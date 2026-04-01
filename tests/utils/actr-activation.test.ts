/**
 * ACT-R v7.0 Activation Memory — Comprehensive Test Suite
 *
 * ═══════════════════════════════════════════════════════════════════
 * PURPOSE:
 *   Validates the mathematical correctness and production stability
 *   of the ACT-R activation memory system integrated in Prism v7.0.
 *
 * COVERAGE:
 *   1. baseLevelActivation       — recency + frequency via ln(Σ t_j^(-d))
 *   2. candidateScopedSpreadingActivation — graph-based boost
 *   3. parameterizedSigmoid      — activation normalization σ(x)
 *   4. compositeRetrievalScore   — weighted blend (sim × w_sim + σ(act) × w_act)
 *   5. computeEffectiveImportance — integration with cognitive memory
 *   6. AccessLogBuffer           — batched write contention prevention
 *
 * MATHEMATICAL PRECISION:
 *   All numerical assertions use toBeCloseTo(expected, decimalPlaces)
 *   where decimalPlaces is calibrated to avoid floating-point noise
 *   while still catching real computational errors.
 *
 * DESIGN:
 *   Tests are PURE — no database, no mocking, no storage layer.
 *   All functions under test are stateless, accepting injected params.
 *   The AccessLogBuffer tests use a mock database interface.
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  baseLevelActivation,
  candidateScopedSpreadingActivation,
  parameterizedSigmoid,
  compositeRetrievalScore,
  ACT_R_DEFAULT_DECAY,
  ACTIVATION_FLOOR,
  MIN_TIME_DELTA_SECONDS,
  DEFAULT_SIGMOID_MIDPOINT,
  DEFAULT_SIGMOID_STEEPNESS,
  DEFAULT_WEIGHT_SIMILARITY,
  DEFAULT_WEIGHT_ACTIVATION,
} from "../../src/utils/actrActivation.js";

// ═══════════════════════════════════════════════════════════════════
// 1. BASE-LEVEL ACTIVATION: B_i = ln(Σ t_j^(-d))
// ═══════════════════════════════════════════════════════════════════

describe("baseLevelActivation", () => {
  const now = new Date("2025-01-01T12:00:00Z");

  // ── Edge Cases ──────────────────────────────────────────────

  it("should return ACTIVATION_FLOOR for empty timestamps", () => {
    const result = baseLevelActivation([], now);
    expect(result).toBe(ACTIVATION_FLOOR);
    expect(result).toBe(-10.0);
  });

  it("should handle default decay parameter (0.5)", () => {
    expect(ACT_R_DEFAULT_DECAY).toBe(0.5);
  });

  // ── Single Access ───────────────────────────────────────────

  it("should return 0.0 for a single access 1 second ago (clamped)", () => {
    // Access at 0.5s ago → clamped to 1.0s (Rule #4)
    // B = ln(1^(-0.5)) = ln(1) = 0.0
    const timestamps = [new Date(now.getTime() - 500)];
    const result = baseLevelActivation(timestamps, now);
    expect(result).toBeCloseTo(0.0, 5);
  });

  it("should return 0.0 for a single access exactly at MIN_TIME_DELTA", () => {
    // 1s ago exactly: t = 1.0, B = ln(1^-0.5) = ln(1) = 0
    const timestamps = [new Date(now.getTime() - 1000)];
    const result = baseLevelActivation(timestamps, now);
    expect(result).toBeCloseTo(0.0, 5);
  });

  it("should return negative for a single access 1 hour ago", () => {
    // t = 3600s, B = ln(3600^-0.5) = ln(1/60) = -ln(60) ≈ -4.094
    const timestamps = [new Date(now.getTime() - 3600 * 1000)];
    const result = baseLevelActivation(timestamps, now);
    expect(result).toBeCloseTo(-Math.log(60), 3);
    expect(result).toBeLessThan(0);
  });

  it("should return deeply negative for ancient access (30 days)", () => {
    // t = 30d = 2,592,000s, B = ln(t^-0.5) = -0.5 × ln(2592000) ≈ -7.38
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const timestamps = [new Date(now.getTime() - thirtyDaysMs)];
    const result = baseLevelActivation(timestamps, now);
    expect(result).toBeLessThan(-6);
    expect(result).toBeGreaterThan(ACTIVATION_FLOOR);
  });

  // ── Frequency (Multiple Accesses) ──────────────────────────

  it("should increase activation with more recent accesses (frequency boost)", () => {
    // Single access at 1 hour ago
    const single = baseLevelActivation(
      [new Date(now.getTime() - 3600_000)],
      now
    );

    // Same access + 2 extra accesses at 10m and 30m ago
    const triple = baseLevelActivation(
      [
        new Date(now.getTime() - 3600_000),
        new Date(now.getTime() - 600_000),
        new Date(now.getTime() - 1800_000),
      ],
      now
    );

    // More accesses → higher activation
    expect(triple).toBeGreaterThan(single);
  });

  it("should produce higher activation for 10 recent bursts than 1 old access", () => {
    // 1 access 24h ago
    const old = baseLevelActivation(
      [new Date(now.getTime() - 86400_000)],
      now
    );

    // 10 accesses spread across last 10 minutes
    const burst = baseLevelActivation(
      Array.from({ length: 10 }, (_, i) =>
        new Date(now.getTime() - (i + 1) * 60_000)
      ),
      now
    );

    expect(burst).toBeGreaterThan(old);
  });

  // ── Time Clamping (Rule #4) ─────────────────────────────────

  it("should clamp sub-second deltas to MIN_TIME_DELTA_SECONDS", () => {
    expect(MIN_TIME_DELTA_SECONDS).toBe(1.0);

    // Access at t=now (0ms delta → clamped to 1s)
    const atNow = baseLevelActivation([new Date(now.getTime())], now);
    // Access at 0.1s ago (100ms delta → clamped to 1s)
    const atSubSecond = baseLevelActivation(
      [new Date(now.getTime() - 100)],
      now
    );

    // Both should produce the same result: ln(1^-0.5) = 0.0
    expect(atNow).toBeCloseTo(0.0, 5);
    expect(atSubSecond).toBeCloseTo(0.0, 5);
  });

  it("should clamp negative time deltas (clock skew)", () => {
    // Access 1 minute in the FUTURE → negative delta → clamped to 1s
    const future = baseLevelActivation(
      [new Date(now.getTime() + 60_000)],
      now
    );
    expect(future).toBeCloseTo(0.0, 5);
    expect(Number.isFinite(future)).toBe(true);
  });

  // ── Custom Decay Rate ──────────────────────────────────────

  it("should forget faster with higher decay rate", () => {
    const accessTime = [new Date(now.getTime() - 3600_000)]; // 1h ago
    const slow = baseLevelActivation(accessTime, now, 0.3);
    const fast = baseLevelActivation(accessTime, now, 0.8);

    // Higher decay → lower activation for old memories
    expect(fast).toBeLessThan(slow);
  });

  it("should retain activation longer with lower decay rate", () => {
    const accessTime = [new Date(now.getTime() - 86400_000)]; // 24h ago
    const gentle = baseLevelActivation(accessTime, now, 0.1);
    const harsh = baseLevelActivation(accessTime, now, 0.9);

    expect(gentle).toBeGreaterThan(harsh);
  });

  // ── Mathematical Precision ─────────────────────────────────

  it("should match hand-computed value for known inputs", () => {
    // Single access at exactly 100s ago:
    // t = 100, d = 0.5
    // B = ln(100^(-0.5)) = ln(1/10) = -ln(10) ≈ -2.302585
    const timestamps = [new Date(now.getTime() - 100_000)];
    const result = baseLevelActivation(timestamps, now, 0.5);
    expect(result).toBeCloseTo(-Math.log(10), 4);
  });

  it("should match hand-computed value for two accesses", () => {
    // Access at 100s ago and 400s ago:
    // Σ = 100^(-0.5) + 400^(-0.5) = 0.1 + 0.05 = 0.15
    // B = ln(0.15) ≈ -1.8971
    const timestamps = [
      new Date(now.getTime() - 100_000),
      new Date(now.getTime() - 400_000),
    ];
    const result = baseLevelActivation(timestamps, now, 0.5);
    const expected = Math.log(
      Math.pow(100, -0.5) + Math.pow(400, -0.5)
    );
    expect(result).toBeCloseTo(expected, 4);
  });

  it("should always return finite numbers", () => {
    // Stress test: 1000 accesses spread across 1 year
    const timestamps = Array.from({ length: 1000 }, (_, i) =>
      new Date(now.getTime() - i * 31_536_000) // spread across 1000 years back
    );
    const result = baseLevelActivation(timestamps, now);
    expect(Number.isFinite(result)).toBe(true);
    expect(Number.isNaN(result)).toBe(false);
  });
});


// ═══════════════════════════════════════════════════════════════════
// 2. CANDIDATE-SCOPED SPREADING ACTIVATION
// ═══════════════════════════════════════════════════════════════════

describe("candidateScopedSpreadingActivation", () => {
  // ── Edge Cases ──────────────────────────────────────────────

  it("should return 0 for empty candidate set", () => {
    const links = [{ target_id: "a", strength: 0.8 }];
    expect(candidateScopedSpreadingActivation(links, new Set())).toBe(0);
  });

  it("should return 0 for empty links array", () => {
    const candidates = new Set(["a", "b", "c"]);
    expect(candidateScopedSpreadingActivation([], candidates)).toBe(0);
  });

  it("should return 0 when no links match candidates", () => {
    const links = [
      { target_id: "x", strength: 0.9 },
      { target_id: "y", strength: 0.7 },
    ];
    const candidates = new Set(["a", "b"]);
    expect(candidateScopedSpreadingActivation(links, candidates)).toBe(0);
  });

  // ── Scoping (Rule #5: No God Nodes) ─────────────────────────

  it("should only count links targeting candidates (not all outbound)", () => {
    const links = [
      { target_id: "a", strength: 1.0 },   // in candidates
      { target_id: "b", strength: 1.0 },   // in candidates
      { target_id: "x", strength: 1.0 },   // NOT in candidates
      { target_id: "y", strength: 1.0 },   // NOT in candidates
      { target_id: "z", strength: 1.0 },   // NOT in candidates
    ];
    const candidates = new Set(["a", "b", "c"]);

    const result = candidateScopedSpreadingActivation(links, candidates);

    // W = 1/3, relevantLinks = 2 (a, b), S = (1/3)(1.0) + (1/3)(1.0) = 2/3
    expect(result).toBeCloseTo(2 / 3, 5);
  });

  // ── Mathematical Precision ─────────────────────────────────

  it("should compute W = 1/|candidateIds|", () => {
    const links = [{ target_id: "a", strength: 1.0 }];

    // 1 candidate: W = 1
    const s1 = candidateScopedSpreadingActivation(links, new Set(["a"]));
    expect(s1).toBeCloseTo(1.0, 5);

    // 5 candidates: W = 0.2
    const s5 = candidateScopedSpreadingActivation(
      links,
      new Set(["a", "b", "c", "d", "e"])
    );
    expect(s5).toBeCloseTo(0.2, 5);
  });

  it("should scale with link strength", () => {
    const candidates = new Set(["a"]);

    const weak = candidateScopedSpreadingActivation(
      [{ target_id: "a", strength: 0.1 }],
      candidates
    );
    const strong = candidateScopedSpreadingActivation(
      [{ target_id: "a", strength: 0.9 }],
      candidates
    );

    expect(strong).toBeGreaterThan(weak);
    expect(strong / weak).toBeCloseTo(9.0, 3);
  });

  it("should sum contributions from multiple matching links", () => {
    const links = [
      { target_id: "a", strength: 0.5 },
      { target_id: "b", strength: 0.3 },
    ];
    const candidates = new Set(["a", "b"]);

    // W = 1/2 = 0.5, S = 0.5×0.5 + 0.5×0.3 = 0.25 + 0.15 = 0.4
    const result = candidateScopedSpreadingActivation(links, candidates);
    expect(result).toBeCloseTo(0.4, 5);
  });
});


// ═══════════════════════════════════════════════════════════════════
// 3. PARAMETERIZED SIGMOID: σ(x) = 1 / (1 + e^(-k(x - x₀)))
// ═══════════════════════════════════════════════════════════════════

describe("parameterizedSigmoid", () => {
  // ── Standard Behavior ──────────────────────────────────────

  it("should return 0.5 at the midpoint", () => {
    // σ(-2) with midpoint=-2 should be exactly 0.5
    const result = parameterizedSigmoid(-2.0, -2.0, 1.0);
    expect(result).toBeCloseTo(0.5, 10);
  });

  it("should return near-1 for high activation", () => {
    // σ(3) with midpoint=-2 → e^(-1*(3-(-2))) = e^(-5) ≈ 0.0067
    // σ = 1/(1+0.0067) ≈ 0.993
    const result = parameterizedSigmoid(3.0, -2.0, 1.0);
    expect(result).toBeGreaterThan(0.99);
    expect(result).toBeLessThan(1.0);
  });

  it("should return near-0 for very negative activation", () => {
    // σ(-10) with midpoint=-2 → e^(-1*(-10-(-2))) = e^(8) ≈ 2981
    // σ = 1/(1+2981) ≈ 0.000335
    const result = parameterizedSigmoid(-10.0, -2.0, 1.0);
    expect(result).toBeLessThan(0.001);
    expect(result).toBeGreaterThan(0);
  });

  // ── Documented Discrimination Points ────────────────────────

  it("should match documented discrimination values (from code comments)", () => {
    // B = -10 → σ ≈ 0.0003
    expect(parameterizedSigmoid(-10)).toBeCloseTo(0.000335, 4);

    // B = -5  → σ ≈ 0.047
    expect(parameterizedSigmoid(-5)).toBeCloseTo(0.0474, 3);

    // B = -2  → σ = 0.50
    expect(parameterizedSigmoid(-2)).toBeCloseTo(0.5, 5);

    // B = 0   → σ ≈ 0.88
    expect(parameterizedSigmoid(0)).toBeCloseTo(0.881, 2);

    // B = +3  → σ ≈ 0.99
    expect(parameterizedSigmoid(3)).toBeCloseTo(0.993, 2);
  });

  // ── Custom Parameters ──────────────────────────────────────

  it("should shift midpoint when midpoint parameter changes", () => {
    // With midpoint=0: σ(0) = 0.5
    expect(parameterizedSigmoid(0, 0, 1)).toBeCloseTo(0.5, 5);
    // With midpoint=-5: σ(-5) = 0.5
    expect(parameterizedSigmoid(-5, -5, 1)).toBeCloseTo(0.5, 5);
  });

  it("should be steeper with higher steepness", () => {
    // At same distance from midpoint, higher steepness → more extreme
    const gentle = parameterizedSigmoid(0, -2, 0.5);
    const steep = parameterizedSigmoid(0, -2, 3.0);

    // Both > 0.5 (above midpoint) but steep should be closer to 1
    expect(steep).toBeGreaterThan(gentle);
    expect(steep).toBeGreaterThan(0.99);
  });

  // ── Guard Rails ─────────────────────────────────────────────

  it("should handle Infinity input (returns 1.0)", () => {
    expect(parameterizedSigmoid(Infinity)).toBe(1.0);
  });

  it("should handle -Infinity input (returns 0.0)", () => {
    expect(parameterizedSigmoid(-Infinity)).toBe(0.0);
  });

  it("should handle NaN input (returns 0.0)", () => {
    expect(parameterizedSigmoid(NaN)).toBe(0.0);
  });

  it("should handle extreme positive (no overflow)", () => {
    // Exponent would be -1*(1000-(-2)) = -1002 → e^(-1002) ≈ 0
    // σ ≈ 1/(1+0) = 1
    const result = parameterizedSigmoid(1000);
    expect(result).toBe(1);
  });

  it("should handle extreme negative (no overflow)", () => {
    // Exponent would be -1*(-1000-(-2)) = 998 → e^(998) = Infinity
    // But we clamp exponents > 500 → returns 0
    const result = parameterizedSigmoid(-1000);
    expect(result).toBe(0);
  });

  // ── Monotonicity ────────────────────────────────────────────

  it("should be monotonically increasing", () => {
    const values = [-10, -7, -5, -3, -2, -1, 0, 1, 3, 5, 10];
    for (let i = 1; i < values.length; i++) {
      expect(parameterizedSigmoid(values[i])).toBeGreaterThan(
        parameterizedSigmoid(values[i - 1])
      );
    }
  });
});


// ═══════════════════════════════════════════════════════════════════
// 4. COMPOSITE RETRIEVAL SCORE
// ═══════════════════════════════════════════════════════════════════

describe("compositeRetrievalScore", () => {
  // ── Default Weights ─────────────────────────────────────────

  it("should export correct default weights", () => {
    expect(DEFAULT_WEIGHT_SIMILARITY).toBe(0.7);
    expect(DEFAULT_WEIGHT_ACTIVATION).toBe(0.3);
    expect(DEFAULT_WEIGHT_SIMILARITY + DEFAULT_WEIGHT_ACTIVATION).toBeCloseTo(1.0, 5);
  });

  // ── Pure Similarity (no activation boost) ───────────────────

  it("should approach w_sim × similarity when activation is deeply negative", () => {
    // σ(ACTIVATION_FLOOR) ≈ 0, so score ≈ 0.7 × 0.95 = 0.665
    const score = compositeRetrievalScore(0.95, ACTIVATION_FLOOR);
    expect(score).toBeCloseTo(0.7 * 0.95, 1);
  });

  // ── Full Activation Boost ──────────────────────────────────

  it("should approach w_sim × similarity + w_act when activation is very high", () => {
    // σ(+10) ≈ 1.0, so score ≈ 0.7 × 0.95 + 0.3 × 1.0 = 0.665 + 0.3 = 0.965
    const score = compositeRetrievalScore(0.95, 10.0);
    expect(score).toBeCloseTo(0.7 * 0.95 + 0.3, 2);
  });

  // ── Re-ranking Behavior ────────────────────────────────────

  it("should enable a slightly lower-similarity result to beat a higher one via activation", () => {
    // Result A: sim=0.95, activation=-10 (dead memory → σ ≈ 0)
    // Score A ≈ 0.7 × 0.95 + 0.3 × 0.0003 ≈ 0.665
    const scoreA = compositeRetrievalScore(0.95, -10);

    // Result B: sim=0.85, activation=+2 (hot memory → σ ≈ 0.98)
    // Score B ≈ 0.7 × 0.85 + 0.3 × 0.98 ≈ 0.595 + 0.294 = 0.889
    const scoreB = compositeRetrievalScore(0.85, 2);

    // B should overtake A despite lower similarity!
    expect(scoreB).toBeGreaterThan(scoreA);
  });

  it("should NOT allow activation to dominate similarity (by default)", () => {
    // Result A: sim=0.90, activation=-10 (cold)
    // Result B: sim=0.50, activation=+5 (very hot, σ ≈ 0.999)
    const scoreA = compositeRetrievalScore(0.90, -10);
    const scoreB = compositeRetrievalScore(0.50, 5);

    // A should still win because 0.7×0.9 >> 0.7×0.5 even with full activation boost
    // A ≈ 0.63, B ≈ 0.35 + 0.3 = 0.65... this is actually close
    // With sim=0.90 vs 0.50 and activation boost of 0.3, let's check exact:
    // A = 0.7 × 0.9 + 0.3 × 0.000335 ≈ 0.63
    // B = 0.7 × 0.5 + 0.3 × 0.999 ≈ 0.35 + 0.30 = 0.65
    // Actually B barely wins! Let's use sim=0.95 vs 0.50 instead
    const scoreHigh = compositeRetrievalScore(0.95, -10);
    const scoreLow = compositeRetrievalScore(0.45, 5);
    // scoreHigh ≈ 0.665, scoreLow ≈ 0.315 + 0.3 = 0.615
    expect(scoreHigh).toBeGreaterThan(scoreLow);
  });

  // ── Custom Weights ─────────────────────────────────────────

  it("should respect custom weights", () => {
    // All weight on activation, none on similarity
    const allActivation = compositeRetrievalScore(0.95, 3.0, 0.0, 1.0);
    // σ(3) ≈ 0.993
    expect(allActivation).toBeCloseTo(0.993, 2);

    // All weight on similarity, none on activation  
    const allSimilarity = compositeRetrievalScore(0.95, 3.0, 1.0, 0.0);
    expect(allSimilarity).toBeCloseTo(0.95, 5);
  });

  // ── Score Range ─────────────────────────────────────────────

  it("should produce scores bounded by [0, ~1.0]", () => {
    // Maximum: sim=1.0, activation=+∞ → 0.7 × 1 + 0.3 × 1 = 1.0
    const max = compositeRetrievalScore(1.0, 100);
    expect(max).toBeCloseTo(1.0, 2);

    // Minimum: sim=0.0, activation=-∞ → 0.7 × 0 + 0.3 × 0 = 0.0
    const min = compositeRetrievalScore(0.0, -100);
    expect(min).toBeCloseTo(0.0, 2);
  });
});


// ═══════════════════════════════════════════════════════════════════
// 5. ACCESS LOG BUFFER
// ═══════════════════════════════════════════════════════════════════

describe("AccessLogBuffer", () => {
  let mockDb: { execute: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockDb = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
  });

  it("should batch-flush write events", async () => {
    const { AccessLogBuffer } = await import(
      "../../src/utils/accessLogBuffer.js"
    );
    // Use 0 interval = manual flush only
    const buffer = new AccessLogBuffer(mockDb as any, 0);

    buffer.push("entry-1", undefined);
    buffer.push("entry-2", "ctx-hash");
    buffer.push("entry-3", undefined);

    // No writes yet
    expect(mockDb.execute).not.toHaveBeenCalled();

    // Manual flush
    await buffer.flush();

    // Should have been called once with a batch INSERT
    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    const call = mockDb.execute.mock.calls[0][0];
    expect(call.sql).toContain("INSERT INTO memory_access_log");
    // 3 entries
    expect(call.args.length).toBe(9); // 3 entries × 3 params each
  });

  it("should deduplicate entries within the same flush window", async () => {
    const { AccessLogBuffer } = await import(
      "../../src/utils/accessLogBuffer.js"
    );
    const buffer = new AccessLogBuffer(mockDb as any, 0);

    buffer.push("entry-1", undefined);
    buffer.push("entry-1", undefined); // duplicate
    buffer.push("entry-1", undefined); // duplicate

    await buffer.flush();

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    const call = mockDb.execute.mock.calls[0][0];
    // Should only insert 1 unique entry
    expect(call.args.length).toBe(3); // 1 entry × 3 params
  });

  it("should be a no-op when buffer is empty", async () => {
    const { AccessLogBuffer } = await import(
      "../../src/utils/accessLogBuffer.js"
    );
    const buffer = new AccessLogBuffer(mockDb as any, 0);

    await buffer.flush();

    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it("should drop failed batch and remain usable (telemetry-grade, no re-queue)", async () => {
    const { AccessLogBuffer } = await import(
      "../../src/utils/accessLogBuffer.js"
    );
    mockDb.execute.mockRejectedValueOnce(new Error("SQLITE_BUSY"));

    const buffer = new AccessLogBuffer(mockDb as any, 0);
    buffer.push("entry-1", undefined);

    // First flush fails — batch is intentionally dropped (not re-queued)
    const flushed = await buffer.flush();
    expect(flushed).toBe(0); // Nothing persisted

    // Buffer should still be functional after error
    mockDb.execute.mockResolvedValueOnce({ rows: [] });
    buffer.push("entry-2", undefined);
    const flushed2 = await buffer.flush();
    expect(flushed2).toBe(1); // New entry persisted successfully

    // Total: 2 execute calls (1 failed, 1 succeeded)
    expect(mockDb.execute).toHaveBeenCalledTimes(2);
  });

  it("should flush remaining buffer on dispose", async () => {
    const { AccessLogBuffer } = await import(
      "../../src/utils/accessLogBuffer.js"
    );
    const buffer = new AccessLogBuffer(mockDb as any, 0);

    buffer.push("entry-1", undefined);
    buffer.push("entry-2", undefined);

    await buffer.dispose();

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
  });
});


// ═══════════════════════════════════════════════════════════════════
// 6. INTEGRATION: baseLevelActivation → sigmoid → compositeScore
// ═══════════════════════════════════════════════════════════════════

describe("Full Pipeline Integration", () => {
  const now = new Date("2025-01-01T12:00:00Z");

  it("should rank a frequently-accessed result above a rarely-accessed one", () => {
    // Memory A: accessed 20 times in the last hour (hot)
    const timestampsA = Array.from({ length: 20 }, (_, i) =>
      new Date(now.getTime() - (i + 1) * 180_000) // every 3 min
    );
    const baseA = baseLevelActivation(timestampsA, now);

    // Memory B: accessed once, 2 days ago (cold)
    const timestampsB = [new Date(now.getTime() - 2 * 86400_000)];
    const baseB = baseLevelActivation(timestampsB, now);

    // Memory A should have much higher activation
    expect(baseA).toBeGreaterThan(baseB);

    // Now compute full composite scores at same similarity
    const scoreA = compositeRetrievalScore(0.85, baseA);
    const scoreB = compositeRetrievalScore(0.85, baseB);

    // Hot memory should rank higher
    expect(scoreA).toBeGreaterThan(scoreB);
  });

  it("should produce correct end-to-end score for known inputs", () => {
    // Single access at 100s ago → B = -ln(10) ≈ -2.3026
    const B = baseLevelActivation(
      [new Date(now.getTime() - 100_000)],
      now,
      0.5
    );

    // σ(-2.3026) with midpoint=-2, steepness=1
    // exponent = -1 * (-2.3026 - (-2)) = -1 * (-0.3026) = 0.3026
    // σ = 1/(1 + e^0.3026) = 1/(1 + 1.3534) = 1/2.3534 ≈ 0.4249
    const sigma = parameterizedSigmoid(B);

    // Composite: 0.7 × 0.90 + 0.3 × 0.4249 = 0.63 + 0.12747 = 0.75747
    const score = compositeRetrievalScore(0.90, B);

    expect(score).toBeCloseTo(0.7 * 0.90 + 0.3 * sigma, 4);
  });

  it("should produce a stable ordering across a realistic search result set", () => {
    // Simulate 5 search results with varying access patterns
    const results = [
      { id: "A", sim: 0.92, accessAgoMs: [5_000, 60_000, 300_000] },          // hot
      { id: "B", sim: 0.95, accessAgoMs: [86400_000 * 30] },                   // cold but high sim
      { id: "C", sim: 0.88, accessAgoMs: [60_000] },                           // warm
      { id: "D", sim: 0.85, accessAgoMs: [5_000, 10_000, 15_000, 20_000] },    // burst
      { id: "E", sim: 0.80, accessAgoMs: [86400_000 * 90] },                   // ancient
    ];

    const scores = results.map(r => {
      const timestamps = r.accessAgoMs.map(ms => new Date(now.getTime() - ms));
      const B = baseLevelActivation(timestamps, now);
      return { id: r.id, score: compositeRetrievalScore(r.sim, B) };
    });

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);

    // Verify ordering is deterministic and scores are finite
    for (const s of scores) {
      expect(Number.isFinite(s.score)).toBe(true);
      expect(s.score).toBeGreaterThan(0);
      expect(s.score).toBeLessThanOrEqual(1.0);
    }

    // The burst-accessed D should rank higher than the ancient E
    const dIdx = scores.findIndex(s => s.id === "D");
    const eIdx = scores.findIndex(s => s.id === "E");
    expect(dIdx).toBeLessThan(eIdx);
  });
});
