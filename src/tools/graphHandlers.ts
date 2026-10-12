
import { formatRulesBlock, applySentinelBlock, SENTINEL_START, SENTINEL_END, REDACT_PATTERNS } from "./commonHelpers.js";
/**
 * Session Memory Handlers (v2.0 — StorageBackend Refactor)
 *
 * ═══════════════════════════════════════════════════════════════════
 * v2.0 CHANGES IN THIS FILE (Step 1: Pure Refactor)
 *
 * BEFORE: All handlers called supabasePost/Get/Rpc/Patch/Delete directly.
 * AFTER:  All handlers call StorageBackend methods via `getStorage()`.
 *
 * This refactor changes ZERO behavior. Every method call maps 1:1 to
 * the same Supabase API call (see src/storage/supabase.ts for mapping).
 *
 * WHY: This enables Step 2 (SQLite local mode) — once SqliteStorage
 * implements the same interface, the handlers work with both backends
 * without any code changes.
 * ═══════════════════════════════════════════════════════════════════
 */

import { debugLog } from "../utils/logger.js";
import { recordCognitiveRoute } from "../observability/graphMetrics.js";
import { getStorage } from "../storage/index.js";
import { toKeywordArray } from "../utils/keywordExtractor.js";
import { getEmbeddingProvider, getLLMProvider } from "../utils/llm/factory.js";
import { getCurrentGitState, getGitDrift } from "../utils/git.js";
import { getSetting, getAllSettings } from "../storage/configStorage.js";
import { mergeHandoff, dbToHandoffSchema, sanitizeForMerge } from "../utils/crdtMerge.js";

// ─── Phase 1: Explainability & Memory Lineage ────────────────
// These utilities provide structured tracing metadata for search operations.
// When `enable_trace: true` is passed to session_search_memory or knowledge_search,
// a separate MCP content block (content[1]) is returned with a MemoryTrace object
// containing: strategy, scores, latency breakdown (embedding/storage/total), and metadata.
// See src/utils/tracing.ts for full type definitions and design decisions.
import { createMemoryTrace, traceToContentBlock } from "../utils/tracing.js";
import { PRISM_USER_ID, PRISM_AUTO_CAPTURE, PRISM_CAPTURE_PORTS } from "../config.js";
import { captureLocalEnvironment } from "../utils/autoCapture.js";
import { fireCaptionAsync } from "../utils/imageCaptioner.js";
import {
  isSessionSaveLedgerArgs,
  isSessionSaveHandoffArgs,
  isSessionLoadContextArgs,
  isKnowledgeSearchArgs,
  isKnowledgeForgetArgs,
  isSessionSearchMemoryArgs,
  isBackfillEmbeddingsArgs,
  isMemoryHistoryArgs,
  isMemoryCheckoutArgs,
  isSessionHealthCheckArgs,        // v2.2.0: health check type guard
  isSessionForgetMemoryArgs,       // Phase 2: GDPR-compliant memory deletion type guard
  isKnowledgeSetRetentionArgs,     // v3.1: TTL retention policy type guard
  // v4.0: Active Behavioral Memory type guards
  isSessionSaveExperienceArgs,
  isKnowledgeVoteArgs,
  // v4.2: Sync Rules type guard
  isKnowledgeSyncRulesArgs,
  // v5.1: Deep Storage Mode type guard
  isDeepStoragePurgeArgs,
  isSessionIntuitiveRecallArgs,
  isSessionSynthesizeEdgesArgs,
  SESSION_SYNTHESIS_MAX_ENTRIES,
  SESSION_SYNTHESIS_MAX_NEIGHBORS_PER_ENTRY,
  isSessionCognitiveRouteArgs,
} from "./sessionMemoryDefinitions.js";

// v4.2: File system access for knowledge_sync_rules
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve, isAbsolute, sep, relative } from "node:path";

// v3.1: In-memory debounce lock for auto-compaction.
// Prevents multiple concurrent Gemini compaction tasks for the same project
// when many agents call session_save_ledger at the same time.
const activeCompactions = new Set<string>();


// ─── v0.4.0: Import server type for resource notifications ───
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { notifyResourceUpdate } from "../server.js";

// ─── Save Ledger Handler ──────────────────────────────────────

/**
 * Appends an immutable session log entry.
 *
 * Think of the ledger as a "commit log" for agent work — once written, entries
 * are never modified. This creates a permanent audit trail of all work done.
 *
 * After saving, generates an embedding vector for the entry via fire-and-forget.
 */
import { computeEffectiveImportance, recordMemoryAccess } from "../utils/cognitiveMemory.js";
import {
  baseLevelActivation,
  candidateScopedSpreadingActivation,
  compositeRetrievalScore,
} from "../utils/actrActivation.js";
import {
  PRISM_ACTR_DECAY,
  PRISM_ACTR_WEIGHT_SIMILARITY,
  PRISM_ACTR_WEIGHT_ACTIVATION,
  PRISM_ACTR_SIGMOID_MIDPOINT,
  PRISM_ACTR_SIGMOID_STEEPNESS,
  PRISM_ACTR_MAX_ACCESSES_PER_ENTRY,
} from "../config.js";
import { isActrEnabled } from "../utils/actrEnablement.js";
import { createHash } from "node:crypto";
import { HdcStateMachine } from "../sdm/stateMachine.js";
import { ConceptDictionary } from "../sdm/conceptDictionary.js";
import { PolicyGateway } from "../sdm/policyGateway.js";
import { getSdmEngine } from "../sdm/sdmEngine.js";
import {
  PRISM_HDC_ENABLED,
  PRISM_HDC_EXPLAINABILITY_ENABLED,
  PRISM_HDC_POLICY_FALLBACK_THRESHOLD,
  PRISM_HDC_POLICY_CLARIFY_THRESHOLD,
} from "../config.js";

/**
 * Header line for knowledge_search results.
 *
 * A 'relaxed' match_mode means no entry matched every query term — the portal
 * widened the search and returned the closest entries. Wording those the same
 * as an exact hit is how a best-effort guess gets read as a confirmed answer,
 * so the distinction is stated in the text the agent actually sees.
 *
 * Exported so the wording is covered by a test that exercises this function
 * rather than a copy of it.
 */
export function formatKnowledgeHeader(
  resultCount: number,
  matchMode?: string,
): string {
  if (matchMode === "relaxed") {
    return `🧠 No exact match. ${resultCount} closest ${resultCount === 1 ? "entry" : "entries"} ` +
      `(widened search — treat as leads, not confirmed answers):`;
  }
  return `🧠 Found ${resultCount} knowledge entries:`;
}


/**
 * Header + per-hit scoring for session_search_memory results.
 *
 * Exported so wording is covered by tests that call the shipped functions —
 * a lesson from the knowledge_search match_mode fix, whose first tests
 * mirrored the logic and would have passed while the handler regressed.
 *
 * Hybrid detection is per-row: portal fusion (weighted RRF, measured 59%
 * blind hit@1 vs 45% semantic-only) annotates each row with semantic_rank /
 * lexical_rank. Any row carrying lexical_rank means the lexical arm ran, so
 * calling the results "semantically similar" would misstate how they were
 * found — and a lexical-only rescue has NO similarity score at all, which
 * previously rendered as "N/A similar".
 */
export function isHybridSearchResults(results: unknown[]): boolean {
  return results.some((r) => (r as any)?.lexical_rank !== undefined && (r as any)?.lexical_rank !== null);
}

export function searchResultsHeader(count: number, hybrid: boolean): string {
  return hybrid
    ? `🧠 Found ${count} matching sessions (hybrid retrieval — semantic meaning + exact terms):`
    : `🧠 Found ${count} semantically similar sessions:`;
}

export function formatHitScore(r: any): string {
  const sim = typeof r.similarity === "number" ? `${(r.similarity * 100).toFixed(1)}% similar` : null;
  const sem = r.semantic_rank !== undefined && r.semantic_rank !== null ? `sem#${r.semantic_rank + 1}` : null;
  const lex = r.lexical_rank !== undefined && r.lexical_rank !== null ? `lex#${r.lexical_rank + 1}` : null;
  if (sem || lex) {
    const arms = [sem, lex].filter(Boolean).join(" + ");
    return sim ? `${sim} (${arms})` : `exact-term match (${arms})`;
  }
  return sim ?? "N/A similar";
}

export async function knowledgeSearchHandler(args: unknown) {
  if (!isKnowledgeSearchArgs(args)) {
    throw new Error("Invalid arguments for knowledge_search");
  }

  // Phase 1: destructure enable_trace (defaults to false for backward compat)
  const { project, query, category, limit = 10, enable_trace = false, activation } = args as any;

  debugLog(`[knowledge_search] Searching: project=${project || "all"}, query_chars=${query?.length || 0}, category=${category || "any"}, limit=${limit}`);


  // Phase 1: Capture total start time for latency measurement
  const totalStart = performance.now();
  const storage = await getStorage();

  // NOTE: do NOT auto-derive keywords from the free-text query. The portal
  // applies keywords as a hard .overlaps() AND-filter; deriving them from
  // the query (via toKeywordArray) turns "BFCL" into keywords=['bfcl']
  // which excludes every row whose keywords[] column doesn't contain
  // 'bfcl' — even when the summary clearly matches "BFCL" via textSearch.
  // Free-text search must rely on textSearch alone. Callers who want a
  // keyword overlap filter should pass keywords explicitly via a future
  // input-schema field, not via implicit extraction.

  // Phase 1: Capture storage-specific start time to isolate DB latency
  // from keyword extraction and other overhead
  const storageStart = performance.now();
  const data = await storage.searchKnowledge({
    project: project || null,
    keywords: [],
    category: category || null,
    queryText: query || null,
    limit: Math.min(limit, 50),
    userId: PRISM_USER_ID,
    activation,
  });
  const storageMs = performance.now() - storageStart;
  const totalMs = performance.now() - totalStart;

  const resultCount = Array.isArray(data?.results) ? data.results.length : 0;
  if (!data || resultCount === 0) {
    // Phase 1: Use contentBlocks array instead of inline object
    // so we can conditionally push the trace block at content[1]
    const contentBlocks: Array<{ type: string; text: string }> = [{
      type: "text",
      text: `🔍 No knowledge found matching your search.\n` +
        (query ? `Query: "${query}"\n` : "") +
        (category ? `Category: ${category}\n` : "") +
        (project ? `Project: ${project}\n` : "") +
        `\nTip: Try session_search_memory for semantic (meaning-based) search ` +
        `if keyword search doesn't find what you need.`,
    }];

    // Phase 1: Append trace block even on empty results — this tells
    // the developer the search DID execute, it just found nothing.
    // topScore and threshold are null for keyword search (no scoring system).
    if (enable_trace) {
      const trace = createMemoryTrace({
        strategy: "keyword",
        query: query || "",
        resultCount: 0,
        topScore: null,     // keyword search doesn't produce similarity scores
        threshold: null,     // keyword search has no threshold concept
        embeddingMs: 0,      // no embedding needed for keyword search
        storageMs,
        totalMs,
        project: project || null,
      });
      contentBlocks.push(traceToContentBlock(trace));
    }

    return { content: contentBlocks, isError: false };
  }

  if (data.results && Array.isArray(data.results)) {

    const resultIds = data.results.map((r: any) => r.id).filter(Boolean);
    if (resultIds.length > 0) {
      recordMemoryAccess(resultIds);
    }

    // Mutate results to surface effective importance
    for (const r of data.results as any[]) {
      if (typeof r.importance === 'number' && r.importance > 0) {
        r.effective_importance = computeEffectiveImportance(r.importance, r.last_accessed_at, r.created_at, Boolean(r.is_rollup));
      }
    }
  }

  // Phase 1: Wrap in contentBlocks array for optional trace attachment
  const contentBlocks: Array<{ type: string; text: string }> = [{
    type: "text",
    text: `${formatKnowledgeHeader(resultCount, data.match_mode)}\n\n${JSON.stringify(data.results, null, 2)}`,
  }];

  // Phase 1: Attach MemoryTrace with strategy="keyword" and timing data
  if (enable_trace) {
    const trace = createMemoryTrace({
      strategy: "keyword",
      query: query || "",
      resultCount,
      topScore: null,       // keyword search doesn't produce similarity scores
      threshold: null,       // keyword search has no threshold concept
      embeddingMs: 0,        // no embedding needed for keyword search
      storageMs,
      totalMs,
      project: project || null,
    });
    contentBlocks.push(traceToContentBlock(trace));
  }

  // ── v6.0 Phase 3: 1-Hop Graph Expansion ──────────────────
  // Same pattern as sessionSearchMemoryHandler:
  // Traverse outbound links from direct hits to find associated memories.
  // Graph-expanded results are BONUS — don't consume limit slots.
  try {
    // Extract IDs from the knowledge search results
    const directIds = new Set<string>();
    if (data.results && Array.isArray(data.results)) {
      for (const entry of data.results) {
        if ((entry as any)?.id) directIds.add((entry as any).id);
      }
    }

    if (directIds.size > 0) {
      const enrichedIds = new Set<string>();
      const maxGraphResults = Math.min(limit, 10);

      for (const directId of directIds) {
        if (enrichedIds.size >= maxGraphResults) break;
        const links = await storage.getLinksFrom(directId, PRISM_USER_ID, 0.3, 5);
        for (const link of links) {
          if (!directIds.has(link.target_id) && !enrichedIds.has(link.target_id)) {
            enrichedIds.add(link.target_id);
            if (enrichedIds.size >= maxGraphResults) break;
          }
        }
      }

      if (enrichedIds.size > 0) {
        const enrichedEntries = await storage.getLedgerEntries({
          user_id: `eq.${PRISM_USER_ID}`,
          ids: [...enrichedIds],
          select: "id,summary,project,created_at",
        });

        if (enrichedEntries.length > 0) {
          const graphFormatted = enrichedEntries.map((e: any) =>
            `[🔗] ${e.created_at?.split("T")[0] || "unknown"} — ${e.project || "unknown"}\n` +
            `  Summary: ${e.summary}`
          ).join("\n");

          contentBlocks[0] = {
            type: "text",
            text: contentBlocks[0].text +
              `\n\n🔗 Graph-connected memories (${enrichedEntries.length} via 1-hop expansion):\n\n${graphFormatted}`,
          };

          // Fire-and-forget: reinforce traversed links
          for (const directId of directIds) {
            storage.getLinksFrom(directId, PRISM_USER_ID, 0.3, 5)
              .then(links => {
                for (const link of links) {
                  if (enrichedIds.has(link.target_id)) {
                    storage.reinforceLink(directId, link.target_id, link.link_type).catch(() => {});
                  }
                }
              })
              .catch(() => {});
          }
        }
      }
    }
  } catch (graphErr) {
    debugLog(`[knowledge_search] Graph expansion failed (non-fatal): ${graphErr instanceof Error ? graphErr.message : String(graphErr)}`);
  }

  // Machine-readable evidence snippets for direct pass-through to prism_infer
  if (data.results && Array.isArray(data.results) && (data.results as any[]).length > 0) {
    const evidenceSnippets = (data.results as any[]).map((r: any, i: number) => ({
      source: `knowledge_search:${r.id ?? i}`,
      // Carry the record date. Without it a two-year-old note and yesterday's
      // are indistinguishable in the grounding evidence, so a stale memory is
      // cited with the same confidence as a fresh one — local storage removes
      // the external correction pressure that would otherwise catch it.
      // session_date first: it is when the work HAPPENED, which is what a
      // staleness signal needs. created_at is when the row was written and is
      // assigned on save — it cannot be backdated, so an import would stamp
      // every migrated memory as brand new, failing silently toward "fresh".
      // sqlite.ts already treats session_date as authoritative.
      recorded: r.session_date ?? r.created_at ?? r.updated_at ?? r.timestamp ?? undefined,
      content: (r.content ?? r.summary ?? r.text ?? "").slice(0, 1000),
    })).filter((s: any) => s.content);
    if (evidenceSnippets.length > 0) {
      contentBlocks.push({ type: "text", text: JSON.stringify({ evidence_snippets: evidenceSnippets }) });
    }
  }

  return { content: contentBlocks, isError: false };
}

export async function knowledgeForgetHandler(args: unknown) {
  if (!isKnowledgeForgetArgs(args)) {
    throw new Error("Invalid arguments for knowledge_forget");
  }

  const {
    project,
    category,
    older_than_days,
    clear_handoff = false,
    confirm_all = false,
    dry_run = false,
  } = args;

  if (!project && !confirm_all) {
    return {
      content: [{
        type: "text",
        text: `⚠️ Safety check: You must specify a 'project' to forget, ` +
          `or set 'confirm_all: true' to wipe all entries.\n` +
          `This prevents accidental deletion of all knowledge.`,
      }],
      isError: true,
    };
  }

  debugLog(`[knowledge_forget] ${dry_run ? "DRY RUN: " : ""}Forgetting: ` +
    `project=${project || "ALL"}, category=${category || "any"}, ` +
    `older_than=${older_than_days || "any"}d, clear_handoff=${clear_handoff}`);

  const storage = await getStorage();

  const ledgerParams: Record<string, string> = {};
  ledgerParams.user_id = `eq.${PRISM_USER_ID}`;
  if (project) {
    ledgerParams.project = `eq.${project}`;
  }
  if (category) {
    ledgerParams.keywords = `cs.{cat:${category}}`;
  }
  if (older_than_days) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - older_than_days);
    ledgerParams.created_at = `lt.${cutoffDate.toISOString()}`;
  }

  let ledgerCount = 0;
  let handoffCleared = false;

  if (dry_run) {
    const selectParams = { ...ledgerParams, select: "id" };
    const entries = await storage.getLedgerEntries(selectParams);
    ledgerCount = entries.length;
  } else {
    const result = await storage.deleteLedger(ledgerParams);
    ledgerCount = result.length;

    if (clear_handoff && project) {
      await storage.deleteHandoff(project, PRISM_USER_ID);
      handoffCleared = true;
    }
  }

  const action = dry_run ? "would be forgotten" : "forgotten";
  const emoji = dry_run ? "🔍" : "🧹";

  return {
    content: [{
      type: "text",
      text: `${emoji} ${ledgerCount} ledger entries ${action}` +
        (project ? ` for project "${project}"` : "") +
        (category ? ` in category "${category}"` : "") +
        (older_than_days ? ` older than ${older_than_days} days` : "") +
        `.\n` +
        (handoffCleared ? `🗑️ Handoff state also cleared for "${project}".\n` : "") +
        (dry_run ? `\n💡 This was a dry run — nothing was actually deleted. Remove dry_run to execute.` : "") +
        (!dry_run && ledgerCount > 0 ? `\n✅ Knowledge base pruned. Fresh start!` : ""),
    }],
    isError: false,
  };
}

export async function sessionSearchMemoryHandler(args: unknown) {
  if (!isSessionSearchMemoryArgs(args)) {
    throw new Error("Invalid arguments for session_search_memory");
  }

  const {
    query,
    project,
    limit = 5,
    similarity_threshold = 0.7,
    // Phase 1: enable_trace defaults to false for full backward compatibility.
    // When true, a MemoryTrace JSON block is appended as content[1].
    enable_trace = false,
    // v5.2: Context-Weighted Retrieval — biases search toward active work context
    context_boost = false,
    activation,
  } = args as any;

  debugLog(
    `[session_search_memory] Semantic search: queryHash=${createHash("sha256").update(query).digest("hex")}, ` +
    `project=${project || "all"}, limit=${limit}, threshold=${similarity_threshold}` +
    `${context_boost ? ", context_boost=ON" : ""}`
  );

  // Phase 1: Start total latency timer BEFORE any work (embedding + storage)
  const totalStart = performance.now();

  // Step 1: Generate embedding for the search query
  let queryEmbedding: number[];
  let storage: Awaited<ReturnType<typeof getStorage>>;
  // Phase 1: Start embedding latency timer — isolates Gemini API call time.
  // This is the most variable component: 50ms on a good day, 2000ms under load.
  const embeddingStart = performance.now();

  // ── v5.2: Context-Weighted Retrieval ───────────────────────────
  // When context_boost is enabled, prepend active project context to the
  // search query before embedding generation. This naturally biases the
  // embedding vector toward memories from the same project/branch/context.
  // Elegant: no scoring heuristics needed — semantics do the work.
  let effectiveQuery = query;
  if (context_boost && project) {
    try {
      const storage = await getStorage();
      const ctx = await storage.loadContext(project, "quick", PRISM_USER_ID);
      const contextParts: string[] = [];
      if (ctx && typeof ctx === "object") {
        const ctxObj = ctx as Record<string, unknown>;
        if (ctxObj.active_branch) contextParts.push(`branch: ${ctxObj.active_branch}`);
        if (ctxObj.key_context) contextParts.push(`context: ${String(ctxObj.key_context).substring(0, 200)}`);
        const keywords = ctxObj.keywords as string[] | undefined;
        if (keywords?.length) contextParts.push(`keywords: ${keywords.slice(0, 5).join(", ")}`);
      }
      if (contextParts.length > 0) {
        effectiveQuery = `[${contextParts.join("; ")}] ${query}`;
        debugLog(`[session_search_memory] Context boost applied (${effectiveQuery.length} characters)`);
      }
    } catch {
      // Context load failed — proceed with unmodified query (graceful degradation)
      debugLog("[session_search_memory] Context boost failed (non-fatal) — using original query");
    }
  } else if (context_boost && !project) {
    // User enabled context_boost but didn't specify a project — can't boost without context
    debugLog("[session_search_memory] context_boost ignored — requires a project parameter to load context");
  }

  try {
    // Resolve auto storage before provider selection so a cloud brain uses
    // Portal-mediated embeddings even when context_boost is disabled.
    storage = await getStorage();
    queryEmbedding = await getEmbeddingProvider().generateEmbedding(effectiveQuery);
  } catch (err) {
    return {
      content: [{
        type: "text",
        text: `❌ Failed to generate embedding for query: ${err instanceof Error ? err.message : String(err)}\n\n` +
          `💡 Try knowledge_search (keyword-based) as a fallback.`,
      }],
      isError: true,
    };
  }
  // Phase 1: Capture embedding API latency
  const embeddingMs = performance.now() - embeddingStart;

  // Step 2: Search via storage backend
  try {
    // Phase 1: Start storage latency timer — isolates DB query time.
    // For Supabase: this measures the pgvector cosine distance RPC call.
    // For SQLite: this measures the local sqlite-vec similarity search.
    const storageStart = performance.now();
    // v7.0: Over-fetch candidates to give ACT-R re-ranker a meaningful pool.
    // If we only fetch `limit` rows, the re-ranker can only shuffle those exact
    // results — a memory at rank #(limit+1) by similarity but accessed 500 times
    // would never surface. Fetch 4× or minimum 20, then slice after re-ranking.
    const actrEnabled = isActrEnabled();
    const candidateLimit = actrEnabled
      ? Math.min(Math.max(limit * 4, 20), 50)
      : Math.min(limit, 20);
    const results = await storage.searchMemory({
      queryEmbedding: JSON.stringify(queryEmbedding),
      // Portal-backed installs fuse this with lexical search (weighted RRF).
      queryText: query,
      project: project || null,
      limit: candidateLimit,
      similarityThreshold: similarity_threshold,
      userId: PRISM_USER_ID,
      activation,
    });
    // Phase 1: Capture storage query latency and compute total
    const storageMs = performance.now() - storageStart;
    const totalMs = performance.now() - totalStart;

    if (results.length === 0) {
      // Phase 1: Use contentBlocks array so we can optionally push trace at [1]
      const contentBlocks: Array<{ type: string; text: string }> = [{
        type: "text",
        text: `🔍 No semantically similar sessions found for: "${query}"\n` +
          (project ? `Project: ${project}\n` : "") +
          `Similarity threshold: ${similarity_threshold}\n\n` +
          `Tips:\n` +
          `• Lower the similarity_threshold (e.g., 0.5) for broader results\n` +
          `• Try knowledge_search for keyword-based matching\n` +
          `• Ensure sessions have been saved with embeddings (requires a configured embedding provider)`,
      }];

      // Phase 1: Trace is still valuable on empty results — it proves the search
      // executed and reveals whether the bottleneck was embedding or storage.
      if (enable_trace) {
        const trace = createMemoryTrace({
          strategy: "semantic",
          query,
          resultCount: 0,
          topScore: null,          // no results = no top score
          threshold: similarity_threshold,
          embeddingMs,
          storageMs,
          totalMs,
          project: project || null,
        });
        contentBlocks.push(traceToContentBlock(trace));
      }

      return { content: contentBlocks, isError: false };
    }

    // ── v7.0: ACT-R Re-Ranking Pipeline ──────────────────────────
    const resultIds = results.map((r: any) => r.id).filter(Boolean);
    const policyCandidates = [...results].sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0)).slice(0, limit);
    const now = new Date();

    // Accumulate ACT-R metrics for trace output
    let actrMetrics: {
      baseLevels: number[];
      spreadings: number[];
      sigmoids: number[];
      composites: number[];
    } | null = null;

    if (actrEnabled && resultIds.length > 0) {
      try {
        // Step A: Bulk-fetch access logs for all candidate IDs
        const accessLogMap = await storage.getAccessLog(resultIds, PRISM_ACTR_MAX_ACCESSES_PER_ENTRY);

        // Step B: Fetch outbound links for spreading activation
        const candidateIdSet = new Set(resultIds);
        const linksMap = new Map<string, Array<{ target_id: string; strength: number }>>();
        if (storage.getCandidateLinks) {
          const links = await storage.getCandidateLinks(resultIds);
          for (const link of links) {
            const outgoing = linksMap.get(link.source_id) ?? [];
            outgoing.push({ target_id: link.target_id, strength: link.strength });
            linksMap.set(link.source_id, outgoing);
          }
        } else for (const id of resultIds) {
          try {
            const links = await storage.getLinksFrom(id, PRISM_USER_ID, 0.0, 20);
            linksMap.set(id, links.map((l: any) => ({
              target_id: l.target_id,
              strength: l.strength ?? 1.0,
            })));
          } catch {
            linksMap.set(id, []);
          }
        }

        // Step C: Compute activation for each result and re-rank
        actrMetrics = { baseLevels: [], spreadings: [], sigmoids: [], composites: [] };

        for (const r of results as any[]) {
          const id = r.id;
          if (!id) continue;

          // B_i: Base-level activation from access log
          const accessTimestamps = accessLogMap.get(id) || [];
          // If no access log entries, use created_at as single proxy
          const timestamps = accessTimestamps.length > 0
            ? accessTimestamps
            : [new Date(r.created_at || now)];

          // Rollups represent consolidated semantic knowledge over many sessions.
          // They should decay 50% slower than raw episodic chatter to retain long-term context.
          const decayRate = r.is_rollup ? PRISM_ACTR_DECAY * 0.5 : PRISM_ACTR_DECAY;
          const Bi = baseLevelActivation(timestamps, now, decayRate);

          // S_i: Candidate-scoped spreading activation
          const outboundLinks = linksMap.get(id) || [];
          const Si = candidateScopedSpreadingActivation(outboundLinks, candidateIdSet);

          // Composite retrieval score
          const composite = compositeRetrievalScore(
            typeof r.similarity === "number" ? r.similarity : 0,
            Bi + Si,
            PRISM_ACTR_WEIGHT_SIMILARITY,
            PRISM_ACTR_WEIGHT_ACTIVATION,
            PRISM_ACTR_SIGMOID_MIDPOINT,
            PRISM_ACTR_SIGMOID_STEEPNESS
          );

          // Attach to result for re-sorting and display
          r._actr_Bi = Bi;
          r._actr_Si = Si;
          r._actr_composite = composite;

          actrMetrics.baseLevels.push(Bi);
          actrMetrics.spreadings.push(Si);
          actrMetrics.composites.push(composite);
        }

        // Re-sort by composite score (descending)
        (results as any[]).sort((a: any, b: any) => (b._actr_composite ?? 0) - (a._actr_composite ?? 0));

        debugLog(
          `[session_search_memory] ACT-R re-ranking applied to ${results.length} candidates (returning top ${limit}): ` +
          `mean B_i=${(actrMetrics.baseLevels.reduce((a, b) => a + b, 0) / actrMetrics.baseLevels.length).toFixed(3)}, ` +
          `mean composite=${(actrMetrics.composites.reduce((a, b) => a + b, 0) / actrMetrics.composites.length).toFixed(3)}`
        );
      } catch (actrErr) {
        actrMetrics = null;
        // ACT-R failures are non-fatal — degrade to similarity-only ordering
        debugLog(`[session_search_memory] ACT-R re-ranking failed (non-fatal): ${actrErr instanceof Error ? actrErr.message : String(actrErr)}`);
      }
    }

    // v7.0: Slice the re-ranked candidate pool back to the requested limit.
    // This MUST happen after re-ranking but BEFORE recording access events,
    // so we only log access for results actually delivered to the LLM.
    results.splice(limit);

    if (PRISM_HDC_ENABLED && results.length > 0) {
      // Policy thresholds are calibrated to semantic relevance, not activation.
      const topScore = policyCandidates[0]?.similarity;
      const secondScore = policyCandidates.length > 1 ? policyCandidates[1].similarity : 0;
      const gapDistance = (topScore || 0) - (secondScore || 0);

      const fallbackThreshold = PRISM_HDC_POLICY_FALLBACK_THRESHOLD || 0.85;
      const clarifyThreshold = PRISM_HDC_POLICY_CLARIFY_THRESHOLD || 0.95;
      const gapThreshold = clarifyThreshold - fallbackThreshold;

      if ((topScore || 0) < fallbackThreshold || (policyCandidates.length > 1 && gapDistance < gapThreshold)
        || (results[0].similarity ?? 0) < fallbackThreshold) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              results: [],
              meta: {
                rejected: true,
                reason: `Uncertainty Rejection: topScore (${(topScore || 0).toFixed(3)}) < ${fallbackThreshold} OR gapDistance (${gapDistance.toFixed(3)}) < ${gapThreshold.toFixed(3)}.`
              }
            }, null, 2)
          }],
          isError: false
        };
      }
    }

    // Fire-and-forget: record access events for the final delivered results
    // v7.0: Writes to both access_log buffer AND legacy last_accessed_at
    const finalIds = results.map((r: any) => r.id).filter(Boolean);
    if (finalIds.length > 0) {
      const queryHash = createHash("sha256").update(query).digest("hex");
      recordMemoryAccess(finalIds, queryHash);
    }

    // Format results with similarity scores + effective importance + ACT-R
    const formatted = results.map((r: any, i: number) => {
      const simScore = formatHitScore(r);

      // Dynamic importance decay (uses ACT-R internally when enabled)
      const baseImportance = r.importance ?? 0;
      const effectiveImportance = computeEffectiveImportance(baseImportance, r.last_accessed_at, r.created_at, Boolean(r.is_rollup));

      const importanceStr = baseImportance > 0
        ? `  Importance: ${effectiveImportance}${effectiveImportance !== baseImportance ? ` (base: ${baseImportance}, decayed)` : ""}\n`
        : "";

      // v7.0: Append ACT-R composite score when available
      const actrStr = r._actr_composite !== undefined
        ? `  ACT-R: composite=${r._actr_composite.toFixed(3)} (B=${r._actr_Bi?.toFixed(2)}, S=${r._actr_Si?.toFixed(3)})\n`
        : "";

      return `[${i + 1}] ${simScore} — ${r.session_date || "unknown date"}\n` +
        `  Project: ${r.project}\n` +
        `  Summary: ${r.summary}\n` +
        importanceStr +
        actrStr +
        (r.decisions?.length ? `  Decisions: ${r.decisions.join("; ")}\n` : "") +
        (r.files_changed?.length ? `  Files: ${r.files_changed.join(", ")}\n` : "");
    }).join("\n");

    // Phase 1: content[0] = human-readable results (unchanged from pre-Phase 1)
    const contentBlocks: Array<{ type: string; text: string }> = [{
      type: "text",
      text: `${searchResultsHeader(results.length, isHybridSearchResults(results))}\n\n${formatted}`,
    }];
    if (actrEnabled && resultIds.length > 0 && !actrMetrics) {
      contentBlocks.push({ type: "text", text: "Automatic memory ranking unavailable for this search; returning relevance ordering." });
    }

    // Phase 1: content[1] = machine-readable MemoryTrace (only when enable_trace=true)
    // topScore is read from results[0].similarity — this is the cosine distance
    // already returned by SemanticSearchResult in the storage interface.
    // No storage layer modifications were needed ("Score Bubbling" reviewer level-up).
    if (enable_trace) {
      const topScore = results.length > 0 && typeof results[0].similarity === "number"
        ? results[0].similarity
        : null;

      // v7.0: Compute ACT-R trace metrics (means)
      const mean = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : undefined;

      const trace = createMemoryTrace({
        strategy: "semantic",
        query,
        resultCount: results.length,
        topScore,
        threshold: similarity_threshold,
        embeddingMs,
        storageMs,
        totalMs,
        project: project || null,
        // v7.0: ACT-R observability
        actrEnabled: actrMetrics !== null,
        actrBaseLevelMean: actrMetrics ? mean(actrMetrics.baseLevels) : undefined,
        actrSpreadingMean: actrMetrics ? mean(actrMetrics.spreadings) : undefined,
        actrCompositeMean: actrMetrics ? mean(actrMetrics.composites) : undefined,
      });
      contentBlocks.push(traceToContentBlock(trace));
    }

    // Machine-readable evidence snippets for direct pass-through to prism_infer
    {
      const evidenceSnippets = results.map((r: any, i: number) => ({
        source: `session_search_memory:${r.id ?? i}`,
        recorded: r.session_date ?? r.created_at ?? r.updated_at ?? r.timestamp ?? undefined,
        content: (r.summary ?? "").slice(0, 1000),
      })).filter((s: any) => s.content);
      if (evidenceSnippets.length > 0) {
        contentBlocks.push({ type: "text", text: JSON.stringify({ evidence_snippets: evidenceSnippets }) });
      }
    }

    // ── v6.0 Phase 3: 1-Hop Graph Expansion ──────────────────
    // After direct hits, traverse outbound links from each result to
    // find associated memories. Graph-expanded results are BONUS — they
    // don't consume limit slots. Hard-capped at `limit` additional results
    // to protect LLM context windows.
    //
    // Fire-and-forget: errors degrade gracefully to just direct hits.
    try {
      const directIds = new Set(results.map((r: any) => r.id).filter(Boolean));
      const enrichedIds = new Set<string>();
      const maxGraphResults = Math.min(limit, 10); // Hard cap

      for (const directId of directIds) {
        if (enrichedIds.size >= maxGraphResults) break;
        const links = await storage.getLinksFrom(directId, PRISM_USER_ID, 0.3, 5);
        for (const link of links) {
          if (!directIds.has(link.target_id) && !enrichedIds.has(link.target_id)) {
            enrichedIds.add(link.target_id);
            if (enrichedIds.size >= maxGraphResults) break;
          }
        }
      }

      if (enrichedIds.size > 0) {
        // Fetch the actual entries for enriched IDs
        const enrichedEntries = await storage.getLedgerEntries({
          user_id: `eq.${PRISM_USER_ID}`,
          ids: [...enrichedIds],
          select: "id,summary,project,created_at",
        });

        if (enrichedEntries.length > 0) {
          const graphFormatted = enrichedEntries.map((e: any) =>
            `[🔗] ${e.created_at?.split("T")[0] || "unknown"} — ${e.project || "unknown"}\n` +
            `  Summary: ${e.summary}`
          ).join("\n");

          contentBlocks[0] = {
            type: "text",
            text: contentBlocks[0].text +
              `\n\n🔗 Graph-connected memories (${enrichedEntries.length} via 1-hop expansion):\n\n${graphFormatted}`,
          };
          const deliveredGraphIds = enrichedEntries.map((entry: any) => entry.id).filter(Boolean);
          if (deliveredGraphIds.length > 0) recordMemoryAccess(deliveredGraphIds, createHash("sha256").update(query).digest("hex"));

          // Fire-and-forget: reinforce traversed links
          for (const directId of directIds) {
            storage.getLinksFrom(directId, PRISM_USER_ID, 0.3, 5)
              .then(links => {
                for (const link of links) {
                  if (enrichedIds.has(link.target_id)) {
                    storage.reinforceLink(directId, link.target_id, link.link_type).catch(() => {});
                  }
                }
              })
              .catch(() => {});
          }
        }
      }
    } catch (graphErr) {
      debugLog(`[session_search_memory] Graph expansion failed (non-fatal): ${graphErr instanceof Error ? graphErr.message : String(graphErr)}`);
    }

    return { content: contentBlocks, isError: false };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes("vector") || errorMsg.includes("does not exist")) {
      return {
        content: [{
          type: "text",
          text: `❌ Semantic search is not available: pgvector extension may not be enabled.\n\n` +
            `To fix: Go to Supabase Dashboard → Database → Extensions → enable "vector"\n` +
            `Then run migration 018_semantic_search.sql\n\n` +
            `💡 Use knowledge_search (keyword-based) as an alternative.`,
        }],
        isError: true,
      };
    }
    throw err;
  }
}

export async function knowledgeUpvoteHandler(args: unknown) {
  if (!isKnowledgeVoteArgs(args)) {
    throw new Error("Invalid arguments for knowledge_upvote");
  }

  const storage = await getStorage();
  try {
    await storage.adjustImportance(args.id, 1, PRISM_USER_ID);
    debugLog(`[knowledge_upvote] Upvoted entry ${args.id}`);
    return {
      content: [{ type: "text", text: `👍 Entry ${args.id} upvoted (+1 importance).` }],
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `❌ Failed to upvote entry ${args.id}: ${msg}` }],
      isError: true,
    };
  }
}

export async function knowledgeDownvoteHandler(args: unknown) {
  if (!isKnowledgeVoteArgs(args)) {
    throw new Error("Invalid arguments for knowledge_downvote");
  }

  const storage = await getStorage();
  try {
    await storage.adjustImportance(args.id, -1, PRISM_USER_ID);
    debugLog(`[knowledge_downvote] Downvoted entry ${args.id}`);
    return {
      content: [{ type: "text", text: `👎 Entry ${args.id} downvoted (-1 importance).` }],
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `❌ Failed to downvote entry ${args.id}: ${msg}` }],
      isError: true,
    };
  }
}

export async function knowledgeSyncRulesHandler(args: unknown) {
  if (!isKnowledgeSyncRulesArgs(args)) {
    throw new Error("Invalid arguments for knowledge_sync_rules");
  }

  const { project, target_file = ".cursorrules", dry_run = false } = args;
  const storage = await getStorage();

  // 1. Resolve repo path
  const repoPath = await getSetting(`repo_path:${project}`, "");
  if (!repoPath || !repoPath.trim()) {
    return {
      content: [{
        type: "text",
        text: `❌ No repo_path configured for project "${project}".\n` +
          `Set it in the Mind Palace dashboard (Settings → Project Repo Paths) before syncing rules.`,
      }],
      isError: true,
    };
  }

  const normalizedRepoPath = repoPath.trim().replace(/\/+$/, "");

  // 2. Fetch graduated insights
  const insights = await storage.getGraduatedInsights(project, PRISM_USER_ID, 7);

  if (insights.length === 0) {
    return {
      content: [{
        type: "text",
        text: `ℹ️ No graduated insights found for project "${project}".\n` +
          `Insights graduate when their importance score reaches 7 or higher.\n` +
          `Use \`knowledge_upvote\` to increase importance of valuable entries.`,
      }],
      isError: false,
    };
  }

  // 3. Format rules block
  const rulesBlock = formatRulesBlock(
    insights.map(i => ({ ...i, importance: i.importance ?? 0 })),
    project
  );

  // 4. Dry-run: return preview without writing
  if (dry_run) {
    return {
      content: [{
        type: "text",
        text: `🔍 **Dry Run Preview** — ${insights.length} graduated insight(s) for "${project}":\n\n` +
          `Target: ${normalizedRepoPath}/${target_file}\n\n` +
          `\`\`\`markdown\n${rulesBlock}\n\`\`\`\n\n` +
          `Run again without \`dry_run\` to write this to disk.`,
      }],
      isError: false,
    };
  }

  // 5. Idempotent file write — with path traversal protection
  // Reject absolute paths (e.g. "/etc/hosts")
  if (isAbsolute(target_file)) {
    return {
      content: [{
        type: "text",
        text: `❌ Security Error: target_file cannot be an absolute path. Got: "${target_file}"`,
      }],
      isError: true,
    };
  }

  // Resolve both paths to their canonical forms, then assert containment
  const resolvedRepo = resolve(normalizedRepoPath);
  const targetPath = resolve(resolvedRepo, target_file);
  const relativePath = relative(resolvedRepo, targetPath);

  // Ensure the resolved target is strictly inside the repo root
  // (handles "../../../etc/hosts" style traversal)
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return {
      content: [{
        type: "text",
        text: `❌ Security Error: Path traversal blocked.\n` +
          `"${target_file}" resolves outside the repo root "${resolvedRepo}".`,
      }],
      isError: true,
    };
  }

  // Block writes to .git/ and node_modules/ directories
  if (target_file.startsWith('.git/') || target_file.includes('/.git/') || target_file.startsWith('node_modules/')) {
    return { content: [{ type: "text", text: "Error: Cannot write to .git/ or node_modules/ directories" }], isError: true };
  }

  // Ensure directory exists (handles nested target_file like ".config/rules.md")
  const targetDir = dirname(targetPath);
  if (!existsSync(targetDir)) {
    await mkdir(targetDir, { recursive: true });
  }

  let existingContent = "";
  try {
    existingContent = await readFile(targetPath, "utf-8");
  } catch {
    // File doesn't exist yet — will be created
    debugLog(`[knowledge_sync_rules] File ${targetPath} doesn't exist, creating new`);
  }

  const newContent = applySentinelBlock(existingContent, rulesBlock);
  await writeFile(targetPath, newContent, "utf-8");

  debugLog(`[knowledge_sync_rules] Synced ${insights.length} insights to ${targetPath}`);

  return {
    content: [{
      type: "text",
      text: `✅ Synced ${insights.length} graduated insight(s) to \`${targetPath}\`\n\n` +
        `Top insights synced:\n` +
        insights.slice(0, 5).map(i =>
          `  • [${i.importance}] ${i.summary.substring(0, 80)}${i.summary.length > 80 ? "..." : ""}`
        ).join("\n") +
        (insights.length > 5 ? `\n  ... and ${insights.length - 5} more` : ""),
    }],
    isError: false,
  };
}

export async function sessionIntuitiveRecallHandler(
  args: unknown
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (!isSessionIntuitiveRecallArgs(args)) {
    return {
      content: [{ type: "text", text: "Invalid arguments for session_intuitive_recall" }],
      isError: true,
    };
  }

  try {
    const { decodeSdmVector } = await import("../sdm/sdmDecoder.js");

    await getStorage();
    const queryVector = await getEmbeddingProvider().generateEmbedding(args.query);
    const sdmEngine = getSdmEngine(args.project);
    const targetVector = sdmEngine.read(new Float32Array(queryVector));

    const limit = args.limit ?? 3;
    const threshold = args.threshold ?? 0.55;

    const topMatches = await decodeSdmVector(args.project, targetVector, limit, threshold);

    let recallBlock = `🧠 **SDM Intuitive Recall for "${args.project}"**\n\n`;
    recallBlock += `Query: "${args.query}"\n`;
    recallBlock += `Target vector generated. Scanning ${topMatches.length > 0 ? topMatches.length + " latents surfaced." : "No strong patterns surfaced."}\n\n`;

    if (topMatches.length === 0) {
      recallBlock += `*No stored patterns resonated above the ${(threshold * 100).toFixed(1)}% similarity threshold.*`;
    } else {
      for (const match of topMatches) {
        recallBlock += `- [Similarity: ${(match.similarity * 100).toFixed(1)}%] ${match.summary}\n`;
      }
    }

    return {
      content: [{ type: "text", text: recallBlock }],
      isError: false,
    };
  } catch (err) {
    debugLog(`[session_intuitive_recall] Failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      content: [{ type: "text", text: `Error triggering Intuitive Recall: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

export async function sessionCognitiveRouteHandler(
  args: unknown
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (!isSessionCognitiveRouteArgs(args)) {
    return {
      content: [{ type: "text", text: "Invalid arguments for session_cognitive_route" }],
      isError: true,
    };
  }

  if (!PRISM_HDC_ENABLED) {
    return {
      content: [{
        type: "text",
        text: "⚠️ session_cognitive_route is disabled. Set PRISM_HDC_ENABLED=true to enable v6.5 cognitive routing.",
      }],
      isError: true,
    };
  }

  try {
    const storage = await getStorage();
    const sdmEngine = getSdmEngine(args.project);
    const dict = new ConceptDictionary(storage);

    const stateVector = await dict.getConcept(args.state);
    const roleVector = await dict.getConcept(args.role);
    const actionVector = await dict.getConcept(args.action);

    const machine = new HdcStateMachine(stateVector, sdmEngine);
    machine.transition(roleVector, actionVector);

    const fallbackKey = `hdc:fallback_threshold:${args.project}`;
    const clarifyKey = `hdc:clarify_threshold:${args.project}`;

    const persistedFallbackRaw = await storage.getSetting(fallbackKey);
    const persistedClarifyRaw = await storage.getSetting(clarifyKey);

    const persistedFallback = persistedFallbackRaw !== null ? Number(persistedFallbackRaw) : NaN;
    const persistedClarify = persistedClarifyRaw !== null ? Number(persistedClarifyRaw) : NaN;

    const baseFallbackThreshold = Number.isFinite(persistedFallback)
      ? persistedFallback
      : PRISM_HDC_POLICY_FALLBACK_THRESHOLD;
    const baseClarifyThreshold = Number.isFinite(persistedClarify)
      ? persistedClarify
      : PRISM_HDC_POLICY_CLARIFY_THRESHOLD;

    const fallbackThreshold = args.fallback_threshold ?? baseFallbackThreshold;
    const clarifyThreshold = args.clarify_threshold ?? baseClarifyThreshold;
    const explain = args.explain !== undefined ? args.explain : true;

    if (!(fallbackThreshold >= 0 && fallbackThreshold < clarifyThreshold && clarifyThreshold <= 1)) {
      return {
        content: [{
          type: "text",
          text:
            `Invalid policy thresholds for project "${args.project}": ` +
            `fallback=${fallbackThreshold}, clarify=${clarifyThreshold}. ` +
            "Expected 0 <= fallback < clarify <= 1.",
        }],
        isError: true,
      };
    }

    // Phase 2 parity hook: persist project-specific threshold overrides via storage settings.
    // This works on both SQLite and Supabase backends through the shared StorageBackend API.
    if (args.fallback_threshold !== undefined || args.clarify_threshold !== undefined) {
      await storage.setSetting(fallbackKey, String(fallbackThreshold));
      await storage.setSetting(clarifyKey, String(clarifyThreshold));
    }

    const gateway = new PolicyGateway(dict, {
      fallbackThreshold,
      clarifyThreshold,
    });

    const cogStart = Date.now();
    const result = await gateway.evaluateIntent(machine);
    const cogDuration = Date.now() - cogStart;

    // Phase 4: Record cognitive route telemetry
    recordCognitiveRoute({
      project: args.project,
      route: result.route,
      concept: result.concept || null,
      confidence: result.confidence,
      distance: result.distance,
      ambiguous: result.ambiguous,
      steps: result.steps,
      duration_ms: cogDuration,
    });

    const lines: string[] = [];
    lines.push(`🧠 Cognitive Route — project \"${args.project}\"`);
    lines.push("");
    lines.push(`State: ${args.state}`);
    lines.push(`Role: ${args.role}`);
    lines.push(`Action: ${args.action}`);
    lines.push("");
    lines.push(`Route: ${result.route}`);
    lines.push(`Concept: ${result.concept || "(none)"}`);
    lines.push(`Confidence: ${(result.confidence * 100).toFixed(2)}%`);
    lines.push(`Distance: ${result.distance}`);
    lines.push(`Ambiguous: ${result.ambiguous ? "yes" : "no"}`);
    lines.push(`Convergence Steps: ${result.steps}`);

    if (PRISM_HDC_EXPLAINABILITY_ENABLED && explain) {
      lines.push("");
      lines.push("Explainability:");
      lines.push(`- Policy thresholds: fallback=${fallbackThreshold}, clarify=${clarifyThreshold}`);
      lines.push("- Routing logic: below fallback => FALLBACK, ambiguous/below clarify => CLARIFY, else AUTO_ROUTE");
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      isError: false,
    };
  } catch (err) {
    debugLog(`[session_cognitive_route] Failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      content: [{ type: "text", text: `Error triggering cognitive route: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

export async function synthesizeEdgesCore({
  project,
  similarity_threshold = 0.7,
  max_entries = 50,
  max_neighbors_per_entry = 3,
  randomize_selection = false,
}: {
  project: string;
  similarity_threshold?: number;
  max_entries?: number;
  max_neighbors_per_entry?: number;
  randomize_selection?: boolean;
}) {
  if (!Number.isFinite(similarity_threshold) || similarity_threshold < 0 || similarity_threshold > 1) {
    throw new RangeError("similarity_threshold must be a finite number from 0 to 1");
  }
  if (!Number.isInteger(max_entries) || max_entries < 1 || max_entries > SESSION_SYNTHESIS_MAX_ENTRIES) {
    throw new RangeError(`max_entries must be an integer from 1 to ${SESSION_SYNTHESIS_MAX_ENTRIES}`);
  }
  if (!Number.isInteger(max_neighbors_per_entry)
      || max_neighbors_per_entry < 1
      || max_neighbors_per_entry > SESSION_SYNTHESIS_MAX_NEIGHBORS_PER_ENTRY) {
    throw new RangeError(
      `max_neighbors_per_entry must be an integer from 1 to ${SESSION_SYNTHESIS_MAX_NEIGHBORS_PER_ENTRY}`,
    );
  }

  const storage = await getStorage();
  const llm = getEmbeddingProvider();

  try {
    let recentEntries: unknown[];

    if (storage.getGraphSynthesisEntries) {
      recentEntries = await storage.getGraphSynthesisEntries({
        project,
        limit: max_entries,
        randomize: randomize_selection,
      });
    } else if (randomize_selection) {
      // 1. Fetch up to 1000 IDs for the project
      const rawIds = await storage.getLedgerEntries({
        user_id: `eq.${PRISM_USER_ID}`,
        project: `eq.${project}`,
        deleted_at: "is.null",
        archived_at: "is.null",
        select: "id",
        limit: 1000,
      }) as { id: string }[];

      // 2. Fisher-Yates shuffle
      const ids = rawIds.map(r => r.id).filter(Boolean);
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }

      // 3. Take max_entries
      const selectedIds = ids.slice(0, max_entries);

      if (selectedIds.length > 0) {
        recentEntries = await storage.getLedgerEntries({
          ids: selectedIds,
        });
      } else {
        recentEntries = [];
      }
    } else {
      recentEntries = await storage.getLedgerEntries({
        user_id: `eq.${PRISM_USER_ID}`,
        project: `eq.${project}`,
        deleted_at: "is.null",
        archived_at: "is.null",
        order: "created_at.desc",
        limit: max_entries,
      });
    }

    let newLinks = 0;
    let skippedLinks = 0;
    let entriesScanned = 0;
    let totalCandidates = 0;
    let totalBelow = 0;
    let embeddingsCreated = 0;
    let entriesWithoutText = 0;
    const queryEmbeddings = new Map<string, string>();
    const isCloudGraph = typeof storage.getGraphSynthesisEntries === "function";

    // Populate every selected row before searching so the first row can match
    // the rest of the same batch. The old single-pass loop skipped every
    // legacy row that had neither vector representation.
    for (const entry of recentEntries as any[]) {
      if (!entry?.id) continue;
      let queryEmbeddingStr = entry.embedding;
      if (!queryEmbeddingStr) {
        const textToEmbed = [entry.summary || "", ...(entry.decisions || [])].filter(Boolean).join(" | ");
        if (!textToEmbed) {
          entriesWithoutText++;
          continue;
        }
        const generated = await llm.generateEmbedding(textToEmbed);
        queryEmbeddingStr = JSON.stringify(generated);
        await storage.patchLedger(entry.id, {
          embedding: queryEmbeddingStr,
          ...(isCloudGraph ? { only_if_missing: true } : {}),
        });
        embeddingsCreated++;
      }
      queryEmbeddings.set(entry.id, queryEmbeddingStr);
    }

    const existingTargets = new Map<string, Set<string>>();
    if (storage.getDashboardMemoryGraph) {
      const graph = await storage.getDashboardMemoryGraph({ project, limit: 500 });
      for (const link of graph.edges as any[]) {
        if (!existingTargets.has(link.source_id)) existingTargets.set(link.source_id, new Set());
        existingTargets.get(link.source_id)!.add(link.target_id);
      }
    }
    const linksToCreate: Array<{
      source_id: string;
      target_id: string;
      link_type: "synthesized_from";
      strength: number;
    }> = [];

    for (const entry of recentEntries as any[]) {
      entriesScanned++;
      const queryEmbeddingStr = queryEmbeddings.get(entry.id);
      if (!queryEmbeddingStr) continue;

      let candidatesEvaluated = 0;
      let belowThreshold = 0;

      // Fetch more candidates with a baseline threshold to calculate tuning metrics
      const similar = await storage.searchMemory({
        queryEmbedding: queryEmbeddingStr,
        project,
        limit: max_neighbors_per_entry * 3 + 1, // Look deeper to surface metrics
        similarityThreshold: 0.0, // Filter manually below
        userId: PRISM_USER_ID,
      });

      // Get existing links to avoid duplicates
      const existingTargetIds = storage.getDashboardMemoryGraph
        ? (existingTargets.get(entry.id) ?? new Set<string>())
        : new Set((await storage.getLinksFrom(entry.id, PRISM_USER_ID)).map(l => l.target_id));

      let neighborsFound = 0;

      for (const match of similar) {
        if (match.id === entry.id) continue;

        candidatesEvaluated++;

        if (match.similarity < similarity_threshold) {
          belowThreshold++;
          continue;
        }

        if (neighborsFound >= max_neighbors_per_entry) {
          continue; // We have enough top neighbors above threshold
        }

        neighborsFound++;

        if (existingTargetIds.has(match.id)) {
          skippedLinks++;
        } else {
          linksToCreate.push({
            source_id: entry.id,
            target_id: match.id,
            link_type: 'synthesized_from',
            strength: Math.max(0, Math.min(1, match.similarity)),
          });
          existingTargetIds.add(match.id);
        }
      }

      totalCandidates += candidatesEvaluated;
      totalBelow += belowThreshold;
    }

    if (linksToCreate.length > 0) {
      if (storage.createLinks) {
        await storage.createLinks(linksToCreate, PRISM_USER_ID);
      } else {
        for (const link of linksToCreate) await storage.createLink(link, PRISM_USER_ID);
      }
      newLinks = linksToCreate.length;
    }

    return {
      success: true,
      entriesScanned,
      embeddingsCreated,
      entriesWithoutText,
      totalCandidates,
      totalBelow,
      skippedLinks,
      newLinks
    };
  } catch (err) {
    debugLog(`[synthesizeEdgesCore] Failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

export async function sessionSynthesizeEdgesHandler(args: unknown) {
  if (!isSessionSynthesizeEdgesArgs(args)) {
    throw new Error("Invalid arguments for session_synthesize_edges");
  }

  const {
    project,
    similarity_threshold = 0.7,
    max_entries = 50,
    max_neighbors_per_entry = 3,
    randomize_selection = false,
  } = args;

  try {
    const res = await synthesizeEdgesCore({
      project,
      similarity_threshold,
      max_entries,
      max_neighbors_per_entry,
      randomize_selection,
    });

    return {
      content: [{
        type: "text",
        text: `✅ Synthesized edges for project "${project}"\n\n` +
              `• Entries scanned: ${res.entriesScanned}\n` +
              `• Candidates evaluated: ${res.totalCandidates}\n` +
              `• Below threshold (<${similarity_threshold}): ${res.totalBelow}\n` +
              `• Duplicates skipped: ${res.skippedLinks}\n` +
              `• New links created: ${res.newLinks}`
      }],
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `❌ Failed to synthesize edges: ${msg}` }],
      isError: true,
    };
  }
}

// ─── Step 4: LLM Context Assembly (Test Me) ──────────────────────────

export async function assembleTestMeContext(nodeId: string, project: string, storage: any) {
  // 1. Gather outbound graph links (top 5)
  const outboundLinks = await storage.getLinksFrom(nodeId, PRISM_USER_ID, 0.0, 5);

  // 2. Gather semantic neighbors (top 5) via true search
  const semanticResult = await storage.searchKnowledge({
    project,
    keywords: [nodeId],
    limit: 5,
    userId: PRISM_USER_ID
  });

  // 3. Deduplicate and compactly format the results
  const contextMap = new Map<string, string>();

  for (const link of outboundLinks) {
    // If the target is an entry, fetch its summary to provide context
    try {
      if (link.target_id && link.target_id.length === 36) { // naive UUID check
        const entries = await storage.getLedgerEntries({ id: `eq.${link.target_id}` });
        if (entries && entries.length > 0) {
          contextMap.set(link.target_id, entries[0].summary.substring(0, 300));
        }
      }
    } catch {}
  }

  const semanticEntries = semanticResult?.results || [];
  for (const entry of semanticEntries as any[]) {
    if (entry.id && !contextMap.has(entry.id) && entry.summary) {
      contextMap.set(entry.id, entry.summary.substring(0, 300));
    }
  }

  return {
    nodeId,
    project,
    contextItems: Array.from(contextMap.values())
  };
}

export async function generateTestMeQuestions(context: any, nodeId: string) {
  try {
    const provider = getLLMProvider();

    const payloadContext = context.contextItems.length > 0
      ? context.contextItems.join("\\n---\\n")
      : "No direct graph context available.";

    const prompt = `You are a technical knowledge assistant. Generate exactly 3 active-recall Socratic questions and short answers for the concept/node: "${nodeId}".

Available context from the knowledge graph:
${payloadContext}

If context is sparse, derive questions from intrinsic properties and likely operational implications of the concept.

Constraint: Output strictly as JSON array of objects with keys "q" and "a". Do not include markdown fences or other text.
Example:
[
  {"q":"What is X?","a":"X is..."},
  {"q":"How does X work?","a":"It works by..."}
]`;

    const responseText = await provider.generateText(prompt);

    // Attempt to parse strictly
    let textToParse = responseText.trim();
    if (textToParse.startsWith("\`\`\`json")) {
      textToParse = textToParse.replace(/\`\`\`json/g, "").replace(/\`\`\`/g, "").trim();
    }

    const parsed = JSON.parse(textToParse);
    if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed[0].q || !parsed[0].a) {
      throw new Error("Invalid output shape");
    }

    return { questions: parsed };
  } catch (err: any) {
    if (err.message?.includes("API key") || err.message?.includes("auth")) {
      return { questions: [], reason: "no_api_key" };
    }
    return { questions: [], reason: "generation_failed" };
  }
}
