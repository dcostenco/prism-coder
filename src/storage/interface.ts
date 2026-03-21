/**
 * Storage Backend Interface (v2.0 — Step 1)
 *
 * This interface abstracts away all persistence operations so that
 * the session memory handlers (sessionMemoryHandlers.ts) never need
 * to know whether data is stored in Supabase (cloud) or SQLite (local).
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS:
 *   v1.5 coupled all memory operations directly to Supabase REST API
 *   calls. This made it impossible to run Prism without a Supabase
 *   account. v2.0 introduces a local SQLite mode, which requires
 *   this clean abstraction boundary.
 *
 * IMPLEMENTATION CONTRACT:
 *   - SupabaseStorage: wraps existing Supabase REST calls (Step 1)
 *   - SqliteStorage: local @libsql/client implementation (Step 2–3)
 *   - Both must pass the same integration tests
 * ═══════════════════════════════════════════════════════════════════
 */

// ─── Type Definitions ─────────────────────────────────────────

/**
 * A single immutable session log entry.
 * These are append-only — once created, they are never modified
 * (except for adding embeddings or archiving during compaction).
 */
export interface LedgerEntry {
  // Identity
  id?: string;
  project: string;
  conversation_id: string;
  user_id: string;

  // Content
  summary: string;
  todos?: string[];
  files_changed?: string[];
  decisions?: string[];
  keywords?: string[];

  // Embedding (generated async after save)
  embedding?: string; // JSON-stringified number[]

  // Compaction metadata
  is_rollup?: boolean;
  rollup_count?: number;
  archived_at?: string | null;

  // Timestamps
  created_at?: string;
  session_date?: string;
}

/**
 * Live handoff state for a project — upserted at session end.
 * The "running context" that gets loaded when a new session boots.
 */
export interface HandoffEntry {
  project: string;
  user_id: string;

  // Context
  last_summary?: string | null;
  pending_todo?: string[] | null;
  active_decisions?: string[] | null;
  keywords?: string[] | null;
  key_context?: string | null;
  active_branch?: string | null;

  // OCC
  version?: number;

  // Metadata (extensible for git drift, screenshots, etc.)
  metadata?: Record<string, unknown>;
}

/**
 * Result of a saveHandoff operation (OCC-aware).
 */
export interface SaveHandoffResult {
  status: "created" | "updated" | "conflict";
  version?: number;
  current_version?: number; // Only present on conflict
}

/**
 * Result of a loadContext operation (progressive loading).
 */
export type ContextResult = Record<string, unknown> | null;

/**
 * Result of a knowledge search operation.
 */
export interface KnowledgeSearchResult {
  count: number;
  results: unknown[];
}

/**
 * Result of a semantic search operation.
 */
export interface SemanticSearchResult {
  id: string;
  project: string;
  summary: string;
  similarity: number;
  session_date?: string;
  decisions?: string[];
  files_changed?: string[];
}

/**
 * A point-in-time snapshot of a handoff state (v2.0 — Time Travel).
 * Each successful saveHandoff creates one of these automatically.
 * Used by memory_history / memory_checkout to browse and restore past states.
 */
export interface HistorySnapshot {
  id: string;
  project: string;
  user_id: string;
  version: number;
  snapshot: HandoffEntry;
  branch: string;
  created_at: string;
}

// ─── v2.2.0: Health Check Types ──────────────────────────────

/**
 * Raw health statistics returned by the storage layer.
 *
 * The storage backend only runs simple aggregate queries —
 * all analysis logic (duplicate detection, severity scoring)
 * lives in healthCheck.ts to keep the DB layer agnostic.
 */
export interface HealthStats {
  // Count of active ledger entries with no embedding vector
  missingEmbeddings: number;

  // All active ledger entries (id + project + summary) — used
  // for in-memory duplicate detection via JS Jaccard similarity
  // (avoids Levenshtein SQL dependency that SQLite doesn't have)
  activeLedgerSummaries: Array<{ id: string; project: string; summary: string }>;

  // Projects that have handoff state but zero active ledger entries
  orphanedHandoffs: Array<{ project: string }>;

  // Rollup entries whose archived originals no longer exist
  staleRollups: number;

  // Total counts for the health report summary
  totalActiveEntries: number;
  totalHandoffs: number;
  totalRollups: number;
}

// ─── Storage Backend Interface ────────────────────────────────

/**
 * The core abstraction for all Prism memory operations.
 *
 * Both SupabaseStorage and SqliteStorage implement this interface.
 * The session memory handlers call these methods instead of making
 * direct Supabase REST API calls.
 */
export interface StorageBackend {
  // ─── Lifecycle ─────────────────────────────────────────────

  /** Initialize the storage backend (create tables, check connection, etc.) */
  initialize(): Promise<void>;

  /** Gracefully close the storage backend */
  close(): Promise<void>;

  // ─── Ledger Operations (Append-Only) ───────────────────────

  /**
   * Insert a new ledger entry. Returns the created entry (with id).
   * Embeddings are NOT generated here — they're handled separately.
   */
  saveLedger(entry: LedgerEntry): Promise<unknown>;

  /**
   * Patch a ledger entry (used for embedding backfill).
   * @param id - The UUID of the entry to patch
   * @param data - The fields to update (e.g., { embedding: "..." })
   */
  patchLedger(id: string, data: Record<string, unknown>): Promise<void>;

  /**
   * Read ledger entries matching filter criteria.
   * Used by compaction to find candidates and by backfill to find missing embeddings.
   */
  getLedgerEntries(params: Record<string, string>): Promise<unknown[]>;

  /**
   * Delete ledger entries matching filter criteria.
   * Used by knowledge_forget to prune old entries.
   */
  deleteLedger(params: Record<string, string>): Promise<unknown[]>;

  // ─── Handoff Operations (OCC-Controlled) ───────────────────

  /**
   * Upsert handoff state with optimistic concurrency control.
   * Returns status (created/updated/conflict) + new version.
   */
  saveHandoff(handoff: HandoffEntry, expectedVersion?: number | null): Promise<SaveHandoffResult>;

  /**
   * Delete handoff state for a project (used by knowledge_forget with clear_handoff).
   */
  deleteHandoff(project: string, userId: string): Promise<void>;

  /**
   * Load context for a project at the requested depth level.
   * Levels: "quick" | "standard" | "deep"
   */
  loadContext(project: string, level: string, userId: string): Promise<ContextResult>;

  // ─── Search Operations ─────────────────────────────────────

  /**
   * Search accumulated knowledge via keywords and full-text.
   */
  searchKnowledge(params: {
    project?: string | null;
    keywords: string[];
    category?: string | null;
    queryText?: string | null;
    limit: number;
    userId: string;
  }): Promise<KnowledgeSearchResult | null>;

  /**
   * Semantic search via embeddings (pgvector or sqlite-vec).
   * Falls back to keyword search if vectors are unavailable.
   */
  searchMemory(params: {
    queryEmbedding: string; // JSON-stringified number[]
    project?: string | null;
    limit: number;
    similarityThreshold: number;
    userId: string;
  }): Promise<SemanticSearchResult[]>;

  // ─── Compaction ────────────────────────────────────────────

  /**
   * Find projects that exceed the compaction threshold.
   */
  getCompactionCandidates(
    threshold: number,
    keepRecent: number,
    userId: string
  ): Promise<Array<{ project: string; total_entries: number; to_compact: number }>>;

  // ─── v2.0 Time Travel ──────────────────────────────────────

  /**
   * Save a snapshot of the current handoff state for time travel.
   * Called automatically after every successful saveHandoff.
   */
  saveHistorySnapshot(handoff: HandoffEntry, branch?: string): Promise<void>;

  /**
   * List version history for a project (newest first).
   * Used by memory_history tool.
   */
  getHistory(project: string, userId: string, limit?: number): Promise<HistorySnapshot[]>;

  // ─── v2.0 Dashboard ─────────────────────────────────────────

  /**
   * List all distinct projects that have handoff data.
   * Used by the Mind Palace Dashboard for project discovery.
   */
  listProjects(): Promise<string[]>;

  // ─── v2.2.0 Health Check (fsck) ─────────────────────────────

  /**
   * Gather raw health statistics for the integrity checker.
   * Returns aggregate counts + raw data for JS-side analysis.
   * The health check engine (healthCheck.ts) does all the
   * smart analysis — this just runs simple SQL queries.
   */
  getHealthStats(userId: string): Promise<HealthStats>;
}
