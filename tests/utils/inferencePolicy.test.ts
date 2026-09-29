/**
 * The second-read exclusion policy: served by Synalux, pinned by hash, held in
 * memory. Anything but the pinned, well-formed artifact is no policy (the
 * second read then does not run). A synthetic artifact stands in for the real
 * one, which is not public.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { createHash } from "crypto";

const { PORTAL, mockGetSynaluxJwt, mockInvalidateSynaluxJwt } = vi.hoisted(() => ({
    PORTAL: "https://portal.test",
    mockGetSynaluxJwt: vi.fn<() => Promise<string | null>>(),
    mockInvalidateSynaluxJwt: vi.fn(),
}));
vi.mock("../../src/config.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/config.js")>();
    return { ...actual, PRISM_SYNALUX_BASE_URL: PORTAL, SYNALUX_CONFIGURED: true };
});
vi.mock("../../src/utils/synaluxJwt.js", () => ({ getSynaluxJwt: mockGetSynaluxJwt, invalidateSynaluxJwt: mockInvalidateSynaluxJwt }));

import { parseSecondReadPolicy, getSecondReadPolicy, parseAnswerCheckPolicy, getAnswerCheckPolicy, parseClassifierInputPolicy, getClassifierInputPolicy, _resetSecondReadPolicyForTest, clearInferencePolicies, hasNestedRepetition, SECOND_READ_POLICY_SHA256, ANSWER_CHECK_POLICY_SHA256, CLASSIFIER_INPUT_POLICY_SHA256 } from "../../src/utils/inferencePolicy.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ARTIFACT = JSON.parse(readFileSync(new URL("../fixtures/second-read-policy.synthetic.json", import.meta.url), "utf8"));
const BYTES = JSON.stringify(ARTIFACT);
const SHA = sha(BYTES);
/** The artifact with one change, and bytes and hash that match the change. */
const variant = (edit: (a: typeof ARTIFACT) => void) => {
    const a = JSON.parse(BYTES); edit(a);
    const b = JSON.stringify(a);
    return { b, h: sha(b) };
};

describe("parseSecondReadPolicy", () => {
    it("compiles exactly the pinned artifact, with the flags the client sets", () => {
        const p = parseSecondReadPolicy(BYTES, SHA)!;
        expect(p).not.toBeNull();
        expect(p.operational.flags).toBe("i");
        expect(p.classifierLabels.flags).toBe("");
        expect(p.deployScriptNoun.flags).toBe("gi");
        expect(p.operational.test("WHERE IS THE VAULT")).toBe(true);
        expect(p.classifierLabels.test("obvious_reserved")).toBe(false);
    });
    it("another hash is no policy: one changed byte, or a well-formed artifact that is not the pinned one", () => {
        expect(parseSecondReadPolicy(BYTES.replace("vault", "vaulx"), SHA)).toBeNull();
        expect(parseSecondReadPolicy(BYTES, SECOND_READ_POLICY_SHA256)).toBeNull();
    });
    it("a wrong schema or evaluator, a list below its floor, a missing, oversized or uncompilable pattern is no policy", () => {
        for (const [name, edit] of [
            ["schema", (a: typeof ARTIFACT) => { a.schema = 2; }],
            ["evaluator", (a: typeof ARTIFACT) => { a.evaluator = "second-read-exclusion/2"; }],
            ["few terms", (a: typeof ARTIFACT) => { a.second_read.operational_terms = a.second_read.operational_terms.slice(0, 7); }],
            ["empty list", (a: typeof ARTIFACT) => { a.second_read.operational_terms = []; }],
            ["one decision", (a: typeof ARTIFACT) => { a.second_read.deploy_decision = ["\\bnow\\b"]; }],
            ["empty pattern", (a: typeof ARTIFACT) => { a.second_read.operational_terms[0] = ""; }],
            ["missing field", (a: typeof ARTIFACT) => { delete a.second_read.classifier_directed; }],
            ["oversize pattern", (a: typeof ARTIFACT) => { a.second_read.deploy_term = "x".repeat(1_025); }],
            ["not a string", (a: typeof ARTIFACT) => { a.second_read.operational_terms[0] = 7; }],
            ["uncompilable", (a: typeof ARTIFACT) => { a.second_read.classifier_directed = "(unclosed"; }],
        ] as const) {
            const { b, h } = variant(edit as (a: typeof ARTIFACT) => void);
            expect(parseSecondReadPolicy(b, h), name).toBeNull();
        }
        const huge = JSON.stringify({ ...ARTIFACT, pad: "x".repeat(70_000) });
        expect(parseSecondReadPolicy(huge, sha(huge))).toBeNull();
        expect(parseSecondReadPolicy("not json", sha("not json"))).toBeNull();
    });
});

describe("getSecondReadPolicy", () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        vi.clearAllMocks();
        _resetSecondReadPolicyForTest();
        mockGetSynaluxJwt.mockResolvedValue("jwt-current");
        fetchMock = vi.fn(async () => new Response(BYTES, { status: 200 }));
    });
    const load = (extra: Record<string, unknown> = {}) =>
        getSecondReadPolicy({ fetchImpl: fetchMock as unknown as typeof fetch, expectSha256: SHA, ...extra });

    it("GETs the pinned artifact by its hash with bearer auth and no redirects, and compiles it", async () => {
        const p = await load();
        expect(p?.operational.test("the control room")).toBe(true);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${PORTAL}/api/v1/prism/inference-policy/${SHA}`);
        expect(init).toMatchObject({ method: "GET", redirect: "error" });
        expect(init.headers).toMatchObject({ Authorization: "Bearer jwt-current" });
    });
    it("loads once per process; concurrent callers share the one request", async () => {
        const [a, b] = await Promise.all([load(), load()]);
        expect(a).toBe(b);
        expect(await load()).toBe(a);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it("the real pin is what an unconfigured call fetches", async () => {
        await getSecondReadPolicy({ fetchImpl: fetchMock as unknown as typeof fetch });
        expect(String(fetchMock.mock.calls[0][0])).toBe(`${PORTAL}/api/v1/prism/inference-policy/${SECOND_READ_POLICY_SHA256}`);
    });
    it("bytes that are not the pinned artifact are no policy", async () => {
        fetchMock.mockResolvedValueOnce(new Response(BYTES.replace("vault", "vaulx"), { status: 200 }));
        expect(await load()).toBeNull();
    });
    it("a denial or failure is no policy, and the next try waits instead of hammering the portal", async () => {
        for (const status of [403, 404, 500]) {
            _resetSecondReadPolicyForTest();
            fetchMock.mockReset();
            fetchMock.mockResolvedValue(new Response("{}", { status }));
            expect(await load(), String(status)).toBeNull();
            expect(await load(), String(status)).toBeNull();
            expect(fetchMock, String(status)).toHaveBeenCalledTimes(1);
        }
        _resetSecondReadPolicyForTest();
        fetchMock.mockReset();
        fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
        expect(await load()).toBeNull();
    });
    it("a 401 is retried once with a fresh token", async () => {
        mockGetSynaluxJwt.mockResolvedValueOnce("jwt-stale").mockResolvedValueOnce("jwt-fresh");
        fetchMock.mockResolvedValueOnce(new Response("", { status: 401 })).mockResolvedValueOnce(new Response(BYTES, { status: 200 }));
        expect(await load()).not.toBeNull();
        expect(mockInvalidateSynaluxJwt).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it("no token, no request; a token that never arrives ends at the deadline", async () => {
        mockGetSynaluxJwt.mockResolvedValue(null);
        expect(await load()).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
        _resetSecondReadPolicyForTest();
        mockGetSynaluxJwt.mockReturnValue(new Promise(() => { /* never */ }));
        const t0 = Date.now();
        expect(await load({ deadlineMs: 50 })).toBeNull();
        expect(Date.now() - t0).toBeLessThan(1_000);
    });
    it("an oversized reply is not read", async () => {
        fetchMock.mockResolvedValueOnce(new Response(BYTES, { status: 200, headers: { "content-length": "999999" } }));
        expect(await load()).toBeNull();
    });
    it("the pin covers the bytes as received: a byte-order mark in front is another artifact, even though decoding would drop it", async () => {
        const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(BYTES, "utf8")]);
        fetchMock.mockResolvedValueOnce(new Response(withBom, { status: 200 }));
        expect(await load()).toBeNull();
        // the same bytes without it load
        _resetSecondReadPolicyForTest();
        fetchMock.mockResolvedValueOnce(new Response(Buffer.from(BYTES, "utf8"), { status: 200 }));
        expect(await load()).not.toBeNull();
    });
});

describe("parseAnswerCheckPolicy", () => {
    const ACBYTES = JSON.stringify(JSON.parse(readFileSync(new URL("../fixtures/answer-check-policy.synthetic.json", import.meta.url), "utf8")));
    const ACSHA = sha(ACBYTES);
    const acVariant = (edit: (a: { schema: unknown; evaluator: unknown; answer_check: Record<string, any> }) => void) => {
        const a = JSON.parse(ACBYTES); edit(a);
        const b = JSON.stringify(a);
        return { b, h: sha(b) };
    };
    it("compiles exactly the pinned artifact: texts, correction template, arithmetic fragments and scale list", () => {
        const p = parseAnswerCheckPolicy(ACBYTES, ACSHA)!;
        expect(p).not.toBeNull();
        expect(p.systemPrompt).toMatch(/^SYNTHETIC CHECK RULES/);
        expect(p.correction.line).toContain("{expression}");
        expect(p.arithmetic.quoted).toBeInstanceOf(RegExp);
        expect(p.arithmetic.scalePowers).toEqual([-2, -1, 1, 2]);
    });
    it("another hash is no policy: one changed byte, the second-read artifact, or a well-formed artifact that is not the pinned one", () => {
        expect(parseAnswerCheckPolicy(ACBYTES.replace("SYNTHETIC", "SYNTHETIX"), ACSHA)).toBeNull();
        expect(parseAnswerCheckPolicy(BYTES, SHA)).toBeNull();
        expect(parseAnswerCheckPolicy(ACBYTES)).toBeNull();   // the real pin is not this fixture
    });
    it("a wrong schema or evaluator, a missing or oversized text, a template without its slots, a capturing, back-referencing or uncompilable fragment, or a bad scale list is no policy", () => {
        for (const [name, edit] of [
            ["schema", a => { a.schema = 2; }],
            ["evaluator", a => { a.evaluator = "answer-check/2"; }],
            ["no system prompt", a => { delete a.answer_check.system_prompt; }],
            ["blank reminder", a => { a.answer_check.reminder = "  "; }],
            ["oversize prompt", a => { a.answer_check.system_prompt = "x".repeat(16_385); }],
            ["slot missing", a => { a.answer_check.correction.line = "{expression} is {correct}"; }],
            ["empty join", a => { a.answer_check.correction.join = ""; }],
            ["capturing group", a => { a.answer_check.arithmetic.number = "(\\d+)"; }],
            ["named group", a => { a.answer_check.arithmetic.end = "(?<x>\\s)"; }],
            ["back-reference", a => { a.answer_check.arithmetic.end = "(?!\\1)"; }],
            ["uncompilable", a => { a.answer_check.arithmetic.start = "(?<!"; }],
            // a trailing backslash would escape the reader's own closing parenthesis
            ["trailing backslash", a => { a.answer_check.arithmetic.number = "\\d+\\"; }],
            ["no scale", a => { a.answer_check.arithmetic.scale_powers = []; }],
            ["zero power", a => { a.answer_check.arithmetic.scale_powers = [0]; }],
            ["huge power", a => { a.answer_check.arithmetic.scale_powers = [13]; }],
            ["fractional power", a => { a.answer_check.arithmetic.scale_powers = [1.5]; }],
            ["no arithmetic", a => { delete a.answer_check.arithmetic; }],
        ] as Array<[string, Parameters<typeof acVariant>[0]]>) {
            const { b, h } = acVariant(edit);
            expect(parseAnswerCheckPolicy(b, h), name).toBeNull();
        }
    });
    it("is fetched like the second-read policy: its own pin, memory only, one request per process", async () => {
        _resetSecondReadPolicyForTest();
        mockGetSynaluxJwt.mockResolvedValue("jwt-current");
        const fetchMock = vi.fn(async () => new Response(ACBYTES, { status: 200 }));
        const load = () => getAnswerCheckPolicy({ fetchImpl: fetchMock as unknown as typeof fetch, expectSha256: ACSHA });
        const [a, b] = await Promise.all([load(), load()]);
        expect(a).not.toBeNull();
        expect(a).toBe(b);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`${PORTAL}/api/v1/prism/inference-policy/${ACSHA}`);
        _resetSecondReadPolicyForTest();
        fetchMock.mockClear();
        await getAnswerCheckPolicy({ fetchImpl: fetchMock as unknown as typeof fetch });
        expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`${PORTAL}/api/v1/prism/inference-policy/${ANSWER_CHECK_POLICY_SHA256}`);
    });
});

describe("backtracking guard: a match cannot be interrupted once it starts, so these shapes are refused before compiling", () => {
    it("refuses a group repeated without bound (or more than 3 times) whose body varies in width or offers alternatives", () => {
        for (const p of ["(a+)+$", "(?:a+)+$", "(a|aa)+", "(\\w+\\s?)*", "(.*a){20}", "((a+))+", "((a|aa))+", "(a*)*b", "(?:x+x+)+y", "(a+){4}", "([a-z]+)*$", "(?<n>a+)+", "(a+){2,}",
            // bounded but variable-width bodies, and a class JavaScript closes at once (review 2026-09-27, measured exponential)
            "(?:a{1,4})+x", "(?:a{0,2})+$", "(?:aa?)+$", "[^](x+)+y"])
            expect(hasNestedRepetition(p), p).toBe(true);
    });
    it("allows fixed-width repeats, short bounded repeats, plain alternation, and look-arounds", () => {
        for (const p of ["(?:,\\d{3})+", "(?:\\d{2})+", "(?:ab){2}x", "(?:\\S+\\s+){0,3}", "\\d+(?:\\.\\d+)?", "\\b(?:alpha|beta)\\w*", "(?:ab)+", "[(a+)+]", "\\(a+\\)+",
            "[$]?\\d+(?:,\\d{3})*(?:\\.\\d+)?", "(?<![\\w.,$])(?<![+\\-−×*\\/÷]\\s*)", "(?![\\w.…]|\\s*[+\\-−×*\\/÷=]\\s*\\d)", "\\s*[+−]\\s*|\\s+-\\s+"])
            expect(hasNestedRepetition(p), p).toBe(false);
    });
    it("an unbalanced pattern is refused", () => {
        expect(hasNestedRepetition("(a")).toBe(true);
        expect(hasNestedRepetition("a)")).toBe(true);
    });
    it("a second-read artifact carrying one is no policy, and so is an oversized list", () => {
        for (const edit of [
            (a: typeof ARTIFACT) => { a.second_read.operational_terms.push("(a+)+$"); },
            (a: typeof ARTIFACT) => { a.second_read.deploy_decision.push("(?:x|xx)+y"); },
            (a: typeof ARTIFACT) => { a.second_read.classifier_directed = "(?:a+)+$"; },
            (a: typeof ARTIFACT) => { a.second_read.operational_terms.push("(?:a{1,4})+x"); },
            (a: typeof ARTIFACT) => { a.second_read.operational_terms.push("\\b(\\w)\\1+"); },
            (a: typeof ARTIFACT) => { a.second_read.operational_terms = Array.from({ length: 1001 }, (_v, i) => `term${i}`); },
        ]) {
            const { b, h } = variant(edit);
            expect(parseSecondReadPolicy(b, h)).toBeNull();
        }
        const ok = variant(a => { a.second_read.operational_terms.push("\\bcontrol\\s+(?:\\S+\\s+){0,3}room\\b"); });
        expect(parseSecondReadPolicy(ok.b, ok.h)).not.toBeNull();
    });
    it("an answer-check artifact carrying one is no policy; its separator must neither match nothing nor a digit, and a number must hold one", () => {
        const ACBYTES = JSON.stringify(JSON.parse(readFileSync(new URL("../fixtures/answer-check-policy.synthetic.json", import.meta.url), "utf8")));
        const acVariant = (edit: (a: { answer_check: Record<string, any> }) => void) => { const a = JSON.parse(ACBYTES); edit(a); const b = JSON.stringify(a); return { b, h: sha(b) }; };
        for (const edit of [
            (a: { answer_check: Record<string, any> }) => { a.answer_check.arithmetic.number = "(?:\\d+)+"; },
            (a: { answer_check: Record<string, any> }) => { a.answer_check.arithmetic.quoted = "\"(?:[^\"]+)*\""; },
            (a: { answer_check: Record<string, any> }) => { a.answer_check.arithmetic.minus_or_plus = "\\s*"; },
            (a: { answer_check: Record<string, any> }) => { a.answer_check.arithmetic.minus_or_plus = "\\s*[+0-9]\\s*"; },
            (a: { answer_check: Record<string, any> }) => { a.answer_check.arithmetic.number = "\\d*"; },
        ]) {
            const { b, h } = acVariant(edit);
            expect(parseAnswerCheckPolicy(b, h)).toBeNull();
        }
        expect(parseAnswerCheckPolicy(ACBYTES, sha(ACBYTES))).not.toBeNull();
    });
});

describe("clearInferencePolicies: a sign-out or an account change drops what the previous account loaded", () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        vi.clearAllMocks();
        _resetSecondReadPolicyForTest();
        mockGetSynaluxJwt.mockResolvedValue("jwt-current");
        fetchMock = vi.fn(async () => new Response(BYTES, { status: 200 }));
    });
    const load = () => getSecondReadPolicy({ fetchImpl: fetchMock as unknown as typeof fetch, expectSha256: SHA });
    it("the next use fetches again", async () => {
        expect(await load()).not.toBeNull();
        expect(await load()).not.toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        clearInferencePolicies();
        expect(await load()).not.toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it("a load still in flight when the account changes is not kept", async () => {
        let release!: () => void;
        fetchMock.mockImplementationOnce(() => new Promise<Response>(r => { release = () => r(new Response(BYTES, { status: 200 })); }));
        const pending = load();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        clearInferencePolicies();
        release();
        await pending;
        await load();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe("parseClassifierInputPolicy", () => {
    const CI = JSON.stringify(JSON.parse(readFileSync(new URL("../fixtures/classifier-input-policy.synthetic.json", import.meta.url), "utf8")));
    const CISHA = sha(CI);
    const civariant = (edit: (a: any) => void) => { const a = JSON.parse(CI); edit(a); const b = JSON.stringify(a); return { b, h: sha(b) }; };

    it("builds exactly the pinned artifact: the word set, groups, qualifiers, and the token pattern with no flags", () => {
        const p = parseClassifierInputPolicy(CI, CISHA)!;
        expect(p).not.toBeNull();
        expect([...p.dropWords]).toContain("lorem");
        expect(p.requireEach.map(g => [...g])).toEqual([["lorem", "sed"], ["dolor", "amet"]]);
        expect([...p.onlyAfter.get("elit")!]).toEqual(["amet"]);
        expect(p.onlyAfterPattern?.test("++x")).toBe(true);
        expect(p.onlyAfterPattern?.test("++")).toBe(false);
        expect([...p.keptNeedsOneOf]).toEqual(["write", "spec", "function"]);
        expect(p.alsoMatch?.flags).toBe("");
        expect(p.alsoMatch?.test("++abc")).toBe(true);
    });
    it("another hash is no policy", () => {
        expect(parseClassifierInputPolicy(CI.replace("lorem", "lorex"), CISHA)).toBeNull();
        expect(parseClassifierInputPolicy(CI, CLASSIFIER_INPUT_POLICY_SHA256)).toBeNull();
    });
    it("a wrong schema or evaluator, a short list, an entry that is not one lowercase word, a bad token pattern is no policy", () => {
        for (const [name, edit] of [
            ["schema", (a: any) => { a.schema = 2; }],
            ["evaluator", (a: any) => { a.evaluator = "classifier-input/2"; }],
            ["missing section", (a: any) => { delete a.classifier_input; }],
            ["few words", (a: any) => { a.classifier_input.drop_sentence_words = a.classifier_input.drop_sentence_words.slice(0, 7); }],
            ["not a list", (a: any) => { a.classifier_input.drop_sentence_words = "lorem"; }],
            ["uppercase", (a: any) => { a.classifier_input.drop_sentence_words[0] = "Lorem"; }],
            ["two words", (a: any) => { a.classifier_input.drop_sentence_words[0] = "lorem ipsum"; }],
            ["empty word", (a: any) => { a.classifier_input.drop_sentence_words[0] = ""; }],
            ["long word", (a: any) => { a.classifier_input.drop_sentence_words[0] = "x".repeat(41); }],
            ["not a string", (a: any) => { a.classifier_input.drop_sentence_words[0] = 7; }],
            ["no groups", (a: any) => { delete a.classifier_input.require_each; }],
            ["empty group list", (a: any) => { a.classifier_input.require_each = []; }],
            ["empty group", (a: any) => { a.classifier_input.require_each[0] = []; }],
            ["group word not listed", (a: any) => { a.classifier_input.require_each[0].push("vault"); }],
            ["five groups", (a: any) => { a.classifier_input.require_each = [["lorem"], ["lorem"], ["lorem"], ["lorem"], ["lorem"]]; }],
            ["qualifier not an object", (a: any) => { a.classifier_input.only_after = ["elit"]; }],
            ["qualified word not listed", (a: any) => { a.classifier_input.only_after = { vault: ["amet"] }; }],
            ["qualifier names an unlisted word", (a: any) => { a.classifier_input.only_after = { elit: ["vault"] }; }],
            ["empty qualifier", (a: any) => { a.classifier_input.only_after = { elit: [] }; }],
            ["no kept words", (a: any) => { delete a.classifier_input.kept_needs_one_of; }],
            ["empty kept words", (a: any) => { a.classifier_input.kept_needs_one_of = []; }],
            ["kept word not one word", (a: any) => { a.classifier_input.kept_needs_one_of = ["write it"]; }],
            ["bad qualifier pattern", (a: any) => { a.classifier_input.only_after_pattern = "^(#+)+$"; }],
            ["qualifier pattern not a string", (a: any) => { a.classifier_input.only_after_pattern = 7; }],
            ["empty pattern", (a: any) => { a.classifier_input.also_match = ""; }],
            ["pattern not a string", (a: any) => { a.classifier_input.also_match = 7; }],
            ["back-reference", (a: any) => { a.classifier_input.also_match = "^(#)\\1$"; }],
            ["nested repetition", (a: any) => { a.classifier_input.also_match = "^(#+)+$"; }],
            ["uncompilable", (a: any) => { a.classifier_input.also_match = "(unclosed"; }],
            ["oversize pattern", (a: any) => { a.classifier_input.also_match = "x".repeat(1_025); }],
        ] as const) {
            const { b, h } = civariant(edit);
            expect(parseClassifierInputPolicy(b, h), name).toBeNull();
        }
    });
    it("the token pattern and the qualifiers are optional", () => {
        const { b, h } = civariant((a: any) => { delete a.classifier_input.also_match; delete a.classifier_input.only_after; delete a.classifier_input.only_after_pattern; });
        const p = parseClassifierInputPolicy(b, h)!;
        expect(p.alsoMatch).toBeNull();
        expect(p.onlyAfterPattern).toBeNull();
        expect(p.onlyAfter.size).toBe(0);
    });
});

describe("getClassifierInputPolicy", () => {
    const CI = JSON.stringify(JSON.parse(readFileSync(new URL("../fixtures/classifier-input-policy.synthetic.json", import.meta.url), "utf8")));
    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        vi.clearAllMocks();
        clearInferencePolicies();
        mockGetSynaluxJwt.mockResolvedValue("jwt-current");
        fetchMock = vi.fn(async () => new Response(CI, { status: 200 }));
    });
    const load = () => getClassifierInputPolicy({ fetchImpl: fetchMock as unknown as typeof fetch, expectSha256: sha(CI) });

    it("GETs the artifact by its hash, loads once, and drops it when the account changes", async () => {
        expect((await load())?.dropWords.has("lorem")).toBe(true);
        expect(String(fetchMock.mock.calls[0][0])).toBe(`${PORTAL}/api/v1/prism/inference-policy/${sha(CI)}`);
        await load();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        clearInferencePolicies();
        await load();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it("the real pin is what an unconfigured call fetches", async () => {
        await getClassifierInputPolicy({ fetchImpl: fetchMock as unknown as typeof fetch });
        expect(String(fetchMock.mock.calls[0][0])).toBe(`${PORTAL}/api/v1/prism/inference-policy/${CLASSIFIER_INPUT_POLICY_SHA256}`);
    });
    it("a denial is no policy", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 403 }));
        expect(await load()).toBeNull();
    });
});
