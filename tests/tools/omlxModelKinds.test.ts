import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));
vi.mock("node:fs/promises", async original => ({
    ...await original<typeof import("node:fs/promises")>(), readFile: readFileMock,
}));
let provider: typeof import("../../src/utils/omlxProvider.js");

const id = "fixture-text-model", credential = randomUUID();
const options = { basePath: "/fixture-only", env: {} };
const text = { id, engine_type: "batched", model_type: "llm", loaded: false, is_loading: false,
    estimated_size: 9990258624, max_context_window: 32768, model_path: "/fixture/models/fixture-text-model",
    distributed: false, source_type: "local", config_model_type: "qwen3_5" };
function fetcher(models: unknown[]) {
    return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => Response.json(
        String(url).endsWith("/models/status") ? { models } : { data: [{ id }] }));
}
beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    readFileMock.mockImplementation(async path => basename(String(path)) === "settings.json"
        ? JSON.stringify({ auth: { api_key: credential }, sampling: { max_context_window: 32768 } }) : "{}");
    provider = await import("../../src/utils/omlxProvider.js");
});

describe("oMLX model category versus execution engine", () => {
    it("keeps a batched text model discoverable with its real weight estimate", async () => {
        const fetchImpl = fetcher([text]);
        await expect(provider.inspectOmlxCodingModels({ ...options, fetchImpl })).resolves.toEqual([
            { id, loaded: false, weightBytes: text.estimated_size, contextTokens: 32768 },
        ]);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(String(fetchImpl.mock.calls[0][0])).toMatch(/\/v1\/models\/status$/);
        expect(fetchImpl.mock.calls[0][1]?.body).toBeUndefined();
    });
    it("accepts the same batched model in serving inspection without granting generation", async () => {
        const fetchImpl = fetcher([text]);
        const target = await provider.detectOmlx(id, { ...options, fetchImpl });
        const result = await provider.inspectOmlxServing(target, { fetchImpl });
        expect(result).toMatchObject({ model_id: id, engine_type: "batched", model_path: text.model_path,
            generation_enabled: false, qualification: "not_qualified", serving_identity_verified: false });
        expect(fetchImpl.mock.calls.map(call => new URL(String(call[0])).pathname)).toEqual(["/v1/models", "/v1/models/status"]);
    });
    it("uses an explicit noncoding category instead of a misleading legacy engine name", async () => {
        const fetchImpl = fetcher([{ ...text, engine_type: "llm", model_type: "embedding" }]);
        await expect(provider.inspectOmlxCodingModels({ ...options, fetchImpl })).resolves.toEqual([]);
    });
    it("preserves legacy category-only metadata and vision inventory", async () => {
        const fetchImpl = fetcher([{ ...text, model_type: undefined, engine_type: "llm" },
            { ...text, id: "fixture-vision", model_type: "vlm", engine_type: "vlm" }]);
        expect((await provider.inspectOmlxCodingModels({ ...options, fetchImpl })).map(row => row.id)).toEqual([id, "fixture-vision"]);
    });
    it.each([
        { engine_type: "batched", model_type: undefined },
        { engine_type: "batched", model_type: "vlm" },
        { engine_type: "new-engine", model_type: "llm" },
        { engine_type: "llm", model_type: "embedding" },
    ])("refuses unsupported or inconsistent serving metadata: %j", async fields => {
        const fetchImpl = fetcher([{ ...text, ...fields }]);
        const target = await provider.detectOmlx(id, { ...options, fetchImpl });
        await expect(provider.inspectOmlxServing(target, { fetchImpl })).rejects.toThrow("omlx_serving_model_invalid");
    });
    it("still rejects malformed paths and mismatched context after recognizing batched text", async () => {
        for (const fields of [{ model_path: "relative/model" }, { max_context_window: 4096 }]) {
            const fetchImpl = fetcher([{ ...text, ...fields }]);
            const target = await provider.detectOmlx(id, { ...options, fetchImpl });
            await expect(provider.inspectOmlxServing(target, { fetchImpl })).rejects.toThrow("omlx_serving_model_invalid");
        }
    });
});
