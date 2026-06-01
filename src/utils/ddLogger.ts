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
const DD_API_KEY = process.env.DD_API_KEY || "";
const DD_SITE = process.env.DD_SITE || "datadoghq.com";
const SERVICE = "prism-mcp";

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
    try {
        await fetch(`${SYNALUX_BASE}/api/v1/telemetry`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(batch.map(e => ({
                service: SERVICE,
                event_type: e.status === "error" ? "error" : "action",
                message: e.message,
                context: { ...e, service: undefined, message: undefined },
                user_id: e.user_id,
                user_plan: e.user_plan,
            }))),
            signal: AbortSignal.timeout(5_000),
        });
    } catch {
        // Silent — don't crash the MCP server
    }

    // Secondary: Datadog Logs (if API key is set AND Logs product is enabled)
    if (DD_API_KEY) {
        try {
            await fetch(`https://http-intake.logs.${DD_SITE}/api/v2/logs`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "DD-API-KEY": DD_API_KEY },
                body: JSON.stringify(batch),
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
        message,
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
