/** A synthetic oMLX control server behind an injected fetch: register,
 * execute (a server-sent event stream), cancel and status. */
export interface Ids { jobId: string; operationId: string; model?: string; settingsSha256?: string }
export type Script = (ids: Ids, control: { cancelled: Promise<void> }) => AsyncGenerator<string>;
export interface FakeOptions {
    script?: Script;
    register?: number;
    onRegister?: () => void;
    status?: (ids: Ids) => { status: number; body?: unknown };
    cancel?: (ids: Ids) => { status: number; body?: unknown };
}

export const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const STORE_GENERATION = "00000000-0000-4000-8000-000000000000";
export const record = (ids: Ids, fields: Record<string, unknown>) => ({
    version: 3, job_id: ids.jobId, operation_id: ids.operationId, model_id: ids.model ?? "synthetic-model",
    request_sha256: "c".repeat(64), settings_sha256: ids.settingsSha256 ?? "d".repeat(64), store_generation_id: STORE_GENERATION,
    engine_generation_verified: false, provider_qualified: false, production_enabled: false, ...fields,
});
export const terminal = (ids: Ids, state: string, fields: Record<string, unknown> = {}) =>
    record(ids, { state, claim_state: "finished", backend_stopped: true, claim_store_generation_id: STORE_GENERATION,
        cancel_requested: false, evidence: [], ...fields });
export const cancellation = (ids: Ids, claimed: boolean, generation = STORE_GENERATION) => ({
    version: 3, job_id: ids.jobId, operation_id: ids.operationId, store_generation_id: generation,
    state: "cancel_requested", backend_stopped: false, claim_state: claimed ? "claimed" : "none",
    claim_store_generation_id: claimed ? generation : null,
});

// An explicit undefined finish reason is kept; only an omitted one means "stop".
export const completes = (text = "Hello", ...finish: unknown[]): Script => async function* (ids) {
    const finish_reason = finish.length ? finish[0] : "stop";
    yield sse("claimed", { state: "claimed" });
    for (const part of [text.slice(0, 2), text.slice(2)]) yield sse("delta", { text: part, prompt_tokens: 5, completion_tokens: 1 });
    yield sse("finished", { finish_reason, prompt_tokens: 5, completion_tokens: 2 });
    yield sse("terminal", terminal(ids, "completed", { evidence: ["finished_output", "absent_proved", "stream_synchronized"] }));
};
export const runsUntilCancel: Script = async function* (ids, control) {
    yield sse("claimed", { state: "claimed" });
    yield sse("delta", { text: "partial", prompt_tokens: 5, completion_tokens: 1 });
    await control.cancelled;
    yield sse("terminal", terminal(ids, "cancelled", { evidence: ["waiting_cleaned", "stream_synchronized"], cancel_requested: true }));
};
export const endsWithoutTerminal: Script = async function* () {
    yield sse("claimed", { state: "claimed" });
    yield sse("delta", { text: "partial", prompt_tokens: 5, completion_tokens: 1 });
};

function json(status: number, body?: unknown): Response {
    return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function fakeControl(options: FakeOptions = {}) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    // Like the store: a streamed terminal is what status and cancel report afterwards.
    const terminals = new Map<string, Record<string, unknown>>();
    const registrations = new Map<string, Ids>();
    const cancellations = new Map<string, string>();
    const claimed = new Set<string>();
    let onCancel!: () => void;
    const cancelled = new Promise<void>(resolve => { onCancel = resolve; });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
        calls.push({ method, path: url.pathname, body });
        const match = url.pathname.match(/^\/prism-control\/v1\/jobs\/([^/]+)\/operations\/([^/]+)(\/[a-z]+)?$/);
        if (!match) return json(404);
        const operationId = decodeURIComponent(match[2]);
        const ids = registrations.get(operationId) ?? { jobId: decodeURIComponent(match[1]), operationId };
        if (method === "PUT") {
            options.onRegister?.();
            const status = options.register ?? 200;
            const bound = { ...ids, model: body?.request?.model, settingsSha256: body?.expected_settings_sha256 };
            if (status === 200) registrations.set(operationId, bound);
            return json(status, record(bound, { state: "registered", claim_state: "none" }));
        }
        if (match[3] === "/cancel") {
            onCancel();
            const stored = terminals.get(ids.operationId);
            const reply = options.cancel?.(ids) ?? (stored ? { status: 200, body: { ...stored, cancel_requested: true } }
                : { status: 200, body: cancellation(ids, claimed.has(operationId)) });
            if (!stored && reply.status === 200) cancellations.set(operationId, STORE_GENERATION);
            return json(reply.status, reply.body);
        }
        if (match[3] === "/execute") {
            const script = (options.script ?? completes())(ids, { cancelled });
            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
                },
                async pull(controller) {
                    const next = await script.next();
                    if (next.done) { controller.close(); return; }
                    if (next.value.startsWith("event: claimed\n")) claimed.add(operationId);
                    if (next.value.startsWith("event: terminal\n")) {
                        const data = JSON.parse(next.value.split("\ndata: ")[1]);
                        if (data?.operation_id === ids.operationId) terminals.set(ids.operationId, data);
                    }
                    controller.enqueue(encoder.encode(next.value));
                },
                cancel() { void script.return(undefined); },
            });
            return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        const stored = terminals.get(ids.operationId);
        const cancelledIn = cancellations.get(operationId);
        const claimedHere = claimed.has(operationId);
        const reply = options.status?.(ids) ?? (stored ? { status: 200, body: stored }
            : cancelledIn ? { status: 200, body: cancellation(ids, claimedHere, cancelledIn) }
            : registrations.has(operationId) ? { status: 200, body: record(ids, claimedHere
                ? { state: "claimed", claim_state: "claimed", claim_store_generation_id: STORE_GENERATION }
                : { state: "registered", claim_state: "none", backend_stopped: false }) } : { status: 404 });
        return json(reply.status, reply.body);
    }) as typeof fetch;
    return { fetchImpl, calls, cancels: () => calls.filter(call => call.path.endsWith("/cancel")).length };
}
