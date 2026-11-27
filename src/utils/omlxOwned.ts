/** Owned oMLX generation: every explicit oMLX call is one owned
 * job whose single operation goes through the provider's control routes, so a
 * run is treated as stopped only on the provider's durable proof. */
import { createHash } from "node:crypto";
import { OmlxError, inferenceJobStateDirectory, omlxControlEndpoint, type LocalGeneration, type OmlxRequest, type OmlxTarget } from "./omlxProvider.js";
import { recoverOwnedJob, runOwnedJob, type OwnedAction, type OwnedObservation, type OwnedProviderRequest } from "./omlxJobControl.js";
import { assertControlRequestSize, cancelOperation, executeOperation, operationStatus, registerOperation, type ControlEndpoint } from "./omlxControl.js";
import { responsesInput } from "./omlxImages.js";

const OWNED_DRAIN = Object.freeze({ budgetMs: 10_000, pollIntervalMs: 250 });
const OWNED_MAX_JOB_MS = 900_000;
const OWNED_MAX_ADMISSION_MS = 120_000;
const OWNED_CANCEL_READ_MS = 30_000;
const SHA256 = /^[0-9a-f]{64}$/;
const STORE_GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STOPPED_STATES = new Set(["completed", "cancelled", "failed", "not_started"]);
type OperationCancel = (jobId: string, operationId: string) => ReturnType<typeof cancelOperation>;

function coalesceOperationCancels(endpoint: ControlEndpoint): OperationCancel {
    const pending = new Map<string, ReturnType<OperationCancel>>();
    return (jobId, operationId) => {
        const previous = pending.get(operationId);
        if (previous) return previous;
        const request = cancelOperation(endpoint, jobId, operationId);
        pending.set(operationId, request);
        return request;
    };
}

function controlRecord(body: unknown, jobId: string, operationId: string): Record<string, unknown> | undefined {
    if (!body || typeof body !== "object") return undefined;
    const record = body as Record<string, unknown>;
    return record.version === 3 && record.job_id === jobId && record.operation_id === operationId
        && typeof record.store_generation_id === "string" && STORE_GENERATION.test(record.store_generation_id) ? record : undefined;
}

/** The store binds the payload at registration. Use its authenticated response
 * to fingerprint the identity that subsequent terminal records must prove. */
function registrationId(record: Record<string, unknown>): string | undefined {
    const { model_id, request_sha256, settings_sha256, store_generation_id } = record;
    if (typeof store_generation_id !== "string" || !STORE_GENERATION.test(store_generation_id)
        || typeof model_id !== "string" || !model_id || typeof request_sha256 !== "string" || !SHA256.test(request_sha256)
        || typeof settings_sha256 !== "string" || !SHA256.test(settings_sha256)) return undefined;
    const hash = createHash("sha256").update(JSON.stringify([model_id, request_sha256, settings_sha256])).digest("hex");
    return `${store_generation_id}_${hash}`;
}

function stoppedOutcome(record: Record<string, unknown> | undefined, requestId: string | null): string | undefined {
    if (!record || record.claim_state !== "finished" || record.backend_stopped !== true
        || record.claim_store_generation_id !== record.store_generation_id || typeof record.state !== "string"
        || !STOPPED_STATES.has(record.state)) return undefined;
    const confirmedId = registrationId(record);
    return confirmedId && (requestId === null || confirmedId === requestId) ? record.state : undefined;
}

/** A stored claimless tombstone has the job/op and store, but no payload hashes. */
function stoppedBeforeClaim(record: Record<string, unknown> | undefined, requestId: string): boolean {
    const [generation, digest] = requestId.split("_");
    return typeof digest === "string" && SHA256.test(digest) && record?.state === "cancel_requested" && record.claim_state === "none"
        && record.backend_stopped === false && record.claim_store_generation_id === null && record.store_generation_id === generation;
}

/** Thinking ends at the first `</think>`; a leading `<think>` is optional. */
export function splitThinking(raw: string): { text: string; thinking?: string } | undefined {
    const close = raw.indexOf("</think>");
    if (close < 0) return raw.trimStart().startsWith("<think>") ? undefined : { text: raw.trim() };
    const thinking = raw.slice(0, close).replace(/^\s*<think>/, "").trim();
    return { text: raw.slice(close + "</think>".length).trim(), ...(thinking ? { thinking } : {}) };
}

/** A terminal must belong to the original registration. A claimless cancel
 * needs a matching registered operation and a tombstone from the same store. */
async function observeOwned(endpoint: ControlEndpoint, providerId: string,
    marker: { version: number; job_id: string; operation_id: string | null; provider_started: boolean; provider_request_id: string | null },
    cancel: OperationCancel): Promise<OwnedObservation> {
    if (!marker.provider_started || !marker.operation_id) return { idle_verified: true };
    const jobId = marker.job_id, operationId = marker.operation_id;
    const requestId = marker.provider_request_id;
    const acknowledgement = { provider_id: providerId, job_id: jobId, operation_id: operationId,
        ...(requestId !== null ? { provider_request_id: requestId } : {}) };
    // With the v3 journal, the adapter cannot send execute before the
    // registration binding is durable. Legacy unbound journals need a terminal.
    if (marker.version === 3 && requestId === null) return { idle_verified: true, acknowledgement };
    try {
        const status = await operationStatus(endpoint, jobId, operationId);
        const record = status.status === 200 ? controlRecord(status.body, jobId, operationId) : undefined;
        if (stoppedOutcome(record, requestId)) return { idle_verified: true, acknowledgement };
        if (requestId === null) return { idle_verified: false };
        if (marker.version === 3 && stoppedBeforeClaim(record, requestId)) return { idle_verified: true, acknowledgement };
        if (record?.state !== "registered" || record.claim_state !== "none" || registrationId(record) !== requestId)
            return { idle_verified: false };
        const reply = await cancel(jobId, operationId);
        const after = reply.status === 200 ? controlRecord(reply.body, jobId, operationId) : undefined;
        if (stoppedOutcome(after, requestId) || stoppedBeforeClaim(after, requestId))
            return { idle_verified: true, acknowledgement };
    } catch { /* not proven */ }
    return { idle_verified: false };
}

/** Avoid creating cancellation records on a provider that cannot confirm the binding. */
async function cancelActiveOperation(endpoint: ControlEndpoint, jobId: string, operationId: string, requestId: string, cancel: OperationCancel): Promise<void> {
    const status = await operationStatus(endpoint, jobId, operationId);
    const record = status.status === 200 ? controlRecord(status.body, jobId, operationId) : undefined;
    if (!record || registrationId(record) !== requestId) return;
    if ((record.state === "registered" && record.claim_state === "none")
        || (record.state === "claimed" && record.claim_state === "claimed" && record.claim_store_generation_id === record.store_generation_id))
        await cancel(jobId, operationId);
}

function responsesRequest(target: OmlxTarget, request: OmlxRequest): Record<string, unknown> {
    const kwargs = (request.profile?.chat_template_kwargs ?? undefined) as Record<string, unknown> | undefined;
    return {
        model: target.model,
        input: responsesInput(request.messages),
        max_output_tokens: request.maxTokens,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.cacheStore === false ? { prompt_cache_retention: "none" } : {}),
        ...(request.think === undefined && kwargs === undefined ? {} : { chat_template_kwargs: {
            ...(kwargs ?? {}), ...(request.think === undefined ? {} : { enable_thinking: request.think }) } }),
    };
}

/** One owned operation: register, execute and read; on abort, cancel once
 * and keep reading for a bounded time. Acknowledged only on a terminal that
 * proves this operation stopped. */
async function ownedAction(endpoint: ControlEndpoint, target: OmlxTarget, request: OmlxRequest, owned: OwnedProviderRequest,
    remainingMs: () => number, cancelReadMs: number, cancel: OperationCancel): Promise<OwnedAction<LocalGeneration>> {
    const body = responsesRequest(target, request);
    if (owned.signal.aborted || remainingMs() <= 0) throw new Error("owned_job_stopped");
    const registered = await registerOperation(endpoint, owned.jobId, owned.operationId, body, target.settingsSha256);
    if (registered.status !== 200) {
        if (registered.errorCode === "settings_changed")
            throw new OmlxError("omlx_settings_changed");
        if (request.messages.some(message => message.images?.length) && [400, 413].includes(registered.status))
            throw new OmlxError(registered.status === 413 ? "omlx_image_too_large" : "omlx_image_invalid");
        throw new Error(`omlx_control_register_${registered.status}`);
    }
    const registration = controlRecord(registered.body, owned.jobId, owned.operationId);
    if (!registration || registration.claim_state !== "none" || registration.state !== "registered"
        || registration.model_id !== target.model || (target.settingsSha256 && registration.settings_sha256 !== target.settingsSha256))
        throw new Error("omlx_control_registration_invalid");
    const requestId = registrationId(registration);
    if (!requestId) throw new Error("omlx_control_registration_invalid");
    owned.bindRequestId(requestId);
    if (owned.signal.aborted || remainingMs() <= 0) throw new Error("owned_job_stopped");
    const stream = new AbortController();
    let readLimit: ReturnType<typeof setTimeout> | undefined;
    let cancelling: Promise<void> | undefined;
    const onAbort = () => {
        cancelling = cancelActiveOperation(endpoint, owned.jobId, owned.operationId, requestId, cancel).catch(() => undefined);
        readLimit = setTimeout(() => stream.abort(), cancelReadMs);
    };
    owned.signal.addEventListener("abort", onAbort, { once: true });
    let text = "";
    let finished: Record<string, unknown> | undefined;
    let terminal: unknown;
    try {
        const remaining = Math.floor(remainingMs());
        if (owned.signal.aborted || remaining < 1) throw new Error("owned_job_stopped");
        const admission = Math.min(OWNED_MAX_ADMISSION_MS, remaining);
        for await (const { event, data } of executeOperation(endpoint, owned.jobId, owned.operationId, body, admission, stream.signal, target.settingsSha256)) {
            const d = data as Record<string, unknown> | undefined;
            if (event === "delta" && typeof d?.text === "string") text += d.text;
            else if (event === "finished") finished = d;
            else if (event === "terminal") { terminal = data; break; }
            else if (event === "unresolved") break;
        }
    } finally {
        owned.signal.removeEventListener("abort", onAbort);
        clearTimeout(readLimit);
        stream.abort();
        await cancelling;
    }
    const outcome = stoppedOutcome(controlRecord(terminal, owned.jobId, owned.operationId), requestId);
    if (!outcome) throw new Error("omlx_control_unresolved");
    const acknowledgement = { provider_id: target.url, job_id: owned.jobId, operation_id: owned.operationId, provider_request_id: requestId };
    if (outcome !== "completed") {
        const reason = outcome === "failed" ? "omlx_failed" : outcome === "cancelled" ? "timeout" : "omlx_not_admitted";
        return { value: { ok: false, reason }, acknowledgement };
    }
    const doneReason = finished?.finish_reason;
    if (doneReason !== "stop" && doneReason !== "length") return { value: { ok: false, reason: "omlx_finish_reason_invalid" }, acknowledgement };
    const split = splitThinking(text);
    if (!split?.text) return { value: { ok: false, reason: split?.thinking || !split ? "think_only" : "empty_response" }, acknowledgement };
    return { value: { ok: true, text: split.text, thinking: split.thinking, doneReason,
        promptTokens: typeof finished?.prompt_tokens === "number" ? finished.prompt_tokens : undefined,
        completionTokens: typeof finished?.completion_tokens === "number" ? finished.completion_tokens : undefined }, acknowledgement };
}

/** Check the complete execute envelope before creating any owned operation. */
export function validateOmlxRequestEnvelope(target: OmlxTarget, request: OmlxRequest): void {
    try { assertControlRequestSize(responsesRequest(target, request), target.settingsSha256); }
    catch (error) {
        throw new OmlxError(error instanceof Error && error.message === "omlx_control_request_too_large"
            ? "omlx_image_too_large" : "omlx_image_invalid");
    }
}

/** Owned generation through oMLX's control routes, inside one owned job.
 * Returns only once no marker write can follow; the caller already holds the
 * device lease, so acquiring here is a no-op and the marker is the quarantine. */
export interface OwnedOmlxOptions {
    fetchImpl?: typeof fetch; stateDirectory?: string;
    /** Test hooks only; production uses the 10 s drain and the 30 s read bound. */
    drainBudgetMs?: number; cancelReadMs?: number;
}
export async function ownedOmlxGenerate(target: OmlxTarget, request: OmlxRequest, signal: AbortSignal,
    options: OwnedOmlxOptions = {}): Promise<LocalGeneration> {
    const { fetchImpl = fetch, stateDirectory = inferenceJobStateDirectory() } = options;
    const endpoint = omlxControlEndpoint(target, fetchImpl);
    if (!endpoint) return { ok: false, reason: "omlx_auth_unavailable" };
    if (Object.keys(request.profile ?? {}).some(key => key !== "chat_template_kwargs")) return { ok: false, reason: "omlx_profile_unsupported" };
    if (request.messages.some(message => message.images?.length)) {
        try { validateOmlxRequestEnvelope(target, request); }
        catch (error) { return { ok: false, reason: (error as OmlxError).reason }; }
    }
    const requestRemainingMs = () => (request.deadlineMs ?? Infinity) - Date.now();
    const budgetMs = Math.floor(Math.min(OWNED_MAX_JOB_MS, request.timeoutMs, requestRemainingMs()));
    if (budgetMs <= 0) return { ok: false, reason: "timeout" };
    const cancel = coalesceOperationCancels(endpoint);
    let inputFailure: string | undefined;
    const result = await runOwnedJob({
        providerId: target.url, stateDirectory, budgetMs, signal, bindBeforeDispatch: true,
        drain: { ...OWNED_DRAIN, ...(options.drainBudgetMs === undefined ? {} : { budgetMs: options.drainBudgetMs }) },
        acquire: async () => async () => {},
        observe: marker => observeOwned(endpoint, target.url, marker, cancel),
    }, context => context.providerAction(async owned => {
        try { return await ownedAction(endpoint, target, request, owned, () => Math.min(context.remainingMs(), requestRemainingMs()),
            options.cancelReadMs ?? OWNED_CANCEL_READ_MS, cancel); }
        catch (error) {
            if ((error instanceof OmlxError && ["omlx_image_invalid", "omlx_image_too_large", "omlx_settings_changed"].includes(error.reason))
                || (error instanceof Error && error.message === "omlx_settings_changed"))
                inputFailure = error instanceof OmlxError ? error.reason : "omlx_settings_changed";
            throw error;
        }
    }));
    const quarantined = await (result.settled ?? Promise.resolve(result.quarantined));
    if (requestRemainingMs() <= 0 && !quarantined) return { ok: false, reason: "timeout" };
    if (result.status === "success" && result.value) return result.value;
    if (result.status === "provider_busy") return { ok: false, reason: "omlx_provider_busy" };
    if (quarantined) return { ok: false, reason: "omlx_stop_unproved" };
    if (inputFailure && result.status !== "deadline" && result.status !== "cancelled") return { ok: false, reason: inputFailure };
    return { ok: false, reason: result.status === "deadline" || result.status === "cancelled" ? "timeout" : "omlx_control_error" };
}

/** Right after the device lease: clear this provider's stale marker on proof. */
export async function recoverOwnedOmlx(target: OmlxTarget,
    { fetchImpl = fetch, stateDirectory = inferenceJobStateDirectory() }: Pick<OwnedOmlxOptions, "fetchImpl" | "stateDirectory"> = {}): Promise<void> {
    const endpoint = omlxControlEndpoint(target, fetchImpl);
    if (!endpoint) throw new OmlxError("omlx_auth_unavailable");
    const cancel = coalesceOperationCancels(endpoint);
    try { await recoverOwnedJob({ providerId: target.url, stateDirectory, observe: marker => observeOwned(endpoint, target.url, marker, cancel) }); }
    catch { throw new OmlxError("omlx_provider_quarantined"); }
}
