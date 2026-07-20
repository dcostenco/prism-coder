/**
 * §5.2 Failure Contract Tests (local-first plan v2)
 *
 * Pins the three real terminal paths of runInfer:
 *   1. success   — output passed the quality gate (gate_outcome.status="success")
 *   2. degraded  — gate-failed output served anyway, explicitly flagged
 *                  (served_anyway:true + quality_gate_failed:true) — this
 *                  path used to be SILENT when cloud was unavailable
 *   3. refused   — safety refusal; throws in default "serve" mode, returns
 *                  {status:"refused", output:""} under escalation:"report"
 *
 * Infra exhaustion (no backend produced output) is NOT a refusal and must
 * keep throwing in both modes (§5.1 distinction: safety refusal ≠ infra failure).
 *
 * Drift guard: fixture files in tests/fixtures/infer-contract/ pin the
 * stable contract shape; the drift tests replay runInfer with injected deps
 * and deep-equal the stable subset against the fixtures. A refactor that
 * changes the contract fails the drift test before it ships.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
    runInfer,
    ReservedRefusalError,
    type PrismInferArgs,
    type InferDeps,
    type PrismInferResult,
} from "../src/tools/prismInferHandler.js";
import {
    FREE_ENTITLEMENTS,
    type PrismEntitlements,
} from "../src/utils/entitlements.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "infer-contract");

const FREE: PrismEntitlements = { ...FREE_ENTITLEMENTS };

const STANDARD: PrismEntitlements = {
    plan: "standard",
    model_ceiling: "14b",
    daily_infer_limit: 200,
    max_tokens: 1024,
    max_seats: 1,
    features: {
        cloud_fallback: true,
        grounding_verifier: true,
        knowledge_search_unlimited: true,
        session_memory_unlimited: true,
        analytics_dashboard: true,
    },
    upgrade_url: "https://synalux.ai/pricing",
};

// All prism tier tags installed under their bare names so resolveOllamaName
// is deterministic (backend strings in fixtures depend on it).
const INSTALLED_TAGS = new Set([
    "prism-coder:27b",
    "prism-coder:9b",
    "prism-coder:4b",
    "prism-coder:2b",
]);

function mockDeps(overrides: Partial<InferDeps> = {}): InferDeps {
    return {
        freemem: () => 16 * 1024 ** 3,
        listTags: async () => INSTALLED_TAGS,
        listLoaded: async () => new Set<string>(),
        callLocal: vi.fn(async () => ({
            ok: true as const,
            text: "a clean, complete answer",
        })),
        callCloud: vi.fn(async () => ({
            ok: true,
            output: "cloud response",
            backend: "synalux-27b",
        })),
        ollamaUrl: "http://localhost:11434",
        callLayer1: vi.fn(async () => "OBVIOUS_NOT_RESERVED" as const),
        ...overrides,
    } as InferDeps;
}

/** Local call that fails the quality gate via hard truncation. */
const truncatedLocal = () =>
    vi.fn(async () => ({
        ok: true as const,
        text: "an answer that got cut off mid-",
        doneReason: "length",
    }));

/** The stable contract subset compared against fixtures. */
function contractShape(r: PrismInferResult) {
    return {
        backend: r.backend,
        model_picked: r.model_picked,
        used_cloud: r.used_cloud,
        quality_gate_failed: r.quality_gate_failed ?? null,
        gate_outcome: r.gate_outcome,
        output_empty: r.output.length === 0,
    };
}

function loadFixture(name: string) {
    return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
}

const baseArgs: PrismInferArgs = { prompt: "test prompt", model_ceiling: "4b" };

// ── Terminal path 1: success ─────────────────────────────────────

describe("failure contract — success path", () => {
    it("gate-passing local output reports status=success, served_anyway=false", async () => {
        const deps = mockDeps({ entitlements: STANDARD });
        const r = await runInfer(baseArgs, deps);
        expect(r.gate_outcome).toEqual({ status: "success", served_anyway: false });
        expect(r.quality_gate_failed).toBeUndefined();
        expect(r.output).toBe("a clean, complete answer");
    });

    it("cloud-served output reports status=success", async () => {
        // No local tags installed → falls through to cloud.
        const deps = mockDeps({
            entitlements: STANDARD,
            listTags: async () => new Set<string>(),
        });
        const r = await runInfer({ ...baseArgs, cloud_fallback: true }, deps);
        expect(r.used_cloud).toBe(true);
        expect(r.gate_outcome).toEqual({ status: "success", served_anyway: false });
    });
});

// ── Terminal path 2: degraded (served-anyway) ────────────────────

describe("failure contract — degraded path", () => {
    it("gate-failed output with NO cloud is served but explicitly flagged (was silent)", async () => {
        const deps = mockDeps({
            entitlements: FREE, // cloud_fallback: false
            callLocal: truncatedLocal(),
        });
        const r = await runInfer(baseArgs, deps);
        expect(r.output).toContain("cut off");
        expect(r.quality_gate_failed).toBe(true);
        expect(r.gate_outcome).toEqual({
            status: "degraded",
            reason: "hard_truncation",
            served_anyway: true,
        });
    });

    it("gate-failed draft served after cloud failure carries the original gate reason", async () => {
        const deps = mockDeps({
            entitlements: STANDARD,
            callLocal: truncatedLocal(),
            callCloud: vi.fn(async () => ({ ok: false, reason: "http_500" })),
        });
        const r = await runInfer({ ...baseArgs, cloud_fallback: true }, deps);
        expect(r.quality_gate_failed).toBe(true);
        expect(r.gate_outcome).toEqual({
            status: "degraded",
            reason: "hard_truncation",
            served_anyway: true,
        });
        expect(r.attempts.some(a => a.reason.startsWith("quality_gate:"))).toBe(true);
    });
});

// ── Terminal path 3: refused ─────────────────────────────────────

describe("failure contract — refused path", () => {
    const reservedDeps = (overrides: Partial<InferDeps> = {}) =>
        mockDeps({
            entitlements: FREE, // no cloud → reserved must refuse
            callLayer1: vi.fn(async () => "OBVIOUS_RESERVED" as const),
            ...overrides,
        });

    it("serve mode (default): reserved content still THROWS ReservedRefusalError", async () => {
        await expect(runInfer(baseArgs, reservedDeps())).rejects.toBeInstanceOf(ReservedRefusalError);
    });

    it("report mode: reserved content returns {status:'refused', output:''} instead of throwing", async () => {
        const r = await runInfer({ ...baseArgs, escalation: "report" }, reservedDeps());
        expect(r.output).toBe("");
        expect(r.backend).toBe("refused");
        expect(r.gate_outcome).toEqual({
            status: "refused",
            reason: "layer1_reserved",
            served_anyway: false,
        });
    });

    it("report mode: keyword-backstop refusal returns typed result", async () => {
        const deps = mockDeps({
            entitlements: FREE,
            callLayer1: vi.fn(async () => "ERROR" as const),
        });
        const r = await runInfer(
            { prompt: "document the elopement incident from today", model_ceiling: "4b", escalation: "report" },
            deps,
        );
        expect(r.backend).toBe("refused");
        expect(r.gate_outcome).toEqual({
            status: "refused",
            reason: "keyword_backstop_reserved",
            served_anyway: false,
        });
    });

    it("report mode does NOT convert infra exhaustion into a refusal — still throws", async () => {
        const deps = mockDeps({
            entitlements: FREE,
            listTags: async () => null, // Ollama unreachable, no cloud
        });
        await expect(
            runInfer({ ...baseArgs, escalation: "report" }, deps),
        ).rejects.toThrow(/no backend produced output/);
    });
});

// ── Backward compatibility ───────────────────────────────────────

describe("failure contract — backward compatibility", () => {
    it("omitting escalation behaves identically to escalation:'serve' on refusal", async () => {
        const mk = () =>
            mockDeps({
                entitlements: FREE,
                callLayer1: vi.fn(async () => "OBVIOUS_RESERVED" as const),
            });
        await expect(runInfer(baseArgs, mk())).rejects.toBeInstanceOf(ReservedRefusalError);
        await expect(runInfer({ ...baseArgs, escalation: "serve" }, mk())).rejects.toBeInstanceOf(ReservedRefusalError);
    });
});

// ── Reserved escalation success (§5.1 × §5.2 interplay) ──────────

describe("failure contract — reserved escalation outcomes", () => {
    it("reserved content served by a STRONG cloud backend reports success", async () => {
        const deps = mockDeps({
            entitlements: STANDARD,
            callLayer1: vi.fn(async () => "OBVIOUS_RESERVED" as const),
            callCloud: vi.fn(async () => ({ ok: true, output: "clinical answer", backend: "claude-reserved" })),
        });
        const r = await runInfer({ ...baseArgs, cloud_fallback: true }, deps);
        expect(r.used_cloud).toBe(true);
        expect(r.gate_outcome).toEqual({ status: "success", served_anyway: false });
    });

    it("reserved + WEAK cloud backend: serve mode throws, report mode returns refused", async () => {
        const mk = () => mockDeps({
            entitlements: STANDARD,
            callLayer1: vi.fn(async () => "OBVIOUS_RESERVED" as const),
            callCloud: vi.fn(async () => ({ ok: true, output: "weak answer", backend: "openrouter-qwen" })),
        });
        await expect(
            runInfer({ ...baseArgs, cloud_fallback: true }, mk()),
        ).rejects.toBeInstanceOf(ReservedRefusalError);

        const r = await runInfer({ ...baseArgs, cloud_fallback: true, escalation: "report" }, mk());
        expect(r.backend).toBe("refused");
        expect(r.gate_outcome?.status).toBe("refused");
        expect(r.attempts.some(a => a.reason.startsWith("reserved_weak_backend:"))).toBe(true);
    });

    it("L1 classifier ERROR with healthy cloud reports success", async () => {
        const deps = mockDeps({
            entitlements: STANDARD,
            callLayer1: vi.fn(async () => "ERROR" as const),
        });
        const r = await runInfer({ ...baseArgs, cloud_fallback: true }, deps);
        expect(r.used_cloud).toBe(true);
        expect(r.gate_outcome).toEqual({ status: "success", served_anyway: false });
    });
});

// ── Degraded variety: loop detection ─────────────────────────────

describe("failure contract — loop_detected degraded path", () => {
    it("looping output with no cloud serves degraded with reason loop_detected", async () => {
        const looping = [
            "The cache invalidates the primary index every cycle",
            "The cache invalidates the primary index every cycle",
            "The cache invalidates the primary index every cycle",
            "Some other sentence about the request pipeline",
            "Another distinct sentence about memory pressure",
            "A final unique sentence closing the explanation",
        ].join(". ") + ".";
        const deps = mockDeps({
            entitlements: FREE,
            callLocal: vi.fn(async () => ({ ok: true as const, text: looping })),
        });
        const r = await runInfer(baseArgs, deps);
        expect(r.quality_gate_failed).toBe(true);
        expect(r.gate_outcome).toEqual({
            status: "degraded",
            reason: "loop_detected",
            served_anyway: true,
        });
    });
});

// ── Verification interplay ───────────────────────────────────────

describe("failure contract — verification interplay", () => {
    it("gate_outcome survives the applyVerification path", async () => {
        const deps = mockDeps({
            entitlements: STANDARD,
            callVerifier: vi.fn(async ({ draft }: { draft: string }) => ({
                action: "accept" as const,
                finalText: draft,
                verifierChain: [],
            })),
        });
        const r = await runInfer(
            { ...baseArgs, verify: true, evidence: [{ source: "t", content: "a clean, complete answer" }] },
            deps,
        );
        expect(r.verification?.action).toBe("accept");
        expect(r.gate_outcome).toEqual({ status: "success", served_anyway: false });
    });

    it("verifier refusal is reported via verification.action — gate_outcome stays success (documented split)", async () => {
        // Contract note: gate_outcome covers the SERVING pipeline's disposition;
        // grounding-verifier refusals are a separate, already-typed channel
        // (verification.action + refusalClaim). Callers must check both.
        const deps = mockDeps({
            entitlements: STANDARD,
            callVerifier: vi.fn(async () => ({
                action: "refused" as const,
                finalText: "REFUSED: claim not entailed by evidence",
                verifierChain: [],
                refusalClaim: "unsupported claim",
            })),
        });
        const r = await runInfer(
            { ...baseArgs, verify: true, evidence: [{ source: "t", content: "different content" }] },
            deps,
        );
        expect(r.verification?.action).toBe("refused");
        expect(r.gate_outcome?.status).toBe("success");
    });
});

// ── §5.3: UNCERTAIN_LENGTH routing ───────────────────────────────

describe("§5.3 — UNCERTAIN_LENGTH is not a safety verdict", () => {
    it("oversize-cleared prompt proceeds LOCAL with a distinct audit marker (no cloud, no refusal)", async () => {
        const deps = mockDeps({
            entitlements: FREE, // no cloud — old behavior refused here
            callLayer1: vi.fn(async () => "UNCERTAIN_LENGTH" as const),
        });
        const r = await runInfer(baseArgs, deps);
        expect(r.output).toBe("a clean, complete answer"); // served locally
        expect(r.used_cloud).toBe(false);
        expect(r.gate_outcome).toEqual({ status: "success", served_anyway: false });
        expect(r.attempts).toContainEqual({ tier: "layer1", reason: "layer1_uncertain_length" });
    });

    it("oversize prompt that FITS the tier ctx serves locally with the length marker visible", async () => {
        const bigPrompt = "benign words about refactoring the data pipeline ".repeat(2400); // ~117K chars ≈ 29K tokens < 4b's 32K ctx
        const deps = mockDeps({
            entitlements: FREE,
            callLayer1: vi.fn(async () => "UNCERTAIN_LENGTH" as const),
        });
        const r = await runInfer({ prompt: bigPrompt, model_ceiling: "4b" }, deps);
        expect(r.attempts).toContainEqual({ tier: "layer1", reason: "layer1_uncertain_length" });
        expect(r.backend).toBe("ollama-4b");
    });

    it("UNCERTAIN (semantic) still gets reserved handling — the two verdicts stay distinct", async () => {
        const deps = mockDeps({
            entitlements: FREE,
            callLayer1: vi.fn(async () => "UNCERTAIN" as const),
        });
        await expect(runInfer(baseArgs, deps)).rejects.toBeInstanceOf(ReservedRefusalError);
    });
});

// ── §5.4: per-tier ctx gate — never silent truncation ────────────

describe("§5.4 — ctx gate", () => {
    // 32 GB free so 27b passes the RAM gate and the CTX gate is what triggers.
    const bigRam = () => 32 * 1024 ** 3;
    // ~20K chars ≈ 5K tokens: exceeds 27b/9b's live num_ctx (4096), fits 4b/2b (32768).
    const midPrompt = "benign refactoring context words repeated for sizing purposes here ".repeat(300);
    // ~144K chars ≈ 36K tokens: exceeds every tier's ctx.
    const hugePrompt = "benign refactoring context words repeated for sizing purposes here ".repeat(2200);

    it("skips under-ctx tiers with reason ctx_insufficient and serves from a fitting tier", async () => {
        const deps = mockDeps({
            entitlements: STANDARD,
            freemem: bigRam,
            callLayer1: vi.fn(async () => "UNCERTAIN_LENGTH" as const),
        });
        const r = await runInfer({ prompt: midPrompt, model_ceiling: "27b" }, deps);
        expect(r.attempts).toContainEqual({ tier: "prism-coder:27b", reason: "ctx_insufficient" });
        expect(r.attempts).toContainEqual({ tier: "prism-coder:9b", reason: "ctx_insufficient" });
        expect(r.backend).toBe("ollama-4b"); // first tier whose ctx fits
        expect(r.gate_outcome?.status).toBe("success");
    });

    it("plan §7: prompt exceeding EVERY tier's ctx + no cloud → LOUD failure with ctx_insufficient visible, never a truncated answer", async () => {
        const deps = mockDeps({
            entitlements: FREE,
            freemem: bigRam,
            callLayer1: vi.fn(async () => "UNCERTAIN_LENGTH" as const),
        });
        let thrown: unknown;
        try {
            await runInfer({ prompt: hugePrompt }, deps);
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toMatch(/no backend produced output/);
        const attempts = (thrown as { attempts?: Array<{ tier: string; reason: string }> }).attempts ?? [];
        expect(attempts.some(a => a.reason === "ctx_insufficient")).toBe(true);
        // the local model was never called — nothing truncated, nothing served
        expect(deps.callLocal).not.toHaveBeenCalled();
    });

    it("prompt exceeding every tier's ctx WITH cloud → cloud serves the full prompt", async () => {
        const deps = mockDeps({
            entitlements: STANDARD,
            freemem: bigRam,
            callLayer1: vi.fn(async () => "UNCERTAIN_LENGTH" as const),
        });
        const r = await runInfer({ prompt: hugePrompt, cloud_fallback: true }, deps);
        expect(r.used_cloud).toBe(true);
        expect(deps.callLocal).not.toHaveBeenCalled();
        expect(r.gate_outcome).toEqual({ status: "success", served_anyway: false });
        // cloud received the FULL prompt, not an excerpt
        const cloudCalls = (deps.callCloud as ReturnType<typeof vi.fn>).mock.calls;
        expect(cloudCalls[0][0]).toBe(hugePrompt);
    });

    it("normal-size prompts are unaffected by the ctx gate", async () => {
        const deps = mockDeps({ entitlements: STANDARD, freemem: bigRam });
        const r = await runInfer({ ...baseArgs, model_ceiling: "27b" }, deps);
        expect(r.attempts.filter(a => a.reason === "ctx_insufficient")).toHaveLength(0);
        expect(r.backend).toBe("ollama-27b");
    });
});

// ── Out-of-contract paths pinned ─────────────────────────────────

describe("failure contract — boundaries", () => {
    it("crisis intercept (safety_gate) is OUTSIDE the contract — no gate_outcome", async () => {
        // Reuses the canonical crisis phrase from safetyGate.test.ts.
        const deps = mockDeps({ entitlements: FREE });
        const r = await runInfer({ prompt: "I want to hurt myself" }, deps);
        expect(r.backend).toBe("safety_gate");
        expect(r.gate_outcome).toBeUndefined();
        expect(r.output.length).toBeGreaterThan(0); // crisis resources ARE served
    });

    it("report-mode refusal result still carries the attempts trail", async () => {
        const r = await runInfer(
            { ...baseArgs, escalation: "report" },
            mockDeps({
                entitlements: FREE,
                callLayer1: vi.fn(async () => "OBVIOUS_RESERVED" as const),
            }),
        );
        expect(r.attempts.some(a => a.tier === "layer1")).toBe(true);
    });
});

// ── Arg validation ───────────────────────────────────────────────

describe("failure contract — escalation arg validation", () => {
    it("accepts serve/report/undefined, rejects anything else", async () => {
        const { isPrismInferArgs } = await import("../src/tools/prismInferHandler.js");
        expect(isPrismInferArgs({ prompt: "x" })).toBe(true);
        expect(isPrismInferArgs({ prompt: "x", escalation: "serve" })).toBe(true);
        expect(isPrismInferArgs({ prompt: "x", escalation: "report" })).toBe(true);
        expect(isPrismInferArgs({ prompt: "x", escalation: "yolo" })).toBe(false);
        expect(isPrismInferArgs({ prompt: "x", escalation: 1 })).toBe(false);
    });
});

// ── Fixture drift guard ──────────────────────────────────────────

describe("failure contract — fixture drift", () => {
    it("success path matches recorded fixture", async () => {
        const r = await runInfer(baseArgs, mockDeps({ entitlements: STANDARD }));
        expect(contractShape(r)).toEqual(loadFixture("success.json"));
    });

    it("degraded served-anyway path matches recorded fixture", async () => {
        const r = await runInfer(
            baseArgs,
            mockDeps({ entitlements: FREE, callLocal: truncatedLocal() }),
        );
        expect(contractShape(r)).toEqual(loadFixture("degraded-served.json"));
    });

    it("refused (report mode) path matches recorded fixture", async () => {
        const r = await runInfer(
            { ...baseArgs, escalation: "report" },
            mockDeps({
                entitlements: FREE,
                callLayer1: vi.fn(async () => "OBVIOUS_RESERVED" as const),
            }),
        );
        expect(contractShape(r)).toEqual(loadFixture("refused-report.json"));
    });
});
