import { describe, it, expect } from "vitest";
import { parseRouteOutput, applyLocalRouteContract } from "../../src/utils/routeContract.js";

/**
 * The route parser must accept the envelopes the fleet actually emits.
 *
 * Measured 2026-08-15 end-to-end through runInfer against a live
 * prism-coder:9b: the model opens with the PIPE marker and closes with the
 * ANGLE one —
 *
 *   <|tool_call|>\n{"name": "session_save_ledger", ...}\n</tool_call>
 *
 * parseRouteOutput detected the pipe START and then required the pipe END,
 * never considering a mixed pair, so a CORRECT tool call was classified
 * malformed and rewritten to "NO_TOOL" and served (gate_outcome degraded,
 * served_anyway: true). The caller sees no tool call at all.
 *
 * This is not cosmetic. Direct /api/chat measurement put the 9b at 95.7%
 * routing; through runInfer the same model on the same 115 cases scored 43.5%.
 * The entire gap was this parser. The 9b emits the other mixed form
 * (`</|tool_call|>`) when thinking is off, so both of its real shapes were
 * rejected while the two canonical pairs it does not emit were accepted.
 */

const BODY = '{"name": "session_save_ledger", "arguments": {"note": "x"}}';

describe("route contract accepts the envelopes models actually emit", () => {
    it("parses a pipe open closed by the angle marker", () => {
        const parsed = parseRouteOutput(`<|tool_call|>\n${BODY}\n</tool_call>`);
        expect(parsed.kind, "the 9b's thinking-on envelope was rejected").toBe("tool_call");
    });

    it("parses a pipe open closed by the slash-pipe marker", () => {
        const parsed = parseRouteOutput(`<|tool_call|>\n${BODY}\n</|tool_call|>`);
        expect(parsed.kind, "the 9b's thinking-off envelope was rejected").toBe("tool_call");
    });

    it("parses an angle open closed by the pipe marker", () => {
        const parsed = parseRouteOutput(`<tool_call>\n${BODY}\n<|tool_call_end|>`);
        expect(parsed.kind).toBe("tool_call");
    });

    it("still parses both canonical pairs", () => {
        expect(parseRouteOutput(`<|tool_call|>\n${BODY}\n<|tool_call_end|>`).kind).toBe("tool_call");
        expect(parseRouteOutput(`<tool_call>\n${BODY}\n</tool_call>`).kind).toBe("tool_call");
    });

    it("does not suppress a correctly-routed call", () => {
        const outcome = applyLocalRouteContract(`<|tool_call|>\n${BODY}\n</tool_call>`);
        expect(outcome.output, "a correct tool call was rewritten to NO_TOOL").not.toBe("NO_TOOL");
        expect(outcome.action).not.toBe("suppressed");
        expect(outcome.output).toContain("session_save_ledger");
    });

    // Tolerance must not become "accept anything" — a body that is not a valid
    // tool call still has to be suppressed, whatever brackets surround it.
    it("still rejects a malformed body inside a mixed envelope", () => {
        expect(parseRouteOutput('<|tool_call|>\n{"nam\n</tool_call>').kind).toBe("malformed");
    });

    it("still rejects an unopened envelope", () => {
        expect(parseRouteOutput(`${BODY}\n</tool_call>`).kind).toBe("malformed");
    });

    it("parses an unterminated envelope whose body is complete", () => {
        // Measured: the 9b emits `<|tool_call|> {...}` with no closing marker.
        const parsed = parseRouteOutput(`<|tool_call|> ${BODY}`);
        expect(parsed.kind, "a complete call without its terminator was rejected").toBe("tool_call");
    });

    it("still rejects an unterminated envelope that was CUT OFF", () => {
        // This is what makes accepting unterminated envelopes safe: a truncated
        // call leaves invalid JSON, so it cannot masquerade as a complete one.
        expect(parseRouteOutput('<|tool_call|> {"name": "session_save_led').kind).toBe("malformed");
        expect(parseRouteOutput('<|tool_call|> {"name": "x", "arguments": {"a"').kind).toBe("malformed");
    });

    it("leaves ordinary prose alone", () => {
        expect(parseRouteOutput("You could save that to the ledger.").kind).toBe("plain_text");
    });
});
