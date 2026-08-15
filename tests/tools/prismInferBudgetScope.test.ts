import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { runInfer, type InferDeps, type PrismInferArgs } from "../../src/tools/prismInferHandler.js";
import { _setCacheForTest, _resetEntitlementsForTest, type PrismEntitlements } from "../../src/utils/entitlements.js";

/**
 * The plan's token cap is a CLOUD budget. It must not throttle local inference.
 *
 * One `maxTokens` used to be spent on both backends, so the free tier — which is
 * local-only (cloud_fallback: false) and capped at 512 — clamped num_predict on
 * hardware Synalux pays nothing to run. That cap is also what produced
 * hard_truncation: a 9b turn spends ~600 tokens on <think> before answering.
 *
 * Also pinned here: thinking is a property of the WEIGHTS, not the mode.
 * Measured on the 115-case routing suite through production /api/chat — the 9b
 * scores 83.5% with thinking off and 95.7% with it on; 2b/4b/27b are 100%
 * either way. Route mode used to force think=false for everyone, which meant
 * the default router ran in the only configuration that costs it 12 points.
 */

const GB = 1024 ** 3;

function ent(overrides: Partial<PrismEntitlements> = {}): PrismEntitlements {
    return {
        plan: "free",
        model_ceiling: "9b",
        daily_infer_limit: 50,
        max_tokens: 512,
        max_seats: 1,
        features: {
            cloud_fallback: false,
            grounding_verifier: false,
            knowledge_search_unlimited: false,
            session_memory_unlimited: false,
            analytics_dashboard: false,
        },
        upgrade_url: "https://synalux.ai/pricing",
        ...overrides,
    } as PrismEntitlements;
}

const INSTALLED = new Set(["prism-coder:9b", "prism-coder:4b", "prism-coder:2b"]);

beforeEach(() => _setCacheForTest(ent(), 60_000));
afterAll(() => _resetEntitlementsForTest());

function makeDeps(overrides: Partial<InferDeps>): InferDeps {
    return {
        freemem: () => 30 * GB,
        listTags: async () => INSTALLED,
        listLoaded: async () => new Set<string>(),
        callLocal: async () => ({ ok: true as const, text: "ok answer here", doneReason: "stop" }),
        callCloud: async () => ({ ok: false as const, reason: "no_cloud" }),
        ollamaUrl: "http://localhost:11434",
        callLayer1: async () => "OBVIOUS_NOT_RESERVED",
        ...overrides,
    };
}

const args = (extra: Partial<PrismInferArgs> = {}): PrismInferArgs =>
    ({ prompt: "which tool handles this", model_ceiling: "9b", ...extra });

describe("token budget is scoped to the backend that costs money", () => {
    it("does not clamp LOCAL num_predict to the free plan's 512", async () => {
        let seen = -1;
        const deps = makeDeps({
            callLocal: async (_u, _m, _p, _s, maxTokens) => {
                seen = maxTokens;
                return { ok: true as const, text: "ok answer here", doneReason: "stop" };
            },
        });

        // Deliberately the 4b: the 9b's minLocalTokens floor would mask a
        // re-coupling by raising the budget to 2048 regardless of the plan cap.
        await runInfer(args({ max_tokens: 4096, model_ceiling: "4b" }), deps);

        expect(seen, "free plan cap leaked onto the user's own hardware").toBe(4096);
    });

    it("still clamps CLOUD tokens to the plan cap", async () => {
        let cloudTokens = -1;
        _setCacheForTest(ent({ plan: "standard", features: { ...ent().features, cloud_fallback: true } }), 60_000);
        const deps = makeDeps({
            callLocal: async () => ({ ok: false as const, reason: "timeout" }),
            callCloud: async (_p, maxTokens) => {
                cloudTokens = maxTokens;
                return { ok: false as const, reason: "still_no" };
            },
        });

        await runInfer(args({ max_tokens: 4096, cloud_fallback: true }), deps).catch(() => {});

        expect(cloudTokens, "cloud spend escaped the plan cap").toBeLessThanOrEqual(512);
    });
});

describe("thinking follows the weights, not the mode", () => {
    it("lets the 9b think in route mode", async () => {
        const seen: Array<{ model: string; think?: boolean }> = [];
        const deps = makeDeps({
            callLocal: async (_u, model, _p, _s, _mt, _t, _to, think) => {
                seen.push({ model, think });
                return { ok: true as const, text: "ok answer here", doneReason: "stop" };
            },
        });

        await runInfer(args(), deps); // mode defaults to "route"

        expect(seen[0]).toEqual({ model: "prism-coder:9b", think: true });
    });

    it("keeps thinking OFF for tiers that gain nothing from it", async () => {
        const seen: Array<{ model: string; think?: boolean }> = [];
        const deps = makeDeps({
            callLocal: async (_u, model, _p, _s, _mt, _t, _to, think) => {
                seen.push({ model, think });
                return { ok: true as const, text: "ok answer here", doneReason: "stop" };
            },
        });

        await runInfer(args({ model_ceiling: "4b" }), deps);

        expect(seen[0]).toEqual({ model: "prism-coder:4b", think: false });
    });

    it("an explicit think=false still wins over the tier preference", async () => {
        const seen: Array<boolean | undefined> = [];
        const deps = makeDeps({
            callLocal: async (_u, _m, _p, _s, _mt, _t, _to, think) => {
                seen.push(think);
                return { ok: true as const, text: "ok answer here", doneReason: "stop" };
            },
        });

        await runInfer(args({ think: false }), deps);

        expect(seen[0]).toBe(false);
    });

    it("gives a thinking tier room for the reasoning AND the answer", async () => {
        let seen = -1;
        const deps = makeDeps({
            callLocal: async (_u, _m, _p, _s, maxTokens) => {
                seen = maxTokens;
                return { ok: true as const, text: "ok answer here", doneReason: "stop" };
            },
        });

        await runInfer(args(), deps); // default 1024 request, 9b needs ~600 to think

        expect(seen, "reasoning would crowd out the answer").toBeGreaterThanOrEqual(2048);
    });
});
