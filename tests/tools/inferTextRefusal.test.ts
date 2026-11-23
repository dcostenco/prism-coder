import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { ReservedRefusalError } from "../../src/tools/prismInferHandler.js";
import { fileURLToPath } from "node:url";
import { compactLedgerHandler } from "../../src/tools/compactionHandler.js";
import { appendInferMetric } from "../../src/storage/inferMetricsLedger.js";
import { FREE_ENTITLEMENTS, getEntitlements } from "../../src/utils/entitlements.js";
import { callLayer1, keywordBackstop } from "../../src/utils/layer1.js";
import { consumeHostExecution, HostAuthorizationError } from "../../src/utils/hostTasks.js";
import { getSynaluxJwt } from "../../src/utils/synaluxJwt.js";

const { storage, generateText } = vi.hoisted(() => ({
    storage: {
        getLedgerEntries: vi.fn(),
        saveLedger: vi.fn(),
        patchLedger: vi.fn(),
        createLink: vi.fn(),
        upsertSemanticKnowledge: vi.fn(),
    },
    generateText: vi.fn(),
}));

vi.mock("../../src/config.js", async original => ({
    ...await original<typeof import("../../src/config.js")>(),
    PRISM_LOCAL_LLM_ENABLED: true,
    PRISM_FORCE_LOCAL: false,
    PRISM_STRICT_LOCAL_MODE: false,
    PRISM_LOCAL_LLM_URL: "http://127.0.0.1:11434",
    PRISM_SYNALUX_BASE_URL: "https://provider.fixture.invalid",
}));
vi.mock("../../src/storage/index.js", () => ({
    activeStorageBackend: "local",
    getStorage: () => storage,
}));
vi.mock("../../src/storage/inferMetricsLedger.js", () => ({
    appendInferMetric: vi.fn(),
    queryInferMetrics: vi.fn(),
}));
vi.mock("../../src/utils/llm/factory.js", () => ({
    getLLMProvider: () => ({ generateText }),
}));
vi.mock("../../src/utils/entitlements.js", async original => ({
    ...await original<typeof import("../../src/utils/entitlements.js")>(),
    getEntitlements: vi.fn(),
}));
vi.mock("../../src/utils/layer1.js", async original => ({
    ...await original<typeof import("../../src/utils/layer1.js")>(),
    callLayer1: vi.fn(),
    keywordBackstop: vi.fn(),
}));
vi.mock("../../src/utils/inferencePolicy.js", async original => ({
    ...await original<typeof import("../../src/utils/inferencePolicy.js")>(),
    getAnswerCheckPolicy: async () => null,
    getClassifierInputPolicy: async () => null,
    getSecondReadPolicy: async () => null,
}));
vi.mock("../../src/utils/hostTasks.js", async original => ({
    ...await original<typeof import("../../src/utils/hostTasks.js")>(),
    consumeHostExecution: vi.fn(),
}));
vi.mock("../../src/utils/localCodingPreference.js", async original => ({
    ...await original<typeof import("../../src/utils/localCodingPreference.js")>(),
    localCodingPreference: async () => ({ saved: "ollama", effective: "ollama", configured: true, envOverride: null }),
}));
vi.mock("../../src/utils/availableMemory.js", () => ({ getAvailableMemoryBytes: () => 16 * 1024 ** 3 }));
vi.mock("../../src/utils/omlxProvider.js", async original => ({
    ...await original<typeof import("../../src/utils/omlxProvider.js")>(),
    withInferenceResourceLease: async (_exclusive: boolean, action: () => Promise<unknown>) => action(),
    withOllamaResourceLease: async (action: () => Promise<unknown>) => action(),
}));
vi.mock("../../src/utils/ddLogger.js", () => ({ ddLog: vi.fn() }));
vi.mock("../../src/utils/synaluxJwt.js", () => ({
    getSynaluxJwt: vi.fn(async () => null),
    invalidateSynaluxJwt: vi.fn(),
}));

let installed: string[];

function compactFixture(count = 1) {
    const entries = Array.from({ length: count + 1 }, (_, index) => ({
        id: `entry-${index}`,
        summary: "Routine project maintenance.",
        decisions: [],
        files_changed: [],
        keywords: [],
        session_date: "2026-11-20",
    }));
    storage.getLedgerEntries.mockResolvedValueOnce(entries).mockResolvedValueOnce(entries.slice(0, count));
    return compactLedgerHandler({ project: "fixture", threshold: 1, keep_recent: 1 });
}

function expectNoFallbackOrWrites() {
    expect(getSynaluxJwt).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(storage.saveLedger).not.toHaveBeenCalled();
    expect(storage.patchLedger).not.toHaveBeenCalled();
    expect(storage.createLink).not.toHaveBeenCalled();
    expect(storage.upsertSemanticKnowledge).not.toHaveBeenCalled();
}

describe("Compaction inference failure boundary", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        installed = ["prism-coder:4b"];
        vi.mocked(getEntitlements).mockResolvedValue(FREE_ENTITLEMENTS);
        vi.mocked(callLayer1).mockResolvedValue("ERROR");
        vi.mocked(keywordBackstop).mockReturnValue("OBVIOUS_RESERVED");
        generateText.mockResolvedValue(JSON.stringify({ summary: "Combined routine maintenance." }));
        storage.saveLedger.mockResolvedValue([{ id: "rollup-fixture" }]);
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
            const url = new URL(input);
            if (url.origin === "http://127.0.0.1:11434" && url.pathname === "/api/tags") {
                return Response.json({ models: installed.map(name => ({ name })) });
            }
            if (url.origin === "http://127.0.0.1:11434" && url.pathname === "/api/ps") {
                return Response.json({ models: [] });
            }
            throw new Error("Unexpected network request in the offline compaction fixture");
        }));
    });

    afterEach(() => vi.unstubAllGlobals());

    it("ReservedRefusalError is exported and identifiable by type", () => {
        // The check must not be a regex over the message — a reworded error
        // would silently reopen the hole.
        const err = new ReservedRefusalError("RESERVED", [{ tier: "layer1", reason: "layer1_reserved" }]);
        expect(err).toBeInstanceOf(ReservedRefusalError);
        expect(err).toBeInstanceOf(Error);
        expect(err.refusal_reason).toBe("layer1_reserved");
    });

    it.each([
        { count: 1, cloud: false },
        { count: 1, cloud: true },
        { count: 11, cloud: false },
    ])("stops compaction for $count entries when the backstop refuses (plan cloud $cloud)", async ({ count, cloud }) => {
        vi.mocked(getEntitlements).mockResolvedValue({
            ...FREE_ENTITLEMENTS,
            features: { ...FREE_ENTITLEMENTS.features, cloud_fallback: cloud },
        });
        await expect(compactFixture(count)).rejects.toThrow(/keyword backstop/);
        expectNoFallbackOrWrites();
        expect(keywordBackstop).toHaveBeenCalledOnce();
        expect(appendInferMetric).toHaveBeenCalledOnce();
        expect(appendInferMetric).toHaveBeenCalledWith(expect.objectContaining({
            gate_outcome: "refused",
            refusal_reason: "keyword_backstop_reserved",
        }));
    });

    it("keeps semantic safety and host authorization refusals out of compaction fallback", async () => {
        vi.mocked(callLayer1).mockResolvedValueOnce("OBVIOUS_RESERVED");
        await expect(compactFixture()).rejects.toBeInstanceOf(ReservedRefusalError);
        expectNoFallbackOrWrites();

        const refusal = new HostAuthorizationError("host_authorization_required");
        vi.mocked(consumeHostExecution).mockImplementationOnce(() => { throw refusal; });
        await expect(compactFixture()).rejects.toBe(refusal);
        expectNoFallbackOrWrites();
    });

    it("propagates an unclassified failure before compaction fallback", async () => {
        const failure = new Error("Fixture could not resolve inference settings");
        vi.mocked(getEntitlements).mockRejectedValueOnce(failure);
        await expect(compactFixture()).rejects.toBe(failure);
        expectNoFallbackOrWrites();
    });

    it("uses the configured fallback after confirmed local unavailability", async () => {
        installed = [];
        vi.mocked(callLayer1).mockResolvedValue("OBVIOUS_NOT_RESERVED");
        const result = await compactFixture();
        expect(result.isError).toBe(false);
        expect(generateText).toHaveBeenCalledOnce();
        expect(storage.saveLedger).toHaveBeenCalledOnce();
        expect(storage.patchLedger).toHaveBeenCalledOnce();
    });

    it("compaction routes local summaries through inferText", async () => {
        const { readFileSync } = await import("node:fs");
        const src = readFileSync(
            fileURLToPath(new URL("../../src/tools/compactionHandler.ts", import.meta.url)),
            "utf8",
        );
        expect(src).toMatch(/const localResponse = await inferText/);
        expect(src, "compaction reintroduced a direct local-LLM call")
            .not.toMatch(/callLocalLlm/);
    });
});
