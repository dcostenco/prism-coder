import { describe, expect, it, vi } from "vitest";
import { resolveLocalCodingBackend, type LocalCodingPreference } from "../../src/utils/localCodingPreference.js";
import { strictLoaded } from "../../src/tools/prismInferHandler.js";

const preference = (effective: LocalCodingPreference["effective"], configured = true): LocalCodingPreference => ({ saved: effective, effective, envOverride: null, configured });
describe("local coding backend choice", () => {
    it("honors an explicit task choice over every saved preference", () => {
        for (const saved of ["auto", "omlx", "ollama"] as const) {
            for (const explicit of ["omlx", "ollama"] as const) {
                expect(resolveLocalCodingBackend({ mode: "code", local_backend: explicit }, preference(saved))).toBe(explicit);
            }
        }
    });
    it("Auto prefers configured oMLX without changing image, chat or tool routing", () => {
        expect(resolveLocalCodingBackend({ mode: "code" }, preference("auto"))).toBe("omlx");
        expect(resolveLocalCodingBackend({ mode: "code" }, preference("auto", false))).toBe("ollama");
        for (const effective of ["auto", "omlx"] as const) {
            for (const args of [{ mode: "chat" }, { mode: "route" }, { mode: "code", images: ["image"] }]) {
                expect(resolveLocalCodingBackend(args, preference(effective))).toBe("ollama");
            }
        }
    });
    it("keeps explicitly bounded small code calls eligible for Ollama in Auto", () => {
        for (const model_ceiling of ["2b", "4b", "9b"]) {
            expect(resolveLocalCodingBackend({ mode: "code", model_ceiling }, preference("auto"))).toBe("ollama");
            expect(resolveLocalCodingBackend({ mode: "code", model_ceiling, local_backend: "omlx" }, preference("auto"))).toBe("omlx");
        }
    });
});
describe("oMLX residency observation without an Ollama dependency", () => {
    it("accepts a positively closed listener, without starting a daemon", async () => {
        const fetcher = vi.fn(async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error(), { code: "ECONNREFUSED" }) }); });
        expect(await strictLoaded("http://127.0.0.1:11434", fetcher)).toEqual(new Set());
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it.each(["ETIMEDOUT", "ENOTFOUND", "ECONNRESET"])("does not mistake %s for proof of an absent runtime", async code => {
        await expect(strictLoaded("http://127.0.0.1:11434", async () => { throw Object.assign(new Error(), { code }); })).rejects.toThrow("omlx_ollama_state_unavailable");
    });
    it.each([new Response("{}"), new Response("invalid"), new Response("{}", { status: 503 })])("refuses untrustworthy state", async response => {
        await expect(strictLoaded("http://127.0.0.1:11434", async () => response)).rejects.toThrow("omlx_ollama_state_unavailable");
    });
});
