/**
 * Valence Engine — Affect-Tagged Memory (v9.0)
 *
 * ═══════════════════════════════════════════════════════════════════
 * PURPOSE:
 *   Implements Affective Cognitive Routing — every memory gets a
 *   "gut feeling" score from -1.0 (trauma) to +1.0 (success).
 *   Agents get warned when approaching historically problematic
 *   topics, and get green-light signals for proven-successful paths.
 *
 * AFFECTIVE SALIENCE PRINCIPLE:
 *   In human psychology, highly emotional memories — both extreme
 *   joy and extreme trauma — are retrieved MORE easily, not less.
 *   Therefore, the retrieval score uses |valence| (absolute magnitude)
 *   to BOOST salience, while the SIGN (±) is used purely for
 *   prompt injection / UX warnings.
 *
 *   This prevents the Valence Retrieval Paradox where a failure
 *   memory gets pushed below the retrieval threshold, causing the
 *   agent to repeat the exact same mistake.
 *
 * DESIGN:
 *   All functions are PURE — zero I/O, zero imports from storage.
 *   Valence propagation through the Synapse graph uses energy-weighted
 *   transfer with fan-dampened flow and strict [-1, 1] clamping.
 *
 * FILES THAT IMPORT THIS:
 *   - src/storage/sqlite.ts (auto-derive valence on save)
 *   - src/tools/graphHandlers.ts (hybrid scoring + UX warnings)
 *   - src/memory/synapseEngine.ts (valence propagation)
 * ═══════════════════════════════════════════════════════════════════
 */

// ─── Valence Derivation ───────────────────────────────────────

/**
 * Deterministic mapping from experience event type to valence score.
 *
 * | Event Type          | Valence | Rationale                          |
 * |---------------------|---------|------------------------------------|
 * | success             | +0.8    | Positive reinforcement             |
 * | failure             | -0.8    | Strong negative signal             |
 * | correction          | -0.6    | User had to fix agent              |
 * | learning            | +0.4    | New knowledge acquired             |
 * | validation_result   | ±0.6    | Pass → +0.6, Fail → -0.6          |
 * | session / default   | 0.0     | Neutral — no sentiment signal      |
 *
 * @param eventType - The experience event type from session_ledger
 * @param notes - Optional notes field (for validation_result pass/fail)
 * @returns Valence score in [-1.0, +1.0]
 */
export function deriveValence(eventType: string | undefined, notes?: string | null): number {
  if (!eventType || eventType === 'session') return 0.0;

  switch (eventType) {
    case 'success':
      return 0.8;
    case 'failure':
      return -0.8;
    case 'correction':
      return -0.6;
    case 'learning':
      return 0.4;
    case 'validation_result':
      // Check notes for pass/fail indication
      if (notes) {
        const lower = notes.toLowerCase();
        if (lower.includes('pass') || lower.includes('success') || lower.includes('green')) {
          return 0.6;
        }
        if (lower.includes('fail') || lower.includes('error') || lower.includes('blocked')) {
          return -0.6;
        }
      }
      // Ambiguous validation result → slightly negative (cautious)
      return -0.2;
    default:
      return 0.0;
  }
}

// ─── Retrieval Salience (Magnitude-Based) ─────────────────────

/**
 * Compute the retrieval salience boost from valence.
 *
 * Uses ABSOLUTE MAGNITUDE — both extreme positive and extreme negative
 * memories are more salient (more retrievable). The sign is preserved
 * separately for UX warnings.
 *
 * @param valence - Raw valence score in [-1.0, +1.0]
 * @returns Salience boost in [0.0, 1.0]
 */
export function valenceSalience(valence: number | null | undefined): number {
  if (valence == null || !Number.isFinite(valence)) return 0.0;
  return Math.min(1.0, Math.abs(valence));
}

// ─── UX Warning / Signal Tags ─────────────────────────────────

/**
 * Format a valence score into a human-readable emoji tag for display
 * in search results and context output.
 *
 * @param valence - Raw valence score in [-1.0, +1.0]
 * @returns Emoji tag string, or empty string for neutral
 */
export function formatValenceTag(valence: number | null | undefined): string {
  if (valence == null || !Number.isFinite(valence)) return '';
  if (valence <= -0.5) return '🔴';
  if (valence <= -0.2) return '🟠';
  if (valence >= 0.5) return '🟢';
  if (valence >= 0.2) return '🔵';
  return '🟡'; // Neutral zone (-0.2 to +0.2)
}

/**
 * Determine if a set of retrieved memories should trigger a
 * negative valence warning in the response.
 *
 * @param avgValence - Average valence across top results
 * @param threshold - Warning threshold (default: -0.3)
 * @returns true if the agent should be warned about historical friction
 */
export function shouldWarnNegativeValence(
  avgValence: number,
  threshold: number = -0.3,
): boolean {
  return Number.isFinite(avgValence) && avgValence < threshold;
}

/**
 * Generate a contextual warning message based on average valence.
 *
 * @param avgValence - Average valence across top results
 * @returns Warning/signal string to inject into MCP response, or null
 */
export function generateValenceWarning(avgValence: number): string | null {
  if (!Number.isFinite(avgValence)) return null;

  if (avgValence < -0.5) {
    return '⚠️ **Caution:** This topic is strongly correlated with historical failures and corrections. Consider reviewing past decisions before proceeding.';
  }
  if (avgValence < -0.3) {
    return '⚠️ **Warning:** This area has mixed historical outcomes. Approach with awareness of prior friction.';
  }
  if (avgValence > 0.5) {
    return '🟢 **High Signal:** This path has historically led to successful outcomes.';
  }

  return null;
}

// ─── Valence Propagation (for Synapse Engine) ─────────────────

/**
 * Propagation result for a single node.
 */
export interface ValencePropagationResult {
  /** Memory entry UUID */
  id: string;
  /** Propagated valence score, clamped to [-1.0, +1.0] */
  propagatedValence: number;
}

/**
 * Propagate valence through Synapse activation results.
 *
 * Each node's propagated valence is computed as the energy-weighted
 * average of its sources' valence, with fan-dampening to prevent
 * hub explosion. The final value is strictly clamped to [-1.0, +1.0].
 *
 * IMPORTANT — Fan-Dampening:
 *   If 50 neutral nodes point to 1 negative node, the negative valence
 *   must NOT multiply to -50.0. The incoming valence is averaged over
 *   the fan-in count, then clamped.
 *
 * Algorithm:
 *   For each non-anchor node with incoming energy flows:
 *     propagatedValence = Σ(flow_weight × source_valence) / Σ(flow_weight)
 *   Clamped to [-1.0, +1.0].
 *
 *   Anchor nodes retain their original valence unchanged.
 *
 * @param synapseResults - Node IDs with their activation energy from Synapse
 * @param valenceLookup - Map from entry ID → raw valence (from DB)
 * @param flowWeights - Map from `targetId` → Array<{ sourceId, weight }> representing
 *                      the energy flows that contributed to each node's activation
 * @returns Map from entry ID → propagated valence
 */
export function propagateValence(
  synapseResults: Array<{ id: string; activationEnergy: number; isDiscovered: boolean }>,
  valenceLookup: Map<string, number>,
  flowWeights?: Map<string, Array<{ sourceId: string; weight: number }>>,
): Map<string, number> {
  const result = new Map<string, number>();

  for (const node of synapseResults) {
    // Anchor nodes: use their direct valence
    if (!node.isDiscovered) {
      const directValence = valenceLookup.get(node.id) ?? 0.0;
      result.set(node.id, clampValence(directValence));
      continue;
    }

    // Discovered nodes: compute energy-weighted average from source flows
    const flows = flowWeights?.get(node.id);
    if (!flows || flows.length === 0) {
      // No flow data → use direct valence if available, else neutral
      result.set(node.id, clampValence(valenceLookup.get(node.id) ?? 0.0));
      continue;
    }

    let weightedValenceSum = 0;
    let totalWeight = 0;

    for (const flow of flows) {
      const sourceValence = valenceLookup.get(flow.sourceId) ?? result.get(flow.sourceId) ?? 0.0;
      const absWeight = Math.abs(flow.weight);
      weightedValenceSum += absWeight * sourceValence;
      totalWeight += absWeight;
    }

    const propagated = totalWeight > 0 ? weightedValenceSum / totalWeight : 0.0;
    result.set(node.id, clampValence(propagated));
  }

  return result;
}

/**
 * Clamp a valence value to the valid range [-1.0, +1.0].
 * Returns 0.0 for non-finite values.
 */
export function clampValence(v: number): number {
  if (!Number.isFinite(v)) return 0.0;
  return Math.max(-1.0, Math.min(1.0, v));
}

// ─── Hybrid Score Component ───────────────────────────────────

/**
 * Compute the hybrid retrieval score incorporating valence salience.
 *
 * Formula: 0.65 × similarity + 0.25 × normalizedActivation + 0.1 × |valence|
 *
 * The valence component uses ABSOLUTE MAGNITUDE — both extreme positive
 * and extreme negative memories get a retrieval boost. Only the sign
 * matters for UX warnings, not for ranking.
 *
 * @param similarity - Semantic similarity score [0, 1]
 * @param normalizedActivation - Sigmoid-normalized activation energy [0, 1]
 * @param valence - Raw valence score [-1, +1]
 * @param weights - Optional weight overrides
 * @returns Hybrid score in [0, 1]
 */
export function computeHybridScoreWithValence(
  similarity: number,
  normalizedActivation: number,
  valence: number | null | undefined,
  weights: { similarity?: number; activation?: number; valence?: number } = {},
): number {
  const wSim = weights.similarity ?? 0.65;
  const wAct = weights.activation ?? 0.25;
  const wVal = weights.valence ?? 0.10;

  const safeSim = Number.isFinite(similarity) ? Math.max(0, Math.min(1, similarity)) : 0;
  const safeAct = Number.isFinite(normalizedActivation) ? Math.max(0, Math.min(1, normalizedActivation)) : 0;
  const safeVal = valenceSalience(valence); // Already returns [0, 1] magnitude

  return wSim * safeSim + wAct * safeAct + wVal * safeVal;
}
