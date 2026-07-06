/**
 * src/session/sessionContext.ts
 *
 * Server-side session state, keyed on conversation_id (the same id threaded
 * through session_load_context / session_save_ledger / prism_infer).
 *
 * WHY THIS EXISTS
 * ---------------
 * On Claude Code, "call session_load_context first" was enforced by the
 * guard_on_submit hook injecting a MANDATORY STARTUP reminder, and by
 * mark_loaded.py flipping a pending flag. Neither mechanism runs on a
 * non-Claude host (Gemini, autonomous script, cron job).
 *
 * This module moves that state server-side so any host that calls
 * session_load_context gets its conversation marked as loaded — regardless
 * of whether it ran the hook.
 *
 * TWO DELIBERATE BOUNDARIES
 * -------------------------
 * 1. This is NOT a safety mechanism. prism_infer's input/output safety gates
 *    run unconditionally before and after every model call. A host that never
 *    loads context still cannot reach an un-gated model.
 *
 * 2. requireContextLoaded gates only CORRECTNESS-requiring, project-scoped
 *    actions (save_ledger, save_handoff) — tools that act on a specific project
 *    and produce wrong results if the agent hasn't confirmed its working context.
 *    Do NOT gate prism_infer on this; a host that never loads context must still
 *    be able to run inference (safety is already unconditional there).
 *
 * Fail-closed: an unknown or expired conversation_id → context not loaded.
 */

import { BOUNDARIES_VERSION as CURRENT_BOUNDARIES_VERSION } from "../boundaries/boundaries.js";

interface SessionState {
  contextLoaded: boolean;
  /** Version of the BOUNDARIES_TEXT delivered to this session. */
  boundariesVersion: string | null;
  project: string | null;
  lastSeen: number;
  inferenceCalls: number;
  usedCloudCalls: number;
}

/** Return type for requireContextLoaded — discriminated union. */
export type GateResult =
  | null                                         // OK — proceed
  | { blocked: true;  error: string }            // hard block — return error to model
  | { blocked: false; warning: string };         // soft advisory — proceed, prepend warning

const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 h — conversation-scoped
const MAX_SESSIONS   = 10_000;

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
    return {
      blocked: true,
      error:
        "context_not_loaded: session expired (6 h TTL). Call " +
        "session_load_context(project, conversation_id) again to reload context. " +
        "(Enforced server-side — applies to every host.)",
    };
  }

  if (!s || !s.contextLoaded) {
    return {
      blocked: true,
      error:
        "context_not_loaded: call session_load_context(project, conversation_id) " +
        "before this action. This project-scoped tool needs confirmed working context " +
        "to act correctly. (Enforced server-side — applies to every host.)",
    };
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

/** Best-effort telemetry from prism_infer. Never affects a safety decision. */
export function noteInferenceForSession(
  conversationId: string,
  info: { backend: string; usedCloud: boolean },
): void {
  // Only update sessions that already exist — don't create ghost stubs for
  // conversations that never called session_load_context. Ghost stubs would
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
