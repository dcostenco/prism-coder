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

  // ─── v3.0: Agent Hivemind — Role Identity ──────────────────
  // Which agent role created this entry. Defaults to 'global'
  // for backward compatibility with pre-v3.0 entries.
  role?: string; // 'global' | 'dev' | 'qa' | 'pm' | 'lead' | custom (defaults to 'global')

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

  // ─── v4.0: Active Behavioral Memory ───────────────────────────
  // Typed experience events that enable pattern detection and proactive warnings.
  // Evolves Prism from passive session logging to behavioral learning.
  event_type?: string;       // 'session' | 'correction' | 'success' | 'failure' | 'learning'
  confidence_score?: number; // 1-100 — agent's confidence in the outcome
  importance?: number;       // 0+ — upvote-driven importance scoring (for insight graduation)

  // ─── Phase 2: GDPR Soft Delete ───────────────────────────────
  // When deleted_at is set, the entry is "tombstoned" — hidden from
  // all search queries but still physically present for audit trails.
  // deleted_reason captures the GDPR Article 17 justification.
  deleted_at?: string | null;
  deleted_reason?: string | null;

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

  // ─── v3.0: Agent Hivemind — Role Identity ──────────────────
  // Role-scoped handoff state. Each role gets its own handoff
  // within a project. Defaults to 'global' for backward compat.
  role?: string; // 'global' | 'dev' | 'qa' | 'pm' | 'lead' | custom (defaults to 'global')

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

// ─── v3.0: Agent Registry Types ──────────────────────────────

/**
 * Tracks an active agent in the Hivemind coordination registry.
 * Agents register on startup, heartbeat periodically, and are
 * auto-pruned when stale (>30 min without heartbeat).
 */
export interface AgentRegistryEntry {
  id?: string;
  project: string;
  user_id: string;
  role: string;
  agent_name?: string | null;
  status: "active" | "idle" | "shutdown";
  current_task?: string | null;
  last_heartbeat?: string;
  created_at?: string;
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

  // ─── Phase 2: GDPR-Compliant Memory Deletion ────────────────
  //
  // These methods operate on INDIVIDUAL entries by ID (surgical).
  // This is intentionally different from deleteLedger() which uses
  // filter params for bulk operations.
  //
  // WHY TWO METHODS?
  //   softDeleteLedger → Sets deleted_at = NOW(). Entry stays in DB
  //     for audit trail. Search queries filter it out via
  //     "WHERE deleted_at IS NULL". Reversible.
  //   hardDeleteLedger → Physical DELETE. Irreversible. Use for
  //     GDPR "right to erasure" when audit trail must also go.

  /**
   * Soft-delete a ledger entry (tombstone).
   * Sets deleted_at = NOW() and deleted_reason = reason.
   * The entry remains in the database but is excluded from all searches.
   *
   * @param id - UUID of the ledger entry to soft-delete
   * @param userId - Owner verification (MUST match entry's user_id)
   * @param reason - GDPR Article 17 justification (optional but recommended)
   */
  softDeleteLedger(id: string, userId: string, reason?: string): Promise<void>;

  /**
   * Hard-delete a ledger entry (physical removal).
   * Permanently removes the row from the database. Irreversible.
   * Use only when GDPR Article 17 requires complete erasure.
   *
   * @param id - UUID of the ledger entry to physically delete
   * @param userId - Owner verification (MUST match entry's user_id)
   */
  hardDeleteLedger(id: string, userId: string): Promise<void>;

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
   * @param role - Optional agent role filter (defaults to 'global')
   */
  loadContext(project: string, level: string, userId: string, role?: string): Promise<ContextResult>;

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
    role?: string | null; // v3.0: filter by agent role
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
    role?: string | null; // v3.0: filter by agent role
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

  // ─── v3.0: Agent Registry Operations ──────────────────────────

  /**
   * Register an agent (upsert on project + user_id + role).
   * If already registered, updates agent_name, status, and current_task.
   */
  registerAgent(entry: AgentRegistryEntry): Promise<AgentRegistryEntry>;

  /**
   * Update heartbeat timestamp and optionally current_task.
   */
  heartbeatAgent(project: string, userId: string, role: string, currentTask?: string): Promise<void>;

  /**
   * List all agents on a project. Auto-prunes agents with
   * heartbeats older than staleMinutes (default 30).
   */
  listTeam(project: string, userId: string, staleMinutes?: number): Promise<AgentRegistryEntry[]>;

  /**
   * Remove an agent from the registry.
   */
  deregisterAgent(project: string, userId: string, role: string): Promise<void>;

  // ─── v3.0: Dashboard Settings (configStorage proxy) ──────────

  /**
   * Get a single dashboard setting by key.
   * Returns null if the key does not exist.
   */
  getSetting(key: string): Promise<string | null>;

  /**
   * Set (upsert) a dashboard setting.
   */
  setSetting(key: string, value: string): Promise<void>;

  /**
   * Retrieve all dashboard settings as a key→value map.
   */
  getAllSettings(): Promise<Record<string, string>>;

  // ─── v3.1: Memory Analytics ──────────────────────────────────

  /**
   * Return aggregate analytics for a project's memory usage.
   * Used by the Mind Palace Analytics dashboard card.
   */
  getAnalytics(project: string, userId: string): Promise<AnalyticsData>;

  // ─── v3.1: TTL / Automated Data Retention ────────────────────

  /**
   * Soft-delete ledger entries older than ttlDays for a project.
   * Skips rollup entries (is_rollup = true) — only expires raw sessions.
   * Returns count of expired entries.
   */
  expireByTTL(project: string, ttlDays: number, userId: string): Promise<{ expired: number }>;

  // ─── v4.0: Active Behavioral Memory ──────────────────────────

  /**
   * Adjust the importance score of a ledger entry.
   * Used by knowledge_upvote (+1) and knowledge_downvote (-1).
   * Importance is clamped to >= 0 (never goes negative).
   * Entries at importance >= 7 are considered "graduated" insights.
   *
   * @param id - UUID of the ledger entry
   * @param delta - Amount to adjust by (+1 or -1 typically)
   * @param userId - Owner verification (MUST match entry's user_id)
   */
  adjustImportance(id: string, delta: number, userId: string): Promise<void>;
}

// ─── v3.1 Types ────────────────────────────────────────────────

/**
 * Analytics data for a single project.
 * Returned by StorageBackend.getAnalytics().
 */
export interface AnalyticsData {
  /** Total active (non-archived, non-deleted) ledger entries */
  totalEntries: number;
  /** Total rollup/compaction entries */
  totalRollups: number;
  /** Estimated raw entries replaced by rollups (sum of rollup_count) */
  rollupSavings: number;
  /** Average character length of session summaries (proxy for token cost) */
  avgSummaryLength: number;
  /** Session count per day for the last 14 days */
  sessionsByDay: Array<{ date: string; count: number }>;
}
