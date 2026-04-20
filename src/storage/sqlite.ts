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
import { AccessLogBuffer } from "../utils/accessLogBuffer.js";
import { PRISM_ACTR_BUFFER_FLUSH_MS } from "../config.js";
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
  MemoryLink,              // v6.0: Associative Memory Graph
  PipelineState,           // v7.3: Dark Factory Pipeline
  PipelineStatus,          // v7.3: Dark Factory Pipeline
  VerificationHarness,     // v7.2.0
  ValidationResult,        // v7.2.0
  SpreadingActivationOptions, // v8.0: Spreading Activation
} from "./interface.js";

import { debugLog } from "../utils/logger.js";
import { getSdmEngine } from "../sdm/sdmEngine.js";
import { SafetyController } from "../darkfactory/safetyController.js";

export class SqliteStorage implements StorageBackend {
  private db!: Client;
  private dbPath!: string;
  private accessLogBuffer!: AccessLogBuffer;

  // ─── Lifecycle ─────────────────────────────────────────────

  async initialize(_isLocal?: boolean, dbPath?: string): Promise<void> {
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

    // v6.0: Enable foreign key enforcement — required for ON DELETE CASCADE
    // in memory_links table. Without this, CASCADE is silently ignored.
    await this.db.execute("PRAGMA foreign_keys = ON");

    // Run all migrations
    await this.runMigrations();

    // v7.0: Initialize the ACT-R access log write buffer.
    // The buffer batches logAccess() calls into periodic single-INSERT flushes
    // to prevent SQLite SQLITE_BUSY contention (Rule #1).
    this.accessLogBuffer = new AccessLogBuffer(this.db, PRISM_ACTR_BUFFER_FLUSH_MS);

    debugLog(`[SqliteStorage] Initialized at ${this.dbPath}`);
  }

  async close(): Promise<void> {
    // v7.0: Drain the access log buffer before closing the DB connection.
    // This ensures any buffered access events are persisted on shutdown.
    if (this.accessLogBuffer) {
      await this.accessLogBuffer.dispose();
    }
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

      const tx = await this.db.transaction();
      try {
        // Step 1: Create new table with correct constraint
        await tx.execute(`
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
        await tx.execute(`
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
        await tx.execute(`DROP TABLE session_handoffs`);
        await tx.execute(`ALTER TABLE session_handoffs_v2 RENAME TO session_handoffs`);
        
        await tx.commit();
        debugLog("[SqliteStorage] v3.0 migration: session_handoffs rebuilt with UNIQUE(project, user_id, role)");
      } catch (txError) {
        await tx.rollback();
        console.error("[SqliteStorage] v3.0 migration: session_handoffs rebuild failed, rolled back", txError);
        throw txError;
      }
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
    //
    // REVIEWER NOTE: v5.0 introduces a DUAL-STORAGE strategy for embeddings:
    //   1. `embedding` (F32_BLOB)          — float32 for native vector search (Tier 1)
    //   2. `embedding_compressed` (TEXT)    — base64 TurboQuant blob for JS fallback (Tier 2)
    //   3. `embedding_format` (TEXT)        — 'turbo3', 'turbo4', or 'float32'
    //   4. `embedding_turbo_radius` (REAL)  — original vector magnitude
    //
    // WHY DUAL-STORAGE (not replace)?
    //   - Backward compatibility: existing installations with sqlite-vec
    //     continue using Tier-1 native vector search (fastest).
    //   - Graceful degradation: installations WITHOUT sqlite-vec fall back
    //     to Tier-2 JS-side asymmetric search using compressed blobs.
    //   - The compressed column is TEXT (base64) not BLOB because SQLite's
    //     TEXT type handles base64 more reliably across @libsql/client versions.
    //
    // STORAGE OVERHEAD: The compressed blob adds ~535 bytes per entry
    //   (400 bytes * 4/3 base64 expansion ≈ 535 chars). At 10K entries,
    //   this is ~5 MB — negligible compared to the 23 MB saved by not
    //   needing float32 vectors when sqlite-vec is unavailable.
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

    // ─── v5.2 Migration: Cognitive Memory — Last Accessed Tracking ───
    //
    // REVIEWER NOTE: last_accessed_at enables dynamic importance decay
    // computed at retrieval time: effective = base * 0.95^days_since_access.
    // No background workers needed — decay is a pure function of time.
    // This column is updated fire-and-forget on each search hit.

    try {
      await this.db.execute(
        `ALTER TABLE session_ledger ADD COLUMN last_accessed_at TEXT DEFAULT NULL`
      );
      debugLog("[SqliteStorage] v5.2 migration: added last_accessed_at column");
    } catch (e: any) {
      if (!e.message?.includes("duplicate column name")) throw e;
    }

    // ── v5.3: Hivemind Watchdog columns on agent_registry ────────
    // These enable the server-side health monitor to detect frozen agents,
    // task overruns, and infinite loops. Safe no-op if columns already exist.

    try {
      await this.db.execute(
        `ALTER TABLE agent_registry ADD COLUMN task_start_time TEXT DEFAULT NULL`
      );
      debugLog("[SqliteStorage] v5.3 migration: added task_start_time column");
    } catch (e: any) {
      if (!e.message?.includes("duplicate column name")) throw e;
    }

    try {
      await this.db.execute(
        `ALTER TABLE agent_registry ADD COLUMN expected_duration_minutes INTEGER DEFAULT NULL`
      );
      debugLog("[SqliteStorage] v5.3 migration: added expected_duration_minutes column");
    } catch (e: any) {
      if (!e.message?.includes("duplicate column name")) throw e;
    }

    try {
      await this.db.execute(
        `ALTER TABLE agent_registry ADD COLUMN task_hash TEXT DEFAULT NULL`
      );
      debugLog("[SqliteStorage] v5.3 migration: added task_hash column");
    } catch (e: any) {
      if (!e.message?.includes("duplicate column name")) throw e;
    }

    try {
      await this.db.execute(
        `ALTER TABLE agent_registry ADD COLUMN loop_count INTEGER DEFAULT 0`
      );
      debugLog("[SqliteStorage] v5.3 migration: added loop_count column");
    } catch (e: any) {
      if (!e.message?.includes("duplicate column name")) throw e;
    }

    // ─── v5.5 Migration: Superposed Distributed Memory (SDM) ───
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS sdm_state (
        project TEXT PRIMARY KEY,
        counters BLOB NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // v6.5 Migration: Add address_version column if missing
    try {
      await this.db.execute(`ALTER TABLE sdm_state ADD COLUMN address_version INTEGER DEFAULT 1`);
    } catch (e: any) {
      if (!e.message?.includes("duplicate column name")) throw e;
    }

    // ─── v6.0 Migration: Associative Memory Graph ──────────────
    //
    // REVIEWER NOTE: memory_links implements a typed, weighted edge table
    // that turns the flat session_ledger into an associative graph.
    // See: memory_links_rfc.md (approved 2026-03-30, 2 rounds external review)
    //
    // KEY DESIGN:
    //   - Composite PK (source_id, target_id, link_type) prevents duplicate edges
    //   - Bidirectional: 'related_to' inserts dual rows (A→B + B→A)
    //   - Directed: 'temporal_next', 'spawned_from' use single rows
    //   - ON DELETE CASCADE: deleting a ledger entry auto-removes its links
    //   - Requires PRAGMA foreign_keys = ON (set in initialize())
    //   - 25-link cap enforced in application logic, NOT triggers
    //
    // STORAGE: ~100 bytes/link → 10MB per 100k links (laptop-safe)

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS memory_links (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        link_type TEXT NOT NULL,
        strength REAL DEFAULT 1.0 CHECK (strength >= 0.0 AND strength <= 1.0),
        metadata TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        last_traversed_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (source_id, target_id, link_type),
        FOREIGN KEY (source_id) REFERENCES session_ledger(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES session_ledger(id) ON DELETE CASCADE
      )
    `);

    // NOTE: idx_mem_links_source is intentionally OMITTED.
    // The composite PK (source_id, target_id, link_type) already provides
    // a covering index for source_id as the leading column.
    //
    // Reverse lookups: "who links TO this entry?"
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_mem_links_target ON memory_links(target_id)`
    );
    // Filter by link type (e.g., only temporal_next for chain traversal)
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_mem_links_type ON memory_links(link_type)`
    );
    // Decay queries: find links not traversed in N days
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_mem_links_traversed ON memory_links(last_traversed_at)`
    );
    // LRU compaction ordering optimization
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_session_ledger_last_accessed ON session_ledger(last_accessed_at)`
    );

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS hdc_dictionary (
        concept_name TEXT PRIMARY KEY,
        vector BLOB NOT NULL
      )
    `);

    // ─── Phase 4 Migration: Semantic Knowledge Table ──────────────
    //
    // REVIEWER NOTE: Created to separate timeless semantic facts from 
    // chronological episodic ledger events, per Phase 4 consolidation.
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS semantic_knowledge (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT '',
        concept TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        confidence REAL DEFAULT 0.5,
        instances INTEGER DEFAULT 1,
        related_entities TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // v7.8 Migration: Rename legacy columns if upgrading from older schema
    try {
      await this.db.execute(`ALTER TABLE semantic_knowledge RENAME COLUMN rule TO description`);
    } catch { /* column already renamed or doesn't exist */ }
    try {
      await this.db.execute(`ALTER TABLE semantic_knowledge ADD COLUMN instances INTEGER DEFAULT 1`);
    } catch { /* column already exists */ }
    try {
      await this.db.execute(`ALTER TABLE semantic_knowledge ADD COLUMN related_entities TEXT DEFAULT '[]'`);
    } catch { /* column already exists */ }
    try {
      await this.db.execute(`ALTER TABLE semantic_knowledge ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))`);
    } catch { /* column already exists */ }
    
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_semantic_project ON semantic_knowledge(project)`
    );


    // v6.5 Migration: Add prng_version column if missing
    try {
      await this.db.execute(`ALTER TABLE hdc_dictionary ADD COLUMN prng_version INTEGER DEFAULT 1`);
    } catch (e: any) {
      if (!e.message?.includes("duplicate column name")) throw e;
    }

    // ─── v7.0 Migration: ACT-R Memory Access Log ──────────────
    //
    // REVIEWER NOTE: This table drives the ACT-R base-level activation
    // formula: B_i = ln(Σ t_j^(-d)). Each row is a single "access" event
    // recorded fire-and-forget via AccessLogBuffer.
    //
    // DESIGN:
    //   - INTEGER PRIMARY KEY = SQLite implicit rowid (fastest inserts)
    //   - entry_id NOT NULL FK → session_ledger (ON DELETE CASCADE)
    //   - accessed_at TEXT ISO-8601 — enables julianday() math in queries
    //   - context_hash TEXT — optional search query fingerprint for
    //     future "what queries retrieve this memory?" analytics
    //
    // INDEXES:
    //   - (entry_id, accessed_at DESC): covers the window-function query
    //     used by getAccessLog(). DESC order makes recent-first scans
    //     sequential reads (no reverse B-tree traversal).
    //   - (accessed_at): covers the retention sweep in pruneAccessLog().
    //
    // STORAGE: ~80 bytes/row → 100K accesses ≈ 8 MB → laptop-safe.

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS memory_access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id TEXT NOT NULL,
        accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
        context_hash TEXT DEFAULT NULL,
        FOREIGN KEY (entry_id) REFERENCES session_ledger(id) ON DELETE CASCADE
      )
    `);

    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_access_log_entry_time
       ON memory_access_log(entry_id, accessed_at DESC)`
    );
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_access_log_time
       ON memory_access_log(accessed_at)`
    );

    // ─── v7.3 Migration: Dark Factory Pipelines ───────────────
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS dark_factory_pipelines (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'default',
        status TEXT NOT NULL,
        current_step TEXT NOT NULL,
        iteration INTEGER NOT NULL,
        eval_revisions INTEGER DEFAULT 0,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        spec TEXT NOT NULL,
        error TEXT,
        last_heartbeat TEXT,
        contract_payload TEXT,
        notes TEXT
      )
    `);

    // ─── v7.4.0 Migration: Adversarial Eval Revisions ─────────
    try {
      await this.db.execute(`ALTER TABLE dark_factory_pipelines ADD COLUMN eval_revisions INTEGER DEFAULT 0`);
      debugLog("[SqliteStorage] v7.4.0 migration: added eval_revisions column");
      // Backfill existing rows — ALTER TABLE DEFAULT only applies to new inserts;
      // rows that existed before the migration will have NULL until explicitly set.
      await this.db.execute(`UPDATE dark_factory_pipelines SET eval_revisions = 0 WHERE eval_revisions IS NULL`);
      debugLog("[SqliteStorage] v7.4.0 migration: backfilled eval_revisions = 0");
    } catch (e: any) {
      if (!e.message?.includes("duplicate column name")) throw e;
    }
    try {
      await this.db.execute(`ALTER TABLE dark_factory_pipelines ADD COLUMN contract_payload TEXT`);
      await this.db.execute(`ALTER TABLE dark_factory_pipelines ADD COLUMN notes TEXT`);
    } catch (e: any) {
      if (!e.message?.includes("duplicate column name")) throw e;
    }
    
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_pipelines_status ON dark_factory_pipelines(user_id, project, status)`
    );

    // ─── v7.2.0 Migration: Verification Harness ────────────────
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS verification_harnesses (
        rubric_hash TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        min_pass_rate REAL NOT NULL,
        tests TEXT NOT NULL,
        metadata TEXT,
        user_id TEXT NOT NULL DEFAULT 'default'
      )
    `);

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS verification_runs (
        id TEXT PRIMARY KEY,
        rubric_hash TEXT NOT NULL,
        project TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        run_at TEXT NOT NULL,
        passed INTEGER NOT NULL,
        pass_rate REAL NOT NULL,
        critical_failures INTEGER NOT NULL,
        coverage_score REAL NOT NULL,
        result_json TEXT NOT NULL,
        gate_action TEXT NOT NULL,
        gate_override INTEGER,
        override_reason TEXT,
        user_id TEXT NOT NULL DEFAULT 'default',
        FOREIGN KEY(rubric_hash) REFERENCES verification_harnesses(rubric_hash)
      )
    `);

    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_verification_runs_project ON verification_runs(project, run_at DESC)`
    );

    // ─── v7.3 Migration: Pipeline Orchestration Overrides ────────
    try {
      await this.db.execute(`ALTER TABLE verification_runs ADD COLUMN gate_override INTEGER`);
    } catch (e: any) {
      if (!e.message?.includes('duplicate column name')) console.warn('Migration warning:', e.message);
    }
    try {
      await this.db.execute(`ALTER TABLE verification_runs ADD COLUMN override_reason TEXT`);
    } catch (e: any) {
      if (!e.message?.includes('duplicate column name')) console.warn('Migration warning:', e.message);
    }

    // ─── H7 Migration: Tenant isolation for verification tables ────────
    try {
      await this.db.execute(`ALTER TABLE verification_harnesses ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'`);
    } catch (e: any) {
      if (!e.message?.includes('duplicate column name')) console.warn('Migration warning:', e.message);
    }
    try {
      await this.db.execute(`ALTER TABLE verification_runs ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'`);
    } catch (e: any) {
      if (!e.message?.includes('duplicate column name')) console.warn('Migration warning:', e.message);
    }
    // H7: Create index after the column exists (post-migration)
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_verification_runs_user ON verification_runs(user_id, project)`
    );

    // ─── v6.1 Migration: Integrity Check ──────────────────────
    //
    // REVIEWER NOTE: PRAGMA integrity_check scans the B-tree structure of
    // every table and index for corruption (missing pages, duplicate rows,
    // invalid records). Runtime is O(N) in database size — typically <1s
    // for a 50MB Prism DB. We run it once at startup and log the result;
    // we do NOT throw on failure to avoid blocking the MCP server on a
    // marginal but still-readable database.
    //
    // The check is non-blocking from the user's perspective because it
    // runs during server startup (before any tool calls are accepted).
    try {
      const integrityResult = await this.db.execute("PRAGMA integrity_check");
      const status = integrityResult.rows[0]?.["integrity_check"] ?? integrityResult.rows[0]?.[0];
      if (status !== "ok") {
        console.error(
          `[SqliteStorage] CRITICAL: PRAGMA integrity_check returned non-ok status: ${JSON.stringify(status)}. ` +
          `Consider running 'sqlite3 prism.db ".recover"' to attempt recovery.`
        );
      } else {
        debugLog("[SqliteStorage] v6.1: integrity_check passed ✓");
      }
    } catch (e) {
      // Non-fatal: some older libSQL versions may not support all integrity_check modes.
      debugLog(`[SqliteStorage] v6.1: integrity_check skipped (${(e as Error).message})`);
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
        if (value === "*") {
           select = "*";
           continue;
        }

        const VALID_COLUMNS = [
          'id', 'user_id', 'project', 'conversation_id', 'summary',
          'files_changed', 'todos', 'decisions', 'metrics', 'keywords',
          'session_date', 'schema_version', 'created_at', 'updated_at',
          'deleted_at', 'archived_at', 'is_rollup', 'rollup_type',
          'last_accessed_at', 'importance'
        ];
        
        const requestedColumns = value.split(',').map(c => c.trim());
        const isSafe = requestedColumns.every(c => VALID_COLUMNS.includes(c) || c === '*');
        
        if (!isSafe) {
          throw new Error('Invalid select column format: contains prohibited columns.');
        }

        select = value;
        continue;
      }
      if (key === "order") {
        const orderClauses = value.split(",").map(clause => {
          const parts = clause.split(".");
          const col = parts[0];
          // ── SQL Injection Guard ──────────────────────────────────────────
          if (!/^[a-zA-Z0-9_]+$/.test(col)) {
            throw new Error(`Invalid order column: "${col}". Only alphanumeric identifiers are allowed.`);
          }
          const dir = parts[1]?.toUpperCase() === "DESC" ? "DESC" : "ASC";
          const nulls = parts[2]?.toUpperCase() === "NULLSFIRST" ? "NULLS FIRST" : (parts[2]?.toUpperCase() === "NULLSLAST" ? "NULLS LAST" : "");
          return `${col} ${dir} ${nulls}`.trim();
        });
        order = `ORDER BY ${orderClauses.join(", ")}`;
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

  /**
   * A safe JSON.parse wrapper that never throws.
   * Used for parsing columns like `metadata` that may contain
   * user-supplied or migrated data that could be invalid JSON.
   *
   * @param text   - Raw string from a DB column. May be null/undefined.
   * @param fallback - Value returned when text is absent or unparseable.
   */
  private safeJsonParse<T = unknown>(text: string | null | undefined, fallback: T): T {
    if (!text) return fallback;
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      debugLog(`[SqliteStorage] safeJsonParse: invalid JSON in DB column — ${(e as Error).message}`);
      return fallback;
    }
  }

  /** Convert a SQLite row to a shape matching Supabase's response format.
   *  Only parses fields that exist in the raw row — respects SELECT projections
   *  so getLedgerEntries({ select: "id,project" }) doesn't fabricate empty arrays. */
  private rowToLedgerEntry(row: Record<string, unknown>): Record<string, unknown> {
    const result = { ...row };
    if ('todos' in row) result.todos = this.parseJsonColumn(row.todos);
    if ('files_changed' in row) result.files_changed = this.parseJsonColumn(row.files_changed);
    if ('decisions' in row) result.decisions = this.parseJsonColumn(row.decisions);
    if ('keywords' in row) result.keywords = this.parseJsonColumn(row.keywords);
    if ('is_rollup' in row) result.is_rollup = Boolean(row.is_rollup);
    return result;
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

    // ── v7.0 Rule #3: Creation = Access Seeding ─────────────────────
    // Seed the access log with a single event at creation time so that
    // brand-new entries have a non-empty access history. Without this,
    // new entries would have B_i = -∞ (ln(0)) and never surface in
    // ACT-R re-ranking until they're accessed at least once.
    //
    // Uses the buffer for consistency — the creation seed is batched
    // with other access events and flushed on the next cycle.
    if (this.accessLogBuffer) {
      this.accessLogBuffer.push(id, 'creation_seed');
    }

    // Return Supabase-compatible shape: handlers expect [{ id, ... }]
    return [{ id, project: entry.project, created_at: now }];
  }

  async patchLedger(id: string, data: Record<string, unknown>): Promise<void> {
    // ── Column Allowlist (Defense-in-Depth) ────────────────────────
    // Column names are interpolated directly into SQL (not parameterizable).
    // This allowlist prevents accidental or malicious injection via the key.
    // Currently, patchLedger is only called from internal handler code,
    // but this guard protects against future misuse if the method is
    // exposed to less-controlled callers.
    const ALLOWED_COLUMNS = new Set([
      'embedding', 'embedding_compressed', 'embedding_format', 'embedding_turbo_radius',
      'archived_at', 'deleted_at', 'deleted_reason', 'is_rollup', 'rollup_count',
      'importance', 'last_accessed_at', 'keywords', 'todos', 'files_changed', 'decisions',
      'summary', 'confidence_score', 'event_type', 'role',
    ]);

    const sets: string[] = [];
    const args: InValue[] = [];

    for (const [key, value] of Object.entries(data)) {
      if (!ALLOWED_COLUMNS.has(key)) {
        throw new Error(
          `[SqliteStorage] patchLedger: rejected unknown column "${key}". ` +
          `Allowed: ${[...ALLOWED_COLUMNS].join(', ')}`
        );
      }
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

  async getLedgerEntries(params: Record<string, any>): Promise<unknown[]> {
    const { ids, ...restParams } = params;
    const { where, args, select, order, limit } = this.parsePostgRESTFilters(restParams as Record<string, string>);

    let finalWhere = where;
    if (ids && Array.isArray(ids) && ids.length > 0) {
      const placeholders = ids.map(() => "?").join(", ");
      const inClause = `id IN (${placeholders})`;
      if (finalWhere) {
        finalWhere += ` AND ${inClause}`;
      } else {
        finalWhere = `WHERE ${inClause}`;
      }
      args.push(...ids);
    }

    // Build column list from select param
    const columns = select === "*" ? "*" : select;

    let sql = `SELECT ${columns} FROM session_ledger ${finalWhere}`;
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

  // ─── v9.2.4: Cross-Backend Reconciliation Helper ───────────
  //
  // Returns a Map of "project::role" → "updated_at" for all local handoffs.
  // Used by reconcileHandoffs() for lightweight timestamp comparison.
  // Single SELECT on session_handoffs — no joins, no ledger access.

  async getHandoffTimestamps(): Promise<Map<string, string>> {
    const result = await this.db.execute(
      `SELECT project, role, updated_at FROM session_handoffs`
    );
    const map = new Map<string, string>();
    for (const row of result.rows) {
      const project = row.project as string;
      const role = (row.role as string) || "global";
      const updatedAt = row.updated_at as string;
      if (updatedAt) {
        map.set(`${project}::${role}`, updatedAt);
      }
    }
    return map;
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

  async updateLastAccessed(ids: string[]): Promise<void> {
    if (!ids || ids.length === 0) return;
    const CHUNK_SIZE = 500;
    const now = new Date().toISOString(); // JS generates ISO-8601 with Z suffix

    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(", ");

      // Pass 'now' as the first argument, followed by the chunk IDs
      await this.db.execute({
        sql: `UPDATE session_ledger SET last_accessed_at = ? WHERE id IN (${placeholders})`,
        args: [now, ...chunk],
      });
    }
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

    // ─── v7.5.0: Validation Pulse (Standard & Deep) ─────────────
    context.recent_validations = []; // Default empty
    try {
      const validationResult = await this.db.execute({
        sql: `SELECT run_at, passed, pass_rate, gate_action, critical_failures
              FROM verification_runs
              WHERE project = ? AND user_id = ?
              ORDER BY run_at DESC
              LIMIT 3`,
        args: [project, userId],
      });

      if (validationResult.rows.length > 0) {
        context.recent_validations = validationResult.rows.map(r => ({
          run_at: r.run_at,
          passed: Boolean(r.passed),
          pass_rate: r.pass_rate,
          gate_action: r.gate_action,
          critical_failures: Number(r.critical_failures) || 0,
        }));
      }
    } catch (e) {
      // Graceful degradation if verification_runs table hasn't been migrated yet
    }

    if (level === "standard") {
      // Add recent ledger entries (role-scoped)
      const recentLedger = await this.db.execute({
        sql: `SELECT id, summary, decisions, session_date, created_at, importance, last_accessed_at
              FROM session_ledger
              WHERE project = ? AND user_id = ? AND role = ?
                AND archived_at IS NULL AND deleted_at IS NULL
              ORDER BY created_at DESC
              LIMIT 5`,
        args: [project, userId, effectiveRole],
      });

      context.recent_sessions = recentLedger.rows.map(r => ({
        id: r.id,
        summary: r.summary,
        decisions: this.parseJsonColumn(r.decisions),
        session_date: r.session_date || r.created_at,
        importance: r.importance,
        last_accessed_at: r.last_accessed_at,
        created_at: r.created_at,
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
      sql: `SELECT id, summary, decisions, files_changed, todos, session_date, created_at, importance, last_accessed_at
            FROM session_ledger
            WHERE project = ? AND user_id = ? AND role = ?
              AND archived_at IS NULL AND deleted_at IS NULL
            ORDER BY created_at DESC
            LIMIT 50`,
      args: [project, userId, effectiveRole],
    });

    context.session_history = fullLedger.rows.map(r => ({
      id: r.id,
      summary: r.summary,
      decisions: this.parseJsonColumn(r.decisions),
      files_changed: this.parseJsonColumn(r.files_changed),
      todos: this.parseJsonColumn(r.todos),
      session_date: r.session_date || r.created_at,
      importance: r.importance,
      last_accessed_at: r.last_accessed_at,
      created_at: r.created_at,
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
    activation?: SpreadingActivationOptions;
  }): Promise<KnowledgeSearchResult | null> {
    // Build FTS5 query from keywords + queryText (both contribute)
    // "stripe webhook auth" → '"stripe" OR "webhook" OR "auth"'
    const searchTerms = params.keywords
      .filter(k => k.length > 2)
      .map(k => `"${k.replace(/"/g, "")}"`)
      .join(" OR ");

    // Combine both sets — wrap queryText in quotes to sanitize FTS5 control
    // characters (*, ^, OR, NOT) that would crash the MATCH expression.
    const ftsParts: string[] = [];
    if (searchTerms) ftsParts.push(`(${searchTerms})`);
    if (params.queryText) {
      ftsParts.push(`"${params.queryText.replace(/"/g, "")}"`);
    }
    const ftsQuery = ftsParts.join(" OR ");
    if (!ftsQuery) return null;

    // Build query with optional project + role filters
    const conditions: string[] = [
      "ledger_fts MATCH ?",
      "l.user_id = ?",
      "l.archived_at IS NULL",
      "l.deleted_at IS NULL",
    ];
    const args: InValue[] = [ftsQuery, params.userId];

    if (params.project) {
      conditions.push("l.project = ?");
      args.push(params.project);
    }
    if (params.role) {
      conditions.push("l.role = ?");
      args.push(params.role);
    }

    args.push(params.limit);

    const sql = `
      SELECT l.id, l.project, l.summary, l.decisions, l.keywords,
             l.files_changed, l.session_date, l.created_at,
             l.importance, l.last_accessed_at,
             rank AS relevance
      FROM ledger_fts f
      JOIN session_ledger l ON f.rowid = l.rowid
      WHERE ${conditions.join(" AND ")}
      ORDER BY rank
      LIMIT ?
    `;

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
        created_at: r.created_at,
        importance: r.importance,
        last_accessed_at: r.last_accessed_at,
        relevance: r.relevance,
      }));

      if (params.activation?.enabled) {
        // Normalise FTS5 ranks (more negative = better) into positive 0-1 similarity score approximation
        const mappedAnchors = results.map(r => ({
          id: r.id as string,
          project: r.project as string,
          summary: r.summary as string,
          similarity: 1.0 / (1.0 + Math.abs((r.relevance as number) || 0)),
          session_date: r.session_date as string | undefined,
          decisions: r.decisions as string[] | undefined,
          files_changed: r.files_changed as string[] | undefined,
        }));
        
        const { applySpreadingActivation } = await import("../memory/spreadingActivation.js");
        const activated = await applySpreadingActivation(this.db, mappedAnchors, params.activation, params.userId);
        return { count: activated.length, results: activated };
      }

      return { count: results.length, results };
    } catch (err) {
      // FTS5 query syntax error — fall back to LIKE search
      console.error(`[SqliteStorage] FTS5 search failed, falling back to LIKE: ${err instanceof Error ? err.message : String(err)}`);
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
    role?: string | null;  // v6.0: role filter for Hivemind isolation
    activation?: SpreadingActivationOptions;
  }): Promise<KnowledgeSearchResult | null> {
    const conditions: string[] = ["user_id = ?", "archived_at IS NULL", "deleted_at IS NULL"];
    const args: InValue[] = [params.userId];

    if (params.project) {
      conditions.push("project = ?");
      args.push(params.project);
    }
    if (params.role) {
      conditions.push("role = ?");
      args.push(params.role);
    }

    // Add LIKE conditions for each keyword
    for (const kw of params.keywords) {
      if (kw.length > 2) {
        conditions.push("(summary LIKE ? OR keywords LIKE ? OR decisions LIKE ?)");
        const pattern = `%${kw}%`;
        args.push(pattern, pattern, pattern);
      }
    }

    // BUG FIX: queryText was previously ignored — if keywords were empty,
    // zero search filters were added, returning unfiltered top-N results.
    if (params.queryText) {
      conditions.push("(summary LIKE ? OR keywords LIKE ? OR decisions LIKE ?)");
      const pattern = `%${params.queryText}%`;
      args.push(pattern, pattern, pattern);
    }

    args.push(params.limit);

    const result = await this.db.execute({
      sql: `SELECT id, project, summary, decisions, keywords, files_changed, session_date, created_at, importance, last_accessed_at
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
      created_at: r.created_at,
      importance: r.importance,
      last_accessed_at: r.last_accessed_at,
    }));

    if (params.activation?.enabled) {
      // Base similarity mapped as 1.0 for LIKE exact/partial matches
      const mappedAnchors = results.map(r => ({
        id: r.id as string,
        project: r.project as string,
        summary: r.summary as string,
        similarity: 1.0,
        session_date: r.session_date as string | undefined,
        decisions: r.decisions as string[] | undefined,
        files_changed: r.files_changed as string[] | undefined,
      }));
      
      const { applySpreadingActivation } = await import("../memory/spreadingActivation.js");
      const activated = await applySpreadingActivation(this.db, mappedAnchors, params.activation, params.userId);
      return { count: activated.length, results: activated };
    }

    return { count: results.length, results };
  }

  async searchMemory(params: {
    queryEmbedding: string; // JSON-stringified number[]
    project?: string | null;
    limit: number;
    similarityThreshold: number;
    userId: string;
    role?: string | null;  // v3.0: optional role filter
    activation?: SpreadingActivationOptions; // v8.0 spreading activation
  }): Promise<SemanticSearchResult[]> {
    // ─── VECTOR SEARCH (cosine similarity via libSQL) ───
    // vector_distance_cos() returns distance (0 to 2).
    // Similarity = 1 - distance. Higher is better.
    try {
      const conditions: string[] = [
        "l.embedding IS NOT NULL",
        "l.user_id = ?",
        "l.archived_at IS NULL",
        "l.deleted_at IS NULL",
      ];
      const args: InValue[] = [params.queryEmbedding, params.userId];

      if (params.project) {
        conditions.push("l.project = ?");
        args.push(params.project);
      }
      if (params.role) {
        conditions.push("l.role = ?");
        args.push(params.role);
      }

      args.push(params.limit);

      const sql = `
        SELECT l.id, l.project, l.summary, l.decisions, l.files_changed,
               l.session_date, l.created_at, l.is_rollup, l.importance, l.last_accessed_at,
               (1 - vector_distance_cos(l.embedding, vector(?))) AS similarity
        FROM session_ledger l
        WHERE ${conditions.join(" AND ")}
        ORDER BY similarity DESC
        LIMIT ?
      `;

      const result = await this.db.execute({ sql, args });

      // Filter by similarity threshold and format results
      const baseResults = result.rows
        .filter(r => (r.similarity as number) >= params.similarityThreshold)
        .map(r => ({
          id: r.id as string,
          project: r.project as string,
          summary: r.summary as string,
          similarity: r.similarity as number,
          session_date: (r.session_date || r.created_at) as string,
          decisions: this.parseJsonColumn(r.decisions) as string[],
          files_changed: this.parseJsonColumn(r.files_changed) as string[],
          is_rollup: Boolean(r.is_rollup),
          importance: (r.importance as number) ?? 0,
          last_accessed_at: (r.last_accessed_at as string) || null,
        }));

      if (params.activation?.enabled) {
        const { applySpreadingActivation } = await import("../memory/spreadingActivation.js");
        return applySpreadingActivation(this.db, baseResults, params.activation, params.userId);
      }

      return baseResults;
    } catch (err) {
      // ─── TIER 2 FALLBACK: Asymmetric TurboQuant search in JS ───
      //
      // REVIEWER NOTE: THREE-TIER SEARCH ARCHITECTURE
      //
      //   Tier 1: Native vector search via libSQL's vector_distance_cos()
      //     - Uses the F32_BLOB `embedding` column with DiskANN index
      //     - FASTEST: O(log n) approximate nearest neighbor
      //     - Requires: libSQL ≥ 0.4.0 with sqlite-vec extension
      //
      //   Tier 2: TurboQuant asymmetric search in JavaScript
      //     - Fetches ALL compressed embeddings, scores each in JS
      //     - Uses asymmetricCosineSimilarity(float32_query, compressed_target)
      //     - O(n) linear scan, but n is typically < 10K entries
      //     - Activated when: Tier 1 throws (older libSQL, no F32_BLOB)
      //
      //   Tier 3: FTS5 keyword search (handled by searchKnowledge)
      //     - Pure text matching, no vectors needed
      //     - Last resort when both Tier 1 and Tier 2 fail
      //
      // WHY JS-SIDE SCORING (not SQLite UDF)?
      //   @libsql/client doesn't support custom user-defined functions.
      //   The TurboQuant math (matrix multiply, bit unpacking) requires
      //   Float64Array operations that can't be expressed in SQL.
      //   For typical Prism datasets (< 10K entries), linear scan
      //   completes in < 100ms — acceptable for a memory search.
      debugLog(
        `[SqliteStorage] Tier-1 vector search failed, trying Tier-2 TurboQuant fallback: ${err instanceof Error ? err.message : String(err)}`
      );

      try {
        const { getDefaultCompressor, deserialize } = await import("../utils/turboquant.js");
        const compressor = getDefaultCompressor();

        // Parse query embedding from JSON string
        const queryVec: number[] = JSON.parse(params.queryEmbedding);

        // Fetch all entries that have compressed embeddings
        const fallbackConditions: string[] = [
          "embedding_compressed IS NOT NULL",
          "user_id = ?",
          "archived_at IS NULL",
          "deleted_at IS NULL",
        ];
        const fallbackArgs: InValue[] = [params.userId];

        if (params.project) {
          fallbackConditions.push("project = ?");
          fallbackArgs.push(params.project);
        }
        if (params.role) {
          fallbackConditions.push("role = ?");
          fallbackArgs.push(params.role);
        }

        const fallbackSql = `
          SELECT id, project, summary, decisions, files_changed,
                 session_date, created_at, is_rollup, importance, last_accessed_at,
                 embedding_compressed, embedding_turbo_radius
          FROM session_ledger
          WHERE ${fallbackConditions.join(" AND ")}
        `;

        const fallbackResult = await this.db.execute({ sql: fallbackSql, args: fallbackArgs });

        // Score each entry using asymmetric cosine similarity
        // Track residualNorm for optional tiebreaker (v9.3)
        const { PRISM_TURBOQUANT_TIEBREAKER_EPSILON } = await import("../config.js");
        const eps = PRISM_TURBOQUANT_TIEBREAKER_EPSILON;
        const scored: (SemanticSearchResult & { _residualNorm?: number })[] = [];
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
                is_rollup: Boolean(row.is_rollup),
                importance: (row.importance as number) ?? 0,
                last_accessed_at: (row.last_accessed_at as string) || null,
                _residualNorm: eps > 0 ? compressed.residualNorm : undefined,
              });
            }
          } catch {
            // Skip entries with corrupt compressed data
          }
        }

        // Sort by similarity descending, with optional residualNorm tiebreaker
        // When ε > 0: candidates within ε of each other are ranked by lower
        // residualNorm (its compressed representation is more trustworthy).
        scored.sort((a, b) => {
          const diff = b.similarity - a.similarity;
          if (eps > 0 && Math.abs(diff) < eps && a._residualNorm != null && b._residualNorm != null) {
            return a._residualNorm - b._residualNorm;
          }
          return diff;
        });
        
        const baseResults = scored.slice(0, params.limit);
        // Strip internal tiebreaker field before returning
        for (const r of baseResults) delete (r as any)._residualNorm;
        debugLog(
          `[SqliteStorage] Tier-2 TurboQuant fallback: scored ${fallbackResult.rows.length} entries, ` +
          `${scored.length} above threshold`
        );

        if (params.activation?.enabled) {
          const { applySpreadingActivation } = await import("../memory/spreadingActivation.js");
          return applySpreadingActivation(this.db, baseResults, params.activation, params.userId);
        }

        return baseResults;
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

  // ─── v2.0 Dashboard ─────────────────────────────────────────────

  // ─── v5.4: CRDT Base State Retrieval ───────────────────────
  //
  // Reads a historical handoff snapshot by version number.
  // Used by the CRDT merge engine to reconstruct the base state
  // that both concurrent agents originally read.
  //
  // This leverages the EXISTING session_handoffs_history table
  // (created by Time Travel v2.0) — no schema changes needed.

  async getHandoffAtVersion(
    project: string,
    version: number,
    userId: string = "default"
  ): Promise<Record<string, unknown> | null> {
    const result = await this.db.execute({
      sql: `SELECT snapshot FROM session_handoffs_history
            WHERE project = ? AND user_id = ? AND version = ?
            LIMIT 1`,
      args: [project, userId, version],
    });

    if (result.rows.length === 0 || !result.rows[0].snapshot) return null;

    try {
      const snapshot = result.rows[0].snapshot;
      if (typeof snapshot === "string") return JSON.parse(snapshot) as Record<string, unknown>;
      return snapshot as unknown as Record<string, unknown>;
    } catch {
      console.error(`[SqliteStorage] Failed to parse history snapshot for ${project} v${version}`);
      return null;
    }
  }

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

    // ── v5.4: Aggregate CRDT merge counts from handoff metadata ───
    // Each successful CRDT merge increments metadata.crdt_merge_count.
    // We sum across all handoffs for the health report.
    const mergesResult = await this.db.execute({
      sql: `SELECT SUM(CAST(json_extract(metadata, '$.crdt_merge_count') AS INTEGER)) as total
            FROM session_handoffs WHERE user_id = ?`,
      args: [userId],
    });
    const totalCrdtMerges = Number(mergesResult.rows[0]?.total ?? 0);

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
      totalCrdtMerges,       // v5.4: total CRDT auto-merges
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
          (id, project, user_id, role, agent_name, status, current_task,
           task_start_time, expected_duration_minutes, task_hash, loop_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL, NULL, 0)`,
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
      // UNIQUE constraint → update existing — reset watchdog fields on re-registration
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE") || msg.includes("constraint")) {
        await this.db.execute({
          sql: `UPDATE agent_registry
            SET agent_name = ?, status = ?, current_task = ?,
                last_heartbeat = datetime('now'),
                task_start_time = datetime('now'),
                expected_duration_minutes = NULL,
                task_hash = NULL,
                loop_count = 0
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
    currentTask?: string,
    expectedDurationMinutes?: number
  ): Promise<void> {
    // v5.3: Loop detection — compute task hash and compare with stored value.
    // If the hash matches, increment loop_count. If different, reset counter.
    // This runs inline with the heartbeat UPDATE for zero additional queries.
    const newTaskHash = currentTask
      ? this._simpleHash(currentTask)
      : null;

    // Fetch current agent state for loop comparison (single SELECT)
    const current = await this.db.execute({
      sql: `SELECT task_hash, loop_count FROM agent_registry
        WHERE project = ? AND user_id = ? AND role = ?`,
      args: [project, userId, role],
    });

    const existingHash = current.rows[0]?.task_hash as string | null;
    const existingLoopCount = (current.rows[0]?.loop_count as number) || 0;

    // Determine if task changed
    const taskChanged = newTaskHash !== null && newTaskHash !== existingHash;
    const sameTask = newTaskHash !== null && newTaskHash === existingHash;

    const newLoopCount = sameTask
      ? existingLoopCount + 1
      : (taskChanged ? 0 : existingLoopCount);

    // Auto-detect LOOPING: if same task repeated >= 5 times, flag it
    const newStatus = newLoopCount >= 5 ? "looping" : "active";

    const setClauses = [
      "last_heartbeat = datetime('now')",
      "loop_count = ?",
      "status = ?",
    ];
    const args: InValue[] = [newLoopCount, newStatus];

    if (currentTask !== undefined) {
      setClauses.push("current_task = ?");
      args.push(currentTask);
    }

    if (newTaskHash !== null) {
      setClauses.push("task_hash = ?");
      args.push(newTaskHash);
    }

    // Task changed → reset task_start_time
    if (taskChanged) {
      setClauses.push("task_start_time = datetime('now')");
    }

    // Store expected duration if provided
    if (expectedDurationMinutes !== undefined) {
      setClauses.push("expected_duration_minutes = ?");
      args.push(expectedDurationMinutes);
    }

    args.push(project, userId, role);

    await this.db.execute({
      sql: `UPDATE agent_registry
        SET ${setClauses.join(", ")}
        WHERE project = ? AND user_id = ? AND role = ?`,
      args,
    });
  }

  /**
   * Simple string hash for loop detection.
   * Uses DJB2 — fast, deterministic, no crypto overhead.
   */
  private _simpleHash(str: string): string {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xFFFFFFFF;
    }
    return hash.toString(16);
  }

  async listTeam(
    project: string,
    userId: string,
    staleMinutes: number = 30
  ): Promise<AgentRegistryEntry[]> {
    // Auto-prune OFFLINE agents (>30min without heartbeat)
    await this.db.execute({
      sql: `DELETE FROM agent_registry
        WHERE project = ? AND user_id = ?
          AND last_heartbeat < datetime('now', '-' || ? || ' minutes')`,
      args: [project, userId, staleMinutes],
    });

    // Fetch remaining agents (including watchdog columns)
    const result = await this.db.execute({
      sql: `SELECT id, project, user_id, role, agent_name, status,
                   current_task, last_heartbeat, created_at,
                   task_start_time, expected_duration_minutes, task_hash, loop_count
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
      status: (r.status as AgentRegistryEntry["status"]),
      current_task: r.current_task as string | null,
      last_heartbeat: r.last_heartbeat as string,
      created_at: r.created_at as string,
      task_start_time: r.task_start_time as string | null,
      expected_duration_minutes: r.expected_duration_minutes as number | null,
      task_hash: r.task_hash as string | null,
      loop_count: (r.loop_count as number) || 0,
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

  // ─── v5.3: Hivemind Watchdog Methods ───────────────────────

  async getAllAgents(userId: string): Promise<AgentRegistryEntry[]> {
    const result = await this.db.execute({
      sql: `SELECT id, project, user_id, role, agent_name, status,
                   current_task, last_heartbeat, created_at,
                   task_start_time, expected_duration_minutes, task_hash, loop_count
            FROM agent_registry
            WHERE user_id = ?
            ORDER BY project, role`,
      args: [userId],
    });

    return result.rows.map(r => ({
      id: r.id as string,
      project: r.project as string,
      user_id: r.user_id as string,
      role: r.role as string,
      agent_name: r.agent_name as string | null,
      status: (r.status as AgentRegistryEntry["status"]),
      current_task: r.current_task as string | null,
      last_heartbeat: r.last_heartbeat as string,
      created_at: r.created_at as string,
      task_start_time: r.task_start_time as string | null,
      expected_duration_minutes: r.expected_duration_minutes as number | null,
      task_hash: r.task_hash as string | null,
      loop_count: (r.loop_count as number) || 0,
    }));
  }

  async updateAgentStatus(
    project: string, userId: string, role: string,
    status: AgentRegistryEntry["status"],
    additionalFields?: Record<string, unknown>
  ): Promise<void> {
    const setClauses = ["status = ?"];
    const args: InValue[] = [status];

    // Allow watchdog to set arbitrary safe fields (e.g., loop_count reset)
    const ALLOWED_FIELDS = new Set([
      "loop_count", "task_start_time", "expected_duration_minutes",
      "task_hash", "current_task",
    ]);
    if (additionalFields) {
      for (const [key, val] of Object.entries(additionalFields)) {
        if (ALLOWED_FIELDS.has(key)) {
          setClauses.push(`${key} = ?`);
          args.push(val as InValue);
        }
      }
    }

    args.push(project, userId, role);

    await this.db.execute({
      sql: `UPDATE agent_registry
        SET ${setClauses.join(", ")}
        WHERE project = ? AND user_id = ? AND role = ?`,
      args,
    });
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

  // ─── v5.1: Deep Storage Mode ("The Purge") ────────────────────
  //
  // WHAT THIS DOES:
  //   NULLs out bulky float32 `embedding` columns (3KB each) for entries
  //   that already have TurboQuant `embedding_compressed` blobs (~400B each).
  //   This reclaims ~90% of vector storage while maintaining Tier-2 search
  //   accuracy at 95%+ via asymmetric TurboQuant cosine estimation.
  //
  // WHY IT'S SAFE:
  //   1. Only purges entries where embedding_compressed IS NOT NULL (guard clause)
  //      — the compressed blob is the surviving search index
  //   2. Minimum age of 7 days enforced — recent entries keep full precision
  //      so Tier-1 native sqlite-vec search can still use them
  //   3. Skips soft-deleted entries (deleted_at IS NULL filter)
  //   4. Multi-tenant user_id guard prevents cross-user purges
  //   5. Dry-run mode lets users preview the impact before executing
  //
  // SQL STRATEGY:
  //   Two queries: one SELECT COUNT/SUM for preview stats, one conditional
  //   UPDATE SET embedding = NULL for the actual purge. Both queries use
  //   identical WHERE clauses built from the same conditions/args arrays.
  //
  // AFTER PURGE:
  //   - Tier-1 (sqlite-vec DiskANN): entries without float32 are invisible
  //     to native vector search — this is expected and harmless
  //   - Tier-2 (TurboQuant JS-side): unaffected — uses embedding_compressed
  //   - Tier-3 (FTS5 keyword): unaffected — uses text columns
  //
  // REVIEWER NOTE: We intentionally do NOT run VACUUM after purge.
  //   VACUUM rewrites the entire database file and can be very slow
  //   on large databases. Users who want to reclaim physical disk
  //   space can run VACUUM manually via SQLite CLI. The NULLed columns
  //   free up logical space that SQLite's b-tree allocator will reuse
  //   for future writes.

  async purgeHighPrecisionEmbeddings(params: {
    project?: string;
    olderThanDays: number;
    dryRun: boolean;
    userId: string;
  }): Promise<{ purged: number; eligible: number; reclaimedBytes: number }> {
    // ── Safety guard: prevent purging entries younger than 7 days ──
    // Entries younger than 7 days may still benefit from Tier-1 native
    // sqlite-vec search (which requires float32 embeddings). Purging them
    // would silently degrade search quality for active projects.
    if (params.olderThanDays < 7) {
      throw new Error(
        "olderThanDays must be at least 7 to prevent purging recent entries. " +
        "Entries younger than 7 days may still benefit from Tier-1 native vector search."
      );
    }

    // ── Build the WHERE clause dynamically ──
    // Each condition narrows the eligible set. The conditions array and args
    // array are kept in sync — condition[i] uses args[i] as its parameter.
    const conditions = [
      "embedding IS NOT NULL",           // only entries that actually have float32 vectors
      "embedding_compressed IS NOT NULL", // CRITICAL: only entries that have a TurboQuant fallback
      "deleted_at IS NULL",              // skip tombstoned entries
      `created_at < datetime('now', ?)`, // age filter using SQLite datetime modifier
    ];

    // SQLite datetime modifier syntax: '-30 days', '-7 days', etc.
    const args: any[] = [`-${params.olderThanDays} days`];

    // Multi-tenant guard: always scope to userId to prevent cross-user purges
    if (params.userId) {
      conditions.push("user_id = ?");
      args.push(params.userId);
    }

    // Optional project filter: when omitted, purge spans all projects
    if (params.project) {
      conditions.push("project = ?");
      args.push(params.project);
    }

    const whereClause = conditions.join(" AND ");

    // ── Step 1: Count eligible entries and estimate bytes to reclaim ──
    // SUM(LENGTH(embedding)) gives the exact byte count of the float32 blobs
    // that will be freed. This is the number shown to the user in the response.
    const countResult = await this.db.execute({
      sql: `SELECT COUNT(*) as eligible,
                   COALESCE(SUM(LENGTH(embedding)), 0) as bytes
            FROM session_ledger
            WHERE ${whereClause}`,
      args,
    });

    const eligible = Number(countResult.rows[0]?.eligible) || 0;
    const reclaimedBytes = Number(countResult.rows[0]?.bytes) || 0;

    // ── Dry run: return stats without modifying any data ──
    if (params.dryRun) {
      debugLog(
        `[SqliteStorage] purgeHighPrecisionEmbeddings DRY RUN: ` +
        `${eligible} eligible entries, ~${(reclaimedBytes / 1024 / 1024).toFixed(2)} MB reclaimable` +
        (params.project ? ` (project: ${params.project})` : " (all projects)")
      );
      return { purged: 0, eligible, reclaimedBytes };
    }

    // ── Step 2: Execute the purge — NULL out the float32 column ──
    // A single UPDATE is atomic — either all eligible entries are purged
    // or none are (in case of a database error). No partial state.
    if (eligible > 0) {
      await this.db.execute({
        sql: `UPDATE session_ledger
              SET embedding = NULL
              WHERE ${whereClause}`,
        args,
      });

      debugLog(
        `[SqliteStorage] purgeHighPrecisionEmbeddings: purged ${eligible} entries, ` +
        `reclaimed ~${(reclaimedBytes / 1024 / 1024).toFixed(2)} MB` +
        (params.project ? ` (project: ${params.project})` : " (all projects)")
      );
    }

    return { purged: eligible, eligible, reclaimedBytes };
  }

  // ─── v5.5: SDM Persistence ───────────────────────────────────

  async loadSdmState(project: string): Promise<Float32Array | null> {
    const result = await this.db.execute({
      sql: `SELECT counters, address_version FROM sdm_state WHERE project = ?`,
      args: [project],
    });

    if (result.rows.length === 0) {
      return null;
    }

    // Check address_version: if persisted state was generated with a different
    // PRNG algorithm, the hard-location addresses will mismatch. Reject stale state.
    const storedVersion = (result.rows[0].address_version as number) ?? 1;
    const { SDM_ADDRESS_VERSION } = await import('../sdm/sdmEngine.js');
    if (storedVersion !== SDM_ADDRESS_VERSION) {
      debugLog(`[SqliteStorage] SDM state version mismatch for ${project}: stored v${storedVersion}, current v${SDM_ADDRESS_VERSION}. Rebuilding.`);
      // Delete the stale row so it gets regenerated cleanly
      await this.db.execute({ sql: `DELETE FROM sdm_state WHERE project = ?`, args: [project] });
      return null;
    }

    const blob = result.rows[0].counters as any;
    // libSQL returns blobs as ArrayBuffer.
    // We instantiate a Float32Array directly over the buffer.
    if (blob instanceof ArrayBuffer) {
      return new Float32Array(blob);
    } else if (blob instanceof Uint8Array) {
      // In case it's returned as a Uint8Array view
      return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    } else {
      throw new Error(`[SqliteStorage] Unexpected blob type returned for SDM state`);
    }
  }

  async saveSdmState(project: string, state: Float32Array): Promise<void> {
    // The state is a Float32Array. We need its underlying buffer for SQLite.
    // Wrap in Uint8Array to satisfy @libsql/client InValue typing which rejects SharedArrayBuffer
    const buffer = new Uint8Array(state.buffer, state.byteOffset, state.byteLength);
    const { SDM_ADDRESS_VERSION } = await import('../sdm/sdmEngine.js');
    
    // We do an UPSERT (INSERT ... ON CONFLICT REPLACE).
    await this.db.execute({
      sql: `INSERT INTO sdm_state (project, counters, address_version, updated_at) 
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(project) DO UPDATE SET 
              counters = excluded.counters,
              address_version = excluded.address_version,
              updated_at = excluded.updated_at`,
      args: [project, buffer, SDM_ADDRESS_VERSION],
    });
    
    debugLog(`[SqliteStorage] Persisted SDM state v${SDM_ADDRESS_VERSION} to disk for project: ${project}`);
  }

  // ─── v6.5: HDC State Machines & Cognitive Logic ───────────────────────

  async getHdcConcept(concept: string): Promise<Uint32Array | null> {
    const result = await this.db.execute({
      sql: `SELECT vector FROM hdc_dictionary WHERE concept_name = ?`,
      args: [concept]
    });

    if (result.rows.length === 0) {
      return null;
    }

    const blob = result.rows[0].vector as any;
    // libSQL returns blobs as ArrayBuffer.
    // We instantiate a Uint32Array directly over the buffer.
    if (blob instanceof ArrayBuffer) {
      return new Uint32Array(blob);
    } else if (blob instanceof Uint8Array) {
      return new Uint32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    } else {
      throw new Error(`[SqliteStorage] Unexpected blob type returned for HDC vector`);
    }
  }

  async getAllHdcConcepts(): Promise<Array<{ concept: string; vector: Uint32Array }>> {
    const result = await this.db.execute(`SELECT concept_name, vector FROM hdc_dictionary`);
    return result.rows.map(row => {
      const blob = row.vector as any;
      let vec: Uint32Array;
      if (blob instanceof ArrayBuffer) {
        vec = new Uint32Array(blob);
      } else if (blob instanceof Uint8Array) {
        vec = new Uint32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
      } else {
        throw new Error(`[SqliteStorage] Unexpected blob type returned for HDC vector`);
      }
      return { concept: row.concept_name as string, vector: vec };
    });
  }

  async saveHdcConcept(concept: string, vector: Uint32Array): Promise<void> {
    // The vector is a Uint32Array. We need its underlying buffer for SQLite.
    // Wrap in Uint8Array to satisfy @libsql/client InValue typing which rejects SharedArrayBuffer
    const buffer = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
    const { SDM_ADDRESS_VERSION } = await import('../sdm/sdmEngine.js');
    
    await this.db.execute({
      sql: `INSERT INTO hdc_dictionary (concept_name, vector, prng_version) 
            VALUES (?, ?, ?)
            ON CONFLICT(concept_name) DO UPDATE SET 
              vector = excluded.vector,
              prng_version = excluded.prng_version`,
      args: [concept, buffer, SDM_ADDRESS_VERSION],
    });
    
    debugLog(`[SqliteStorage] Persisted HDC orthogonal concept v${SDM_ADDRESS_VERSION} to dictionary: ${concept}`);
  }

  // ─── v6.1: Storage Hygiene ────────────────────────────────────────────

  /**
   * Returns the current SQLite database file size in bytes using
   * SQLite's own page count/size pragmas (accurate, no filesystem stat needed).
   */
  private async getDatabaseSize(): Promise<number> {
    const result = await this.db.execute(
      `SELECT page_count * page_size AS size
       FROM pragma_page_count(), pragma_page_size()`
    );
    return Number(result.rows[0]?.size ?? 0);
  }

  /**
   * Reclaim disk space by running VACUUM on the SQLite database.
   *
   * REVIEWER NOTE (v6.1):
   * VACUUM rewrites the entire database file, reclaiming pages freed by
   * DELETE/UPDATE operations. It acquires an exclusive lock for the
   * duration — no other connections may read or write during VACUUM.
   * In Prism's single-process MCP model this is safe: the MCP server
   * handles one tool call at a time, so the lock is always available.
   *
   * Runtime: O(N) in database size (~1s per 100MB on an SSD).
   * Recommended: call after `deep_storage_purge` removes ≥1,000 entries.
   */
  async vacuumDatabase(opts: { dryRun: boolean }): Promise<{
    sizeBefore: number;
    sizeAfter: number;
    message: string;
  }> {
    const sizeBefore = await this.getDatabaseSize();

    if (!opts.dryRun) {
      debugLog("[SqliteStorage] Starting VACUUM — acquiring exclusive DB lock");
      try {
        await this.db.execute("VACUUM");
        debugLog("[SqliteStorage] VACUUM complete");
      } catch (err: any) {
        // SQLITE_BUSY (error code 5) means another connection holds the lock.
        // Surface a clear, retryable error instead of crashing.
        const isBusy = err.message?.includes('SQLITE_BUSY') ||
                       err.message?.includes('database is locked') ||
                       err.code === 5;
        if (isBusy) {
          throw new Error(
            '[SqliteStorage] VACUUM failed: database is locked by another connection. ' +
            'Retry after other operations complete. (SQLITE_BUSY)'
          );
        }
        throw err; // Re-throw non-lock errors
      }
    }

    const sizeAfter = await this.getDatabaseSize();
    const savedMb = ((sizeBefore - sizeAfter) / (1024 * 1024)).toFixed(2);

    return {
      sizeBefore,
      sizeAfter,
      message: opts.dryRun
        ? `Dry run: no changes made. Current database size: ${(sizeBefore / (1024 * 1024)).toFixed(2)} MB. ` +
          `Note: Large databases may take up to 60 seconds to vacuum.`
        : `VACUUM completed successfully. Reclaimed ${savedMb} MB. ` +
          `Note: Large databases may take up to 60 seconds to vacuum.`,
    };
  }

  async getAllProjectEmbeddings(project: string): Promise<Array<{ id: string, summary: string, embedding_compressed: string }>> {
    const res = await this.db.execute({
      sql: `SELECT id, summary, embedding_compressed FROM session_ledger
            WHERE project = ? AND deleted_at IS NULL AND embedding_compressed IS NOT NULL`,
      args: [project]
    });

    return res.rows.map(r => ({
      id: r.id as string,
      summary: r.summary as string,
      embedding_compressed: r.embedding_compressed as string
    }));
  }

  // ─── v6.0: Associative Memory Graph ─────────────────────────
  //
  // These methods implement the memory_links RFC (approved 2026-03-30).
  // All use @libsql/client's execute({ sql, args }) pattern.
  // Cap enforcement and reinforcement are designed to be called from
  // application logic (not triggers) per the RFC design decisions.

  async createLink(link: MemoryLink, _userId: string): Promise<void> {
    // INSERT OR IGNORE — idempotent on composite PK (source, target, type)
    // Strength is clamped by CHECK constraint (0.0–1.0) in schema.
    // Note: _userId accepted for interface parity with Supabase (which validates
    // tenant ownership via prism_create_link RPC). SQLite is single-tenant.
    await this.db.execute({
      sql: `INSERT OR IGNORE INTO memory_links
            (source_id, target_id, link_type, strength, metadata)
            VALUES (?, ?, ?, ?, ?)`,
      args: [
        link.source_id,
        link.target_id,
        link.link_type,
        Math.max(0.0, Math.min(link.strength ?? 1.0, 1.0)),
        link.metadata ?? null,
      ],
    });

    // Atomically enforce 25-link cap for auto-generated link types.
    // Manual/structural links (temporal_next, spawned_from) are exempt.
    if (link.link_type === 'related_to') {
      await this.pruneExcessLinks(link.source_id, 'related_to');
    }
  }

  async deleteLink(
    sourceId: string,
    targetId: string,
    linkType: MemoryLink['link_type'],
    _userId: string
  ): Promise<boolean> {
    const result = await this.db.execute({
      sql: `DELETE FROM memory_links
            WHERE source_id = ? AND target_id = ? AND link_type = ?`,
      args: [sourceId, targetId, linkType],
    });
    return (result.rowsAffected ?? 0) > 0;
  }

  async getLinksFrom(
    sourceId: string,
    userId: string,
    minStrength: number = 0.0,
    limit: number = 25
  ): Promise<MemoryLink[]> {
    // JOIN session_ledger to enforce:
    //   1. Tenant isolation (target.user_id = userId)
    //   2. GDPR tombstone filtering (target.deleted_at IS NULL)
    //   3. TTL/archive filtering (target.archived_at IS NULL)
    const result = await this.db.execute({
      sql: `SELECT m.source_id, m.target_id, m.link_type, m.strength, m.metadata,
                   m.created_at, m.last_traversed_at
            FROM memory_links m
            JOIN session_ledger target ON m.target_id = target.id
            WHERE m.source_id = ? AND m.strength >= ?
              AND target.user_id = ?
              AND target.deleted_at IS NULL
              AND (target.archived_at IS NULL OR m.link_type IN ('spawned_from', 'supersedes'))
            ORDER BY m.strength DESC, m.last_traversed_at DESC
            LIMIT ?`,
      args: [sourceId, minStrength, userId, limit],
    });

    return result.rows.map((r) => ({
      source_id: r.source_id as string,
      target_id: r.target_id as string,
      link_type: r.link_type as MemoryLink['link_type'],
      strength: r.strength as number,
      metadata: r.metadata as string | null,
      created_at: r.created_at as string,
      last_traversed_at: r.last_traversed_at as string,
    }));
  }

  async getLinksTo(
    targetId: string,
    userId: string,
    minStrength: number = 0.0,
    limit: number = 25
  ): Promise<MemoryLink[]> {
    // JOIN session_ledger to enforce tenant isolation + GDPR visibility
    // on the SOURCE side ("who links to me?" — verify the linker is visible)
    const result = await this.db.execute({
      sql: `SELECT m.source_id, m.target_id, m.link_type, m.strength, m.metadata,
                   m.created_at, m.last_traversed_at
            FROM memory_links m
            JOIN session_ledger source ON m.source_id = source.id
            WHERE m.target_id = ? AND m.strength >= ?
              AND source.user_id = ?
              AND source.deleted_at IS NULL
              AND (source.archived_at IS NULL OR m.link_type IN ('spawned_from', 'supersedes'))
            ORDER BY m.strength DESC, m.last_traversed_at DESC
            LIMIT ?`,
      args: [targetId, minStrength, userId, limit],
    });

    return result.rows.map((r) => ({
      source_id: r.source_id as string,
      target_id: r.target_id as string,
      link_type: r.link_type as MemoryLink['link_type'],
      strength: r.strength as number,
      metadata: r.metadata as string | null,
      created_at: r.created_at as string,
      last_traversed_at: r.last_traversed_at as string,
    }));
  }

  async countLinks(entryId: string, linkType?: string): Promise<number> {
    if (linkType) {
      const result = await this.db.execute({
        sql: `SELECT COUNT(*) as count FROM memory_links
              WHERE source_id = ? AND link_type = ?`,
        args: [entryId, linkType],
      });
      return Number(result.rows[0]?.count) || 0;
    } else {
      const result = await this.db.execute({
        sql: `SELECT COUNT(*) as count FROM memory_links
              WHERE source_id = ?`,
        args: [entryId],
      });
      return Number(result.rows[0]?.count) || 0;
    }
  }

  async pruneExcessLinks(
    entryId: string,
    linkType: string,
    maxLinks: number = 25
  ): Promise<void> {
    // Atomic cap enforcement: delete ALL links beyond the top N by strength.
    // Uses NOT IN subquery to keep the strongest links, eliminating TOCTOU
    // races that could occur with separate COUNT + DELETE operations.
    // Safe to call unconditionally — no-ops when count <= maxLinks.
    await this.db.execute({
      sql: `DELETE FROM memory_links
            WHERE source_id = ? AND link_type = ?
              AND rowid NOT IN (
                SELECT rowid FROM memory_links
                WHERE source_id = ? AND link_type = ?
                ORDER BY strength DESC, last_traversed_at DESC
                LIMIT ?
              )`,
      args: [entryId, linkType, entryId, linkType, maxLinks],
    });
  }

  async reinforceLink(
    sourceId: string,
    targetId: string,
    linkType: string
  ): Promise<void> {
    // Increment strength by +0.1, capped at 1.0 (enforced by CHECK constraint).
    // Update last_traversed_at to prevent decay from targeting active links.
    // This method is designed to be called fire-and-forget via setImmediate().
    await this.db.execute({
      sql: `UPDATE memory_links
            SET strength = MIN(strength + 0.1, 1.0),
                last_traversed_at = datetime('now')
            WHERE source_id = ? AND target_id = ? AND link_type = ?`,
      args: [sourceId, targetId, linkType],
    });
  }

  async decayLinks(olderThanDays: number): Promise<number> {
    // Reduce strength by -0.05 for non-structural associative links not traversed in N days.
    // Floor at 0.0 (enforced by CHECK constraint) — links at 0.0 are
    // effectively dead but preserved for provenance audit.
    // We only decay related_to heuristical links, not factual structural links.
    const result = await this.db.execute({
      sql: `UPDATE memory_links
            SET strength = MAX(strength - 0.05, 0.0)
            WHERE last_traversed_at < datetime('now', ?)
              AND link_type IN ('related_to')`,
      args: [`-${olderThanDays} days`],
    });
    return result.rowsAffected;
  }

  async summarizeWeakLinks(
    project: string,
    userId: string,
    minStrength: number,
    maxSourceEntries: number = 25,
    maxLinksPerSource: number = 25,
  ): Promise<{ sources_considered: number; links_scanned: number; links_soft_pruned: number }> {
    const entries = await this.db.execute({
      sql: `SELECT id
            FROM session_ledger
            WHERE project = ?
              AND user_id = ?
              AND deleted_at IS NULL
              AND archived_at IS NULL
            ORDER BY created_at DESC
            LIMIT ?`,
      args: [project, userId, maxSourceEntries],
    });

    let linksScanned = 0;
    let linksSoftPruned = 0;

    for (const row of entries.rows) {
      const sourceId = row.id as string;
      const links = await this.getLinksFrom(sourceId, userId, 0.0, maxLinksPerSource);
      linksScanned += links.length;
      linksSoftPruned += links.filter(l => l.strength < minStrength).length;
    }

    return {
      sources_considered: entries.rows.length,
      links_scanned: linksScanned,
      links_soft_pruned: linksSoftPruned,
    };
  }

  // ─── v6.0 Phase 3: Keyword Overlap Finder ──────────────────
  //
  // Pushes heavy intersection logic to the DB layer.
  // Strategy: CTE-first json_each explosion with hash join.
  //
  // 1. input_kw CTE: explodes the input keyword array into rows
  // 2. JOIN json_each(sl.keywords): explodes each entry's stored keywords
  // 3. HAVING COUNT: filters to entries with ≥ minSharedKeywords matches
  //
  // This is O(N * K) where N = number of entries and K = avg keywords per entry.
  // Much better than the O(N²) self-join alternative.

  async findKeywordOverlapEntries(
    excludeId: string,
    project: string,
    keywords: string[],
    userId: string,
    minSharedKeywords: number = 3,
    limit: number = 10,
  ): Promise<Array<{ id: string; shared_count: number }>> {
    // ── Short keyword allowlist ──────────────────────────────────────────
    // The length > 2 filter eliminates noise ("is", "to", "at") but also
    // accidentally drops valid technical identifiers like "C", "Go", "R",
    // "OS", "VM", etc. The allowlist exempts known short tech keywords so
    // that sessions tagged with "go" still create graph edges with others.
    const SHORT_KW_ALLOWLIST = new Set(["c", "go", "r", "os", "vm", "ui", "ai", "ml", "db", "ts", "js", "rx"]);
    const validKeywords = keywords.filter(k =>
      k && typeof k === 'string' &&
      (k.length > 2 || SHORT_KW_ALLOWLIST.has(k.toLowerCase()))
    );
    if (validKeywords.length === 0) return [];


    // Build the VALUES list for the input keywords CTE.
    // Each keyword becomes a row: VALUES ('kw1'), ('kw2'), ...
    // We use parameterized queries to avoid SQL injection.
    const placeholders = validKeywords.map(() => "(?)").join(", ");
    const args: (string | number)[] = [...validKeywords, userId, project, excludeId, minSharedKeywords, limit];

    const result = await this.db.execute({
      sql: `
        WITH input_kw(kw) AS (VALUES ${placeholders})
        SELECT sl.id, COUNT(DISTINCT ik.kw) AS shared_count
        FROM session_ledger sl,
             json_each(sl.keywords) AS je,
             input_kw ik
        WHERE sl.user_id = ?
          AND sl.project = ?
          AND sl.id != ?
          AND sl.deleted_at IS NULL
          AND sl.archived_at IS NULL
          AND je.value = ik.kw
        GROUP BY sl.id
        HAVING COUNT(DISTINCT ik.kw) >= ?
        ORDER BY shared_count DESC
        LIMIT ?
      `,
      args,
    });

    return result.rows.map((r) => ({
      id: r.id as string,
      shared_count: Number(r.shared_count),
    }));
  }

  async backfillLinks(
    project: string
  ): Promise<{ temporal: number; keyword: number; provenance: number }> {
    // ─── v6.0 Phase 3: Full Backfill Engine ──────────────────
    //
    // Retroactively creates graph edges for all existing entries.
    // Each strategy runs a single INSERT OR IGNORE SQL statement
    // for idempotency — safe to re-run multiple times.

    let temporal = 0;
    let keyword = 0;
    let provenance = 0;

    debugLog(`[SqliteStorage] backfillLinks starting for project: ${project}`);

    // ── Strategy 1: Temporal Chaining via LEAD() ──────────────
    //
    // Links consecutive entries within the same conversation using
    // the LEAD() window function. This replaces O(N²) self-joins
    // with O(N) window scans.
    //
    // SQL: For each entry partitioned by conversation_id, get the
    // "next" entry by created_at. Insert a temporal_next directed edge.
    try {
      const temporalResult = await this.db.execute({
        sql: `
          INSERT OR IGNORE INTO memory_links (source_id, target_id, link_type, strength, metadata)
          SELECT
            id AS source_id,
            next_id AS target_id,
            'temporal_next' AS link_type,
            1.0 AS strength,
            json_object('backfill', 'temporal', 'conversation_id', conversation_id) AS metadata
          FROM (
            SELECT
              id,
              conversation_id,
              LEAD(id) OVER (
                PARTITION BY conversation_id
                ORDER BY created_at ASC
              ) AS next_id
            FROM session_ledger
            WHERE project = ?
              AND deleted_at IS NULL
              AND conversation_id IS NOT NULL
              AND conversation_id != ''
          )
          WHERE next_id IS NOT NULL
        `,
        args: [project],
      });
      temporal = temporalResult.rowsAffected;
      debugLog(`[SqliteStorage] backfillLinks temporal: ${temporal} links created`);
    } catch (err) {
      debugLog(`[SqliteStorage] backfillLinks temporal strategy failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Strategy 2: Keyword Intersection via CTE + json_each ─
    //
    // Finds pairs of entries that share ≥ 3 keywords. Uses a CTE to
    // explode each entry's keywords JSON array into rows, then groups
    // by pair to count shared keywords.
    //
    // NOTE: This creates BIDIRECTIONAL links (A→B and B→A).
    // The WHERE a.id < b.id prevents duplicates in the same INSERT.
    try {
      const keywordResult = await this.db.execute({
        sql: `
          INSERT OR IGNORE INTO memory_links (source_id, target_id, link_type, strength, metadata)
          SELECT
            a_id AS source_id,
            b_id AS target_id,
            'related_to' AS link_type,
            MIN(0.3 + (shared_count * 0.1), 1.0) AS strength,
            json_object('backfill', 'keyword', 'shared_keywords', shared_count) AS metadata
          FROM (
            SELECT
              a.id AS a_id,
              b.id AS b_id,
              COUNT(DISTINCT ja.value) AS shared_count
            FROM session_ledger a
            JOIN json_each(a.keywords) AS ja
            JOIN session_ledger b ON b.project = ? AND b.deleted_at IS NULL AND b.archived_at IS NULL
            JOIN json_each(b.keywords) AS jb ON ja.value = jb.value
            WHERE a.project = ?
              AND a.deleted_at IS NULL
              AND a.archived_at IS NULL
              AND a.id < b.id
              AND a.keywords IS NOT NULL
              AND b.keywords IS NOT NULL
            GROUP BY a.id, b.id
            HAVING COUNT(DISTINCT ja.value) >= 3
          )
        `,
        args: [project, project],
      });
      // This creates A→B links. Now create reverse B→A links.
      const keywordReverseResult = await this.db.execute({
        sql: `
          INSERT OR IGNORE INTO memory_links (source_id, target_id, link_type, strength, metadata)
          SELECT
            b_id AS source_id,
            a_id AS target_id,
            'related_to' AS link_type,
            MIN(0.3 + (shared_count * 0.1), 1.0) AS strength,
            json_object('backfill', 'keyword_reverse', 'shared_keywords', shared_count) AS metadata
          FROM (
            SELECT
              a.id AS a_id,
              b.id AS b_id,
              COUNT(DISTINCT ja.value) AS shared_count
            FROM session_ledger a
            JOIN json_each(a.keywords) AS ja
            JOIN session_ledger b ON b.project = ? AND b.deleted_at IS NULL AND b.archived_at IS NULL
            JOIN json_each(b.keywords) AS jb ON ja.value = jb.value
            WHERE a.project = ?
              AND a.deleted_at IS NULL
              AND a.archived_at IS NULL
              AND a.id < b.id
              AND a.keywords IS NOT NULL
              AND b.keywords IS NOT NULL
            GROUP BY a.id, b.id
            HAVING COUNT(DISTINCT ja.value) >= 3
          )
        `,
        args: [project, project],
      });
      keyword = keywordResult.rowsAffected + keywordReverseResult.rowsAffected;
      debugLog(`[SqliteStorage] backfillLinks keyword: ${keyword} links created (${keywordResult.rowsAffected} forward + ${keywordReverseResult.rowsAffected} reverse)`);
    } catch (err) {
      debugLog(`[SqliteStorage] backfillLinks keyword strategy failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Strategy 3: Provenance (Rollup → Archived Originals) ──
    //
    // Links compaction rollup entries to the archived originals they
    // summarize. Uses temporal proximity: archived entries whose
    // archived_at timestamp is within 5 minutes of the rollup's
    // created_at are considered provenance targets.
    try {
      const provenanceResult = await this.db.execute({
        sql: `
          INSERT OR IGNORE INTO memory_links (source_id, target_id, link_type, strength, metadata)
          SELECT
            rollup.id AS source_id,
            archived.id AS target_id,
            'spawned_from' AS link_type,
            0.8 AS strength,
            json_object('backfill', 'provenance') AS metadata
          FROM session_ledger rollup
          JOIN session_ledger archived
            ON archived.project = rollup.project
            AND archived.archived_at IS NOT NULL
            AND archived.deleted_at IS NULL
            AND ABS(
              julianday(archived.archived_at) - julianday(rollup.created_at)
            ) < (5.0 / 1440.0)
          WHERE rollup.project = ?
            AND rollup.deleted_at IS NULL
            AND rollup.summary LIKE '%[ROLLUP]%'
        `,
        args: [project],
      });
      provenance = provenanceResult.rowsAffected;
      debugLog(`[SqliteStorage] backfillLinks provenance: ${provenance} links created`);
    } catch (err) {
      debugLog(`[SqliteStorage] backfillLinks provenance strategy failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    debugLog(
      `[SqliteStorage] backfillLinks complete for "${project}": ` +
      `temporal=${temporal}, keyword=${keyword}, provenance=${provenance}`
    );
    return { temporal, keyword, provenance };
  }

  // ─── v7.0: ACT-R Access Log Methods ────────────────────────────
  //
  // These three methods support the ACT-R base-level activation model.
  // Read the interface.ts docstrings for the full spec.

  /**
   * Record a memory access event (synchronous, fire-and-forget via buffer).
   * Rule #1: Write contention prevention.
   */
  logAccess(entryId: string, contextHash?: string): void {
    this.accessLogBuffer.push(entryId, contextHash);
  }

  /**
   * Batch-fetch access timestamps for multiple entries using window functions.
   * Rule #2: Prevents N+1 query explosion.
   *
   * SQL STRATEGY:
   *   Uses ROW_NUMBER() OVER (PARTITION BY entry_id ORDER BY accessed_at DESC)
   *   to rank accesses per entry, then filters to the top `maxPerEntry`.
   *   This converts N separate queries into 1 query with O(N*K) work
   *   where N = entries and K = max accesses per entry.
   *
   *   We use a CTE subquery pattern because SQLite doesn't support
   *   WHERE on a window function alias in the same SELECT scope.
   */
  async getAccessLog(
    entryIds: string[],
    maxPerEntry: number = 50
  ): Promise<Map<string, Date[]>> {
    const result = new Map<string, Date[]>();

    if (entryIds.length === 0) return result;

    // Build parameterized IN clause
    const placeholders = entryIds.map(() => "?").join(", ");

    const rows = await this.db.execute({
      sql: `
        WITH ranked AS (
          SELECT
            entry_id,
            accessed_at,
            ROW_NUMBER() OVER (
              PARTITION BY entry_id
              ORDER BY accessed_at DESC
            ) AS rn
          FROM memory_access_log
          WHERE entry_id IN (${placeholders})
        )
        SELECT entry_id, accessed_at
        FROM ranked
        WHERE rn <= ?
        ORDER BY entry_id, accessed_at DESC
      `,
      args: [...entryIds, maxPerEntry],
    });

    // Assemble the Map from flat rows
    for (const row of rows.rows) {
      const entryId = row.entry_id as string;
      const accessedAt = new Date(row.accessed_at as string);

      if (!result.has(entryId)) {
        result.set(entryId, []);
      }
      result.get(entryId)!.push(accessedAt);
    }

    return result;
  }

  /**
   * Prune access log entries older than N days.
   * Called by the sleep-cycle scheduler to bound table growth.
   */
  async pruneAccessLog(olderThanDays: number): Promise<number> {
    const result = await this.db.execute({
      sql: `DELETE FROM memory_access_log
            WHERE accessed_at < datetime('now', ?)`,
      args: [`-${olderThanDays} days`],
    });
    const pruned = result.rowsAffected;
    debugLog(`[SqliteStorage] pruneAccessLog: removed ${pruned} entries older than ${olderThanDays} days`);
    return pruned;
  }

  // ─── Dark Factory (v7.3) ───────────────────────────────────

  async savePipeline(state: PipelineState): Promise<void> {
    const now = new Date().toISOString();
    const updatedState = { ...state, updated_at: now };

    // Status Guard: prevent overwriting a terminated pipeline
    const existing = await this.getPipeline(state.id, state.user_id);
    if (existing) {
      if (existing.status === 'ABORTED' || existing.status === 'COMPLETED') {
        throw new Error(`Cannot update pipeline ${state.id} because it is already ${existing.status}.`);
      }
      // Validate state machine transition
      if (!SafetyController.validateTransition(existing.status as PipelineStatus, updatedState.status as PipelineStatus)) {
        throw new Error(
          `Illegal pipeline transition: ${existing.status} → ${updatedState.status} ` +
          `for pipeline ${state.id}. Legal transitions from ${existing.status}: ` +
          `${SafetyController.getLegalTransitions(existing.status as PipelineStatus).join(', ') || 'NONE (terminal)'}.`
        );
      }
    }

    await this.db.execute({
      sql: `
        INSERT INTO dark_factory_pipelines (id, project, user_id, status, current_step, iteration, eval_revisions, started_at, updated_at, spec, error, last_heartbeat, contract_payload, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          current_step = excluded.current_step,
          iteration = excluded.iteration,
          eval_revisions = excluded.eval_revisions,
          updated_at = excluded.updated_at,
          spec = excluded.spec,
          error = excluded.error,
          last_heartbeat = excluded.last_heartbeat,
          contract_payload = excluded.contract_payload,
          notes = excluded.notes
      `,
      args: [
        updatedState.id,
        updatedState.project,
        updatedState.user_id,
        updatedState.status,
        updatedState.current_step,
        updatedState.iteration,
        updatedState.eval_revisions ?? 0,
        updatedState.started_at,
        updatedState.updated_at,
        updatedState.spec,
        updatedState.error || null,
        updatedState.last_heartbeat || null,
        updatedState.contract_payload ? JSON.stringify(updatedState.contract_payload) : null,
        updatedState.notes || null
      ]
    });
  }

  async getPipeline(id: string, userId: string): Promise<PipelineState | null> {
    const result = await this.db.execute({
      sql: `SELECT * FROM dark_factory_pipelines WHERE id = ? AND user_id = ?`,
      args: [id, userId]
    });
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as any;
    return {
      ...row,
      contract_payload: row.contract_payload ? JSON.parse(row.contract_payload) : undefined
    } as PipelineState;
  }

  async listPipelines(project: string | undefined, status: PipelineStatus | undefined, userId: string): Promise<PipelineState[]> {
    const conditions: string[] = ['user_id = ?'];
    const args: any[] = [userId];
    
    if (project) {
      conditions.push('project = ?');
      args.push(project);
    }
    if (status) {
      conditions.push('status = ?');
      args.push(status);
    }
    
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM dark_factory_pipelines ${where} ORDER BY updated_at DESC`;
    
    const result = await this.db.execute({ sql, args });
    return result.rows.map((row: any) => ({
      ...row,
      contract_payload: row.contract_payload ? JSON.parse(row.contract_payload) : undefined
    })) as PipelineState[];
  }

  // ─── Verification Harness (v7.2.0) ───────────────────────────

  async saveVerificationHarness(harness: VerificationHarness, userId: string): Promise<void> {
    await this.db.execute({
      sql: `
        INSERT INTO verification_harnesses (rubric_hash, project, conversation_id, created_at, min_pass_rate, tests, metadata, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(rubric_hash) DO UPDATE SET
          metadata = excluded.metadata
      `,
      args: [
        harness.rubric_hash,
        harness.project,
        harness.conversation_id,
        harness.created_at,
        harness.min_pass_rate,
        JSON.stringify(harness.tests),
        harness.metadata ? JSON.stringify(harness.metadata) : null,
        userId
      ]
    });
  }

  async getVerificationHarness(rubric_hash: string, userId: string): Promise<VerificationHarness | null> {
    const result = await this.db.execute({
      sql: `SELECT * FROM verification_harnesses WHERE rubric_hash = ? AND user_id = ?`,
      args: [rubric_hash, userId]
    });

    if (result.rows.length === 0) return null;
    const row = result.rows[0] as any;
    return {
      ...row,
      tests: JSON.parse(row.tests),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    } as VerificationHarness;
  }

  async saveVerificationRun(result: ValidationResult, userId: string): Promise<void> {
    await this.db.execute({
      sql: `
        INSERT INTO verification_runs (
          id, rubric_hash, project, conversation_id, run_at, 
          passed, pass_rate, critical_failures, coverage_score, result_json, gate_action, gate_override, override_reason, user_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `,
      args: [
        result.id,
        result.rubric_hash,
        result.project,
        result.conversation_id,
        result.run_at,
        result.passed ? 1 : 0,
        result.pass_rate,
        result.critical_failures,
        result.coverage_score,
        result.result_json,
        result.gate_action,
        result.gate_override ? 1 : 0,
        result.override_reason || null,
        userId
      ]
    });
  }

  async listVerificationRuns(project: string, userId: string): Promise<ValidationResult[]> {
    const result = await this.db.execute({
      sql: `SELECT * FROM verification_runs WHERE project = ? AND user_id = ? ORDER BY run_at DESC`,
      args: [project, userId]
    });

    return result.rows.map(row => ({
      ...row,
      passed: Boolean(row.passed),
      gate_override: (row as any).gate_override === 1,
      override_reason: (row as any).override_reason || undefined
    })) as unknown as ValidationResult[];
  }

  async getVerificationRun(id: string, userId: string): Promise<ValidationResult | null> {
    const result = await this.db.execute({
      sql: `SELECT * FROM verification_runs WHERE id = ? AND user_id = ?`,
      args: [id, userId]
    });

    if (result.rows.length === 0) return null;
    const row = result.rows[0] as any;
    return {
      ...row,
      passed: Boolean(row.passed),
      gate_override: row.gate_override === 1,
      override_reason: row.override_reason || undefined
    } as ValidationResult;
  }

  // ─── v7.5: Semantic Consolidation ────────────────────────────────
  
  async upsertSemanticKnowledge(data: {
    project: string;
    concept: string;
    description: string;
    related_entities?: string[];
    userId?: string;
  }): Promise<string> {
    const existing = await this.db.execute({
      sql: `SELECT id, instances, confidence FROM semantic_knowledge WHERE project = ? AND concept = ? LIMIT 1`,
      args: [data.project, data.concept]
    });

    if (existing.rows.length > 0) {
      const row = existing.rows[0] as any;
      const newConfidence = Math.min(1.0, row.confidence + 0.1);
      
      await this.db.execute({
        sql: `UPDATE semantic_knowledge SET instances = instances + 1, confidence = ?, updated_at = ? WHERE id = ?`,
        args: [newConfidence, new Date().toISOString(), row.id]
      });
      return row.id;
    } else {
      const id = crypto.randomUUID();
      await this.db.execute({
        sql: `INSERT INTO semantic_knowledge (id, project, user_id, concept, description, confidence, instances, related_entities, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          data.project,
          data.userId || '',
          data.concept,
          data.description,
          0.5,
          1,
          JSON.stringify(data.related_entities || []),
          new Date().toISOString(),
          new Date().toISOString()
        ]
      });
      return id;
    }
  }

  // ─── v11.0: Research Task Bridge ──────────────────────────────

  async listPendingResearchTasks(): Promise<ResearchTask[]> {
    return []; // Only supported via Supabase bridge
  }

  async updateResearchTask(_id: string, _data: any): Promise<void> {
    // No-op
  }
}

