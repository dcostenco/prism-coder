/**
 * Generic route-output contract for prism_infer.
 *
 * This module deliberately contains no intent taxonomy or benchmark-derived
 * routing heuristics. It only parses the public Prism tool-call envelope and
 * enforces the caller-advertised registry before a host can act on a route.
 */

export const DEFAULT_PRISM_ROUTE_TOOLS: ReadonlySet<string> = new Set([
    "session_load_context",
    "session_save_ledger",
    "session_save_handoff",
    "session_compact_ledger",
    "session_search_memory",
    "knowledge_search",
    "brave_web_search",
]);

export type ParsedRouteOutput =
    | { kind: "plain_text" }
    | { kind: "malformed" }
    | { kind: "tool_call"; name: string; args: Record<string, unknown> };

export interface RouteGuardOutcome {
    output: string;
    action: "plain_text" | "preserved" | "remapped" | "suppressed";
    source: "local" | "portal" | "local_fallback";
    original_tool?: string;
    final_tool?: string;
    reason?: string;
}

const PIPE_START = "<|tool_call|>";
const PIPE_END = "<|tool_call_end|>";
const ANGLE_START = "<tool_call>";
const ANGLE_END = "</tool_call>";
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const MAX_ROUTE_OUTPUT_CHARS = 32_000;
const MAX_ROUTE_REASON_CHARS = 256;
const MAX_ARGUMENT_DEPTH = 32;
const MAX_ARGUMENT_NODES = 2_048;
const TOOL_CALL_KEYS = new Set(["name", "arguments", "args"]);

export function isRouteToolName(value: unknown): value is string {
    return typeof value === "string" && TOOL_NAME_RE.test(value);
}

function isBoundedJsonValue(root: unknown): boolean {
    const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
    let nodes = 0;
    while (stack.length > 0) {
        const current = stack.pop()!;
        nodes += 1;
        if (nodes > MAX_ARGUMENT_NODES || current.depth > MAX_ARGUMENT_DEPTH) {
            return false;
        }
        if (current.value === null) continue;
        if (typeof current.value === "number") {
            if (!Number.isFinite(current.value)) return false;
            continue;
        }
        if (
            typeof current.value === "string" ||
            typeof current.value === "boolean"
        ) {
            continue;
        }
        if (typeof current.value !== "object") return false;
        const values = Array.isArray(current.value)
            ? current.value
            : Object.values(current.value as Record<string, unknown>);
        for (const value of values) {
            stack.push({ value, depth: current.depth + 1 });
        }
    }
    return true;
}

function primitiveLeaves(value: unknown): unknown[] {
    const leaves: unknown[] = [];
    const stack = [value];
    while (stack.length > 0) {
        const current = stack.pop();
        if (current !== null && typeof current === "object") {
            stack.push(...(
                Array.isArray(current)
                    ? current
                    : Object.values(current as Record<string, unknown>)
            ));
        } else {
            leaves.push(current);
        }
    }
    return leaves;
}

function promptContainsPrimitive(prompt: string, value: number | boolean): boolean {
    const rendered = String(value).toLowerCase()
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9_.-])${rendered}($|[^A-Za-z0-9_.-])`)
        .test(prompt.toLowerCase());
}

function promptContainsString(prompt: string, value: string): boolean {
    const normalizedValue = value.trim().toLowerCase();
    if (!normalizedValue) return false;
    if (/^[A-Za-z0-9_.:-]+$/.test(normalizedValue)) {
        const escaped = normalizedValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(^|[^A-Za-z0-9_.:-])${escaped}($|[^A-Za-z0-9_.:-])`)
            .test(prompt.toLowerCase());
    }
    return prompt.toLowerCase().includes(normalizedValue);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) &&
            Array.isArray(right) &&
            left.length === right.length &&
            left.every((entry, index) => sameJsonValue(entry, right[index]));
    }
    if (
        left === null ||
        right === null ||
        typeof left !== "object" ||
        typeof right !== "object"
    ) {
        return false;
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return leftKeys.length === rightKeys.length &&
        leftKeys.every((key, index) =>
            key === rightKeys[index] &&
            sameJsonValue(leftRecord[key], rightRecord[key]));
}

function hasDerivedArguments(
    correctedArgs: Record<string, unknown>,
    originalArgs: Record<string, unknown>,
    originalPrompt: string,
): boolean {
    const originalLeaves = primitiveLeaves(originalArgs);
    return primitiveLeaves(correctedArgs).every((leaf) => {
        if (originalLeaves.some((candidate) => Object.is(candidate, leaf))) {
            return true;
        }
        if (typeof leaf === "string") {
            return promptContainsString(originalPrompt, leaf);
        }
        if (typeof leaf === "number" || typeof leaf === "boolean") {
            return promptContainsPrimitive(originalPrompt, leaf);
        }
        return false;
    });
}

function parseToolJson(raw: string): ParsedRouteOutput {
    try {
        const value = JSON.parse(raw) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return { kind: "malformed" };
        }
        const record = value as Record<string, unknown>;
        if (!isRouteToolName(record.name)) {
            return { kind: "malformed" };
        }
        if (Object.keys(record).some((key) => !TOOL_CALL_KEYS.has(key))) {
            return { kind: "malformed" };
        }
        const hasArguments = Object.prototype.hasOwnProperty.call(record, "arguments");
        const hasArgs = Object.prototype.hasOwnProperty.call(record, "args");
        if (hasArguments && hasArgs) return { kind: "malformed" };
        const rawArgs = hasArguments
            ? record.arguments
            : hasArgs
                ? record.args
                : {};
        if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
            return { kind: "malformed" };
        }
        if (!isBoundedJsonValue(rawArgs)) return { kind: "malformed" };
        return {
            kind: "tool_call",
            name: record.name,
            args: rawArgs as Record<string, unknown>,
        };
    } catch {
        return { kind: "malformed" };
    }
}

function parseEnvelope(
    output: string,
    startToken: string,
    endToken: string,
): ParsedRouteOutput {
    const start = output.indexOf(startToken);
    const end = output.indexOf(endToken, start + startToken.length);
    if (
        start < 0 ||
        end < 0 ||
        output.indexOf(startToken, start + startToken.length) >= 0 ||
        output.indexOf(endToken, end + endToken.length) >= 0
    ) {
        return { kind: "malformed" };
    }
    const before = output.slice(0, start).trim();
    const after = output.slice(end + endToken.length).trim();
    if (before || after) return { kind: "malformed" };
    return parseToolJson(output.slice(start + startToken.length, end).trim());
}

/**
 * Closing markers seen in the wild, in the order they are tried.
 *
 * `</|tool_call|>` is not a marker this codebase ever emitted — it is what
 * prism-coder:9b produces with thinking off, the same way it produces
 * `</tool_call>` with thinking on. Neither is the canonical partner of the pipe
 * opener, so a strictly-paired parse rejected both.
 */
const END_TOKENS = [PIPE_END, ANGLE_END, "</|tool_call|>"] as const;

/**
 * Try each known closing marker against a given opener.
 *
 * Models mix openers and closers: measured 2026-08-15, prism-coder:9b opens
 * with `<|tool_call|>` and closes with `</tool_call>`. Requiring the matching
 * partner classified a CORRECT tool call as malformed, which
 * applyLocalRouteContract then rewrote to "NO_TOOL" and served. End to end that
 * cost the 9b 95.7% -> 43.5% on the 115-case routing suite; the whole gap was
 * this pairing. Only the ENVELOPE is tolerant — the body still has to be a
 * valid tool call, so a malformed payload is suppressed exactly as before.
 */
function parseWithAnyTerminator(trimmed: string, startToken: string): ParsedRouteOutput {
    let lastResult: ParsedRouteOutput = { kind: "malformed" };
    for (const endToken of END_TOKENS) {
        if (!trimmed.includes(endToken)) continue;
        const parsed = parseEnvelope(trimmed, startToken, endToken);
        if (parsed.kind === "tool_call") return parsed;
        lastResult = parsed;
    }
    // No terminator at all — measured: the 9b emits
    // `<|tool_call|> {"name": ..., "arguments": {...}}` with nothing after it.
    //
    // Accept ONLY when everything after the opener parses as a COMPLETE tool
    // call. That is what makes this safe against truncation: a call cut off
    // mid-emission leaves invalid JSON, which parseToolJson rejects, so a
    // half-written envelope is still suppressed. Only a whole, well-formed body
    // that merely lacks its closing marker gets through.
    if (!END_TOKENS.some(t => trimmed.includes(t))) {
        const body = trimmed.slice(trimmed.indexOf(startToken) + startToken.length).trim();
        return parseToolJson(body);
    }
    return lastResult;
}

export function parseRouteOutput(output: string): ParsedRouteOutput {
    if (output.length > MAX_ROUTE_OUTPUT_CHARS) return { kind: "malformed" };
    const trimmed = output.trim();
    // Dispatch on the OPENER. Presence of a closing marker alone no longer
    // decides the family, because the two families get mixed.
    if (trimmed.includes(PIPE_START)) return parseWithAnyTerminator(trimmed, PIPE_START);
    if (trimmed.includes(ANGLE_START)) return parseWithAnyTerminator(trimmed, ANGLE_START);

    // A closing marker with no opener is a truncated or corrupted envelope, not
    // prose — keep suppressing it.
    const hasPipeMarker = trimmed.includes(PIPE_END);
    if (hasPipeMarker) return parseEnvelope(trimmed, PIPE_START, PIPE_END);

    const hasAngleMarker = trimmed.includes(ANGLE_END) || trimmed.includes("</|tool_call|>");
    if (hasAngleMarker) return parseEnvelope(trimmed, ANGLE_START, ANGLE_END);

    // A route answer that starts like raw tool JSON is an attempted contract
    // response. Treat invalid JSON/shape as malformed rather than returning it
    // as ordinary prose that a host might accidentally interpret.
    if (trimmed.startsWith("{")) return parseToolJson(trimmed);

    return { kind: "plain_text" };
}

export function applyLocalRouteContract(
    draft: string,
    allowedTools: ReadonlySet<string> = DEFAULT_PRISM_ROUTE_TOOLS,
): RouteGuardOutcome {
    const parsed = parseRouteOutput(draft);
    if (parsed.kind === "plain_text") {
        return { output: draft, action: "plain_text", source: "local" };
    }
    if (parsed.kind === "malformed") {
        return {
            output: "NO_TOOL",
            action: "suppressed",
            source: "local",
            reason: "malformed_tool_call",
        };
    }
    if (parsed.name === "NO_TOOL") {
        return { output: "NO_TOOL", action: "plain_text", source: "local" };
    }
    if (!allowedTools.has(parsed.name)) {
        return {
            output: "NO_TOOL",
            action: "suppressed",
            source: "local",
            original_tool: parsed.name,
            reason: "unadvertised_tool",
        };
    }
    return {
        output: draft,
        action: "preserved",
        source: "local",
        original_tool: parsed.name,
        final_tool: parsed.name,
    };
}

/**
 * Validate a private portal correction before trusting it.
 *
 * The portal is an authenticated service, but the public client still treats
 * its response as untrusted network input. The declared action must agree with
 * the output shape and with the original draft.
 */
export function validatePortalRouteGuardOutcome(
    value: unknown,
    originalDraft: string,
    allowedTools: ReadonlySet<string>,
    originalPrompt = "",
): RouteGuardOutcome | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
        typeof record.output !== "string" ||
        record.output.length === 0 ||
        record.output.length > MAX_ROUTE_OUTPUT_CHARS ||
        record.source !== "portal" ||
        !["plain_text", "preserved", "remapped", "suppressed"].includes(
            typeof record.action === "string" ? record.action : "",
        )
    ) {
        return null;
    }
    if (
        record.original_tool !== undefined &&
        !isRouteToolName(record.original_tool)
    ) {
        return null;
    }
    if (
        record.final_tool !== undefined &&
        !isRouteToolName(record.final_tool)
    ) {
        return null;
    }
    if (
        record.reason !== undefined &&
        (typeof record.reason !== "string" ||
            record.reason.length > MAX_ROUTE_REASON_CHARS)
    ) {
        return null;
    }

    const action = record.action as RouteGuardOutcome["action"];
    const original = parseRouteOutput(originalDraft);
    const corrected = parseRouteOutput(record.output);

    if (action === "plain_text") {
        if (original.kind !== "plain_text" || corrected.kind !== "plain_text") {
            return null;
        }
    } else if (action === "suppressed") {
        if (
            original.kind !== "tool_call" ||
            record.output.trim() !== "NO_TOOL" ||
            (record.original_tool !== undefined &&
                record.original_tool !== original.name) ||
            record.final_tool !== undefined
        ) {
            return null;
        }
    } else {
        if (
            original.kind !== "tool_call" ||
            corrected.kind !== "tool_call" ||
            !allowedTools.has(corrected.name) ||
            record.original_tool !== original.name ||
            record.final_tool !== corrected.name
        ) {
            return null;
        }
        if (action === "preserved" && corrected.name !== original.name) {
            return null;
        }
        if (action === "remapped" && corrected.name === original.name) {
            return null;
        }
        if (
            action === "preserved" &&
            !sameJsonValue(corrected.args, original.args)
        ) {
            return null;
        }
        if (
            action === "remapped" &&
            !hasDerivedArguments(corrected.args, original.args, originalPrompt)
        ) {
            return null;
        }
    }

    return {
        output: record.output,
        action,
        source: "portal",
        ...(record.original_tool !== undefined
            ? { original_tool: record.original_tool as string }
            : {}),
        ...(record.final_tool !== undefined
            ? { final_tool: record.final_tool as string }
            : {}),
        ...(record.reason !== undefined
            ? { reason: record.reason as string }
            : {}),
    };
}
