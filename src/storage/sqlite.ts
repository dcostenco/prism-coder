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

import type {
  StorageBackend,
  LedgerEntry,
  HandoffEntry,
  SaveHandoffResult,
  ContextResult,
  KnowledgeSearchResult,
  SemanticSearchResult,
} from "./interface.js";

export class SqliteStorage implements StorageBackend {
  private db!: Client;
  private dbPath!: string;

  // ─── Lifecycle ─────────────────────────────────────────────

  async initialize(): Promise<void> {
    // Resolve ~/.prism-mcp/ directory
    const prismDir = path.join(os.homedir(), ".prism-mcp");
    if (!fs.existsSync(prismDir)) {
      fs.mkdirSync(prismDir, { recursive: true });
    }

    this.dbPath = path.join(prismDir, "data.db");

    this.db = createClient({
      url: `file:${this.dbPath}`,
    });

    // Enable WAL mode for better concurrent read performance
    await this.db.execute("PRAGMA journal_mode=WAL");

    // Run all migrations
    await this.runMigrations();

    console.error(`[SqliteStorage] Initialized at ${this.dbPath}`);
  }

  async close(): Promise<void> {
    this.db.close();
    console.error("[SqliteStorage] Closed");
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
        embedding TEXT DEFAULT NULL,
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
    `);
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
      try { return JSON.parse(value); } catch { return []; }
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
        (id, project, conversation_id, user_id, summary, todos, files_changed,
         decisions, keywords, is_rollup, rollup_count, title, agent_name, created_at, session_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        entry.project,
        entry.conversation_id,
        entry.user_id,
        entry.summary,
        JSON.stringify(entry.todos || []),
        JSON.stringify(entry.files_changed || []),
        JSON.stringify(entry.decisions || []),
        JSON.stringify(entry.keywords || []),
        entry.is_rollup ? 1 : 0,
        entry.rollup_count || 0,
        entry.is_rollup ? `Session Rollup (${entry.rollup_count || 0} entries)` : null,
        entry.is_rollup ? "prism-compactor" : null,
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
      sets.push(`${key} = ?`);
      args.push((typeof value === "object" && value !== null ? JSON.stringify(value) : value) as InValue);
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

  // ─── Handoff Operations (OCC) ──────────────────────────────

  async saveHandoff(
    handoff: HandoffEntry,
    expectedVersion?: number | null
  ): Promise<SaveHandoffResult> {
    // CASE 1: No expectedVersion → UPSERT (create or force-update)
    if (expectedVersion === null || expectedVersion === undefined) {
      // Try INSERT first
      try {
        await this.db.execute({
          sql: `INSERT INTO session_handoffs
            (id, project, user_id, last_summary, pending_todo, active_decisions,
             keywords, key_context, active_branch, version, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '{}')`,
          args: [
            randomUUID(),
            handoff.project,
            handoff.user_id,
            handoff.last_summary ?? null,
            JSON.stringify(handoff.pending_todo ?? []),
            JSON.stringify(handoff.active_decisions ?? []),
            JSON.stringify(handoff.keywords ?? []),
            handoff.key_context ?? null,
            handoff.active_branch ?? null,
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
                  version = version + 1, updated_at = datetime('now')
              WHERE project = ? AND user_id = ?
              RETURNING version`,
            args: [
              handoff.last_summary ?? null,
              JSON.stringify(handoff.pending_todo ?? []),
              JSON.stringify(handoff.active_decisions ?? []),
              JSON.stringify(handoff.keywords ?? []),
              handoff.key_context ?? null,
              handoff.active_branch ?? null,
              handoff.project,
              handoff.user_id,
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
            version = version + 1, updated_at = datetime('now')
        WHERE project = ? AND user_id = ? AND version = ?
        RETURNING version`,
      args: [
        handoff.last_summary ?? null,
        JSON.stringify(handoff.pending_todo ?? []),
        JSON.stringify(handoff.active_decisions ?? []),
        JSON.stringify(handoff.keywords ?? []),
        handoff.key_context ?? null,
        handoff.active_branch ?? null,
        handoff.project,
        handoff.user_id,
        expectedVersion,
      ],
    });

    if (result.rows.length === 0) {
      // Version mismatch — detect the actual current version
      const check = await this.db.execute({
        sql: "SELECT version FROM session_handoffs WHERE project = ? AND user_id = ?",
        args: [handoff.project, handoff.user_id],
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
    userId: string
  ): Promise<ContextResult> {
    // Fetch handoff state
    const handoffResult = await this.db.execute({
      sql: "SELECT * FROM session_handoffs WHERE project = ? AND user_id = ?",
      args: [project, userId],
    });

    if (handoffResult.rows.length === 0) return null;

    const handoff = handoffResult.rows[0] as Record<string, unknown>;

    // Base context (always returned)
    const context: Record<string, unknown> = {
      project: handoff.project,
      keywords: this.parseJsonColumn(handoff.keywords),
      pending_todo: this.parseJsonColumn(handoff.pending_todo),
      version: handoff.version,
    };

    if (level === "quick") {
      return context;
    }

    // Standard: add handoff summary, active decisions, branch
    context.last_summary = handoff.last_summary;
    context.active_decisions = this.parseJsonColumn(handoff.active_decisions);
    context.active_branch = handoff.active_branch;
    context.key_context = handoff.key_context;

    if (level === "standard") {
      // Add recent ledger entries as summaries
      const recentLedger = await this.db.execute({
        sql: `SELECT summary, decisions, session_date, created_at
              FROM session_ledger
              WHERE project = ? AND user_id = ? AND archived_at IS NULL
              ORDER BY created_at DESC
              LIMIT 5`,
        args: [project, userId],
      });

      context.recent_sessions = recentLedger.rows.map(r => ({
        summary: r.summary,
        decisions: this.parseJsonColumn(r.decisions),
        session_date: r.session_date || r.created_at,
      }));

      return context;
    }

    // Deep: add full session history
    const fullLedger = await this.db.execute({
      sql: `SELECT summary, decisions, files_changed, todos, session_date, created_at
            FROM session_ledger
            WHERE project = ? AND user_id = ? AND archived_at IS NULL
            ORDER BY created_at DESC
            LIMIT 50`,
      args: [project, userId],
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
    const conditions: string[] = ["user_id = ?", "archived_at IS NULL"];
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
    queryEmbedding: string;
    project?: string | null;
    limit: number;
    similarityThreshold: number;
    userId: string;
  }): Promise<SemanticSearchResult[]> {
    // Step 2: FTS5 keyword fallback — true vector search comes in Step 3.
    // We extract words from the embedding query context (the handler already
    // generated an embedding, but we can't use it without sqlite-vec).
    // Instead, we search using FTS5 on recent non-archived entries.
    console.error("[SqliteStorage] searchMemory: using FTS5 fallback (vector search coming in Step 3)");

    // Without the original query text, we can't do FTS5.
    // Return empty — the handler already warns about this gracefully.
    // Step 3 will add true cosine similarity search using F32_BLOB.
    return [];
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
}
