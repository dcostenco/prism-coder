import { describe, it, expect } from "vitest";
import { pickLocalModel, MODEL_TIERS, fmtGb, resolveOllamaName } from "../../src/utils/modelPicker.js";

const GB = 1024 ** 3;

describe("pickLocalModel", () => {
    it("default ceiling is 9b — picks 9B even with 30GB free", () => {
        const choice = pickLocalModel(30 * GB);
        expect(choice?.tag).toBe("prism-coder:9b");
    });

    it("picks 27B only with explicit ceiling='27b'", () => {
        expect(pickLocalModel(30 * GB, "27b")?.tag).toBe("prism-coder:27b");
    });

    it("picks 9B when 8–23 GB free", () => {
        expect(pickLocalModel(12 * GB)?.tag).toBe("prism-coder:9b");
        expect(pickLocalModel(20 * GB)?.tag).toBe("prism-coder:9b");
    });

    it("picks 4B when 5–7 GB free (9B needs 8GB)", () => {
        expect(pickLocalModel(5 * GB)?.tag).toBe("prism-coder:4b");
        expect(pickLocalModel(6 * GB)?.tag).toBe("prism-coder:4b");
        expect(pickLocalModel(7 * GB)?.tag).toBe("prism-coder:4b");
    });

    it("picks 2B (Qwen3.5-4B Q3_K_M) when 3–4.9 GB free", () => {
        expect(pickLocalModel(3 * GB)?.tag).toBe("prism-coder:2b");
        expect(pickLocalModel(4 * GB)?.tag).toBe("prism-coder:2b");
    });

    it("returns null below 3 GB free", () => {
        expect(pickLocalModel(2 * GB)).toBeNull();
        expect(pickLocalModel(0)).toBeNull();
        expect(pickLocalModel(-1)).toBeNull();
        expect(pickLocalModel(Number.NaN)).toBeNull();
    });

    it("honors ceiling — '9b' forbids 27B even on a 64 GB box", () => {
        const choice = pickLocalModel(64 * GB, "9b");
        expect(choice?.tag).toBe("prism-coder:9b");
    });

    it("ceiling '4b' on 30 GB picks 4B", () => {
        expect(pickLocalModel(30 * GB, "4b")?.tag).toBe("prism-coder:4b");
    });

    it("ceiling '2b' on 64 GB picks 2B", () => {
        expect(pickLocalModel(64 * GB, "2b")?.tag).toBe("prism-coder:2b");
    });

    it("respects `available` whitelist — skips tiers not pulled", () => {
        // 30 GB free would normally pick 27B, but if only 9B is installed:
        const available = new Set(["prism-coder:9b", "prism-coder:4b"]);
        const choice = pickLocalModel(30 * GB, undefined, available);
        expect(choice?.tag).toBe("prism-coder:9b");
    });

    it("returns null when nothing in `available` matches", () => {
        const available = new Set(["llama3:8b"]); // unrelated
        expect(pickLocalModel(30 * GB, undefined, available)).toBeNull();
    });

    it("accepts namespaced HuggingFace-style tags (dcostenco/prism-coder:27b)", () => {
        const available = new Set([
            "dcostenco/prism-coder:27b",
            "dcostenco/prism-coder:9b",
        ]);
        // Default ceiling=9b, so 30GB picks 9b not 27b
        expect(pickLocalModel(30 * GB, undefined, available)?.tag).toBe("prism-coder:9b");
        // Explicit ceiling=27b allows 27b
        expect(pickLocalModel(30 * GB, "27b", available)?.tag).toBe("prism-coder:27b");
        expect(pickLocalModel(15 * GB, undefined, available)?.tag).toBe("prism-coder:9b");
    });

    it("mixes bare and namespaced tags in the same `available` set", () => {
        const available = new Set([
            "prism-coder:9b",                  // bare
            "prism-coder:4b",                       // stock model
            "someuser/llama3:8b",               // unrelated namespaced
        ]);
        expect(pickLocalModel(30 * GB, undefined, available)?.tag).toBe("prism-coder:9b");
        expect(pickLocalModel(5 * GB, undefined, available)?.tag).toBe("prism-coder:4b");
    });

    it("MODEL_TIERS is ordered largest → smallest", () => {
        for (let i = 1; i < MODEL_TIERS.length; i++) {
            expect(MODEL_TIERS[i].minFreeGb).toBeLessThan(MODEL_TIERS[i - 1].minFreeGb);
        }
    });
});

describe("resolveOllamaName", () => {
    it("returns the bare tag when bare is installed", () => {
        const installed = new Set(["prism-coder:27b", "prism-coder:9b"]);
        expect(resolveOllamaName("prism-coder:27b", installed)).toBe("prism-coder:27b");
    });

    it("returns the namespaced tag when only namespaced is installed", () => {
        const installed = new Set(["dcostenco/prism-coder:27b"]);
        expect(resolveOllamaName("prism-coder:27b", installed)).toBe("dcostenco/prism-coder:27b");
    });

    it("prefers bare over namespaced when both are present", () => {
        const installed = new Set(["prism-coder:27b", "dcostenco/prism-coder:27b"]);
        expect(resolveOllamaName("prism-coder:27b", installed)).toBe("prism-coder:27b");
    });

    it("returns the input tag when nothing matches (let Ollama 404)", () => {
        const installed = new Set(["llama3:8b"]);
        expect(resolveOllamaName("prism-coder:27b", installed)).toBe("prism-coder:27b");
    });
});

describe("fmtGb", () => {
    it("formats binary GB to one decimal", () => {
        expect(fmtGb(12 * GB)).toBe("12.0 GB");
        expect(fmtGb(1.5 * GB)).toBe("1.5 GB");
        expect(fmtGb(0)).toBe("0.0 GB");
    });
});
