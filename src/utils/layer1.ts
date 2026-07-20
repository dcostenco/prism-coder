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

// VERBATIM — §E prism-infer-boundaries/SKILL.md. Do not edit without re-running eval-layer1.mjs.
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
- Whether to push, ship, deploy, or block a production release
- Diagnosis code assignment

OBVIOUS_NOT_RESERVED — general coding, code review, analysis, documentation, test generation, data processing.

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

const LAYER1_TIMEOUT_MS = 1_500;
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
): Promise<Layer1Verdict> {
    if (!userPrompt || !userPrompt.trim()) return "ERROR";

    const oversize = userPrompt.length > MAX_CLASSIFIER_PROMPT_LENGTH;
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
                        { role: "user", content: LAYER1_PROMPT.replace("{prompt}", classifierInput) },
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

    const first = await classify(LAYER1_TIMEOUT_MS);
    const verdict = first !== "ERROR" ? first : await classify(LAYER1_RETRY_TIMEOUT_MS);

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
