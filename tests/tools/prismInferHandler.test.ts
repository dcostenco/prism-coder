/**
 * prismInferHandler — comprehensive unit tests
 * ═══════════════════════════════════════════════════════════════════
 *
 * Tests the RAM-gated local-first inference cascade, cloud fallback,
 * L3 grounding verifier integration, type guard, and timeout handling.
 *
 * All external dependencies (Ollama, synalux portal, os.freemem) are
 * injected via the InferDeps interface — no network calls, no mocks
 * on global fetch.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import {
    runInfer,
    isPrismInferArgs,
    type InferDeps,
    type PrismInferArgs,
    type PrismInferResult,
} from "../../src/tools/prismInferHandler.js";
import type { GroundingOutcome } from "../../src/utils/groundingVerifier.js";
import { _setCacheForTest, _resetEntitlementsForTest, type PrismEntitlements } from "../../src/utils/entitlements.js";

const GB = 1024 ** 3;

const ENTERPRISE_ENTITLEMENTS: PrismEntitlements = {
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

// Tests assume enterprise-level access (27b ceiling, cloud fallback, verifier)
beforeEach(() => {
    _setCacheForTest(ENTERPRISE_ENTITLEMENTS, 60_000);
});

afterAll(() => {
    _resetEntitlementsForTest();
});

// All five tiers installed in Ollama
const INSTALLED_ALL = new Set([
    "prism-coder:27b",
    "prism-coder:9b",
    "prism-coder:4b",
    "prism-coder:2b",
]);

// ─── Helpers ──────────────────────────────────────────────────────

function makeDeps(overrides: Partial<InferDeps> = {}): InferDeps {
    return {
        freemem: () => 30 * GB,
        listTags: async () => INSTALLED_ALL,
        listLoaded: async () => new Set<string>(),
        callLocal: async () => ({ ok: false as const, reason: "default_mock_fail" }),
        callCloud: async () => ({ ok: false as const, reason: "default_mock_fail" }),
        ollamaUrl: "http://localhost:11434",
        callLayer1: async () => "OBVIOUS_NOT_RESERVED",
        ...overrides,
    };
}

function args(extra: Partial<PrismInferArgs> = {}): PrismInferArgs {
    return { prompt: "ping", ...extra };
}

/**
 * Build a mock verifier that returns a canned GroundingOutcome.
 */
function verifierMock(outcome: Partial<GroundingOutcome> & { action: GroundingOutcome["action"]; finalText: string }) {
    return vi.fn(async () => ({
        claims: [],
        verifierChain: [{ model: "prism-coder:4b", verdict: "ENTAILED" as const, latencyMs: 10 }],
        ...outcome,
    }));
}

// ═══════════════════════════════════════════════════════════════════
// 1. isPrismInferArgs — type guard
// ═══════════════════════════════════════════════════════════════════

describe("isPrismInferArgs — type guard", () => {
    it("accepts minimal valid args (prompt only)", () => {
        expect(isPrismInferArgs({ prompt: "hello" })).toBe(true);
    });

    it("accepts fully-populated valid args", () => {
        expect(isPrismInferArgs({
            prompt: "hello",
            system: "you are helpful",
            max_tokens: 2048,
            temperature: 0.7,
            model_ceiling: "9b",
            cloud_fallback: true,
            timeout_ms: 30000,
            verify: true,
            verifier_model: "prism-coder:4b",
            verifier_timeout_ms: 3000,
            evidence: [{ source: "tool:x", content: "some fact" }],
        })).toBe(true);
    });

    it("rejects null", () => {
        expect(isPrismInferArgs(null)).toBe(false);
    });

    it("rejects undefined", () => {
        expect(isPrismInferArgs(undefined)).toBe(false);
    });

    it("rejects a string", () => {
        expect(isPrismInferArgs("just a string")).toBe(false);
    });

    it("rejects missing prompt", () => {
        expect(isPrismInferArgs({ system: "hi" })).toBe(false);
    });

    it("rejects empty prompt", () => {
        expect(isPrismInferArgs({ prompt: "  " })).toBe(false);
    });

    it("rejects non-string prompt", () => {
        expect(isPrismInferArgs({ prompt: 42 })).toBe(false);
    });

    it("rejects invalid model_ceiling value", () => {
        expect(isPrismInferArgs({ prompt: "hi", model_ceiling: "64b" })).toBe(false);
    });

    it("rejects non-boolean cloud_fallback", () => {
        expect(isPrismInferArgs({ prompt: "hi", cloud_fallback: "yes" })).toBe(false);
    });

    it("rejects non-number max_tokens", () => {
        expect(isPrismInferArgs({ prompt: "hi", max_tokens: "big" })).toBe(false);
    });

    it("rejects non-number temperature", () => {
        expect(isPrismInferArgs({ prompt: "hi", temperature: "hot" })).toBe(false);
    });

    it("rejects non-boolean verify", () => {
        expect(isPrismInferArgs({ prompt: "hi", verify: 1 })).toBe(false);
    });

    it("rejects non-string verifier_model", () => {
        expect(isPrismInferArgs({ prompt: "hi", verifier_model: 42 })).toBe(false);
    });

    it("rejects non-number verifier_timeout_ms", () => {
        expect(isPrismInferArgs({ prompt: "hi", verifier_timeout_ms: "fast" })).toBe(false);
    });

    it("rejects evidence that is not an array", () => {
        expect(isPrismInferArgs({ prompt: "hi", evidence: "not array" })).toBe(false);
    });

    it("rejects evidence items missing source", () => {
        expect(isPrismInferArgs({
            prompt: "hi",
            evidence: [{ content: "fact" }],
        })).toBe(false);
    });

    it("rejects evidence items missing content", () => {
        expect(isPrismInferArgs({
            prompt: "hi",
            evidence: [{ source: "tool:x" }],
        })).toBe(false);
    });

    it("rejects evidence items with non-string fields", () => {
        expect(isPrismInferArgs({
            prompt: "hi",
            evidence: [{ source: 42, content: true }],
        })).toBe(false);
    });

    it("rejects evidence items that are null", () => {
        expect(isPrismInferArgs({
            prompt: "hi",
            evidence: [null],
        })).toBe(false);
    });

    it("accepts all valid model_ceiling values", () => {
        for (const c of ["27b", "9b", "4b", "2b"]) {
            expect(isPrismInferArgs({ prompt: "hi", model_ceiling: c })).toBe(true);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════
// 2. RAM-gated tier selection
// ═══════════════════════════════════════════════════════════════════

describe("runInfer — RAM-gated tier selection", () => {
    it("picks 9b when 16GB free (27b needs 24GB, fails RAM gate)", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            freemem: () => 16 * GB,
            callLocal: async (_url, model) => {
                calls.push(model);
                return { ok: true as const, text: "pong-9b" };
            },
        });
        // No model_ceiling => handler starts at 27b, but 27b needs 24GB
        // which exceeds 16GB free. RAM gate skips 27b, picks 9b (needs 8GB).
        const r = await runInfer(args(), deps);
        expect(r.model_picked).toBe("prism-coder:9b");
        expect(r.backend).toBe("ollama-9b");
        expect(r.output).toBe("pong-9b");
        expect(r.used_cloud).toBe(false);
        // 27b was skipped by RAM gate, not called
        expect(calls).toEqual(["prism-coder:9b"]);
        expect(r.attempts).toContainEqual({ tier: "prism-coder:27b", reason: "ram_insufficient" });
    });

    it("picks 27b ONLY when explicit ceiling='27b' and RAM sufficient", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            freemem: () => 30 * GB,
            callLocal: async (_url, model) => {
                calls.push(model);
                return { ok: true as const, text: "pong-27b" };
            },
        });
        const r = await runInfer(args({ model_ceiling: "27b" }), deps);
        expect(r.model_picked).toBe("prism-coder:27b");
        expect(r.backend).toBe("ollama-27b");
        expect(calls).toEqual(["prism-coder:27b"]);
    });

    it("falls back to 4b when 5GB free (9b needs 8GB)", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            freemem: () => 5 * GB,
            callLocal: async (_url, model) => {
                calls.push(model);
                return { ok: true as const, text: "pong-4b" };
            },
        });
        const r = await runInfer(args(), deps);
        expect(r.model_picked).toBe("prism-coder:4b");
        expect(calls).toEqual(["prism-coder:4b"]);
        expect(r.attempts).toContainEqual({ tier: "prism-coder:9b", reason: "ram_insufficient" });
    });

    it("falls back to 4b when 6GB free (9b needs 8GB)", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            freemem: () => 6 * GB,
            callLocal: async (_url, model) => {
                calls.push(model);
                return { ok: true as const, text: "pong-4b" };
            },
        });
        const r = await runInfer(args(), deps);
        expect(r.model_picked).toBe("prism-coder:4b");
        expect(r.backend).toBe("ollama-4b");
        expect(calls).toEqual(["prism-coder:4b"]);
        expect(r.attempts).toContainEqual({ tier: "prism-coder:9b", reason: "ram_insufficient" });
    });

    it("falls back to 2b when 3GB free (4b needs 4GB)", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            freemem: () => 3 * GB,
            callLocal: async (_url, model) => {
                calls.push(model);
                return { ok: true as const, text: "pong-2b" };
            },
        });
        const r = await runInfer(args(), deps);
        expect(r.model_picked).toBe("prism-coder:2b");
        expect(r.backend).toBe("ollama-2b");
        expect(calls).toEqual(["prism-coder:2b"]);
    });

    it("returns no viable local when <3GB free (2b needs 3GB), throws without cloud", async () => {
        const localMock = vi.fn();
        const deps = makeDeps({
            freemem: () => 2 * GB,
            callLocal: localMock as any,
        });
        await expect(runInfer(args(), deps)).rejects.toThrow(/no backend produced output/);
        // No local model should have been attempted
        expect(localMock).not.toHaveBeenCalled();
    });

    it("returns no viable local when 0 bytes free", async () => {
        const localMock = vi.fn();
        const deps = makeDeps({
            freemem: () => 0,
            callLocal: localMock as any,
        });
        await expect(runInfer(args(), deps)).rejects.toThrow(/no backend produced output/);
        expect(localMock).not.toHaveBeenCalled();
    });

    it("ceiling=4b prevents trying 9b even with plenty of RAM", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            freemem: () => 64 * GB,
            callLocal: async (_url, model) => {
                calls.push(model);
                return { ok: true as const, text: "pong" };
            },
        });
        const r = await runInfer(args({ model_ceiling: "4b" }), deps);
        expect(r.model_picked).toBe("prism-coder:4b");
        expect(calls).toEqual(["prism-coder:4b"]);
        expect(calls).not.toContain("prism-coder:27b");
        expect(calls).not.toContain("prism-coder:9b");
    });

    it("ceiling=2b only tries 2b", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            freemem: () => 64 * GB,
            callLocal: async (_url, model) => {
                calls.push(model);
                return { ok: true as const, text: "pong-2b" };
            },
        });
        const r = await runInfer(args({ model_ceiling: "2b" }), deps);
        expect(r.model_picked).toBe("prism-coder:2b");
        expect(calls).toEqual(["prism-coder:2b"]);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Default ceiling behavior in runInfer vs pickLocalModel
// ═══════════════════════════════════════════════════════════════════
//
// NOTE: pickLocalModel (in modelPicker.ts) defaults to "9b" ceiling,
// but runInfer's cascade starts at index 0 (27b) when model_ceiling
// is not specified. The 9b default is a convention for callers; the
// handler itself walks all tiers from the top unless explicitly capped.

describe("runInfer — ceiling behavior", () => {
    it("no model_ceiling: starts at 27b (handler walks all tiers)", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            freemem: () => 64 * GB,
            callLocal: async (_url, model) => {
                calls.push(model);
                return { ok: true as const, text: "pong-27b" };
            },
        });
        // No model_ceiling arg => handler starts at index 0 (27b)
        const r = await runInfer(args(), deps);
        expect(calls[0]).toBe("prism-coder:27b");
        expect(r.model_picked).toBe("prism-coder:27b");
    });

    it("model_ceiling='9b' restricts to 9b and below", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            freemem: () => 64 * GB,
            callLocal: async (_url, model) => {
                calls.push(model);
                return { ok: true as const, text: "pong-9b" };
            },
        });
        const r = await runInfer(args({ model_ceiling: "9b" }), deps);
        expect(calls[0]).toBe("prism-coder:9b");
        expect(calls).not.toContain("prism-coder:27b");
        expect(r.model_picked).toBe("prism-coder:9b");
    });

    it("explicit ceiling='27b' is same as no ceiling (starts at 27b)", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            freemem: () => 64 * GB,
            callLocal: async (_url, model) => {
                calls.push(model);
                return { ok: true as const, text: "pong-27b" };
            },
        });
        const r = await runInfer(args({ model_ceiling: "27b" }), deps);
        expect(calls[0]).toBe("prism-coder:27b");
        expect(r.model_picked).toBe("prism-coder:27b");
    });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Cascade fallthrough (tier failures)
// ═══════════════════════════════════════════════════════════════════

describe("runInfer — cascade fallthrough on tier failures", () => {
    it("cascades from 9b to 4b when 9b fails", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            freemem: () => 16 * GB,
            callLocal: async (_url, model) => {
                calls.push(model);
                if (model.includes("9b")) return { ok: false as const, reason: "timeout" };
                return { ok: true as const, text: "pong-4b" };
            },
        });
        const r = await runInfer(args(), deps);
        expect(calls).toEqual(["prism-coder:9b", "prism-coder:4b"]);
        expect(r.model_picked).toBe("prism-coder:4b");
        expect(r.attempts).toContainEqual({ tier: "prism-coder:9b", reason: "timeout" });
    });

    it("cascades all the way down from 27b to 2b (no ceiling)", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            freemem: () => 64 * GB,
            callLocal: async (_url, model) => {
                calls.push(model);
                if (model === "prism-coder:2b") return { ok: true as const, text: "last-resort" };
                return { ok: false as const, reason: "ollama_http_500" };
            },
        });
        const r = await runInfer(args({ model_ceiling: "27b" }), deps);
        // ceiling=27b, cascades: 27b -> 9b -> 4b -> 2b
        expect(calls).toEqual([
            "prism-coder:27b",
            "prism-coder:9b",
            "prism-coder:4b",
            "prism-coder:2b",
        ]);
        expect(r.model_picked).toBe("prism-coder:2b");
    });

    it("cascades from ceiling=9b down to 2b", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            freemem: () => 64 * GB,
            callLocal: async (_url, model) => {
                calls.push(model);
                if (model === "prism-coder:2b") return { ok: true as const, text: "last-resort" };
                return { ok: false as const, reason: "ollama_http_500" };
            },
        });
        const r = await runInfer(args({ model_ceiling: "9b" }), deps);
        // ceiling=9b => cascade: 9b -> 4b -> 2b
        expect(calls).toEqual([
            "prism-coder:9b",
            "prism-coder:4b",
            "prism-coder:2b",
        ]);
        expect(r.model_picked).toBe("prism-coder:2b");
    });

    it("skips tiers not installed in Ollama", async () => {
        const calls: string[] = [];
        const partial = new Set(["prism-coder:4b", "prism-coder:2b"]);
        const deps = makeDeps({
            freemem: () => 30 * GB,
            listTags: async () => partial,
            callLocal: async (_url, model) => {
                calls.push(model);
                return { ok: true as const, text: "pong" };
            },
        });
        const r = await runInfer(args(), deps);
        expect(calls).toEqual(["prism-coder:4b"]);
        expect(r.attempts).toContainEqual({ tier: "prism-coder:9b", reason: "not_pulled" });
    });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Cloud fallback
// ═══════════════════════════════════════════════════════════════════

describe("runInfer — cloud fallback", () => {
    it("cloud_fallback=true: uses cloud when all local tiers fail", async () => {
        const cloudFn = vi.fn(async () => ({
            ok: true as const,
            output: "cloud-answer",
            backend: "synalux-9b",
        }));
        const deps = makeDeps({
            callLocal: async () => ({ ok: false as const, reason: "timeout" }),
            callCloud: cloudFn,
        });
        const r = await runInfer(args({ cloud_fallback: true }), deps);
        expect(r.used_cloud).toBe(true);
        expect(r.output).toBe("cloud-answer");
        expect(r.backend).toBe("synalux-9b");
        expect(cloudFn).toHaveBeenCalledOnce();
    });

    it("cloud_fallback=false (default): never calls cloud, throws on local exhaustion", async () => {
        const cloudFn = vi.fn();
        const deps = makeDeps({
            callLocal: async () => ({ ok: false as const, reason: "network" }),
            callCloud: cloudFn as any,
        });
        await expect(runInfer(args(), deps)).rejects.toThrow(/no backend produced output/);
        expect(cloudFn).not.toHaveBeenCalled();
    });

    it("cloud_fallback=true but cloud also fails: throws with full attempt log", async () => {
        const deps = makeDeps({
            callLocal: async () => ({ ok: false as const, reason: "timeout" }),
            callCloud: async () => ({ ok: false as const, reason: "synalux_http_503" }),
        });
        const err = await runInfer(args({ cloud_fallback: true }), deps).catch((e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toMatch(/no backend produced output/);
        expect(err.message).toMatch(/synalux/); // attempt log in the message
    });

    it("Ollama unreachable: goes straight to cloud when cloud_fallback=true", async () => {
        const localFn = vi.fn();
        const cloudFn = vi.fn(async () => ({
            ok: true as const,
            output: "from-cloud",
            backend: "synalux-opus",
        }));
        const deps = makeDeps({
            listTags: async () => null, // Ollama unreachable
            callLocal: localFn as any,
            callCloud: cloudFn,
        });
        const r = await runInfer(args({ cloud_fallback: true }), deps);
        expect(r.used_cloud).toBe(true);
        expect(r.output).toBe("from-cloud");
        expect(localFn).not.toHaveBeenCalled();
        expect(r.attempts).toContainEqual({ tier: "ollama_probe", reason: "unreachable" });
    });

    it("Ollama unreachable + cloud_fallback=false: throws", async () => {
        const deps = makeDeps({
            listTags: async () => null,
        });
        await expect(runInfer(args(), deps)).rejects.toThrow(/no backend produced output/);
    });

    it("cloud result model_picked is null (not a local model)", async () => {
        const deps = makeDeps({
            freemem: () => 1 * GB, // too low for any local tier
            callCloud: async () => ({
                ok: true as const,
                output: "cloud-answer",
                backend: "synalux-claude",
            }),
        });
        const r = await runInfer(args({ cloud_fallback: true }), deps);
        expect(r.model_picked).toBeNull();
        expect(r.used_cloud).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 6. Timeout handling
// ═══════════════════════════════════════════════════════════════════

describe("runInfer — timeout handling", () => {
    it("local timeout is logged and cascades to next tier", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            freemem: () => 16 * GB,
            callLocal: async (_url, model) => {
                calls.push(model);
                if (model.includes("9b")) return { ok: false as const, reason: "timeout" };
                return { ok: true as const, text: "recovered" };
            },
        });
        const r = await runInfer(args(), deps);
        expect(r.attempts).toContainEqual({ tier: "prism-coder:9b", reason: "timeout" });
        expect(r.model_picked).toBe("prism-coder:4b");
        expect(r.output).toBe("recovered");
    });

    it("all tiers timeout + no cloud => throws with timeout reasons in attempts", async () => {
        const deps = makeDeps({
            callLocal: async () => ({ ok: false as const, reason: "timeout" }),
        });
        const err = await runInfer(args(), deps).catch((e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toMatch(/timeout/);
    });

    it("custom timeout_ms is passed through to callLocal", async () => {
        let capturedTimeout: number | undefined;
        const deps = makeDeps({
            freemem: () => 16 * GB,
            callLocal: async (_url, _model, _prompt, _sys, _max, _temp, timeout) => {
                capturedTimeout = timeout;
                return { ok: true as const, text: "ok" };
            },
        });
        await runInfer(args({ timeout_ms: 45_000 }), deps);
        expect(capturedTimeout).toBe(45_000);
    });

    it("default timeout scales with model size", async () => {
        const timeouts: Record<string, number> = {};
        // Run with ceiling=27b and all tiers failing to capture timeout for each
        const deps = makeDeps({
            freemem: () => 64 * GB,
            callLocal: async (_url, model, _prompt, _sys, _max, _temp, timeout) => {
                timeouts[model] = timeout;
                return { ok: false as const, reason: "fail" };
            },
        });
        await runInfer(args({ model_ceiling: "27b", cloud_fallback: false }), deps).catch(() => {});
        // Verify timeouts: 27b=120s, 9b=60s, 4b=20s, 2b=15s
        expect(timeouts["prism-coder:27b"]).toBe(120_000);
        expect(timeouts["prism-coder:9b"]).toBe(60_000);
        expect(timeouts["prism-coder:4b"]).toBe(20_000);
        expect(timeouts["prism-coder:2b"]).toBe(15_000);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 7. L3 grounding verifier integration
// ═══════════════════════════════════════════════════════════════════

describe("runInfer — L3 grounding verifier", () => {
    it("verify=true + evidence: verifier is called and can serve the draft", async () => {
        const callVerifier = verifierMock({
            action: "served",
            finalText: "Patient count: 5",
        });
        const deps = makeDeps({
            callLocal: async () => ({ ok: true as const, text: "Patient count: 5" }),
            callVerifier: callVerifier as any,
        });
        const r = await runInfer(args({
            verify: true,
            evidence: [{ source: "db", content: "patients: 5" }],
        }), deps);
        expect(r.output).toBe("Patient count: 5");
        expect(r.verification).toBeDefined();
        expect(r.verification!.action).toBe("served");
        expect(callVerifier).toHaveBeenCalledOnce();
    });

    it("verify=true + evidence: verifier refuses fabricated claims", async () => {
        const callVerifier = verifierMock({
            action: "refused_fabricated",
            finalText: 'I can\'t ground "10 patients" in the evidence provided.',
            refusalClaim: "10 patients",
        });
        const deps = makeDeps({
            callLocal: async () => ({ ok: true as const, text: "You have 10 patients." }),
            callVerifier: callVerifier as any,
        });
        const r = await runInfer(args({
            verify: true,
            evidence: [{ source: "db", content: "patients: 5" }],
        }), deps);
        expect(r.output).toMatch(/can't ground/);
        expect(r.verification!.action).toBe("refused_fabricated");
        expect(r.verification!.refusalClaim).toBe("10 patients");
    });

    it("verifier not called when verify is omitted and no evidence", async () => {
        const callVerifier = vi.fn();
        const deps = makeDeps({
            callLocal: async () => ({ ok: true as const, text: "just a response" }),
            callVerifier: callVerifier as any,
        });
        const r = await runInfer(args(), deps);
        expect(callVerifier).not.toHaveBeenCalled();
        expect(r.verification).toBeUndefined();
    });

    it("verifier auto-enabled when evidence is provided (even without explicit verify=true)", async () => {
        const callVerifier = verifierMock({
            action: "served",
            finalText: "grounded",
        });
        const deps = makeDeps({
            callLocal: async () => ({ ok: true as const, text: "grounded" }),
            callVerifier: callVerifier as any,
        });
        // evidence provided but verify not explicitly set => defaults to true
        const r = await runInfer(args({
            evidence: [{ source: "x", content: "fact" }],
        }), deps);
        expect(callVerifier).toHaveBeenCalledOnce();
        expect(r.verification).toBeDefined();
    });

    it("verify=false explicitly skips verifier even when evidence is provided", async () => {
        const callVerifier = vi.fn();
        const deps = makeDeps({
            callLocal: async () => ({ ok: true as const, text: "raw draft" }),
            callVerifier: callVerifier as any,
        });
        const r = await runInfer(args({
            verify: false,
            evidence: [{ source: "x", content: "fact" }],
        }), deps);
        expect(callVerifier).not.toHaveBeenCalled();
        expect(r.verification).toBeUndefined();
        expect(r.output).toBe("raw draft");
    });

    it("verification applies to cloud fallback output too", async () => {
        const callVerifier = verifierMock({
            action: "refused_fabricated",
            finalText: 'I can\'t ground "Jane Doe" in the evidence.',
            refusalClaim: "Jane Doe",
        });
        const deps = makeDeps({
            listTags: async () => new Set<string>(), // no local models
            callCloud: async () => ({
                ok: true as const,
                output: "Jane Doe is your next appointment.",
                backend: "synalux-claude",
            }),
            callVerifier: callVerifier as any,
        });
        const r = await runInfer(args({
            cloud_fallback: true,
            verify: true,
            evidence: [{ source: "calendar", content: "rows: []" }],
        }), deps);
        expect(r.used_cloud).toBe(true);
        expect(r.verification!.action).toBe("refused_fabricated");
    });

    it("passes verifier_model and verifier_timeout_ms through to verifier", async () => {
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
            verifier_model: "prism-coder:4b",
            verifier_timeout_ms: 5000,
        }), deps);
        const opts = callVerifier.mock.calls[0][0] as any;
        expect(opts.verifierModel).toBe("prism-coder:4b");
        expect(opts.timeoutMs).toBe(5000);
    });

    it("verifier receives the ollamaUrl from deps", async () => {
        const callVerifier = vi.fn(async (opts: any) => ({
            action: "served" as const,
            finalText: opts.draft,
            claims: [],
            verifierChain: [],
        }));
        const deps = makeDeps({
            callLocal: async () => ({ ok: true as const, text: "draft" }),
            callVerifier: callVerifier as any,
            ollamaUrl: "http://custom:9999",
        });
        await runInfer(args({
            verify: true,
            evidence: [{ source: "x", content: "y" }],
        }), deps);
        const opts = callVerifier.mock.calls[0][0] as any;
        expect(opts.ollamaUrl).toBe("http://custom:9999");
    });

    it("verification result includes verifierChain", async () => {
        const callVerifier = verifierMock({
            action: "served",
            finalText: "ok",
            verifierChain: [
                { model: "prism-coder:4b", verdict: "ENTAILED" as const, latencyMs: 42 },
            ],
        });
        const deps = makeDeps({
            callLocal: async () => ({ ok: true as const, text: "ok" }),
            callVerifier: callVerifier as any,
        });
        const r = await runInfer(args({
            verify: true,
            evidence: [{ source: "x", content: "y" }],
        }), deps);
        expect(r.verification!.verifierChain).toHaveLength(1);
        expect(r.verification!.verifierChain[0].model).toBe("prism-coder:4b");
    });
});

// ═══════════════════════════════════════════════════════════════════
// 8. Warm-model bypass
// ═══════════════════════════════════════════════════════════════════

describe("runInfer — warm-model RAM bypass", () => {
    it("uses already-loaded model even when freemem is insufficient for cold load", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            freemem: () => 2 * GB, // below min for any cold tier
            listLoaded: async () => new Set(["prism-coder:9b"]),
            callLocal: async (_url, model) => {
                calls.push(model);
                return { ok: true as const, text: "warm-9b" };
            },
        });
        const r = await runInfer(args(), deps);
        expect(calls).toEqual(["prism-coder:9b"]);
        expect(r.backend).toBe("ollama-9b");
        expect(r.output).toBe("warm-9b");
    });

    it("warm bypass still respects model_ceiling", async () => {
        const calls: string[] = [];
        const deps = makeDeps({
            freemem: () => 2 * GB,
            listLoaded: async () => new Set(["prism-coder:27b", "prism-coder:9b", "prism-coder:4b"]),
            callLocal: async (_url, model) => {
                calls.push(model);
                return { ok: true as const, text: "ok" };
            },
        });
        // ceiling=4b should prevent 9b (and 27b) from being tried
        const r = await runInfer(args({ model_ceiling: "4b" }), deps);
        expect(calls).toEqual(["prism-coder:4b"]);
        expect(r.model_picked).toBe("prism-coder:4b");
    });
});

// ═══════════════════════════════════════════════════════════════════
// 9. Telemetry fields
// ═══════════════════════════════════════════════════════════════════

describe("runInfer — telemetry", () => {
    it("ram_free_mb is reported in megabytes", async () => {
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

    it("attempts array is populated even on success", async () => {
        // Install only 4b and 2b — so 9b is skipped as not_pulled
        const deps = makeDeps({
            freemem: () => 16 * GB,
            listTags: async () => new Set(["prism-coder:4b", "prism-coder:2b"]),
            callLocal: async () => ({ ok: true as const, text: "ok" }),
        });
        const r = await runInfer(args(), deps);
        expect(r.attempts).toContainEqual({ tier: "prism-coder:9b", reason: "not_pulled" });
    });
});

// ═══════════════════════════════════════════════════════════════════
// 10. Namespaced Ollama tags
// ═══════════════════════════════════════════════════════════════════

describe("runInfer — namespaced Ollama tags (HuggingFace form)", () => {
    it("resolves dcostenco/prism-coder:9b to the namespaced name", async () => {
        const calls: string[] = [];
        const namespaced = new Set([
            "dcostenco/prism-coder:9b",
            "dcostenco/prism-coder:4b",
        ]);
        const deps = makeDeps({
            freemem: () => 16 * GB,
            listTags: async () => namespaced,
            callLocal: async (_url, model) => {
                calls.push(model);
                return { ok: true as const, text: "pong" };
            },
        });
        const r = await runInfer(args(), deps);
        // Should resolve to the namespaced form
        expect(calls[0]).toBe("dcostenco/prism-coder:9b");
        expect(r.model_picked).toBe("prism-coder:9b");
    });
});

// ═══════════════════════════════════════════════════════════════════
// 11. max_tokens clamping
// ═══════════════════════════════════════════════════════════════════

describe("runInfer — max_tokens clamping", () => {
    it("clamps max_tokens to enterprise ceiling (4096)", async () => {
        let capturedMax: number | undefined;
        const deps = makeDeps({
            freemem: () => 16 * GB,
            callLocal: async (_url, _model, _prompt, _sys, maxTokens) => {
                capturedMax = maxTokens;
                return { ok: true as const, text: "ok" };
            },
        });
        await runInfer(args({ max_tokens: 99999 }), deps);
        expect(capturedMax).toBe(4096);
    });

    it("defaults max_tokens to 1024 when not specified", async () => {
        let capturedMax: number | undefined;
        const deps = makeDeps({
            freemem: () => 16 * GB,
            callLocal: async (_url, _model, _prompt, _sys, maxTokens) => {
                capturedMax = maxTokens;
                return { ok: true as const, text: "ok" };
            },
        });
        await runInfer(args(), deps);
        expect(capturedMax).toBe(1024);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 12. Temperature passthrough
// ═══════════════════════════════════════════════════════════════════

describe("runInfer — temperature", () => {
    it("defaults to 0 when not specified", async () => {
        let capturedTemp: number | undefined;
        const deps = makeDeps({
            freemem: () => 16 * GB,
            callLocal: async (_url, _model, _prompt, _sys, _max, temp) => {
                capturedTemp = temp;
                return { ok: true as const, text: "ok" };
            },
        });
        await runInfer(args(), deps);
        expect(capturedTemp).toBe(0);
    });

    it("passes specified temperature through", async () => {
        let capturedTemp: number | undefined;
        const deps = makeDeps({
            freemem: () => 16 * GB,
            callLocal: async (_url, _model, _prompt, _sys, _max, temp) => {
                capturedTemp = temp;
                return { ok: true as const, text: "ok" };
            },
        });
        await runInfer(args({ temperature: 0.8 }), deps);
        expect(capturedTemp).toBe(0.8);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 13. System prompt passthrough
// ═══════════════════════════════════════════════════════════════════

describe("runInfer — system prompt", () => {
    it("passes system prompt through to callLocal", async () => {
        let capturedSystem: string | undefined;
        const deps = makeDeps({
            freemem: () => 16 * GB,
            callLocal: async (_url, _model, _prompt, system) => {
                capturedSystem = system;
                return { ok: true as const, text: "ok" };
            },
        });
        await runInfer(args({ system: "You are a code reviewer." }), deps);
        expect(capturedSystem).toBe("You are a code reviewer.");
    });

    it("system is undefined when not provided", async () => {
        let capturedSystem: string | undefined = "sentinel";
        const deps = makeDeps({
            freemem: () => 16 * GB,
            callLocal: async (_url, _model, _prompt, system) => {
                capturedSystem = system;
                return { ok: true as const, text: "ok" };
            },
        });
        await runInfer(args(), deps);
        expect(capturedSystem).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════════════════
// 14. Error shape
// ═══════════════════════════════════════════════════════════════════

describe("runInfer — error details", () => {
    it("thrown error includes attempts array", async () => {
        const deps = makeDeps({
            callLocal: async () => ({ ok: false as const, reason: "network" }),
        });
        try {
            await runInfer(args(), deps);
            expect.unreachable("should have thrown");
        } catch (err: any) {
            expect(err.attempts).toBeDefined();
            expect(Array.isArray(err.attempts)).toBe(true);
            expect(err.attempts.length).toBeGreaterThan(0);
        }
    });

    it("thrown error includes free RAM in message", async () => {
        const deps = makeDeps({
            freemem: () => 2 * GB,
        });
        const err = await runInfer(args(), deps).catch((e: Error) => e);
        expect(err.message).toMatch(/2\.0 GB/);
    });
});

describe("runInfer — mode/think parameter", () => {
    it("route mode sends think=false to Ollama", async () => {
        let capturedThink: boolean | undefined;
        const deps = makeDeps({
            callLocal: async (_url, _model, _prompt, _system, _max, _temp, _timeout, think) => {
                capturedThink = think;
                return { ok: true as const, text: "tool_call result" };
            },
        });
        await runInfer(args({ mode: "route" }), deps);
        expect(capturedThink).toBe(false);
    });

    it("chat mode sends think=true to Ollama", async () => {
        let capturedThink: boolean | undefined;
        const deps = makeDeps({
            callLocal: async (_url, _model, _prompt, _system, _max, _temp, _timeout, think) => {
                capturedThink = think;
                return { ok: true as const, text: "A helpful response about the topic." };
            },
        });
        await runInfer(args({ mode: "chat" }), deps);
        expect(capturedThink).toBe(true);
    });

    it("code mode sends think=true to Ollama", async () => {
        let capturedThink: boolean | undefined;
        const deps = makeDeps({
            callLocal: async (_url, _model, _prompt, _system, _max, _temp, _timeout, think) => {
                capturedThink = think;
                return { ok: true as const, text: "function sort(arr) { return arr.sort(); }" };
            },
        });
        await runInfer(args({ mode: "code" }), deps);
        expect(capturedThink).toBe(true);
    });

    it("explicit think=false overrides chat mode default", async () => {
        let capturedThink: boolean | undefined;
        const deps = makeDeps({
            callLocal: async (_url, _model, _prompt, _system, _max, _temp, _timeout, think) => {
                capturedThink = think;
                return { ok: true as const, text: "Quick answer without reasoning." };
            },
        });
        await runInfer(args({ mode: "chat", think: false }), deps);
        expect(capturedThink).toBe(false);
    });

    it("route mode does NOT inject nothink prefix into prompt", async () => {
        let capturedPrompt = "";
        const deps = makeDeps({
            callLocal: async (_url, _model, prompt, _system, _max, _temp, _timeout) => {
                capturedPrompt = prompt;
                return { ok: true as const, text: "tool routing result" };
            },
        });
        await runInfer(args({ mode: "route", prompt: "list tools" }), deps);
        expect(capturedPrompt).toBe("list tools");
        expect(capturedPrompt).not.toContain("<think>");
    });

    it("uses /api/chat not /api/generate (messages format)", async () => {
        let capturedUrl = "";
        const deps = makeDeps({
            freemem: () => 30 * GB,
            listTags: async () => INSTALLED_ALL,
            listLoaded: async () => new Set<string>(),
            callLocal: async (url) => {
                capturedUrl = url;
                return { ok: true as const, text: "response" };
            },
            callCloud: async () => ({ ok: false as const, reason: "unused" }),
            ollamaUrl: "http://localhost:11434",
        });
        await runInfer(args(), deps);
        expect(capturedUrl).toBe("http://localhost:11434");
    });
});
