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
    ts?: number;
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
    /** Stable ID supplied by external spools. Null for native MCP rows. */
    source_event_id?: string;
    /** Prior turns sent with this call. 0 for a single-turn call. Without it,
     *  "how often does a host actually pass history" needs a transcript scan
     *  (2026-09-16: it did, and the answer was once). */
    history_turns?: number;
    /** Which screen layer produced the verdict that decided this call:
     *  'rules' | 'isolated' | 'prompt' | 'context' | 'budget' | 'backstop'. Names the layer
     *  to fix when benign work is refused. */
    refusal_layer?: string;
}

let client: ReturnType<typeof createClient> | null = null;
let ensured: Promise<void> | null = null;
let disabled = false;
let initFailures = 0;
const MAX_INIT_FAILURES = 3;
const LEDGER_UNAVAILABLE_ERROR = "Inference metrics ledger is unavailable";
const INSERT_METRIC_SQL = `INSERT OR IGNORE INTO infer_metrics
    (ts, caller, mode, backend, model, used_cloud, gate_outcome,
     refusal_reason, prompt_tokens, completion_tokens, latency_ms, ram_free_mb,
     source_event_id, history_turns, refusal_layer)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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
                    ram_free_mb INTEGER,
                    source_event_id TEXT,
                    history_turns INTEGER,
                    refusal_layer TEXT
                )`);
            // Existing ledgers predate external panel-spool ingestion. SQLite has
            // no ADD COLUMN IF NOT EXISTS, so use the repository's established
            // idempotent migration pattern and reject only unexpected failures.
            for (const column of [
                "source_event_id TEXT",
                "history_turns INTEGER",
                "refusal_layer TEXT",
            ]) {
                try {
                    await client.execute(`ALTER TABLE infer_metrics ADD COLUMN ${column}`);
                } catch (e) {
                    if (!(e instanceof Error) || !e.message.includes("duplicate column name")) throw e;
                }
            }
            await client.execute(
                `CREATE INDEX IF NOT EXISTS idx_infer_metrics_ts ON infer_metrics (ts)`);
            await client.execute(
                `CREATE UNIQUE INDEX IF NOT EXISTS idx_infer_metrics_source_event
                 ON infer_metrics (source_event_id) WHERE source_event_id IS NOT NULL`);
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
        await client.execute({ sql: INSERT_METRIC_SQL, args: metricArgs(row) });
    })().catch((e) => {
        debugLog(`[infer-ledger] append failed: ${e instanceof Error ? e.message : e}`);
    });
}

export interface InferMetricBatchResult {
    inserted: number;
    duplicates: number;
}

/**
 * Transactionally append externally-spooled rows and report deduplication.
 * Unlike appendInferMetric(), this is awaited so the spool owner knows when it
 * is safe to delete a claimed file.
 */
export async function appendInferMetricBatch(rows: InferMetricRow[]): Promise<InferMetricBatchResult> {
    if (rows.length === 0) return { inserted: 0, duplicates: 0 };
    await ensureTable();
    if (disabled || !client) throw new Error(LEDGER_UNAVAILABLE_ERROR);

    const results = await client.batch(
        rows.map(row => ({ sql: INSERT_METRIC_SQL, args: metricArgs(row) })),
        "write",
    );
    const inserted = results.reduce((total, result) => total + result.rowsAffected, 0);
    return { inserted, duplicates: rows.length - inserted };
}

function metricArgs(row: InferMetricRow): Array<string | number | null> {
    const timestamp = Number.isFinite(row.ts) && (row.ts ?? 0) > 0
        ? Math.floor(row.ts as number)
        : Date.now();
    return [
        timestamp, row.caller ?? "mcp", row.mode ?? null, row.backend,
        row.model, row.used_cloud ? 1 : 0, row.gate_outcome ?? null,
        row.refusal_reason ?? null, row.prompt_tokens ?? null,
        row.completion_tokens ?? null, row.latency_ms ?? null,
        row.ram_free_mb ?? null, row.source_event_id ?? null,
        row.history_turns ?? null, row.refusal_layer ?? null,
    ];
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
    by_caller: Record<string, InferMetricsCallerAggregate>;
}

export interface InferMetricsCallerAggregate {
    total: number;
    local: number;
    cloud: number;
    prompt_tokens: number;
    completion_tokens: number;
    avg_latency_ms: number;
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
        const byC = await client.execute({
            sql: `SELECT COALESCE(caller, 'mcp') AS caller,
                         COUNT(*) AS total,
                         SUM(CASE WHEN used_cloud = 0 THEN 1 ELSE 0 END) AS local,
                         SUM(CASE WHEN used_cloud = 1 THEN 1 ELSE 0 END) AS cloud,
                         COALESCE(SUM(prompt_tokens), 0) AS pt,
                         COALESCE(SUM(completion_tokens), 0) AS ct,
                         COALESCE(AVG(latency_ms), 0) AS avg_lat
                  FROM infer_metrics ${where}
                  GROUP BY COALESCE(caller, 'mcp')`,
            args: whereArgs });
        const r = agg.rows[0] as Record<string, unknown>;
        const by_backend: Record<string, number> = {};
        for (const row of byB.rows as Array<Record<string, unknown>>) {
            by_backend[String(row.backend)] = Number(row.n);
        }
        const by_caller: Record<string, InferMetricsCallerAggregate> = {};
        for (const row of byC.rows as Array<Record<string, unknown>>) {
            by_caller[String(row.caller)] = {
                total: Number(row.total ?? 0),
                local: Number(row.local ?? 0),
                cloud: Number(row.cloud ?? 0),
                prompt_tokens: Number(row.pt ?? 0),
                completion_tokens: Number(row.ct ?? 0),
                avg_latency_ms: Math.round(Number(row.avg_lat ?? 0)),
            };
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
            by_caller,
        };
    } catch (e) {
        debugLog(`[infer-ledger] query failed: ${e instanceof Error ? e.message : e}`);
        return null;
    }
}

export interface LocalSavingsModelRow {
    calls: number;
    prompt_tokens: number;
    completion_tokens: number;
}

export interface LocalSavings {
    /** Calls actually SERVED by a local model — the only rows that saved anything. */
    local_calls: number;
    /** Calls that fell through to cloud. Context for the ratio, never savings. */
    cloud_calls: number;
    local_prompt_tokens: number;
    local_completion_tokens: number;
    local_total_tokens: number;
    /** Local rows carrying no token counts at all. They contribute ZERO to the
     *  totals above, so a high count here means the headline understates. */
    local_calls_without_tokens: number;
    /** Served-locally rows whose prompt_tokens is 0 — Ollama reports
     *  prompt_eval_count=0 on a KV-cache hit, so real submitted context went
     *  uncounted. Another source of understatement, tracked separately because
     *  its cause and fix differ from the row above. */
    local_calls_with_cached_prompt: number;
    /** Local calls whose prompt tokens are character-based ESTIMATES rather
     *  than measured counts. Always 0 for ledger views (they sum raw measured
     *  prompt_tokens); the SESSION view sets it, because there a KV-cache hit
     *  is estimated from prompt text instead of counted as 0 — which is why
     *  the same call can read far higher in 'session' than in 'month'/'all'.
     *  Nonzero ⇒ the headline is an estimate, not a floor, and the renderer
     *  must say so (adversarial review finding C1). */
    local_calls_with_estimated_prompt: number;
    /** Local serves that came from the VS Code panel playground (caller
     *  'panel') rather than agent delegation, with their token volume. They
     *  ARE local serving, but "kept off your cloud model" is a weaker claim
     *  for playground traffic, so the renderer discloses the share instead of
     *  folding it in silently (adversarial review finding O2). */
    panel_local_calls: number;
    panel_local_tokens: number;
    /** Refused/never-served rows excluded from every figure above. */
    excluded_refusals: number;
    first_ts: number | null;
    last_ts: number | null;
    by_model: Record<string, LocalSavingsModelRow>;
}

/**
 * Aggregate what local serving actually displaced, optionally since a timestamp.
 *
 * Distinct from queryInferMetrics(), which sums tokens across local AND cloud
 * rows — a total that answers "how much did prism process?" not "what did
 * local serving save?".
 *
 * Refusals are excluded. recordInference() writes a ledger row BEFORE its
 * `backend === "refused"` early return, so the ledger legitimately contains
 * rows where no model ran and nothing was served. Counting those as savings
 * would inflate the exact KPI the in-memory accumulators go out of their way
 * to protect (see the §5.2 note in utils/inferenceMetrics.ts).
 */
export async function queryLocalSavings(sinceTs?: number): Promise<LocalSavings | null> {
    try {
        await ensureTable();
        if (disabled || !client) return null;

        // Served locally = local row that is not a refusal. `gate_outcome`
        // 'refused' and backend 'refused' are written by different call sites
        // (handler vs refusal site), so both are checked.
        const SERVED_LOCAL = `used_cloud = 0 AND backend <> 'refused'
                              AND (gate_outcome IS NULL OR gate_outcome <> 'refused')`;
        const where = sinceTs != null ? `WHERE ts >= ?` : "";
        const whereArgs = sinceTs != null ? [Math.floor(sinceTs)] : [];

        const agg = await client.execute({
            sql: `
            SELECT
                SUM(CASE WHEN ${SERVED_LOCAL} THEN 1 ELSE 0 END) AS local_calls,
                SUM(CASE WHEN used_cloud = 1 THEN 1 ELSE 0 END) AS cloud_calls,
                COALESCE(SUM(CASE WHEN ${SERVED_LOCAL} THEN prompt_tokens END), 0) AS pt,
                COALESCE(SUM(CASE WHEN ${SERVED_LOCAL} THEN completion_tokens END), 0) AS ct,
                SUM(CASE WHEN ${SERVED_LOCAL}
                          AND prompt_tokens IS NULL AND completion_tokens IS NULL
                         THEN 1 ELSE 0 END) AS untokened,
                SUM(CASE WHEN ${SERVED_LOCAL} AND prompt_tokens = 0 THEN 1 ELSE 0 END) AS cached_prompt,
                SUM(CASE WHEN ${SERVED_LOCAL} AND COALESCE(caller, 'mcp') = 'panel' THEN 1 ELSE 0 END) AS panel_calls,
                COALESCE(SUM(CASE WHEN ${SERVED_LOCAL} AND COALESCE(caller, 'mcp') = 'panel'
                                  THEN COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0) END), 0) AS panel_tokens,
                SUM(CASE WHEN used_cloud = 0 AND NOT (${SERVED_LOCAL}) THEN 1 ELSE 0 END) AS refusals,
                MIN(CASE WHEN ${SERVED_LOCAL} THEN ts END) AS first_ts,
                MAX(CASE WHEN ${SERVED_LOCAL} THEN ts END) AS last_ts
            FROM infer_metrics ${where}`,
            args: whereArgs,
        });

        const byM = await client.execute({
            sql: `SELECT COALESCE(model, backend) AS model,
                         COUNT(*) AS calls,
                         COALESCE(SUM(prompt_tokens), 0) AS pt,
                         COALESCE(SUM(completion_tokens), 0) AS ct
                  FROM infer_metrics
                  ${where ? `${where} AND` : "WHERE"} ${SERVED_LOCAL}
                  GROUP BY COALESCE(model, backend)`,
            args: whereArgs,
        });

        const r = agg.rows[0] as Record<string, unknown>;
        const by_model: Record<string, LocalSavingsModelRow> = {};
        for (const row of byM.rows as Array<Record<string, unknown>>) {
            by_model[String(row.model)] = {
                calls: Number(row.calls ?? 0),
                prompt_tokens: Number(row.pt ?? 0),
                completion_tokens: Number(row.ct ?? 0),
            };
        }
        const pt = Number(r.pt ?? 0);
        const ct = Number(r.ct ?? 0);
        return {
            local_calls: Number(r.local_calls ?? 0),
            cloud_calls: Number(r.cloud_calls ?? 0),
            local_prompt_tokens: pt,
            local_completion_tokens: ct,
            local_total_tokens: pt + ct,
            local_calls_without_tokens: Number(r.untokened ?? 0),
            local_calls_with_cached_prompt: Number(r.cached_prompt ?? 0),
            local_calls_with_estimated_prompt: 0,
            panel_local_calls: Number(r.panel_calls ?? 0),
            panel_local_tokens: Number(r.panel_tokens ?? 0),
            excluded_refusals: Number(r.refusals ?? 0),
            first_ts: r.first_ts == null ? null : Number(r.first_ts),
            last_ts: r.last_ts == null ? null : Number(r.last_ts),
            by_model,
        };
    } catch (e) {
        debugLog(`[infer-ledger] savings query failed: ${e instanceof Error ? e.message : e}`);
        return null;
    }
}

export interface DailySavingsRow {
    /** UTC day, "YYYY-MM-DD". */
    day: string;
    local_calls: number;
    cloud_calls: number;
    local_prompt_tokens: number;
    local_completion_tokens: number;
}

/**
 * Per-UTC-day aggregates of the same SERVED_LOCAL quantity the savings meter
 * reports — the shape the paid savings-sync uploads.
 *
 * Absolute per-day values, not deltas: the uploader re-sends a trailing
 * window and the portal upserts on (user, device, day), so a lost or repeated
 * upload converges instead of double-counting. Same refusal exclusion as
 * queryLocalSavings — a synced figure must never be higher than the local one.
 */
export async function queryDailyLocalSavings(sinceTs: number): Promise<DailySavingsRow[] | null> {
    try {
        await ensureTable();
        if (disabled || !client) return null;
        const SERVED_LOCAL = `used_cloud = 0 AND backend <> 'refused'
                              AND (gate_outcome IS NULL OR gate_outcome <> 'refused')`;
        const res = await client.execute({
            sql: `
            SELECT date(ts / 1000, 'unixepoch') AS day,
                   SUM(CASE WHEN ${SERVED_LOCAL} THEN 1 ELSE 0 END) AS local_calls,
                   SUM(CASE WHEN used_cloud = 1 THEN 1 ELSE 0 END) AS cloud_calls,
                   COALESCE(SUM(CASE WHEN ${SERVED_LOCAL} THEN prompt_tokens END), 0) AS pt,
                   COALESCE(SUM(CASE WHEN ${SERVED_LOCAL} THEN completion_tokens END), 0) AS ct
            FROM infer_metrics
            WHERE ts >= ?
            GROUP BY date(ts / 1000, 'unixepoch')
            ORDER BY day`,
            args: [Math.floor(sinceTs)],
        });
        return (res.rows as Array<Record<string, unknown>>).map((r) => ({
            day: String(r.day),
            local_calls: Number(r.local_calls ?? 0),
            cloud_calls: Number(r.cloud_calls ?? 0),
            local_prompt_tokens: Number(r.pt ?? 0),
            local_completion_tokens: Number(r.ct ?? 0),
        }));
    } catch (e) {
        debugLog(`[infer-ledger] daily savings query failed: ${e instanceof Error ? e.message : e}`);
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
