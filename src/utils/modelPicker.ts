/**
 * RAM-Gated Local Model Picker
 * ─────────────────────────────────────────────────────────────
 * Pure function. Given free RAM in bytes, return the largest
 * prism-coder tag whose Q4_K_M weights + KV-cache headroom fit.
 *
 * Thresholds reflect observed footprint on Apple Silicon with
 * 8K–32K context windows (Q4_K_M weights + KV cache + activations
 * + OS headroom). They are intentionally conservative so picking
 * a tier never OOMs the machine.
 *
 *   tag                 weights   need free   ctx
 *   prism-coder:32b     ~19 GB    ≥ 24 GB     32K
 *   prism-coder:14b     ~ 9 GB    ≥ 12 GB     32K
 *   prism-coder:4b      ~ 2.5 GB  ≥  4 GB      8K
 *   prism-coder:8b      ~ 5 GB    ≥  7 GB     32K
 *   prism-coder:1b7     ~ 2 GB    ≥  3 GB      8K
 *
 * Below 3 GB free → no local pick (caller must use cloud).
 *
 * Note: thresholds use BINARY GB (1024^3) — matches what `os.freemem()`
 * reports on macOS/Linux.
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
    { tag: 'prism-coder:8b',   weightsGb:  5, minFreeGb:  7, ctxTokens: 32_768 },
    { tag: 'prism-coder:4b',   weightsGb:  2.5, minFreeGb: 4, ctxTokens:  8_192 },
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

/**
 * Pick the largest viable tier for the given free RAM.
 * Returns null when no tier fits (caller should go cloud-only).
 *
 * @param freeBytes  Result of os.freemem() — binary bytes
 * @param ceiling    Optional cap (e.g. "14b" to forbid 32B even if RAM allows)
 * @param available  Optional whitelist — only consider tags in this set. Accepts
 *                   bare (`prism-coder:32b`) or namespaced (`dcostenco/prism-coder:32b`).
 */
export function pickLocalModel(
    freeBytes: number,
    ceiling?: string,
    available?: ReadonlySet<string>,
): ModelChoice | null {
    if (!Number.isFinite(freeBytes) || freeBytes <= 0) return null;

    const ceilingIdx = ceiling
        ? MODEL_TIERS.findIndex(t => t.tag.endsWith(ceiling) || t.tag === ceiling)
        : 0;
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
