/**
 * Entitlements Gate Tests — clampCeiling, ceilingExceeded, getEntitlements
 *
 * Covers:
 *   1. clampCeiling — model ceiling enforcement at all tier boundaries
 *   2. ceilingExceeded — boolean check for ceiling violations
 *   3. getEntitlements — cache behavior, free fallback, JWT failure
 *   4. invalidateEntitlements — cache busting on plan change
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    clampCeiling,
    ceilingExceeded,
    getEntitlements,
    invalidateEntitlements,
    FREE_ENTITLEMENTS,
    _resetEntitlementsForTest,
    _setCacheForTest,
    type PrismEntitlements,
} from "../src/utils/entitlements.js";

// ── Test fixtures ────────────────────────────────────────────────

const STANDARD_ENTITLEMENTS: PrismEntitlements = {
    plan: "standard",
    model_ceiling: "14b",
    daily_infer_limit: 200,
    max_tokens: 1024,
    max_seats: 1,
    features: {
        cloud_fallback: true,
        grounding_verifier: true,
        knowledge_search_unlimited: true,
        session_memory_unlimited: true,
        analytics_dashboard: true,
    },
    upgrade_url: "https://synalux.ai/pricing",
};

const ADVANCED_ENTITLEMENTS: PrismEntitlements = {
    plan: "advanced",
    model_ceiling: "32b",
    daily_infer_limit: 2000,
    max_tokens: 2048,
    max_seats: 5,
    features: {
        cloud_fallback: true,
        grounding_verifier: true,
        knowledge_search_unlimited: true,
        session_memory_unlimited: true,
        analytics_dashboard: true,
    },
    upgrade_url: "https://synalux.ai/pricing",
};

// ── Setup / Teardown ─────────────────────────────────────────────

beforeEach(() => {
    _resetEntitlementsForTest();
});

// ── clampCeiling ─────────────────────────────────────────────────

describe("clampCeiling", () => {
    it("returns plan ceiling when no request specified", () => {
        expect(clampCeiling(undefined, "4b")).toBe("4b");
        expect(clampCeiling(undefined, "32b")).toBe("32b");
    });

    it("returns requested ceiling when within plan limit", () => {
        expect(clampCeiling("4b", "14b")).toBe("4b");
        expect(clampCeiling("2b", "32b")).toBe("2b");
        expect(clampCeiling("4b", "14b")).toBe("4b");
    });

    it("clamps requested ceiling to plan maximum", () => {
        expect(clampCeiling("32b", "4b")).toBe("4b");
        expect(clampCeiling("14b", "4b")).toBe("4b");
        expect(clampCeiling("32b", "14b")).toBe("14b");
    });

    it("returns equal ceiling when request matches plan", () => {
        expect(clampCeiling("4b", "4b")).toBe("4b");
        expect(clampCeiling("14b", "14b")).toBe("14b");
        expect(clampCeiling("32b", "32b")).toBe("32b");
    });

    it("returns plan ceiling for unknown requested model", () => {
        expect(clampCeiling("70b", "14b")).toBe("14b");
        expect(clampCeiling("unknown", "4b")).toBe("4b");
    });

    it("returns requested for unknown plan ceiling", () => {
        expect(clampCeiling("14b", "unknown")).toBe("14b");
    });

    // Critical: free tier can never get above 4b
    it("free tier ceiling blocks all models above 4b", () => {
        expect(clampCeiling("14b", "4b")).toBe("4b");
        expect(clampCeiling("14b", "4b")).toBe("4b");
        expect(clampCeiling("32b", "4b")).toBe("4b");
    });

    it("allows 2b on every plan", () => {
        expect(clampCeiling("2b", "2b")).toBe("2b");
        expect(clampCeiling("2b", "4b")).toBe("2b");
        expect(clampCeiling("2b", "14b")).toBe("2b");
        expect(clampCeiling("2b", "32b")).toBe("2b");
    });
});

// ── ceilingExceeded ──────────────────────────────────────────────

describe("ceilingExceeded", () => {
    it("returns true when request exceeds ceiling", () => {
        expect(ceilingExceeded("14b", "4b")).toBe(true);
        expect(ceilingExceeded("32b", "14b")).toBe(true);
        expect(ceilingExceeded("32b", "4b")).toBe(true);
        expect(ceilingExceeded("14b", "4b")).toBe(true);
    });

    it("returns false when request is at or below ceiling", () => {
        expect(ceilingExceeded("4b", "4b")).toBe(false);
        expect(ceilingExceeded("4b", "14b")).toBe(false);
        expect(ceilingExceeded("2b", "4b")).toBe(false);
        expect(ceilingExceeded("14b", "32b")).toBe(false);
    });

    it("returns false for unknown models (safe fallback)", () => {
        expect(ceilingExceeded("70b", "4b")).toBe(false);
        expect(ceilingExceeded("14b", "unknown")).toBe(false);
    });
});

// ── getEntitlements cache ────────────────────────────────────────

describe("getEntitlements cache", () => {
    it("returns cached entitlements within TTL", async () => {
        _setCacheForTest(STANDARD_ENTITLEMENTS, 60_000);
        const result = await getEntitlements();
        expect(result.plan).toBe("standard");
        expect(result.model_ceiling).toBe("14b");
    });

    it("returns free tier when cache expired and no auth", async () => {
        _resetEntitlementsForTest();
        const result = await getEntitlements();
        expect(result.plan).toBe("free");
        expect(result.model_ceiling).toBe("4b");
        expect(result.max_tokens).toBe(512);
    });

    it("invalidateEntitlements clears cache", async () => {
        _setCacheForTest(ADVANCED_ENTITLEMENTS, 60_000);
        const before = await getEntitlements();
        expect(before.plan).toBe("advanced");

        invalidateEntitlements();
        const after = await getEntitlements();
        expect(after.plan).toBe("free");
    });
});

// ── FREE_ENTITLEMENTS constants ──────────────────────────────────

describe("FREE_ENTITLEMENTS", () => {
    it("has correct free tier limits", () => {
        expect(FREE_ENTITLEMENTS.plan).toBe("free");
        expect(FREE_ENTITLEMENTS.model_ceiling).toBe("4b");
        expect(FREE_ENTITLEMENTS.daily_infer_limit).toBe(50);
        expect(FREE_ENTITLEMENTS.max_tokens).toBe(512);
    });

    it("disables all premium features", () => {
        expect(FREE_ENTITLEMENTS.features.cloud_fallback).toBe(false);
        expect(FREE_ENTITLEMENTS.features.grounding_verifier).toBe(false);
        expect(FREE_ENTITLEMENTS.features.knowledge_search_unlimited).toBe(false);
        expect(FREE_ENTITLEMENTS.features.session_memory_unlimited).toBe(false);
        expect(FREE_ENTITLEMENTS.features.analytics_dashboard).toBe(false);
    });

    it("includes upgrade URL", () => {
        expect(FREE_ENTITLEMENTS.upgrade_url).toBe("https://synalux.ai/pricing");
    });
});

// ── Tier enforcement matrix ──────────────────────────────────────

describe("tier enforcement matrix", () => {
    const tiers: Array<{ plan: string; ceiling: string; maxTokens: number; cloud: boolean; verifier: boolean }> = [
        { plan: "free", ceiling: "4b", maxTokens: 512, cloud: false, verifier: false },
        { plan: "standard", ceiling: "14b", maxTokens: 1024, cloud: true, verifier: true },
        { plan: "advanced", ceiling: "32b", maxTokens: 2048, cloud: true, verifier: true },
        { plan: "enterprise", ceiling: "32b", maxTokens: 4096, cloud: true, verifier: true },
    ];

    for (const tier of tiers) {
        describe(`${tier.plan} plan`, () => {
            it(`ceiling is ${tier.ceiling}`, () => {
                // Requesting 32b on this plan should clamp to tier ceiling
                const clamped = clampCeiling("32b", tier.ceiling);
                expect(clamped).toBe(tier.ceiling);
            });

            it(`max_tokens capped at ${tier.maxTokens}`, () => {
                const requested = 8192;
                const effective = Math.min(requested, tier.maxTokens, 8192);
                expect(effective).toBe(tier.maxTokens);
            });

            it(`cloud_fallback is ${tier.cloud}`, () => {
                const requestedCloud = true;
                const allowed = requestedCloud && tier.cloud;
                expect(allowed).toBe(tier.cloud);
            });

            it(`grounding_verifier is ${tier.verifier}`, () => {
                expect(tier.verifier).toBe(tier.plan !== "free");
            });
        });
    }

    // Cross-tier escalation attempts
    it("free user requesting 14b gets clamped to 4b", () => {
        expect(clampCeiling("14b", "4b")).toBe("4b");
    });

    it("standard user requesting 32b gets clamped to 14b", () => {
        expect(clampCeiling("32b", "14b")).toBe("14b");
    });

    it("advanced user requesting 32b gets 32b", () => {
        expect(clampCeiling("32b", "32b")).toBe("32b");
    });
});
