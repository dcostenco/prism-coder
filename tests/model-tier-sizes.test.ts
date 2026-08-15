/**
 * The tier table must describe the artifacts that are actually published.
 *
 * 2026-08-14: the 2b/4b/9b tags were rebuilt with a vision tower and pushed,
 * changing their on-disk size (2b 2.3 -> 3.3 GB, 9b 5.8 -> 6.7 GB). MODEL_TIERS
 * still carried the old numbers, and the picker uses weightsGb for eviction
 * math and minFreeGb for the RAM gate — understating a model's size makes the
 * gate admit something that cannot fit. The 2b is the mobile first gate, and it
 * grew 43%.
 */
import { describe, it, expect } from "vitest";
import { MODEL_TIERS } from "../src/utils/modelPicker.js";

// Sizes as served by ollama.com after the 2026-08-14 vision push.
const PUBLISHED_GB: Record<string, number> = {
  "prism-coder:27b": 17,
  "prism-coder:9b": 6.7,
  "prism-coder:4b": 3.5,
  "prism-coder:2b": 3.3,
};

describe("MODEL_TIERS matches published artifacts", () => {
  it("never understates a tier's weights", () => {
    for (const tier of MODEL_TIERS) {
      const published = PUBLISHED_GB[tier.tag];
      expect(published, `unknown tier ${tier.tag}`).toBeDefined();
      expect(tier.weightsGb, `${tier.tag} weightsGb understated`).toBeGreaterThanOrEqual(published);
    }
  });

  it("keeps headroom above the weights for KV cache and activations", () => {
    for (const tier of MODEL_TIERS) {
      expect(tier.minFreeGb, `${tier.tag} admits a model that cannot fit`)
        .toBeGreaterThan(tier.weightsGb);
    }
  });
});
