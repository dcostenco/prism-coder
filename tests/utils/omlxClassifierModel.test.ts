import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MODEL = "fixture-classifier-v2";
const ENV = "PRISM_OMLX_CLASSIFIER_MODEL";
describe("operator-owned oMLX classifier model selection", () => {
    beforeEach(() => { vi.resetModules(); vi.stubEnv(ENV, undefined); });
    afterEach(() => vi.unstubAllEnvs());

    it("retains the existing classifier when no model is configured", async () => {
        const api = await import("../../src/utils/omlxLayer1.js");
        expect(api.omlxLayer1Model()).toBe(api.OMLX_LAYER1_MODEL);
    });
    it("pins the selected model until the host reloads", async () => {
        vi.stubEnv(ENV, MODEL);
        const api = await import("../../src/utils/omlxLayer1.js");
        vi.stubEnv(ENV, "another-fixture-model");
        expect(api.omlxLayer1Model()).toBe(MODEL);
    });
    it.each(["", " model", "model name", "../model", "model\n", "<model>", "x".repeat(257)])("never repairs invalid configuration %j", async value => {
        vi.stubEnv(ENV, value);
        const api = await import("../../src/utils/omlxLayer1.js");
        expect(() => api.omlxLayer1Model()).toThrow("omlx_classifier_model_invalid");
        const detect = vi.fn();
        expect(await api.classifyOmlxBoundary("Draft a generic helper function.", { detect } as never, () => 0)).toBe("ERROR");
        expect(detect).not.toHaveBeenCalled();
    });
});
