/**
 * Pre-merge adversarial review of multi-turn (2026-09-16): each test here
 * failed on the code it guards before the fix landed.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import {
    runInfer,
    VISION_SYSTEM_PROMPT,
    prismInferHandler,
    messagesProblem,
    _resetLayer1HistoryCacheForTest,
    LAYER1_HISTORY_CACHE_TTL_MS,
    callSynaluxInference,
    portalFlattenedTranscript,
    historyTurnWindows,
    screeningTranscript,
    windowsOf,
    DETERMINISTIC_FLOOR_WINDOW_CHARS,
    DETERMINISTIC_FLOOR_WINDOW_OVERLAP,
    HISTORY_TURN_WINDOW_CHARS,
    HISTORY_TURN_WINDOW_OVERLAP,
    CLOUD_HISTORY_MAX_MESSAGES,
    CLOUD_HISTORY_CAP_BYTES,
    type InferDeps,
    type PrismInferArgs,
} from "../../src/tools/prismInferHandler.js";
import { _setCacheForTest, _resetEntitlementsForTest, type PrismEntitlements } from "../../src/utils/entitlements.js";

const GB = 1024 ** 3;
const MARKER = "RESERVED_MARKER_restraint_duration";
const ENT: PrismEntitlements = {
    plan: "enterprise",
    model_ceiling: "27b",
    daily_infer_limit: 100_000,
    max_tokens: 4096,
    max_seats: 25,
    multi_turn: { enabled: true, max_turns: 30, max_chars: 96_000 },
    features: { cloud_fallback: false, grounding_verifier: false, knowledge_search_unlimited: true, session_memory_unlimited: true, analytics_dashboard: true },
    upgrade_url: "https://synalux.ai/pricing",
};
beforeEach(() => { _setCacheForTest(ENT, 60_000); _resetLayer1HistoryCacheForTest(); });
afterAll(() => _resetEntitlementsForTest());

function deps(overrides: Partial<InferDeps> = {}): InferDeps {
    return {
        freemem: () => 40 * GB,
        listTags: async () => new Set(["prism-coder:9b", "prism-coder:4b"]),
        listLoaded: async () => new Set<string>(),
        probeVision: async () => false,
        probeNumCtx: async () => null,
        callLocal: vi.fn(async (_u, model) => ({ ok: true as const, text: `answer from ${model}`, doneReason: "stop" })),
        callCloud: vi.fn(async () => ({ ok: false as const, reason: "no_cloud" })),
        ollamaUrl: "http://x",
        callLayer1: vi.fn(async () => "OBVIOUS_NOT_RESERVED" as const),
        ...overrides,
    } as InferDeps;
}
const HISTORY = [
    { role: "user" as const, content: "My project codename is Nightjar. Reply OK." },
    { role: "assistant" as const, content: "OK" },
];
const args = (extra: Record<string, unknown> = {}): PrismInferArgs =>
    ({ prompt: "What is my codename?", mode: "chat", escalation: "report", messages: HISTORY, ...extra } as unknown as PrismInferArgs);

describe("R1 the silent-truncation backstop counts the whole input", () => {
    // 4b only, num_ctx 32,768 → the collapse value is 16,384 prompt tokens.
    const big = "The quarterly reconciliation report was adjusted. ".repeat(400); // 20,000 chars
    const collapsed = () => deps({
        listTags: async () => new Set(["prism-coder:4b"]),
        probeNumCtx: async () => 32_768,
        callLocal: vi.fn(async () => ({ ok: true as const, text: "answer from a fragment", doneReason: "stop", promptTokens: 16_386 })),
    });
    it("a short prompt behind long history that collapses to num_ctx/2 is refused as truncated, not served", async () => {
        let seen: string[] = [];
        let output = "";
        try {
            const r = await runInfer(args({ prompt: "continue", messages: [{ role: "user", content: big }, { role: "assistant", content: "OK" }] }), collapsed());
            output = r.output; seen = r.attempts.map(a => a.reason);
        } catch (e) {
            seen = ((e as { attempts?: Array<{ reason: string }> }).attempts ?? []).map(a => a.reason);
        }
        expect(seen.some(x => x.startsWith("input_truncated:")), `attempts were ${JSON.stringify(seen)}`).toBe(true);
        expect(output).not.toContain("answer from a fragment");
    });
    it("a short single-turn prompt that merely lands on num_ctx/2 is still served (floor unchanged without history)", async () => {
        const r = await runInfer({ prompt: "short question", mode: "code", escalation: "report" }, collapsed());
        expect(r.output).toContain("answer from a fragment");
    });
});

describe("R2 the code-repair retry carries the same history as the first call", () => {
    const PROMPT = "Implement class TrieNode with a valid Python constructor. Return only the implementation source code.";
    const BAD = "class TrieNode:\n    def __init__():\n        self.children = {}";
    const GOOD = "class TrieNode:\n    def __init__(self):\n        self.children = {}";
    it("the second local call (repair) has the history in the trailing slot", async () => {
        const callLocal = vi.fn()
            .mockResolvedValueOnce({ ok: true as const, text: BAD, doneReason: "stop" })
            .mockResolvedValueOnce({ ok: true as const, text: GOOD, doneReason: "stop" });
        const r = await runInfer(args({ prompt: PROMPT, mode: "code", model_ceiling: "9b" }), deps({ callLocal }));
        expect(r.attempts.some(a => a.reason.startsWith("code_repair:")), JSON.stringify(r.attempts)).toBe(true);
        expect(callLocal.mock.calls.length).toBeGreaterThanOrEqual(2);
        const repair = callLocal.mock.calls[1];
        expect(repair[2]).toContain("<failed_gate>");
        expect(repair[9]).toEqual(HISTORY);
    });
});

describe("R3 the cloud cap mirrors the portal exactly", () => {
    it("50 prior turns plus the current one is 51 messages: refused before any network call", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not be called"));
        try {
            const fifty = Array.from({ length: CLOUD_HISTORY_MAX_MESSAGES }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: "t" }));
            const r = await callSynaluxInference("x", 64, 1_000, { messages: [...fifty, { role: "user", content: "x" }] });
            expect(r.ok).toBe(false);
            expect((r as { ok: false; reason: string }).reason).toBe("history_over_cloud_cap");
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally { fetchSpy.mockRestore(); }
    });
    it("flattening matches the portal byte-for-byte: 'User:'/'Assistant:' labels, newline-joined, trailing Assistant cue", () => {
        expect(portalFlattenedTranscript([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]))
            .toBe("User: a\nAssistant: b\nAssistant:");
    });
    it("a transcript the portal would 413 by ten bytes is refused here too", async () => {
        // One message: portal form = 6 + c + 11 bytes. c = 32,752 makes it 32,769,
        // one over the cap; the old client formula (`USER: ` + c + `\n` = 32,759)
        // accepted it and the portal rejected it.
        const c = CLOUD_HISTORY_CAP_BYTES - 17 + 1;
        const messages = [{ role: "user" as const, content: "x".repeat(c) }];
        expect(Buffer.byteLength(portalFlattenedTranscript(messages), "utf8")).toBe(CLOUD_HISTORY_CAP_BYTES + 1);
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not be called"));
        try {
            const r = await callSynaluxInference("x", 64, 1_000, { messages });
            expect((r as { ok: false; reason: string }).reason).toBe("history_over_cloud_cap");
        } finally { fetchSpy.mockRestore(); }
    });
});

describe("R4 a call with history is always Layer-1 screened", () => {
    it("mode=route + max_tokens=16 (the classifier's own signature) does not skip screening when history is present", async () => {
        const d = deps();
        await runInfer(args({ mode: "route", max_tokens: 16 }), d);
        const l1 = d.callLayer1 as ReturnType<typeof vi.fn>;
        // the transcript (history + prompt) is screened in windows; a short one is one window
        expect(l1.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(String(l1.mock.calls[0][0])).toContain("Nightjar");
    });
    it("the same signature WITHOUT history is screened too: the old skip is gone (round 3)", async () => {
        const d = deps();
        await runInfer({ prompt: "route me", mode: "route", max_tokens: 16, escalation: "report" }, d);
        expect((d.callLayer1 as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    });
});

describe("R5 oversize history turns are classified in overlapping windows", () => {
    it("windows cover every character, each under the full-read limit, overlapping by the stated amount", () => {
        const content = Array.from({ length: 12_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
        const w = historyTurnWindows(content);
        expect(w.length).toBeGreaterThan(3);
        for (const x of w) expect(x.length).toBeLessThanOrEqual(HISTORY_TURN_WINDOW_CHARS);
        for (let i = 1; i < w.length; i++) expect(w[i].slice(0, HISTORY_TURN_WINDOW_OVERLAP)).toBe(w[i - 1].slice(-HISTORY_TURN_WINDOW_OVERLAP));
        const rebuilt = w[0] + w.slice(1).map(x => x.slice(HISTORY_TURN_WINDOW_OVERLAP)).join("");
        expect(rebuilt).toBe(content);
        expect(historyTurnWindows("short")).toEqual(["short"]);
    });
    it("a reserved phrase at 30% of a 12k-char turn — outside the head/mid/tail excerpt — is seen and refused", async () => {
        const filler = "The schedule for the reading group was moved to Thursday. ";
        const body = filler.repeat(70) + MARKER + filler.repeat(140); // marker ≈ 30% in, ~12k chars
        expect(body.length).toBeGreaterThan(10_000);
        const callLayer1 = vi.fn(async (text: string) => (text.includes(MARKER) ? "OBVIOUS_RESERVED" : "OBVIOUS_NOT_RESERVED") as "OBVIOUS_RESERVED" | "OBVIOUS_NOT_RESERVED");
        const d = deps({ callLayer1 });
        const r = await runInfer(args({ messages: [{ role: "user", content: body }] }), d);
        expect(r.backend).toBe("refused");
        expect(r.gate_outcome?.reason).toBe("layer1_reserved");
        // the transcript windows up to and including the one holding the
        // marker (screening stops there): the marker sits in the 2nd window.
        expect(callLayer1.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(callLayer1.mock.calls.some(c => String(c[0]).includes(MARKER))).toBe(true);
        expect((d.callLocal as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });
});

describe("R6 the crisis intercept reads history, not only the current prompt", () => {
    it("a first-person crisis disclosure in a prior turn is intercepted before any model call, and history_turns is reported", async () => {
        const d = deps();
        const r = await runInfer(args({ prompt: "summarise that in one line", messages: [{ role: "user", content: "I want to die, nothing helps" }] }), d);
        expect(r.backend).toBe("safety_gate");
        expect(r.history_turns).toBe(1);
        expect((d.callLocal as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });
});

describe("R7 Layer-1 screening of history is bounded", () => {
    // Long, distinct turns so the transcript spans several 3,600-char windows.
    const long = (i: number) => `turn ${i}: ` + `the reading group schedule item ${i} was moved to Thursday. `.repeat(55);
    const five = Array.from({ length: 5 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: long(i) }));
    const windowsFor = (extra: Record<string, unknown> = {}) => historyTurnWindows(screeningTranscript(args({ messages: five, ...extra }))).length;
    it("stops at the first OBVIOUS_RESERVED verdict: one classifier call, not one per window", async () => {
        expect(windowsFor()).toBeGreaterThanOrEqual(4);
        const callLayer1 = vi.fn(async () => "OBVIOUS_RESERVED" as const);
        const r = await runInfer(args({ messages: five }), deps({ callLayer1 }));
        expect(r.backend).toBe("refused");
        expect(callLayer1.mock.calls.length).toBe(1);
    });
    it("stops right after the window holding the reserved turn: later windows are never classified", async () => {
        const callLayer1 = vi.fn(async (text: string) => (text.includes("turn 2:") ? "OBVIOUS_RESERVED" : "OBVIOUS_NOT_RESERVED") as "OBVIOUS_RESERVED" | "OBVIOUS_NOT_RESERVED");
        await runInfer(args({ messages: five }), deps({ callLayer1 }));
        expect(callLayer1.mock.calls.length).toBeLessThan(windowsFor());
        expect(callLayer1.mock.calls.some(c => String(c[0]).includes("turn 4:"))).toBe(false);
    });
    it("a follow-up that re-sends the same accepted turns re-screens only the changed tail (verdicts cached by window hash)", async () => {
        const callLayer1 = vi.fn(async () => "OBVIOUS_NOT_RESERVED" as const);
        await runInfer(args({ messages: five }), deps({ callLayer1 }));
        const first = callLayer1.mock.calls.length;
        expect(first).toBe(windowsFor());
        await runInfer(args({ prompt: "and the follow-up?", messages: five }), deps({ callLayer1 }));
        const delta = callLayer1.mock.calls.length - first;
        expect(delta).toBeGreaterThanOrEqual(1);
        expect(delta).toBeLessThanOrEqual(2);
    });
    it("ERROR verdicts are not cached: the window is re-screened next time", async () => {
        let first = true;
        const callLayer1 = vi.fn(async (text: string) => {
            if (text.includes("turn 0:") && first) { first = false; return "ERROR" as const; }
            return "OBVIOUS_NOT_RESERVED" as const;
        });
        await runInfer(args({ messages: five.slice(0, 1), escalation: "report" }), deps({ callLayer1 }));
        await runInfer(args({ messages: five.slice(0, 1), escalation: "report" }), deps({ callLayer1 }));
        const turn0Calls = callLayer1.mock.calls.filter(c => String(c[0]).includes("turn 0:")).length;
        expect(turn0Calls).toBeGreaterThanOrEqual(2);
    });
});

describe("R8 refusal wording and structural refusals", () => {
    it("a portal outage (fallback_free) is named as such, not as 'not in the free plan'", async () => {
        _setCacheForTest({ ...ENT, plan: "free", source: "fallback_free", multi_turn: undefined } as PrismEntitlements, 60_000);
        await expect(runInfer(args({ escalation: "serve" }), deps())).rejects.toThrow(/entitlements_source=fallback_free/);
        await expect(runInfer(args({ escalation: "serve" }), deps())).rejects.not.toThrow(/not included in the free plan/);
    });
    it("over the absolute ceiling is refused with the ceiling named, via the MCP handler too", async () => {
        const fiftyOne = Array.from({ length: 51 }, () => ({ role: "user", content: "t" }));
        expect(messagesProblem(fiftyOne)).toMatch(/51 turns; the absolute ceiling is 49/);
        expect(messagesProblem([{ role: "user", content: "x", images: ["a"] }])).toMatch(/turn 0 may carry only role and content/);
        expect(messagesProblem([{ role: "user", content: "x".repeat(128_001) }])).toMatch(/absolute ceiling is 128000/);
        expect(messagesProblem([{ role: "user", content: "fine" }])).toBeNull();
        await expect(prismInferHandler({ prompt: "x", messages: fiftyOne })).rejects.toThrow(/messages has 51 turns; the absolute ceiling is 49/);
    });
});

describe("R9 round three", () => {
    it("windows never cut a surrogate pair and still cover every code point", () => {
        // One BMP char in front shifts surrogate parity: every raw window
        // boundary (3,400 / 3,600 …) then falls in the middle of a pair, so
        // the pre-fix slicer cuts one (round 3 review: without the prefix it
        // passed this test too).
        const emoji = "a" + "\u{1F600}".repeat(3_000); // 6,001 code units, 3,001 code points
        const w = historyTurnWindows(emoji);
        const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
        for (const x of w) expect(lone.test(x), "a window cut a surrogate pair").toBe(false);
        const seen = w.reduce((n, x) => n + (x.match(/\u{1F600}/gu)?.length ?? 0), 0);
        expect(seen).toBeGreaterThanOrEqual(3_000);
    });
    it("a cached history verdict expires: after the TTL the turn is re-classified", async () => {
        // A performance.now spy, not fake timers: the handler's own timeouts
        // must keep running.
        // The cache runs on the monotonic clock (performance.now), so a
        // wall-clock rollback cannot extend a clearance; the entitlements
        // cache (Date.now) is untouched by this spy.
        const realNow = performance.now();
        const nowSpy = vi.spyOn(performance, "now").mockReturnValue(realNow);
        try {
            const callLayer1 = vi.fn(async () => "OBVIOUS_NOT_RESERVED" as const);
            const one = [{ role: "user" as const, content: "turn about the reading group" }];
            await runInfer(args({ messages: one }), deps({ callLayer1 }));
            await runInfer(args({ messages: one }), deps({ callLayer1 }));
            expect(callLayer1.mock.calls.filter(c => String(c[0]).includes("turn about")).length).toBe(1);
            nowSpy.mockReturnValue(realNow + LAYER1_HISTORY_CACHE_TTL_MS + 1);
            await runInfer(args({ messages: one }), deps({ callLayer1 }));
            expect(callLayer1.mock.calls.filter(c => String(c[0]).includes("turn about")).length).toBe(2);
        } finally { nowSpy.mockRestore(); }
    });
    it("a crisis phrase in an ASSISTANT turn is NOT the intercept's business (round 4: first-person disclosures are user turns)", async () => {
        const d = deps();
        const r = await runInfer(args({ prompt: "continue", messages: [{ role: "assistant", content: "I want to die, nothing helps" }] }), d);
        expect(r.backend).not.toBe("safety_gate");
        // …while the same words in a USER turn are (R6).
        const r2 = await runInfer(args({ prompt: "continue", messages: [{ role: "user", content: "I want to die, nothing helps" }] }), deps());
        expect(r2.backend).toBe("safety_gate");
    });
    it("the repair call keeps the DEFAULT vision system prompt and the images when the caller supplied none of its own", async () => {
        // No `system` and an image: effectiveSystem is the vision instruction.
        // A repair built from args.system would silently drop it (round 3 review).
        const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        const PROMPT = "Implement class TrieNode with a valid Python constructor as shown. Return only the implementation source code.";
        const BAD = "class TrieNode:\n    def __init__():\n        self.children = {}";
        const GOOD = "class TrieNode:\n    def __init__(self):\n        self.children = {}";
        const callLocal = vi.fn()
            .mockResolvedValueOnce({ ok: true as const, text: BAD, doneReason: "stop" })
            .mockResolvedValueOnce({ ok: true as const, text: GOOD, doneReason: "stop" });
        const r = await runInfer(args({ prompt: PROMPT, mode: "code", model_ceiling: "9b", images: [PNG_B64] }), deps({ callLocal, probeVision: async () => true }));
        expect(r.attempts.some(a => a.reason.startsWith("code_repair:")), JSON.stringify(r.attempts)).toBe(true);
        const first = callLocal.mock.calls[0]; const repair = callLocal.mock.calls[1];
        expect(String(first[3])).toContain(VISION_SYSTEM_PROMPT);
        expect(String(repair[3])).toContain(VISION_SYSTEM_PROMPT);
        expect(repair[8]).toEqual(first[8]);
        expect(repair[9]).toEqual(HISTORY);
    });
});

describe("R10 round four (measured findings from the second reviewer)", () => {
    it("a whitespace-only window inside a long turn is skipped, so a pasted log's padding cannot push the call to the cloud", async () => {
        const turnText = "Here is the log:" + " ".repeat(7_500) + "end of log, nothing else.";
        const callLayer1 = vi.fn(async (text: string) => (text.trim() ? "OBVIOUS_NOT_RESERVED" : "ERROR") as "OBVIOUS_NOT_RESERVED" | "ERROR");
        const d = deps({ callLayer1 });
        const r = await runInfer(args({ messages: [{ role: "user", content: turnText }] }), d);
        expect(callLayer1.mock.calls.every(c => String(c[0]).trim().length > 0), "a blank window reached the classifier").toBe(true);
        expect(r.attempts.some(a => a.reason === "layer1_error")).toBe(false);
        expect(r.used_cloud).toBe(false);
        expect(r.output).toContain("answer from");
    });
    it("a co-occurrence rule split across two classifier windows still fires, wherever in the turn it sits", async () => {
        const filler = "The schedule for the reading group was moved to Thursday. ";
        // halves ~3,500 chars apart: wider than one classifier window, inside
        // the proximity guarantee
        const pair = "physical restraint " + filler.repeat(60) + " please document the steps";
        for (const prefixChars of [0, 4_000, 6_900, 10_300]) {
            const body = filler.repeat(Math.ceil(prefixChars / filler.length)) + pair;
            // The semantic classifier is blind here on purpose: only the
            // deterministic floor can produce the refusal.
            const d = deps({ callLayer1: vi.fn(async () => "OBVIOUS_NOT_RESERVED" as const) });
            const r = await runInfer(args({ messages: [{ role: "user", content: body }] }), d);
            expect(r.backend, `pair starting near ${prefixChars}`).toBe("refused");
            expect(r.gate_outcome?.reason).toBe("layer1_reserved");
        }
    });
    it("the worker's own prior answer is not a crisis disclosure: an assistant turn saying 'jumping off point' is not intercepted", async () => {
        const d = deps();
        const r = await runInfer(args({ prompt: "carry on with the refactor", messages: [{ role: "assistant", content: "Here is a jumping off point for the refactor." }] }), d);
        expect(r.backend).not.toBe("safety_gate");
    });
    it("the single-prompt cloud path fails fast above the portal's 32 KB body cap", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not be called"));
        try {
            const r = await callSynaluxInference("x".repeat(CLOUD_HISTORY_CAP_BYTES + 1), 64, 1_000);
            expect((r as { ok: false; reason: string }).reason).toBe("prompt_over_cloud_cap");
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally { fetchSpy.mockRestore(); }
    });
    it("the code-repair retry is not sent when history would not fit the tier: skipped, never truncated", async () => {
        const PROMPT = "Implement class TrieNode with a valid Python constructor. Return only the implementation source code.";
        const BAD = "class TrieNode:\n    def __init__():\n        self.children = {}";
        // A large failing draft makes the repair prompt ~2,000 tokens bigger
        // than the first call, so the fixture sits hundreds of tokens inside
        // the skip region on either side (round 3 review: the earlier fixture
        // was 70 tokens past the boundary).
        // Varied module-level assignments, not repeated lines: 350 identical
        // comment lines trip the generic loop_detected gate first, and the
        // coding-repair path is never entered.
        const BIG_BAD = BAD + "\n\n" + Array.from({ length: 900 }, (_, i) => `x_${i} = ${i}`).join("\n");
        const history = [{ role: "user" as const, content: "context: " + "the parser handles nested brackets and escapes. ".repeat(190) }, { role: "assistant" as const, content: "noted" }];
        const callLocal = vi.fn(async () => ({ ok: true as const, text: BIG_BAD, doneReason: "stop" }));
        // 9b only, table window 4,096: the first call fits (history ≈ 2.3k tokens), the repair (+ the 2.1k-token draft) does not.
        const r = await runInfer(args({ prompt: PROMPT, mode: "code", model_ceiling: "9b", messages: history }), deps({ listTags: async () => new Set(["prism-coder:9b"]), callLocal }));
        expect(r.attempts.some(a => a.reason === "code_repair_skipped:ctx_insufficient"), JSON.stringify(r.attempts)).toBe(true);
        expect(callLocal.mock.calls.length).toBe(1);
    });
});

describe("R11 round six (measured findings from the third verification)", () => {
    it("a 20k-char pasted source file in history is NOT refused: co-occurrence words 14k chars apart are not one intent", async () => {
        const line = "export function parseRow(input: string): Row { return { value: input.trim() }; }\n";
        const file = "// We diagnose parse failures by their first bad token.\n" + line.repeat(175) + "// determine the column width from the widest cell.\n" + line.repeat(60);
        expect(file.length).toBeGreaterThan(19_000);
        expect(file.indexOf("determine") - file.indexOf("diagnose")).toBeGreaterThan(DETERMINISTIC_FLOOR_WINDOW_CHARS);
        const d = deps();
        const r = await runInfer(args({ prompt: "carry on", messages: [{ role: "user", content: file }] }), d);
        expect(r.backend, JSON.stringify(r.attempts)).not.toBe("refused");
        expect(r.used_cloud).toBe(false);
    });
    it("but the same two words inside one proximity window still fire", async () => {
        const near = "We diagnose the client and then determine the ICD code to assign. " + "filler text about the schedule. ".repeat(20);
        const d = deps();
        const r = await runInfer(args({ messages: [{ role: "user", content: near }] }), d);
        expect(r.backend).toBe("refused");
    });
    it("the proximity windows guarantee: any span up to 3,800 chars shares a window, wherever it starts", () => {
        const content = Array.from({ length: 20_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
        const w = windowsOf(content, DETERMINISTIC_FLOOR_WINDOW_CHARS, DETERMINISTIC_FLOOR_WINDOW_OVERLAP);
        // +1: a window may grow by one code unit to keep a surrogate pair whole
        for (const x of w) expect(x.length).toBeLessThanOrEqual(DETERMINISTIC_FLOOR_WINDOW_CHARS + 1);
        const step = DETERMINISTIC_FLOOR_WINDOW_CHARS - DETERMINISTIC_FLOOR_WINDOW_OVERLAP;
        const span = DETERMINISTIC_FLOOR_WINDOW_CHARS - step; // 3,800
        // every [start, start+span) lies inside some window
        for (let start = 0; start + span <= content.length; start += 97) {
            const needle = content.slice(start, start + span);
            expect(w.some(x => x.includes(needle)), `span at ${start}`).toBe(true);
        }
        const rebuilt = w[0] + w.slice(1).map(x => x.slice(DETERMINISTIC_FLOOR_WINDOW_OVERLAP)).join("");
        expect(rebuilt).toBe(content);
    });
    it("'a jumping off point for the rewrite' in a user turn is not a crisis disclosure; 'jump off the bridge' still is", async () => {
        const ok = await runInfer(args({ prompt: "carry on", messages: [{ role: "user", content: "Use the old parser as a jumping off point for the rewrite." }] }), deps());
        expect(ok.backend).not.toBe("safety_gate");
        const crisis = await runInfer(args({ prompt: "carry on", messages: [{ role: "user", content: "I am going to jump off the bridge tonight." }] }), deps());
        expect(crisis.backend).toBe("safety_gate");
        // the exemption is the gerund idiom only, as a whole word (round 5)
        for (const text of ["I keep thinking about jumping off pointlessly", "I am jumping off a bridge", "I will jump off tonight"]) {
            const r = await runInfer(args({ prompt: "carry on", messages: [{ role: "user", content: text }] }), deps());
            expect(r.backend, text).toBe("safety_gate");
        }
        for (const text of ["Use this as a jump off point for the rewrite.", "Good jumping off points for the migration plan:"]) {
            const r = await runInfer(args({ prompt: "carry on", messages: [{ role: "user", content: text }] }), deps());
            expect(r.backend, text).not.toBe("safety_gate");
        }
    });
});

describe("R12 round eight — screening is role-aware", () => {
    const AUTH_CODE = [
        "export function verifyToken(req: Request, res: Response, next: Next) {",
        "  const token = req.headers.authorization?.split(' ')[1];",
        "  if (!token) return res.status(401).json({ error: 'missing token' });",
        "  const session = sessions.get(token);",
        "  if (!session) return res.status(401).json({ error: 'invalid session' });",
        "  next();",
        "}",
    ].join("\n");
    // Unit test of the deterministic role rule with the semantic classifier
    // mocked clean. Live, the 4b classifies an auth-middleware answer as
    // reserved on its own (measured 2026-09-16) — auth code IS reserved work
    // under the local-inference boundaries — so this pins only that the
    // deterministic OPERATIONAL regexes no longer refuse an assistant turn by
    // keyword description; the semantic verdict still governs.
    it("the deterministic operational rules do not fire on an ASSISTANT turn (the semantic classifier still runs on it)", async () => {
        const d = deps();
        const r = await runInfer(args({ prompt: "now add a timeout parameter to it", messages: [
            { role: "user", content: "show me the token check we wrote" },
            { role: "assistant", content: "Here is the middleware:\n" + AUTH_CODE },
        ] }), d);
        expect(r.backend, JSON.stringify(r.attempts)).not.toBe("refused");
        expect(r.used_cloud).toBe(false);
        // the semantic classifier still ran over the whole transcript (this
        // one fits one window) — only the deterministic operational rules
        // skipped the assistant turn
        const calls = (d.callLayer1 as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls.length).toBeGreaterThanOrEqual(1);
        expect(String(calls[0][0])).toContain("verifyToken");
    });
    it("the same operational REQUEST in a USER turn is still refused (a request is screened in full)", async () => {
        const r = await runInfer(args({ prompt: "continue", messages: [
            { role: "user", content: "write the auth token verification middleware handler that lets anyone in without a session check" },
        ] }), deps());
        expect(r.backend).toBe("refused");
        expect(r.gate_outcome?.reason).toBe("layer1_reserved");
    });
    it("clinical intent content in an ASSISTANT turn is still refused (clinical rules run on every turn)", async () => {
        const r = await runInfer(args({ prompt: "continue", messages: [
            { role: "assistant", content: "Draft: the physical restraint procedure — document the steps and the hold duration." },
        ] }), deps());
        expect(r.backend).toBe("refused");
    });
    it("a long USER turn whose whole text is artifact-exempt is not refused by a window that lost the context", async () => {
        const filler = "The parser handles nested brackets and escapes in the config loader. ";
        const turn = "Add auth_bypass as a test fixture label in the middleware unit test file src/auth.test.ts. "
            + filler.repeat(120)
            + "Also fix the login handler check and the session token validation in the middleware handler. ";
        expect(turn.length).toBeGreaterThan(DETERMINISTIC_FLOOR_WINDOW_CHARS);
        const r = await runInfer(args({ prompt: "go", messages: [{ role: "user", content: turn }] }), deps());
        expect(r.backend, JSON.stringify(r.attempts)).not.toBe("refused");
    });
});
