/**
 * SQLite Local Storage Backend (v2.0 — Step 2)
 *
 * Zero-cloud, local-first storage using @libsql/client (libSQL/SQLite).
 * Data lives at ~/.prism-mcp/data.db — no account, no API keys, no network.
 *
 * ═══════════════════════════════════════════════════════════════════
 * KEY DESIGN DECISIONS:
 *
 * 1. FTS5 for search (Step 2) — vectors deferred to Step 3
 * 2. PostgREST-style filter params → SQL WHERE clause parser
 *    (so handlers don't need to know which backend they're using)
 * 3. OCC via UPDATE...WHERE version=? (no stored procedures needed)
 * 4. JSON arrays stored as TEXT columns (stringify on write, parse on read)
 * 5. Auto-sync FTS5 index via triggers (zero manual maintenance)
 * ═══════════════════════════════════════════════════════════════════
 */

import { createClient, type Client, type InValue } from "@libsql/client";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";
import { getSetting as cfgGet, setSetting as cfgSet, getAllSettings as cfgGetAll } from "./configStorage.js";

import type {
  StorageBackend,
  LedgerEntry,
  HandoffEntry,
  SaveHandoffResult,
  ContextResult,
  KnowledgeSearchResult,
  SemanticSearchResult,
  HistorySnapshot,
  HealthStats,             // v2.2.0: Health check (fsck) aggregate type
  AgentRegistryEntry,      // v3.0: Agent Hivemind registry
  AnalyticsData,           // v3.1: Memory Analytics
} from "./interface.js";

import { debugLog } from "../utils/logger.js";

export class SqliteStorage implements StorageBackend {
  private db!: Client;
  private dbPath!: string;

  // ─── Lifecycle ─────────────────────────────────────────────

  async initialize(dbPath?: string): Promise<void> {
    // ─── DB Path Resolution ────────────────────────────────────────────
    // Priority:
    //   1. Explicit dbPath argument — used by tests to inject a per-instance
    //      path with ZERO global side-effects. No env mutation, no race risk,
    //      safe under full parallel test execution.
    //   2. Default: ~/.prism-mcp/data.db — used by production server startup.
    //
    // Why explict arg over env var?
    //   Env vars are process-global. Mutating them around an async boundary
    //   (set → await initialize() → restore) is racey when multiple test
    //   suites run in parallel: suite B can clobber PRISM_DB_PATH between
    //   suite A's write and suite A's read. A direct argument has no
    //   observable global state and cannot race.
    let resolvedPath: string;
    if (dbPath) {
      resolvedPath = dbPath;
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } else {
      const prismDir = path.join(os.homedir(), ".prism-mcp");
      if (!fs.existsSync(prismDir)) {
        fs.mkdirSync(prismDir, { recursive: true });
      }
      resolvedPath = path.join(prismDir, "data.db");
    }

    this.dbPath = resolvedPath;

    this.db = createClient({
      url: `file:${this.dbPath}`,
    });

    // Enable WAL mode for better concurrent read performance
    await this.db.execute("PRAGMA journal_mode=WAL");

    // Run all migrations
    await this.runMigrations();

    debugLog(`[SqliteStorage] Initialized at ${this.dbPath}`);
  }

  async close(): Promise<void> {
    this.db.close();
    debugLog("[SqliteStorage] Closed");
  }

  // ─── Migrations ────────────────────────────────────────────

  private async runMigrations(): Promise<void> {
    // REVIEWER NOTE: We use executeMultiple for the DDL statements.
    // All columns that hold arrays in Supabase are TEXT (JSON) here.
    // The schema mirrors Supabase tables exactly to keep handlers agnostic.
    await this.db.executeMultiple(`
      -- ─── Session Ledger (append-only session log) ───
      CREATE TABLE IF NOT EXISTS session_ledger (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        project TEXT NOT NULL,
        conversation_id TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT 'default',
        summary TEXT NOT NULL DEFAULT '',
        title TEXT DEFAULT NULL,
        agent_name TEXT DEFAULT NULL,
        todos TEXT DEFAULT '[]',
        files_changed TEXT DEFAULT '[]',
        decisions TEXT DEFAULT '[]',
        keywords TEXT DEFAULT '[]',
        embedding F32_BLOB(768),  -- libSQL native 768-dim vector (Gemini text-embedding-004)
        is_rollup INTEGER DEFAULT 0,
        rollup_count INTEGER DEFAULT 0,
        archived_at TEXT DEFAULT NULL,
        session_date TEXT DEFAULT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- ─── Session Handoffs (live project state, OCC-controlled) ───
      CREATE TABLE IF NOT EXISTS session_handoffs (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        project TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'default',
        last_summary TEXT DEFAULT NULL,
        pending_todo TEXT DEFAULT '[]',
        active_decisions TEXT DEFAULT '[]',
        keywords TEXT DEFAULT '[]',
        key_context TEXT DEFAULT NULL,
        active_branch TEXT DEFAULT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(project, user_id)
      );

      -- ─── Indexes ───
      CREATE INDEX IF NOT EXISTS idx_ledger_project ON session_ledger(project);
      CREATE INDEX IF NOT EXISTS idx_ledger_user ON session_ledger(user_id);
      CREATE INDEX IF NOT EXISTS idx_ledger_created ON session_ledger(created_at);
      CREATE INDEX IF NOT EXISTS idx_ledger_archived ON session_ledger(archived_at);

      -- ─── Vector ANN Index (libSQL DiskANN) ───
      -- Accelerates cosine similarity search on large datasets.
      -- Gracefully ignored if libSQL version doesn't support it.
      CREATE INDEX IF NOT EXISTS idx_ledger_embedding
        ON session_ledger(libsql_vector_idx(embedding));

      -- ─── FTS5 Virtual Table for full-text search on ledger ───
      -- content= means this is a "contentless" external-content table
      -- that reads from session_ledger. Triggers keep it synced.
      CREATE VIRTUAL TABLE IF NOT EXISTS ledger_fts USING fts5(
        project,
        summary,
        decisions,
        keywords,
        content='session_ledger',
        content_rowid='rowid'
      );

      -- ─── FTS5 Sync Triggers ───
      -- Auto-sync the FTS index when rows are inserted/deleted/updated.
      -- This is the key to zero-maintenance full-text search.
      CREATE TRIGGER IF NOT EXISTS ledger_fts_insert AFTER INSERT ON session_ledger BEGIN
        INSERT INTO ledger_fts(rowid, project, summary, decisions, keywords)
        VALUES (new.rowid, new.project, new.summary, new.decisions, new.keywords);
      END;

      CREATE TRIGGER IF NOT EXISTS ledger_fts_delete AFTER DELETE ON session_ledger BEGIN
        INSERT INTO ledger_fts(ledger_fts, rowid, project, summary, decisions, keywords)
        VALUES ('delete', old.rowid, old.project, old.summary, old.decisions, old.keywords);
      END;

      CREATE TRIGGER IF NOT EXISTS ledger_fts_update AFTER UPDATE ON session_ledger BEGIN
        INSERT INTO ledger_fts(ledger_fts, rowid, project, summary, decisions, keywords)
        VALUES ('delete', old.rowid, old.project, old.summary, old.decisions, old.keywords);
        INSERT INTO ledger_fts(rowid, project, summary, decisions, keywords)
        VALUES (new.rowid, new.project, new.summary, new.decisions, new.keywords);
      END;

      -- ─── Handoff History (Time Travel snapshots) ───
      -- Every successful saveHandoff auto-creates a snapshot here.
      -- memory_history reads them; memory_checkout restores from them.
      CREATE TABLE IF NOT EXISTS session_handoffs_history (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        project TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'default',
        version INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT 'main',
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_history_project
        ON session_handoffs_history(project, user_id);
      CREATE INDEX IF NOT EXISTS idx_history_version
        ON session_handoffs_history(project, version);
    `);

    // ─── Phase 2 Migration: GDPR Soft Delete Columns ──────────
    //
    // SQLITE GOTCHA: Unlike CREATE TABLE IF NOT EXISTS, ALTER TABLE
    // throws a fatal error if the column already exists. We MUST
    // wrap each ALTER TABLE in a try/catch and only ignore
    // "duplicate column name" errors.
    //
    // This migration runs on every boot but is idempotent — the
    // try/catch ensures it's safe to run repeatedly.

    try {
      await this.db.execute(
        `ALTER TABLE session_ledger ADD COLUMN deleted_at TEXT DEFAULT NULL`
      );
      debugLog("[SqliteStorage] Phase 2 migration: added deleted_at column");
    } catch (e: any) {
      // "duplicate column name" = column already exists from prior boot.
      // Any other error is a real problem — rethrow it.
      if (!e.message?.includes("duplicate column name")) throw e;
    }

    try {
      await this.db.execute(
        `ALTER TABLE session_ledger ADD COLUMN deleted_reason TEXT DEFAULT NULL`
      );
      debugLog("[SqliteStorage] Phase 2 migration: added deleted_reason column");
    } catch (e: any) {
      if (!e.message?.includes("duplicate column name")) throw e;
    }

    // Index for fast WHERE deleted_at IS NULL queries.
    // CREATE INDEX IF NOT EXISTS is safe to run repeatedly (no try/catch needed).
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_ledger_deleted ON session_ledger(deleted_at)`
    );

    // ─── v3.0 Migration: Agent Hivemind ──────────────────────────
    //
    // 1. Add `role` column to session_ledger (simple ALTER TABLE — no UNIQUE issue)
    // 2. Rebuild session_handoffs with new UNIQUE(project, user_id, role)
    //    Using 'global' default instead of NULL to avoid SQLite NULL uniqueness trap.
    // 3. Create agent_registry table

    // session_ledger: simple column add
    try {
      await this.db.execute(
        `ALTER TABLE session_ledger ADD COLUMN role TEXT NOT NULL DEFAULT 'global'`
      );
      debugLog("[SqliteStorage] v3.0 migration: added role column to session_ledger");
    } catch (e: any) {
      if (!e.message?.includes("duplicate column name")) throw e;
    }
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_ledger_role ON session_ledger(role)`
    );

    // session_handoffs: 4-step table rebuild for UNIQUE constraint change
    // Check if we need to do the rebuild by looking for the role column
    try {
      await this.db.execute(`SELECT role FROM session_handoffs LIMIT 1`);
      // Column exists — migration already ran
    } catch {
      // Column doesn't exist — do the table rebuild
      debugLog("[SqliteStorage] v3.0 migration: rebuilding session_handoffs with role column");

      // Step 1: Create new table with correct constraint
      await this.db.execute(`
        CREATE TABLE session_handoffs_v2 (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          project TEXT NOT NULL,
          user_id TEXT NOT NULL DEFAULT 'default',
          role TEXT NOT NULL DEFAULT 'global',
          last_summary TEXT DEFAULT NULL,
          pending_todo TEXT DEFAULT '[]',
          active_decisions TEXT DEFAULT '[]',
          keywords TEXT DEFAULT '[]',
          key_context TEXT DEFAULT NULL,
          active_branch TEXT DEFAULT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          metadata TEXT DEFAULT '{}',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          UNIQUE(project, user_id, role)
        )
      `);

      // Step 2: Copy data with explicit column names (Pro-Tip 2)
      await this.db.execute(`
        INSERT INTO session_handoffs_v2
          (id, project, user_id, role, last_summary, pending_todo,
           active_decisions, keywords, key_context, active_branch,
           version, metadata, created_at, updated_at)
        SELECT
          id, project, user_id, 'global', last_summary, pending_todo,
          active_decisions, keywords, key_context, active_branch,
          version, metadata, created_at, updated_at
        FROM session_handoffs
      `);

      // Step 3: Drop old and rename
      await this.db.execute(`DROP TABLE session_handoffs`);
      await this.db.execute(`ALTER TABLE session_handoffs_v2 RENAME TO session_handoffs`);

      debugLog("[SqliteStorage] v3.0 migration: session_handoffs rebuilt with UNIQUE(project, user_id, role)");
    }

    // agent_registry: new table for Hivemind coordination
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS agent_registry (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        project TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'default',
        role TEXT NOT NULL,
        agent_name TEXT DEFAULT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        current_task TEXT DEFAULT NULL,
        last_heartbeat TEXT DEFAULT (datetime('now')),
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(project, user_id, role)
      )
    `);
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_registry_project ON agent_registry(project, user_id)`
    );

    // ── Note: system_settings is intentionally orphaned ─────────────────
    // This table is created for forward-compatibility but is NOT the active
    // settings store. Both SqliteStorage and SupabaseStorage proxy settings
    // calls to configStorage.js (JSON file on disk) via:
    //   import { getSetting, setSetting, getAllSettings } from "./configStorage.js"
    //
    // The table is NOT safe to drop from the migration because existing user
    // deployments may already have it and SQLite has no IF EXISTS for DROP
    // in a safe cross-version migration. Instead, a future release can
    // repoint getSettings/setSetting to use this.db.execute() here and
    // retire configStorage.js at that point.
    //
    // See: src/storage/interface.ts "v3.0: Dashboard Settings (configStorage proxy)"
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // ─── v4.0 Migration: Active Behavioral Memory ──────────────
    // Three new columns for typed experience events and insight graduation.
    // Uses the proven idempotent try/catch pattern for safe ALTER TABLE.

    try {
      await this.db.execute(
        `ALTER TABLE session_ledger ADD COLUMN event_type TEXT DEFAULT 'session'`
      );
      debugLog("[SqliteStorage] v4.0 migration: added event_type column");
    } catch (e: any) {
      if (!e.message?.includes("duplicate column name")) throw e;
    }

    try {
      await this.db.execute(
        `ALTER TABLE session_ledger ADD COLUMN confidence_score INTEGER DEFAULT NULL`
      );
      debugLog("[SqliteStorage] v4.0 migration: added confidence_score column");
    } catch (e: any) {
      if (!e.message?.includes("duplicate column name")) throw e;
    }

    try {
      await this.db.execute(
        `ALTER TABLE session_ledger ADD COLUMN importance INTEGER DEFAULT 0`
      );
      debugLog("[SqliteStorage] v4.0 migration: added importance column");
    } catch (e: any) {
      if (!e.message?.includes("duplicate column name")) throw e;
    }

    // Composite indexes for behavioral queries (idempotent via IF NOT EXISTS)
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_ledger_event_type ON session_ledger(event_type)`
    );
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_ledger_importance ON session_ledger(importance DESC)`
    );

    // ─── v5.0 Migration: TurboQuant Compressed Embeddings ─────
    // Stores compressed embedding alongside float32 for backward compat.
    // Uses base64 TEXT (not F32_BLOB) — asymmetric search runs in JS.

    try {
      await this.db.execute(
        `ALTER TABLE session_ledger ADD COLUMN embedding_compressed TEXT DEFAULT NULL`
      );
      debugLog("[SqliteStorage] v5.0 migration: added embedding_compressed column");
    } catch (e: any) {
      if (!e.message?.includes("duplicate column name")) throw e;
    }

    try {
      await this.db.execute(
        `ALTER TABLE session_ledger ADD COLUMN embedding_format TEXT DEFAULT NULL`
      );
      debugLog("[SqliteStorage] v5.0 migration: added embedding_format column");
    } catch (e: any) {
      if (!e.message?.includes("duplicate column name")) throw e;
    }

    try {
      await this.db.execute(
        `ALTER TABLE session_ledger ADD COLUMN embedding_turbo_radius REAL DEFAULT NULL`
      );
      debugLog("[SqliteStorage] v5.0 migration: added embedding_turbo_radius column");
    } catch (e: any) {
      if (!e.message?.includes("duplicate column name")) throw e;
    }
  }

  // ─── PostgREST Filter Parser ───────────────────────────────
  //
  // REVIEWER NOTE: The handlers pass PostgREST-style filter params
  // (e.g., { project: "eq.my-app", archived_at: "is.null" }).
  // This parser converts those into SQL WHERE clauses + args so
  // handlers work identically with both Supabase and SQLite.

  private parsePostgRESTFilters(
    params: Record<string, string>
  ): { where: string; args: InValue[]; select: string; order: string; limit: number | null } {
    const conditions: string[] = [];
    const args: InValue[] = [];
    let select = "*";
    let order = "";
    let limit: number | null = null;

    for (const [key, value] of Object.entries(params)) {
      // Special params (not filters)
      if (key === "select") {
        select = value;
        continue;
      }
      if (key === "order") {
        // e.g., "created_at.desc" → "created_at DESC"
        const parts = value.split(".");
        const col = parts[0];
        // ── SQL Injection Guard ──────────────────────────────────────────
        // col is interpolated directly into the ORDER BY clause. We must
        // reject anything that isn't a plain identifier (letters, digits,
        // underscores) before it touches the query string.
        // Note: @libsql/client already blocks stacked queries (;DROP TABLE),
        // but CASE WHEN / expression injection is still possible without this.
        if (!/^[a-zA-Z0-9_]+$/.test(col)) {
          throw new Error(`Invalid order column: "${col}". Only alphanumeric identifiers are allowed.`);
        }
        const dir = parts[1]?.toUpperCase() === "DESC" ? "DESC" : "ASC";
        order = `ORDER BY ${col} ${dir}`;
        continue;
      }
      if (key === "limit") {
        limit = parseInt(value, 10);
        continue;
      }

      // PostgREST filter operators
      if (value.startsWith("eq.")) {
        // Handle boolean mapping: SQLite uses 0/1 for booleans
        const raw = value.slice(3);
        if (key === "is_rollup") {
          conditions.push(`${key} = ?`);
          args.push(raw === "true" ? 1 : raw === "false" ? 0 : raw);
        } else {
          conditions.push(`${key} = ?`);
          args.push(raw);
        }
      } else if (value === "is.null") {
        conditions.push(`${key} IS NULL`);
      } else if (value === "is.not.null") {
        conditions.push(`${key} IS NOT NULL`);
      } else if (value.startsWith("lt.")) {
        conditions.push(`${key} < ?`);
        args.push(value.slice(3));
      } else if (value.startsWith("gt.")) {
        conditions.push(`${key} > ?`);
        args.push(value.slice(3));
      } else if (value.startsWith("lte.")) {
        conditions.push(`${key} <= ?`);
        args.push(value.slice(4));
      } else if (value.startsWith("gte.")) {
        conditions.push(`${key} >= ?`);
        args.push(value.slice(4));
      } else if (value.startsWith("cs.")) {
        // array contains — in SQLite we use JSON + LIKE on the text column
        // cs.{cat:health} → keywords LIKE '%cat:health%'
        const pattern = value.slice(3).replace(/[{}]/g, "");
        conditions.push(`${key} LIKE ?`);
        args.push(`%${pattern}%`);
      } else {
        // Bare value — treat as equality
        conditions.push(`${key} = ?`);
        args.push(value);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return { where, args, select, order, limit };
  }

  // ─── Helper: Parse JSON column safely ──────────────────────

  private parseJsonColumn(value: unknown): unknown[] {
    if (!value) return [];
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        // ── Type Safety Guard ────────────────────────────────────────────
        // JSON.parse() can return any type (object, number, boolean, null).
        // If a malformed non-array JSON string (e.g. "{}") somehow made it
        // into the DB, callers would crash on .map()/.filter().
        // Force it to an array so all downstream code stays safe.
        return Array.isArray(parsed) ? parsed : [];
      } catch { return []; }
    }
    if (Array.isArray(value)) return value;
    return [];
  }

  /** Convert a SQLite row to a shape matching Supabase's response format */
  private rowToLedgerEntry(row: Record<string, unknown>): Record<string, unknown> {
    return {
      ...row,
      todos: this.parseJsonColumn(row.todos),
      files_changed: this.parseJsonColumn(row.files_changed),
      decisions: this.parseJsonColumn(row.decisions),
      keywords: this.parseJsonColumn(row.keywords),
      is_rollup: Boolean(row.is_rollup),
    };
  }

  // ─── Ledger Operations ─────────────────────────────────────

  async saveLedger(entry: LedgerEntry): Promise<unknown> {
    const id = entry.id || randomUUID();
    const now = new Date().toISOString();

    await this.db.execute({
      sql: `INSERT INTO session_ledger
        (id, project, conversation_id, user_id, role, summary, todos, files_changed,
         decisions, keywords, is_rollup, rollup_count, title, agent_name,
         event_type, confidence_score, importance,
         embedding_compressed, embedding_format, embedding_turbo_radius,
         created_at, session_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        entry.project,
        entry.conversation_id,
        entry.user_id,
        entry.role || "global",   // v3.0: default to 'global'
        entry.summary,
        JSON.stringify(entry.todos || []),
        JSON.stringify(entry.files_changed || []),
        JSON.stringify(entry.decisions || []),
        JSON.stringify(entry.keywords || []),
        entry.is_rollup ? 1 : 0,
        entry.rollup_count || 0,
        entry.is_rollup ? `Session Rollup (${entry.rollup_count || 0} entries)` : null,
        entry.is_rollup ? "prism-compactor" : null,
        entry.event_type || "session",   // v4.0: default to 'session'
        entry.confidence_score ?? null,   // v4.0: nullable
        entry.importance || 0,            // v4.0: default to 0
        entry.embedding_compressed || null,        // v5.0: TurboQuant
        entry.embedding_format || null,            // v5.0: turbo3/turbo4/float32
        entry.embedding_turbo_radius ?? null,      // v5.0: original vector magnitude
        now,
        now,
      ],
    });

    // Return Supabase-compatible shape: handlers expect [{ id, ... }]
    return [{ id, project: entry.project, created_at: now }];
  }

  async patchLedger(id: string, data: Record<string, unknown>): Promise<void> {
    const sets: string[] = [];
    const args: InValue[] = [];

    for (const [key, value] of Object.entries(data)) {
      if (key === "embedding") {
        // Use libSQL's native vector() function for F32_BLOB columns.
        // The value is a JSON-stringified number[] from the handler.
        sets.push(`${key} = vector(?)`);
        args.push((typeof value === "string" ? value : JSON.stringify(value)) as InValue);
      } else {
        sets.push(`${key} = ?`);
        args.push((typeof value === "object" && value !== null ? JSON.stringify(value) : value) as InValue);
      }
    }

    if (sets.length === 0) return;

    args.push(id);
    await this.db.execute({
      sql: `UPDATE session_ledger SET ${sets.join(", ")} WHERE id = ?`,
      args,
    });
  }

  async getLedgerEntries(params: Record<string, string>): Promise<unknown[]> {
    const { where, args, select, order, limit } = this.parsePostgRESTFilters(params);

    // Build column list from select param
    const columns = select === "*" ? "*" : select;

    let sql = `SELECT ${columns} FROM session_ledger ${where}`;
    if (order) sql += ` ${order}`;
    if (limit) {
      sql += ` LIMIT ?`;
      args.push(limit);
    }

    const result = await this.db.execute({ sql, args });
    return result.rows.map(row => this.rowToLedgerEntry(row as Record<string, unknown>));
  }

  async deleteLedger(params: Record<string, string>): Promise<unknown[]> {
    // First fetch entries that will be deleted (for return value)
    const entries = await this.getLedgerEntries({ ...params, select: "id,project,summary" });

    const { where, args } = this.parsePostgRESTFilters(params);

    if (!where) {
      throw new Error("Cannot delete without filters — safety guard");
    }

    await this.db.execute({
      sql: `DELETE FROM session_ledger ${where}`,
      args,
    });

    return entries;
  }

  // ─── Phase 2: GDPR-Compliant Memory Deletion ──────────────
  //
  // These methods are SURGICAL — they operate on a single entry by ID.
  // They MUST verify user_id ownership to prevent cross-user deletion.
  //
  // softDeleteLedger: Sets deleted_at + deleted_reason. Entry stays in
  //   DB for audit trail. All search queries filter it out via
  //   "AND deleted_at IS NULL". Reversible.
  //
  // hardDeleteLedger: Physical DELETE. Irreversible. FTS5 triggers
  //   automatically clean up the full-text index.

  async softDeleteLedger(id: string, userId: string, reason?: string): Promise<void> {
    // UPDATE (not DELETE): sets tombstone fields while preserving the row.
    // The JS-side datetime('now') matches SQLite's native format.
    await this.db.execute({
      sql: `UPDATE session_ledger
            SET deleted_at = datetime('now'), deleted_reason = ?
            WHERE id = ? AND user_id = ?`,
      args: [reason || null, id, userId],
    });
    debugLog(`[SqliteStorage] Soft-deleted ledger entry ${id} (reason: ${reason || "none"})`);
  }

  async hardDeleteLedger(id: string, userId: string): Promise<void> {
    // Physical DELETE — row is permanently removed.
    // FTS5 trigger (ledger_fts_delete) automatically cleans up the index.
    await this.db.execute({
      sql: `DELETE FROM session_ledger WHERE id = ? AND user_id = ?`,
      args: [id, userId],
    });
    debugLog(`[SqliteStorage] Hard-deleted ledger entry ${id}`);
  }

  // ─── Handoff Operations (OCC) ──────────────────────────────

  async saveHandoff(
    handoff: HandoffEntry,
    expectedVersion?: number | null
  ): Promise<SaveHandoffResult> {
    const role = handoff.role || "global"; // v3.0: default to 'global'

    // CASE 1: No expectedVersion → UPSERT (create or force-update)
    if (expectedVersion === null || expectedVersion === undefined) {
      // Try INSERT first
      try {
        await this.db.execute({
          sql: `INSERT INTO session_handoffs
            (id, project, user_id, role, last_summary, pending_todo, active_decisions,
             keywords, key_context, active_branch, version, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          args: [
            randomUUID(),
            handoff.project,
            handoff.user_id,
            role,
            handoff.last_summary ?? null,
            JSON.stringify(handoff.pending_todo ?? []),
            JSON.stringify(handoff.active_decisions ?? []),
            JSON.stringify(handoff.keywords ?? []),
            handoff.key_context ?? null,
            handoff.active_branch ?? null,
            JSON.stringify(handoff.metadata ?? {}),
          ],
        });
        return { status: "created", version: 1 };
      } catch (err) {
        // UNIQUE constraint violation → update instead
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE") || msg.includes("constraint")) {
          const result = await this.db.execute({
            sql: `UPDATE session_handoffs
              SET last_summary = ?, pending_todo = ?, active_decisions = ?,
                  keywords = ?, key_context = ?, active_branch = ?,
                  metadata = ?, version = version + 1, updated_at = datetime('now')
              WHERE project = ? AND user_id = ? AND role = ?
              RETURNING version`,
            args: [
              handoff.last_summary ?? null,
              JSON.stringify(handoff.pending_todo ?? []),
              JSON.stringify(handoff.active_decisions ?? []),
              JSON.stringify(handoff.keywords ?? []),
              handoff.key_context ?? null,
              handoff.active_branch ?? null,
              JSON.stringify(handoff.metadata ?? {}),
              handoff.project,
              handoff.user_id,
              role,
            ],
          });
          const newVersion = result.rows[0]?.version as number;
          return { status: "updated", version: newVersion };
        }
        throw err;
      }
    }

    // CASE 2: OCC — update ONLY if version matches expectedVersion
    const result = await this.db.execute({
      sql: `UPDATE session_handoffs
        SET last_summary = ?, pending_todo = ?, active_decisions = ?,
            keywords = ?, key_context = ?, active_branch = ?,
            metadata = ?, version = version + 1, updated_at = datetime('now')
        WHERE project = ? AND user_id = ? AND role = ? AND version = ?
        RETURNING version`,
      args: [
        handoff.last_summary ?? null,
        JSON.stringify(handoff.pending_todo ?? []),
        JSON.stringify(handoff.active_decisions ?? []),
        JSON.stringify(handoff.keywords ?? []),
        handoff.key_context ?? null,
        handoff.active_branch ?? null,
        JSON.stringify(handoff.metadata ?? {}),
        handoff.project,
        handoff.user_id,
        role,
        expectedVersion,
      ],
    });

    if (result.rows.length === 0) {
      // Version mismatch — detect the actual current version
      const check = await this.db.execute({
        sql: "SELECT version FROM session_handoffs WHERE project = ? AND user_id = ? AND role = ?",
        args: [handoff.project, handoff.user_id, role],
      });

      if (check.rows.length > 0) {
        return {
          status: "conflict",
          current_version: check.rows[0].version as number,
        };
      }

      // Doesn't exist — create it
      return this.saveHandoff(handoff, null);
    }

    return {
      status: "updated",
      version: result.rows[0].version as number,
    };
  }

  async deleteHandoff(project: string, userId: string): Promise<void> {
    await this.db.execute({
      sql: "DELETE FROM session_handoffs WHERE project = ? AND user_id = ?",
      args: [project, userId],
    });
  }

  // ─── Load Context (Progressive) ────────────────────────────

  async loadContext(
    project: string,
    level: string,
    userId: string,
    role?: string  // v3.0: optional role filter
  ): Promise<ContextResult> {
    const effectiveRole = role || "global";

    // Fetch handoff state (role-scoped)
    const handoffResult = await this.db.execute({
      sql: "SELECT * FROM session_handoffs WHERE project = ? AND user_id = ? AND role = ?",
      args: [project, userId, effectiveRole],
    });

    if (handoffResult.rows.length === 0) return null;

    const handoff = handoffResult.rows[0] as Record<string, unknown>;

    // Base context (always returned)
    const context: Record<string, unknown> = {
      project: handoff.project,
      role: handoff.role, // v3.0: include role in response
      keywords: this.parseJsonColumn(handoff.keywords),
      pending_todo: this.parseJsonColumn(handoff.pending_todo),
      version: handoff.version,
      metadata: this.parseJsonColumn(handoff.metadata) || {},
    };

    if (level === "quick") {
      return context;
    }

    // Standard: add handoff summary, active decisions, branch
    context.last_summary = handoff.last_summary;
    context.active_decisions = this.parseJsonColumn(handoff.active_decisions);
    context.active_branch = handoff.active_branch;
    context.key_context = handoff.key_context;

    // ─── v4.0: Behavioral Warnings (Standard & Deep) ────────────
    // Hoisted above the branch so both levels get warnings without duplication.
    // Filters: role-scoped, non-archived, non-deleted, high importance.
    const warningsResult = await this.db.execute({
      sql: `SELECT summary, importance
            FROM session_ledger
            WHERE project = ? AND user_id = ? AND role = ?
              AND event_type = 'correction'
              AND importance >= 3
              AND deleted_at IS NULL
              AND archived_at IS NULL
            ORDER BY importance DESC
            LIMIT 5`,
      args: [project, userId, effectiveRole],
    });

    if (warningsResult.rows.length > 0) {
      context.behavioral_warnings = warningsResult.rows.map(r => ({
        summary: r.summary,
        importance: r.importance,
      }));
    }

    if (level === "standard") {
      // Add recent ledger entries (role-scoped)
      const recentLedger = await this.db.execute({
        sql: `SELECT summary, decisions, session_date, created_at
              FROM session_ledger
              WHERE project = ? AND user_id = ? AND role = ?
                AND archived_at IS NULL AND deleted_at IS NULL
              ORDER BY created_at DESC
              LIMIT 5`,
        args: [project, userId, effectiveRole],
      });

      context.recent_sessions = recentLedger.rows.map(r => ({
        summary: r.summary,
        decisions: this.parseJsonColumn(r.decisions),
        session_date: r.session_date || r.created_at,
      }));

      // v3.0: Team Roster injection — show active teammates
      if (role && role !== "global") {
        try {
          const teamResult = await this.db.execute({
            sql: `SELECT role, status, current_task, last_heartbeat
                  FROM agent_registry
                  WHERE project = ? AND user_id = ? AND role != ?
                    AND last_heartbeat > datetime('now', '-30 minutes')
                  ORDER BY last_heartbeat DESC`,
            args: [project, userId, role],
          });

          if (teamResult.rows.length > 0) {
            context.active_team = teamResult.rows.map(r => ({
              role: r.role,
              status: r.status,
              current_task: r.current_task,
              last_heartbeat: r.last_heartbeat,
            }));
          }
        } catch {
          // agent_registry may not exist yet — graceful degradation
        }
      }

      return context;
    }

    // Deep: add full session history (role-scoped)
    const fullLedger = await this.db.execute({
      sql: `SELECT summary, decisions, files_changed, todos, session_date, created_at
            FROM session_ledger
            WHERE project = ? AND user_id = ? AND role = ?
              AND archived_at IS NULL AND deleted_at IS NULL
            ORDER BY created_at DESC
            LIMIT 50`,
      args: [project, userId, effectiveRole],
    });

    context.session_history = fullLedger.rows.map(r => ({
      summary: r.summary,
      decisions: this.parseJsonColumn(r.decisions),
      files_changed: this.parseJsonColumn(r.files_changed),
      todos: this.parseJsonColumn(r.todos),
      session_date: r.session_date || r.created_at,
    }));

    return context;
  }

  // ─── Search Operations ─────────────────────────────────────

  async searchKnowledge(params: {
    project?: string | null;
    keywords: string[];
    category?: string | null;
    queryText?: string | null;
    limit: number;
    userId: string;
    role?: string | null;  // v3.0: optional role filter
  }): Promise<KnowledgeSearchResult | null> {
    // Build FTS5 query from keywords
    // "stripe webhook auth" → "stripe OR webhook OR auth"
    const searchTerms = params.keywords
      .filter(k => k.length > 2)
      .map(k => `"${k.replace(/"/g, "")}"`)
      .join(" OR ");

    if (!searchTerms && !params.queryText) return null;

    const ftsQuery = searchTerms || params.queryText || "";

    // Build query with optional project filter
    let sql: string;
    const args: InValue[] = [];

    if (params.project) {
      sql = `
        SELECT l.id, l.project, l.summary, l.decisions, l.keywords,
               l.files_changed, l.session_date, l.created_at,
               rank AS relevance
        FROM ledger_fts f
        JOIN session_ledger l ON f.rowid = l.rowid
        WHERE ledger_fts MATCH ?
          AND l.project = ?
          AND l.user_id = ?
          AND l.archived_at IS NULL
          AND l.deleted_at IS NULL
        ORDER BY rank
        LIMIT ?
      `;
      args.push(ftsQuery, params.project, params.userId, params.limit);
    } else {
      sql = `
        SELECT l.id, l.project, l.summary, l.decisions, l.keywords,
               l.files_changed, l.session_date, l.created_at,
               rank AS relevance
        FROM ledger_fts f
        JOIN session_ledger l ON f.rowid = l.rowid
        WHERE ledger_fts MATCH ?
          AND l.user_id = ?
          AND l.archived_at IS NULL
          AND l.deleted_at IS NULL
        ORDER BY rank
        LIMIT ?
      `;
      args.push(ftsQuery, params.userId, params.limit);
    }

    try {
      const result = await this.db.execute({ sql, args });

      if (result.rows.length === 0) return null;

      const results = result.rows.map(r => ({
        id: r.id,
        project: r.project,
        summary: r.summary,
        decisions: this.parseJsonColumn(r.decisions),
        keywords: this.parseJsonColumn(r.keywords),
        files_changed: this.parseJsonColumn(r.files_changed),
        session_date: r.session_date || r.created_at,
        relevance: r.relevance,
      }));

      return { count: results.length, results };
    } catch (err) {
      // FTS5 query syntax error — fall back to LIKE search
      console.error(`[SqliteStorage] FTS5 search failed, falling back to LIKE: ${err}`);
      return this.searchKnowledgeFallback(params);
    }
  }

  /** Fallback search using LIKE when FTS5 query syntax fails */
  private async searchKnowledgeFallback(params: {
    project?: string | null;
    keywords: string[];
    queryText?: string | null;
    limit: number;
    userId: string;
  }): Promise<KnowledgeSearchResult | null> {
    const conditions: string[] = ["user_id = ?", "archived_at IS NULL", "deleted_at IS NULL"];
    const args: InValue[] = [params.userId];

    if (params.project) {
      conditions.push("project = ?");
      args.push(params.project);
    }

    // Add LIKE conditions for each keyword
    for (const kw of params.keywords) {
      if (kw.length > 2) {
        conditions.push("(summary LIKE ? OR keywords LIKE ? OR decisions LIKE ?)");
        const pattern = `%${kw}%`;
        args.push(pattern, pattern, pattern);
      }
    }

    args.push(params.limit);

    const result = await this.db.execute({
      sql: `SELECT id, project, summary, decisions, keywords, files_changed, session_date, created_at
            FROM session_ledger
            WHERE ${conditions.join(" AND ")}
            ORDER BY created_at DESC
            LIMIT ?`,
      args,
    });

    if (result.rows.length === 0) return null;

    const results = result.rows.map(r => ({
      id: r.id,
      project: r.project,
      summary: r.summary,
      decisions: this.parseJsonColumn(r.decisions),
      keywords: this.parseJsonColumn(r.keywords),
      files_changed: this.parseJsonColumn(r.files_changed),
      session_date: r.session_date || r.created_at,
    }));

    return { count: results.length, results };
  }

  async searchMemory(params: {
    queryEmbedding: string; // JSON-stringified number[]
    project?: string | null;
    limit: number;
    similarityThreshold: number;
    userId: string;
    role?: string | null;  // v3.0: optional role filter
  }): Promise<SemanticSearchResult[]> {
    // ─── VECTOR SEARCH (cosine similarity via libSQL) ───
    // vector_distance_cos() returns distance (0 to 2).
    // Similarity = 1 - distance. Higher is better.
    try {
      let sql: string;
      const args: InValue[] = [];

      if (params.project) {
        sql = `
          SELECT l.id, l.project, l.summary, l.decisions, l.files_changed,
                 l.session_date, l.created_at,
                 (1 - vector_distance_cos(l.embedding, vector(?))) AS similarity
          FROM session_ledger l
          WHERE l.embedding IS NOT NULL
            AND l.user_id = ?
            AND l.project = ?
            AND l.archived_at IS NULL
            AND l.deleted_at IS NULL
          ORDER BY similarity DESC
          LIMIT ?
        `;
        args.push(params.queryEmbedding, params.userId, params.project, params.limit);
      } else {
        sql = `
          SELECT l.id, l.project, l.summary, l.decisions, l.files_changed,
                 l.session_date, l.created_at,
                 (1 - vector_distance_cos(l.embedding, vector(?))) AS similarity
          FROM session_ledger l
          WHERE l.embedding IS NOT NULL
            AND l.user_id = ?
            AND l.archived_at IS NULL
            AND l.deleted_at IS NULL
          ORDER BY similarity DESC
          LIMIT ?
        `;
        args.push(params.queryEmbedding, params.userId, params.limit);
      }

      const result = await this.db.execute({ sql, args });

      // Filter by similarity threshold and format results
      return result.rows
        .filter(r => (r.similarity as number) >= params.similarityThreshold)
        .map(r => ({
          id: r.id as string,
          project: r.project as string,
          summary: r.summary as string,
          similarity: r.similarity as number,
          session_date: (r.session_date || r.created_at) as string,
          decisions: this.parseJsonColumn(r.decisions) as string[],
          files_changed: this.parseJsonColumn(r.files_changed) as string[],
        }));
    } catch (err) {
      // ─── TIER 2 FALLBACK: Asymmetric TurboQuant search in JS ───
      // When native vector search fails (libSQL <0.4.0 or no F32_BLOB),
      // fall back to fetching compressed embeddings and ranking in JS
      // using asymmetricCosineSimilarity().
      debugLog(
        `[SqliteStorage] Tier-1 vector search failed, trying Tier-2 TurboQuant fallback: ${err}`
      );

      try {
        const { getDefaultCompressor, deserialize } = await import("../utils/turboquant.js");
        const compressor = getDefaultCompressor();

        // Parse query embedding from JSON string
        const queryVec: number[] = JSON.parse(params.queryEmbedding);

        // Fetch all entries that have compressed embeddings
        let fallbackSql: string;
        const fallbackArgs: InValue[] = [];

        if (params.project) {
          fallbackSql = `
            SELECT id, project, summary, decisions, files_changed,
                   session_date, created_at, embedding_compressed, embedding_turbo_radius
            FROM session_ledger
            WHERE embedding_compressed IS NOT NULL
              AND user_id = ?
              AND project = ?
              AND archived_at IS NULL
              AND deleted_at IS NULL
          `;
          fallbackArgs.push(params.userId, params.project);
        } else {
          fallbackSql = `
            SELECT id, project, summary, decisions, files_changed,
                   session_date, created_at, embedding_compressed, embedding_turbo_radius
            FROM session_ledger
            WHERE embedding_compressed IS NOT NULL
              AND user_id = ?
              AND archived_at IS NULL
              AND deleted_at IS NULL
          `;
          fallbackArgs.push(params.userId);
        }

        const fallbackResult = await this.db.execute({ sql: fallbackSql, args: fallbackArgs });

        // Score each entry using asymmetric cosine similarity
        const scored: SemanticSearchResult[] = [];
        for (const row of fallbackResult.rows) {
          try {
            const compressedBase64 = row.embedding_compressed as string;
            const buf = Buffer.from(compressedBase64, "base64");
            const compressed = deserialize(buf);
            const similarity = compressor.asymmetricCosineSimilarity(queryVec, compressed);

            if (similarity >= params.similarityThreshold) {
              scored.push({
                id: row.id as string,
                project: row.project as string,
                summary: row.summary as string,
                similarity,
                session_date: (row.session_date || row.created_at) as string,
                decisions: this.parseJsonColumn(row.decisions) as string[],
                files_changed: this.parseJsonColumn(row.files_changed) as string[],
              });
            }
          } catch {
            // Skip entries with corrupt compressed data
          }
        }

        // Sort by similarity descending and limit
        scored.sort((a, b) => b.similarity - a.similarity);
        debugLog(
          `[SqliteStorage] Tier-2 TurboQuant fallback: scored ${fallbackResult.rows.length} entries, ` +
          `${scored.length} above threshold`
        );
        return scored.slice(0, params.limit);
      } catch (fallbackErr) {
        // Both tiers failed — return empty
        console.error(
          `[SqliteStorage] Both Tier-1 and Tier-2 search failed: ${fallbackErr}`
        );
        console.error("[SqliteStorage] Tip: Ensure you're using libSQL ≥ 0.4.0 for native vector support.");
        return [];
      }
    }
  }

  // ─── Compaction ────────────────────────────────────────────

  async getCompactionCandidates(
    threshold: number,
    keepRecent: number,
    userId: string
  ): Promise<Array<{ project: string; total_entries: number; to_compact: number }>> {
    const result = await this.db.execute({
      sql: `SELECT project, COUNT(*) as total_entries
            FROM session_ledger
            WHERE user_id = ? AND archived_at IS NULL AND is_rollup = 0
            GROUP BY project
            HAVING COUNT(*) > ?`,
      args: [userId, threshold],
    });

    return result.rows.map(r => ({
      project: r.project as string,
      total_entries: r.total_entries as number,
      to_compact: (r.total_entries as number) - keepRecent,
    }));
  }

  // ─── Time Travel ──────────────────────────────────────────

  async saveHistorySnapshot(handoff: HandoffEntry, branch: string = "main"): Promise<void> {
    const id = randomUUID();
    const snapshotStr = JSON.stringify(handoff);

    await this.db.execute({
      sql: `INSERT INTO session_handoffs_history
            (id, project, user_id, version, snapshot, branch)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        handoff.project,
        handoff.user_id,
        handoff.version ?? 1,
        snapshotStr,
        branch,
      ],
    });

    console.error(
      `[SqliteStorage] History snapshot saved: project=${handoff.project}, ` +
      `version=${handoff.version ?? 1}, branch=${branch}`
    );
  }

  async getHistory(
    project: string,
    userId: string,
    limit: number = 10
  ): Promise<HistorySnapshot[]> {
    const result = await this.db.execute({
      sql: `SELECT id, project, user_id, version, snapshot, branch, created_at
            FROM session_handoffs_history
            WHERE project = ? AND user_id = ?
            ORDER BY version DESC
            LIMIT ?`,
      args: [project, userId, limit],
    });

    return result.rows.map(row => ({
      id: row.id as string,
      project: row.project as string,
      user_id: row.user_id as string,
      version: row.version as number,
      snapshot: JSON.parse(row.snapshot as string) as HandoffEntry,
      branch: row.branch as string,
      created_at: row.created_at as string,
    }));
  }

  // ─── v2.0 Dashboard ─────────────────────────────────────────

  async listProjects(): Promise<string[]> {
    const result = await this.db.execute(
      "SELECT DISTINCT project FROM session_handoffs ORDER BY project ASC"
    );
    return result.rows.map(row => row.project as string);
  }

  // ─── v2.2.0 Health Check (fsck) ─────────────────────────────

  /**
   * Gather raw health statistics for the integrity checker.
   *
   * This method runs 5 lightweight SQL queries and returns raw data.
   * The heavy analysis (duplicate detection via Jaccard similarity)
   * happens in healthCheck.ts in pure JS — keeping SQLite free of
   * C-extension dependencies like Levenshtein.
   */
  async getHealthStats(userId: string): Promise<HealthStats> {

    // ── Check 1: Count entries with no embedding vector ──────────
    // When Gemini API is down during save, the fire-and-forget
    // embedding call fails silently. These rows need backfill.
    const missingResult = await this.db.execute({
      sql: `
        SELECT COUNT(*) as cnt
        FROM session_ledger
        WHERE user_id = ?
          AND archived_at IS NULL
          AND embedding IS NULL
      `,
      args: [userId],  // bind user_id to the ? placeholder
    });
    const missingEmbeddings = Number(  // extract count, default 0
      missingResult.rows[0]?.cnt ?? 0
    );

    // ── Check 2: Fetch active summaries for JS duplicate detection ─
    // We pull id + project + summary into memory so healthCheck.ts
    // can run Jaccard similarity in pure JS (~5ms for typical sets).
    // The Compactor keeps the active ledger small, so this is safe.
    const summariesResult = await this.db.execute({
      sql: `
        SELECT id, project, summary
        FROM session_ledger
        WHERE user_id = ?
          AND archived_at IS NULL
      `,
      args: [userId],  // bind user_id to the ? placeholder
    });
    // Map raw DB rows to typed objects for the health engine
    const activeLedgerSummaries = summariesResult.rows.map(row => ({
      id: row.id as string,         // unique entry identifier
      project: row.project as string, // project this entry belongs to
      summary: row.summary as string, // text we compare for duplicates
    }));

    // ── Check 3: Find orphaned handoffs ──────────────────────────
    // An orphaned handoff = handoff state exists but zero active
    // ledger entries back it. Usually from testing or bugs.
    // LEFT JOIN + HAVING COUNT = 0 finds projects with no entries.
    const orphanResult = await this.db.execute({
      sql: `
        SELECT h.project
        FROM session_handoffs h
        LEFT JOIN session_ledger l
          ON h.project = l.project
          AND h.user_id = l.user_id
          AND l.archived_at IS NULL
        WHERE h.user_id = ?
        GROUP BY h.project
        HAVING COUNT(l.id) = 0
      `,
      args: [userId],  // bind user_id to the ? placeholder
    });
    // Map to simple project name objects
    const orphanedHandoffs = orphanResult.rows.map(row => ({
      project: row.project as string,  // the orphaned project name
    }));

    // ── Check 4: Count stale rollups ─────────────────────────────
    // A rollup entry should have archived originals backing it.
    // If those originals were hard-deleted, the rollup is stale.
    // Self-join: rollups (is_rollup=1) LEFT JOIN archived entries.
    const staleResult = await this.db.execute({
      sql: `
        SELECT r.id
        FROM session_ledger r
        LEFT JOIN session_ledger a
          ON a.archived_at IS NOT NULL
          AND a.project = r.project
          AND a.user_id = r.user_id
        WHERE r.user_id = ?
          AND r.is_rollup = 1
          AND r.archived_at IS NULL
        GROUP BY r.id
        HAVING COUNT(a.id) = 0
      `,
      args: [userId],  // bind user_id to the ? placeholder
    });
    // Count how many rollups have zero archived originals
    const staleRollups = staleResult.rows.length;

    // ── Totals: aggregate counts for health report summary ───────
    // Three scalar subqueries in one shot for efficiency.
    const totalsResult = await this.db.execute({
      sql: `
        SELECT
          (SELECT COUNT(*) FROM session_ledger
            WHERE user_id = ? AND archived_at IS NULL) as active,
          (SELECT COUNT(*) FROM session_handoffs
            WHERE user_id = ?) as handoffs,
          (SELECT COUNT(*) FROM session_ledger
            WHERE user_id = ? AND is_rollup = 1
            AND archived_at IS NULL) as rollups
      `,
      args: [userId, userId, userId],  // bind user_id 3x (one per subquery)
    });
    // Extract each total, fallback to 0 if undefined
    const totalActiveEntries = Number(totalsResult.rows[0]?.active ?? 0);
    const totalHandoffs = Number(totalsResult.rows[0]?.handoffs ?? 0);
    const totalRollups = Number(totalsResult.rows[0]?.rollups ?? 0);

    // ── Return the complete raw health stats ─────────────────────
    // healthCheck.ts engine will analyze this + produce HealthReport
    return {
      missingEmbeddings,     // entries needing embedding repair
      activeLedgerSummaries, // raw summaries for JS dupe detection
      orphanedHandoffs,      // projects with handoff but no ledger
      staleRollups,          // rollups with no archived originals
      totalActiveEntries,    // grand total of active entries
      totalHandoffs,         // grand total of handoff records
      totalRollups,          // grand total of rollup entries
    };
  }

  // ─── v3.0: Agent Registry (Hivemind) ───────────────────────

  async registerAgent(entry: AgentRegistryEntry): Promise<AgentRegistryEntry> {
    const id = randomUUID();
    const role = entry.role;
    const status = entry.status || "active";

    try {
      // Try INSERT first
      await this.db.execute({
        sql: `INSERT INTO agent_registry
          (id, project, user_id, role, agent_name, status, current_task)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          entry.project,
          entry.user_id,
          role,
          entry.agent_name ?? null,
          status,
          entry.current_task ?? null,
        ],
      });

      debugLog(`[SqliteStorage] Agent registered: ${entry.project}/${role}`);
      return { ...entry, id, status };
    } catch (err) {
      // UNIQUE constraint → update existing
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE") || msg.includes("constraint")) {
        await this.db.execute({
          sql: `UPDATE agent_registry
            SET agent_name = ?, status = ?, current_task = ?,
                last_heartbeat = datetime('now')
            WHERE project = ? AND user_id = ? AND role = ?`,
          args: [
            entry.agent_name ?? null,
            status,
            entry.current_task ?? null,
            entry.project,
            entry.user_id,
            role,
          ],
        });

        debugLog(`[SqliteStorage] Agent re-registered: ${entry.project}/${role}`);
        return { ...entry, status };
      }
      throw err;
    }
  }

  async heartbeatAgent(
    project: string,
    userId: string,
    role: string,
    currentTask?: string
  ): Promise<void> {
    const setClauses = ["last_heartbeat = datetime('now')"];
    const args: InValue[] = [];

    if (currentTask !== undefined) {
      setClauses.push("current_task = ?");
      args.push(currentTask);
    }

    args.push(project, userId, role);

    await this.db.execute({
      sql: `UPDATE agent_registry
        SET ${setClauses.join(", ")}
        WHERE project = ? AND user_id = ? AND role = ?`,
      args,
    });
  }

  async listTeam(
    project: string,
    userId: string,
    staleMinutes: number = 30
  ): Promise<AgentRegistryEntry[]> {
    // Auto-prune stale agents first
    await this.db.execute({
      sql: `DELETE FROM agent_registry
        WHERE project = ? AND user_id = ?
          AND last_heartbeat < datetime('now', '-' || ? || ' minutes')`,
      args: [project, userId, staleMinutes],
    });

    // Fetch remaining active agents
    const result = await this.db.execute({
      sql: `SELECT id, project, user_id, role, agent_name, status,
                   current_task, last_heartbeat, created_at
            FROM agent_registry
            WHERE project = ? AND user_id = ?
            ORDER BY last_heartbeat DESC`,
      args: [project, userId],
    });

    return result.rows.map(r => ({
      id: r.id as string,
      project: r.project as string,
      user_id: r.user_id as string,
      role: r.role as string,
      agent_name: r.agent_name as string | null,
      status: (r.status as "active" | "idle" | "shutdown"),
      current_task: r.current_task as string | null,
      last_heartbeat: r.last_heartbeat as string,
      created_at: r.created_at as string,
    }));
  }

  async deregisterAgent(
    project: string,
    userId: string,
    role: string
  ): Promise<void> {
    await this.db.execute({
      sql: "DELETE FROM agent_registry WHERE project = ? AND user_id = ? AND role = ?",
      args: [project, userId, role],
    });
    debugLog(`[SqliteStorage] Agent deregistered: ${project}/${role}`);
  }

  // ─── System Settings (v3.0 Dashboard) — proxy to configStorage ───

  async getSetting(key: string): Promise<string | null> {
    const val = await cfgGet(key, "");
    return val === "" ? null : val;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await cfgSet(key, value);
  }

  async getAllSettings(): Promise<Record<string, string>> {
    return cfgGetAll();
  }

  // ─── v3.1: Memory Analytics ──────────────────────────────────────────────
  //
  // Returns usage statistics for the Mind Palace dashboard.
  // Two SQL queries are used:
  //   Query 1 — aggregate counts (fast, single pass)
  //   Query 2 — sessions-per-day for the 14-day sparkline
  //
  // Both queries exclude:
  //   • archived_at IS NOT NULL  — TTL-expired entries (soft-deleted by expireByTTL)
  //   • deleted_at IS NOT NULL   — GDPR tombstones (from session_forget_memory)
  // This ensures the dashboard only shows "live" memory, matching what the
  // LLM actually sees during session_load_context.

  async getAnalytics(project: string, userId: string): Promise<AnalyticsData> {
    // Query 1: Aggregate stats — total entries, rollup count, tokens saved,
    // and average summary length (used as a proxy for knowledge richness).
    const countResult = await this.db.execute({
      sql: `SELECT
              COUNT(*) AS total_entries,
              SUM(CASE WHEN is_rollup = 1 THEN 1 ELSE 0 END) AS total_rollups,
              -- rollup_count tracks how many raw entries each rollup replaced,
              -- so we can show "X entries saved by compaction" in the dashboard.
              SUM(CASE WHEN is_rollup = 1 THEN COALESCE(rollup_count, 0) ELSE 0 END) AS rollup_savings,
              COALESCE(AVG(LENGTH(summary)), 0) AS avg_summary_length
            FROM session_ledger
            WHERE project = ? AND user_id = ?
              AND archived_at IS NULL AND deleted_at IS NULL`,
      args: [project, userId],
    });

    const row = countResult.rows[0] as Record<string, unknown>;

    // Query 2: Sessions per day for the sparkline (last 14 days).
    // We only count non-rollup entries so the chart reflects actual work sessions,
    // not compaction operations.
    const sparkResult = await this.db.execute({
      sql: `SELECT
              DATE(created_at) AS date,
              COUNT(*) AS count
            FROM session_ledger
            WHERE project = ? AND user_id = ?
              AND archived_at IS NULL AND deleted_at IS NULL
              AND is_rollup = 0
              AND created_at >= DATE('now', '-14 days')
            GROUP BY DATE(created_at)
            ORDER BY date ASC`,
      args: [project, userId],
    });

    // Fill in zeros for days with no sessions so the sparkline always
    // has exactly 14 bars regardless of how sparse the data is.
    // A gap-fill approach (day loop + Map lookup) is much simpler than
    // a SQL recursive CTE for this use case.
    const sparkMap = new Map<string, number>();
    for (const r of sparkResult.rows) {
      sparkMap.set(r.date as string, r.count as number);
    }

    const sessionsByDay: Array<{ date: string; count: number }> = [];
    for (let i = 13; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().slice(0, 10);
      sessionsByDay.push({ date: dateStr, count: sparkMap.get(dateStr) || 0 });
    }

    return {
      totalEntries: (row?.total_entries as number) || 0,
      totalRollups: (row?.total_rollups as number) || 0,
      rollupSavings: (row?.rollup_savings as number) || 0,
      avgSummaryLength: Math.round((row?.avg_summary_length as number) || 0),
      sessionsByDay,
    };
  }

  // ─── v3.1: TTL / Automated Data Retention ────────────────────────────────
  //
  // Design: SOFT-DELETE (not hard-delete)
  //
  // We set archived_at rather than deleting rows. This means:
  //   • The entry disappears from session_load_context and knowledge_search
  //     immediately (both queries filter on archived_at IS NULL)
  //   • The row is preserved for audit trails and GDPR right-of-access requests
  //   • A hard-delete can still be performed later via session_forget_memory
  //     with hard_delete: true
  //
  // Rollup entries (is_rollup = 1) are intentionally excluded from expiry:
  //   • Rollups are dense summaries of many sessions — losing them would wipe
  //     the entire compacted history, not just old raw entries.
  //   • If users want to clean up rollups, they should use knowledge_forget
  //     or session_forget_memory explicitly.
  //
  // The minimum TTL enforced in the handler is 7 days, so the cutoff is
  // always at least one week in the past. This prevents accidental mass-delete.

  async expireByTTL(
    project: string,
    ttlDays: number,
    userId: string
  ): Promise<{ expired: number }> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - ttlDays);
    const cutoffStr = cutoff.toISOString();

    // Use archived_at (soft-delete) rather than hard-deleting rows.
    // This preserves the audit trail while hiding old entries from all
    // standard queries that filter on `archived_at IS NULL`.
    const result = await this.db.execute({
      sql: `UPDATE session_ledger
            SET archived_at = datetime('now')
            WHERE project = ? AND user_id = ?
              AND is_rollup = 0          -- never expire compacted rollups
              AND archived_at IS NULL    -- idempotent: skip already-expired rows
              AND deleted_at IS NULL     -- skip GDPR tombstones
              AND created_at < ?`,
      args: [project, userId, cutoffStr],
    });

    const expired = result.rowsAffected || 0;
    debugLog(`[SqliteStorage] TTL sweep: expired ${expired} entries for "${project}" (cutoff: ${cutoffStr})`);

    // ─── v4.0: Importance Decay ──────────────────────────────────
    // Decay importance of experience entries not referenced in 30 days.
    // This prevents "Insight Bloat" — old corrections that are no longer
    // relevant gradually lose their weight and stop appearing as warnings.
    // Only targets typed experience events (event_type != 'session'),
    // so regular session logs are never affected.
    const decayResult = await this.db.execute({
      sql: `UPDATE session_ledger
            SET importance = MAX(0, importance - 1)
            WHERE project = ? AND user_id = ?
              AND importance > 0
              AND event_type != 'session'
              AND created_at < datetime('now', '-30 days')
              AND deleted_at IS NULL`,
      args: [project, userId],
    });
    const decayed = decayResult.rowsAffected || 0;
    if (decayed > 0) {
      debugLog(`[SqliteStorage] Importance decay: reduced ${decayed} entries for "${project}"`);
    }

    return { expired };
  }

  // ─── v4.0: Insight Graduation ──────────────────────────────────
  //
  // Adjusts the importance score of a ledger entry.
  // Used by knowledge_upvote (+1) and knowledge_downvote (-1).
  // Importance is clamped via MAX(0, ...) — never goes negative.
  // Entries reaching importance >= 7 are considered "graduated"
  // and will appear prominently in behavioral warnings.

  async adjustImportance(
    id: string,
    delta: number,
    userId: string
  ): Promise<void> {
    await this.db.execute({
      sql: `UPDATE session_ledger
            SET importance = MAX(0, importance + ?)
            WHERE id = ? AND user_id = ?`,
      args: [delta, id, userId],
    });
    debugLog(`[SqliteStorage] Adjusted importance for ${id} by ${delta > 0 ? "+" : ""}${delta}`);
  }

  // ─── v4.2: Graduated Insights Query ──────────────────────────
  //
  // Returns ledger entries that have "graduated" — i.e., their
  // importance score has reached the threshold (default 7).
  // Used by knowledge_sync_rules to physically write insights
  // into .cursorrules / .clauderules files at the project repo path.

  async getGraduatedInsights(
    project: string,
    userId: string,
    minImportance: number = 7
  ): Promise<LedgerEntry[]> {
    const result = await this.db.execute({
      sql: `SELECT id, project, user_id, role, summary, importance,
                   event_type, decisions, created_at
            FROM session_ledger
            WHERE project = ? AND user_id = ?
              AND importance >= ?
              AND deleted_at IS NULL
              AND archived_at IS NULL
            ORDER BY importance DESC, created_at DESC`,
      args: [project, userId, minImportance],
    });

    return result.rows.map(row => ({
      id: row.id as string,
      project: row.project as string,
      user_id: row.user_id as string,
      role: (row.role as string) || "global",
      summary: row.summary as string,
      importance: Number(row.importance),
      event_type: (row.event_type as string) || "session",
      decisions: this.parseJsonColumn(row.decisions) as string[],
      created_at: row.created_at as string,
      conversation_id: "",
    }));
  }

  // ─── v4.3: Standalone Importance Decay ────────────────────
  //
  // Extracted from expireByTTL so decay can be triggered independently
  // (e.g. fire-and-forget from session_save_ledger) without needing
  // an active TTL retention policy.

  async decayImportance(
    project: string,
    userId: string,
    decayDays: number
  ): Promise<void> {
    const result = await this.db.execute({
      sql: `UPDATE session_ledger
            SET importance = MAX(0, importance - 1)
            WHERE project = ? AND user_id = ?
              AND importance > 0
              AND event_type != 'session'
              AND created_at < datetime('now', '-' || ? || ' days')
              AND deleted_at IS NULL`,
      args: [project, userId, decayDays],
    });
    const decayed = result.rowsAffected || 0;
    if (decayed > 0) {
      debugLog(`[SqliteStorage] decayImportance: reduced ${decayed} entries for "${project}" (>${decayDays}d old)`);
    }
  }

}

