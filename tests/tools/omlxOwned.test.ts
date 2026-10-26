import { describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOmlxTarget, OmlxError, omlxModelTarget, type OmlxRequest } from "../../src/utils/omlxProvider.js";
import { ownedOmlxGenerate, recoverOwnedOmlx, splitThinking } from "../../src/utils/omlxOwned.js";
import { assertControlRequestSize, registerOperation } from "../../src/utils/omlxControl.js";
import { completes, endsWithoutTerminal, fakeControl, record, runsUntilCancel, sse, terminal } from "./omlxControlFake.js";

const MODEL = "synthetic-model";
const URL_ = "http://127.0.0.1:8000/v1";
const REQUEST: OmlxRequest = { messages: [{ role: "user", content: "hi" }], maxTokens: 64, temperature: 0, timeoutMs: 5_000, think: false };
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const target = () => createOmlxTarget(URL_, MODEL, 65536, "synthetic-provider-key");
const state = () => mkdtempSync(join(tmpdir(), "prism-owned-omlx-"));
const markerPath = (directory: string) => join(directory, createHash("sha256").update(URL_).digest("hex") + ".json");
const marker = (directory: string) => JSON.parse(readFileSync(markerPath(directory), "utf8"));

describe("owned oMLX generation through the control routes", () => {
    it.each([400,413])("reports image registration %s as input failure only after idle proof", async status => {
        const directory = state();
        const fake = fakeControl({ register: status, status: () => ({ status:404 }), cancel: () => ({ status:409 }) });
        const png = Buffer.from([137,80,78,71,13,10,26,10]).toString("base64");
        const result = await ownedOmlxGenerate(target(), { ...REQUEST, messages:[{role:"user",content:"image",images:[png]}] },
            new AbortController().signal, { fetchImpl:fake.fetchImpl,stateDirectory:directory,drainBudgetMs:300 });
        expect(result).toEqual({ ok:false,reason:status===413 ? "omlx_image_too_large" : "omlx_image_invalid" });
        expect(marker(directory).active).toBe(false);
        expect(fake.calls.some(call=>call.path.endsWith("/execute"))).toBe(false);
    });
    it("registers then executes a UUIDv7 operation, streams the text, and clears the marker on a stopped terminal", async () => {
        const directory = state(); const fake = fakeControl({ script: completes("Hello world") });
        const result = await ownedOmlxGenerate(target(), REQUEST, new AbortController().signal, { fetchImpl: fake.fetchImpl, stateDirectory: directory, drainBudgetMs: 300 });
        expect(result).toEqual({ ok: true, text: "Hello world", doneReason: "stop", promptTokens: 5, completionTokens: 2 });
        expect(fake.calls.map(call => call.method)).toEqual(["PUT", "POST", "GET"]);
        expect(fake.calls[1].path.endsWith("/execute")).toBe(true);
        const operationId = fake.calls[0].path.split("/").pop()!;
        expect(operationId).toMatch(UUID7);
        expect(fake.calls[0].body).toEqual({ request: { model: MODEL, input: REQUEST.messages, max_output_tokens: 64, temperature: 0,
            chat_template_kwargs: { enable_thinking: false } } });
        expect(fake.calls[1].body).toMatchObject({ request: fake.calls[0].body && (fake.calls[0].body as { request: unknown }).request });
        expect((fake.calls[1].body as { admission_timeout_ms: number }).admission_timeout_ms).toBeGreaterThanOrEqual(1);
        expect(marker(directory)).toMatchObject({ active: false, provider_started: true, operation_id: operationId });
        expect(fake.cancels()).toBe(0);
    });

    it("forwards the image capability settings digest to register and execute", async () => {
        const digest = "e".repeat(64);
        const on = createOmlxTarget(URL_, MODEL, 65536, "synthetic-provider-key", undefined, digest);
        const fake = fakeControl({ script: completes("digest") });
        expect(await ownedOmlxGenerate(on, REQUEST, new AbortController().signal,
            { fetchImpl: fake.fetchImpl, stateDirectory: state(), drainBudgetMs: 300 })).toMatchObject({ ok: true, text: "digest" });
        expect((fake.calls[0].body as any).expected_settings_sha256).toBe(digest);
        expect((fake.calls[1].body as any).expected_settings_sha256).toBe(digest);
        expect((fake.calls[0].body as any).request).not.toHaveProperty("expected_settings_sha256");
    });

    it("reports a stale settings refusal from registration only after the marker is inactive", async () => {
        const digest = "f".repeat(64); const directory = state();
        const base = fakeControl();
        const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
            const method = init?.method ?? "GET";
            if (method === "PUT") return new Response(JSON.stringify({ error: { code: "settings_changed" } }),
                { status: 409, headers: { "X-Prism-Control-Error": "settings_changed" } });
            if (method === "POST") return new Response("", { status: 409 });
            return base.fetchImpl(input, init);
        }) as typeof fetch;
        const result = await ownedOmlxGenerate(createOmlxTarget(URL_, MODEL, 65536, "synthetic-provider-key", undefined, digest), REQUEST,
            new AbortController().signal, { fetchImpl, stateDirectory: directory, drainBudgetMs: 300 });
        expect(result).toEqual({ ok: false, reason: "omlx_settings_changed" });
        expect(marker(directory).active).toBe(false);
        expect(base.calls.some(call => call.path.endsWith("/execute"))).toBe(false);
    });

    it("reports a stale settings refusal from execute without reading an error body", async () => {
        const digest = "1".repeat(64); const directory = state();
        const base = fakeControl();
        const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            if (path.endsWith("/execute")) {
                const response = new Response("ignored", { status: 409, headers: { "X-Prism-Control-Error": "settings_changed" } });
                Object.defineProperty(response, "body", { get() { throw Error("error_body_must_not_be_read"); } });
                response.text = async () => { throw Error("error_body_must_not_be_read"); };
                return response;
            }
            if ((init?.method ?? "GET") === "POST") return new Response("", { status: 409 });
            return base.fetchImpl(input, init);
        }) as typeof fetch;
        const result = await ownedOmlxGenerate(createOmlxTarget(URL_, MODEL, 65536, "synthetic-provider-key", undefined, digest), REQUEST,
            new AbortController().signal, { fetchImpl, stateDirectory: directory, drainBudgetMs: 300 });
        expect(result).toEqual({ ok: false, reason: "omlx_settings_changed" });
        expect(marker(directory).active).toBe(false);
    });

    it("keeps quarantine precedence when stale settings arrives with an unproved claim", async () => {
        const base = fakeControl(); const directory = state();
        const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            if (path.endsWith("/execute")) return new Response(null, { status: 409, headers: { "X-Prism-Control-Error": "settings_changed" } });
            if (path.endsWith("/cancel")) return new Response(null, { status: 409 });
            if ((init?.method ?? "GET") === "GET") {
                const parts = path.split("/");
                return Response.json({ version: 3, claim_state: "claimed", job_id: decodeURIComponent(parts.at(-3)!), operation_id: decodeURIComponent(parts.at(-1)!) });
            }
            return base.fetchImpl(input, init);
        }) as typeof fetch;
        const result = await ownedOmlxGenerate(createOmlxTarget(URL_, MODEL, 65536, "synthetic-provider-key", undefined, "2".repeat(64)), REQUEST,
            new AbortController().signal, { fetchImpl, stateDirectory: directory, drainBudgetMs: 300 });
        expect(result).toEqual({ ok: false, reason: "omlx_stop_unproved" });
        expect(marker(directory).active).toBe(true);
    });

    it("counts the settings expectation in the envelope before any registration fetch", () => {
        const fake = fakeControl();
        const body = { model: MODEL, input: "", max_output_tokens: 1 };
        const maximumBodyBytes = 256 * 1024;
        const overhead = Buffer.byteLength(JSON.stringify({ request: body, admission_timeout_ms: Number.MAX_SAFE_INTEGER }), "utf8");
        body.input = "x".repeat(maximumBodyBytes - overhead);
        expect(() => assertControlRequestSize(body)).not.toThrow();
        expect(() => registerOperation({ base: URL_, apiKey: randomUUID(), fetchImpl: fake.fetchImpl },
            "job", "operation", body, "a".repeat(64))).toThrow("omlx_control_request_too_large");
        expect(fake.calls).toEqual([]);
    });

    it("leaves unset sampling and thinking out of the request, while an explicit zero is sent", async () => {
        const fake = fakeControl();
        await ownedOmlxGenerate(target(), { ...REQUEST, temperature: undefined, think: undefined }, new AbortController().signal,
            { fetchImpl: fake.fetchImpl, stateDirectory: state(), drainBudgetMs: 300 });
        const sent = (fake.calls[0].body as { request: Record<string, unknown> }).request;
        expect(sent).not.toHaveProperty("temperature"); expect(sent).not.toHaveProperty("chat_template_kwargs");
        const zero = fakeControl();
        await ownedOmlxGenerate(target(), REQUEST, new AbortController().signal, { fetchImpl: zero.fetchImpl, stateDirectory: state(), drainBudgetMs: 300 });
        expect((zero.calls[0].body as { request: Record<string, unknown> }).request.temperature).toBe(0);
    });

    it("asks the provider not to keep the prompt cache only when the request opts out", async () => {
        const sent = async (request: OmlxRequest, on = target()) => {
            const fake = fakeControl();
            const result = await ownedOmlxGenerate(on, request, new AbortController().signal, { fetchImpl: fake.fetchImpl, stateDirectory: state(), drainBudgetMs: 300 });
            expect(result.ok).toBe(true);
            return (fake.calls[0].body as { request: Record<string, unknown> }).request;
        };
        expect((await sent({ ...REQUEST, cacheStore: false })).prompt_cache_retention).toBe("none");
        expect(await sent(REQUEST)).not.toHaveProperty("prompt_cache_retention");
        expect(await sent({ ...REQUEST, cacheStore: true })).not.toHaveProperty("prompt_cache_retention");
        // Another model on the same server keeps the URL, context and credential.
        const sibling = omlxModelTarget(target(), "synthetic-classifier");
        expect(sibling).toEqual({ url: URL_, model: "synthetic-classifier", contextTokens: 65536 });
        expect((await sent(REQUEST, sibling)).model).toBe("synthetic-classifier");
    });

    it("splits thinking at the first closing tag, with or without the opener", () => {
        expect(splitThinking("<think>plan</think>answer")).toEqual({ text: "answer", thinking: "plan" });
        expect(splitThinking("plan\n</think>\nanswer")).toEqual({ text: "answer", thinking: "plan" });
        expect(splitThinking("answer")).toEqual({ text: "answer" });
        expect(splitThinking("<think>never closed")).toBeUndefined();
    });

    it.each([
        ["failed", "omlx_failed"], ["cancelled", "timeout"], ["not_started", "omlx_not_admitted"],
    ])("maps a stopped %s terminal to %s and clears the marker", async (state_, reason) => {
        const directory = state();
        const fake = fakeControl({ script: async function* (ids) { yield sse("terminal", terminal(ids, state_)); } });
        expect(await ownedOmlxGenerate(target(), REQUEST, new AbortController().signal, { fetchImpl: fake.fetchImpl, stateDirectory: directory, drainBudgetMs: 300 })).toEqual({ ok: false, reason });
        expect(marker(directory).active).toBe(false);
    });

    it.each([undefined, null, "tool_calls", "content_filter"])("never promotes completion state %j", async finish_reason => {
        const fake = fakeControl({ script: completes("Hello", finish_reason as string) });
        expect(await ownedOmlxGenerate(target(), REQUEST, new AbortController().signal, { fetchImpl: fake.fetchImpl, stateDirectory: state(), drainBudgetMs: 300 }))
            .toEqual({ ok: false, reason: "omlx_finish_reason_invalid" });
    });

    it.each([
        ["a wrong version", { version: 2 }], ["an unfinished claim", { claim_state: "claimed" }],
        ["no stop proof", { backend_stopped: false }], ["another operation", { operation_id: "00000000-0000-7000-8000-000000000000" }],
    ])("does not acknowledge a terminal with %s; only the status proof clears it, and nothing is served", async (_name, fields) => {
        const directory = state();
        const fake = fakeControl({
            script: async function* (ids) {
                yield sse("delta", { text: "unserved" }); yield sse("finished", { finish_reason: "stop" });
                yield sse("terminal", terminal(ids, "completed", fields)); },
            status: ids => ({ status: 200, body: terminal(ids, "completed") }),
        });
        expect(await ownedOmlxGenerate(target(), REQUEST, new AbortController().signal, { fetchImpl: fake.fetchImpl, stateDirectory: directory, drainBudgetMs: 300 }))
            .toEqual({ ok: false, reason: "omlx_control_error" });
        expect(marker(directory).active).toBe(false);
    });

    it("on abort sends one cancel, reads the cancelled terminal, and returns only after the marker is settled", async () => {
        const directory = state(); const fake = fakeControl({ script: runsUntilCancel,
            status: ids => ({ status: 200, body: terminal(ids, "cancelled") }) });
        const controller = new AbortController();
        const pending = ownedOmlxGenerate(target(), REQUEST, controller.signal, { fetchImpl: fake.fetchImpl, stateDirectory: directory, drainBudgetMs: 300 });
        while (!fake.calls.some(call => call.path.endsWith("/execute"))) await new Promise(r => setTimeout(r, 5));
        controller.abort();
        expect(await pending).toEqual({ ok: false, reason: "timeout" });
        expect(fake.cancels()).toBe(1);
        expect(marker(directory).active).toBe(false);
    });

    it("cancels at the job deadline, so the provider can retire the operation", async () => {
        const directory = state(); const fake = fakeControl({ script: runsUntilCancel,
            status: ids => ({ status: 200, body: terminal(ids, "cancelled") }) });
        expect(await ownedOmlxGenerate(target(), { ...REQUEST, timeoutMs: 150 }, new AbortController().signal, { fetchImpl: fake.fetchImpl, stateDirectory: directory, drainBudgetMs: 300 }))
            .toEqual({ ok: false, reason: "timeout" });
        expect(fake.cancels()).toBe(1);
        expect(marker(directory).active).toBe(false);
    });

    it("never registers after an abort", async () => {
        const fake = fakeControl(); const controller = new AbortController(); controller.abort();
        await ownedOmlxGenerate(target(), REQUEST, controller.signal, { fetchImpl: fake.fetchImpl, stateDirectory: state(), drainBudgetMs: 300 });
        expect(fake.calls).toEqual([]);
    });

    it("stops reading a stream that never ends after its cancel, at the read bound", async () => {
        const controller = new AbortController();
        const fake = fakeControl({ script: async function* (_ids, control) {
            yield sse("claimed", { state: "claimed" }); await control.cancelled; await new Promise(() => undefined); } });
        const started = Date.now();
        const pending = ownedOmlxGenerate(target(), REQUEST, controller.signal,
            { fetchImpl: fake.fetchImpl, stateDirectory: state(), drainBudgetMs: 200, cancelReadMs: 50 });
        while (!fake.calls.some(call => call.path.endsWith("/execute"))) await new Promise(r => setTimeout(r, 5));
        controller.abort();
        expect(await pending).toEqual({ ok: false, reason: "omlx_stop_unproved" });
        expect(Date.now() - started).toBeLessThan(3_000);
    });

    it("never executes when the abort lands while registering", async () => {
        const controller = new AbortController();
        const fake = fakeControl({ onRegister: () => controller.abort() });
        await ownedOmlxGenerate(target(), REQUEST, controller.signal, { fetchImpl: fake.fetchImpl, stateDirectory: state(), drainBudgetMs: 300 });
        expect(fake.calls.some(call => call.path.endsWith("/execute"))).toBe(false);
    });

    it("ends the read on an event name the coordinator never sends", async () => {
        const directory = state();
        const fake = fakeControl({ script: async function* (ids) {
            yield sse("surprise", {}); yield sse("delta", { text: "unserved" }); yield sse("finished", { finish_reason: "stop" });
            yield sse("terminal", terminal(ids, "completed")); },
            status: ids => ({ status: 200, body: terminal(ids, "completed") }) });
        expect(await ownedOmlxGenerate(target(), REQUEST, new AbortController().signal, { fetchImpl: fake.fetchImpl, stateDirectory: directory, drainBudgetMs: 300 }))
            .toEqual({ ok: false, reason: "omlx_control_error" });
    });

    it("keeps the quarantine while the status shows a claim, and clears it on a terminal", async () => {
        const kept = state();
        const claimed = fakeControl({ script: endsWithoutTerminal, status: ids => ({ status: 200, body: record(ids, { state: "claimed", claim_state: "claimed" }) }) });
        expect(await ownedOmlxGenerate(target(), REQUEST, new AbortController().signal, { fetchImpl: claimed.fetchImpl, stateDirectory: kept, drainBudgetMs: 300 })).toEqual({ ok: false, reason: "omlx_stop_unproved" });
        expect(marker(kept).active).toBe(true);
        const cleared = state();
        const done = fakeControl({ script: endsWithoutTerminal, status: ids => ({ status: 200, body: terminal(ids, "completed") }) });
        expect(await ownedOmlxGenerate(target(), REQUEST, new AbortController().signal, { fetchImpl: done.fetchImpl, stateDirectory: cleared, drainBudgetMs: 300 })).toEqual({ ok: false, reason: "omlx_control_error" });
        expect(marker(cleared).active).toBe(false);
    });

    it("refuses an unsupported profile key before any request", async () => {
        const fake = fakeControl();
        expect(await ownedOmlxGenerate(target(), { ...REQUEST, profile: { top_p: 0.9 } }, new AbortController().signal, { fetchImpl: fake.fetchImpl, stateDirectory: state(), drainBudgetMs: 300 }))
            .toEqual({ ok: false, reason: "omlx_profile_unsupported" });
        expect(fake.calls).toEqual([]);
    });
});

describe("recovery of a stale owned marker", () => {
    const stale = (directory: string, fields: Record<string, unknown> = {}) => writeFileSync(markerPath(directory), JSON.stringify({
        version: 2, provider_hash: createHash("sha256").update(URL_).digest("hex"), job_id: "11111111-1111-4111-8111-111111111111",
        operation_id: "01900000-0000-7000-8000-000000000001", provider_request_id: null, provider_started: true, active: true, ...fields }), { mode: 0o600 });

    it.each([
        ["a stopped terminal", { status: ids => ({ status: 200, body: terminal(ids, "completed") }) }],
        ["a 404 cancelled into a claimless tombstone", { cancel: ids => ({ status: 200, body: record(ids, { state: "cancel_requested", claim_state: "none" }) }) }],
        ["a 404 whose cancel is refused (no registration)", { cancel: () => ({ status: 409 }) }],
        ["a registration that never ran", { status: ids => ({ status: 200, body: record(ids, { state: "registered", claim_state: "none" }) }),
            cancel: ids => ({ status: 200, body: record(ids, { state: "cancel_requested", claim_state: "none" }) }) }],
    ])("clears it on %s", async (_name, options) => {
        const directory = state(); stale(directory);
        await recoverOwnedOmlx(target(), { fetchImpl: fakeControl(options as never).fetchImpl, stateDirectory: directory });
        expect(marker(directory).active).toBe(false);
    });

    it.each([
        ["a live claim", { status: (ids: never) => ({ status: 200, body: record(ids, { state: "claimed", claim_state: "claimed" }) }) }],
        ["an unknown claim", { status: (ids: never) => ({ status: 200, body: record(ids, { state: "unknown", claim_state: "unknown" }) }) }],
    ])("refuses on %s and keeps the marker", async (_name, options) => {
        const directory = state(); stale(directory); const fake = fakeControl(options as never);
        await expect(recoverOwnedOmlx(target(), { fetchImpl: fake.fetchImpl, stateDirectory: directory })).rejects.toThrow(OmlxError);
        expect(marker(directory).active).toBe(true);
        expect(fake.cancels()).toBe(0); // live or unknown work is never cancelled by recovery
    });

    it("refuses when the provider cannot be reached, and keeps the marker", async () => {
        const directory = state(); stale(directory);
        const unreachable = (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;
        await expect(recoverOwnedOmlx(target(), { fetchImpl: unreachable, stateDirectory: directory })).rejects.toThrow(OmlxError);
        expect(marker(directory).active).toBe(true);
    });

    it("does nothing without a marker, and a never-dispatched marker clears without a request", async () => {
        const empty = state(); const quiet = fakeControl();
        await recoverOwnedOmlx(target(), { fetchImpl: quiet.fetchImpl, stateDirectory: empty });
        expect(existsSync(markerPath(empty))).toBe(false);
        const undispatched = state(); stale(undispatched, { provider_started: false, operation_id: null });
        await recoverOwnedOmlx(target(), { fetchImpl: quiet.fetchImpl, stateDirectory: undispatched });
        expect(marker(undispatched).active).toBe(false);
        expect(quiet.calls).toEqual([]);
    });
});
