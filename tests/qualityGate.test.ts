import { describe, it, expect } from "vitest";
import { passesQualityGate } from "../src/utils/qualityGate.js";

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
});
