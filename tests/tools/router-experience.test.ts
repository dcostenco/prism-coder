import { describe, it, expect, vi } from "vitest";
import { getExperienceBias } from "../../src/tools/routerExperience.js";
import type { StorageBackend } from "../../src/storage/interface.js";

describe("routerExperience - getExperienceBias", () => {
  it("returns 0 bias when insufficient data (cold start)", async () => {
    const mockStorage = {
      getLedgerEntries: vi.fn().mockResolvedValue([
        // Only 1 relevant entry
        { event_type: "success", keywords: ["api", "login"], summary: "claw success" }
      ]),
    } as unknown as StorageBackend;

    const res = await getExperienceBias("projA", ["api", "login"], mockStorage);
    expect(res.bias).toBe(0);
    expect(res.sampleCount).toBe(1);
    expect(res.rationale).toContain("need 5 to apply ML bias");
  });

  it("calculates positive bias on consistent success", async () => {
    // 5 successes against "claw" tasks with 2 overlap
    const entries = Array(5).fill({
      event_type: "success",
      keywords: ["react", "component", "button"],
      summary: "success with claw"
    });

    const mockStorage = {
      getLedgerEntries: vi.fn().mockResolvedValue(entries),
    } as unknown as StorageBackend;

    const res = await getExperienceBias("projA", ["react", "component"], mockStorage);
    // Win rate = 1.0 (5 successes, 0 failures)
    // Scale: (1.0 - 0.5) * 0.30 = 0.15
    expect(res.bias).toBeCloseTo(0.15);
    expect(res.sampleCount).toBe(5);
    expect(res.rationale).toContain("Win rate: 100.0%");
    expect(res.rationale).toContain("boost");
  });

  it("calculates penalty bias on consistent failure", async () => {
    // 5 failures
    const entries = Array(5).fill({
      event_type: "failure",
      keywords: ["deploy", "docker", "test"],
      summary: "claw failed to deploy"
    });

    const mockStorage = {
      getLedgerEntries: vi.fn().mockResolvedValue(entries),
    } as unknown as StorageBackend;

    const res = await getExperienceBias("projA", ["docker", "deploy"], mockStorage);
    // Win rate = 0 (0 successes, 5 failures)
    // Scale: (0 - 0.5) * 0.30 = -0.15
    expect(res.bias).toBeCloseTo(-0.15);
    expect(res.sampleCount).toBe(5);
    expect(res.rationale).toContain("penalty");
  });

  it("calculates mixed bias (e.g. 75% win rate)", async () => {
    const entries = [
      ...Array(3).fill({ event_type: "success", keywords: ["a", "b", "c"], summary: "claw did well" }),
      ...Array(1).fill({ event_type: "failure", keywords: ["a", "b", "c"], summary: "claw did poorly" }),
    ]; // 3 wins, 1 loss = 75% win rate. Only 4 elements? Wait, we need 5! Let's add 1 more win.
    
    const entries2 = [
      ...Array(4).fill({ event_type: "success", keywords: ["a", "b", "c"], summary: "claw did well" }),
      { event_type: "failure", keywords: ["a", "b", "c"], summary: "claw did poorly" },
    ]; // 4 wins, 1 loss = 80% win rate.

    const mockStorage = {
      getLedgerEntries: vi.fn().mockResolvedValue(entries2),
    } as unknown as StorageBackend;

    const res = await getExperienceBias("projA", ["a", "b"], mockStorage);
    
    // Win rate = 0.8
    // Bias: (0.8 - 0.5) * 0.30 = +0.09
    expect(res.bias).toBeCloseTo(0.09);
    expect(res.sampleCount).toBe(5);
  });
});
