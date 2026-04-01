/**
 * Cognitive Memory Module — v7.0 (ACT-R Activation)
 *
 * ═══════════════════════════════════════════════════════════════════
 * CHANGELOG:
 *   v5.2 — Ebbinghaus exponential decay: effective = base × 0.95^days
 *   v7.0 — REPLACED with ACT-R base-level activation model.
 *          The old formula conflated importance (a semantic property)
 *          with recency (a retrieval property). ACT-R separates them:
 *            - importance = semantic vote score (unchanged by time)
 *            - activation = B_i = ln(Σ t_j^(-d)) (retrieval signal)
 *
 *          computeEffectiveImportance now uses ACT-R baseLevelActivation
 *          with a single-timestamp proxy (last_accessed_at or created_at).
 *          The full multi-timestamp pipeline runs in graphHandlers.ts
 *          where the access log is available.
 *
 * FILES THAT IMPORT THIS:
 *   - src/tools/graphHandlers.ts (knowledge search, session search)
 *   - src/tools/coreHandlers.ts (load context importance ordering)
 * ═══════════════════════════════════════════════════════════════════
 */

import { getStorage } from "../storage/index.js";
import { debugLog } from "./logger.js";
import {
  baseLevelActivation,
  parameterizedSigmoid,
} from "./actrActivation.js";
import {
  PRISM_ACTR_ENABLED,
  PRISM_ACTR_DECAY,
  PRISM_ACTR_SIGMOID_MIDPOINT,
  PRISM_ACTR_SIGMOID_STEEPNESS,
} from "../config.js";

/**
 * Computes the effective importance of a memory, combining the semantic
 * importance score with a recency-based activation factor.
 *
 * v7.0 (ACT-R):
 *   effective = baseImportance × σ(B_i)
 *
 *   Where B_i uses a single-timestamp proxy (last_accessed_at or created_at)
 *   and σ is the parameterized sigmoid from actrActivation.ts.
 *
 *   This is a LIGHTWEIGHT estimator used by context loading and knowledge
 *   search to order results. The full multi-access-log pipeline runs in
 *   sessionSearchMemoryHandler (graphHandlers.ts).
 *
 * Fallback (PRISM_ACTR_ENABLED=false):
 *   Reverts to the v5.2 Ebbinghaus decay: base × 0.95^days
 *
 * @param baseImportance The raw importance score of the memory.
 * @param lastAccessedStr ISO string representing the last access time.
 * @param createdAtStr ISO string representing creation time (fallback).
 * @returns The effective importance score, rounded to 2 decimal places.
 */
export function computeEffectiveImportance(
    baseImportance: number,
    lastAccessedStr: string | null | undefined,
    createdAtStr: string
): number {
    if (baseImportance <= 0) return baseImportance;

    const now = new Date();

    // Fallback to creation date if it has never been accessed
    const referenceDateStr = lastAccessedStr || createdAtStr;
    const referenceDate = new Date(referenceDateStr);

    if (!PRISM_ACTR_ENABLED) {
        // ── Legacy Ebbinghaus Decay (v5.2, deprecated) ──
        const diffMs = Math.max(0, now.getTime() - referenceDate.getTime());
        const daysSinceAccess = diffMs / (1000 * 60 * 60 * 24);
        const effective = baseImportance * Math.pow(0.95, daysSinceAccess);
        return Math.round(effective * 100) / 100;
    }

    // ── ACT-R Activation (v7.0) ──
    // Use a single-timestamp proxy: treat last_accessed_at as one access event.
    // This gives a simplified B_i = ln(t^(-d)) = -d × ln(t)
    // The full multi-timestamp B_i runs in graphHandlers.ts search pipeline.
    const Bi = baseLevelActivation(
        [referenceDate],
        now,
        PRISM_ACTR_DECAY
    );

    // Normalize to (0, 1) via parameterized sigmoid
    const activationFactor = parameterizedSigmoid(
        Bi,
        PRISM_ACTR_SIGMOID_MIDPOINT,
        PRISM_ACTR_SIGMOID_STEEPNESS
    );

    // Scale importance by activation factor
    // Fresh memory: factor ≈ 0.99 → nearly full importance
    // Cold memory:  factor ≈ 0.05 → heavily discounted
    const effective = baseImportance * activationFactor;

    return Math.round(effective * 100) / 100;
}

/**
 * Fire-and-forget helper to record access events for retrieved memories.
 *
 * v7.0: Uses the storage.logAccess() method which delegates to the
 * AccessLogBuffer for batched, contention-free writes.
 * Also updates legacy last_accessed_at for backward compat.
 *
 * @param ids Array of memory IDs that were just accessed
 * @param contextHash Optional search query fingerprint
 */
export function recordMemoryAccess(ids: string[], contextHash?: string): void {
    if (!ids || ids.length === 0) return;

    // Fire and forget, don't block execution
    getStorage().then(storage => {
        // v7.0: Log access events to memory_access_log via buffer
        for (const id of ids) {
            storage.logAccess(id, contextHash);
        }

        // Backward compat: batch-update legacy last_accessed_at via IN clause.
        // Uses the optimized updateLastAccessed (single SQL with WHERE id IN (...))
        // instead of N individual patchLedger calls.
        storage.updateLastAccessed(ids).then(() => {
            debugLog(`[CognitiveMemory] Recorded ${ids.length} memory accesses.`);
        }).catch(() => {
            // Non-fatal: legacy timestamp is best-effort
        });
    }).catch(error => {
        debugLog(`[CognitiveMemory] Failed to record memory access: ${error instanceof Error ? error.message : String(error)}`);
    });
}

/**
 * @deprecated Use recordMemoryAccess() instead. Kept for backward compat.
 * Fire-and-forget helper to update the last_accessed_at timestamp.
 */
export function updateLastAccessed(ids: string[]): void {
    recordMemoryAccess(ids);
}
