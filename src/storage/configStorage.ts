import { createClient } from "@libsql/client";
import { resolve } from "path";
import { homedir } from "os";

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

function getClient() {
  if (!configClient) {
    configClient = createClient({
      url: `file:${CONFIG_PATH}`,
    });
  }
  return configClient;
}

export async function initConfigStorage() {
  if (initialized) return;

  const client = getClient();
  await client.execute(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  initialized = true;
}

export async function getSetting(key: string, defaultValue = ""): Promise<string> {
  await initConfigStorage();
  const client = getClient();
  const rs = await client.execute({
    sql: "SELECT value FROM system_settings WHERE key = ?",
    args: [key],
  });

  if (rs.rows.length > 0) {
    return rs.rows[0].value as string;
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
}

export async function getAllSettings(): Promise<Record<string, string>> {
  await initConfigStorage();
  const client = getClient();
  const rs = await client.execute("SELECT key, value FROM system_settings");
  
  const settings: Record<string, string> = {};
  for (const row of rs.rows) {
    settings[row.key as string] = row.value as string;
  }
  return settings;
}
