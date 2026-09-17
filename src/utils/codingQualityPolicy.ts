import { spawnSync } from "node:child_process";

/**
 * Coding quality policy for prism_infer.
 *
 * This is intentionally a high-precision rejection gate, not a style linter.
 * It catches objective signs that an implementation response is incomplete or
 * structurally broken. Task-specific compilation and tests remain the final
 * authority for correctness.
 */

export interface CodingQualityResult {
    pass: boolean;
    reason?: string;
}

export interface DeterministicCodingRepairResult {
    output: string;
    changes: string[];
}

interface RejectionPattern {
    reason: string;
    pattern: RegExp;
}

const IMPLEMENTATION_REQUEST_RE =
    /\b(?:implement|write|create|generate|complete|finish|fix)\b[\s\S]{0,160}\b(?:code|source|function|method|class|interface|struct|enum|implementation|algorithm|component|endpoint)\b/i;

const STRICT_SOURCE_REQUEST_RE =
    /\b(?:return|output|respond with)\s+only\s+(?:the\s+)?(?:implementation\s+)?(?:source\s+)?code\b/i;

const CODE_SHAPE_RE =
    /(?:^|\n)\s*(?:(?:export|public|private|protected|internal|open|pub|static|final|abstract|async)\s+)*(?:class|interface|struct|enum|function|def|func|fun|fn|type)\s+[A-Za-z_$][\w$]*|(?:^|\n)\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=|(?:^|\n)\s*(?:[A-Za-z_$][\w$:<>,.?*[\]&]*\s+)+[A-Za-z_$][\w$]*\s*\([^;\n]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:\{|=>)|=>\s*[{(]/m;

import { analyzeTypeScript } from "./typescriptDiagnostics.js";

export const INCOMPLETE_IMPLEMENTATION_PATTERNS: readonly RejectionPattern[] = [
    {
        reason: "code_placeholder",
        pattern: /\b(?:your code here|implementation goes here|insert implementation here)\b/i,
    },
    {
        reason: "code_placeholder",
        pattern: /\b(?:implementation|code)\s+(?:is\s+)?(?:omitted|left out|not shown)\b/i,
    },
    {
        reason: "code_placeholder",
        pattern: /\b(?:rest|remainder)\s+of\s+(?:the\s+)?(?:implementation|code)\b/i,
    },
    {
        reason: "code_placeholder",
        pattern: /(?:#|\/\/|\/\*+|\*)\s*(?:TODO|FIXME)\s*:?\s*(?:implement|complete|finish|add)\b/i,
    },
    {
        reason: "code_not_implemented",
        pattern: /\braise\s+NotImplementedError\b/,
    },
    {
        reason: "code_unfinished_reasoning",
        pattern: /(?:^|\n)\s*(?:#|\/\/|\/\*+|\*)?\s*(?:actually,?\s+)?(?:let me think|i need to (?:think|finish|complete)|to be continued)\b/i,
    },
] as const;

const REQUIRED_SYMBOL_PATTERNS: readonly RegExp[] = [
    /\b(?:implement|write|create|generate|complete)\s+(?:an?\s+)?(?:class|function|method|interface|struct|enum)\s+[`'"]?([A-Za-z_$][\w$]*)/gi,
    /\bimplement\s+[`'"]?([A-Za-z_$][\w$]*)\s*\(/gi,
] as const;

const PYTHON_CLASS_RE = /^(\s*)class\s+([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:/;
const PYTHON_FUNCTION_RE = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/;
const PYTHON_DIRECT_PRIVATE_CALL_RE = /\bself\.(_[A-Za-z_]\w*)\s*\(/g;
const PYTHON_METHOD_DECORATOR_RE = /^(\s*)@(staticmethod|classmethod)\b/;
const PYTHON_SIGNAL_RE =
    /```(?:python|py)\b|(?:^|\n)\s*(?:from\s+\S+\s+import|import\s+\S+|(?:async\s+)?def\s+|class\s+\w+.*:)/im;
const UNFENCED_PYTHON_START_RE =
    /^\s*(?:from\s+\S+\s+import|import\s+\S+|(?:async\s+)?def\s+|class\s+\w+)/i;
const TRAILING_PROSE_LINE_RE =
    /^(?!(?:async\s+def|def|class|from|import|return|raise|yield|assert|del|global|nonlocal|if|elif|else|for|while|try|except|finally|with|match|case)\b)(?![A-Za-z_]\w*\s*=)[A-Za-z][A-Za-z'’-]*:?(?:\s+(?:[A-Za-z][A-Za-z'’+/-]*|`[^`\r\n]+`|https?:\/\/\S+|\d[\w.,%()+\-]*|[+*=<>-])){2,}[.!?]$/;
const TRAILING_URL_LINE_RE = /^https?:\/\/\S+$/i;
const PYTHON_INVALID_DEF_RE =
    /(?:^|\n)\s*(?:async\s+)?def\s+[A-Za-z_]\w*\s*:/m;
const PYTHON_READY_SENTINEL = "PRISM_PYTHON_READY";
const PYTHON_AST_SCRIPT =
    `import ast,sys; print('${PYTHON_READY_SENTINEL}', flush=True); ` +
    "tree=ast.parse(sys.stdin.read()); compile(tree, '<prism-coding-gate>', 'exec')";
const PYTHON_COMMANDS = ["python3", "python"] as const;
const PYTHON_CHILDREN_KEYS_UNPACK_RE =
    /\bfor\s+[A-Za-z_]\w*\s*,\s*child(?:_node)?\s+in\s+(?:sorted\(\s*)?[A-Za-z_][\w.]*\.children\.keys\(\)\s*\)?\s*:/;

interface PythonScope {
    kind: "class" | "function";
    indent: number;
    classScope?: PythonClassScope;
}

interface PythonClassScope {
    hasBase: boolean;
    definedMethods: Set<string>;
    directPrivateCalls: Set<string>;
    supportsDynamicLookup: boolean;
}

interface MissingReceiverAssignment {
    lineIndex: number;
    name: string;
}

interface ExtractedCode {
    all: string;
    python?: string;
    /** Only TypeScript blocks. The analyzer must never be pointed at prose or at
     *  another language's code — an earlier repair edited a python block. */
    typescript?: string;
    hasFences: boolean;
}

/** Enough of a type-annotation or declaration signal to call a block TypeScript. */
const TS_SIGNAL_RE =
    /:\s*(?:string|number|boolean|void|any|unknown|never|Promise<)\b|\binterface\s+[A-Z]|\bexport\s+(?:class|interface|type|abstract)\b|\b(?:private|public|protected|readonly)\s+\w+\s*[:=]|<[A-Z]\w*(?:\s*,\s*[A-Z]\w*)*>/;

function extractUnfencedPythonCode(output: string): string | undefined {
    const lines = output.trim().split(/\r?\n/);
    const start = lines.findIndex((line) => UNFENCED_PYTHON_START_RE.test(line));
    if (start < 0) return undefined;

    let end = lines.length;
    for (let index = start + 1; index < lines.length; index++) {
        const line = lines[index];
        const previousLine = lines[index - 1];
        if (
            previousLine.trim().length === 0 &&
            indentation(line) === 0 &&
            (
                TRAILING_PROSE_LINE_RE.test(line.trim()) ||
                TRAILING_URL_LINE_RE.test(line.trim())
            )
        ) {
            end = index;
            break;
        }
    }

    const code = lines.slice(start, end).join("\n").trim();
    return code || undefined;
}

function extractCode(output: string): ExtractedCode {
    const blocks = [
        ...output.matchAll(/```([A-Za-z0-9_+#.-]+)?\s*\n([\s\S]*?)```/g),
    ].map((match) => ({
        language: match[1]?.toLowerCase(),
        code: match[2].trim(),
    })).filter((block) => block.code.length > 0);

    if (blocks.length === 0) {
        const python = extractUnfencedPythonCode(output);
        const bare = output.trim();
        return {
            all: bare,
            ...(python ? { python } : {}),
            ...(!python && TS_SIGNAL_RE.test(bare) ? { typescript: bare } : {}),
            hasFences: false,
        };
    }

    const pythonBlocks = blocks
        .filter((block) => (
            block.language === "python" ||
            block.language === "py" ||
            (!block.language && PYTHON_SIGNAL_RE.test(block.code))
        ))
        .map((block) => block.code);

    const tsBlocks = blocks
        .filter((block) => (
            block.language === "typescript" ||
            block.language === "ts" ||
            block.language === "tsx" ||
            (!block.language && TS_SIGNAL_RE.test(block.code))
        ))
        .map((block) => block.code);

    return {
        all: blocks.map((block) => block.code).join("\n\n"),
        ...(pythonBlocks.length > 0
            ? { python: pythonBlocks.join("\n\n") }
            : {}),
        ...(tsBlocks.length > 0 ? { typescript: tsBlocks.join("\n\n") } : {}),
        hasFences: true,
    };
}

function indentation(line: string): number {
    return line.match(/^\s*/)?.[0].replace(/\t/g, "    ").length ?? 0;
}

function pythonBlockEnd(lines: string[], start: number, blockIndent: number): number {
    let end = start + 1;
    while (end < lines.length) {
        const line = lines[end];
        if (line.trim() && indentation(line) <= blockIndent) break;
        end++;
    }
    return end;
}

function directBodyIndent(
    lines: string[],
    start: number,
    end: number,
): number | undefined {
    const indents = lines
        .slice(start + 1, end)
        .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
        .map(indentation);
    return indents.length > 0 ? Math.min(...indents) : undefined;
}

function findConstructorMissingReceiverAssignments(
    lines: string[],
): MissingReceiverAssignment[] {
    const assignments: MissingReceiverAssignment[] = [];

    for (let classIndex = 0; classIndex < lines.length; classIndex++) {
        const classMatch = lines[classIndex].match(PYTHON_CLASS_RE);
        if (!classMatch) continue;

        const classIndent = indentation(lines[classIndex]);
        const classEnd = pythonBlockEnd(lines, classIndex, classIndent);
        const classBodyIndent = directBodyIndent(lines, classIndex, classEnd);
        if (classBodyIndent === undefined) continue;

        const selfAttributes = new Set<string>();
        const selfAttributeRe = /\bself\.([A-Za-z_]\w*)\b/g;
        for (const line of lines.slice(classIndex + 1, classEnd)) {
            for (const match of line.matchAll(selfAttributeRe)) {
                selfAttributes.add(match[1]);
            }
        }

        for (let functionIndex = classIndex + 1; functionIndex < classEnd; functionIndex++) {
            const functionMatch = lines[functionIndex].match(PYTHON_FUNCTION_RE);
            if (
                !functionMatch ||
                functionMatch[2] !== "__init__" ||
                indentation(lines[functionIndex]) !== classBodyIndent
            ) {
                continue;
            }

            const functionIndent = indentation(lines[functionIndex]);
            const functionEnd = pythonBlockEnd(lines, functionIndex, functionIndent);
            const functionBodyIndent = directBodyIndent(
                lines,
                functionIndex,
                functionEnd,
            );
            if (functionBodyIndent === undefined) continue;
            const functionBody = lines
                .slice(functionIndex + 1, functionEnd)
                .join("\n");

            for (
                let bodyIndex = functionIndex + 1;
                bodyIndex < functionEnd;
                bodyIndex++
            ) {
                if (indentation(lines[bodyIndex]) !== functionBodyIndent) continue;
                const bareAssignment = lines[bodyIndex].match(
                    /^\s*([A-Za-z_]\w*)\s*=(?!=)/,
                );
                if (!bareAssignment || !selfAttributes.has(bareAssignment[1])) continue;
                const bareUseRe = new RegExp(
                    `(?<!\\.)\\b${bareAssignment[1]}\\b`,
                    "g",
                );
                if ([...functionBody.matchAll(bareUseRe)].length !== 1) continue;
                assignments.push({
                    lineIndex: bodyIndex,
                    name: bareAssignment[1],
                });
            }
        }
        classIndex = classEnd - 1;
    }

    return assignments;
}

function requiredSymbols(prompt: string): string[] {
    const symbols = new Set<string>();
    for (const pattern of REQUIRED_SYMBOL_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of prompt.matchAll(pattern)) {
            if (match[1]) symbols.add(match[1]);
        }
    }
    return [...symbols];
}

function pythonStructureFailure(code: string): string | undefined {
    if (
        !/(?:^|\n)\s*class\s+[A-Za-z_]\w*[\s(:]/m.test(code) ||
        !/(?:^|\n)\s*(?:async\s+)?def\s+/m.test(code)
    ) {
        return undefined;
    }

    const lines = code.split(/\r?\n/);
    const scopes: PythonScope[] = [];
    const classScopes: PythonClassScope[] = [];
    let pendingDecorator: { indent: number; kind: "staticmethod" | "classmethod" } | undefined;

    for (const line of lines) {
        if (!line.trim() || line.trimStart().startsWith("#")) continue;
        const indent = indentation(line);

        while (scopes.length > 0 && scopes[scopes.length - 1].indent >= indent) {
            scopes.pop();
        }

        const decorator = line.match(PYTHON_METHOD_DECORATOR_RE);
        if (decorator) {
            pendingDecorator = {
                indent,
                kind: decorator[2] as "staticmethod" | "classmethod",
            };
            continue;
        }

        const classMatch = line.match(PYTHON_CLASS_RE);
        if (classMatch) {
            const baseList = line.match(/\(([^)]*)\)/)?.[1].trim() ?? "";
            const classScope: PythonClassScope = {
                hasBase: baseList.length > 0,
                definedMethods: new Set<string>(),
                directPrivateCalls: new Set<string>(),
                supportsDynamicLookup: false,
            };
            classScopes.push(classScope);
            scopes.push({ kind: "class", indent, classScope });
            pendingDecorator = undefined;
            continue;
        }

        const functionMatch = line.match(PYTHON_FUNCTION_RE);
        if (functionMatch) {
            const parent = scopes[scopes.length - 1];
            const methodName = functionMatch[2];
            const parameters = functionMatch[3]
                .split(",")
                .map((parameter) => parameter.trim())
                .filter(Boolean);

            if (parent?.kind === "class") {
                parent.classScope?.definedMethods.add(methodName);
                if (methodName === "__getattr__" || methodName === "__getattribute__") {
                    if (parent.classScope) parent.classScope.supportsDynamicLookup = true;
                }
                const decoratedStatic =
                    pendingDecorator?.indent === indent &&
                    pendingDecorator.kind === "staticmethod";
                const expectedReceiver =
                    pendingDecorator?.indent === indent &&
                    pendingDecorator.kind === "classmethod"
                        ? "cls"
                        : "self";
                if (!decoratedStatic && parameters[0]?.split(/[:=]/, 1)[0].trim() !== expectedReceiver) {
                    return "python_method_missing_receiver";
                }
            }

            scopes.push({ kind: "function", indent });
            pendingDecorator = undefined;
        } else {
            pendingDecorator = undefined;
        }

        const containingClass = [...scopes]
            .reverse()
            .find((scope) => scope.kind === "class")
            ?.classScope;
        PYTHON_DIRECT_PRIVATE_CALL_RE.lastIndex = 0;
        for (const match of line.matchAll(PYTHON_DIRECT_PRIVATE_CALL_RE)) {
            containingClass?.directPrivateCalls.add(match[1]);
        }
    }

    for (const classScope of classScopes) {
        if (classScope.hasBase || classScope.supportsDynamicLookup) continue;
        for (const called of classScope.directPrivateCalls) {
            if (!classScope.definedMethods.has(called)) {
                return "python_undefined_private_helper";
            }
        }
    }
    return undefined;
}

function pythonSyntaxFailure(code: string): string | undefined {
    if (!PYTHON_SIGNAL_RE.test(code)) return undefined;
    if (PYTHON_INVALID_DEF_RE.test(code)) return "python_syntax_error";

    for (const command of PYTHON_COMMANDS) {
        const parsed = spawnSync(command, ["-c", PYTHON_AST_SCRIPT], {
            input: code,
            encoding: "utf8",
            timeout: 2_000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
        });
        if (parsed.error && (parsed.error as NodeJS.ErrnoException).code === "ENOENT") {
            continue;
        }
        const parserStarted = parsed.stdout
            ?.split(/\r?\n/)
            .includes(PYTHON_READY_SENTINEL) === true;
        if (!parserStarted) {
            continue;
        }
        return parsed.status === 0 ? undefined : "python_syntax_error";
    }
    return undefined;
}

function pythonStaticContractFailure(code: string): string | undefined {
    const issues = new Set<string>();
    const lines = code.split(/\r?\n/);
    if (findConstructorMissingReceiverAssignments(lines).length > 0) {
        issues.add("constructor_attribute_missing_receiver");
    }

    if (PYTHON_CHILDREN_KEYS_UNPACK_RE.test(code)) {
        issues.add("dict_keys_unpack");
    }

    return issues.size > 0
        ? `python_static_contract:${[...issues].sort().join(",")}`
        : undefined;
}

/**
 * A generic used with no type argument, e.g. `Map<string, Array>`.
 *
 * prism-coder:9b emits this repeatedly — observed in four separate generations
 * of the same EventEmitter task — and it is a hard compile error (TS2314), so
 * the file never builds. Detecting it needs no TypeScript dependency: the shape
 * is unambiguous when the bare name sits inside a type-argument list or
 * directly after a type annotation.
 *
 * Deliberately narrow. Prose mentioning "the Array, then the Map" must not
 * match, so a bare name is only a finding when it is syntactically in a type
 * position; a bare `Promise` as a lone return type with no delimiter after it
 * is missed, which is the conservative direction.
 */
const TS_GENERIC = "(?:Array|Map|Set|Promise|Record|Partial|Readonly|WeakMap|WeakSet)";
const TS_BARE_GENERIC_RE = new RegExp(
    `<[^<>]*\\b${TS_GENERIC}\\b(?!\\s*<)[^<>]*>` +
    `|:\\s*${TS_GENERIC}\\b(?!\\s*<)\\s*[={;,)\\]]`,
);

/** Null when the code carries no TypeScript static-contract defect. */
function tsStaticContractFailure(code: string): string | null {
    return TS_BARE_GENERIC_RE.test(code) ? "ts_static_contract:bare_generic" : null;
}

/** Character ranges a repair must not touch on one line.
 *
 *  Strings, because rewriting `"use Map<string, Array> carefully"` changes a
 *  RUNTIME VALUE rather than a type. And comments, because `// don't use a bare
 *  Map<string, Array>` is a warning against the very thing the repair would
 *  write, so editing it inverts the author's meaning. Both found in review. */
function protectedSpans(line: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    const strings = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
    for (const m of line.matchAll(strings)) spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    // A line comment runs to end of line. An apostrophe in prose ("don't")
    // breaks the string scan, which is how comments slipped through before.
    const comment = /\/\/|\/\*/.exec(line);
    if (comment) spans.push([comment.index, line.length]);
    return spans;
}

/** Fence languages whose contents are TypeScript. A bare generic inside a
 *  python or json block is not a type error to fix — the first version rewrote
 *  a comment inside a python block in a multi-language answer. */
const TS_FENCE_LANG = /^\s*```\s*(ts|typescript|tsx)?\s*$/i;

/** `Map<string, Array>` -> `Map<string, Array<any>>`, within code only.
 *
 *  `any` rather than `unknown` on purpose: `unknown` makes the file compile and
 *  then breaks every use of the value, which trades one compile error for
 *  several. This makes the code build; it does not make it well typed.
 *
 *  Scoped twice, both from adversarial review. Fenced output is repaired only
 *  INSIDE its fences, because rewriting the surrounding prose inverts sentences
 *  like "do not write Map<string, Array>". And no match inside a string literal
 *  is touched, because that is a value, not a type. */
function repairBareGenerics(code: string): { code: string; changed: boolean } {
    let changed = false;
    const spanRe = new RegExp(TS_BARE_GENERIC_RE.source, "g");

    const repairLine = (line: string): string => {
        const off_limits = protectedSpans(line);
        return line.replace(spanRe, (span, offset: number) => {
            if (off_limits.some(([a, b]) => offset >= a && offset < b)) return span;
            const fixed = span.replace(
                new RegExp(`\\b(${TS_GENERIC})\\b(?!\\s*<)`, "g"),
                "$1<any>",
            );
            if (fixed !== span) changed = true;
            return fixed;
        });
    };

    const lines = code.split("\n");
    const hasFences = /^\s*```/m.test(code);
    let inFence = false;
    let fenceIsTs = false;
    const out = lines.map((line) => {
        if (/^\s*```/.test(line)) {
            if (!inFence) fenceIsTs = TS_FENCE_LANG.test(line);
            inFence = !inFence;
            return line;
        }
        // No fences at all: the whole output is the code block.
        return (!hasFences || (inFence && fenceIsTs)) ? repairLine(line) : line;
    });
    return { code: out.join("\n"), changed };
}

export function applyDeterministicCodingRepairs(
    output: string,
    reason: string,
): DeterministicCodingRepairResult {
    if (reason.startsWith("ts_static_contract:")) {
        if (!reason.includes("bare_generic")) return { output, changes: [] };
        const repaired = repairBareGenerics(output);
        return repaired.changed
            ? { output: repaired.code, changes: ["bare_generic"] }
            : { output, changes: [] };
    }

    if (!reason.startsWith("python_static_contract:")) {
        return { output, changes: [] };
    }

    const lines = output.split(/\r?\n/);
    const changes = new Set<string>();

    if (reason.includes("constructor_attribute_missing_receiver")) {
        for (const { lineIndex, name } of findConstructorMissingReceiverAssignments(lines)) {
            const bareAssignment = lines[lineIndex].match(
                /^(\s*)([A-Za-z_]\w*)(\s*=(?!=).*)$/,
            );
            if (!bareAssignment || bareAssignment[2] !== name) continue;
            lines[lineIndex] =
                `${bareAssignment[1]}self.${name}${bareAssignment[3]}`;
            changes.add("constructor_attribute_missing_receiver");
        }
    }

    if (reason.includes("dict_keys_unpack")) {
        for (let index = 0; index < lines.length; index++) {
            if (!PYTHON_CHILDREN_KEYS_UNPACK_RE.test(lines[index])) continue;
            lines[index] = lines[index].replace(".keys()", ".items()");
            changes.add("dict_keys_unpack");
        }
    }

    return {
        output: lines.join(output.includes("\r\n") ? "\r\n" : "\n"),
        changes: [...changes].sort(),
    };
}

/**
 * Reject only objective implementation failures. Non-implementation analysis
 * in code mode remains valid prose and bypasses this specialized gate.
 */
export function passesCodingQualityGate(
    prompt: string,
    output: string,
): CodingQualityResult {
    const implementationRequested =
        IMPLEMENTATION_REQUEST_RE.test(prompt) || STRICT_SOURCE_REQUEST_RE.test(prompt);
    if (!implementationRequested) return { pass: true };

    for (const { reason, pattern } of INCOMPLETE_IMPLEMENTATION_PATTERNS) {
        if (pattern.test(output)) return { pass: false, reason };
    }

    const extracted = extractCode(output);
    const code = extracted.all;
    if (STRICT_SOURCE_REQUEST_RE.test(prompt) && !CODE_SHAPE_RE.test(code)) {
        return { pass: false, reason: "code_shape_missing" };
    }

    for (const symbol of requiredSymbols(prompt)) {
        const symbolRe = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        if (!symbolRe.test(code)) {
            return { pass: false, reason: "code_required_symbol_missing" };
        }
    }

    const pythonCode = extracted.python;
    if (pythonCode) {
        const pythonSyntax = pythonSyntaxFailure(pythonCode);
        if (pythonSyntax) return { pass: false, reason: pythonSyntax };

        const pythonStaticContract = pythonStaticContractFailure(pythonCode);
        if (pythonStaticContract) {
            return { pass: false, reason: pythonStaticContract };
        }

        const pythonFailure = pythonStructureFailure(pythonCode);
        if (pythonFailure) return { pass: false, reason: pythonFailure };
    }

    // The regex floor runs first: it is the one finding with a deterministic
    // repair, and it works even if the compiler cannot be loaded.
    const tsFailure = tsStaticContractFailure(code);
    if (tsFailure) return { pass: false, reason: tsFailure };

    // Then the compiler, over TypeScript blocks only.
    if (extracted.typescript) {
        const findings = analyzeTypeScript(extracted.typescript, extracted.hasFences);
        if (findings.length > 0) {
            return { pass: false, reason: `ts_static_contract:${findings.join(",")}` };
        }
    }

    return { pass: true };
}

const CODING_REPAIR_SYSTEM_INSTRUCTION =
    "Repair the supplied implementation. Return one complete replacement implementation with no prose, " +
    "placeholders, TODOs, omitted sections, or unfinished reasoning. Preserve every requirement in the original task.";

const CODING_REPAIR_GUIDANCE: Readonly<Record<string, string>> = {
    code_placeholder:
        "Replace every placeholder or omitted section with complete executable code.",
    code_not_implemented:
        "Replace NotImplemented stubs with the complete requested behavior.",
    code_unfinished_reasoning:
        "Remove unfinished reasoning and finish the implementation before returning it.",
    code_shape_missing:
        "Return actual source code with the requested definition, not a prose description.",
    code_required_symbol_missing:
        "Define the exact class, function, method, or interface name requested by the task.",
    python_syntax_error:
        "Make the entire Python module parse successfully; check every def signature, delimiter, and block.",
    python_method_missing_receiver:
        "Instance methods must take self first; class methods must take cls first unless decorated staticmethod.",
    python_undefined_private_helper:
        "Define every directly called private self helper or replace the call with the correct defined helper.",
    constructor_attribute_missing_receiver:
        "In __init__, persist instance state as self.<attribute>; do not assign it to a discarded local variable.",
    syntax_error:
        "The code does not parse. Balance every brace, bracket and parenthesis, and finish every statement.",
    optional_chain_assignment:
        "Optional chaining cannot appear on the left of an assignment. Guard with an if, or assert the value is present, before assigning to the property.",
    type_not_assignable:
        "Make the returned value match the declared return type, or widen the declaration to what the implementation actually produces.",
    implicit_any_param:
        "Annotate every parameter; under strict mode an inferred any is an error.",
    deferred_mutation_returned_sync:
        "A value mutated inside a then/catch/setTimeout callback is returned before that callback runs. Await the work, or return a Promise that resolves after it.",
    bare_generic:
        "Every generic needs its type argument: write Array<T>, Map<K, V>, Set<T>, Promise<T> — never a bare Array, Map, Set or Promise in a type position.",
    dict_keys_unpack:
        "When unpacking key and value, iterate dictionary .items(); .keys() yields one key per iteration.",
} as const;

function repairGuidance(reason: string): string[] {
    const guidance = new Set<string>();
    for (const [code, instruction] of Object.entries(CODING_REPAIR_GUIDANCE)) {
        if (reason.includes(code)) guidance.add(instruction);
    }
    return [...guidance];
}

export function buildCodingRepairPrompt(
    originalPrompt: string,
    draft: string,
    reason: string,
): { prompt: string; system: string } {
    const safeDraft = draft.replace(/<\|/g, "< |");
    const guidance = repairGuidance(reason);
    return {
        system: CODING_REPAIR_SYSTEM_INSTRUCTION,
        prompt:
            `<original_task>\n${originalPrompt}\n</original_task>\n` +
            `<failed_gate>${reason}</failed_gate>\n` +
            (guidance.length > 0
                ? `<repair_guidance>\n- ${guidance.join("\n- ")}\n</repair_guidance>\n`
                : "") +
            `<draft>\n${safeDraft}\n</draft>`,
    };
}
