import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import { tmpdir } from "node:os";
import { unloadOllamaModel, waitForOllamaUnloadDrain } from "../../src/tools/prismInferHandler.js";
import { createOmlxTarget, createOmlxRuntime, detectOmlx, guardedOmlxGenerate,
    withInferenceResourceLease, withOllamaResourceLease, type OmlxRuntime, type OmlxTarget, type OmlxRequest } from "../../src/utils/omlxProvider.js";

const MODEL = "Qwen3.8-Flash-Next-oQ8e-mtp";
const FAKE_KEY = "synthetic-test-key-do-not-relay";
const TARGET: OmlxTarget = createOmlxTarget("http://127.0.0.1:8000/v1", MODEL, 65536, FAKE_KEY);
const REQUEST: OmlxRequest = { messages: [{ role: "user", content: "Draft a helper" }], maxTokens: 256, temperature: 0, timeoutMs: 100, think: false };
const homes: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function config() {
    const home = await mkdtemp(join(tmpdir(), "prism-omlx-test-")); homes.push(home);
    await mkdir(join(home, ".omlx"));
    await writeFile(join(home, ".omlx/settings.json"), JSON.stringify({ server: { host: "127.0.0.1", port: 8000 }, auth: { api_key: FAKE_KEY }, sampling: { max_context_window: 32768 } }));
    await writeFile(join(home, ".omlx/model_settings.json"), JSON.stringify({ models: { [MODEL]: { max_context_window: 65536, is_default: true } } }));
    return home;
}
const fetchModels = () => vi.fn(async () => new Response(JSON.stringify({ data: [{ id: MODEL }] }))) as unknown as typeof fetch;
function runtime(overrides: Partial<OmlxRuntime> = {}): OmlxRuntime {
    return { detect: async () => TARGET, acquire: async () => async () => {}, listLoaded: async () => new Set(), unload: async () => {},
        generate: async () => ({ ok: true, text: "draft", doneReason: "stop" }), ...overrides };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

describe("authenticated oMLX discovery", () => {
    it("an event-loop-blocking resource probe cannot start generation after the absolute deadline", async () => {
        const generate = vi.fn(async () => ({ ok: true as const, text: "draft", doneReason: "stop" }));
        const blocked = runtime({ generate, listLoaded: async () => {
            const start = Date.now(); while (Date.now() - start < 25) { /* synthetic blocking probe */ }
            return new Set();
        } });
        expect(await guardedOmlxGenerate(blocked, TARGET, { ...REQUEST, timeoutMs: 1 }, () => 30 * 1024 ** 3))
            .toMatchObject({ ok: false, reason: "timeout" });
        expect(generate).not.toHaveBeenCalled();
    });
    it("uses trusted configuration, exact advertised identity, and a redirect-free authenticated probe", async () => {
        const home = await config(); const fetchImpl = fetchModels();
        const target = await detectOmlx(undefined, { home, env: {}, fetchImpl });
        expect(target).toEqual(TARGET);
        expect(JSON.stringify(target)).not.toContain(FAKE_KEY);
        expect(Object.keys(target)).not.toContain("apiKey");
        expect(inspect(target, { showHidden: true })).not.toContain(FAKE_KEY);
        expect(inspect(target, { showHidden: true })).not.toContain("apiKey");
        expect(fetchImpl).toHaveBeenCalledWith(TARGET.url + "/models", expect.objectContaining({ headers: { Authorization: `Bearer ${FAKE_KEY}` }, redirect: "error", signal: expect.any(AbortSignal) }));
    });
    it("accepts an environment key without exposing it in failures", async () => {
        const home = await config();
        const fetchImpl = vi.fn(async () => { throw new Error(FAKE_KEY); }) as unknown as typeof fetch;
        await expect(detectOmlx(MODEL, { home, env: { OMLX_API_KEY: FAKE_KEY }, fetchImpl })).rejects.toThrow("omlx_detection_unavailable");
        const error = await detectOmlx(MODEL, { home, env: {}, fetchImpl }).catch(e => e);
        expect(String(error)).not.toContain(FAKE_KEY);
    });
    it.each([401, 403, 503])("refuses model discovery HTTP %i without returning server bodies", async status => {
        const home = await config();
        const fetchImpl = vi.fn(async () => new Response(FAKE_KEY, { status })) as unknown as typeof fetch;
        const error = await detectOmlx(MODEL, { home, env: {}, fetchImpl }).catch(e => e);
        expect(error.reason).toBe(status === 503 ? "omlx_models_http_503" : "omlx_auth_failed");
        expect(String(error)).not.toContain(FAKE_KEY);
    });
    it("refuses an absent or mismatched advertised model", async () => {
        const home = await config();
        for (const data of [[], [{ id: "another-model" }]]) {
            const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data }))) as unknown as typeof fetch;
            await expect(detectOmlx(MODEL, { home, env: {}, fetchImpl })).rejects.toThrow("omlx_model_not_advertised");
        }
    });
    it.each(["https://example.com/v1", "http://192.168.1.1/v1", "http://127.0.0.1.evil/v1", "http://user:secret@127.0.0.1:8000/v1", "http://127.0.0.1:8000/v1?key=secret"])("refuses non-loopback or credential-bearing endpoint %s before fetch", async url => {
        const home = await config(); const fetchImpl = fetchModels();
        await expect(detectOmlx(MODEL, { home, env: { OMLX_BASE_URL: url }, fetchImpl })).rejects.toThrow("omlx_local_endpoint_required");
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it("refuses a remote Ollama classification/resource endpoint for an explicit local backend", async () => {
        const listLoaded = vi.fn(async () => new Set<string>()); const unload = vi.fn(async () => {});
        const detect = vi.fn(async () => TARGET);
        const r = createOmlxRuntime({ listLoaded, unload, detect, generate: async () => ({ ok: false, reason: "unused" }) }, "http://192.168.1.1:11434");
        await expect(r.detect(MODEL)).rejects.toThrow("omlx_local_endpoint_required");
        expect(listLoaded).not.toHaveBeenCalled(); expect(unload).not.toHaveBeenCalled(); expect(detect).not.toHaveBeenCalled();
    });
    it("requires authentication before making any request", async () => {
        const home = await config();
        await writeFile(join(home, ".omlx/settings.json"), "{}");
        const fetchImpl = fetchModels();
        await expect(detectOmlx(MODEL, { home, env: {}, fetchImpl })).rejects.toThrow("omlx_auth_unavailable");
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe("oMLX transport and resource protection", () => {
    it("uses only the reversible existing Ollama unload endpoint and checks HTTP failures", async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ done: true, done_reason: "unload" }))) as unknown as typeof fetch;
        await unloadOllamaModel("http://127.0.0.1:11434", "any-model", fetchImpl);
        expect(JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0][1]!.body))).toEqual({ model: "any-model", keep_alive: 0 });
        const failure = vi.fn(async () => new Response(FAKE_KEY, { status: 500 })) as unknown as typeof fetch;
        await expect(unloadOllamaModel("http://127.0.0.1:11434", "any-model", failure)).rejects.toThrow("omlx_ollama_unload_failed");
    });
    it.each([{}, { done: false }, { done: true, done_reason: "stop" }, { done: true, error: FAKE_KEY }, "malformed"])("rejects an invalid unload acknowledgment without relaying its body", async payload => {
        const fetchImpl = vi.fn(async () => new Response(typeof payload === "string" ? payload : JSON.stringify(payload))) as unknown as typeof fetch;
        const error = await unloadOllamaModel("http://127.0.0.1:11434", "any-model", fetchImpl).catch(error => error);
        expect(error).toBeInstanceOf(Error); expect(error.message).toBe("omlx_ollama_unload_failed");
        expect(String(error)).not.toContain(FAKE_KEY);
    });
    it("accepts a positive legacy unload acknowledgment without done_reason", async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ done: true }))) as unknown as typeof fetch;
        await expect(unloadOllamaModel("http://127.0.0.1:11434", "any-model", fetchImpl)).resolves.toBeUndefined();
    });
    it("waits for acknowledged models to drain instead of treating the first warm sample as failure", async () => {
        const states = [new Set(["first", "second"]), new Set(["second"]), new Set<string>()];
        const listLoaded = vi.fn(async () => states.shift()!);
        await waitForOllamaUnloadDrain(listLoaded, new Set(["first", "second"]), 100, 2);
        expect(listLoaded).toHaveBeenCalledTimes(3);
    });
    it("does not wait through a newcomer or infer emptiness from a failed/hung probe", async () => {
        await expect(waitForOllamaUnloadDrain(async () => new Set(["foreign"]), new Set(["original"]), 30, 2)).rejects.toThrow("omlx_memory_contention");
        await expect(waitForOllamaUnloadDrain(async () => { throw new Error(FAKE_KEY); }, new Set(), 30, 2)).rejects.toThrow("omlx_ollama_state_unavailable");
        await expect(waitForOllamaUnloadDrain(() => new Promise(() => {}), new Set(), 10, 2)).rejects.toThrow("omlx_ollama_state_unavailable");
    });
    it("refuses a persistent known model at the bounded deadline", async () => {
        await expect(waitForOllamaUnloadDrain(async () => new Set(["original"]), new Set(["original"]), 10, 2)).rejects.toThrow("omlx_ollama_unload_incomplete");
    });
    it("blocks real daemon ports before network I/O while explicit mock transports remain usable", async () => {
        for (const url of ["http://127.0.0.1:11434/api/generate", "http://localhost:8000/v1/chat/completions"]) {
            await expect(fetch(url)).rejects.toThrow("Live local model HTTP is forbidden in unit tests");
        }
    });
    it("refuses unknown Ollama state or low memory before generation", async () => {
        for (const listLoaded of [async () => new Set(["contender"]), async () => { throw new Error(FAKE_KEY); }]) {
            const generate = vi.fn(runtime().generate);
            const result = await guardedOmlxGenerate(runtime({ listLoaded, generate }), TARGET, REQUEST, () => 8 * 1024 ** 3);
            expect(result.ok).toBe(false); expect(generate).not.toHaveBeenCalled();
        }
        const generate = vi.fn(runtime().generate);
        expect(await guardedOmlxGenerate(runtime({ generate }), TARGET, REQUEST, () => 1)).toEqual({ ok: false, reason: "omlx_memory_pressure" });
        expect(generate).not.toHaveBeenCalled();
    });
    it("rejects contention during inference and aborts the pending generation", async () => {
        let probes = 0; let signal!: AbortSignal;
        const r = runtime({ listLoaded: async () => new Set(++probes > 1 ? ["contender"] : []),
            generate: async (_target, _request, s) => { signal = s; return new Promise(resolve => s.addEventListener("abort", () => resolve({ ok: false, reason: "aborted" }), { once: true })); } });
        expect(await guardedOmlxGenerate(r, TARGET, REQUEST, () => 8 * 1024 ** 3, 2)).toEqual({ ok: false, reason: "omlx_memory_contention" });
        expect(signal.aborted).toBe(true);
    });
    it("rejects a result if memory pressure appeared during inference", async () => {
        let free = 8 * 1024 ** 3;
        const r = runtime({ generate: async () => { free = 1; return { ok: true, text: "draft" }; } });
        expect(await guardedOmlxGenerate(r, TARGET, REQUEST, () => free)).toEqual({ ok: false, reason: "omlx_memory_pressure" });
    });
    it("enforces a hard timeout even if a generation dependency never resolves", async () => {
        let signal!: AbortSignal;
        const r = runtime({ generate: async (_target, _request, s) => { signal = s; return new Promise(() => {}); } });
        expect(await guardedOmlxGenerate(r, TARGET, { ...REQUEST, timeoutMs: 10 }, () => 8 * 1024 ** 3)).toEqual({ ok: false, reason: "timeout" });
        expect(signal.aborted).toBe(true);
    });
    it("bounds resource probes too and never generates after a timed-out probe finishes late", async () => {
        let finish!: (loaded: Set<string>) => void;
        const generate = vi.fn(runtime().generate);
        const r = runtime({ generate, listLoaded: () => new Promise(resolve => { finish = resolve; }) });
        expect(await guardedOmlxGenerate(r, TARGET, { ...REQUEST, timeoutMs: 10 }, () => 8 * 1024 ** 3)).toEqual({ ok: false, reason: "timeout" });
        finish(new Set()); await new Promise(resolve => setTimeout(resolve, 1));
        expect(generate).not.toHaveBeenCalled();
    });
    it("serializes exclusive calls, blocks classification readers, and releases after an error", async () => {
        const hold = deferred(); const events: string[] = [];
        const first = withInferenceResourceLease(true, async () => { events.push("first"); await hold.promise; throw new Error("test"); });
        const reader = withInferenceResourceLease(false, async () => { events.push("reader"); });
        const second = withInferenceResourceLease(true, async () => { events.push("second"); });
        await new Promise(resolve => setTimeout(resolve, 5)); expect(events).toEqual(["first"]);
        hold.resolve(); await expect(first).rejects.toThrow("test"); await Promise.all([reader, second]);
        expect(events).toEqual(["first", "reader", "second"]);
    });
});

describe("cross-process device exclusion", () => {
    it("refuses a second process while the lease is held and recovers on process exit without lock-file cleanup", async () => {
        const { createServer } = await import("node:net");
        const { spawn } = await import("node:child_process");
        const { once } = await import("node:events");
        const { acquireOmlxLease } = await import("../../src/utils/omlxProvider.js");
        const stateDirectory = await mkdtemp(join(tmpdir(), "prism-device-lease-test-")); homes.push(stateDirectory);
        const temporary = createServer();
        await new Promise<void>(resolve => temporary.listen(0, "127.0.0.1", resolve));
        const port = (temporary.address() as import("node:net").AddressInfo).port;
        await new Promise<void>(resolve => temporary.close(() => resolve()));
        const moduleUrl = new URL("../../src/utils/omlxProvider.ts", import.meta.url).href;
        const script = `import { acquireOmlxLease } from ${JSON.stringify(moduleUrl)}; await acquireOmlxLease(${port}, {stateDirectory:${JSON.stringify(stateDirectory)}}); console.log('held'); process.stdin.once('data', () => process.exit(0));`;
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
        let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
        const exited = once(child, "exit");
        try {
            await new Promise<void>((resolve, reject) => {
                child.stdout.once("data", chunk => String(chunk).includes("held") ? resolve() : reject(new Error("unexpected lease handshake")));
                child.once("error", reject);
                child.once("exit", code => { if (code !== 0) reject(new Error("lease child failed: " + stderr)); });
            });
            await expect(acquireOmlxLease(port, { stateDirectory })).rejects.toThrow("omlx_resource_busy");
            const ordinary = vi.fn(async () => "ordinary inference");
            await expect(withOllamaResourceLease(ordinary, port, stateDirectory)).rejects.toThrow("omlx_resource_busy");
            expect(ordinary).not.toHaveBeenCalled();
        } finally { child.stdin.end("exit\n"); await exited; }
        const release = await acquireOmlxLease(port, { stateDirectory }); await release(); await release();
        let active = 0, maximum = 0;
        const ordinary = () => withOllamaResourceLease(async () => {
            maximum = Math.max(maximum, ++active);
            await new Promise(resolve => setTimeout(resolve, 5)); active--;
        }, port, stateDirectory);
        await Promise.all([ordinary(), ordinary()]); expect(maximum).toBe(2);
    });
});
