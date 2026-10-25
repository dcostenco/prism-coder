/** Local model selection using installed tiers and available memory. */

const GB = 1024 ** 3;

export interface ModelChoice {
    tag: string;
    weightsGb: number;
    minFreeGb: number;
    ctxTokens: number;
    /** Explicit reasoning preference for this tier, when specified. */
    prefersThinking?: boolean;
    /** Local token floor, so reasoning does not crowd out the answer. */
    minLocalTokens?: number;
}

/**
 * Local tier metadata in selection order. Memory values use GiB.
 * Weight estimates and admission requirements are separate quantities;
 * context and memory limits remain subject to provider validation.
 */
export const MODEL_TIERS: ReadonlyArray<ModelChoice> = [
    { tag: 'prism-coder:27b',  weightsGb: 15.6, minFreeGb: 21, ctxTokens: 4_096 },
    { tag: 'prism-coder:9b',   weightsGb:  6.2, minFreeGb:  9, ctxTokens: 4_096,
      prefersThinking: true, minLocalTokens: 2_048 },
    // An explicit false preference differs from an unspecified preference.
    { tag: 'prism-coder:4b',   weightsGb:  3.2, minFreeGb:  5.2, ctxTokens: 32_768,
      prefersThinking: false },
    { tag: 'prism-coder:2b',   weightsGb:  3, minFreeGb:  4.5, ctxTokens: 32_768,
      prefersThinking: false },
];

/** Match a bare tier tag or its namespaced installed form. */
function tagMatches(installed: string, tierTag: string): boolean {
    return installed === tierTag || installed.endsWith(`/${tierTag}`);
}

/** Default ceiling when the caller does not specify one. */
export const DEFAULT_CEILING = "9b";

/**
 * Pick the first installed tier that meets the local memory requirement.
 *
 * @param freeBytes  Available-memory estimate in bytes.
 * @param ceiling    Optional tier ceiling.
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
