/**
 * SyncBus Factory — Routes to the correct sync implementation (v2.0 — Step 6)
 *
 * Returns SqliteSyncBus for local mode, SupabaseSyncBus for cloud mode.
 * Uses the same PRISM_STORAGE env var as the storage factory.
 *
 * Singleton pattern — only one bus per process (prevents duplicate watchers).
 */

import { PRISM_STORAGE } from "../config.js";
import { debugLog } from "../utils/logger.js";
import type { SyncBus } from "./index.js";
import { getSetting } from "../storage/configStorage.js";

let _bus: SyncBus | null = null;

export async function getSyncBus(): Promise<SyncBus> {
  if (_bus) return _bus;

  // DB-first, then env, then config.ts default (same priority as storage/index.ts)
  const dbStorage = await getSetting("PRISM_STORAGE", "");
  const resolvedStorage = dbStorage || process.env.PRISM_STORAGE || PRISM_STORAGE;

  if (resolvedStorage === "local") {
    const { SqliteSyncBus } = await import("./sqliteSync.js");
    _bus = new SqliteSyncBus();
  } else {
    const { SupabaseSyncBus } = await import("./supabaseSync.js");
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      console.error(
        "[SyncBus] Supabase credentials not found — falling back to local sync bus"
      );
      const { SqliteSyncBus } = await import("./sqliteSync.js");
      _bus = new SqliteSyncBus();
    } else {
      _bus = new SupabaseSyncBus(url, key);
    }
  }

  debugLog(`[SyncBus] Initialized: ${_bus.constructor.name} (client=${_bus.clientId.substring(0, 8)})`);
  return _bus;
}
