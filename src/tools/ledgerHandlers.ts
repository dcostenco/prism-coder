import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { redactSettings, toMarkdown } from "./commonHelpers.js";
import * as fflate from "fflate";
import { buildVaultDirectory } from "../utils/vaultExporter.js";
/**
 * Session Memory Handlers (v2.0 — StorageBackend Refactor)
 *
 * ═══════════════════════════════════════════════════════════════════
 * v2.0 CHANGES IN THIS FILE (Step 1: Pure Refactor)
 *
 * BEFORE: All handlers called supabasePost/Get/Rpc/Patch/Delete directly.
 * AFTER:  All handlers call StorageBackend methods via `getStorage()`.
 *
 * This refactor changes ZERO behavior. Every method call maps 1:1 to
 * the same Supabase API call (see src/storage/supabase.ts for mapping).
 *
 * WHY: This enables Step 2 (SQLite local mode) — once SqliteStorage
 * implements the same interface, the handlers work with both backends
 * without any code changes.
 * ═══════════════════════════════════════════════════════════════════
 */

import { debugLog } from "../utils/logger.js";
import { getStorage, activeStorageBackend } from "../storage/index.js";
import { toKeywordArray } from "../utils/keywordExtractor.js";
import { getLLMProvider } from "../utils/llm/factory.js";
import { getCurrentGitState, getGitDrift } from "../utils/git.js";
import { getSetting, getAllSettings } from "../storage/configStorage.js";
import { mergeHandoff, dbToHandoffSchema, sanitizeForMerge } from "../utils/crdtMerge.js";

// ─── Phase 1: Explainability & Memory Lineage ────────────────
// These utilities provide structured tracing metadata for search operations.
// When `enable_trace: true` is passed to session_search_memory or knowledge_search,
// a separate MCP content block (content[1]) is returned with a MemoryTrace object
// containing: strategy, scores, latency breakdown (embedding/storage/total), and metadata.
// See src/utils/tracing.ts for full type definitions and design decisions.
import { createMemoryTrace, traceToContentBlock } from "../utils/tracing.js";
import { GOOGLE_API_KEY, PRISM_USER_ID, PRISM_AUTO_CAPTURE, PRISM_CAPTURE_PORTS } from "../config.js";
import { captureLocalEnvironment } from "../utils/autoCapture.js";
import { fireCaptionAsync } from "../utils/imageCaptioner.js";
import {
  isSessionSaveLedgerArgs,
  isSessionSaveHandoffArgs,
  isSessionLoadContextArgs,
  isKnowledgeSearchArgs,
  isKnowledgeForgetArgs,
  isSessionSearchMemoryArgs,
  isBackfillEmbeddingsArgs,
  isMemoryHistoryArgs,
  isMemoryCheckoutArgs,
  isSessionHealthCheckArgs,        // v2.2.0: health check type guard
  isSessionForgetMemoryArgs,       // Phase 2: GDPR-compliant memory deletion type guard
  isKnowledgeSetRetentionArgs,     // v3.1: TTL retention policy type guard
  // v4.0: Active Behavioral Memory type guards
  isSessionSaveExperienceArgs,
  isKnowledgeVoteArgs,
  // v4.2: Sync Rules type guard
  isKnowledgeSyncRulesArgs,
  // v5.1: Deep Storage Mode type guard
  isDeepStoragePurgeArgs,
  // v5.5: SDM Intuitive Recall type guard
  isSessionIntuitiveRecallArgs,
  isSessionExportMemoryArgs,
  isSessionSaveImageArgs,
  isSessionViewImageArgs
} from "./sessionMemoryDefinitions.js";

// v4.2: File system access for knowledge_sync_rules
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve, isAbsolute, sep, relative } from "node:path";

// v3.1: In-memory debounce lock for auto-compaction.
// Prevents multiple concurrent Gemini compaction tasks for the same project
// when many agents call session_save_ledger at the same time.
const activeCompactions = new Set<string>();


// ─── v0.4.0: Import server type for resource notifications ───
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { notifyResourceUpdate } from "../server.js";

// ─── Save Ledger Handler ──────────────────────────────────────

/**
 * Appends an immutable session log entry.
 *
 * Think of the ledger as a "commit log" for agent work — once written, entries
 * are never modified. This creates a permanent audit trail of all work done.
 *
 * After saving, generates an embedding vector for the entry via fire-and-forget.
 */
import { computeEffectiveImportance, recordMemoryAccess } from "../utils/cognitiveMemory.js";
export async function sessionSaveLedgerHandler(args: unknown) {
  if (!isSessionSaveLedgerArgs(args)) {
    throw new Error("Invalid arguments for session_save_ledger");
  }

  const { project, conversation_id, summary, todos, files_changed, decisions, role } = args;
  const storage = await getStorage();

  // ─── Repo path mismatch validation (v4.2) ───
  let repoPathWarning = "";
  if (files_changed && files_changed.length > 0) {
    try {
      const configuredPath = await getSetting(`repo_path:${project}`, "");
      if (configuredPath && configuredPath.trim()) {
        const normalizedPath = configuredPath.trim().replace(/\\/g, "/").replace(/\/+$/, "");  // normalize + strip trailing slash
        const mismatched = files_changed.filter((f: string) => !f.replace(/\\/g, "/").startsWith(normalizedPath));
        if (mismatched.length === files_changed.length) {
          repoPathWarning = `\n\n⚠️ Project mismatch: none of the files_changed paths match repo_path "${normalizedPath}" ` +
            `configured for project "${project}". Consider saving under the correct project.`;
          debugLog(`[session_save_ledger] Repo path mismatch for "${project}": expected prefix "${normalizedPath}"`);
        }
      }
    } catch { /* getSetting non-fatal */ }
  }

  debugLog(`[session_save_ledger] Saving ledger entry for project="${project}"`);

  // Auto-extract keywords from summary + decisions for knowledge accumulation
  const combinedText = [summary, ...(decisions || [])].join(" ");
  const keywords = toKeywordArray(combinedText);
  debugLog(`[session_save_ledger] Extracted ${keywords.length} keywords: ${keywords.slice(0, 5).join(", ")}...`);

  // Save via storage backend
  const effectiveRole = role || await getSetting("default_role", "global");
  const result = await storage.saveLedger({
    project,
    conversation_id,
    summary,
    user_id: PRISM_USER_ID,
    todos: todos || [],
    files_changed: files_changed || [],
    decisions: decisions || [],
    keywords,
    role: effectiveRole,  // v3.0: Hivemind role scoping (dashboard fallback)
  });

  // ─── Fire-and-forget embedding generation ───
  if (GOOGLE_API_KEY && result) {
    const embeddingText = [summary, ...(decisions || [])].join("\n");
    const savedEntry = Array.isArray(result) ? result[0] : result;
    const entryId = (savedEntry as any)?.id;

    if (entryId) {
      getLLMProvider().generateEmbedding(embeddingText)
        .then(async (embedding) => {
          // Build atomic patch — float32 + TurboQuant in ONE DB update
          const patchData: Record<string, unknown> = {
            embedding: JSON.stringify(embedding),
          };

          // TurboQuant: compress alongside float32 (non-fatal)
          try {
            const { getDefaultCompressor, serialize } = await import("../utils/turboquant.js");
            const compressor = getDefaultCompressor();
            const compressed = compressor.compress(embedding);
            const buf = serialize(compressed);

            patchData.embedding_compressed = buf.toString("base64");
            patchData.embedding_format = `turbo${compressor.bits}`;
            patchData.embedding_turbo_radius = compressed.radius;
            debugLog(`[session_save_ledger] TurboQuant compressed: ${buf.length} bytes (${(3072 / buf.length).toFixed(1)}× ratio)`);
          } catch (turboErr: any) {
            console.error(`[session_save_ledger] TurboQuant compression failed (non-fatal): ${turboErr.message}`);
          }

          // Single atomic DB update for all embedding data
          await storage.patchLedger(entryId, patchData);
          debugLog(`[session_save_ledger] Embedding saved for entry ${entryId}`);
        })
        .catch((err) => {
          console.error(`[session_save_ledger] Embedding generation failed (non-fatal): ${err.message}`);
        });
    }
  }

  // ─── v6.0 Phase 3: Fire-and-forget auto-linking ────────────
  // Creates temporal (conversation chain) and keyword overlap (related_to)
  // graph edges. Wrapped in setImmediate + try/catch so graph failures
  // NEVER affect the primary MCP response path.
  if (result) {
    const savedEntry = Array.isArray(result) ? result[0] : result;
    const autoLinkEntryId = (savedEntry as any)?.id;
    if (autoLinkEntryId) {
      setImmediate(() => {
        import("../utils/autoLinker.js")
          .then(({ autoLinkEntry }) =>
            autoLinkEntry(
              autoLinkEntryId,
              project,
              keywords,
              conversation_id,
              PRISM_USER_ID,
              storage,
              (savedEntry as any).created_at
            )
          )
          .catch((err) => {
            debugLog(`[session_save_ledger] Auto-linking failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
          });
      });
    }
  }

  // ─── Fire-and-forget auto-compact ────────────────────────────
  // If the user has opted into auto-compact (via dashboard Settings → Boot),
  // run a health check after saving and compact if brain is degraded/unhealthy.
  // Uses debounce Set to prevent concurrent Gemini calls for same project.
  getSetting("compaction_auto", "false").then(async (autoCompact) => {
    if (autoCompact !== "true") return;
    if (activeCompactions.has(project)) {
      debugLog(`[auto-compact] Skipped for "${project}" — compaction already in progress`);
      return;
    }
    activeCompactions.add(project);
    try {
      const { runHealthCheck } = await import("../utils/healthCheck.js");
      const { compactLedgerHandler } = await import("./compactionHandler.js");
      const healthStats = await storage.getHealthStats(PRISM_USER_ID);
      const report = runHealthCheck(healthStats);
      if (report.status === "degraded" || report.status === "unhealthy") {
        debugLog(`[auto-compact] Brain "${project}" is ${report.status} — triggering compaction`);
        await compactLedgerHandler({ project });
        debugLog(`[auto-compact] Compaction complete for "${project}"`);
      }
    } catch (err) {
      console.error(`[auto-compact] Non-fatal error for "${project}": ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      activeCompactions.delete(project);
    }
  }).catch(() => {/* getSetting non-fatal */});

  // ─── Fire-and-forget importance decay (v4.3) ──────────────
  // Decays stale behavioral insights (>30d old) by -1 importance.
  // Matches SQLite's automatic decay behavior on every save.
  // Non-fatal: errors are logged but never surfaced to the caller.
  storage.decayImportance(project, PRISM_USER_ID, 30).catch((err) => {
    debugLog(`[session_save_ledger] Background decay failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  });

  return {
    content: [{
      type: "text",
      text: `✅ Session ledger saved for project "${project}"\n` +
        `Summary: ${summary}\n` +
        (todos?.length ? `TODOs: ${todos.length} items\n` : "") +
        (files_changed?.length ? `Files changed: ${files_changed.length}\n` : "") +
        (decisions?.length ? `Decisions: ${decisions.length}\n` : "") +
        (GOOGLE_API_KEY ? `📊 Embedding generation queued for semantic search.\n` : "") +
        repoPathWarning +
        `\nRaw response: ${JSON.stringify(result)}`,
    }],
    isError: false,
  };
}

export async function sessionSaveHandoffHandler(args: unknown, server?: Server) {
  if (!isSessionSaveHandoffArgs(args)) {
    throw new Error("Invalid arguments for session_save_handoff");
  }

  const {
    project,
    expected_version,
    open_todos,
    active_branch,
    last_summary,
    key_context,
    role,  // v3.0: Hivemind role
  } = args;

  const storage = await getStorage();

  debugLog(
    `[session_save_handoff] Saving handoff for project="${project}" ` +
    `(expected_version=${expected_version ?? "none"})`
  );

  // Auto-extract keywords from summary + context for knowledge accumulation
  const combinedText = [last_summary || "", key_context || ""].filter(Boolean).join(" ");
  let keywords = combinedText ? toKeywordArray(combinedText) : undefined;
  if (keywords) {
    debugLog(`[session_save_handoff] Extracted ${keywords.length} keywords: ${keywords.slice(0, 5).join(", ")}...`);
  }

  // Auto-capture Git state for Reality Drift Detection (v2.0 Step 5)
  const gitState = getCurrentGitState();
  const metadata: Record<string, unknown> = {};
  if (gitState.isRepo) {
    metadata.git_branch = gitState.branch;
    metadata.last_commit_sha = gitState.commitSha;
    debugLog(
      `[session_save_handoff] Git state captured: branch=${gitState.branch}, sha=${gitState.commitSha?.substring(0, 8)}`
    );
  }

  // Save via storage backend (OCC-aware)
  const effectiveRole = role || await getSetting("default_role", "global");
  let data = await storage.saveHandoff(
    {
      project,
      user_id: PRISM_USER_ID,
      last_summary: last_summary ?? null,
      pending_todo: open_todos ?? null,
      active_decisions: null,
      keywords: keywords ?? null,
      key_context: key_context ?? null,
      active_branch: active_branch ?? null,
      metadata,
      role: effectiveRole,  // v3.0: Hivemind role scoping (dashboard fallback)
    },
    expected_version ?? null
  );

  // ─── v5.4: CRDT Auto-Merge Resolution Loop ──────────────────
  //
  // Instead of returning a conflict error, we now:
  //   1. Fetch the base state (the version the incoming agent read)
  //   2. Fetch the current DB state (what beat the incoming agent)
  //   3. Run a 3-way CRDT merge (OR-Set for arrays, LWW for scalars)
  //   4. Retry the save with the merged state
  //
  // This converts what was previously an error into an automatic merge.
  // The loop handles the rare case where ANOTHER save sneaks in during
  // our merge (up to MAX_ATTEMPTS retries before giving up).

  const MAX_MERGE_ATTEMPTS = 3;
  let mergeAttempts = 0;
  let isMerged = false;
  let mergeStrategy: Record<string, string> | null = null;

  while (data.status === "conflict" && mergeAttempts < MAX_MERGE_ATTEMPTS) {
    // If the user explicitly disabled CRDT merging, return old OCC error
    if (args.disable_merge) {
      debugLog(
        `[session_save_handoff] VERSION CONFLICT for "${project}": ` +
        `expected=${expected_version}, current=${data.current_version} (merge disabled)`
      );
      return {
        content: [{
          type: "text",
          text: `⚠️ Version conflict detected for project "${project}"!\n\n` +
            `You sent version ${expected_version}, but the current version is ${data.current_version}.\n` +
            `Auto-merge is disabled. Please call session_load_context to see the latest changes, ` +
            `then manually merge your updates and try saving again.`,
        }],
        isError: true,
      };
    }

    debugLog(
      `[session_save_handoff] CRDT merge attempt ${mergeAttempts + 1}/${MAX_MERGE_ATTEMPTS} ` +
      `for "${project}" (expected=${expected_version}, current=${data.current_version})`
    );

    // Step 1: Fetch the base state (what the incoming agent originally read)
    const baseDbState = expected_version
      ? await storage.getHandoffAtVersion(project, expected_version, PRISM_USER_ID)
      : null;
    const baseState = dbToHandoffSchema(baseDbState);

    // Step 2: Fetch current DB state (what beat us to the save)
    const currentDbState = await storage.loadContext(project, "standard", PRISM_USER_ID, effectiveRole);
    const currentState = dbToHandoffSchema(currentDbState);

    if (!currentState || !currentDbState) {
      debugLog("[session_save_handoff] CRDT merge failed: could not load current state");
      break; // Safety fallback — can't merge without both sides
    }

    // Step 3: Build the incoming state from the original args
    const incomingState = {
      summary: last_summary || "",
      active_branch: active_branch,
      key_context: key_context,
      pending_todo: open_todos,
      active_decisions: undefined as string[] | undefined,
      keywords: keywords,
    };

    // Step 4: Run 3-way CRDT merge (sanitize first to block prototype pollution)
    const sanitizedIncoming = sanitizeForMerge(incomingState) as typeof incomingState;
    const crdt = mergeHandoff(baseState, sanitizedIncoming, currentState);
    mergeStrategy = crdt.strategy;
    isMerged = true;

    debugLog(
      `[session_save_handoff] CRDT merge strategy: ${JSON.stringify(crdt.strategy)}`
    );

    // Step 5: Build merged handoff and retry save
    const mergedExpectedVersion = (currentDbState as Record<string, unknown>).version as number;
    data = await storage.saveHandoff(
      {
        project,
        user_id: PRISM_USER_ID,
        last_summary: crdt.merged.summary ?? null,
        pending_todo: crdt.merged.pending_todo ?? null,
        active_decisions: crdt.merged.active_decisions ?? null,
        keywords: crdt.merged.keywords ?? null,
        key_context: crdt.merged.key_context ?? null,
        active_branch: crdt.merged.active_branch ?? null,
        metadata: {
          ...metadata,
          crdt_merge_count: (((currentDbState as Record<string, unknown>).metadata as Record<string, unknown>)?.crdt_merge_count as number || 0) + 1,
          last_merge_strategy: crdt.strategy,
        },
        role: effectiveRole,
      },
      mergedExpectedVersion ?? null
    );

    // Update these for the snapshot/notification blocks below
    if (data.status !== "conflict") {
      // Merge succeeded — update local vars for the success path
      keywords = crdt.merged.keywords ?? keywords;
    }

    mergeAttempts++;
  }

  // After all merge attempts exhausted, still a conflict → give up
  if (data.status === "conflict") {
    debugLog(
      `[session_save_handoff] CRDT merge exhausted after ${MAX_MERGE_ATTEMPTS} attempts for "${project}"`
    );
    return {
      content: [{
        type: "text",
        text: `⚠️ CRDT auto-merge failed for "${project}" after ${MAX_MERGE_ATTEMPTS} attempts ` +
          `due to high contention. Please run session_load_context to see the latest state ` +
          `and try saving again.`,
      }],
      isError: true,
    };
  }

  // ─── Success: handoff created or updated ───
  const newVersion = data.version;

  // ─── TIME MACHINE: Auto-snapshot for time travel (fire-and-forget) ───
  // Every successful save creates a snapshot so the user can revert later.
  // We don't await — this should never block the success response.
  if (data.status === "created" || data.status === "updated") {
    const snapshotEntry = {
      project,
      user_id: PRISM_USER_ID,
      last_summary: last_summary ?? null,
      pending_todo: open_todos ?? null,
      active_decisions: null,
      keywords: keywords ?? null,
      key_context: key_context ?? null,
      active_branch: active_branch ?? null,
      version: newVersion,
    };
    storage.saveHistorySnapshot(snapshotEntry).catch(err =>
      console.error(`[session_save_handoff] History snapshot failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    );
  }

  // ─── Trigger resource subscription notification ───
  if (server && (data.status === "created" || data.status === "updated")) {
    try {
      notifyResourceUpdate(project, server);
    } catch (err) {
      console.error(`[session_save_handoff] Resource notification failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── TELEPATHY: Broadcast to other Prism MCP instances (v2.0 Step 6) ───
  if (data.status === "created" || data.status === "updated") {
    import("../sync/factory.js")
      .then(({ getSyncBus }) => getSyncBus())
      .then(bus => bus.broadcastUpdate(project, newVersion ?? 1))
      .catch(err =>
        console.error(`[session_save_handoff] SyncBus broadcast failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
      );
  }

  // ─── AUTO-CAPTURE: Snapshot local dev server HTML (v2.1 Step 10) ───
  // Fire-and-forget — never blocks the handoff response.
  if (PRISM_AUTO_CAPTURE && (data.status === "created" || data.status === "updated")) {
    captureLocalEnvironment(project, PRISM_CAPTURE_PORTS).then(async (captureMeta) => {
      if (captureMeta) {
        try {
          const latestCtx = await storage.loadContext(project, "quick", PRISM_USER_ID);
          if (latestCtx) {
            const ctx = latestCtx as any;
            const updatedMeta = { ...(ctx.metadata || {}) };
            updatedMeta.visual_memory = updatedMeta.visual_memory || [];
            updatedMeta.visual_memory.push(captureMeta);

            await storage.saveHandoff({
              project,
              user_id: PRISM_USER_ID,
              metadata: updatedMeta,
              last_summary: ctx.last_summary ?? null,
              pending_todo: ctx.pending_todo ?? null,
              active_decisions: ctx.active_decisions ?? null,
              keywords: ctx.keywords ?? null,
              key_context: ctx.key_context ?? null,
              active_branch: ctx.active_branch ?? null,
            }, newVersion);
            debugLog(`[AutoCapture] HTML snapshot indexed in visual memory for "${project}"`);
          }
        } catch (err) {
          console.error(`[AutoCapture] Metadata patch failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }).catch(err => console.error(`[AutoCapture] Background task failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`));
  }

  // ─── FACT MERGER: Async LLM contradiction resolution (v2.3.0) ───
  // Fire-and-forget — the agent gets instant "✅ Saved" while Gemini
  // merges contradicting facts in the background (~2-3s).
  //
  // TRIGGER CONDITIONS (all must be true):
  //   1. GOOGLE_API_KEY is configured (Gemini is available)
  //   2. The handoff was an UPDATE (not a brand-new project)
  //   3. key_context was provided (something to merge)
  //
  // OCC SAFETY:
  //   If the user saves another handoff while the merger runs,
  //   the merger's save will fail with a version conflict. This is
  //   intentional — active user input always wins over background merging.
  if (GOOGLE_API_KEY && data.status === "updated" && key_context) {
    // Use dynamic import to avoid loading Gemini SDK if not needed
    import("../utils/factMerger.js").then(async ({ consolidateFacts }) => {
      try {
        // Step 1: Load the old context from the database
        const oldState = await storage.loadContext(project, "quick", PRISM_USER_ID);
        const oldKeyContext = (oldState as any)?.key_context || "";  // extract old key_context

        // Step 2: Skip merge if old context is empty (nothing to merge with)
        if (!oldKeyContext || oldKeyContext.trim().length === 0) {
          debugLog("[FactMerger] No old context to merge — skipping");
          return;  // first handoff for this project, no merge needed
        }

        // Step 3: Call Gemini to intelligently merge old + new context
        const mergedContext = await consolidateFacts(oldKeyContext, key_context);

        // Step 4: Skip patch if merged result is same as current key_context
        if (mergedContext === key_context) {
          debugLog("[FactMerger] No changes after merge — skipping patch");
          return;  // Gemini determined no contradictions existed
        }

        // Step 5: Silently patch the database with the merged context
        // Uses the current version for OCC — if user saved again, this will
        // fail with a version conflict (which is the correct behavior)
        await storage.saveHandoff({
          project,                                // same project
          user_id: PRISM_USER_ID,                 // same user
          key_context: mergedContext,              // merged context (cleaned by Gemini)
          last_summary: last_summary ?? null,      // preserve existing summary
          pending_todo: open_todos ?? null,        // preserve existing TODOs
          active_decisions: null,                  // preserve existing decisions
          keywords: keywords ?? null,              // preserve existing keywords
          active_branch: active_branch ?? null,    // preserve existing branch
          metadata: {},                            // no metadata changes
        }, newVersion);                            // use current version for OCC

        debugLog("[FactMerger] Context merged and patched for \"" + project + "\"");
      } catch (err) {
        // OCC conflict = user saved again while merge was running (expected)
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("conflict") || errMsg.includes("version")) {
          // This is GOOD behavior — user's active input takes precedence
          debugLog("[FactMerger] Merge skipped due to active session (OCC conflict)");
        } else {
          // Unexpected error — log but don't crash
          console.error("[FactMerger] Background merge failed (non-fatal): " + errMsg);
        }
      }
    }).catch(err =>
      // Dynamic import itself failed — module not found or similar
      console.error("[FactMerger] Module load failed (non-fatal): " + err)
    );
  }

  // Build response text based on whether a CRDT merge occurred
  const responseText = isMerged
    ? `🔄 Auto-merged conflict for "${project}" (v${expected_version} → v${newVersion})\n` +
      `Strategy: ${JSON.stringify(mergeStrategy)}\n` +
      (last_summary ? `Summary: ${last_summary}\n` : "") +
      `\n🔑 Remember: pass expected_version: ${newVersion} on your next save ` +
      `to maintain concurrency control.`
    : `✅ Handoff ${data.status || "saved"} for project "${project}" ` +
      `(version: ${newVersion})\n` +
      (last_summary ? `Last summary: ${last_summary}\n` : "") +
      (open_todos?.length ? `Open TODOs: ${open_todos.length} items\n` : "") +
      (active_branch ? `Active branch: ${active_branch}\n` : "") +
      `\n🔑 Remember: pass expected_version: ${newVersion} on your next save ` +
      `to maintain concurrency control.`;

  return {
    content: [{
      type: "text",
      text: responseText,
    }],
    isError: false,
  };
}

export async function sessionLoadContextHandler(args: unknown) {
  if (!isSessionLoadContextArgs(args)) {
    throw new Error("Invalid arguments for session_load_context");
  }

  const { project, level = "standard", role } = args;
  const maxTokens = (args as any).max_tokens as number | undefined
    || parseInt(await getSetting("max_tokens", "0"), 10) || undefined;  // v4.0: arg > dashboard setting > none
  const agentName = await getSetting("agent_name", "");

  const validLevels = ["quick", "standard", "deep"];
  if (!validLevels.includes(level)) {
    return {
      content: [{
        type: "text",
        text: `Invalid level "${level}". Must be one of: ${validLevels.join(", ")}`,
      }],
      isError: true,
    };
  }

  debugLog(`[session_load_context] Loading ${level} context for project="${project}"`);

  const storage = await getStorage();
  const effectiveRole = role || await getSetting("default_role", "") || undefined;
  const data = await storage.loadContext(project, level, PRISM_USER_ID, effectiveRole);  // v3.0: role with dashboard fallback

  if (!data) {
    return {
      content: [{
        type: "text",
        text: `No session context found for project "${project}" at level ${level}.\n` +
          `This project has no previous session history. Starting fresh.`,
      }],
      isError: false,
    };
  }

  const version = (data as any)?.version;
  const versionNote = version
    ? `\n\n🔑 Session version: ${version}. Pass expected_version: ${version} when saving handoff.`
    : "";

  // ─── v9.2.2: Split-Brain Drift Detection ───────────────────
  // When using one storage backend (e.g. SQLite), check if an
  // alternate backend (e.g. Supabase) exists with a different
  // version. This prevents agents from unknowingly acting on
  // stale state from a diverged backend.
  //
  // PERF NOTE: We do NOT construct a full StorageBackend for the
  // alternate check — that would trigger full migrations/schema
  // validation on every load (~200-1000ms). Instead we use
  // lightweight direct queries: REST GET for Supabase, raw SQL
  // for SQLite. This keeps the check under ~100ms.
  let splitBrainWarning = "";
  try {
    const { SUPABASE_CONFIGURED, SUPABASE_URL, SUPABASE_KEY } = await import("../config.js");
    if (activeStorageBackend === "local" && SUPABASE_CONFIGURED && SUPABASE_URL && SUPABASE_KEY) {
      // Lightweight Supabase version check via REST (no full init/migrations)
      const { supabaseGet } = await import("../utils/supabaseApi.js");
      const rows = await supabaseGet("session_handoffs", {
        project: `eq.${project}`,
        select: "version",
        limit: "1",
      });
      const altVersion = Array.isArray(rows) && rows[0] ? (rows[0] as any).version : null;
      if (altVersion && altVersion !== version) {
        splitBrainWarning = `\n\n⚠️ **SPLIT-BRAIN DETECTED** (v${version} local vs v${altVersion} cloud)\n` +
          `Your local SQLite state (v${version}) differs from the Supabase cloud state (v${altVersion}). ` +
          `This means another client (e.g. Claude Desktop) has saved state that this environment cannot see. ` +
          `TODOs, summaries, and decisions may be stale. Please reconcile by running:\n` +
          `  \`prism load ${project} --storage supabase\` to see the cloud state.`;
        debugLog(`[session_load_context] SPLIT-BRAIN: local v${version} vs supabase v${altVersion}`);
      }
    } else if (activeStorageBackend === "supabase") {
      // When using Supabase as primary, local SQLite being stale is expected.
      // Only warn if local is NEWER (data loss risk). If local is older, that's
      // normal — cloud is authoritative.
      const dbPath = nodePath.join(os.homedir(), ".prism-mcp", "data.db");
      if (fs.existsSync(dbPath)) {
        let altClient: any = null;
        try {
          const { createClient } = await import("@libsql/client");
          altClient = createClient({ url: `file:${dbPath}` });
          const result = await altClient.execute(
            `SELECT version FROM session_handoffs WHERE project = ? LIMIT 1`,
            [project]
          );
          const altVersion = result.rows?.[0]?.version as number | undefined;
          if (altVersion && altVersion > (version as number)) {
            // Local is NEWER than cloud — this IS a real split-brain (data loss risk)
            splitBrainWarning = `\n\n⚠️ **SPLIT-BRAIN DETECTED** (v${version} cloud vs v${altVersion} local)\n` +
              `Your local SQLite state (v${altVersion}) is NEWER than Supabase cloud (v${version}). ` +
              `This means local work hasn't been pushed to cloud. Run:\n` +
              `  \`prism load ${project} --storage local\` to see the local state.`;
            debugLog(`[session_load_context] SPLIT-BRAIN: local v${altVersion} NEWER than supabase v${version}`);
          } else if (altVersion && altVersion !== version) {
            // Local is older — normal, cloud is authoritative. No warning needed.
            debugLog(`[session_load_context] Local SQLite v${altVersion} is stale (cloud v${version}) — expected when using Supabase backend`);
          }
        } finally {
          if (altClient) altClient.close();
        }
      }
    }
  } catch (err) {
    debugLog(`[session_load_context] Split-brain check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  // ─── Reality Drift Detection (v2.0 Step 5) ───
  // Check if the developer changed code since the last handoff save.
  let driftReport = "";
  const meta = (data as any)?.metadata;

  if (meta?.last_commit_sha) {
    const currentGit = getCurrentGitState();

    if (currentGit.isRepo) {
      if (meta.git_branch && currentGit.branch !== meta.git_branch) {
        // Branch switch — inform but don't panic
        driftReport = `\n\n⚠️ **CONTEXT SHIFT:** This memory was saved on branch ` +
          `\`${meta.git_branch}\`, but you are currently on branch \`${currentGit.branch}\`. ` +
          `Code may have diverged — review carefully before making changes.`;
        debugLog(
          `[session_load_context] Context shift detected: ${meta.git_branch} → ${currentGit.branch}`
        );
      } else if (currentGit.commitSha !== meta.last_commit_sha) {
        // Same branch, different commits — calculate drift
        const changes = getGitDrift(meta.last_commit_sha as string);
        if (changes) {
          driftReport = `\n\n⚠️ **REALITY DRIFT DETECTED**\n` +
            `Since this memory was saved (commit ${(meta.last_commit_sha as string).substring(0, 8)}), ` +
            `the following files were modified outside of agent sessions:\n\`\`\`\n${changes}\n\`\`\`\n` +
            `Please review these files if they overlap with your current task.`;
          debugLog(
            `[session_load_context] Reality drift detected! ${changes.split("\n").length} files changed`
          );
        }
      } else {
        debugLog(`[session_load_context] No drift — repo matches saved state`);
      }
    }
  }

  // ─── Morning Briefing (v2.0 Step 7) ───
  // If it's been more than 4 hours since the last briefing, generate a fresh one.
  // Otherwise, show the cached briefing from metadata.
  let briefingBlock = "";
  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
  const now = Date.now();
  const lastGenerated = meta?.briefing_generated_at as number || 0;

  if (now - lastGenerated > FOUR_HOURS_MS) {
    try {
      // Only import when needed — keeps cold start fast when not generating
      const { generateMorningBriefing } = await import("../utils/briefing.js");

      // Fetch recent ledger entries for context
      const recentRaw = await storage.getLedgerEntries({
        project: `eq.${project}`,
        user_id: `eq.${PRISM_USER_ID}`,
        order: "created_at.desc",
        limit: "10",
      });

      const recentEntries = (recentRaw as any[]).map(e => ({
        type: e.type || "entry",
        summary: e.summary || e.content || "",
      }));

      const contextObj = data as any;
      const briefingText = await generateMorningBriefing(
        {
          project,
          lastSummary: contextObj.last_summary ?? contextObj.summary ?? null,
          pendingTodos: contextObj.pending_todo ?? contextObj.active_context ?? null,
          keyContext: contextObj.key_context ?? null,
          activeBranch: contextObj.active_branch ?? null,
        },
        recentEntries
      );

      briefingBlock = `\n\n[🌅 MORNING BRIEFING]\n${briefingText}`;

      // Cache the briefing in metadata so we don't regenerate for 4 hours
      // Fire-and-forget — never block the context response
      const updatedMeta = { ...(meta || {}), briefing_generated_at: now, morning_briefing: briefingText };
      const handoffUpdate = {
        project,
        user_id: PRISM_USER_ID,
        metadata: updatedMeta,
        last_summary: contextObj.last_summary ?? null,
        pending_todo: contextObj.pending_todo ?? null,
        active_decisions: contextObj.active_decisions ?? null,
        keywords: contextObj.keywords ?? null,
        key_context: contextObj.key_context ?? null,
        active_branch: contextObj.active_branch ?? null,
      };
      const currentVersion = (data as any)?.version;
      if (currentVersion) {
        storage.saveHandoff(handoffUpdate, currentVersion).catch(err =>
          console.error(`[Morning Briefing] Cache save failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
        );
      }

      debugLog(`[session_load_context] Morning Briefing generated for "${project}"`);
    } catch (err) {
      console.error(`[session_load_context] Morning Briefing failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (meta?.morning_briefing) {
    // Show the cached briefing (generated within last 4 hours)
    briefingBlock = `\n\n[🌅 MORNING BRIEFING]\n${meta.morning_briefing}`;
    debugLog(`[session_load_context] Showing cached Morning Briefing for "${project}"`);
  }

  // ─── Visual Memory Index (v2.0 Step 9) ───
  // Show lightweight index of saved images — never loads actual image data
  let visualMemoryBlock = "";
  const visuals = (data as any)?.metadata?.visual_memory || [];
  if (visuals.length > 0) {
    visualMemoryBlock = `\n\n[🖼️ VISUAL MEMORY]\nThe following reference images are available. Use session_view_image(id) to view them if needed:\n`;
    visuals.forEach((v: any) => {
      visualMemoryBlock += `- [ID: ${v.id}] ${v.description} (${v.timestamp?.split("T")[0] || "unknown"})\n`;
    });
  }

  const d = data as Record<string, any>;
  let formattedContext = ``;
  if (d.last_summary) formattedContext += `📝 Last Summary: ${d.last_summary}\n`;
  if (d.active_branch) formattedContext += `🌿 Active Branch: ${d.active_branch}\n`;
  if (d.key_context) formattedContext += `💡 Key Context: ${d.key_context}\n`;
  
  if (d.pending_todo?.length) {
    formattedContext += `\n✅ Open TODOs:\n` + d.pending_todo.map((t: string) => `  - ${t}`).join("\n") + `\n`;
  }
  if (d.active_decisions?.length) {
    formattedContext += `\n⚖️ Active Decisions:\n` + d.active_decisions.map((dec: string) => `  - ${dec}`).join("\n") + `\n`;
  }
  if (d.keywords?.length) {
    formattedContext += `\n🔑 Keywords: ${d.keywords.join(", ")}\n`;
  }
  if (d.recent_sessions?.length) {
    const resultIds = d.recent_sessions.map((r: any) => r.id).filter(Boolean);
    if (resultIds.length > 0) recordMemoryAccess(resultIds);

    formattedContext += `\n⏳ Recent Sessions:\n` + d.recent_sessions.map((s: any) => {
      let impStr = "";
      if (typeof s.importance === 'number' && s.importance > 0) {
        const eff = computeEffectiveImportance(s.importance, s.last_accessed_at, s.created_at, Boolean(s.is_rollup));
        impStr = ` [Imp: ${eff}]`;
      }
      return `  [${s.session_date?.split("T")[0]}]${impStr} ${s.summary}`;
    }).join("\n") + `\n`;
  }
  if (d.session_history?.length) {
    formattedContext += `\n📂 Session History (${d.session_history.length} entries):\n` + d.session_history.map((s: any) => `  [${s.session_date?.split("T")[0]}] ${s.summary}`).join("\n") + `\n`;
  }
  if (d.recent_validations?.length) {
    formattedContext += `\n🔬 Recent Validations:\n` + d.recent_validations.map((v: any) => {
      const passStr = v.passed ? "✅ PASS" : "❌ FAIL";
      const icon = v.gate_action ? (v.passed ? "🚀" : "🛑") : "ℹ️";
      const dateStr = (v.run_at || "unknown").split("T")[0];
      const rateStr = Math.round((Number(v.pass_rate) || 0) * 100);
      let out = `  ${icon} [${dateStr}] ${passStr} (${rateStr}%)`;
      if (v.critical_failures > 0) {
        out += ` -> Critical Blockers: ${v.critical_failures}`;
      }
      return out;
    }).join("\n") + `\n`;
  }

  // ─── Role-Scoped Skill Injection ─────────────────────────────
  // If the active role has a skill document stored, append it so the
  // agent loads its rules/conventions automatically at session start.
  let skillBlock = "";
  let skillLoaded = false;
  if (effectiveRole) {
    const skillContent = await getSetting(`skill:${effectiveRole}`, "");
    if (skillContent && skillContent.trim()) {
      skillBlock = `\n\n[📜 ROLE SKILL: ${effectiveRole}]\n${skillContent.trim()}`;
      skillLoaded = true;
      debugLog(`[session_load_context] Injecting skill for role="${effectiveRole}" (${skillContent.length} chars)`);
    }
  }

  // ─── Agent Greeting Block ────────────────────────────────────
  // Shows agent identity (name + role) and skill status after briefing.
  let greetingBlock = "";
  if (agentName || effectiveRole) {
    const namePart = agentName ? `👋 **${agentName}**` : `👋 **Agent**`;
    const rolePart = effectiveRole ? ` · Role: \`${effectiveRole}\`` : "";
    const skillPart = skillLoaded ? ` · 📜 \`${effectiveRole}\` skill loaded` : (effectiveRole ? " · 📜 No skill configured" : "");
    greetingBlock = `\n\n[👤 AGENT IDENTITY]\n${namePart}${rolePart}${skillPart}`;
  }

  // ─── SDM Intuitive Recall (v5.5) ───
  // Generate embedding of current context and fetch latent SDM patterns
  let sdmRecallBlock = "";
  if (level !== "quick" && GOOGLE_API_KEY) {
    try {
      const activeText = [d.last_summary, d.key_context, ...(d.keywords || [])].filter(Boolean).join(" ");
      if (activeText.length > 10) {
        // v2.1 LLM factory handles the API call
        const queryVector = await getLLMProvider().generateEmbedding(activeText);
        
        // Lazy-load to avoid blocking server boot
        const { getSdmEngine } = await import("../sdm/sdmEngine.js");
        const { decodeSdmVector } = await import("../sdm/sdmDecoder.js");

        const sdmEngine = getSdmEngine(project);
        const targetVector = sdmEngine.read(new Float32Array(queryVector));
        
        const topMatches = await decodeSdmVector(project, targetVector, 3, 0.55);
        if (topMatches.length > 0) {
          sdmRecallBlock = `\n\n[🧠 INTUITIVE RECALL]\nThe deeper Superposed Memory matrix resonated with your current task and surfaced these latent patterns:\n`;
          for (const match of topMatches) {
             sdmRecallBlock += `- [Sim: ${(match.similarity * 100).toFixed(1)}%] ${match.summary}\n`;
          }
          debugLog(`[session_load_context] SDM Recall surfaced ${topMatches.length} latent patterns`);
        }
      }
    } catch (err) {
      debugLog(`[session_load_context] SDM Recall failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  // Build the response object before v4.0 augmentations
  let responseText = `📋 Session context for "${project}" (${level}):\n\n${formattedContext.trim()}${splitBrainWarning}${driftReport}${briefingBlock}${sdmRecallBlock}${greetingBlock}${visualMemoryBlock}${skillBlock}${versionNote}`;

  // ─── v4.0: Behavioral Warnings Injection ───────────────────
  // If loadContext returned behavioral_warnings, add them to the
  // formatted output so the agent sees them prominently.
  const behavWarnings = (data as any)?.behavioral_warnings as Array<{summary: string; importance: number}> | undefined;
  if (behavWarnings && behavWarnings.length > 0) {
    responseText += `\n\n[⚠️ BEHAVIORAL WARNINGS]\n` +
      behavWarnings.map(w => `- ${w.summary} (importance: ${w.importance})`).join("\n");
  }

  // ─── v9.4.7: ABA Precision Protocol (foundational) ────────
  // Injected into EVERY session load so the agent always operates
  // under these behavioral rules. Never truncated (placed before
  // token budget check).
  responseText += `\n\n[🧠 ABA PRECISION PROTOCOL]\n` +
    `Rule 1 — Observable Goals: Every task must have a measurable, verifiable outcome. State the specific result.\n` +
    `Rule 2 — Precise Execution: One step at a time. Verify each step. If it fails → STOP → fix → verify → then continue.\n` +
    `Rule 3 — No Reinforcement of Errors: Never repeat the same mistake twice. When the user says something is wrong, read the actual code/data FIRST before forming an opinion.\n` +
    `Rule 4 — No Negation/Filler Lead: NEVER start with "I can't", "I'm unable to", "Unfortunately", "I cannot", "I apologize", "While I cannot", "Sorry", "Regrettably", "I'm afraid", "As an AI", "Sure,", "Certainly,", "I can certainly". Affirmative words ("Yes", "Absolutely") ONLY permitted as direct answers to Yes/No questions. UNCERTAINTY ESCAPE: Only use "Missing: [item]" for specific required variables (patient_id, deploy ID). Do NOT use as generic refusal.\n` +
    `Rule 5 — Fix Without Asking: When you see a bug, fix it immediately. Do NOT ask "would you like me to fix that?" — just fix it.\n` +
    `Rule 6 — Action Intent: When user says "fix/run/open/deploy", they want ACTION not a tutorial. Ask for specific info needed in 1-2 sentences, or act directly.\n` +
    `Rule 7 — Tool Redirect (HELP AT ALL COST): When user asks to "open browser"/"run terminal"/"git push" — tell them HOW to switch to LOCAL mode (Cmd+Shift+P), describe what it will do, provide relevant URLs/commands, and ask a follow-up question to keep helping. Never just say "switch to LOCAL mode" and stop.`;

  // ─── v4.0: Token Budget Truncation ─────────────────────────
  // 1 token ≈ 4 chars heuristic. Truncate if response exceeds budget.
  if (maxTokens && maxTokens > 0) {
    const maxChars = maxTokens * 4;
    if (responseText.length > maxChars) {
      responseText = responseText.slice(0, maxChars) + "\n\n[… truncated to fit token budget]";
      debugLog(`[session_load_context] Truncated response to ${maxTokens} tokens (${maxChars} chars)`);
    }
  }

  return {
    content: [{ type: "text", text: responseText }],
    isError: false,
  };
}

export async function memoryHistoryHandler(args: unknown) {
  if (!isMemoryHistoryArgs(args)) {
    throw new Error("Invalid arguments for memory_history");
  }

  const { project, limit = 10 } = args;
  const storage = await getStorage();

  debugLog(`[memory_history] Fetching history for project="${project}" (limit=${limit})`);

  const history = await storage.getHistory(project, PRISM_USER_ID, Math.min(limit, 50));

  if (history.length === 0) {
    return {
      content: [{
        type: "text",
        text: `No memory history found for project "${project}".\n\n` +
          `History is automatically created each time you save a handoff.\n` +
          `Use session_save_handoff first, then check history again.`,
      }],
      isError: false,
    };
  }

  // Format timeline for LLM readability
  const timeline = history.map(h => {
    const summary = h.snapshot.last_summary || "(no summary)";
    const todos = h.snapshot.pending_todo?.length || 0;
    const branch = h.branch !== "main" ? ` [branch: ${h.branch}]` : "";
    return `  v${h.version} [${h.created_at}]${branch}\n    Summary: ${summary}\n    TODOs: ${todos} items`;
  }).join("\n\n");

  return {
    content: [{
      type: "text",
      text: `🕰️ Memory History for "${project}" (${history.length} snapshots):\n\n${timeline}\n\n` +
        `To revert to any version, use: memory_checkout with project="${project}" and target_version=<version number>.`,
    }],
    isError: false,
  };
}

export async function memoryCheckoutHandler(args: unknown) {
  if (!isMemoryCheckoutArgs(args)) {
    throw new Error("Invalid arguments for memory_checkout");
  }

  const { project, target_version } = args;
  const storage = await getStorage();

  debugLog(
    `[memory_checkout] Reverting project="${project}" to version ${target_version}`
  );

  // 1. Find the target snapshot
  const history = await storage.getHistory(project, PRISM_USER_ID, 50);
  const targetState = history.find(h => h.version === target_version);

  if (!targetState) {
    const available = history.map(h => `v${h.version}`).join(", ") || "none";
    return {
      content: [{
        type: "text",
        text: `❌ Version ${target_version} not found in history for "${project}".\n\n` +
          `Available versions: ${available}\n\n` +
          `Use memory_history to see the full timeline.`,
      }],
      isError: true,
    };
  }

  // 2. Get current state for OCC
  const currentContext = await storage.loadContext(project, "quick", PRISM_USER_ID);
  const currentVersion = currentContext ? (currentContext as Record<string, unknown>).version as number : null;

  // 3. Build the revert handoff — copy the historical snapshot but mark it as a revert
  const revertHandoff = {
    ...targetState.snapshot,
    project,
    user_id: PRISM_USER_ID,
    last_summary: `[REVERTED TO v${target_version}] ${targetState.snapshot.last_summary || ""}`,
  };

  // 4. Save with OCC — pass current version to prevent race conditions
  const result = await storage.saveHandoff(revertHandoff, currentVersion);

  if (result.status === "conflict") {
    return {
      content: [{
        type: "text",
        text: `⚠️ Version conflict during checkout! Another session updated the project.\n\n` +
          `Current version: ${result.current_version}\n` +
          `Call session_load_context to see the latest state, then try again.`,
      }],
      isError: true,
    };
  }

  // 5. Save the revert itself to history (so you can undo the undo)
  const revertSnapshotEntry = {
    ...revertHandoff,
    version: result.version,
  };
  await storage.saveHistorySnapshot(revertSnapshotEntry).catch(err =>
    console.error(`[memory_checkout] History snapshot of revert failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
  );

  const newVersion = result.version;

  return {
    content: [{
      type: "text",
      text: `🕰️ Time travel successful!\n\n` +
        `• Project: "${project}"\n` +
        `• Reverted from: v${currentVersion || "?"} → restored v${target_version}\n` +
        `• New current version: v${newVersion}\n` +
        `• Summary: ${targetState.snapshot.last_summary || "(no summary)"}\n\n` +
        `The project's memory has been restored to the state from ${targetState.created_at}.\n` +
        `This revert is also saved in history, so you can undo it with another memory_checkout.\n\n` +
        `🔑 Remember: pass expected_version: ${newVersion} on your next save.`,
    }],
    isError: false,
  };
}

export async function sessionSaveImageHandler(args: unknown) {
  if (!isSessionSaveImageArgs(args)) {
    return {
      content: [{ type: "text", text: "Invalid arguments. Requires: project, file_path, description." }],
      isError: true,
    };
  }

  const { project, file_path, description } = args;

  // Resolve path (supports relative paths)
  const resolvedPath = nodePath.resolve(file_path);
  if (!fs.existsSync(resolvedPath)) {
    return {
      content: [{ type: "text", text: `Error: File not found at "${resolvedPath}".` }],
      isError: true,
    };
  }

  // Validate extension
  const ext = nodePath.extname(resolvedPath).toLowerCase() || ".png";
  const SUPPORTED_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"];
  if (!SUPPORTED_EXTS.includes(ext)) {
    return {
      content: [{
        type: "text",
        text: `Error: Unsupported image format "${ext}". Supported: ${SUPPORTED_EXTS.join(", ")}.`,
      }],
      isError: true,
    };
  }

  // Setup media vault directory
  const mediaDir = nodePath.join(os.homedir(), ".prism-mcp", "media", project);
  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
  }

  // Copy to vault with short UUID
  const imageId = randomUUID().slice(0, 8);
  const vaultFilename = `${imageId}${ext}`;
  const vaultPath = nodePath.join(mediaDir, vaultFilename);
  fs.copyFileSync(resolvedPath, vaultPath);

  // Update handoff metadata
  const storage = await getStorage();
  const context = await storage.loadContext(project, "quick", PRISM_USER_ID);

  if (!context) {
    return {
      content: [{
        type: "text",
        text: `Error: No active context for project "${project}". Save a handoff first.`,
      }],
      isError: true,
    };
  }

  const contextObj = context as any;
  const meta = contextObj.metadata || {};
  meta.visual_memory = meta.visual_memory || [];
  meta.visual_memory.push({
    id: imageId,
    description,
    filename: vaultFilename,
    original_path: resolvedPath,
    timestamp: new Date().toISOString(),
  });

  // Save back (triggers history snapshot + telepathy)
  const handoffUpdate = {
    project,
    user_id: PRISM_USER_ID,
    metadata: meta,
    last_summary: contextObj.last_summary ?? null,
    pending_todo: contextObj.pending_todo ?? null,
    active_decisions: contextObj.active_decisions ?? null,
    keywords: contextObj.keywords ?? null,
    key_context: contextObj.key_context ?? null,
    active_branch: contextObj.active_branch ?? null,
  };

  const currentVersion = contextObj.version;
  await storage.saveHandoff(handoffUpdate, currentVersion);

  const fileSize = fs.statSync(vaultPath).size;
  const sizeKB = (fileSize / 1024).toFixed(1);
  debugLog(`[Visual Memory] Saved image [${imageId}] for "${project}" (${sizeKB}KB, ${ext})`);

  // Fire-and-forget VLM captioning (2-5s — don’t block the MCP response)
  fireCaptionAsync(project, imageId, vaultPath, description);

  return {
    content: [{
      type: "text",
      text: `✅ Image saved to visual memory.\n\n` +
        `• ID: \`${imageId}\`\n` +
        `• Description: ${description}\n` +
        `• Format: ${ext} (${sizeKB}KB)\n` +
        `• Vault: ${vaultPath}\n` +
        `• Captioning: ⏳ queued (will be searchable in ~5s)\n\n` +
        `Use \`session_view_image("${project}", "${imageId}")\` to retrieve it later.`,
    }],
    isError: false,
  };
}

export async function sessionViewImageHandler(args: unknown) {
  if (!isSessionViewImageArgs(args)) {
    return {
      content: [{ type: "text", text: "Invalid arguments. Requires: project, image_id." }],
      isError: true,
    };
  }

  const { project, image_id } = args;

  // Load context to find image metadata
  const storage = await getStorage();
  const context = await storage.loadContext(project, "quick", PRISM_USER_ID);
  const visuals = (context as any)?.metadata?.visual_memory || [];
  const imgMeta = visuals.find((v: any) => v.id === image_id);

  if (!imgMeta) {
    return {
      content: [{
        type: "text",
        text: `Error: Image ID [${image_id}] not found in visual memory for project "${project}".` +
          (visuals.length > 0
            ? `\n\nAvailable IDs: ${visuals.map((v: any) => `${v.id} (${v.description})`).join(", ")}`
            : "\n\nNo images saved in visual memory yet."),
      }],
      isError: true,
    };
  }

  const vaultPath = nodePath.join(os.homedir(), ".prism-mcp", "media", project, imgMeta.filename);
  if (!fs.existsSync(vaultPath)) {
    return {
      content: [{
        type: "text",
        text: `Error: Image file missing from vault at "${vaultPath}". ` +
          `The metadata exists but the file was deleted.`,
      }],
      isError: true,
    };
  }

  // Read file and convert to base64
  const base64Data = fs.readFileSync(vaultPath).toString("base64");

  // Determine MIME type from extension
  const ext = nodePath.extname(imgMeta.filename).toLowerCase();
  const MIME_MAP: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
  };
  const mimeType = MIME_MAP[ext] || "image/png";

  const fileSize = fs.statSync(vaultPath).size;
  debugLog(`[Visual Memory] Retrieved image [${image_id}] for "${project}" (${(fileSize / 1024).toFixed(1)}KB)`);

  // Return MCP content array with text + image
  return {
    content: [
      {
        type: "text",
        text: `🖼️ Visual Memory [${image_id}]: ${imgMeta.description}\n` +
          `Saved: ${imgMeta.timestamp?.split("T")[0] || "unknown"}\n` +
          `Format: ${ext.replace(".", "").toUpperCase()} (${(fileSize / 1024).toFixed(1)}KB)` +
          (imgMeta.caption ? `\n\n🤖 VLM Caption:\n${imgMeta.caption}` : "\n\n⏳ Caption: generating..."),
      },
      {
        type: "image",
        data: base64Data,
        mimeType: mimeType,
      },
    ],
    isError: false,
  };
}

export async function sessionForgetMemoryHandler(args: unknown) {
  try {
    // ─── Input Validation ───
    if (!isSessionForgetMemoryArgs(args)) {
      return {
        content: [{
          type: "text",
          text: "Invalid arguments. Required: memory_id (string). Optional: hard_delete (boolean), reason (string).",
        }],
        isError: true,
      };
    }

    const { memory_id, hard_delete = false, reason } = args;

    // ─── Get Storage Backend ───
    const storage = await getStorage();

    // ─── Execute Deletion ───
    // The storage methods verify user_id ownership internally,
    // preventing cross-user deletion attacks.
    if (hard_delete) {
      // IRREVERSIBLE: Physical removal from the database.
      // FTS5 triggers (SQLite) or Supabase cascades clean up indexes.
      await storage.hardDeleteLedger(memory_id, PRISM_USER_ID);

      debugLog(`[session_forget_memory] Hard-deleted entry ${memory_id}`);

      return {
        content: [{
          type: "text",
          text: `🗑️ **Hard Deleted** memory entry \`${memory_id}\`.\n\n` +
            `This entry has been permanently removed from the database. ` +
            `It cannot be recovered. All associated embeddings and FTS indexes ` +
            `have been cleaned up.`,
        }],
        isError: false,
      };
    } else {
      // REVERSIBLE: Soft-delete (tombstone) — sets deleted_at + deleted_reason.
      // The entry remains in the database but is excluded from ALL search
      // queries (vector, FTS5, and context loading).
      await storage.softDeleteLedger(memory_id, PRISM_USER_ID, reason);

      debugLog(`[session_forget_memory] Soft-deleted entry ${memory_id} (reason: ${reason || "none"})`);

      return {
        content: [{
          type: "text",
          text: `🔇 **Soft Deleted** memory entry \`${memory_id}\`.\n\n` +
            `The entry has been tombstoned (deleted_at = NOW()). ` +
            `It will no longer appear in any search results, but remains ` +
            `in the database for audit trail purposes.\n\n` +
            (reason ? `📋 **Reason**: ${reason}\n\n` : "") +
            `To permanently remove this entry, call again with \`hard_delete: true\`.`,
        }],
        isError: false,
      };
    }
  } catch (error) {
    console.error(`[session_forget_memory] Error: ${error}`);
    return {
      content: [{
        type: "text",
        text: `Error forgetting memory: ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
    };
  }
}

export async function sessionSaveExperienceHandler(args: unknown) {
  if (!isSessionSaveExperienceArgs(args)) {
    throw new Error("Invalid arguments for session_save_experience");
  }

  const { project, event_type, context: ctx, action, outcome, correction, confidence_score, role } = args;
  const storage = await getStorage();

  debugLog(`[session_save_experience] Recording ${event_type} event for project="${project}"`);

  // Format structured summary from event fields
  let summary = `[${event_type.toUpperCase()}] ${ctx} → ${action} → ${outcome}`;
  if (event_type === "correction" && correction) {
    summary += ` | CORRECTION: ${correction}`;
  }

  // Auto-extract keywords from the structured summary
  const keywords = toKeywordArray(summary);
  debugLog(`[session_save_experience] Extracted ${keywords.length} keywords: ${keywords.slice(0, 5).join(", ")}...`);

  const effectiveRole = role || await getSetting("default_role", "global");

  const result = await storage.saveLedger({
    project,
    conversation_id: "experience-event",
    user_id: PRISM_USER_ID,
    role: effectiveRole,
    event_type,
    summary,
    decisions: [
      `Context: ${ctx}`,
      `Action: ${action}`,
      `Outcome: ${outcome}`,
      ...(correction ? [`Correction: ${correction}`] : []),
    ],
    keywords,
    confidence_score: typeof confidence_score === "number" ? confidence_score : undefined,
    // Corrections start with importance 1 to jumpstart visibility
    importance: event_type === "correction" ? 1 : 0,
  });

  // Fire-and-forget embedding generation
  if (GOOGLE_API_KEY && result) {
    const embeddingText = summary;
    const savedEntry = Array.isArray(result) ? result[0] : result;
    const entryId = (savedEntry as any)?.id;

    if (entryId) {
      getLLMProvider().generateEmbedding(embeddingText)
        .then(async (embedding) => {
          await storage.patchLedger(entryId, {
            embedding: JSON.stringify(embedding),
          });
          debugLog(`[session_save_experience] Embedding saved for entry ${entryId}`);
        })
        .catch((err) => {
          console.error(`[session_save_experience] Embedding failed (non-fatal): ${err.message}`);
        });
    }
  }

  return {
    content: [{
      type: "text",
      text: `✅ Experience recorded: ${event_type} for project "${project}"\n` +
        `Summary: ${summary}\n` +
        (confidence_score !== undefined ? `Confidence: ${confidence_score}%\n` : "") +
        `Importance: ${event_type === "correction" ? 1 : 0} (upvote to increase)`,
    }],
    isError: false,
  };
}

export async function sessionExportMemoryHandler(args: unknown) {
  if (!isSessionExportMemoryArgs(args)) {
    return {
      content: [{ type: "text", text: "Error: output_dir (string) is required." }],
      isError: true,
    };
  }

  const { output_dir, format = "json" } = args;
  const requestedProject = (args as { project?: string }).project;

  // Validate output directory
  if (!existsSync(output_dir)) {
    return {
      content: [{
        type: "text",
        text: `Error: output_dir does not exist: "${output_dir}". Please create it first.`,
      }],
      isError: true,
    };
  }

  const storage = await getStorage();
  const exportedFiles: string[] = [];

  try {
    // Determine which projects to export
    let projects: string[];
    if (requestedProject) {
      projects = [requestedProject];
    } else {
      projects = await storage.listProjects();
      if (projects.length === 0) {
        return {
          content: [{ type: "text", text: "No projects found in memory — nothing to export." }],
          isError: false,
        };
      }
    }

    // Fetch settings once (shared across all projects)
    const rawSettings = await getAllSettings();
    const safeSettings = redactSettings(rawSettings);
    const exportedAt = new Date().toISOString();
    const dateSuffix = exportedAt.split("T")[0]; // YYYY-MM-DD

    for (const project of projects) {
      debugLog(`[session_export_memory] Exporting project "${project}" as ${format}`);

      // Fetch handoff (live context)
      const ctx = await storage.loadContext(project, "deep", PRISM_USER_ID) as {
        metadata?: { visual_memory?: unknown[] };
        [key: string]: unknown;
      } | null;

      // Fetch full ledger (all non-deleted entries, capped at 10k as OOM guard)
      const ledger = await storage.getLedgerEntries({
        project: `eq.${project}`,
        order: "created_at.asc",
        limit: "10000",
      }) as Array<{
        id?: string;
        created_at?: string;
        event_type?: string;
        summary: string;
        todos?: string[];
        decisions?: string[];
        files_changed?: string[];
        embedding?: string | null; // strip from export (large + not human-useful)
        [key: string]: unknown;
      }>;

      // Strip raw embedding vectors from the export (large binary / not human-useful)
      // embedding: raw float32 JSON array (~12KB/entry)
      // embedding_compressed: TurboQuant binary blob (~400B/entry, base64 in JSON)
      const cleanLedger = ledger.map(({ embedding: _emb, embedding_compressed: _ec, ...rest }) => rest);

      const visualMemory = (ctx?.metadata?.visual_memory as unknown[] | undefined) ?? [];

      const exportPayload = {
        prism_export: {
          version: "6.1",
          exported_at: exportedAt,
          project,
          settings: safeSettings,
          handoff: ctx ?? null,
          visual_memory: visualMemory,
          ledger: cleanLedger,
        },
      };

      // Serialize
      const ext = format === "markdown" ? "md" : format === "vault" ? "zip" : "json";
      const filename = `prism-export-${project}-${dateSuffix}.${ext}`;
      const outputPath = join(output_dir, filename);

      let content: string | Buffer;
      if (format === "vault") {
        const vaultFiles = buildVaultDirectory(exportPayload);
        content = Buffer.from(fflate.zipSync(vaultFiles));
      } else if (format === "markdown") {
        content = toMarkdown(exportPayload);
      } else {
        content = JSON.stringify(exportPayload, null, 2);
      }

      if (format === "vault") {
        await writeFile(outputPath, content as Buffer);
      } else {
        await writeFile(outputPath, content as string, "utf-8");
      }
      exportedFiles.push(outputPath);
      debugLog(`[session_export_memory] Wrote ${content.length} bytes to ${outputPath}`);
    }

    const plural = exportedFiles.length > 1 ? "files" : "file";
    return {
      content: [{
        type: "text",
        text:
          `✅ Memory exported successfully (${format.toUpperCase()})\n\n` +
          `**Project(s):** ${projects.join(", ")}\n` +
          `**${exportedFiles.length} ${plural} written:**\n` +
          exportedFiles.map(f => `  \u2022 \`${f}\``).join("\n") +
          `\n\n⚠️ API keys have been redacted. Vault image files are NOT included — ` +
          `only metadata and captions. Re-run \`session_save_image\` to re-attach images.`,
      }],
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[session_export_memory] Error: ${msg}`);
    return {
      content: [{ type: "text", text: `Export failed: ${msg}` }],
      isError: true,
    };
  }
}
