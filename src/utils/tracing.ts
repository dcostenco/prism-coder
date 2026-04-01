/**
 * Memory Trace — Phase 1 Explainability & Lineage
 *
 * ═══════════════════════════════════════════════════════════════════
 * PURPOSE:
 *   Provides structured tracing metadata for every search/recall
 *   operation in Prism MCP. When `enable_trace: true` is passed to
 *   `session_search_memory` or `knowledge_search`, the response
 *   includes a separate MCP content block with a MemoryTrace object.
 *
 * WHY THIS EXISTS:
 *   Without tracing, developers have no visibility into *why* a
 *   memory was returned — was it a semantic match? A keyword hit?
 *   How confident was the score? Was the 500ms latency caused by
 *   the embedding API or the database query?
 *
 *   This module answers all of those questions by providing:
 *   - strategy: "semantic" | "keyword" → which search path was used
 *   - top_score: the cosine similarity / relevance score of the best result
 *   - latency: { embedding_ms, storage_ms, total_ms } → pinpoints bottlenecks
 *   - result_count, threshold, project, query, timestamp → full context
 *
 * DESIGN DECISIONS:
 *
 *   1. NO OPENTELEMETRY SDK IN PHASE 1
 *      We get the data structures right in-memory first. OTel
 *      integration (W3C traceparent headers, span export to
 *      Datadog/LangSmith) layers on top in a follow-up without
 *      any code changes to the MemoryTrace types.
 *
 *   2. SEPARATE MCP CONTENT BLOCK (The "Output Array Trick")
 *      Instead of concatenating trace JSON into the human-readable
 *      text response (content[0]), we return it as content[1].
 *
 *      Why?
 *      - Prevents LLMs from accidentally blending trace JSON into
 *        their reasoning (they sometimes try to "interpret" inline JSON)
 *      - Programmatic MCP clients can grab content[1] directly
 *        without parsing/splitting string output
 *      - Clean separation of concerns: content[0] = human-readable,
 *        content[1] = machine-readable trace metadata
 *
 *   3. LATENCY BREAKDOWN (Not just total)
 *      A single `latency_ms` number is misleading. A 500ms total could
 *      be 480ms embedding API + 20ms DB, or 20ms embedding + 480ms DB.
 *      These are very different problems requiring different fixes.
 *
 *      We capture three timestamps:
 *        - Before embedding API call → after = embedding_ms
 *        - Before storage.searchMemory() → after = storage_ms
 *        - Start to finish = total_ms (includes overhead, serialization, etc.)
 *
 *   4. SCORE BUBBLING (No storage layer changes needed)
 *      The existing SemanticSearchResult interface (interface.ts L104-112)
 *      already includes `similarity: number`. We read this directly from
 *      results[0].similarity — no modifications to the storage layer.
 *      For keyword search, top_score is null since keyword search doesn't
 *      return relevance scores in the current implementation.
 *
 *   5. BACKWARD COMPATIBILITY
 *      When `enable_trace` is not set (default: false), the response
 *      is identical to pre-Phase 1 output. Zero breaking changes.
 *      Existing tests pass without modification.
 *
 * USAGE:
 *   This module is imported by sessionMemoryHandlers.ts. It is NOT
 *   imported by the storage layer, server.ts, or any other module.
 *
 * FILES THAT IMPORT THIS:
 *   - src/tools/sessionMemoryHandlers.ts (search handlers)
 *
 * RELATED FILES:
 *   - src/tools/sessionMemoryDefinitions.ts (enable_trace param definition)
 *   - src/storage/interface.ts (SemanticSearchResult with similarity score)
 *
 * FUTURE EXTENSIONS (Phase 1.5+):
 *   - Add OpenTelemetry span creation using these same trace objects
 *   - Add `reranked_score` field when re-ranking is implemented
 *   - Add `graph_hops` field when graph-based recall is added
 *   - Add PII sanitization flags for GDPR-strict deployments
 * ═══════════════════════════════════════════════════════════════════
 */

// ─── Types ────────────────────────────────────────────────────

/**
 * Latency breakdown for a single search operation.
 *
 * Separates compute time (embedding API call to Gemini/OpenAI) from
 * storage time (pgvector cosine distance query or SQLite full-text search).
 *
 * This distinction is critical for debugging:
 *   - High embedding_ms → Gemini API latency spike, consider caching
 *   - High storage_ms → DB needs index tuning or the table is too large
 *   - total_ms >> embedding_ms + storage_ms → serialization overhead
 *
 * All values are in milliseconds, rounded to nearest integer via
 * Math.round() in createMemoryTrace() for cleaner output.
 */
export interface TraceLatency {
  /** Time spent calling the embedding model (ms). 0 for keyword search. */
  embedding_ms: number;
  /** Time spent querying the database — pgvector or SQLite (ms). */
  storage_ms: number;
  /** Total end-to-end latency including overhead (ms). */
  total_ms: number;
}

/**
 * Structured trace metadata attached to search results.
 *
 * Tells the developer *why* a memory was returned and at what confidence.
 * Returned as a separate MCP content block (content[1]) when
 * `enable_trace: true` is passed to a search tool.
 *
 * Example output in the MCP response:
 * ```json
 * {
 *   "strategy": "semantic",
 *   "query": "authentication bug fix",
 *   "result_count": 3,
 *   "top_score": 0.89,
 *   "threshold": 0.7,
 *   "latency": {
 *     "embedding_ms": 142,
 *     "storage_ms": 23,
 *     "total_ms": 178
 *   },
 *   "timestamp": "2026-03-21T21:19:00.000Z",
 *   "project": "prism-mcp"
 * }
 * ```
 *
 * Note: For keyword search (knowledge_search), `top_score` and
 * `threshold` are null since keyword search doesn't produce
 * similarity scores in the current implementation.
 */
export interface MemoryTrace {
  /** Which search strategy was used: "semantic" (vector) or "keyword" (full-text) */
  strategy: "semantic" | "keyword";

  /** The original search query as provided by the caller */
  query: string;

  /** Number of results returned (after threshold filtering) */
  result_count: number;

  /**
   * Top score from the result set.
   * - For semantic search: cosine similarity (0-1) from SemanticSearchResult.similarity
   * - For keyword search: null (keyword search doesn't produce scores)
   */
  top_score: number | null;

  /**
   * Similarity/relevance threshold used to filter results.
   * - For semantic search: the similarity_threshold parameter (default 0.7)
   * - For keyword search: null (no threshold concept)
   */
  threshold: number | null;

  /** Latency breakdown — see TraceLatency for details */
  latency: TraceLatency;

  /** ISO 8601 timestamp of when the search was executed */
  timestamp: string;

  /** Project scope (null = searched across all projects) */
  project: string | null;

  // ─── v7.0: ACT-R Activation Observability ────────────────────

  /** Mean base-level activation B_i across all returned results (undefined if ACT-R disabled) */
  actr_base_level_mean?: number;
  /** @alias actr_base_level_mean — plan-documented name for per-result tracing */
  actr_base_level_activation?: number;

  /** Mean spreading activation S_i across all returned results (undefined if ACT-R disabled) */
  actr_spreading_mean?: number;
  /** @alias actr_spreading_mean — plan-documented name for per-result tracing */
  actr_spreading_activation?: number;

  /** Mean sigmoid output σ(B_i + S_i) across all returned results (undefined if ACT-R disabled) */
  actr_sigmoid_mean?: number;
  /** @alias actr_sigmoid_mean — plan-documented name for per-result tracing */
  actr_sigmoid_activation?: number;

  /** Mean composite score across all returned results (undefined if ACT-R disabled) */
  actr_composite_mean?: number;
  /** @alias actr_composite_mean — plan-documented name for per-result tracing */
  actr_composite_score?: number;

  /** Whether ACT-R re-ranking was applied */
  actr_enabled?: boolean;
}

// ─── Factory ──────────────────────────────────────────────────

/**
 * Create a MemoryTrace object from search operation metrics.
 *
 * This is a pure factory function — no side effects, no I/O.
 * Called by the search handlers after both the embedding API call
 * and storage query have completed.
 *
 * Latency values are rounded to nearest integer for cleaner output
 * (sub-millisecond precision is noise, not signal).
 *
 * @param params.strategy      - "semantic" or "keyword"
 * @param params.query         - Original search query string
 * @param params.resultCount   - Number of results returned
 * @param params.topScore      - Best similarity score, or null for keyword
 * @param params.threshold     - Threshold used, or null for keyword
 * @param params.embeddingMs   - Time for embedding API call (0 for keyword)
 * @param params.storageMs     - Time for database query
 * @param params.totalMs       - Total end-to-end time
 * @param params.project       - Project filter, or null for all
 * @returns A complete MemoryTrace object ready for serialization
 */
export function createMemoryTrace(params: {
  strategy: MemoryTrace["strategy"];
  query: string;
  resultCount: number;
  topScore: number | null;
  threshold: number | null;
  embeddingMs: number;
  storageMs: number;
  totalMs: number;
  project: string | null;
  // v7.0: Optional ACT-R metrics
  actrBaseLevelMean?: number;
  actrSpreadingMean?: number;
  actrSigmoidMean?: number;
  actrCompositeMean?: number;
  actrEnabled?: boolean;
}): MemoryTrace {
  const trace: MemoryTrace = {
    strategy: params.strategy,
    query: params.query,
    result_count: params.resultCount,
    top_score: params.topScore,
    threshold: params.threshold,
    latency: {
      embedding_ms: Math.round(params.embeddingMs),
      storage_ms: Math.round(params.storageMs),
      total_ms: Math.round(params.totalMs),
    },
    timestamp: new Date().toISOString(),
    project: params.project,
  };

  // v7.0: Attach ACT-R metrics only when present (keeps trace clean when disabled)
  if (params.actrEnabled !== undefined) {
    trace.actr_enabled = params.actrEnabled;
    if (params.actrBaseLevelMean !== undefined) {
      const v = Math.round(params.actrBaseLevelMean * 1000) / 1000;
      trace.actr_base_level_mean = v;
      trace.actr_base_level_activation = v; // plan-documented alias
    }
    if (params.actrSpreadingMean !== undefined) {
      const v = Math.round(params.actrSpreadingMean * 1000) / 1000;
      trace.actr_spreading_mean = v;
      trace.actr_spreading_activation = v; // plan-documented alias
    }
    if (params.actrSigmoidMean !== undefined) {
      const v = Math.round(params.actrSigmoidMean * 1000) / 1000;
      trace.actr_sigmoid_mean = v;
      trace.actr_sigmoid_activation = v; // plan-documented alias
    }
    if (params.actrCompositeMean !== undefined) {
      const v = Math.round(params.actrCompositeMean * 1000) / 1000;
      trace.actr_composite_mean = v;
      trace.actr_composite_score = v; // plan-documented alias
    }
  }

  return trace;
}

/**
 * Format a MemoryTrace into an MCP content block.
 *
 * Returns a single content block to push into the content[] array
 * at index [1]. The "=== MEMORY TRACE ===" header makes it visually
 * distinct from the human-readable search results at content[0].
 *
 * The trace is pretty-printed (2-space indent) for readability in
 * console output and MCP inspector tools.
 *
 * @param trace - A MemoryTrace object from createMemoryTrace()
 * @returns An MCP content block: { type: "text", text: "..." }
 */
export function traceToContentBlock(trace: MemoryTrace): { type: string; text: string } {
  return {
    type: "text",
    text: `=== MEMORY TRACE ===\n${JSON.stringify(trace, null, 2)}`,
  };
}
