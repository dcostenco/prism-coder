import { afterEach, describe, expect, it, vi } from "vitest";
import { createOmlxRuntime, createOmlxTarget, guardedOmlxGenerate, OMLX_MIN_AVAILABLE_BYTES,
    reclaimIdleOmlxMemory, withInferenceResourceLease, type OmlxRuntime } from "../../src/utils/omlxProvider.js";

const GIB = 1024 ** 3;
const KEY = "synthetic-capacity-key";
const TARGET = createOmlxTarget("http://127.0.0.1:8000/v1", "vendor/future-model", 8192, KEY);
const REQUEST = { messages: [{ role: "user", content: "draft" }], maxTokens: 64, timeoutMs: 200 };
const model = (id: string, overrides = {}) => ({ id, loaded: false, is_loading: false, pinned: false,
    resident_estimated_size: 6 * GIB, last_access: 0, ...overrides });
afterEach(() => vi.restoreAllMocks());

function fixture(rows = [model(TARGET.model), model("vendor/previous", { loaded: true })]) {
    let available = GIB;
    const calls: { path: string; method: string }[] = [];
    const fetchImpl = vi.fn(async (url, init) => {
        const path = new URL(String(url)).pathname;
        calls.push({ path, method: init?.method ?? "GET" });
        expect(init?.redirect).toBe("error");
        expect(init?.headers).toEqual({ Authorization: "Bearer " + KEY });
        if (path.endsWith("/models/status")) return new Response(JSON.stringify({ models: rows }));
        available = 10 * GIB;
        const id = decodeURIComponent(path.slice("/v1/models/".length, -"/unload-idle".length));
        return new Response(JSON.stringify({ status: "ok", model_id: id }));
    }) as unknown as typeof fetch;
    const read = () => available;
    const run = (signal = new AbortController().signal, deadline = Date.now() + 3000) =>
        withInferenceResourceLease(true, () => reclaimIdleOmlxMemory(TARGET, read, signal, deadline, fetchImpl));
    return { calls, fetchImpl, read, run, setAvailable: (bytes: number) => { available = bytes; } };
}

describe("idle-only oMLX capacity reclamation", () => {
    it("uses discovered arbitrary IDs and freshly observed RAM before proceeding", async () => {
        const f = fixture();
        await f.run();
        expect(f.calls).toEqual([{ path: "/v1/models/status", method: "GET" },
            { path: "/v1/models/vendor%2Fprevious/unload-idle", method: "POST" }]);
        expect(f.read()).toBe(10 * GIB);
    });
    it("reclaims for estimated requested weights plus reserve even above the reserve alone", async () => {
        const f = fixture(); f.setAvailable(4 * GIB);
        await f.run();
        expect(f.calls).toHaveLength(2);
    });
    it("keeps resident models when the requested estimate already fits", async () => {
        const f = fixture(); f.setAvailable(8 * GIB);
        await f.run();
        expect(f.calls).toHaveLength(1);
    });
    it("does not count already loaded target weights again or evict that target", async () => {
        const f = fixture([model(TARGET.model, { loaded: true })]);
        f.setAvailable(OMLX_MIN_AVAILABLE_BYTES);
        await f.run();
        expect(f.calls).toHaveLength(1);
        f.setAvailable(GIB);
        await expect(f.run()).rejects.toThrow("omlx_memory_pressure");
        expect(f.calls.every(call => call.method === "GET")).toBe(true);
    });
    it("skips pinned and loading models, and prefers the oldest eligible model", async () => {
        const f = fixture([model(TARGET.model), model("pinned", { loaded: true, pinned: true }),
            model("loading", { loaded: true, is_loading: true }),
            model("newer", { loaded: true, last_access: 20 }), model("older", { loaded: true, last_access: 10 })]);
        await f.run();
        expect(f.calls[1].path).toBe("/v1/models/older/unload-idle");
        expect(f.calls).toHaveLength(2);
    });
    it.each([401, 403, 404, 409, 500])("refuses HTTP %s without the ordinary unload fallback", async status => {
        const f = fixture();
        vi.mocked(f.fetchImpl).mockImplementationOnce(async () => new Response(JSON.stringify({ models: [model(TARGET.model), model("old", { loaded: true })] })))
            .mockImplementationOnce(async () => new Response("unavailable", { status }));
        await expect(f.run()).rejects.toThrow();
        expect(vi.mocked(f.fetchImpl).mock.calls).toHaveLength(2);
        expect(String(vi.mocked(f.fetchImpl).mock.calls[1][0])).toContain("/unload-idle");
    });
    it("does not invent freed bytes from the unloaded model's metadata", async () => {
        const f = fixture();
        vi.mocked(f.fetchImpl).mockImplementation(async (_url, init) => init?.method === "POST"
            ? new Response(JSON.stringify({ status: "ok", model_id: "old" }))
            : new Response(JSON.stringify({ models: [model(TARGET.model), model("old", { loaded: true })] })));
        await expect(f.run(new AbortController().signal, Date.now() + 120)).rejects.toThrow("timeout");
        expect(f.read()).toBe(GIB);
    });
    it("leaves an active older model alone and tries the next idle candidate", async () => {
        const f = fixture();
        vi.mocked(f.fetchImpl).mockImplementationOnce(async () => new Response(JSON.stringify({ models: [model(TARGET.model),
            model("active", { loaded: true, last_access: 1 }), model("idle", { loaded: true, last_access: 2 })] })))
            .mockImplementationOnce(async () => new Response("busy", { status: 409 }));
        await f.run();
        expect(vi.mocked(f.fetchImpl).mock.calls.map(call => String(call[0]))).toEqual([
            TARGET.url + "/models/status", TARGET.url + "/models/active/unload-idle", TARGET.url + "/models/idle/unload-idle"]);
    });
    it.each([[], [model(TARGET.model), model(TARGET.model)], [model(TARGET.model), model("old", { pinned: null })]].map(rows => [rows]))(
        "refuses ambiguous inventory without changing residency", async rows => {
            const f = fixture(rows);
            await expect(f.run()).rejects.toThrow();
            expect(f.calls.every(call => call.method === "GET")).toBe(true);
        });
    it("keeps alias requests working without guessing which resident model they identify", async () => {
        const f = fixture([model("canonical", { loaded: true })]); f.setAvailable(4 * GIB);
        await f.run();
        expect(f.calls).toHaveLength(1);
    });
    it("requires exclusive orchestration and refuses unknown RAM before network calls", async () => {
        const f = fixture();
        await expect(reclaimIdleOmlxMemory(TARGET, f.read, new AbortController().signal, Date.now() + 1000, f.fetchImpl))
            .rejects.toThrow("omlx_exclusive_lease_required");
        f.setAvailable(NaN);
        await expect(f.run()).rejects.toThrow("omlx_memory_pressure");
        expect(f.calls).toEqual([]);
    });
    it("does not start a late or cancelled mutation", async () => {
        const f = fixture(); const controller = new AbortController(); controller.abort();
        await expect(f.run(controller.signal)).rejects.toThrow("timeout");
        await expect(f.run(new AbortController().signal, Date.now() - 1)).rejects.toThrow("timeout");
        expect(f.calls).toEqual([]);
    });
});

describe("generation wiring", () => {
    function runtime(overrides: Partial<OmlxRuntime> = {}): OmlxRuntime {
        return { detect: async () => TARGET, acquire: async () => async () => {}, listLoaded: async () => new Set(),
            unload: async () => {}, generate: vi.fn(async () => ({ ok: true as const, text: "draft" })), ...overrides };
    }
    it("reclaims before generation and rechecks memory afterwards", async () => {
        let bytes = GIB; const order: string[] = [];
        const r = runtime({ reclaim: async () => { order.push("reclaim"); bytes = 10 * GIB; },
            generate: async () => { order.push("generate"); return { ok: true, text: "draft" }; } });
        expect(await guardedOmlxGenerate(r, TARGET, REQUEST, () => bytes)).toMatchObject({ ok: true });
        expect(order).toEqual(["reclaim", "generate"]);
    });
    it("refuses failed reclamation and never evicts from the active watcher", async () => {
        let bytes = 10 * GIB;
        const reclaim = vi.fn(async () => {});
        const r = runtime({ reclaim, generate: async (_target, _request, signal) => {
            bytes = 0;
            return new Promise(resolve => signal.addEventListener("abort", () => resolve({ ok: false, reason: "timeout" }), { once: true }));
        } });
        expect(await guardedOmlxGenerate(r, TARGET, REQUEST, () => bytes, 5)).toMatchObject({ ok: false, reason: "omlx_memory_pressure" });
        expect(reclaim).toHaveBeenCalledTimes(1);
    });
    it("observed Ollama contention prevents any automatic unload", async () => {
        const reclaim = vi.fn(async () => {});
        const r = runtime({ reclaim, listLoaded: async () => new Set(["foreign-job"]) });
        expect(await guardedOmlxGenerate(r, TARGET, REQUEST, () => GIB)).toMatchObject({ ok: false, reason: "omlx_memory_contention" });
        expect(reclaim).not.toHaveBeenCalled(); expect(r.generate).not.toHaveBeenCalled();
    });
    it("does not start generation when reclamation settles after timeout", async () => {
        const r = runtime({ reclaim: async () => { await new Promise(resolve => setTimeout(resolve, 20)); } });
        expect(await guardedOmlxGenerate(r, TARGET, { ...REQUEST, timeoutMs: 5 }, () => GIB)).toMatchObject({ ok: false });
        await new Promise(resolve => setTimeout(resolve, 25));
        expect(r.generate).not.toHaveBeenCalled();
    });
    it("cannot start generation or leak a watcher after the post-reclaim contention probe times out", async () => {
        let probes = 0;
        const intervals = vi.spyOn(globalThis, "setInterval");
        const r = runtime({ reclaim: async () => {}, listLoaded: async () => {
            if (++probes === 2) await new Promise(resolve => setTimeout(resolve, 40));
            return new Set();
        } });
        try {
            expect(await guardedOmlxGenerate(r, TARGET, { ...REQUEST, timeoutMs: 5 }, () => 10 * GIB)).toMatchObject({ ok: false });
            await new Promise(resolve => setTimeout(resolve, 65));
            expect(r.generate).not.toHaveBeenCalled();
            expect(intervals).not.toHaveBeenCalled();
        } finally {
            for (const result of intervals.mock.results) if (result.type === "return") clearInterval(result.value);
        }
    });
    it("the production runtime supplies the automatic reclaimer", () => {
        const r = runtime();
        expect(createOmlxRuntime(r, "http://127.0.0.1:11434").reclaim).toBe(reclaimIdleOmlxMemory);
    });
});
