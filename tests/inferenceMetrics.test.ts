import { describe, it, expect, beforeEach } from "vitest";
import {
    recordInference,
    getInferenceSnapshot,
    resetInferenceMetrics,
    formatInferenceMetrics,
    inferenceMetricsHandler,
} from "../src/utils/inferenceMetrics.js";

beforeEach(() => {
    resetInferenceMetrics();
});

describe("recordInference", () => {
    it("increments localCalls for local backend", () => {
        recordInference({ backend: "ollama-27b", model_picked: "prism-coder:27b", used_cloud: false, latency_ms: 100 });
        const snap = getInferenceSnapshot();
        expect(snap.localCalls).toBe(1);
        expect(snap.cloudCalls).toBe(0);
    });

    it("increments cloudCalls for cloud backend", () => {
        recordInference({ backend: "synalux", model_picked: null, used_cloud: true, latency_ms: 200 });
        const snap = getInferenceSnapshot();
        expect(snap.localCalls).toBe(0);
        expect(snap.cloudCalls).toBe(1);
    });

    it("skips safety_gate intercepts entirely", () => {
        recordInference({ backend: "safety_gate", model_picked: null, used_cloud: false, latency_ms: 1 });
        const snap = getInferenceSnapshot();
        expect(snap.totalCalls).toBe(0);
    });

    it("accumulates token counts", () => {
        recordInference({ backend: "ollama-9b", model_picked: "prism-coder:9b", used_cloud: false, latency_ms: 50, prompt_tokens: 100, completion_tokens: 50 });
        recordInference({ backend: "ollama-9b", model_picked: "prism-coder:9b", used_cloud: false, latency_ms: 60, prompt_tokens: 200, completion_tokens: 80 });
        const snap = getInferenceSnapshot();
        expect(snap.promptTokensEvaluated).toBe(300);
        expect(snap.totalCompletionTokens).toBe(130);
        expect(snap.totalTokens).toBe(430);
    });

    it("handles undefined token counts as 0", () => {
        recordInference({ backend: "ollama-2b", model_picked: "prism-coder:2b", used_cloud: false, latency_ms: 10 });
        const snap = getInferenceSnapshot();
        expect(snap.promptTokensEvaluated).toBe(0);
        expect(snap.totalCompletionTokens).toBe(0);
    });

    it("keys byModel on model_picked when available", () => {
        recordInference({ backend: "ollama-27b", model_picked: "prism-coder:27b", used_cloud: false, latency_ms: 100, prompt_tokens: 50, completion_tokens: 25 });
        const snap = getInferenceSnapshot();
        expect(snap.byModel["prism-coder:27b"]).toBeDefined();
        expect(snap.byModel["prism-coder:27b"].calls).toBe(1);
    });

    it("keys byModel on backend when model_picked is null", () => {
        recordInference({ backend: "synalux-27b", model_picked: null, used_cloud: true, latency_ms: 200 });
        const snap = getInferenceSnapshot();
        expect(snap.byModel["synalux-27b"]).toBeDefined();
    });

    it("accumulates per-model stats across multiple calls", () => {
        recordInference({ backend: "ollama-9b", model_picked: "prism-coder:9b", used_cloud: false, latency_ms: 50, prompt_tokens: 100, completion_tokens: 50 });
        recordInference({ backend: "ollama-9b", model_picked: "prism-coder:9b", used_cloud: false, latency_ms: 70, prompt_tokens: 150, completion_tokens: 60 });
        recordInference({ backend: "synalux", model_picked: null, used_cloud: true, latency_ms: 200, prompt_tokens: 80, completion_tokens: 40 });
        const snap = getInferenceSnapshot();
        expect(snap.byModel["prism-coder:9b"].calls).toBe(2);
        expect(snap.byModel["prism-coder:9b"].promptTokensEvaluated).toBe(250);
        expect(snap.byModel["synalux"].calls).toBe(1);
    });
});

describe("getInferenceSnapshot", () => {
    it("returns zeroed snapshot when no calls recorded", () => {
        const snap = getInferenceSnapshot();
        expect(snap.totalCalls).toBe(0);
        expect(snap.localPct).toBe(0);
        expect(snap.cloudPct).toBe(0);
        expect(Object.keys(snap.byModel)).toHaveLength(0);
    });

    it("percentages always sum to 100", () => {
        recordInference({ backend: "ollama-9b", model_picked: "prism-coder:9b", used_cloud: false, latency_ms: 50 });
        recordInference({ backend: "ollama-9b", model_picked: "prism-coder:9b", used_cloud: false, latency_ms: 50 });
        recordInference({ backend: "synalux", model_picked: null, used_cloud: true, latency_ms: 200 });
        const snap = getInferenceSnapshot();
        expect(snap.localPct + snap.cloudPct).toBe(100);
    });

    it("100% local when no cloud calls", () => {
        recordInference({ backend: "ollama-4b", model_picked: "prism-coder:4b", used_cloud: false, latency_ms: 30 });
        const snap = getInferenceSnapshot();
        expect(snap.localPct).toBe(100);
        expect(snap.cloudPct).toBe(0);
    });

    it("deep-copies byModel", () => {
        recordInference({ backend: "ollama-9b", model_picked: "prism-coder:9b", used_cloud: false, latency_ms: 100, prompt_tokens: 50, completion_tokens: 25 });
        const snap1 = getInferenceSnapshot();
        snap1.byModel["prism-coder:9b"].calls = 999;
        const snap2 = getInferenceSnapshot();
        expect(snap2.byModel["prism-coder:9b"].calls).toBe(1);
    });
});

describe("resetInferenceMetrics", () => {
    it("clears all state", () => {
        recordInference({ backend: "ollama-27b", model_picked: "prism-coder:27b", used_cloud: false, latency_ms: 100, prompt_tokens: 500, completion_tokens: 200 });
        resetInferenceMetrics();
        const snap = getInferenceSnapshot();
        expect(snap.totalCalls).toBe(0);
        expect(snap.totalTokens).toBe(0);
        expect(Object.keys(snap.byModel)).toHaveLength(0);
    });

    it("allows recording after reset", () => {
        recordInference({ backend: "ollama-9b", model_picked: "prism-coder:9b", used_cloud: false, latency_ms: 50, prompt_tokens: 100, completion_tokens: 50 });
        resetInferenceMetrics();
        recordInference({ backend: "ollama-4b", model_picked: "prism-coder:4b", used_cloud: false, latency_ms: 30, prompt_tokens: 40, completion_tokens: 20 });
        const snap = getInferenceSnapshot();
        expect(snap.totalCalls).toBe(1);
        expect(snap.byModel["prism-coder:9b"]).toBeUndefined();
        expect(snap.byModel["prism-coder:4b"]).toBeDefined();
    });
});

describe("formatInferenceMetrics", () => {
    it("returns empty string when no calls", () => {
        expect(formatInferenceMetrics()).toBe("");
    });

    it("single model hides breakdown", () => {
        recordInference({ backend: "ollama-9b", model_picked: "prism-coder:9b", used_cloud: false, latency_ms: 100, prompt_tokens: 200, completion_tokens: 80 });
        const out = formatInferenceMetrics();
        expect(out).toContain("Total calls: 1");
        expect(out).toContain("Local: 1 (100%)");
        expect(out).not.toContain("By model:");
    });

    it("multi-model shows breakdown sorted by calls", () => {
        recordInference({ backend: "ollama-27b", model_picked: "prism-coder:27b", used_cloud: false, latency_ms: 100, prompt_tokens: 100, completion_tokens: 50 });
        recordInference({ backend: "ollama-9b", model_picked: "prism-coder:9b", used_cloud: false, latency_ms: 50, prompt_tokens: 80, completion_tokens: 40 });
        recordInference({ backend: "ollama-9b", model_picked: "prism-coder:9b", used_cloud: false, latency_ms: 60, prompt_tokens: 90, completion_tokens: 45 });
        const out = formatInferenceMetrics();
        expect(out).toContain("By model:");
        expect(out.indexOf("prism-coder:9b")).toBeLessThan(out.indexOf("prism-coder:27b"));
    });

    it("handler returns message when no calls", async () => {
        const result = await inferenceMetricsHandler();
        expect(result.content[0].text).toContain("No prism_infer calls");
        expect(result.content[0].text).toContain("local-model delegation");
    });

    it("handler returns metrics block when calls exist", async () => {
        recordInference({ backend: "ollama-9b", model_picked: "prism-coder:9b", used_cloud: false, latency_ms: 100, prompt_tokens: 200, completion_tokens: 80 });
        const result = await inferenceMetricsHandler();
        expect(result.content[0].text).toContain("Total calls: 1");
        expect(result.content[0].text).toContain("Local: 1 (100%)");
    });

    it("mixed local and cloud", () => {
        recordInference({ backend: "ollama-9b", model_picked: "prism-coder:9b", used_cloud: false, latency_ms: 50, prompt_tokens: 100, completion_tokens: 50 });
        recordInference({ backend: "synalux", model_picked: null, used_cloud: true, latency_ms: 200, prompt_tokens: 80, completion_tokens: 40 });
        const out = formatInferenceMetrics();
        expect(out).toContain("Local: 1 (50%)");
        expect(out).toContain("Cloud: 1 (50%)");
    });
});
