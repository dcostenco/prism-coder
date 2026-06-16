/**
 * L1 Safety Gate — deterministic crisis/medical interception for prism_infer.
 *
 * Runs BEFORE model output reaches the caller. High precision, low recall:
 * only intercepts patterns that unambiguously indicate self-harm intent
 * (input) or dangerous instructions (output). Generic clinical/pharmacological
 * terms ("dose of", "milligrams", "lethal") are NOT intercepted — they appear
 * in routine BCBA/medical notes.
 *
 * This is a backstop, not a comprehensive filter. The model's own safety
 * training is the primary layer.
 */

// ── Input: first-person crisis expressions ───────────────────────────────────

const CRISIS_INPUT_RE = [
    /hurt(?:ing)?\s+(?:my)?self/i,
    /kill\s+(?:my)?self/i,
    /end\s+my\s+life/i,
    /want\s+to\s+die/i,
    /want\s+to\s+(?:commit\s+)?suicide/i,
    /cut(?:ting)?\s+(?:my)?self/i,
    /(?:hang|hanging)\s+(?:my)?self/i,
    /jump(?:ing)?\s+off/i,
    /how\s+(?:many|much|to).*(?:pills|overdose|die)/i,
];

const MEDICAL_INPUT_RE = [
    /(?:how\s+much|what\s+dose)\s+.*(?:should\s+I|do\s+I|can\s+I)\s+(?:inject|take|give)/i,
    /(?:dose|dosage)\s+(?:should\s+I|do\s+I|can\s+I)\s+(?:inject|take|give)/i,
];

// ── Output: model providing dangerous instructions ───────────────────────────

const CRISIS_OUTPUT_RE = [
    /\bhow many pills\s+to\b/i,
    /\boverdose amount\b/i,
    /\bnoose\b/i,
    /\bhanging yourself\b/i,
    /\bsuicide method\b/i,
    /\bmethod of suicide\b/i,
    /\bself[- ]?harm method\b/i,
    /\bhow to (?:kill|hang|poison|overdose)\b/i,
];

const MEDICAL_OUTPUT_RE = [
    /\binject this (?:amount|dose|much)\b/i,
    /\btake this (?:amount|many|dose)\b/i,
    /\byou should (?:inject|take)\s+\d+\s+units\b/i,
];

// ── Responses ────────────────────────────────────────────────────────────────

export const CRISIS_RESPONSE = "I'm concerned about your safety. Please call or text 988 (Suicide & Crisis Lifeline) right now — available 24/7. If in immediate danger, call 911. You are not alone.";
export const MEDICAL_RESPONSE = "I cannot provide specific medical dosing advice. Please contact your doctor or pharmacist. For emergencies, call 911.";

// ── API ──────────────────────────────────────────────────────────────────────

function normalize(text: string): string {
    return text.toLowerCase().replace(/\p{Cf}/gu, "").replace(/\s+/g, " ");
}

export function checkInputSafety(text: string): string | null {
    const t = normalize(text);
    if (CRISIS_INPUT_RE.some(p => p.test(t))) return CRISIS_RESPONSE;
    if (MEDICAL_INPUT_RE.some(p => p.test(t))) return MEDICAL_RESPONSE;
    return null;
}

export function checkOutputSafety(response: string): string {
    const r = normalize(response);
    if (CRISIS_OUTPUT_RE.some(re => re.test(r))) return CRISIS_RESPONSE;
    if (MEDICAL_OUTPUT_RE.some(re => re.test(r))) return MEDICAL_RESPONSE;
    return response;
}
