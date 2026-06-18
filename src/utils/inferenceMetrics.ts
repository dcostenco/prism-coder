/**
 * Inference metrics — local accumulator for user-facing display.
 *
 * The local accumulator is the SOLE source for the session metrics block
 * shown in session_save_ledger/handoff. It tracks what THIS prism process
 * did THIS session — prism is the natural and only complete source for
 * this data (the portal only sees what prism forwards).
 *
 * Portal forwarding (ddLog → /api/v1/telemetry) is a separate, best-effort
 * analytics stream that the display path never depends on. If the portal
 * is down, unconfigured, or the token is missing, users still see metrics.
 */

import { debugLog } from "./logger.js";

export interface ModelStats {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalLatencyMs: number;
}

export interface InferenceSnapshot {
    localCalls: number;
    cloudCalls: number;
    totalCalls: number;
    localPct: number;
    cloudPct: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    avgLatencyMs: number;
    byModel: Record<string, ModelStats>;
}

const byModel: Record<string, ModelStats> = {};
let localCalls = 0;
let cloudCalls = 0;
let totalPromptTokens = 0;
let totalCompletionTokens = 0;
let totalLatencyMs = 0;

export function recordInference(result: {
    backend: string;
    model_picked: string | null;
    used_cloud: boolean;
    latency_ms: number;
    prompt_tokens?: number;
    completion_tokens?: number;
}): void {
    if (result.backend === "safety_gate") return;

    const key = result.model_picked ?? result.backend;

    if (result.used_cloud) {
        cloudCalls++;
    } else {
        localCalls++;
    }

    const pt = result.prompt_tokens ?? 0;
    const ct = result.completion_tokens ?? 0;
    totalPromptTokens += pt;
    totalCompletionTokens += ct;
    totalLatencyMs += result.latency_ms;

    if (!byModel[key]) {
        byModel[key] = { calls: 0, promptTokens: 0, completionTokens: 0, totalLatencyMs: 0 };
    }
    byModel[key].calls++;
    byModel[key].promptTokens += pt;
    byModel[key].completionTokens += ct;
    byModel[key].totalLatencyMs += result.latency_ms;
}

export function getInferenceSnapshot(): InferenceSnapshot {
    const total = localCalls + cloudCalls;
    const modelCopy: Record<string, ModelStats> = {};
    for (const [k, v] of Object.entries(byModel)) {
        modelCopy[k] = { ...v };
    }
    return {
        localCalls,
        cloudCalls,
        totalCalls: total,
        localPct: total > 0 ? Math.round((localCalls / total) * 100) : 0,
        cloudPct: total > 0 ? 100 - Math.round((localCalls / total) * 100) : 0,
        totalPromptTokens,
        totalCompletionTokens,
        totalTokens: totalPromptTokens + totalCompletionTokens,
        avgLatencyMs: total > 0 ? Math.round(totalLatencyMs / total) : 0,
        byModel: modelCopy,
    };
}

export function resetInferenceMetrics(): void {
    localCalls = 0;
    cloudCalls = 0;
    totalPromptTokens = 0;
    totalCompletionTokens = 0;
    totalLatencyMs = 0;
    for (const key of Object.keys(byModel)) {
        delete byModel[key];
    }
    debugLog("[inference-metrics] Session metrics reset");
}

export async function inferenceMetricsHandler(): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
}> {
    const block = formatInferenceMetrics();
    return {
        content: [{
            type: "text",
            text: block || "No prism_infer calls this session. Metrics track local-model delegation only — not the host model's (Claude's) token spend.",
        }],
    };
}

export function formatInferenceMetrics(): string {
    const snap = getInferenceSnapshot();
    if (snap.totalCalls === 0) return "";

    const lines: string[] = [
        `\n📊 Inference Metrics (this session):`,
        `  Total calls: ${snap.totalCalls} — Local: ${snap.localCalls} (${snap.localPct}%) | Cloud: ${snap.cloudCalls} (${snap.cloudPct}%)`,
        `  Tokens: ${snap.totalPromptTokens.toLocaleString()} in + ${snap.totalCompletionTokens.toLocaleString()} out = ${snap.totalTokens.toLocaleString()} total`,
        `  Avg latency: ${snap.avgLatencyMs}ms`,
    ];

    const models = Object.entries(snap.byModel).sort((a, b) => b[1].calls - a[1].calls);
    if (models.length > 1) {
        lines.push(`  By model:`);
        for (const [name, stats] of models) {
            const tokens = stats.promptTokens + stats.completionTokens;
            const avgMs = stats.calls > 0 ? Math.round(stats.totalLatencyMs / stats.calls) : 0;
            lines.push(`    ${name}: ${stats.calls} calls, ${tokens.toLocaleString()} tokens, avg ${avgMs}ms`);
        }
    }

    return lines.join("\n");
}
