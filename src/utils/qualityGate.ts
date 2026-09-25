import { parseRouteOutput } from "./routeContract.js";

/**
 * Quality Gate — deterministic check for obvious inference failures.
 *
 * NARROW by design: only high-precision signals that rarely false-positive.
 * Does NOT judge correctness — that's the grounding verifier's job.
 * Does NOT use refusal regex (too many false positives on legitimate output).
 *
 * Returns: { pass: boolean, reason?: string }
 */

export interface QualityGateResult {
    pass: boolean;
    reason?: string;
}

/**
 * Signal 5 — Tool-call bleed: pipe-delimited format leaking into non-tool turns.
 * Matches <|tool_call|> and <|tool_call_end|> only — NOT angle-bracket <tool_call> variants
 * (those are normalized by normalizeToolCallFormat, not gated as failures).
 */
export const TOOL_CALL_BLEED_RE = /<\|tool_call\|>|<\|tool_call_end\|>/;

/**
 * Check if a model response passes the quality gate.
 * @param stripped  Response AFTER think-stripping (use stripThink first)
 * @param thinkOnly  True if the response was only <think> blocks with no answer
 * @param finishReason  Ollama's finish_reason if available (e.g. "length" = truncated)
 * @param mode  Inference mode — "route": empty only when blank; "chat": empty only with no letter or digit; "code"/unset: 4 chars or fewer
 */
export function passesQualityGate(
    stripped: string,
    thinkOnly: boolean,
    finishReason?: string,
    mode?: "route" | "code" | "chat",
): QualityGateResult {
    // Signal 1: Think-only — model reasoned but produced no answer (check before empty)
    if (thinkOnly) {
        return { pass: false, reason: "think_only" };
    }

    // Signal 2: Mode-aware empty floor.
    // Route legitimately returns 1–4 char labels ("P1", "YES", "CO4", "FIXED").
    // Chat answers can be one short value: a follow-up asking "what is x times
    // 6?" is correctly answered "42". Measured 2026-09-24: under the old <5
    // floor, correct chat answers "16" and "36" failed here and, on a paid
    // plan, were thrown away and re-asked of the cloud. So chat is empty only
    // when it has no letter or digit at all.
    // Code keeps <5: a 1–4 char code answer ("Hi", "DONE") is not an answer.
    const trimmed = stripped.trim();
    const empty =
        mode === "route" ? trimmed.length === 0
        : mode === "chat" ? !/[\p{L}\p{N}]/u.test(trimmed)
        : trimmed.length <= 4;
    if (empty) {
        return { pass: false, reason: "empty_response" };
    }

    // Signal 3: Hard truncation — Ollama reports finish_reason="length"
    // meaning the model hit num_predict before finishing
    if (finishReason === "length") {
        return { pass: false, reason: "hard_truncation" };
    }

    // Signal 5: Tool-call bleed. The pipe envelope is invalid in chat/code,
    // but it is the canonical trained output in route mode. Route mode parses
    // the whole envelope and fails only when the contract is malformed.
    if (TOOL_CALL_BLEED_RE.test(stripped)) {
        if (mode === "route") {
            const parsedRoute = parseRouteOutput(stripped);
            if (parsedRoute.kind === "tool_call") {
                // Continue through the remaining generic loop checks.
            } else {
                return { pass: false, reason: "route_tool_call_malformed" };
            }
        } else {
            return { pass: false, reason: "tool_call_bleed" };
        }
    }

    // Signal 4: Exact-loop detection (two passes).
    //
    // Pass A (prose-only, threshold ≥3): strip structural markdown that
    // naturally repeats (code blocks, tables, headings, bold labels).
    // Catches loops in explanatory text.
    const proseOnly = stripped
        .replace(/```[\s\S]*?```/g, "")
        .replace(/^\|.*\|$/gm, "")
        .replace(/^#{1,6}\s+.*$/gm, "")
        .replace(/^[\s*-]*\*{1,2}[^*]+\*{1,2}:?\s*$/gm, "");
    const proseSentences = proseOnly.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 10);
    // Plain source code often repeats structural lines across methods. In code
    // mode those are not prose loops, and splitting on "." corrupts member
    // access (`node = self.root` becomes `node = self`). Pass B below still
    // catches egregious repetition at the higher threshold.
    if (mode !== "code" && proseSentences.length >= 6) {
        const counts = new Map<string, number>();
        for (const s of proseSentences) {
            const key = s.toLowerCase();
            counts.set(key, (counts.get(key) ?? 0) + 1);
            if ((counts.get(key) ?? 0) >= 3) {
                return { pass: false, reason: "loop_detected" };
            }
        }
    }

    // Pass B (full text, threshold ≥5): catches egregious loops hidden
    // inside fake code blocks or other structural elements. Higher
    // threshold avoids false positives on legitimate code patterns
    // (e.g. `node = self.root` × 4 is fine, × 5 is suspicious).
    // In code mode, periods are member-access operators, not sentence
    // boundaries. Splitting `input.length` at "." made several different
    // loops share the fragment `while (i < input` and falsely counted it as
    // repeated output. Full-line matching still catches genuinely duplicated
    // source while preserving valid repeated control-flow shapes.
    const fullTextUnits = mode === "code"
        ? stripped.split(/\n+/)
        : stripped.split(/[.!?\n]+/);
    const allSentences = fullTextUnits
        .map(s => s.trim())
        .filter(s => s.length > 10);
    if (allSentences.length >= 10) {
        const counts = new Map<string, number>();
        for (const s of allSentences) {
            const key = s.toLowerCase();
            counts.set(key, (counts.get(key) ?? 0) + 1);
            if ((counts.get(key) ?? 0) >= 5) {
                return { pass: false, reason: "loop_detected" };
            }
        }
    }

    return { pass: true };
}
