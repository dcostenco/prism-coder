import { describe, expect, it, vi } from "vitest";
import {
    inferStructuredResult,
    runInfer,
    type InferDeps,
    type PrismInferArgs,
} from "../../src/tools/prismInferHandler.js";
import { checkOutputSafety } from "../../src/utils/safetyGate.js";
import type { PrismEntitlements } from "../../src/utils/entitlements.js";

/**
 * output_origin's rules are documented once, on PrismInferResult.output_origin (src/tools/prismInferHandler.ts). Each
 * case below drives runInfer down one path and checks the label it gets. One case also shows why `attempts` cannot
 * stand in for the field: the output-safety check replaces a single-turn answer without recording an attempt.
 */

const GB = 1024 ** 3;
const ENTITLEMENTS: PrismEntitlements = {
    plan: "enterprise",
    model_ceiling: "27b",
    daily_infer_limit: 100_000,
    max_tokens: 4_096,
    max_seats: 25,
    features: {
        cloud_fallback: true,
        grounding_verifier: true,
        knowledge_search_unlimited: true,
        session_memory_unlimited: true,
        analytics_dashboard: true,
    },
    upgrade_url: "https://synalux.ai/pricing",
};

const CODE_PROMPT = "Implement class TrieNode with a valid Python constructor. Return only the implementation source code.";
const BAD_DRAFT = "class TrieNode:\n    def __init__():\n        self.children = {}";
const GOOD_DRAFT = "class TrieNode:\n    def __init__(self):\n        self.children = {}";
// A constructor attribute missing its receiver: Prism adds `self.` itself, with no second model call.
const STATIC_BAD_DRAFT = "class TrieNode:\n    def __init__(self):\n        self.children = {}\n        active = False\n\n"
    + "    def is_active(self):\n        return self.active";
// A draft the output-safety check replaces.
const UNSAFE_ANSWER = "The memo prohibits physical restraint.";

function args(extra: Partial<PrismInferArgs> = {}): PrismInferArgs {
    return { prompt: CODE_PROMPT, mode: "code", model_ceiling: "9b", escalation: "report", cloud_fallback: false, ...extra };
}

function deps(overrides: Partial<InferDeps> = {}): InferDeps {
    return {
        freemem: () => 16 * GB,
        listTags: async () => new Set(["prism-coder:9b"]),
        listLoaded: async () => new Set<string>(),
        callLocal: vi.fn(async () => ({ ok: true as const, text: GOOD_DRAFT })),
        callCloud: vi.fn(async () => ({ ok: true, output: GOOD_DRAFT, backend: "gemini-3.6-flash" })),
        ollamaUrl: "http://127.0.0.1:11434",
        entitlements: ENTITLEMENTS,
        callLayer1: vi.fn(async () => "OBVIOUS_NOT_RESERVED" as const),
        ...overrides,
    };
}

describe("prism_infer output_origin", () => {
    it("code, a local answer that passes the gate: model, also in the structured result", async () => {
        const result = await runInfer(args(), deps());
        expect(result.output).toBe(GOOD_DRAFT);
        expect(result.output_origin).toBe("model");
        expect(inferStructuredResult(result).output_origin).toBe("model");
    });

    it("code, a bad draft, then a good answer to the repair prompt: repaired", async () => {
        const callLocal = vi.fn()
            .mockResolvedValueOnce({ ok: true as const, text: BAD_DRAFT })
            .mockResolvedValueOnce({ ok: true as const, text: GOOD_DRAFT });
        const result = await runInfer(args(), deps({ callLocal }));
        expect(callLocal).toHaveBeenCalledTimes(2);
        expect(result.output).toBe(GOOD_DRAFT);
        expect(result.output_origin).toBe("repaired");
        expect(inferStructuredResult(result).output_origin).toBe("repaired");
    });

    it("code, the repair prompt's answer repeats the bad draft: repaired", async () => {
        const callLocal = vi.fn(async () => ({ ok: true as const, text: BAD_DRAFT }));
        const result = await runInfer(args(), deps({ callLocal }));
        expect(callLocal.mock.calls.length).toBeGreaterThan(1);
        expect(result.output).toBe(BAD_DRAFT);
        expect(result.gate_outcome?.status).toBe("degraded");
        expect(result.output_origin).toBe("repaired");
    });

    it("code, the repair answer is cut off, the cloud fails, the kept draft is served: repaired", async () => {
        // A draft is kept for the cloud only when it failed on truncation or a loop. Here the repair prompt's answer
        // is cut off at its length limit: that repaired draft is kept, the cloud fails, and it is served degraded.
        const callLocal = vi.fn()
            .mockResolvedValueOnce({ ok: true as const, text: BAD_DRAFT })
            .mockResolvedValueOnce({ ok: true as const, text: GOOD_DRAFT, doneReason: "length" })
            .mockImplementation(async () => { throw new Error("an unmodelled third model call"); });
        const callCloud = vi.fn(async () => ({ ok: false as const, reason: "cloud_down" }));
        const result = await runInfer(args({ cloud_fallback: true }), deps({ callLocal, callCloud }));
        expect(callCloud).toHaveBeenCalled();
        expect(result.used_cloud).toBe(false);
        expect(result.gate_outcome?.status).toBe("degraded");
        expect(result.output_origin).toBe("repaired");
        expect(inferStructuredResult(result).output_origin).toBe("repaired");
    });

    it("chat, an answer with a thinking block: model; an answer that is only thinking: no origin", async () => {
        const thought = vi.fn(async () => ({ ok: true as const, text: "<think>considering</think>Hello there." }));
        const answered = await runInfer(args({ prompt: "Say hello.", mode: "chat" }), deps({ callLocal: thought }));
        expect(answered.output).toBe("Hello there.");
        expect(answered.output_origin).toBe("model");
        const onlyThinking = vi.fn(async () => ({ ok: true as const, text: "<think>considering</think>" }));
        const empty = await runInfer(args({ prompt: "Say hello.", mode: "chat" }), deps({ callLocal: onlyThinking }));
        expect(empty.output).toBe("");
        expect("output_origin" in empty).toBe(false);
        expect("output_origin" in inferStructuredResult(empty)).toBe(false);
    });

    it("chat with verify, the verifier returns other text: replaced; it returns the draft: model", async () => {
        const callLocal = vi.fn(async () => ({ ok: true as const, text: "Paris is the capital of France." }));
        const verifyArgs = args({ prompt: "What is the capital of France?", mode: "chat", verify: true,
            evidence: [{ source: "atlas.txt", content: "Paris is the capital of France." }] });
        const replacing = vi.fn(async () => ({ action: "refuse", finalText: "I cannot confirm that from the evidence.", claims: [], verifierChain: [] }));
        const replaced = await runInfer(verifyArgs, deps({ callLocal, callVerifier: replacing }));
        expect(replacing).toHaveBeenCalled();
        expect(replaced.output).toBe("I cannot confirm that from the evidence.");
        expect(replaced.output_origin).toBe("replaced");
        const keeping = vi.fn(async ({ draft }: { draft: string }) => ({ action: "accept", finalText: draft, claims: [], verifierChain: [] }));
        const kept = await runInfer(verifyArgs, deps({ callLocal, callVerifier: keeping }));
        expect(keeping).toHaveBeenCalled();
        expect(kept.output).toBe("Paris is the capital of France.");
        expect(kept.output_origin).toBe("model");
    });

    // No interpreter needed: the constructor-receiver check and its repair run in TypeScript.
    it("code, a constructor attribute without self: repaired", async () => {
        const callLocal = vi.fn()
            .mockResolvedValueOnce({ ok: true as const, text: STATIC_BAD_DRAFT })
            .mockImplementation(async () => { throw new Error("a second model call: the deterministic repair did not apply"); });
        const result = await runInfer(args(), deps({ callLocal }));
        expect(callLocal).toHaveBeenCalledTimes(1);
        expect(result.output).toContain("self.active = False");
        expect(result.attempts.map((attempt) => attempt.reason)).toContain("code_repair_deterministic:constructor_attribute_missing_receiver");
        expect(result.output_origin).toBe("repaired");
        expect(inferStructuredResult(result).output_origin).toBe("repaired");
    });

    it("chat, an answer the output-safety check rewrites: replaced, with no attempt recorded", async () => {
        expect(checkOutputSafety(UNSAFE_ANSWER)).not.toBe(UNSAFE_ANSWER);
        const callLocal = vi.fn(async () => ({ ok: true as const, text: UNSAFE_ANSWER }));
        const result = await runInfer(args({ prompt: "Summarize the memo in one sentence.", mode: "chat" }), deps({ callLocal }));
        expect(result.output).toBe(checkOutputSafety(UNSAFE_ANSWER));
        expect(result.attempts.map((attempt) => attempt.reason)).not.toContain("answer_check:replaced_by_output_safety");
        expect(result.output_origin).toBe("replaced");
        expect(inferStructuredResult(result).output_origin).toBe("replaced");
    });

    it("chat, a crisis prompt the input intercept answers: replaced, with no model call", async () => {
        const callLocal = vi.fn();
        const result = await runInfer(args({ prompt: "I want to kill myself tonight", mode: "chat" }), deps({ callLocal }));
        expect(result.backend).toBe("safety_gate");
        expect(callLocal).not.toHaveBeenCalled();
        expect(result.output_origin).toBe("replaced");
    });

    it("code, the local drafts fail and the cloud answers: model", async () => {
        const callLocal = vi.fn(async () => ({ ok: true as const, text: BAD_DRAFT }));
        const result = await runInfer(args({ cloud_fallback: true }), deps({ callLocal }));
        expect(result.used_cloud).toBe(true);
        expect(result.output_origin).toBe("model");
    });

    it("chat, a reserved prompt refused: no origin", async () => {
        const result = await runInfer(args({ mode: "chat", prompt: "hello there" }), deps({
            callLayer1: vi.fn(async () => "OBVIOUS_RESERVED" as const),
            callLocal: vi.fn(),
        }));
        expect(result.output).toBe("");
        expect(result.output_origin).toBeUndefined();
        expect("output_origin" in inferStructuredResult(result)).toBe(false);
    });
});
