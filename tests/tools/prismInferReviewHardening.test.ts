/**
 * Pre-merge adversarial review of multi-turn (2026-09-16): each test here
 * failed on the code it guards before the fix landed.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import {
    runInfer,
    prismInferHandler,
    messagesProblem,
    _resetLayer1HistoryCacheForTest,
    callSynaluxInference,
    portalFlattenedTranscript,
    historyTurnWindows,
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
        expect(l1.mock.calls.length).toBe(1 + HISTORY.length);
    });
    it("the same signature WITHOUT history keeps skipping (the classifier's recursion guard is unchanged)", async () => {
        const d = deps();
        await runInfer({ prompt: "route me", mode: "route", max_tokens: 16, escalation: "report" }, d);
        expect((d.callLayer1 as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
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
        const r = await runInfer(args({ messages: [{ role: "assistant", content: body }] }), d);
        expect(r.backend).toBe("refused");
        expect(r.gate_outcome?.reason).toBe("layer1_reserved");
        // prompt + the windows up to and including the one holding the marker
        // (screening stops there): the marker sits in the 2nd or 3rd window.
        expect(callLayer1.mock.calls.length).toBeGreaterThanOrEqual(3);
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
    const five = Array.from({ length: 5 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `turn ${i} about the reading group schedule` }));
    it("stops at the first OBVIOUS_RESERVED verdict: a reserved current prompt costs one classifier call, not six", async () => {
        const callLayer1 = vi.fn(async () => "OBVIOUS_RESERVED" as const);
        const r = await runInfer(args({ prompt: MARKER, messages: five }), deps({ callLayer1 }));
        expect(r.backend).toBe("refused");
        expect(callLayer1.mock.calls.length).toBe(1);
    });
    it("stops right after the reserved turn: turns 0-1 clean, turn 2 reserved → 4 calls, never 6", async () => {
        const callLayer1 = vi.fn(async (text: string) => (text.startsWith("turn 2") ? "OBVIOUS_RESERVED" : "OBVIOUS_NOT_RESERVED") as "OBVIOUS_RESERVED" | "OBVIOUS_NOT_RESERVED");
        await runInfer(args({ messages: five }), deps({ callLayer1 }));
        expect(callLayer1.mock.calls.length).toBe(1 + 3);
    });
    it("a follow-up that re-sends the same accepted turns re-screens only the new prompt (verdicts cached by hash)", async () => {
        const callLayer1 = vi.fn(async () => "OBVIOUS_NOT_RESERVED" as const);
        await runInfer(args({ messages: five }), deps({ callLayer1 }));
        expect(callLayer1.mock.calls.length).toBe(1 + 5);
        await runInfer(args({ prompt: "and the follow-up?", messages: five }), deps({ callLayer1 }));
        expect(callLayer1.mock.calls.length).toBe(1 + 5 + 1);
    });
    it("ERROR verdicts are not cached: the turn is re-screened next time", async () => {
        let first = true;
        const callLayer1 = vi.fn(async (text: string) => {
            if (text.startsWith("turn 0") && first) { first = false; return "ERROR" as const; }
            return "OBVIOUS_NOT_RESERVED" as const;
        });
        await runInfer(args({ messages: five.slice(0, 1), escalation: "report" }), deps({ callLayer1 }));
        await runInfer(args({ messages: five.slice(0, 1), escalation: "report" }), deps({ callLayer1 }));
        const turn0Calls = callLayer1.mock.calls.filter(c => String(c[0]).startsWith("turn 0")).length;
        expect(turn0Calls).toBe(2);
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
        expect(messagesProblem(fiftyOne)).toMatch(/51 turns; the absolute ceiling is 50/);
        expect(messagesProblem([{ role: "user", content: "x", images: ["a"] }])).toMatch(/turn 0 may carry only role and content/);
        expect(messagesProblem([{ role: "user", content: "x".repeat(128_001) }])).toMatch(/absolute ceiling is 128000/);
        expect(messagesProblem([{ role: "user", content: "fine" }])).toBeNull();
        await expect(prismInferHandler({ prompt: "x", messages: fiftyOne })).rejects.toThrow(/messages has 51 turns; the absolute ceiling is 50/);
    });
});
