/**
 * RAM-Gated Local Model Picker
 * ─────────────────────────────────────────────────────────────
 * Cascade: 9b (default) → 4b (verifier) → 2b (mobile) → 27b (quality).
 *
 * The default ceiling is "9b" — NOT "27b". This means:
 *   - 9b is the primary model for routing + general inference (Qwen3.5-9B, 100% BFCL)
 *   - 4b is used as the grounding verifier (fast, small)
 *   - 2b is the mobile/iPhone first gate (Qwen3.5-2B, 99.1% BFCL)
 *   - 27b is only loaded when caller explicitly passes ceiling="27b"
 *     or when the task requires maximum quality (complex code gen, etc.)
 *
 * This saves 11GB+ RAM vs 27b and keeps response times fast.
 *
 *   tag                 weights   need free   ctx     role
 *   prism-coder:27b     ~16 GB    ≥ 20 GB      4K    quality (on-demand, Qwen3.5 DeltaNet, 100% BFCL)
 *   prism-coder:9b      ~ 5.8 GB  ≥  8 GB      4K    default router (Qwen3.5, 100% BFCL)
 *   prism-coder:4b      ~ 3.4 GB  ≥  5 GB     32K    verifier (Qwen3.5, 100%)
 *   prism-coder:2b      ~ 2.3 GB  ≥  3 GB     32K    mobile / iPhone (Qwen3.5, 99.1%)
 *
 * Below 3 GB free → no local pick (caller must use cloud).
 */

const GB = 1024 ** 3;

export interface ModelChoice {
    tag: string;
    weightsGb: number;
    minFreeGb: number;
    ctxTokens: number;
}

/**
 * Tier table, ordered LARGEST → SMALLEST. Picker walks this and returns
 * the first row whose minFreeGb fits within freeBytes.
 *
 * ctxTokens (§5.4): aligned with the LIVE Modelfile `num_ctx` values
 * (verified via `ollama show <tag> --modelfile` on 2026-07-20). The values
 * are inverted from intuition — the 27b/9b Modelfiles bake num_ctx 4096
 * while 4b/2b bake 32768. The tier walk skips tiers whose ctx cannot hold
 * prompt + output (reason: ctx_insufficient) — Ollama otherwise silently
 * truncates the prompt and answers from the fragment. If a Modelfile's
 * num_ctx is ever raised, update the row here (a raise is a measured
 * decision with KV-cache RAM costed — plan v2 §5.4).
 */
export const MODEL_TIERS: ReadonlyArray<ModelChoice> = [
    { tag: 'prism-coder:27b',  weightsGb: 16, minFreeGb: 20, ctxTokens: 4_096 },
    { tag: 'prism-coder:9b',   weightsGb:  5.8, minFreeGb:  8, ctxTokens: 4_096 },
    { tag: 'prism-coder:4b',   weightsGb:  3.4, minFreeGb:  5, ctxTokens: 32_768 },
    { tag: 'prism-coder:2b',   weightsGb:  2.3, minFreeGb:  3, ctxTokens: 32_768 },
];

/**
 * True when `installed` matches `tierTag` either as a bare tag
 * (`prism-coder:27b`) or as a namespaced HuggingFace-style tag
 * (`dcostenco/prism-coder:27b`). The README documents `ollama pull
 * dcostenco/prism-coder:27b`, so Ollama's /api/tags returns the
 * namespaced form — without this matcher the picker would never
 * see them and silently fall through to cloud.
 */
function tagMatches(installed: string, tierTag: string): boolean {
    return installed === tierTag || installed.endsWith(`/${tierTag}`);
}

/** Default ceiling: 9b. Pass ceiling="27b" explicitly for max quality. */
export const DEFAULT_CEILING = "9b";

/**
 * Pick the best viable tier for the given free RAM.
 * Default ceiling is 9b — use ceiling="27b" only for complex tasks.
 *
 * @param freeBytes  Result of os.freemem() — binary bytes
 * @param ceiling    Cap tier. Default "9b". Pass "27b" for complex tasks.
 * @param available  Optional whitelist of installed Ollama tags.
 */
export function pickLocalModel(
    freeBytes: number,
    ceiling?: string,
    available?: ReadonlySet<string>,
): ModelChoice | null {
    if (!Number.isFinite(freeBytes) || freeBytes <= 0) return null;

    const effectiveCeiling = ceiling || DEFAULT_CEILING;
    const ceilingIdx = MODEL_TIERS.findIndex(t => t.tag.endsWith(`:${effectiveCeiling}`));
    const startIdx = ceilingIdx >= 0 ? ceilingIdx : 0;

    for (let i = startIdx; i < MODEL_TIERS.length; i++) {
        const tier = MODEL_TIERS[i];
        if (freeBytes < tier.minFreeGb * GB) continue;
        if (available) {
            let found = false;
            for (const a of available) {
                if (tagMatches(a, tier.tag)) { found = true; break; }
            }
            if (!found) continue;
        }
        return tier;
    }
    return null;
}

/**
 * Resolve a tier tag to the actual Ollama name installed locally.
 * If `installed` contains a namespaced match (e.g. `dcostenco/prism-coder:27b`),
 * the namespaced form is returned so Ollama's /api/generate finds it.
 * Falls back to the bare tag when only the bare form is present.
 */
export function resolveOllamaName(tierTag: string, installed: ReadonlySet<string>): string {
    if (installed.has(tierTag)) return tierTag;
    for (const a of installed) {
        if (a.endsWith(`/${tierTag}`)) return a;
    }
    return tierTag;
}

/**
 * Format a byte count for logging. 12_884_901_888 → "12.0 GB".
 */
export function fmtGb(bytes: number): string {
    return `${(bytes / GB).toFixed(1)} GB`;
}
