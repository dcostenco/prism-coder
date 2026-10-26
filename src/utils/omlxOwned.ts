/** Owned oMLX generation: every explicit oMLX call is one owned
 * job whose single operation goes through the provider's control routes, so a
 * run is treated as stopped only on the provider's durable proof. */
import { OmlxError, inferenceJobStateDirectory, omlxControlEndpoint, type LocalGeneration, type OmlxRequest, type OmlxTarget } from "./omlxProvider.js";
import { recoverOwnedJob, runOwnedJob, type OwnedAction, type OwnedObservation, type OwnedProviderRequest } from "./omlxJobControl.js";
import { assertControlRequestSize, cancelOperation, executeOperation, operationStatus, registerOperation, type ControlEndpoint } from "./omlxControl.js";
import { responsesInput } from "./omlxImages.js";

const OWNED_DRAIN = Object.freeze({ budgetMs: 10_000, pollIntervalMs: 250 });
const OWNED_MAX_JOB_MS = 900_000;
const OWNED_MAX_ADMISSION_MS = 120_000;
const OWNED_CANCEL_READ_MS = 30_000;


/** The terminal's outcome, only when it proves this operation stopped. */
function stoppedOutcome(body: unknown, jobId: string, operationId: string): string | undefined {
    if (!body || typeof body !== "object") return undefined;
    const b = body as Record<string, unknown>;
    return b.version === 3 && b.claim_state === "finished" && b.backend_stopped === true
        && b.job_id === jobId && b.operation_id === operationId && typeof b.state === "string" ? b.state : undefined;
}

/** Thinking ends at the first `</think>`; a leading `<think>` is optional. */
export function splitThinking(raw: string): { text: string; thinking?: string } | undefined {
    const close = raw.indexOf("</think>");
    if (close < 0) return raw.trimStart().startsWith("<think>") ? undefined : { text: raw.trim() };
    const thinking = raw.slice(0, close).replace(/^\s*<think>/, "").trim();
    return { text: raw.slice(close + "</think>".length).trim(), ...(thinking ? { thinking } : {}) };
}

/** Proven stop for a started operation: a terminal; or, for one that never
 * ran (404, or registered without a claim), a cancel answered with a
 * claimless tombstone or a 409, which the store gives only when no
 * registration (so no claim) exists. Anything else is not idle. */
async function observeOwned(endpoint: ControlEndpoint, providerId: string,
    marker: { job_id: string; operation_id: string | null; provider_started: boolean }): Promise<OwnedObservation> {
    if (!marker.provider_started || !marker.operation_id) return { idle_verified: true };
    const jobId = marker.job_id, operationId = marker.operation_id;
    const acknowledgement = { provider_id: providerId, job_id: jobId, operation_id: operationId };
    try {
        const status = await operationStatus(endpoint, jobId, operationId);
        if (status.status === 200 && stoppedOutcome(status.body, jobId, operationId)) return { idle_verified: true, acknowledgement };
        const record = status.body as Record<string, unknown> | undefined;
        const unclaimed = status.status === 200 && record?.claim_state === "none"
            && record?.job_id === jobId && record?.operation_id === operationId;
        if (status.status !== 404 && !unclaimed) return { idle_verified: false };
        const cancel = await cancelOperation(endpoint, jobId, operationId);
        const after = cancel.body as Record<string, unknown> | undefined;
        if (cancel.status === 409) return { idle_verified: true, acknowledgement };
        if (cancel.status === 200 && (stoppedOutcome(after, jobId, operationId)
            || (after?.claim_state === "none" && after?.job_id === jobId && after?.operation_id === operationId)))
            return { idle_verified: true, acknowledgement };
    } catch { /* not proven */ }
    return { idle_verified: false };
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
    remainingMs: () => number, cancelReadMs: number): Promise<OwnedAction<LocalGeneration>> {
    const body = responsesRequest(target, request);
    if (owned.signal.aborted) throw new Error("owned_job_stopped");
    const registered = await registerOperation(endpoint, owned.jobId, owned.operationId, body);
    if (registered.status !== 200) {
        if (request.messages.some(message => message.images?.length) && [400, 413].includes(registered.status))
            throw new OmlxError(registered.status === 413 ? "omlx_image_too_large" : "omlx_image_invalid");
        throw new Error(`omlx_control_register_${registered.status}`);
    }
    if (owned.signal.aborted) throw new Error("owned_job_stopped"); // never execute after a cancel
    const stream = new AbortController();
    let readLimit: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
        void cancelOperation(endpoint, owned.jobId, owned.operationId).catch(() => undefined);
        readLimit = setTimeout(() => stream.abort(), cancelReadMs);
    };
    owned.signal.addEventListener("abort", onAbort, { once: true });
    let text = "";
    let finished: Record<string, unknown> | undefined;
    let terminal: unknown;
    try {
        const admission = Math.min(OWNED_MAX_ADMISSION_MS, Math.max(1, Math.floor(remainingMs())));
        for await (const { event, data } of executeOperation(endpoint, owned.jobId, owned.operationId, body, admission, stream.signal)) {
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
    }
    const outcome = stoppedOutcome(terminal, owned.jobId, owned.operationId);
    if (!outcome) throw new Error("omlx_control_unresolved");
    const acknowledgement = { provider_id: target.url, job_id: owned.jobId, operation_id: owned.operationId };
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
    try { assertControlRequestSize(responsesRequest(target, request)); }
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
    const budgetMs = Math.min(OWNED_MAX_JOB_MS, Math.max(1, Math.floor(request.timeoutMs)));
    let inputFailure: string | undefined;
    const result = await runOwnedJob({
        providerId: target.url, stateDirectory, budgetMs, signal,
        drain: { ...OWNED_DRAIN, ...(options.drainBudgetMs === undefined ? {} : { budgetMs: options.drainBudgetMs }) },
        acquire: async () => async () => {},
        observe: marker => observeOwned(endpoint, target.url, marker),
    }, context => context.providerAction(async owned => {
        try { return await ownedAction(endpoint, target, request, owned, context.remainingMs,
            options.cancelReadMs ?? OWNED_CANCEL_READ_MS); }
        catch (error) {
            if (error instanceof OmlxError && ["omlx_image_invalid", "omlx_image_too_large"].includes(error.reason)) inputFailure = error.reason;
            throw error;
        }
    }));
    const quarantined = await (result.settled ?? Promise.resolve(result.quarantined));
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
    try { await recoverOwnedJob({ providerId: target.url, stateDirectory, observe: marker => observeOwned(endpoint, target.url, marker) }); }
    catch { throw new OmlxError("omlx_provider_quarantined"); }
}
