import { describe, expect, test } from "vitest";
import { computeIntentHealth } from "../../src/dashboard/intentHealth.js";

describe("Intent Health Scoring", () => {
  const fakeNow = new Date("2026-04-04T00:00:00Z").getTime();
  const dayMs = 1000 * 60 * 60 * 24;

  test("calculates score correctly for fresh context with todos and decisions", () => {
    // 0 days stale
    const ctx = {
      recent_sessions: [
        { created_at: new Date(fakeNow).toISOString(), decisions: ["Do X", "Do Y"] }
      ],
      pending_todo: ["Task 1", "Task 2"] // 2 todos -> 25 points
    };

    const result = computeIntentHealth(ctx, 30, fakeNow);
    // Staleness = 0 days => 50 points
    // TODOs = 2 => 25 points
    // Decisions = true => 20 points
    // Total = 95
    expect(result.score).toBe(95);
    expect(result.staleness_days).toBe(0);
    expect(result.open_todo_count).toBe(2);
    expect(result.has_active_decisions).toBe(true);
    expect(result.signals.length).toBe(3);
  });

  test("calculates score correctly for perfectly stale project", () => {
    // 30 days stale
    const ctx = {
      recent_sessions: [
        { created_at: new Date(fakeNow - 30 * dayMs).toISOString(), decisions: [] }
      ],
      pending_todo: Array.from({ length: 10 }, (_, i) => `Task ${i}`) // 10 todos => 0 points
    };

    const result = computeIntentHealth(ctx, 30, fakeNow);
    // Staleness = 30 days => 0 points
    // TODOs = 10 => 0 points
    // Decisions = false => 14 points
    // Total = 14
    expect(result.score).toBe(14);
    expect(result.staleness_days).toBe(30);
    expect(result.open_todo_count).toBe(10);
    expect(result.has_active_decisions).toBe(false);
  });

  test("handles empty contexts safely", () => {
    const result = computeIntentHealth({}, 30, fakeNow);
    // Staleness = 0 days => 50 points
    // TODOs = 0 => 30 points
    // Decisions = false => 14 points
    // Total = 94
    expect(result.score).toBe(94);
    expect(result.staleness_days).toBe(0);
    expect(result.open_todo_count).toBe(0);
    expect(result.has_active_decisions).toBe(false);
  });
  
  test("staleness decay is linear and caps at 0", () => {
    const ctx = {
      recent_sessions: [
        { created_at: new Date(fakeNow - 45 * dayMs).toISOString() }
      ]
    };
    const result = computeIntentHealth(ctx, 30, fakeNow);
    expect(result.score).toBe(44);
    expect(result.staleness_days).toBe(45);
  });

  test("handles NaN timestamps gracefully (staleness defaults to 0)", () => {
    const ctx = {
      recent_sessions: [{ created_at: "not-a-date" }]
    };
    const result = computeIntentHealth(ctx, 30, fakeNow);
    expect(result.staleness_days).toBe(0);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.score)).toBe(true);
  });

  test("respects custom staleThresholdDays", () => {
    const ctx = {
      recent_sessions: [
        { created_at: new Date(fakeNow - 5 * dayMs).toISOString() }
      ]
    };
    // 5 days stale with 10-day threshold = 50% decay = 25 staleness points
    const result = computeIntentHealth(ctx, 10, fakeNow);
    expect(result.score).toBe(25 + 30 + 14); // 69
  });

  test("TODO boundary: exactly 4 todos scores 15", () => {
    const ctx = { pending_todo: ["a","b","c","d"] };
    const result = computeIntentHealth(ctx, 30, fakeNow);
    expect(result.score).toBe(50 + 15 + 14); // 79
  });

  test("multiple sessions — any with decisions counts as true", () => {
    const ctx = {
      recent_sessions: [
        { created_at: new Date(fakeNow).toISOString(), decisions: [] },
        { created_at: new Date(fakeNow - dayMs).toISOString(), decisions: ["d1"] }
      ]
    };
    const result = computeIntentHealth(ctx, 30, fakeNow);
    expect(result.has_active_decisions).toBe(true);
    expect(result.score).toBe(50 + 30 + 20); // 100
  });

  test("score never exceeds 100", () => {
    const ctx = {
      recent_sessions: [
        { created_at: new Date(fakeNow).toISOString(), decisions: ["x"] }
      ],
      pending_todo: []
    };
    const result = computeIntentHealth(ctx, 30, fakeNow);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  test("handles missing decisions key (undefined) gracefully", () => {
    const ctx = {
      recent_sessions: [
        { created_at: new Date(fakeNow).toISOString() }
        // no "decisions" property
      ]
    };
    const result = computeIntentHealth(ctx, 30, fakeNow);
    expect(result.has_active_decisions).toBe(false);
    expect(result.score).toBe(50 + 30 + 14); // 94
  });

  test("staleThresholdDays=0 does not produce Infinity/NaN guards back to 30", () => {
    const ctx = {
      recent_sessions: [
        { created_at: new Date(fakeNow - 5 * dayMs).toISOString() }
      ]
    };
    const result = computeIntentHealth(ctx, 0, fakeNow);
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    // 5 days stale with a fallback 30-day threshold = 42 staleness points
    expect(result.score).toBe(42 + 30 + 14); 
  });

  test("signals have correct severity for stale + overloaded state", () => {
    const ctx = {
      recent_sessions: [
        { created_at: new Date(fakeNow - 45 * dayMs).toISOString(), decisions: [] }
      ],
      pending_todo: Array.from({ length: 10 }, (_, i) => `T${i}`)
    };
    const result = computeIntentHealth(ctx, 30, fakeNow);
    expect(result.signals).toHaveLength(3);
    
    const staleSig = result.signals.find(s => s.type === "staleness");
    expect(staleSig?.severity).toBe("critical");
    expect(staleSig?.message).toContain("45");
    
    const todoSig = result.signals.find(s => s.type === "todos");
    expect(todoSig?.severity).toBe("critical");
    expect(todoSig?.message).toContain("Overwhelming");
    
    const decSig = result.signals.find(s => s.type === "decisions");
    expect(decSig?.severity).toBe("warn");
  });

  test("NaN staleThresholdDays falls back to 30", () => {
    const ctx = {
      recent_sessions: [
        { created_at: new Date(fakeNow - 5 * dayMs).toISOString() }
      ]
    };
    const result = computeIntentHealth(ctx, NaN, fakeNow);
    expect(Number.isFinite(result.score)).toBe(true);
    // Falls back to 30-day threshold: 5 days stale = 42 staleness points
    expect(result.score).toBe(42 + 30 + 14); // 86
  });

  test("future timestamp (clock skew) treats staleness as 0", () => {
    const ctx = {
      recent_sessions: [
        { created_at: new Date(fakeNow + 5 * dayMs).toISOString() }
      ]
    };
    const result = computeIntentHealth(ctx, 30, fakeNow);
    expect(result.staleness_days).toBe(0);
    expect(result.score).toBe(50 + 30 + 14); // 94, full freshness
  });
});
