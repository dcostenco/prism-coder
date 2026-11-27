import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { InferDeps, PrismInferArgs } from "../../src/tools/prismInferHandler.js";
import { FREE_ENTITLEMENTS, type PrismEntitlements } from "../../src/utils/entitlements.js";
import { createOmlxTarget, type OmlxRuntime } from "../../src/utils/omlxProvider.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODEL = "Qwen3.8-Flash-Next-oQ8e-mtp";
const TARGET = createOmlxTarget("http://127.0.0.1:8000/v1", MODEL, 65536, "synthetic-provider-key");
const OUTPUT = "def identity(value):\n    return value\n";
const ENT: PrismEntitlements = { ...FREE_ENTITLEMENTS, plan: "standard", source: "portal", model_ceiling: "27b",
    features: { ...FREE_ENTITLEMENTS.features, cloud_fallback: true }, multi_turn: { enabled: true, max_turns: 12, max_chars: 32000 } };
const ask = (overrides: Partial<PrismInferArgs> = {}): PrismInferArgs => ({ prompt: "Draft a Python identity helper.", mode: "code", local_backend: "omlx", cloud_fallback: false, escalation: "report", verify: false, ...overrides });

function fixture(classifier: "OBVIOUS_NOT_RESERVED" | "OBVIOUS_RESERVED" | "UNCERTAIN" | "ERROR" = "OBVIOUS_NOT_RESERVED") {
    const events: string[] = [];
    const omlx: OmlxRuntime = {
        detect: vi.fn(async () => TARGET), acquire: vi.fn(async () => async () => {}),
        listLoaded: vi.fn(async () => new Set<string>()), unload: vi.fn(async () => {}),
        generate: vi.fn(async () => { events.push("generate"); return { ok: true as const, text: OUTPUT, doneReason: "stop", promptTokens: 1, completionTokens: 1 }; }),
    };
    const deps: InferDeps = { omlx, entitlements: ENT, freemem: () => 30 * 1024 ** 3,
        listTags: vi.fn(async () => new Set(["prism-coder:27b", "prism-coder:9b", "prism-coder:4b", "prism-coder:2b"])),
        listLoaded: vi.fn(async () => new Set<string>()), ollamaUrl: "http://127.0.0.1:11434",
        callLayer1: vi.fn(async (_text, _url, _model, _fetch, _images, opts) => { events.push(JSON.stringify(opts ?? {})); return classifier; }),
        callLocal: vi.fn(async () => ({ ok: true as const, text: OUTPUT, doneReason: "stop" })),
        callCloud: vi.fn(async () => ({ ok: true, output: "cloud draft", backend: "synalux" })), probeNumCtx: async () => 32768,
        classifierInputPolicy: async () => null, secondReadPolicy: async () => null };
    return { deps, omlx, events };
}

describe("oMLX classifier policy authority", () => {
    beforeEach(() => { vi.resetModules(); vi.unstubAllEnvs(); });
    afterEach(() => vi.unstubAllEnvs());

    it("preserves legacy defaults and passes strict text options", async () => {
        const f = fixture();
        const { runInfer } = await import("../../src/tools/prismInferHandler.js");
        const result = await runInfer(ask(), f.deps);
        expect(result.backend).toBe("omlx");
        expect(f.events.some((event) => event.includes('"strictErrors":true') && event.includes('"readOversizeWhole":true'))).toBe(true);
        expect(f.events.some((event) => event.includes("authoritativePolicy"))).toBe(false);
    });

    it.each(["OBVIOUS_RESERVED", "UNCERTAIN", "ERROR"] as const)("fails closed on %s without worker generation", async verdict => {
        const f = fixture(verdict);
        const { runInfer } = await import("../../src/tools/prismInferHandler.js");
        const result = await runInfer(ask(), f.deps);
        expect(result.backend).toBe("refused");
        expect(f.events).not.toContain("generate");
    });

    it("invalid policy authority is a structured refusal before generation", async () => {
        vi.stubEnv("PRISM_OMLX_CLASSIFIER_POLICY_AUTHORITY", "policy");
        vi.stubEnv("PRISM_OMLX_CLASSIFIER_POLICY_FILE", "/tmp/nonexistent-classifier-policy");
        vi.stubEnv("PRISM_OMLX_CLASSIFIER_POLICY_SHA256", "deadbeef");
        const f = fixture();
        const { runInfer } = await import("../../src/tools/prismInferHandler.js");
        const result = await runInfer(ask(), f.deps);
        expect(result.backend).toBe("refused");
        expect(result.gate_outcome?.reason).toBe("omlx_classifier_policy_invalid");
        expect(f.events).not.toContain("generate");
    });

    it("invalid classifier selection refuses in both report and throwing modes", async () => {
        vi.stubEnv("PRISM_OMLX_CLASSIFIER_MODEL", "invalid model name");
        const f = fixture();
        const { runInfer } = await import("../../src/tools/prismInferHandler.js");
        const result = await runInfer(ask(), f.deps);
        expect(result.backend).toBe("refused");
        expect(result.gate_outcome?.reason).toBe("omlx_classifier_model_invalid");
        await expect(runInfer(ask({ escalation: undefined }), f.deps)).rejects.toThrow("omlx_classifier_model_invalid");
        expect(f.deps.callLayer1).not.toHaveBeenCalled(); expect(f.omlx.generate).not.toHaveBeenCalled();
        expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
    });

    it("crisis input remains intercepted before classifier authority", async () => {
        vi.stubEnv("PRISM_OMLX_CLASSIFIER_POLICY_AUTHORITY", "policy");
        const f = fixture();
        const { runInfer } = await import("../../src/tools/prismInferHandler.js");
        const result = await runInfer(ask({ prompt: "I might hurt myself tonight." }), f.deps);
        expect(result.backend).toBe("safety_gate");
        expect(f.omlx.detect).not.toHaveBeenCalled();
        expect(f.events).not.toContain("generate");
    });

    it("keeps an ordinary filename request on the semantic classifier path", async () => {
        const f = fixture();
        const { runInfer } = await import("../../src/tools/prismInferHandler.js");
        const result = await runInfer(ask({ prompt: "Please rename the restraint-report filename in this generic test fixture." }), f.deps);
        expect(result.backend).toBe("omlx");
        expect(f.events.some((event) => event.includes("strictErrors"))).toBe(true);
        expect(f.events).toContain("generate");
    });

    it("enables validated authority at boot and omits classifier-input rewriting", async () => {
        const dir = mkdtempSync(join(tmpdir(), "omlx-policy-authority-"));
        const file = join(dir, "policy.txt");
        const policy = "Synthetic operator classifier policy. Return only the declared labels.";
        writeFileSync(file, policy, { mode: 0o600 });
        vi.stubEnv("PRISM_OMLX_CLASSIFIER_POLICY_AUTHORITY", "policy");
        vi.stubEnv("PRISM_OMLX_CLASSIFIER_POLICY_FILE", file);
        vi.stubEnv("PRISM_OMLX_CLASSIFIER_POLICY_SHA256", createHash("sha256").update(policy).digest("hex"));
        try {
            const f = fixture();
            const { runInfer } = await import("../../src/tools/prismInferHandler.js");
            const result = await runInfer(ask(), f.deps);
            expect(result.backend).toBe("omlx");
            expect(f.events.some((event) => event.includes('"authoritativePolicy":true'))).toBe(true);
            expect(f.events.some((event) => event.includes("classifierInput"))).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("keeps every history turn and an oversize-safe classifier option visible", async () => {
        const f = fixture();
        const { runInfer } = await import("../../src/tools/prismInferHandler.js");
        const result = await runInfer(ask({
            messages: [
                { role: "user", content: "The first generic project note." },
                { role: "assistant", content: "A prior generic response." },
            ],
            prompt: "Please summarize this generic source note. " + "x".repeat(4200),
        }), f.deps);
        expect(result.backend).toBe("refused");
        expect(result.gate_outcome?.reason).toBe("answer_unverified");
        expect(f.events.filter((event) => event.includes("strictErrors")).length).toBeGreaterThanOrEqual(3);
    });
});
