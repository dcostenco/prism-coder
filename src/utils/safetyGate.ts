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
    // English
    /hurt(?:ing)?\s+(?:my)?self/i,
    /kill\s+(?:my)?self/i,
    /end\s+my\s+life/i,
    /want\s+to\s+die/i,
    /want\s+to\s+(?:commit\s+)?suicide/i,
    /cut(?:ting)?\s+(?:my)?self/i,
    /(?:hang|hanging)\s+(?:my)?self/i,
    /jump(?:ing)?\s+off/i,
    /how\s+(?:many|much|to).*(?:pills|overdose|die)/i,
    // Spanish — block hyperbole nouns only (NOT hunger/thirst/cold — may be literal for neglected child)
    /quiero\s+morir(?!\s+de\s+(?:risa|la\s+risa|vergüenza|ganas|envidia|aburrimiento)\b)/i,
    /(?:voy\s+a\s+)?matarme(?!\s+(?:estudiando|trabajando|riendo|de\s+(?:risa|la\s+risa))\b)/i,
    /hacerme\s+da[ñn]o/i,
    /(?:quiero\s+)?suicidarme/i,
    // French — block hyperbole nouns only (NOT faim/soif/chaud/froid)
    /je\s+veux\s+mourir(?!\s+d[e']\s*(?:rire|honte|envie|ennui)\b)/i,
    /(?:vais\s+)?me\s+tuer(?!\s+[àa]\s+(?:rire|travailler|étudier)\b)/i,
    /me\s+suicider/i,
    // Portuguese — block hyperbole nouns only (NOT fome/sede/calor/frio/sono)
    /quero\s+morrer(?!\s+de\s+(?:rir|vergonha|inveja|tédio)\b)/i,
    /(?:vou\s+)?me\s+matar(?!\s+(?:estudando|trabalhando|rindo|de\s+(?:rir|tanto))\b)/i,
    // Russian — block hyperbole nouns (смех/стыд/зависть/голод/жара/скука)
    // Russian — NOT голода/жары/холода (may be literal)
    /хочу\s+умереть(?!\s+от\s+(?:смеха|стыда|зависти|скуки)(?:\s|$))/i,
    /убить\s+себя/i,
    /покончить\s+с\s+собой/i,
    // Arabic (alef variants handled in normalize)
    /[اأإآ]ر[يى]د\s+[اأإآ]ن\s+[اأإآ]موت/,
    /قتل\s+نفس[يى]/,
    /[اأإآ]نه[يى]\s+ح[يى][اأإآ]ت[يى]/,
    // German — block hyperbole nouns (Lachen/Scham/Neid/Hunger/Langeweile)
    // German — NOT hunger/kälte (may be literal)
    /(?:ich\s+)?will\s+sterben(?!\s+vor\s+(?:lachen|scham|neid|langeweile)\b)/i,
    /mich\s+umbringen/i,
    // Ukrainian — block hyperbole nouns (сміх/сором/заздрість/голод)
    // Ukrainian — NOT голоду/холоду (may be literal)
    /хочу\s+померти(?!\s+від\s+(?:сміху|сорому|заздрості|нудьги)(?:\s|$))/i,
    /вбити\s+себе/i,
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
    /\bhow to (?:kill|hang|poison|overdose)\s+(?:your|my|him|her|them|one)self\b/i,
    /\bhow to overdose\b/i,
];

const MEDICAL_OUTPUT_RE = [
    /\binject this (?:amount|dose|much)\b/i,
    /\btake this (?:amount|many|dose)\b/i,
    /\byou should (?:inject|take)\s+\d+\s+units\b/i,
];

// ── Responses ────────────────────────────────────────────────────────────────

export const CRISIS_RESPONSE = "I'm concerned about your safety. Please call or text 988 (Suicide & Crisis Lifeline) right now — available 24/7. If in immediate danger, call 911. International: findahelpline.com. You are not alone.";
export const MEDICAL_RESPONSE = "I cannot provide specific medical dosing advice. Please contact your doctor or pharmacist. For emergencies, call 911.";

// ── API ──────────────────────────────────────────────────────────────────────

function normalize(text: string): string {
    return text
        .toLowerCase()
        .replace(/\p{Cf}/gu, "")
        .replace(/\p{Mn}/gu, "")      // Arabic harakat + all combining marks
        .replace(/ـ/g, "")
        .replace(/[أإآ]/g, "ا")
        .replace(/\s+/g, " ");
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
