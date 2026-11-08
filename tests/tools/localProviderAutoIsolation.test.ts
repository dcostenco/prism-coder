import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/utils/localCodingSettings.js", async original => ({
    ...await original<typeof import("../../src/utils/localCodingSettings.js")>(), readLocalCodingSettings: vi.fn(),
}));
vi.mock("../../src/utils/omlxProvider.js", async original => ({
    ...await original<typeof import("../../src/utils/omlxProvider.js")>(), configuredOmlxModel: vi.fn(),
}));
vi.mock("../../src/tools/prismInferHandler.js", async original => ({
    ...await original<typeof import("../../src/tools/prismInferHandler.js")>(),
    listOllamaTags: vi.fn(async () => new Set(["prism-coder:4b"])), productionInferDeps: vi.fn(),
}));
vi.mock("../../src/utils/layer1.js", async original => ({
    ...await original<typeof import("../../src/utils/layer1.js")>(), callLayer1: vi.fn(async () => "OBVIOUS_NOT_RESERVED"),
}));

import { readLocalCodingSettings } from "../../src/utils/localCodingSettings.js";
import { configuredOmlxModel, OmlxError } from "../../src/utils/omlxProvider.js";
import { localCodingPreference } from "../../src/utils/localCodingPreference.js";
import { runInfer, listOllamaTags, productionInferDeps, type InferDeps } from "../../src/tools/prismInferHandler.js";
import { classifyQueryBoundary } from "../../src/tools/queryMemoryNaturalHandler.js";
import { FREE_ENTITLEMENTS } from "../../src/utils/entitlements.js";

describe("Auto does not read an ineligible provider configuration", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(readLocalCodingSettings).mockResolvedValue({ backend: "auto", source: "existing" });
        vi.mocked(configuredOmlxModel).mockRejectedValue(new OmlxError("omlx_config_unavailable"));
    });
    function deps(): InferDeps {
        return { codingPreference: localCodingPreference,
            entitlements: { ...FREE_ENTITLEMENTS, model_ceiling: "27b" }, freemem: () => 30 * 1024 ** 3,
            listTags: vi.fn(async () => new Set(["prism-coder:27b", "prism-coder:4b"])), listLoaded: vi.fn(async () => new Set<string>()),
            ollamaUrl: "http://127.0.0.1:11434", callLayer1: vi.fn(async () => "OBVIOUS_NOT_RESERVED"),
            callLocal: vi.fn(async () => ({ ok: true as const, text: "The project notes are available locally.", doneReason: "stop" })),
            callCloud: vi.fn(async () => ({ ok: false, output: "", backend: "synalux" })), probeNumCtx: async () => 65536,
            classifierInputPolicy: async () => null, secondReadPolicy: async () => null, answerCheckPolicy: async () => null,
        };
    }
    it.each([undefined, "route", "chat"] as const)("keeps Auto mode %s working when unrelated oMLX settings are unreadable", async mode => {
        const f = deps();
        const result = await runInfer({ prompt: "Look up my project notes.", mode, cloud_fallback: false, verify: false, route_guard: "local", escalation: "report" }, f);
        expect(result.backend).toMatch(/^ollama-/);
        expect(f.callLocal).toHaveBeenCalled();
        expect(configuredOmlxModel).not.toHaveBeenCalled();
    });
    it("keeps code-mode Auto strict when its eligible oMLX configuration is broken", async () => {
        const f = deps();
        expect(await runInfer({ prompt: "Draft a Python helper.", mode: "code", escalation: "report" }, f))
            .toMatchObject({ backend: "refused", gate_outcome: { reason: "local_coding_preference_invalid" } });
        expect(configuredOmlxModel).toHaveBeenCalled();
        expect(f.callLocal).not.toHaveBeenCalled();
    });
    it.each([
        { ceiling: "4b", planCeiling: "27b" },
        { ceiling: undefined, planCeiling: "9b" },
    ] as const)("does not read oMLX settings when Auto code cannot select it: %j", async ({ ceiling, planCeiling }) => {
        const f = deps();
        f.entitlements = { ...FREE_ENTITLEMENTS, model_ceiling: planCeiling };
        f.callLocal = vi.fn(async () => ({ ok: true as const, text: "def identity(value):\n    return value\n", doneReason: "stop" }));
        const result = await runInfer({ prompt: "Draft a Python identity helper.", mode: "code", model_ceiling: ceiling,
            cloud_fallback: false, verify: false, escalation: "report" }, f);
        expect(result.backend).toMatch(/^ollama-/);
        expect(f.callLocal).toHaveBeenCalled();
        expect(configuredOmlxModel).not.toHaveBeenCalled();
    });
    it("keeps the Auto memory boundary on Ollama without consulting oMLX configuration", async () => {
        expect(await classifyQueryBoundary("What could explain this change in behavior?")).toBe("OBVIOUS_NOT_RESERVED");
        expect(listOllamaTags).toHaveBeenCalled();
        expect(configuredOmlxModel).not.toHaveBeenCalled();
        expect(productionInferDeps).not.toHaveBeenCalled();
    });
});
