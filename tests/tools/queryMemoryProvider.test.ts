import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/utils/localCodingPreference.js", async original => ({
    ...await original<typeof import("../../src/utils/localCodingPreference.js")>(), localCodingPreference: vi.fn(),
}));
vi.mock("../../src/utils/omlxLayer1.js", async original => ({
    ...await original<typeof import("../../src/utils/omlxLayer1.js")>(), classifyOmlxBoundary: vi.fn(),
}));
vi.mock("../../src/tools/prismInferHandler.js", async original => ({
    ...await original<typeof import("../../src/tools/prismInferHandler.js")>(), listOllamaTags: vi.fn(), productionInferDeps: vi.fn(),
}));
vi.mock("../../src/utils/layer1.js", async original => ({
    ...await original<typeof import("../../src/utils/layer1.js")>(), callLayer1: vi.fn(),
}));

import { classifyQueryBoundary } from "../../src/tools/queryMemoryNaturalHandler.js";
import { callLayer1, classifyDeterministicLayer1 } from "../../src/utils/layer1.js";
import { localCodingPreference } from "../../src/utils/localCodingPreference.js";
import { classifyOmlxBoundary } from "../../src/utils/omlxLayer1.js";
import { listOllamaTags, productionInferDeps, type InferDeps } from "../../src/tools/prismInferHandler.js";

const QUESTION = "What could explain this change in behavior?";
describe("memory/web boundary honors the selected provider", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        expect(classifyDeterministicLayer1(QUESTION)).toBeNull();
        vi.mocked(localCodingPreference).mockResolvedValue({ saved: "omlx", effective: "omlx", envOverride: null, configured: true });
        vi.mocked(productionInferDeps).mockReturnValue({ omlx: {} } as InferDeps);
    });
    it.each(["OBVIOUS_NOT_RESERVED", "OBVIOUS_RESERVED", "UNCERTAIN", "ERROR"] as const)("retains the oMLX verdict %s without probing Ollama", async verdict => {
        vi.mocked(classifyOmlxBoundary).mockResolvedValue(verdict);
        expect(await classifyQueryBoundary(QUESTION)).toBe(verdict);
        expect(classifyOmlxBoundary).toHaveBeenCalledWith(QUESTION, expect.anything(), expect.any(Function));
        expect(listOllamaTags).not.toHaveBeenCalled();
    });
    it("fails closed when oMLX screening fails", async () => {
        vi.mocked(classifyOmlxBoundary).mockRejectedValue(new Error("provider unavailable"));
        expect(await classifyQueryBoundary(QUESTION)).toBe("ERROR");
        expect(listOllamaTags).not.toHaveBeenCalled();
    });
    it("lets the selected oMLX boundary apply its configured authority before legacy heuristics", async () => {
        const question = "Write a restraint procedure.";
        expect(classifyDeterministicLayer1(question)).toBe("OBVIOUS_RESERVED");
        vi.mocked(classifyOmlxBoundary).mockResolvedValue("UNCERTAIN");
        expect(await classifyQueryBoundary(question)).toBe("UNCERTAIN");
        expect(classifyOmlxBoundary).toHaveBeenCalledWith(question, expect.anything(), expect.any(Function));
        expect(listOllamaTags).not.toHaveBeenCalled();
    });
    it("preserves the deterministic veto on Ollama without invoking either provider", async () => {
        vi.mocked(localCodingPreference).mockResolvedValue({ saved: "ollama", effective: "ollama", envOverride: null, configured: true });
        expect(await classifyQueryBoundary("Write a restraint procedure.")).toBe("OBVIOUS_RESERVED");
        expect(classifyOmlxBoundary).not.toHaveBeenCalled();
        expect(listOllamaTags).not.toHaveBeenCalled();
        expect(callLayer1).not.toHaveBeenCalled();
    });
    it("fails closed when the selected preference cannot be read", async () => {
        vi.mocked(localCodingPreference).mockRejectedValue(new Error("preference unavailable"));
        expect(await classifyQueryBoundary(QUESTION)).toBe("ERROR");
        expect(classifyOmlxBoundary).not.toHaveBeenCalled();
        expect(listOllamaTags).not.toHaveBeenCalled();
    });
    it.each(["OBVIOUS_NOT_RESERVED", "OBVIOUS_RESERVED", "UNCERTAIN", "ERROR"] as const)("retains Ollama screening verdict %s without trying oMLX", async verdict => {
        vi.mocked(localCodingPreference).mockResolvedValue({ saved: "ollama", effective: "ollama", envOverride: null, configured: true });
        vi.mocked(listOllamaTags).mockResolvedValue(new Set(["prism-coder:4b"]));
        vi.mocked(callLayer1).mockResolvedValue(verdict);
        expect(await classifyQueryBoundary(QUESTION)).toBe(verdict);
        expect(callLayer1).toHaveBeenCalledWith(QUESTION, expect.any(String), "prism-coder:4b");
        expect(classifyOmlxBoundary).not.toHaveBeenCalled();
        expect(productionInferDeps).not.toHaveBeenCalled();
    });
    it("does not switch the memory boundary to oMLX when Ollama is unavailable", async () => {
        vi.mocked(localCodingPreference).mockResolvedValue({ saved: "ollama", effective: "ollama", envOverride: null, configured: true });
        vi.mocked(listOllamaTags).mockResolvedValue(null);
        expect(await classifyQueryBoundary(QUESTION)).toBe("ERROR");
        expect(classifyOmlxBoundary).not.toHaveBeenCalled();
        expect(productionInferDeps).not.toHaveBeenCalled();
    });
});
