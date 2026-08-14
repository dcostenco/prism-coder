/**
 * Layer 1 semantic pre-classifier for prism_infer.
 * ─────────────────────────────────────────────────────────────
 * Calls dcostenco/prism-coder:4b via Ollama to classify whether
 * a prompt is OBVIOUS_RESERVED, OBVIOUS_NOT_RESERVED, or UNCERTAIN.
 *
 * Fail-closed contract:
 *   OBVIOUS_NOT_RESERVED → permits local routing
 *   OBVIOUS_RESERVED     → escalate to cloud
 *   UNCERTAIN            → escalate to cloud (conservative)
 *   UNCERTAIN_LENGTH     → §5.3: prompt too long to classify in full, but the
 *                          full-text keyword floor is clean AND a head+tail
 *                          excerpt classified clean — permits local routing
 *                          with a distinct audit marker ("too long to classify"
 *                          ≠ "semantically uncertain")
 *   ERROR                → escalate to cloud (never fail-open)
 *
 * The prompt below is VERBATIM from §E of prism-infer-boundaries/SKILL.md.
 * It is duplicated here (not imported) because prism is a thin client with no
 * access to the skills tree at runtime. A drift test asserts byte-for-byte match.
 *
 * Must not run when mode="route" and max_tokens<=16 — that IS a Layer 1 call.
 */

export type Layer1Verdict =
    | "OBVIOUS_RESERVED"
    | "OBVIOUS_NOT_RESERVED"
    | "UNCERTAIN"
    | "UNCERTAIN_LENGTH"
    | "ERROR";

// VERBATIM — §E prism-infer-boundaries/SKILL.md.
// Changes require the private Layer 1 evaluation gate before release.
export const LAYER1_PROMPT = `Classify this request with exactly one word: OBVIOUS_RESERVED, OBVIOUS_NOT_RESERVED, or UNCERTAIN.

OBVIOUS_RESERVED — clearly involves:
- Behavioral crisis: de-escalation, meltdown management, rage episode, violent behavior response
- Physical restraint, holds, containment, physical management of clients
- Self-harm: client bites/hits/scratches/bangs self, draws blood, injures self
- Suicide, homicide, harm to self or others, safety planning
- Client physical elopement incidents — client ran away, bolted, or escaped (with prior documented incidents)
- Writing auth/login/JWT/token/session validation code
- Determining if code bypasses auth or allows unauthenticated access
- Assessing whether code actually exposes PHI or constitutes a HIPAA violation
- Whether to push, ship, deploy, block, stop shipping, or make a production go/no-go decision
- Medication choice, prescribing, or dosing
- Diagnosis code assignment or professional sign-off

OBVIOUS_NOT_RESERVED — general coding, code review, analysis, documentation, test generation, or data processing. Also routine non-crisis BCBA measurement and operational definitions; tentative ABC/FBA hypotheses; data gathering before intervention when no injury or imminent danger is stated; educational explanations of function-matched intervention concepts; dignity-preserving language; caregiver training; AAC access rights and replacement-response candidates for BCBA review; and explaining continued AAC access or nonrestrictive positioning when no injury is reported.

UNCERTAIN — if the request touches reserved vocabulary but the task is non-security, non-clinical operational work (e.g., deleting or renaming a file, adding a non-auth data field to a form, reviewing existing code for dead exports or hook order) rather than writing clinical safety protocols, implementing auth or security code, making push or deploy decisions, or determining compliance.

Request: "{prompt}"

Answer (one word):`;

const VALID: ReadonlySet<string> = new Set([
    "OBVIOUS_RESERVED",
    "OBVIOUS_NOT_RESERVED",
    "UNCERTAIN",
]);

/**
 * Parse the model's raw text into a verdict. Extracts the first token of
 * letters/underscores (ignoring leading punctuation, quotes, whitespace).
 * Anything not in the valid set → ERROR, which the caller escalates.
 * Note: OBVIOUS_NOT_RESERVED contains "RESERVED" as a substring — whole-token
 * matching via Set prevents the substring trap from inverting the gate.
 */
export function parseLayer1(raw: string | null | undefined): Layer1Verdict {
    if (!raw) return "ERROR";
    const m = raw.trim().toUpperCase().match(/[A-Z_]+/);
    if (!m) return "ERROR";
    const token = m[0];
    return VALID.has(token) ? (token as Layer1Verdict) : "ERROR";
}

type IntentRule = (prompt: string) => boolean;

const has = (pattern: RegExp): IntentRule => (prompt) => pattern.test(prompt);
const all = (...rules: IntentRule[]): IntentRule => (prompt) => rules.every((rule) => rule(prompt));

const RESERVED_INTENT_RULES: readonly IntentRule[] = [
    all(
        has(/\b(?:de[- ]?escalat\w*|meltdown\w*|rage\s+episode|violent\w*)\b/i),
        has(/\b(?:draft|write|plan|procedure|protocol|manag\w*|what\s+(?:do|should)\b|respond\w*)\b/i),
    ),
    all(
        has(/\b(?:physical\s+intervention|containment|hold\s+procedure|restrain\w*|seclu\w*|physical\s+management)\b/i),
        has(/\b(?:draft|write|document|procedure|protocol|use|implement|instruct\w*)\b/i),
    ),
    all(
        has(/\b(?:self[- ]?(?:harm|injur\w*)|bites?\s+(?:him|her|them)self|scratches?\s+(?:him|her|them)self|bangs?\s+(?:his|her|their)\s+head|harm\s+(?:himself|herself|themselves))\b/i),
        has(/\b(?:bleed\w*|blood|concrete|head\s+impact|medical\s+attention|risk(?:\s+of\s+injury)?|causes?\s+injury|actual\s+injury|assess\w*|screen\w*|want\w*)\b/i),
    ),
    (prompt) => (
        /\b(?:punch\w*|attack\w*|aggress\w*|hit\s+staff)\b/i.test(prompt)
        && /\b(?:last\s+(?:week|month|year)|prior|previous|history|injur\w*)\b/i.test(prompt)
        && !/\bno\s+injur(?:y|ies)\b/i.test(prompt)
        && /\b(?:plan|procedure|intervention|assess\w*)\b/i.test(prompt)
    ),
    has(/\b(?:suicid\w*|homicid\w*)\b/i),
    all(
        has(/\b(?:write|implement|create|build|add|modify|update|fix|refactor)\b/i),
        has(/\b(?:auth\w*|login|jwt|tokens?|sessions?|api\s+keys?)\b/i),
        has(/\b(?:verify|verification|validat\w*|check\w*|middleware|handler)\b/i),
    ),
    all(
        has(/\b(?:does|can|could|whether|write|implement|create|build|add|modify|update|fix|refactor)\b/i),
        has(/\b(?:endpoint|route|user|someone|permissions?|authenticat\w*|authoriz\w*)\b/i),
        has(/\b(?:without|bypass\w*|unauthenticated|not\s+check\w*|lets?\s+anyone|anyone\s+in)\b/i),
    ),
    all(
        has(/\b(?:ship\w*|deploy\w*|prod(?:uction)?|release\w*)\b/i),
        has(/\b(?:safe|bad\s+enough|finding\w*|go\s+to|stop|block|ready|whether|can\s+we|should\s+we)\b/i),
    ),
    all(
        has(/\b(?:expos\w*|intercept\w*|leak\w*|access\w*)\b/i),
        has(/\b(?:phi|patient\s+(?:records?|data)|health\s+(?:records?|data))\b/i),
    ),
    all(
        has(/\b(?:medicat\w*|prescrib\w*|dos(?:e|age|ing))\b/i),
        has(/\b(?:choose|recommend\w*|select|schedule|mg|how\s+much)\b/i),
    ),
    all(
        has(/\b(?:diagnos\w*|icd[- ]?\d*)\b/i),
        has(/\b(?:assign|choose|sign[- ]?off|approve|determine)\b/i),
    ),
];

const ROUTINE_BCBA_INTENT_RULES: readonly IntentRule[] = [
    has(/\boperational\s+definition\b/i),
    all(
        has(/\bdefin\w*\b/i),
        has(/\b(?:onset|offset|observers?|score|measur\w*)\b/i),
    ),
    all(
        has(/\b(?:abc|fba|functional\s+behavior)\b/i),
        has(/\b(?:hypothes\w*|tentative|summari[sz]\w*)\b/i),
    ),
    all(
        has(/\b(?:what\s+data|data\s+(?:should|to)\s+(?:be\s+)?gather\w*|collect\s+data)\b/i),
        has(/\bbefore\s+(?:select\w*|choos\w*|design\w*)\s+(?:an?\s+)?intervention\b/i),
    ),
    all(
        has(/\b(?:aac|augmentative\s+communication)\b/i),
        has(/\b(?:replacement[- ]response|replacement\s+(?:skill|behavior)|function[- ]matched)\b/i),
        has(/\b(?:bcba|clinician)\s+review\b/i),
    ),
    all(
        has(/\b(?:explain|educat\w*|why)\b/i),
        has(/\b(?:dro|differential\s+reinforcement|function[- ]matched|maintain\w+\s+by|escape\s+from)\b/i),
    ),
    all(
        has(/\b(?:caregiver|staff|parent)\s+training\b/i),
        has(/\b(?:aac|replacement|break[- ]request|communication)\b/i),
    ),
    all(
        has(/\b(?:rewrite|rephrase)\b/i),
        has(/\b(?:stigmat\w*|dignity|objective|tentative|function[- ]based)\b/i),
    ),
    all(
        has(/\b(?:aac|communication\s+device)\b/i),
        has(/\b(?:remain|keep)\s+available\b/i),
        has(/\bno\s+injur(?:y|ies)\b/i),
        has(/\bnonrestrictive\b/i),
    ),
];

function matchesAny(prompt: string, rules: readonly IntentRule[]): boolean {
    return rules.some((rule) => rule(prompt));
}

const NON_OPERATIONAL_ARTIFACT_CONTEXT =
    /(?:\b(?:test\s+fixture|fixture\s+label|unit\s+test|old\s+comment|fields?|columns?|labels?|filename|file\s+name|docs?|legal\s+(?:label|phrase|clause)|hook\s+order|dead\s+exports?|type\s+annotation|table\s+scan|add\s+index)\b|\/docs\/|\.[cm]?[jt]sx?\b)/i;
const NON_OPERATIONAL_ARTIFACT_ACTION =
    /\b(?:review\b[\s\S]{0,120}\bhook\s+order|delete\b[\s\S]{0,120}\bdocs?|unit\s+tests?|add\b[\s\S]{0,120}\b(?:fields?|index|labels?|numeric\s+validation)|remove\b[\s\S]{0,120}\bcomments?|old\s+comment\b[\s\S]{0,120}\bremove)\b/i;

/**
 * Deterministic policy floor for unambiguous intents.
 *
 * Routing is code, not model judgment: clear reserved work fails closed and
 * clear routine BCBA work reaches local inference. Ambiguous prompts return
 * null and continue to the semantic classifier below.
 */
export function classifyDeterministicLayer1(userPrompt: string): Layer1Verdict | null {
    if (matchesAny(userPrompt, RESERVED_INTENT_RULES)) return "OBVIOUS_RESERVED";
    if (
        NON_OPERATIONAL_ARTIFACT_CONTEXT.test(userPrompt) &&
        NON_OPERATIONAL_ARTIFACT_ACTION.test(userPrompt)
    ) {
        return "OBVIOUS_NOT_RESERVED";
    }
    if (matchesAny(userPrompt, ROUTINE_BCBA_INTENT_RULES)) return "OBVIOUS_NOT_RESERVED";
    return null;
}

const LAYER1_TIMEOUT_MS = 1_500;
/** Image classify budget. A vision pass carries ~3,000 image tokens; the
 *  1.5s text budget would time out every call and make the gate useless —
 *  a gate that always errors is a gate that never gates. */
export const LAYER1_IMAGE_TIMEOUT_MS = 10_000;
const LAYER1_RETRY_TIMEOUT_MS = 5_000;

// Deterministic reserved-vocabulary backstop for the ERROR path.
// These patterns catch reserved content when the classifier is unavailable.
// Not sufficient alone (adversaries can paraphrase), but as an ERROR-path
// floor they block the obvious cases that padding/injection attacks
// would otherwise smuggle through.
const RESERVED_KEYWORDS = /\b(restrain\w*|seclu(?:sion|d\w*)|physical\s*holds?|(?:prone|supine|basket|therapeutic|manual|two[- ]?person)\s+holds?|hold(?:ing)?\s+(?:the\s+)?(?:client|child|student|patient)\s+down|containment|self[- ]?harm\w*|suicid\w*|overdos\w*|dos(?:age|ing)\s*(?:mg|schedule)|crisis\s*de[- ]?escalation|meltdown\s*management|rage\s+episode|elopement\s*incident)\b/i;

/**
 * Deterministic keyword check — the ERROR-path floor.
 * Returns OBVIOUS_RESERVED if reserved vocabulary is present,
 * OBVIOUS_NOT_RESERVED otherwise. Used only when the LLM classifier
 * fails (timeout, model not loaded, injection attack).
 */
export function keywordBackstop(prompt: string): Layer1Verdict {
    return RESERVED_KEYWORDS.test(prompt) ? "OBVIOUS_RESERVED" : "OBVIOUS_NOT_RESERVED";
}

// Over-length prompts are attacker-controlled — don't let length
// select the ERROR branch. §5.3: instead of a blanket UNCERTAIN (which
// routed every big benign prompt to cloud-or-refuse — v1 FATAL #3), run
// the deterministic keyword floor over the FULL text, then classify a
// bounded head+tail excerpt. A clean floor + clean excerpt yields the
// distinct UNCERTAIN_LENGTH verdict so callers can tell "too long to
// classify" from "semantically uncertain".
const MAX_CLASSIFIER_PROMPT_LENGTH = 4_000;
// Excerpt budget: head + middle + tail must stay under the classifier cap
// with room for the LAYER1_PROMPT template. The sampled middle window
// narrows the region an attacker can hide paraphrased reserved content in
// (adversarial-review finding: keyword-free paraphrases in the unseen
// middle are the residual gap — the window makes padding placement
// harder; the full-text keyword floor remains the deterministic net).
const EXCERPT_HEAD_CHARS = 2_000;
const EXCERPT_MID_CHARS = 400;
const EXCERPT_TAIL_CHARS = 1_400;

/** Bounded head+middle+tail excerpt of an oversize prompt (§5.3). Exported for tests. */
export function buildOversizeExcerpt(prompt: string): string {
    const midStart = Math.max(
        EXCERPT_HEAD_CHARS,
        Math.floor(prompt.length / 2) - EXCERPT_MID_CHARS / 2,
    );
    const middle = prompt.slice(midStart, midStart + EXCERPT_MID_CHARS);
    return (
        prompt.slice(0, EXCERPT_HEAD_CHARS) +
        "\n[…]\n" +
        middle +
        "\n[…]\n" +
        prompt.slice(-EXCERPT_TAIL_CHARS)
    );
}

/**
 * Run the Layer 1 classifier with retry on cold-model timeout.
 * Returns a verdict; never throws.
 *
 * Flow: classify → if ERROR, retry once with longer timeout →
 * if still ERROR, return ERROR (caller uses keywordBackstop).
 *
 * Oversize flow (§5.3): full-text keyword floor → excerpt classification →
 * reserved/uncertain excerpt verdicts keep full reserved handling;
 * a clean excerpt returns UNCERTAIN_LENGTH.
 */
export async function callLayer1(
    userPrompt: string,
    ollamaUrl: string,
    model: string,
    fetchImpl: typeof fetch = fetch,
    /** Images accompanying the request. The classifier MUST see them: a
     *  screenshot of clinical material would otherwise pass a gate that only
     *  ever read the text prompt. */
    images?: string[],
): Promise<Layer1Verdict> {
    if (!userPrompt || !userPrompt.trim()) return "ERROR";

    const oversize = userPrompt.length > MAX_CLASSIFIER_PROMPT_LENGTH;
    const deterministic = classifyDeterministicLayer1(userPrompt);
    if (deterministic === "OBVIOUS_RESERVED") return deterministic;
    if (!oversize && deterministic === "OBVIOUS_NOT_RESERVED") return deterministic;

    if (oversize && keywordBackstop(userPrompt) === "OBVIOUS_RESERVED") {
        // The regex floor has no length limit — reserved vocabulary anywhere
        // in the full text (including the middle the excerpt can't see)
        // short-circuits to reserved handling.
        return "OBVIOUS_RESERVED";
    }
    const classifierInput = oversize ? buildOversizeExcerpt(userPrompt) : userPrompt;

    const classify = async (timeoutMs: number): Promise<Layer1Verdict> => {
        let res: Response;
        try {
            res = await fetchImpl(`${ollamaUrl}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model,
                    messages: [
                        {
                            role: "user",
                            content: LAYER1_PROMPT.replace("{prompt}", classifierInput),
                            ...(images?.length ? { images } : {}),
                        },
                    ],
                    stream: false,
                    think: false,
                    options: { num_predict: 16, temperature: 0 },
                }),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch {
            return "ERROR";
        }

        if (!res.ok) return "ERROR";

        let data: unknown;
        try {
            data = await res.json();
        } catch {
            return "ERROR";
        }

        if ((data as { error?: string })?.error) return "ERROR";
        const text = (data as { message?: { content?: string } })?.message?.content;
        return parseLayer1(text);
    };

    // Image requests get the vision budget on both attempts, and an ERROR is
    // mapped to UNCERTAIN: with text, ERROR falls through to a keyword backstop
    // that can still read the prompt; with an image there is NOTHING to fall
    // back on — the gate saw nothing — so unclassifiable image content must be
    // treated as reserved-handling, never silently allowed.
    const hasImages = !!images?.length;
    const firstBudget = hasImages ? LAYER1_IMAGE_TIMEOUT_MS : LAYER1_TIMEOUT_MS;
    const retryBudget = hasImages ? LAYER1_IMAGE_TIMEOUT_MS : LAYER1_RETRY_TIMEOUT_MS;
    const first = await classify(firstBudget);
    const settled = first !== "ERROR" ? first : await classify(retryBudget);
    const verdict: Layer1Verdict = (hasImages && settled === "ERROR") ? "UNCERTAIN" : settled;

    if (!oversize) return verdict;

    // §5.3 oversize mapping:
    //   excerpt OBVIOUS_RESERVED / UNCERTAIN → keep full reserved handling
    //   excerpt OBVIOUS_NOT_RESERVED        → UNCERTAIN_LENGTH (distinct verdict)
    //   excerpt ERROR                       → UNCERTAIN_LENGTH — the deterministic
    //     keyword floor already cleared the FULL text above, which is the same
    //     floor the normal-size ERROR path falls back to via the caller.
    if (verdict === "OBVIOUS_RESERVED" || verdict === "UNCERTAIN") return verdict;
    return "UNCERTAIN_LENGTH";
}
