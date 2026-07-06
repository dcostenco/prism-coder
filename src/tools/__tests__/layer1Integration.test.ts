/**
 * Layer 1 integration tests.
 * Verifies that prismInferHandler routes correctly based on Layer 1 verdict,
 * using injectable deps to mock both Layer 1 and cloud.
 */

import { describe, it, expect, vi } from "vitest";
import { runInfer, type InferDeps } from "../prismInferHandler.js";
import { parseLayer1 } from "../../utils/layer1.js";
import { LAYER1_PROMPT } from "../../utils/layer1.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ── parseLayer1 unit tests ────────────────────────────────────────────────────

describe("parseLayer1", () => {
    it("returns OBVIOUS_NOT_RESERVED for exact token", () => {
        expect(parseLayer1("OBVIOUS_NOT_RESERVED")).toBe("OBVIOUS_NOT_RESERVED");
    });

    it("returns OBVIOUS_RESERVED for exact token", () => {
        expect(parseLayer1("OBVIOUS_RESERVED")).toBe("OBVIOUS_RESERVED");
    });

    it("returns UNCERTAIN for exact token", () => {
        expect(parseLayer1("UNCERTAIN")).toBe("UNCERTAIN");
    });

    it("ignores trailing whitespace and is case-insensitive", () => {
        expect(parseLayer1("  obvious_not_reserved  ")).toBe("OBVIOUS_NOT_RESERVED");
        expect(parseLayer1("Obvious_Reserved\n")).toBe("OBVIOUS_RESERVED");
    });

    it("returns ERROR for empty / null / undefined", () => {
        expect(parseLayer1("")).toBe("ERROR");
        expect(parseLayer1(null)).toBe("ERROR");
        expect(parseLayer1(undefined)).toBe("ERROR");
    });

    it("returns ERROR for unrecognised token", () => {
        expect(parseLayer1("UNKNOWN")).toBe("ERROR");
        expect(parseLayer1("YES")).toBe("ERROR");
    });

    it("handles quoted tokens — model wraps verdict in quotes", () => {
        expect(parseLayer1('"OBVIOUS_RESERVED"')).toBe("OBVIOUS_RESERVED");
        expect(parseLayer1('"OBVIOUS_NOT_RESERVED"')).toBe("OBVIOUS_NOT_RESERVED");
    });

    // Safety-critical: substring trap — OBVIOUS_NOT_RESERVED must not parse as RESERVED
    it("[safety] 'OBVIOUS_NOT_RESERVED' is NOT parsed as OBVIOUS_RESERVED", () => {
        const verdict = parseLayer1("OBVIOUS_NOT_RESERVED");
        expect(verdict).not.toBe("OBVIOUS_RESERVED");
        expect(verdict).toBe("OBVIOUS_NOT_RESERVED");
    });

    // Safety-critical: only first token is used
    it("[safety] extra words after verdict token are ignored", () => {
        expect(parseLayer1("OBVIOUS_RESERVED because it involves crisis")).toBe("OBVIOUS_RESERVED");
        expect(parseLayer1("OBVIOUS_NOT_RESERVED — safe to route locally")).toBe("OBVIOUS_NOT_RESERVED");
    });

    it("returns ERROR when model outputs think block before verdict", () => {
        expect(parseLayer1("<think>let me consider this</think>\nOBVIOUS_RESERVED")).toBe("ERROR");
    });
});

// ── LAYER1_PROMPT drift test ──────────────────────────────────────────────────

describe("LAYER1_PROMPT drift", () => {
    it("layer1.ts prompt matches eval-layer1.mjs verbatim", () => {
        const evalPath = path.resolve(import.meta.dirname, "../../../../scripts/eval-layer1.mjs");
        if (!fs.existsSync(evalPath)) {
            // CI may not have the scripts dir — skip gracefully
            return;
        }
        const evalSrc = fs.readFileSync(evalPath, "utf-8");
        const match = evalSrc.match(/const LAYER1_PROMPT = `([\s\S]*?)`;/);
        expect(match).not.toBeNull();
        const evalPrompt = match![1];
        expect(LAYER1_PROMPT).toBe(evalPrompt);
    });
});

// ── Handler integration tests ─────────────────────────────────────────────────

function makeBaseDeps(overrides: Partial<InferDeps> = {}): InferDeps {
    return {
        freemem: () => 8 * 1024 ** 3,
        listTags: async () => new Set(["dcostenco/prism-coder:4b"]),
        listLoaded: async () => new Set(),
        callLocal: async () => ({ ok: true, text: "local response", doneReason: "stop" }),
        callCloud: async () => ({ ok: true, output: "cloud response", backend: "synalux" }),
        ollamaUrl: "http://localhost:11434",
        entitlements: {
            plan: "pro",
            max_tokens: 4096,
            model_ceiling: "27b",
            daily_infer_limit: 1000,
            max_seats: 1,
            features: {
                cloud_fallback: true,
                grounding_verifier: false,
                knowledge_search_unlimited: false,
                session_memory_unlimited: false,
                analytics_dashboard: false,
            },
            upgrade_url: "https://synalux.ai/pricing",
        },
        ...overrides,
    };
}

describe("Layer 1 handler integration", () => {
    it("OBVIOUS_RESERVED → escalates to cloud, callLocal is never invoked", async () => {
        const callLocal = vi.fn().mockResolvedValue({ ok: true, text: "local response" });
        const callCloud = vi.fn().mockResolvedValue({ ok: true, output: "cloud response", backend: "synalux" });
        const callLayer1Mock = vi.fn().mockResolvedValue("OBVIOUS_RESERVED");

        const result = await runInfer(
            {
                prompt: "draft a de-escalation plan for when the client becomes violent",
                mode: "code",
                cloud_fallback: true,
                max_tokens: 512,
            },
            makeBaseDeps({ callLocal, callCloud, callLayer1: callLayer1Mock }),
        );

        expect(callLayer1Mock).toHaveBeenCalledOnce();
        expect(callLocal).not.toHaveBeenCalled();
        expect(callCloud).toHaveBeenCalledOnce();
        expect(result.used_cloud).toBe(true);
        expect(result.attempts.some(a => a.tier === "layer1")).toBe(true);
    });

    it("UNCERTAIN → escalates to cloud (fail-closed)", async () => {
        const callLocal = vi.fn().mockResolvedValue({ ok: true, text: "local response" });
        const callCloud = vi.fn().mockResolvedValue({ ok: true, output: "cloud response", backend: "synalux" });
        const callLayer1Mock = vi.fn().mockResolvedValue("UNCERTAIN");

        const result = await runInfer(
            { prompt: "is this code correct", mode: "code", cloud_fallback: true, max_tokens: 512 },
            makeBaseDeps({ callLocal, callCloud, callLayer1: callLayer1Mock }),
        );

        expect(callLayer1Mock).toHaveBeenCalledOnce();
        expect(callLocal).not.toHaveBeenCalled();
        expect(result.used_cloud).toBe(true);
    });

    it("ERROR → escalates to cloud (fail-closed)", async () => {
        const callLocal = vi.fn().mockResolvedValue({ ok: true, text: "local response" });
        const callCloud = vi.fn().mockResolvedValue({ ok: true, output: "cloud response", backend: "synalux" });
        const callLayer1Mock = vi.fn().mockResolvedValue("ERROR");

        const result = await runInfer(
            { prompt: "write a function", mode: "code", cloud_fallback: true, max_tokens: 512 },
            makeBaseDeps({ callLocal, callCloud, callLayer1: callLayer1Mock }),
        );

        expect(callLayer1Mock).toHaveBeenCalledOnce();
        expect(callLocal).not.toHaveBeenCalled();
        expect(result.used_cloud).toBe(true);
    });

    it("OBVIOUS_NOT_RESERVED → proceeds to local tier", async () => {
        const callLocal = vi.fn().mockResolvedValue({ ok: true, text: "local response", doneReason: "stop" });
        const callCloud = vi.fn();
        const callLayer1Mock = vi.fn().mockResolvedValue("OBVIOUS_NOT_RESERVED");

        const result = await runInfer(
            { prompt: "write a TypeScript function to sort an array", mode: "code", cloud_fallback: true, max_tokens: 512 },
            makeBaseDeps({ callLocal, callCloud, callLayer1: callLayer1Mock }),
        );

        expect(callLayer1Mock).toHaveBeenCalledOnce();
        expect(callLocal).toHaveBeenCalled();
        expect(result.used_cloud).toBe(false);
    });

    it("cloud_fallback=false → Layer 1 skipped entirely", async () => {
        const callLayer1Mock = vi.fn().mockResolvedValue("OBVIOUS_RESERVED");
        const callLocal = vi.fn().mockResolvedValue({ ok: true, text: "local response", doneReason: "stop" });

        const result = await runInfer(
            { prompt: "write something", mode: "code", cloud_fallback: false, max_tokens: 512 },
            makeBaseDeps({ callLayer1: callLayer1Mock, callLocal }),
        );

        expect(callLayer1Mock).not.toHaveBeenCalled();
        expect(result.used_cloud).toBe(false);
    });

    it("recursion guard: mode=route + max_tokens<=16 skips Layer 1", async () => {
        const callLayer1Mock = vi.fn().mockResolvedValue("OBVIOUS_RESERVED");
        const callLocal = vi.fn().mockResolvedValue({ ok: true, text: "OBVIOUS_RESERVED", doneReason: "stop" });

        await runInfer(
            { prompt: "classify this", mode: "route", cloud_fallback: true, max_tokens: 16 },
            makeBaseDeps({ callLayer1: callLayer1Mock, callLocal }),
        );

        expect(callLayer1Mock).not.toHaveBeenCalled();
    });

    it("RESERVED + cloud fails → throws, never falls through to local", async () => {
        const callLocal = vi.fn().mockResolvedValue({ ok: true, text: "local response" });
        const callCloud = vi.fn().mockResolvedValue({ ok: false, reason: "synalux_timeout" });
        const callLayer1Mock = vi.fn().mockResolvedValue("OBVIOUS_RESERVED");

        await expect(
            runInfer(
                { prompt: "de-escalation plan for violent behavior", mode: "code", cloud_fallback: true, max_tokens: 512 },
                makeBaseDeps({ callLocal, callCloud, callLayer1: callLayer1Mock }),
            )
        ).rejects.toThrow("Layer 1 verdict=OBVIOUS_RESERVED");

        expect(callLocal).not.toHaveBeenCalled();
    });
});
