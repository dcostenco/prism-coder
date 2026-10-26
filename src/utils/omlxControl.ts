/** Client for oMLX's provider-control routes: register, execute (a
 * server-sent event stream), cancel and status. The key and the fetch are
 * passed in by the caller; nothing here is persisted or logged. */

const CALL_TIMEOUT_MS = 2_000;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 256 * 1024;
const EVENTS = new Set(["claimed", "delta", "finished", "terminal", "unresolved"]);

export interface ControlEndpoint { readonly base: string; readonly apiKey: string; readonly fetchImpl: typeof fetch }
export interface ControlReply { status: number; body: unknown }
export interface ControlEvent { event: string; data: unknown }

function operationUrl(endpoint: ControlEndpoint, jobId: string, operationId: string, suffix = ""): string {
    return `${endpoint.base}/jobs/${encodeURIComponent(jobId)}/operations/${encodeURIComponent(operationId)}${suffix}`;
}

function headers(endpoint: ControlEndpoint, body: boolean): Record<string, string> {
    return { Authorization: `Bearer ${endpoint.apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) };
}

function requestBody(value: unknown): string {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new Error("omlx_control_request_too_large");
    return text;
}

async function call(endpoint: ControlEndpoint, method: string, url: string, body?: unknown): Promise<ControlReply> {
    const response = await endpoint.fetchImpl(url, {
        method, headers: headers(endpoint, body !== undefined),
        ...(body === undefined ? {} : { body: requestBody(body) }),
        redirect: "error", signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) return { status: response.status, body: undefined };
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    return { status: response.status, body: parsed };
}

export function registerOperation(endpoint: ControlEndpoint, jobId: string, operationId: string, request: unknown): Promise<ControlReply> {
    // Reserve the larger execute envelope before creating a durable operation.
    assertControlRequestSize(request);
    return call(endpoint, "PUT", operationUrl(endpoint, jobId, operationId), { request });
}

export function assertControlRequestSize(request: unknown): void {
    requestBody({ request, admission_timeout_ms: Number.MAX_SAFE_INTEGER });
}

export function cancelOperation(endpoint: ControlEndpoint, jobId: string, operationId: string): Promise<ControlReply> {
    return call(endpoint, "POST", operationUrl(endpoint, jobId, operationId, "/cancel"));
}

export function operationStatus(endpoint: ControlEndpoint, jobId: string, operationId: string): Promise<ControlReply> {
    return call(endpoint, "GET", operationUrl(endpoint, jobId, operationId));
}

/** Execute and yield the stream's events in order. Only the five event names
 * the coordinator sends are accepted; anything else ends the read. */
export async function* executeOperation(endpoint: ControlEndpoint, jobId: string, operationId: string, request: unknown,
    admissionTimeoutMs: number, signal: AbortSignal): AsyncGenerator<ControlEvent> {
    const response = await endpoint.fetchImpl(operationUrl(endpoint, jobId, operationId, "/execute"), {
        method: "POST", headers: headers(endpoint, true),
        body: requestBody({ request, admission_timeout_ms: admissionTimeoutMs }),
        redirect: "error", signal,
    });
    if (!response.ok || !response.body) throw new Error(`omlx_control_http_${response.status}`);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            let event = "", data = "";
            for (const line of block.split("\n")) {
                if (line.startsWith("event: ")) event = line.slice(7);
                else if (line.startsWith("data: ")) data += line.slice(6);
            }
            if (!EVENTS.has(event)) throw new Error("omlx_control_event_invalid");
            yield { event, data: data ? JSON.parse(data) : undefined };
        }
        if (buffer.length > MAX_EVENT_BYTES) throw new Error("omlx_control_event_too_large");
    }
}
