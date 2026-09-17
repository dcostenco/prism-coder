/**
 * TypeScript static-contract check: a generic used with no type argument.
 *
 * prism-coder:9b emits `Map<string, Array>` repeatedly — observed in four
 * separate generations of the same EventEmitter task, including through the
 * live MCP server. It is TS2314, a hard compile error, so nothing it writes
 * builds. The coding gate carried three static passes for Python and none for
 * TypeScript, so this shipped every time.
 *
 * Detection needs no TypeScript dependency, which matters: `typescript` is not
 * a declared dependency of this package and adding it costs 23 MB. The repair
 * was verified against real 9b output — one substitution and the file compiles
 * clean under `--strict`.
 */
import { describe, it, expect } from "vitest";
import {
    passesCodingQualityGate,
    applyDeterministicCodingRepairs,
} from "../src/utils/codingQualityPolicy.js";

const REQUEST = "Write a typed EventEmitter class in TypeScript with on, emit and off.";

/** Verbatim prism-coder:9b output, captured live through the MCP server. */
const REAL_9B = `\`\`\`typescript
export class EventEmitter {
  private listeners: Map<string, Array> = new Map();

  on(event: string, listener: Function) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(listener);
  }

  emit(event: string, ...args: any[]) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}
\`\`\``;

describe("a bare generic in a type position is a finding", () => {
    it("catches the defect the 9b actually emits", () => {
        const r = passesCodingQualityGate(REQUEST, REAL_9B);
        expect(r.pass).toBe(false);
        expect(r.reason).toBe("ts_static_contract:bare_generic");
    });

    for (const [label, code] of [
        ["inside a type-argument list", "const m: Map<string, Array> = new Map();"],
        ["after a type annotation", "let xs: Array = [];"],
        ["as a field type", "class A { private s: Set; }"],
        ["nested in a second argument", "const m = new Map<string, Set>();"],
        ["a bare Promise return", "function f(): Promise { return null as any; }"],
        ["a bare Record", "const r: Record = {};"],
    ] as const) {
        it(`catches a bare generic ${label}`, () => {
            const r = passesCodingQualityGate(REQUEST, "```ts\n" + code + "\n```");
            expect(r.reason, code).toBe("ts_static_contract:bare_generic");
        });
    }
});

describe("it does not fire on correct code or on prose", () => {
    for (const [label, code] of [
        ["a parameterised Map and Array", "const m: Map<string, Array<Function>> = new Map();"],
        ["a parameterised Promise", "async function f(): Promise<void> {}"],
        ["a parameterised Record", "const r: Record<string, number> = {};"],
        ["generic type parameters of its own", "class E<T extends Record<string, any>> { }"],
        ["prose naming the types", "// Return the Array, then the Map."],
        ["a comment listing collections", "/* Set; Map; Array */ const x: number = 1;"],
        ["a string containing a type name", 'const s: string = "Array, Map";'],
    ] as const) {
        it(`stays quiet on ${label}`, () => {
            const r = passesCodingQualityGate(REQUEST, "```ts\n" + code + "\n```");
            expect(r.reason, code).not.toBe("ts_static_contract:bare_generic");
        });
    }
});

describe("the deterministic repair", () => {
    const REASON = "ts_static_contract:bare_generic";

    it("parameterises the bare generic the 9b wrote", () => {
        const out = applyDeterministicCodingRepairs(REAL_9B, REASON);
        expect(out.changes).toContain("bare_generic");
        expect(out.output).toContain("Map<string, Array<any>>");
    });

    it("uses any rather than unknown, so existing uses keep compiling", () => {
        // `unknown` trades one compile error for several at every use site.
        const out = applyDeterministicCodingRepairs("const m: Map<string, Array> = new Map();", REASON);
        expect(out.output).toContain("Array<any>");
        expect(out.output).not.toContain("Array<unknown>");
    });

    it("leaves the repaired output clean on a second pass", () => {
        const once = applyDeterministicCodingRepairs(REAL_9B, REASON).output;
        const twice = applyDeterministicCodingRepairs(once, REASON);
        expect(twice.changes).toEqual([]);
        expect(twice.output).toBe(once);
        expect(once).not.toContain("Array<any><any>");
    });

    it("re-passes the gate after repair", () => {
        const repaired = applyDeterministicCodingRepairs(REAL_9B, REASON).output;
        expect(passesCodingQualityGate(REQUEST, repaired).reason).not.toBe(REASON);
    });

    it("changes nothing else in the file", () => {
        const repaired = applyDeterministicCodingRepairs(REAL_9B, REASON).output;
        for (const kept of ["export class EventEmitter", "on(event: string", "emit(event: string", "listener(...args)"]) {
            expect(repaired, kept).toContain(kept);
        }
    });

    it("does not touch code when the reason is a different contract", () => {
        const out = applyDeterministicCodingRepairs(REAL_9B, "python_static_contract:dict_keys_unpack");
        expect(out.changes).toEqual([]);
        expect(out.output).toBe(REAL_9B);
    });

    it("reports no change when there is nothing to repair", () => {
        const clean = "```ts\nconst m: Map<string, Array<number>> = new Map();\n```";
        expect(applyDeterministicCodingRepairs(clean, REASON).changes).toEqual([]);
    });
});

describe("the check is scoped to implementation requests", () => {
    it("does not judge prose answers that merely discuss types", () => {
        const r = passesCodingQualityGate(
            "Explain the difference between Array and Set in TypeScript.",
            "An Array, unlike a Set, keeps duplicates and preserves order.",
        );
        expect(r.pass).toBe(true);
    });
});

describe("the repair is scoped to code, and never to values", () => {
    const REASON = "ts_static_contract:bare_generic";

    it("does not rewrite a string literal — that is a value, not a type", () => {
        // Found in adversarial review. The first version rewrote
        // `"use Map<string, Array> carefully"`, silently changing what the
        // program prints. A repair that alters runtime behaviour is not a repair.
        const src = [
            "```ts",
            'const doc: string = "use Map<string, Array> carefully";',
            "const m: Map<string, Array> = new Map();",
            "```",
        ].join("\n");
        const out = applyDeterministicCodingRepairs(src, REASON);
        expect(out.output).toContain('"use Map<string, Array> carefully"');
        expect(out.output).toContain("const m: Map<string, Array<any>> = new Map();");
        expect(out.changes).toContain("bare_generic");
    });

    it("leaves prose outside the fences alone, including sentences about the defect", () => {
        // "Do not write Map<string, Array>" must not become
        // "Do not write Map<string, Array<any>>", which inverts the sentence.
        const src = [
            "Do not write Map<string, Array> — it fails to compile.",
            "",
            "```ts",
            "const m: Map<string, Array> = new Map();",
            "```",
        ].join("\n");
        const out = applyDeterministicCodingRepairs(src, REASON);
        expect(out.output).toContain("Do not write Map<string, Array> — it fails to compile.");
        expect(out.output).toContain("const m: Map<string, Array<any>> = new Map();");
    });

    it("repairs unfenced output, where the whole answer is the code", () => {
        const out = applyDeterministicCodingRepairs("const m: Map<string, Array> = new Map();", REASON);
        expect(out.output).toContain("Array<any>");
    });

    it("parameterises a nested bare generic at the right depth", () => {
        const out = applyDeterministicCodingRepairs(
            "```ts\nconst m: Map<string, Array<Map<string, Set>>> = new Map();\n```",
            REASON,
        );
        expect(out.output).toContain("Map<string, Array<Map<string, Set<any>>>>");
    });

    it("does not touch a template literal containing a type name", () => {
        const src = "```ts\nconst msg = `avoid Map<string, Array> here`;\nconst m: Map<string, Array> = new Map();\n```";
        const out = applyDeterministicCodingRepairs(src, REASON);
        expect(out.output).toContain("`avoid Map<string, Array> here`");
        expect(out.output).toContain("const m: Map<string, Array<any>> = new Map();");
    });
});

describe("round 4: the repair stays inside TypeScript, and out of comments", () => {
    const REASON = "ts_static_contract:bare_generic";

    it("does not rewrite a comment warning against the defect", () => {
        // An apostrophe in "don't" broke the string scan, so comments slipped
        // through and `// don't use a bare Map<string, Array>` was rewritten
        // into advice to write exactly that.
        const src = [
            "```ts",
            "// don't use a bare Map<string, Array> here",
            "const m: Map<string, Array> = new Map();",
            "```",
        ].join("\n");
        const out = applyDeterministicCodingRepairs(src, REASON);
        expect(out.output).toContain("// don't use a bare Map<string, Array> here");
        expect(out.output).toContain("const m: Map<string, Array<any>> = new Map();");
    });

    it("leaves a non-TypeScript fence alone in a multi-language answer", () => {
        const src = [
            "```python",
            "d = {}  # Map<string, Array> in a docstring",
            "```",
            "```ts",
            "const m: Map<string, Array> = new Map();",
            "```",
        ].join("\n");
        const out = applyDeterministicCodingRepairs(src, REASON);
        expect(out.output).toContain("# Map<string, Array> in a docstring");
        expect(out.output).toContain("const m: Map<string, Array<any>> = new Map();");
    });

    it("repairs an indented fence inside a list item", () => {
        const src = "1. Example:\n\n   ```ts\n   const m: Map<string, Array> = new Map();\n   ```";
        expect(applyDeterministicCodingRepairs(src, REASON).output).toContain("Array<any>");
    });

    it("repairs an unclosed fence rather than giving up", () => {
        const src = "```ts\nconst m: Map<string, Array> = new Map();";
        expect(applyDeterministicCodingRepairs(src, REASON).output).toContain("Array<any>");
    });

    it("repairs a fence with no language tag", () => {
        const src = "```\nconst m: Map<string, Array> = new Map();\n```";
        expect(applyDeterministicCodingRepairs(src, REASON).output).toContain("Array<any>");
    });
});
