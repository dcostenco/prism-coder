/**
 * ACT-R Activation Engine — v7.0 Cognitive Memory
 *
 * ═══════════════════════════════════════════════════════════════════
 * PURPOSE:
 *   Implements the ACT-R (Adaptive Control of Thought—Rational) memory
 *   activation model for production-grade retrieval ranking.
 *
 * PAPER BASIS:
 *   "Human-Like Remembering and Forgetting in LLM Agents:
 *    An ACT-R Integration" (ACM, 2025)
 *
 * KEY EQUATIONS:
 *   Base-Level Activation:  B_i = ln(Σ t_j^(-d))
 *   Spreading Activation:   S_i = Σ(W × link.strength) for links ∈ candidateSet
 *   Composite Score:         Score = w_sim × sim + w_act × σ(B_i + S_i)
 *
 * PRODUCTION HARDENING:
 *   - Rule #3: Creation = Access (zero-access memories handled gracefully)
 *   - Rule #4: Time clamp t ≥ 1.0s prevents Infinity/NaN
 *   - Rule #5: Candidate-scoped spreading prevents God node centrality
 *   - Parameterized sigmoid for proper activation discrimination
 *
 * DESIGN:
 *   All functions are PURE — zero side effects, zero I/O, zero imports
 *   from storage. State (timestamps, links) is passed in as arguments.
 *   This makes the module fully testable with no mocking.
 *
 * FILES THAT IMPORT THIS:
 *   - src/utils/cognitiveMemory.ts (computeEffectiveImportance)
 *   - src/tools/graphHandlers.ts (search re-ranking pipeline)
 * ═══════════════════════════════════════════════════════════════════
 */

// ─── Constants ────────────────────────────────────────────────

/** ACT-R standard decay parameter. Higher = faster forgetting. */
export const ACT_R_DEFAULT_DECAY = 0.5;

/** Hard floor for activation when no access history exists. */
export const ACTIVATION_FLOOR = -10.0;

/**
 * Minimum time delta in seconds. Prevents division by zero
 * when a memory was accessed in the same second (or subsecond).
 * Rule #4: Hard clamp t_j ≥ 1.0s.
 */
export const MIN_TIME_DELTA_SECONDS = 1.0;

/** Default parameterized sigmoid midpoint. */
export const DEFAULT_SIGMOID_MIDPOINT = -2.0;

/** Default parameterized sigmoid steepness. */
export const DEFAULT_SIGMOID_STEEPNESS = 1.0;

/** Default similarity weight in composite score. */
export const DEFAULT_WEIGHT_SIMILARITY = 0.7;

/** Default activation weight in composite score. */
export const DEFAULT_WEIGHT_ACTIVATION = 0.3;


// ─── Base-Level Activation ────────────────────────────────────

/**
 * Computes ACT-R base-level activation for a memory item.
 *
 * B_i = ln(Σ t_j^(-d))
 *
 * Where:
 *   t_j = max(1.0, seconds since j-th access)  ← CLAMPED (Rule #4)
 *   d   = decay parameter (0.5 per ACT-R standard)
 *
 * Interpretation:
 *   - More recent accesses → larger t^(-d) → higher B_i
 *   - More total accesses  → more terms in sum → higher B_i
 *   - Very old accesses    → t^(-d) ≈ 0 → negligible contribution
 *
 * Edge cases:
 *   - Zero accesses → ACTIVATION_FLOOR (-10.0)
 *   - Single access just now → ln(1^-0.5) = ln(1) = 0.0 (neutral)
 *   - Sub-second timestamps → clamped to 1.0s (prevents Infinity)
 *   - Negative time delta (clock skew) → clamped to 1.0s
 *
 * @param accessTimestamps - Array of Date objects, one per access event
 * @param now - Current time reference (injected for testability)
 * @param decayRate - ACT-R decay parameter d (default: 0.5)
 * @returns Base-level activation value (typically -10 to +5 range)
 */
export function baseLevelActivation(
  accessTimestamps: Date[],
  now: Date,
  decayRate: number = ACT_R_DEFAULT_DECAY
): number {
  if (accessTimestamps.length === 0) {
    return ACTIVATION_FLOOR;
  }

  const nowMs = now.getTime();
  let sum = 0;

  for (const ts of accessTimestamps) {
    // Seconds since this access occurred
    const deltaMs = nowMs - ts.getTime();
    const deltaSec = Math.max(MIN_TIME_DELTA_SECONDS, deltaMs / 1000);

    // t_j^(-d)  — each access contributes to the sum
    sum += Math.pow(deltaSec, -decayRate);
  }

  // Guard against sum=0 (shouldn't happen with clamped t, but be safe)
  if (sum <= 0) {
    return ACTIVATION_FLOOR;
  }

  return Math.log(sum);
}


// ─── Candidate-Scoped Spreading Activation ────────────────────

/**
 * Computes spreading activation scoped to the current search result set.
 *
 * S_i = Σ(W × link.strength) for links where target_id ∈ candidateIds
 *
 * CRITICAL DESIGN (Rule #5: No God Nodes):
 *   Only counts links pointing to OTHER entries in the current search
 *   result set. A memory connected to 1000 random entries but only
 *   2 search results gets S_i based on those 2 only.
 *
 *   This prevents "hub" memories from dominating rankings just
 *   because they have high degree centrality.
 *
 * W = 1 / |candidateIds| (uniform attention weight across candidates)
 *
 * @param outboundLinks - All outbound links from this memory entry
 * @param candidateIds - Set of entry IDs in the current search result set
 * @returns Spreading activation value (0 to ~1.0 range)
 */
export function candidateScopedSpreadingActivation(
  outboundLinks: Array<{ target_id: string; strength: number }>,
  candidateIds: Set<string>
): number {
  if (candidateIds.size === 0 || outboundLinks.length === 0) {
    return 0;
  }

  // Filter to only links pointing to other search results
  const relevantLinks = outboundLinks.filter(l => candidateIds.has(l.target_id));

  if (relevantLinks.length === 0) {
    return 0;
  }

  // Uniform attention weight across all candidates
  const W = 1 / candidateIds.size;

  return relevantLinks.reduce((sum, link) => sum + W * link.strength, 0);
}


// ─── Parameterized Sigmoid ────────────────────────────────────

/**
 * Parameterized sigmoid normalization.
 *
 * σ(x) = 1 / (1 + e^(-k(x - x₀)))
 *
 * WHY NOT STANDARD SIGMOID?
 *   Standard sigmoid σ(x) = 1/(1+e^(-x)) is centered at 0. But ACT-R
 *   base-level activations naturally cluster in the -7 to +3 range.
 *   A naive sigmoid would compress most values near 0.01-0.11, making
 *   the activation weight irrelevant.
 *
 * CALIBRATED DEFAULTS (from ACT-R activation distribution):
 *   x₀ = -2.0 (midpoint: activation of -2 maps to 0.5)
 *   k  = 1.0  (steepness)
 *
 * Resulting discrimination:
 *   B = -10 → σ ≈ 0.0003 (dead memory, near-zero boost)
 *   B = -5  → σ ≈ 0.047  (cold memory, minimal boost)
 *   B = -2  → σ = 0.50   (moderate, midpoint)
 *   B =  0  → σ ≈ 0.88   (fresh memory, strong boost)
 *   B = +3  → σ ≈ 0.99   (hot memory, maximum boost)
 *
 * @param x - Raw activation value (B_i + S_i)
 * @param midpoint - Activation value that maps to 0.5 (default: -2.0)
 * @param steepness - How sharply the curve rises (default: 1.0)
 * @returns Normalized activation in (0, 1)
 */
export function parameterizedSigmoid(
  x: number,
  midpoint: number = DEFAULT_SIGMOID_MIDPOINT,
  steepness: number = DEFAULT_SIGMOID_STEEPNESS
): number {
  // Guard against NaN/Infinity inputs
  if (!Number.isFinite(x)) {
    return x > 0 ? 1.0 : 0.0;
  }

  const exponent = -steepness * (x - midpoint);

  // Prevent overflow: if exponent is very large, sigmoid ≈ 0
  // If exponent is very negative, sigmoid ≈ 1
  if (exponent > 500) return 0;
  if (exponent < -500) return 1;

  return 1 / (1 + Math.exp(exponent));
}


// ─── Composite Retrieval Score ────────────────────────────────

/**
 * Computes the final retrieval ranking score combining similarity
 * and ACT-R activation.
 *
 * Score = w_sim × similarity + w_act × σ(activation)
 *
 * The parameterized sigmoid normalizes activation from (-∞, +∞)
 * to (0, 1) so the two components are on comparable scales.
 *
 * Default weights: w_sim = 0.7, w_act = 0.3
 * (Similarity dominates — activation is a re-ranking boost, not a replacement)
 *
 * @param similarity - Cosine similarity score from vector search (0 to 1)
 * @param activation - Raw ACT-R activation (B_i + S_i, pre-sigmoid)
 * @param weightSimilarity - Weight for similarity component (default: 0.7)
 * @param weightActivation - Weight for activation component (default: 0.3)
 * @param sigmoidMidpoint - Sigmoid midpoint (default: -2.0)
 * @param sigmoidSteepness - Sigmoid steepness (default: 1.0)
 * @returns Composite score (higher = better retrieval candidate)
 */
export function compositeRetrievalScore(
  similarity: number,
  activation: number,
  weightSimilarity: number = DEFAULT_WEIGHT_SIMILARITY,
  weightActivation: number = DEFAULT_WEIGHT_ACTIVATION,
  sigmoidMidpoint: number = DEFAULT_SIGMOID_MIDPOINT,
  sigmoidSteepness: number = DEFAULT_SIGMOID_STEEPNESS
): number {
  const normalizedActivation = parameterizedSigmoid(
    activation,
    sigmoidMidpoint,
    sigmoidSteepness
  );

  return weightSimilarity * similarity + weightActivation * normalizedActivation;
}
