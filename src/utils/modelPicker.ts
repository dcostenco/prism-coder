/**
 * RAM-Gated Local Model Picker
 * ─────────────────────────────────────────────────────────────
 * Cascade: 14b (default) → 4b (verifier) → 32b (complex only).
 *
 * The default ceiling is "14b" — NOT "32b". This means:
 *   - 14b is the primary model for routing + general inference
 *   - 4b is used as the grounding verifier (fast, small)
 *   - 32b is only loaded when caller explicitly passes ceiling="32b"
 *     or when the task requires maximum quality (complex code gen, etc.)
 *
 * This saves 10GB+ RAM on most devices and keeps response times fast.
 * The 14b achieves 100% on eval_300 — same as 32b.
 *
 *   tag                 weights   need free   ctx     role
 *   prism-coder:32b     ~19 GB    ≥ 24 GB     32K    complex (on-demand)
 *   prism-coder:14b     ~ 9 GB    ≥ 12 GB     32K    default router
 *   qwen3.5:4b      ~ 2.5 GB  ≥  4 GB      8K    verifier + mobile
 *   prism-coder:1b7     ~ 2 GB    ≥  3 GB      8K    watch + ultra-low RAM
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
 */
export const MODEL_TIERS: ReadonlyArray<ModelChoice> = [
    { tag: 'prism-coder:32b',  weightsGb: 19, minFreeGb: 24, ctxTokens: 32_768 },
    { tag: 'prism-coder:14b',  weightsGb:  9, minFreeGb: 12, ctxTokens: 32_768 },
    { tag: 'qwen3.5:4b',   weightsGb:  2.5, minFreeGb: 4, ctxTokens:  8_192 },
    { tag: 'prism-coder:1b7',  weightsGb:  2, minFreeGb:  3, ctxTokens:  8_192 },
];

/**
 * True when `installed` matches `tierTag` either as a bare tag
 * (`prism-coder:32b`) or as a namespaced HuggingFace-style tag
 * (`dcostenco/prism-coder:32b`). The README documents `ollama pull
 * dcostenco/prism-coder:32b`, so Ollama's /api/tags returns the
 * namespaced form — without this matcher the picker would never
 * see them and silently fall through to cloud.
 */
function tagMatches(installed: string, tierTag: string): boolean {
    return installed === tierTag || installed.endsWith(`/${tierTag}`);
}

/** Default ceiling: 14b. Pass ceiling="32b" explicitly for max quality. */
export const DEFAULT_CEILING = "14b";

/**
 * Pick the best viable tier for the given free RAM.
 * Default ceiling is 14b — use ceiling="32b" only for complex tasks.
 *
 * @param freeBytes  Result of os.freemem() — binary bytes
 * @param ceiling    Cap tier. Default "14b". Pass "32b" for complex tasks.
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
 * If `installed` contains a namespaced match (e.g. `dcostenco/prism-coder:32b`),
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
