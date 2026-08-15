/**
 * prism_infer Tier Enforcement Tests
 *
 * Verifies that runInfer() correctly enforces entitlement gates:
 *   1. Model ceiling — free=4b, standard=9b, advanced/enterprise=27b
 *   2. Max tokens — clamped to plan limit
 *   3. Cloud fallback — blocked for free users
 *   4. Grounding verifier — blocked for free users
 *   5. Plan field in response
 *
 * All tests use injected deps (no live Ollama/portal).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    runInfer,
    type PrismInferArgs,
    type InferDeps,
    type PrismInferResult,
} from "../src/tools/prismInferHandler.js";
import {
    FREE_ENTITLEMENTS,
    type PrismEntitlements,
} from "../src/utils/entitlements.js";

// ── Entitlement fixtures ─────────────────────────────────────────

const FREE: PrismEntitlements = { ...FREE_ENTITLEMENTS };

const STANDARD: PrismEntitlements = {
    plan: "standard",
    model_ceiling: "9b",
    daily_infer_limit: 200,
    max_tokens: 1024,
    max_seats: 1,
    features: {
        cloud_fallback: true,
        grounding_verifier: true,
        route_guard: true,
        knowledge_search_unlimited: true,
        session_memory_unlimited: true,
        analytics_dashboard: true,
    },
    upgrade_url: "https://synalux.ai/pricing",
};

const ADVANCED: PrismEntitlements = {
    plan: "advanced",
    model_ceiling: "27b",
    daily_infer_limit: 2000,
    max_tokens: 2048,
    max_seats: 5,
    features: {
        cloud_fallback: true,
        grounding_verifier: true,
        route_guard: true,
        knowledge_search_unlimited: true,
        session_memory_unlimited: true,
        analytics_dashboard: true,
    },
    upgrade_url: "https://synalux.ai/pricing",
};

const ENTERPRISE: PrismEntitlements = {
    plan: "enterprise",
    model_ceiling: "27b",
    daily_infer_limit: 100_000,
    max_tokens: 4096,
    max_seats: 25,
    features: {
        cloud_fallback: true,
        grounding_verifier: true,
        route_guard: true,
        knowledge_search_unlimited: true,
        session_memory_unlimited: true,
        analytics_dashboard: true,
    },
    upgrade_url: "https://synalux.ai/pricing",
};

// ── Mock deps factory ────────────────────────────────────────────

function mockDeps(overrides: Partial<InferDeps> = {}): InferDeps {
    return {
        freemem: () => 16 * 1024 ** 3, // 16 GB free
        listTags: async () => new Set([
            "prism-coder:2b",
            "prism-coder:4b",
            "prism-coder:9b",
            "prism-coder:27b",
        ]),
        listLoaded: async () => new Set<string>(),
        callLocal: vi.fn(async (
            _url: string,
            model: string,
            _prompt: string,
            _system: string | undefined,
            maxTokens: number,
            _temp: number,
            _timeout: number,
        ) => ({
            ok: true as const,
            text: `response from ${model} (max_tokens=${maxTokens})`,
        })),
        callCloud: vi.fn(async (_prompt: string, maxTokens: number, _timeout: number) => ({
            ok: true,
            output: `cloud response (max_tokens=${maxTokens})`,
            backend: "gemini-3.6-flash",
        })),
        ollamaUrl: "http://localhost:11434",
        callLayer1: vi.fn(async () => "OBVIOUS_NOT_RESERVED" as const),
        callVerifier: vi.fn(async ({ draft }) => ({
            action: "accept" as const,
            finalText: draft,
            verifierChain: [],
        })),
        ...overrides,
    };
}

const baseArgs: PrismInferArgs = { prompt: "test prompt" };

// ── 1. Model Ceiling Enforcement ─────────────────────────────────

describe("model ceiling enforcement", () => {
    it("free user requesting 27b gets clamped to 4b model", async () => {
        const deps = mockDeps({ entitlements: FREE });
        const result = await runInfer({ ...baseArgs, model_ceiling: "27b" }, deps);

        // callLocal should have been called with a model ≤ 4b
        const calls = (deps.callLocal as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        const modelUsed = calls[0][1];
        expect(modelUsed).toMatch(/2b|4b/);
    });

    it("free user requesting 9b gets clamped to 4b", async () => {
        const deps = mockDeps({ entitlements: FREE });
        const result = await runInfer({ ...baseArgs, model_ceiling: "9b" }, deps);

        const calls = (deps.callLocal as ReturnType<typeof vi.fn>).mock.calls;
        const modelUsed = calls[0][1];
        expect(modelUsed).toMatch(/2b|4b/);
    });

    it("standard user requesting 27b selects the entitled 9b model", async () => {
        const deps = mockDeps({ entitlements: STANDARD });
        const result = await runInfer({ ...baseArgs, model_ceiling: "27b" }, deps);

        const calls = (deps.callLocal as ReturnType<typeof vi.fn>).mock.calls;
        const modelUsed = calls[0][1];
        expect(modelUsed).toMatch(/9b/);
        expect(modelUsed).not.toMatch(/27b/);
    });

    it("advanced user requesting 27b gets 27b (with sufficient RAM)", async () => {
        const deps = mockDeps({
            entitlements: ADVANCED,
            freemem: () => 32 * 1024 ** 3, // 32 GB — enough for 27b model (needs 24GB)
        });
        const result = await runInfer({ ...baseArgs, model_ceiling: "27b" }, deps);

        const calls = (deps.callLocal as ReturnType<typeof vi.fn>).mock.calls;
        const modelUsed = calls[0][1];
        expect(modelUsed).toMatch(/27b/);
    });

    it("free user with no ceiling specified gets 4b max", async () => {
        const deps = mockDeps({ entitlements: FREE });
        const result = await runInfer({ ...baseArgs }, deps);

        const calls = (deps.callLocal as ReturnType<typeof vi.fn>).mock.calls;
        const modelUsed = calls[0][1];
        expect(modelUsed).toMatch(/2b|4b/);
    });
});

// ── 2. Max Tokens Enforcement ────────────────────────────────────

describe("max tokens enforcement", () => {
    // CONTRACT CHANGE (2026-08-15): the plan cap is a CLOUD budget and no longer
    // clamps local num_predict. The free tier is local-only, so the old rule
    // throttled the user's own hardware for no saving, and 512 is below the
    // ~600 tokens a 9b turn spends on <think> — it manufactured hard_truncation.
    // Runaway generation stays bounded by timeout_ms and the quality gate.
    it("free user's LOCAL tokens are not clamped to the plan's 512", async () => {
        const deps = mockDeps({ entitlements: FREE });
        await runInfer({ ...baseArgs, max_tokens: 4096 }, deps);

        const calls = (deps.callLocal as ReturnType<typeof vi.fn>).mock.calls;
        const tokensSent = calls[0][4]; // maxTokens is the 5th positional arg
        expect(tokensSent, "plan cap leaked onto local inference").toBeGreaterThan(512);
    });

    it("standard user's LOCAL tokens are not clamped to the plan's cap", async () => {
        const deps = mockDeps({ entitlements: STANDARD });
        await runInfer({ ...baseArgs, max_tokens: 4096 }, deps);

        const calls = (deps.callLocal as ReturnType<typeof vi.fn>).mock.calls;
        const tokensSent = calls[0][4];
        expect(tokensSent).toBeGreaterThan(1024);
    });

    it("enterprise user gets full 4096 tokens", async () => {
        const deps = mockDeps({ entitlements: ENTERPRISE });
        const result = await runInfer({ ...baseArgs, max_tokens: 4096 }, deps);

        const calls = (deps.callLocal as ReturnType<typeof vi.fn>).mock.calls;
        const tokensSent = calls[0][4];
        expect(tokensSent).toBe(4096);
    });

    it("global hard cap of 8192 applies to enterprise too", async () => {
        const deps = mockDeps({ entitlements: ENTERPRISE });
        const result = await runInfer({ ...baseArgs, max_tokens: 16384 }, deps);

        const calls = (deps.callLocal as ReturnType<typeof vi.fn>).mock.calls;
        const tokensSent = calls[0][4];
        // The plan cap no longer bounds local inference, but the absolute 8192
        // ceiling still does — that one is a safety limit, not a billing limit.
        expect(tokensSent).toBeLessThanOrEqual(8192);
        expect(tokensSent, "global hard cap not applied").toBeLessThan(16384);
    });
});

// ── 3. Cloud Fallback Gate ───────────────────────────────────────

describe("cloud fallback gate", () => {
    it("free user with cloud_fallback=true still blocked", async () => {
        const deps = mockDeps({
            entitlements: FREE,
            // All local models fail
            callLocal: vi.fn(async () => ({ ok: false as const, reason: "all_fail" })),
        });

        await expect(
            runInfer({ ...baseArgs, cloud_fallback: true }, deps),
        ).rejects.toThrow();

        // Cloud should NOT have been called
        expect(deps.callCloud).not.toHaveBeenCalled();
    });

    it("standard user with cloud_fallback=true gets cloud on local failure", async () => {
        const deps = mockDeps({
            entitlements: STANDARD,
            callLocal: vi.fn(async () => ({ ok: false as const, reason: "all_fail" })),
        });

        const result = await runInfer({ ...baseArgs, cloud_fallback: true }, deps);

        expect(deps.callCloud).toHaveBeenCalled();
        expect(result.used_cloud).toBe(true);
    });

    it("paid user without cloud_fallback=true does not trigger cloud", async () => {
        const deps = mockDeps({
            entitlements: STANDARD,
            callLocal: vi.fn(async () => ({ ok: false as const, reason: "fail" })),
        });

        await expect(
            runInfer({ ...baseArgs, cloud_fallback: false }, deps),
        ).rejects.toThrow();

        expect(deps.callCloud).not.toHaveBeenCalled();
    });
});

// ── 4. Grounding Verifier Gate ───────────────────────────────────

describe("grounding verifier gate", () => {
    it("free user with verify=true and evidence does NOT call verifier", async () => {
        const verifierFn = vi.fn(async ({ draft }: { draft: string }) => ({
            action: "accept" as const,
            finalText: draft,
            verifierChain: [],
        }));

        const deps = mockDeps({
            entitlements: FREE,
            callVerifier: verifierFn,
        });

        const result = await runInfer({
            ...baseArgs,
            verify: true,
            evidence: [{ source: "doc.txt", content: "fact" }],
        }, deps);

        // Verifier should NOT have been called — free plan
        expect(verifierFn).not.toHaveBeenCalled();
        expect(result.verification).toBeUndefined();
    });

    it("standard user with verify=true calls verifier", async () => {
        const verifierFn = vi.fn(async ({ draft }: { draft: string }) => ({
            action: "accept" as const,
            finalText: draft,
            verifierChain: ["step1"],
        }));

        const deps = mockDeps({
            entitlements: STANDARD,
            callVerifier: verifierFn,
        });

        const result = await runInfer({
            ...baseArgs,
            verify: true,
            evidence: [{ source: "doc.txt", content: "fact" }],
        }, deps);

        expect(verifierFn).toHaveBeenCalled();
        expect(result.verification).toBeDefined();
        expect(result.verification!.action).toBe("accept");
    });

    it("standard user with evidence but verify=false skips verifier", async () => {
        const verifierFn = vi.fn(async ({ draft }: { draft: string }) => ({
            action: "accept" as const,
            finalText: draft,
            verifierChain: [],
        }));

        const deps = mockDeps({
            entitlements: STANDARD,
            callVerifier: verifierFn,
        });

        const result = await runInfer({
            ...baseArgs,
            verify: false,
            evidence: [{ source: "doc.txt", content: "fact" }],
        }, deps);

        expect(verifierFn).not.toHaveBeenCalled();
    });
});

// ── 5. Plan in Response ──────────────────────────────────────────

describe("plan in response", () => {
    it("free plan is returned in result", async () => {
        const deps = mockDeps({ entitlements: FREE });
        const result = await runInfer(baseArgs, deps);
        expect(result.plan).toBe("free");
    });

    it("standard plan is returned in result", async () => {
        const deps = mockDeps({ entitlements: STANDARD });
        const result = await runInfer(baseArgs, deps);
        expect(result.plan).toBe("standard");
    });

    it("enterprise plan is returned in result", async () => {
        const deps = mockDeps({ entitlements: ENTERPRISE });
        const result = await runInfer(baseArgs, deps);
        expect(result.plan).toBe("enterprise");
    });
});

// ── 6. Combined Gate Scenarios ───────────────────────────────────

describe("combined gate scenarios", () => {
    it("free user: 4b ceiling + 512 tokens + no cloud + no verifier", async () => {
        const verifierFn = vi.fn(async ({ draft }: { draft: string }) => ({
            action: "accept" as const, finalText: draft, verifierChain: [],
        }));

        const deps = mockDeps({
            entitlements: FREE,
            callVerifier: verifierFn,
            callLocal: vi.fn(async () => ({ ok: true as const, text: "ok" })),
        });

        const result = await runInfer({
            prompt: "test",
            max_tokens: 8192,
            model_ceiling: "27b",
            cloud_fallback: true,
            verify: true,
            evidence: [{ source: "x", content: "y" }],
        }, deps);

        // Model: only 4b or lower (no 9b, no 27b)
        const localCalls = (deps.callLocal as ReturnType<typeof vi.fn>).mock.calls;
        for (const call of localCalls) {
            expect(call[1]).toMatch(/2b|4b/);
        }

        // Tokens: the 512 plan cap binds CLOUD spend, not the user's own GPU.
        // Cloud clamping has its own test in prismInferBudgetScope.test.ts.
        expect(localCalls[0][4], "plan cap throttled local inference").toBeGreaterThan(512);

        // No verifier
        expect(verifierFn).not.toHaveBeenCalled();

        // Plan tag
        expect(result.plan).toBe("free");
    });

    it("enterprise user: full access to all features", async () => {
        const verifierFn = vi.fn(async ({ draft }: { draft: string }) => ({
            action: "accept" as const, finalText: draft, verifierChain: ["v1"],
        }));

        const deps = mockDeps({
            entitlements: ENTERPRISE,
            callVerifier: verifierFn,
            freemem: () => 32 * 1024 ** 3, // 32 GB — enough for 27b model
        });

        const result = await runInfer({
            prompt: "test",
            max_tokens: 4096,
            model_ceiling: "27b",
            verify: true,
            evidence: [{ source: "x", content: "y" }],
        }, deps);

        // Model: 27b available
        const localCalls = (deps.callLocal as ReturnType<typeof vi.fn>).mock.calls;
        expect(localCalls[0][1]).toMatch(/27b/);

        // Tokens: full 4096
        expect(localCalls[0][4]).toBe(4096);

        // Verifier called
        expect(verifierFn).toHaveBeenCalled();
        expect(result.verification).toBeDefined();

        // Plan tag
        expect(result.plan).toBe("enterprise");
    });
});
