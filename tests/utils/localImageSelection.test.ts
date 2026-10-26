import { describe, expect, it } from "vitest";
import { localImageRequestProblem, resolveLocalImageSelection } from "../../src/utils/localImageSelection.js";

const image = { images: ["synthetic-image"] };
const saved = { backend: "omlx", models: { omlx: "vendor/future", ollama: "other:vision" } };
describe("image request selection without name guesses", () => {
    it.each([{}, { images: [] }, { ...image, local_backend: "ollama" }])("preserves legacy requests: %j", args => {
        expect(resolveLocalImageSelection(args, saved)).toBeNull();
    });
    it("copies the selected primitive values from exact backend assignments", () => {
        const value = resolveLocalImageSelection(image, saved);
        expect(value).toEqual({ backend: "omlx", model: "vendor/future" });
        saved.models.omlx = "later-build";
        expect(value?.model).toBe("vendor/future"); saved.models.omlx = "vendor/future";
    });
    it("uses an explicit pair despite a broken saved record", () => {
        expect(resolveLocalImageSelection({ ...image, image_backend: "ollama", image_model: "next:tag" }, null)).toEqual({ backend: "ollama", model: "next:tag" });
    });
    it("uses only the corresponding saved fields for partial overrides", () => {
        expect(resolveLocalImageSelection({ ...image, image_backend: "ollama" }, saved)).toEqual({ backend: "ollama", model: "other:vision" });
        expect(resolveLocalImageSelection({ ...image, image_model: "one-off" }, saved)).toEqual({ backend: "omlx", model: "one-off" });
        expect(() => resolveLocalImageSelection({ ...image, image_backend: "omlx" }, { backend: "ollama", models: { ollama: "other" } })).toThrow("local_image_model_missing");
    });
    it("does not infer an active backend from stored model assignments", () => {
        expect(resolveLocalImageSelection(image, { models: saved.models })).toBeNull();
        expect(() => resolveLocalImageSelection({ ...image, image_model: "one-off" }, {})).toThrow("local_image_backend_missing");
    });
    it("reports incomplete active selection instead of using coding defaults", () => {
        expect(() => resolveLocalImageSelection(image, { backend: "omlx" })).toThrow("local_image_model_missing");
    });
    it("does not import prototype selections", () => {
        expect(resolveLocalImageSelection(image, Object.create(saved))).toBeNull();
        expect(() => resolveLocalImageSelection(image, { backend: "omlx", models: Object.create(saved.models) })).toThrow("local_image_model_missing");
    });
    it.each([
        { image_backend: "auto" }, { image_model: "" }, { image_model: 3 }, { image_model: "bad\nmodel" },
        { image_backend: "omlx", images: [] }, { image_model: "x", images: undefined },
        { image_backend: "omlx", local_backend: "omlx" }, { image_model: "same", local_model: "same" },
        { image_backend: "omlx", local_role: "reviewer" },
    ])("rejects invalid or mixed overrides: %j", extra => {
        const args = { ...image, ...extra };
        expect(localImageRequestProblem(args)).toBe("local_image_request_invalid");
        expect(() => resolveLocalImageSelection(args, saved)).toThrow("local_image_request_invalid");
    });
    it("never treats readiness or other saved fields as authority", () => {
        expect(() => resolveLocalImageSelection(image, { ...saved, qualified: true })).toThrow("local_image_preference_invalid");
    });
});
