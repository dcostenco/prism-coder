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

  // Embedding (generated async after save via Gemini text-embedding-004)
  embedding?: string; // JSON-stringified number[] — 768-dim float32 vector

  // ─── v5.0: TurboQuant Compressed Embedding ──────────────────
  //
  // REVIEWER NOTE: These fields implement DUAL-STORAGE for embeddings.
  // Both float32 (`embedding`) and compressed (`embedding_compressed`)
  // are stored simultaneously. This enables the three-tier search:
  //   Tier 1: Native sqlite-vec on F32_BLOB `embedding` (fastest)
  //   Tier 2: JS-side asymmetric search on compressed blobs (fallback)
  //   Tier 3: FTS5 text search via `searchKnowledge` (last resort)
  //
  // The compressed format uses TurboQuant (Google, ICLR 2026):
  //   - Lloyd-Max MSE quantization + QJL residual correction
  //   - 768 floats (3,072 bytes) → ~400 bytes (base64: ~535 chars)
  //   - Asymmetric search: query stays float32, targets are compressed
  //   - See: src/utils/turboquant.ts for the math core
  //
  embedding_compressed?: string;           // base64-encoded TurboQuant blob (~535 chars → ~400 bytes decoded)
  embedding_format?: 'turbo3' | 'turbo4' | 'float32';  // quantization bits: turbo3 = 304 bytes, turbo4 = 400 bytes
  embedding_turbo_radius?: number;         // original vector L2 norm — needed for cosine sim reconstruction

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
  last_accessed_at?: string | null;  // v5.2: Cognitive Memory — tracks last retrieval for importance decay
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
 * Agent health status for the Hivemind Watchdog (v5.3).
 *
 * State machine:
 *   ACTIVE  → STALE    (no heartbeat for staleThresholdMin)
 *   STALE   → FROZEN   (no heartbeat for frozenThresholdMin)
 *   FROZEN  → [pruned] (no heartbeat for offlineThresholdMin)
 *   ACTIVE  → OVERDUE  (task exceeded expected_duration_minutes)
 *   ACTIVE  → LOOPING  (same task_hash repeated ≥ loopThreshold times)
 */
export type AgentHealthStatus =
  | "active"
  | "idle"
  | "shutdown"
  | "stale"
  | "frozen"
  | "overdue"
  | "looping";

/**
 * Tracks an active agent in the Hivemind coordination registry.
 * Agents register on startup, heartbeat periodically, and are
 * auto-pruned when stale (>30 min without heartbeat).
 *
 * v5.3: Added watchdog fields for health monitoring —
 * task_start_time, expected_duration_minutes, task_hash, loop_count.
 */
export interface AgentRegistryEntry {
  id?: string;
  project: string;
  user_id: string;
  role: string;
  agent_name?: string | null;
  status: AgentHealthStatus;
  current_task?: string | null;
  last_heartbeat?: string;
  created_at?: string;
  // ─── v5.3: Watchdog Health Monitoring Fields ───
  /** When the current task started (ISO string). Set on task change. */
  task_start_time?: string | null;
  /** Expected task duration in minutes. Used by watchdog for OVERDUE detection. */
  expected_duration_minutes?: number | null;
  /** Hash of current_task string. Used for loop detection. */
  task_hash?: string | null;
  /** Number of consecutive heartbeats with the same task_hash. */
  loop_count?: number;
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

  // v5.4: CRDT auto-merge counter (aggregated from handoff metadata)
  totalCrdtMerges: number;
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
  updateLastAccessed(ids: string[]): Promise<void>;
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
  getLedgerEntries(params: Record<string, any>): Promise<unknown[]>;

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
   * Retrieve a historical handoff snapshot by version number.
   * Used by the CRDT merge engine to reconstruct the base state
   * that both agents originally read before their concurrent saves.
   *
   * @param project - Project identifier
   * @param version - The version number to retrieve (from history)
   * @param userId - User who owns the handoff (default: 'default')
   * @returns The snapshot at that version, or null if not found
   */
  getHandoffAtVersion(project: string, version: number, userId?: string): Promise<Record<string, unknown> | null>;

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
   * v5.3: Also accepts expected_duration_minutes for OVERDUE detection,
   * and performs loop detection (incrementing loop_count when task_hash repeats).
   */
  heartbeatAgent(
    project: string, userId: string, role: string,
    currentTask?: string, expectedDurationMinutes?: number
  ): Promise<void>;

  /**
   * List all agents on a project. Auto-prunes agents with
   * heartbeats older than staleMinutes (default 30).
   */
  listTeam(project: string, userId: string, staleMinutes?: number): Promise<AgentRegistryEntry[]>;

  /**
   * Remove an agent from the registry.
   */
  deregisterAgent(project: string, userId: string, role: string): Promise<void>;

  // ─── v5.3: Hivemind Watchdog Operations ───────────────────────

  /**
   * Get ALL registered agents across ALL projects for a user.
   * Used by the watchdog sweep to check health of every agent.
   */
  getAllAgents(userId: string): Promise<AgentRegistryEntry[]>;

  /**
   * Update an agent's status and optional additional fields.
   * Used by the watchdog sweep for state transitions (ACTIVE→STALE→FROZEN).
   */
  updateAgentStatus(
    project: string, userId: string, role: string,
    status: AgentHealthStatus, additionalFields?: Record<string, unknown>
  ): Promise<void>;

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

  /**
   * Fetch graduated insights for a project.
   * Returns ledger entries with importance >= minImportance (default 7),
   * excluding archived and soft-deleted entries.
   * Used by knowledge_sync_rules to sync insights into IDE rules files.
   *
   * @param project - Project identifier
   * @param userId - Owner verification
   * @param minImportance - Minimum importance threshold (default: 7)
   */
  getGraduatedInsights(project: string, userId: string, minImportance?: number): Promise<LedgerEntry[]>;

  /**
   * Decay importance scores for stale behavioral memory entries.
   * Entries older than decayDays whose importance > 0 are decremented by 1
   * (clamped at 0). Session-type entries are excluded — only behavioral
   * experience events (corrections, learnings, etc.) decay.
   *
   * Called fire-and-forget from session_save_ledger to achieve the same
   * automatic decay behavior as the SQLite health sweep, without requiring
   * a TTL retention policy to be configured.
   *
   * @param project  - Project identifier
   * @param userId   - Owner verification
   * @param decayDays - Entries older than this many days are eligible for decay
   */
  decayImportance(project: string, userId: string, decayDays: number): Promise<void>;

  // ─── v5.1: Deep Storage Mode ("The Purge") ────────────────────
  //
  // CONTEXT: v5.0 introduced TurboQuant, which stores a compressed 400-byte
  // representation (embedding_compressed) alongside the original 3KB float32
  // embedding. Once entries have compressed blobs AND are old enough, the
  // float32 column is pure redundancy — Tier-2 search uses compressed blobs
  // and achieves 95%+ accuracy.
  //
  // This method NULLs out the float32 embedding column for entries that:
  //   1. Already have embedding_compressed (never destroys the last copy)
  //   2. Are older than olderThanDays (safety: keeps recent data at full precision)
  //   3. Are not soft-deleted (no point purging tombstoned entries)
  //
  // PAYOFF: Reclaims ~90% of vector memory storage. A 10K-entry project
  // with 3KB/embedding uses ~30MB; after purge, only ~4MB of compressed
  // blobs remain.
  //
  // @param params.project      - Optional: limit purge to a single project
  // @param params.olderThanDays - Minimum age in days (≥7 enforced for safety)
  // @param params.dryRun       - Preview mode: count eligible but don't purge
  // @param params.userId       - Multi-tenant ownership guard
  // @returns purged count, eligible count, and estimated bytes reclaimed
  purgeHighPrecisionEmbeddings(params: {
    project?: string;
    olderThanDays: number;
    dryRun: boolean;
    userId: string;
  }): Promise<{ purged: number; eligible: number; reclaimedBytes: number }>;

  // ─── v5.5: SDM Persistence ───────────────────────────────────

  /**
   * Load the Superposed Distributed Memory (SDM) counter matrix into memory.
   * Called automatically by the SDMEngine during initialization.
   * If no state exists for the project, returns null.
   *
   * @param project - Project identifier
   */
  loadSdmState(project: string): Promise<Float32Array | null>;

  /**
   * Persist the SDM counter matrix to disk.
   * Called synchronously during background flushing or SIGINT/SIGTERM.
   *
   * @param project - Project identifier
   * @param state - The 10,000 x 768 element Float32Array
   */
  saveSdmState(project: string, state: Float32Array): Promise<void>;

  /**
   * Fetch all compressed embeddings for a project to enable fast JS-space Hamming scanning.
   * Returns id, summary, and the base64 encoded embedding_compressed BLOB.
   * @param project - Project identifier
   */
  getAllProjectEmbeddings(project: string): Promise<Array<{ id: string, summary: string, embedding_compressed: string }>>;

  // ─── v6.0: Memory Links (Associative Graph) ──────────────────
  //
  // Typed, weighted edges that turn the flat session_ledger into an
  // associative graph. See: memory_links_rfc.md (approved 2026-03-30)
  //
  // SECURITY: All read methods JOIN against session_ledger to enforce:
  //   1. Tenant isolation (user_id match)
  //   2. GDPR tombstone filtering (deleted_at IS NULL)
  //   3. TTL/archive filtering (archived_at IS NULL)

  /**
   * Create a link between two ledger entries.
   * Uses INSERT OR IGNORE (idempotent). After insert, atomically prunes
   * any related_to links beyond the 25-link cap.
   *
   * v6.2 (migration 035): Requires userId for tenant-aware validation.
   * Supabase routes through prism_create_link SECURITY DEFINER RPC.
   */
  createLink(link: MemoryLink, userId: string): Promise<void>;

  /**
   * Delete a link by composite key (source_id, target_id, link_type).
   * Validates tenant ownership of both endpoints before deletion.
   *
   * @param sourceId - Source entry UUID
   * @param targetId - Target entry UUID
   * @param linkType - Link type discriminator
   * @param userId   - Tenant identity for ownership validation
   * @returns true if a link was deleted, false if not found
   */
  deleteLink(
    sourceId: string,
    targetId: string,
    linkType: MemoryLink['link_type'],
    userId: string
  ): Promise<boolean>;

  /**
   * Get all outbound links from a source entry.
   * JOINs session_ledger to enforce tenant isolation and GDPR visibility.
   * Used for 1-hop expansion during search result enrichment.
   */
  getLinksFrom(sourceId: string, userId: string, minStrength?: number, limit?: number): Promise<MemoryLink[]>;

  /**
   * Get all inbound links pointing to a target entry.
   * JOINs session_ledger to enforce tenant isolation and GDPR visibility.
   * Used for reverse lookups: "who references this entry?"
   */
  getLinksTo(targetId: string, userId: string, minStrength?: number, limit?: number): Promise<MemoryLink[]>;

  /**
   * Count links from an entry, optionally filtered by type.
   */
  countLinks(entryId: string, linkType?: string): Promise<number>;

  /**
   * Atomically prune all links of a given type beyond the top 25 by strength.
   * Uses a single DELETE with NOT IN subquery — no TOCTOU race.
   */
  pruneExcessLinks(entryId: string, linkType: string, maxLinks?: number): Promise<void>;

  /**
   * Strengthen a link by +0.1 (capped at 1.0) and update last_traversed_at.
   * Called async (fire-and-forget via setImmediate) when a link is traversed
   * during search, so it never blocks the search response path.
   */
  reinforceLink(sourceId: string, targetId: string, linkType: string): Promise<void>;

  /**
   * Decay all links not traversed in the last N days by -0.1 (floor at 0.0).
   * Called by the sleep-cycle consolidation scheduler.
   * @returns Number of links decayed
   */
  decayLinks(olderThanDays: number): Promise<number>;

  /**
   * Summarize weak-link soft-pruning impact for a project without deleting links.
   * Used by scheduler observability to estimate how many links would be filtered
   * out by the active minStrength threshold.
   */
  summarizeWeakLinks(
    project: string,
    userId: string,
    minStrength: number,
    maxSourceEntries?: number,
    maxLinksPerSource?: number,
  ): Promise<{
    sources_considered: number;
    links_scanned: number;
    links_soft_pruned: number;
  }>;


  /**
   * Find existing ledger entries that share ≥ minSharedKeywords with the given keywords.
   * Used by the auto-linker to create `related_to` edges on save.
   *
   * Implementation pushes the intersection logic to the DB layer using
   * CTE-based json_each() explosion with hash joins — O(N) vs O(N²) cross-join.
   *
   * Results exclude the entry itself, archived entries, and deleted entries.
   *
   * @param excludeId       - Entry ID to exclude from results (self)
   * @param project         - Project scope
   * @param keywords        - Keywords from the new entry
   * @param userId          - Tenant ID for isolation
   * @param minSharedKeywords - Minimum shared keywords (default: 3)
   * @param limit           - Maximum results to return (default: 10)
   * @returns Array of matching entry IDs with their shared keyword counts
   */
  findKeywordOverlapEntries(
    excludeId: string,
    project: string,
    keywords: string[],
    userId: string,
    minSharedKeywords?: number,
    limit?: number,
  ): Promise<Array<{ id: string; shared_count: number }>>;

  /**
   * Retroactively create links for all existing entries in a project.
   * Three strategies: temporal chaining, keyword overlap, provenance.
   * Idempotent via INSERT OR IGNORE.
   * @returns Counts of links created per strategy
   */
  backfillLinks(project: string): Promise<{ temporal: number; keyword: number; provenance: number }>;

  // ─── v6.1: Storage Hygiene ────────────────────────────────────

  /**
   * Run VACUUM on the underlying database to reclaim disk space after
   * large purge operations. For SQLite, this rewrites the entire DB file.
   * For remote backends (Supabase), returns a guidance message.
   *
   * @param opts.dryRun - If true, reports current size without running VACUUM.
   * @returns sizeBefore, sizeAfter (bytes), and a human-readable message.
   */
  vacuumDatabase(opts: { dryRun: boolean }): Promise<{
    sizeBefore: number;
    sizeAfter: number;
    message: string;
  }>;

  // ─── v6.5: HDC State Machines & Cognitive Logic ────────────────

  /**
   * Retrieve a generated HDC orthogonal vector for a semantic concept.
   * If the concept doesn't exist, returns null.
   *
   * @param concept - The string identifier of the concept (e.g. 'Action:Read')
   */
  getHdcConcept(concept: string): Promise<Uint32Array | null>;

  /**
   * Retrieves all globally stored HDC concepts from the dictionary.
   */
  getAllHdcConcepts(): Promise<Array<{ concept: string; vector: Uint32Array }>>;

  /**
   * Persist a generated HDC orthogonal vector to the dictionary.
   *
   * @param concept - The string identifier of the concept.
   * @param vector - The 768-word Uint32Array representing the concept.
   */
  saveHdcConcept(concept: string, vector: Uint32Array): Promise<void>;

  // ─── v7.0: ACT-R Access Log (Activation Memory) ────────────────
  //
  // These methods support the ACT-R base-level activation model.
  // Every memory retrieval logs an access event. The access log enables
  // B_i = ln(Σ t_j^(-d)) — combining recency and frequency into a
  // single activation score.

  /**
   * Record a memory access event. Delegates to an in-memory buffer
   * (AccessLogBuffer) that flushes periodically — callers pay zero
   * async overhead. This is intentionally SYNCHRONOUS (fire-and-forget).
   *
   * Rule #1: Write contention prevention via batched inserts.
   *
   * @param entryId - The session_ledger entry that was accessed/retrieved
   * @param contextHash - Optional hash of the search query context
   */
  logAccess(entryId: string, contextHash?: string): void;

  /**
   * Batch-fetch access timestamps for multiple entries in a single query.
   * Uses SQL window functions: ROW_NUMBER() OVER (PARTITION BY entry_id
   * ORDER BY accessed_at DESC) to limit per-entry results efficiently.
   *
   * Rule #2: Prevents N+1 query explosion on batch fetches.
   *
   * @param entryIds - Array of entry IDs to fetch access logs for
   * @param maxPerEntry - Maximum timestamps per entry (default: 50)
   * @returns Map from entryId → array of Date objects (most-recent first)
   */
  getAccessLog(
    entryIds: string[],
    maxPerEntry?: number
  ): Promise<Map<string, Date[]>>;

  /**
   * Prune access log entries older than N days.
   * Called by the sleep-cycle scheduler to keep the access log bounded.
   *
   * @param olderThanDays - Delete entries older than this many days
   * @returns Number of rows pruned
   */
  pruneAccessLog(olderThanDays: number): Promise<number>;
}

// ─── v6.0: Memory Link Type ───────────────────────────────────

/**
 * A typed, weighted edge between two session_ledger entries.
 * Forms the associative graph layer over the flat ledger.
 *
 * Link types:
 *   - related_to:       Topical similarity (bidirectional, dual-row)
 *   - temporal_next:    Sequential ordering within a conversation (directed)
 *   - spawned_from:     Compaction provenance — rollup → archived originals (directed)
 *   - synthesized_from: Insight derived from multiple entries (directed)
 *   - supersedes:       Newer entry replaces older (directed)
 *   - depends_on:       Prerequisite relationship (directed)
 */
export interface MemoryLink {
  source_id: string;
  target_id: string;
  link_type: 'related_to' | 'temporal_next' | 'spawned_from' | 'synthesized_from' | 'supersedes' | 'depends_on';
  strength: number;
  metadata?: string | null;       // JSON-stringified optional context
  created_at?: string;
  last_traversed_at?: string;
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
