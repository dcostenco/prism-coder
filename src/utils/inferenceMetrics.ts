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
import { appendInferMetric, queryInferMetrics } from "../storage/inferMetricsLedger.js";
import { ingestPanelMetrics } from "../storage/panelMetricsSpool.js";

const PANEL_CALLER = "panel";

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
    /** The two halves of cloudTokensSavedEst, kept separately so the savings
     *  meter can show a prompt/completion split without deriving it by
     *  subtraction — totalCompletionTokens spans cloud calls too, so
     *  cloudTokensSavedEst - totalCompletionTokens is wrong whenever any call
     *  fell through to cloud. */
    localPromptTokensEst: number;
    localCompletionTokens: number;
    /** Local calls where Ollama reported prompt_eval_count=0 (KV-cache hit) and
     *  the prompt tokens in localPromptTokensEst are therefore ESTIMATED from
     *  prompt text, not measured. The savings meter must disclose this: the
     *  ledger views count those calls' prompt tokens as 0 (measured floor),
     *  so the same call can read >10x higher here than there. */
    localCallsEstimatedPrompt: number;
    /** Local calls that recorded no token information at all — they contribute
     *  0 to every token figure. */
    localCallsUntokened: number;
    /** Wall-clock span of local serves this session, for the savings header.
     *  Null until the first local serve — without these the session render
     *  said "no local calls yet" above a populated call count (round-2
     *  adversarial review). */
    localFirstTs: number | null;
    localLastTs: number | null;
    thinkOnlyRetries: number;
    thinkOnlyRetryPct: number;
    /** Total user prompts seen this session (delegated + not delegated).
     *  A rate reading with nonDelegatedCount === 0 is a curated-set tautology,
     *  not a rate measurement. */
    totalPrompts: number;
    nonDelegatedCount: number;
    byModel: Record<string, ModelStats>;
    /** Local serves only. byModel keys on model name across BOTH local and
     *  cloud calls, so it cannot answer "what did local serving displace?" for
     *  a model name that appears on both sides. The savings meter reads this. */
    byModelLocal: Record<string, ModelStats>;
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

    // Whitespace density, because the punctuation test above cannot see the
    // content that breaks this estimate hardest. A base64 blob has almost no
    // code punctuation, so it took the PROSE divisor of 4.0 while really
    // tokenising at 1.31 chars/token — a 3x undercount. Measured against live
    // prism-coder:4b, chars per token:
    //
    //   TypeScript   25.8% whitespace   3.68
    //   prose        11.9%              ~4.0
    //   minified js   3.2%              2.44
    //   dense JSON     0%               1.58
    //   base64         0%               1.31
    //
    // Whitespace separates them with no overlap where punctuation does not.
    // This estimate feeds the §5.4 ctx gate, so undercounting is the dangerous
    // direction: an 84,953-char JSON payload estimated 25,744 tokens, cleared
    // the 32,768 gate, and was served by a model that silently discarded ~70%
    // of it and answered confidently from what was left. Overcounting only
    // costs an unnecessary escalation.
    //
    // These divisors do NOT guarantee an overcount, and an earlier version of
    // this comment claimed they did. Measured against 22 real repo files, real
    // TypeScript spans 1.57-3.82 chars/token and the estimate lands BELOW the
    // truth for 12 of them (worst 0.51x). The divisors reduce how often and how
    // far the estimate undercounts; the truncation detector in
    // prismInferHandler is what makes a missed estimate safe, and it is floored
    // on prompt LENGTH so it does not inherit these blind spots.
    const wsCount = (text.match(/\s/g) ?? []).length;
    const wsRatio = text.length > 0 ? wsCount / text.length : 1;
    const divisor =
        wsRatio < 0.01 ? 1.2      // base64, dense JSON — measured 1.31 and 1.58
        : wsRatio < 0.05 ? 2.2    // minified/packed source — measured 2.44
        : isCode ? 2.5            // see the range below — 3.3 was optimistic
        : 4.0;
    // The code divisor was 3.3, which is the ratio of comfortable prose-like
    // source. Measured across five code samples on prism-coder:4b it is a range,
    // not a constant: repo TypeScript 3.65 and 3.35, dense short statements 2.92,
    // shell 2.23, indented JSON-ish config 1.95.
    //
    // 2.5 covers real and dense source. It does NOT cover indented dense data —
    // that would need ~1.9, which would refuse ordinary code files at roughly
    // half the size they actually fit at, and a gate that refuses normal work
    // gets routed around.
    //
    // That is a deliberate limit, not an oversight. No character-based estimate
    // is safe across a 2x density spread, so the estimate is a ROUTING heuristic
    // and the truncation detector in prismInferHandler is what makes a miss safe.
    //
    // Precisely what the detector covers, since an earlier version of this
    // comment overstated it: it fires on prompts of at least num_ctx/2
    // CHARACTERS whose evaluated count lands on the collapse value. Flooring it
    // on length rather than on this estimate is what decouples the two — while
    // it was floored on the estimate its reach was capped at a 2x undercount,
    // and a tab-separated table (4x undercount) was served a wrong answer from a
    // truncated context with nothing recorded in attempts. It still cannot see
    // a prompt shorter than num_ctx/2 characters, which no tokenizer can turn
    // into num_ctx/2 tokens.
    const latinTokens = latinLen / divisor;
    const cjkTokens = cjkCount;          // ~1 token per CJK char
    const emojiTokens = emojiCount * 1.5; // ~1.5 BPE tokens per emoji
    return Math.ceil(Math.max(0, latinTokens) + cjkTokens + emojiTokens);
}

const byModel: Record<string, ModelStats> = {};
const byModelLocal: Record<string, ModelStats> = {};
let localCalls = 0;
let cloudCalls = 0;
let promptTokensEvaluated = 0;
let promptTokensSubmittedEst = 0;
let totalCompletionTokens = 0;
let totalLatencyMs = 0;
let cloudTokensSavedEst = 0;
let localPromptTokensEst = 0;
let localCompletionTokens = 0;
let localCallsEstimatedPrompt = 0;
let localCallsUntokened = 0;
let localFirstTs: number | null = null;
let localLastTs: number | null = null;
let thinkOnlyRetries = 0;
let totalPrompts = 0;
let nonDelegatedCount = 0;

export function recordThinkOnlyRetry(): void {
    thinkOnlyRetries++;
}

export function recordPromptSeen(delegated: boolean): void {
    totalPrompts++;
    if (!delegated) nonDelegatedCount++;
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
    /** Persisted to the durable ledger when present (Phase 0, plan §5.6). */
    mode?: string;
    ram_free_mb?: number;
    quality_gate_failed?: boolean;
    /** §5.2 failure contract — structured terminal disposition. */
    gate_outcome?: { status: "success" | "degraded" | "refused"; reason?: string; served_anyway: boolean };
    /** Prior turns sent with the call, and which screen layer decided it.
     *  Ledgered so "how often is history passed" and "which layer refused"
     *  are queries, not transcript archaeology (2026-09-16). */
    history_turns?: number;
    refusal_layer?: string;
}): void {
    if (result.backend === "safety_gate") return;

    // Durable ledger row (fire-and-forget; in-memory counters below remain the
    // per-session view). safety_gate is excluded by the early return above.
    // §5.2: prefer the structured gate_outcome; keep the legacy
    // "gate_failed_served" string for degraded rows so existing ledger
    // queries stay valid. Refused rows (escalation:"report") carry the
    // refusal reason — the serve-mode throw paths ledger directly at the
    // refusal site (makeReservedRefusal / backstop), so exactly one row
    // is written either way.
    const gateOutcomeStr = result.gate_outcome
        ? (result.gate_outcome.status === "degraded" ? "gate_failed_served" : result.gate_outcome.status)
        : (result.quality_gate_failed ? "gate_failed_served" : undefined);
    appendInferMetric({
        backend: result.backend,
        model: result.model_picked,
        used_cloud: result.used_cloud,
        mode: result.mode,
        gate_outcome: gateOutcomeStr,
        refusal_reason: result.gate_outcome?.status === "refused" ? result.gate_outcome.reason : undefined,
        prompt_tokens: result.prompt_tokens,
        completion_tokens: result.completion_tokens,
        latency_ms: result.latency_ms,
        ram_free_mb: result.ram_free_mb,
        history_turns: result.history_turns,
        refusal_layer: result.refusal_layer,
    });

    // §5.2: refused results (escalation:"report") get a ledger row above but
    // must NOT touch the session accumulators — no model ran and nothing was
    // served, so counting them as local serves would inflate local% and
    // cloudTokensSavedEst (the GATE 6 KPI: "improves only when local inference
    // replaces a cloud call"). Serve-mode refusals throw and never reach here,
    // so skipping keeps both modes' accounting identical.
    if (result.backend === "refused") return;

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
        localPromptTokensEst += submittedEst;
        localCompletionTokens += ct;
        // Honesty counters for the savings meter (adversarial review C1): a
        // KV-cache hit means submittedEst is an ESTIMATE, and a call with no
        // token data at all contributes 0 — both change how the headline must
        // be read, so both are tracked rather than left implicit.
        if (evaluated === 0 && submittedEst > 0) localCallsEstimatedPrompt++;
        if (submittedEst === 0 && ct === 0) localCallsUntokened++;
        const now = Date.now();
        if (localFirstTs === null) localFirstTs = now;
        localLastTs = now;
    }

    const bump = (into: Record<string, ModelStats>) => {
        if (!into[key]) {
            into[key] = {
                calls: 0,
                promptTokensEvaluated: 0,
                promptTokensSubmittedEst: 0,
                completionTokens: 0,
                totalLatencyMs: 0,
            };
        }
        into[key].calls++;
        into[key].promptTokensEvaluated += evaluated;
        into[key].promptTokensSubmittedEst += submittedEst;
        into[key].completionTokens += ct;
        into[key].totalLatencyMs += result.latency_ms;
    };
    bump(byModel);
    if (!result.used_cloud) bump(byModelLocal);
}

export function getInferenceSnapshot(): InferenceSnapshot {
    const total = localCalls + cloudCalls;
    const modelCopy: Record<string, ModelStats> = {};
    for (const [k, v] of Object.entries(byModel)) {
        modelCopy[k] = { ...v };
    }
    const modelLocalCopy: Record<string, ModelStats> = {};
    for (const [k, v] of Object.entries(byModelLocal)) {
        modelLocalCopy[k] = { ...v };
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
        localPromptTokensEst,
        localCompletionTokens,
        localCallsEstimatedPrompt,
        localCallsUntokened,
        localFirstTs,
        localLastTs,
        thinkOnlyRetries,
        thinkOnlyRetryPct: localCalls > 0 ? Math.round((thinkOnlyRetries / localCalls) * 100) : 0,
        totalPrompts,
        nonDelegatedCount,
        byModel: modelCopy,
        byModelLocal: modelLocalCopy,
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
    localPromptTokensEst = 0;
    localCompletionTokens = 0;
    localCallsEstimatedPrompt = 0;
    localCallsUntokened = 0;
    localFirstTs = null;
    localLastTs = null;
    thinkOnlyRetries = 0;
    totalPrompts = 0;
    nonDelegatedCount = 0;
    for (const key of Object.keys(byModel)) {
        delete byModel[key];
    }
    for (const key of Object.keys(byModelLocal)) {
        delete byModelLocal[key];
    }
    debugLog("[inference-metrics] Session metrics reset");
}

export async function inferenceMetricsHandler(args?: { period?: string }): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
}> {
    if (args?.period === "all") {
        const ingest = await ingestPanelMetrics();
        const agg = await queryInferMetrics();
        if (!agg || agg.total === 0) {
            const warning = ingest.failed_files > 0
                ? ` Panel spool ingestion failed for ${ingest.failed_files} file(s); retained for retry.`
                : "";
            return { content: [{ type: "text", text: `No persisted inference calls yet (ledger empty).${warning}` }] };
        }
        const localPct = agg.total ? Math.round((agg.local / agg.total) * 100) : 0;
        const cloudPct = agg.total ? Math.round((agg.cloud / agg.total) * 100) : 0;
        const span = agg.first_ts && agg.last_ts
            ? `${new Date(agg.first_ts).toISOString().slice(0, 10)} → ${new Date(agg.last_ts).toISOString().slice(0, 10)}`
            : "n/a";
        const byB = Object.entries(agg.by_backend)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `  ${k}: ${v}`).join("\n");
        const panel = agg.by_caller[PANEL_CALLER];
        const panelPct = panel?.total ? Math.round((panel.local / panel.total) * 100) : 0;
        const panelLine = panel
            ? `Panel local serve rate: ${panelPct}% (${panel.local}/${panel.total}; cloud ${panel.cloud})`
            : "Panel local serve rate: no panel calls recorded";
        let ingestNote = "";
        if (ingest.invalid > 0) ingestNote = `discarded ${ingest.invalid} invalid panel row(s)`;
        if (ingest.failed_files > 0) {
            ingestNote += `${ingestNote ? "; " : ""}retained ${ingest.failed_files} panel file(s) for retry`;
        }
        const ingestLine = ingestNote ? `\nPanel spool: ${ingestNote}` : "";
        return {
            content: [{
                type: "text",
                text: `📊 Inference Metrics — ALL TIME (persisted ledger, ${span})\n` +
                    `Total calls: ${agg.total} — Local: ${agg.local} (${localPct}%) | Cloud: ${agg.cloud} (${cloudPct}%)\n` +
                    `${panelLine}\n` +
                    `Prompt tokens: ${agg.prompt_tokens} | Completion tokens: ${agg.completion_tokens}\n` +
                    `Avg latency: ${agg.avg_latency_ms}ms\nBy backend:\n${byB}${ingestLine}`,
            }],
        };
    }
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
