/**
 * The tier table must describe the artifacts that are actually published.
 *
 * 2026-08-14: the 2b/4b/9b tags were rebuilt with a vision tower and pushed,
 * changing their on-disk size. MODEL_TIERS still carried the old numbers.
 *
 * The first pass at this test asserted "weightsGb never understates", which was
 * backwards: the two fields want OPPOSITE conservatism. minFreeGb gates
 * admission, so understating it admits a model that cannot fit. weightsGb is
 * credited as memory reclaimed by eviction, so OVERstating it makes the handler
 * unload warm models on a promise it cannot keep. It also let decimal GB from
 * `ollama list` be written into fields the picker multiplies by 1024**3.
 */
import { describe, it, expect } from "vitest";
import { MODEL_TIERS } from "../src/utils/modelPicker.js";

/**
 * Sum of the published manifest layers (model + projector + config) after the
 * 2026-08-14 vision push, converted to GiB — the unit the picker actually uses.
 * Recompute with:
 *   jq '[.layers[].size] + [.config.size] | add'
 *     ~/.ollama/models/manifests/registry.ollama.ai/dcostenco/prism-coder/<tag>
 */
const PUBLISHED_GIB: Record<string, number> = {
  "prism-coder:27b": 15.66,
  "prism-coder:9b": 6.26,
  "prism-coder:4b": 3.23,
  "prism-coder:2b": 3.09,
};

describe("MODEL_TIERS matches published artifacts", () => {
  it("never credits eviction with more memory than the tier occupies", () => {
    for (const tier of MODEL_TIERS) {
      const published = PUBLISHED_GIB[tier.tag];
      expect(published, `unknown tier ${tier.tag}`).toBeDefined();
      expect(tier.weightsGb, `${tier.tag} weightsGb over-credits eviction`)
        .toBeLessThanOrEqual(published);
    }
  });

  it("keeps weightsGb within 10% below the real size, so eviction still fires", () => {
    // The opposite failure: understate weights far enough and the handler never
    // believes eviction can free room, so the ceiling tier is never reachable.
    for (const tier of MODEL_TIERS) {
      expect(tier.weightsGb, `${tier.tag} weightsGb understated — eviction will never fire`)
        .toBeGreaterThan(PUBLISHED_GIB[tier.tag] * 0.9);
    }
  });

  it("gates admission above the real size, with headroom for KV cache", () => {
    for (const tier of MODEL_TIERS) {
      expect(tier.minFreeGb, `${tier.tag} admits a model that cannot fit`)
        .toBeGreaterThan(PUBLISHED_GIB[tier.tag]);
    }
  });

  it("uses GiB, not the decimal GB that `ollama list` prints", () => {
    // A 3.31 GB manifest is 3.09 GiB. Writing ollama's number into a field the
    // picker multiplies by 1024**3 overstates every row by ~7%.
    for (const tier of MODEL_TIERS) {
      const decimalGb = PUBLISHED_GIB[tier.tag] * (1024 ** 3) / 1e9;
      expect(tier.weightsGb, `${tier.tag} looks like decimal GB copied from \`ollama list\``)
        .toBeLessThan(decimalGb);
    }
  });
});
