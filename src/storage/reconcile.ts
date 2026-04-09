/**
 * Cross-Backend Handoff & Ledger Reconciliation (v9.2.4)
 *
 * Fixes the split-brain data inconsistency where writes made via
 * Claude Desktop (Supabase) are invisible to Antigravity (local SQLite).
 *
 * SYNCS TWO LAYERS:
 *   1. session_handoffs — latest project state (TODOs, summary, decisions)
 *   2. session_ledger   — recent session history (used by standard/deep loads)
 *
 * WHEN THIS RUNS:
 *   - Automatically during getStorage() initialization when:
 *     1. The active backend is "local" (SQLite), AND
 *     2. Supabase credentials are available (env or dashboard config)
 *
 * PERFORMANCE:
 *   - 2 Supabase REST calls per synced project:
 *     - session_handoffs: 1-5 rows (~1KB) → instant
 *     - session_ledger: last 20 entries per stale project (~50KB) → fast
 *   - Local SQLite: bulk timestamp check + targeted ID lookups + N upserts
 *   - Total: ~300-800ms (dominated by network, not DB)
 *   - Safe for databases with millions of entries — scoped queries only
 *
 * DESIGN:
 *   - Read-only on Supabase (never writes to remote)
 *   - Last-writer-wins by updated_at/created_at timestamp
 *   - Non-blocking: wrapped in try/catch, errors downgraded to debug log
 *   - Idempotent: safe to run on every boot (ledger uses ID dedup)
 *   - 5-second timeout on Supabase calls to prevent startup freeze
 */

import { supabaseGet } from "../utils/supabaseApi.js";
import { debugLog } from "../utils/logger.js";
import { PRISM_USER_ID } from "../config.js";
import type { StorageBackend } from "./interface.js";

/** Timeout for each Supabase REST call (ms). Prevents startup freeze. */
const RECONCILE_TIMEOUT_MS = 5_000;

export interface ReconcileResult {
  checked: number;
  synced: number;
  projects: string[];
  ledgerEntriesSynced: number;
}

/**
 * Safely parse a JSON array field from Supabase.
 * Handles: arrays (pass-through), JSON strings (parse), garbage (empty array).
 * Never throws.
 */
function safeParseArray(val: unknown): string[] {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Wrap a promise with a timeout. Rejects with AbortError if exceeded.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[Reconcile] Timeout after ${ms}ms: ${label}`)),
      ms,
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Pull newer handoffs AND recent ledger entries from Supabase into local SQLite.
 *
 * @param localStorage - The initialized SqliteStorage instance
 * @param getLocalTimestamps - Function to bulk-read local handoff timestamps
 * @returns Summary of what was synced
 */
export async function reconcileHandoffs(
  localStorage: StorageBackend,
  getLocalTimestamps?: () => Promise<Map<string, string>>,
): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, synced: 0, projects: [], ledgerEntriesSynced: 0 };

  try {
    // ═══════════════════════════════════════════════════════════
    // LAYER 1: Handoff Reconciliation (session_handoffs)
    // ═══════════════════════════════════════════════════════════

    // Step 1: Fetch all handoffs from Supabase (single REST call, ~1-5 rows)
    // Timeout prevents startup freeze if Supabase is slow/unreachable.
    const remoteHandoffs = await withTimeout(
      supabaseGet("session_handoffs", {
        user_id: `eq.${PRISM_USER_ID}`,
        select: "*",
      }),
      RECONCILE_TIMEOUT_MS,
      "fetch handoffs",
    ) as Record<string, unknown>[];

    if (!Array.isArray(remoteHandoffs) || remoteHandoffs.length === 0) {
      debugLog("[Reconcile] No remote handoffs found — nothing to sync");
      return result;
    }

    result.checked = remoteHandoffs.length;

    // Step 2: Get all local handoff timestamps in one query (not per-project)
    let localTimestamps: Map<string, string>;
    if (getLocalTimestamps) {
      localTimestamps = await getLocalTimestamps();
    } else {
      // Fallback: empty map means all remotes will be synced
      localTimestamps = new Map();
    }

    // Step 3: Compare and sync only stale handoffs
    // Use a Set to deduplicate projects with multiple roles (FIX #6)
    const syncedProjectsSet = new Set<string>();

    for (const remote of remoteHandoffs) {
      const project = remote.project as string;
      const role = (remote.role as string) || "global";
      const key = `${project}::${role}`;
      const remoteUpdatedAt = remote.updated_at as string;
      const localUpdatedAt = localTimestamps.get(key);

      // Sync if: local doesn't exist, or remote is newer
      const needsSync = !localUpdatedAt
        || (remoteUpdatedAt && new Date(remoteUpdatedAt) > new Date(localUpdatedAt));

      if (needsSync) {
        // FIX #4: safeParseArray prevents JSON.parse crash from aborting all projects
        await localStorage.saveHandoff({
          project,
          user_id: PRISM_USER_ID,
          role,
          last_summary: (remote.last_summary as string) ?? null,
          pending_todo: safeParseArray(remote.pending_todo),
          active_decisions: safeParseArray(remote.active_decisions),
          keywords: safeParseArray(remote.keywords),
          key_context: (remote.key_context as string) ?? null,
          active_branch: (remote.active_branch as string) ?? null,
          metadata: typeof remote.metadata === "object" && remote.metadata !== null ? remote.metadata as Record<string, unknown> : {},
        });

        result.synced++;
        result.projects.push(project);
        syncedProjectsSet.add(project);  // FIX #6: dedup multi-role projects
        debugLog(
          `[Reconcile] Synced handoff "${project}" (role: ${role}) — ` +
          `remote: ${remoteUpdatedAt}, local: ${localUpdatedAt || "missing"}`
        );
      }
    }

    // ═══════════════════════════════════════════════════════════
    // LAYER 2: Recent Ledger Reconciliation (session_ledger)
    //
    // For any project whose handoff was stale, also pull recent
    // ledger entries so that standard/deep context loads include
    // session history written via Supabase.
    //
    // We only pull the last 20 entries per project (not the full
    // history) — this covers standard/deep context needs without
    // doing a bulk data migration.
    // ═══════════════════════════════════════════════════════════

    if (syncedProjectsSet.size > 0) {
      result.ledgerEntriesSynced = await reconcileLedger(
        localStorage,
        [...syncedProjectsSet],  // FIX #6: deduplicated list
      );
    }

    if (result.synced > 0) {
      // FIX #7: Use debugLog instead of console.error for non-error output
      debugLog(
        `[Prism Reconcile] Synced ${result.synced} handoff(s)` +
        `${result.ledgerEntriesSynced > 0 ? ` + ${result.ledgerEntriesSynced} ledger entries` : ""}` +
        ` from Supabase → SQLite: ${result.projects.join(", ")}`
      );
    } else {
      debugLog("[Reconcile] All local data is up-to-date with Supabase");
    }
  } catch (err) {
    // Non-fatal: log and continue. Supabase may be unreachable (offline mode).
    debugLog(
      `[Reconcile] Failed to reconcile (non-fatal): ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
  }

  return result;
}

/**
 * Pull recent ledger entries from Supabase for the given projects.
 *
 * Uses targeted ID lookup for dedup: only queries the specific IDs
 * returned from Supabase, not the entire local ledger. (FIX #2)
 *
 * @param localStorage - The initialized StorageBackend (SQLite)
 * @param projects - Deduplicated list of projects with stale handoffs
 * @returns Number of ledger entries synced
 */
async function reconcileLedger(
  localStorage: StorageBackend,
  projects: string[],
): Promise<number> {
  let totalSynced = 0;

  for (const project of projects) {
    try {
      // Fetch the 20 most recent ledger entries for this project
      // Timeout prevents hang if Supabase is slow (FIX #3)
      const remoteLedger = await withTimeout(
        supabaseGet("session_ledger", {
          user_id: `eq.${PRISM_USER_ID}`,
          project: `eq.${project}`,
          archived_at: "is.null",
          deleted_at: "is.null",
          select: "id,project,conversation_id,summary,user_id,role,todos,files_changed,decisions,keywords,event_type,importance,created_at,session_date",
          order: "created_at.desc",
          limit: "20",
        }),
        RECONCILE_TIMEOUT_MS,
        `fetch ledger for ${project}`,
      ) as Record<string, unknown>[];

      if (!Array.isArray(remoteLedger) || remoteLedger.length === 0) {
        continue;
      }

      // FIX #2: Only query the specific IDs we need to check — not the entire ledger.
      // This is O(remote_count) not O(total_ledger_entries).
      const remoteIds = remoteLedger.map(e => e.id as string);
      const existingEntries = await localStorage.getLedgerEntries({
        ids: remoteIds,
        select: "id",
      });
      const existingIds = new Set(
        (Array.isArray(existingEntries) ? existingEntries : [])
          .map((e: any) => e.id as string)
      );

      // Insert only entries that don't exist locally
      for (const entry of remoteLedger) {
        if (existingIds.has(entry.id as string)) {
          continue; // Already exists locally
        }

        try {
          await localStorage.saveLedger({
            id: entry.id as string,
            project: entry.project as string,
            conversation_id: (entry.conversation_id as string) || "reconciled",
            summary: entry.summary as string,
            user_id: PRISM_USER_ID,
            role: (entry.role as string) || "global",
            todos: safeParseArray(entry.todos),
            files_changed: safeParseArray(entry.files_changed),
            decisions: safeParseArray(entry.decisions),
            keywords: safeParseArray(entry.keywords),
            event_type: (entry.event_type as string) || "session",
            importance: (entry.importance as number) || 0,
          });
          totalSynced++;
        } catch (insertErr) {
          // Skip entries that fail (e.g., UNIQUE constraint = already exists)
          const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
          if (!msg.includes("UNIQUE") && !msg.includes("constraint")) {
            debugLog(`[Reconcile] Failed to insert ledger entry ${entry.id}: ${msg}`);
          }
        }
      }

      debugLog(
        `[Reconcile] Ledger sync for "${project}": ${remoteLedger.length} remote, ` +
        `${existingIds.size} already local, ${totalSynced} new`
      );
    } catch (err) {
      debugLog(
        `[Reconcile] Ledger sync failed for "${project}" (non-fatal): ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return totalSynced;
}
