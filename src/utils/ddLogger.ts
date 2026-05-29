/**
 * Datadog Server-Side Logger
 *
 * Sends structured logs to Datadog HTTP Logs API.
 * No agent needed — direct HTTPS POST to intake.
 *
 * Env: DD_API_KEY, DD_SITE (default datadoghq.com)
 */

const DD_API_KEY = process.env.DD_API_KEY || "";
const DD_SITE = process.env.DD_SITE || "datadoghq.com";
const SERVICE = "prism-mcp";
const INTAKE_URL = `https://http-intake.logs.${DD_SITE}/api/v2/logs`;

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
    if (queue.length === 0 || !DD_API_KEY) return;

    const batch = queue.splice(0, MAX_BATCH);
    try {
        await fetch(INTAKE_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "DD-API-KEY": DD_API_KEY,
            },
            body: JSON.stringify(batch),
            signal: AbortSignal.timeout(5_000),
        });
    } catch {
        // Silent — don't crash the app if DD is unreachable
    }

    if (queue.length > 0) scheduleFlush();
}

export function ddLog(
    level: "info" | "warn" | "error",
    message: string,
    context?: Record<string, unknown>,
) {
    if (!DD_API_KEY) return;

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
