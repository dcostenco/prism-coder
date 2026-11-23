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
vi.mock("../../src/utils/availableMemory.js", () => ({ getAvailableMemoryBytes: () => freeMemory }));
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
let freeMemory: number;
let respond: (path: string) => Response | undefined;

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
        freeMemory = 16 * 1024 ** 3;
        respond = () => undefined;
        vi.mocked(getEntitlements).mockResolvedValue(FREE_ENTITLEMENTS);
        vi.mocked(callLayer1).mockResolvedValue("ERROR");
        vi.mocked(keywordBackstop).mockReturnValue("OBVIOUS_RESERVED");
        generateText.mockResolvedValue(JSON.stringify({ summary: "Combined routine maintenance." }));
        storage.saveLedger.mockResolvedValue([{ id: "rollup-fixture" }]);
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
            const url = new URL(input);
            if (url.origin !== "http://127.0.0.1:11434") throw new Error("Unexpected provider origin");
            const override = respond(url.pathname);
            if (override) return override;
            if (url.pathname === "/api/tags") return Response.json({ models: installed.map(name => ({ name })) });
            if (url.pathname === "/api/ps") return Response.json({ models: [] });
            if (url.pathname === "/api/show") return Response.json({ parameters: "num_ctx 32768" });
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

    it.each([
        { label: "authorization required", path: "/api/tags", status: 401, body: "{}" },
        { label: "access forbidden", path: "/api/tags", status: 403, body: "{}" },
        { label: "service returned an ambiguous error", path: "/api/tags", status: 503, body: "{}" },
        { label: "partial inventory", path: "/api/tags", status: 206, body: '{"models":[]}' },
        { label: "malformed inventory", path: "/api/tags", status: 200, body: "invalid json" },
        { label: "missing model list", path: "/api/tags", status: 200, body: "{}" },
        { label: "blank model name", path: "/api/tags", status: 200, body: '{"models":[{"name":" "}]}' },
        { label: "inventory contains a provider error", path: "/api/tags", status: 200, body: '{"models":[],"error":"denied"}' },
        { label: "model ID with spaces", path: "/api/tags", status: 200, body: '{"models":[{"name":"fixture bad:latest"}]}' },
        { label: "duplicate catalog model IDs", path: "/api/tags", status: 200, body: '{"models":[{"name":"other:latest"},{"name":"other:latest"}]}' },
        { label: "loaded model lookup denied", path: "/api/ps", status: 403, body: "{}" },
        { label: "invalid loaded model ID", path: "/api/ps", status: 200, body: '{"models":[{"name":"other model"}]}' },
        { label: "duplicate loaded model IDs", path: "/api/ps", status: 200, body: '{"models":[{"name":"other:latest"},{"name":"other:latest"}]}' },
    ])("keeps $label out of fallback", async ({ path, status, body }) => {
        respond = route => route === path ? new Response(body, { status }) : undefined;
        await expect(compactFixture()).rejects.toThrow();
        expectNoFallbackOrWrites();
        expect(callLayer1).not.toHaveBeenCalled();
    });

    it("refuses an ambiguous inventory timeout", async () => {
        respond = path => {
            if (path === "/api/tags") throw new DOMException("Inventory timeout", "TimeoutError");
        };
        await expect(compactFixture()).rejects.toThrow();
        expectNoFallbackOrWrites();
    });

    it.each([
        { label: "mixed address failures", wrap: (refused: Error, timeout: Error) => new AggregateError([refused, timeout]) },
        { label: "an empty aggregate", wrap: () => new AggregateError([]) },
        { label: "a conflicting nested cause", wrap: (_refused: Error, timeout: Error) => new Error("Wrapped", { cause: timeout }) },
    ])("keeps $label out of closed-listener fallback", async ({ wrap }) => {
        vi.mocked(keywordBackstop).mockReturnValue("OBVIOUS_NOT_RESERVED");
        const refused = Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" });
        const timeout = Object.assign(new Error("Connection timed out"), { code: "ETIMEDOUT" });
        const cause = Object.assign(wrap(refused, timeout), { code: "ECONNREFUSED" });
        respond = path => {
            if (path === "/api/tags") throw new TypeError("Fetch failed", { cause });
        };
        await expect(compactFixture()).rejects.toThrow("Fetch failed");
        expectNoFallbackOrWrites();
        expect(callLayer1).not.toHaveBeenCalled();
    });

    it("honors the first authorization denial from the actual classifier", async () => {
        const actual = await vi.importActual<typeof import("../../src/utils/layer1.js")>("../../src/utils/layer1.js");
        vi.mocked(callLayer1).mockImplementation(actual.callLayer1);
        vi.mocked(keywordBackstop).mockReturnValue("OBVIOUS_NOT_RESERVED");
        let requests = 0;
        respond = path => {
            if (path !== "/api/chat") return;
            requests++;
            return requests === 1 ? new Response("{}", { status: 403 })
                : Response.json({ message: { content: "OBVIOUS_NOT_RESERVED" }, done: true });
        };
        await expect(compactFixture()).rejects.toThrow(/classification could not be confirmed/);
        expect(requests).toBe(1);
        expectNoFallbackOrWrites();
    });

    it.each(["denial", "malformed reply", "abort"])("stops on local generation %s", async failure => {
        vi.mocked(callLayer1).mockResolvedValue("OBVIOUS_NOT_RESERVED");
        let requests = 0;
        respond = path => {
            if (path !== "/api/chat") return;
            requests++;
            if (failure === "abort") throw new DOMException("Fixture cancelled", "AbortError");
            return failure === "denial" ? new Response("{}", { status: 401 }) : new Response("invalid json");
        };
        await expect(compactFixture()).rejects.toThrow(/local generation did not complete/);
        expect(requests).toBe(1);
        expectNoFallbackOrWrites();
    });

    describe.each(["classifier", "generator"])("protected %s response", phase => {
        it.each([
            { label: "unfinished", status: 200, envelope: { done: false } },
            { label: "missing completion", status: 200, envelope: {} },
            { label: "nonboolean completion", status: 200, envelope: { done: "true" } },
            { label: "truncated", status: 200, envelope: { done: true, done_reason: "length" } },
            { label: "partial HTTP response", status: 206, envelope: { done: true } },
            { label: "explicit provider error", status: 200, envelope: { done: true, error: "" } },
            { label: "nontext content", status: 200, envelope: { done: true, message: { content: 7 } } },
        ])("refuses $label before fallback or ledger writes", async ({ status, envelope }) => {
            const actual = await vi.importActual<typeof import("../../src/utils/layer1.js")>("../../src/utils/layer1.js");
            vi.mocked(callLayer1).mockImplementation(actual.callLayer1);
            vi.mocked(keywordBackstop).mockReturnValue("OBVIOUS_NOT_RESERVED");
            if (phase === "classifier") freeMemory = 0;
            const classification = phase === "classifier";
            const validText = classification ? "OBVIOUS_NOT_RESERVED" : JSON.stringify({ summary: "Routine maintenance summary." });
            let requests = 0;
            respond = path => {
                if (path !== "/api/chat") return;
                requests++;
                if (!classification && requests === 1) {
                    return Response.json({ done: true, done_reason: "stop", message: { content: "OBVIOUS_NOT_RESERVED" } });
                }
                return Response.json({ message: { content: validText }, ...envelope }, { status });
            };
            const failure = classification ? /classification could not be confirmed/ : /local generation did not complete/;
            await expect(compactFixture()).rejects.toThrow(failure);
            expect(requests).toBe(classification ? 1 : 2);
            expectNoFallbackOrWrites();
        });
    });

    it.each([1, 2])("keeps originals if classification refuses after %s locally summarized chunks", async successfulChunks => {
        vi.mocked(callLayer1).mockResolvedValue("ERROR");
        vi.mocked(keywordBackstop).mockReturnValue("OBVIOUS_NOT_RESERVED");
        for (let i = 0; i < successfulChunks; i++) vi.mocked(callLayer1).mockResolvedValueOnce("OBVIOUS_NOT_RESERVED");
        let localOutputs = 0;
        respond = path => {
            if (path !== "/api/chat") return;
            localOutputs++;
            return Response.json({ message: { content: JSON.stringify({ summary: "Summarized routine maintenance." }) }, done: true });
        };
        await expect(compactFixture(11)).rejects.toThrow(/classification could not be confirmed/);
        expect(callLayer1).toHaveBeenCalledTimes(successfulChunks + 1);
        expect(localOutputs).toBe(successfulChunks);
        expectNoFallbackOrWrites();
    });

    it.each(["empty inventory", "unrelated model", "closed listener", "all addresses refused", "insufficient RAM"])(
        "uses the configured fallback after confirmed local unavailability from %s", async evidence => {
        vi.mocked(keywordBackstop).mockReturnValue("OBVIOUS_NOT_RESERVED");
        vi.mocked(callLayer1).mockResolvedValue("OBVIOUS_NOT_RESERVED");
        if (evidence === "empty inventory") installed = [];
        if (evidence === "unrelated model") installed = ["fixture-other:latest"];
        if (evidence === "closed listener" || evidence === "all addresses refused") respond = path => {
            if (path === "/api/tags") {
                const refused = Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" });
                const cause = evidence === "closed listener" ? refused : new AggregateError([refused, refused]);
                throw new TypeError("Fetch failed", { cause });
            }
        };
        if (evidence === "insufficient RAM") freeMemory = 0;
        const result = await compactFixture();
        expect(result.isError).toBe(false);
        expect(generateText).toHaveBeenCalledOnce();
        expect(storage.saveLedger).toHaveBeenCalledOnce();
        expect(storage.patchLedger).toHaveBeenCalledOnce();
    });

    it("uses the keyword floor when verified inventory lacks a classifier", async () => {
        installed = [];
        await expect(compactFixture()).rejects.toThrow(/keyword backstop/);
        expect(callLayer1).not.toHaveBeenCalled();
        expectNoFallbackOrWrites();
    });

    it("uses a model warmed by classification before considering cloud fallback", async () => {
        freeMemory = 0;
        let warmed = false;
        let localResponses = 0;
        vi.mocked(callLayer1).mockImplementationOnce(async () => {
            warmed = true;
            return "OBVIOUS_NOT_RESERVED";
        });
        respond = path => {
            if (path === "/api/ps") return Response.json({ models: warmed ? [{ name: "prism-coder:4b" }] : [] });
            if (path === "/api/chat") {
                localResponses++;
                return Response.json({ message: { content: JSON.stringify({ summary: "Summarized routine maintenance." }) }, done: true });
            }
        };
        const result = await compactFixture();
        expect(result.isError).toBe(false);
        expect(localResponses).toBe(1);
        expect(generateText).not.toHaveBeenCalled();
        expect(storage.saveLedger).toHaveBeenCalledOnce();
    });

    it("writes a local rollup after complete classifier and generator replies", async () => {
        const actual = await vi.importActual<typeof import("../../src/utils/layer1.js")>("../../src/utils/layer1.js");
        vi.mocked(callLayer1).mockImplementation(actual.callLayer1);
        const summary = "Summarized routine maintenance.";
        let requests = 0;
        respond = path => {
            if (path !== "/api/chat") return;
            const content = ++requests === 1 ? "OBVIOUS_NOT_RESERVED" : JSON.stringify({ summary });
            return Response.json({ done: true, done_reason: "stop", message: { content } });
        };
        expect((await compactFixture()).isError).toBe(false);
        expect(requests).toBe(2);
        expect(generateText).not.toHaveBeenCalled();
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
