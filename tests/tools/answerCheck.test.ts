/**
 * The answer check: a local answer to a
 * conversation is served only when it passes the local check, run on this
 * device with the pinned rules. When cloud is allowed and no image is
 * attached, a local pass is also confirmed by Synalux on a copy pseudonymized
 * on this device. Free plans and single prompts keep their local-first
 * behaviour: nothing is checked and nothing is sent.
 *
 *   local PASS, cloud off or an image    served locally; nothing sent
 *   local PASS, confirmation PASS        served locally
 *   confirmation FAIL / ERROR            cloud answers; if it fails, withheld
 *   local FAIL / ERROR / unfit / no rules  cloud when allowed, else withheld
 *   form gate failed                     cloud when allowed, else withheld (never a degraded draft)
 *   image and not a local pass           withheld (the image never leaves the device)
 *
 * The check itself is stubbed here (tests/utils/answerGrounding.test.ts
 * covers it); the end-to-end block runs the real check against a fake Ollama.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { runInfer, callOllamaGenerate, groundAnswer, _resetLayer1HistoryCacheForTest, type InferDeps, type PrismInferArgs, type AnswerCheckVerdict } from "../../src/tools/prismInferHandler.js";
import { answerGroundingBytes, ANSWER_GROUNDING_THINK_TOKENS, ANSWER_GROUNDING_FOLLOW_UP_TOKENS, type AnswerGroundingVerdict } from "../../src/utils/answerGrounding.js";
import { parseAnswerCheckPolicy } from "../../src/utils/inferencePolicy.js";
import { _setCacheForTest, _resetEntitlementsForTest, FREE_ENTITLEMENTS, type PrismEntitlements } from "../../src/utils/entitlements.js";

const GB = 1024 ** 3;
const BYTES = JSON.stringify(JSON.parse(readFileSync(new URL("../fixtures/answer-check-policy.synthetic.json", import.meta.url), "utf8")));
const POLICY = parseAnswerCheckPolicy(BYTES, createHash("sha256").update(BYTES).digest("hex"))!;
// The plans, as the server defines them:
// no account: everything local, no multi-turn; a free account: multi-turn with the
// local check and 20 metered cloud answers a day, no confirmation; Pro (plan key
// "standard"): the confirmation too.
const NO_ACCOUNT: PrismEntitlements = { ...FREE_ENTITLEMENTS, source: "unconfigured" };
const FREE: PrismEntitlements = {
    plan: "free", model_ceiling: "27b", daily_infer_limit: 20, max_tokens: 512, max_seats: 1,
    features: { cloud_fallback: true, grounding_verifier: false, knowledge_search_unlimited: false, session_memory_unlimited: false, analytics_dashboard: false },
    multi_turn: { enabled: true, max_turns: 12, max_chars: 32_000 },
    upgrade_url: "https://synalux.ai/pricing",
};
const STANDARD: PrismEntitlements = {
    plan: "standard", model_ceiling: "27b", daily_infer_limit: 200, max_tokens: 2048, max_seats: 1,
    features: { cloud_fallback: true, grounding_verifier: true, knowledge_search_unlimited: true, session_memory_unlimited: true, analytics_dashboard: true },
    multi_turn: { enabled: true, max_turns: 12, max_chars: 32_000 },
    upgrade_url: "https://synalux.ai/pricing",
};
const plan = (ent: PrismEntitlements) => _setCacheForTest(ent, 60_000);
beforeEach(() => { plan(STANDARD); _resetLayer1HistoryCacheForTest(); });
afterAll(() => _resetEntitlementsForTest());

const SYRUP = [
    { role: "user" as const, content: "We have 240 units of syrup in stock." },
    { role: "assistant" as const, content: "Noted, 240 units in stock." },
    { role: "user" as const, content: "We sold 65 units today." },
    { role: "assistant" as const, content: "Updated to 175 units remaining." },
];
const SYRUP_PROMPT = "How many would we have left after selling 40 more?";
const WRONG = "You'd have 195 units remaining.";
const RIGHT = "After selling 40 more units, you would have 135 units left in stock.";
const CLOUD_TEXT = "You would have 135 units left.";
const IMAGE = "aGVsbG8=";

type GroundArgs = Parameters<typeof groundAnswer>[0];
type ConfirmArgs = { messages: readonly { role: string; content: string }[]; prompt: string; answer: string };
type LocalReply = { ok: true; text: string; doneReason: string } | { ok: false; reason: string };
const ask = (extra: Record<string, unknown> = {}): PrismInferArgs =>
    ({ prompt: SYRUP_PROMPT, mode: "chat", escalation: "report", messages: SYRUP, ...extra } as unknown as PrismInferArgs);
function deps(answer: string | LocalReply | LocalReply[], local: AnswerGroundingVerdict, confirm: AnswerCheckVerdict = "PASS", overrides: Partial<InferDeps> = {}) {
    const ground = vi.fn(async (_o: GroundArgs) => ({ verdict: local }));
    const check = vi.fn(async (_o: ConfirmArgs) => ({ verdict: confirm }));
    const replies = Array.isArray(answer) ? [...answer] : null;
    const one: LocalReply = typeof answer === "string" ? { ok: true, text: answer, doneReason: "stop" } : (answer as LocalReply);
    const d = {
        freemem: () => 40 * GB,
        listTags: async () => new Set(["prism-coder:9b", "prism-coder:4b"]),
        listLoaded: async () => new Set<string>(),
        probeVision: async () => true,
        probeNumCtx: async () => 32_768,
        probeTemplateOverhead: async () => 64,
        probeLoadedContext: async () => null,
        callLayer1: vi.fn(async () => "OBVIOUS_NOT_RESERVED" as const),
        callLocal: vi.fn(async () => (replies ? replies.shift() ?? one : one)),
        callCloud: vi.fn(async () => ({ ok: true as const, output: CLOUD_TEXT, backend: "synalux-gemini" })),
        ollamaUrl: "http://x",
        answerCheckPolicy: async () => POLICY,
        groundAnswer: ground,
        checkAnswer: check,
        ...overrides,
    } as unknown as InferDeps;
    return { d, ground, check, cloud: d.callCloud as unknown as ReturnType<typeof vi.fn>, local: d.callLocal as unknown as ReturnType<typeof vi.fn> };
}
const reasons = (r: { attempts: { reason: string }[] }) => r.attempts.map(a => a.reason);
/** A fresh failing cloud each time: a shared mock would carry calls across cells. */
const cloudDown = (): Partial<InferDeps> => ({ callCloud: vi.fn(async () => ({ ok: false as const, reason: "synalux_timeout" })) } as Partial<InferDeps>);
const withheld = (reason: string) => ({ backend: "refused", output: "", gate_outcome: { status: "refused", reason, served_anyway: false } });

describe("the local check decides first, on this device", () => {
    it("reads exactly the served answer with the pinned rules, on the model that answered", async () => {
        const { d, ground } = deps(RIGHT, "GROUNDED");
        await runInfer(ask(), d);
        expect(ground).toHaveBeenCalledTimes(1);
        expect(ground.mock.calls[0][0]).toMatchObject({ policy: POLICY, model: "prism-coder:9b", messages: SYRUP, prompt: SYRUP_PROMPT, answer: RIGHT, numCtx: 32_768 });
    });
    it("local FAIL: the cloud answers with the conversation, no confirmation is asked; cloud down or off, withheld", async () => {
        let c = deps(WRONG, "UNGROUNDED");
        let r = await runInfer(ask(), c.d);
        expect(r).toMatchObject({ used_cloud: true, output: CLOUD_TEXT });
        expect(reasons(r)).toEqual(expect.arrayContaining(["answer_check:local_ungrounded", "quality_gate:ungrounded"]));
        expect(c.check).not.toHaveBeenCalled();
        expect(c.cloud.mock.calls[0][3]).toMatchObject({ messages: [...SYRUP, { role: "user", content: SYRUP_PROMPT }] });
        _resetLayer1HistoryCacheForTest();
        r = await runInfer(ask(), deps(WRONG, "UNGROUNDED", "PASS", cloudDown()).d);
        expect(r).toMatchObject(withheld("answer_ungrounded"));
        _resetLayer1HistoryCacheForTest();
        c = deps(WRONG, "UNGROUNDED");
        r = await runInfer(ask({ cloud_fallback: false }), c.d);
        expect(r).toMatchObject(withheld("answer_ungrounded"));
        expect(c.cloud).not.toHaveBeenCalled();
        expect(reasons(r)).toContain("answer_withheld:ungrounded");
        // serve mode: an error, and the rejected text is not in it
        const err = await runInfer(ask({ escalation: undefined, cloud_fallback: false }), deps(WRONG, "UNGROUNDED").d).then(() => null, e => e as Error & { refusal_reason?: string });
        expect(err?.refusal_reason).toBe("answer_ungrounded");
        expect(err?.message).not.toContain("195");
    });
    it("local ERROR, a check that throws, no pinned rules, or too large for the running context: unchecked — cloud, else withheld", async () => {
        const cases: Array<[string, Partial<InferDeps>, string]> = [
            ["error", {}, "answer_check:local_error"],
            ["throws", { groundAnswer: vi.fn(async () => { throw new Error("boom"); }) } as Partial<InferDeps>, "answer_check:local_error"],
            ["no rules", { answerCheckPolicy: async () => null } as Partial<InferDeps>, "answer_check:local_no_policy"],
            ["rules fail to load", { answerCheckPolicy: async () => { throw new Error("x"); } } as Partial<InferDeps>, "answer_check:local_no_policy"],
            ["unfit", { probeLoadedContext: async () => 256 } as Partial<InferDeps>, "answer_check:local_unfit"],
        ];
        for (const [name, over, reason] of cases) {
            _resetLayer1HistoryCacheForTest();
            let c = deps(RIGHT, "ERROR", "PASS", over);
            const r = await runInfer(ask(), c.d);
            expect(r, name).toMatchObject({ used_cloud: true, output: CLOUD_TEXT });
            expect(reasons(r), name).toContain(reason);
            expect(c.check, name).not.toHaveBeenCalled();
            _resetLayer1HistoryCacheForTest();
            c = deps(RIGHT, "ERROR", "PASS", { ...over, ...cloudDown() });
            expect(await runInfer(ask(), c.d), name).toMatchObject(withheld("answer_unverified"));
            _resetLayer1HistoryCacheForTest();
            c = deps(RIGHT, "ERROR", "PASS", over);
            expect(await runInfer(ask({ cloud_fallback: false }), c.d), name).toMatchObject(withheld("answer_unverified"));
            expect(c.cloud, name).not.toHaveBeenCalled();
        }
    });
    it("the size bound is the request's bytes plus the measured overhead, the reasoning budget and the follow-up room, against the RUNNING context", async () => {
        const need = answerGroundingBytes(POLICY, SYRUP, SYRUP_PROMPT, RIGHT) + 64 + ANSWER_GROUNDING_THINK_TOKENS + ANSWER_GROUNDING_FOLLOW_UP_TOKENS;
        for (const [ctx, sent] of [[need - 1, false], [need, true]] as const) {
            _resetLayer1HistoryCacheForTest();
            const c = deps(RIGHT, "GROUNDED", "PASS", { probeLoadedContext: async () => ctx } as Partial<InferDeps>);
            await runInfer(ask(), c.d);
            expect(c.ground.mock.calls.length > 0, String(ctx)).toBe(sent);
            if (sent) expect(c.ground.mock.calls[0][0].numCtx).toBe(ctx);
        }
        // a stock install's 9b (no pinned num_ctx: the tier table says 4,096) is sized by the context Ollama loaded it with
        // within the plan's 12 turns
        const long = Array.from({ length: 12 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `Entry ${i}: the shelf holds ${i * 3} jars of item ${i}. `.repeat(5) }));
        expect(answerGroundingBytes(POLICY, long, SYRUP_PROMPT, RIGHT) + 64 + ANSWER_GROUNDING_THINK_TOKENS).toBeGreaterThan(4_096);
        _resetLayer1HistoryCacheForTest();
        let c = deps(RIGHT, "GROUNDED", "PASS", { probeNumCtx: async () => null, probeLoadedContext: async () => 32_768 } as Partial<InferDeps>);
        await runInfer(ask({ messages: long }), c.d);
        expect(c.ground.mock.calls[0][0].numCtx).toBe(32_768);
        _resetLayer1HistoryCacheForTest();
        c = deps(RIGHT, "GROUNDED", "PASS", { probeNumCtx: async () => null, probeLoadedContext: async () => null } as Partial<InferDeps>);
        const r = await runInfer(ask({ messages: long }), c.d);
        expect(c.ground).not.toHaveBeenCalled();
        expect(reasons(r)).toContain("answer_check:local_unfit");
    });
});

describe("a local pass is confirmed by Synalux only when cloud is allowed, on a pseudonymized copy", () => {
    it("confirmation PASS: served locally; the confirmation received the conversation, request and answer as served", async () => {
        const { d, check, cloud } = deps(RIGHT, "GROUNDED", "PASS");
        const r = await runInfer(ask(), d);
        expect(r).toMatchObject({ backend: "ollama-9b", output: RIGHT, used_cloud: false, gate_outcome: { status: "success", served_anyway: false } });
        expect(r.quality_gate_failed).toBeUndefined();
        expect(reasons(r)).toEqual(expect.arrayContaining(["answer_check:local_grounded", "answer_check:confirm_pass"]));
        expect(check).toHaveBeenCalledTimes(1);
        // this conversation holds no identifiers: the copy is the text itself
        expect(check.mock.calls[0][0]).toEqual({ messages: SYRUP, prompt: SYRUP_PROMPT, answer: RIGHT });
        expect(cloud).not.toHaveBeenCalled();
    });
    it("confirmation FAIL: the cloud answers; if the cloud fails, withheld — the local text never returns", async () => {
        let r = await runInfer(ask(), deps(RIGHT, "GROUNDED", "FAIL").d);
        expect(r).toMatchObject({ used_cloud: true, output: CLOUD_TEXT });
        expect(reasons(r)).toEqual(expect.arrayContaining(["answer_check:confirm_fail", "quality_gate:ungrounded"]));
        _resetLayer1HistoryCacheForTest();
        r = await runInfer(ask(), deps(RIGHT, "GROUNDED", "FAIL", cloudDown()).d);
        expect(r).toMatchObject(withheld("answer_ungrounded"));
    });
    it("confirmation ERROR, or one that throws: unchecked — the cloud answers; if it fails, withheld", async () => {
        for (const over of [{}, { checkAnswer: vi.fn(async () => { throw new Error("boom"); }) }] as Array<Partial<InferDeps>>) {
            _resetLayer1HistoryCacheForTest();
            let r = await runInfer(ask(), deps(RIGHT, "GROUNDED", "ERROR", over).d);
            expect(r).toMatchObject({ used_cloud: true, output: CLOUD_TEXT });
            expect(reasons(r)).toContain("answer_check:confirm_error");
            _resetLayer1HistoryCacheForTest();
            r = await runInfer(ask(), deps(RIGHT, "GROUNDED", "ERROR", { ...over, ...cloudDown() }).d);
            expect(r).toMatchObject(withheld("answer_unverified"));
        }
    });
    it("cloud not allowed for the request: the local pass is served and nothing is sent", async () => {
        const { d, check, cloud } = deps(RIGHT, "GROUNDED", "FAIL");
        const r = await runInfer(ask({ cloud_fallback: false }), d);
        expect(r).toMatchObject({ backend: "ollama-9b", output: RIGHT, used_cloud: false });
        expect(check).not.toHaveBeenCalled();
        expect(cloud).not.toHaveBeenCalled();
    });
    it("the three documented switches: with cloud_fallback, verify and route_guard all off, nothing leaves the device; each switch opens only its own channel", async () => {
        // README: cloud fallback is governed by cloud_fallback, the grounding verifier by verify
        // (on by default when evidence is given), route correction by route_guard.
        const channels = () => ({
            callVerifier: vi.fn(async ({ draft }: { draft: string }) => ({ action: "accept" as const, finalText: draft, verifierChain: [] })),
            callRouteGuard: vi.fn(async () => { throw new Error("route guard must not run"); }),
        });
        let ch = channels();
        let c = deps(RIGHT, "GROUNDED", "PASS", ch as unknown as Partial<InferDeps>);
        let r = await runInfer(ask({ cloud_fallback: false, route_guard: "local" }), c.d);
        expect(r).toMatchObject({ output: RIGHT, used_cloud: false });
        for (const f of [c.check, c.cloud, ch.callVerifier, ch.callRouteGuard]) expect(f).not.toHaveBeenCalled();
        // verify on: only the verifier is called
        _resetLayer1HistoryCacheForTest();
        ch = channels();
        c = deps(RIGHT, "GROUNDED", "PASS", ch as unknown as Partial<InferDeps>);
        r = await runInfer(ask({ cloud_fallback: false, route_guard: "local", verify: true, evidence: [{ source: "note", content: "240 in stock, 65 sold" }] }), c.d);
        expect(ch.callVerifier).toHaveBeenCalledTimes(1);
        for (const f of [c.check, c.cloud, ch.callRouteGuard]) expect(f).not.toHaveBeenCalled();
        // route mode, a bare tool call, on a plan with the route guard feature: route_guard
        // "local" keeps the correction on the device; the default ("auto") sends it,
        // whatever cloud_fallback says
        plan({ ...STANDARD, features: { ...STANDARD.features, route_guard: true } });
        const TOOL = '<|tool_call|>{"name":"session_load_context","arguments":{"project":"x"}}<|tool_call_end|>';
        _resetLayer1HistoryCacheForTest();
        ch = channels();
        c = deps(TOOL, "GROUNDED", "PASS", ch as unknown as Partial<InferDeps>);
        await runInfer(ask({ mode: "route", cloud_fallback: false, route_guard: "local" }), c.d);
        for (const f of [c.check, c.cloud, ch.callRouteGuard, ch.callVerifier]) expect(f).not.toHaveBeenCalled();
        _resetLayer1HistoryCacheForTest();
        ch = channels();
        c = deps(TOOL, "GROUNDED", "PASS", ch as unknown as Partial<InferDeps>);
        await runInfer(ask({ mode: "route", cloud_fallback: false }), c.d).catch(() => null);
        expect(ch.callRouteGuard).toHaveBeenCalledTimes(1);
        for (const f of [c.check, c.cloud]) expect(f).not.toHaveBeenCalled();
    });
    it("identifiers never leave the device: the confirmation receives tokens; the local check and the answer served keep the real text", async () => {
        const IDENTIFYING = [
            { role: "user" as const, content: "Patient Maria Lopez, MRN 00123456, DOB 03/14/1988, phone 555-123-4567, email maria.lopez@example.com." },
            { role: "assistant" as const, content: "Noted for Maria Lopez." },
            { role: "user" as const, content: "She lives at 42 Oak Street, Springfield IL 62704. Her doctor is Dr. Chen." },
            { role: "assistant" as const, content: "Got it: Dr. Chen." },
        ];
        const prompt = "Who is maria's doctor, and what is her MRN?";
        const answer = "Maria's doctor is Dr. Chen; her MRN is 00123456.";
        const { d, ground, check } = deps(answer, "GROUNDED", "PASS");
        const r = await runInfer(ask({ messages: IDENTIFYING, prompt }), d);
        expect(r.output).toBe(answer);
        expect(ground.mock.calls[0][0]).toMatchObject({ messages: IDENTIFYING, prompt, answer });
        const sent = JSON.stringify(check.mock.calls[0][0]);
        for (const id of ["Maria", "maria", "Lopez", "00123456", "03/14/1988", "555-123-4567", "example.com", "42 Oak Street", "Springfield", "62704", "Chen"])
            expect(sent, id).not.toContain(id);
        // each identifier is replaced whole, by its own kind of token
        for (const token of ["NAME_1", "ID_1", "DATE_1", "PHONE_1", "EMAIL_1", "ADDRESS_1"]) expect(sent, token).toContain(token);
        // identity survives: the same person is the same token in the conversation, the request and the answer
        const sentArgs = check.mock.calls[0][0];
        const token = sentArgs.messages[1].content.match(/NAME_\d+/)![0];
        expect(sentArgs.prompt).toContain(token);
        expect(sentArgs.answer).toContain(token);
    });
    it("text the pseudonymizer cannot read is not sent: the local pass stands, as with cloud off", async () => {
        const RU = [{ role: "user" as const, content: "Пациентка Анна Иванова, 240 единиц." }, { role: "assistant" as const, content: "Записано." }];
        const { d, check, cloud } = deps(RIGHT, "GROUNDED", "FAIL");
        const r = await runInfer(ask({ messages: RU }), d);
        expect(check).not.toHaveBeenCalled();
        expect(cloud).not.toHaveBeenCalled();
        expect(r).toMatchObject({ output: RIGHT, used_cloud: false });
        expect(reasons(r)).toContain("answer_check:confirm_not_sendable");
    });
});

describe("an image stays on the device", () => {
    it("local pass: served, nothing sent, whatever the cloud flag; the check read the image", async () => {
        for (const cloud_fallback of [undefined, true, false]) {
            _resetLayer1HistoryCacheForTest();
            const { d, ground, check, cloud } = deps(RIGHT, "GROUNDED", "FAIL");
            const r = await runInfer(ask({ images: [IMAGE], cloud_fallback }), d);
            expect(r, String(cloud_fallback)).toMatchObject({ output: RIGHT, used_cloud: false });
            expect(ground.mock.calls[0][0].images, String(cloud_fallback)).toEqual([IMAGE]);
            expect(check, String(cloud_fallback)).not.toHaveBeenCalled();
            expect(cloud, String(cloud_fallback)).not.toHaveBeenCalled();
        }
    });
    it("local FAIL or ERROR: withheld as a structured refusal, never sent to the cloud", async () => {
        for (const [local, reason] of [["UNGROUNDED", "answer_ungrounded"], ["ERROR", "answer_unverified"]] as const) {
            _resetLayer1HistoryCacheForTest();
            const { d, check, cloud } = deps(RIGHT, local);
            const r = await runInfer(ask({ images: [IMAGE] }), d);
            expect(r, local).toMatchObject(withheld(reason));
            expect(check, local).not.toHaveBeenCalled();
            expect(cloud, local).not.toHaveBeenCalled();
        }
    });
});

describe("what is checked", () => {
    it("a form-gate failure is never served as a degraded draft in a conversation: cloud, else withheld; nothing is checked", async () => {
        const truncated: LocalReply = { ok: true, text: "After selling 40 more units, you would have", doneReason: "length" };
        let c = deps(truncated, "GROUNDED");
        let r = await runInfer(ask(), c.d);
        expect(c.ground).not.toHaveBeenCalled();
        expect(c.check).not.toHaveBeenCalled();
        expect(r).toMatchObject({ used_cloud: true, output: CLOUD_TEXT });
        expect(reasons(r)).toEqual(expect.arrayContaining(["quality_gate:hard_truncation", "answer_check:form"]));
        _resetLayer1HistoryCacheForTest();
        c = deps(truncated, "GROUNDED", "PASS", cloudDown());
        r = await runInfer(ask(), c.d);
        expect(r).toMatchObject(withheld("answer_unverified"));
        expect(r.output).not.toContain("you would have");
        _resetLayer1HistoryCacheForTest();
        c = deps(truncated, "GROUNDED");
        r = await runInfer(ask({ cloud_fallback: false }), c.d);
        expect(r).toMatchObject(withheld("answer_unverified"));
        expect(c.cloud).not.toHaveBeenCalled();
    });
    it("the answer as served: thinking stripped, the think-only retry's answer, a smaller tier's answer on that tier", async () => {
        let c = deps(`<think>240 minus 65 is 175, minus 40 is 135</think>${RIGHT}`, "GROUNDED");
        await runInfer(ask(), c.d);
        expect(c.ground.mock.calls[0][0].answer).toBe(RIGHT);
        expect(c.check.mock.calls[0][0].answer).toBe(RIGHT);
        _resetLayer1HistoryCacheForTest();
        c = deps([{ ok: false, reason: "think_only" }, { ok: true, text: RIGHT, doneReason: "stop" }], "GROUNDED");
        const retried = await runInfer(ask(), c.d);
        expect(c.local.mock.calls).toHaveLength(2);
        expect(c.ground.mock.calls.map(x => x[0].answer)).toEqual([RIGHT]);
        expect(retried.output).toBe(RIGHT);
        _resetLayer1HistoryCacheForTest();
        c = deps(RIGHT, "GROUNDED", "PASS", { listTags: async () => new Set(["prism-coder:4b"]) } as Partial<InferDeps>);
        expect((await runInfer(ask(), c.d)).backend).toBe("ollama-4b");
        expect(c.ground.mock.calls[0][0].model).toBe("prism-coder:4b");
    });
    it("a passed answer that output safety then replaces is recorded as replaced", async () => {
        const dangerous = "You should take 40 units of it tonight.";   // safetyGate MEDICAL_OUTPUT_RE
        const r = await runInfer(ask(), deps(dangerous, "GROUNDED").d);
        expect(r.output).not.toBe(dangerous);
        expect(reasons(r)).toEqual(expect.arrayContaining(["answer_check:local_grounded", "answer_check:replaced_by_output_safety"]));
        _resetLayer1HistoryCacheForTest();
        expect(reasons(await runInfer(ask(), deps(RIGHT, "GROUNDED").d))).not.toContain("answer_check:replaced_by_output_safety");
    });
    it("chat, code and route plain text are checked; a single prompt and a route-mode tool call are not", async () => {
        for (const [name, a] of [["chat", ask()], ["code", ask({ mode: "code" })], ["route, plain text", ask({ mode: "route" })]] as const) {
            _resetLayer1HistoryCacheForTest();
            const { d, ground } = deps(RIGHT, "GROUNDED");
            await runInfer(a, d);
            expect(ground, name).toHaveBeenCalledTimes(1);
        }
        _resetLayer1HistoryCacheForTest();
        let c = deps(RIGHT, "UNGROUNDED", "FAIL");
        const single = await runInfer(ask({ messages: undefined }), c.d);
        expect(c.ground).not.toHaveBeenCalled();
        expect(c.check).not.toHaveBeenCalled();
        expect(single.output).toBe(RIGHT);
        _resetLayer1HistoryCacheForTest();
        c = deps('<|tool_call|>{"name":"session_load_context","arguments":{"project":"x"}}<|tool_call_end|>', "UNGROUNDED", "FAIL");
        await runInfer(ask({ mode: "route" }), c.d);
        expect(c.ground).not.toHaveBeenCalled();
    });
    it("a route answer with prose around its tool call is checked like prose; the unchecked prose is never served", async () => {
        // Review 2026-09-26: an unterminated envelope after the prose parsed as a tool call,
        // so the check was skipped and the whole draft, prose included, was served.
        const draft = `${WRONG}\n<|tool_call|>{"name":"session_load_context","arguments":{"project":"x"}}`;
        let c = deps(draft, "UNGROUNDED");
        let r = await runInfer(ask({ mode: "route", cloud_fallback: false }), c.d);
        expect(c.ground).toHaveBeenCalledTimes(1);
        expect(r).toMatchObject(withheld("answer_ungrounded"));
        expect(r.output).not.toContain("195");
        _resetLayer1HistoryCacheForTest();
        c = deps(draft, "UNGROUNDED");
        r = await runInfer(ask({ mode: "route" }), c.d);
        expect(r).toMatchObject({ used_cloud: true, output: CLOUD_TEXT });
    });
    it("no draft of a conversation's answer is kept for recovery: a truncated route tool call is not served when the cloud fails", async () => {
        const cut: LocalReply = { ok: true, text: '<|tool_call|>{"name":"session_load_context","arguments":{"project":"x"}}<|tool_call_end|>', doneReason: "length" };
        const c = deps(cut, "GROUNDED", "PASS", cloudDown());
        // With nothing else to serve, the call fails outright; the kept-draft path
        // would have returned the truncated call marked degraded.
        const outcome = await runInfer(ask({ mode: "route" }), c.d).then(r => r, (e: Error) => e);
        expect(outcome).toBeInstanceOf(Error);
        expect((outcome as Error).message).toMatch(/no backend produced output/);
        // a single prompt keeps its degraded recovery (unchanged)
        _resetLayer1HistoryCacheForTest();
        const single = await runInfer(ask({ mode: "route", messages: undefined }), deps(cut, "GROUNDED", "PASS", cloudDown()).d);
        expect(single.gate_outcome?.status).toBe("degraded");
    });
});

/**
 * The tier × cloud matrix: cloud enabled and disabled, on the free and the
 * paid tiers. Every combination of plan, the
 * caller's cloud flag, request shape, image, local verdict, confirmation and
 * cloud health, with what must happen and what may leave the device.
 */
describe("tier × cloud matrix", () => {
    type Outcome = "local" | "cloud" | "withheld" | "not_in_plan";
    interface Cell {
        plan: "none" | "free" | "standard"; cloud: boolean | undefined; request: "single" | "conversation"; image: boolean;
        local: AnswerGroundingVerdict; confirm: AnswerCheckVerdict; cloudOk: boolean;
    }
    const expected = (c: Cell): { outcome: Outcome; checked: boolean; confirmed: boolean; cloudCalled: boolean; reason?: string } => {
        if (c.request === "single") return { outcome: "local", checked: false, confirmed: false, cloudCalled: false };   // local first, every plan, any flag
        if (c.plan === "none") return { outcome: "not_in_plan", checked: false, confirmed: false, cloudCalled: false };   // multi-turn needs an account
        const cloudAllowed = c.cloud !== false;   // every account has cloud (free: 20 a day); only the caller turns it off
        if (c.local === "GROUNDED") {
            // no confirmation: cloud off, an image, or a plan without the verifier (a free account)
            if (!cloudAllowed || c.image || c.plan === "free") return { outcome: "local", checked: true, confirmed: false, cloudCalled: false };
            if (c.confirm === "PASS") return { outcome: "local", checked: true, confirmed: true, cloudCalled: false };
            const reason = c.confirm === "FAIL" ? "answer_ungrounded" : "answer_unverified";
            return { outcome: c.cloudOk ? "cloud" : "withheld", checked: true, confirmed: true, cloudCalled: true, reason };
        }
        const reason = c.local === "UNGROUNDED" ? "answer_ungrounded" : "answer_unverified";
        if (c.image || !cloudAllowed) return { outcome: "withheld", checked: true, confirmed: false, cloudCalled: false, reason };
        return { outcome: c.cloudOk ? "cloud" : "withheld", checked: true, confirmed: false, cloudCalled: true, reason };
    };
    const cells: Cell[] = [];
    for (const p of ["none", "free", "standard"] as const)
        for (const cloud of [undefined, true, false])
            for (const request of ["single", "conversation"] as const)
                for (const image of [false, true])
                    for (const local of ["GROUNDED", "UNGROUNDED", "ERROR"] as const)
                        for (const confirm of ["PASS", "FAIL", "ERROR"] as const)
                            for (const cloudOk of [true, false]) cells.push({ plan: p, cloud, request, image, local, confirm, cloudOk });

    it(`all ${3 * 3 * 2 * 2 * 3 * 3 * 2} cells route as specified, and nothing leaves the device unless allowed`, async () => {
        const seen = new Set<string>();
        for (const cell of cells) {
            plan(cell.plan === "none" ? NO_ACCOUNT : cell.plan === "free" ? FREE : STANDARD);
            _resetLayer1HistoryCacheForTest();
            const name = JSON.stringify(cell);
            const { d, ground, check, cloud, local } = deps(RIGHT, cell.local, cell.confirm, cell.cloudOk ? {} : cloudDown());
            const a = ask({ cloud_fallback: cell.cloud, ...(cell.request === "single" ? { messages: undefined } : {}), ...(cell.image ? { images: [IMAGE] } : {}) });
            const r = await runInfer(a, d);
            const want = expected(cell);
            const got: Outcome = r.gate_outcome?.reason === "multi_turn_not_in_plan" ? "not_in_plan"
                : r.backend === "refused" ? "withheld"
                : r.used_cloud ? "cloud" : "local";
            expect(got, name).toBe(want.outcome);
            expect(ground.mock.calls.length > 0, `${name} checked`).toBe(want.checked);
            expect(check.mock.calls.length > 0, `${name} confirmed`).toBe(want.confirmed);
            expect(cloud.mock.calls.length > 0, `${name} cloud`).toBe(want.cloudCalled);
            if (want.outcome === "local") expect(r.output, name).toBe(RIGHT);
            if (want.outcome === "withheld") expect(r, name).toMatchObject(withheld(want.reason!));
            if (want.outcome === "not_in_plan") expect(local, `${name} no generation`).not.toHaveBeenCalled();
            seen.add(want.outcome);
        }
        expect([...seen].sort()).toEqual(["cloud", "local", "not_in_plan", "withheld"]);
    });
    it("a single prompt with no account, or on a free account, is served locally with no check and no cloud, and no model cap", async () => {
        for (const [name, ent] of [["no account", NO_ACCOUNT], ["free account", FREE]] as const) for (const cloud_fallback of [undefined, true, false]) {
            plan(ent);
            _resetLayer1HistoryCacheForTest();
            const { d, ground, check, cloud } = deps(RIGHT, "UNGROUNDED", "FAIL");
            const r = await runInfer(ask({ messages: undefined, cloud_fallback }), d);
            expect(r, `${name} ${cloud_fallback}`).toMatchObject({ backend: "ollama-9b", output: RIGHT, used_cloud: false });
            expect(ground).not.toHaveBeenCalled();
            expect(check).not.toHaveBeenCalled();
            expect(cloud).not.toHaveBeenCalled();
        }
    });
    it("a single prompt's form failure is unchanged: degraded without cloud, cloud with it; conversations never degrade", async () => {
        const truncated: LocalReply = { ok: true, text: "After selling 40 more units, you would have", doneReason: "length" };
        plan(NO_ACCOUNT);
        let r = await runInfer(ask({ messages: undefined }), deps(truncated, "GROUNDED").d);
        expect(r).toMatchObject({ quality_gate_failed: true, gate_outcome: { status: "degraded", served_anyway: true } });
        plan(STANDARD);
        _resetLayer1HistoryCacheForTest();
        r = await runInfer(ask({ messages: undefined }), deps(truncated, "GROUNDED").d);
        expect(r).toMatchObject({ used_cloud: true, output: CLOUD_TEXT });
        _resetLayer1HistoryCacheForTest();
        r = await runInfer(ask({ messages: undefined }), deps(truncated, "GROUNDED", "PASS", cloudDown()).d);
        expect(r).toMatchObject({ quality_gate_failed: true, gate_outcome: { status: "degraded" } });
    });
});

describe("end to end over HTTP: a fake Ollama, the real generation client and the real local check", () => {
    // The fake checker decides from the request it receives: FAIL when the
    // candidate it was sent is the wrong recall. That proves the answer reached
    // the checker as JSON data under the pinned rules and the verdict routed the
    // request; judging accuracy is the real-model benchmark's job.
    const run = async (answer: string) => {
        const checks: string[] = [];
        const server = http.createServer((req, res) => {
            let body = ""; req.on("data", ch => (body += ch)); req.on("end", () => {
                const j = JSON.parse(body || "{}");
                const msgs = (j.messages ?? []) as Array<{ role: string; content: string }>;
                res.setHeader("Content-Type", "application/json");
                if (req.url === "/api/ps") { res.end(JSON.stringify({ models: [] })); return; }
                let content = answer;
                if (msgs[0]?.role === "system" && msgs[0].content === POLICY.systemPrompt) {
                    const data = JSON.parse(msgs[1].content);
                    checks.push(data.candidate_answer);
                    content = /\b195\b/.test(data.candidate_answer) ? "FAIL" : "PASS";
                }
                res.end(JSON.stringify({ message: { role: "assistant", content }, done: true, done_reason: "stop", prompt_eval_count: 300, eval_count: 20 }));
            });
        });
        await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
            const { d, cloud, check } = deps(answer, "GROUNDED", "PASS", { ollamaUrl: url, callLocal: callOllamaGenerate, groundAnswer: undefined, probeLoadedContext: undefined } as Partial<InferDeps>);
            const r = await runInfer(ask(), d);
            return { r, checks, cloud, check };
        } finally { server.close(); }
    };
    it("the wrong recall is caught on the device and the cloud answers; no confirmation is asked", async () => {
        const { r, checks, cloud, check } = await run(WRONG);
        expect(checks).toEqual([WRONG]);
        expect(check).not.toHaveBeenCalled();
        expect(cloud).toHaveBeenCalledTimes(1);
        expect(r).toMatchObject({ used_cloud: true, output: CLOUD_TEXT });
    });
    it("the right recall passes on the device, is confirmed, and is served locally", async () => {
        const { r, checks, cloud, check } = await run(RIGHT);
        expect(checks).toEqual([RIGHT]);
        expect(check).toHaveBeenCalledTimes(1);
        expect(cloud).not.toHaveBeenCalled();
        expect(r).toMatchObject({ used_cloud: false, output: RIGHT });
        expect(reasons(r)).toEqual(expect.arrayContaining(["answer_check:local_grounded", "answer_check:confirm_pass"]));
    });
});
