import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/utils/localCodingPreference.js", async original => ({
    ...await original<typeof import("../../src/utils/localCodingPreference.js")>(),
    localCodingPreference: vi.fn(),
}));
vi.mock("../../src/utils/localCodingModelSelection.js", async original => ({
    ...await original<typeof import("../../src/utils/localCodingModelSelection.js")>(),
    selectUnassignedCodingModel: vi.fn(),
}));
vi.mock("../../src/utils/entitlements.js", async original => ({
    ...await original<typeof import("../../src/utils/entitlements.js")>(), getEntitlements: vi.fn(),
}));
vi.mock("../../src/utils/inferenceMetrics.js", async original => ({
    ...await original<typeof import("../../src/utils/inferenceMetrics.js")>(), recordInference: vi.fn(), formatInferenceMetrics: () => "",
}));
vi.mock("../../src/utils/ddLogger.js", () => ({ ddLog: vi.fn() }));
vi.mock("../../src/utils/availableMemory.js", () => ({ getAvailableMemoryBytes: () => 30 * 1024 ** 3 }));
vi.mock("../../src/utils/omlxProvider.js", async original => ({
    ...await original<typeof import("../../src/utils/omlxProvider.js")>(),
    withInferenceResourceLease: async (_exclusive: boolean, action: () => Promise<unknown>) => action(),
    withOllamaResourceLease: async (action: () => Promise<unknown>) => action(),
}));

import { inferText, prismInferHandler } from "../../src/tools/prismInferHandler.js";
import { localCodingPreference } from "../../src/utils/localCodingPreference.js";
import { selectUnassignedCodingModel } from "../../src/utils/localCodingModelSelection.js";
import { FREE_ENTITLEMENTS, getEntitlements } from "../../src/utils/entitlements.js";

describe("default production coding entrypoints", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getEntitlements).mockResolvedValue({ ...FREE_ENTITLEMENTS, model_ceiling: "27b" });
        vi.mocked(localCodingPreference).mockResolvedValue({ saved: "omlx", effective: "omlx", configured: true, envOverride: null });
        vi.mocked(selectUnassignedCodingModel).mockRejectedValue(new Error("local_coding_model_unavailable"));
    });
    it("internal inferText(code) reaches the installed selector and reports unavailability", async () => {
        expect(await inferText("Draft a Python identity helper.", { mode: "code" })).toBeNull();
        expect(selectUnassignedCodingModel).toHaveBeenCalledWith(expect.objectContaining({ backend: "omlx", role: "coder", ceiling: "27b" }));
        expect(Object.keys(vi.mocked(selectUnassignedCodingModel).mock.calls[0][0]).sort())
            .toEqual(["backend", "ceiling", "deadlineMs", "ollamaUrl", "role", "signal"]);
        expect(vi.mocked(selectUnassignedCodingModel).mock.calls[0][0].signal).toBeUndefined();
    });
    it("on-device text refuses a remote Ollama before classification or model selection", async () => {
        vi.stubEnv("PRISM_LOCAL_LLM_URL", "http://network-ollama.test:11434");
        try {
            vi.resetModules();
            const { inferText } = await import("../../src/tools/prismInferHandler.js");
            const { getEntitlements } = await import("../../src/utils/entitlements.js");
            const { localCodingPreference } = await import("../../src/utils/localCodingPreference.js");
            const { selectUnassignedCodingModel } = await import("../../src/utils/localCodingModelSelection.js");
            vi.mocked(getEntitlements).mockResolvedValue(FREE_ENTITLEMENTS);
            vi.mocked(localCodingPreference).mockResolvedValue({ saved: "ollama", effective: "ollama", configured: true, envOverride: null });
            vi.mocked(selectUnassignedCodingModel).mockRejectedValue(new Error("Synthetic model boundary"));
            expect(await inferText("Draft a Python identity helper.", { mode: "code", localOnly: true })).toBeNull();
            expect(getEntitlements).not.toHaveBeenCalled();
            expect(selectUnassignedCodingModel).not.toHaveBeenCalled();
            expect(await inferText("Draft a Python identity helper.", { mode: "code" })).toBeNull();
            expect(selectUnassignedCodingModel).toHaveBeenCalledWith(expect.objectContaining({ ollamaUrl: "http://network-ollama.test:11434" }));
        } finally {
            vi.unstubAllEnvs();
        }
    });
    it("protects memory evidence before classification when the configured Ollama is remote", async () => {
        vi.stubEnv("PRISM_LOCAL_LLM_URL", "http://network-ollama.test:11434");
        try {
            vi.resetModules();
            const { prismInferHandler } = await import("../../src/tools/prismInferHandler.js");
            const { getEntitlements } = await import("../../src/utils/entitlements.js");
            expect(await prismInferHandler({ prompt: "Describe a saved project decision.", mode: "chat",
                evidence: [{ source: "memory", content: "private fixture text" }],
                verify: true, cloud_fallback: true }, undefined, { localOnly: true }))
                .toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/local_endpoint_required/) }] });
            expect(getEntitlements).not.toHaveBeenCalled();
        } finally { vi.unstubAllEnvs(); }
    });
    it("MCP cancellation reaches selection before generation can start", async () => {
        const controller = new AbortController();
        let entered!: () => void;
        const selecting = new Promise<void>(resolve => { entered = resolve; });
        vi.mocked(selectUnassignedCodingModel).mockImplementation(options => {
            entered();
            return new Promise((_resolve, reject) => {
                if (!options.signal) { reject(new Error("missing caller cancellation")); return; }
                options.signal.addEventListener("abort", () => reject(new Error("selection aborted")), { once: true });
            });
        });
        const pending = prismInferHandler({ prompt: "Draft a Python identity helper.", mode: "code",
            cloud_fallback: false, escalation: "report" }, undefined, { signal: controller.signal });
        await selecting;
        const suppliedSignal = vi.mocked(selectUnassignedCodingModel).mock.calls[0][0].signal;
        controller.abort();
        const response = await pending;
        expect(suppliedSignal).toBe(controller.signal);
        expect(response).toMatchObject({ isError: true, content: [{ text: "prism_infer: caller_cancelled" }] });
    });
    it.each(["coder", "reviewer"] as const)("MCP default dependencies reach the selector for %s", async local_role => {
        const response = await prismInferHandler({ prompt: "Draft a Python identity helper.", mode: "code", local_role,
            cloud_fallback: false, escalation: "report" });
        expect(response.structuredContent).toMatchObject({ backend: "refused", gate_outcome: { reason: "local_coding_model_unavailable" } });
        expect(selectUnassignedCodingModel).toHaveBeenCalledWith(expect.objectContaining({ backend: "omlx", role: local_role }));
    });
    it.each([undefined, "route", "chat"] as const)("MCP production dependencies honor saved oMLX for mode %s", async mode => {
        const response = await prismInferHandler({ prompt: "Look up my saved project notes.", mode,
            cloud_fallback: false, escalation: "report" });
        expect(response.structuredContent).toMatchObject({ backend: "refused", gate_outcome: { reason: "local_coding_model_unavailable" } });
        expect(selectUnassignedCodingModel).toHaveBeenCalledWith(expect.objectContaining({ backend: "omlx", role: "coder" }));
    });
});
