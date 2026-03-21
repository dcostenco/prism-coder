/**
 * Supabase Storage Backend (v2.0 — Step 1)
 *
 * This class wraps the existing Supabase REST API calls behind
 * the StorageBackend interface. It contains ZERO new logic —
 * everything here was extracted from sessionMemoryHandlers.ts
 * and compactionHandler.ts.
 *
 * ═══════════════════════════════════════════════════════════════════
 * REVIEWER NOTE: This is a PURE REFACTOR. Every method maps 1:1 to
 * an existing call in v1.5.1. If behavior changes are detected,
 * that's a bug — file an issue.
 * ═══════════════════════════════════════════════════════════════════
 */

import {
  supabasePost,
  supabaseGet,
  supabaseRpc,
  supabasePatch,
  supabaseDelete,
} from "../utils/supabaseApi.js";

import type {
  StorageBackend,
  LedgerEntry,
  HandoffEntry,
  SaveHandoffResult,
  ContextResult,
  KnowledgeSearchResult,
  SemanticSearchResult,
  HistorySnapshot,
  HealthStats,        // v2.2.0: Health check (fsck) aggregate type
} from "./interface.js";

export class SupabaseStorage implements StorageBackend {
  // ─── Lifecycle ─────────────────────────────────────────────

  async initialize(): Promise<void> {
    // Supabase is always ready — connection is stateless (REST API).
    // The SUPABASE_URL and SUPABASE_KEY are validated at import time
    // by supabaseApi.ts's guard clause.
    console.error("[SupabaseStorage] Initialized (REST API, stateless)");
  }

  async close(): Promise<void> {
    // No-op for Supabase — connections are stateless.
    console.error("[SupabaseStorage] Closed (no-op for REST)");
  }

  // ─── Ledger Operations ─────────────────────────────────────

  async saveLedger(entry: LedgerEntry): Promise<unknown> {
    // Direct mapping from sessionSaveLedgerHandler line 95
    const record = {
      project: entry.project,
      conversation_id: entry.conversation_id,
      summary: entry.summary,
      user_id: entry.user_id,
      todos: entry.todos || [],
      files_changed: entry.files_changed || [],
      decisions: entry.decisions || [],
      keywords: entry.keywords || [],
      ...(entry.is_rollup !== undefined && { is_rollup: entry.is_rollup }),
      ...(entry.rollup_count !== undefined && { rollup_count: entry.rollup_count }),
      // Compaction handler also sets title, agent_name for rollup entries
      ...(entry.is_rollup && {
        title: `Session Rollup (${entry.rollup_count || 0} entries)`,
        agent_name: "prism-compactor",
      }),
    };

    return supabasePost("session_ledger", record);
  }

  async patchLedger(id: string, data: Record<string, unknown>): Promise<void> {
    // Direct mapping from sessionSaveLedgerHandler line 115 (embedding patch)
    // and compactionHandler line 292 (archive patch)
    await supabasePatch("session_ledger", data, { id: `eq.${id}` });
  }

  async getLedgerEntries(params: Record<string, string>): Promise<unknown[]> {
    // Direct mapping from:
    //   - compactionHandler line 143 (count entries for project)
    //   - compactionHandler line 211 (fetch oldest entries)
    //   - backfillEmbeddingsHandler line 700 (find missing embeddings)
    //   - knowledgeForgetHandler line 479 (dry run count)
    const result = await supabaseGet("session_ledger", params);
    return Array.isArray(result) ? result : [];
  }

  async deleteLedger(params: Record<string, string>): Promise<unknown[]> {
    // Direct mapping from knowledgeForgetHandler line 482
    const result = await supabaseDelete("session_ledger", params);
    return Array.isArray(result) ? result : [];
  }

  // ─── Handoff Operations ────────────────────────────────────

  async saveHandoff(
    handoff: HandoffEntry,
    expectedVersion?: number | null
  ): Promise<SaveHandoffResult> {
    // Direct mapping from sessionSaveHandoffHandler line 214
    // Calls the save_handoff_with_version RPC for OCC
    const result = await supabaseRpc("save_handoff_with_version", {
      p_project: handoff.project,
      p_expected_version: expectedVersion ?? null,
      p_last_summary: handoff.last_summary ?? null,
      p_pending_todo: handoff.pending_todo ?? null,
      p_active_decisions: handoff.active_decisions ?? null,
      p_keywords: handoff.keywords ?? null,
      p_key_context: handoff.key_context ?? null,
      p_active_branch: handoff.active_branch ?? null,
      p_user_id: handoff.user_id,
    });

    const data = Array.isArray(result) ? result[0] : result;

    if (data?.status === "conflict") {
      return {
        status: "conflict",
        current_version: data.current_version,
      };
    }

    return {
      status: data?.status || "updated",
      version: data?.version,
    };
  }

  async deleteHandoff(project: string, userId: string): Promise<void> {
    // Direct mapping from knowledgeForgetHandler line 486
    await supabaseDelete("session_handoffs", {
      project: `eq.${project}`,
      user_id: `eq.${userId}`,
    });
  }

  async loadContext(
    project: string,
    level: string,
    userId: string
  ): Promise<ContextResult> {
    // Direct mapping from sessionLoadContextHandler line 330
    const result = await supabaseRpc("get_session_context", {
      p_project: project,
      p_level: level,
      p_user_id: userId,
    });

    const data = Array.isArray(result) ? result[0] : result;
    return (data as ContextResult) ?? null;
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
    // Direct mapping from knowledgeSearchHandler line 388
    const result = await supabaseRpc("search_knowledge", {
      p_project: params.project || null,
      p_keywords: params.keywords,
      p_category: params.category || null,
      p_query_text: params.queryText || null,
      p_limit: Math.min(params.limit, 50),
      p_user_id: params.userId,
    });

    const data = Array.isArray(result) ? result[0] : result;

    if (!data || !data.results || data.count === 0) {
      return null;
    }

    return data as KnowledgeSearchResult;
  }

  async searchMemory(params: {
    queryEmbedding: string;
    project?: string | null;
    limit: number;
    similarityThreshold: number;
    userId: string;
  }): Promise<SemanticSearchResult[]> {
    // Direct mapping from sessionSearchMemoryHandler line 583
    const result = await supabaseRpc("semantic_search_ledger", {
      p_query_embedding: params.queryEmbedding,
      p_project: params.project || null,
      p_limit: Math.min(params.limit, 20),
      p_similarity_threshold: params.similarityThreshold,
      p_user_id: params.userId,
    });

    return Array.isArray(result) ? result as SemanticSearchResult[] : [];
  }

  // ─── Compaction ────────────────────────────────────────────

  async getCompactionCandidates(
    threshold: number,
    keepRecent: number,
    userId: string
  ): Promise<Array<{ project: string; total_entries: number; to_compact: number }>> {
    // Direct mapping from compactionHandler line 165
    const result = await supabaseRpc("get_compaction_candidates", {
      p_threshold: threshold,
      p_keep_recent: keepRecent,
      p_user_id: userId,
    });

    return Array.isArray(result) ? result : [];
  }

  // ─── Time Travel ──────────────────────────────────────────

  async saveHistorySnapshot(handoff: HandoffEntry, branch: string = "main"): Promise<void> {
    await supabasePost("session_handoffs_history", {
      project: handoff.project,
      user_id: handoff.user_id,
      version: handoff.version ?? 1,
      snapshot: handoff,
      branch,
    });
  }

  async getHistory(
    project: string,
    userId: string,
    limit: number = 10
  ): Promise<HistorySnapshot[]> {
    const data = await supabaseGet("session_handoffs_history", {
      project: `eq.${project}`,
      user_id: `eq.${userId}`,
      order: "version.desc",
      limit: String(limit),
    });
    return (Array.isArray(data) ? data : []) as HistorySnapshot[];
  }

  // ─── v2.0 Dashboard ─────────────────────────────────────────

  async listProjects(): Promise<string[]> {
    const data = await supabaseGet("session_handoffs", {
      select: "project",
      order: "project.asc",
    });
    const rows = Array.isArray(data) ? data : [];
    // Deduplicate on the client side since Supabase doesn't support DISTINCT via REST
    return [...new Set(rows.map((r: any) => r.project as string))];
  }

  // ─── v2.2.0 Health Check (fsck) ─────────────────────────────

  /**
   * Gather raw health statistics via Supabase REST API.
   *
   * Supabase REST (PostgREST) doesn't support complex JOINs,
   * so we fetch raw data and let healthCheck.ts do the analysis
   * in pure JS — same approach as SQLite for consistency.
   */
  async getHealthStats(userId: string): Promise<HealthStats> {

    // ── Check 1: Entries missing embeddings ────────────────────
    // Fetch active entries where embedding column is null.
    // PostgREST filter: archived_at=is.null AND embedding=is.null
    const missingData = await supabaseGet("session_ledger", {
      select: "id",                    // only need count
      user_id: `eq.${userId}`,          // scope to this user
      archived_at: "is.null",           // only active entries
      embedding: "is.null",             // missing embedding
    });
    // Count the returned rows (PostgREST returns array)
    const missingEmbeddings = Array.isArray(missingData) ? missingData.length : 0;

    // ── Check 2: All active summaries for JS duplicate detection ─
    // Pull id + project + summary so healthCheck.ts can run
    // Jaccard similarity comparison in-memory.
    const summData = await supabaseGet("session_ledger", {
      select: "id,project,summary",     // minimal columns needed
      user_id: `eq.${userId}`,          // scope to this user
      archived_at: "is.null",           // only active entries
    });
    // Map to typed array for the health check engine
    const activeLedgerSummaries = (Array.isArray(summData) ? summData : []).map(
      (r: any) => ({
        id: r.id as string,             // unique entry ID
        project: r.project as string,   // project name
        summary: r.summary as string,   // text for dupe comparison
      })
    );

    // ── Check 3: Find orphaned handoffs ──────────────────────────
    // Fetch all handoff projects, then all ledger projects.
    // Difference = orphaned handoffs (handoff but no ledger entries).
    const handoffData = await supabaseGet("session_handoffs", {
      select: "project",               // only need project names
      user_id: `eq.${userId}`,          // scope to this user
    });
    const handoffProjects = new Set(         // set for O(1) lookup
      (Array.isArray(handoffData) ? handoffData : [])
        .map((r: any) => r.project as string)
    );
    const ledgerData = await supabaseGet("session_ledger", {
      select: "project",               // only need project names
      user_id: `eq.${userId}`,          // scope to this user
      archived_at: "is.null",           // only active entries
    });
    const ledgerProjects = new Set(          // projects that have entries
      (Array.isArray(ledgerData) ? ledgerData : [])
        .map((r: any) => r.project as string)
    );
    // Orphaned = in handoffs but NOT in ledger
    const orphanedHandoffs = [...handoffProjects]
      .filter(p => !ledgerProjects.has(p))   // keep only orphans
      .map(project => ({ project }));         // wrap in object

    // ── Check 4: Count stale rollups ─────────────────────────────
    // PostgREST can't do self-joins. Fetch rollups and archived
    // entries separately, then compute in JS.
    const rollupData = await supabaseGet("session_ledger", {
      select: "id,project",            // rollup ID and project
      user_id: `eq.${userId}`,          // scope to this user
      is_rollup: "eq.true",             // only rollup entries
      archived_at: "is.null",           // still active
    });
    const archivedData = await supabaseGet("session_ledger", {
      select: "project",               // just need project names
      user_id: `eq.${userId}`,          // scope to this user
      "archived_at": "not.is.null",     // only archived entries
    });
    // Build a set of projects that have archived entries
    const archivedProjects = new Set(
      (Array.isArray(archivedData) ? archivedData : [])
        .map((r: any) => r.project as string)
    );
    // Stale = rollup exists but project has no archived originals
    const rollups = Array.isArray(rollupData) ? rollupData : [];
    const staleRollups = rollups.filter(
      (r: any) => !archivedProjects.has(r.project)  // no originals
    ).length;

    // ── Totals ───────────────────────────────────────────────────
    // Reuse data already fetched above to avoid extra API calls
    const totalActiveEntries = activeLedgerSummaries.length;
    const totalHandoffs = handoffProjects.size;
    const totalRollups = rollups.length;

    // ── Return raw health stats for the JS engine ────────────────
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
}
