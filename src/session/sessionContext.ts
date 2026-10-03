/**
 * Session state tracking — in-process hot path with a durable local receipt.
 *
 * This is NOT business logic — it's MCP connection lifecycle state.
 * Business logic (skill routing, budget tranching, content resolution)
 * lives in the synalux portal at /api/v1/prism/skills.
 *
 * What stays here (host lifecycle state, cannot be portal-side):
 *   markContextLoaded / requireContextLoaded — write-gate for session tools
 *   noteInferenceForSession — telemetry counter
 *   drift timer — connection-scoped GATE 5 enforcement
 *
 * What moved to portal (business logic):
 *   Skill routing, budget tranching, content loading, phantom detection,
 *   prompt-keyword matching, user-local skill loading, context-discovery.
 */

import { createHash } from "node:crypto";
import { BOUNDARIES_VERSION as CURRENT_BOUNDARIES_VERSION } from "../boundaries/boundaries.js";
import * as configStorage from "../storage/configStorage.js";
import type { SessionContextReceipt } from "../storage/configStorage.js";

interface SessionState {
  contextLoaded: boolean;
  /** Version of the BOUNDARIES_TEXT delivered to this session. */
  boundariesVersion: string | null;
  project: string | null;
  lastSeen: number;
  inferenceCalls: number;
  usedCloudCalls: number;
  // Drift detection timer (GATE 5 — server-side tracking)
  /** Epoch ms when session_load_context was called (session start). */
  driftSessionStart?: number;
  /** Epoch ms of the last session_detect_drift or session_save_ledger call. */
  driftLastCheck?: number;
}

/** Return type for requireContextLoaded — discriminated union. */
export type GateResult =
  | null                                         // OK — proceed
  | { blocked: true;  error: string }            // hard block — return error to model
  | { blocked: false; warning: string };         // soft advisory — proceed, prepend warning

const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 h — conversation-scoped
const MAX_SESSIONS   = 10_000;
const RECEIPT_CLOCK_SKEW_MS = 60_000;

/**
 * Connection-scoped fallback: remember the last conversation_id seen via
 * markContextLoaded so that tools which don't carry conversation_id
 * (e.g. prism_infer) still benefit from drift reminders.
 */
let lastSeenConversationId: string | undefined;

// JS Map preserves insertion order. Touch-on-access (delete + re-insert) keeps
// the Map ordered LRU-last so eviction can pop the first key in O(1).
const sessions = new Map<string, SessionState>();

function touch(conversationId: string, s: SessionState): void {
  // Re-insert to move this entry to the end of insertion order (most-recently-used).
  sessions.delete(conversationId);
  s.lastSeen = Date.now();
  sessions.set(conversationId, s);
}

function evictStale(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [k, v] of sessions) {
    if (v.lastSeen < cutoff) sessions.delete(k);
  }
  // Hard cap: evict least-recently-used entries (the ones at the front of the Map,
  // because touch() always re-inserts accessed entries at the back).
  // Guard: use !== undefined (not truthy) so an empty-string key doesn't stall the loop.
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) sessions.delete(oldest);
    else break;
  }
}

function getOrInit(conversationId: string): SessionState {
  let s = sessions.get(conversationId);
  if (!s) {
    s = {
      contextLoaded: false,
      boundariesVersion: null,
      project: null,
      lastSeen: Date.now(),
      inferenceCalls: 0,
      usedCloudCalls: 0,
    };
    sessions.set(conversationId, s);
    if (sessions.size > MAX_SESSIONS) evictStale();
    return s;
  }
  // Touch on access — maintains O(1) LRU eviction order in the Map.
  touch(conversationId, s);
  return s;
}

/**
 * Called by sessionLoadContextHandler after it successfully assembles context.
 * Server-side equivalent of mark_loaded.py — fires from the tool handler
 * itself, so it works for every host, not just Claude Code.
 */
export function markContextLoaded(
  conversationId: string,
  project: string,
  boundariesVersion: string,
): void {
  const s = getOrInit(conversationId);
  s.contextLoaded = true;
  s.project = project;
  s.boundariesVersion = boundariesVersion;
  lastSeenConversationId = conversationId;
}

const ENFORCED = " (Enforced server-side — applies to every host.)";

/**
 * The one remedy every refusal names, so the three variants cannot drift apart
 * and the host instruction blocks (src/contextRecoveryPolicy.ts), the server
 * instructions and the tool descriptions can say the same thing. A block that
 * forbids the call a refusal asks for leaves an agent with no way forward
 * (tests/startup-recovery-contract.test.ts pins every surface).
 */
const CONTEXT_RECOVERY =
  " To recover, call session_load_context with the same project and the same conversation_id you " +
  "passed to this save, then retry the save once. You do not need to repeat session_bootstrap (it " +
  "reloads only the dashboard Auto-Load projects and reprints the startup display). A recovery load " +
  "is not a second startup. If the retry is refused too, stop and tell the user.";

function contextNotLoadedError(project?: string): GateResult {
  const projectNote = project
    ? " the requested project was not loaded for this conversation."
    : " no context is registered for this conversation.";
  return {
    blocked: true,
    error:
      "context_not_loaded:" + projectNote + CONTEXT_RECOVERY +
      " This project-scoped tool needs confirmed working context to act correctly." + ENFORCED,
  };
}

/**
 * A save whose conversation_id is the empty string can never be recovered by
 * "the same conversation_id you passed": the load handler registers nothing for
 * an empty id. Say what is actually wrong and where the real id comes from.
 */
function emptyConversationIdError(): GateResult {
  return {
    blocked: true,
    error:
      "context_not_loaded: conversation_id is empty, so no context can be registered for it." +
      " Pass this conversation's conversation_id (the value on session_bootstrap's <prism_session /> line)," +
      " call session_load_context with that conversation_id and this project, then retry the save once." +
      " If the retry is refused too, stop and tell the user." + ENFORCED,
  };
}

function contextExpiredError(): GateResult {
  return {
    blocked: true,
    error: "context_not_loaded: session expired (6 h TTL)." + CONTEXT_RECOVERY + ENFORCED,
  };
}

/**
 * Longest project or conversation_id a refusal echoes back. A longer value gets
 * the remedy without a literal call: a clipped value would register the wrong
 * project, and the retry would be refused again.
 */
const MAX_ECHOED_VALUE = 200;

/**
 * Print the literal recovery call, built from the arguments the refused save
 * used, so "the same project and conversation_id" cannot be mistyped or
 * replaced by a host session id. Values are JSON-escaped and echoed whole, only
 * to the caller that just sent them; a value too long to echo gets no call.
 */
function withExactCall(gate: GateResult, conversationId: string, project: string): GateResult {
  if (!gate || !gate.blocked || !conversationId || !project.trim() || !gate.error.endsWith(ENFORCED)) {
    return gate;
  }
  if (project.length > MAX_ECHOED_VALUE || conversationId.length > MAX_ECHOED_VALUE) return gate;
  const call = JSON.stringify({
    project,
    conversation_id: conversationId,
    toolAction: "Reload context",
    toolSummary: "Recover from context_not_loaded",
  });
  return {
    blocked: true,
    error: gate.error.slice(0, -ENFORCED.length) + ` Exact call: session_load_context(${call}).` + ENFORCED,
  };
}

function hashReceiptScope(kind: "conversation" | "project", value: string): string {
  return createHash("sha256").update(`prism-session-${kind}\0${value}`).digest("hex");
}

async function persistContextReceipt(
  conversationId: string,
  project: string,
  boundariesVersion: string,
  loadedAt: number,
): Promise<void> {
  const now = Date.now();
  const receipt: SessionContextReceipt = {
    conversationHash: hashReceiptScope("conversation", conversationId),
    projectHash: hashReceiptScope("project", project),
    project,
    boundariesVersion,
    loadedAt,
    lastSeen: now,
  };
  await configStorage.saveSessionContextReceipt(receipt, now - SESSION_TTL_MS);
}

async function persistContextReceiptBestEffort(
  conversationId: string,
  project: string,
  boundariesVersion: string,
  loadedAt: number,
): Promise<void> {
  try {
    await persistContextReceipt(conversationId, project, boundariesVersion, loadedAt);
  } catch (error) {
    // Keep the established same-process path available on read-only or damaged
    // config stores, but make degraded restart recovery visible to operators.
    console.error(
      `[sessionContext] Durable context receipt unavailable for project "${project}": ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Registers successful context materialization and persists an opaque receipt.
 * The conversation_id never leaves this process unhashed.
 */
export async function registerContextLoaded(
  conversationId: string,
  project: string,
  boundariesVersion: string,
): Promise<void> {
  markContextLoaded(conversationId, project, boundariesVersion);
  noteDriftSessionStart(conversationId);
  const s = sessions.get(conversationId);
  await persistContextReceiptBestEffort(
    conversationId,
    project,
    boundariesVersion,
    s?.driftSessionStart ?? Date.now(),
  );
}

/**
 * Soft gate for handlers that need project context to be CORRECT (not safe).
 *
 * Returns:
 *   null                          — OK, proceed
 *   { blocked: true, error }      — hard block; return the error verbatim to the model
 *   { blocked: false, warning }   — proceed, but prepend the warning to the response
 *                                   (emitted when the session was loaded with an older
 *                                   BOUNDARIES_VERSION — the host should reload context)
 *
 * Fail-closed: unknown or expired session → hard block.
 * Does NOT gate safety. Do not call this from prism_infer.
 */
export function requireContextLoaded(conversationId: string | undefined): GateResult {
  // No conversation_id (undefined) means the caller is using the session-agnostic
  // interface (auto-push host, resource reader, or legacy client). Allow through —
  // the gate is opt-in when a conversation_id is explicitly provided.
  // NOTE: use === undefined, not !conversationId, so that an empty-string ""
  // conversation_id still falls through to the sessions.get() lookup and gets
  // blocked (hard block) instead of silently bypassing the gate.
  if (conversationId === undefined) return null;

  const s = sessions.get(conversationId);

  // #9: Enforce TTL on reads. A session loaded 6 h+ ago is treated as expired
  // even if no write has triggered eviction yet. Evict immediately on detection.
  if (s && (Date.now() - s.lastSeen) > SESSION_TTL_MS) {
    sessions.delete(conversationId);
    return contextExpiredError();
  }

  if (!s || !s.contextLoaded) {
    return contextNotLoadedError();
  }

  // Touch on valid read — maintains LRU order.
  touch(conversationId, s);

  // #15: Soft warning when this session was loaded with an older BOUNDARIES_VERSION.
  // The server may have been updated mid-session. Don't block writes — that would
  // be disruptive — but advise the host to reload context to pick up the new boundaries.
  if (s.boundariesVersion !== null && s.boundariesVersion !== CURRENT_BOUNDARIES_VERSION) {
    return {
      blocked: false,
      warning:
        `[advisory] Operating boundaries updated (session loaded v${s.boundariesVersion}, ` +
        `server now at v${CURRENT_BOUNDARIES_VERSION}). Call session_load_context again ` +
        `to receive the latest boundaries. Proceeding with current write.`,
    };
  }

  return null;
}

/**
 * Project-scoped durable gate used by ledger and handoff writes.
 *
 * The in-memory state remains the hot path. If another MCP process loaded the
 * requested project, or this process restarted, an unexpired hashed receipt
 * restores only that exact project. Unknown, malformed, expired, and
 * cross-project lookups remain fail-closed.
 */
export async function requireContextLoadedForProject(
  conversationId: string | undefined,
  project: string,
): Promise<GateResult> {
  const gate = await evaluateContextGateForProject(conversationId, project);
  return conversationId === undefined ? gate : withExactCall(gate, conversationId, project);
}

async function evaluateContextGateForProject(
  conversationId: string | undefined,
  project: string,
): Promise<GateResult> {
  if (conversationId === undefined) return null;
  if (!conversationId) return emptyConversationIdError();
  if (!project.trim()) return contextNotLoadedError(project || undefined);

  const memoryGate = requireContextLoaded(conversationId);
  const memoryState = sessions.get(conversationId);
  if (memoryState?.contextLoaded && memoryState.project === project &&
      !(memoryGate && memoryGate.blocked)) {
    await persistContextReceiptBestEffort(
      conversationId,
      project,
      memoryState.boundariesVersion ?? CURRENT_BOUNDARIES_VERSION,
      memoryState.driftSessionStart ?? memoryState.lastSeen,
    );
    return memoryGate;
  }

  let receipt: SessionContextReceipt | null = null;
  try {
    receipt = await configStorage.getSessionContextReceipt(
      hashReceiptScope("conversation", conversationId),
      hashReceiptScope("project", project),
    );
  } catch (error) {
    console.error(
      `[sessionContext] Durable context receipt lookup failed for project "${project}": ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
    return memoryGate && memoryGate.blocked ? memoryGate : contextNotLoadedError(project);
  }

  if (!receipt) return memoryGate?.blocked ? memoryGate : contextNotLoadedError(project);

  const now = Date.now();
  const invalidReceipt =
    receipt.project !== project ||
    !Number.isFinite(receipt.loadedAt) ||
    !Number.isFinite(receipt.lastSeen) ||
    receipt.loadedAt <= 0 ||
    receipt.loadedAt > receipt.lastSeen ||
    receipt.lastSeen > now + RECEIPT_CLOCK_SKEW_MS;
  if (invalidReceipt) return contextNotLoadedError(project);
  if ((now - receipt.lastSeen) > SESSION_TTL_MS) return contextExpiredError();

  markContextLoaded(conversationId, project, receipt.boundariesVersion);
  const restored = sessions.get(conversationId);
  if (restored) restored.driftSessionStart = receipt.loadedAt;

  const restoredGate = requireContextLoaded(conversationId);
  await persistContextReceiptBestEffort(
    conversationId,
    project,
    receipt.boundariesVersion,
    receipt.loadedAt,
  );
  return restoredGate;
}

/** Best-effort telemetry from prism_infer. Never affects a safety decision. */
export function noteInferenceForSession(
  conversationId: string,
  info: { backend: string; usedCloud: boolean },
): void {
  // Only update sessions that already exist — don't create ghost stubs for
  // conversations that never called session_bootstrap or session_load_context.
  // Ghost stubs would
  // accumulate in the LRU and crowd out legitimate registered sessions.
  const s = sessions.get(conversationId);
  if (!s) return;
  s.inferenceCalls += 1;
  if (info.usedCloud) s.usedCloudCalls += 1;
  touch(conversationId, s);
}

/** For metrics / session health checks. */
export function getSessionState(conversationId: string): Readonly<SessionState> | null {
  return sessions.get(conversationId) ?? null;
}

// ─── GATE 5: Server-Side Drift Timer ────────────────────────
// These functions track drift detection timing per conversation so the
// server can inject GATE 5 reminders into tool responses without relying
// on external hooks (guard_on_submit.py). The server is pull-based — it
// can only inject when a tool is called, so we piggyback on every
// prism-mcp tool response when the timer is overdue.

const DRIFT_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Called by sessionLoadContextHandler to mark session start for drift timing.
 */
export function noteDriftSessionStart(conversationId: string): void {
  const s = sessions.get(conversationId);
  if (!s) return;
  s.driftSessionStart = Date.now();
  // Don't set driftLastCheck — the first check should happen 60 min after start
}

/**
 * Called after session_detect_drift or session_save_ledger completes
 * to reset the drift timer for this conversation.
 */
export function noteDriftCheck(conversationId: string): void {
  const s = sessions.get(conversationId);
  if (!s) return;
  s.driftLastCheck = Date.now();
  touch(conversationId, s);
}

/**
 * Returns a GATE 5 drift reminder string if 60+ minutes have elapsed
 * since session start AND 60+ minutes since the last drift check.
 * Returns empty string if no reminder is due or if the session is too
 * young (< 60 min).
 *
 * This is called from the common tool response path in server.ts and
 * appended to every prism-mcp tool response when overdue.
 */
export function getDriftReminder(conversationId: string | undefined): string {
  const effectiveId = conversationId || lastSeenConversationId;
  if (!effectiveId) return "";

  const s = sessions.get(effectiveId);
  if (!s || !s.contextLoaded || !s.driftSessionStart) return "";

  const now = Date.now();
  const sessionAge = now - s.driftSessionStart;

  // Session must be at least 60 minutes old before reminders kick in
  if (sessionAge < DRIFT_CHECK_INTERVAL_MS) return "";

  // If a drift check has been done, only remind if 60+ min since last check
  if (s.driftLastCheck) {
    const sinceLastCheck = now - s.driftLastCheck;
    if (sinceLastCheck < DRIFT_CHECK_INTERVAL_MS) return "";
  }

  // Drift reminder is overdue
  const minutesSinceStart = Math.round(sessionAge / 60_000);
  const minutesSinceCheck = s.driftLastCheck
    ? Math.round((now - s.driftLastCheck) / 60_000)
    : minutesSinceStart;

  return (
    `\n\n[⏰ GATE 5 — DRIFT CHECK OVERDUE (${minutesSinceCheck} min since last check, session ${minutesSinceStart} min old)]\n` +
    `Long-session drift protocol requires action NOW:\n` +
    `1. Call session_save_ledger — snapshot current state\n` +
    `2. Call session_detect_drift — check drift vs original goals\n` +
    `3. If major_drift returned: call session_compact_ledger + reload context\n` +
    `This check is MANDATORY every 60 minutes. Do not skip.`
  );
}
