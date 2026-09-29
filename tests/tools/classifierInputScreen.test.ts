/**
 * prism_infer's screen passes the account's classifier-input policy to the
 * Layer 1 classifier, and makes the call it always made when there is none.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { runInfer, type InferDeps, type PrismInferArgs } from "../../src/tools/prismInferHandler.js";
import { _setCacheForTest, _resetEntitlementsForTest, type PrismEntitlements } from "../../src/utils/entitlements.js";
import type { ClassifierInputPolicy } from "../../src/utils/layer1.js";

const GB = 1024 ** 3;
const ENT = {
    plan: "free", model_ceiling: "9b", daily_infer_limit: 50, max_tokens: 512, max_seats: 1,
    features: { cloud_fallback: false, grounding_verifier: false, knowledge_search_unlimited: false, session_memory_unlimited: false, analytics_dashboard: false },
    upgrade_url: "https://synalux.ai/pricing",
} as PrismEntitlements;
const POLICY: ClassifierInputPolicy = { dropWords: new Set(["lorem", "ipsum"]), requireEach: [new Set(["lorem"])], onlyAfter: new Map(), onlyAfterPattern: null, alsoMatch: null, keptNeedsOneOf: new Set(["which"]) };

beforeEach(() => _setCacheForTest(ENT, 60_000));
afterAll(() => _resetEntitlementsForTest());

function run(policy: (() => Promise<ClassifierInputPolicy | null>) | undefined, extra: Partial<PrismInferArgs> = {}) {
    const calls: unknown[][] = [];
    const deps: InferDeps = {
        freemem: () => 30 * GB,
        listTags: async () => new Set(["prism-coder:9b", "prism-coder:4b"]),
        listLoaded: async () => new Set<string>(),
        callLocal: async () => ({ ok: true as const, text: "ok answer here", doneReason: "stop" }),
        callCloud: async () => ({ ok: false as const, reason: "no_cloud" }),
        ollamaUrl: "http://localhost:11434",
        callLayer1: async (...a: unknown[]) => { calls.push(a); return "OBVIOUS_NOT_RESERVED"; },
        ...(policy ? { classifierInputPolicy: policy } : {}),
    };
    const args = { prompt: "Lorem ipsum. Which tool handles this?", model_ceiling: "9b", ...extra } as PrismInferArgs;
    return runInfer(args, deps).then(() => calls);
}

describe("the screen and the classifier-input policy", () => {
    it("passes the policy to the classifier when the account has one", async () => {
        const calls = await run(async () => POLICY);
        expect(calls).toHaveLength(1);
        expect(calls[0].slice(0, 3)).toEqual(["Lorem ipsum. Which tool handles this?", "http://localhost:11434", "prism-coder:4b"]);
        expect(calls[0][5]).toEqual({ classifierInput: POLICY });
    });

    it("makes the call it always made when there is no policy, or the load fails", async () => {
        for (const policy of [async () => null, async () => { throw new Error("portal down"); }]) {
            const calls = await run(policy);
            expect(calls).toHaveLength(1);
            expect(calls[0]).toHaveLength(5);
        }
    });

    it("with no portal configured, the default loader has no policy and nothing is fetched", async () => {
        const calls = await run(undefined);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toHaveLength(5);
    });

    it("in a conversation, the prompt's classification gets the policy; the history windows do not", async () => {
        _setCacheForTest({ ...ENT, multi_turn: { enabled: true, max_turns: 12, max_chars: 32_000 } } as PrismEntitlements, 60_000);
        const calls = await run(async () => POLICY, {
            mode: "chat", escalation: "report",
            messages: [{ role: "user", content: "Count the rows in the sheet." }, { role: "assistant", content: "There are 12 rows." }],
        } as Partial<PrismInferArgs>);
        const promptCalls = calls.filter(c => c[0] === "Lorem ipsum. Which tool handles this?");
        expect(promptCalls).toHaveLength(1);
        expect(promptCalls[0][5]).toEqual({ deterministic: false, classifierInput: POLICY });
        const others = calls.filter(c => c[0] !== "Lorem ipsum. Which tool handles this?");
        expect(others.length).toBeGreaterThan(0);
        for (const c of others) expect((c[5] as { classifierInput?: unknown } | undefined)?.classifierInput).toBeUndefined();
    });
});
