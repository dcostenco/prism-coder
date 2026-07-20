/**
 * Persistent inference-metrics ledger — append-only rows in the same
 * ~/.prism-mcp/prism-config.db used by configStorage.
 *
 * Purpose: the in-memory counters in utils/inferenceMetrics.ts reset with
 * every MCP server process, which made "how much do we actually delegate?"
 * unanswerable. This ledger is the durable record that delegation goal
 * metrics (local vs cloud volume over time) are computed from.
 *
 * Contract:
 *   - appendInferMetric() is fire-and-forget: it must NEVER throw or delay
 *     the inference hot path. Failures are debug-logged and dropped.
 *   - safety_gate calls are excluded by the caller (recordInference returns
 *     before reaching us) — crisis-filter triggers are never persisted.
 *   - gate_outcome / refusal_reason / caller are nullable now and filled by
 *     the Phase-1 failure contract without a schema migration.
 */

import { createClient } from "@libsql/client";
import { resolve, dirname } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";
import { debugLog } from "../utils/logger.js";

// Resolution order:
//   1. PRISM_INFER_LEDGER_DB_PATH — explicit override (tests, relocation)
//   2. PRISM_DATA_DIR — the test-suite sandbox (tests/setup.ts) and any
//      operator-relocated data root; REQUIRED so `npm test` never writes
//      fabricated rows into the real user ledger
//   3. default ~/.prism-mcp/prism-config.db (shared with configStorage)
function dbPath(): string {
    if (process.env.PRISM_INFER_LEDGER_DB_PATH) return process.env.PRISM_INFER_LEDGER_DB_PATH;
    if (process.env.PRISM_DATA_DIR) return resolve(process.env.PRISM_DATA_DIR, "prism-config.db");
    return resolve(homedir(), ".prism-mcp", "prism-config.db");
}

export interface InferMetricRow {
    backend: string;
    model: string | null;
    used_cloud: boolean;
    mode?: string;
    caller?: string;            // 'mcp' | 'panel' | ... (Phase 2)
    gate_outcome?: string;      // Phase 1 failure contract
    refusal_reason?: string;    // Phase 1 failure contract
    prompt_tokens?: number;
    completion_tokens?: number;
    latency_ms?: number;
    ram_free_mb?: number;
}

let client: ReturnType<typeof createClient> | null = null;
let ensured: Promise<void> | null = null;
let disabled = false;
let initFailures = 0;
const MAX_INIT_FAILURES = 3;

function closeClient(context: string): void {
    const activeClient = client;
    client = null;
    if (!activeClient) return;
    try {
        activeClient.close();
    } catch (e) {
        debugLog(`[infer-ledger] ${context} close failed: ${e instanceof Error ? e.message : e}`);
    }
}

function ensureTable(): Promise<void> {
    if (!ensured) {
        ensured = (async () => {
            const path = dbPath();
            const dir = dirname(path);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            client = createClient({ url: `file:${path}` });
            // Shared file with configStorage — wait out short write locks
            // instead of failing (transient SQLITE_BUSY must not kill the
            // ledger). Best-effort: an unsupported PRAGMA must not disable us.
            await client.execute(`PRAGMA busy_timeout = 2000`).catch(() => {});
            await client.execute(`
                CREATE TABLE IF NOT EXISTS infer_metrics (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts INTEGER NOT NULL,
                    caller TEXT,
                    mode TEXT,
                    backend TEXT NOT NULL,
                    model TEXT,
                    used_cloud INTEGER NOT NULL,
                    gate_outcome TEXT,
                    refusal_reason TEXT,
                    prompt_tokens INTEGER,
                    completion_tokens INTEGER,
                    latency_ms INTEGER,
                    ram_free_mb INTEGER
                )`);
            await client.execute(
                `CREATE INDEX IF NOT EXISTS idx_infer_metrics_ts ON infer_metrics (ts)`);
        })().catch((e) => {
            // Transient failures (missing dir on first run, SQLITE_BUSY) retry on
            // the next append; only repeated failure disables for the process.
            initFailures++;
            ensured = null;
            closeClient("init failure");
            if (initFailures >= MAX_INIT_FAILURES) disabled = true;
            debugLog(`[infer-ledger] init failed (${initFailures}/${MAX_INIT_FAILURES}${disabled ? ", ledger disabled" : ", will retry"}): ${e instanceof Error ? e.message : e}`);
        });
    }
    return ensured;
}

/** Append one row. Fire-and-forget — never throws, never blocks the caller. */
export function appendInferMetric(row: InferMetricRow): void {
    if (disabled) return;
    void (async () => {
        await ensureTable();
        if (disabled || !client) return;
        await client.execute({
            sql: `INSERT INTO infer_metrics
                  (ts, caller, mode, backend, model, used_cloud, gate_outcome,
                   refusal_reason, prompt_tokens, completion_tokens, latency_ms, ram_free_mb)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                Date.now(), row.caller ?? "mcp", row.mode ?? null, row.backend,
                row.model, row.used_cloud ? 1 : 0, row.gate_outcome ?? null,
                row.refusal_reason ?? null, row.prompt_tokens ?? null,
                row.completion_tokens ?? null, row.latency_ms ?? null,
                row.ram_free_mb ?? null,
            ],
        });
    })().catch((e) => {
        debugLog(`[infer-ledger] append failed: ${e instanceof Error ? e.message : e}`);
    });
}

export interface InferMetricsAggregate {
    total: number;
    local: number;
    cloud: number;
    prompt_tokens: number;
    completion_tokens: number;
    avg_latency_ms: number;
    first_ts: number | null;
    last_ts: number | null;
    by_backend: Record<string, number>;
}

/** Aggregate all persisted rows (optionally since a timestamp). */
export async function queryInferMetrics(sinceTs?: number): Promise<InferMetricsAggregate | null> {
    try {
        await ensureTable();
        if (disabled || !client) return null;
        const where = sinceTs != null ? `WHERE ts >= ?` : "";
        const whereArgs = sinceTs != null ? [Math.floor(sinceTs)] : [];
        const agg = await client.execute({
            sql: `
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN used_cloud = 0 THEN 1 ELSE 0 END) AS local,
                   SUM(CASE WHEN used_cloud = 1 THEN 1 ELSE 0 END) AS cloud,
                   COALESCE(SUM(prompt_tokens), 0) AS pt,
                   COALESCE(SUM(completion_tokens), 0) AS ct,
                   COALESCE(AVG(latency_ms), 0) AS avg_lat,
                   MIN(ts) AS first_ts, MAX(ts) AS last_ts
            FROM infer_metrics ${where}`, args: whereArgs });
        const byB = await client.execute({
            sql: `SELECT backend, COUNT(*) AS n FROM infer_metrics ${where} GROUP BY backend`,
            args: whereArgs });
        const r = agg.rows[0] as Record<string, unknown>;
        const by_backend: Record<string, number> = {};
        for (const row of byB.rows as Array<Record<string, unknown>>) {
            by_backend[String(row.backend)] = Number(row.n);
        }
        return {
            total: Number(r.total ?? 0),
            local: Number(r.local ?? 0),
            cloud: Number(r.cloud ?? 0),
            prompt_tokens: Number(r.pt ?? 0),
            completion_tokens: Number(r.ct ?? 0),
            avg_latency_ms: Math.round(Number(r.avg_lat ?? 0)),
            first_ts: r.first_ts == null ? null : Number(r.first_ts),
            last_ts: r.last_ts == null ? null : Number(r.last_ts),
            by_backend,
        };
    } catch (e) {
        debugLog(`[infer-ledger] query failed: ${e instanceof Error ? e.message : e}`);
        return null;
    }
}

/** Test hook — reset module state so a fresh DB path/env can be exercised. */
export function _resetInferLedgerForTest(): void {
    // Close the logical client instead of only dropping its reference.
    // libsql 0.5.29 can still retain native prepared-statement handles until
    // V8 GC (libsql-js#228), so this is not a synchronous file-unlock barrier.
    closeClient("test reset");
    ensured = null;
    disabled = false;
    initFailures = 0;
}
