
import { debugLog } from "../utils/logger.js";
import { SupabaseStorage } from "./supabase.js";
import type { StorageBackend } from "./interface.js";
import { getSetting } from "./configStorage.js";

let storageInstance: StorageBackend | null = null;
export let activeStorageBackend: string = "local";

/** Validate that a string is an http(s) URL (mirrors logic in config.ts). */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Returns the singleton storage backend.
 *
 * On first call: creates and initializes the appropriate backend.
 * On subsequent calls: returns the cached instance.
 *
 * SUPABASE CREDENTIAL RESOLUTION ORDER (v9.2):
 *   1. configStorage (prism-config.db)           (set via Mind Palace dashboard)
 *   2. process.env.SUPABASE_URL / SUPABASE_KEY  (env var fallback)
 *
 * If credentials are found only in configStorage, they are injected into
 * process.env so that supabaseApi.ts (which reads module-level constants
 * from config.ts) picks them up on the same startup cycle.
 */
export async function getStorage(): Promise<StorageBackend> {
  if (storageInstance) return storageInstance;

  // SOURCE OF TRUTH: prism-config.db (dashboard) → env fallback → "local" default
  // DB wins because the dashboard is the authoritative source post-migration.
  const dbStorage = await getSetting("PRISM_STORAGE", "");
  const requestedBackend = (dbStorage || process.env.PRISM_STORAGE || "local") as "supabase" | "local";

  if (requestedBackend === "supabase") {
    // ─── Resolve credentials: configStorage → env var fallback ──────────
    // v9.2: DB (dashboard) is the source of truth for Supabase credentials,
    // consistent with PRISM_STORAGE resolution above. If the user configured
    // Supabase via the dashboard, the values live in configStorage. Env vars
    // are only used as a fallback for users who haven't migrated yet.
    const resolvedUrl =
      await getSetting("SUPABASE_URL", "") ||
      process.env.SUPABASE_URL ||
      "";
    const resolvedKey =
      await getSetting("SUPABASE_KEY", "") ||
      await getSetting("SUPABASE_SERVICE_ROLE_KEY", "") ||
      process.env.SUPABASE_KEY ||
      "";

    const isConfigured = !!resolvedUrl && !!resolvedKey && isHttpUrl(resolvedUrl);

    if (!isConfigured) {
      activeStorageBackend = "local";
      console.error(
        "[Prism Storage] Supabase backend requested but credentials are missing or invalid " +
        "(checked both process.env and prism-config.db). Falling back to local storage.\n" +
        "  → Configure via Mind Palace dashboard (Settings → Storage Backend → Supabase) or set SUPABASE_URL / SUPABASE_KEY env vars."
      );
    } else {
      // Inject resolved credentials into process.env so supabaseApi.ts
      // (which reads config.ts module-level constants) can use them.
      // This is safe: process.env injection only affects in-process lookups;
      // it doesn't mutate the shell environment of the parent process.
      // Always overwrite — DB is the source of truth post-v9.2.
      process.env.SUPABASE_URL  = resolvedUrl;
      process.env.SUPABASE_KEY  = resolvedKey;
      activeStorageBackend = "supabase";
      debugLog(`[Prism Storage] Supabase credentials resolved (source: ${await getSetting("SUPABASE_URL", "") ? "configStorage" : "env"})`);
    }
  } else {
    activeStorageBackend = requestedBackend;
  }

  debugLog(`[Prism Storage] Initializing backend: ${activeStorageBackend}`);

  if (activeStorageBackend === "local") {
    const { SqliteStorage } = await import("./sqlite.js");
    storageInstance = new SqliteStorage();
  } else if (activeStorageBackend === "supabase") {
    storageInstance = new SupabaseStorage();
  } else {
    throw new Error(
      `Unknown PRISM_STORAGE value: "${activeStorageBackend}". ` +
      `Must be "local" or "supabase".`
    );
  }

  await storageInstance.initialize();
  return storageInstance;
}


/**
 * Closes the active storage backend and resets the singleton.
 * Used for testing and graceful shutdown.
 */
export async function closeStorage(): Promise<void> {
  if (storageInstance) {
    await storageInstance.close();
    storageInstance = null;
  }
}

// Re-export the interface types for convenience
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
