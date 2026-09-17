/**
 * Real type checking for generated TypeScript, plus one AST rule a type checker
 * cannot express.
 *
 * The regex gate that shipped in 20.21.4 catches exactly one defect class
 * (TS2314, a generic with no type argument). The very next sample defeated it:
 * a doubly-linked-list splice written as `node.next?.prev = this.head`, which is
 * TS2779 and does not compile. Extending the regex per error code is an arms
 * race the compiler already wins.
 *
 * WHY THIS IS NOT JUST `tsc`. A generated snippet has no tsconfig, no resolved
 * imports, and no way to declare whether it targets the DOM or Node. Checking a
 * fragment therefore produces errors about the HARNESS rather than the code.
 * Measured while building this: checking one LRU cache against the DOM lib made
 * the snippet's own `Node` class collide with the DOM's, producing twelve
 * phantom errors beside the two real ones. A gate that fails correct code gets
 * switched off, so the design is an ALLOWLIST: a diagnostic is reported only if
 * its code appears in ALLOWED_CODES. That, and nothing else, is what prevents a
 * context failure from being reported as a defect.
 *
 * Two things that look load-bearing and are not — established by mutation, and
 * recorded so nobody trusts them for safety:
 *
 *   IGNORED_CODES does NOT filter anything. It marks codes already triaged as
 *   context failures, so the debug log can flag genuinely unclassified ones.
 *   Emptying it changes no reported finding.
 *
 *   The narrow default library (`lib.es2022.d.ts`, no DOM) is defence in depth,
 *   not protection. It was chosen after the DOM lib made a snippet's own `Node`
 *   class collide with the DOM's and produce twelve extra diagnostics — but all
 *   twelve were outside the allowlist, so none would have been reported anyway.
 *   No constructed case makes the library choice change a reported finding. It
 *   is kept because less noise and less work are both worth having.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { debugLog } from "./logger.js";

/** Semantic diagnostics that indict the SNIPPET. Each observed on real output. */
const ALLOWED_CODES = new Map<number, string>([
    [2314, "bare_generic"],               // Map<string, Array>
    [2779, "optional_chain_assignment"],  // node.next?.prev = x
    [2322, "type_not_assignable"],        // Promise<PromiseSettledResult[]> as Promise<void>
    [7006, "implicit_any_param"],         // (listener) => ... under strict — CONDITIONAL, see below
]);

/**
 * An implicit `any` only indicts the snippet once everything else resolved.
 *
 * `app.get("/", (req, res) => ...)` is correct Express, and `req` is implicitly
 * any ONLY because a fragment cannot resolve `express`. Reporting that blames
 * the harness. So TS7006 is suppressed whenever a module or name failed to
 * resolve — found by attacking the allowlist rather than by review.
 */
const CONDITIONAL_ON_RESOLUTION = 7006;
const RESOLUTION_FAILURE_CODES = new Set([2304, 2307, 2792, 2583]);

/**
 * Codes already triaged as context failures rather than defects.
 *
 * NOT a filter — the allowlist above is what decides what is reported. This
 * exists so the debug log can distinguish "known to be noise" from "never seen
 * before", which is how the allowlist gets extended from evidence.
 *
 * 2304/2583/2584 unresolved name, 2307 unresolved module, 2300 duplicate
 * identifier, 2315/2554 a snippet type shadowed by a lib type (the `Node`
 * collision), 6053 a lib file we did not serve, 2686/2695 UMD and expression
 * complaints that only make sense inside a real project.
 */
const IGNORED_CODES = new Set([2300, 2304, 2307, 2315, 2554, 2583, 2584, 2686, 2695, 2792, 6053]);

let tsModule: typeof import("typescript") | null | undefined;

/** Loaded once, synchronously, so the quality gate stays synchronous. */
function loadTypeScript(): typeof import("typescript") | null {
    if (tsModule !== undefined) return tsModule;
    try {
        tsModule = createRequire(import.meta.url)("typescript") as typeof import("typescript");
    } catch (e) {
        // A declared dependency, so this means a broken install. The regex floor
        // in codingQualityPolicy still runs; this enhancement simply does not.
        debugLog(`[ts-diagnostics] typescript unavailable: ${e instanceof Error ? e.message : e}`);
        tsModule = null;
    }
    return tsModule;
}

const libCache = new Map<string, string | undefined>();

function readLib(libDir: string, file: string): string | undefined {
    if (!libCache.has(file)) {
        try {
            libCache.set(file, readFileSync(join(libDir, file), "utf8"));
        } catch {
            libCache.set(file, undefined);
        }
    }
    return libCache.get(file);
}

/**
 * Allowed findings only, de-duplicated, stable order. Empty when unavailable.
 *
 * `fenced` says the text was inside a ``` block, i.e. the model MEANT it as
 * code. Only then is a parse failure attributable to the snippet. Unfenced
 * output is ambiguous: "the function takes a value: string and returns a
 * formatted result" is a sentence, and reporting it as a syntax error rejects a
 * correct answer. Ambiguity favours the caller.
 */
export function typecheckSnippet(code: string, fenced = true): string[] {
    const ts = loadTypeScript();
    if (!ts) return [];
    const libDir = dirname(createRequire(import.meta.url).resolve("typescript"));
    const name = "snippet.ts";

    const sourceOf = (file: string): string | undefined =>
        file === name ? code : readLib(libDir, file);

    const host: import("typescript").CompilerHost = {
        getSourceFile: (file) => {
            const text = sourceOf(file);
            return text === undefined
                ? undefined
                : ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
        },
        getDefaultLibFileName: () => "lib.es2022.d.ts",
        writeFile: () => { /* noEmit */ },
        getCurrentDirectory: () => "/",
        getCanonicalFileName: (file) => file,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => "\n",
        fileExists: (file) => sourceOf(file) !== undefined,
        readFile: sourceOf,
    };

    let syntactic: readonly import("typescript").Diagnostic[];
    let semantic: readonly import("typescript").Diagnostic[];
    try {
        const program = ts.createProgram([name], {
            strict: true,
            target: ts.ScriptTarget.ES2022,
            noEmit: true,
            types: [],
            skipLibCheck: true,
        }, host);
        syntactic = program.getSyntacticDiagnostics();
        semantic = program.getSemanticDiagnostics();
    } catch (e) {
        debugLog(`[ts-diagnostics] check failed: ${e instanceof Error ? e.message : e}`);
        return [];
    }

    // A parse failure needs no allowlist. Nothing about a missing library or an
    // unresolved import can make a brace go missing, so a syntactic diagnostic
    // always indicts the snippet. And once the file does not parse, the semantic
    // results describe a tree that was never valid, so they are not consulted.
    if (syntactic.length > 0) return fenced ? ["syntax_error"] : [];

    const unresolved = semantic.some(d => RESOLUTION_FAILURE_CODES.has(d.code));

    const found = new Set<string>();
    for (const d of semantic) {
        if (d.code === CONDITIONAL_ON_RESOLUTION && unresolved) continue;
        const name_ = ALLOWED_CODES.get(d.code);
        if (name_) found.add(name_);
        else if (!IGNORED_CODES.has(d.code)) {
            // Neither indicted nor excused. Logged so the lists can be extended
            // from evidence rather than guessed at; never reported as a finding,
            // because an unclassified code is exactly the kind that turns out to
            // be about the harness.
            debugLog(`[ts-diagnostics] unclassified TS${d.code}`);
        }
    }
    return [...found].sort();
}

const DEFERRED_METHOD = /^(then|catch|finally)$/;
const DEFERRED_FN = /^(setTimeout|setInterval|setImmediate|queueMicrotask)$/;

/**
 * A value mutated inside a promise or timer callback and then returned
 * synchronously by the enclosing function.
 *
 * Valid TypeScript, and wrong: the callback runs in a later microtask, so the
 * returned value never includes it. From the first multi-turn benchmark, where
 * `emit()` incremented its counter inside `result.then(() => count++)` and
 * returned 1 for three listeners. No type checker expresses this, but the AST
 * is already loaded, so the rule is nearly free.
 */
export function findDeferredMutationReturnedSync(code: string): string[] {
    const ts = loadTypeScript();
    if (!ts) return [];
    const sf = ts.createSourceFile("snippet.ts", code, ts.ScriptTarget.ES2022, true);
    const hits = new Set<string>();

    const insideDeferredCallback = (node: import("typescript").Node): boolean => {
        for (let p = node.parent; p; p = p.parent) {
            if (ts.isCallExpression(p)) {
                const callee = p.expression;
                if (ts.isPropertyAccessExpression(callee) && DEFERRED_METHOD.test(callee.name.text)) return true;
                if (ts.isIdentifier(callee) && DEFERRED_FN.test(callee.text)) return true;
            }
            // Stop at the enclosing function: a mutation in a sibling function
            // says nothing about this one's return value.
            if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) return false;
        }
        return false;
    };

    const inspect = (fn: import("typescript").Node): void => {
        const mutatedLate = new Set<string>();
        const returned = new Set<string>();
        const visit = (n: import("typescript").Node): void => {
            const target =
                (ts.isPostfixUnaryExpression(n) || ts.isPrefixUnaryExpression(n)) && ts.isIdentifier(n.operand)
                    ? n.operand.text
                    : ts.isBinaryExpression(n) && ts.isIdentifier(n.left) && [
                        ts.SyntaxKind.EqualsToken,
                        ts.SyntaxKind.PlusEqualsToken,
                        ts.SyntaxKind.MinusEqualsToken,
                    ].includes(n.operatorToken.kind)
                        ? n.left.text
                        : null;
            if (target && insideDeferredCallback(n)) mutatedLate.add(target);
            if (ts.isReturnStatement(n) && n.expression && ts.isIdentifier(n.expression)) {
                returned.add(n.expression.text);
            }
            // Do not descend into a NESTED named function or method: it has its
            // own scope and its own `count`, and `scan` visits it separately.
            // Without this, `inner`'s deferred mutation was credited to `outer`,
            // flagging correct code. Arrow functions and anonymous function
            // expressions ARE entered, because that is what a callback is.
            if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) return;
            ts.forEachChild(n, visit);
        };
        ts.forEachChild(fn, visit);
        for (const v of mutatedLate) if (returned.has(v)) hits.add(v);
        return;
    };

    const scan = (n: import("typescript").Node): void => {
        if (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) inspect(n);
        ts.forEachChild(n, scan);
    };
    ts.forEachChild(sf, scan);
    return hits.size ? ["deferred_mutation_returned_sync"] : [];
}

/** Every TypeScript finding for a snippet, type errors and the AST rule. */
export function analyzeTypeScript(code: string, fenced = true): string[] {
    return [...typecheckSnippet(code, fenced), ...findDeferredMutationReturnedSync(code)].sort();
}
