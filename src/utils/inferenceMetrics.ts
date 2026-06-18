/**
 * Inference metrics — thin-client fetch from Synalux portal.
 *
 * Prism forwards per-call metrics via ddLog("prism_infer.usage").
 * The portal aggregates them in app_telemetry. This module fetches
 * the aggregated summary on demand (session_save_ledger/handoff).
 */

import { getSynaluxJwt } from "./synaluxJwt.js";
import { PRISM_SYNALUX_BASE_URL } from "../config.js";
import { debugLog } from "./logger.js";

interface PortalMetrics {
    total_calls: number;
    local_calls: number;
    cloud_calls: number;
    local_pct: number;
    cloud_pct: number;
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_tokens: number;
    avg_latency_ms: number;
    by_model: Record<string, { calls: number; prompt_tokens: number; completion_tokens: number; total_latency_ms: number }>;
}

let sessionStartedAt: string = new Date().toISOString();

export function markSessionStart(): void {
    sessionStartedAt = new Date().toISOString();
}

async function fetchMetrics(): Promise<{ metrics: PortalMetrics | null; error?: string }> {
    if (!PRISM_SYNALUX_BASE_URL) return { metrics: null, error: "no_portal_url" };

    const jwt = await getSynaluxJwt();
    if (!jwt) return { metrics: null, error: "jwt_unavailable" };

    try {
        const url = `${PRISM_SYNALUX_BASE_URL}/api/v1/telemetry/inference-metrics?since=${encodeURIComponent(sessionStartedAt)}`;
        const res = await fetch(url, {
            headers: { "Authorization": `Bearer ${jwt}` },
            signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) {
            debugLog(`[inference-metrics] portal returned ${res.status}`);
            return { metrics: null, error: `portal_${res.status}` };
        }
        return { metrics: (await res.json()) as PortalMetrics };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`[inference-metrics] fetch failed: ${msg}`);
        return { metrics: null, error: msg };
    }
}

export async function fetchPortalInferenceMetrics(): Promise<string> {
    const { metrics, error } = await fetchMetrics();
    if (!metrics) {
        if (error) debugLog(`[inference-metrics] unavailable: ${error}`);
        return "";
    }
    if (metrics.total_calls === 0) return "";

    const lines: string[] = [
        `\n📊 Inference Metrics (this session):`,
        `  Total calls: ${metrics.total_calls} — Local: ${metrics.local_calls} (${metrics.local_pct}%) | Cloud: ${metrics.cloud_calls} (${metrics.cloud_pct}%)`,
        `  Tokens: ${metrics.total_prompt_tokens.toLocaleString()} in + ${metrics.total_completion_tokens.toLocaleString()} out = ${metrics.total_tokens.toLocaleString()} total`,
        `  Avg latency: ${metrics.avg_latency_ms}ms`,
    ];

    const models = Object.entries(metrics.by_model).sort((a, b) => b[1].calls - a[1].calls);
    if (models.length > 1) {
        lines.push(`  By model:`);
        for (const [name, stats] of models) {
            const tokens = stats.prompt_tokens + stats.completion_tokens;
            const avgMs = stats.calls > 0 ? Math.round(stats.total_latency_ms / stats.calls) : 0;
            lines.push(`    ${name}: ${stats.calls} calls, ${tokens.toLocaleString()} tokens, avg ${avgMs}ms`);
        }
    }

    return lines.join("\n");
}
