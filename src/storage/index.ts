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

import { PRISM_STORAGE } from "../config.js";
import { SupabaseStorage } from "./supabase.js";
import type { StorageBackend } from "./interface.js";

let storageInstance: StorageBackend | null = null;

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

  console.error(`[Prism Storage] Initializing backend: ${PRISM_STORAGE}`);

  if (PRISM_STORAGE === "local") {
    const { SqliteStorage } = await import("./sqlite.js");
    storageInstance = new SqliteStorage();
  } else if (PRISM_STORAGE === "supabase") {
    storageInstance = new SupabaseStorage();
  } else {
    throw new Error(
      `Unknown PRISM_STORAGE value: "${PRISM_STORAGE}". ` +
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
