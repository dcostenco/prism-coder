/** Explicit, authenticated on-device oMLX transport and resource coordination.
 * Application safety/quality/entitlement policy remains in prismInferHandler. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, type BigIntStats } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { OwnedAcknowledgement, OwnedAction, OwnedProviderRequest } from "./omlxJobControl.js";
import type { ControlEndpoint } from "./omlxControl.js";
import { operationStatus } from "./omlxControl.js";

export const OMLX_LEASE_PORT = 19438;
export const OMLX_MIN_AVAILABLE_BYTES = 2 * 1024 ** 3;
const PROBE_TIMEOUT_MS = 3_000;
const WATCH_INTERVAL_MS = 1_000;
const MAX_INSPECTION_BYTES = 256 * 1024;
const MAX_ADVERTISED_MODELS = 1024;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const NATIVE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NATIVE_UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_NATIVE_BYTES = 4 * 1024 ** 2;
const MAX_NATIVE_EVENT_BYTES = 256 * 1024;
const MAX_NATIVE_INPUT_BYTES = 1024 * 1024;
const STATUS_COUNTS = ["models_loaded", "models_loading", "active_requests", "waiting_requests"] as const;
const MAX_DEVICE_MARKERS = 64;
const MAX_DEVICE_MARKER_BYTES = 4096;
const RECLAIM_POLL_MS = 100;
const RECLAIM_DRAIN_MS = 1500;
const MARKER_FIELDS = ["version", "provider_hash", "job_id", "operation_id", "provider_started", "active", "provider_request_id"] as const;
const DEVICE_MARKER_NAME = /^[a-f0-9]{64}\.json$/;
const DEVICE_PENDING_NAME = /^[a-f0-9]{64}\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pending$/;

export class OmlxError extends Error {
    constructor(public readonly reason: string) { super(reason); this.name = "OmlxError"; }
}
export interface OmlxTarget { readonly url: string; readonly model: string; readonly contextTokens: number }
const credentials = new WeakMap<OmlxTarget, string>();
type NativeBinding = { jobId: string; operationId: string };
const nativeIdProtocols = new WeakSet<OmlxTarget>();
const nativeIdBindings = new WeakMap<OmlxTarget, Map<string, NativeBinding>>();
const MAX_NATIVE_BINDINGS = 256;
/** Authentication is deliberately absent from every serializable target. */
export function createOmlxTarget(url: string, model: string, contextTokens: number, apiKey: string): OmlxTarget {
    const target = Object.freeze({ url: loopbackUrl(url), model, contextTokens });
    credentials.set(target, apiKey);
    return target;
}
/** Another model on the same authenticated server: same URL, context and credential. */
export function omlxModelTarget(target: OmlxTarget, model: string): OmlxTarget {
    const apiKey = credentials.get(target);
    if (apiKey === undefined) throw new OmlxError("omlx_auth_unavailable");
    return createOmlxTarget(target.url, model, target.contextTokens, apiKey);
}
export interface OmlxRequest {
    messages: readonly { role: string; content: string }[];
    maxTokens: number; temperature?: number; timeoutMs: number; think?: boolean;
    profile?: Record<string, unknown>;
    /** false: ask the provider not to keep this request's prompt cache (a
     *  classifier request is unique and never reused). */
    cacheStore?: boolean;
}
export type LocalGeneration = { ok: true; text: string; thinking?: string; doneReason?: string; promptTokens?: number; completionTokens?: number }
    | { ok: false; reason: string };
export interface OmlxRuntime {
    detect: (model?: string) => Promise<OmlxTarget>;
    acquire: (port?: number, options?: OmlxLeaseOptions) => Promise<() => Promise<void>>;
    /** Clear this provider's stale owned-job marker on proof, or refuse. */
    recover?: (target: OmlxTarget) => Promise<void>;
    /** Called only before generation while the inference/device lease is held. */
    reclaim?: (target: OmlxTarget, available: () => number, signal: AbortSignal, deadlineMs: number) => Promise<void>;
    listLoaded: () => Promise<Set<string>>;
    unload: (model: string) => Promise<void>;
    generate: (target: OmlxTarget, request: OmlxRequest, signal: AbortSignal) => Promise<LocalGeneration>;
}

export function inferenceJobStateDirectory(home = homedir()): string {
    return join(home, ".prism-mcp", "omlx-owned-jobs");
}
const stateStamp = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
type DeviceMarker = { version: number; provider_hash: string; job_id: string; operation_id: string | null;
    provider_started: boolean; active: boolean; provider_request_id?: string | null };
function readDeviceMarker(path: string, name: string): DeviceMarker {
    let fd: number | undefined;
    try {
        if (typeof process.getuid !== "function") throw new Error();
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.uid !== BigInt(process.getuid()) || (before.mode & 0o077n) !== 0n || before.size > BigInt(MAX_DEVICE_MARKER_BYTES)) throw new Error();
        const bytes = Buffer.alloc(MAX_DEVICE_MARKER_BYTES + 1), count = readSync(fd, bytes, 0, bytes.length, 0);
        if (count > MAX_DEVICE_MARKER_BYTES || count !== Number(before.size)) throw new Error();
        const marker = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)));
        const fields = marker?.version === 1 ? MARKER_FIELDS.filter(field => field !== "provider_request_id") : MARKER_FIELDS;
        if (!marker || Object.keys(marker).length !== fields.length || !fields.every(field => Object.hasOwn(marker, field))
            || ![1, 2].includes(marker.version) || marker.provider_hash !== name.slice(0, 64)
            || typeof marker.job_id !== "string" || !NATIVE_UUID_PATTERN.test(marker.job_id)
            || typeof marker.active !== "boolean" || typeof marker.provider_started !== "boolean"
            || (marker.provider_started ? typeof marker.operation_id !== "string" || !NATIVE_UUID_PATTERN.test(marker.operation_id) : marker.operation_id !== null)
            || (marker.version === 2 && (marker.provider_request_id !== null && (typeof marker.provider_request_id !== "string" || !NATIVE_ID_PATTERN.test(marker.provider_request_id))
                || !marker.provider_started && marker.provider_request_id !== null))) throw new Error();
        const after = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true });
        if (!current.isFile() || stateStamp(before) !== stateStamp(after) || stateStamp(after) !== stateStamp(current)) throw new Error();
        return marker;
    } finally { if (fd !== undefined) closeSync(fd); }
}
/** Read-only fail-closed gate. Only the owned controller can recover active
 * jobs using correlated backend proof; ordinary callers never clear a marker. */
export function checkInferenceDeviceQuarantine(directory = inferenceJobStateDirectory(), recoveryProviderId?: string): void {
    if (recoveryProviderId !== undefined) loopbackUrl(recoveryProviderId);
    // runOwnedJob keys its journal by the exact provider ID. Normalizing here
    // could exempt one journal while the controller looks up a different one.
    const recoveryHash = recoveryProviderId === undefined ? undefined : createHash("sha256").update(recoveryProviderId).digest("hex");
    let root: BigIntStats;
    try { root = lstatSync(directory, { bigint: true }); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new OmlxError("omlx_quarantine_state_unavailable");
    }
    try {
        if (!root.isDirectory() || typeof process.getuid !== "function" || root.uid !== BigInt(process.getuid()) || (root.mode & 0o077n) !== 0n) throw new Error();
        const names = readdirSync(directory);
        if (names.length > MAX_DEVICE_MARKERS || names.some(name => !DEVICE_MARKER_NAME.test(name) && !DEVICE_PENDING_NAME.test(name))) throw new Error();
        for (const name of names.filter(name => DEVICE_MARKER_NAME.test(name))) {
            const marker = readDeviceMarker(join(directory, name), name);
            if (marker.active && marker.provider_hash !== recoveryHash) throw new OmlxError("omlx_provider_quarantined");
        }
        if (stateStamp(root) !== stateStamp(lstatSync(directory, { bigint: true }))) throw new Error();
    } catch (error) {
        if (error instanceof OmlxError) throw error;
        throw new OmlxError("omlx_quarantine_state_unavailable");
    }
}

export interface OmlxLeaseOptions {
    /** Internal operator/test path, never an MCP task argument. */
    stateDirectory?: string;
    /** Internal runOwnedJob recovery only; acquiring is not dispatch authority. */
    recoveryProviderId?: string;
}

/** Atomic OS-owned exclusion across disposable MCP processes. No lock files,
 * stale-owner recovery, daemon control, or credentials on this listener. */
export async function acquireOmlxLease(port = OMLX_LEASE_PORT, options: OmlxLeaseOptions = {}): Promise<() => Promise<void>> {
    const server = createServer(socket => socket.destroy());
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
        });
    } catch (error) {
        throw new OmlxError((error as NodeJS.ErrnoException).code === "EADDRINUSE"
            ? "omlx_resource_busy" : "omlx_lease_unavailable");
    }
    server.removeAllListeners("error");
    server.on("error", () => {});
    server.unref();
    let released = false;
    const release = async () => {
        if (released) return;
        released = true;
        await new Promise<void>(resolve => server.close(() => resolve()));
    };
    try { checkInferenceDeviceQuarantine(options.stateDirectory, options.recoveryProviderId); }
    catch (error) { await release(); throw error; }
    return release;
}

let ordinaryLeaseForTest: (() => Promise<() => Promise<void>>) | undefined;
/** Unit tests inject resource ownership just as they inject model transport.
 * Explicit-port integration tests always use the real OS lease. */
export function _setOrdinaryLeaseForTest(acquire?: () => Promise<() => Promise<void>>): void {
    ordinaryLeaseForTest = acquire;
}
const ordinaryDeviceLeases = new Map<number, { users: number; acquired: Promise<() => Promise<void>> }>();
/** Ordinary calls share one lease within this process. Other MCP processes
 * fail closed while any local owner holds the device, including Flash. */
export async function withOllamaResourceLease<T>(action: () => Promise<T>, port?: number, stateDirectory?: string): Promise<T> {
    const checkQuarantine = () => {
        // Injected unit-test device ownership uses injected model transport.
        // Explicit state paths and all production leases retain the real gate.
        if (stateDirectory !== undefined || !ordinaryLeaseForTest) checkInferenceDeviceQuarantine(stateDirectory);
    };
    if (leaseContext.getStore() === true) { checkQuarantine(); return action(); }
    const leasePort = port ?? OMLX_LEASE_PORT;
    let lease = ordinaryDeviceLeases.get(leasePort);
    if (!lease) {
        lease = { users: 0, acquired: port === undefined && ordinaryLeaseForTest
            ? ordinaryLeaseForTest() : acquireOmlxLease(leasePort, { stateDirectory }) };
        ordinaryDeviceLeases.set(leasePort, lease);
    }
    lease.users++;
    try { await lease.acquired; checkQuarantine(); return await action(); }
    finally {
        if (--lease.users === 0) {
            ordinaryDeviceLeases.delete(leasePort);
            const release = await lease.acquired.catch(() => undefined);
            await release?.();
        }
    }
}

/** Readers (ordinary Ollama calls) remain concurrent; an explicit oMLX call
 * owns the device through classification, unloading, generation and checks. */
let exclusiveTail: Promise<void> = Promise.resolve();
const readers = new Set<Promise<void>>();
const leaseContext = new AsyncLocalStorage<boolean>();
export async function withInferenceResourceLease<T>(exclusive: boolean, action: () => Promise<T>, deadlineMs?: number): Promise<T> {
    if (leaseContext.getStore() !== undefined) return action();
    const preceding = exclusiveTail;
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    const precedingReaders = exclusive ? [...readers] : [];
    if (exclusive) exclusiveTail = preceding.then(() => done);
    else readers.add(done);
    try {
        const waiting = Promise.all([preceding, ...precedingReaders]);
        if (deadlineMs === undefined) await waiting;
        else {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([waiting, new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new OmlxError("omlx_task_deadline_exceeded")), Math.max(0, deadlineMs - Date.now()));
                })]);
            } finally { clearTimeout(timer); }
            if (Date.now() >= deadlineMs) throw new OmlxError("omlx_task_deadline_exceeded");
        }
        return await leaseContext.run(exclusive, action);
    } finally { readers.delete(done); release(); }
}

export function loopbackUrl(value: string, path = "/v1"): string {
    try {
        const url = new URL(value);
        if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash
            || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
            || ![path || "/", path + "/"].includes(url.pathname)) throw new Error();
        return url.href.replace(/\/$/, "");
    } catch { throw new OmlxError("omlx_local_endpoint_required"); }
}
async function localJson(path: string): Promise<Record<string, any>> {
    try {
        const value = JSON.parse(await readFile(path, "utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        return value;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw new OmlxError("omlx_config_unavailable");
    }
}
export interface OmlxConnectionOptions {
    home?: string; basePath?: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; deadlineMs?: number; signal?: AbortSignal;
}
export async function omlxConfigurationDirectory(options: OmlxConnectionOptions = {}): Promise<string> {
    if (options.basePath) return options.basePath;
    const home = options.home ?? homedir();
    // Isolated callers supply a home and never consult this machine's settings.
    const source = options.home === undefined
        ? (await (await import("./localCodingSettings.js")).readLocalCodingSettings()).source : "existing";
    return source === "managed" ? join(home, ".prism-mcp", "omlx", "server") : join(home, ".omlx");
}
async function connection(options: OmlxConnectionOptions) {
    const env = options.env ?? process.env;
    const directory = await omlxConfigurationDirectory(options);
    const [settings, profiles] = await Promise.all([
        localJson(join(directory, "settings.json")),
        localJson(join(directory, "model_settings.json")),
    ]);
    const managed = directory === join(options.home ?? homedir(), ".prism-mcp", "omlx", "server");
    const apiKey = (!managed && env.OMLX_API_KEY) || settings.auth?.api_key;
    if (typeof apiKey !== "string" || !apiKey.trim()) throw new OmlxError("omlx_auth_unavailable");
    const url = loopbackUrl((!managed && env.OMLX_BASE_URL) || `http://${settings.server?.host ?? "127.0.0.1"}:${settings.server?.port ?? 8000}/v1`);
    return { settings, profiles, apiKey, url, directory, managed };
}
/** Exposed profile IDs resolve through persisted oMLX records, never name
 * heuristics. This observes request context only, not checkpoint qualification. */
async function configuredContext(model: string, models: Record<string, any>, settings: Record<string, any>, directory: string): Promise<number> {
    const matches: Record<string, any>[] = [];
    for (const [id, base] of Object.entries(models)) {
        if (base && typeof base === "object" && !Array.isArray(base)
            && (model === id || (typeof base.model_alias === "string" && model === base.model_alias))) matches.push(base);
    }
    if (model.includes(":")) {
        let profileMatches = 0;
        const document = await localJson(join(directory, "model_profiles.json"));
        if (Object.keys(document).length && (document.version !== 1 || !document.profiles
            || typeof document.profiles !== "object" || Array.isArray(document.profiles))) throw new OmlxError("omlx_profile_config_invalid");
        for (const [id, records] of Object.entries(document.profiles ?? {})) {
            if (!records || typeof records !== "object" || Array.isArray(records)) throw new OmlxError("omlx_profile_config_invalid");
            const base = Object.hasOwn(models, id) ? models[id] : undefined;
            for (const record of Object.values(records) as any[]) {
                if (!record || typeof record !== "object" || Array.isArray(record)) throw new OmlxError("omlx_profile_config_invalid");
                if (record.expose_as_model !== true) continue;
                const suppliedName = record.api_name;
                const name = suppliedName === undefined || suppliedName === null || suppliedName === "" ? record.name : suppliedName;
                if (typeof name !== "string" || !PROFILE_NAME_PATTERN.test(name)) throw new OmlxError("omlx_profile_config_invalid");
                const aliases = [id, ...(typeof base?.model_alias === "string" ? [base.model_alias] : [])];
                if (!aliases.some(alias => model === `${alias}:${name}`)) continue;
                if (!base || typeof base !== "object" || Array.isArray(base)
                    || !record.settings || typeof record.settings !== "object" || Array.isArray(record.settings)) throw new OmlxError("omlx_profile_config_invalid");
                const context = record.settings.max_context_window;
                matches.push({ ...base, ...(context === undefined || context === null || context === "" ? {} : { max_context_window: context }) });
                profileMatches++;
            }
        }
        if (!profileMatches) throw new OmlxError("omlx_profile_not_configured");
    }
    if (matches.length > 1) throw new OmlxError("omlx_profile_binding_ambiguous");
    const context = matches[0]?.max_context_window ?? settings.sampling?.max_context_window;
    if (!Number.isInteger(context) || context <= 0) throw new OmlxError("omlx_context_unknown");
    return context;
}
function selectedModel(requestedModel: string | undefined, env: NodeJS.ProcessEnv, settings: Record<string, any>, profiles: Record<string, any>) {
    const models = profiles.models && typeof profiles.models === "object" ? profiles.models : {};
    const defaults = Object.keys(models).filter(id => models[id]?.is_default === true);
    const singleFlash = Object.keys(models).length === 1 && /Flash-Next/i.test(Object.keys(models)[0])
        ? Object.keys(models)[0] : undefined;
    const model = requestedModel ?? env.OMLX_MODEL ?? settings.integrations?.codex_model
        ?? (defaults.length === 1 ? defaults[0] : singleFlash);
    if (typeof model !== "string" || !model.trim()) throw new OmlxError("omlx_model_not_configured");
    return { model, models };
}

/** Configuration only: Auto never starts a daemon or probes another backend. */
export async function configuredOmlxModel(requestedModel?: string, options: OmlxConnectionOptions = {}): Promise<string | undefined> {
    const env = options.env ?? process.env, directory = await omlxConfigurationDirectory(options);
    const [settings, profiles] = await Promise.all([
        localJson(join(directory, "settings.json")), localJson(join(directory, "model_settings.json")),
    ]);
    const managed = directory === join(options.home ?? homedir(), ".prism-mcp", "omlx", "server");
    if (!((!managed && env.OMLX_API_KEY) || settings.auth?.api_key)) return undefined;
    try { return selectedModel(requestedModel, managed ? { ...env, OMLX_MODEL: undefined } : env, settings, profiles).model; }
    catch (error) {
        if (error instanceof OmlxError && error.reason === "omlx_model_not_configured") return undefined;
        throw error;
    }
}

export async function detectOmlx(requestedModel?: string, options: OmlxConnectionOptions = {}): Promise<OmlxTarget> {
    const env = options.env ?? process.env;
    const { settings, profiles, apiKey, url, directory, managed } = await connection(options);
    const { model, models } = selectedModel(requestedModel, managed ? { ...env, OMLX_MODEL: undefined } : env, settings, profiles);
    const contextTokens = await configuredContext(model, models, settings, directory);
    try {
        const response = await (options.fetchImpl ?? fetch)(`${url}/models`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: "error",
        });
        if (!response.ok) throw new OmlxError(response.status === 401 || response.status === 403
            ? "omlx_auth_failed" : `omlx_models_http_${response.status}`);
        const data = await response.json() as { data?: { id?: unknown }[] };
        if (!Array.isArray(data.data) || !data.data.some(entry => entry?.id === model)) {
            throw new OmlxError("omlx_model_not_advertised");
        }
        return createOmlxTarget(url, model, contextTokens, apiKey);
    } catch (error) {
        if (error instanceof OmlxError) throw error;
        // Never relay raw server bodies, URLs, headers, or exception messages.
        throw new OmlxError("omlx_detection_unavailable");
    }
}

export interface OmlxInspection {
    url: string;
    advertised_models: string[];
    status: { version: string; uptime_seconds: number; models_loaded: number; models_loading: number;
        active_requests: number; waiting_requests: number; model_memory_used: number; model_memory_max: number };
    idle_observed: boolean;
    generation_enabled: false;
    qualification: "not_qualified";
    evidence_scope: "authenticated_server_counters_only";
}

/** Sanitized model inventory, not filesystem paths or a load/fit guarantee. */
export async function inspectOmlxCodingModels(options: OmlxConnectionOptions = {}): Promise<import("./ollamaCodingModels.js").LocalCodingModelObservation[]> {
    if (options.signal?.aborted || (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs)) throw new OmlxError("omlx_inspection_timeout");
    const { apiKey, url } = await connection(options);
    if (options.signal?.aborted || (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs)) throw new OmlxError("omlx_inspection_timeout");
    const timeout = options.deadlineMs === undefined ? PROBE_TIMEOUT_MS : Math.min(PROBE_TIMEOUT_MS, Math.max(0, options.deadlineMs - Date.now()));
    const raw = await inspectionJson(`${url}/models/status`, apiKey, options.fetchImpl ?? fetch, timeout, "GET", options.signal);
    if (!Array.isArray(raw.models) || raw.models.length > MAX_ADVERTISED_MODELS) throw new OmlxError("omlx_inspection_models_invalid");
    const ids = new Set<string>();
    return raw.models.filter(entry => entry && typeof entry === "object" && ["llm", "vlm"].includes(entry.engine_type)).map(entry => {
        if (typeof entry.id !== "string" || !MODEL_ID_PATTERN.test(entry.id) || entry.id.includes(apiKey) || ids.has(entry.id)
            || typeof entry.loaded !== "boolean") throw new OmlxError("omlx_inspection_models_invalid");
        ids.add(entry.id);
        const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
        return { id: entry.id, loaded: entry.loaded,
            ...(positive(entry.estimated_size) ? { weightBytes: entry.estimated_size } : {}),
            ...(entry.loaded && positive(entry.actual_size) ? { loadedBytes: entry.actual_size } : {}),
            ...(positive(entry.max_context_window) ? { contextTokens: entry.max_context_window } : {}) };
    });
}

async function inspectionJson(url: string, apiKey: string, fetchImpl: typeof fetch, timeoutMs: number,
    method: "GET" | "POST" = "GET", parentSignal?: AbortSignal): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const deadline = performance.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkTime = () => {
        if (controller.signal.aborted || parentSignal?.aborted || performance.now() >= deadline) throw new OmlxError("omlx_inspection_timeout");
    };
    const work = async () => {
        checkTime();
        const response = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${apiKey}` },
            redirect: "error", signal: AbortSignal.any([controller.signal, ...(parentSignal ? [parentSignal] : [])]) });
        checkTime();
        if (!response.ok) throw new OmlxError(method === "POST" && response.status === 409 ? "omlx_idle_model_busy"
            : response.status === 401 || response.status === 403 ? "omlx_auth_failed" : "omlx_inspection_http_failed");
        if (!response.body) throw new OmlxError("omlx_inspection_invalid");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
            for (;;) {
                checkTime();
                const part = await reader.read();
                checkTime();
                if (part.done) break;
                bytes += part.value.byteLength;
                if (bytes > MAX_INSPECTION_BYTES) throw new OmlxError("omlx_inspection_size_limit");
                chunks.push(part.value);
            }
        } finally { void reader.cancel().catch(() => {}); }
        const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        checkTime();
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new OmlxError("omlx_inspection_invalid");
        return data as Record<string, unknown>;
    };
    try {
        return await Promise.race([work(), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new OmlxError("omlx_inspection_timeout")); }, timeoutMs);
        })]);
    } catch (error) {
        if (error instanceof OmlxError) throw error;
        throw new OmlxError("omlx_inspection_unavailable");
    } finally { clearTimeout(timer); controller.abort(); }
}

/** Reclaim only idle non-target models. Metadata is a planning hint; native
 * pool admission still owns fit and activity decisions. A transport failure
 * refuses this generation; it does not prove backend teardown completed. */
export async function reclaimIdleOmlxMemory(target: OmlxTarget, available: () => number,
    signal: AbortSignal, deadlineMs: number, fetchImpl: typeof fetch = fetch): Promise<void> {
    if (leaseContext.getStore() !== true) throw new OmlxError("omlx_exclusive_lease_required");
    const key = credentials.get(target);
    if (!key) throw new OmlxError("omlx_auth_unavailable");
    const check = () => {
        if (signal.aborted || Date.now() >= deadlineMs) throw new OmlxError("timeout");
    };
    const readAvailable = () => {
        const bytes = available();
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new OmlxError("omlx_memory_pressure");
        return bytes;
    };
    const probe = (url: string, method: "GET" | "POST" = "GET") => {
        check();
        return inspectionJson(url, key, fetchImpl, Math.min(PROBE_TIMEOUT_MS, deadlineMs - Date.now()), method);
    };
    check();
    readAvailable();
    const raw = await probe(`${target.url}/models/status`);
    if (!Array.isArray(raw.models) || raw.models.length > MAX_ADVERTISED_MODELS) throw new OmlxError("omlx_inspection_models_invalid");
    const ids = new Set<string>();
    const models = raw.models.map((entry: any) => {
        if (!entry || typeof entry.id !== "string" || !MODEL_ID_PATTERN.test(entry.id) || entry.id.includes(key)
            || ids.has(entry.id) || typeof entry.loaded !== "boolean" || typeof entry.is_loading !== "boolean"
            || typeof entry.pinned !== "boolean") throw new OmlxError("omlx_inspection_models_invalid");
        ids.add(entry.id);
        return entry;
    });
    const requested = models.find((entry: any) => entry.id === target.model);
    // Advertised aliases may differ from canonical inventory IDs. Without an
    // exact binding, leave eviction to native pool admission and protect every
    // resident model from speculative alias-based victim selection.
    if (!requested) {
        if (readAvailable() >= OMLX_MIN_AVAILABLE_BYTES) return;
        throw new OmlxError("omlx_memory_pressure");
    }
    if (requested.is_loading) throw new OmlxError("omlx_memory_contention");
    const estimate = requested.resident_estimated_size;
    // Unknown sizes remain the native pool's decision; the existing reserve
    // never shrinks and a loaded target is never selected as a victim.
    const required = OMLX_MIN_AVAILABLE_BYTES + (!requested.loaded && Number.isSafeInteger(estimate) && estimate > 0 ? estimate : 0);
    if (!Number.isSafeInteger(required)) throw new OmlxError("omlx_inspection_models_invalid");
    if (readAvailable() >= required) return;
    const victims = models.filter((entry: any) => entry.loaded && !entry.is_loading && !entry.pinned && entry.id !== target.model)
        .sort((a: any, b: any) => (Number.isFinite(a.last_access) ? a.last_access : Infinity)
            - (Number.isFinite(b.last_access) ? b.last_access : Infinity));
    for (const victim of victims) {
        check();
        if (readAvailable() >= required) return;
        let ack: Record<string, unknown>;
        try { ack = await probe(`${target.url}/models/${encodeURIComponent(victim.id)}/unload-idle`, "POST"); }
        catch (error) {
            if (error instanceof OmlxError && error.reason === "omlx_idle_model_busy") continue;
            throw error;
        }
        if (ack.status !== "ok" || ack.model_id !== victim.id) throw new OmlxError("omlx_idle_unload_unconfirmed");
        // The shared RAM reader caches for one second. Wait for an observed
        // increase; never add advertised model bytes to an old sample.
        const drainDeadline = Math.min(deadlineMs, Date.now() + RECLAIM_DRAIN_MS);
        do {
            check();
            if (readAvailable() >= required) return;
            await new Promise(resolve => setTimeout(resolve, RECLAIM_POLL_MS));
        } while (Date.now() < drainDeadline);
    }
    check();
    if (readAvailable() < required) throw new OmlxError("omlx_memory_pressure");
}

/** Read-only control-plane evidence. Advertisement and idle counters do not
 * establish checkpoint identity, cancellation completion or model qualification. */
export async function inspectOmlx(options: OmlxConnectionOptions & { timeoutMs?: number } = {}): Promise<OmlxInspection> {
    const timeout = options.timeoutMs ?? PROBE_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > PROBE_TIMEOUT_MS) throw new OmlxError("omlx_inspection_timeout_invalid");
    const { apiKey, url } = await connection(options);
    const fetchImpl = options.fetchImpl ?? fetch;
    const [models, raw] = await Promise.all([
        inspectionJson(`${url}/models`, apiKey, fetchImpl, timeout),
        inspectionJson(`${url.slice(0, -3)}/api/status`, apiKey, fetchImpl, timeout),
    ]);
    const data = models.data;
    if (!Array.isArray(data) || data.length > MAX_ADVERTISED_MODELS
        || !data.every(entry => entry && typeof entry === "object" && typeof entry.id === "string"
            && MODEL_ID_PATTERN.test(entry.id) && !entry.id.includes(apiKey))) {
        throw new OmlxError("omlx_inspection_models_invalid");
    }
    const advertised = data.map(entry => entry.id as string);
    if (new Set(advertised).size !== advertised.length) throw new OmlxError("omlx_inspection_models_invalid");
    if (typeof raw.version !== "string" || raw.version.length > 32 || raw.version.includes(apiKey)
        || !/^[0-9]+\.[0-9]+\.[0-9]+(?:rc[0-9]+)?(?:[.+-][A-Za-z0-9.-]+)?$/.test(raw.version)
        || typeof raw.uptime_seconds !== "number" || !Number.isFinite(raw.uptime_seconds) || raw.uptime_seconds < 0
        || !STATUS_COUNTS.every(key => Number.isSafeInteger(raw[key]) && (raw[key] as number) >= 0)
        || ![raw.model_memory_used, raw.model_memory_max].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
        throw new OmlxError("omlx_inspection_status_invalid");
    }
    return { url, advertised_models: advertised,
        status: { version: raw.version, uptime_seconds: raw.uptime_seconds,
            models_loaded: raw.models_loaded as number, models_loading: raw.models_loading as number,
            active_requests: raw.active_requests as number, waiting_requests: raw.waiting_requests as number,
            model_memory_used: raw.model_memory_used as number, model_memory_max: raw.model_memory_max as number },
        idle_observed: raw.active_requests === 0 && raw.waiting_requests === 0 && raw.models_loading === 0,
        generation_enabled: false, qualification: "not_qualified", evidence_scope: "authenticated_server_counters_only" };
}

export interface OmlxServingInspection {
    model_id: string; model_path: string; max_context_window: number;
    loaded: boolean; is_loading: boolean; distributed: boolean;
    engine_type: "llm" | "vlm"; config_model_type: string; source_type: "local" | "hf_cache";
    serving_identity_verified: false; generation_enabled: false; qualification: "not_qualified";
    evidence_scope: "authenticated_model_status_only";
}
/** Saved inventory binds advertised model to its reported path and context.
 * File hashes, effective settings and engine lifetime remain controller checks. */
export async function inspectOmlxServing(target: OmlxTarget, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<OmlxServingInspection> {
    const key = credentials.get(target);
    if (!key) throw new OmlxError("omlx_auth_unavailable");
    const timeout = options.timeoutMs ?? PROBE_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > PROBE_TIMEOUT_MS) throw new OmlxError("omlx_inspection_timeout_invalid");
    const raw = await inspectionJson(`${target.url}/models/status`, key, options.fetchImpl ?? fetch, timeout);
    const models = raw.models;
    if (!Array.isArray(models) || models.length > MAX_ADVERTISED_MODELS
        || !models.every(entry => entry && typeof entry === "object" && typeof entry.id === "string"
            && MODEL_ID_PATTERN.test(entry.id) && !entry.id.includes(key))
        || new Set(models.map(entry => entry.id)).size !== models.length) throw new OmlxError("omlx_serving_inventory_invalid");
    const model = models.find(entry => entry.id === target.model);
    if (!model) throw new OmlxError("omlx_serving_model_unavailable");
    if (typeof model.model_path !== "string" || model.model_path.length > 4096 || /[\u0000-\u001f\u007f]/.test(model.model_path)
        || !isAbsolute(model.model_path) || resolve(model.model_path) !== model.model_path || model.model_path.includes(key)
        || !Number.isSafeInteger(model.max_context_window) || model.max_context_window !== target.contextTokens
        || model.max_context_window <= 0 || !["loaded", "is_loading", "distributed"].every(field => typeof model[field] === "boolean")
        || !["llm", "vlm"].includes(model.engine_type) || !["local", "hf_cache"].includes(model.source_type)
        || typeof model.config_model_type !== "string" || !MODEL_ID_PATTERN.test(model.config_model_type)
        || model.config_model_type.includes(key)) throw new OmlxError("omlx_serving_model_invalid");
    return { model_id: target.model, model_path: model.model_path, max_context_window: model.max_context_window,
        loaded: model.loaded, is_loading: model.is_loading, distributed: model.distributed, engine_type: model.engine_type,
        config_model_type: model.config_model_type, source_type: model.source_type, serving_identity_verified: false,
        generation_enabled: false, qualification: "not_qualified", evidence_scope: "authenticated_model_status_only" };
}

/** Operator capability negotiation only. Version support grants formatting
 * compatibility, never cancellation, model quality or inference admission. */
export async function negotiateOwnedOmlxIdentity(target: OmlxTarget, fetchImpl: typeof fetch = fetch): Promise<"native-id-v1"> {
    const key = credentials.get(target);
    if (!key) throw new OmlxError("omlx_auth_unavailable");
    const status = await inspectionJson(`${target.url.slice(0, -3)}/api/status`, key, fetchImpl, PROBE_TIMEOUT_MS);
    if (status.version !== "0.7.0") throw new OmlxError("omlx_native_protocol_unsupported");
    nativeIdProtocols.add(target);
    if (!nativeIdBindings.has(target)) nativeIdBindings.set(target, new Map());
    return "native-id-v1";
}

/** Reads the existing trusted journal; caller data cannot manufacture a
 * correlation tuple. This restores identity only and never clears quarantine. */
export function restoreOwnedOmlxBinding(target: OmlxTarget, jobId: string, operationId: string, nativeId: string,
    directory = inferenceJobStateDirectory()): boolean {
    const key = credentials.get(target), bindings = nativeIdBindings.get(target);
    if (!key || !bindings || !NATIVE_UUID_PATTERN.test(jobId) || !NATIVE_UUID_PATTERN.test(operationId)
        || !NATIVE_ID_PATTERN.test(nativeId) || nativeId.includes(key)) throw new OmlxError("omlx_native_request_invalid");
    try {
        const root = lstatSync(directory, { bigint: true });
        if (!root.isDirectory() || typeof process.getuid !== "function" || root.uid !== BigInt(process.getuid()) || (root.mode & 0o077n) !== 0n) throw new Error();
        const name = createHash("sha256").update(target.url).digest("hex") + ".json";
        const marker = readDeviceMarker(join(directory, name), name);
        if (stateStamp(root) !== stateStamp(lstatSync(directory, { bigint: true }))) throw new Error();
        if (marker.version !== 2 || !marker.active || !marker.provider_started || marker.job_id !== jobId
            || marker.operation_id !== operationId || marker.provider_request_id !== nativeId) return false;
        const previous = bindings.get(nativeId);
        if (previous && (previous.jobId !== jobId || previous.operationId !== operationId)) return false;
        if (!previous && bindings.size >= MAX_NATIVE_BINDINGS) bindings.delete(bindings.keys().next().value!);
        bindings.set(nativeId, { jobId, operationId });
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw new OmlxError("omlx_quarantine_state_unavailable");
    }
}

function nativeIdentity(response: any, target: OmlxTarget, jobId: string, operationId: string, id?: string): boolean {
    const key = credentials.get(target);
    const metadata = response?.metadata;
    const missingMetadata = metadata === undefined || metadata !== null && typeof metadata === "object"
        && !Array.isArray(metadata) && Object.keys(metadata).length === 0;
    const matchedMetadata = metadata?.prism_job_id === jobId && metadata?.prism_operation_id === operationId;
    return !!response && response.object === "response" && typeof response.id === "string"
        && !!key && !response.id.includes(key) && NATIVE_ID_PATTERN.test(response.id) && (id === undefined || response.id === id)
        && response.model === target.model && (matchedMetadata || nativeIdProtocols.has(target) && missingMetadata);
}
function nativeTerminal(response: any): boolean {
    return response?.error == null && (response.status === "completed"
        || response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens");
}
function nativeAcknowledgement(target: OmlxTarget, jobId: string, operationId: string, id: string): OwnedAcknowledgement {
    return { provider_id: target.url, job_id: jobId, operation_id: operationId, provider_request_id: id };
}
function nativeGeneration(response: any): LocalGeneration {
    if (!Array.isArray(response.output) || response.output.length > 128) throw new OmlxError("omlx_native_output_invalid");
    const texts: string[] = [];
    for (const item of response.output) {
        if (item?.type === "reasoning") continue;
        if (item?.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)
            || item.content.length > 32 || !["completed", "incomplete"].includes(item.status)
            || response.status === "completed" && item.status !== "completed") return { ok: false, reason: "omlx_native_output_invalid" };
        for (const part of item.content) {
            if (part?.type !== "output_text" || typeof part.text !== "string") return { ok: false, reason: "omlx_native_output_invalid" };
            texts.push(part.text);
        }
    }
    const text = texts.join("\n").trim();
    if (!text) return { ok: false, reason: "empty_response" };
    const prompt = response.usage?.input_tokens, completion = response.usage?.output_tokens;
    if ([prompt, completion].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) throw new OmlxError("omlx_native_usage_invalid");
    return { ok: true, text, doneReason: response.status === "completed" ? "stop" : "length",
        ...(prompt === undefined ? {} : { promptTokens: prompt }), ...(completion === undefined ? {} : { completionTokens: completion }) };
}

/** Internal transport for qualified controllers. This primitive does not grant
 * inference admission or prove server cancellation/idle. Stored responses are
 * used for correlation; qualification initially uses synthetic fixtures only. */
export async function callOwnedOmlxResponses(target: OmlxTarget, request: Pick<OmlxRequest, "messages" | "maxTokens">,
    owned: OwnedProviderRequest, fetchImpl: typeof fetch = fetch): Promise<OwnedAction<LocalGeneration>> {
    const key = credentials.get(target);
    if (!key) throw new OmlxError("omlx_auth_unavailable");
    const jobId = owned.jobId, operationId = owned.operationId, signal = owned.signal;
    const bindRequestId = owned.bindRequestId.bind(owned);
    if (!NATIVE_UUID_PATTERN.test(jobId) || !NATIVE_UUID_PATTERN.test(operationId)
        || !Number.isInteger(request.maxTokens) || request.maxTokens < 1 || request.maxTokens > 8192
        || !Array.isArray(request.messages) || !request.messages.length || request.messages.length > 128
        || request.messages.some(message => !message || !["system", "user", "assistant"].includes(message.role) || typeof message.content !== "string")) throw new OmlxError("omlx_native_request_invalid");
    const inputBytes = request.messages.reduce((sum, message) => sum + Buffer.byteLength(message.content, "utf8") + 8, 0);
    if (inputBytes > MAX_NATIVE_INPUT_BYTES || inputBytes + request.maxTokens + 1300 > target.contextTokens) throw new OmlxError("omlx_ctx_insufficient");
    const check = () => { if (signal.aborted) throw new OmlxError("omlx_native_stopped"); };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        check();
        const response = await fetchImpl(`${target.url}/responses`, { method: "POST", redirect: "error", signal,
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({model: target.model, input: request.messages.map(({role, content}) => ({role, content})), max_output_tokens: request.maxTokens,
                stream: true, store: true, truncation: "disabled", metadata: {prism_job_id: jobId, prism_operation_id: operationId}}) });
        check();
        if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) throw new OmlxError("omlx_native_http_invalid");
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0, buffer = "", id: string | undefined, terminal: any;
        const frame = (value: string) => {
            if (Buffer.byteLength(value, "utf8") > MAX_NATIVE_EVENT_BYTES) throw new OmlxError("omlx_native_event_limit");
            const lines = value.split(/\r?\n/), events = lines.filter(line => line.startsWith("event:"));
            const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (!data && lines.every(line => !line || line.startsWith(":"))) return;
            if (data === "[DONE]") {
                if (events.length || !terminal) throw new OmlxError("omlx_native_event_invalid");
                return;
            }
            if (events.length !== 1) throw new OmlxError("omlx_native_event_invalid");
            const event = JSON.parse(data), type = events[0].slice(6).trim();
            if (event.type !== type || terminal) throw new OmlxError("omlx_native_event_invalid");
            if (type === "response.created") {
                if (id || !nativeIdentity(event.response, target, jobId, operationId)
                    || event.response.status !== "in_progress") throw new OmlxError("omlx_native_identity_invalid");
                id = event.response.id;
                const bindings = nativeIdBindings.get(target);
                if (bindings?.has(id!)) throw new OmlxError("omlx_native_identity_reused");
                bindRequestId(id!);
                if (bindings) {
                    if (bindings.size >= MAX_NATIVE_BINDINGS) bindings.delete(bindings.keys().next().value!);
                    bindings.set(id!, { jobId, operationId });
                }
            } else if (["response.completed", "response.incomplete"].includes(type)) {
                if (!id || !nativeIdentity(event.response, target, jobId, operationId, id)
                    || !nativeTerminal(event.response) || type !== `response.${event.response.status}`) throw new OmlxError("omlx_native_terminal_invalid");
                terminal = event.response;
            } else if (type === "error" || type === "response.failed") throw new OmlxError("omlx_native_provider_failed");
        };
        for (;;) {
            check(); const part = await reader.read(); check();
            if (part.done) { buffer += decoder.decode(); break; }
            bytes += part.value.byteLength;
            if (bytes > MAX_NATIVE_BYTES) throw new OmlxError("omlx_native_size_limit");
            buffer += decoder.decode(part.value, {stream: true});
            let separator: RegExpExecArray | null;
            while ((separator = /\r?\n\r?\n/.exec(buffer))) {
                frame(buffer.slice(0, separator.index)); buffer = buffer.slice(separator.index + separator[0].length); check();
            }
            if (Buffer.byteLength(buffer, "utf8") > MAX_NATIVE_EVENT_BYTES) throw new OmlxError("omlx_native_event_limit");
        }
        if (buffer.trim()) throw new OmlxError("omlx_native_event_incomplete");
        if (!id || !terminal) throw new OmlxError("omlx_native_terminal_missing");
        const value = nativeGeneration(terminal);
        if (value.ok && value.text.includes(key)) throw new OmlxError("omlx_native_output_invalid");
        return {value, acknowledgement: nativeAcknowledgement(target, jobId, operationId, id)};
    } catch (error) {
        if (error instanceof OmlxError) throw error;
        throw new OmlxError(signal.aborted ? "omlx_native_stopped" : "omlx_native_transport_invalid");
    } finally { void reader?.cancel().catch(() => {}); }
}

/** Correlated terminal evidence only. A qualified controller must independently
 * verify idle before releasing ownership; a 404 or unknown status is no proof. */
export async function readOwnedOmlxCompletion(target: OmlxTarget, jobId: string, operationId: string, nativeId: string,
    fetchImpl: typeof fetch = fetch): Promise<OwnedAcknowledgement | undefined> {
    const key = credentials.get(target);
    if (!key || !NATIVE_UUID_PATTERN.test(jobId) || !NATIVE_UUID_PATTERN.test(operationId)
        || !NATIVE_ID_PATTERN.test(nativeId) || nativeId.includes(key)) throw new OmlxError("omlx_native_request_invalid");
    if (nativeIdProtocols.has(target)) {
        const binding = nativeIdBindings.get(target)?.get(nativeId);
        // Cross-worker recovery needs an independently validated durable
        // binding. Until implemented, an empty process map grants no proof.
        if (!binding || binding.jobId !== jobId || binding.operationId !== operationId) return undefined;
    }
    try {
        const value = await inspectionJson(`${target.url}/responses/${nativeId}`, key, fetchImpl, PROBE_TIMEOUT_MS);
        return nativeIdentity(value, target, jobId, operationId, nativeId) && nativeTerminal(value)
            ? nativeAcknowledgement(target, jobId, operationId, nativeId) : undefined;
    } catch { return undefined; }
}

/** The control routes' endpoint for this target. The key stays inside the
 * returned object; this module keeps no runtime imports of its own. */
export function omlxControlEndpoint(target: OmlxTarget, fetchImpl: typeof fetch = fetch): ControlEndpoint | undefined {
    const apiKey = credentials.get(target);
    return apiKey ? Object.freeze({ base: new URL(target.url).origin + "/prism-control/v1", apiKey, fetchImpl }) : undefined;
}

/** Probe a fresh, nonexistent operation without registering or cancelling it. */
export async function hasOmlxControl(target: OmlxTarget, fetchImpl: typeof fetch = fetch): Promise<boolean> {
    const endpoint = omlxControlEndpoint(target, fetchImpl);
    if (!endpoint) return false;
    try {
        const reply = await operationStatus(endpoint, randomUUID(), randomUUID());
        return reply.status === 404 && (reply.body as { detail?: unknown })?.detail === "Control operation unknown";
    } catch { return false; }
}

export function createOmlxRuntime(resources: Pick<OmlxRuntime, "listLoaded" | "unload" | "generate"> & Pick<Partial<OmlxRuntime>, "detect" | "recover">,
    ollamaUrl: string): OmlxRuntime {
    return { ...resources, reclaim: reclaimIdleOmlxMemory, detect: async model => {
        // An explicit local request also keeps its classification/resource
        // probes on loopback, even if ordinary Ollama has a remote base URL.
        loopbackUrl(ollamaUrl, "");
        return (resources.detect ?? detectOmlx)(model);
    }, acquire: acquireOmlxLease };
}

/** Fail closed if another Ollama user loads weights or available memory drops
 * below the reserve. The watcher never unloads a contender's model. */
export async function guardedOmlxGenerate(runtime: OmlxRuntime, target: OmlxTarget,
    request: OmlxRequest, freemem: () => number, watchIntervalMs = WATCH_INTERVAL_MS): Promise<LocalGeneration> {
    if (request.timeoutMs <= 0) return { ok: false, reason: "timeout" };
    const deadline = Date.now() + request.timeoutMs;
    const inputBytes = request.messages.reduce((n, message) => n + Buffer.byteLength(message.content, "utf8") + 8, 0);
    if (inputBytes + request.maxTokens + 1_300 > target.contextTokens) return { ok: false, reason: "omlx_ctx_insufficient" };
    const contention = async (): Promise<string | null> => {
        try {
            if ((await runtime.listLoaded()).size) return "omlx_memory_contention";
            const available = freemem();
            if (!Number.isFinite(available) || available < OMLX_MIN_AVAILABLE_BYTES) return "omlx_memory_pressure";
            return null;
        } catch { return "omlx_ollama_state_unavailable"; }
    };
    const controller = new AbortController();
    let stop!: (result: LocalGeneration) => void;
    const failure = new Promise<LocalGeneration>(resolve => { stop = resolve; });
    let checking = false;
    let stopped = false;
    let watcher: ReturnType<typeof setInterval> | undefined;
    const fail = (reason: string) => { controller.abort(); stop({ ok: false, reason }); };
    const timeout = setTimeout(() => fail("timeout"), request.timeoutMs);
    const work = async (): Promise<LocalGeneration> => {
        let initial = await contention();
        // A late resource probe must never start generation after timeout.
        if (stopped || controller.signal.aborted || Date.now() >= deadline) return { ok: false, reason: "timeout" };
        if (runtime.reclaim && (initial === null || initial === "omlx_memory_pressure")) {
            try { await runtime.reclaim(target, freemem, controller.signal, deadline); }
            catch (error) { return { ok: false, reason: error instanceof OmlxError ? error.reason : "omlx_idle_unload_failed" }; }
            if (stopped || controller.signal.aborted || Date.now() >= deadline) return { ok: false, reason: "timeout" };
            initial = await contention();
        }
        // The post-reclaim probe can outlive the race's timeout/finally. A
        // late read must not publish another watcher or start an owned job.
        if (stopped || controller.signal.aborted || Date.now() >= deadline) return { ok: false, reason: "timeout" };
        if (initial) return { ok: false, reason: initial };
        watcher = setInterval(() => {
            if (checking || stopped) return;
            checking = true;
            void contention().then(reason => { if (reason && !stopped) fail(reason); })
                .finally(() => { checking = false; });
        }, watchIntervalMs);
        const result = await runtime.generate(target, request, controller.signal)
            .catch(() => ({ ok: false as const, reason: controller.signal.aborted ? "timeout" : "omlx_network" }));
        if (stopped || controller.signal.aborted || Date.now() >= deadline) return { ok: false, reason: "timeout" };
        if (!result.ok) return result;
        const final = await contention();
        if (stopped || controller.signal.aborted || Date.now() >= deadline) return { ok: false, reason: "timeout" };
        return final ? { ok: false, reason: final } : result;
    };
    try { return await Promise.race([work(), failure]); }
    finally { stopped = true; clearTimeout(timeout); if (watcher) clearInterval(watcher); controller.abort(); }
}
