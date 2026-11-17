import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PRISM_INFER_TOOL, runInfer, prismInferHandler, productionInferDeps, isPrismInferArgs, _resetLayer1HistoryCacheForTest, _resetClassifierLimitsForTest, callOllamaGenerate, type InferDeps, type PrismInferArgs } from "../../src/tools/prismInferHandler.js";
import { selectUnassignedCodingModel } from "../../src/utils/localCodingModelSelection.js";
import { selectedOllamaCodingModel } from "../../src/utils/ollamaCodingModels.js";
import { FREE_ENTITLEMENTS, type PrismEntitlements } from "../../src/utils/entitlements.js";
import { parseAnswerCheckPolicy, parseSecondReadPolicy } from "../../src/utils/inferencePolicy.js";
import { callLayer1, LAYER1_PROMPT } from "../../src/utils/layer1.js";
import { ANSWER_GROUNDING_THINK } from "../../src/utils/answerGrounding.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmlxError, createOmlxTarget, type OmlxRequest, type OmlxRuntime, type OmlxTarget } from "../../src/utils/omlxProvider.js";
import { _setOrdinaryLeaseForTest, withInferenceResourceLease } from "../../src/utils/omlxProvider.js";
import { ownedOmlxGenerate } from "../../src/utils/omlxOwned.js";
import { OMLX_LAYER1_MODEL } from "../../src/utils/omlxLayer1.js";
import { completes, endsWithoutTerminal, fakeControl, record } from "./omlxControlFake.js";
import { CRISIS_RESPONSE } from "../../src/utils/safetyGate.js";

const MODEL = "Qwen3.8-Flash-Next-oQ8e-mtp";
// As detection returns it: carrying the provider credential.
const TARGET: OmlxTarget = createOmlxTarget("http://127.0.0.1:8000/v1", MODEL, 65536, "synthetic-provider-key");
const OUTPUT = "def identity(value):\n    return value\n";
const POLICY_TEXT = JSON.stringify(JSON.parse(readFileSync(new URL("../fixtures/answer-check-policy.synthetic.json", import.meta.url), "utf8")));
const POLICY = parseAnswerCheckPolicy(POLICY_TEXT, createHash("sha256").update(POLICY_TEXT).digest("hex"))!;
const SECOND_READ_TEXT = JSON.stringify(JSON.parse(readFileSync(new URL("../fixtures/second-read-policy.synthetic.json", import.meta.url), "utf8")));
const SECOND_READ_POLICY = parseSecondReadPolicy(SECOND_READ_TEXT, createHash("sha256").update(SECOND_READ_TEXT).digest("hex"))!;
const ENT: PrismEntitlements = { ...FREE_ENTITLEMENTS, plan: "standard", source: "portal", model_ceiling: "27b",
    features: { ...FREE_ENTITLEMENTS.features, cloud_fallback: true, grounding_verifier: true },
    multi_turn: { enabled: true, max_turns: 12, max_chars: 32000 } };
const ask = (overrides: Partial<PrismInferArgs> = {}): PrismInferArgs => ({ prompt: "Draft a Python identity helper.", mode: "code", local_backend: "omlx", cloud_fallback: false, escalation: "report", verify: false, ...overrides });
beforeEach(() => { _resetLayer1HistoryCacheForTest(); });
function fixture() {
    const events: string[] = [];
    // Ollama is empty at admission and stays empty: explicit oMLX classifies on oMLX.
    const loaded = new Set<string>();
    const omlx: OmlxRuntime = {
        detect: vi.fn(async () => { events.push("detect"); return TARGET; }),
        acquire: vi.fn(async () => async () => {}),
        listLoaded: vi.fn(async () => new Set(loaded)),
        unload: vi.fn(async model => { events.push("unload:" + model); loaded.delete(model); }),
        generate: vi.fn(async () => { events.push("generate"); return { ok: true as const, text: OUTPUT, doneReason: "stop", promptTokens: 31, completionTokens: 12 }; }),
    };
    const deps: InferDeps = { omlx, entitlements: ENT, freemem: () => 30 * 1024 ** 3,
        listTags: vi.fn(async () => new Set(["prism-coder:27b", "prism-coder:9b", "prism-coder:4b", "prism-coder:2b"])),
        listLoaded: vi.fn(async () => new Set(loaded)), ollamaUrl: "http://127.0.0.1:11434",
        callLayer1: vi.fn(async () => { events.push("classify"); return "OBVIOUS_NOT_RESERVED"; }),
        callLocal: vi.fn(async () => ({ ok: true as const, text: OUTPUT, doneReason: "stop" })),
        callCloud: vi.fn(async () => ({ ok: true, output: "cloud draft", backend: "synalux" })),
        probeNumCtx: async () => 32768, classifierInputPolicy: async () => null,
        secondReadPolicy: async () => null, answerCheckPolicy: async () => POLICY,
    };
    return { deps, omlx, events, loaded };
}

describe("trusted bridge execution context", () => {
    it.each(['bounded', 'signal-only'])('OR retains the device lease while a timed-out limits probe settles (%s)', async contextKind => {
        _resetClassifierLimitsForTest();
        const f = fixture(), id = 'vendor/worker:lease-proof';
        f.deps.ollamaUrl = `http://fixture.invalid/${contextKind}`;
        const events: string[] = [];
        let mono = 0, finish!: () => void, began!: () => void, pending: Promise<unknown> | undefined;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => mono), originalFetch = globalThis.fetch;
        const running = new Promise<void>(resolve => { finish = resolve; });
        const started = new Promise<void>(resolve => { began = resolve; });
        _setOrdinaryLeaseForTest(async () => { events.push('acquired'); return async () => { events.push('released'); }; });
        f.deps.listTags = async () => new Set([id, 'prism-coder:4b', 'prism-coder:9b']);
        f.deps.selectedOllamaModel = async () => ({ tag: id, ctxTokens: 32768, weightsGb: 1, minFreeGb: 3 });
        f.deps.secondReadPolicy = async () => parseSecondReadPolicy(SECOND_READ_TEXT, createHash('sha256').update(SECOND_READ_TEXT).digest('hex'));
        f.deps.callLayer1 = vi.fn(async (text) => text === 'Which shade is darker?' ? 'UNCERTAIN' as const : 'OBVIOUS_NOT_RESERVED' as const);
        // Exercise the actual limits probe and its HTTP path, not an injected probe.
        f.deps.probeClassifierLimits = undefined;
        globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
            if (String(url).endsWith('/api/show')) { mono = 31000; return new Response(JSON.stringify({ system: '', parameters: 'num_ctx 32768' })); }
            if (String(url).endsWith('/api/chat')) {
                events.push('probe-started'); began(); await running; events.push('probe-settled');
                return new Response(JSON.stringify({ prompt_eval_count: 64 }));
            }
            return new Response(JSON.stringify({ models: [{ name: 'prism-coder:9b', context_length: 32768 }, { name: 'prism-coder:4b', context_length: 32768 }] }));
        }) as typeof fetch;
        try {
            pending = runInfer(ask({ local_backend: 'ollama', local_model: id, prompt: 'Which shade is darker?',
                messages: [{ role: 'user', content: 'The shades are Sky Blue and Moss Green.' }, { role: 'assistant', content: 'Noted.' }] }), f.deps,
                contextKind === 'bounded' ? { requiredLocalBackend: 'ollama' } : { signal: new AbortController().signal });
            await started; await new Promise(resolve => setImmediate(resolve));
            expect(events).not.toContain('released');
            finish(); await pending;
            expect(events.indexOf('released')).toBeGreaterThan(events.lastIndexOf('probe-settled'));
            expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
        } finally {
            finish?.(); await pending?.catch(() => undefined); clock.mockRestore(); globalThis.fetch = originalFetch;
            _setOrdinaryLeaseForTest(async () => async () => {});
        }
    });
    it.each([
        ['busy', new OmlxError('omlx_resource_busy')], ['quarantined', new OmlxError('omlx_provider_quarantined')],
        ['maintenance', new Error('Synthetic maintenance requires operator recovery')],
        ['filesystem', Object.assign(new Error('Synthetic maintenance file is unreadable'), { code: 'EACCES' })],
    ] as const)('LC Auto preserves the device error %s', async (_reason, error) => {
        const f = fixture();
        f.deps.codingPreference = async () => ({ saved: 'ollama', effective: 'ollama', configured: true, envOverride: null });
        f.deps.codingModel = vi.fn(async () => 'vendor/worker:queued');
        _setOrdinaryLeaseForTest(async () => { throw error; });
        try {
            await expect(runInfer(ask({ local_backend: 'ollama' }), f.deps)).rejects.toBe(error);
            expect(f.deps.codingModel).not.toHaveBeenCalled();
        } finally { _setOrdinaryLeaseForTest(async () => async () => {}); }
    });
    it.each(['lookup window', 'request timeout', 'Stop'])('LC Auto admission preserves %s after an exclusive wait', async outcome => {
        const f = fixture(), id = 'vendor/worker:queued', controller = new AbortController();
        let now = 1000, release!: () => void, began!: () => void, pending: Promise<unknown> | undefined;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        const ready = new Promise<void>(resolve => { began = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const blocking = withInferenceResourceLease(true, async () => { began(); await gate; });
        f.deps.codingPreference = async () => ({ saved: 'ollama', effective: 'ollama', configured: true, envOverride: null });
        f.deps.codingModel = vi.fn(async () => id);
        f.deps.listTags = async () => new Set([id]);
        f.deps.selectedOllamaModel = async () => ({ tag: id, ctxTokens: 4096, weightsGb: 1, minFreeGb: 3 });
        try {
            await ready;
            pending = runInfer(ask({ local_backend: 'ollama', timeout_ms: outcome === 'request timeout' ? 1000 : undefined }), f.deps,
                outcome === 'lookup window' ? undefined : { requiredLocalBackend: 'ollama', signal: controller.signal }).catch(error => error);
            await new Promise(resolve => setImmediate(resolve));
            now += 3000; if (outcome === 'Stop') controller.abort();
            release(); await blocking;
            const result = await pending;
            if (outcome === 'lookup window') {
                expect(result).toMatchObject({ output: OUTPUT });
                expect(vi.mocked(f.deps.codingModel).mock.calls[0][0].deadlineMs).toBe(now + 2000);
            } else {
                expect((result as Error).message).toBe(outcome === 'Stop' ? 'prism_infer: caller_cancelled' : 'prism_infer: timeout');
                expect(f.deps.codingModel).not.toHaveBeenCalled();
            }
        } finally { release?.(); await blocking; await pending?.catch(() => undefined); clock.mockRestore(); }
    });
    it.each(['selected', 'Auto'])('LC drains metadata registered while its %s owner is settling', async route => {
        const f = fixture(), id = 'vendor/worker:late', events: string[] = [];
        let began!: () => void, reject!: (error: Error) => void, register!: () => void, finish!: () => void;
        let pending: Promise<unknown> | undefined;
        const ready = new Promise<void>(resolve => { began = resolve; });
        const parent = new Promise<void>(resolve => { register = resolve; });
        const late = new Promise<void>(resolve => { finish = () => { events.push('late-settled'); resolve(); }; });
        const work = (track?: (promise: Promise<unknown>) => void) => {
            track?.(parent.then(() => { track?.(late); })); began();
            return new Promise<never>((_resolve, fail) => { reject = fail; });
        };
        f.deps.listTags = async () => new Set([id]);
        f.deps.selectedOllamaModel = (_url, _model, _ceiling, _fetch, options) => work(options?.track);
        if (route === 'Auto') {
            f.deps.codingPreference = async () => ({ saved: 'ollama', effective: 'ollama', configured: true, envOverride: null });
            f.deps.codingModel = options => work(options.track);
        }
        _setOrdinaryLeaseForTest(async () => { events.push('acquired'); return async () => { events.push('released'); }; });
        try {
            pending = runInfer(ask({ local_backend: 'ollama', local_model: route === 'selected' ? id : undefined }), f.deps).catch(error => error);
            await ready; reject(new Error(route === 'Auto' ? 'local_coding_selection_timeout' : 'ollama_model_metadata_unavailable'));
            await new Promise(resolve => setImmediate(resolve)); register();
            await new Promise(resolve => setImmediate(resolve)); expect(events).not.toContain('released');
            finish(); await pending; expect(events.indexOf('released')).toBeGreaterThan(events.indexOf('late-settled'));
        } finally {
            reject?.(new Error('fixture finished')); register?.(); finish?.(); await pending?.catch(() => undefined);
            _setOrdinaryLeaseForTest(async () => async () => {});
        }
    });
    it.each([
        ['sibling failure', 'selected', 'bounded'], ['timeout', 'selected', 'bounded'], ['Stop', 'selected', 'bounded'],
        ['sibling failure', 'selected', 'context-free'], ['timeout', 'selected', 'context-free'],
        ['sibling failure', 'Auto', 'context-free'], ['timeout', 'Auto', 'context-free'],
        ['Stop', 'Auto', 'bounded'], ['Stop', 'Auto', 'signal-only'],
    ] as const)('inventory ownership waits after %s (%s, %s)', async (failure, route, contextKind) => {
        const f = fixture(), id = 'vendor/worker:inventory-proof', controller = new AbortController();
        const events: string[] = [];
        let finish!: () => void, began!: () => void, pending: Promise<unknown> | undefined;
        const waiting = new Promise<void>(resolve => { finish = resolve; });
        const started = new Promise<void>(resolve => { began = resolve; });
        const originalFetch = globalThis.fetch;
        f.deps.listTags = async () => new Set([id]);
        f.deps.listLoaded = async () => new Set();
        // No injected selection: exercise its actual concurrent metadata work.
        f.deps.selectedOllamaModel = undefined;
        if (route === 'Auto') {
            f.deps.codingPreference = async () => ({ saved: 'ollama', effective: 'ollama', configured: true, envOverride: null });
            f.deps.codingModel = options => selectUnassignedCodingModel(options, { recommend: async () => undefined });
        }
        _setOrdinaryLeaseForTest(async () => { events.push('acquired'); return async () => { events.push('released'); }; });
        globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
            if (String(url).endsWith('/api/tags')) return failure === 'sibling failure'
                ? new Response('', { status: 503 })
                : new Response(JSON.stringify({ models: [{ name: id, size: 1024 ** 3 }] }));
            expect(String(url)).toMatch(/\/api\/ps$/);
            events.push('inventory-started'); began(); await waiting;
            events.push('inventory-settled');
            return new Response(JSON.stringify({ models: [] }));
        }) as typeof fetch;
        if (failure === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            pending = runInfer(ask({ local_backend: 'ollama', local_model: route === 'Auto' ? undefined : id }), f.deps,
                contextKind === 'context-free' ? undefined : contextKind === 'signal-only' ? { signal: controller.signal }
                    : { requiredLocalBackend: 'ollama', signal: controller.signal }).catch(error => error);
            await started;
            if (failure === 'Stop') controller.abort();
            if (failure === 'timeout') await vi.advanceTimersByTimeAsync(3001);
            await new Promise(resolve => setImmediate(resolve));
            expect(events).toContain('acquired');
            expect(events).not.toContain('released');
            finish(); const outcome = await pending;
            if (failure === 'Stop') expect((outcome as Error).message).toContain('caller_cancelled');
            expect(events.indexOf('released')).toBeGreaterThan(events.indexOf('inventory-settled'));
            expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
        } finally {
            finish?.(); await pending?.catch(() => undefined); globalThis.fetch = originalFetch;
            if (failure === 'timeout') vi.useRealTimers();
            _setOrdinaryLeaseForTest(async () => async () => {});
        }
    });
    it.each(['/api/ps', '/api/show'])('inventory ownership waits for response-body cancellation at %s', async bodyPath => {
        const f = fixture(), id = 'vendor/worker:body-proof', controller = new AbortController(), events: string[] = [];
        const originalFetch = globalThis.fetch;
        let began!: () => void, finish!: () => void, pending: Promise<unknown> | undefined;
        const started = new Promise<void>(resolve => { began = resolve; });
        const cancellation = new Promise<void>(resolve => { finish = resolve; });
        const body = new ReadableStream<Uint8Array>({
            pull() { began(); },
            async cancel() { events.push('cancel-started'); await cancellation; events.push('cancel-settled'); },
        }, { highWaterMark: 0 });
        f.deps.listTags = async () => new Set([id]); f.deps.listLoaded = async () => new Set();
        f.deps.selectedOllamaModel = undefined;
        _setOrdinaryLeaseForTest(async () => { events.push('acquired'); return async () => { events.push('released'); }; });
        globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => String(url).endsWith(bodyPath) ? new Response(body)
            : new Response(JSON.stringify(String(url).endsWith('/api/tags')
                ? { models: [{ name: id, size: 1024 ** 3 }] } : { models: [] }))) as typeof fetch;
        try {
            pending = runInfer(ask({ local_backend: 'ollama', local_model: id }), f.deps,
                { requiredLocalBackend: 'ollama', signal: controller.signal }).catch(error => error);
            await started; controller.abort(); await new Promise(resolve => setImmediate(resolve));
            expect(events).toContain('cancel-started'); expect(events).not.toContain('released');
            finish(); await pending;
            expect(events.indexOf('released')).toBeGreaterThan(events.indexOf('cancel-settled'));
            expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
        } finally {
            finish?.(); await pending?.catch(() => undefined); globalThis.fetch = originalFetch;
            _setOrdinaryLeaseForTest(async () => async () => {});
        }
    });
    it.each(['expiry', 'stop'])('OR production inventory cannot start another exchange after %s', async how => {
        const f = fixture(), live = productionInferDeps(), controller = new AbortController();
        let now = 1000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now), originalFetch = globalThis.fetch;
        f.deps.listTags = live.listTags; f.deps.listLoaded = live.listLoaded;
        const fetcher = vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            expect(String(url)).toMatch(/\/api\/tags$/); expect(init?.signal).toBeInstanceOf(AbortSignal);
            if (how === 'expiry') now += 180000; else controller.abort();
            return new Response(JSON.stringify({ models: [{ name: 'vendor/worker:exact' }] }));
        });
        globalThis.fetch = fetcher as unknown as typeof fetch;
        try {
            await expect(runInfer(ask({ local_backend: 'ollama', local_model: 'vendor/worker:exact', timeout_ms: 180000 }), f.deps,
                { requiredLocalBackend: 'ollama', signal: controller.signal })).rejects.toThrow(how === 'expiry' ? 'timeout' : 'caller_cancelled');
            expect(fetcher).toHaveBeenCalledOnce(); expect(f.deps.callLayer1).not.toHaveBeenCalled();
            expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
        } finally { clock.mockRestore(); globalThis.fetch = originalFetch; }
    });
    it("ownership repair keeps the whole request pending after a second-read timeout until its classifier settles", async () => {
        const f = fixture(), id = 'vendor/worker:exact';
        let monotonic = 0, finish!: () => void, began!: () => void, settled = false;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
        const started = new Promise<void>(resolve => { began = resolve; });
        const stopped = new Promise<void>(resolve => { finish = resolve; });
        f.deps.listTags = async () => new Set([id, 'prism-coder:4b', 'prism-coder:9b']);
        f.deps.selectedOllamaModel = async () => ({ tag: id, ctxTokens: 32768, weightsGb: 1, minFreeGb: 3 });
        f.deps.secondReadPolicy = async () => parseSecondReadPolicy(SECOND_READ_TEXT, createHash('sha256').update(SECOND_READ_TEXT).digest('hex'));
        f.deps.probeClassifierLimits = async () => ({ numCtx: 32768, overheadBound: 100 });
        f.deps.callLayer1 = vi.fn(async (text, _url, model) => {
            if (model === 'prism-coder:9b') { monotonic = 31000; began(); await stopped; return 'OBVIOUS_NOT_RESERVED' as const; }
            return text === 'Which option is darkest?' ? 'UNCERTAIN' as const : 'OBVIOUS_NOT_RESERVED' as const;
        });
        try {
            const pending = runInfer(ask({ local_backend: 'ollama', local_model: id, prompt: 'Which option is darkest?',
                messages: [{ role: 'user', content: 'The options are Sky Blue and Moss Green.' }, { role: 'assistant', content: 'Noted.' }] }), f.deps,
                { requiredLocalBackend: 'ollama' }).finally(() => { settled = true; });
            await started; await new Promise(resolve => setImmediate(resolve));
            expect(settled).toBe(false); expect(f.deps.callLocal).not.toHaveBeenCalled();
            finish(); const result = await pending;
            expect(result.gate_outcome?.status).toBe('refused'); expect(settled).toBe(true);
            expect(f.deps.callCloud).not.toHaveBeenCalled();
        } finally { finish?.(); clock.mockRestore(); }
    });
    it("ownership repair stops the real template probe before its generation after deadline expiry", async () => {
        const f = fixture(), id = 'vendor/worker:template-deadline';
        let now = 1000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now), originalFetch = globalThis.fetch;
        f.deps.listTags = async () => new Set([id]);
        f.deps.selectedOllamaModel = async () => ({ tag: id, ctxTokens: 32768, weightsGb: 1, minFreeGb: 3 });
        f.deps.probeTemplateOverhead = undefined;
        const fetcher = vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            expect(init?.signal).toBeInstanceOf(AbortSignal);
            expect(String(url)).toMatch(/\/api\/chat$/);
            now += 180000;
            return new Response(JSON.stringify({ prompt_eval_count: 100 }));
        });
        globalThis.fetch = fetcher as unknown as typeof fetch;
        try {
            await expect(runInfer(ask({ local_backend: 'ollama', local_model: id, timeout_ms: 180000, system: 'Use the supplied module.',
                messages: [{ role: 'user', content: 'Review the input helper.' }, { role: 'assistant', content: 'I can review it.' }] }), f.deps,
                { requiredLocalBackend: 'ollama' })).rejects.toThrow('timeout');
            expect(fetcher).toHaveBeenCalledOnce(); expect(f.deps.callLocal).toHaveBeenCalledOnce();
            expect(f.deps.callCloud).not.toHaveBeenCalled();
        } finally { clock.mockRestore(); globalThis.fetch = originalFetch; }
    });
    it("RH generation rechecks its deadline after Modelfile metadata before HTTP dispatch", async () => {
        let now = 1000;
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now), originalFetch = globalThis.fetch;
        const fetcher = vi.fn(async () => { now = 2000; return new Response(JSON.stringify({ system: '' })); });
        globalThis.fetch = fetcher as unknown as typeof fetch;
        try {
            expect(await callOllamaGenerate('http://fixture.invalid', 'rh-deadline:model', 'Explain code', undefined, 512, 0, 1000,
                false, undefined, undefined, 4096, { deadlineMs: 2000 })).toEqual({ ok: false, reason: 'timeout' });
            expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][0]).toMatch(/\/api\/show$/);
        } finally { clock.mockRestore(); globalThis.fetch = originalFetch; }
    });
    it("RH expired history classifier cannot issue a second read or generation", async () => {
        const f = fixture(), id = "vendor/worker:exact";
        let now = 1000;
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        f.deps.listTags = async () => new Set([id]);
        f.deps.selectedOllamaModel = async () => ({ tag: id, ctxTokens: 32768, weightsGb: 1, minFreeGb: 3 });
        f.deps.callLayer1 = vi.fn(async () => { now += 180000; return "UNCERTAIN" as const; });
        try {
            await expect(runInfer(ask({ local_backend: 'ollama', local_model: id, timeout_ms: 180000,
                messages: [{ role: 'user', content: 'Review the value helper.' }, { role: 'assistant', content: 'I can review it.' }] }), f.deps,
                { requiredLocalBackend: 'ollama' })).rejects.toThrow('timeout');
            expect(f.deps.callLayer1).toHaveBeenCalledOnce(); expect(f.deps.callLocal).not.toHaveBeenCalled();
            expect(f.deps.callCloud).not.toHaveBeenCalled();
        } finally { clock.mockRestore(); }
    });
    it("RH Ollama retries consume one deadline including metadata and classification", async () => {
        const f = fixture(), id = "vendor/worker:exact";
        let now = 1000;
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        f.deps.listTags = async () => new Set([id]);
        f.deps.selectedOllamaModel = async () => { now += 1000; return { tag: id, ctxTokens: 32768, weightsGb: 1, minFreeGb: 3 }; };
        f.deps.callLayer1 = vi.fn(async () => { now += 4000; return "OBVIOUS_NOT_RESERVED" as const; });
        const timeouts: number[] = [];
        f.deps.callLocal = vi.fn(async (...args) => {
            timeouts.push(args[6]); now += 60000;
            return timeouts.length === 1 ? { ok: false as const, reason: "think_only" }
                : { ok: true as const, text: OUTPUT, doneReason: "stop" };
        });
        try {
            const result = await runInfer(ask({ local_backend: "ollama", local_model: id, timeout_ms: 180000, think: true }), f.deps,
                { requiredLocalBackend: "ollama" });
            expect(result.output).toBe(OUTPUT); expect(timeouts).toEqual([175000, 115000]);
            expect(f.deps.callCloud).not.toHaveBeenCalled();
        } finally { clock.mockRestore(); }
    });
    it("RH Ollama expiration cannot dispatch another worker attempt", async () => {
        const f = fixture(), id = "vendor/worker:exact";
        let now = 1000;
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        f.deps.listTags = async () => new Set([id]);
        f.deps.selectedOllamaModel = async () => ({ tag: id, ctxTokens: 32768, weightsGb: 1, minFreeGb: 3 });
        f.deps.callLocal = vi.fn(async () => { now += 180000; return { ok: false as const, reason: "think_only" }; });
        try {
            await expect(runInfer(ask({ local_backend: "ollama", local_model: id, timeout_ms: 180000, think: true }), f.deps,
                { requiredLocalBackend: "ollama" })).rejects.toThrow("timeout");
            expect(f.deps.callLocal).toHaveBeenCalledOnce(); expect(f.deps.callCloud).not.toHaveBeenCalled();
        } finally { clock.mockRestore(); }
    });
    it("RH expired answer check cannot refresh its retry deadline or serve a draft", async () => {
        const f = fixture(), id = "vendor/worker:exact";
        let now = 1000;
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now), originalFetch = globalThis.fetch;
        f.deps.listTags = async () => new Set([id]);
        f.deps.selectedOllamaModel = async () => ({ tag: id, ctxTokens: 32768, weightsGb: 1, minFreeGb: 3 });
        f.deps.probeTemplateOverhead = async () => 0;
        f.deps.callLocal = vi.fn(async () => { now += 179500; return { ok: true as const, text: OUTPUT, doneReason: "stop" }; });
        const fetcher = vi.fn(async () => { now += 500; return new Response(JSON.stringify({ done: true, done_reason: "stop", message: { content: "invalid verdict" } })); });
        globalThis.fetch = fetcher as unknown as typeof fetch;
        try {
            await expect(runInfer(ask({ local_backend: "ollama", local_model: id, timeout_ms: 180000,
                messages: [{ role: "user", content: "A helper should return its input." }, { role: "assistant", content: "I can review that helper." }] }), f.deps,
                { requiredLocalBackend: "ollama" })).rejects.toThrow("timeout");
            expect(fetcher).toHaveBeenCalledOnce(); expect(f.deps.callCloud).not.toHaveBeenCalled();
        } finally { clock.mockRestore(); globalThis.fetch = originalFetch; }
    });
    it("RH realistic file continuation sizes the selected model and checks the full answer", async () => {
        const f = fixture(), id = "vendor/worker:exact", file = "export const fixtureValue = 1;\n".repeat(400);
        const metadata = vi.fn(async (url: Parameters<typeof fetch>[0]) => new Response(JSON.stringify(String(url).endsWith('/api/tags')
            ? { models: [{ name: id, size: 1024 ** 3 }] } : String(url).endsWith('/api/ps') ? { models: [] }
                : { model_info: { 'general.architecture': 'fixture', 'general.parameter_count': 9e9, 'fixture.context_length': 65536,
                    'fixture.block_count': 32, 'fixture.embedding_length': 4096, 'fixture.attention.head_count': 32, 'fixture.attention.head_count_kv': 8 }, capabilities: ['completion'] })));
        f.deps.listTags = async () => new Set([id]);
        let choice: any;
        f.deps.selectedOllamaModel = async (url, model, ceiling, _fetch, options) =>
            choice = await selectedOllamaCodingModel(url, model, ceiling, metadata as unknown as typeof fetch, options);
        f.deps.probeTemplateOverhead = async () => 1300;
        f.deps.groundAnswer = vi.fn(async () => ({ verdict: "GROUNDED" as const }));
        const result = await runInfer(ask({ local_backend: "ollama", local_model: id, max_tokens: 1024, timeout_ms: 180000,
            messages: [{ role: "user", content: "Read the fixture module." }, { role: "assistant", content: "I read it." }],
            prompt: "Explain this module:\n" + file }), f.deps, { requiredLocalBackend: "ollama" });
        expect(choice.ctxTokens).toBeGreaterThan(16000); expect(choice.minFreeGb).toBeGreaterThan(3);
        expect(result.output).toBe(OUTPUT);
        const call = vi.mocked(f.deps.callLocal).mock.calls[0];
        expect(call[1]).toBe(id); expect(call[2]).toContain(file); expect(call[10]).toBe(choice.ctxTokens);
        expect(call[11]).toMatchObject({ deadlineMs: expect.any(Number) });
        expect(f.deps.groundAnswer).toHaveBeenCalledOnce(); expect(f.deps.callCloud).not.toHaveBeenCalled();
        expect(metadata.mock.calls.every(([url]) => !String(url).endsWith('/api/chat'))).toBe(true);
    });
    it("refuses a changed dashboard backend before any generation", async () => {
        const f = fixture();
        f.deps.codingPreference = async () => ({ saved: "ollama", effective: "ollama", configured: false, envOverride: null });
        expect(await runInfer(ask({ local_backend: undefined }), f.deps, { requiredLocalBackend: "omlx" }))
            .toMatchObject({ backend: "refused", gate_outcome: { reason: "bridge_requires_omlx" } });
        expect(f.deps.callCloud).not.toHaveBeenCalled(); expect(f.deps.callLocal).not.toHaveBeenCalled();
        expect(f.omlx.detect).not.toHaveBeenCalled();
    });
    it("does not start detection for a cancelled request", async () => {
        const f = fixture(), controller = new AbortController(); controller.abort();
        await expect(runInfer(ask(), f.deps, { signal: controller.signal })).rejects.toThrow("caller_cancelled");
        expect(f.omlx.detect).not.toHaveBeenCalled(); expect(f.omlx.generate).not.toHaveBeenCalled();
    });
    it("passes cancellation to the owner and waits for its stop before releasing the device", async () => {
        const f = fixture(), controller = new AbortController();
        let began!: () => void, stop!: () => void, settled = false;
        const started = new Promise<void>(resolve => { began = resolve; });
        const stopped = new Promise<void>(resolve => { stop = resolve; });
        f.omlx.acquire = vi.fn(async () => async () => { f.events.push("release"); });
        f.omlx.generate = vi.fn(async (_target, _request, signal) => {
            began(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
            f.events.push("abort"); await stopped; f.events.push("stop-proved");
            return { ok: false as const, reason: "caller_cancelled" };
        });
        const pending = runInfer(ask({ local_model: MODEL }), f.deps, { signal: controller.signal })
            .catch(error => error).finally(() => { settled = true; });
        await started; controller.abort(); await new Promise(resolve => setTimeout(resolve, 10));
        expect(settled).toBe(false); expect(f.events).not.toContain("release");
        stop(); await pending;
        expect(f.events.indexOf("stop-proved")).toBeLessThan(f.events.indexOf("release"));
        expect(f.deps.callCloud).not.toHaveBeenCalled(); expect(f.deps.callLocal).not.toHaveBeenCalled();
    });
});

describe("saved execution roles", () => {
    it("trusted Ollama bridge refuses an oMLX role before acquiring a device", async () => {
        const f = fixture();
        f.deps.codingPreference = async () => ({ saved: "omlx", effective: "omlx", configured: true, envOverride: null,
            assignment: { runtime: "omlx", model: MODEL } });
        const result = await runInfer(ask({ local_backend: undefined }), f.deps, { requiredLocalBackend: "ollama" });
        expect(result).toMatchObject({ backend: "refused", output: "", used_cloud: false,
            gate_outcome: { reason: "bridge_requires_ollama" } });
        expect(f.omlx.acquire).not.toHaveBeenCalled(); expect(f.omlx.detect).not.toHaveBeenCalled();
        expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it("Ollama bridge cancellation during metadata starts no generation", async () => {
        const f = fixture(), controller = new AbortController(), id = "vendor/worker:exact";
        f.deps.listTags = async () => new Set([id]);
        f.deps.selectedOllamaModel = async () => {
            controller.abort();
            return { tag: id, ctxTokens: 4096, weightsGb: 1, minFreeGb: 3 };
        };
        await expect(runInfer(ask({ local_backend: "ollama", local_model: id }), f.deps,
            { signal: controller.signal, requiredLocalBackend: "ollama" })).rejects.toThrow("caller_cancelled");
        expect(f.deps.callLayer1).not.toHaveBeenCalled();
        expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it("Ollama bridge cancellation during classification dispatches no worker or second read", async () => {
        const f = fixture(), controller = new AbortController(), id = "vendor/worker:exact";
        f.deps.listTags = async () => new Set([id]);
        f.deps.selectedOllamaModel = async () => ({ tag: id, ctxTokens: 4096, weightsGb: 1, minFreeGb: 3 });
        f.deps.callLayer1 = vi.fn(async () => { controller.abort(); return "OBVIOUS_NOT_RESERVED" as const; });
        await expect(runInfer(ask({ local_backend: "ollama", local_model: id }), f.deps,
            { signal: controller.signal, requiredLocalBackend: "ollama" })).rejects.toThrow("caller_cancelled");
        expect(f.deps.callLayer1).toHaveBeenCalledOnce();
        expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it("Ollama bridge cancellation waits for its in-flight call and withholds output", async () => {
        const f = fixture(), controller = new AbortController(), id = "vendor/worker:exact";
        f.deps.listTags = async () => new Set([id]);
        f.deps.selectedOllamaModel = async () => ({ tag: id, ctxTokens: 4096, weightsGb: 1, minFreeGb: 3 });
        let started!: () => void, complete!: () => void, settled = false;
        const began = new Promise<void>(resolve => { started = resolve; });
        f.deps.callLocal = vi.fn(async () => {
            started(); await new Promise<void>(resolve => { complete = resolve; });
            return { ok: true as const, text: OUTPUT };
        });
        const result = runInfer(ask({ local_backend: "ollama", local_model: id }), f.deps,
            { signal: controller.signal, requiredLocalBackend: "ollama" }).catch(error => error).finally(() => { settled = true; });
        await began; controller.abort(); await new Promise(resolve => setTimeout(resolve, 10));
        expect(settled).toBe(false); complete();
        expect((await result).message).toContain("caller_cancelled");
        expect(f.deps.callLocal).toHaveBeenCalledOnce(); expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it.each([undefined,'route','chat'] as const)('coding assignments do not retarget non-code mode %s', async mode => {
        for (const runtime of ['host','synalux','omlx','ollama'] as const) {
            const f = fixture();
            const profile = {id:'a'.repeat(64),provider:'fixture',model:'fixture-host',effort:'high',status:'configured' as const};
            f.deps.hostProfiles = vi.fn(async () => [profile]);
            f.deps.codingPreference = vi.fn(async (...args: any[]) => {
                const plain = {saved:'auto',effective:'auto',configured:false,envOverride:null};
                if (args[4] === false) return plain as any;
                return {...plain,effective:runtime === 'omlx' || runtime === 'ollama' ? runtime : 'auto',
                    assignment:runtime === 'host' ? {runtime,profile:profile.id} : runtime === 'synalux' ? {runtime} : {runtime,model:'saved:code'}} as any;
            });
            await runInfer(ask({mode,local_backend:undefined}),f.deps).catch(() => undefined);
            expect(f.deps.callLocal, runtime).toHaveBeenCalled();
            expect(f.deps.callCloud, runtime).not.toHaveBeenCalled();
            expect(f.deps.hostProfiles, runtime).not.toHaveBeenCalled();
            expect(f.omlx.generate, runtime).not.toHaveBeenCalled();
            expect((f.deps.callLocal as any).mock.calls.every((call: any[]) => call[0].model !== 'saved:code')).toBe(true);
        }
    });
    it("an exact local pin cannot exhaust RAM and silently spend cloud credits", async () => {
        const f = fixture(); f.deps.freemem = () => 0;
        f.deps.listTags = async () => new Set(["exact:model"]);
        f.deps.selectedOllamaModel = async () => ({ tag: "exact:model", ctxTokens: 4096, weightsGb: 9, minFreeGb: 11 });
        await runInfer(ask({ local_backend: "ollama", local_model: "exact:model", cloud_fallback: true }), f.deps).catch(() => undefined);
        expect(f.deps.callCloud).not.toHaveBeenCalled(); expect(f.deps.callLocal).not.toHaveBeenCalled();
    });
    it("uses a saved reviewer model with requested/actual provenance", async () => {
        const f = fixture();
        f.deps.codingPreference = async () => ({ saved: "auto", effective: "omlx", configured: true, envOverride: null,
            assignment: { runtime: "omlx", model: MODEL } });
        const result = await runInfer(ask({ local_backend: undefined, local_role: "reviewer" }), f.deps);
        expect(f.omlx.detect).toHaveBeenCalledWith(MODEL);
        expect(result.selection).toMatchObject({ source: "role_assignment", requested_model: MODEL, actual_model: MODEL, actual_runtime: "omlx", actual_effort: null });
    });
    it("uses entitled Synalux cloud directly, leaving device providers unused", async () => {
        const f = fixture();
        f.deps.codingPreference = async () => ({ saved: "auto", effective: "auto", configured: false, envOverride: null, assignment: { runtime: "synalux" } });
        const result = await runInfer(ask({ local_backend: undefined, cloud_fallback: undefined }), f.deps);
        expect(result).toMatchObject({ used_cloud: true, selection: { source: "role_assignment", requested_runtime: "synalux", requested_model: null, actual_model: null } });
        expect(f.deps.callCloud).toHaveBeenCalledOnce(); expect(f.deps.listTags).not.toHaveBeenCalled(); expect(f.omlx.detect).not.toHaveBeenCalled();
    });
    it("keeps reserved signaling and output safety on a direct Synalux role", async () => {
        const f = fixture();
        f.deps.codingPreference = async () => ({ saved: "auto", effective: "auto", configured: false, envOverride: null,
            assignment: { runtime: "synalux" } });
        f.deps.callCloud = vi.fn(async () => ({ ok: true, output: "Here is how to overdose on pills", backend: "synalux" }));
        const result = await runInfer(ask({ prompt: "Draft a physical restraint protocol for a client.", local_backend: undefined,
            cloud_fallback: undefined }), f.deps);
        expect(f.deps.callCloud).toHaveBeenCalledWith(expect.any(String), expect.any(Number), expect.any(Number),
            expect.objectContaining({ reserved: true }));
        expect(result.output).toBe(CRISIS_RESPONSE);
        expect(f.deps.callLayer1).not.toHaveBeenCalled();
        expect(f.deps.listTags).not.toHaveBeenCalled();
        expect(f.omlx.detect).not.toHaveBeenCalled();
    });
    it("refuses a weak backend returned for reserved direct Synalux work", async () => {
        const f = fixture();
        f.deps.codingPreference = async () => ({ saved: "auto", effective: "auto", configured: false, envOverride: null,
            assignment: { runtime: "synalux" } });
        f.deps.callCloud = vi.fn(async () => ({ ok: true, output: "unsafe weak answer", backend: "ollama-prism-coder:9b" }));
        const result = await runInfer(ask({ prompt: "Draft a physical restraint protocol for a client.", local_backend: undefined,
            cloud_fallback: undefined }), f.deps);
        expect(result).toMatchObject({ backend: "refused", output: "", used_cloud: false,
            gate_outcome: { status: "refused", reason: "layer1_reserved", served_anyway: false } });
        expect(result.attempts).toEqual(expect.arrayContaining([{ tier: "synalux", reason: "reserved_weak_backend:ollama-prism-coder:9b" }]));
    });
    it("does not reinterpret a local-only caller or a free plan as cloud consent", async () => {
        const f = fixture();
        f.deps.codingPreference = async () => ({ saved: "auto", effective: "auto", configured: false, envOverride: null, assignment: { runtime: "synalux" } });
        await expect(runInfer(ask({ local_backend: undefined }), f.deps)).rejects.toThrow("cloud_explicitly_forbidden");
        f.deps.entitlements = FREE_ENTITLEMENTS;
        expect(await runInfer(ask({ local_backend: undefined, cloud_fallback: undefined }), f.deps)).toMatchObject({ backend: "refused", gate_outcome: { reason: "cloud_not_in_plan" } });
        expect(f.deps.callCloud).not.toHaveBeenCalled(); expect(f.deps.listTags).not.toHaveBeenCalled();
    });
    it("creates a request-bound host handoff without claiming execution", async () => {
        const f = fixture(), profile = { id: "a".repeat(64), provider: "claude", model: "example-model", effort: "high", status: "configured" as const };
        f.deps.codingPreference = async () => ({ saved: "auto", effective: "auto", configured: false, envOverride: null, assignment: { runtime: "host", profile: profile.id } });
        f.deps.hostProfiles = async () => [profile];
        const result = await runInfer(ask({ local_backend: undefined, local_role: "reviewer" }), f.deps);
        expect(result).toMatchObject({ backend: "host_handoff_required", output: "", used_cloud: false,
            host_handoff: { executed: false, request: { role: "reviewer", model: "example-model", effort: "high" } },
            selection: { actual_model: null, actual_runtime: null } });
        expect(f.deps.callCloud).not.toHaveBeenCalled(); expect(f.omlx.detect).not.toHaveBeenCalled();
        f.deps.hostProfiles = async () => [];
        await expect(runInfer(ask({ local_backend: undefined }), f.deps)).rejects.toThrow("execution_host_unavailable");
    });
});

describe("explicit oMLX through the centralized prism_infer pipeline", () => {
    it.each([undefined, "route", "chat", "code"] as const)("keeps saved Ollama for mode %s despite a healthy oMLX provider", async mode => {
        const f = fixture();
        f.deps.codingPreference = async () => ({ saved: "ollama", effective: "ollama", configured: true, envOverride: null });
        const result = await runInfer(ask({ mode, local_backend: undefined }), f.deps);
        expect(result.backend).toMatch(/^ollama-/);
        expect(f.deps.callLocal).toHaveBeenCalled();
        expect(f.omlx.detect).not.toHaveBeenCalled();
        expect(f.omlx.acquire).not.toHaveBeenCalled();
        expect(f.omlx.generate).not.toHaveBeenCalled();
    });
    it.each([undefined, "route", "chat", "code"] as const)("does not substitute oMLX when Ollama fails in mode %s", async mode => {
        for (const failure of ["inventory", "missing_model", "generation"] as const) {
            const f = fixture();
            f.deps.codingPreference = async () => ({ saved: "ollama", effective: "ollama", configured: true, envOverride: null });
            if (failure === "inventory") f.deps.listTags = vi.fn(async () => null);
            if (failure === "missing_model") f.deps.listTags = vi.fn(async () => new Set<string>());
            if (failure === "generation") f.deps.callLocal = vi.fn(async () => ({ ok: false, reason: "provider_unavailable" }));
            const result = await runInfer(ask({ mode, local_backend: undefined }), f.deps)
                .catch(error => ({ backend: "exception", error }));
            expect(["refused", "exception"]).toContain(result.backend);
            expect(f.omlx.detect, failure).not.toHaveBeenCalled();
            expect(f.omlx.acquire, failure).not.toHaveBeenCalled();
            expect(f.omlx.generate, failure).not.toHaveBeenCalled();
            expect(f.deps.callCloud, failure).not.toHaveBeenCalled();
        }
    });
    it.each([undefined, "route", "chat"] as const)("honors saved oMLX for text mode %s without Ollama inference", async mode => {
        const f = fixture();
        const output = mode === "chat" ? "The saved local notes describe the project." : '<tool_call>{"name":"knowledge_search","arguments":{"query":"project"}}</tool_call>';
        f.deps.codingPreference = vi.fn(async () => ({ saved: "omlx" as const, effective: "omlx" as const, configured: true, envOverride: null,
            models: { omlx: { coder: MODEL } } }));
        f.deps.callRouteGuard = vi.fn(async () => { throw new Error("must stay local"); });
        f.omlx.generate = vi.fn(async () => ({ ok: true as const, text: output, doneReason: "stop" }));
        const result = await runInfer(ask({ mode, local_backend: undefined, prompt: "Look up my saved project notes." }), f.deps);
        expect(result).toMatchObject({ backend: "omlx", model_picked: MODEL, used_cloud: false, output });
        expect(f.omlx.detect).toHaveBeenCalledWith(MODEL);
        expect(f.deps.listTags).not.toHaveBeenCalled();
        expect(f.deps.listLoaded).not.toHaveBeenCalled();
        expect(f.deps.callLocal).not.toHaveBeenCalled();
        expect(f.deps.callCloud).not.toHaveBeenCalled();
        expect(f.deps.callRouteGuard).not.toHaveBeenCalled();
    });
    it.each(["route", "chat"] as const)("never substitutes Ollama when the saved oMLX %s model is unavailable", async mode => {
        const f = fixture();
        f.deps.codingPreference = async () => ({ saved: "omlx", effective: "omlx", configured: true, envOverride: null,
            models: { omlx: { coder: MODEL } } });
        f.omlx.detect = vi.fn(async () => { throw new OmlxError("omlx_model_not_advertised"); });
        expect(await runInfer(ask({ mode, local_backend: undefined, cloud_fallback: true }), f.deps))
            .toMatchObject({ backend: "refused", gate_outcome: { reason: "omlx_model_not_advertised" } });
        expect(f.deps.listTags).not.toHaveBeenCalled();
        expect(f.deps.callLocal).not.toHaveBeenCalled();
        expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it("retains the advertised-tool boundary for oMLX routing without a portal call", async () => {
        const f = fixture();
        const draft = '<tool_call>{"name":"brave_web_search","arguments":{"query":"project"}}</tool_call>';
        f.omlx.generate = vi.fn(async () => ({ ok: true as const, text: draft, doneReason: "stop" }));
        f.deps.callRouteGuard = vi.fn(async () => { throw new Error("must stay local"); });
        const result = await runInfer(ask({ mode: "route", allowed_tools: ["knowledge_search"] }), f.deps);
        expect(result.route_guard).toMatchObject({ action: "suppressed", source: "local" });
        expect(result.output).not.toBe(draft);
        expect(f.deps.callRouteGuard).not.toHaveBeenCalled();
        expect(f.deps.callLocal).not.toHaveBeenCalled();
    });
    it.each([undefined, "route", "chat"] as const)("retains the plan ceiling without switching provider for mode %s", async mode => {
        const f = fixture();
        f.deps.entitlements = { ...ENT, model_ceiling: "9b" };
        f.deps.codingPreference = async () => ({ saved: "omlx", effective: "omlx", configured: true, envOverride: null,
            models: { omlx: { coder: MODEL } } });
        expect(await runInfer(ask({ mode, local_backend: undefined }), f.deps))
            .toMatchObject({ backend: "refused", gate_outcome: { reason: "omlx_model_ceiling" } });
        expect(f.omlx.detect).not.toHaveBeenCalled();
        expect(f.deps.listTags).not.toHaveBeenCalled();
        expect(f.deps.callLocal).not.toHaveBeenCalled();
        expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it.each(["route", "chat"] as const)("accepts explicit oMLX %s through the MCP envelope", async mode => {
        const f = fixture();
        const response = await prismInferHandler(ask({ mode, local_model: MODEL, route_guard: "local" }), f.deps);
        expect(response.isError).not.toBe(true);
        expect(response.structuredContent).toMatchObject({ backend: "omlx", model_picked: MODEL });
        expect(f.deps.callLocal).not.toHaveBeenCalled();
    });
    it("binds automatic coding selection in production dependencies", () => {
        expect(productionInferDeps().codingModel).toBe(selectUnassignedCodingModel);
    });
    it.each(["coder", "reviewer"] as const)("runs an unassigned %s on a discovered future model outside named tiers", async local_role => {
        const f = fixture(); const id = "vendor/future-build";
        f.deps.codingPreference = async () => ({ saved: "omlx", effective: "omlx", configured: true, envOverride: null });
        const recommend = vi.fn(async () => undefined);
        f.deps.codingModel = options => selectUnassignedCodingModel(options, {
            recommend, omlxModels: async () => [{ id, loaded: false, weightBytes: 1024 ** 3, contextTokens: 65536 }],
            omlxDefault: async () => undefined,
        });
        f.omlx.detect = vi.fn(async model => createOmlxTarget("http://127.0.0.1:8000/v1", model!, 65536, "synthetic-provider-key"));
        const result = await runInfer(ask({ local_role }), f.deps);
        expect(result).toMatchObject({ backend: "omlx", model_picked: id, used_cloud: false, output: OUTPUT });
        expect(recommend.mock.calls[0].slice(0, 2)).toEqual(["omlx", local_role]);
        expect(f.omlx.detect).toHaveBeenCalledWith(id);
        expect(f.deps.listTags).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it.each(["coder", "reviewer"] as const)("keeps discovered Ollama %s selection on its exact-model path", async local_role => {
        const f = fixture(); const id = "vendor/future:tag";
        f.deps.codingPreference = async () => ({ saved: "ollama", effective: "ollama", configured: false, envOverride: null });
        f.deps.codingModel = options => selectUnassignedCodingModel(options, {
            recommend: async () => undefined, ollamaModels: async () => [{ id, loaded: false, weightBytes: 1024 ** 3 }],
            ollamaChoice: async () => ({ tag: id, ctxTokens: 4096, weightsGb: 1, minFreeGb: 3 }),
        });
        f.deps.listTags = async () => new Set([id]);
        f.deps.selectedOllamaModel = vi.fn(async () => ({ tag: id, ctxTokens: 4096, weightsGb: 1, minFreeGb: 3 }));
        const result = await runInfer(ask({ local_backend: "ollama", local_role }), f.deps);
        expect(result).toMatchObject({ backend: "ollama-" + id, model_picked: id, used_cloud: false, output: OUTPUT });
        expect(f.deps.selectedOllamaModel).toHaveBeenCalledWith(f.deps.ollamaUrl, id, "27b", undefined,
            { deadlineMs: undefined, signal: undefined, requestedContextTokens: undefined, track: expect.any(Function) });
        expect(vi.mocked(f.deps.callLocal).mock.calls[0][1]).toBe(id);
        expect(f.omlx.detect).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it("does not consult automatic recommendations for explicit or saved model overrides", async () => {
        for (const explicit of [true, false]) {
            const f = fixture(); f.deps.codingModel = vi.fn(async () => { throw new Error("must not select"); });
            f.deps.codingPreference = async () => ({ saved: "omlx", effective: "omlx", configured: true, envOverride: null,
                models: { omlx: { coder: MODEL, reviewer: MODEL } } });
            expect(await runInfer(ask({ local_role: "reviewer", ...(explicit ? { local_model: MODEL } : {}) }), f.deps))
                .toMatchObject({ backend: "omlx", model_picked: MODEL });
            expect(f.deps.codingModel).not.toHaveBeenCalled();
        }
    });
    it("keeps the configured oMLX profile ID through exact detection", async () => {
        const f = fixture(); const id = "vendor/future-build:fast";
        const recommend = vi.fn(async () => "other-build");
        const inventory = vi.fn(async () => []);
        f.deps.codingPreference = async () => ({ saved: "omlx", effective: "omlx", configured: true, envOverride: null });
        f.deps.codingModel = options => selectUnassignedCodingModel(options, {
            omlxDefault: async () => id, omlxModels: inventory, recommend,
        });
        f.omlx.detect = vi.fn(async model => createOmlxTarget("http://127.0.0.1:8000/v1", model!, 65536, "synthetic-provider-key"));
        expect(await runInfer(ask(), f.deps)).toMatchObject({ backend: "omlx", model_picked: id, output: OUTPUT });
        expect(f.omlx.detect).toHaveBeenCalledWith(id);
        expect(recommend).not.toHaveBeenCalled(); expect(inventory).not.toHaveBeenCalled();
    });
    it("refuses a lower oMLX ceiling before automatic discovery", async () => {
        const f = fixture(); f.deps.entitlements = { ...ENT, model_ceiling: "9b" };
        f.deps.codingPreference = async () => ({ saved: "omlx", effective: "omlx", configured: true, envOverride: null });
        f.deps.codingModel = vi.fn(async () => MODEL);
        expect(await runInfer(ask(), f.deps)).toMatchObject({ backend: "refused", gate_outcome: { reason: "omlx_model_ceiling" } });
        expect(f.deps.codingModel).not.toHaveBeenCalled(); expect(f.omlx.detect).not.toHaveBeenCalled();
    });
    it("settles the caller deadline even when an injected selector ignores it", async () => {
        const f = fixture(); let release!: (id: string) => void; let settled = false;
        const held = new Promise<string>(resolve => { release = resolve; });
        f.deps.codingPreference = async () => ({ saved: "omlx", effective: "omlx", configured: true, envOverride: null });
        f.deps.codingModel = async () => held;
        const pending = runInfer(ask({ timeout_ms: 5 }), f.deps).then(value => { settled = true; return value; });
        try { await new Promise(r => setTimeout(r, 30)); expect(settled).toBe(true); }
        finally { release(MODEL); await pending; }
        expect(await pending).toMatchObject({ backend: "refused", gate_outcome: { reason: "local_coding_selection_timeout" } });
        expect(f.omlx.detect).not.toHaveBeenCalled(); expect(f.omlx.generate).not.toHaveBeenCalled();
        expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it.each([900_500, 0, 0.5])("validates the original timeout %s before automatic selection changes the budget", async timeout_ms => {
        const f = fixture();
        f.deps.codingPreference = async () => ({ saved: "omlx", effective: "omlx", configured: true, envOverride: null });
        f.deps.codingModel = vi.fn(async () => { await new Promise(r => setTimeout(r, 600)); return MODEL; });
        await expect(runInfer(ask({ timeout_ms }), f.deps)).rejects.toThrow("invalid bounded oMLX generation parameters");
        expect(f.deps.codingModel).not.toHaveBeenCalled(); expect(f.omlx.detect).not.toHaveBeenCalled();
        expect(f.omlx.generate).not.toHaveBeenCalled();
    });
    it("exercises the MCP envelope with the selected future model", async () => {
        const f = fixture();
        f.deps.codingPreference = async () => ({ saved: "omlx", effective: "omlx", configured: true, envOverride: null });
        f.deps.codingModel = vi.fn(async () => MODEL);
        const result = await prismInferHandler(ask({ local_role: "reviewer" }), f.deps);
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ backend: "omlx", model_picked: MODEL, used_cloud: false });
        expect(f.deps.codingModel).toHaveBeenCalledWith(expect.objectContaining({ backend: "omlx", role: "reviewer", ceiling: "27b" }));
    });
    it("Auto keeps a plan-limited code call on Ollama even with no caller ceiling", async () => {
        const f = fixture();
        f.deps.entitlements = { ...ENT, model_ceiling: "9b" };
        f.deps.codingPreference = async () => ({ saved: "auto", effective: "auto", envOverride: null, configured: true });
        const result = await runInfer(ask({ local_backend: undefined }), f.deps);
        expect(result.backend).not.toBe("omlx");
        expect(result.backend).not.toBe("refused");
        expect(f.deps.callLocal).toHaveBeenCalled();
        expect(f.omlx.detect).not.toHaveBeenCalled();
    });
    it("applies the saved coding preference before acquiring the correct device lease", async () => {
        const f = fixture();
        f.deps.codingPreference = vi.fn(async () => ({ saved: "auto", effective: "auto", envOverride: null, configured: true, model: MODEL }));
        expect(await runInfer(ask({ local_backend: undefined }), f.deps)).toMatchObject({ backend: "omlx", model_picked: MODEL });
        expect(f.omlx.detect).toHaveBeenCalledWith(MODEL);
        expect(f.deps.listTags).not.toHaveBeenCalled();
    });
    it("does not consult preferences when a task explicitly names backend and model", async () => {
        const f = fixture(); f.deps.codingPreference = vi.fn(async () => { throw new Error("must not read preferences"); });
        expect(await runInfer(ask({ local_model: MODEL }), f.deps)).toMatchObject({ backend: "omlx" });
        expect(f.deps.codingPreference).not.toHaveBeenCalled();
    });
    it.each(["coder", "reviewer"] as const)("uses a shared discovered oMLX model for explicit backend and %s role", async local_role => {
        const f = fixture();
        f.deps.codingPreference = async () => ({ saved: "ollama", effective: "ollama", configured: false, envOverride: null,
            models: { omlx: { coder: MODEL, reviewer: MODEL } } });
        expect(await runInfer(ask({ local_role }), f.deps)).toMatchObject({ backend: "omlx", model_picked: MODEL });
        expect(f.omlx.detect).toHaveBeenCalledWith(MODEL);
    });
    it.each(["coder", "reviewer"] as const)("uses the selected Ollama %s model without a named-tier fallback", async local_role => {
        const f = fixture(); const id = "org/next-build:tag";
        f.deps.listTags = async () => new Set([id, "prism-coder:4b"]);
        f.deps.codingPreference = async () => ({ saved: "ollama", effective: "ollama", configured: false, envOverride: null,
            models: { ollama: { coder: id, reviewer: id } } });
        f.deps.selectedOllamaModel = vi.fn(async () => ({ tag: id, ctxTokens: 4096, weightsGb: 10, minFreeGb: 15 }));
        expect(await runInfer(ask({ local_backend: "ollama", local_role }), f.deps)).toMatchObject({ backend: "ollama-" + id, model_picked: id });
        expect(f.deps.selectedOllamaModel).toHaveBeenCalledWith(f.deps.ollamaUrl, id, "27b", undefined,
            { deadlineMs: undefined, signal: undefined, requestedContextTokens: undefined, track: expect.any(Function) });
        const call = vi.mocked(f.deps.callLocal).mock.calls[0];
        expect(call[1]).toBe(id); expect(call[10]).toBe(4096);
        expect(call[4]).toBe(1024); expect(call[6]).toBe(300_000);
        expect(f.omlx.detect).not.toHaveBeenCalled();
    });
    it('assigns oMLX role budgets after backend selection while preserving explicit budgets', async () => {
        const f = fixture();
        await runInfer(ask({ local_role: 'coder', local_model: MODEL }), f.deps);
        expect(vi.mocked(f.omlx.generate).mock.calls[0][1].maxTokens).toBe(4096);
        const explicit = fixture();
        await runInfer(ask({ local_role: 'reviewer', local_model: MODEL, max_tokens: 512, timeout_ms: 10000 }), explicit.deps);
        expect(vi.mocked(explicit.omlx.generate).mock.calls[0][1].maxTokens).toBe(512);
        expect(vi.mocked(explicit.omlx.generate).mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(10000);
    });
    it('documents explicit-role budgets and preserves legacy role-less budgets', async () => {
        const properties = PRISM_INFER_TOOL.inputSchema.properties as Record<string, any>;
        expect(properties.timeout_ms.description).toContain('oMLX 600s');
        expect(properties.max_tokens.description).toContain('oMLX defaults 4096');
        const f = fixture(); await runInfer(ask({ local_model: MODEL }), f.deps);
        expect(vi.mocked(f.omlx.generate).mock.calls[0][1].maxTokens).toBe(1024);
        expect(vi.mocked(f.omlx.generate).mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(300_000);
    });
    it.each(["ollama_model_metadata_incomplete", "ollama_model_ceiling", "ollama_model_memory_unknown"])("refuses %s instead of substituting another model", async reason => {
        const f = fixture(); const id = "new:tag";
        f.deps.listTags = async () => new Set([id, "prism-coder:4b"]);
        f.deps.selectedOllamaModel = async () => { throw new Error(reason); };
        expect(await runInfer(ask({ local_backend: "ollama", local_model: id }), f.deps)).toMatchObject({ backend: "refused", gate_outcome: { reason } });
        expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it.each([undefined, '9b'] as const)('treats complexity as a hint while preserving explicit ceiling %s', async model_ceiling => {
        const f = fixture(); const id = 'future:tag';
        f.deps.listTags = async () => new Set([id, 'prism-coder:4b']);
        f.deps.selectedOllamaModel = vi.fn(async () => ({ tag: id, ctxTokens: 4096, weightsGb: 10, minFreeGb: 15 }));
        await runInfer(ask({ local_backend: 'ollama', local_model: id, task_complexity: 2, model_ceiling }), f.deps);
        expect(f.deps.selectedOllamaModel).toHaveBeenCalledWith(f.deps.ollamaUrl, id, model_ceiling ?? '27b', undefined,
            { deadlineMs: undefined, signal: undefined, requestedContextTokens: undefined, track: expect.any(Function) });
    });
    it('returns a structured refusal for unreadable preferences without substituting a backend default', async () => {
        const f = fixture(); f.deps.codingPreference = async () => { throw new Error('synthetic-secret'); };
        expect(await runInfer(ask({ local_backend: 'ollama' }), f.deps)).toMatchObject({ backend: 'refused', output: '', gate_outcome: { reason: 'local_coding_preference_invalid' } });
        expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.omlx.detect).not.toHaveBeenCalled();
    });
    it('reports a safe exact assignment conflict without exposing unknown preference errors', async () => {
        const conflict = fixture();
        conflict.deps.codingPreference = async () => { throw new Error('execution_assignment_override_conflict'); };
        expect(await runInfer(ask({ local_backend: 'ollama' }), conflict.deps)).toMatchObject({
            backend: 'refused', output: '', gate_outcome: { reason: 'execution_assignment_override_conflict' },
        });
        const unknown = fixture();
        unknown.deps.codingPreference = async () => { throw new Error('private-path-or-secret'); };
        expect(await runInfer(ask({ local_backend: 'ollama' }), unknown.deps)).toMatchObject({
            backend: 'refused', output: '', gate_outcome: { reason: 'local_coding_preference_invalid' },
        });
    });
    it('does not call an unreachable inventory proof that a model is missing', async () => {
        const f = fixture(); f.deps.listTags = async () => null;
        expect(await runInfer(ask({ local_backend: 'ollama', local_model: 'future:tag' }), f.deps)).toMatchObject({ backend: 'refused', gate_outcome: { reason: 'ollama_model_inventory_unavailable' } });
        expect(f.deps.callLocal).not.toHaveBeenCalled();
    });
    it("detects first, classifies with the oMLX classifier without touching Ollama, and reports actual metadata", async () => {
        const f = fixture(); const result = await runInfer(ask({ local_model: MODEL }), f.deps);
        expect(f.events).toEqual(["detect", "classify", "generate"]);
        expect(f.omlx.detect).toHaveBeenCalledWith(MODEL);
        // The classifier reads with the oMLX model and the owned-path adapter, never Ollama's 4b.
        expect(vi.mocked(f.deps.callLayer1!).mock.calls[0][2]).toBe(OMLX_LAYER1_MODEL);
        expect(typeof vi.mocked(f.deps.callLayer1!).mock.calls[0][3]).toBe("function");
        expect(f.loaded.size).toBe(0); expect(f.omlx.unload).not.toHaveBeenCalled();
        expect(result).toMatchObject({ backend: "omlx", model_picked: MODEL, output: OUTPUT, used_cloud: false,
            prompt_tokens: 31, completion_tokens: 12, plan: "standard", entitlements_source: "portal",
            history_turns: 0, gate_outcome: { status: "success", served_anyway: false } });
        expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it.each(["omlx_model_not_advertised", "omlx_auth_failed", "omlx_detection_unavailable"])("detection failure %s leaves Ollama untouched with no generation or fallback", async reason => {
        const f = fixture(); f.loaded.add("other-user-model"); f.omlx.detect = vi.fn(async () => { throw new OmlxError(reason); });
        expect(await runInfer(ask({ cloud_fallback: true }), f.deps)).toMatchObject({ backend: "refused", output: "", gate_outcome: { status: "refused", reason, served_anyway: false } });
        expect(f.omlx.unload).not.toHaveBeenCalled(); expect(f.omlx.generate).not.toHaveBeenCalled();
        expect(f.deps.callLayer1).not.toHaveBeenCalled(); expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
        expect([...f.loaded]).toEqual(["other-user-model"]);
    });
    it("requires the cross-process lease after detection and releases it on refusal", async () => {
        const busy = fixture(); busy.omlx.acquire = vi.fn(async () => { throw new OmlxError("omlx_resource_busy"); });
        expect(await runInfer(ask(), busy.deps)).toMatchObject({ backend: "refused", gate_outcome: { status: "refused", reason: "omlx_resource_busy" } });
        expect(busy.omlx.detect).toHaveBeenCalledTimes(1);
        expect(busy.omlx.unload).not.toHaveBeenCalled(); expect(busy.omlx.generate).not.toHaveBeenCalled();
        expect(busy.deps.callLayer1).not.toHaveBeenCalled();
        const refused = fixture(); const release = vi.fn(async () => {});
        refused.omlx.acquire = vi.fn(async () => release);
        refused.deps.callLayer1 = async () => "OBVIOUS_RESERVED";
        await runInfer(ask(), refused.deps); expect(release).toHaveBeenCalledTimes(1);
    });
    it("recovers this provider's stale marker right after the device lease, before Layer 1", async () => {
        const f = fixture(); f.omlx.recover = vi.fn(async () => { f.events.push("recover"); });
        await runInfer(ask(), f.deps);
        expect(f.events.slice(0, 3)).toEqual(["detect", "recover", "classify"]);
        expect(f.omlx.acquire).toHaveBeenCalledWith(undefined, { recoveryProviderId: TARGET.url });
        const refused = fixture(); const release = vi.fn(async () => {});
        refused.omlx.acquire = vi.fn(async () => release);
        refused.omlx.recover = vi.fn(async () => { throw new OmlxError("omlx_provider_quarantined"); });
        expect(await runInfer(ask(), refused.deps)).toMatchObject({ backend: "refused", gate_outcome: { reason: "omlx_provider_quarantined" } });
        expect(refused.deps.callLayer1).not.toHaveBeenCalled(); expect(refused.omlx.generate).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(1);
    });
    it("keeps the device lease until an owned generation settles, even after the handler's own timeout answered", async () => {
        const f = fixture();
        f.omlx.acquire = vi.fn(async () => async () => { f.events.push("release"); });
        f.omlx.generate = vi.fn(() => new Promise(resolve => setTimeout(() => {
            f.events.push("generation-settled"); resolve({ ok: false as const, reason: "timeout" });
        }, 300)));
        await expect(runInfer(ask({ timeout_ms: 50 }), f.deps)).rejects.toThrow("no backend produced output");
        expect(f.events.indexOf("generation-settled")).toBeGreaterThan(-1);
        expect(f.events.indexOf("generation-settled")).toBeLessThan(f.events.indexOf("release"));
    });
    it("keeps the device lease until a timed out capacity operation settles", async () => {
        const f = fixture();
        f.omlx.acquire = vi.fn(async () => async () => { f.events.push("release"); });
        f.omlx.reclaim = vi.fn(() => new Promise(resolve => setTimeout(() => {
            f.events.push("reclaim-settled"); resolve();
        }, 100)));
        const result = await runInfer(ask({ timeout_ms: 20 }), f.deps).catch(error => error);
        expect(f.events.indexOf("reclaim-settled")).toBeGreaterThan(-1);
        expect(f.events.indexOf("release")).toBeGreaterThan(f.events.indexOf("reclaim-settled"));
        expect(f.omlx.generate).not.toHaveBeenCalled();
        expect(result).not.toMatchObject({ backend: "omlx" });
    });
    it("refuses unreadable Ollama state at admission without classifying", async () => {
        const f = fixture(); f.omlx.listLoaded = async () => { throw new Error("raw secret"); };
        const result = await runInfer(ask(), f.deps);
        expect(result).toMatchObject({ backend: "refused", gate_outcome: { status: "refused", reason: "omlx_ollama_state_unavailable", served_anyway: false } });
        expect(JSON.stringify(result)).not.toContain("raw secret");
        expect(f.deps.callLayer1).not.toHaveBeenCalled(); expect(f.omlx.unload).not.toHaveBeenCalled();
        expect(f.omlx.generate).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it("preserves every resident Ollama model and refuses contention before classification", async () => {
        const f = fixture(); f.loaded.add("prism-coder:27b"); f.loaded.add("other-user-model");
        const result = await runInfer(ask(), f.deps);
        expect(f.events).toEqual(["detect"]);
        expect([...f.loaded]).toEqual(["prism-coder:27b", "other-user-model"]);
        expect(f.omlx.unload).not.toHaveBeenCalled();
        expect(result).toMatchObject({ backend: "refused", output: "", gate_outcome: { reason: "omlx_memory_contention" } });
    });
    it("never attempts an Ollama unload in either escalation mode", async () => {
        for (const escalation of ["report", undefined] as const) {
            const f = fixture(); f.loaded.add("other-user-model");
            f.omlx.unload = vi.fn(async () => { throw new OmlxError("omlx_ollama_unload_failed"); });
            const run = runInfer(ask({ escalation }), f.deps);
            if (escalation === "report") {
                expect(await run).toMatchObject({ backend: "refused", output: "", used_cloud: false,
                    gate_outcome: { status: "refused", reason: "omlx_memory_contention", served_anyway: false } });
            } else await expect(run).rejects.toThrow("omlx_memory_contention");
            expect(f.omlx.unload).not.toHaveBeenCalled();
            expect(f.deps.callLayer1).not.toHaveBeenCalled(); expect(f.omlx.generate).not.toHaveBeenCalled();
            expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
        }
    });
    it("runs oMLX classification and generation without querying Ollama model tags or ordinary loaded models", async () => {
        const f = fixture();
        f.deps.listTags = vi.fn(async () => { throw new Error("Ollama must not be needed"); });
        f.deps.listLoaded = vi.fn(async () => { throw new Error("ordinary Ollama probe must not run"); });
        expect(await runInfer(ask(), f.deps)).toMatchObject({ backend: "omlx", output: OUTPUT });
        expect(f.deps.listTags).not.toHaveBeenCalled(); expect(f.deps.listLoaded).not.toHaveBeenCalled();
        expect(f.omlx.listLoaded).toHaveBeenCalled(); expect(f.deps.callLayer1).toHaveBeenCalled();
    });
    it("refuses, and unloads nothing, when any model appears in Ollama during classification", async () => {
        const f = fixture();
        f.deps.callLayer1 = vi.fn(async () => { f.loaded.add("other-user-model"); return "OBVIOUS_NOT_RESERVED" as const; });
        await expect(runInfer(ask(), f.deps)).rejects.toThrow("omlx_memory_contention");
        expect(f.omlx.unload).not.toHaveBeenCalled();
        expect([...f.loaded]).toEqual(["other-user-model"]);
        expect(f.omlx.generate).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it("skips the hedge second read: the oMLX classifier already read every window, so the hedge stands and refuses", async () => {
        const f = fixture();
        f.deps.secondReadPolicy = async () => SECOND_READ_POLICY;
        f.deps.callLayer1 = vi.fn(async (text: string) =>
            text === "Draft a Python identity helper." ? "UNCERTAIN" as const : "OBVIOUS_NOT_RESERVED" as const) as unknown as InferDeps["callLayer1"];
        f.deps.probeClassifierLimits = vi.fn(async () => ({ numCtx: null, overheadBound: null }));
        const result = await runInfer(ask({ messages: [{ role: "user", content: "The helper returns its argument." }, { role: "assistant", content: "Noted." }] }), f.deps);
        expect(result).toMatchObject({ backend: "refused", gate_outcome: { status: "refused" } });
        expect(result.attempts.map(a => a.reason)).toEqual(expect.arrayContaining(["layer1_hedge_second_read_skipped_omlx", "layer1_uncertain"]));
        expect(f.deps.probeClassifierLimits).not.toHaveBeenCalled();
        for (const call of vi.mocked(f.deps.callLayer1!).mock.calls) expect(call[2]).toBe(OMLX_LAYER1_MODEL);
        expect(f.loaded.size).toBe(0); expect(f.omlx.generate).not.toHaveBeenCalled();
    });
    it("a reserved refusal leaves Ollama untouched", async () => {
        const f = fixture(); f.deps.callLayer1 = vi.fn(async () => "OBVIOUS_RESERVED" as const);
        expect(await runInfer(ask(), f.deps)).toMatchObject({ backend: "refused" });
        expect(f.loaded.size).toBe(0); expect(f.omlx.unload).not.toHaveBeenCalled();
    });
    it("never serves on the keyword backstop alone when the classifier errs, in either mode", async () => {
        for (const escalation of ["report", undefined] as const) {
            const f = fixture();
            f.deps.callLayer1 = vi.fn(async () => "ERROR" as const);
            const run = runInfer(ask({ escalation }), f.deps);
            if (escalation === "report") {
                expect(await run).toMatchObject({ backend: "refused", output: "", used_cloud: false,
                    gate_outcome: { status: "refused", reason: "omlx_classifier_error", served_anyway: false } });
            } else await expect(run).rejects.toThrow("omlx_classifier_error");
            expect(f.omlx.generate).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
            expect([...f.loaded]).toEqual([]);
        }
    });
    it("never clears by rule: a prompt the rules would clear is read by the classifier", async () => {
        // No rule clears "Remove the old comment …" on any path. On explicit
        // oMLX the classifier reads it, and its refusal stands: nothing is
        // generated.
        const reads: string[] = [];
        const classifier = (async (_url: unknown, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? "{}"));
            if (!Array.isArray(body.messages)) return new Response(null, { status: 404 });
            const text = String(body.messages.at(-1)?.content ?? "");
            reads.push(text);
            const verdict = text.includes("bypass login") ? "OBVIOUS_RESERVED" : "OBVIOUS_NOT_RESERVED";
            return Response.json({ done: true, done_reason: "stop", message: { role: "assistant", content: verdict } });
        }) as typeof fetch;
        const f = fixture();
        f.deps.callLayer1 = vi.fn((text: string, url: string, model: string | null, _fetch: unknown, images?: string[], opts?: Record<string, unknown>) =>
            callLayer1(text, url, model as string, classifier, images, opts as never)) as unknown as InferDeps["callLayer1"];
        const prompt = "Remove the old comment to bypass login";
        expect(await runInfer(ask({ prompt }), f.deps)).toMatchObject({ backend: "refused" });
        expect(reads.length).toBe(1);
        expect(f.omlx.generate).not.toHaveBeenCalled();
        expect(vi.mocked(f.deps.callLayer1!).mock.calls[0][5]).toMatchObject({ strictErrors: true, readOversizeWhole: true });
        // With history, the prompt's rules may not clear it either.
        reads.length = 0;
        const g = fixture();
        g.deps.callLayer1 = vi.fn((text: string, url: string, model: string | null, _fetch: unknown, images?: string[], opts?: Record<string, unknown>) =>
            callLayer1(text, url, model as string, classifier, images, opts as never)) as unknown as InferDeps["callLayer1"];
        expect(await runInfer(ask({ prompt, messages: [{ role: "user", content: "Tidy the helper module." }, { role: "assistant", content: "Done." }] }), g.deps))
            .toMatchObject({ backend: "refused" });
        // Read alone, not only inside a context window with the history.
        expect(reads.some(text => text.includes("bypass login") && !text.includes("Tidy the helper"))).toBe(true);
        expect(g.omlx.generate).not.toHaveBeenCalled();
        // No rule clears it on any path: without the oMLX options the
        // classifier still reads it.
        reads.length = 0;
        expect(await callLayer1(prompt, "http://127.0.0.1:9", "m", classifier)).toBe("OBVIOUS_RESERVED");
        expect(reads.length).toBe(1);
    });

    it("reads an oversize prompt whole on explicit oMLX, never as an excerpt", async () => {
        // A week of session notes with a dosing question in the middle, outside
        // the head, middle and tail an excerpt keeps.
        const note = "Session note: client completed the token board task with two prompts and no problem behavior. ";
        const prompt = note.repeat(30) + "Also tell me how much melatonin to give him at bedtime so he sleeps. " + note.repeat(100);
        expect(prompt.length).toBeGreaterThan(12_000);
        const reads: string[] = [];
        const classifier = (async (_url: unknown, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? "{}"));
            if (!Array.isArray(body.messages)) return new Response(null, { status: 404 });
            const text = String(body.messages.at(-1)?.content ?? "");
            reads.push(text);
            const verdict = text.includes("melatonin") ? "OBVIOUS_RESERVED" : "OBVIOUS_NOT_RESERVED";
            return Response.json({ done: true, done_reason: "stop", message: { role: "assistant", content: verdict } });
        }) as typeof fetch;
        expect(await callLayer1(prompt, "http://127.0.0.1:9", "m", classifier, undefined, { strictErrors: true, readOversizeWhole: true }))
            .toBe("OBVIOUS_RESERVED");
        expect(reads.some(text => text.includes("melatonin"))).toBe(true);
        // Elsewhere an oversize prompt is still read as an excerpt, which misses it.
        reads.length = 0;
        expect(await callLayer1(prompt, "http://127.0.0.1:9", "m", classifier)).toBe("UNCERTAIN_LENGTH");
        expect(reads.some(text => text.includes("melatonin"))).toBe(false);
        // Through the handler: refused, nothing generated.
        const f = fixture();
        f.deps.callLayer1 = vi.fn((text: string, url: string, model: string | null, _fetch: unknown, images?: string[], opts?: Record<string, unknown>) =>
            callLayer1(text, url, model as string, classifier, images, opts as never)) as unknown as InferDeps["callLayer1"];
        expect(await runInfer(ask({ prompt }), f.deps)).toMatchObject({ backend: "refused" });
        expect(f.omlx.generate).not.toHaveBeenCalled();
    });

    it("an oversize prompt whose excerpt the classifier could not read is refused, never served on the keyword floor", async () => {
        // A long keyword-clean prompt: the shared oversize mapping would turn
        // an unread excerpt into UNCERTAIN_LENGTH and generate.
        const failing = (async () => new Response("down", { status: 500 })) as typeof fetch;
        const prompt = "Draft a Python identity helper that returns its argument unchanged. ".repeat(80);
        expect(prompt.length).toBeGreaterThan(4000);
        for (const escalation of ["report", undefined] as const) {
            const f = fixture();
            f.deps.callLayer1 = vi.fn((text: string, url: string, model: string | null, _fetch: unknown, images?: string[], opts?: Record<string, unknown>) =>
                callLayer1(text, url, model as string, failing, images, opts as never)) as unknown as InferDeps["callLayer1"];
            const run = runInfer(ask({ prompt, escalation }), f.deps);
            if (escalation === "report") {
                expect(await run).toMatchObject({ backend: "refused", gate_outcome: { status: "refused", reason: "omlx_classifier_error" } });
            } else await expect(run).rejects.toThrow("omlx_classifier_error");
            expect(f.omlx.generate).not.toHaveBeenCalled();
        }
        // Ordinary callers keep the documented oversize mapping.
        expect(await callLayer1(prompt, "http://127.0.0.1:9", "prism-coder:4b", failing)).toBe("UNCERTAIN_LENGTH");
        expect(await callLayer1(prompt, "http://127.0.0.1:9", "prism-coder:4b", failing, undefined, { strictErrors: true })).toBe("ERROR");
    });
    it("a history window the classifier cannot read is refused as uncertain, never served", async () => {
        const f = fixture();
        f.deps.callLayer1 = vi.fn(async (text: string) =>
            text === "Draft a Python identity helper." ? "OBVIOUS_NOT_RESERVED" as const : "ERROR" as const) as unknown as InferDeps["callLayer1"];
        const result = await runInfer(ask({ messages: [{ role: "user", content: "An earlier turn the classifier cannot read." }, { role: "assistant", content: "Noted." }] }), f.deps);
        expect(result).toMatchObject({ backend: "refused", gate_outcome: { status: "refused" } });
        // Window errors already fail closed: they count as an uncertain read.
        expect(result.attempts.map(a => a.reason)).toContain("layer1_uncertain");
        expect(f.omlx.generate).not.toHaveBeenCalled();
    });
    it("refuses explicit oMLX below the top model ceiling before detection or any Ollama call", async () => {
        const cases: [string, Partial<PrismInferArgs>, PrismEntitlements][] = [
            ["plan ceiling", {}, { ...ENT, model_ceiling: "9b" }],
            ["caller ceiling", { model_ceiling: "2b" }, ENT],
            // An explicit ceiling still wins over a hint, and a hint cannot lift the plan.
            ["caller ceiling with a high hint", { model_ceiling: "9b", task_complexity: 9 }, ENT],
            ["plan ceiling with a high hint", { task_complexity: 9 }, { ...ENT, model_ceiling: "9b" }],
        ];
        for (const [label, extra, entitlements] of cases) {
            for (const escalation of ["report", undefined] as const) {
                const f = fixture(); f.deps.entitlements = entitlements;
                const run = runInfer(ask({ ...extra, escalation }), f.deps);
                if (escalation === "report") {
                    expect(await run, label).toMatchObject({ backend: "refused", gate_outcome: { status: "refused", reason: "omlx_model_ceiling", served_anyway: false } });
                } else await expect(run, label).rejects.toThrow("omlx_model_ceiling");
                expect(f.omlx.detect, label).not.toHaveBeenCalled(); expect(f.omlx.acquire, label).not.toHaveBeenCalled();
                expect(f.deps.callLayer1, label).not.toHaveBeenCalled(); expect(f.omlx.unload, label).not.toHaveBeenCalled();
                expect(f.omlx.generate, label).not.toHaveBeenCalled(); expect(f.deps.callCloud, label).not.toHaveBeenCalled();
            }
        }
    });
    // session_task_route puts task_complexity in its recommended_args; a caller that
    // copies them into an explicit oMLX call was refused in 8 ms (2026-10-18).
    it("a complexity hint picks Ollama's starting tier, so it never refuses explicit oMLX", async () => {
        for (const task_complexity of [1, 4, 6, 9]) {
            for (const escalation of ["report", undefined] as const) {
                const f = fixture();
                const result = await runInfer(ask({ task_complexity, escalation }), f.deps);
                expect(result, `complexity ${task_complexity}`).toMatchObject({ backend: "omlx", output: OUTPUT, gate_outcome: { status: "success" } });
                expect(f.events, `complexity ${task_complexity}`).toEqual(["detect", "classify", "generate"]);
                // The hint's fast-task "no thinking" shortcut is Ollama's too: the oMLX server's settings own thinking.
                expect(vi.mocked(f.omlx.generate).mock.calls[0][1].think, `complexity ${task_complexity}`).toBeUndefined();
                expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
            }
        }
    });
    it("never substitutes another backend after generation failure, regardless of cloud option", async () => {
        for (const cloud_fallback of [undefined, true, false]) {
            const f = fixture(); f.omlx.generate = vi.fn(async () => ({ ok: false, reason: "omlx_http_507" }));
            await expect(runInfer(ask({ cloud_fallback }), f.deps)).rejects.toThrow("omlx_http_507");
            expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
        }
    });
    it("preserves reserved, entitlement, context, and quality gates", async () => {
        const reserved = fixture(); reserved.deps.callLayer1 = async () => "OBVIOUS_RESERVED";
        expect(await runInfer(ask({ cloud_fallback: true }), reserved.deps)).toMatchObject({ backend: "refused", output: "", gate_outcome: { status: "refused", reason: "layer1_reserved" } });
        expect(reserved.omlx.unload).not.toHaveBeenCalled(); expect(reserved.omlx.generate).not.toHaveBeenCalled(); expect(reserved.deps.callCloud).not.toHaveBeenCalled();
        const denied = fixture(); denied.deps.entitlements = { ...ENT, multi_turn: { enabled: false, max_turns: 0, max_chars: 0 } };
        expect(await runInfer(ask({ messages: [{ role: "user", content: "earlier task" }] }), denied.deps)).toMatchObject({ gate_outcome: { reason: "multi_turn_not_in_plan" } });
        expect(denied.omlx.detect).not.toHaveBeenCalled();
        const oversized = fixture();
        await expect(runInfer(ask({ prompt: "x".repeat(65536) }), oversized.deps)).rejects.toThrow("omlx_ctx_insufficient");
        expect(oversized.omlx.unload).not.toHaveBeenCalled();
        const degraded = fixture(); degraded.omlx.generate = async () => ({ ok: true, text: "A useful draft that is incomplete at the token budget", doneReason: "length" });
        expect(await runInfer(ask({ think: false }), degraded.deps)).toMatchObject({ backend: "omlx", quality_gate_failed: true, gate_outcome: { status: "degraded", served_anyway: true } });
    });
    it("keeps accepted history and the same-model local answer-check policy without reloading Ollama", async () => {
        const f = fixture();
        f.omlx.generate = vi.fn(async (_target, request) => ({ ok: true,
            text: request.messages[0]?.content === POLICY.systemPrompt ? "PASS" : OUTPUT, doneReason: "stop" }));
        const messages = [{ role: "user" as const, content: "Draft a Python identity helper." }, { role: "assistant" as const, content: OUTPUT }];
        // The caller's sampling must not leak into the answer check.
        const result = await runInfer(ask({ messages, prompt: "Return the accepted helper again.", temperature: 0.7, think: !ANSWER_GROUNDING_THINK }), f.deps);
        expect(result).toMatchObject({ backend: "omlx", history_turns: 2, gate_outcome: { status: "success" } });
        const generated = vi.mocked(f.omlx.generate).mock.calls;
        expect(generated[0][1].messages).toEqual([...messages, { role: "user", content: "Return the accepted helper again." }]);
        expect(generated[0][1]).toMatchObject({ temperature: 0.7, think: !ANSWER_GROUNDING_THINK });
        expect(generated[1][0].model).toBe(MODEL);
        expect(generated[1][1].messages[0].content).toBe(POLICY.systemPrompt);
        expect(generated[1][1].temperature).toBe(0);
        expect(generated[1][1].think).toBe(ANSWER_GROUNDING_THINK);
        expect(f.deps.callLocal).not.toHaveBeenCalled();
    });
    it.each([undefined, null, "tool_calls", "content_filter"])("never promotes provider completion state %j to a successful draft", async finish_reason => {
        const f = fixture();
        const target = createOmlxTarget(TARGET.url, MODEL, TARGET.contextTokens, "synthetic-provider-key");
        f.omlx.detect = async () => target;
        f.omlx.generate = async (selected, request, signal) => ownedOmlxGenerate(selected, request, signal, {
            fetchImpl: fakeControl({ script: completes(OUTPUT, finish_reason) }).fetchImpl,
            stateDirectory: mkdtempSync(join(tmpdir(), "prism-owned-handler-")), drainBudgetMs: 300 });
        await expect(runInfer(ask(), f.deps)).rejects.toThrow("omlx_finish_reason_invalid");
        expect(f.deps.callCloud).not.toHaveBeenCalled(); expect(f.deps.callLocal).not.toHaveBeenCalled();
    });
    it("never fabricates a terminal stop for a history-check PASS with missing completion state", async () => {
        const f = fixture();
        f.omlx.generate = vi.fn(async (_target, request) => request.messages[0]?.content === POLICY.systemPrompt
            ? { ok: true, text: "PASS" } : { ok: true, text: OUTPUT, doneReason: "stop" });
        const messages = [{ role: "user" as const, content: "Draft a Python identity helper." }, { role: "assistant" as const, content: OUTPUT }];
        expect(await runInfer(ask({ messages, prompt: "Return the accepted helper again." }), f.deps)).toMatchObject({
            output: "", backend: "refused", used_cloud: false,
            gate_outcome: { status: "refused", served_anyway: false, reason: "answer_unverified" },
        });
        expect(f.deps.callCloud).not.toHaveBeenCalled(); expect(f.deps.callLocal).not.toHaveBeenCalled();
    });
    it("leaves the oMLX read options off an ordinary Ollama call, single-turn and with history", async () => {
        const history = [{ role: "user" as const, content: "Tidy the helper module." }, { role: "assistant" as const, content: "Done." }];
        for (const messages of [undefined, history]) {
            const f = fixture(); f.loaded.clear();
            await runInfer({ prompt: "Draft a Python identity helper.", mode: "code", cloud_fallback: false, escalation: "report", ...(messages ? { messages } : {}) }, f.deps);
            const calls = vi.mocked(f.deps.callLayer1!).mock.calls;
            expect(calls.length, messages ? "history" : "single").toBeGreaterThan(0);
            for (const call of calls) {
                const opts = (call[5] ?? {}) as Record<string, unknown>;
                expect(opts).not.toHaveProperty("strictErrors");
                expect(opts).not.toHaveProperty("readOversizeWhole");
            }
            expect(f.omlx.detect).not.toHaveBeenCalled();
        }
    });
    it.each(["27b", "9b", "4b", "2b"] as const)("ordinary callers retain Ollama tier %s without touching oMLX", async model_ceiling => {
        const f = fixture(); f.loaded.clear();
        const result = await runInfer({ prompt: "Draft a Python identity helper.", mode: "code", model_ceiling, cloud_fallback: false }, f.deps);
        expect(result.backend).toBe("ollama-" + model_ceiling);
        expect(f.omlx.detect).not.toHaveBeenCalled(); expect(f.omlx.unload).not.toHaveBeenCalled();
    });
    it("serializes real explicit calls and blocks even standalone in-process classification", async () => {
        const f = fixture(); let release!: () => void; let entered!: () => void;
        const waiting = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        let calls = 0;
        f.omlx.generate = vi.fn(async () => {
            if (++calls === 1) { entered(); await waiting; }
            return { ok: true, text: OUTPUT, doneReason: "stop" };
        });
        const first = runInfer(ask(), f.deps); await started;
        const second = runInfer(ask(), f.deps);
        let classified = false;
        const standalone = callLayer1("Write a Python identity function.", "http://unused", "prism-coder:4b")
            .then(() => { classified = true; });
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(f.omlx.detect).toHaveBeenCalledTimes(1); expect(classified).toBe(false);
        release(); await Promise.all([first, second, standalone]);
        expect(f.omlx.generate).toHaveBeenCalledTimes(2); expect(classified).toBe(true);
    });
    it("preserves configured oMLX thinking unless explicitly overridden", async () => {
        const f = fixture(); await runInfer(ask(), f.deps);
        expect(vi.mocked(f.omlx.generate).mock.calls[0][1].think).toBeUndefined();
        expect(vi.mocked(f.omlx.generate).mock.calls[0][1].temperature).toBeUndefined();
        await runInfer(ask({ think: true, temperature: 0 }), f.deps);
        expect(vi.mocked(f.omlx.generate).mock.calls[1][1].think).toBe(true);
        expect(vi.mocked(f.omlx.generate).mock.calls[1][1].temperature).toBe(0);
    });
    it("does not disable explicit/configured thinking in generic truncation or think-only retries", async () => {
        const truncated = fixture();
        truncated.omlx.generate = vi.fn(async () => ({ ok: true, text: "A useful draft that is incomplete at the token budget", doneReason: "length" }));
        const result = await runInfer(ask({ think: true }), truncated.deps);
        expect(result.gate_outcome?.status).toBe("degraded");
        expect(truncated.omlx.generate).toHaveBeenCalledTimes(1);
        expect(vi.mocked(truncated.omlx.generate).mock.calls[0][1].think).toBe(true);
        const thinking = fixture(); thinking.omlx.generate = vi.fn(async () => ({ ok: false, reason: "think_only" }));
        await expect(runInfer(ask({ think: true }), thinking.deps)).rejects.toThrow("think_only");
        expect(thinking.omlx.generate).toHaveBeenCalledTimes(1);
    });
    it("validates the explicit selector and bounded text-only scope", () => {
        expect(isPrismInferArgs(ask({ local_model: MODEL }))).toBe(true);
        for (const args of [{ prompt: "task", local_backend: "other" }, { prompt: "task", local_model: MODEL },
            ask({ images: ["abc"] }), ask({ local_model: " " })]) expect(isPrismInferArgs(args)).toBe(false);
    });
});

describe("explicit oMLX classification through the real callLayer1 and the owned path", () => {
    type Answer = Awaited<ReturnType<OmlxRuntime["generate"]>>;
    // The real classifier entry point. Every classifier read reaches the
    // runtime's generate with the classifier model; the rest is generation and
    // the answer check on the detected model.
    function owned(classify: (request: OmlxRequest) => Answer | Promise<Answer>) {
        const f = fixture(); f.deps.callLayer1 = undefined;
        const classifierRequests: OmlxRequest[] = [];
        f.omlx.generate = vi.fn(async (target: OmlxTarget, request: OmlxRequest) => {
            if (target.model === OMLX_LAYER1_MODEL) { f.events.push("classify"); classifierRequests.push(request); return classify(request); }
            f.events.push("generate");
            return { ok: true as const, text: request.messages[0]?.content === POLICY.systemPrompt ? "PASS" : OUTPUT, doneReason: "stop" };
        });
        return { ...f, classifierRequests };
    }
    const ollamaChat = (spy: { mock: { calls: unknown[][] } }) =>
        spy.mock.calls.filter(([input]) => /\/api\/(chat|show)\b/.test(String(input instanceof Request ? input.url : input)));

    it.each([undefined, "route", "chat"] as const)("keeps the real classifier on oMLX for text mode %s", async mode => {
        const f = owned(() => ({ ok: true, text: "OBVIOUS_NOT_RESERVED", doneReason: "stop" }));
        f.deps.codingPreference = async () => ({ saved: "omlx", effective: "omlx", configured: true, envOverride: null,
            models: { omlx: { coder: MODEL } } });
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        try {
            expect(await runInfer(ask({ mode, local_backend: undefined }), f.deps)).toMatchObject({ backend: "omlx" });
            expect(ollamaChat(fetchSpy)).toEqual([]);
        } finally { fetchSpy.mockRestore(); }
        expect(f.classifierRequests.length).toBeGreaterThan(0);
        expect(vi.mocked(f.omlx.generate).mock.calls.map(call => call[0].model)).toContain(OMLX_LAYER1_MODEL);
        expect(f.deps.listTags).not.toHaveBeenCalled();
        expect(f.deps.callLocal).not.toHaveBeenCalled();
    });

    it("sends the read to the oMLX classifier on the same server, asks for no cache store, and never asks Ollama", async () => {
        const f = owned(() => ({ ok: true, text: "OBVIOUS_NOT_RESERVED", doneReason: "stop" }));
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        try {
            expect(await runInfer(ask(), f.deps)).toMatchObject({ backend: "omlx", gate_outcome: { status: "success" } });
            expect(ollamaChat(fetchSpy)).toEqual([]);
        } finally { fetchSpy.mockRestore(); }
        expect(f.events).toEqual(["detect", "classify", "generate"]);
        expect(vi.mocked(f.omlx.generate).mock.calls[0][0]).toEqual({ url: TARGET.url, model: OMLX_LAYER1_MODEL, contextTokens: TARGET.contextTokens });
        expect(f.classifierRequests[0]).toMatchObject({ maxTokens: 16, temperature: 0, think: false, cacheStore: false });
        expect(f.classifierRequests[0].messages[0]).toEqual({
            role: "system", content: LAYER1_PROMPT.slice(0, LAYER1_PROMPT.indexOf('\n\nRequest:')),
        });
        expect(JSON.parse(f.classifierRequests[0].messages[1].content.split('\n')[0])).toEqual({ request: ask().prompt });
    });

    it("sends the history and context windows of a multi-turn call through the adapter too", async () => {
        const f = owned(() => ({ ok: true, text: "OBVIOUS_NOT_RESERVED", doneReason: "stop" }));
        const messages = [{ role: "user" as const, content: "The helper returns its argument." }, { role: "assistant" as const, content: OUTPUT }];
        expect(await runInfer(ask({ messages, prompt: "Return the accepted helper again." }), f.deps)).toMatchObject({ backend: "omlx" });
        const read = f.classifierRequests.map(request => request.messages[request.messages.length - 1].content);
        expect(f.classifierRequests.length).toBeGreaterThanOrEqual(3);
        expect(read.some(text => text.includes("The helper returns its argument."))).toBe(true);
        expect(read.some(text => text.includes("Return the accepted helper again."))).toBe(true);
        expect(f.classifierRequests.every(request => request.cacheStore === false)).toBe(true);
    });

    it("refuses when the oMLX classifier cannot answer, in either mode, and never generates", async () => {
        for (const escalation of ["report", undefined] as const) {
            const f = owned(() => ({ ok: false, reason: "omlx_control_error" }));
            const run = runInfer(ask({ escalation }), f.deps);
            if (escalation === "report") {
                expect(await run).toMatchObject({ backend: "refused", gate_outcome: { status: "refused", reason: "omlx_classifier_error" } });
            } else await expect(run).rejects.toThrow("omlx_classifier_error");
            expect(f.classifierRequests).toHaveLength(2); // callLayer1's one retry
            expect(f.events).not.toContain("generate");
        }
    });

    it("keeps the device lease until a classifier job the guard gave up on has settled", async () => {
        let free = 30 * 1024 ** 3;
        const f = owned(() => {
            free = 1024 ** 3; // memory pressure: the guard answers before the job ends
            return new Promise(resolve => setTimeout(() => {
                f.events.push("classifier-settled"); resolve({ ok: true, text: "OBVIOUS_NOT_RESERVED", doneReason: "stop" });
            }, 1_500));
        });
        f.deps.freemem = () => free;
        f.omlx.acquire = vi.fn(async () => async () => { f.events.push("release"); });
        expect(await runInfer(ask(), f.deps)).toMatchObject({ backend: "refused", gate_outcome: { reason: "omlx_classifier_error" } });
        expect(f.events.indexOf("classifier-settled")).toBeGreaterThan(-1);
        expect(f.events.indexOf("classifier-settled")).toBeLessThan(f.events.indexOf("release"));
    }, 10_000);

    // Through the real owned path: the first read cannot prove its stop, so its
    // marker stays and the provider is quarantined. The retry is refused
    // without a second registration, and the request is refused.
    it("refuses when a classifier read leaves the provider quarantined, and never registers again", async () => {
        const f = fixture(); f.deps.callLayer1 = undefined;
        const stateDirectory = mkdtempSync(join(tmpdir(), "prism-owned-quarantine-"));
        const control = fakeControl({ script: endsWithoutTerminal,
            status: ids => ({ status: 200, body: record(ids, { state: "claimed", claim_state: "claimed" }) }) });
        f.omlx.generate = vi.fn((target: OmlxTarget, request: OmlxRequest, signal: AbortSignal) =>
            ownedOmlxGenerate(target, request, signal, { fetchImpl: control.fetchImpl, stateDirectory, drainBudgetMs: 50, cancelReadMs: 50 }));
        expect(await runInfer(ask(), f.deps)).toMatchObject({ backend: "refused", gate_outcome: { reason: "omlx_classifier_error" } });
        expect(control.calls.filter(call => call.method === "PUT")).toHaveLength(1);
        expect(vi.mocked(f.omlx.generate).mock.calls.every(([target]) => target.model === OMLX_LAYER1_MODEL)).toBe(true);
    });

    it("classifies through real oMLX ownership even when Ollama is unavailable", async () => {
        const f = owned(() => ({ ok: true, text: "OBVIOUS_NOT_RESERVED", doneReason: "stop" }));
        f.deps.listTags = vi.fn(async () => null);
        expect(await runInfer(ask(), f.deps)).toMatchObject({ backend: "omlx", output: OUTPUT });
        expect(f.classifierRequests.length).toBeGreaterThan(0);
        expect(f.deps.listTags).not.toHaveBeenCalled();
    });
});
