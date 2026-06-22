/**
 * Telemetry Logger — Prism MCP Server
 *
 * Sends structured events to Synalux portal (/api/v1/telemetry)
 * which stores in Supabase with 15-day retention.
 *
 * Falls back to Datadog HTTP Logs if DD_API_KEY is set.
 * Env: PRISM_SYNALUX_BASE_URL (default https://synalux.ai)
 */

const SYNALUX_BASE = process.env.PRISM_SYNALUX_BASE_URL || "https://synalux.ai";
const TELEMETRY_WRITE_TOKEN = process.env.TELEMETRY_WRITE_TOKEN || "";
const DD_API_KEY = process.env.DD_API_KEY || "";
const DD_SITE = process.env.DD_SITE || "datadoghq.com";
const SERVICE = "prism-mcp";

const CONTEXT_ALLOWLIST = new Set([
    "backend", "model", "used_cloud", "prompt_tokens", "completion_tokens",
    "latency_ms", "plan", "requested_ceiling", "effective_ceiling",
    "ceiling_clamped", "requested_tokens", "effective_tokens", "tokens_clamped",
    "cloud_requested", "cloud_allowed", "cloud_blocked",
    "verify_requested", "verify_allowed", "verify_blocked",
    "tool", "project", "success", "durationMs",
]);

const queue: Array<Record<string, unknown>> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 5_000;
const MAX_BATCH = 50;

function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
}

async function flush() {
    flushTimer = null;
    if (queue.length === 0) return;

    const batch = queue.splice(0, MAX_BATCH);

    // Primary: Synalux portal → Supabase (always available)
    if (TELEMETRY_WRITE_TOKEN) {
        try {
            await fetch(`${SYNALUX_BASE}/api/v1/telemetry`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${TELEMETRY_WRITE_TOKEN}`,
                    "X-Prism-Client": "prism-mcp",
                },
                body: JSON.stringify(batch.map(e => {
                    const ctx: Record<string, unknown> = {};
                    for (const [k, v] of Object.entries(e)) {
                        if (CONTEXT_ALLOWLIST.has(k)) ctx[k] = v;
                    }
                    return {
                        service: SERVICE,
                        event_type: e.status === "error" ? "error" : "action",
                        message: e.message,
                        context: ctx,
                        user_id: e.user_id,
                        user_plan: e.user_plan,
                    };
                })),
                signal: AbortSignal.timeout(5_000),
            });
        } catch {
            // Silent — don't crash the MCP server
        }
    }

    // Secondary: Datadog Logs (if API key is set AND Logs product is enabled)
    // Same allowlist applied — both sinks get identical filtered context.
    if (DD_API_KEY) {
        try {
            await fetch(`https://http-intake.logs.${DD_SITE}/api/v2/logs`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "DD-API-KEY": DD_API_KEY },
                body: JSON.stringify(batch.map(e => {
                    const ctx: Record<string, unknown> = {};
                    for (const [k, v] of Object.entries(e)) {
                        if (CONTEXT_ALLOWLIST.has(k)) ctx[k] = v;
                    }
                    return {
                        ddsource: "nodejs",
                        ddtags: e.ddtags,
                        hostname: e.hostname,
                        service: SERVICE,
                        status: e.status,
                        message: e.message,
                        ...ctx,
                        timestamp: e.timestamp,
                    };
                })),
                signal: AbortSignal.timeout(5_000),
            });
        } catch {
            // Silent
        }
    }

    if (queue.length > 0) scheduleFlush();
}

export function ddLog(
    level: "info" | "warn" | "error",
    message: string,
    context?: Record<string, unknown>,
) {
    queue.push({
        ddsource: "nodejs",
        ddtags: `env:${process.env.NODE_ENV || "development"},service:${SERVICE}`,
        hostname: process.env.HOSTNAME || "prism-mcp",
        service: SERVICE,
        status: level,
        message: message.slice(0, 200),
        ...context,
        timestamp: new Date().toISOString(),
    });

    scheduleFlush();
}

export function ddError(message: string, error?: Error, context?: Record<string, unknown>) {
    ddLog("error", message, {
        ...context,
        error: error ? {
            message: error.message,
            stack: error.stack?.split("\n").slice(0, 5).join("\n"),
            name: error.name,
        } : undefined,
    });
}

export function ddInfo(message: string, context?: Record<string, unknown>) {
    ddLog("info", message, context);
}

export function ddWarn(message: string, context?: Record<string, unknown>) {
    ddLog("warn", message, context);
}

if (!TELEMETRY_WRITE_TOKEN && process.env.PRISM_DEBUG_LOGGING) {
    console.info("[prism-mcp] Portal telemetry not configured (no TELEMETRY_WRITE_TOKEN). Session metrics work locally — this is normal for offline/free-tier use.");
}
