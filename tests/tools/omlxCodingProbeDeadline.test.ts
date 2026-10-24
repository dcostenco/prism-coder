import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
const fixtureCredential = randomUUID();
const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));
vi.mock("node:fs/promises", async original => ({
    ...await original<typeof import("node:fs/promises")>(), readFile: readFileMock,
}));
import { selectedOllamaCodingModel } from "../../src/utils/ollamaCodingModels.js";

describe("local model probe deadlines", () => {
    beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
    it("does not start Ollama show after the deadline", async () => {
        const calls: string[] = [];
        const id = "fixture/future:tag";
        const fetcher = async (url: string) => {
            calls.push(url);
            await new Promise(resolve => setTimeout(resolve, 30));
            const data = url.endsWith("/api/tags") ? { models: [{ name: id, size: 1024 ** 3 }] }
                : url.endsWith("/api/ps") ? { models: [] } : {
                    capabilities: ["completion"], model_info: { "general.architecture": "fixture", "general.parameter_count": 9e9,
                        "fixture.context_length": 4096, "fixture.block_count": 24, "fixture.embedding_length": 1024,
                        "fixture.attention.head_count": 8, "fixture.attention.head_count_kv": 4 } };
            return new Response(JSON.stringify(data));
        };
        await expect(selectedOllamaCodingModel("http://local", id, "27b", fetcher as typeof fetch,
            { deadlineMs: Date.now() + 5 })).rejects.toThrow("ollama_model_probe_deadline");
        expect(calls.some(url => url.endsWith("/api/show"))).toBe(false);
    });
    it("does not start oMLX status after a late settings read", async () => {
        const { inspectOmlxCodingModels } = await import("../../src/utils/omlxProvider.js");
        readFileMock.mockImplementation(async path => {
            await new Promise(resolve => setTimeout(resolve, 30));
            return String(path).endsWith("/settings.json")
                ? JSON.stringify({ server: { host: "127.0.0.1", port: 8000 }, auth: { api_key: fixtureCredential } }) : "{}";
        });
        const fetcher = vi.fn(async () => new Response(JSON.stringify({ models: [] })));
        await expect(inspectOmlxCodingModels({ basePath: "/synthetic-only", env: {}, fetchImpl: fetcher,
            deadlineMs: Date.now() + 5 })).rejects.toThrow("omlx_inspection_timeout");
        expect(readFileMock).toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    });
    it("refuses oMLX before status when its signal is already aborted", async () => {
        const { inspectOmlxCodingModels } = await import("../../src/utils/omlxProvider.js");
        const fetcher = vi.fn(async () => new Response(JSON.stringify({ models: [] })));
        await expect(inspectOmlxCodingModels({ basePath: "/synthetic-only", fetchImpl: fetcher, signal: AbortSignal.abort() }))
            .rejects.toThrow("omlx_inspection_timeout");
        expect(readFileMock).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    });
});
