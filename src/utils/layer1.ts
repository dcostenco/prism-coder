/**
 * Layer 1 semantic pre-classifier for prism_infer.
 * ─────────────────────────────────────────────────────────────
 * Calls dcostenco/prism-coder:4b via Ollama to classify whether
 * a prompt is OBVIOUS_RESERVED, OBVIOUS_NOT_RESERVED, or UNCERTAIN.
 *
 * Fail-closed contract:
 *   OBVIOUS_NOT_RESERVED → the ONLY verdict that permits local routing
 *   OBVIOUS_RESERVED     → escalate to cloud
 *   UNCERTAIN            → escalate to cloud (conservative)
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

// p95 measured 484–511ms on warm 4b; 1500ms is a generous ceiling that still
// fails closed on model stall without blocking the handler for too long.
const LAYER1_TIMEOUT_MS = 1_500;

/**
 * Run the Layer 1 classifier. Returns a verdict; never throws.
 * On ANY failure path returns "ERROR" so the caller escalates to cloud.
 *
 * @param userPrompt  the end-user prompt being classified (NOT the LAYER1_PROMPT)
 * @param ollamaUrl   Ollama base URL
 * @param model       classifier model tag (caller-resolved via resolveOllamaName)
 * @param fetchImpl   injected for tests; defaults to global fetch
 */
export async function callLayer1(
    userPrompt: string,
    ollamaUrl: string,
    model: string,
    fetchImpl: typeof fetch = fetch,
): Promise<Layer1Verdict> {
    if (!userPrompt || !userPrompt.trim()) return "ERROR";

    let res: Response;
    try {
        res = await fetchImpl(`${ollamaUrl}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model,
                messages: [
                    { role: "user", content: LAYER1_PROMPT.replace("{prompt}", userPrompt) },
                ],
                stream: false,
                think: false,
                options: { num_predict: 16, temperature: 0 },
            }),
            signal: AbortSignal.timeout(LAYER1_TIMEOUT_MS),
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
}
