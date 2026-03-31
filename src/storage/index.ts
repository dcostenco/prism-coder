/**
 * Storage Factory (v2.0 — Step 1)
 *
 * Unified entry point for storage initialization.
 * Routes between Supabase (cloud) and SQLite (local) based on
 * the PRISM_STORAGE environment variable.
 *
 * Usage in server.ts:
 *   const storage = await getStorage();
 *   // Pass `storage` to all session memory handlers
 */

import { PRISM_STORAGE as ENV_PRISM_STORAGE } from "../config.js";
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
 *
 * @throws Error if PRISM_STORAGE=local (not yet implemented in Step 1)
 * @throws Error if PRISM_STORAGE=supabase but Supabase is not configured
 */
export async function getStorage(): Promise<StorageBackend> {
  if (storageInstance) return storageInstance;

  // Use environment variable if explicitly set, otherwise fall back to db config
  const envStorage = process.env.PRISM_STORAGE as "supabase" | "local" | undefined;
  activeStorageBackend = envStorage || await getSetting("PRISM_STORAGE", ENV_PRISM_STORAGE) as "supabase" | "local";
  
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

  await storageInstance!.initialize();
  return storageInstance!;
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
