/** Durable cooperative ownership. Provider completion/idle evidence must come
 * from a qualified adapter, never task text or client-fetch abortion. */
import { constants, closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

const MAX_BUDGET_MS = 900_000;
const MAX_MARKER_BYTES = 4096;
const MIN_DRAIN_POLL_MS = 10;
const MAX_DRAIN_POLL_MS = 3000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LEGACY_FIELDS = ["version", "provider_hash", "job_id", "operation_id", "provider_started", "active"] as const;
const FIELDS = [...LEGACY_FIELDS, "provider_request_id"] as const;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Marker = { version: 2; provider_hash: string; job_id: string; operation_id: string | null; provider_request_id: string | null; provider_started: boolean; active: boolean };
export interface OwnedAcknowledgement { provider_id: string; job_id: string; operation_id: string; provider_request_id?: string }
export interface OwnedObservation { idle_verified: boolean; acknowledgement?: OwnedAcknowledgement }
export interface OwnedAction<T> { value: T; acknowledgement?: OwnedAcknowledgement }
export interface OwnedProviderRequest {
    signal: AbortSignal; jobId: string; operationId: string;
    /** Bind only the existing operation. Drain-time identity evidence may arrive
     * after caller stop; this neither dispatches nor releases backend work. */
    bindRequestId: (id: string) => void;
}
export interface OwnedJobOptions {
    providerId: string; stateDirectory: string; budgetMs: number; signal?: AbortSignal;
    /** Trusted controller only. Polling may outlast the caller deadline and
     * never authorizes a new provider action or substitutes for completion. */
    drain?: { budgetMs: number; pollIntervalMs: number };
    acquire: () => Promise<() => Promise<void>>;
    observe: (marker: Readonly<Marker>) => Promise<OwnedObservation>;
}
export interface OwnedJobContext {
    readonly signal: AbortSignal; readonly jobId: string;
    remainingMs: () => number;
    stage: <T>(action: () => Promise<T>) => Promise<T>;
    providerAction: <T>(action: (request: OwnedProviderRequest) => Promise<OwnedAction<T>>) => Promise<T>;
}
export interface OwnedJobResult<T> {
    status: "success" | "deadline" | "cancelled" | "provider_busy" | "infrastructure_error";
    job_id: string; quarantined: boolean; value?: T;
    /** Non-enumerable. Resolves once no marker write can follow (the job's own
     * run and its drain), to whether the marker is still active. */
    readonly settled?: Promise<boolean>;
}

/** RFC 9562 UUIDv7: the mint time in milliseconds, then random bits. The
 * provider's control store retires these one horizon after minting. */
export function uuidv7(now = Date.now()): string {
    const bytes = randomBytes(16);
    bytes.writeUIntBE(now, 0, 6);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readMarker(path: string, providerHash: string): Marker | undefined {
    // One open and no stat before it, so nothing can change between a check and
    // the read: O_NOFOLLOW refuses a symlink, O_NONBLOCK keeps a FIFO from
    // blocking, and fstat checks the file actually opened.
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("owned_job_marker_invalid"); }
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_MARKER_BYTES) throw new Error();
        const bytes = Buffer.alloc(MAX_MARKER_BYTES + 1);
        const count = readSync(fd, bytes, 0, bytes.length, 0);
        if (count > MAX_MARKER_BYTES) throw new Error();
        const v = JSON.parse(bytes.subarray(0, count).toString("utf8"));
        const fields = v?.version === 1 ? LEGACY_FIELDS : FIELDS;
        if (!v || Object.keys(v).length !== fields.length || !fields.every(key => Object.hasOwn(v, key))
            || ![1, 2].includes(v.version) || v.provider_hash !== providerHash || typeof v.job_id !== "string" || !UUID.test(v.job_id)
            || typeof v.active !== "boolean" || typeof v.provider_started !== "boolean"
            || (v.provider_started ? typeof v.operation_id !== "string" || !UUID.test(v.operation_id) : v.operation_id !== null)
            || (v.version === 2 && (v.provider_request_id !== null && (typeof v.provider_request_id !== "string" || !REQUEST_ID.test(v.provider_request_id))
                || (!v.provider_started && v.provider_request_id !== null)))) throw new Error();
        return { ...v, version: 2, provider_request_id: v.version === 1 ? null : v.provider_request_id } as Marker;
    } catch { throw new Error("owned_job_marker_invalid"); }
    finally { closeSync(fd); }
}
function persist(path: string, marker: Marker): void {
    // <hash>.<uuid>.pending: the only temporary name the device quarantine scan accepts.
    if (!path.endsWith(".json")) throw new Error("owned_job_marker_invalid");
    const temporary = path.slice(0, -".json".length) + "." + randomUUID() + ".pending";
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(marker)); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
    const directory = openSync(join(path, ".."), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
}
/** The file still holds this marker, so a write cannot replace a later job's. */
function holds(path: string, marker: Marker): boolean {
    const current = readMarker(path, marker.provider_hash);
    return !!current && current.job_id === marker.job_id && current.operation_id === marker.operation_id;
}
function trustedDirectory(stateDirectory: string): string {
    const directory = realpathSync(stateDirectory);
    const permissions = statSync(directory);
    if (typeof process.getuid !== "function" || permissions.uid !== process.getuid() || (permissions.mode & 0o077) !== 0) throw new Error("owned_job_state_directory_untrusted");
    return directory;
}
function matches(ack: OwnedAcknowledgement | undefined, marker: Marker, providerId: string): boolean {
    return !!ack && ack.provider_id === providerId && ack.job_id === marker.job_id && ack.operation_id === marker.operation_id
        && (marker.provider_request_id === null || ack.provider_request_id === marker.provider_request_id);
}
// Materialize adapter-controlled getters before evaluating the current binding.
// Reading a callback field may synchronously bind the pending native request.
function snapshotAcknowledgement(ack: OwnedAcknowledgement | undefined): OwnedAcknowledgement | undefined {
    return ack && { provider_id: ack.provider_id, job_id: ack.job_id, operation_id: ack.operation_id,
        provider_request_id: ack.provider_request_id };
}
function snapshotObservation(observation: OwnedObservation): OwnedObservation {
    const idle = observation.idle_verified;
    const acknowledgement = snapshotAcknowledgement(observation.acknowledgement);
    return { idle_verified: idle, acknowledgement };
}

/** The clock starts before directory/lease/probe preparation. Resource work
 * MUST use context.providerAction so its marker is durable before dispatch. */
export async function runOwnedJob<T>(options: OwnedJobOptions, work: (context: OwnedJobContext) => Promise<T>): Promise<OwnedJobResult<T>> {
    const admitted = performance.now();
    const jobId = randomUUID();
    if (!Number.isInteger(options.budgetMs) || options.budgetMs < 1 || options.budgetMs > MAX_BUDGET_MS
        || typeof options.providerId !== "string" || !options.providerId.trim()) throw new Error("owned_job_options_invalid");
    const requestedDrain = options.drain;
    if (requestedDrain !== undefined && (!requestedDrain || typeof requestedDrain !== "object" || Array.isArray(requestedDrain)
        || Object.keys(requestedDrain).length !== 2 || !Object.hasOwn(requestedDrain, "budgetMs") || !Object.hasOwn(requestedDrain, "pollIntervalMs")
        || !Number.isInteger(requestedDrain.budgetMs) || requestedDrain.budgetMs < 1 || requestedDrain.budgetMs > MAX_BUDGET_MS
        || !Number.isInteger(requestedDrain.pollIntervalMs) || requestedDrain.pollIntervalMs < MIN_DRAIN_POLL_MS
        || requestedDrain.pollIntervalMs > MAX_DRAIN_POLL_MS)) throw new Error("owned_job_options_invalid");
    const drain = requestedDrain === undefined ? undefined : { ...requestedDrain };
    const deadline = admitted + options.budgetMs;
    const controller = new AbortController();
    let timedOut = false;
    let closed = false;
    let providerPending = false;
    const remaining = () => Math.max(0, deadline - performance.now());
    const stopStatus = () => timedOut || performance.now() >= deadline ? "deadline" as const : "cancelled" as const;
    const check = () => {
        if (closed || controller.signal.aborted || performance.now() >= deadline) throw new Error("owned_job_stopped");
    };
    const checkBudget = () => {
        if (controller.signal.aborted || performance.now() >= deadline) throw new Error("owned_job_stopped");
    };
    const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    let release: (() => Promise<void>) | undefined;
    const releaseOwned = async () => {
        const owned = release;
        release = undefined;
        await owned?.();
    };
    let marker: Marker | undefined;
    let path: string | undefined;
    let lastAcknowledged = false;
    let cleanupComplete = false;
    let cleanupRunning: Promise<boolean> | undefined;
    const cleanup = (): Promise<boolean> => {
        if (cleanupComplete) return Promise.resolve(true);
        if (cleanupRunning) return cleanupRunning;
        cleanupRunning = (async () => {
            if (!marker || !path) { await releaseOwned(); return true; }
            try {
                const observation = snapshotObservation(await options.observe(Object.freeze({ ...marker })));
                const acknowledged = !marker.provider_started || lastAcknowledged || matches(observation.acknowledgement, marker, options.providerId);
                if (observation.idle_verified !== true || !acknowledged) return false;
                const finished = { ...marker, active: false };
                // A later job (after recovery) may own the file now: never overwrite it.
                if (holds(path, marker)) persist(path, finished);
                marker = finished;
                await releaseOwned();
                cleanupComplete = true;
                return true;
            } catch { return false; }
        })().finally(() => { cleanupRunning = undefined; });
        return cleanupRunning;
    };
    let drainStarted = false;
    const startDrain = (): Promise<void> => {
        if (!drain || drainStarted || cleanupComplete || !marker?.active || !marker.provider_started || !release) return Promise.resolve();
        drainStarted = true;
        const until = performance.now() + drain.budgetMs;
        return (async () => {
            while (marker?.active && !cleanupComplete && performance.now() < until) {
                let limit: ReturnType<typeof setTimeout> | undefined;
                try {
                    const pending = cleanup();
                    const safe = await Promise.race([pending, new Promise<undefined>(resolve => {
                        limit = setTimeout(() => resolve(undefined), Math.max(0, until - performance.now())); limit.unref();
                    })]);
                    // The budget ended first: the cleanup still runs, and may still
                    // write the marker. Settle only after it (its observe is bounded).
                    if (safe === undefined) { await pending; return; }
                    if (safe !== false) return;
                } finally { clearTimeout(limit); }
                const pause = Math.min(drain.pollIntervalMs, until - performance.now());
                if (pause <= 0) return;
                await new Promise<void>(resolve => {const timer = setTimeout(resolve, pause); timer.unref();});
            }
        })().catch(() => { /* Durable active marker and retained lease remain the failure result. */ });
    };
    const context: OwnedJobContext = {
        signal: controller.signal, jobId, remainingMs: remaining,
        stage: async action => { check(); const value = await action(); check(); return value; },
        providerAction: async action => {
            check();
            if (!marker || !path) throw new Error("owned_job_not_admitted");
            if (providerPending) throw new Error("owned_job_concurrent_operation");
            if (marker.provider_started && !lastAcknowledged) throw new Error("owned_job_unresolved_operation");
            marker = { ...marker, provider_started: true, operation_id: uuidv7(), provider_request_id: null, active: true };
            lastAcknowledged = false;
            persist(path, marker); check();
            providerPending = true;
            try {
                const operationId = marker.operation_id!;
                const bindRequestId = (id: string) => {
                    if (typeof id !== "string" || !REQUEST_ID.test(id)) throw new Error("owned_job_request_id_invalid");
                    if (!providerPending || cleanupComplete || !marker?.active || !path || marker.operation_id !== operationId) throw new Error("owned_job_operation_not_active");
                    if (marker.provider_request_id !== null) {
                        if (marker.provider_request_id !== id) throw new Error("owned_job_request_id_rebind");
                        return;
                    }
                    lastAcknowledged = false;
                    marker = { ...marker, provider_request_id: id }; persist(path, marker);
                };
                const result = await action({ signal: controller.signal, jobId, operationId, bindRequestId });
                const value = result.value;
                const acknowledgement = snapshotAcknowledgement(result.acknowledgement);
                lastAcknowledged = matches(acknowledgement, marker, options.providerId);
                check();
                if (!lastAcknowledged) throw new Error("owned_job_acknowledgement_missing");
                return value;
            } finally { providerPending = false; }
        },
    };
    const running = async (): Promise<OwnedJobResult<T>> => {
        try {
            check();
            mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 }); check();
            const directory = trustedDirectory(options.stateDirectory);
            const providerHash = hash(options.providerId);
            path = join(directory, providerHash + ".json");
            const granted = await options.acquire();
            try { check(); } catch (error) { await granted(); throw error; }
            release = granted;
            const previous = readMarker(path, providerHash);
            if (previous?.active) {
                const observed = snapshotObservation(await options.observe(Object.freeze({ ...previous }))); check();
                if (observed.idle_verified !== true || (previous.provider_started && !matches(observed.acknowledgement, previous, options.providerId))) {
                    await releaseOwned();
                    return { status: "provider_busy", job_id: jobId, quarantined: true };
                }
            }
            const observed = snapshotObservation(await options.observe(Object.freeze({version: 2, provider_hash: providerHash,
                job_id: jobId, operation_id: null, provider_request_id: null, provider_started: false, active: false}))); check();
            if (observed.idle_verified !== true) { await releaseOwned(); return { status: "provider_busy", job_id: jobId, quarantined: false }; }
            marker = {version: 2, provider_hash: providerHash, job_id: jobId, operation_id: null, provider_request_id: null, provider_started: false, active: true};
            persist(path, marker); check();
            const value = await work(context); check();
            closed = true;
            if (!await cleanup()) return { status: "infrastructure_error", job_id: jobId, quarantined: true };
            checkBudget();
            return { status: "success", job_id: jobId, quarantined: false, value };
        } catch {
            closed = true;
            const safe = await cleanup();
            return { status: controller.signal.aborted || performance.now() >= deadline ? stopStatus() : "infrastructure_error",
                job_id: jobId, quarantined: !safe };
        }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted!: () => void;
    const stopped = new Promise<OwnedJobResult<T>>(resolve => {
        aborted = () => {
            void cleanup();
            resolve({ status: stopStatus(), job_id: jobId, quarantined: marker?.active === true });
        };
        controller.signal.addEventListener("abort", aborted, { once: true });
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(0, remaining()));
        if (controller.signal.aborted) aborted();
    });
    const run = running();
    let result: OwnedJobResult<T>;
    let drained: Promise<void> = Promise.resolve();
    try { result = await Promise.race([run, stopped]); }
    finally {
        clearTimeout(timer); controller.signal.removeEventListener("abort", aborted);
        options.signal?.removeEventListener("abort", cancel);
        closed = true; controller.abort();
        drained = startDrain();
    }
    // Neither the run nor the drain rejects; settle on both, then report the marker.
    const settled = Promise.all([run, drained]).then(() => marker?.active === true, () => marker?.active === true);
    return Object.defineProperty({ ...result }, "settled", { value: settled, enumerable: false });
}

/** Before any other work of a call that holds the device lease: clear this
 * provider's stale marker only on proof, else refuse. Same proof rule as
 * runOwnedJob's startup check; writes only the marker it observed. */
export async function recoverOwnedJob(options: Pick<OwnedJobOptions, "providerId" | "stateDirectory" | "observe">): Promise<void> {
    let directory: string;
    try { directory = trustedDirectory(options.stateDirectory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const providerHash = hash(options.providerId);
    const path = join(directory, providerHash + ".json");
    const previous = readMarker(path, providerHash);
    if (!previous?.active) return;
    const observed = snapshotObservation(await options.observe(Object.freeze({ ...previous })));
    if (observed.idle_verified !== true || (previous.provider_started && !matches(observed.acknowledgement, previous, options.providerId)))
        throw new Error("owned_job_provider_quarantined");
    if (holds(path, previous)) persist(path, { ...previous, active: false });
}
