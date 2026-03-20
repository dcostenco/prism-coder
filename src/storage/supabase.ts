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
}
