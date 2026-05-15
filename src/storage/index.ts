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

function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Probe for synalux credentials: env vars first, then config DB.
 * Returns true if usable credentials are now in process.env.
 */
async function ensureSynaluxCredentials(): Promise<boolean> {
  if (SYNALUX_CONFIGURED) return true;
  // Re-check process.env directly: SYNALUX_CONFIGURED is captured at module
  // load, so credentials injected later by another caller would be invisible
  // to it. Mirrors ensureSupabaseCredentials below.
  const envUrl = process.env.PRISM_SYNALUX_BASE_URL?.trim();
  const envKey = process.env.PRISM_SYNALUX_API_KEY?.trim();
  if (envUrl && envKey && isValidHttpUrl(envUrl)) return true;
  const url = (await getSetting("PRISM_SYNALUX_BASE_URL"))?.trim();
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
  if (requested === "auto") {
    if (await ensureSynaluxCredentials()) {
      requested = "synalux";
    } else if (await ensureSupabaseCredentials()) {
      requested = "supabase";
    } else {
      requested = "local";
    }
    debugLog(`[Prism Storage] Auto-resolved: ${requested}`);
  }

  // ─── Validate explicit backend has credentials ────────────────
  if (requested === "synalux" && !(await ensureSynaluxCredentials())) {
    console.error(
      "[Prism Storage] Synalux backend requested but PRISM_SYNALUX_BASE_URL/PRISM_SYNALUX_API_KEY are missing or invalid. Falling back to local storage."
    );
    requested = "local";
  }
  if (requested === "supabase" && !(await ensureSupabaseCredentials())) {
    console.error(
      "[Prism Storage] Supabase backend requested but SUPABASE_URL/SUPABASE_KEY are missing or invalid. Falling back to local storage."
    );
    requested = "local";
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
  if (storageInstance) {
    await storageInstance.close();
    storageInstance = null;
  }
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
