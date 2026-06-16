import { describe, it, expect } from "vitest";
import { stripThink } from "../src/utils/thinkStrip.js";

describe("stripThink", () => {
    it("passes through text with no think blocks", () => {
        const r = stripThink("Hello world");
        expect(r.stripped).toBe("Hello world");
        expect(r.thinkContent).toBeNull();
        expect(r.thinkOnly).toBe(false);
    });

    it("strips a single think block", () => {
        const r = stripThink("<think>reasoning here</think>\n\nThe answer is 42.");
        expect(r.stripped).toBe("The answer is 42.");
        expect(r.thinkContent).toBe("reasoning here");
        expect(r.thinkOnly).toBe(false);
    });

    it("strips empty think block (nothink pattern)", () => {
        const r = stripThink("<think>\n\n</think>\n\nHello");
        expect(r.stripped).toBe("Hello");
        expect(r.thinkOnly).toBe(false);
    });

    it("detects think-only response", () => {
        const r = stripThink("<think>I'm thinking about this but have no answer</think>");
        expect(r.stripped).toBe("");
        expect(r.thinkOnly).toBe(true);
    });

    it("handles unclosed think block (truncated)", () => {
        const r = stripThink("<think>I was thinking about");
        expect(r.stripped).toBe("");
        expect(r.thinkOnly).toBe(true);
    });

    it("strips multiple think blocks", () => {
        const r = stripThink("<think>step 1</think>Part A<think>step 2</think>Part B");
        expect(r.stripped).toBe("Part APart B");
    });

    it("strips synalux_think variant", () => {
        const r = stripThink("<|synalux_think|>internal reasoning</|synalux_think|>\n\nThe answer.");
        expect(r.stripped).toBe("The answer.");
        expect(r.thinkContent).toBe("internal reasoning");
        expect(r.thinkOnly).toBe(false);
    });

    it("detects synalux_think-only response", () => {
        const r = stripThink("<|synalux_think|>only thinking</|synalux_think|>");
        expect(r.stripped).toBe("");
        expect(r.thinkOnly).toBe(true);
    });

    it("handles unclosed synalux_think block", () => {
        const r = stripThink("<|synalux_think|>partial reasoning");
        expect(r.stripped).toBe("");
        expect(r.thinkOnly).toBe(true);
    });
});
