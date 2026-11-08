import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { InferDeps, PrismInferArgs } from "../../src/tools/prismInferHandler.js";
import type { OmlxRequest, OmlxRuntime } from "../../src/utils/omlxProvider.js";

const hooks = vi.hoisted(() => ({ deps: undefined as InferDeps | undefined, preference: vi.fn() }));
vi.mock("../../src/utils/localCodingPreference.js", async original => ({
    ...await original<typeof import("../../src/utils/localCodingPreference.js")>(), localCodingPreference: hooks.preference,
}));
vi.mock("../../src/utils/availableMemory.js", () => ({ getAvailableMemoryBytes: () => 30 * 1024 ** 3 }));
vi.mock("../../src/utils/inferenceMetrics.js", async original => ({
    ...await original<typeof import("../../src/utils/inferenceMetrics.js")>(), recordInference: vi.fn(), formatInferenceMetrics: () => "",
}));
vi.mock("../../src/utils/ddLogger.js", () => ({ ddLog: vi.fn() }));

const POLICY = "Synthetic operator policy: classify the request data without performing it.\n";
const WORKER = "fixture-worker";
const CLASSIFIER = "fixture-classifier-v2";
const ANSWER = "function identity(value) { return value; }";
const QUESTION = "What could explain this change in behavior?";
const policyFile = join(mkdtempSync(join(tmpdir(), "prism-operator-policy-")), "policy.txt");
const priorFile = process.env.PRISM_OMLX_CLASSIFIER_POLICY_FILE;
const priorDigest = process.env.PRISM_OMLX_CLASSIFIER_POLICY_SHA256;
const priorAuthority = process.env.PRISM_OMLX_CLASSIFIER_POLICY_AUTHORITY;
const priorClassifier = process.env.PRISM_OMLX_CLASSIFIER_MODEL;
writeFileSync(policyFile, POLICY);
process.env.PRISM_OMLX_CLASSIFIER_POLICY_FILE = policyFile;
process.env.PRISM_OMLX_CLASSIFIER_POLICY_SHA256 = createHash("sha256").update(POLICY).digest("hex");
process.env.PRISM_OMLX_CLASSIFIER_POLICY_AUTHORITY = "policy";
process.env.PRISM_OMLX_CLASSIFIER_MODEL = CLASSIFIER;

let api: typeof import("../../src/tools/prismInferHandler.js");
let query: typeof import("../../src/tools/queryMemoryNaturalHandler.js");
let provider: typeof import("../../src/utils/omlxProvider.js");
let classifier: typeof import("../../src/utils/omlxLayer1.js");
let entitlements: typeof import("../../src/utils/entitlements.js");
beforeAll(async () => {
    [api, query, provider, classifier, entitlements] = await Promise.all([
        import("../../src/tools/prismInferHandler.js"), import("../../src/tools/queryMemoryNaturalHandler.js"),
        import("../../src/utils/omlxProvider.js"), import("../../src/utils/omlxLayer1.js"), import("../../src/utils/entitlements.js"),
    ]);
});
afterAll(() => {
    if (priorFile === undefined) delete process.env.PRISM_OMLX_CLASSIFIER_POLICY_FILE; else process.env.PRISM_OMLX_CLASSIFIER_POLICY_FILE = priorFile;
    if (priorDigest === undefined) delete process.env.PRISM_OMLX_CLASSIFIER_POLICY_SHA256; else process.env.PRISM_OMLX_CLASSIFIER_POLICY_SHA256 = priorDigest;
    if (priorAuthority === undefined) delete process.env.PRISM_OMLX_CLASSIFIER_POLICY_AUTHORITY; else process.env.PRISM_OMLX_CLASSIFIER_POLICY_AUTHORITY = priorAuthority;
    if (priorClassifier === undefined) delete process.env.PRISM_OMLX_CLASSIFIER_MODEL; else process.env.PRISM_OMLX_CLASSIFIER_MODEL = priorClassifier;
});
beforeEach(() => {
    vi.restoreAllMocks(); writeFileSync(policyFile, POLICY);
    api._resetLayer1HistoryCacheForTest();
    hooks.preference.mockResolvedValue({ saved: "omlx", effective: "omlx", configured: true, envOverride: null, models: { omlx: { coder: WORKER } } });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
});

function fixture(rawLabel: string | readonly string[] = "OBVIOUS_NOT_RESERVED", doneReason: string | undefined = "stop") {
    const classifications: OmlxRequest[] = [], answers: OmlxRequest[] = [];
    const release = vi.fn(async () => {});
    const runtime: OmlxRuntime = {
        detect: vi.fn(async model => provider.createOmlxTarget("http://127.0.0.1:8000/v1", model ?? WORKER, 32768, "fixture-key")),
        acquire: vi.fn(async () => release), listLoaded: vi.fn(async () => new Set<string>()),
        generate: vi.fn(async (target, request) => {
            if (target.model === CLASSIFIER) {
                classifications.push(request);
                const text = typeof rawLabel === "string" ? rawLabel : rawLabel[Math.min(classifications.length - 1, rawLabel.length - 1)]!;
                return { ok: true, text, doneReason };
            }
            answers.push(request); return { ok: true, text: ANSWER, doneReason: "stop" };
        }),
    };
    const entitled = { ...entitlements.FREE_ENTITLEMENTS, source: "portal" as const, plan: "standard" as const, model_ceiling: "27b" as const,
        multi_turn: { enabled: true, max_turns: 12, max_chars: 32000 },
        features: { ...entitlements.FREE_ENTITLEMENTS.features, cloud_fallback: false, knowledge_search_unlimited: true } };
    const deps: InferDeps = { omlx: runtime, entitlements: entitled, freemem: () => 30 * 1024 ** 3,
        listTags: vi.fn(async () => new Set<string>()), listLoaded: vi.fn(async () => new Set<string>()),
        ollamaUrl: "http://127.0.0.1:11434", codingPreference: hooks.preference,
        callLocal: vi.fn(async () => { throw Error("unexpected alternate provider"); }),
        callCloud: vi.fn(async () => { throw Error("unexpected cloud inference"); }),
        probeNumCtx: async () => 32768, classifierInputPolicy: vi.fn(async () => null),
        secondReadPolicy: async () => null, answerCheckPolicy: async () => null };
    hooks.deps = deps;
    vi.spyOn(api, "productionInferDeps").mockReturnValue(deps);
    return { deps, entitled, classifications, answers, runtime, release };
}
const ask = (overrides: Partial<PrismInferArgs> = {}): PrismInferArgs => ({ prompt: "Draft a Python identity helper.", mode: "code",
    local_backend: "omlx", local_model: WORKER, cloud_fallback: false, escalation: "report", verify: false, ...overrides });

describe("real text entrypoints use the operator-owned policy", () => {
    it("uses the separately selected classifier while preserving the writer model", async () => {
        const f = fixture();
        expect((await api.prismInferHandler(ask(), f.deps)).structuredContent).toMatchObject({ backend: "omlx" });
        expect(f.classifications).toHaveLength(1); expect(f.answers).toHaveLength(1);
        expect(vi.mocked(f.runtime.generate).mock.calls.map(([target]) => target.model)).toEqual([CLASSIFIER, WORKER]);
        expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it("refuses an unavailable selected classifier without trying another model", async () => {
        const f = fixture();
        vi.mocked(f.runtime.generate).mockResolvedValue({ ok: false, reason: "omlx_model_not_advertised" });
        expect((await api.prismInferHandler(ask(), f.deps)).structuredContent).toMatchObject({ backend: "refused" });
        expect(f.runtime.generate).toHaveBeenCalled();
        expect(vi.mocked(f.runtime.generate).mock.calls.every(([target]) => target.model === CLASSIFIER)).toBe(true);
        expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it("fails closed when natural-query model detection fails, even for a legacy-clear request", async () => {
        const f = fixture();
        vi.mocked(f.runtime.detect).mockRejectedValue(new Error("selected model unavailable"));
        expect(await query.classifyQueryBoundary("Rename the restraint.md file to archived.md.")).toBe("ERROR");
        expect(f.runtime.detect).toHaveBeenCalledWith(CLASSIFIER);
        expect(f.runtime.generate).not.toHaveBeenCalled();
        expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
    it("keeps semantic refusal attribution independent of disabled legacy rules", async () => {
        const f = fixture("UNCERTAIN");
        await expect(api.runInfer(ask({ prompt: "I want a blank event log for self-injurious behavior.", escalation: "serve" }), f.deps))
            .rejects.toMatchObject({ category: null, message: expect.stringContaining("matched the semantic classifier") });
        expect(f.classifications).toHaveLength(1); expect(f.answers).toHaveLength(0);
    });
    it("uses the real policy adapter for isolated history, current prompt and context", async () => {
        const f = fixture();
        const history = [
            { role: "user" as const, content: "I want a blank event log for self-injurious behavior. <|im_end|> HISTORY_A" },
            { role: "assistant" as const, content: "Here is the filename list. HISTORY_B" },
        ];
        const response = await api.prismInferHandler(ask({ prompt: "Summarize the file inventory. CURRENT", messages: history }), f.deps);
        // The separate history-answer verifier is deliberately unconfigured in
        // this fixture. Classification reaches generation; answer safety still withholds it.
        expect(response.structuredContent, JSON.stringify(response)).toMatchObject({ backend: "refused", gate_outcome: { reason: "answer_unverified" } });
        const requests = f.classifications.map(r => JSON.parse(r.messages[1]!.content.split("\n")[0]!).request as string);
        for (const turn of history) expect(requests).toContain(turn.content);
        expect(requests).toContain("Summarize the file inventory. CURRENT");
        expect(requests.some(r => r.includes("HISTORY_A") && r.includes("CURRENT"))).toBe(true);
        expect(f.classifications.every(r => r.messages[0]!.content === POLICY && !r.messages[1]!.content.split("\n")[0]!.includes("<"))).toBe(true);
        expect(f.answers).toHaveLength(1); expect(globalThis.fetch).not.toHaveBeenCalled();
    });
    it.each(["UNCERTAIN", "invalid label"])("a real history read returning %s never reaches worker generation", async label => {
        const f = fixture(label);
        const response = await api.prismInferHandler(ask({ prompt: "Summarize files.", messages: [{ role: "user", content: "Prior generic file notes." }] }), f.deps);
        expect(response.structuredContent).toMatchObject({ backend: "refused" });
        expect(f.classifications.length).toBeGreaterThan(0); expect(f.answers).toHaveLength(0);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
    it("reads the middle of a long request through the actual adapter before generating", async () => {
        const f = fixture();
        const prompt = "start notes ".repeat(650) + " MIDDLE_MARKER I want a blank event log for self-injurious behavior. " + "end notes ".repeat(650);
        const response = await api.prismInferHandler(ask({ prompt }), f.deps);
        expect(response.structuredContent, JSON.stringify(response)).toMatchObject({ backend: "omlx" });
        const requests = f.classifications.map(r => JSON.parse(r.messages[1]!.content.split("\n")[0]!).request as string);
        expect(requests.length).toBeGreaterThan(1);
        expect(requests.some(r => r.includes("MIDDLE_MARKER"))).toBe(true);
        expect(requests.some(r => r.includes("start notes"))).toBe(true);
        expect(requests.some(r => r.includes("end notes"))).toBe(true);
        expect(f.answers).toHaveLength(1);
    });
    it("retains ownership until timed-out configured-policy generation has settled", async () => {
        const f = fixture();
        let settle!: (value: { ok: false; reason: "timeout" }) => void;
        vi.mocked(f.runtime.generate).mockImplementation(() => new Promise(resolve => { settle = resolve; }));
        const pending = classifier.classifyOmlxBoundary("Generic request to classify.", f.runtime, () => 30 * 1024 ** 3, Date.now() + 30);
        await vi.waitFor(() => expect(f.runtime.generate).toHaveBeenCalledOnce());
        await new Promise(resolve => setTimeout(resolve, 80));
        try { expect(f.release).not.toHaveBeenCalled(); }
        finally { settle({ ok: false, reason: "timeout" }); }
        expect(await pending).toBe("ERROR");
        expect(f.release).toHaveBeenCalledOnce(); expect(f.runtime.generate).toHaveBeenCalledOnce();
    });
    it("requires a real adapter verdict for a neutral request previously caught by the legacy floor", async () => {
        const prompt = "I want a blank event log for self-injurious behavior.";
        const { classifyDeterministicLayer1 } = await import("../../src/utils/layer1.js");
        expect(classifyDeterministicLayer1(prompt)).toBe("OBVIOUS_RESERVED");
        const f = fixture();
        const response = await api.prismInferHandler(ask({ prompt }), f.deps);
        expect(response.structuredContent).toMatchObject({ backend: "omlx", gate_outcome: { status: "success" } });
        expect(f.classifications).toHaveLength(1);
        expect(f.classifications[0]!.messages[0]!.content).toBe(POLICY);
        expect(f.answers).toHaveLength(1);
        expect(f.deps.classifierInputPolicy).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
    it("makes the actual natural-memory handler consult policy before the legacy veto", async () => {
        const f = fixture();
        const searchWeb = vi.fn(async () => []);
        const response = await query.queryMemoryNaturalHandler({ question: "I want a blank event log for self-injurious behavior.", web_fallback: true, synthesize: false }, {
            searchMemory: async () => ({ content: [], isError: false }), searchWeb, fetchPage: async () => "",
            classifyBoundary: query.classifyQueryBoundary, infer: args => api.prismInferHandler(args, f.deps), getEntitlements: async () => f.entitled,
        });
        expect(JSON.parse(response.content[0]!.text)).toMatchObject({ status: "no_results", retrieval: "web" });
        expect(f.classifications).toHaveLength(1); expect(searchWeb).toHaveBeenCalledOnce();
        expect(f.answers).toHaveLength(0); expect(globalThis.fetch).not.toHaveBeenCalled();
    });
    it("keeps crisis disclosures ahead of classification and web retrieval", async () => {
        const f = fixture(), searchWeb = vi.fn(async () => []);
        const response = await query.queryMemoryNaturalHandler({ question: "I want to hurt myself.", web_fallback: true }, {
            searchMemory: async () => ({ content: [], isError: false }), searchWeb, fetchPage: async () => "",
            classifyBoundary: query.classifyQueryBoundary, infer: args => api.prismInferHandler(args, f.deps), getEntitlements: async () => f.entitled,
        });
        expect(JSON.parse(response.content[0]!.text), response.content[0]!.text).toMatchObject({ boundary: "OBVIOUS_RESERVED", inference: { header: expect.stringContaining("backend=safety_gate") } });
        expect(f.classifications).toHaveLength(0); expect(searchWeb).not.toHaveBeenCalled();
        expect(f.deps.omlx!.detect).not.toHaveBeenCalled();
    });
    it("serves an ordinary local answer after the real classifier reads the pinned policy", async () => {
        const f = fixture();
        const result = await api.prismInferHandler(ask(), f.deps);
        expect(result.structuredContent, JSON.stringify({ result, reads: f.classifications.length, fetches: vi.mocked(globalThis.fetch).mock.calls.map(c => String(c[0])) })).toMatchObject({ backend: "omlx", model_picked: WORKER, gate_outcome: { status: "success" } });
        expect(result.content.some(block => block.text.includes(ANSWER))).toBe(true);
        expect(f.classifications.length).toBeGreaterThan(0);
        expect(f.classifications.every(r => r.messages[0]?.content === POLICY)).toBe(true);
        expect(f.answers).toHaveLength(1);
        expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
    it.each(["OBVIOUS_RESERVED", "UNCERTAIN", "invalid label"])("refuses %s in report and throwing contracts without an answer", async label => {
        const f = fixture(label);
        expect((await api.prismInferHandler(ask(), f.deps)).structuredContent).toMatchObject({ backend: "refused" });
        await expect(api.runInfer(ask({ escalation: undefined }), f.deps)).rejects.toThrow();
        expect(f.classifications.length).toBeGreaterThan(0); expect(f.answers).toEqual([]);
        expect(f.deps.callCloud).not.toHaveBeenCalled(); expect(f.deps.callLocal).not.toHaveBeenCalled();
    });
    it.each([
        ["OBVIOUS_NOT_RESERVED extra explanation", "stop"],
        ["obvious_not_reserved", "stop"],
        ["OBVIOUS_NOT_RESERVED", "length"],
    ])("never repairs or accepts an incomplete configured-policy label: %s / %s", async (label, finish) => {
        const f = fixture(label, finish);
        expect((await api.prismInferHandler(ask(), f.deps)).structuredContent).toMatchObject({ backend: "refused" });
        expect(f.classifications.length).toBeGreaterThan(0); expect(f.answers).toEqual([]);
        expect(f.deps.callCloud).not.toHaveBeenCalled(); expect(f.deps.callLocal).not.toHaveBeenCalled();
    });
    it("does not turn an invalid first classifier response into clearance with a retry", async () => {
        const f = fixture(["OBVIOUS_NOT_RESERVED with extra text", "OBVIOUS_NOT_RESERVED"]);
        expect((await api.prismInferHandler(ask(), f.deps)).structuredContent).toMatchObject({ backend: "refused" });
        expect(f.classifications).toHaveLength(1); expect(f.answers).toEqual([]);
        expect(f.deps.callCloud).not.toHaveBeenCalled(); expect(f.deps.callLocal).not.toHaveBeenCalled();
    });
    it("does not turn a rejected configured-policy read into clearance with a retry", async () => {
        const { callLayer1 } = await import("../../src/utils/layer1.js");
        const generate = vi.fn()
            .mockRejectedValueOnce(new Error("synthetic generator rejection"))
            .mockResolvedValue({ ok: true, text: "OBVIOUS_NOT_RESERVED", doneReason: "stop" });
        const adapter = classifier.omlxLayer1Fetch(generate);
        const verdict = await callLayer1("Return exactly READY.", "http://127.0.0.1:8000/v1",
            classifier.OMLX_LAYER1_MODEL, adapter, undefined, { deterministic: false, strictErrors: true, readOversizeWhole: true });
        expect(verdict).toBe("ERROR"); expect(generate).toHaveBeenCalledTimes(1);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
    it("makes the actual natural-memory handler invoke its production boundary adapter", async () => {
        const f = fixture(), infer = vi.fn(async () => { throw Error("unexpected answer"); });
        const result = await query.queryMemoryNaturalHandler({ question: QUESTION, web_fallback: true, synthesize: false }, {
            searchMemory: async () => ({ content: [], isError: false }), searchWeb: async () => [], fetchPage: async () => "",
            classifyBoundary: query.classifyQueryBoundary, infer, getEntitlements: async () => f.entitled,
        });
        expect(JSON.parse(result.content[0]!.text), JSON.stringify({ result, reads: f.classifications.length, fetches: vi.mocked(globalThis.fetch).mock.calls.map(c => String(c[0])) })).toMatchObject({ status: "no_results", retrieval: "web" });
        expect(f.classifications).toHaveLength(1); expect(f.classifications[0]!.messages[0]!.content).toBe(POLICY);
        expect(f.runtime.detect).toHaveBeenCalledWith(CLASSIFIER);
        expect(f.answers).toEqual([]); expect(infer).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
    });
    it("serves a natural-query local answer through the real inference pipeline with explicit verification", async () => {
        const f = fixture();
        f.entitled.features.grounding_verifier = true;
        f.deps.callVerifier = vi.fn(async ({ draft }) => ({ action: "PASS", finalText: draft, claims: [], verifierChain: [] }));
        const response = await query.queryMemoryNaturalHandler({ question: "Explain a Rust iterator's identity behavior.", web_fallback: true }, {
            searchMemory: async () => ({ content: [], isError: false }),
            searchWeb: async () => [{ type: "web", source: "fixture-source", title: "Synthetic iterator reference",
                url: "https://example.invalid/iterator", description: "Synthetic test evidence.", content: "Synthetic test evidence." }],
            fetchPage: async () => "The synthetic identity helper returns its argument unchanged.",
            classifyBoundary: query.classifyQueryBoundary,
            infer: args => api.prismInferHandler(args, f.deps), getEntitlements: async () => f.entitled,
        });
        expect(JSON.parse(response.content[0]!.text), response.content[0]!.text).toMatchObject({ status: "ok", answer: ANSWER });
        expect(f.classifications.length).toBeGreaterThanOrEqual(2);
        expect(f.classifications.every(r => r.messages[0]?.content === POLICY)).toBe(true);
        expect(f.answers).toHaveLength(1);
        expect(f.deps.callVerifier).toHaveBeenCalledTimes(1);
        expect(f.deps.callCloud).not.toHaveBeenCalled(); expect(f.deps.callLocal).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
    it.each(["OBVIOUS_RESERVED", "UNCERTAIN", "invalid label"])("natural-query %s never reaches web retrieval or local answer generation", async label => {
        const f = fixture(label), searchWeb = vi.fn(async () => []);
        const response = await query.queryMemoryNaturalHandler({ question: QUESTION, web_fallback: true }, {
            searchMemory: async () => ({ content: [], isError: false }), searchWeb, fetchPage: async () => "",
            classifyBoundary: query.classifyQueryBoundary,
            infer: args => api.prismInferHandler(args, f.deps), getEntitlements: async () => f.entitled,
        });
        expect(JSON.parse(response.content[0]!.text)).toMatchObject({ status: "refused", answer: "" });
        expect(f.classifications.length).toBeGreaterThan(0); expect(f.answers).toEqual([]);
        expect(searchWeb).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
        expect(f.deps.callLocal).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
    });
    it("rejects a changed pinned policy before either product entrypoint generates", async () => {
        const f = fixture(); writeFileSync(policyFile, "changed policy");
        expect((await api.prismInferHandler(ask(), f.deps)).structuredContent).toMatchObject({ backend: "refused" });
        expect(await query.classifyQueryBoundary(QUESTION)).toBe("ERROR");
        expect(f.classifications).toEqual([]); expect(f.answers).toEqual([]);
        expect(f.deps.callCloud).not.toHaveBeenCalled(); expect(f.deps.callLocal).not.toHaveBeenCalled();
    });
});
