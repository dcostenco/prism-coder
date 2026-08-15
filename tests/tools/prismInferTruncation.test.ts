import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { runInfer, type InferDeps, type PrismInferArgs } from "../../src/tools/prismInferHandler.js";
import { _setCacheForTest, _resetEntitlementsForTest, type PrismEntitlements } from "../../src/utils/entitlements.js";

/**
 * Hard truncation must be retried WITHOUT thinking, on the same tier.
 *
 * Measured on prism-coder:4b at the free tier's 512-token budget
 * (entitlements.ts FREE_ENTITLEMENTS.max_tokens): the query "Search my
 * knowledge base for ACT-R decay algorithm" spends 2,336 characters on
 * <think>, hits num_predict, and returns done_reason="length" having emitted
 * no tool call. The identical query with think=false finishes in 35 tokens.
 *
 * The quality gate already names this (`hard_truncation`), but the handler's
 * only response was to fall through to the next SMALLER tier — carrying the
 * same token budget, so it re-runs the same budget failure with less capable
 * weights. Cutting the reasoning is the remedy that matches the cause.
 */

const GB = 1024 ** 3;

const FREE_ISH: PrismEntitlements = {
    plan: "enterprise",
    model_ceiling: "27b",
    daily_infer_limit: 100000,
    max_tokens: 512, // the budget that actually truncates
    max_seats: 25,
    features: {
        cloud_fallback: false,
        grounding_verifier: false,
        knowledge_search_unlimited: true,
        session_memory_unlimited: true,
        analytics_dashboard: true,
    },
    upgrade_url: "https://synalux.ai/pricing",
};

const INSTALLED = new Set(["prism-coder:9b", "prism-coder:4b", "prism-coder:2b"]);

beforeEach(() => _setCacheForTest(FREE_ISH, 60_000));
afterAll(() => _resetEntitlementsForTest());

function makeDeps(overrides: Partial<InferDeps>): InferDeps {
    return {
        freemem: () => 30 * GB,
        listTags: async () => INSTALLED,
        listLoaded: async () => new Set<string>(),
        callLocal: async () => ({ ok: false as const, reason: "unstubbed" }),
        callCloud: async () => ({ ok: false as const, reason: "no_cloud" }),
        ollamaUrl: "http://localhost:11434",
        callLayer1: async () => "OBVIOUS_NOT_RESERVED",
        ...overrides,
    };
}

// mode "chat" is required: mode defaults to "route", and resolveThinkingMode
// forces think=false for route — so the ROUTING path was never exposed to this
// bug at all. The exposure is chat/code on a small token budget.
const args = (extra: Partial<PrismInferArgs> = {}): PrismInferArgs =>
    ({ prompt: "Search my knowledge base for ACT-R decay algorithm", ceiling: "9b", mode: "chat", ...extra });

describe("hard truncation is retried without thinking, not dropped to a smaller tier", () => {
    it("retries the SAME tier with think=false and keeps the answer", async () => {
        const calls: Array<{ model: string; think?: boolean }> = [];
        const deps = makeDeps({
            callLocal: async (_u, model, _p, _s, _mt, _t, _to, think) => {
                calls.push({ model, think });
                if (think) {
                    // Budget spent reasoning; the answer starts but is cut off.
                    return { ok: true as const, text: "ACT-R decay follows a power law where base-level acti", doneReason: "length" };
                }
                return { ok: true as const, text: "ACT-R decay follows a power law over time since each retrieval.", doneReason: "stop" };
            },
        });

        const r = await runInfer(args(), deps);

        expect(calls.map(c => `${c.model}:${c.think}`))
            .toEqual(["prism-coder:9b:true", "prism-coder:9b:false"]);
        expect(r.model_picked, "fell to a smaller tier instead of retrying").toBe("prism-coder:9b");
        expect(r.output, "kept the truncated fragment").toContain("since each retrieval");
    });

    it("does not retry when the truncated call already had thinking off", async () => {
        // think=false cannot re-trigger the same failure, so a second identical
        // call would be pure latency.
        const calls: Array<{ model: string; think?: boolean }> = [];
        const deps = makeDeps({
            callLocal: async (_u, model, _p, _s, _mt, _t, _to, think) => {
                calls.push({ model, think });
                return { ok: true as const, text: "partial output", doneReason: "length" };
            },
        });

        await runInfer(args({ think: false }), deps);

        const perTier = calls.filter(c => c.model === "prism-coder:9b");
        expect(perTier.length, "retried a call that had nothing to cut").toBe(1);
    });

    it("retries at most once, then serves the degraded result", async () => {
        // With no cloud available the handler serves truncated output rather
        // than falling to a smaller tier — the same budget would truncate there
        // too. One retry, no loop.
        const calls: Array<boolean | undefined> = [];
        const deps = makeDeps({
            callLocal: async (_u, _m, _p, _s, _mt, _t, _to, think) => {
                calls.push(think);
                return { ok: true as const, text: "still cut off", doneReason: "length" };
            },
        });

        const r = await runInfer(args(), deps);

        expect(calls.slice(0, 2), "expected exactly one think=false retry").toEqual([true, false]);
        expect(r.output).toContain("still cut off");
    });
});
