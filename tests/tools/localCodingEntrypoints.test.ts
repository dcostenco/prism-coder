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
            .toEqual(["backend", "ceiling", "deadlineMs", "ollamaUrl", "role"]);
    });
    it.each(["coder", "reviewer"] as const)("MCP default dependencies reach the selector for %s", async local_role => {
        const response = await prismInferHandler({ prompt: "Draft a Python identity helper.", mode: "code", local_role,
            cloud_fallback: false, escalation: "report" });
        expect(response.structuredContent).toMatchObject({ backend: "refused", gate_outcome: { reason: "local_coding_model_unavailable" } });
        expect(selectUnassignedCodingModel).toHaveBeenCalledWith(expect.objectContaining({ backend: "omlx", role: local_role }));
    });
});
