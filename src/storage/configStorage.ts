import { createClient } from "@libsql/client";
import { resolve, dirname } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";

// We use a small, dedicated DB just for configuration settings.
// This solves the chicken-and-egg problem: we need to know WHICH
// storage backend to boot *before* we can use that backend.
//
// Stored in ~/.prism-mcp/prism-config.db — the same root directory
// used by sqlite.ts and autoCapture.ts for all Prism files.
//
// ⚡ BOOT SETTINGS NOTE:
//   Settings in this store that affect server initialization (e.g.
//   PRISM_STORAGE, PRISM_ENABLE_HIVEMIND) are read only at startup.
//   Changing them at runtime requires a server restart to take effect.
//   Runtime-only settings (e.g. dashboard_theme) take effect immediately.
const CONFIG_PATH = resolve(homedir(), ".prism-mcp", "prism-config.db");

let configClient: ReturnType<typeof createClient> | null = null;
let initialized = false;

// ─── In-memory settings cache ──────────────────────────────────────
// Preloaded during initConfigStorage() so that hot-path MCP handlers
// (e.g. ReadResourceRequestSchema) can read settings synchronously
// without opening an additional SQLite round-trip and stalling the
// MCP stdio handshake (which causes a black-screen on startup).
let settingsCache: Record<string, string> | null = null;

function getClient() {
  if (!configClient) {
    // Ensure the directory exists before opening the DB.
    // In Docker/CI (e.g. Glama), ~/.prism-mcp/ doesn't exist yet,
    // and libSQL throws SQLITE_CANTOPEN (error 14) without it.
    const dir = dirname(CONFIG_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    configClient = createClient({
      url: `file:${CONFIG_PATH}`,
    });
  }
  return configClient;
}

export async function initConfigStorage() {
  if (initialized) return;

  try {
    const client = getClient();
    await client.execute(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Preload all rows into the cache so subsequent reads are zero-cost.
    const rs = await client.execute("SELECT key, value FROM system_settings");
    settingsCache = {};
    for (const row of rs.rows) {
      settingsCache[row.key as string] = row.value as string;
    }
  } catch (err) {
    // Graceful degradation: if the DB can't be opened (e.g. read-only
    // filesystem in a sandboxed container), fall back to an empty cache.
    // getSettingSync() will return defaults; getSetting()/setSetting()
    // will attempt to re-open the DB on first call.
    console.error(`[configStorage] Failed to initialize (non-fatal): ${err}`);
    settingsCache = {};
  }

  initialized = true;
}

/**
 * Synchronous setting read — served from the in-memory cache.
 * Returns defaultValue if the cache hasn't been populated yet (e.g. very
 * early startup before initConfigStorage() has been called) or if the key
 * doesn't exist. Safe to call from any MCP request handler without triggering
 * a SQLite round-trip.
 */
export function getSettingSync(key: string, defaultValue = ""): string {
  if (!settingsCache) return defaultValue;
  return settingsCache[key] ?? defaultValue;
}

export async function getSetting(key: string, defaultValue = ""): Promise<string> {
  await initConfigStorage();
  // Serve from cache when warm (the common case after startup).
  if (settingsCache && key in settingsCache) {
    return settingsCache[key];
  }
  const client = getClient();
  const rs = await client.execute({
    sql: "SELECT value FROM system_settings WHERE key = ?",
    args: [key],
  });

  if (rs.rows.length > 0) {
    const value = rs.rows[0].value as string;
    // Populate cache entry for future reads.
    if (settingsCache) settingsCache[key] = value;
    return value;
  }
  return defaultValue;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await initConfigStorage();
  const client = getClient();
  await client.execute({
    sql: `
      INSERT INTO system_settings (key, value, updated_at) 
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `,
    args: [key, value],
  });
  // Keep the cache in sync so getSettingSync() reflects the new value immediately.
  if (settingsCache) {
    settingsCache[key] = value;
  }
}

export async function getAllSettings(): Promise<Record<string, string>> {
  await initConfigStorage();
  // Return a snapshot of the cache (avoids a redundant DB round-trip).
  if (settingsCache) {
    return { ...settingsCache };
  }
  const client = getClient();
  const rs = await client.execute("SELECT key, value FROM system_settings");

  const settings: Record<string, string> = {};
  for (const row of rs.rows) {
    settings[row.key as string] = row.value as string;
  }
  return settings;
}

/**
 * Closes the config SQLite client to release the file handle on prism-config.db.
 * Called by the lifecycle module during graceful shutdown.
 */
export function closeConfigStorage() {
  if (configClient) {
    try {
      configClient.close();
    } catch (e) {
      console.error(`[ConfigStorage] Error closing db:`, e);
    }
  }
}
