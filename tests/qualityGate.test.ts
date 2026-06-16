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
});
