/**
 * Auto-eviction is the ONLY consumer of MODEL_TIERS.weightsGb, and until now it
 * had no test at all — `grep -rln evict tests/` matched nothing.
 *
 * The handler decides whether to unload warm tier models by predicting how much
 * memory they will give back: `freeBytes + Σ weightsGb >= ceiling.minFreeGb`.
 * That prediction is a promise. If weightsGb overstates the tiers (e.g. by
 * copying the decimal GB `ollama list` prints into a field multiplied by
 * 1024**3), the handler throws away warm models to satisfy a threshold it then
 * cannot reach — paying every cold-start cost for nothing.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { runInfer, type InferDeps, type PrismInferArgs } from "../../src/tools/prismInferHandler.js";
import { _setCacheForTest, _resetEntitlementsForTest, type PrismEntitlements } from "../../src/utils/entitlements.js";

const GB = 1024 ** 3;

const ENTERPRISE: PrismEntitlements = {
    plan: "enterprise",
    model_ceiling: "27b",
    daily_infer_limit: 100000,
    max_tokens: 4096,
    max_seats: 25,
    features: {
        cloud_fallback: true,
        grounding_verifier: true,
        knowledge_search_unlimited: true,
        session_memory_unlimited: true,
        analytics_dashboard: true,
    },
    upgrade_url: "https://synalux.ai/pricing",
};

const INSTALLED = new Set([
    "prism-coder:27b",
    "prism-coder:9b",
    "prism-coder:4b",
    "prism-coder:2b",
]);

/** Warm: 9b (6.2 GiB) + 4b (3.2 GiB) = 9.4 GiB of honest eviction credit. */
const WARM = new Set(["prism-coder:9b", "prism-coder:4b"]);

let unloaded: string[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
    _setCacheForTest(ENTERPRISE, 60_000);
    unloaded = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (body.keep_alive === 0) unloaded.push(body.model);
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

afterAll(() => {
    _resetEntitlementsForTest();
});

function makeDeps(overrides: Partial<InferDeps>): InferDeps {
    return {
        freemem: () => 30 * GB,
        listTags: async () => INSTALLED,
        listLoaded: async () => WARM,
        callLocal: async () => ({ ok: true as const, text: "pong" }),
        callCloud: async () => ({ ok: false as const, reason: "no_cloud" }),
        ollamaUrl: "http://localhost:11434",
        callLayer1: async () => "OBVIOUS_NOT_RESERVED",
        ...overrides,
    };
}

const args = (extra: Partial<PrismInferArgs> = {}): PrismInferArgs =>
    ({ prompt: "ping", task_complexity: "complex", ...extra });

describe("auto-eviction honours the weights it promises to reclaim", () => {
    it("evicts warm tiers when their real size closes the gap to the 27b gate", async () => {
        // 14 free + 9.4 warm = 23.4 GiB >= the 27b gate of 21.
        const freed = [14 * GB, 22 * GB];
        let n = 0;
        const called: string[] = [];
        const deps = makeDeps({
            freemem: () => freed[Math.min(n++, freed.length - 1)],
            callLocal: async (_u, model) => { called.push(model); return { ok: true as const, text: "pong" }; },
        });

        const r = await runInfer(args({ ceiling: "27b" }), deps);

        expect(unloaded.sort()).toEqual(["prism-coder:4b", "prism-coder:9b"]);
        expect(called).toEqual(["prism-coder:27b"]);
        expect(r.model_picked).toBe("prism-coder:27b");
    });

    it("does NOT evict when the honest weights cannot close the gap", async () => {
        // 11 free + 9.4 honest warm = 20.4 GiB < the 21 GiB gate, so the warm
        // models must survive and the request must settle on a smaller tier.
        //
        // This is the mutation guard: restore the decimal-GB numbers ollama
        // prints (9b 6.7 + 4b 3.5 = 10.2) and 11 + 10.2 = 21.2 clears the gate,
        // so the handler unloads both models on a promise it cannot keep.
        const called: string[] = [];
        const deps = makeDeps({
            freemem: () => 11 * GB,
            callLocal: async (_u, model) => { called.push(model); return { ok: true as const, text: "pong" }; },
        });

        const r = await runInfer(args({ ceiling: "27b" }), deps);

        expect(unloaded, "warm models unloaded on a promise the weights cannot keep").toEqual([]);
        expect(called).toEqual(["prism-coder:9b"]);
        expect(r.model_picked).toBe("prism-coder:9b");
    });

    it("never evicts models outside the prism tier table", async () => {
        const deps = makeDeps({
            freemem: () => 14 * GB,
            listLoaded: async () => new Set([...WARM, "llama3:70b", "someone-elses:13b"]),
        });

        await runInfer(args({ ceiling: "27b" }), deps);

        expect(unloaded).not.toContain("llama3:70b");
        expect(unloaded).not.toContain("someone-elses:13b");
    });
});
