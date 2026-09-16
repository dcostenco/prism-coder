import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { runInfer, type InferDeps, type PrismInferArgs } from "../../src/tools/prismInferHandler.js";
import { _setCacheForTest, _resetEntitlementsForTest, type PrismEntitlements } from "../../src/utils/entitlements.js";

/**
 * Screenshot requests must not pay for capability they do not need.
 *
 * Measured 2026-08-15 against the live models on a rendered traceback
 * screenshot, three runs each:
 *
 *   prism-coder:2b  think=false   185 tok   2.3s   3/3 correct
 *   prism-coder:2b  think=true    867 tok   8.5s   3/3 correct
 *   prism-coder:4b  think=false             1.2s   3/3 correct
 *   prism-coder:9b  think=false             1.3s   0/3   (wrong traceback frame)
 *   prism-coder:9b  think=true              5.2s   3/3 correct
 *
 * Three separate costs were found on this path, and the tier choice — the one
 * a capability-scoring design would have optimised — was the smallest of them:
 *
 *   thinking on a tier that does not need it   8.5s -> 2.3s
 *   evicting a tier the walk then skips        ~2-3s
 *   tier choice (9b vs 2b)                     ~0s, both correct
 */

const GB = 1024 ** 3;

const ENT: PrismEntitlements = {
    plan: "enterprise", model_ceiling: "27b", daily_infer_limit: 99999,
    max_tokens: 2048, max_seats: 25,
    features: { cloud_fallback: false, grounding_verifier: false,
                knowledge_search_unlimited: true, session_memory_unlimited: true,
                analytics_dashboard: true },
    upgrade_url: "https://synalux.ai/pricing",
};

const PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const INSTALLED = new Set(["prism-coder:27b", "prism-coder:9b", "prism-coder:4b", "prism-coder:2b"]);

beforeEach(() => _setCacheForTest(ENT, 60_000));
afterAll(() => _resetEntitlementsForTest());

interface Seen { model: string; think?: boolean }

function makeDeps(seen: Seen[], overrides: Partial<InferDeps> = {}): InferDeps {
    return {
        freemem: () => 40 * GB,
        listTags: async () => INSTALLED,
        listLoaded: async () => new Set<string>(),
        // Production shape: only the 27b lacks a projector.
        probeVision: async (_u, m) => !m.includes("27b"),
        callLocal: async (_u, model, _p, _s, _mt, _t, _to, think) => {
            seen.push({ model, think });
            return { ok: true as const, text: "FILE: billing/pricing.py line 12", doneReason: "stop" };
        },
        callCloud: async () => ({ ok: false as const, reason: "no_cloud" }),
        ollamaUrl: "http://localhost:11434",
        callLayer1: async () => "OBVIOUS_NOT_RESERVED",
        // Hermetic: these tests assert the TABLE's 4,096-token window for the
        // 9b/27b. Without an injected probe the gate reads num_ctx from the
        // LIVE daemon at ollamaUrl, and on a host that adopted
        // scripts/prism-coder-9b.Modelfile (32768) they fail while passing on
        // CI, which has no Ollama. Found 2026-09-15 the day the pin landed.
        probeNumCtx: async () => null,
        ...overrides,
    };
}

const imageArgs = (extra: Partial<PrismInferArgs> = {}): PrismInferArgs =>
    ({ prompt: "read this screenshot", images: [PNG_B64], mode: "code", ...extra });

describe("vision requests take the cheapest tier that can see", () => {
    it("ships the default vision system prompt when the caller gives none", async () => {
        // This prompt is what makes smallest-first sound. Without it the small
        // tiers answer with the first thing they see: 4/6 on natural prompts,
        // 6/6 with it. The ordering below depends on this being present.
        const seenSystem: Array<string | undefined> = [];
        await runInfer(imageArgs(), makeDeps([], {
            callLocal: async (_u, _m, _p, system) => {
                seenSystem.push(system);
                return { ok: true as const, text: "FILE: billing/pricing.py line 12", doneReason: "stop" };
            },
        }));
        expect(seenSystem[0], "image request went out with no vision guidance").toBeTruthy();
        expect(seenSystem[0]).toContain("innermost");
    });

    it("never overrides a system prompt the caller wrote", async () => {
        const seenSystem: Array<string | undefined> = [];
        await runInfer(imageArgs({ system: "MINE" }), makeDeps([], {
            callLocal: async (_u, _m, _p, system) => {
                seenSystem.push(system);
                return { ok: true as const, text: "FILE: billing/pricing.py line 12", doneReason: "stop" };
            },
        }));
        expect(seenSystem[0]).toBe("MINE");
    });

    it("does not add vision guidance to a TEXT request", async () => {
        const seenSystem: Array<string | undefined> = [];
        await runInfer({ prompt: "write a clamp fn", mode: "code" }, makeDeps([], {
            callLocal: async (_u, _m, _p, system) => {
                seenSystem.push(system);
                return { ok: true as const, text: "function clamp(){}", doneReason: "stop" };
            },
        }));
        expect(seenSystem[0]).toBeUndefined();
    });

    it("uses the 9b — the tier that transcribes handwriting without silent errors", async () => {
        // Smallest-first was implemented and reverted the same day. Measured
        // live on a traceback screenshot:
        //
        //   prompt                          2b     4b     9b(think)
        //   structured "FILE: <file:line>"   ok     ok     ok
        //   natural "what file and line?"    WRONG  WRONG  ok
        //
        // Both small tiers answer with the CALLER frame instead of where the
        // exception was raised, and thinking does not rescue them — the 2b is
        // still wrong after 11.6s of it. 2.0s vs 5.8s is not worth an answer
        // the user cannot tell is wrong.
        const seen: Seen[] = [];
        const r = await runInfer(imageArgs(), makeDeps(seen));
        // 2b/4b write the phone number as 655-0182; the 9b reads 555-0182.
        expect(r.model_picked, "a small tier transcribes digits wrongly").toContain("9b");
    });

    it("still honours an explicit ceiling — this changes defaults, not instructions", async () => {
        const seen: Seen[] = [];
        const r = await runInfer(imageArgs({ model_ceiling: "9b" }), makeDeps(seen));
        expect(r.model_picked).toContain("9b");
    });

    it("never hands an image to a tier with no projector", async () => {
        const seen: Seen[] = [];
        await runInfer(imageArgs(), makeDeps(seen));
        expect(seen.some(s => s.model.includes("27b"))).toBe(false);
    });
});

describe("a paid caller is never handed an answer about an image the cloud never saw", () => {
    // callSynaluxInference's signature is (prompt, maxTokens, timeoutMs, opts) —
    // there is no image channel, and the request body is {prompt, max_tokens,
    // reserved}. Escalating an IMAGE request therefore sends the text alone.
    //
    // Measured before this guard, on a paid enterprise plan with cloud fallback
    // enabled: "How many lines are in this image?" returned
    // "The image contains 42 lines." with used_cloud=true — a fabrication the
    // caller cannot distinguish from a real answer. The other cloud path already
    // refused image requests for exactly this reason; the Layer 1 escalation
    // never got the same guard.
    const PAID: PrismEntitlements = {
        ...ENT,
        features: { ...ENT.features, cloud_fallback: true },
    };

    it("serves an UNCERTAIN image request locally rather than escalating to a text-only cloud", async () => {
        // Contract updated 2026-08-18: the property this test protects is that
        // a paid caller is never handed a fabricated answer about an image the
        // cloud never saw. The old mechanism was a refusal; the new one is
        // stronger — serve LOCALLY from a model that DID see the image, with
        // cloud pinned off for the whole call. Clinical pixels are safe
        // on-device; the leak was only ever the cloud path.
        _setCacheForTest(PAID, 60_000);
        let cloudCalls = 0;
        const deps = makeDeps([], {
            callLayer1: async () => "UNCERTAIN" as const,
            callCloud: (async () => {
                cloudCalls++;
                return { ok: true as const, output: "The image contains 42 lines.", backend: "anthropic" };
            }) as InferDeps["callCloud"],
        });
        const r = await runInfer({ ...imageArgs(), cloud_fallback: true }, deps);
        expect(r.used_cloud, "an image answer claimed a cloud that has no image channel").toBe(false);
        expect(r.attempts?.some(a => a.reason === "layer1_uncertain_image_local_only"),
               `attempts=${JSON.stringify(r.attempts)}`).toBe(true);
        expect(cloudCalls, "sent an image request to a cloud path with no image channel").toBe(0);
    });

    it("refuses an IMAGE request when the classifier itself errored", async () => {
        // callLayer1 maps ERROR to UNCERTAIN whenever images are present, so
        // this branch is unreachable through the real classifier — which is
        // exactly why it went untested and why reverting its guard left all
        // 4126 tests green. If a caller injects a classifier that returns ERROR,
        // nothing has looked at the image, so the answer is a refusal, not a
        // fallthrough to the keyword backstop and a local answer.
        _setCacheForTest(PAID, 60_000);
        let cloudCalls = 0;
        let localCalls = 0;
        const deps = makeDeps([], {
            callLayer1: async () => "ERROR" as const,
            callCloud: (async () => { cloudCalls++; return { ok: true as const, output: "x", backend: "anthropic" }; }) as InferDeps["callCloud"],
            callLocal: async () => { localCalls++; return { ok: true as const, text: "local", doneReason: "stop" }; },
        });
        await expect(
            runInfer({ ...imageArgs(), cloud_fallback: true }, deps),
        ).rejects.toThrow(/refused/);
        expect(cloudCalls, "escalated an image to a text-only cloud").toBe(0);
        expect(localCalls, "served an image locally that nothing had screened").toBe(0);
    });

    it("refuses an IMAGE request on ERROR with NO cloud at all — the free-tier half", async () => {
        // The guard is deliberately not conditioned on allowCloud, and that half
        // had no test: re-adding `allowCloud &&` to it left the full suite green.
        // The case named in review is exactly this one — no cloud, ERROR verdict,
        // images, clean keyword floor — where the backstop would previously have
        // served it locally from an image nothing had screened.
        _setCacheForTest(ENT, 60_000);          // cloud_fallback: false
        let localCalls = 0;
        const deps = makeDeps([], {
            callLayer1: async () => "ERROR" as const,
            callLocal: async () => { localCalls++; return { ok: true as const, text: "local", doneReason: "stop" }; },
        });
        await expect(runInfer(imageArgs(), deps)).rejects.toThrow(/refused/);
        expect(localCalls, "served an unscreened image locally via the keyword backstop").toBe(0);
    });

    it("still escalates a TEXT request to cloud — the guard is about images only", async () => {
        _setCacheForTest(PAID, 60_000);
        let cloudCalls = 0;
        const deps = makeDeps([], {
            callLayer1: async () => "UNCERTAIN" as const,
            callCloud: (async () => {
                cloudCalls++;
                return { ok: true as const, output: "cloud answer", backend: "anthropic" };
            }) as InferDeps["callCloud"],
        });
        const r = await runInfer(
            { prompt: "explain this clinical policy", mode: "chat", cloud_fallback: true },
            deps,
        );
        expect(cloudCalls).toBe(1);
        expect(r.used_cloud).toBe(true);
    });
});

describe("the vision prompt is accounted for, not just applied", () => {
    it("charges the ctx gate for the prompt it actually sends", async () => {
        // The gate used to price args.system while the model received
        // effectiveSystem, so 46 tokens of vision prompt went uncounted against
        // a 64-token margin. Reverting that leaves the whole suite green, which
        // is why this test exists.
        //
        // Budget on a 4096-ctx tier: 4096 - 3000 (flat per-image estimate) - 64
        // (template margin) = 1032 tokens. A 4000-char prompt estimates at 1000
        // — under the budget without the vision prompt, over it with.
        const seen: Seen[] = [];
        const r = await runInfer(
            { prompt: "x".repeat(4000), images: [PNG_B64], mode: "code" },
            makeDeps(seen),
        );
        expect(
            r.attempts.some(a => a.tier.includes("9b") && a.reason === "ctx_insufficient"),
            "the 9b was priced as if the vision prompt were free",
        ).toBe(true);
    });

    it("does not overrun the gate when the caller supplies no images", async () => {
        // Same prompt, no image: no vision prompt is added, so nothing changes
        // for text requests.
        const seen: Seen[] = [];
        const r = await runInfer({ prompt: "x".repeat(4000), mode: "code" }, makeDeps(seen));
        expect(r.attempts.some(a => a.reason === "ctx_insufficient" && a.tier.includes("9b"))).toBe(false);
    });

    it("treats system:'' as a caller who wants no system prompt", async () => {
        // `!args.system` swallowed the empty string and substituted the vision
        // prompt over an explicit instruction. Reverting to the falsy check also
        // leaves the suite green without this.
        const seenSystem: Array<string | undefined> = [];
        await runInfer(imageArgs({ system: "" }), makeDeps([], {
            callLocal: async (_u, _m, _p, system) => {
                seenSystem.push(system);
                return { ok: true as const, text: "FILE: billing/pricing.py line 12", doneReason: "stop" };
            },
        }));
        expect(seenSystem[0], "overrode an explicit empty system prompt").toBe("");
    });
});

describe("thinking on image requests follows the tier, not the mode", () => {
    it("does NOT think on a small tier when one is explicitly chosen", async () => {
        // Thinking costs 867 tokens for the same answer the 2b gives in 185.
        const seen: Seen[] = [];
        await runInfer(imageArgs({ model_ceiling: "2b" }), makeDeps(seen));
        const first = seen.find(s => s.model.includes("2b"));
        expect(first?.think, "paid for reasoning this tier does not need").toBe(false);
    });

    it("DOES think on the 9b, which is 0/3 without it", async () => {
        const seen: Seen[] = [];
        await runInfer(imageArgs({ model_ceiling: "9b" }), makeDeps(seen));
        const nine = seen.find(s => s.model.includes("9b"));
        expect(nine?.think, "the 9b reads the wrong traceback frame without thinking").toBe(true);
    });

    it("an explicit think flag still wins", async () => {
        const seen: Seen[] = [];
        await runInfer(imageArgs({ think: true }), makeDeps(seen));
        expect(seen[0]?.think).toBe(true);
    });

    it("leaves NON-image code requests thinking, as before", async () => {
        const seen: Seen[] = [];
        await runInfer({ prompt: "write a clamp fn", mode: "code" }, makeDeps(seen));
        expect(seen[0]?.think, "regressed thinking for ordinary code generation").toBe(true);
    });
});

describe("the eviction probe must not be able to fail the request", () => {
    // These two tests deliberately do NOT inject probeVision. Every other test
    // in this file does, and that is precisely why the first version of the
    // eviction fix shipped a hard regression: the real probeVision throws on
    // any non-2xx, and no stubbed probe ever throws.

    /** /api/show as production behaves it: the ceiling 404s (or errors) because
     *  it is not pulled, every other tier answers normally with vision. A blanket
     *  failure would take out the Layer 1 classifier probe first and never reach
     *  the code under test. */
    async function withCeilingShowStatus<T>(
        status: number, fn: () => Promise<T>, onEvict?: (m: string) => void,
    ): Promise<T> {
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
            const body = init?.body ? JSON.parse(String(init.body)) : {};
            if (String(url).includes("/api/show")) {
                if (String(body.model).includes("27b")) return new Response("nope", { status });
                return new Response(JSON.stringify({ capabilities: ["vision"] }), { status: 200 });
            }
            if (body.keep_alive === 0) onEvict?.(String(body.model));
            return new Response("{}", { status: 200 });
        }) as typeof fetch;
        try { return await fn(); } finally { globalThis.fetch = realFetch; }
    }

    it("serves an image request on a machine where the ceiling tier is NOT pulled", async () => {
        // /api/show 404s for a model that was never pulled. Before the fix this
        // probe ran before the installed check and its rejection propagated out
        // of runInfer: "ceiling not pulled" became a hard failure instead of a
        // tier the walk steps over.
        const seen: Seen[] = [];
        const withoutCeiling = new Set(["prism-coder:9b", "prism-coder:4b", "prism-coder:2b"]);
        const r = await withCeilingShowStatus(404, () => runInfer(imageArgs(), makeDeps(seen, {
            probeVision: undefined,
            listTags: async () => withoutCeiling,
            listLoaded: async () => new Set(["prism-coder:4b"]),
            freemem: () => 16 * GB,
        })));
        expect(r.model_picked, "an uninstalled ceiling failed the whole request").toBeTruthy();
        expect(seen.length).toBeGreaterThan(0);
    });

    it("treats an unprobeable ceiling as 'do not evict' rather than throwing", async () => {
        // Ollama restarting (5xx) or /api/show timing out must not take the
        // request down, and must not evict warm models on a guess.
        const unloaded: string[] = [];
        const seen: Seen[] = [];
        const r = await withCeilingShowStatus(503, () => runInfer(imageArgs(), makeDeps(seen, {
            probeVision: undefined,
            listLoaded: async () => new Set(["prism-coder:4b", "prism-coder:2b"]),
            freemem: () => 16 * GB,
        })), m => unloaded.push(m));
        expect(r.model_picked).toBeTruthy();
        expect(unloaded, "evicted warm models on the strength of a failed probe").toEqual([]);
    });
});

describe("eviction does not clear the decks for a tier that cannot serve", () => {
    it("skips eviction when the ceiling has no vision", async () => {
        const unloaded: string[] = [];
        const seen: Seen[] = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
            const body = init?.body ? JSON.parse(String(init.body)) : {};
            if (body.keep_alive === 0) unloaded.push(body.model);
            return new Response("{}", { status: 200 });
        }) as typeof fetch;
        try {
            await runInfer(imageArgs(), makeDeps(seen, {
                // warm smaller tiers, cold ceiling — the shape that triggered it
                listLoaded: async () => new Set(["prism-coder:4b", "prism-coder:2b"]),
                // 16 free + 6.2 warm = 22.2 GiB, which CLEARS the 27b's 21 GiB
                // gate — so without the fix eviction fires. The first version
                // used 12 GiB, where the credit never reached the gate and the
                // branch was never entered: the test passed under mutation.
                freemem: () => 16 * GB,
            }));
        } finally {
            globalThis.fetch = realFetch;
        }
        expect(unloaded, "unloaded warm models to make room for a tier it then skips").toEqual([]);
    });
});
