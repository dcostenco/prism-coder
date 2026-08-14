/**
 * The access gate lives in prism_infer and is driven by the plan tier.
 *
 * Leak found 2026-08-14: clampCeiling returned the CALLER'S requested tier
 * whenever the PLAN's ceiling was unrecognised. The portal was shipping
 * '14b' (standard) and '32b' (advanced/enterprise) — tiers the client retired —
 * so for every paid plan the gate silently evaporated and the request decided
 * its own ceiling. An entitlement the client cannot parse must never grant
 * MORE than the free floor.
 */
import { describe, it, expect } from "vitest";
import { clampCeiling, FREE_ENTITLEMENTS } from "../src/utils/entitlements.js";

describe("clampCeiling — plan tier is the gate", () => {
  it("clamps a request down to the plan ceiling", () => {
    expect(clampCeiling("27b", "9b")).toBe("9b");
    expect(clampCeiling("9b", "4b")).toBe("4b");
  });

  it("lets a smaller request through untouched", () => {
    expect(clampCeiling("4b", "27b")).toBe("4b");
  });

  it("uses the plan ceiling when no request is made", () => {
    expect(clampCeiling(undefined, "9b")).toBe("9b");
  });

  it("ignores an unrecognised REQUEST and applies the plan", () => {
    expect(clampCeiling("14b", "9b")).toBe("9b");
  });

  it("an unrecognised PLAN ceiling must not grant the request (the leak)", () => {
    // Old portal values. Previously returned "27b" — the caller's ask.
    expect(clampCeiling("27b", "14b")).toBe(FREE_ENTITLEMENTS.model_ceiling);
    expect(clampCeiling("27b", "32b")).toBe(FREE_ENTITLEMENTS.model_ceiling);
    expect(clampCeiling("9b", "8b")).toBe(FREE_ENTITLEMENTS.model_ceiling);
  });
});

// ── End-to-end: the gate must actually stop the ladder ──────────────────
import { runInfer } from "../src/tools/prismInferHandler.js";
import { _setCacheForTest, _resetEntitlementsForTest } from "../src/utils/entitlements.js";

const GB = 1024 ** 3;
const ALL = new Set(["prism-coder:27b", "prism-coder:9b", "prism-coder:4b", "prism-coder:2b"]);
function ent(ceiling: string): any {
  return {
    plan: "standard", model_ceiling: ceiling, daily_infer_limit: 1e5, max_tokens: 4096, max_seats: 5,
    features: { cloud_fallback: false, grounding_verifier: false, route_guard: false,
                knowledge_search_unlimited: true, session_memory_unlimited: true, analytics_dashboard: false },
    upgrade_url: "https://synalux.ai/pricing",
  };
}
async function tiersTried(planCeiling: string, requested?: string): Promise<string[]> {
  const tried: string[] = [];
  _setCacheForTest(ent(planCeiling), 60_000);
  try {
    await runInfer(
      { prompt: "hi", mode: "chat", ...(requested ? { model_ceiling: requested as any } : {}) },
      {
        freemem: () => 40 * GB, listTags: async () => ALL, listLoaded: async () => new Set<string>(),
        callLocal: async (_u: string, m: string) => { tried.push(m); return { ok: true as const, text: "ok", doneReason: "stop" }; },
        callCloud: async () => ({ ok: false as const, reason: "off" }),
        ollamaUrl: "http://x", callLayer1: async () => "OBVIOUS_NOT_RESERVED",
      } as any);
  } finally { _resetEntitlementsForTest(); }
  return tried;
}

describe("prism_infer enforces the gate end-to-end", () => {
  it("a 9b plan never reaches the 27b, even when the caller asks for it", async () => {
    const tried = await tiersTried("9b", "27b");
    expect(tried.some(m => m.includes("27b"))).toBe(false);
    expect(tried.some(m => m.includes("9b"))).toBe(true);
  });

  it("a 4b plan never reaches the 9b", async () => {
    const tried = await tiersTried("4b", "27b");
    expect(tried.some(m => m.includes("27b") || m.includes("9b"))).toBe(false);
    expect(tried.some(m => m.includes("4b"))).toBe(true);
  });

  it("a 27b plan does reach the 27b", async () => {
    expect((await tiersTried("27b", "27b")).some(m => m.includes("27b"))).toBe(true);
  });

  it("a RETIRED plan tier ('14b') is gated to the free floor, not opened up", async () => {
    const tried = await tiersTried("14b", "27b");
    expect(tried.some(m => m.includes("27b") || m.includes("9b"))).toBe(false);
  });
});
