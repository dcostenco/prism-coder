/**
 * API Usage Analytics — Per-Project Call Tracking
 *
 * Tracks every MCP tool invocation with timing, token estimates,
 * and project association. Uses @libsql/client (same as the rest
 * of prism's local storage layer).
 *
 * Storage: `api_analytics` table in ~/.prism-mcp/data.db
 */

import { debugLog } from "./logger.js";
import { createClient, type Client } from "@libsql/client";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// ─── Types ───────────────────────────────────────────────────

export interface ToolInvocation {
    id: string;
    tool: string;
    project: string;
    timestamp: string;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    success: boolean;
    errorMessage?: string;
}

export interface ProjectAnalytics {
    project: string;
    totalCalls: number;
    successRate: number;
    avgDurationMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    topTools: Array<{ tool: string; count: number }>;
    callsByDay: Array<{ date: string; count: number }>;
    periodStart: string;
    periodEnd: string;
}

export interface SystemAnalytics {
    totalProjects: number;
    totalCalls: number;
    globalSuccessRate: number;
    avgDurationMs: number;
    topProjects: Array<{ project: string; calls: number }>;
    topTools: Array<{ tool: string; calls: number }>;
    callsByHour: Array<{ hour: number; count: number }>;
}

// ─── DB Connection ──────────────────────────────────────────

let _db: Client | null = null;
let _tableReady = false;

function getDbPath(): string {
    return process.env.PRISM_ANALYTICS_DB_PATH
        || join(homedir(), ".prism-mcp", "data.db");
}

function getDb(): Client {
    if (_db) return _db;
    const dbPath = getDbPath();
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    _db = createClient({ url: `file:${dbPath}` });
    return _db;
}

async function ensureTable(): Promise<void> {
    if (_tableReady) return;
    await getDb().execute("PRAGMA journal_mode=WAL");
    await getDb().execute(`
        CREATE TABLE IF NOT EXISTS api_analytics (
            id TEXT PRIMARY KEY,
            tool TEXT NOT NULL,
            project TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            duration_ms INTEGER NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            success INTEGER NOT NULL,
            error_message TEXT
        )
    `);
    _tableReady = true;
}

/** Reset DB connection and in-memory buffer (for tests). */
export function _resetDb(): void {
    _db = null;
    _tableReady = false;
    BUFFER.length = 0;
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
}

// ─── In-Memory Buffer ────────────────────────────────────────

const BUFFER: ToolInvocation[] = [];
const FLUSH_THRESHOLD = 25;
const FLUSH_INTERVAL_MS = 30_000;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

// ─── Recording ───────────────────────────────────────────────

export function recordInvocation(
    tool: string,
    project: string,
    args: unknown,
    response: string,
    durationMs: number,
    success: boolean,
    errorMessage?: string,
): void {
    // Called before the tool response return in both success and error paths
    // of server dispatch — a throw here would swallow the tool result. Isolate.
    try {
        const invocation: ToolInvocation = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            tool,
            project: project || "unknown",
            timestamp: new Date().toISOString(),
            durationMs,
            inputTokens: estimateTokens(JSON.stringify(args || {})),
            outputTokens: estimateTokens(response || ""),
            success,
            errorMessage,
        };

        BUFFER.push(invocation);

        if (BUFFER.length >= FLUSH_THRESHOLD) {
            void flushBuffer();
        }

        if (!flushTimer) {
            flushTimer = setTimeout(() => {
                flushTimer = null;
                void flushBuffer();
            }, FLUSH_INTERVAL_MS);
            if (typeof flushTimer === "object" && "unref" in flushTimer) {
                (flushTimer as NodeJS.Timeout).unref();
            }
        }
    } catch (err) {
        debugLog(`Analytics recordInvocation skipped: ${err}`);
    }
}

export async function flushBuffer(): Promise<number> {
    if (BUFFER.length === 0) return 0;

    const batch = BUFFER.splice(0, BUFFER.length);

    try {
        await ensureTable();
        const db = getDb();

        for (const inv of batch) {
            await db.execute({
                sql: `INSERT OR IGNORE INTO api_analytics
                      (id, tool, project, timestamp, duration_ms, input_tokens, output_tokens, success, error_message)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: [
                    inv.id, inv.tool, inv.project, inv.timestamp,
                    inv.durationMs, inv.inputTokens, inv.outputTokens,
                    inv.success ? 1 : 0, inv.errorMessage || null,
                ],
            });
        }

        debugLog(`Analytics: flushed ${batch.length} invocations`);
        return batch.length;
    } catch (err) {
        BUFFER.unshift(...batch);
        if (BUFFER.length > 1000) BUFFER.splice(1000);
        debugLog(`Analytics flush failed: ${err}`);
        return 0;
    }
}

// ─── Query Functions ─────────────────────────────────────────

export async function getProjectAnalytics(
    project: string,
    days: number = 30,
): Promise<ProjectAnalytics> {
    await flushBuffer();

    try {
        await ensureTable();
        const db = getDb();
        const since = new Date(Date.now() - days * 86_400_000).toISOString();

        const stats = await db.execute({
            sql: `SELECT
                    COUNT(*) as total_calls,
                    AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) as success_rate,
                    AVG(duration_ms) as avg_duration,
                    SUM(input_tokens) as total_input,
                    SUM(output_tokens) as total_output,
                    MIN(timestamp) as period_start,
                    MAX(timestamp) as period_end
                  FROM api_analytics
                  WHERE project = ? AND timestamp >= ?`,
            args: [project, since],
        });
        const s = stats.rows[0] as any;

        const topTools = await db.execute({
            sql: `SELECT tool, COUNT(*) as count
                  FROM api_analytics
                  WHERE project = ? AND timestamp >= ?
                  GROUP BY tool ORDER BY count DESC LIMIT 10`,
            args: [project, since],
        });

        const callsByDay = await db.execute({
            sql: `SELECT DATE(timestamp) as date, COUNT(*) as count
                  FROM api_analytics
                  WHERE project = ? AND timestamp >= ?
                  GROUP BY DATE(timestamp) ORDER BY date`,
            args: [project, since],
        });

        return {
            project,
            totalCalls: Number(s?.total_calls) || 0,
            successRate: Number(s?.success_rate) || 0,
            avgDurationMs: Math.round(Number(s?.avg_duration) || 0),
            totalInputTokens: Number(s?.total_input) || 0,
            totalOutputTokens: Number(s?.total_output) || 0,
            topTools: topTools.rows.map((r: any) => ({ tool: r.tool, count: Number(r.count) })),
            callsByDay: callsByDay.rows.map((r: any) => ({ date: r.date, count: Number(r.count) })),
            periodStart: s?.period_start || since,
            periodEnd: s?.period_end || new Date().toISOString(),
        };
    } catch (err) {
        debugLog(`Analytics query failed: ${err}`);
        return {
            project,
            totalCalls: 0, successRate: 0, avgDurationMs: 0,
            totalInputTokens: 0, totalOutputTokens: 0,
            topTools: [], callsByDay: [],
            periodStart: "", periodEnd: "",
        };
    }
}

export async function getSystemAnalytics(days: number = 30): Promise<SystemAnalytics> {
    await flushBuffer();

    try {
        await ensureTable();
        const db = getDb();
        const since = new Date(Date.now() - days * 86_400_000).toISOString();

        const stats = await db.execute({
            sql: `SELECT COUNT(*) as total, COUNT(DISTINCT project) as projects,
                         AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) as success_rate,
                         AVG(duration_ms) as avg_duration
                  FROM api_analytics WHERE timestamp >= ?`,
            args: [since],
        });
        const s = stats.rows[0] as any;

        const topProjects = await db.execute({
            sql: `SELECT project, COUNT(*) as calls FROM api_analytics
                  WHERE timestamp >= ? GROUP BY project ORDER BY calls DESC LIMIT 10`,
            args: [since],
        });

        const topTools = await db.execute({
            sql: `SELECT tool, COUNT(*) as calls FROM api_analytics
                  WHERE timestamp >= ? GROUP BY tool ORDER BY calls DESC LIMIT 10`,
            args: [since],
        });

        return {
            totalProjects: Number(s?.projects) || 0,
            totalCalls: Number(s?.total) || 0,
            globalSuccessRate: Number(s?.success_rate) || 0,
            avgDurationMs: Math.round(Number(s?.avg_duration) || 0),
            topProjects: topProjects.rows.map((r: any) => ({ project: r.project, calls: Number(r.calls) })),
            topTools: topTools.rows.map((r: any) => ({ tool: r.tool, calls: Number(r.calls) })),
            callsByHour: [],
        };
    } catch {
        return {
            totalProjects: 0, totalCalls: 0, globalSuccessRate: 0, avgDurationMs: 0,
            topProjects: [], topTools: [], callsByHour: [],
        };
    }
}

debugLog("API analytics module loaded (@libsql/client)");
