/**
 * Inference metrics — local accumulator for user-facing display.
 *
 * Tracks what THIS prism process did THIS session. Portal forwarding
 * (ddLog) is a separate best-effort stream — display never depends on it.
 *
 * T1 fix: content-aware chars/token estimator (was flat /4, biased for
 *   emoji-dense/code/CJK payloads by 15–40%).
 * T2 fix: dual-column prompt tokens — `evaluated` (Ollama actual) vs
 *   `submittedEst` (estimated submitted, including KV-cached prefixes).
 *   Ollama returns prompt_eval_count=0 for cached prompts, so "evaluated"
 *   undercounts on repeated system-prompt calls; submittedEst shows actual load.
 */

import { debugLog } from "./logger.js";

export interface ModelStats {
    calls: number;
    promptTokensEvaluated: number;  // actual from Ollama prompt_eval_count
    promptTokensSubmittedEst: number;  // estimated total submitted (incl. KV-cached prefixes)
    completionTokens: number;
    totalLatencyMs: number;
}

export interface InferenceSnapshot {
    localCalls: number;
    cloudCalls: number;
    totalCalls: number;
    localPct: number;
    cloudPct: number;
    promptTokensEvaluated: number;
    promptTokensSubmittedEst: number;
    totalCompletionTokens: number;
    totalTokens: number;
    avgLatencyMs: number;
    /** Tokens handled by local Ollama instead of cloud — the honest routing metric.
     *  Accumulated as submittedEst + completionTokens for every used_cloud=false call.
     *  This is the "opportunity savings" — what would have gone to Claude/Synalux portal. */
    cloudTokensSavedEst: number;
    thinkOnlyRetries: number;
    thinkOnlyRetryPct: number;
    byModel: Record<string, ModelStats>;
}

// T1 fix: content-aware token estimator. Replaces flat text.length / 4 which
// underestimates emoji (~2 UTF-16 units but 1.5-2.5 BPE tokens) and CJK
// (~1 char ≈ 1 token) by 15-40%, and overestimates dense code (~3.3 chars/token).
export function estimateTokens(text: string): number {
    if (!text) return 0;
    const cjkCount = (text.match(/[　-鿿豈-﫿]/g) ?? []).length;
    const emojiCount = (text.match(/[\u{1F000}-\u{1FFFF}]/gu) ?? []).length;
    // Code density check: >2% of chars are code punctuation → use code divisor
    const codePunct = (text.match(/[`{};\[\]=>|#@$%^&*\\]/g) ?? []).length;
    const isCode = text.length > 0 && codePunct / text.length > 0.02;
    // UTF-16 length minus CJK and emoji codepoints (emoji are 2 units each)
    const latinLen = text.length - cjkCount - emojiCount * 2;
    const latinTokens = latinLen / (isCode ? 3.3 : 4.0);
    const cjkTokens = cjkCount;          // ~1 token per CJK char
    const emojiTokens = emojiCount * 1.5; // ~1.5 BPE tokens per emoji
    return Math.ceil(Math.max(0, latinTokens) + cjkTokens + emojiTokens);
}

const byModel: Record<string, ModelStats> = {};
let localCalls = 0;
let cloudCalls = 0;
let promptTokensEvaluated = 0;
let promptTokensSubmittedEst = 0;
let totalCompletionTokens = 0;
let totalLatencyMs = 0;
let cloudTokensSavedEst = 0;
let thinkOnlyRetries = 0;

export function recordThinkOnlyRetry(): void {
    thinkOnlyRetries++;
}

export function recordInference(result: {
    backend: string;
    model_picked: string | null;
    used_cloud: boolean;
    latency_ms: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    /** T2: pass prompt text (or length) so we can estimate submitted tokens when
     *  Ollama returns prompt_eval_count=0 (KV-cache hit). */
    prompt_text?: string;
    prompt_length?: number;
}): void {
    if (result.backend === "safety_gate") return;

    const key = result.model_picked ?? result.backend;

    if (result.used_cloud) {
        cloudCalls++;
    } else {
        localCalls++;
    }

    const evaluated = result.prompt_tokens ?? 0;
    const ct = result.completion_tokens ?? 0;

    // T2: when Ollama returns 0 evaluated (KV-cache hit), estimate submitted tokens
    // from the prompt text/length so submittedEst reflects actual context load.
    let submittedEst = evaluated; // default: evaluated is the best estimate
    if (evaluated === 0 && !result.used_cloud) {
        if (result.prompt_text) {
            submittedEst = estimateTokens(result.prompt_text);
        } else if (result.prompt_length && result.prompt_length > 0) {
            submittedEst = Math.ceil(result.prompt_length / 4); // flat fallback without text
        }
    }

    promptTokensEvaluated += evaluated;
    promptTokensSubmittedEst += submittedEst;
    totalCompletionTokens += ct;
    totalLatencyMs += result.latency_ms;
    if (!result.used_cloud) {
        cloudTokensSavedEst += submittedEst + ct;
    }

    if (!byModel[key]) {
        byModel[key] = {
            calls: 0,
            promptTokensEvaluated: 0,
            promptTokensSubmittedEst: 0,
            completionTokens: 0,
            totalLatencyMs: 0,
        };
    }
    byModel[key].calls++;
    byModel[key].promptTokensEvaluated += evaluated;
    byModel[key].promptTokensSubmittedEst += submittedEst;
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
        promptTokensEvaluated,
        promptTokensSubmittedEst,
        totalCompletionTokens,
        totalTokens: promptTokensSubmittedEst + totalCompletionTokens,
        avgLatencyMs: total > 0 ? Math.round(totalLatencyMs / total) : 0,
        cloudTokensSavedEst,
        thinkOnlyRetries,
        thinkOnlyRetryPct: localCalls > 0 ? Math.round((thinkOnlyRetries / localCalls) * 100) : 0,
        byModel: modelCopy,
    };
}

export function resetInferenceMetrics(): void {
    localCalls = 0;
    cloudCalls = 0;
    promptTokensEvaluated = 0;
    promptTokensSubmittedEst = 0;
    totalCompletionTokens = 0;
    totalLatencyMs = 0;
    cloudTokensSavedEst = 0;
    thinkOnlyRetries = 0;
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
            text: block || "No prism_infer calls this session.\n" +
                "📊 Delegation Metrics track local-model delegation — not the host model's (Claude's) spend.",
        }],
    };
}

/**
 * Format inference metrics.
 *
 * @param compact - When true, returns a single-line footer for appending to
 *   prism_infer responses. Output is threshold-gated: only emits every
 *   PRISM_METRICS_EVERY calls (default 5) so it doesn't drown per-response output.
 *   When false (default), returns the full multi-line block used by the explicit
 *   inference_metrics tool.
 */
export function formatInferenceMetrics(compact = false): string {
    const snap = getInferenceSnapshot();
    if (snap.totalCalls === 0) return "";

    if (compact) {
        // Threshold gate: only emit every N calls so the footer is periodic, not per-call noise.
        // The per-call header already shows backend/model/latency; this is the session rollup.
        const every = parseInt(process.env["PRISM_METRICS_EVERY"] ?? "5", 10);
        // Always emit on the first call (totalCalls===1) so short sessions (1–4 calls)
        // see at least one rollup. Otherwise emit every N calls as the rolling summary.
        if (snap.totalCalls !== 1 && snap.totalCalls % every !== 0) return "";
        const savedStr = snap.cloudTokensSavedEst > 0 ? ` · ${snap.cloudTokensSavedEst.toLocaleString()} cloud tok saved` : "";
        return `📊 local ${snap.localCalls} (${snap.localPct}%) · cloud ${snap.cloudCalls} (${snap.cloudPct}%) · ~${snap.totalTokens.toLocaleString()} tok · avg ${snap.avgLatencyMs}ms${savedStr}`;
    }

    // Full multi-line block (explicit inference_metrics tool call).
    // T2: show both evaluated (Ollama actual) and submitted estimate.
    // When they differ, the gap is KV-cached prompt tokens (real load, not counted by Ollama).
    const promptLine = snap.promptTokensEvaluated !== snap.promptTokensSubmittedEst
        ? `  Prompt tokens: ${snap.promptTokensEvaluated.toLocaleString()} evaluated / ${snap.promptTokensSubmittedEst.toLocaleString()} submitted est.`
        : `  Prompt tokens: ${snap.promptTokensEvaluated.toLocaleString()}`;

    const savedLine = snap.cloudTokensSavedEst > 0
        ? `  Cloud tokens saved (est.): ${snap.cloudTokensSavedEst.toLocaleString()} — token volume handled locally instead of cloud`
        : `  Cloud tokens saved (est.): 0`;

    const lines: string[] = [
        `\n📊 Delegation Metrics — local-model calls this session (not host model spend):`,
        `  Total calls: ${snap.totalCalls} — Local: ${snap.localCalls} (${snap.localPct}%) | Cloud: ${snap.cloudCalls} (${snap.cloudPct}%)`,
        promptLine,
        `  Completion tokens: ${snap.totalCompletionTokens.toLocaleString()}`,
        savedLine,
        `  Avg latency: ${snap.avgLatencyMs}ms`,
    ];

    const models = Object.entries(snap.byModel).sort((a, b) => b[1].calls - a[1].calls);
    if (models.length > 1) {
        lines.push(`  By model:`);
        for (const [name, stats] of models) {
            const tokens = stats.promptTokensSubmittedEst + stats.completionTokens;
            const avgMs = stats.calls > 0 ? Math.round(stats.totalLatencyMs / stats.calls) : 0;
            lines.push(`    ${name}: ${stats.calls} calls, ${tokens.toLocaleString()} tokens est., avg ${avgMs}ms`);
        }
    }

    return lines.join("\n");
}
