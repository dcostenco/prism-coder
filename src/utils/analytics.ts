/**
 * v12.2: API Usage Analytics — Per-Project Call Tracking
 *
 * Tracks every MCP tool invocation with timing, token estimates,
 * and project association. Provides aggregate analytics for the
 * Mind Palace Dashboard.
 *
 * Storage: Local SQLite table `api_analytics` (auto-created).
 * Zero external dependencies — no cloud telemetry.
 */

import { debugLog } from "./logger.js";
import { homedir } from "node:os";
import { join } from "node:path";

// Lazy-init helper for SQLite (avoids import issues with storage layer)
function getAnalyticsDbPath(): string {
    return process.env.PRISM_DB_PATH || join(homedir(), ".prism", "prism.db");
}

// ─── Types ───────────────────────────────────────────────────

export interface ToolInvocation {
    id: string;
    tool: string;
    project: string;
    timestamp: string;
    durationMs: number;
    inputTokens: number; // estimated from args
    outputTokens: number; // estimated from response
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

// ─── In-Memory Buffer ────────────────────────────────────────
// Batch writes to SQLite every N invocations or M seconds.

const BUFFER: ToolInvocation[] = [];
const FLUSH_THRESHOLD = 25;
const FLUSH_INTERVAL_MS = 30_000;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Token Estimation ────────────────────────────────────────
// Rough heuristic: 1 token ≈ 4 characters

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

// ─── Recording ───────────────────────────────────────────────

/**
 * Record a tool invocation for analytics tracking.
 *
 * Call this from server.ts after each tool handler completes.
 * Uses a write buffer to avoid per-call SQLite overhead.
 */
export function recordInvocation(
    tool: string,
    project: string,
    args: unknown,
    response: string,
    durationMs: number,
    success: boolean,
    errorMessage?: string,
): void {
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
        flushBuffer();
    }

    // Ensure periodic flush
    if (!flushTimer) {
        flushTimer = setTimeout(() => {
            flushBuffer();
            flushTimer = null;
        }, FLUSH_INTERVAL_MS);
    }
}

/**
 * Flush buffered invocations to storage.
 */
export async function flushBuffer(): Promise<number> {
    if (BUFFER.length === 0) return 0;

    const batch = BUFFER.splice(0, BUFFER.length);

    try {
        // @ts-ignore — better-sqlite3 types not installed; runtime dep only
        const Database = (await import("better-sqlite3")).default;
        const db = new (Database as any)(getAnalyticsDbPath());

        // Ensure table exists
        db.exec(`
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

        const stmt = db.prepare(`
      INSERT OR IGNORE INTO api_analytics
      (id, tool, project, timestamp, duration_ms, input_tokens, output_tokens, success, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

        for (const inv of batch) {
            stmt.run(
                inv.id, inv.tool, inv.project, inv.timestamp,
                inv.durationMs, inv.inputTokens, inv.outputTokens,
                inv.success ? 1 : 0, inv.errorMessage || null,
            );
        }

        debugLog(`Analytics: flushed ${batch.length} invocations to SQLite`);
        return batch.length;
    } catch (err) {
        // Re-add to buffer on failure
        BUFFER.unshift(...batch);
        debugLog(`Analytics flush failed: ${err}`);
        return 0;
    }
}

// ─── Query Functions ─────────────────────────────────────────

/**
 * Get analytics for a specific project.
 */
export async function getProjectAnalytics(
    project: string,
    days: number = 30,
): Promise<ProjectAnalytics> {
    await flushBuffer(); // Ensure latest data is written

    try {
        // @ts-ignore — better-sqlite3 types not installed; runtime dep only
        const Database = (await import("better-sqlite3")).default;
        const db = new (Database as any)(getAnalyticsDbPath());

        const since = new Date(
            Date.now() - days * 24 * 60 * 60 * 1000
        ).toISOString();

        const stats = db.prepare(`
      SELECT
        COUNT(*) as total_calls,
        AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) as success_rate,
        AVG(duration_ms) as avg_duration,
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output,
        MIN(timestamp) as period_start,
        MAX(timestamp) as period_end
      FROM api_analytics
      WHERE project = ? AND timestamp >= ?
    `).get(project, since) as any;

        const topTools = db.prepare(`
      SELECT tool, COUNT(*) as count
      FROM api_analytics
      WHERE project = ? AND timestamp >= ?
      GROUP BY tool ORDER BY count DESC LIMIT 10
    `).all(project, since) as any[];

        const callsByDay = db.prepare(`
      SELECT DATE(timestamp) as date, COUNT(*) as count
      FROM api_analytics
      WHERE project = ? AND timestamp >= ?
      GROUP BY DATE(timestamp) ORDER BY date
    `).all(project, since) as any[];

        return {
            project,
            totalCalls: stats?.total_calls || 0,
            successRate: stats?.success_rate || 0,
            avgDurationMs: Math.round(stats?.avg_duration || 0),
            totalInputTokens: stats?.total_input || 0,
            totalOutputTokens: stats?.total_output || 0,
            topTools: topTools.map((r: any) => ({ tool: r.tool, count: r.count })),
            callsByDay: callsByDay.map((r: any) => ({ date: r.date, count: r.count })),
            periodStart: stats?.period_start || since,
            periodEnd: stats?.period_end || new Date().toISOString(),
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

/**
 * Get system-wide analytics across all projects.
 */
export async function getSystemAnalytics(days: number = 30): Promise<SystemAnalytics> {
    await flushBuffer();

    try {
        // @ts-ignore — better-sqlite3 types not installed; runtime dep only
        const Database = (await import("better-sqlite3")).default;
        const db = new (Database as any)(getAnalyticsDbPath());

        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        const stats = db.prepare(`
      SELECT COUNT(*) as total, COUNT(DISTINCT project) as projects,
             AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) as success_rate,
             AVG(duration_ms) as avg_duration
      FROM api_analytics WHERE timestamp >= ?
    `).get(since) as any;

        const topProjects = db.prepare(`
      SELECT project, COUNT(*) as calls FROM api_analytics
      WHERE timestamp >= ? GROUP BY project ORDER BY calls DESC LIMIT 10
    `).all(since) as any[];

        const topTools = db.prepare(`
      SELECT tool, COUNT(*) as calls FROM api_analytics
      WHERE timestamp >= ? GROUP BY tool ORDER BY calls DESC LIMIT 10
    `).all(since) as any[];

        return {
            totalProjects: stats?.projects || 0,
            totalCalls: stats?.total || 0,
            globalSuccessRate: stats?.success_rate || 0,
            avgDurationMs: Math.round(stats?.avg_duration || 0),
            topProjects: topProjects.map((r: any) => ({ project: r.project, calls: r.calls })),
            topTools: topTools.map((r: any) => ({ tool: r.tool, calls: r.calls })),
            callsByHour: [],
        };
    } catch {
        return {
            totalProjects: 0, totalCalls: 0, globalSuccessRate: 0, avgDurationMs: 0,
            topProjects: [], topTools: [], callsByHour: [],
        };
    }
}

debugLog("v12.2: API analytics module loaded");
