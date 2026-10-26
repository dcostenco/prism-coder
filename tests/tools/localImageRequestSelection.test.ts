import { afterEach, describe, expect, it, vi } from "vitest";
import { isPrismInferArgs, productionInferDeps, runInfer, type InferDeps, type PrismInferArgs } from "../../src/tools/prismInferHandler.js";
import { FREE_ENTITLEMENTS } from "../../src/utils/entitlements.js";
import { readLocalImageSettings, type LocalImageSettings } from "../../src/utils/localImageSettings.js";

const IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=";
const SAVED: LocalImageSettings = { backend: "omlx", models: { omlx: "vendor/future-vision", ollama: "future:vision" } };
type ImageArgs = PrismInferArgs & { image_backend?: unknown; image_model?: unknown };
const ask = (extra: Partial<ImageArgs> = {}): ImageArgs => ({ prompt: "Describe the visible colors.", images: [IMAGE], mode: "code", escalation: "report", cloud_fallback: true, verify: true, ...extra });

function fixture(settings: LocalImageSettings = SAVED) {
    const imagePreference = vi.fn(async () => settings);
    const deps: InferDeps & { imagePreference: typeof imagePreference } = {
        imagePreference, entitlements: { ...FREE_ENTITLEMENTS, source: "portal" }, freemem: () => 8 * 1024 ** 3,
        codingPreference: vi.fn(async () => { throw Error("coding must not select an image model"); }),
        listTags: vi.fn(async () => new Set<string>()), listLoaded: vi.fn(async () => new Set<string>()),
        callLocal: vi.fn(async () => ({ ok: true, text: "unused", doneReason: "stop" })),
        callCloud: vi.fn(async () => ({ ok: true, output: "unused", backend: "synalux" })),
        ollamaUrl: "http://127.0.0.1:11434", probeVision: vi.fn(async () => true),
        probeNumCtx: vi.fn(async () => 8192), callLayer1: vi.fn(async () => "OBVIOUS_NOT_RESERVED"),
        classifierInputPolicy: async () => null, secondReadPolicy: async () => null, answerCheckPolicy: async () => null,
    };
    return { deps, imagePreference };
}

function noInference(deps: InferDeps) {
    for (const fn of [deps.codingPreference, deps.listTags, deps.listLoaded, deps.callLocal, deps.callCloud, deps.callLayer1, deps.probeVision]) expect(fn).not.toHaveBeenCalled();
}

afterEach(() => vi.useRealTimers());

describe("image-specific argument matrix", () => {
    it.each([{ image_backend: "omlx" }, { image_model: "future:vision" }, { image_backend: "ollama", image_model: "future:vision" }])("accepts independent image arguments: %j", extra => {
        expect(isPrismInferArgs(ask(extra))).toBe(true);
    });
    it.each([
        { image_backend: "auto" }, { image_backend: null }, { image_model: "" }, { image_model: "bad\nmodel" }, { image_model: 9 },
        { image_backend: "omlx", images: [] }, { image_model: "future", images: undefined },
        { image_backend: "omlx", local_backend: "ollama" }, { image_backend: "omlx", local_backend: "omlx" },
        { image_model: "future", local_model: "future" }, { image_model: "future", local_role: "coder" },
    ])("rejects invalid or mixed image arguments: %j", extra => {
        expect(isPrismInferArgs(ask(extra as Partial<ImageArgs>))).toBe(false);
    });
    it("keeps the legacy image/coding argument restrictions", () => {
        expect(isPrismInferArgs(ask({ local_backend: "ollama" }))).toBe(true);
        expect(isPrismInferArgs(ask({ local_backend: "omlx" }))).toBe(false);
        expect(isPrismInferArgs(ask({ local_role: "reviewer" }))).toBe(false);
    });
});

describe("selected-image admission before provider work", () => {
    it("wires the fresh independent reader into production dependencies", () => {
        expect(productionInferDeps().imagePreference).toBe(readLocalImageSettings);
    });
    it("does not silently serve a saved oMLX choice on another backend", async () => {
        const f = fixture();
        const result = await runInfer(ask({ images: ["/must/not/read/this-image.png"] }), f.deps);
        expect(result).toMatchObject({ backend: "refused", output: "", used_cloud: false, model_picked: null,
            gate_outcome: { status: "refused", reason: "omlx_runtime_unavailable", served_anyway: false } });
        expect(JSON.stringify(result)).not.toContain("must/not/read");
        expect(f.imagePreference).toHaveBeenCalledTimes(1); noInference(f.deps);
    });
    it("honors a complete explicit image choice without reading saved settings", async () => {
        const f = fixture(); f.imagePreference.mockRejectedValue(Error("unreadable saved record"));
        const result = await runInfer(ask({ image_backend: "ollama", image_model: "vendor/next:vision" }), f.deps);
        expect(result.gate_outcome?.reason).toBe("local_image_backend_not_enabled");
        expect(f.imagePreference).not.toHaveBeenCalled(); noInference(f.deps);
    });
    it("resolves a partial override only against its exact backend", async () => {
        const f = fixture({ backend: "ollama", models: { ollama: "only-other-backend" } });
        const result = await runInfer(ask({ image_backend: "omlx" }), f.deps);
        expect(result.gate_outcome?.reason).toBe("local_image_model_missing"); noInference(f.deps);
    });
    it("requires a backend for a model-only override and a model for a saved backend", async () => {
        const a = fixture({ models: { omlx: "saved-but-not-active" } });
        expect((await runInfer(ask({ image_model: "future" }), a.deps)).gate_outcome?.reason).toBe("local_image_backend_missing");
        const b = fixture({ backend: "omlx" });
        expect((await runInfer(ask(), b.deps)).gate_outcome?.reason).toBe("local_image_model_missing");
        noInference(a.deps); noInference(b.deps);
    });
    it("preserves explicit legacy Ollama and unset-image routing", async () => {
        for (const [settings, extra] of [[SAVED, { local_backend: "ollama" }], [{}, {}], [{ models: { omlx: "stored-not-active" } }, {}]] as const) {
            const f = fixture(settings);
            await expect(runInfer(ask(extra), f.deps)).rejects.toThrow("no backend produced output");
            expect(f.deps.listTags).toHaveBeenCalled();
            if (extra.local_backend) expect(f.imagePreference).not.toHaveBeenCalled();
        }
    });
    it("never consults image settings for text requests", async () => {
        const f = fixture(); f.imagePreference.mockRejectedValue(Error("must not read"));
        await expect(runInfer({ prompt: "Describe a color.", mode: "chat", escalation: "report", cloud_fallback: false }, f.deps)).rejects.toThrow("no backend produced output");
        expect(f.imagePreference).not.toHaveBeenCalled();
    });
    it("keeps the deterministic safety intercept ahead of image settings", async () => {
        const f = fixture(); f.imagePreference.mockRejectedValue(Error("must not read"));
        const result = await runInfer(ask({ prompt: "I want to kill myself" }), f.deps);
        expect(result.backend).toBe("safety_gate"); expect(f.imagePreference).not.toHaveBeenCalled(); noInference(f.deps);
    });
    it("sanitizes preference failures and rejects corrupt records without inference", async () => {
        for (const settings of [null, { backend: "auto" }, { qualified: true }]) {
            const f = fixture(settings as unknown as LocalImageSettings);
            expect((await runInfer(ask(), f.deps)).gate_outcome?.reason).toBe("local_image_preference_invalid"); noInference(f.deps);
        }
        const f = fixture(); f.imagePreference.mockRejectedValue(Error("sensitive-settings-value"));
        const result = await runInfer(ask(), f.deps);
        expect(result.gate_outcome?.reason).toBe("local_image_preference_invalid");
        expect(JSON.stringify(result)).not.toContain("sensitive-settings-value"); noInference(f.deps);
    });
    it("bounds a stalled settings read and ignores its late result", async () => {
        vi.useFakeTimers();
        const f = fixture(); let settle!: (value: LocalImageSettings) => void;
        f.imagePreference.mockReturnValue(new Promise(resolve => { settle = resolve; }));
        const pending = runInfer(ask(), f.deps);
        await vi.advanceTimersByTimeAsync(1000);
        expect((await pending).gate_outcome?.reason).toBe("local_image_selection_timeout");
        settle(SAVED); await Promise.resolve(); noInference(f.deps);
        expect(vi.getTimerCount()).toBe(0);
    });
    it("honors the caller's shorter deadline for settings resolution", async () => {
        vi.useFakeTimers(); const f = fixture(); f.imagePreference.mockReturnValue(new Promise(() => {}));
        const pending = runInfer(ask({ timeout_ms: 25 }), f.deps);
        await vi.advanceTimersByTimeAsync(25);
        expect((await pending).gate_outcome?.reason).toBe("local_image_selection_timeout"); noInference(f.deps);
    });
    it("deducts settings-read time before forwarding a legacy image call", async () => {
        vi.useFakeTimers(); const f = fixture({});
        f.imagePreference.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({}), 80)));
        f.deps.listTags = vi.fn(async () => new Set(["prism-coder:2b"]));
        f.deps.callLocal = vi.fn(async () => { throw Error("stop after observing forwarded deadline"); });
        const pending = runInfer(ask({ mode: "chat", verify: false, cloud_fallback: false, timeout_ms: 100 }), f.deps).catch(() => undefined);
        await vi.advanceTimersByTimeAsync(80); await pending;
        expect(f.deps.callLocal).toHaveBeenCalled();
        const remaining = vi.mocked(f.deps.callLocal).mock.calls[0][6];
        expect(remaining).toBeGreaterThan(0); expect(remaining).toBeLessThanOrEqual(20);
    });
    it("reads a fresh preference for each request without caching a selection", async () => {
        const f = fixture(); f.imagePreference.mockResolvedValueOnce(SAVED).mockResolvedValueOnce({ backend: "ollama", models: { ollama: "next:vision" } });
        expect((await runInfer(ask(), f.deps)).gate_outcome?.reason).toBe("omlx_runtime_unavailable");
        expect((await runInfer(ask(), f.deps)).gate_outcome?.reason).toBe("local_image_backend_not_enabled");
        expect(f.imagePreference).toHaveBeenCalledTimes(2); noInference(f.deps);
    });
    it("snapshots explicit fields and image presence before an asynchronous settings read", async () => {
        const f = fixture(); const args = ask({ image_backend: "omlx" });
        f.imagePreference.mockImplementation(async () => {
            args.local_backend = "ollama";
            args.images!.splice(0);
            return SAVED;
        });
        expect((await runInfer(args, f.deps)).gate_outcome?.reason).toBe("omlx_runtime_unavailable");
        noInference(f.deps);
    });
    it("retains the throwing failure contract when escalation is not report", async () => {
        const f = fixture();
        await expect(runInfer(ask({ escalation: "serve" }), f.deps)).rejects.toThrow("omlx_runtime_unavailable");
        noInference(f.deps);
    });
});
