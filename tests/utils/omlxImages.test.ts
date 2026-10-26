import { describe, expect, it } from "vitest";
import { responsesInput, validateOmlxMessages } from "../../src/utils/omlxImages.js";

const PNG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).toString("base64");

describe("oMLX image transport validation", () => {
    it("preserves text-only representation and serializes user PNG parts", () => {
        expect(responsesInput([{ role: "user", content: "hello" }])).toEqual([{ role: "user", content: "hello" }]);
        expect(responsesInput([{ role: "user", content: "look", images: [PNG] }])).toEqual([{
            role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: `data:image/png;base64,${PNG}` }],
        }]);
    });
    it("rejects non-user, noncanonical and non-PNG images", () => {
        expect(() => validateOmlxMessages([{ role: "system", content: "x", images: [PNG] }])).toThrow("omlx_image_invalid");
        expect(() => validateOmlxMessages([{ role: "user", content: "x", images: ["AA=="] }])).toThrow("omlx_image_invalid");
        expect(() => validateOmlxMessages([{ role: "user", content: "x", images: [PNG.slice(0, -1)] }])).toThrow("omlx_image_invalid");
    });
    it("enforces image count and aggregate bounds", () => {
        expect(() => validateOmlxMessages([{ role: "user", content: "x", images: [PNG, PNG, PNG, PNG, PNG] }])).toThrow();
        const large = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(128 * 1024)]).toString("base64");
        expect(() => validateOmlxMessages([{ role: "user", content: "x", images: [large] }])).toThrow();
        expect(() => validateOmlxMessages([
            { role: "user", content: "a", images: [PNG, PNG, PNG] },
            { role: "user", content: "b", images: [PNG, PNG] },
        ])).toThrow();
    });
    it("rejects inherited message fields", () => {
        const inherited = Object.create({ role: "user", content: "x", images: [PNG] });
        expect(() => validateOmlxMessages([inherited])).toThrow("omlx_messages_invalid");
        const inheritedImages = Object.create({ images: [PNG] });
        inheritedImages.role = "user";
        inheritedImages.content = "x";
        expect(() => validateOmlxMessages([inheritedImages])).toThrow("omlx_image_invalid");
        const sparseMessages: unknown[] = [];
        Object.setPrototypeOf(sparseMessages, { 0: { role: "user", content: "phantom" } });
        sparseMessages.length = 1;
        expect(() => validateOmlxMessages(sparseMessages)).toThrow("omlx_messages_invalid");
        const sparseImages: unknown[] = [];
        Object.setPrototypeOf(sparseImages, { 0: PNG });
        sparseImages.length = 1;
        expect(() => validateOmlxMessages([{ role: "user", content: "x", images: sparseImages }])).toThrow("omlx_image_invalid");
    });
});
