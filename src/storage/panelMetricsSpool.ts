/**
 * Crash-safe ingestion for Synalux VS Code panel inference metrics.
 *
 * The extension and MCP server are separate processes, so the extension writes
 * bounded JSONL records instead of opening Prism's SQLite database. The MCP
 * process atomically claims the live spool, validates every field, and deletes
 * a claim only after the ledger transaction succeeds. Stable event IDs make a
 * replay after a crash idempotent.
 */

import { randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { appendInferMetricBatch, type InferMetricRow } from "./inferMetricsLedger.js";
import { debugLog } from "../utils/logger.js";

const PANEL_METRICS_FILE = "panel-metrics.jsonl";
const PANEL_METRICS_DIRECTORY = ".prism-mcp";
const PANEL_METRICS_PATH_ENV = "PRISM_PANEL_METRICS_PATH";
const LOCK_SUFFIX = ".lock";
const LOCK_STALE_MS = 30_000;
const PROCESSING_STALE_MS = 5 * 60_000;
const LOCK_RETRY_DELAYS_MS = [5, 10, 20, 40, 80, 160] as const;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const EVENT_VERSION = 1;
const MAX_CLAIMS_PER_INGEST = 32;
const MAX_LINE_BYTES = 4 * 1024;
const BATCH_SIZE = 250;
const MAX_MODEL_LENGTH = 256;
const MAX_METRIC_VALUE = 100_000_000;
const MAX_LATENCY_MS = 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PANEL_EVENTS = new Set(["panel_served_local", "panel_escalated"]);
const PANEL_BACKENDS = new Set(["prism", "local", "cloud", "gemini"]);
const PANEL_MODES = new Set(["chat", "code"]);
const LOCAL_BACKENDS = new Set(["prism", "local"]);
const CLOUD_BACKENDS = new Set(["cloud", "gemini"]);
const EVENT_KEYS = new Set([
    "v", "event_id", "ts", "event", "backend", "model", "used_cloud",
    "mode", "prompt_tokens", "completion_tokens", "latency_ms",
]);

interface LockHandle {
    path: string;
    token: string;
    handle: fs.FileHandle;
}

interface ParsedPanelMetric {
    v: number;
    event_id: string;
    ts: number;
    event: string;
    backend: string;
    model: string | null;
    used_cloud: boolean;
    mode: string;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    latency_ms: number;
}

export interface PanelMetricsIngestResult {
    claimed_files: number;
    seen: number;
    valid: number;
    inserted: number;
    duplicates: number;
    invalid: number;
    failed_files: number;
}

const EMPTY_RESULT: Readonly<PanelMetricsIngestResult> = {
    claimed_files: 0,
    seen: 0,
    valid: 0,
    inserted: 0,
    duplicates: 0,
    invalid: 0,
    failed_files: 0,
};

export function getPanelMetricsSpoolPath(): string {
    const override = process.env[PANEL_METRICS_PATH_ENV]?.trim();
    if (override) return override;
    if (process.env.PRISM_DATA_DIR) return resolve(process.env.PRISM_DATA_DIR, PANEL_METRICS_FILE);
    return resolve(homedir(), PANEL_METRICS_DIRECTORY, PANEL_METRICS_FILE);
}

/** Claim and ingest all currently available panel metric files. Never throws. */
export async function ingestPanelMetrics(): Promise<PanelMetricsIngestResult> {
    const result = { ...EMPTY_RESULT };
    let claims: string[];
    try {
        claims = await claimAvailableFiles(getPanelMetricsSpoolPath());
    } catch (error) {
        result.failed_files++;
        debugLog(`[panel-metrics] claim failed: ${error instanceof Error ? error.message : error}`);
        return result;
    }
    result.claimed_files = claims.length;

    for (const claim of claims) {
        try {
            const fileResult = await ingestClaim(claim);
            result.seen += fileResult.seen;
            result.valid += fileResult.valid;
            result.inserted += fileResult.inserted;
            result.duplicates += fileResult.duplicates;
            result.invalid += fileResult.invalid;
            await fs.unlink(claim);
        } catch (error) {
            result.failed_files++;
            debugLog(`[panel-metrics] ingest failed: ${error instanceof Error ? error.message : error}`);
            await returnClaimForRetry(claim).catch(() => undefined);
        }
    }
    return result;
}

async function ingestClaim(path: string): Promise<PanelMetricsIngestResult> {
    const result = { ...EMPTY_RESULT, claimed_files: 1 };
    const input = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let batch: InferMetricRow[] = [];

    const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        const batchResult = await appendInferMetricBatch(batch);
        result.inserted += batchResult.inserted;
        result.duplicates += batchResult.duplicates;
        batch = [];
    };

    for await (const line of lines) {
        if (!line.trim()) continue;
        result.seen++;
        if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
            result.invalid++;
            continue;
        }
        const event = parsePanelMetric(line);
        if (!event) {
            result.invalid++;
            continue;
        }
        result.valid++;
        batch.push(toLedgerRow(event));
        if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();
    return result;
}

function parsePanelMetric(line: string): ParsedPanelMetric | null {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        return null;
    }
    if (!isRecord(value) || Object.keys(value).some(key => !EVENT_KEYS.has(key))) return null;
    if (value.v !== EVENT_VERSION) return null;
    if (typeof value.event_id !== "string" || !UUID_PATTERN.test(value.event_id)) return null;
    if (!isIntegerInRange(value.ts, 1, Date.now() + MAX_FUTURE_SKEW_MS)) return null;
    if (typeof value.event !== "string" || !PANEL_EVENTS.has(value.event)) return null;
    if (typeof value.backend !== "string" || !PANEL_BACKENDS.has(value.backend)) return null;
    if (typeof value.used_cloud !== "boolean") return null;
    if (typeof value.mode !== "string" || !PANEL_MODES.has(value.mode)) return null;
    if (!isNullableMetric(value.prompt_tokens) || !isNullableMetric(value.completion_tokens)) return null;
    if (!isIntegerInRange(value.latency_ms, 0, MAX_LATENCY_MS)) return null;
    if (value.model !== null && (
        typeof value.model !== "string" ||
        value.model.length === 0 ||
        value.model.length > MAX_MODEL_LENGTH ||
        CONTROL_CHARACTER_PATTERN.test(value.model)
    )) return null;

    const isEscalated = value.event === "panel_escalated";
    if (value.used_cloud !== isEscalated) return null;
    if (isEscalated ? !CLOUD_BACKENDS.has(value.backend) : !LOCAL_BACKENDS.has(value.backend)) return null;
    return value as unknown as ParsedPanelMetric;
}

function toLedgerRow(event: ParsedPanelMetric): InferMetricRow {
    return {
        ts: event.ts,
        caller: "panel",
        mode: event.mode,
        backend: event.backend,
        model: event.model,
        used_cloud: event.used_cloud,
        gate_outcome: "success",
        prompt_tokens: event.prompt_tokens ?? undefined,
        completion_tokens: event.completion_tokens ?? undefined,
        latency_ms: event.latency_ms,
        source_event_id: event.event_id,
    };
}

async function claimAvailableFiles(spoolPath: string): Promise<string[]> {
    const directory = dirname(spoolPath);
    await fs.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    const lock = await acquireLock(`${spoolPath}${LOCK_SUFFIX}`);
    if (!lock) throw new Error("panel metrics spool is busy");
    try {
        const claims: string[] = [];
        const base = basename(spoolPath);
        const pendingPrefix = `${base}.pending-`;
        const processingPrefix = `${base}.processing-`;
        const names = await fs.readdir(directory).catch(error => {
            if (hasErrorCode(error, "ENOENT")) return [];
            throw error;
        });

        for (const name of names) {
            if (claims.length >= MAX_CLAIMS_PER_INGEST || !name.startsWith(pendingPrefix)) continue;
            const claimed = await claimExisting(join(directory, name), spoolPath);
            if (claimed) claims.push(claimed);
        }
        for (const name of names) {
            if (claims.length >= MAX_CLAIMS_PER_INGEST || !name.startsWith(processingPrefix)) continue;
            const source = join(directory, name);
            const stat = await fs.stat(source).catch(() => null);
            if (!stat || Date.now() - stat.mtimeMs <= PROCESSING_STALE_MS) continue;
            const claimed = await claimExisting(source, spoolPath);
            if (claimed) claims.push(claimed);
        }

        if (claims.length < MAX_CLAIMS_PER_INGEST) {
            const liveStat = await fs.stat(spoolPath).catch(error => {
                if (hasErrorCode(error, "ENOENT")) return null;
                throw error;
            });
            if (liveStat?.isFile() && liveStat.size > 0) {
                const claim = processingPath(spoolPath);
                await fs.rename(spoolPath, claim);
                claims.push(claim);
            }
        }
        return claims;
    } finally {
        await releaseLock(lock);
    }
}

async function claimExisting(source: string, spoolPath: string): Promise<string | null> {
    const target = processingPath(spoolPath);
    try {
        await fs.rename(source, target);
        return target;
    } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return null;
        throw error;
    }
}

async function returnClaimForRetry(claim: string): Promise<void> {
    const spoolPath = getPanelMetricsSpoolPath();
    const lock = await acquireLock(`${spoolPath}${LOCK_SUFFIX}`);
    if (!lock) return;
    try {
        const pending = `${spoolPath}.pending-${Date.now()}-${randomUUID()}`;
        await fs.rename(claim, pending).catch(error => {
            if (!hasErrorCode(error, "ENOENT")) throw error;
        });
    } finally {
        await releaseLock(lock);
    }
}

function processingPath(spoolPath: string): string {
    return `${spoolPath}.processing-${process.pid}-${Date.now()}-${randomUUID()}`;
}

async function acquireLock(lockPath: string): Promise<LockHandle | null> {
    for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt++) {
        const token = `${process.pid}:${randomUUID()}`;
        try {
            const handle = await fs.open(lockPath, "wx", FILE_MODE);
            await handle.writeFile(token, "utf8");
            return { path: lockPath, token, handle };
        } catch (error) {
            if (!hasErrorCode(error, "EEXIST")) return null;
            await removeStaleLock(lockPath);
            const delay = LOCK_RETRY_DELAYS_MS[attempt];
            if (delay === undefined) return null;
            await wait(delay);
        }
    }
    return null;
}

async function removeStaleLock(lockPath: string): Promise<void> {
    try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            await fs.unlink(lockPath).catch(() => undefined);
        }
    } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
    }
}

async function releaseLock(lock: LockHandle): Promise<void> {
    await lock.handle.close().catch(() => undefined);
    try {
        const owner = await fs.readFile(lock.path, "utf8");
        if (owner === lock.token) await fs.unlink(lock.path);
    } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableMetric(value: unknown): boolean {
    return value === null || isIntegerInRange(value, 0, MAX_METRIC_VALUE);
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function hasErrorCode(error: unknown, code: string): boolean {
    return typeof error === "object" && error !== null && "code" in error &&
        (error as NodeJS.ErrnoException).code === code;
}

function wait(ms: number): Promise<void> {
    return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}
