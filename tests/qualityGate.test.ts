import { describe, it, expect } from "vitest";
import { passesQualityGate, TOOL_CALL_BLEED_RE } from "../src/utils/qualityGate.js";

describe("passesQualityGate", () => {
    it("passes normal response", () => {
        expect(passesQualityGate("The answer is 42.", false).pass).toBe(true);
    });

    it("fails empty response", () => {
        const r = passesQualityGate("", false);
        expect(r.pass).toBe(false);
        expect(r.reason).toBe("empty_response");
    });

    it("fails near-empty response", () => {
        expect(passesQualityGate("Hi", false).pass).toBe(false);
    });

    it("fails think-only", () => {
        const r = passesQualityGate("", true);
        expect(r.pass).toBe(false);
        expect(r.reason).toBe("think_only");
    });

    it("fails hard truncation", () => {
        const r = passesQualityGate("Some partial response that was cut", false, "length");
        expect(r.pass).toBe(false);
        expect(r.reason).toBe("hard_truncation");
    });

    it("fails loop detection", () => {
        const repeated = "The answer is always the same. ".repeat(7);
        const r = passesQualityGate(repeated, false);
        expect(r.pass).toBe(false);
        expect(r.reason).toBe("loop_detected");
    });

    it("passes response with finish_reason=stop", () => {
        expect(passesQualityGate("Valid response here.", false, "stop").pass).toBe(true);
    });

    it("passes code with balanced braces (no false positive)", () => {
        const code = "function sort(arr) {\n  return arr.sort();\n}";
        expect(passesQualityGate(code, false).pass).toBe(true);
    });

    it("does NOT false-positive on refusal text (no regex gate)", () => {
        expect(passesQualityGate("I cannot stress this enough: always use TypeScript.", false).pass).toBe(true);
    });

    it("does NOT false-positive on code with repeated patterns in fenced blocks", () => {
        const trieCode = [
            "Here's a Trie implementation:",
            "```python",
            "class Trie:",
            "    def insert(self, word):",
            "        node = self.root",
            "        for char in word:",
            "            node = node.children[char]",
            "",
            "    def search(self, word):",
            "        node = self.root",
            "        for char in word:",
            "            node = node.children[char]",
            "",
            "    def starts_with(self, prefix):",
            "        node = self.root",
            "        for char in prefix:",
            "            node = node.children[char]",
            "",
            "    def _get_node(self, key):",
            "        node = self.root",
            "        for char in key:",
            "            node = node.children[char]",
            "```",
        ].join("\n");
        const r = passesQualityGate(trieCode, false);
        expect(r.pass).toBe(true);
    });

    it("still detects loops in prose outside code blocks", () => {
        const loopyProse = "```python\nprint('ok')\n```\n" +
            "The model is working. ".repeat(7);
        const r = passesQualityGate(loopyProse, false);
        expect(r.pass).toBe(false);
        expect(r.reason).toBe("loop_detected");
    });

    it("does NOT false-positive on markdown tables with repeated headers", () => {
        const bip = [
            "# Goal 1: Manding",
            "| Component | Details |",
            "|-----------|---------|",
            "| Baseline | 2/10 opportunities |",
            "",
            "# Goal 2: Tacting",
            "| Component | Details |",
            "|-----------|---------|",
            "| Baseline | 3/10 opportunities |",
            "",
            "# Goal 3: Listener Responding",
            "| Component | Details |",
            "|-----------|---------|",
            "| Baseline | 1/10 opportunities |",
            "",
            "# Goal 4: Social Skills",
            "| Component | Details |",
            "|-----------|---------|",
            "| Baseline | 0/10 opportunities |",
        ].join("\n");
        expect(passesQualityGate(bip, false).pass).toBe(true);
    });

    it("does NOT false-positive on repeated markdown headings in clinical templates", () => {
        const sessionNote = [
            "# Session Notes",
            "## Goal 1: AAC Manding",
            "### Intervention",
            "DTT with AAC device, 5-second delay prompting.",
            "### Response",
            "Client initiated 4/5 requests independently.",
            "### Progress",
            "80% accuracy, up from 60% baseline.",
            "## Goal 2: Following Instructions",
            "### Intervention",
            "Natural environment teaching with visual supports.",
            "### Response",
            "Client followed 3/5 two-step instructions.",
            "### Progress",
            "60% accuracy, stable from last session.",
            "## Goal 3: Peer Play",
            "### Intervention",
            "Structured play with peer model and reinforcement.",
            "### Response",
            "Client initiated 2 interactions during 15-min play.",
            "### Progress",
            "Improvement from 0 initiations at baseline.",
        ].join("\n");
        expect(passesQualityGate(sessionNote, false).pass).toBe(true);
    });

    it("does NOT false-positive on bold list labels repeated across template sections", () => {
        const crisisProtocol = [
            "# Client A: SIB",
            "*   **De-escalation:**",
            "Redirect client to sensory tools. Maintain calm voice.",
            "*   **Environment Modifications:**",
            "Pad hard surfaces. Remove sharp objects from area.",
            "*   **Crisis Response:**",
            "If injury occurs, apply first aid. Document in incident log.",
            "",
            "# Client B: Aggression",
            "*   **De-escalation:**",
            "Give space. Offer choices. Use visual timer.",
            "*   **Environment Modifications:**",
            "Separate seating areas. Clear breakable items.",
            "*   **Crisis Response:**",
            "Ensure safety of other clients. Document and notify supervisor.",
            "",
            "# Client C: Elopement",
            "*   **De-escalation:**",
            "Verbal prompts to return. Offer preferred activity.",
            "*   **Environment Modifications:**",
            "Door alarms active. GPS tracker charged.",
            "*   **Crisis Response:**",
            "Follow elopement protocol. Call 911 if not located in 5 min.",
            "",
            "# Client D: Pica",
            "*   **De-escalation:**",
            "Redirect to safe oral stimulation items.",
            "*   **Environment Modifications:**",
            "Lock cleaning supplies. Regular floor sweeps.",
            "*   **Crisis Response:**",
            "If ingestion suspected, call Poison Control. Document item.",
        ].join("\n");
        expect(passesQualityGate(crisisProtocol, false).pass).toBe(true);
    });

    // ── Signal 5: tool_call_bleed (R8) ───────────────────────────────────────

    it("tool_call_bleed: pipe-delimited format fails the gate", () => {
        const bleed = '<|tool_call|>{"name":"aac_route","arguments":{"phrase":"help"}}<|tool_call_end|>';
        const r = passesQualityGate(bleed, false);
        expect(r.pass).toBe(false);
        expect(r.reason).toBe("tool_call_bleed");
    });

    it("tool_call_bleed: <|tool_call_end|> alone fails the gate", () => {
        const r = passesQualityGate("Some output <|tool_call_end|>", false);
        expect(r.pass).toBe(false);
        expect(r.reason).toBe("tool_call_bleed");
    });

    it("tool_call_bleed: does NOT false-positive on prose mentioning 'tool call'", () => {
        const prose = "The model emits a tool call token when routing to AAC.";
        expect(passesQualityGate(prose, false).pass).toBe(true);
    });

    it("tool_call_bleed: does NOT false-positive on angle-bracket <tool_call> (normalized variant, not pipe)", () => {
        const angleVariant = '<tool_call>\n{"name":"x","arguments":{}}\n</tool_call>';
        // angle-bracket variant is handled by normalizeToolCallFormat, NOT gated as a failure
        expect(passesQualityGate(angleVariant, false).pass).toBe(true);
    });

    it("TOOL_CALL_BLEED_RE: exported regex matches pipe format only", () => {
        expect(TOOL_CALL_BLEED_RE.test("<|tool_call|>")).toBe(true);
        expect(TOOL_CALL_BLEED_RE.test("<|tool_call_end|>")).toBe(true);
        expect(TOOL_CALL_BLEED_RE.test("<tool_call>")).toBe(false);
        expect(TOOL_CALL_BLEED_RE.test("tool call")).toBe(false);
    });

    it("still catches real prose loops even with headings present", () => {
        const loopyWithHeadings = [
            "# Analysis",
            "The client needs more support. The intervention was effective.",
            "The client needs more support. The intervention was effective.",
            "The client needs more support. The intervention was effective.",
            "The client needs more support. The intervention was effective.",
            "The client needs more support. The intervention was effective.",
            "The client needs more support. The intervention was effective.",
            "The client needs more support. The intervention was effective.",
        ].join("\n");
        const r = passesQualityGate(loopyWithHeadings, false);
        expect(r.pass).toBe(false);
        expect(r.reason).toBe("loop_detected");
    });

    // ── Loop evasion hardening (Pass B: full-text, threshold ≥5) ─────────

    it("catches egregious loop hidden inside fake code block (≥5 repeats)", () => {
        const fakeCodeLoop = [
            "Here is the answer to your question about the topic:",
            "Let me explain in detail below.",
            "```",
            "The solution is to restart the service and clear the cache.",
            "The solution is to restart the service and clear the cache.",
            "The solution is to restart the service and clear the cache.",
            "The solution is to restart the service and clear the cache.",
            "The solution is to restart the service and clear the cache.",
            "The solution is to restart the service and clear the cache.",
            "The solution is to restart the service and clear the cache.",
            "The solution is to restart the service and clear the cache.",
            "The solution is to restart the service and clear the cache.",
            "The solution is to restart the service and clear the cache.",
            "```",
        ].join("\n");
        const r = passesQualityGate(fakeCodeLoop, false);
        expect(r.pass).toBe(false);
        expect(r.reason).toBe("loop_detected");
    });

    it("does NOT false-positive on code with 4 repeated patterns (below threshold)", () => {
        const legitimateCode = [
            "```python",
            "class Trie:",
            "    def insert(self, word):",
            "        node = self.root",
            "    def search(self, word):",
            "        node = self.root",
            "    def starts_with(self, prefix):",
            "        node = self.root",
            "    def _get_node(self, key):",
            "        node = self.root",
            "```",
        ].join("\n");
        expect(passesQualityGate(legitimateCode, false).pass).toBe(true);
    });

    it("catches loop wrapped in markdown heading evasion (≥5 full-text)", () => {
        const headingEvasion = Array.from({ length: 6 }, (_, i) =>
            `# Section ${i}\nThe model cannot answer this question at this time.`
        ).join("\n");
        const r = passesQualityGate(headingEvasion, false);
        expect(r.pass).toBe(false);
        expect(r.reason).toBe("loop_detected");
    });

    // ── Signal 2: mode-aware empty floor (R9) ────────────────────────────────
    // Route mode returns short classification labels — they are valid, not empty.

    it("route: 'P1' (2 chars) passes the gate (not empty_response)", () => {
        const r = passesQualityGate("P1", false, undefined, "route");
        expect(r.pass).toBe(true);
    });

    it("route: 'YES' (3 chars) passes the gate", () => {
        expect(passesQualityGate("YES", false, undefined, "route").pass).toBe(true);
    });

    it("route: 'GO' (2 chars) passes the gate", () => {
        expect(passesQualityGate("GO", false, undefined, "route").pass).toBe(true);
    });

    it("route: 'CO4' (3 chars) passes the gate", () => {
        expect(passesQualityGate("CO4", false, undefined, "route").pass).toBe(true);
    });

    it("route: empty string still fails (empty_response)", () => {
        const r = passesQualityGate("", false, undefined, "route");
        expect(r.pass).toBe(false);
        expect(r.reason).toBe("empty_response");
    });

    it("route: whitespace-only still fails (empty_response)", () => {
        const r = passesQualityGate("   ", false, undefined, "route");
        expect(r.pass).toBe(false);
        expect(r.reason).toBe("empty_response");
    });

    it("code: 'Hi' (2 chars) still fails the gate (threshold <5 preserved)", () => {
        const r = passesQualityGate("Hi", false, undefined, "code");
        expect(r.pass).toBe(false);
        expect(r.reason).toBe("empty_response");
    });

    it("code: 'DONE' (4 chars) still fails the gate (code threshold preserved)", () => {
        const r = passesQualityGate("DONE", false, undefined, "code");
        expect(r.pass).toBe(false);
        expect(r.reason).toBe("empty_response");
    });

    it("route: bleed check still fires on short bleed output", () => {
        const r = passesQualityGate("<|tool_call|>x<|tool_call_end|>", false, undefined, "route");
        expect(r.pass).toBe(false);
        expect(r.reason).toBe("tool_call_bleed");
    });

    it("no mode (default): 'Hi' fails — backward-compatible with code/chat callers", () => {
        expect(passesQualityGate("Hi", false).pass).toBe(false);
    });
});
