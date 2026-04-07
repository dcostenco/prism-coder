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

import { gzipSync, gunzipSync } from "node:zlib";

import {
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
  VerificationHarness,     // v7.2.0: Verification Harness
  ValidationResult,        // v7.2.0: Verification Harness
  SpreadingActivationOptions,
} from "./interface.js";

import { debugLog } from "../utils/logger.js";
import {
  PRISM_USER_ID,
  PRISM_SYNAPSE_ENABLED,
  PRISM_SYNAPSE_ITERATIONS,
  PRISM_SYNAPSE_SPREAD_FACTOR,
  PRISM_SYNAPSE_LATERAL_INHIBITION,
  PRISM_SYNAPSE_SOFT_CAP,
  PRISM_VALENCE_ENABLED,
} from "../config.js";
import { getSetting as cfgGet, setSetting as cfgSet, getAllSettings as cfgGetAll } from "./configStorage.js";
import { runAutoMigrations } from "./supabaseMigrations.js";
import { SafetyController } from "../darkfactory/safetyController.js";

export class SupabaseStorage implements StorageBackend {
  // ─── Lifecycle ─────────────────────────────────────────────

  async initialize(): Promise<void> {
    debugLog("[SupabaseStorage] Initialized (REST API, stateless)");

    // Auto-apply pending schema migrations (non-fatal)
    try {
      await runAutoMigrations();
    } catch (err) {
      console.error(
        "[SupabaseStorage] Auto-migration failed. Server will continue, but some tools may be unstable.",
        err instanceof Error ? err.message : err
      );
    }
  }

  async close(): Promise<void> {
    debugLog("[SupabaseStorage] Closed (no-op for REST)");
  }

  // ─── Ledger Operations ─────────────────────────────────────

  async saveLedger(entry: LedgerEntry): Promise<unknown> {
    const record = {
      project: entry.project,
      conversation_id: entry.conversation_id,
      summary: entry.summary,
      user_id: entry.user_id,
      role: entry.role || "global",  // v3.0: include role
      todos: entry.todos || [],
      files_changed: entry.files_changed || [],
      decisions: entry.decisions || [],
      keywords: entry.keywords || [],
      ...(entry.is_rollup !== undefined && { is_rollup: entry.is_rollup }),
      ...(entry.rollup_count !== undefined && { rollup_count: entry.rollup_count }),
      ...(entry.is_rollup && {
        title: `Session Rollup (${entry.rollup_count || 0} entries)`,
        agent_name: "prism-compactor",
      }),
      // v4.0: Active Behavioral Memory fields
      event_type: entry.event_type || "session",
      ...(entry.confidence_score !== undefined && { confidence_score: entry.confidence_score }),
      importance: entry.importance || 0,
      // v5.0: TurboQuant Compressed Embedding fields
      ...(entry.embedding_compressed !== undefined && { embedding_compressed: entry.embedding_compressed }),
      ...(entry.embedding_format !== undefined && { embedding_format: entry.embedding_format }),
      ...(entry.embedding_turbo_radius !== undefined && { embedding_turbo_radius: entry.embedding_turbo_radius }),
      // v9.0: Affect-Tagged Memory
      ...(entry.valence !== undefined && entry.valence !== null && { valence: entry.valence }),
    };

    return supabasePost("session_ledger", record);
  }

  async patchLedger(id: string, data: Record<string, unknown>): Promise<void> {
    await supabasePatch("session_ledger", data, { id: `eq.${id}` });
  }

  // v9.0: Atomic delta-based budget persistence
  // Supabase REST PATCH can't do arithmetic, so we use an RPC function.
  // Falls back to read-modify-write if the RPC doesn't exist.
  async patchHandoffBudgetDelta(project: string, userId: string, budgetDelta: number): Promise<void> {
    try {
      // Preferred: atomic delta via SQL RPC
      await supabaseRpc("patch_budget_delta", {
        p_project: project,
        p_user_id: userId,
        p_delta: budgetDelta,
      });
    } catch (rpcErr) {
      // Fallback: read-modify-write (non-atomic, acceptable for Supabase)
      debugLog(`[SupabaseStorage] patch_budget_delta RPC unavailable, using fallback: ${rpcErr instanceof Error ? rpcErr.message : String(rpcErr)}`);
      try {
        const data = await supabaseGet("session_handoffs", {
          project: `eq.${project}`,
          user_id: `eq.${userId}`,
          select: "cognitive_budget",
          limit: "1",
        });
        const rows = Array.isArray(data) ? data : [];
        const currentBudget = rows.length > 0 ? (rows[0] as any).cognitive_budget ?? 2000 : 2000;
        await supabasePatch("session_handoffs", { cognitive_budget: Math.max(0, currentBudget + budgetDelta) }, {
          project: `eq.${project}`,
          user_id: `eq.${userId}`,
        });
      } catch (fallbackErr) {
        debugLog(`[SupabaseStorage] Budget delta fallback also failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
      }
    }
  }

  async getLedgerEntries(params: Record<string, any>): Promise<unknown[]> {
    const { ids, ...restParams } = params;
    
    // Construct PostgREST 'in.' payload for array of ids if present
    if (ids && Array.isArray(ids) && ids.length > 0) {
      restParams.id = `in.(${ids.join(",")})`;
    }

    const result = await supabaseGet("session_ledger", restParams);
    return Array.isArray(result) ? result : [];
  }

  async deleteLedger(params: Record<string, string>): Promise<unknown[]> {
    const result = await supabaseDelete("session_ledger", params);
    return Array.isArray(result) ? result : [];
  }

  // ─── Phase 2: GDPR-Compliant Memory Deletion ──────────────

  async softDeleteLedger(id: string, userId: string, reason?: string): Promise<void> {
    await supabasePatch("session_ledger", {
      deleted_at: new Date().toISOString(),
      deleted_reason: reason || null,
    }, {
      id: `eq.${id}`,
      user_id: `eq.${userId}`,
    });
    debugLog(`[SupabaseStorage] Soft-deleted ledger entry ${id} (reason: ${reason || "none"})`);
  }

  async hardDeleteLedger(id: string, userId: string): Promise<void> {
    await supabaseDelete("session_ledger", {
      id: `eq.${id}`,
      user_id: `eq.${userId}`,
    });
    debugLog(`[SupabaseStorage] Hard-deleted ledger entry ${id}`);
  }

  async updateLastAccessed(ids: string[]): Promise<void> {
    if (!ids || ids.length === 0) return;
    const CHUNK_SIZE = 100;
    const now = new Date().toISOString();
    
    try {
      const promises = [];
      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        const chunk = ids.slice(i, i + CHUNK_SIZE);
        promises.push(
          supabasePatch("session_ledger", {
            last_accessed_at: now
          }, {
            id: `in.(${chunk.join(",")})`
          })
        );
      }
      await Promise.all(promises);
      debugLog(`[SupabaseStorage] Updated last_accessed_at for ${ids.length} entries`);
    } catch (err) {
      console.warn(`[SupabaseStorage] Failed to update last_accessed_at:`, err);
    }
  }

  // ─── Handoff Operations ────────────────────────────────────

  async saveHandoff(
    handoff: HandoffEntry,
    expectedVersion?: number | null
  ): Promise<SaveHandoffResult> {
    try {
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
        p_role: handoff.role || "global",  // v3.0: pass role to RPC
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
    } catch (e) {
      debugLog("[SupabaseStorage] saveHandoff RPC failed: " + (e instanceof Error ? e.message : String(e)));
      return {
        status: "updated",
        version: handoff.version ?? 1,
      };
    }
  }

  async deleteHandoff(project: string, userId: string): Promise<void> {
    await supabaseDelete("session_handoffs", {
      project: `eq.${project}`,
      user_id: `eq.${userId}`,
    });
  }

  async loadContext(
    project: string,
    level: string,
    userId: string,
    role?: string  // v3.0: optional role filter
  ): Promise<ContextResult> {
    try {
      const result = await supabaseRpc("get_session_context", {
        p_project: project,
        p_level: level,
        p_user_id: userId,
        p_role: role || "global",  // v3.0: pass role to RPC
      });

      const data = Array.isArray(result) ? result[0] : result;
      const context = (data as ContextResult) ?? null;
      if (!context) return null;

      // ─── v7.5.0: Validation Pulse (Standard & Deep) ─────────────
      if (level === "standard" || level === "deep") {
        context.recent_validations = [];
        try {
          const valData = await supabaseGet("verification_runs", {
            project: `eq.${project}`,
            user_id: `eq.${userId}`,
            select: "run_at,passed,pass_rate,gate_action,critical_failures",
            order: "run_at.desc",
            limit: "3"
          });
          const validations = Array.isArray(valData) ? valData : [];
          if (validations.length > 0) {
            context.recent_validations = validations.map((r: any) => ({
              run_at: r.run_at,
              passed: Boolean(r.passed),
              pass_rate: r.pass_rate,
              gate_action: r.gate_action,
              critical_failures: Number(r.critical_failures) || 0,
            }));
          }
        } catch (e) {
          // Graceful degradation if table doesn't exist yet
        }
      }

      return context;
    } catch (e) {
      debugLog("[SupabaseStorage] loadContext RPC failed: " + (e instanceof Error ? e.message : String(e)));
      return null as any;
    }
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
    activation?: SpreadingActivationOptions; // v8.0 spreading activation
  }): Promise<KnowledgeSearchResult | null> {
    try {
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

      // v8.0: Apply Synapse graph enrichment if activation is enabled
      if (params.activation?.enabled && Array.isArray(data.results) && data.results.length > 0) {
        const mappedAnchors: SemanticSearchResult[] = data.results.map((r: any) => ({
          id: r.id as string,
          project: r.project as string,
          summary: r.summary as string,
          similarity: 1.0, // FTS matches treated as 1.0 similarity
          session_date: r.session_date as string | undefined,
          decisions: Array.isArray(r.decisions) ? r.decisions as string[] : [],
          files_changed: Array.isArray(r.files_changed) ? r.files_changed as string[] : [],
        }));
        const activated = await this.applySynapse(mappedAnchors, params.activation, params.userId);
        return { count: activated.length, results: activated };
      }

      return data as KnowledgeSearchResult;
    } catch (e) {
      debugLog("[SupabaseStorage] searchKnowledge RPC failed: " + (e instanceof Error ? e.message : String(e)));
      return null;
    }
  }

  async searchMemory(params: {
    queryEmbedding: string;
    project?: string | null;
    limit: number;
    similarityThreshold: number;
    userId: string;
    role?: string | null;
    activation?: SpreadingActivationOptions; // v8.0 spreading activation
  }): Promise<SemanticSearchResult[]> {
    // ─── TIER 1: Native pgvector cosine search via Supabase RPC ─────────
    //
    // REVIEWER NOTE (v6.1): SUPABASE THREE-TIER SEARCH ARCHITECTURE
    //
    //   Tier 1: `semantic_search_ledger` Postgres RPC (pgvector)
    //     - Fastest: GPU-accelerated HNSW index on Supabase Pro/Team plans
    //     - Falls through when: RPC doesn't exist, plan doesn't include pgvector,
    //       or JWT doesn't have EXECUTE on the function
    //
    //   Tier 2: TurboQuant asymmetric search in JavaScript (mirrors SQLite)
    //     - Fetches all embedding_compressed blobs via REST, scores in JS
    //     - O(N) linear scan — acceptable for typical Prism dataset (<10K entries)
    //     - Activated when: Tier 1 throws any error
    //
    //   Tier 3: Empty array (caller falls through to FTS5 keyword search)
    //     - Both Tiers 1 and 2 failed — semantic search unavailable
    try {
      const result = await supabaseRpc("semantic_search_ledger", {
        p_query_embedding: params.queryEmbedding,
        p_project: params.project || null,
        p_limit: Math.min(params.limit, 20),
        p_similarity_threshold: params.similarityThreshold,
        p_user_id: params.userId,
        p_role: params.role || null,
      });
      const baseResults = Array.isArray(result) ? result as SemanticSearchResult[] : [];
      if (params.activation?.enabled && baseResults.length > 0) {
        return this.applySynapse(baseResults, params.activation, params.userId);
      }
      return baseResults;
    } catch (tier1Err) {
      // ─── TIER 2 FALLBACK: TurboQuant JS-side scoring ─────────────────
      debugLog(
        `[SupabaseStorage] Tier-1 RPC failed, trying Tier-2 TurboQuant fallback: ` +
        `${tier1Err instanceof Error ? tier1Err.message : String(tier1Err)}`
      );

      try {
        const { getDefaultCompressor, deserialize } = await import("../utils/turboquant.js");
        const compressor = getDefaultCompressor();

        // Parse the float32 query vector from the JSON string
        const queryVec: number[] = JSON.parse(params.queryEmbedding);

        // Fetch all entries that have TurboQuant compressed embeddings
        const queryParams: Record<string, string> = {
          user_id: `eq.${params.userId}`,
          archived_at: "is.null",
          deleted_at: "is.null",
          embedding_compressed: "not.is.null",
          select: "id,project,summary,decisions,files_changed,session_date,created_at,embedding_compressed,embedding_turbo_radius",
          limit: "5000",  // Safety cap — Supabase default page size
        };
        if (params.project) queryParams.project = `eq.${params.project}`;
        if (params.role)    queryParams.role    = `eq.${params.role}`;

        const rows = await supabaseGet("session_ledger", queryParams) as Record<string, unknown>[];

        const scored: SemanticSearchResult[] = [];
        for (const row of (Array.isArray(rows) ? rows : [])) {
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
                decisions: Array.isArray(row.decisions) ? row.decisions as string[] : [],
                files_changed: Array.isArray(row.files_changed) ? row.files_changed as string[] : [],
              });
            }
          } catch {
            // Skip entries with corrupt compressed data
          }
        }

        scored.sort((a, b) => b.similarity - a.similarity);
        debugLog(
          `[SupabaseStorage] Tier-2 TurboQuant fallback: scored ${rows.length} entries, ` +
          `${scored.length} above threshold`
        );
        const tier2Results = scored.slice(0, params.limit);
        if (params.activation?.enabled && tier2Results.length > 0) {
          return this.applySynapse(tier2Results, params.activation, params.userId);
        }
        return tier2Results;
      } catch (tier2Err) {
        // Both tiers failed — return empty; caller falls through to FTS5
        console.error(
          `[SupabaseStorage] Both Tier-1 and Tier-2 search failed. ` +
          `Tier-1: ${tier1Err instanceof Error ? tier1Err.message : String(tier1Err)}. ` +
          `Tier-2: ${tier2Err instanceof Error ? tier2Err.message : String(tier2Err)}. ` +
          `Tip: Ensure semantic_search_ledger RPC exists in your Supabase project.`
        );
        return [];
      }
    }
  }

  // ─── Synapse Engine Integration (v8.0) ────────────────────────
  //
  // Storage-agnostic multi-hop activation enrichment.
  // Mirrors SqliteStorage.applySynapse() — the Synapse engine itself
  // is pure (zero I/O), receiving link data via the getLinksForNodes
  // callback. Missing node metadata is fetched via Supabase REST.

  private async applySynapse(
    anchors: SemanticSearchResult[],
    options: SpreadingActivationOptions,
    userId: string
  ): Promise<SemanticSearchResult[]> {
    if (!PRISM_SYNAPSE_ENABLED || !options.enabled || anchors.length === 0) return anchors;

    try {
      const { propagateActivation, normalizeActivationEnergy } = await import("../memory/synapseEngine.js");
      const { recordSynapseTelemetry } = await import("../observability/graphMetrics.js");

      const anchorMap = new Map<string, number>();
      for (const a of anchors) anchorMap.set(a.id, a.similarity ?? 1.0);

      const { results, telemetry, flowWeights } = await propagateActivation(
        anchorMap,
        async (nodeIds) => this.getLinksForNodes(nodeIds, userId),
        {
          iterations: options.iterations ?? PRISM_SYNAPSE_ITERATIONS,
          spreadFactor: options.spreadFactor ?? PRISM_SYNAPSE_SPREAD_FACTOR,
          lateralInhibition: options.lateralInhibition ?? PRISM_SYNAPSE_LATERAL_INHIBITION,
          softCap: PRISM_SYNAPSE_SOFT_CAP,
        }
      );

      recordSynapseTelemetry(telemetry);

      // Build node lookup from anchor results
      const fullNodeMap = new Map<string, SemanticSearchResult>();
      for (const a of anchors) fullNodeMap.set(a.id, a);

      // Fetch metadata for nodes discovered by propagation (not in original anchors)
      const finalIds = results.map(r => r.id);
      const missingIds = finalIds.filter(id => !fullNodeMap.has(id));

      if (missingIds.length > 0) {
        try {
          const rows = await supabaseGet("session_ledger", {
            id: `in.(${missingIds.join(",")})`,
            user_id: `eq.${userId}`,
            deleted_at: "is.null",
            select: "id,project,summary,session_date,decisions,files_changed,is_rollup,importance,last_accessed_at,valence",
          }) as Record<string, unknown>[];

          for (const row of (Array.isArray(rows) ? rows : [])) {
            fullNodeMap.set(row.id as string, {
              id: row.id as string,
              project: row.project as string,
              summary: row.summary as string,
              session_date: row.session_date as string | undefined,
              decisions: Array.isArray(row.decisions) ? row.decisions as string[] : [],
              files_changed: Array.isArray(row.files_changed) ? row.files_changed as string[] : [],
              is_rollup: Boolean(row.is_rollup),
              importance: Number(row.importance) || 0,
              last_accessed_at: (row.last_accessed_at as string) || null,
              valence: row.valence != null ? Number(row.valence) : undefined,
              similarity: 0.0,
            });
          }
        } catch (e) {
          debugLog(`[SupabaseStorage] applySynapse: failed to fetch missing nodes: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // ─── v9.0: Valence Propagation for discovered nodes ──────────
      // Mirrors the SQLite implementation: batch propagateValence() call
      // over the full results array with a valence lookup map.
      let propagatedValenceMap: Map<string, number> | null = null;
      if (PRISM_VALENCE_ENABLED) {
        try {
          const { propagateValence } = await import("../memory/valenceEngine.js");
          // Build valence lookup from all known nodes
          const valenceLookup = new Map<string, number>();
          for (const [id, node] of fullNodeMap) {
            if (node.valence != null && Number.isFinite(node.valence)) {
              valenceLookup.set(id, node.valence);
            }
          }

          propagatedValenceMap = propagateValence(results, valenceLookup, flowWeights);
          debugLog(`[SupabaseStorage] v9.0 valence propagation: ${propagatedValenceMap.size} nodes processed`);
        } catch (valErr) {
          debugLog(`[SupabaseStorage] applySynapse: valence propagation failed (non-fatal): ${valErr instanceof Error ? valErr.message : String(valErr)}`);
        }
      }

      // Import hybrid scoring if valence is enabled
      const { computeHybridScoreWithValence } = PRISM_VALENCE_ENABLED
        ? await import("../memory/valenceEngine.js")
        : { computeHybridScoreWithValence: null };

      // Compute hybrid scores and build final result set
      const finalResults: SemanticSearchResult[] = [];

      for (const r of results) {
        if (fullNodeMap.has(r.id)) {
          const node = fullNodeMap.get(r.id)!;
          const normEnergy = normalizeActivationEnergy(r.activationEnergy);
          node.activationScore = normEnergy;
          node.rawActivationEnergy = r.activationEnergy;
          node.isDiscovered = r.isDiscovered;

          // v9.0: Three-component hybrid blend with valence salience
          const nodeValence = propagatedValenceMap?.get(r.id) ?? node.valence;
          if (computeHybridScoreWithValence && nodeValence != null && Number.isFinite(nodeValence)) {
            node.valence = nodeValence;
            node.hybridScore = computeHybridScoreWithValence(node.similarity, normEnergy, nodeValence);
          } else {
            node.hybridScore = (node.similarity * 0.7) + (normEnergy * 0.3);
          }

          finalResults.push(node);
        }
      }

      return finalResults.sort((a, b) => (b.hybridScore || 0) - (a.hybridScore || 0));
    } catch (err) {
      debugLog(`[SupabaseStorage] applySynapse failed (non-fatal, returning original anchors): ${err instanceof Error ? err.message : String(err)}`);
      return anchors;
    }
  }


  // ─── Compaction ────────────────────────────────────────────

  async getCompactionCandidates(
    threshold: number,
    keepRecent: number,
    userId: string
  ): Promise<Array<{ project: string; total_entries: number; to_compact: number }>> {
    try {
      const result = await supabaseRpc("get_compaction_candidates", {
        p_threshold: threshold,
        p_keep_recent: keepRecent,
        p_user_id: userId,
      });

      return Array.isArray(result) ? result : [];
    } catch (e) {
      debugLog("[SupabaseStorage] getCompactionCandidates RPC failed: " + (e instanceof Error ? e.message : String(e)));
      return [];
    }
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

  // ─── v5.4: CRDT Base State Retrieval ───────────────────────
  //
  // Reads a historical handoff snapshot by version number via
  // Supabase REST API. Used by the CRDT merge engine.

  async getHandoffAtVersion(
    project: string,
    version: number,
    userId: string = "default"
  ): Promise<Record<string, unknown> | null> {
    try {
      const data = await supabaseGet("session_handoffs_history", {
        select: "snapshot",
        project: `eq.${project}`,
        user_id: `eq.${userId}`,
        version: `eq.${version}`,
        limit: "1",
      });
      const rows = Array.isArray(data) ? data : [];
      if (rows.length === 0) return null;
      return rows[0].snapshot as Record<string, unknown> || null;
    } catch (err) {
      console.error(`[SupabaseStorage] Failed to get handoff at version ${version}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // ─── v2.0 Dashboard ─────────────────────────────────────────

  async listProjects(): Promise<string[]> {
    const data = await supabaseGet("session_handoffs", {
      select: "project",
      order: "project.asc",
    });
    const rows = Array.isArray(data) ? data : [];
    return [...new Set(rows.map((r: any) => r.project as string))];
  }

  // ─── v2.2.0 Health Check (fsck) ─────────────────────────────

  async getHealthStats(userId: string): Promise<HealthStats> {
    const missingData = await supabaseGet("session_ledger", {
      select: "id",
      user_id: `eq.${userId}`,
      archived_at: "is.null",
      embedding: "is.null",
    });
    const missingEmbeddings = Array.isArray(missingData) ? missingData.length : 0;

    const summData = await supabaseGet("session_ledger", {
      select: "id,project,summary",
      user_id: `eq.${userId}`,
      archived_at: "is.null",
    });
    const activeLedgerSummaries = (Array.isArray(summData) ? summData : []).map(
      (r: any) => ({
        id: r.id as string,
        project: r.project as string,
        summary: r.summary as string,
      })
    );

    const handoffData = await supabaseGet("session_handoffs", {
      select: "project",
      user_id: `eq.${userId}`,
    });
    const handoffProjects = new Set(
      (Array.isArray(handoffData) ? handoffData : [])
        .map((r: any) => r.project as string)
    );
    const ledgerData = await supabaseGet("session_ledger", {
      select: "project",
      user_id: `eq.${userId}`,
      archived_at: "is.null",
    });
    const ledgerProjects = new Set(
      (Array.isArray(ledgerData) ? ledgerData : [])
        .map((r: any) => r.project as string)
    );
    const orphanedHandoffs = [...handoffProjects]
      .filter(p => !ledgerProjects.has(p))
      .map(project => ({ project }));

    const rollupData = await supabaseGet("session_ledger", {
      select: "id,project",
      user_id: `eq.${userId}`,
      is_rollup: "eq.true",
      archived_at: "is.null",
    });
    const archivedData = await supabaseGet("session_ledger", {
      select: "project",
      user_id: `eq.${userId}`,
      "archived_at": "not.is.null",
    });
    const archivedProjects = new Set(
      (Array.isArray(archivedData) ? archivedData : [])
        .map((r: any) => r.project as string)
    );
    const rollups = Array.isArray(rollupData) ? rollupData : [];
    const staleRollups = rollups.filter(
      (r: any) => !archivedProjects.has(r.project)
    ).length;

    const totalActiveEntries = activeLedgerSummaries.length;
    const totalHandoffs = handoffProjects.size;
    const totalRollups = rollups.length;

    // v5.4: Aggregate CRDT merge counts from handoff metadata
    const handoffFullData = await supabaseGet("session_handoffs", {
      select: "metadata",
      user_id: `eq.${userId}`,
    });
    const handoffRows = Array.isArray(handoffFullData) ? handoffFullData : [];
    const totalCrdtMerges = handoffRows.reduce(
      (sum: number, h: any) => sum + ((h.metadata?.crdt_merge_count as number) || 0), 0
    );

    return {
      missingEmbeddings,
      activeLedgerSummaries,
      orphanedHandoffs,
      staleRollups,
      totalActiveEntries,
      totalHandoffs,
      totalRollups,
      totalCrdtMerges,
    };
  }

  // ─── v3.0: Agent Registry (Hivemind) ───────────────────────
  // Supabase users need to run the 017_agent_hivemind.sql migration

  async registerAgent(entry: AgentRegistryEntry): Promise<AgentRegistryEntry> {
    const record = {
      project: entry.project,
      user_id: entry.user_id,
      role: entry.role,
      agent_name: entry.agent_name ?? null,
      status: entry.status || "active",
      current_task: entry.current_task ?? null,
      // v5.3: Initialize watchdog fields
      task_start_time: new Date().toISOString(),
      expected_duration_minutes: null,
      task_hash: null,
      loop_count: 0,
    };
    const result = await supabasePost("agent_registry", record);
    const data = Array.isArray(result) ? result[0] : result;
    return { ...entry, id: data?.id, status: entry.status || "active" };
  }

  /**
   * Simple string hash for loop detection (DJB2).
   * Mirrors SqliteStorage._simpleHash().
   */
  private _simpleHash(str: string): string {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xFFFFFFFF;
    }
    return hash.toString(16);
  }

  async heartbeatAgent(
    project: string, userId: string, role: string,
    currentTask?: string, expectedDurationMinutes?: number
  ): Promise<void> {
    // v5.3: Loop detection — compute task hash and compare with stored value
    const newTaskHash = currentTask ? this._simpleHash(currentTask) : null;

    // Fetch current agent for loop comparison
    const current = await supabaseGet("agent_registry", {
      project: `eq.${project}`,
      user_id: `eq.${userId}`,
      role: `eq.${role}`,
      select: "task_hash,loop_count",
    });
    const agentRow = Array.isArray(current) ? current[0] : current;
    const existingHash = agentRow?.task_hash as string | null;
    const existingLoopCount = (agentRow?.loop_count as number) || 0;

    const taskChanged = newTaskHash !== null && newTaskHash !== existingHash;
    const sameTask = newTaskHash !== null && newTaskHash === existingHash;

    const newLoopCount = sameTask
      ? existingLoopCount + 1
      : (taskChanged ? 0 : existingLoopCount);

    const newStatus = newLoopCount >= 5 ? "looping" : "active";

    const patchData: Record<string, unknown> = {
      last_heartbeat: new Date().toISOString(),
      loop_count: newLoopCount,
      status: newStatus,
    };
    if (currentTask !== undefined) {
      patchData.current_task = currentTask;
    }
    if (newTaskHash !== null) {
      patchData.task_hash = newTaskHash;
    }
    if (taskChanged) {
      patchData.task_start_time = new Date().toISOString();
    }
    if (expectedDurationMinutes !== undefined) {
      patchData.expected_duration_minutes = expectedDurationMinutes;
    }

    await supabasePatch("agent_registry", patchData, {
      project: `eq.${project}`,
      user_id: `eq.${userId}`,
      role: `eq.${role}`,
    });
  }

  async listTeam(project: string, userId: string, _staleMinutes: number = 30): Promise<AgentRegistryEntry[]> {
    const data = await supabaseGet("agent_registry", {
      project: `eq.${project}`,
      user_id: `eq.${userId}`,
      order: "last_heartbeat.desc",
    });
    return (Array.isArray(data) ? data : []) as AgentRegistryEntry[];
  }

  async deregisterAgent(project: string, userId: string, role: string): Promise<void> {
    await supabaseDelete("agent_registry", {
      project: `eq.${project}`,
      user_id: `eq.${userId}`,
      role: `eq.${role}`,
    });
  }

  // ─── v5.3: Hivemind Watchdog Methods ───────────────────────

  async getAllAgents(userId: string): Promise<AgentRegistryEntry[]> {
    const data = await supabaseGet("agent_registry", {
      user_id: `eq.${userId}`,
      order: "project,role",
    });
    return (Array.isArray(data) ? data : []) as AgentRegistryEntry[];
  }

  async updateAgentStatus(
    project: string, userId: string, role: string,
    status: AgentRegistryEntry["status"],
    additionalFields?: Record<string, unknown>
  ): Promise<void> {
    const patchData: Record<string, unknown> = { status };

    const ALLOWED_FIELDS = new Set([
      "loop_count", "task_start_time", "expected_duration_minutes",
      "task_hash", "current_task",
    ]);
    if (additionalFields) {
      for (const [key, val] of Object.entries(additionalFields)) {
        if (ALLOWED_FIELDS.has(key)) {
          patchData[key] = val;
        }
      }
    }

    await supabasePatch("agent_registry", patchData, {
      project: `eq.${project}`,
      user_id: `eq.${userId}`,
      role: `eq.${role}`,
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

  // ─── v3.1: Memory Analytics ──────────────────────────────────

  async getAnalytics(project: string, userId: string): Promise<AnalyticsData> {
    // Attempt to call a Supabase RPC. Falls back to zeroed struct if the RPC
    // doesn't exist yet (avoids breaking users who haven't run the migration).
    try {
      const result = await supabaseRpc("get_project_analytics", {
        p_project: project,
        p_user_id: userId,
      });
      const data = Array.isArray(result) ? result[0] : result;
      if (data) {
        return {
          totalEntries: data.total_entries || 0,
          totalRollups: data.total_rollups || 0,
          rollupSavings: data.rollup_savings || 0,
          avgSummaryLength: data.avg_summary_length || 0,
          sessionsByDay: data.sessions_by_day || [],
        };
      }
    } catch {
      debugLog("[SupabaseStorage] getAnalytics RPC unavailable — returning zeroed struct");
    }
    // Graceful degradation: return zeroed struct so dashboard doesn't crash
    return {
      totalEntries: 0, totalRollups: 0, rollupSavings: 0,
      avgSummaryLength: 0, sessionsByDay: [],
    };
  }

  // ─── v3.1: TTL / Automated Data Retention ────────────────────

  async expireByTTL(
    project: string,
    ttlDays: number,
    userId: string
  ): Promise<{ expired: number }> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - ttlDays);
    const cutoffStr = cutoff.toISOString();

    // Use existing supabasePatch with PostgREST filter syntax
    // No new RPC needed — PATCH with filter works for bulk soft-delete
    try {
      await supabasePatch(
        "session_ledger",
        { archived_at: cutoffStr },
        {
          project: `eq.${project}`,
          user_id: `eq.${userId}`,
          "created_at": `lt.${cutoffStr}`,
          "is_rollup": "eq.false",
          "archived_at": "is.null",
        }
      );
    } catch (e) {
      debugLog("[SupabaseStorage] expireByTTL failed: " + (e instanceof Error ? e.message : String(e)));
    }

    // Fix #5: Decay importance parity with SQLite.
    // NOTE: Unlike SQLite (which decays on every session_save_ledger health sweep),
    // Supabase decay is TTL-gated — it only runs when knowledge_set_retention has
    // been configured for this project. Projects without a TTL policy will not
    // experience importance decay. Future improvement: fire this from
    // sessionSaveLedgerHandler (fire-and-forget) to achieve full parity.
    try {
      await supabaseRpc("prism_decay_importance", {
        p_project: project,
        p_user_id: userId,
        p_days: 30,
      });
      debugLog(`[SupabaseStorage] Importance decay sweep completed for "${project}"`);
    } catch (e) {
      // Non-fatal: decay is a best-effort background operation
      debugLog("[SupabaseStorage] prism_decay_importance failed (non-fatal): " + (e instanceof Error ? e.message : String(e)));
    }

    // Supabase PATCH doesn't return rowsAffected — return 0 (UI doesn't need exact count)
    debugLog(`[SupabaseStorage] TTL sweep completed for "${project}" (cutoff: ${cutoffStr})`);
    return { expired: 0 };
  }

  // ─── v4.0: Insight Graduation ──────────────────────────────────

  async adjustImportance(
    id: string,
    delta: number,
    userId: string
  ): Promise<void> {
    // Fix #4: Use atomic RPC instead of read-then-write.
    // prism_adjust_importance computes MAX(0, importance + delta) in one
    // SQL UPDATE, eliminating the race condition in the old pattern.
    try {
      await supabaseRpc("prism_adjust_importance", {
        p_id: id,
        p_user_id: userId,
        p_delta: delta,
      });
      debugLog(`[SupabaseStorage] Adjusted importance for ${id} by ${delta > 0 ? "+" : ""}${delta} via RPC`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      debugLog("[SupabaseStorage] adjustImportance failed: " + msg);
      throw e; // Fix #3: rethrow so handlers can surface isError:true
    }
  }

  // ─── v4.2: Graduated Insights Query ──────────────────────────

  async getGraduatedInsights(
    project: string,
    userId: string,
    minImportance: number = 7
  ): Promise<LedgerEntry[]> {
    const data = await supabaseGet("session_ledger", {
      project: `eq.${project}`,
      user_id: `eq.${userId}`,
      importance: `gte.${minImportance}`,
      deleted_at: "is.null",
      archived_at: "is.null",
      select: "id,project,user_id,role,summary,importance,event_type,decisions,created_at",
      order: "importance.desc,created_at.desc",
    });
    const rows = Array.isArray(data) ? data : [];
    return rows.map((r: any) => ({
      id: r.id,
      project: r.project,
      user_id: r.user_id,
      role: r.role || "global",
      summary: r.summary,
      importance: r.importance || 0,
      event_type: r.event_type || "session",
      decisions: Array.isArray(r.decisions) ? r.decisions : [],
      created_at: r.created_at,
      conversation_id: "",
    }));
  }

  // ─── v4.3: Standalone Importance Decay ─────────────────────
  //
  // Calls the prism_decay_importance RPC (migration 028) directly,
  // decoupled from expireByTTL so it can be triggered fire-and-forget
  // from session_save_ledger without a TTL policy being active.

  async decayImportance(
    project: string,
    userId: string,
    decayDays: number
  ): Promise<void> {
    try {
      await supabaseRpc("prism_decay_importance", {
        p_project: project,
        p_user_id: userId,
        p_days: decayDays,
      });
      debugLog(`[SupabaseStorage] decayImportance: sweep completed for "${project}" (>${decayDays}d old)`);
    } catch (e) {
      // Non-fatal: decay is best-effort — log and rethrow so fire-and-forget caller can see it
      debugLog("[SupabaseStorage] decayImportance failed: " + (e instanceof Error ? e.message : String(e)));
      throw e;
    }
  }

  // ─── v5.1: Deep Storage Mode ("The Purge") ────────────────────
  //
  // REVIEWER NOTE: This calls the prism_purge_embeddings RPC created
  // by migration 030. The RPC runs server-side in Postgres with
  // SECURITY DEFINER privileges, enforcing all safety guards:
  //   - p_older_than_days >= 7 (raises exception otherwise)
  //   - Only purges entries with embedding_compressed IS NOT NULL
  //   - Multi-tenant: scoped to p_user_id
  //   - Optional project filter (NULL = all projects)
  //   - Dry-run mode (preview without modifying)
  //
  // GRACEFUL DEGRADATION:
  //   If the RPC doesn't exist (PGRST202 — migration 030 not applied),
  //   we throw a clear error directing users to apply the migration.
  //   This matches the pattern used by other Supabase RPC calls
  //   (e.g., prism_adjust_importance in adjustImportance()).
  //
  // RETURN VALUE:
  //   The RPC returns a single-row TABLE with (eligible, purged, reclaimed_bytes).
  //   We parse this into the same TypeScript shape as the SQLite implementation.

  async purgeHighPrecisionEmbeddings(params: {
    project?: string;
    olderThanDays: number;
    dryRun: boolean;
    userId: string;
  }): Promise<{ purged: number; eligible: number; reclaimedBytes: number }> {
    // Safety guard: enforce minimum age (also enforced server-side, but
    // catch early to avoid RPC roundtrip for obviously invalid requests)
    if (params.olderThanDays < 7) {
      throw new Error(
        "olderThanDays must be at least 7 to prevent purging recent entries. " +
        "Entries younger than 7 days may still benefit from Tier-1 native vector search."
      );
    }

    try {
      const result = await supabaseRpc("prism_purge_embeddings", {
        p_project: params.project || null,    // NULL = all projects
        p_user_id: params.userId,
        p_older_than_days: params.olderThanDays,
        p_dry_run: params.dryRun,
      });

      // RPC returns TABLE(eligible, purged, reclaimed_bytes) — parse the first row
      const data = Array.isArray(result) ? result[0] : result;

      return {
        eligible: Number(data?.eligible) || 0,
        purged: Number(data?.purged) || 0,
        reclaimedBytes: Number(data?.reclaimed_bytes) || 0,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);

      // PGRST202 = function not found — migration 030 not applied yet
      if (msg.includes("PGRST202") || msg.includes("Could not find the function")) {
        throw new Error(
          "Deep Storage Purge requires migration 030 (prism_purge_embeddings RPC). " +
          "Apply the migration via: supabase db push, or run " +
          "supabase/migrations/030_deep_storage_purge.sql in your SQL Editor."
        );
      }

      debugLog("[SupabaseStorage] purgeHighPrecisionEmbeddings failed: " + msg);
      throw e;
    }
  }

  // ─── SDM Operations ──────────────────────────────────────────

  // ── Base64 ↔ Float32Array Helpers ────────────────────────────
  //
  // The SDM counter matrix is ~30.7MB (10,000 × 768 × Float32).
  // Uncompressed base64 would be ~41MB, exceeding PostgREST's default
  // payload limit (~10-25MB). We gzip before base64 encoding, which
  // yields ~5-8× compression on clipped ±20 counter values.
  //
  // Format: "gz:<base64(gzip(raw_bytes))>" for compressed payloads.
  // Legacy uncompressed base64 (no prefix) is still readable for
  // backward compatibility during migration.

  private arrayToBase64(arr: Float32Array): string {
    const raw = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    const compressed = gzipSync(raw, { level: 6 });
    return 'gz:' + compressed.toString('base64');
  }

  private base64ToArray(base64: string): Float32Array {
    let buffer: Buffer;
    if (base64.startsWith('gz:')) {
      // Compressed format: gz:<base64(gzip(bytes))>
      const compressed = Buffer.from(base64.slice(3), 'base64');
      buffer = gunzipSync(compressed);
    } else {
      // Legacy uncompressed format for backward compatibility
      buffer = Buffer.from(base64, 'base64');
    }
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  }

  async loadSdmState(project: string): Promise<Float32Array | null> {
    const { SDM_ADDRESS_VERSION } = await import('../sdm/sdmEngine.js');
    const result = await supabaseGet("sdm_state", {
      project: `eq.${project}`,
      select: "counters,address_version",
      limit: "1",
    });

    const rows = Array.isArray(result) ? result : [];
    if (rows.length === 0) return null;

    const row = rows[0] as Record<string, unknown>;
    if (!row.counters || typeof row.counters !== "string") return null;

    // Version mismatch guard: purge stale state generated by old PRNG.
    // Mirrors the same check in SqliteStorage.loadSdmState.
    if (row.address_version !== SDM_ADDRESS_VERSION) {
      debugLog(
        `[SupabaseStorage] SDM address_version mismatch for "${project}" ` +
        `(stored: ${row.address_version}, current: ${SDM_ADDRESS_VERSION}). Purging stale state.`
      );
      await supabaseDelete("sdm_state", { project: `eq.${project}` });
      return null;
    }

    return this.base64ToArray(row.counters);
  }

  async saveSdmState(project: string, state: Float32Array): Promise<void> {
    const base64Content = this.arrayToBase64(state);
    const { SDM_ADDRESS_VERSION } = await import('../sdm/sdmEngine.js');
    await supabasePost(
      "sdm_state",
      {
        project,
        counters: base64Content,
        address_version: SDM_ADDRESS_VERSION,
        updated_at: new Date().toISOString(),
      },
      { on_conflict: "project" },
      { Prefer: "return=minimal,resolution=merge-duplicates" },
    );
  }

  // ─── HDC Dictionary (Concept Vectors) ───────────────────────────
  //
  // The hdc_dictionary table stores 768-word Uint32Array concept vectors
  // (3072 bytes each) as base64 TEXT via Supabase REST. Much smaller than
  // the SDM counter matrix — no concerns about payload size.
  //
  // The prng_version column tracks which PRNG algorithm generated the
  // vector, enabling automatic invalidation when the algorithm changes.

  private uint32ToBase64(arr: Uint32Array): string {
    const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    return Buffer.from(u8).toString("base64");
  }

  private base64ToUint32(base64: string): Uint32Array {
    const buffer = Buffer.from(base64, "base64");
    return new Uint32Array(
      buffer.buffer, buffer.byteOffset, buffer.byteLength / 4
    );
  }

  async getHdcConcept(concept: string): Promise<Uint32Array | null> {
    const result = await supabaseGet("hdc_dictionary", {
      concept_name: `eq.${concept}`,
      select: "vector",
      limit: "1",
    });

    const rows = Array.isArray(result) ? result : [];
    if (rows.length === 0) return null;

    const row = rows[0] as Record<string, unknown>;
    if (!row.vector || typeof row.vector !== "string") return null;

    return this.base64ToUint32(row.vector);
  }

  async getAllHdcConcepts(): Promise<Array<{ concept: string; vector: Uint32Array }>> {
    const result = await supabaseGet("hdc_dictionary", {
      select: "concept_name,vector",
      order: "concept_name.asc",
    });

    const rows = Array.isArray(result) ? result : [];
    return rows.map((row: any) => ({
      concept: row.concept_name as string,
      vector: this.base64ToUint32(row.vector as string),
    }));
  }

  async saveHdcConcept(concept: string, vector: Uint32Array): Promise<void> {
    const base64Vector = this.uint32ToBase64(vector);
    const { HDC_DICTIONARY_VERSION } = await import('../sdm/sdmEngine.js');

    await supabasePost(
      "hdc_dictionary",
      {
        concept_name: concept,
        vector: base64Vector,
        prng_version: HDC_DICTIONARY_VERSION,
      },
      { on_conflict: "concept_name" },
      { Prefer: "return=minimal,resolution=merge-duplicates" },
    );

    debugLog(`[SupabaseStorage] Persisted HDC concept v${HDC_DICTIONARY_VERSION} to dictionary: ${concept}`);
  }

  // ─── v6.1: Storage Hygiene ────────────────────────────────────

  async vacuumDatabase(_opts: { dryRun: boolean }): Promise<{
    sizeBefore: number;
    sizeAfter: number;
    message: string;
  }> {
    return {
      sizeBefore: 0,
      sizeAfter: 0,
      message:
        "VACUUM is not available via the Supabase REST API. " +
        "To reclaim space on your hosted database, go to the Supabase Dashboard → " +
        "Database → Maintenance and run VACUUM ANALYZE there.",
    };
  }

  async getAllProjectEmbeddings(project: string): Promise<Array<{ id: string, summary: string, embedding_compressed: string }>> {
    const result = await supabaseGet("session_ledger", {
      project: `eq.${project}`,
      select: "id,summary,embedding_compressed",
      deleted_at: "is.null",
      archived_at: "is.null",
      embedding_compressed: "not.is.null",
      limit: "5000",  // Safety cap — matches Tier-2 search
    });

    const rows = Array.isArray(result) ? result : [];
    return rows.map((r: any) => ({
      id: r.id as string,
      summary: r.summary as string,
      embedding_compressed: r.embedding_compressed as string,
    }));
  }

  // ─── v6.0: Memory Links (Associative Graph) — Supabase graceful degradation ──
  //
  // These methods return safe no-op values until the Supabase migration +
  // RPC layer is built. This ensures Supabase users don't crash when
  // Phase 3 auto-linking fires. SQLite is the primary target for v6.0.

  async createLink(link: MemoryLink, userId: string): Promise<void> {
    try {
      await supabaseRpc("prism_create_link", {
        p_user_id: userId,
        p_source_id: link.source_id,
        p_target_id: link.target_id,
        p_link_type: link.link_type,
        p_strength: Math.max(0.0, Math.min(link.strength ?? 1.0, 1.0)),
        p_metadata: link.metadata ? JSON.parse(link.metadata) : null,
      });

      if (link.link_type === 'related_to') {
        await this.pruneExcessLinks(link.source_id, 'related_to', 25);
      }
    } catch (e: any) {
      debugLog("[SupabaseStorage] createLink failed: " + e.message);
      return;
    }
  }

  async deleteLink(
    sourceId: string,
    targetId: string,
    linkType: MemoryLink["link_type"],
    userId: string
  ): Promise<boolean> {
    try {
      const result = await supabaseRpc("prism_delete_link", {
        p_user_id: userId,
        p_source_id: sourceId,
        p_target_id: targetId,
        p_link_type: linkType,
      });
      return result === true || result === "true";
    } catch (e: any) {
      debugLog("[SupabaseStorage] deleteLink failed: " + e.message);
      return false;
    }
  }

  async getLinksFrom(sourceId: string, userId: string, minStrength?: number, limit?: number): Promise<MemoryLink[]> {
    try {
      const result = await supabaseRpc("prism_get_links_from", {
        p_source_id: sourceId,
        p_user_id: userId,
        ...(minStrength !== undefined ? { p_min_strength: minStrength } : {}),
        ...(limit !== undefined ? { p_limit: limit } : {}),
      });

      const rows = Array.isArray(result) ? result : [];
      return rows.map((r: any) => ({
        source_id: r.source_id,
        target_id: r.target_id,
        link_type: r.link_type,
        strength: r.strength,
        metadata: r.metadata ? JSON.stringify(r.metadata) : undefined,
        created_at: r.created_at,
        last_traversed_at: r.last_traversed_at,
      }));
    } catch (e: any) {
      debugLog("[SupabaseStorage] getLinksFrom failed: " + e.message);
      return [];
    }
  }

  async getLinksTo(targetId: string, userId: string, minStrength?: number, limit?: number): Promise<MemoryLink[]> {
    try {
      const result = await supabaseRpc("prism_get_links_to", {
        p_target_id: targetId,
        p_user_id: userId,
        ...(minStrength !== undefined ? { p_min_strength: minStrength } : {}),
        ...(limit !== undefined ? { p_limit: limit } : {}),
      });

      const rows = Array.isArray(result) ? result : [];
      return rows.map((r: any) => ({
        source_id: r.source_id,
        target_id: r.target_id,
        link_type: r.link_type,
        strength: r.strength,
        metadata: r.metadata ? JSON.stringify(r.metadata) : undefined,
        created_at: r.created_at,
        last_traversed_at: r.last_traversed_at,
      }));
    } catch (e: any) {
      debugLog("[SupabaseStorage] getLinksTo failed: " + e.message);
      return [];
    }
  }

  async getLinksForNodes(nodeIds: string[], userId: string): Promise<Array<{ source_id: string; target_id: string; strength: number }>> {
    if (!nodeIds || nodeIds.length === 0) return [];
    try {
      const result = await supabaseRpc("prism_get_links_for_nodes", {
        p_node_ids: nodeIds,
        p_user_id: userId
      });

      const rows = Array.isArray(result) ? result : [];
      return rows.map((r: any) => ({
        source_id: r.source_id,
        target_id: r.target_id,
        strength: r.strength
      }));
    } catch (e: any) {
      debugLog("[SupabaseStorage] getLinksForNodes failed: " + e.message);
      return [];
    }
  }

  async countLinks(entryId: string, linkType?: string): Promise<number> {
    try {
      const query = { source_id: `eq.${entryId}` };
      if (linkType) {
        Object.assign(query, { link_type: `eq.${linkType}` });
      }
      const result = await supabaseGet("memory_links", { 
        ...query,
        select: "source_id"
      });
      return Array.isArray(result) ? result.length : 0;
    } catch (e: any) {
      debugLog("[SupabaseStorage] countLinks failed: " + e.message);
      return 0;
    }
  }

  async pruneExcessLinks(entryId: string, linkType: string, maxLinks?: number): Promise<void> {
    try {
      await supabaseRpc("prism_prune_excess_links", {
        p_entry_id: entryId,
        p_link_type: linkType,
        p_max_links: maxLinks ?? 25
      });
    } catch (e: any) {
      debugLog("[SupabaseStorage] pruneExcessLinks failed: " + e.message);
      return;
    }
  }

  async reinforceLink(sourceId: string, targetId: string, linkType: string): Promise<void> {
    try {
      await supabaseRpc("prism_reinforce_link", {
        p_source_id: sourceId,
        p_target_id: targetId,
        p_link_type: linkType
      });
    } catch (e: any) {
      debugLog("[SupabaseStorage] reinforceLink failed: " + e.message);
      return;
    }
  }

  async decayLinks(olderThanDays: number, _userId?: string): Promise<number> {
    try {
      const affected = await supabaseRpc("prism_decay_links", {
        p_older_than_days: olderThanDays
      });
      return Number(affected) || 0;
    } catch (e: any) {
      debugLog("[SupabaseStorage] decayLinks failed: " + e.message);
      return 0;
    }
  }

  async summarizeWeakLinks(
    project: string,
    userId: string,
    minStrength: number,
    maxSourceEntries: number = 25,
    maxLinksPerSource: number = 25,
  ): Promise<{ sources_considered: number; links_scanned: number; links_soft_pruned: number }> {
    // WS4.1 fast-path: aggregate server-side in one RPC call.
    try {
      const rpcResult = await supabaseRpc("prism_summarize_weak_links", {
        p_project: project,
        p_user_id: userId,
        p_min_strength: minStrength,
        p_max_source_entries: maxSourceEntries,
        p_max_links_per_source: maxLinksPerSource,
      });

      const row = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
      if (row && typeof row === "object") {
        return {
          sources_considered: Number((row as any).sources_considered) || 0,
          links_scanned: Number((row as any).links_scanned) || 0,
          links_soft_pruned: Number((row as any).links_soft_pruned) || 0,
        };
      }
    } catch (e: any) {
      debugLog("[SupabaseStorage] summarizeWeakLinks RPC path failed, falling back: " + e.message);
    }

    // Compatibility fallback: iterative N+1 path (kept for migration lag/fault tolerance)
    try {
      const rows = await this.getLedgerEntries({
        project: `eq.${project}`,
        user_id: `eq.${userId}`,
        deleted_at: "is.null",
        archived_at: "is.null",
        select: "id",
        order: "created_at.desc",
        limit: maxSourceEntries,
      }) as Array<{ id?: string }>;

      let linksScanned = 0;
      let linksSoftPruned = 0;

      for (const row of rows) {
        if (!row?.id) continue;
        const links = await this.getLinksFrom(row.id, userId, 0.0, maxLinksPerSource);
        linksScanned += links.length;
        linksSoftPruned += links.filter(l => l.strength < minStrength).length;
      }

      return {
        sources_considered: rows.length,
        links_scanned: linksScanned,
        links_soft_pruned: linksSoftPruned,
      };
    } catch (e: any) {
      debugLog("[SupabaseStorage] summarizeWeakLinks fallback failed: " + e.message);
      return {
        sources_considered: 0,
        links_scanned: 0,
        links_soft_pruned: 0,
      };
    }
  }


  async findKeywordOverlapEntries(
    excludeId: string,
    project: string,
    keywords: string[],
    userId: string,
    minSharedKeywords?: number,
    limit?: number,
  ): Promise<Array<{ id: string; shared_count: number }>> {
    const SHORT_KW_ALLOWLIST = new Set(["c", "go", "r", "os", "vm", "ui", "ai", "ml", "db", "ts", "js", "rx"]);
    const validKeywords = keywords.filter(k =>
      k && typeof k === 'string' &&
      (k.length > 2 || SHORT_KW_ALLOWLIST.has(k.toLowerCase()))
    );
    if (validKeywords.length === 0) return [];

    try {
      const result = await supabaseRpc("find_keyword_overlap_entries", {
        p_exclude_id: excludeId,
        p_project: project,
        p_keywords: validKeywords,
        p_user_id: userId,
        p_min_shared_keywords: minSharedKeywords ?? 3,
        p_limit: limit ?? 10
      });

      const rows = Array.isArray(result) ? result : [];
      return rows.map((r: any) => ({
        id: r.id,
        shared_count: Number(r.shared_count)
      }));
    } catch (e: any) {
      debugLog("[SupabaseStorage] findKeywordOverlapEntries failed: " + e.message);
      return [];
    }
  }

  async backfillLinks(project: string): Promise<{ temporal: number; keyword: number; provenance: number }> {
    try {
      const result = await supabaseRpc("prism_backfill_links", {
        p_project: project
      });
      const parsed = Array.isArray(result) ? result[0] : result;
      return { 
        temporal: Number(parsed?.temporal || 0), 
        keyword: Number(parsed?.keyword || 0), 
        provenance: Number(parsed?.provenance || 0) 
      };
    } catch (e: any) {
      debugLog("[SupabaseStorage] backfillLinks failed: " + e.message);
      return { temporal: 0, keyword: 0, provenance: 0 };
    }
  }

  // ─── v7.0: ACT-R Access Log (Supabase Parity) ───────────────
  //
  // Implements the same StorageBackend contract as SQLite:
  //   - logAccess: fire-and-forget write
  //   - getAccessLog: batch top-N timestamps per entry
  //   - pruneAccessLog: retention delete count
  //
  // All operations route through SECURITY DEFINER RPCs for tenant-safe access.

  logAccess(entryId: string, contextHash?: string): void {
    supabaseRpc("prism_log_access", {
      p_user_id: PRISM_USER_ID,
      p_entry_id: entryId,
      p_accessed_at: new Date().toISOString(),
      p_context_hash: contextHash || null,
    }).catch((e: any) => {
      debugLog(`[SupabaseStorage] logAccess fallback/no-op: ${e.message}`);
    });
  }

  async getAccessLog(
    entryIds: string[],
    maxPerEntry: number = 50
  ): Promise<Map<string, Date[]>> {
    const result = new Map<string, Date[]>();
    if (!entryIds || entryIds.length === 0) return result;

    try {
      const rows = await supabaseRpc("prism_get_access_log", {
        p_user_id: PRISM_USER_ID,
        p_entry_ids: entryIds,
        p_max_per_entry: maxPerEntry,
      });

      const data = Array.isArray(rows) ? rows : [];
      for (const row of data as any[]) {
        const entryId = row.entry_id as string | undefined;
        const accessedAtRaw = row.accessed_at as string | undefined;
        if (!entryId || !accessedAtRaw) continue;

        if (!result.has(entryId)) result.set(entryId, []);
        result.get(entryId)!.push(new Date(accessedAtRaw));
      }

      return result;
    } catch (e: any) {
      debugLog(`[SupabaseStorage] getAccessLog fallback/no-op: ${e.message}`);
      return result;
    }
  }

  async pruneAccessLog(olderThanDays: number): Promise<number> {
    try {
      const rpcResult = await supabaseRpc("prism_prune_access_log", {
        p_older_than_days: olderThanDays,
      });

      if (typeof rpcResult === "number") return rpcResult;
      if (Array.isArray(rpcResult) && rpcResult.length > 0) {
        const first = rpcResult[0] as any;
        if (typeof first === "number") return first;
        if (first && typeof first.deleted_count !== "undefined") {
          return Number(first.deleted_count) || 0;
        }
        if (first && typeof first.prism_prune_access_log !== "undefined") {
          return Number(first.prism_prune_access_log) || 0;
        }
      }
      if (rpcResult && typeof (rpcResult as any).prism_prune_access_log !== "undefined") {
        return Number((rpcResult as any).prism_prune_access_log) || 0;
      }

      return 0;
    } catch (e: any) {
      debugLog(`[SupabaseStorage] pruneAccessLog fallback/no-op: ${e.message}`);
      return 0;
    }
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

    try {
      await supabasePost(
        "dark_factory_pipelines",
        {
          id: updatedState.id,
          project: updatedState.project,
          user_id: updatedState.user_id,
          status: updatedState.status,
          current_step: updatedState.current_step,
          iteration: updatedState.iteration,
          started_at: updatedState.started_at,
          updated_at: updatedState.updated_at,
          spec: updatedState.spec,
          error: updatedState.error || null,
          last_heartbeat: updatedState.last_heartbeat || null,
          // ─── v7.4: Adversarial Evaluation fields ───
          eval_revisions: updatedState.eval_revisions ?? 0,
          contract_payload: updatedState.contract_payload
            ? JSON.stringify(updatedState.contract_payload)
            : null,
          notes: updatedState.notes || null,
        },
        { on_conflict: "id" },
        { Prefer: "return=minimal,resolution=merge-duplicates" }
      );
    } catch (e: any) {
      // PGRST202 fallback if the table doesn't exist yet
      if (e.message?.includes("PGRST202") || e.message?.includes("Could not find the relation")) {
        debugLog("[SupabaseStorage] dark_factory_pipelines missing — please run migration 038");
        return;
      }
      throw e;
    }
  }

  async getPipeline(id: string, userId: string): Promise<PipelineState | null> {
    try {
      const result = await supabaseGet("dark_factory_pipelines", {
        id: `eq.${id}`,
        user_id: `eq.${userId}`,
        limit: "1"
      });
      const rows = Array.isArray(result) ? result : [];
      if (rows.length === 0) return null;
      const row = rows[0] as any;
      // ─── v7.4: Deserialize contract_payload from JSON TEXT ───
      if (row.contract_payload && typeof row.contract_payload === "string") {
        try { row.contract_payload = JSON.parse(row.contract_payload); } catch { /* leave as-is */ }
      }
      return row as unknown as PipelineState;
    } catch (e: any) {
      if (e.message?.includes("PGRST202") || e.message?.includes("Could not find the relation")) return null;
      throw e;
    }
  }

  async listPipelines(project: string | undefined, status: PipelineStatus | undefined, userId: string): Promise<PipelineState[]> {
    try {
      const query: Record<string, string> = {
        user_id: `eq.${userId}`,
        order: "updated_at.desc"
      };
      if (project) query.project = `eq.${project}`;
      if (status) query.status = `eq.${status}`;
      
      const result = await supabaseGet("dark_factory_pipelines", query);
      const rows = (Array.isArray(result) ? result : []) as any[];
      // ─── v7.4: Deserialize contract_payload from JSON TEXT ───
      return rows.map(row => {
        if (row.contract_payload && typeof row.contract_payload === "string") {
          try { row.contract_payload = JSON.parse(row.contract_payload); } catch { /* leave as-is */ }
        }
        return row;
      }) as unknown as PipelineState[];
    } catch (e: any) {
      if (e.message?.includes("PGRST202") || e.message?.includes("Could not find the relation")) return [];
      throw e;
    }
  }

  // ─── Verification Harness (v7.2.0) ───────────────────────────

  async saveVerificationHarness(harness: VerificationHarness, userId: string): Promise<void> {
    try {
      await supabasePost(
        "verification_harnesses",
        {
          rubric_hash: harness.rubric_hash,
          project: harness.project,
          conversation_id: harness.conversation_id,
          created_at: harness.created_at,
          min_pass_rate: harness.min_pass_rate,
          tests: JSON.stringify(harness.tests),
          metadata: harness.metadata ? JSON.stringify(harness.metadata) : null,
          user_id: userId
        },
        { on_conflict: "rubric_hash" },
        { Prefer: "return=representation,resolution=merge-duplicates" }
      );
    } catch (e: any) {
      if (e.message?.includes("PGRST116") || e.message?.includes("duplicate key")) {
        return;
      }
      throw e;
    }
  }

  async getVerificationHarness(rubric_hash: string, userId: string): Promise<VerificationHarness | null> {
    try {
      const rows = await supabaseGet("verification_harnesses", {
        "rubric_hash": `eq.${rubric_hash}`,
        "user_id": `eq.${userId}`
      });
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const row = rows[0] as any;
      return {
        ...row,
        tests: JSON.parse(row.tests),
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined
      } as VerificationHarness;
    } catch (e: any) {
      if (e.message?.includes("PGRST202") || e.message?.includes("Could not find the relation")) return null;
      throw e;
    }
  }

  async saveVerificationRun(result: ValidationResult, userId: string): Promise<void> {
    try {
      await supabasePost(
        "verification_runs",
        {
          id: result.id,
          rubric_hash: result.rubric_hash,
          project: result.project,
          conversation_id: result.conversation_id,
          run_at: result.run_at,
          // H2 fix: Use native booleans for Supabase/PostgreSQL (not 0/1 integers)
          passed: result.passed,
          pass_rate: result.pass_rate,
          critical_failures: result.critical_failures,
          coverage_score: result.coverage_score,
          result_json: result.result_json,
          gate_action: result.gate_action,
          gate_override: result.gate_override ?? false,
          override_reason: result.override_reason || null,
          user_id: userId
        },
        { on_conflict: "id" },
        { Prefer: "return=representation,resolution=ignore-duplicates" }
      );
    } catch (e: any) {
      if (e.message?.includes("PGRST116") || e.message?.includes("duplicate key")) {
        return;
      }
      throw e;
    }
  }

  async listVerificationRuns(project: string, userId: string): Promise<ValidationResult[]> {
    try {
      const query: Record<string, string> = {
        project: `eq.${project}`,
        user_id: `eq.${userId}`,
        order: "run_at.desc"
      };
      const rows = await supabaseGet("verification_runs", query);
      if (!Array.isArray(rows)) return [];
      return rows.map((row: any) => ({
        ...row,
        passed: Boolean(row.passed),
        // H2 fix: Use Boolean() consistently (native booleans from Supabase)
        gate_override: Boolean(row.gate_override),
        override_reason: row.override_reason || undefined
      })) as unknown as ValidationResult[];
    } catch (e: any) {
      if (e.message?.includes("PGRST202") || e.message?.includes("Could not find the relation")) return [];
      throw e;
    }
  }

  async getVerificationRun(id: string, userId: string): Promise<ValidationResult | null> {
    try {
      const rows = await supabaseGet("verification_runs", {
        id: `eq.${id}`,
        user_id: `eq.${userId}`
      });
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const row = rows[0] as any;
      return {
        ...row,
        passed: Boolean(row.passed),
        // H2 fix: Use Boolean() consistently (native booleans from Supabase)
        gate_override: Boolean(row.gate_override),
        override_reason: row.override_reason || undefined
      } as ValidationResult;
    } catch (e: any) {
      if (e.message?.includes("PGRST202") || e.message?.includes("Could not find the relation")) return null;
      throw e;
    }
  }

  // ─── v7.5: Semantic Consolidation ────────────────────────────────

  async upsertSemanticKnowledge(data: {
    project: string;
    concept: string;
    description: string;
    related_entities?: string[];
    userId?: string;
  }): Promise<string> {
    const userId = data.userId || PRISM_USER_ID;
    
    // Check if concept already exists
    const existing = await supabaseGet("semantic_knowledge", {
      project: `eq.${data.project}`,
      concept: `eq.${data.concept}`,
      select: "id,instances,confidence",
      limit: "1"
    });

    const rows = Array.isArray(existing) ? existing : [];

    if (rows.length > 0) {
      const row = rows[0] as any;
      const newConfidence = Math.min(1.0, (row.confidence || 0) + 0.1);
      const newInstances = (row.instances || 0) + 1;
      
      await supabasePatch("semantic_knowledge", {
        instances: newInstances,
        confidence: newConfidence,
        updated_at: new Date().toISOString()
      }, {
        id: `eq.${row.id}`
      });
      return row.id;
    } else {
      const id = crypto.randomUUID();
      await supabasePost("semantic_knowledge", {
        id,
        project: data.project,
        user_id: userId,
        concept: data.concept,
        description: data.description,
        confidence: 0.5,
        instances: 1,
        related_entities: data.related_entities ? JSON.stringify(data.related_entities) : "[]",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      return id;
    }
  }
}

