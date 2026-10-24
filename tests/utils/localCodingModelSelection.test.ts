import { describe, expect, it, vi } from "vitest";
import { selectUnassignedCodingModel, type LocalCodingSelection } from "../../src/utils/localCodingModelSelection.js";

const request = (extra: Partial<LocalCodingSelection> = {}): LocalCodingSelection => ({ backend: "omlx", role: "coder",
    ceiling: "27b", ollamaUrl: "http://127.0.0.1:11434", deadlineMs: Date.now() + 1000, ...extra });
const row = (id: string, extra = {}) => ({ id, loaded: false, weightBytes: 1024, contextTokens: 8192, ...extra });
const fixture = () => ({ recommend: vi.fn(async () => undefined as string | undefined),
    omlxModels: vi.fn(async () => [row("vendor/future-a"), row("vendor/future-b", { loaded: true })]),
    omlxDefault: vi.fn(async () => undefined as string | undefined),
    ollamaModels: vi.fn(async () => [row("org/embedding:tag"), row("org/code:future", { weightBytes: 2048 })]),
    ollamaChoice: vi.fn(async (_url: string, id: string) => {
        if (id.includes("embedding")) throw new Error("ollama_model_metadata_incomplete");
        return { tag: id, weightsGb: 1, minFreeGb: 3, ctxTokens: 4096 };
    }) });

describe("unassigned local coding selection", () => {
    it("matches one hint to local discovery without passing any inventory to Synalux", async () => {
        const f = fixture(); f.recommend.mockResolvedValue("vendor/future-a");
        expect(await selectUnassignedCodingModel(request(), f)).toBe("vendor/future-a");
        const [backend, role, options] = f.recommend.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
        expect([backend, role]).toEqual(["omlx", "coder"]);
        expect(Object.keys(options).sort()).toEqual(["deadlineMs", "signal"]);
        expect(f.ollamaModels).not.toHaveBeenCalled();
    });
    it("uses local configuration or discovery when hints are unavailable or absent locally", async () => {
        const f = fixture(); f.recommend.mockResolvedValue("vendor/not-installed");
        expect(await selectUnassignedCodingModel(request(), f)).toBe("vendor/future-b");
        f.omlxDefault.mockResolvedValue("vendor/future-a");
        f.recommend.mockRejectedValue(new Error("offline"));
        expect(await selectUnassignedCodingModel(request({ role: "reviewer" }), f)).toBe("vendor/future-a");
    });
    it.each(["vendor/future-a", "vendor/future-a:fast"])("preserves configured provider model %s before any hint or automatic inventory", async id => {
        const f = fixture(); f.omlxDefault.mockResolvedValue(id); f.recommend.mockResolvedValue("vendor/future-b");
        expect(await selectUnassignedCodingModel(request(), f)).toBe(id);
        expect(f.recommend).not.toHaveBeenCalled(); expect(f.omlxModels).not.toHaveBeenCalled();
    });
    it("refuses unknown automatic oMLX metadata and preserves lower-ceiling refusal before probing", async () => {
        const f = fixture();
        f.omlxModels.mockResolvedValue([row("unknown", { contextTokens: undefined })]);
        await expect(selectUnassignedCodingModel(request(), f)).rejects.toThrow("local_coding_model_unavailable");
        f.omlxModels.mockClear();
        await expect(selectUnassignedCodingModel(request({ ceiling: "9b" }), f)).rejects.toThrow("omlx_model_ceiling");
        expect(f.omlxModels).not.toHaveBeenCalled(); expect(f.recommend).not.toHaveBeenCalled();
    });
    it("reuses exact Ollama metadata/ceiling checks and skips non-completion models", async () => {
        const f = fixture();
        expect(await selectUnassignedCodingModel(request({ backend: "ollama", ceiling: "9b" }), f)).toBe("org/code:future");
        expect(f.ollamaChoice).toHaveBeenCalledWith("http://127.0.0.1:11434", "org/code:future", "9b", undefined,
            expect.objectContaining({ deadlineMs: expect.any(Number), signal: expect.any(AbortSignal) }));
        expect(f.omlxModels).not.toHaveBeenCalled();
    });
    it("does not contact Synalux or continue discovery after a timed-out local probe", async () => {
        const f = fixture();
        f.omlxModels.mockImplementation(async () => { await new Promise(r => setTimeout(r, 30)); return [row("late")]; });
        await expect(selectUnassignedCodingModel(request({ deadlineMs: Date.now() + 5 }), f)).rejects.toThrow("local_coding_selection_timeout");
        await new Promise(r => setTimeout(r, 40));
        expect(f.recommend).not.toHaveBeenCalled();
    });
});
