/**
 * The response header must report what history the call actually carried.
 *
 * PRISM_INFER_TOOL.description promises: "Every entitlement-resolved result
 * reports `multi_turn` (your plan's caps) and `history_turns` (what was sent)".
 * PrismInferResult.multi_turn's own doc says it rides "on every result, so the
 * host learns its budget from the first call instead of from a refusal".
 *
 * Neither reached the host. Both fields were set on the result and written to
 * the SQLite ledger, but `headerBase` never rendered them, so a caller had no
 * way to see what the model received.
 *
 * Measured cost, 2026-09-16: an agent benchmarked "prism multi-turn vs a cloud
 * model" over three turns, passed no `messages` at all, and published that the
 * 9b suffers "type regression at turn 2" and "architectural amnesia at turn 3".
 * The ledger showed history_turns NULL and prompt_tokens 44/42/45 on a run
 * whose first turn alone emitted 1,264 tokens. With history actually attached
 * the same model preserved the generic map. A visible `history_turns=0` on
 * each of those three responses would have caught it before it was written up.
 *
 * These assert the pure header formatter, so they cover the contract without
 * standing up Ollama.
 */
import { describe, it, expect } from "vitest";
import { inferResponseHeader, type PrismInferResult } from "../../src/tools/prismInferHandler.js";

const base: PrismInferResult = {
    output: "hi",
    backend: "ollama-9b",
    model_picked: "prism-coder:9b",
    ram_free_mb: 14_000,
    latency_ms: 1_234,
    used_cloud: false,
    attempts: [],
    plan: "enterprise",
};

const PAID = { enabled: true, max_turns: 30, max_chars: 96_000 };

describe("the response header reports the history the call carried", () => {
    it("names history_turns=0 when the caller sent no messages — the silent case that must not stay silent", () => {
        const h = inferResponseHeader({ ...base, history_turns: 0, multi_turn: PAID });
        expect(h).toContain("history_turns=0");
    });

    it("names the count when history was sent", () => {
        const h = inferResponseHeader({ ...base, history_turns: 2, multi_turn: PAID });
        expect(h).toContain("history_turns=2");
    });

    it("reports the plan's caps so the host learns its budget without provoking a refusal", () => {
        const h = inferResponseHeader({ ...base, history_turns: 0, multi_turn: PAID });
        expect(h).toContain("multi_turn=30/96000");
    });

    it("says off when the plan has no multi-turn, rather than printing caps that do not apply", () => {
        const h = inferResponseHeader({
            ...base,
            history_turns: 0,
            multi_turn: { enabled: false, max_turns: 12, max_chars: 32_000 },
        });
        expect(h).toContain("multi_turn=off");
        expect(h).not.toContain("12/32000");
    });

    it("omits both when entitlements never resolved — the crisis intercept reports only what was sent", () => {
        const h = inferResponseHeader({ ...base, backend: "safety_gate", history_turns: 3 });
        expect(h).toContain("history_turns=3");
        expect(h).not.toContain("multi_turn=");
    });

    it("keeps every field the header already carried", () => {
        const h = inferResponseHeader({
            ...base,
            history_turns: 0,
            multi_turn: PAID,
            prompt_tokens: 254,
            completion_tokens: 453,
        });
        for (const part of [
            "[prism_infer]",
            "backend=ollama-9b",
            "model=prism-coder:9b",
            "plan=enterprise",
            "free_ram=14000MB",
            "latency=1234ms",
            "used_cloud=false",
            "tokens=254in/453out",
        ]) {
            expect(h, part).toContain(part);
        }
    });

    it("still renders memory, gate and attempts as before", () => {
        const h = inferResponseHeader(
            {
                ...base,
                history_turns: 1,
                multi_turn: PAID,
                quality_gate_failed: true,
                attempts: [{ tier: "prism-coder:27b", reason: "ctx_insufficient" }],
            } as PrismInferResult,
            { project: "prism", depth: "standard" },
        );
        expect(h).toContain("quality_gate_failed=true");
        expect(h).toContain("memory=prism:standard");
        expect(h).toContain("ctx_insufficient");
    });
});
