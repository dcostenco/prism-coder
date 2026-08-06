import {
  PRISM_STORAGE as ENV_PRISM_STORAGE,
  SUPABASE_CONFIGURED,
  SYNALUX_CONFIGURED,
  PRISM_FORCE_LOCAL,
} from "../config.js";
import { debugLog } from "../utils/logger.js";
import { SupabaseStorage } from "./supabase.js";
import type { StorageBackend } from "./interface.js";
import { getSetting } from "./configStorage.js";

export function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    // Plain http is accepted ONLY for loopback, where the traffic never leaves
    // the machine — the local Supabase stack runs on 127.0.0.1:54321.
    //
    // Every caller of this function is gating a CLOUD backend, so accepting
    // http for a remote host meant session content — summaries, decisions,
    // filenames — could be sent unencrypted. The privacy policy states this
    // traffic travels over TLS; before this change that was true only because
    // the default base URL happens to be https, not because anything enforced
    // it. A published claim should be guaranteed by the code, not by a default
    // the user can silently override.
    if (parsed.protocol !== "http:") return false;
    const host = parsed.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Probe for synalux credentials: env vars first, then config DB.
 * Returns true if usable credentials are now in process.env.
 */
export async function ensureSynaluxCredentials(): Promise<boolean> {
  if (SYNALUX_CONFIGURED) return true;
  // Re-check process.env directly: SYNALUX_CONFIGURED is captured at module
  // load, so credentials injected later by another caller would be invisible
  // to it. Mirrors ensureSupabaseCredentials below.
  const envUrl = process.env.PRISM_SYNALUX_BASE_URL?.trim() || process.env.SYNALUX_BASE_URL?.trim();
  const envKey = process.env.PRISM_SYNALUX_API_KEY?.trim();
  if (envUrl && envKey && isValidHttpUrl(envUrl)) return true;
  const url = (await getSetting("PRISM_SYNALUX_BASE_URL"))?.trim() ||
    (await getSetting("SYNALUX_BASE_URL"))?.trim();
  const key = (await getSetting("PRISM_SYNALUX_API_KEY"))?.trim();
  if (url && key && isValidHttpUrl(url)) {
    process.env.PRISM_SYNALUX_BASE_URL = url;
    process.env.PRISM_SYNALUX_API_KEY = key;
    debugLog("[Prism Storage] Synalux credentials loaded from dashboard config");
    return true;
  }
  return false;
}

/**
 * Probe for direct-Supabase credentials: env vars first, then config DB.
 * Returns true if usable credentials are now in process.env.
 */
async function ensureSupabaseCredentials(): Promise<boolean> {
  if (SUPABASE_CONFIGURED) return true;
  const envUrl = process.env.SUPABASE_URL?.trim();
  const envKey = process.env.SUPABASE_KEY?.trim();
  if (envUrl && envKey && isValidHttpUrl(envUrl)) return true;
  const url = (await getSetting("SUPABASE_URL"))?.trim();
  const key = (await getSetting("SUPABASE_KEY"))?.trim();
  if (url && key && isValidHttpUrl(url)) {
    process.env.SUPABASE_URL = url;
    process.env.SUPABASE_KEY = key;
    debugLog("[Prism Storage] Supabase credentials loaded from dashboard config");
    return true;
  }
  return false;
}

let storageInstance: StorageBackend | null = null;
export let activeStorageBackend: string = "local";

export async function getStorage(): Promise<StorageBackend> {
  if (storageInstance) return storageInstance;

  const envStorage = process.env.PRISM_STORAGE as "supabase" | "synalux" | "local" | "auto" | undefined;
  let requested = (envStorage || await getSetting("PRISM_STORAGE", ENV_PRISM_STORAGE)) as "supabase" | "synalux" | "local" | "auto";

  if (PRISM_FORCE_LOCAL) {
    requested = "local";
    debugLog("[Prism Storage] PRISM_FORCE_LOCAL=true — forcing local SQLite");
  }

  // ─── Resolve "auto" → synalux > supabase > local ─────────────
  // Synalux is eligible only when the portal is the entitlement source;
  // direct Supabase remains an independent legacy backend.
  if (requested === "auto") {
    if (await ensureSynaluxCredentials()) {
      const { getEntitlements } = await import("../utils/entitlements.js");
      const entitlements = await getEntitlements();
      const memoryEntitled = entitlements.features?.session_memory_unlimited;

      if (entitlements.source !== "portal" || typeof memoryEntitled !== "boolean") {
        throw new Error(
          "[Prism Storage] Could not verify the Synalux cloud-memory entitlement. " +
          "Refusing to fall back to another backend because that could split session history. " +
          "Retry when Synalux is reachable or set PRISM_STORAGE=local explicitly.",
        );
      }
      requested = memoryEntitled ? "synalux" : "local";
    } else if (await ensureSupabaseCredentials()) {
      requested = "supabase";
    } else {
      requested = "local";
    }
    debugLog(`[Prism Storage] Auto-resolved: ${requested}`);
  }

  // ─── Validate explicit backend has credentials ────────────────
  // An explicitly requested cloud backend with missing credentials must fail
  // loud. Silently serving local SQLite splits session history: the caller
  // keeps working against a stale local copy while believing it is on the
  // cloud, and console.error goes to stderr, which MCP hosts discard. "auto"
  // already refuses to fall back for this exact reason (see above); naming a
  // backend outright is a stronger statement of intent, so it must not be
  // weaker about protecting history.
  //
  // Observed in the field: a base URL present without its API key (a
  // `prism connect` run from a shell that never exported the key strips it)
  // downgraded every subsequent session to local storage for weeks. The local
  // copy kept serving months-old context while the cloud held current history,
  // and nothing in-band surfaced the downgrade.
  //
  // This throw is deliberately NOT matched by isRecoverableStartupStorageError
  // (startupRecovery.ts): a missing credential is a configuration fault, not a
  // transient one, so startup must not paper over it with last-good context.
  if (requested === "synalux" && !(await ensureSynaluxCredentials())) {
    throw new Error(
      "[Prism Storage] PRISM_STORAGE=synalux but Synalux credentials are missing or invalid " +
      "(need PRISM_SYNALUX_BASE_URL and PRISM_SYNALUX_API_KEY). " +
      "Refusing to fall back to local storage because that silently splits session history. " +
      "Set PRISM_STORAGE=local explicitly if local-only storage is intended.",
    );
  }
  if (requested === "supabase" && !(await ensureSupabaseCredentials())) {
    throw new Error(
      "[Prism Storage] PRISM_STORAGE=supabase but Supabase credentials are missing or invalid " +
      "(need SUPABASE_URL and SUPABASE_KEY). " +
      "Refusing to fall back to local storage because that silently splits session history. " +
      "Set PRISM_STORAGE=local explicitly if local-only storage is intended.",
    );
  }

  // ─── Initialize ───────────────────────────────────────────────
  activeStorageBackend = requested;
  debugLog(`[Prism Storage] Initializing backend: ${activeStorageBackend}`);

  if (activeStorageBackend === "synalux") {
    const { SynaluxStorage } = await import("./synalux.js");
    storageInstance = new SynaluxStorage();
  } else if (activeStorageBackend === "supabase") {
    storageInstance = new SupabaseStorage();
  } else if (activeStorageBackend === "local") {
    const { SqliteStorage } = await import("./sqlite.js");
    storageInstance = new SqliteStorage();
  } else {
    throw new Error(`Unknown PRISM_STORAGE value: "${activeStorageBackend}".`);
  }

  await storageInstance.initialize(activeStorageBackend === "local");

  // ─── Cross-backend reconciliation (local + Supabase available) ─
  // v9.2.4: when running on local SQLite but Supabase credentials exist, pull
  // newer handoffs from Supabase into SQLite. Fixes the split-brain where one
  // client (e.g. Claude Desktop) writes to Supabase but another (e.g.
  // Antigravity) reads from SQLite and sees stale data.
  if (activeStorageBackend === "local" && await ensureSupabaseCredentials()) {
    try {
      const { reconcileHandoffs } = await import("./reconcile.js");
      const { SqliteStorage } = await import("./sqlite.js");
      const sqliteInstance = storageInstance as InstanceType<typeof SqliteStorage>;
      await reconcileHandoffs(storageInstance!, () => sqliteInstance.getHandoffTimestamps());
    } catch (err) {
      debugLog(`[Prism Storage] Reconciliation skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return storageInstance;
}

export async function closeStorage(): Promise<void> {
  if (!storageInstance) return;
  const closing = storageInstance;
  // Clear the slot in `finally`: if close() throws, the previous code left a
  // DEAD instance installed as the singleton, and every later getStorage()
  // handed that broken connection to callers. An empty slot is strictly
  // safer — the next getStorage() re-opens cleanly. The error still
  // propagates, so a caller like restoreFromBackup can abort before swapping
  // the database file.
  try {
    await closing.close();
  } finally {
    storageInstance = null;
  }
}

/**
 * Test-only: inject a pre-initialized storage instance into the singleton slot.
 *
 * CONTRACT: the CALLER owns the lifecycle of what it injects. This function
 * deliberately does NOT close the instance it replaces — callers pair the
 * injection with their own cleanup (see createTestDb().cleanup), so closing
 * here would double-close a storage the test still owns.
 *
 * Worth knowing when auditing handle leaks: an instance dropped without
 * close() keeps its sqlite lock, and on Windows that lock blocks unlink of
 * the database file until the process exits (libsql close() does not release
 * it either — tursodatabase/libsql-js#228 — so closing is hygiene, not a
 * guarantee).
 */
export function _setStorageForTesting(instance: StorageBackend | null): void {
  storageInstance = instance;
}

export type { StorageBackend } from "./interface.js";
export type {
  LedgerEntry,
  HandoffEntry,
  SaveHandoffResult,
  ContextResult,
  KnowledgeSearchResult,
  SemanticSearchResult,
  PipelineState,
  PipelineStatus,
} from "./interface.js";
