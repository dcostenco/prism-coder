/**
 * §5.2 — ledger mapping of the structured gate_outcome.
 *
 * recordInference must translate the failure-contract disposition into the
 * durable ledger row exactly once, keeping the legacy 'gate_failed_served'
 * string for degraded rows (existing queries depend on it) and carrying
 * refusal_reason only on refused rows.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/storage/inferMetricsLedger.js", () => ({
    appendInferMetric: vi.fn(),
    queryInferMetrics: vi.fn(async () => []),
}));

import { recordInference } from "../src/utils/inferenceMetrics.js";
import { appendInferMetric } from "../src/storage/inferMetricsLedger.js";

const appended = appendInferMetric as ReturnType<typeof vi.fn>;

const base = {
    backend: "ollama-4b",
    model_picked: "prism-coder:4b",
    used_cloud: false,
    latency_ms: 100,
};

beforeEach(() => appended.mockClear());

describe("ledger gate_outcome mapping", () => {
    it("success maps to gate_outcome='success', no refusal_reason", () => {
        recordInference({ ...base, gate_outcome: { status: "success", served_anyway: false } });
        expect(appended).toHaveBeenCalledTimes(1);
        expect(appended.mock.calls[0][0]).toMatchObject({ gate_outcome: "success" });
        expect(appended.mock.calls[0][0].refusal_reason).toBeUndefined();
    });

    it("degraded keeps the legacy 'gate_failed_served' string", () => {
        recordInference({
            ...base,
            quality_gate_failed: true,
            gate_outcome: { status: "degraded", reason: "hard_truncation", served_anyway: true },
        });
        expect(appended.mock.calls[0][0]).toMatchObject({ gate_outcome: "gate_failed_served" });
        expect(appended.mock.calls[0][0].refusal_reason).toBeUndefined();
    });

    it("refused carries refusal_reason from the contract", () => {
        recordInference({
            ...base,
            backend: "refused",
            model_picked: null,
            gate_outcome: { status: "refused", reason: "layer1_reserved", served_anyway: false },
        });
        expect(appended.mock.calls[0][0]).toMatchObject({
            backend: "refused",
            gate_outcome: "refused",
            refusal_reason: "layer1_reserved",
        });
    });

    it("legacy caller without gate_outcome still maps quality_gate_failed", () => {
        recordInference({ ...base, quality_gate_failed: true });
        expect(appended.mock.calls[0][0]).toMatchObject({ gate_outcome: "gate_failed_served" });
    });

    it("legacy caller with neither flag leaves gate_outcome undefined", () => {
        recordInference({ ...base });
        expect(appended.mock.calls[0][0].gate_outcome).toBeUndefined();
    });

    it("safety_gate rows are never ledgered (contract exclusion holds)", () => {
        recordInference({ backend: "safety_gate", model_picked: null, used_cloud: false, latency_ms: 1 });
        expect(appended).not.toHaveBeenCalled();
    });
});

// ── Adversarial-review finding 1: refused rows must not touch accumulators ──

describe("refused results and session accumulators", () => {
    it("a refused result gets a ledger row but does NOT count as a local serve or save tokens", async () => {
        const { getInferenceSnapshot, resetInferenceMetrics } = await import("../src/utils/inferenceMetrics.js");
        resetInferenceMetrics();

        recordInference({ ...base, prompt_text: "a real local serve", completion_tokens: 20 });
        const afterServe = getInferenceSnapshot();

        recordInference({
            backend: "refused",
            model_picked: null,
            used_cloud: false,
            latency_ms: 3,
            prompt_text: "a very long reserved clinical prompt that must not inflate savings",
            gate_outcome: { status: "refused", reason: "layer1_reserved", served_anyway: false },
        });
        const afterRefused = getInferenceSnapshot();

        expect(appended).toHaveBeenCalledTimes(2); // ledger row written for both
        expect(afterRefused.localCalls).toBe(afterServe.localCalls);
        expect(afterRefused.cloudTokensSavedEst).toBe(afterServe.cloudTokensSavedEst);
        expect(afterRefused.totalCalls ?? afterRefused.localCalls + (afterRefused.cloudCalls ?? 0))
            .toBe(afterServe.totalCalls ?? afterServe.localCalls + (afterServe.cloudCalls ?? 0));
    });
});

// ── Adversarial-review finding 2: serve-mode refusals ledger with parity ──

describe("serve-mode refusal ledger parity", () => {
    it("serve-mode layer1 refusal (throw path) ledgers gate_outcome='refused'", async () => {
        const { runInfer } = await import("../src/tools/prismInferHandler.js");
        const { FREE_ENTITLEMENTS } = await import("../src/utils/entitlements.js");
        appended.mockClear();
        const deps = {
            freemem: () => 16 * 1024 ** 3,
            listTags: async () => new Set(["prism-coder:4b"]),
            listLoaded: async () => new Set<string>(),
            callLocal: vi.fn(async () => ({ ok: true as const, text: "x" })),
            callCloud: vi.fn(async () => ({ ok: false, reason: "off" })),
            ollamaUrl: "http://localhost:11434",
            callLayer1: vi.fn(async () => "OBVIOUS_RESERVED" as const),
            entitlements: { ...FREE_ENTITLEMENTS },
        };
        await expect(
            runInfer({ prompt: "benign words", model_ceiling: "4b" }, deps as never),
        ).rejects.toThrow();
        const refusalRows = appended.mock.calls.filter(c => c[0].backend === "refused");
        expect(refusalRows).toHaveLength(1);
        expect(refusalRows[0][0]).toMatchObject({
            gate_outcome: "refused",
            refusal_reason: "layer1_reserved",
        });
    });

    it("serve-mode keyword-backstop refusal now writes a ledger row (was silent)", async () => {
        const { runInfer } = await import("../src/tools/prismInferHandler.js");
        const { FREE_ENTITLEMENTS } = await import("../src/utils/entitlements.js");
        appended.mockClear();
        const deps = {
            freemem: () => 16 * 1024 ** 3,
            listTags: async () => new Set(["prism-coder:4b"]),
            listLoaded: async () => new Set<string>(),
            callLocal: vi.fn(async () => ({ ok: true as const, text: "x" })),
            callCloud: vi.fn(async () => ({ ok: false, reason: "off" })),
            ollamaUrl: "http://localhost:11434",
            callLayer1: vi.fn(async () => "ERROR" as const),
            entitlements: { ...FREE_ENTITLEMENTS },
        };
        await expect(
            runInfer({ prompt: "document the elopement incident from today", model_ceiling: "4b" }, deps as never),
        ).rejects.toThrow(/keyword backstop/);
        const refusalRows = appended.mock.calls.filter(c => c[0].backend === "refused");
        expect(refusalRows).toHaveLength(1);
        expect(refusalRows[0][0]).toMatchObject({
            gate_outcome: "refused",
            refusal_reason: "keyword_backstop_reserved",
        });
    });
});
