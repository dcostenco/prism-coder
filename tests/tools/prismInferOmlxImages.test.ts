import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { runInfer, type InferDeps, type PrismInferArgs } from "../../src/tools/prismInferHandler.js";
import { FREE_ENTITLEMENTS, type PrismEntitlements } from "../../src/utils/entitlements.js";
import { createOmlxTarget, type OmlxRequest, type OmlxRuntime } from "../../src/utils/omlxProvider.js";
import { IMAGE_CONTENT_SCREEN } from "../../src/utils/layer1.js";
import { OMLX_IMAGE_LIMITS } from "../../src/utils/omlxImages.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE7sAAAAASUVORK5CYII=";
const MODEL = "fixture-vision-model";
const ENT: PrismEntitlements = { ...FREE_ENTITLEMENTS, plan: "standard", model_ceiling: "27b", features: { ...FREE_ENTITLEMENTS.features, cloud_fallback: false } };
const args = (extra: Partial<PrismInferArgs> = {}): PrismInferArgs => ({ prompt: "Describe the image", mode: "code", image_backend: "omlx", image_model: MODEL, images: [PNG], cloud_fallback: false, escalation: "report", verify: false, ...extra });

function deps(captured: OmlxRequest[], options: { classifier?: "error" | "uncertain"; noImageCapability?: boolean; slowImageCapability?: boolean; answer?: string } = {}): InferDeps {
    const target = createOmlxTarget("http://127.0.0.1:8000/v1", MODEL, 65536, randomUUID(), OMLX_IMAGE_LIMITS);
    const omlx: OmlxRuntime = {
        detect: vi.fn(async () => target), detectImage: options.noImageCapability ? undefined : vi.fn(async () => { if (options.slowImageCapability) await new Promise(resolve => setTimeout(resolve, 50)); return target; }), acquire: vi.fn(async () => async () => {}), listLoaded: vi.fn(async () => new Set()), unload: vi.fn(async () => {}),
        generate: vi.fn(async (_target, request) => {
            expect(_target.model).toBe(MODEL);
            captured.push(request);
            if (request.cacheStore === false) {
                if (options.classifier === "error") return { ok: false as const, reason: "classifier_error" };
                return { ok: true as const, text: request.messages.some(m => m.content === IMAGE_CONTENT_SCREEN) ? "NO"
                    : options.classifier === "uncertain" ? "UNCERTAIN" : "OBVIOUS_NOT_RESERVED", doneReason: "stop" };
            }
            return { ok: true as const, text: options.answer ?? "image answer", doneReason: "stop" };
        }),
    };
    return { omlx, entitlements: ENT, freemem: () => 30 * 1024 ** 3, listTags: vi.fn(async () => new Set()), listLoaded: vi.fn(async () => new Set()), ollamaUrl: "http://127.0.0.1:11434", callLocal: vi.fn(async () => ({ ok: false as const, reason: "must_not_use_ollama" })), callCloud: vi.fn(async () => ({ ok: false, output: "must_not_use_cloud", backend: "synalux" })), probeNumCtx: vi.fn(async () => 32768), probeVision: vi.fn(async () => false), classifierInputPolicy: vi.fn(async () => null), secondReadPolicy: vi.fn(async () => null), answerCheckPolicy: vi.fn(async () => null),
    };
}

describe("explicit oMLX image request transport", () => {
    it("keeps image-derived route and verification content local on a paid plan", async () => {
        const captured: OmlxRequest[] = [];
        const d = deps(captured, { answer: '<|tool_call|>{"name":"brave_web_search","arguments":{"query":"fixture"}}<|tool_call_end|>' });
        d.entitlements = { ...ENT, features: { ...ENT.features, cloud_fallback: true, grounding_verifier: true } };
        d.callVerifier = vi.fn(async () => { throw Error("must not upload"); });
        d.callRouteGuard = vi.fn(async () => { throw Error("must not upload"); });
        const result = await runInfer(args({ mode: "route", cloud_fallback: true, verify: true }), d);
        expect(result.backend).toBe("omlx");
        expect(result.attempts).toContainEqual({ tier: "verifier", reason: "verifier_skipped_images_stay_local" });
        for (const call of [d.callCloud,d.callVerifier,d.callRouteGuard]) expect(call).not.toHaveBeenCalled();
    });
    it.each(["jpeg", "dimensions", "envelope"] as const)("rejects %s as input before a model call", async kind => {
        const captured: OmlxRequest[] = []; const d = deps(captured);
        const data = Buffer.alloc(kind === "envelope" ? 95 * 1024 : 33);
        Buffer.from(PNG, "base64").copy(data, 0, 0, 33);
        if (kind === "dimensions") { data.writeUInt32BE(2100, 16); data.writeUInt32BE(2100, 20); }
        const images = kind === "jpeg" ? [Buffer.from([255,216,255,217]).toString("base64")]
            : kind === "envelope" ? [data.toString("base64"),data.toString("base64")] : [data.toString("base64")];
        const result = await runInfer(args({ images, ...(kind === "envelope" ? { prompt: "x".repeat(4096) } : {}) }), d);
        expect(result).toMatchObject({ backend: "refused", gate_outcome: { reason: kind === "jpeg" ? "omlx_image_invalid" : "omlx_image_too_large" } });
        expect(captured).toHaveLength(0);
        expect(result.attempts.some(a => a.reason === "layer1_reserved")).toBe(false);
    });
    it("preserves the plan ceiling for an image model without a trusted tier binding", async () => {
        const captured: OmlxRequest[] = []; const d = deps(captured);
        expect(await runInfer(args({ model_ceiling: "4b" }), d)).toMatchObject({ gate_outcome: { reason: "omlx_model_ceiling" } });
        expect(d.omlx!.detectImage).not.toHaveBeenCalled(); expect(captured).toHaveLength(0);
    });
    it("forwards exact ordered PNG bytes to the selected model without Ollama/cloud", async () => {
        const captured: OmlxRequest[] = []; const d = deps(captured);
        const result = await runInfer(args({ images: [PNG, PNG] }), d);
        expect(result, JSON.stringify(result)).toMatchObject({ backend: "omlx", model_picked: MODEL, output: "image answer", used_cloud: false });
        const attached = captured.map(r => r.messages.find(m => m.images)?.images);
        expect(attached).toEqual([[PNG], [PNG], [PNG, PNG], [PNG, PNG]]);
        expect(d.listTags).not.toHaveBeenCalled(); expect(d.listLoaded).not.toHaveBeenCalled(); expect(d.probeVision).not.toHaveBeenCalled();
        expect(d.callLocal).not.toHaveBeenCalled(); expect(d.callCloud).not.toHaveBeenCalled();
    });

    it("uses saved image selection and the real Layer1 path", async () => {
        const captured: OmlxRequest[] = []; const d = deps(captured); d.imagePreference = vi.fn(async () => ({ backend: "omlx", models: { omlx: MODEL } }));
        const result = await runInfer(args({ image_backend: undefined, image_model: undefined }), d);
        expect(result).toMatchObject({ backend: "omlx", model_picked: MODEL, output: "image answer" });
        expect(captured.filter(r => r.cacheStore === false)).toHaveLength(2); expect(d.callCloud).not.toHaveBeenCalled();
    });
    it("refuses without image capability", async () => {
        const captured: OmlxRequest[] = []; const d = deps(captured, { noImageCapability: true });
        expect(await runInfer(args(), d)).toMatchObject({ backend: "refused", output: "" }); expect(captured).toHaveLength(0);
    });
    it.each(["error", "uncertain"] as const)("does not answer on classifier %s", async classifier => {
        const captured: OmlxRequest[] = []; const d = deps(captured, { classifier });
        expect(await runInfer(args(), d)).toMatchObject({ backend: "refused", output: "" }); expect(d.callCloud).not.toHaveBeenCalled();
    });
    it("bounds image capability detection by the original timeout", async () => {
        const captured: OmlxRequest[] = []; const d = deps(captured, { slowImageCapability: true });
        expect(await runInfer(args({ timeout_ms: 5 }), d)).toMatchObject({ backend: "refused", gate_outcome: { reason: "timeout" } }); expect(captured).toHaveLength(0);
    });
});
