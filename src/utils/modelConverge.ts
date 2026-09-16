/**
 * Model convergence for `prism connect` — the missing half of self-update.
 *
 * selfUpdate.ts converges the PACKAGE; nothing converged the MODELS. The gap
 * was measured on 2026-08-18: the vision-restored artifacts had been on the
 * Ollama registry for four days while a laptop that pulled earlier kept
 * refusing image requests (layer1_classifier_no_vision) — and on the machine
 * where this was written, the `prism-coder:2b` alias pointed at different
 * bytes than `dcostenco/prism-coder:2b`, because `ollama cp` makes a
 * SNAPSHOT: a re-pull updates the source name and silently leaves every
 * alias behind.
 *
 * Design decisions, in order of importance:
 *
 * 1. DELEGATE freshness to `ollama pull`. The registry serves no
 *    docker-content-digest header and its manifest body hash is not the
 *    digest ollama reports locally, so a client-side digest comparison
 *    would reimplement (and drift from) ollama's own logic. `ollama pull`
 *    of an up-to-date tag is a manifest check that downloads nothing.
 *
 * 2. REPAIR the alias after every pull. `prism-coder:<t>` must equal
 *    `dcostenco/prism-coder:<t>` byte-for-byte; when digests differ, re-cp.
 *    This is the trap register-models cannot fix on its own — it only
 *    aliases tags that are MISSING, not tags that are stale.
 *
 * 3. Converge only tiers the machine already has (either the alias or the
 *    namespaced source). Convergence updates what you chose to install; it
 *    never decides that a 16 GB model belongs on your laptop.
 *
 * 4. Models must never break connect. Ollama down, registry unreachable,
 *    one tier failing — report and continue. A machine with stale models
 *    and fresh config beats a machine with neither.
 */

export const MODEL_NAMESPACE = "dcostenco/prism-coder";
export const LOCAL_PREFIX = "prism-coder";
export const CONVERGE_TIERS = ["2b", "4b", "9b", "27b"] as const;

export interface TagInfo {
    name: string;
    digest: string;
}

/** What /api/show says about a tag: the weights blob it is built FROM and
 *  whether a local Modelfile pinned num_ctx on it (scripts/*.Modelfile). */
export interface TagFacts {
    weightsBlob: string;
    pinnedNumCtx: number | null;
}

export interface ModelConvergeDeps {
    /** GET <ollamaUrl>/api/tags → installed models with digests. Throws when unreachable. */
    listTags: () => Promise<TagInfo[]>;
    /** POST <ollamaUrl>/api/show → weights blob + num_ctx pin. Null when unknown.
     *  Optional: without it staleness falls back to the digest comparison. */
    tagFacts?: (name: string) => Promise<TagFacts | null>;
    /** `ollama pull <ref>` — throws on failure. */
    pull: (ref: string) => Promise<void>;
    /** `ollama cp <from> <to>` — throws on failure. */
    copy: (from: string, to: string) => Promise<void>;
    log: (line: string) => void;
    dryRun?: boolean;
}

export interface TierOutcome {
    tier: string;
    action: "pulled_and_aliased" | "aliased_only" | "up_to_date" | "skipped_not_installed" | "failed";
    detail?: string;
}

/** Exit rule for the standalone command: one installed tier that did not
 *  converge is a failure worth a non-zero exit, not only "every tier failed"
 *  (a one-tier host reports three skipped_not_installed and would exit 0). */
export function convergeFailed(outcomes: ReadonlyArray<{ action: string }>): boolean {
    return outcomes.some(o => o.action === "failed");
}

export async function convergeModels(deps: ModelConvergeDeps): Promise<TierOutcome[]> {
    let tags: TagInfo[];
    try {
        tags = await deps.listTags();
    } catch (err) {
        deps.log(`− model convergence skipped: Ollama unreachable (${err instanceof Error ? err.message : String(err)})`);
        return CONVERGE_TIERS.map((tier) => ({ tier, action: "failed" as const, detail: "ollama_unreachable" }));
    }

    const byName = new Map(tags.map((t) => [t.name, t]));
    const outcomes: TierOutcome[] = [];

    for (const tier of CONVERGE_TIERS) {
        const source = `${MODEL_NAMESPACE}:${tier}`;
        const alias = `${LOCAL_PREFIX}:${tier}`;
        const hadSource = byName.has(source);
        const hadAlias = byName.has(alias);

        if (!hadSource && !hadAlias) {
            outcomes.push({ tier, action: "skipped_not_installed" });
            continue;
        }

        if (deps.dryRun) {
            deps.log(`• would pull ${source} and repair the ${alias} alias if stale`);
            outcomes.push({ tier, action: "up_to_date", detail: "dry_run" });
            continue;
        }

        try {
            const digestBefore = byName.get(source)?.digest;
            await deps.pull(source);

            // Re-list AFTER the pull: both the freshness answer and the alias
            // comparison must come from post-pull state, or a pull that
            // changed bytes looks identical to one that did nothing.
            const after = await deps.listTags();
            const afterByName = new Map(after.map((t) => [t.name, t]));
            const sourceNow = afterByName.get(source);
            const aliasNow = afterByName.get(alias);

            if (!sourceNow) {
                outcomes.push({ tier, action: "failed", detail: "source_missing_after_pull" });
                deps.log(`⚠ ${source}: pull reported success but the tag is not installed`);
                continue;
            }

            const pulledNewBytes = digestBefore !== undefined && digestBefore !== sourceNow.digest;
            let aliasStale = !aliasNow || aliasNow.digest !== sourceNow.digest;

            // A digest mismatch is not always stale bytes. Adopting
            // scripts/prism-coder-9b.Modelfile rebuilds the alias FROM the same
            // weights with `PARAMETER num_ctx 32768`, which changes the manifest
            // digest and nothing else — and this branch would have cp'd the
            // unpinned upstream straight over it on the next converge, silently
            // undoing the pin (found 2026-09-15 before it happened). Stale means
            // OLD WEIGHTS: compare the blobs the two tags are built from.
            let pinnedSameWeights = false;
            let droppedPin: number | null = null;
            if (aliasStale && aliasNow && deps.tagFacts) {
                const [a, src] = await Promise.all([deps.tagFacts(alias), deps.tagFacts(source)]);
                if (a && src) {
                    if (a.weightsBlob === src.weightsBlob) {
                        pinnedSameWeights = a.pinnedNumCtx !== null;
                        aliasStale = false;
                    } else if (a.pinnedNumCtx !== null) {
                        droppedPin = a.pinnedNumCtx;
                    }
                } else {
                    // /api/show failed or had no FROM line: a local pin cannot
                    // be detected, so do NOT overwrite — a digest mismatch may
                    // be nothing but the pin (review 2026-09-16). Hosts without
                    // tagFacts (older callers) keep the digest rule.
                    outcomes.push({ tier, action: "failed", detail: "tag_facts_unavailable_pin_unknown" });
                    deps.log(`? ${alias}: /api/show facts unavailable — left alone (a local num_ctx pin cannot be told from stale weights). Re-run when Ollama answers /api/show, or rebuild deliberately with: ollama cp ${source} ${alias}`);
                    continue;
                }
            }

            if (pinnedSameWeights) {
                outcomes.push({ tier, action: "up_to_date", detail: "locally_pinned" });
                deps.log(`= ${alias} is a local pin on the same weights as ${source} — left alone`);
            } else if (aliasStale) {
                await deps.copy(source, alias);
                if (droppedPin !== null) {
                    outcomes.push({ tier, action: pulledNewBytes || !hadSource ? "pulled_and_aliased" : "aliased_only", detail: "pin_dropped_readopt" });
                    deps.log(`⚠ ${alias} rebuilt on new weights; its num_ctx ${droppedPin} pin is GONE — re-adopt with: ollama create ${alias} -f scripts/${alias.replace(":", "-")}.Modelfile`);
                    continue;
                }
                const action = pulledNewBytes || !hadSource ? "pulled_and_aliased" : "aliased_only";
                outcomes.push({ tier, action });
                deps.log(`✓ ${alias} ${aliasNow ? "re-aliased (was a stale snapshot)" : "aliased"} → ${sourceNow.digest.slice(0, 12)}`);
            } else if (pulledNewBytes) {
                // Alias digest already matches the fresh source — cp raced us
                // or the user re-aliased by hand; either way converged.
                outcomes.push({ tier, action: "pulled_and_aliased" });
                deps.log(`✓ ${source} updated; ${alias} already matches`);
            } else {
                outcomes.push({ tier, action: "up_to_date" });
                deps.log(`= ${alias} up to date (${sourceNow.digest.slice(0, 12)})`);
            }
        } catch (err) {
            outcomes.push({ tier, action: "failed", detail: err instanceof Error ? err.message : String(err) });
            deps.log(`⚠ ${source}: ${err instanceof Error ? err.message : String(err)} — continuing with the other tiers`);
        }
    }

    return outcomes;
}
