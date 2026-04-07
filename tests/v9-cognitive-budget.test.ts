/**
 * v9.0 Cognitive Budget Tests
 *
 * Tests for Token-Economic RL: budget spending, UBI earnings,
 * cost multipliers, surprisal integration, and edge cases.
 */

import { describe, it, expect } from "vitest";
import {
  computeCostMultiplier,
  estimateTokens,
  computeUBI,
  computeEventBonus,
  spendBudget,
  applyEarnings,
  formatBudgetDiagnostics,
  DEFAULT_BUDGET_SIZE,
  MINIMUM_BASE_COST,
  UBI_TOKENS_PER_HOUR,
  UBI_MAX_PER_SESSION,
  SUCCESS_BONUS,
  LEARNING_BONUS,
  LOW_BUDGET_THRESHOLD,
  BOILERPLATE_THRESHOLD,
  NOVEL_THRESHOLD,
} from "../src/memory/cognitiveBudget.js";
import {
  computeSurprisal,
  BOILERPLATE_SIMILARITY,
  NOVEL_SIMILARITY,
} from "../src/memory/surprisalGate.js";

// ─── Cost Multiplier ────────────────────────────────────────

describe("computeCostMultiplier", () => {
  it("returns 2.0 for boilerplate (low surprisal)", () => {
    expect(computeCostMultiplier(0.1)).toBe(2.0);
    expect(computeCostMultiplier(0.0)).toBe(2.0);
    expect(computeCostMultiplier(0.15)).toBe(2.0);
  });

  it("returns 1.0 for standard surprisal", () => {
    expect(computeCostMultiplier(0.3)).toBe(1.0);
    expect(computeCostMultiplier(0.5)).toBe(1.0);
    expect(computeCostMultiplier(0.65)).toBe(1.0);
  });

  it("returns 0.5 for novel (high surprisal)", () => {
    expect(computeCostMultiplier(0.8)).toBe(0.5);
    expect(computeCostMultiplier(0.95)).toBe(0.5);
    expect(computeCostMultiplier(1.0)).toBe(0.5);
  });

  it("returns 1.0 for NaN/Infinity", () => {
    expect(computeCostMultiplier(NaN)).toBe(1.0);
    expect(computeCostMultiplier(Infinity)).toBe(1.0);
  });

  it("applies exact threshold: 0.2 → standard (not boilerplate)", () => {
    expect(computeCostMultiplier(BOILERPLATE_THRESHOLD)).toBe(1.0);
  });

  it("applies exact threshold: 0.7 → standard (not novel)", () => {
    expect(computeCostMultiplier(NOVEL_THRESHOLD)).toBe(1.0);
  });
});

// ─── Token Estimation ───────────────────────────────────────

describe("estimateTokens", () => {
  it("estimates tokens as ceil(length / 4)", () => {
    const text = "This is a moderately long summary for testing token estimation";
    expect(estimateTokens(text)).toBe(Math.ceil(text.length / 4));
  });

  it("enforces minimum base cost for empty strings", () => {
    expect(estimateTokens("")).toBe(MINIMUM_BASE_COST);
    expect(estimateTokens("   ")).toBe(MINIMUM_BASE_COST);
  });

  it("enforces minimum base cost for very short strings", () => {
    expect(estimateTokens("hi")).toBe(MINIMUM_BASE_COST);
  });

  it("handles normal-length summaries", () => {
    const summary = "Implemented the cognitive budget system with vector-based surprisal scoring and persistent project-scoped balances";
    const expected = Math.ceil(summary.length / 4);
    expect(estimateTokens(summary)).toBe(expected);
  });
});

// ─── UBI (Universal Basic Income) ───────────────────────────

describe("computeUBI", () => {
  it("returns 0 for null lastSaveTime (first save)", () => {
    expect(computeUBI(null)).toBe(0);
    expect(computeUBI(undefined)).toBe(0);
  });

  it("returns 0 for invalid timestamp", () => {
    expect(computeUBI("not-a-date")).toBe(0);
  });

  it("returns 0 for future lastSaveTime", () => {
    const futureDate = new Date(Date.now() + 3600000).toISOString();
    expect(computeUBI(futureDate)).toBe(0);
  });

  it("returns 100 tokens for 1 hour elapsed", () => {
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const now = new Date();
    expect(computeUBI(oneHourAgo, now)).toBe(UBI_TOKENS_PER_HOUR);
  });

  it("returns 200 tokens for 2 hours elapsed", () => {
    const twoHoursAgo = new Date(Date.now() - 7200000).toISOString();
    const now = new Date();
    expect(computeUBI(twoHoursAgo, now)).toBe(200);
  });

  it("caps at UBI_MAX_PER_SESSION for long durations", () => {
    const tenHoursAgo = new Date(Date.now() - 36000000).toISOString();
    const now = new Date();
    expect(computeUBI(tenHoursAgo, now)).toBe(UBI_MAX_PER_SESSION);
  });

  it("returns 0 for very recent saves (< 1 hour)", () => {
    const thirtyMinAgo = new Date(Date.now() - 1800000).toISOString();
    const now = new Date();
    // 0.5 hours × 100 = 50, floor = 50
    expect(computeUBI(thirtyMinAgo, now)).toBe(50);
  });
});

// ─── Event Bonuses ──────────────────────────────────────────

describe("computeEventBonus", () => {
  it("returns SUCCESS_BONUS for success events", () => {
    expect(computeEventBonus("success")).toBe(SUCCESS_BONUS);
  });

  it("returns LEARNING_BONUS for learning events", () => {
    expect(computeEventBonus("learning")).toBe(LEARNING_BONUS);
  });

  it("returns 0 for other event types", () => {
    expect(computeEventBonus("failure")).toBe(0);
    expect(computeEventBonus("correction")).toBe(0);
    expect(computeEventBonus("session")).toBe(0);
    expect(computeEventBonus(undefined)).toBe(0);
  });
});

// ─── Budget Spending ────────────────────────────────────────

describe("spendBudget", () => {
  it("deducts adjusted cost from balance", () => {
    const result = spendBudget(2000, 100, 0.5); // Standard surprisal → 1× multiplier
    expect(result.spent).toBe(100);
    expect(result.remaining).toBe(1900);
    expect(result.allowed).toBe(true);
  });

  it("applies 2× multiplier for boilerplate", () => {
    const result = spendBudget(2000, 100, 0.1); // Low surprisal → 2× multiplier
    expect(result.spent).toBe(200);
    expect(result.remaining).toBe(1800);
    expect(result.costMultiplier).toBe(2.0);
  });

  it("applies 0.5× multiplier for novel content", () => {
    const result = spendBudget(2000, 100, 0.9); // High surprisal → 0.5× multiplier
    expect(result.spent).toBe(50);
    expect(result.remaining).toBe(1950);
    expect(result.costMultiplier).toBe(0.5);
  });

  it("enforces minimum base cost even for tiny entries", () => {
    const result = spendBudget(2000, 2, 0.5); // Very small cost
    expect(result.spent).toBe(MINIMUM_BASE_COST); // Enforced minimum
  });

  it("always allows the save (graceful degradation)", () => {
    const result = spendBudget(0, 500, 0.5); // Budget already exhausted
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("exhausted");
  });

  it("produces low budget warning when near threshold", () => {
    const result = spendBudget(350, 100, 0.5); // 250 remaining → below LOW_BUDGET_THRESHOLD
    expect(result.remaining).toBe(250);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("running low");
  });

  it("produces no warning when budget is healthy", () => {
    const result = spendBudget(2000, 50, 0.5);
    expect(result.warning).toBeUndefined();
  });

  it("includes surprisal and multiplier in result", () => {
    const result = spendBudget(2000, 100, 0.85);
    expect(result.surprisal).toBe(0.85);
    expect(result.costMultiplier).toBe(0.5);
  });
});

// ─── Earnings (UBI + Bonuses) ───────────────────────────────

describe("applyEarnings", () => {
  it("applies UBI earnings", () => {
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const result = applyEarnings(1500, oneHourAgo, undefined);
    expect(result.ubiEarned).toBeCloseTo(100, 0);
    expect(result.newBalance).toBeCloseTo(1600, 0);
  });

  it("applies event bonus", () => {
    const result = applyEarnings(1500, null, "success");
    expect(result.bonusEarned).toBe(SUCCESS_BONUS);
    expect(result.newBalance).toBe(1500 + SUCCESS_BONUS);
  });

  it("combines UBI + bonus", () => {
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const result = applyEarnings(1500, oneHourAgo, "success");
    expect(result.ubiEarned).toBeCloseTo(100, 0);
    expect(result.bonusEarned).toBe(SUCCESS_BONUS);
    expect(result.newBalance).toBeCloseTo(1500 + 100 + SUCCESS_BONUS, 0);
  });

  it("caps balance at budget size", () => {
    const oneHourAgo = new Date(Date.now() - 36000000).toISOString(); // 10 hours
    const result = applyEarnings(1900, oneHourAgo, "success");
    expect(result.newBalance).toBe(DEFAULT_BUDGET_SIZE); // Capped at max
  });

  it("works from zero balance", () => {
    const twoHoursAgo = new Date(Date.now() - 7200000).toISOString();
    const result = applyEarnings(0, twoHoursAgo, "learning");
    expect(result.ubiEarned).toBe(200);
    expect(result.bonusEarned).toBe(LEARNING_BONUS);
    expect(result.newBalance).toBe(300);
  });
});

// ─── Budget Diagnostics ─────────────────────────────────────

describe("formatBudgetDiagnostics", () => {
  it("produces formatted output with all fields", () => {
    const result = spendBudget(2000, 100, 0.85);
    const output = formatBudgetDiagnostics(result, 2000, 50, 200);

    expect(output).toContain("Budget:");
    expect(output).toContain("1950/2000");
    expect(output).toContain("Surprisal:");
    expect(output).toContain("0.85");
    expect(output).toContain("novel");
    expect(output).toContain("Spent:");
    expect(output).toContain("50 tokens");
    expect(output).toContain("Earned:");
    expect(output).toContain("+50 UBI");
    expect(output).toContain("+200 bonus");
  });

  it("shows boilerplate label for low surprisal", () => {
    const result = spendBudget(2000, 100, 0.1);
    const output = formatBudgetDiagnostics(result);
    expect(output).toContain("boilerplate");
    expect(output).toContain("2.0×");
  });

  it("omits earnings line when zero", () => {
    const result = spendBudget(2000, 100, 0.5);
    const output = formatBudgetDiagnostics(result, 2000, 0, 0);
    expect(output).not.toContain("Earned:");
  });
});

// ─── Vector-Based Surprisal ─────────────────────────────────

describe("computeSurprisal (vector-based)", () => {
  it("returns near-zero surprisal for highly similar content", () => {
    const result = computeSurprisal(0.95);
    expect(result.surprisal).toBeCloseTo(0.05, 5);
    expect(result.isBoilerplate).toBe(true);
    expect(result.isNovel).toBe(false);
  });

  it("returns high surprisal for dissimilar content", () => {
    const result = computeSurprisal(0.2);
    expect(result.surprisal).toBeCloseTo(0.8, 5);
    expect(result.isBoilerplate).toBe(false);
    expect(result.isNovel).toBe(true);
  });

  it("returns medium surprisal for moderately similar content", () => {
    const result = computeSurprisal(0.5);
    expect(result.surprisal).toBeCloseTo(0.5, 5);
    expect(result.isBoilerplate).toBe(false);
    expect(result.isNovel).toBe(false);
  });

  it("returns maximum surprisal for no prior entries", () => {
    const result = computeSurprisal(-1);
    expect(result.surprisal).toBe(1.0);
    expect(result.isNovel).toBe(true);
  });

  it("clamps similarity to [0, 1]", () => {
    const result = computeSurprisal(1.5);
    expect(result.surprisal).toBe(0.0);
    expect(result.maxSimilarity).toBe(1.0);
  });

  it("handles NaN gracefully", () => {
    const result = computeSurprisal(NaN);
    expect(result.surprisal).toBe(1.0); // Treated as no prior entries
    expect(result.isNovel).toBe(true);
  });
});

// ─── Economy Integration Edge Cases ─────────────────────────

describe("Economy Edge Cases", () => {
  it("the 'Bankrupt' state: zero budget still saves", () => {
    const result = spendBudget(0, 200, 0.5);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
    expect(result.warning).toContain("exhausted");
  });

  it("zero-length summary: minimum base cost still bleeds budget", () => {
    const tokens = estimateTokens("");
    expect(tokens).toBe(MINIMUM_BASE_COST);
    const result = spendBudget(2000, tokens, 0.5);
    expect(result.spent).toBe(MINIMUM_BASE_COST);
    expect(result.remaining).toBe(2000 - MINIMUM_BASE_COST);
  });

  it("budget recovery from UBI cannot exceed initial size", () => {
    const tenHoursAgo = new Date(Date.now() - 36000000).toISOString();
    const result = applyEarnings(1990, tenHoursAgo, "success");
    expect(result.newBalance).toBe(DEFAULT_BUDGET_SIZE); // Hard cap
  });

  it("boilerplate entry costs 4× as much as novel entry", () => {
    const boilerplateResult = spendBudget(2000, 100, 0.1);  // 2× multiplier
    const novelResult = spendBudget(2000, 100, 0.9);         // 0.5× multiplier
    expect(boilerplateResult.spent / novelResult.spent).toBe(4); // 200/50 = 4
  });
});
