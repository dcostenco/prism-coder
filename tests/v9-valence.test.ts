/**
 * v9.0 Valence Engine Tests
 *
 * Tests for Affect-Tagged Memory: valence derivation, propagation,
 * hybrid scoring with magnitude-based salience, UX warnings, and
 * edge case handling.
 */

import { describe, it, expect } from "vitest";
import {
  deriveValence,
  valenceSalience,
  formatValenceTag,
  shouldWarnNegativeValence,
  generateValenceWarning,
  propagateValence,
  clampValence,
  computeHybridScoreWithValence,
} from "../src/memory/valenceEngine.js";

// ─── Valence Derivation ─────────────────────────────────────

describe("deriveValence", () => {
  it("returns +0.8 for success events", () => {
    expect(deriveValence("success")).toBe(0.8);
  });

  it("returns -0.8 for failure events", () => {
    expect(deriveValence("failure")).toBe(-0.8);
  });

  it("returns -0.6 for correction events", () => {
    expect(deriveValence("correction")).toBe(-0.6);
  });

  it("returns +0.4 for learning events", () => {
    expect(deriveValence("learning")).toBe(0.4);
  });

  it("returns 0.0 for session events", () => {
    expect(deriveValence("session")).toBe(0.0);
  });

  it("returns 0.0 for undefined event type", () => {
    expect(deriveValence(undefined)).toBe(0.0);
  });

  it("returns 0.0 for unknown event types", () => {
    expect(deriveValence("unknown")).toBe(0.0);
    expect(deriveValence("custom_event")).toBe(0.0);
  });

  // validation_result — depends on notes content
  it("returns +0.6 for validation_result with pass notes", () => {
    expect(deriveValence("validation_result", "All tests passed")).toBe(0.6);
    expect(deriveValence("validation_result", "success rate 100%")).toBe(0.6);
    expect(deriveValence("validation_result", "green light")).toBe(0.6);
  });

  it("returns -0.6 for validation_result with fail notes", () => {
    expect(deriveValence("validation_result", "3 tests failed")).toBe(-0.6);
    expect(deriveValence("validation_result", "critical error detected")).toBe(-0.6);
    expect(deriveValence("validation_result", "blocked by lint")).toBe(-0.6);
  });

  it("returns -0.2 for validation_result with ambiguous notes", () => {
    expect(deriveValence("validation_result", "completed with warnings")).toBe(-0.2);
    expect(deriveValence("validation_result")).toBe(-0.2);
    expect(deriveValence("validation_result", null)).toBe(-0.2);
  });
});

// ─── Affective Salience (Magnitude-Based) ───────────────────

describe("valenceSalience", () => {
  it("returns absolute magnitude for negative valence", () => {
    expect(valenceSalience(-0.8)).toBe(0.8);
    expect(valenceSalience(-0.6)).toBeCloseTo(0.6);
  });

  it("returns absolute magnitude for positive valence", () => {
    expect(valenceSalience(0.8)).toBe(0.8);
    expect(valenceSalience(0.4)).toBeCloseTo(0.4);
  });

  it("returns 0.0 for neutral valence", () => {
    expect(valenceSalience(0.0)).toBe(0.0);
  });

  it("returns 0.0 for null/undefined", () => {
    expect(valenceSalience(null)).toBe(0.0);
    expect(valenceSalience(undefined)).toBe(0.0);
  });

  it("returns 0.0 for NaN", () => {
    expect(valenceSalience(NaN)).toBe(0.0);
  });

  it("clamps to 1.0 for extreme values", () => {
    expect(valenceSalience(5.0)).toBe(1.0);
    expect(valenceSalience(-3.0)).toBe(1.0);
  });

  it("failure and success have EQUAL salience (the key insight)", () => {
    // This is the Affective Salience fix — both extreme positive
    // and extreme negative memories are equally retrievable
    expect(valenceSalience(-0.8)).toBe(valenceSalience(0.8));
  });
});

// ─── UX Tags ────────────────────────────────────────────────

describe("formatValenceTag", () => {
  it("shows 🔴 for strongly negative valence", () => {
    expect(formatValenceTag(-0.8)).toBe("🔴");
    expect(formatValenceTag(-0.5)).toBe("🔴");
  });

  it("shows 🟠 for moderately negative valence", () => {
    expect(formatValenceTag(-0.3)).toBe("🟠");
    expect(formatValenceTag(-0.2)).toBe("🟠");
  });

  it("shows 🟢 for strongly positive valence", () => {
    expect(formatValenceTag(0.8)).toBe("🟢");
    expect(formatValenceTag(0.5)).toBe("🟢");
  });

  it("shows 🔵 for moderately positive valence", () => {
    expect(formatValenceTag(0.3)).toBe("🔵");
    expect(formatValenceTag(0.2)).toBe("🔵");
  });

  it("shows 🟡 for neutral valence", () => {
    expect(formatValenceTag(0.0)).toBe("🟡");
    expect(formatValenceTag(0.1)).toBe("🟡");
    expect(formatValenceTag(-0.1)).toBe("🟡");
  });

  it("returns empty string for null/undefined/NaN", () => {
    expect(formatValenceTag(null)).toBe("");
    expect(formatValenceTag(undefined)).toBe("");
    expect(formatValenceTag(NaN)).toBe("");
  });
});

// ─── Warning Logic ──────────────────────────────────────────

describe("shouldWarnNegativeValence", () => {
  it("returns true when avgValence is below threshold", () => {
    expect(shouldWarnNegativeValence(-0.5)).toBe(true);
    expect(shouldWarnNegativeValence(-0.31)).toBe(true);
  });

  it("returns false when avgValence is above threshold", () => {
    expect(shouldWarnNegativeValence(-0.2)).toBe(false);
    expect(shouldWarnNegativeValence(0.0)).toBe(false);
    expect(shouldWarnNegativeValence(0.5)).toBe(false);
  });

  it("returns false at exactly the threshold", () => {
    expect(shouldWarnNegativeValence(-0.3)).toBe(false);
  });

  it("returns false for NaN/Infinity", () => {
    expect(shouldWarnNegativeValence(NaN)).toBe(false);
    expect(shouldWarnNegativeValence(-Infinity)).toBe(false);
  });

  it("respects custom threshold", () => {
    expect(shouldWarnNegativeValence(-0.2, -0.1)).toBe(true);
    expect(shouldWarnNegativeValence(-0.6, -0.5)).toBe(true);
  });
});

describe("generateValenceWarning", () => {
  it("returns strong caution for very negative valence", () => {
    const warning = generateValenceWarning(-0.7);
    expect(warning).toContain("Caution");
    expect(warning).toContain("historical failures");
  });

  it("returns moderate warning for mildly negative valence", () => {
    const warning = generateValenceWarning(-0.35);
    expect(warning).toContain("Warning");
    expect(warning).toContain("mixed historical outcomes");
  });

  it("returns positive signal for high valence", () => {
    const warning = generateValenceWarning(0.7);
    expect(warning).toContain("High Signal");
    expect(warning).toContain("successful outcomes");
  });

  it("returns null for neutral valence", () => {
    expect(generateValenceWarning(0.0)).toBeNull();
    expect(generateValenceWarning(0.3)).toBeNull();
    expect(generateValenceWarning(-0.2)).toBeNull();
  });

  it("returns null for NaN", () => {
    expect(generateValenceWarning(NaN)).toBeNull();
  });
});

// ─── Clamp ──────────────────────────────────────────────────

describe("clampValence", () => {
  it("clamps values above 1.0", () => {
    expect(clampValence(2.5)).toBe(1.0);
    expect(clampValence(100.0)).toBe(1.0);
  });

  it("clamps values below -1.0", () => {
    expect(clampValence(-2.5)).toBe(-1.0);
    expect(clampValence(-100.0)).toBe(-1.0);
  });

  it("passes through valid values unchanged", () => {
    expect(clampValence(0.5)).toBe(0.5);
    expect(clampValence(-0.5)).toBe(-0.5);
    expect(clampValence(0.0)).toBe(0.0);
  });

  it("returns 0.0 for NaN/Infinity", () => {
    expect(clampValence(NaN)).toBe(0.0);
    expect(clampValence(Infinity)).toBe(0.0);
    expect(clampValence(-Infinity)).toBe(0.0);
  });
});

// ─── Valence Propagation ────────────────────────────────────

describe("propagateValence", () => {
  it("preserves anchor node valence directly", () => {
    const nodes = [
      { id: "A", activationEnergy: 1.0, isDiscovered: false },
    ];
    const valenceLookup = new Map([["A", -0.8]]);

    const result = propagateValence(nodes, valenceLookup);
    expect(result.get("A")).toBe(-0.8);
  });

  it("computes weighted average for discovered nodes", () => {
    const nodes = [
      { id: "A", activationEnergy: 1.0, isDiscovered: false },
      { id: "B", activationEnergy: 0.5, isDiscovered: true },
    ];
    const valenceLookup = new Map([["A", -0.8]]);
    const flows = new Map([
      ["B", [{ sourceId: "A", weight: 0.6 }]],
    ]);

    const result = propagateValence(nodes, valenceLookup, flows);
    expect(result.get("B")).toBe(-0.8); // Single source → direct propagation
  });

  it("fan-dampens when multiple sources contribute", () => {
    // 2 positive sources + 1 negative source → weighted average
    const nodes = [
      { id: "A", activationEnergy: 1.0, isDiscovered: false },
      { id: "B", activationEnergy: 1.0, isDiscovered: false },
      { id: "C", activationEnergy: 1.0, isDiscovered: false },
      { id: "D", activationEnergy: 0.5, isDiscovered: true },
    ];
    const valenceLookup = new Map([
      ["A", 0.8],
      ["B", 0.8],
      ["C", -0.8],
    ]);
    // All equal weights = simple average
    const flows = new Map([
      ["D", [
        { sourceId: "A", weight: 1.0 },
        { sourceId: "B", weight: 1.0 },
        { sourceId: "C", weight: 1.0 },
      ]],
    ]);

    const result = propagateValence(nodes, valenceLookup, flows);
    // (0.8 + 0.8 + -0.8) / 3 = 0.2667
    expect(result.get("D")).toBeCloseTo(0.267, 2);
  });

  it("prevents hub explosion — 50 neutral → 1 negative stays clamped", () => {
    const nodes: Array<{ id: string; activationEnergy: number; isDiscovered: boolean }> = [];
    const valenceLookup = new Map<string, number>();
    const flowEntries: Array<{ sourceId: string; weight: number }> = [];

    // 50 neutral sources (valence 0.0) + 1 strong negative
    for (let i = 0; i < 50; i++) {
      const id = `N${i}`;
      nodes.push({ id, activationEnergy: 1.0, isDiscovered: false });
      valenceLookup.set(id, 0.0);
      flowEntries.push({ sourceId: id, weight: 1.0 });
    }
    nodes.push({ id: "NEG", activationEnergy: 1.0, isDiscovered: false });
    valenceLookup.set("NEG", -0.8);
    flowEntries.push({ sourceId: "NEG", weight: 1.0 });

    // Target node
    nodes.push({ id: "TARGET", activationEnergy: 0.5, isDiscovered: true });
    const flows = new Map([["TARGET", flowEntries]]);

    const result = propagateValence(nodes, valenceLookup, flows);

    // Should be ~-0.016 (averaged over 51 sources), NOT -50*0.8 = -40
    expect(result.get("TARGET")!).toBeGreaterThan(-1.0);
    expect(result.get("TARGET")!).toBeLessThan(0.0);
    expect(result.get("TARGET")!).toBeCloseTo(-0.8 / 51, 2);
  });

  it("defaults to 0.0 for discovered nodes without flow data", () => {
    const nodes = [
      { id: "D", activationEnergy: 0.5, isDiscovered: true },
    ];
    const result = propagateValence(nodes, new Map());
    expect(result.get("D")).toBe(0.0);
  });

  it("handles empty result set", () => {
    const result = propagateValence([], new Map());
    expect(result.size).toBe(0);
  });
});

// ─── Hybrid Scoring with Valence ────────────────────────────

describe("computeHybridScoreWithValence", () => {
  it("uses correct default weights (0.65 / 0.25 / 0.10)", () => {
    const score = computeHybridScoreWithValence(1.0, 1.0, 1.0);
    expect(score).toBeCloseTo(1.0, 5); // All max → should be 1.0
  });

  it("neutral valence contributes zero to score", () => {
    const withValence = computeHybridScoreWithValence(0.8, 0.5, 0.0);
    const expected = 0.65 * 0.8 + 0.25 * 0.5 + 0.1 * 0.0;
    expect(withValence).toBeCloseTo(expected, 5);
  });

  it("negative and positive valence contribute EQUALLY (magnitude)", () => {
    const negative = computeHybridScoreWithValence(0.8, 0.5, -0.8);
    const positive = computeHybridScoreWithValence(0.8, 0.5, 0.8);
    expect(negative).toBeCloseTo(positive, 5); // Same magnitude = same boost
  });

  it("a failure memory scores HIGHER than a neutral memory (Affective Salience)", () => {
    const failureScore = computeHybridScoreWithValence(0.8, 0.5, -0.8);
    const neutralScore = computeHybridScoreWithValence(0.8, 0.5, 0.0);
    expect(failureScore).toBeGreaterThan(neutralScore);
  });

  it("handles null valence gracefully", () => {
    const score = computeHybridScoreWithValence(0.8, 0.5, null);
    const expected = 0.65 * 0.8 + 0.25 * 0.5; // Valence contributes 0
    expect(score).toBeCloseTo(expected, 5);
  });

  it("handles NaN inputs safely", () => {
    const score = computeHybridScoreWithValence(NaN, NaN, NaN);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBe(0.0);
  });

  it("clamps inputs to [0, 1]", () => {
    const score = computeHybridScoreWithValence(2.0, -0.5, 5.0);
    // similarity clamped to 1.0, activation clamped to 0.0, valence magnitude clamped to 1.0
    expect(score).toBeCloseTo(0.65 * 1.0 + 0.25 * 0.0 + 0.1 * 1.0, 5);
  });

  it("supports custom weight overrides", () => {
    const score = computeHybridScoreWithValence(
      0.8, 0.5, 0.6,
      { similarity: 0.5, activation: 0.3, valence: 0.2 }
    );
    const expected = 0.5 * 0.8 + 0.3 * 0.5 + 0.2 * 0.6;
    expect(score).toBeCloseTo(expected, 5);
  });
});
