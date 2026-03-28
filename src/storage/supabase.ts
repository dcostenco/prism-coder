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
} from "./interface.js";

import { debugLog } from "../utils/logger.js";
import { getSetting as cfgGet, setSetting as cfgSet, getAllSettings as cfgGetAll } from "./configStorage.js";
import { runAutoMigrations } from "./supabaseMigrations.js";

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
    };

    return supabasePost("session_ledger", record);
  }

  async patchLedger(id: string, data: Record<string, unknown>): Promise<void> {
    await supabasePatch("session_ledger", data, { id: `eq.${id}` });
  }

  async getLedgerEntries(params: Record<string, string>): Promise<unknown[]> {
    const result = await supabaseGet("session_ledger", params);
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

  // ─── Handoff Operations ────────────────────────────────────

  async saveHandoff(
    handoff: HandoffEntry,
    expectedVersion?: number | null
  ): Promise<SaveHandoffResult> {
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
    const result = await supabaseRpc("get_session_context", {
      p_project: project,
      p_level: level,
      p_user_id: userId,
      p_role: role || "global",  // v3.0: pass role to RPC
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
    role?: string | null;  // v3.0: optional role filter
  }): Promise<KnowledgeSearchResult | null> {
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
    role?: string | null;  // v3.0: optional role filter
  }): Promise<SemanticSearchResult[]> {
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
      console.error(`[SupabaseStorage] Failed to get handoff at version ${version}: ${err}`);
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

  async loadSdmState(project: string): Promise<Float32Array | null> {
    throw new Error("loading SDM state is not implemented for Supabase backend yet.");
  }

  async saveSdmState(project: string, state: Float32Array): Promise<void> {
    throw new Error("saving SDM state is not implemented for Supabase backend yet.");
  }

  async getAllProjectEmbeddings(project: string): Promise<Array<{ id: string, summary: string, embedding_compressed: string }>> {
    throw new Error("getting compressed embeddings for Hamming scan is not implemented for Supabase backend yet.");
  }

}

