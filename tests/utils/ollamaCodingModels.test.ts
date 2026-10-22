import { describe, expect, it, vi } from "vitest";
import { inspectOllamaCodingModels, selectedOllamaCodingModel } from "../../src/utils/ollamaCodingModels.js";
const id = "org/future:tag", GIB = 1024 ** 3;
function fixture(overrides: Record<string, unknown> = {}, weightBytes = 12 * GIB) {
    const info = { "general.architecture": "example", "general.parameter_count": 26e9, "example.context_length": 32768,
        "example.block_count": 60, "example.embedding_length": 4096, "example.attention.head_count": 32, "example.attention.head_count_kv": 8, ...overrides };
    const fetcher = vi.fn(async (url: any, init?: RequestInit) => {
        const data = String(url).endsWith("/api/tags") ? { models: [{ name: id, size: weightBytes }] }
            : String(url).endsWith("/api/ps") ? { models: [{ name: id, size_vram: 13 * GIB, context_length: 4096 }] }
            : { model_info: info, capabilities: ["completion", "thinking"], parameters: "num_ctx 65536" };
        return new Response(JSON.stringify(data));
    });
    return { fetcher };
}
describe("discovered Ollama coding models", () => {
    it("discovers arbitrary IDs, weights and loaded memory without inference or pull calls", async () => {
        const { fetcher } = fixture();
        expect(await inspectOllamaCodingModels("http://local", fetcher)).toEqual([{ id, weightBytes: 12 * GIB, loaded: true, loadedBytes: 13 * GIB, contextTokens: 4096 }]);
        expect(fetcher.mock.calls.map(call => call[0])).toEqual(["http://local/api/tags", "http://local/api/ps"]);
        expect(fetcher.mock.calls.every(call => call[1]?.redirect === "error")).toBe(true);
    });
    it("derives conservative context and RAM estimates from metadata, independent of model spelling", async () => {
        const { fetcher } = fixture();
        const model = await selectedOllamaCodingModel("http://local", id, "27b", fetcher);
        expect(model).toMatchObject({ tag: id, weightsGb: 12, ctxTokens: 4096, prefersThinking: true });
        expect(model.minFreeGb).toBeGreaterThanOrEqual(18);
        expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({ model: id });
    });
    it.each([undefined, NaN, 0, -1, "27B"])("does not infer parameter count from a name when metadata is %j", async count => {
        await expect(selectedOllamaCodingModel("http://local", id, "27b", fixture({ "general.parameter_count": count }).fetcher)).rejects.toThrow("ollama_model_metadata_incomplete");
    });
    it("enforces the caller/plan ceiling using reported parameter count", async () => {
        await expect(selectedOllamaCodingModel("http://local", id, "9b", fixture().fetcher)).rejects.toThrow("ollama_model_ceiling");
    });
    it.each([[27_432_406_640, '27b'], [9_241_705_984, '9b']] as const)("accepts nominal size %s within %s", async (params, ceiling) => {
        await expect(selectedOllamaCodingModel('http://local', id, ceiling, fixture({ 'general.parameter_count': params }).fetcher)).resolves.toMatchObject({ tag: id });
    });
    it('does not make the top nominal tier unlimited', async () => {
        await expect(selectedOllamaCodingModel('http://local', id, '27b', fixture({ 'general.parameter_count': 70e9 }).fetcher)).rejects.toThrow('ollama_model_ceiling');
    });
    it("refuses unknown memory architecture instead of inventing a fit", async () => {
        await expect(selectedOllamaCodingModel("http://local", id, "27b", fixture({ "example.block_count": undefined }).fetcher)).rejects.toThrow("ollama_model_memory_unknown");
    });
    it('accounts for independently declared key/value head dimensions', async () => {
        const fetcher = fixture({ 'example.block_count': 36, 'example.embedding_length': 2560,
            'example.attention.key_length': 128, 'example.attention.value_length': 128 }, 2 * GIB).fetcher;
        const model = await selectedOllamaCodingModel('http://local', id, '27b', fetcher);
        expect(model.minFreeGb).toBeGreaterThanOrEqual(2 + (36 * 8 * 256 * 4096 * 2) / GIB + 2);
    });
    it('refuses invalid explicit head dimensions rather than reverting to a smaller estimate', async () => {
        await expect(selectedOllamaCodingModel('http://local', id, '27b', fixture({ 'example.attention.key_length': 0 }).fetcher)).rejects.toThrow('ollama_model_memory_unknown');
    });
    it("requires exact installation, never resolves a similarly named tag", async () => {
        await expect(selectedOllamaCodingModel("http://local", "other/future:tag", "27b", fixture().fetcher)).rejects.toThrow("ollama_model_not_installed");
    });
    it("rejects malformed and duplicate inventories", async () => {
        const fetcher = async () => new Response(JSON.stringify({ models: [{ name: id }, { name: id }] }));
        await expect(inspectOllamaCodingModels("http://local", fetcher)).rejects.toThrow("ollama_model_inventory_invalid");
    });
});
