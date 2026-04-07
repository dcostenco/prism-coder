/**
 * Surprisal Gate — Vector-Based Novelty Scoring (v9.0)
 *
 * ═══════════════════════════════════════════════════════════════════
 * PURPOSE:
 *   Computes the information-theoretic "surprisal" of an incoming
 *   memory entry by measuring its semantic distance from recent entries.
 *
 * WHY NOT TF-IDF:
 *   A naive TF-IDF approach would require downloading all summaries
 *   into V8 memory and running a custom JS tokenizer. On projects with
 *   10K+ entries (common after Universal Import), this blocks the
 *   Node.js event loop for seconds, causing MCP handshake timeouts.
 *
 * VECTOR-BASED SURPRISAL:
 *   Surprisal = 1 - max_similarity_to_recent_entries
 *
 *   When the agent tries to save an entry, we embed the summary
 *   (already happening in the save flow) and query the DB for the
 *   single most similar entry from the last 7 days.
 *
 *   - Similarity 0.95 → Surprisal 0.05 → "You're repeating yourself" → 2× cost
 *   - Similarity 0.40 → Surprisal 0.60 → "Completely novel thought" → 0.5× cost
 *
 *   This uses the existing native sqlite-vec index, takes < 5ms,
 *   uses zero extra memory, and is far more accurate than word counting.
 *
 * FILES THAT IMPORT THIS:
 *   - src/tools/ledgerHandlers.ts (surprisal computation during save)
 * ═══════════════════════════════════════════════════════════════════
 */

import { debugLog } from "../utils/logger.js";

// ─── Types ────────────────────────────────────────────────────

export interface SurprisalResult {
  /** Surprisal score in [0.0, 1.0]. Higher = more novel. */
  surprisal: number;
  /** Similarity to the closest recent entry (for diagnostics) */
  maxSimilarity: number;
  /** Whether the entry is classified as boilerplate */
  isBoilerplate: boolean;
  /** Whether the entry is classified as novel */
  isNovel: boolean;
}

// ─── Constants ────────────────────────────────────────────────

/** Maximum age of entries to compare against (days) */
export const RECENCY_WINDOW_DAYS = 7;

/** Number of similar entries to fetch for comparison */
export const TOP_K = 1;

/** Similarity above which content is considered boilerplate */
export const BOILERPLATE_SIMILARITY = 0.80;

/** Similarity below which content is considered novel */
export const NOVEL_SIMILARITY = 0.30;

// ─── Core Computation ─────────────────────────────────────────

/**
 * Compute surprisal from a semantic similarity score.
 *
 * This is the pure math core — no I/O. The caller is responsible
 * for running the actual vector search to find maxSimilarity.
 *
 * @param maxSimilarity - Cosine similarity to the most similar recent entry (0-1)
 * @returns SurprisalResult with classification
 */
export function computeSurprisal(maxSimilarity: number): SurprisalResult {
  // Guard: no recent entries found (first entry in project) → maximum novelty
  if (!Number.isFinite(maxSimilarity) || maxSimilarity < 0) {
    return {
      surprisal: 1.0,
      maxSimilarity: 0.0,
      isBoilerplate: false,
      isNovel: true,
    };
  }

  // Clamp to [0, 1]
  const clamped = Math.min(1.0, Math.max(0.0, maxSimilarity));
  const surprisal = 1.0 - clamped;

  return {
    surprisal,
    maxSimilarity: clamped,
    isBoilerplate: clamped >= BOILERPLATE_SIMILARITY,
    isNovel: clamped <= NOVEL_SIMILARITY,
  };
}

/**
 * Compute surprisal using the existing storage backend's vector search.
 *
 * This is the integration wrapper. It:
 * 1. Takes the query embedding (already generated for the save flow)
 * 2. Finds the most similar recent entry via sqlite-vec
 * 3. Computes surprisal = 1 - max_similarity
 *
 * Falls back to surprisal=0.5 (neutral) on any error, to avoid
 * blocking saves due to search failures.
 *
 * @param searchFn - The storage backend's searchMemory function
 * @param queryEmbedding - JSON-stringified embedding of the new entry
 * @param project - Project scope
 * @param userId - Tenant ID
 * @returns SurprisalResult
 */
export async function computeVectorSurprisal(
  searchFn: (params: {
    queryEmbedding: string;
    project?: string | null;
    limit: number;
    similarityThreshold: number;
    userId: string;
  }) => Promise<Array<{ similarity: number }>>,
  queryEmbedding: string,
  project: string,
  userId: string,
): Promise<SurprisalResult> {
  try {
    // Search for the single most similar recent entry
    // Using a very low threshold (0.0) to get the closest match regardless
    const results = await searchFn({
      queryEmbedding,
      project,
      limit: TOP_K,
      similarityThreshold: 0.0, // Get closest match regardless of distance
      userId,
    });

    if (results.length === 0) {
      // No existing entries → fully novel
      debugLog('[surprisal] No recent entries found — maximum novelty');
      return computeSurprisal(-1);
    }

    const maxSimilarity = results[0].similarity;
    debugLog(`[surprisal] Max similarity to recent entries: ${maxSimilarity.toFixed(3)}`);
    return computeSurprisal(maxSimilarity);
  } catch (err) {
    // Non-fatal: fall back to neutral surprisal
    debugLog(`[surprisal] Vector search failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return {
      surprisal: 0.5,
      maxSimilarity: 0.5,
      isBoilerplate: false,
      isNovel: false,
    };
  }
}
