import { PRISM_STORAGE as ENV_PRISM_STORAGE, SUPABASE_CONFIGURED } from "../config.js";
import { debugLog } from "../utils/logger.js";
import { SupabaseStorage } from "./supabase.js";
import type { StorageBackend } from "./interface.js";
import { getSetting } from "./configStorage.js";

let storageInstance: StorageBackend | null = null;
export let activeStorageBackend: string = "local";

/**
 * Returns the singleton storage backend.
 *
 * On first call: creates and initializes the appropriate backend.
 * On subsequent calls: returns the cached instance.
 */
export async function getStorage(): Promise<StorageBackend> {
  if (storageInstance) return storageInstance;

  // Use environment variable if explicitly set, otherwise fall back to db config
  const envStorage = process.env.PRISM_STORAGE as "supabase" | "local" | undefined;
  const requestedBackend = (envStorage || await getSetting("PRISM_STORAGE", ENV_PRISM_STORAGE)) as "supabase" | "local";

  // Guardrail: if Supabase is requested but credentials are unresolved/invalid,
  // transparently fall back to local mode to keep dashboard + core tools usable.
  if (requestedBackend === "supabase" && !SUPABASE_CONFIGURED) {
    activeStorageBackend = "local";
    console.error(
      "[Prism Storage] Supabase backend requested but SUPABASE_URL/SUPABASE_KEY are invalid or unresolved. Falling back to local storage."
    );
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
} from "./interface.js";
