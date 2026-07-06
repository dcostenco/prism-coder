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
 * @param mode  Inference mode — "route" uses length===0 floor; "code"/"chat" keep <5
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
    // Use length===0 for route; keep <5 for code/chat where single-word answers are invalid.
    const emptyFloor = mode === "route" ? 0 : 4;
    if (stripped.trim().length <= emptyFloor) {
        return { pass: false, reason: "empty_response" };
    }

    // Signal 3: Hard truncation — Ollama reports finish_reason="length"
    // meaning the model hit num_predict before finishing
    if (finishReason === "length") {
        return { pass: false, reason: "hard_truncation" };
    }

    // Signal 5: Tool-call bleed — fine-tuned 4b emits <|tool_call|> format in non-tool turns.
    // Pipe-delimited format only; angle-bracket variants are handled by normalizeToolCallFormat.
    // False-positive guard: requires the literal pipe tokens, not the words "tool call".
    if (TOOL_CALL_BLEED_RE.test(stripped)) {
        return { pass: false, reason: "tool_call_bleed" };
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
    if (proseSentences.length >= 6) {
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
    const allSentences = stripped.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 10);
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
