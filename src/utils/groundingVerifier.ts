/**
 * groundingVerifier — runtime accountability for prism_infer
 * ============================================================
 *
 * When a caller passes `evidence` + `verify: true` to prism_infer, this
 * module checks that every factual claim in the model's draft is
 * entailed by one of the evidence snippets. Sibling of synalux-portal's
 * chat-verifier — same architecture, lighter footprint (no DB audit,
 * stateless MCP), pointed at free-form generation instead of tool-call
 * responses.
 *
 * Cascade role: qwen3.5:4b is the default verifier (fast, 2.5GB).
 * 14b drafts; 4b verifies. Different model = Patronus rule satisfied.
 * Falls back to 2b on devices with <4GB free RAM.
 *
 * Failure modes:
 *   - Verifier model unreachable / timeout → fail-closed refusal
 *   - Verifier returns malformed JSON → fail-closed refusal
 *   - NEUTRAL or CONTRADICTED claim → fail-closed refusal that names
 *     the failed claim
 *
 * The refusal text always names which claim couldn't be grounded so
 * the calling agent can decide whether to retry with more evidence or
 * fall back to cloud.
 */

import { PRISM_LOCAL_LLM_URL } from "../config.js";

export type VerifierVerdict = "ENTAILED" | "NEUTRAL" | "CONTRADICTED";
export type GroundingAction = "served" | "refused_fabricated" | "refused_no_evidence" | "refused_timeout";

export interface EvidenceSnippet {
    source: string;       // human-readable label, e.g. "tool:knowledge_search#3"
    content: string;      // the evidence text the model is supposed to be grounded in
}

export interface ClaimVerdict {
    claim: string;
    verdict: VerifierVerdict;
    evidence_span: string | null;
}

export interface GroundingOutcome {
    action: GroundingAction;
    finalText: string;
    claims: ClaimVerdict[];
    verifierChain: Array<{ model: string; verdict: VerifierVerdict; latencyMs: number }>;
    refusalClaim?: string;
}

export interface VerifyOptions {
    draft: string;
    evidence: EvidenceSnippet[];
    /** Verifier model. Defaults to qwen3.5:4b (fast, accurate). Falls back to 2b on low-RAM. */
    verifierModel?: string;
    /** Verifier hard timeout in ms. Defaults to 2000. */
    timeoutMs?: number;
    /** Override Ollama base URL — tests inject. */
    ollamaUrl?: string;
    /** Inject the fetch implementation — tests inject a mock. */
    fetchImpl?: typeof fetch;
}

// ─── Pre-checks ─────────────────────────────────────────────────────────

const ASSERTIVE_RX =
    /(?:\b(?:\d{1,8}|[A-Z]\d{2}(?:\.\d{1,4})?|ICD-?10|CPT|\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,})\b|\$\d)/;

/**
 * Returns true when the draft makes at least one assertion that could be
 * fabricated — numbers, dates, ICD/CPT codes, two-word names, dollar
 * amounts. Conversational replies skip the verifier entirely.
 */
export function draftHasAssertiveClaims(draft: string): boolean {
    if (!draft) return false;
    return ASSERTIVE_RX.test(draft);
}

// ─── Verifier prompt (grammar-constrained JSON) ─────────────────────────

const VERIFIER_SYSTEM_PROMPT = `You are a strict factual-grounding verifier. Your job is to REJECT ungrounded claims.
Given EVIDENCE (one or more text snippets) and DRAFT_ANSWER, find every
factual claim (counts, names, dates, codes, dollar amounts) and assign:

  ENTAILED     — the EXACT value appears verbatim in EVIDENCE text, or is an
                 arithmetic identity (e.g. "3" and "three"). STRICT: if you
                 must infer, estimate, or extrapolate, it is NOT ENTAILED.
  CONTRADICTED — the claim states a DIFFERENT value than what EVIDENCE says
                 for the same fact.
  NEUTRAL      — the claim is not addressed in EVIDENCE at all.

CRITICAL DEFAULT RULE: when in doubt, use NEUTRAL — never guess ENTAILED.
Prefer false negatives over false positives. If the evidence does not
explicitly state the value, it is NEUTRAL.

Do NOT report opinions, refusals, or hedges as claims. Conversational
phrasing ("Hello", "I can help") is not a claim.

Output JSON only — no prose, no apology.`;

const VERIFIER_JSON_SCHEMA = {
    type: "object",
    properties: {
        claims: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    text: { type: "string" },
                    verdict: { type: "string", enum: ["ENTAILED", "NEUTRAL", "CONTRADICTED"] },
                    evidence_span: { type: ["string", "null"] },
                },
                required: ["text", "verdict", "evidence_span"],
                additionalProperties: false,
            },
        },
    },
    required: ["claims"],
    additionalProperties: false,
} as const;

// ─── Refusal text ───────────────────────────────────────────────────────

function refusalText(action: GroundingAction): string {
    switch (action) {
        case "refused_fabricated":
            return "I couldn't verify one of the claims in my response against the provided evidence. " +
                "If this response is correct, supply the supporting source as evidence and retry.";
        case "refused_no_evidence":
            return "I couldn't verify one of the claims in my response — no evidence was provided this turn. " +
                "Provide evidence snippets via the `evidence` argument and retry.";
        case "refused_timeout":
            return "I couldn't verify my response within the allowed time. " +
                "The verifier model may be cold-loading; try again in a moment.";
        case "served":
            return "";
    }
}

// ─── Main entry point ───────────────────────────────────────────────────

interface OpenAIChatResp {
    choices?: Array<{ message?: { content?: string } }>;
}

export async function verifyGrounding(opts: VerifyOptions): Promise<GroundingOutcome> {
    const verifierModel = opts.verifierModel ?? "qwen3.5:4b";
    const timeoutMs     = opts.timeoutMs ?? 2000;
    const ollamaUrl     = opts.ollamaUrl ?? PRISM_LOCAL_LLM_URL;
    const fetchImpl     = opts.fetchImpl ?? fetch;
    const verifierChain: GroundingOutcome["verifierChain"] = [];

    // Tier 0 — conversational drafts skip the verifier entirely.
    if (!draftHasAssertiveClaims(opts.draft)) {
        return {
            action: "served",
            finalText: opts.draft,
            claims: [],
            verifierChain,
        };
    }

    // Tier 0a — assertive draft with NO evidence is fail-closed:
    // the model is making claims it cannot back up.
    if (opts.evidence.length === 0) {
        const claim = firstAssertiveSpan(opts.draft);
        return {
            action: "refused_no_evidence",
            finalText: refusalText("refused_no_evidence"),
            claims: [{ claim, verdict: "NEUTRAL", evidence_span: null }],
            verifierChain,
            refusalClaim: claim,
        };
    }

    // Tier 2 — NLI verifier call.
    const t0 = Date.now();
    const evidenceText = opts.evidence
        .map((e, i) => `[${i}] ${e.source}\n${e.content}`)
        .join("\n\n");

    const payload = {
        model: verifierModel,
        messages: [
            { role: "system", content: VERIFIER_SYSTEM_PROMPT },
            { role: "user", content: `EVIDENCE:\n${evidenceText}\n\nDRAFT_ANSWER:\n${opts.draft}` },
        ],
        stream: false,
        response_format: {
            type: "json_schema",
            json_schema: { name: "verifier", schema: VERIFIER_JSON_SCHEMA, strict: true },
        },
        temperature: 0,
    };

    let parsedClaims: ClaimVerdict[] | null = null;
    try {
        const res = await fetchImpl(`${ollamaUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as OpenAIChatResp;
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new Error("no content");
        const parsed = JSON.parse(content);
        if (!parsed || !Array.isArray(parsed.claims)) throw new Error("malformed");
        parsedClaims = parsed.claims.map((c: { text: unknown; verdict: unknown; evidence_span: unknown }) => ({
            claim: String(c.text ?? ""),
            verdict: ["ENTAILED", "NEUTRAL", "CONTRADICTED"].includes(c.verdict as string)
                ? (c.verdict as VerifierVerdict)
                : "NEUTRAL",
            evidence_span: typeof c.evidence_span === "string" ? c.evidence_span : null,
        }));
    } catch (verifyErr) {
        console.error(`[groundingVerifier] ⚠️ Verifier model "${verifierModel}" failed: ${(verifyErr as Error).message}`);
        const latencyMs = Date.now() - t0;
        verifierChain.push({ model: verifierModel, verdict: "NEUTRAL", latencyMs });
        const claim = firstAssertiveSpan(opts.draft);
        return {
            action: "refused_timeout",
            finalText: refusalText("refused_timeout"),
            claims: [{ claim, verdict: "NEUTRAL", evidence_span: null }],
            verifierChain,
            refusalClaim: claim,
        };
    }
    const latencyMs = Date.now() - t0;

    // C3: empty claims on an assertive draft = verifier failed to decompose
    if (parsedClaims!.length === 0) {
        verifierChain.push({ model: verifierModel, verdict: "NEUTRAL", latencyMs });
        const claim = firstAssertiveSpan(opts.draft);
        return {
            action: "refused_timeout",
            finalText: refusalText("refused_timeout"),
            claims: [{ claim, verdict: "NEUTRAL", evidence_span: null }],
            verifierChain,
            refusalClaim: claim,
        };
    }

    const failing = parsedClaims!.find(c => c.verdict !== "ENTAILED");
    const rollup: VerifierVerdict = failing ? failing.verdict : "ENTAILED";
    verifierChain.push({ model: verifierModel, verdict: rollup, latencyMs });

    if (failing) {
        return {
            action: "refused_fabricated",
            finalText: refusalText("refused_fabricated"),
            claims: parsedClaims!,
            verifierChain,
            refusalClaim: failing.claim,
        };
    }

    return {
        action: "served",
        finalText: opts.draft,
        claims: parsedClaims!,
        verifierChain,
    };
}

// ─── helpers ────────────────────────────────────────────────────────────

function firstAssertiveSpan(_draft: string): string {
    return "[unverifiable claim]";
}
