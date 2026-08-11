import { createClient } from "@libsql/client";
import { resolve, dirname } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { mkdirUsableSync } from "../utils/usableDirectory.js";

const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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
const CONFIG_PATH = process.env.PRISM_CONFIG_PATH
  ? resolve(process.env.PRISM_CONFIG_PATH)
  : resolve(homedir(), ".prism-mcp", "prism-config.db");

let configClient: ReturnType<typeof createClient> | null = null;
let initialized = false;

// ─── In-memory settings cache ──────────────────────────────────────
// Preloaded during initConfigStorage() so that hot-path MCP handlers
// (e.g. ReadResourceRequestSchema) can read settings synchronously
// without opening an additional SQLite round-trip and stalling the
// MCP stdio handshake (which causes a black-screen on startup).
let settingsCache: Record<string, string> | null = null; // assigned as Object.create(null) below

function getClient() {
  if (!configClient) {
    // Ensure the directory exists before opening the DB.
    // In Docker/CI (e.g. Glama), ~/.prism-mcp/ doesn't exist yet,
    // and libSQL throws SQLITE_CANTOPEN (error 14) without it.
    const dir = dirname(CONFIG_PATH);
    if (!existsSync(dir)) {
      // Not plain mkdirSync: recursive creation is umask-masked at every level,
      // and this directory holds the entitlement snapshot, so it must be private
      // and enterable regardless of the umask Prism happens to inherit.
      mkdirUsableSync(dir);
    }
    configClient = createClient({
      url: `file:${CONFIG_PATH}`,
    });
    // Multi-session machines share this one SQLite file across every host
    // window's server process. libsql's default busy timeout is ZERO, so a
    // writer meeting another writer fails instantly with SQLITE_BUSY instead
    // of waiting its turn. Measured 2026-08-11: applying a new skill-manifest
    // snapshot lost that race 10 consecutive times against ~7 live sessions'
    // routine setting writes, leaving the sync permanently "partial" on a busy
    // machine. Five seconds is far beyond any real transaction here and turns
    // contention back into queueing. Fire-and-forget: a failure to set the
    // pragma must never block storage init, and the first real query would
    // surface a genuinely broken database anyway.
    void configClient.execute("PRAGMA busy_timeout = 5000").catch(() => {});
    // WAL is the half that actually ends the starvation: in the default
    // rollback-journal mode every reader blocks the writer, and a machine
    // running many host windows reads this file near-continuously (settings,
    // drift reminders), so a manifest-apply transaction can wait out ANY
    // timeout and still lose. WAL lets readers and the single writer proceed
    // concurrently. The pragma is persistent per-database; issuing it on every
    // init is an idempotent no-op that also upgrades databases created before
    // this change.
    void configClient.execute("PRAGMA journal_mode = WAL").catch(() => {});
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
    await client.execute(`
      CREATE TABLE IF NOT EXISTS prism_managed_skills (
        name TEXT PRIMARY KEY,
        digest TEXT NOT NULL,
        generation TEXT NOT NULL,
        owner TEXT NOT NULL DEFAULT 'prism',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.execute(`
      CREATE TABLE IF NOT EXISTS session_context_receipts (
        conversation_hash TEXT NOT NULL,
        project_hash TEXT NOT NULL,
        project TEXT NOT NULL,
        boundaries_version TEXT NOT NULL,
        loaded_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (conversation_hash, project_hash)
      )
    `);

    // Preload all rows into the cache so subsequent reads are zero-cost.
    const rs = await client.execute("SELECT key, value FROM system_settings");
    settingsCache = Object.create(null) as Record<string, string>;
    const cache = settingsCache;
    for (const row of rs.rows) {
      const k = row.key as string;
      if (!PROTO_KEYS.has(k)) cache[k] = row.value as string;
    }
  } catch (err) {
    // Graceful degradation: if the DB can't be opened (e.g. read-only
    // filesystem in a sandboxed container), fall back to an empty cache.
    // getSettingSync() will return defaults; getSetting()/setSetting()
    // will attempt to re-open the DB on first call.
    console.error(`[configStorage] Failed to initialize (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    settingsCache = Object.create(null);
  }

  initialized = true;
}

export interface ManagedPlatformSkill {
  name: string;
  content: string;
  digest: string;
}

export interface ManagedSkillManifestState {
  generation: string;
  tier: string;
  routingVersion: number;
  skills: ManagedPlatformSkill[];
}

/**
 * Atomically applies a complete platform-skill snapshot.
 *
 * Ownership is recorded separately from the existing `skill:*` namespace so
 * a tier downgrade can remove only rows previously written by Prism. Role and
 * user-local skill rows are never inferred to be managed and are never pruned.
 */
export async function applyManagedSkillManifest(state: ManagedSkillManifestState): Promise<void> {
  await initConfigStorage();
  if (state.skills.length === 0) throw new Error("Refusing to apply an empty skill manifest");

  const client = getClient();
  const names = state.skills.map((skill) => skill.name);
  const placeholders = names.map(() => "?").join(", ");
  const statements: Array<{ sql: string; args: Array<string | number> }> = [];

  for (const skill of state.skills) {
    statements.push({
      sql: `
        INSERT INTO system_settings (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `,
      args: [`skill:${skill.name}`, skill.content],
    });
  }

  // Delete content only when the ownership table proves Prism wrote it and
  // the complete replacement snapshot no longer contains it.
  statements.push({
    sql: `
      DELETE FROM system_settings
      WHERE key IN (
        SELECT 'skill:' || name FROM prism_managed_skills
        WHERE name NOT IN (${placeholders})
      )
    `,
    args: names,
  });
  statements.push({
    sql: `DELETE FROM prism_managed_skills WHERE name NOT IN (${placeholders})`,
    args: names,
  });

  for (const skill of state.skills) {
    statements.push({
      sql: `
        INSERT INTO prism_managed_skills (name, digest, generation, owner, updated_at)
        VALUES (?, ?, ?, 'prism', CURRENT_TIMESTAMP)
        ON CONFLICT(name) DO UPDATE SET
          digest = excluded.digest,
          generation = excluded.generation,
          owner = 'prism',
          updated_at = CURRENT_TIMESTAMP
      `,
      args: [skill.name, skill.digest, state.generation],
    });
  }

  for (const [key, value] of [
    ["skill_manifest:generation", state.generation],
    ["skill_manifest:tier", state.tier],
    ["skill_manifest:routing_version", String(state.routingVersion)],
    ["skill_manifest:owner", "prism"],
    ["skill_manifest:names", JSON.stringify(names)],
  ] as const) {
    statements.push({
      sql: `
        INSERT INTO system_settings (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `,
      args: [key, value],
    });
  }

  // libSQL batch("write") is one transaction: a failed statement rolls back
  // content, ownership, digests, and generation together.
  await client.batch(statements, "write");

  // Refresh only after commit so synchronous readers never observe a future
  // generation paired with stale skill content. A cache read failure must not
  // make callers mistake an already-committed downgrade for a rolled-back DB
  // write and skip native entitlement cleanup. Session loading refreshes again
  // before activation and therefore fails closed until the DB is readable.
  try {
    await refreshConfigStorageCache();
  } catch (error) {
    console.error(`[configStorage] Managed skill manifest committed but cache refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Reload settings written by another Prism process into this process's cache. */
export async function refreshConfigStorageCache(): Promise<void> {
  await initConfigStorage();
  const rs = await getClient().execute("SELECT key, value FROM system_settings");
  const refreshed = Object.create(null) as Record<string, string>;
  for (const row of rs.rows) {
    const key = row.key as string;
    if (!PROTO_KEYS.has(key)) refreshed[key] = row.value as string;
  }
  settingsCache = refreshed;
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

export interface SessionContextReceipt {
  conversationHash: string;
  projectHash: string;
  project: string;
  boundariesVersion: string;
  loadedAt: number;
  lastSeen: number;
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

function validateSessionContextReceipt(receipt: SessionContextReceipt): void {
  if (!SHA256_HEX_RE.test(receipt.conversationHash) ||
      !SHA256_HEX_RE.test(receipt.projectHash) ||
      !receipt.project.trim() ||
      !receipt.boundariesVersion.trim() ||
      !Number.isFinite(receipt.loadedAt) ||
      !Number.isFinite(receipt.lastSeen)) {
    throw new Error("Invalid session context receipt");
  }
}

/**
 * Persists only hashes of the caller-supplied identifiers. The project name is
 * retained so recovery can verify that a hash lookup did not cross scopes.
 * Expired rows are pruned in the same transaction to keep the local table
 * bounded by active sessions rather than process lifetime.
 */
export async function saveSessionContextReceipt(
  receipt: SessionContextReceipt,
  expiresBefore: number,
): Promise<void> {
  validateSessionContextReceipt(receipt);
  if (!Number.isFinite(expiresBefore)) throw new Error("Invalid session receipt expiry");

  await initConfigStorage();
  const client = getClient();
  await client.batch([
    {
      sql: "DELETE FROM session_context_receipts WHERE last_seen < ?",
      args: [expiresBefore],
    },
    {
      sql: `
        INSERT INTO session_context_receipts (
          conversation_hash,
          project_hash,
          project,
          boundaries_version,
          loaded_at,
          last_seen
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_hash, project_hash) DO UPDATE SET
          project = excluded.project,
          boundaries_version = excluded.boundaries_version,
          loaded_at = excluded.loaded_at,
          last_seen = excluded.last_seen
      `,
      args: [
        receipt.conversationHash,
        receipt.projectHash,
        receipt.project,
        receipt.boundariesVersion,
        receipt.loadedAt,
        receipt.lastSeen,
      ],
    },
  ], "write");
}

export async function getSessionContextReceipt(
  conversationHash: string,
  projectHash: string,
): Promise<SessionContextReceipt | null> {
  if (!SHA256_HEX_RE.test(conversationHash) || !SHA256_HEX_RE.test(projectHash)) {
    return null;
  }

  await initConfigStorage();
  const rs = await getClient().execute({
    sql: `
      SELECT project, boundaries_version, loaded_at, last_seen
      FROM session_context_receipts
      WHERE conversation_hash = ? AND project_hash = ?
      LIMIT 1
    `,
    args: [conversationHash, projectHash],
  });
  if (rs.rows.length === 0) return null;

  const row = rs.rows[0];
  const receipt: SessionContextReceipt = {
    conversationHash,
    projectHash,
    project: String(row.project ?? ""),
    boundariesVersion: String(row.boundaries_version ?? ""),
    loadedAt: Number(row.loaded_at),
    lastSeen: Number(row.last_seen),
  };
  try {
    validateSessionContextReceipt(receipt);
    return receipt;
  } catch {
    return null;
  }
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
    if (settingsCache && !PROTO_KEYS.has(key)) settingsCache[key] = value;
    return value;
  }
  return defaultValue;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await initConfigStorage();
  const client = getClient();

  // Retry with exponential backoff for SQLITE_BUSY (concurrent writes).
  // The dashboard and load tests can fire many parallel setting saves.
  const MAX_RETRIES = 5;
  const BASE_DELAY_MS = 20;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await client.execute({
        sql: `
          INSERT INTO system_settings (key, value, updated_at) 
          VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `,
        args: [key, value],
      });
      // Keep the cache in sync so getSettingSync() reflects the new value immediately.
      if (settingsCache && typeof key === "string" && !PROTO_KEYS.has(key)) {
        settingsCache[key] = value;
      }
      return; // Success — exit
    } catch (err: any) {
      const isBusy = err?.code === "SQLITE_BUSY" || err?.rawCode === 5;
      if (isBusy && attempt < MAX_RETRIES) {
        // Exponential backoff + jitter
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 10;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err; // Not SQLITE_BUSY or retries exhausted
    }
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

  const settings: Record<string, string> = Object.create(null);
  for (const row of rs.rows) {
    const k = row.key as string;
    if (!PROTO_KEYS.has(k)) settings[k] = row.value as string;
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
