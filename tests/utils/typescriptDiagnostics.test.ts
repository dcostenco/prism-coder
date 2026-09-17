/**
 * Real type checking for generated TypeScript, plus the AST rule.
 *
 * Every fixture here is a defect a model actually produced during multi-turn
 * benchmarking, or a correct counterpart that must not be flagged. The
 * false-positive cases matter more than the true positives: a gate that fails
 * correct code gets switched off, and then catches nothing at all.
 */
import { describe, it, expect } from "vitest";
import {
    typecheckSnippet,
    findDeferredMutationReturnedSync,
    analyzeTypeScript,
} from "../../src/utils/typescriptDiagnostics.js";

describe("it indicts the snippet", () => {
    it("finds a generic with no type argument (TS2314)", () => {
        expect(typecheckSnippet("const m: Map<string, Array> = new Map();"))
            .toContain("bare_generic");
    });

    it("finds optional chaining on the left of an assignment (TS2779)", () => {
        // The defect that defeated the regex gate: a doubly-linked-list splice.
        const code = `
export class N { prev: N | null = null; next: N | null = null; }
export function unlink(node: N, head: N): void {
  node.next?.prev = head;
}`;
        expect(typecheckSnippet(code)).toContain("optional_chain_assignment");
    });

    it("finds a return value that does not match its declared type (TS2322)", () => {
        const code = `
export function settle(fns: Array<() => unknown>): Promise<void> {
  return Promise.allSettled(fns.map(f => f()));
}`;
        expect(typecheckSnippet(code)).toContain("type_not_assignable");
    });

    it("finds an implicitly any parameter under strict (TS7006)", () => {
        expect(typecheckSnippet("export const f = (xs: Array<number>) => xs.map(x => x);"))
            .not.toContain("implicit_any_param");
        expect(typecheckSnippet("export function g(cb): void { cb(); }"))
            .toContain("implicit_any_param");
    });
});

describe("it never reports what is merely missing context", () => {
    for (const [label, code] of [
        ["an unresolved import", `import { thing } from "./nowhere.js";\nexport const x = thing;`],
        ["an undeclared global", "export const id = crypto.randomUUID();"],
        ["console, absent from the es2022 lib", 'export function log(): void { console.log("hi"); }'],
        ["a name the fragment never declares", "export const y: SomeExternalType = null!;"],
    ] as const) {
        it(`stays silent on ${label}`, () => {
            expect(typecheckSnippet(code), code).toEqual([]);
        });
    }

    it("does not let a lib type shadow the snippet's own class", () => {
        // Measured while building this: checking against the DOM lib made a
        // snippet's own `Node` class collide with the DOM's, producing twelve
        // phantom errors. The default lib is es2022 WITHOUT the DOM for exactly
        // this reason.
        const code = `
export class Node<K, V> {
  constructor(public key: K, public value: V) {}
}
export const n = new Node<string, number>("a", 1);`;
        expect(typecheckSnippet(code)).toEqual([]);
    });
});

describe("correct code produces nothing", () => {
    for (const [label, code] of [
        ["a generic container", `export class Box<T> {
  private items: Array<T> = [];
  add(item: T): void { this.items.push(item); }
  all(): ReadonlyArray<T> { return this.items; }
}`],
        ["a properly typed async method", `export async function runAll(fns: Array<() => Promise<void>>): Promise<void> {
  await Promise.all(fns.map(f => f()));
}`],
        ["a guarded pointer splice", `export class N { prev: N | null = null; next: N | null = null; }
export function unlink(node: N, head: N): void {
  if (node.next) { node.next.prev = head; }
}`],
        ["settled results returned honestly", `export function settle(fns: Array<() => unknown>): Promise<Array<PromiseSettledResult<unknown>>> {
  return Promise.allSettled(fns.map(f => f()));
}`],
    ] as const) {
        it(`stays clean on ${label}`, () => {
            expect(analyzeTypeScript(code), label).toEqual([]);
        });
    }
});

describe("a value mutated in a callback and returned synchronously", () => {
    const BUGGY = `
export class E {
  private ls: Array<Function> = [];
  emit(...args: Array<unknown>): number {
    let count = 0;
    for (const l of this.ls) {
      const r = l(...args);
      if (r instanceof Promise) { r.then(() => count++); } else { count++; }
    }
    return count;
  }
}`;

    it("catches the counter that never counts — no type checker expresses this", () => {
        // From the first multi-turn benchmark: three listeners, two async,
        // emit() returned 1 because .then() runs after the return.
        expect(findDeferredMutationReturnedSync(BUGGY))
            .toContain("deferred_mutation_returned_sync");
    });

    it("catches the setTimeout form", () => {
        expect(findDeferredMutationReturnedSync(
            "export function f(): number { let n = 0; setTimeout(() => { n += 1; }, 0); return n; }",
        )).toContain("deferred_mutation_returned_sync");
    });

    it("is quiet when the work is awaited before returning", () => {
        expect(findDeferredMutationReturnedSync(`
export async function emit(ls: Array<() => Promise<void>>): Promise<number> {
  let count = 0;
  await Promise.all(ls.map(async (l) => { await l(); count++; }));
  return count;
}`)).toEqual([]);
    });

    it("is quiet when the deferred mutation is not the returned value", () => {
        expect(findDeferredMutationReturnedSync(`
export function emit(p: Promise<void>): number {
  let count = 0;
  let logged = 0;
  p.then(() => { logged++; });
  count++;
  return count;
}`)).toEqual([]);
    });

    it("does not attribute an inner function's deferred mutation to its caller", () => {
        // Pins the function-boundary scan. Without it, `count++` inside `inner`
        // is credited to `outer`, whose own `count` is never deferred-mutated —
        // a false positive on correct code. Found by mutation: removing the
        // boundary check left every other test green.
        expect(findDeferredMutationReturnedSync(`
export function outer(): number {
  let count = 0;
  function inner(p: Promise<void>): void {
    let count = 0;
    p.then(() => count++);
  }
  inner(Promise.resolve());
  return count;
}`)).toEqual([]);
    });

    it("is quiet on ordinary synchronous counting", () => {
        expect(findDeferredMutationReturnedSync(`
export function emit(ls: Array<() => void>): number {
  let count = 0;
  for (const l of ls) { l(); count++; }
  return count;
}`)).toEqual([]);
    });
});

describe("analyzeTypeScript combines both and stays ordered", () => {
    it("reports a type error and the AST finding together", () => {
        const both = `
export class E {
  private ls: Array<Function> = [];
  emitAsync(): Promise<void> {
    return Promise.allSettled(this.ls.map(l => l()));
  }
  emit(): number {
    let count = 0;
    for (const l of this.ls) { const r = l(); if (r instanceof Promise) { r.then(() => count++); } }
    return count;
  }
}`;
        const found = analyzeTypeScript(both);
        expect(found).toContain("type_not_assignable");
        expect(found).toContain("deferred_mutation_returned_sync");
        expect([...found].sort()).toEqual(found);
    });
});

describe("attacking the allowlist from the other direction", () => {
    /**
     * Round 1 of adversarial review on the checker itself. Two findings, both
     * the failure the allowlist was supposed to prevent, arriving by routes the
     * allowlist did not anticipate.
     */

    it("does not blame the snippet for an implicit any caused by an unresolved import", () => {
        // Correct Express. `req` is implicitly any ONLY because a fragment
        // cannot resolve `express`. Reporting it indicts the harness.
        expect(typecheckSnippet(`
import express from "express";
const app = express();
app.get("/", (req, res) => { res.send("hi"); });`)).toEqual([]);
    });

    it("still reports an implicit any when nothing failed to resolve", () => {
        // The conditional must not silence the real case: no imports, so there
        // is nothing to blame but the code.
        expect(typecheckSnippet("export function g(cb): void { cb(); }"))
            .toContain("implicit_any_param");
    });

    it("reports a parse failure, which no missing library can explain", () => {
        for (const broken of [
            "export class Broken { m(): void { return; ",
            "export const x: number = ;",
            "export function f( { return 1; }",
        ]) {
            expect(typecheckSnippet(broken), broken).toEqual(["syntax_error"]);
        }
    });

    it("does not consult semantics of a file that never parsed", () => {
        // An unparseable file produces garbage semantic diagnostics — the
        // unclosed-paren case emits TS2391/TS7010/TS2300/TS2842 alongside the
        // real TS1005. Only the parse failure is reported.
        expect(typecheckSnippet("export function f( { return 1; }")).toEqual(["syntax_error"]);
    });

    it("is quiet when a model shows a before and an after block", () => {
        // Blocks are joined before checking, so the same class can be declared
        // twice. Duplicate-identifier is a context failure, not a defect.
        expect(typecheckSnippet(`
class Cache { get(k: string): string { return k; } }

class Cache { get(k: string): string | undefined { return undefined; } }`)).toEqual([]);
    });

    it("is quiet assigning to a type that comes from an unresolved import", () => {
        expect(typecheckSnippet(`
import type { Config } from "./config.js";
export const c: Config = { anything: true };`)).toEqual([]);
    });
});

describe("a parse failure indicts only what was meant as code", () => {
    /**
     * Round 2 of adversarial review. Adding `syntax_error` made the UNFENCED
     * path dangerous: prose that happens to contain a type annotation is
     * classified as TypeScript, fails to parse, and the whole answer is
     * rejected. That is a rejection of a CORRECT answer, the worst class of
     * false positive, and it did not exist before syntax reporting was added.
     *
     * A fenced block was meant as code, so failing to parse indicts it.
     * Unfenced text is ambiguous, so it must not. Ambiguity favours the caller.
     */
    for (const prose of [
        "The function takes a value: string and returns a formatted result.",
        "Declare it as `private total: number` and initialise it before the loop.",
        "Each handler receives a payload: string that it must not mutate.",
    ]) {
        it(`does not call prose a syntax error: "${prose.slice(0, 44)}"`, () => {
            expect(typecheckSnippet(prose, false), prose).toEqual([]);
        });
    }

    it("still reports a fenced block that does not parse", () => {
        expect(typecheckSnippet("export function fmt(v: number): string { return v.toFixed(2);", true))
            .toEqual(["syntax_error"]);
    });

    it("still finds real defects in UNFENCED code that parses", () => {
        // The fenced flag must gate only parse failures. Unfenced code that
        // parses is still checked, or the whole unfenced path goes blind.
        expect(typecheckSnippet("const m: Map<string, Array> = new Map();", false))
            .toContain("bare_generic");
    });

    it("defaults to treating input as fenced", () => {
        // Callers that do not know are treated as code; the gate passes the
        // real answer from extractCode.
        expect(typecheckSnippet("export const x: number = ;")).toEqual(["syntax_error"]);
    });
});
