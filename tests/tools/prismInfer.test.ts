import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { runInfer, type InferDeps, type PrismInferArgs } from "../../src/tools/prismInferHandler.js";
import { _setCacheForTest, _resetEntitlementsForTest, type PrismEntitlements } from "../../src/utils/entitlements.js";

const GB = 1024 ** 3;

const ENTERPRISE_ENTITLEMENTS: PrismEntitlements = {
    plan: "enterprise",
    model_ceiling: "32b",
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

beforeEach(() => {
    _setCacheForTest(ENTERPRISE_ENTITLEMENTS, 60_000);
});

afterAll(() => {
    _resetEntitlementsForTest();
});

const INSTALLED_ALL = new Set([
    "prism-coder:32b",
    "prism-coder:14b",
    "qwen3.5:4b",
    "prism-coder:1b7",
]);

function makeDeps(overrides: Partial<InferDeps>): InferDeps {
    return {
        freemem: () => 30 * GB,
        listTags: async () => INSTALLED_ALL,
        listLoaded: async () => new Set<string>(),
        callLocal: async () => ({ ok: false as const, reason: "default_mock_fail" }),
        callCloud: async () => ({ ok: false as const, reason: "default_mock_fail" }),
        ollamaUrl: "http://localhost:11434",
        ...overrides,
    };
}

function args(extra: Partial<PrismInferArgs> = {}): PrismInferArgs {
    return { prompt: "ping", ...extra };
}

describe("runInfer — local-first cascade", () => {
    it("hits 32B first on a high-RAM box", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            callLocal: async (_url, model) => {
                calls.push(model);
                return { ok: true as const, text: "pong-32b" };
            },
        });
        const r = await runInfer(args(), deps);
        expect(r.backend).toBe("ollama-32b");
        expect(r.model_picked).toBe("prism-coder:32b");
        expect(r.output).toBe("pong-32b");
        expect(r.used_cloud).toBe(false);
        expect(calls).toEqual(["prism-coder:32b"]);
    });

    it("falls down to 14B when 32B fails", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            callLocal: async (_url, model) => {
                calls.push(model);
                if (model === "prism-coder:32b") return { ok: false as const, reason: "timeout" };
                return { ok: true as const, text: `pong-${model}` };
            },
        });
        const r = await runInfer(args(), deps);
        expect(calls).toEqual(["prism-coder:32b", "prism-coder:14b"]);
        expect(r.backend).toBe("ollama-14b");
    });

    it("honors model_ceiling — 14b on a 64GB box never tries 32B", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            freemem: () => 64 * GB,
            callLocal: async (_url, model) => {
                calls.push(model);
                return { ok: true as const, text: "pong" };
            },
        });
        const r = await runInfer(args({ model_ceiling: "14b" }), deps);
        expect(calls).toEqual(["prism-coder:14b"]);
        expect(r.model_picked).toBe("prism-coder:14b");
    });

    it("skips tiers not installed in Ollama", async () => {
        const calls: string[] = [];
        const partial = new Set(["qwen3.5:4b", "prism-coder:1b7"]);
        const deps = makeDeps({
            freemem: () => 30 * GB,
            listTags: async () => partial,
            callLocal: async (_url, model) => {
                calls.push(model);
                return { ok: true as const, text: "pong" };
            },
        });
        const r = await runInfer(args(), deps);
        expect(calls).toEqual(["qwen3.5:4b"]);
        expect(r.attempts).toContainEqual({ tier: "prism-coder:32b", reason: "not_pulled" });
        expect(r.attempts).toContainEqual({ tier: "prism-coder:14b", reason: "not_pulled" });
    });

    it("RAM gate: 5 GB free skips 32B and 14B, picks 4b", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            freemem: () => 5 * GB,
            callLocal: async (_url, model) => {
                calls.push(model);
                return { ok: true as const, text: "pong" };
            },
        });
        const r = await runInfer(args(), deps);
        expect(calls).toEqual(["qwen3.5:4b"]);
        expect(r.model_picked).toBe("qwen3.5:4b");
    });

    it("RAM gate: 2 GB free → no local pick, errors with cloud_fallback=false", async () => {
        const deps = makeDeps({
            freemem: () => 2 * GB,
            callLocal: vi.fn(),
        });
        await expect(runInfer(args(), deps)).rejects.toThrow(/no backend produced output/);
        expect(deps.callLocal).not.toHaveBeenCalled();
    });

    it("Ollama unreachable → goes straight to cloud when allowed", async () => {
        const cloudFn = vi.fn(async () => ({ ok: true as const, output: "from-cloud", backend: "ollama-14b" }));
        const deps = makeDeps({
            listTags: async () => null,
            callLocal: vi.fn(),
            callCloud: cloudFn,
        });
        const r = await runInfer(args({ cloud_fallback: true }), deps);
        expect(r.used_cloud).toBe(true);
        expect(r.output).toBe("from-cloud");
        expect(cloudFn).toHaveBeenCalledOnce();
        expect(deps.callLocal).not.toHaveBeenCalled();
    });

    it("all local fail + cloud_fallback=true → cloud answer returned", async () => {
        const cloudFn = vi.fn(async () => ({ ok: true as const, output: "from-claude", backend: "claude-opus-last-resort" }));
        const deps = makeDeps({
            callLocal: async () => ({ ok: false as const, reason: "timeout" }),
            callCloud: cloudFn,
        });
        const r = await runInfer(args({ cloud_fallback: true }), deps);
        expect(r.used_cloud).toBe(true);
        expect(r.backend).toBe("claude-opus-last-resort");
        expect(r.attempts.length).toBeGreaterThanOrEqual(4); // tried all 4 local tiers
    });

    it("all local fail + cloud_fallback=false → throws (token-saving default)", async () => {
        const deps = makeDeps({
            callLocal: async () => ({ ok: false as const, reason: "network" }),
            callCloud: vi.fn(),
        });
        await expect(runInfer(args(), deps)).rejects.toThrow();
        expect(deps.callCloud).not.toHaveBeenCalled();
    });

    it("cloud_fallback=true but cloud also fails → throws with full attempt log", async () => {
        const deps = makeDeps({
            callLocal: async () => ({ ok: false as const, reason: "timeout" }),
            callCloud: async () => ({ ok: false as const, reason: "synalux_http_503" }),
        });
        await expect(runInfer(args({ cloud_fallback: true }), deps)).rejects.toThrow(/synalux_http_503/);
    });
});

describe("runInfer — telemetry", () => {
    it("reports ram_free_mb in megabytes", async () => {
        const deps = makeDeps({
            freemem: () => 16 * GB,
            callLocal: async () => ({ ok: true as const, text: "ok" }),
        });
        const r = await runInfer(args(), deps);
        expect(r.ram_free_mb).toBe(16 * 1024);
    });

    it("latency_ms is non-negative", async () => {
        const deps = makeDeps({
            callLocal: async () => ({ ok: true as const, text: "ok" }),
        });
        const r = await runInfer(args(), deps);
        expect(r.latency_ms).toBeGreaterThanOrEqual(0);
    });
});

describe("runInfer — warm-model bypass", () => {
    it("uses already-loaded 32B even when freemem says insufficient", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            freemem: () => 2 * GB, // would normally block everything
            listLoaded: async () => new Set(["prism-coder:32b"]),
            callLocal: async (_url, model) => {
                calls.push(model);
                return { ok: true as const, text: "warm-32b" };
            },
        });
        const r = await runInfer(args(), deps);
        expect(calls).toEqual(["prism-coder:32b"]);
        expect(r.backend).toBe("ollama-32b");
        expect(r.output).toBe("warm-32b");
    });

    it("warm bypass respects model_ceiling", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            freemem: () => 2 * GB,
            listLoaded: async () => new Set(["prism-coder:32b", "prism-coder:14b"]),
            callLocal: async (_url, model) => {
                calls.push(model);
                return { ok: true as const, text: "ok" };
            },
        });
        // ceiling forbids 32B; should pick 14B even though both are warm
        const r = await runInfer(args({ model_ceiling: "14b" }), deps);
        expect(calls).toEqual(["prism-coder:14b"]);
        expect(r.model_picked).toBe("prism-coder:14b");
    });
});

// ─── L3 verifier integration ────────────────────────────────────────────

describe("runInfer — L3 grounding verifier integration", () => {
    function verifierMock(outcome: {
        action: "served" | "refused_fabricated" | "refused_no_evidence" | "refused_timeout";
        finalText: string;
        refusalClaim?: string;
    }) {
        return vi.fn(async () => ({
            action: outcome.action,
            finalText: outcome.finalText,
            claims: [],
            verifierChain: [{ model: "prism-coder:1b7", verdict: "ENTAILED" as const, latencyMs: 50 }],
            refusalClaim: outcome.refusalClaim,
        }));
    }

    it("bypasses the verifier entirely when verify is omitted (default false)", async () => {
        const callVerifier = vi.fn();
        const deps = makeDeps({
            callLocal: async () => ({ ok: true as const, text: "You have 8 patients." }),
            callVerifier: callVerifier as any,
        });
        const r = await runInfer(args(), deps);
        expect(callVerifier).not.toHaveBeenCalled();
        expect(r.output).toBe("You have 8 patients.");
        expect(r.verification).toBeUndefined();
    });

    it("calls the verifier when verify=true and substitutes a refusal for fabricated claims", async () => {
        const deps = makeDeps({
            callLocal: async () => ({ ok: true as const, text: "You have 8 patients." }),
            callVerifier: verifierMock({
                action: "refused_fabricated",
                finalText: 'I can\'t ground "8 patients" in the evidence provided.',
                refusalClaim: "8 patients",
            }) as any,
        });
        const r = await runInfer(args({ verify: true, evidence: [{ source: "x", content: "count: 0" }] }), deps);
        expect(r.output).toMatch(/can't ground "8 patients"/);
        expect(r.verification?.action).toBe("refused_fabricated");
        expect(r.verification?.refusalClaim).toBe("8 patients");
    });

    it("serves the draft unchanged when the verifier returns served", async () => {
        const deps = makeDeps({
            callLocal: async () => ({ ok: true as const, text: "You have 0 patients." }),
            callVerifier: verifierMock({ action: "served", finalText: "You have 0 patients." }) as any,
        });
        const r = await runInfer(args({ verify: true, evidence: [{ source: "x", content: "count: 0" }] }), deps);
        expect(r.output).toBe("You have 0 patients.");
        expect(r.verification?.action).toBe("served");
    });

    it("applies verification to cloud fallback output too", async () => {
        const callVerifier = verifierMock({
            action: "refused_fabricated",
            finalText: 'I can\'t ground "Jane Doe".',
            refusalClaim: "Jane Doe",
        });
        const deps = makeDeps({
            listTags: async () => new Set<string>(), // no local tiers
            callCloud: async () => ({ ok: true as const, output: "Jane Doe is your next appointment.", backend: "synalux-claude" }),
            callVerifier: callVerifier as any,
        });
        const r = await runInfer(args({ verify: true, cloud_fallback: true, evidence: [{ source: "x", content: "rows: []" }] }), deps);
        expect(r.used_cloud).toBe(true);
        expect(r.output).toMatch(/can't ground "Jane Doe"/);
        expect(r.verification?.action).toBe("refused_fabricated");
    });

    it("passes verifier_model + verifier_timeout_ms through to the verifier", async () => {
        const callVerifier = vi.fn(async (opts: any) => ({
            action: "served" as const,
            finalText: opts.draft,
            claims: [],
            verifierChain: [],
        }));
        const deps = makeDeps({
            callLocal: async () => ({ ok: true as const, text: "draft" }),
            callVerifier: callVerifier as any,
        });
        await runInfer(args({
            verify: true,
            evidence: [{ source: "x", content: "y" }],
            verifier_model: "qwen3.5:4b",
            verifier_timeout_ms: 5000,
        }), deps);
        const call = callVerifier.mock.calls[0][0] as any;
        expect(call.verifierModel).toBe("qwen3.5:4b");
        expect(call.timeoutMs).toBe(5000);
    });
});
