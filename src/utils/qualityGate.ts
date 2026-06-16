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
 * Check if a model response passes the quality gate.
 * @param stripped  Response AFTER think-stripping (use stripThink first)
 * @param thinkOnly  True if the response was only <think> blocks with no answer
 * @param finishReason  Ollama's finish_reason if available (e.g. "length" = truncated)
 */
export function passesQualityGate(
    stripped: string,
    thinkOnly: boolean,
    finishReason?: string,
): QualityGateResult {
    // Signal 1: Think-only — model reasoned but produced no answer (check before empty)
    if (thinkOnly) {
        return { pass: false, reason: "think_only" };
    }

    // Signal 2: Empty or near-empty after stripping
    if (stripped.trim().length < 5) {
        return { pass: false, reason: "empty_response" };
    }

    // Signal 3: Hard truncation — Ollama reports finish_reason="length"
    // meaning the model hit num_predict before finishing
    if (finishReason === "length") {
        return { pass: false, reason: "hard_truncation" };
    }

    // Signal 4: Exact-loop — same sentence repeated 3+ times
    const sentences = stripped.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 10);
    if (sentences.length >= 6) {
        const counts = new Map<string, number>();
        for (const s of sentences) {
            const key = s.toLowerCase();
            counts.set(key, (counts.get(key) ?? 0) + 1);
            if ((counts.get(key) ?? 0) >= 3) {
                return { pass: false, reason: "loop_detected" };
            }
        }
    }

    return { pass: true };
}
