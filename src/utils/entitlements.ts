/**
 * Prism Entitlements — Plan-Based Feature & Model Gating
 * ═══════════════════════════════════════════════════════════
 * Fetches the user's plan entitlements from the Synalux portal
 * and caches them locally. Used by prism_infer and other tools
 * to enforce model ceiling, max_tokens, and feature gates.
 *
 * Unauthenticated users (no SYNALUX_API_KEY) get free-tier defaults.
 * Authenticated users get their plan from the portal (5-minute cache).
 */

import { getSynaluxJwt } from "./synaluxJwt.js";
import { PRISM_SYNALUX_BASE_URL, SYNALUX_CONFIGURED } from "../config.js";
import { debugLog } from "./logger.js";

// ── Types ─────────────────────────────────────────────────────────

export interface PrismEntitlements {
    plan: string;
    model_ceiling: "2b" | "4b" | "9b" | "27b";
    daily_infer_limit: number;
    max_tokens: number;
    max_seats: number;
    features: {
        cloud_fallback: boolean;
        grounding_verifier: boolean;
        knowledge_search_unlimited: boolean;
        session_memory_unlimited: boolean;
        analytics_dashboard: boolean;
    };
    upgrade_url: string;
}

// ── Free-tier defaults (no auth) ──────────────────────────────────

export const FREE_ENTITLEMENTS: PrismEntitlements = {
    plan: "free",
    model_ceiling: "4b",
    daily_infer_limit: 50,
    max_tokens: 512,
    max_seats: 1,
    features: {
        cloud_fallback: false,
        grounding_verifier: false,
        knowledge_search_unlimited: false,
        session_memory_unlimited: false,
        analytics_dashboard: false,
    },
    upgrade_url: "https://synalux.ai/pricing",
};

// ── Cache ─────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
    entitlements: PrismEntitlements;
    expiresAt: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<PrismEntitlements> | null = null;

// ── Model tier ordering for ceiling enforcement ───────────────────

const TIER_ORDER: readonly string[] = ["2b", "4b", "9b", "27b"];

/**
 * Returns true if `requested` exceeds `ceiling`.
 * e.g. ceilingExceeded("9b", "4b") → true (9b > 4b ceiling)
 */
export function ceilingExceeded(requested: string, ceiling: string): boolean {
    const reqIdx = TIER_ORDER.indexOf(requested);
    const ceilIdx = TIER_ORDER.indexOf(ceiling);
    if (reqIdx === -1 || ceilIdx === -1) return false;
    return reqIdx > ceilIdx;
}

/**
 * Clamp a model ceiling string to the plan's maximum.
 * Returns the lower of the two ceilings.
 */
export function clampCeiling(
    requested: string | undefined,
    planCeiling: string,
): string {
    if (!requested) return planCeiling;
    const reqIdx = TIER_ORDER.indexOf(requested);
    const planIdx = TIER_ORDER.indexOf(planCeiling);
    if (reqIdx === -1) return planCeiling;
    if (planIdx === -1) return requested;
    return TIER_ORDER[Math.min(reqIdx, planIdx)];
}

// ── Fetch ─────────────────────────────────────────────────────────

async function fetchEntitlements(): Promise<PrismEntitlements> {
    if (!SYNALUX_CONFIGURED || !PRISM_SYNALUX_BASE_URL) {
        debugLog("[entitlements] no Synalux auth configured — free tier");
        return FREE_ENTITLEMENTS;
    }

    const jwt = await getSynaluxJwt();
    if (!jwt) {
        debugLog("[entitlements] JWT exchange failed — free tier fallback");
        return FREE_ENTITLEMENTS;
    }

    try {
        const url = `${PRISM_SYNALUX_BASE_URL}/api/v1/prism/entitlements`;
        const res = await fetch(url, {
            method: "GET",
            headers: { Authorization: `Bearer ${jwt}` },
            signal: AbortSignal.timeout(10_000),
            redirect: "error",
        });

        if (!res.ok) {
            debugLog(`[entitlements] portal HTTP ${res.status}`);
            if (cache) {
                debugLog("[entitlements] using last-known-good (safety fail-closed)");
                return cache.entitlements;
            }
            return FREE_ENTITLEMENTS;
        }

        const data = (await res.json()) as PrismEntitlements;

        if (!data.plan || !data.model_ceiling) {
            debugLog("[entitlements] malformed response");
            if (cache) return cache.entitlements;
            return FREE_ENTITLEMENTS;
        }

        // Normalize legacy ceiling values to the current fleet.
        if (data.model_ceiling === ("14b" as string)) {
            debugLog("[entitlements] grandfathered 14b ceiling → 9b");
            data.model_ceiling = "9b";
        }
        if (data.model_ceiling === ("32b" as string)) {
            debugLog("[entitlements] grandfathered 32b ceiling → 27b");
            data.model_ceiling = "27b";
        }

        debugLog(
            `[entitlements] plan=${data.plan} ceiling=${data.model_ceiling} ` +
            `daily=${data.daily_infer_limit} max_tokens=${data.max_tokens}`,
        );
        return data;
    } catch (err) {
        debugLog(
            `[entitlements] fetch error: ${err instanceof Error ? err.message : String(err)}`,
        );
        // F1 fix: fail-closed — keep last-known-good entitlements on fetch error.
        // Safety controls (grounding_verifier) must not degrade on availability failures.
        if (cache) {
            debugLog("[entitlements] using last-known-good (safety fail-closed)");
            return cache.entitlements;
        }
        debugLog("[entitlements] no cached entitlements — free tier fallback (cold start)");
        return FREE_ENTITLEMENTS;
    }
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Get the current user's entitlements (cached for 1 hour).
 * Concurrent callers share a single in-flight fetch.
 */
export async function getEntitlements(): Promise<PrismEntitlements> {
    const now = Date.now();
    if (cache && cache.expiresAt > now) {
        return cache.entitlements;
    }

    if (inFlight) return inFlight;

    inFlight = (async () => {
        try {
            const ent = await fetchEntitlements();
            // Only update cache if this is a REAL fetch (not a cached fallback).
            // fetchEntitlements returns cache.entitlements on error — detect by
            // checking if the returned object is the exact same reference.
            const isFallback = cache && ent === cache.entitlements;
            if (!isFallback) {
                cache = { entitlements: ent, expiresAt: Date.now() + CACHE_TTL_MS };
            }
            // On fallback: DON'T refresh expiresAt — let it expire so we retry.
            return ent;
        } finally {
            inFlight = null;
        }
    })();

    return inFlight;
}

/**
 * Force cache invalidation (e.g. after plan upgrade).
 */
export function invalidateEntitlements(): void {
    cache = null;
}

/** Test-only: reset all state. */
export function _resetEntitlementsForTest(): void {
    cache = null;
    inFlight = null;
}

/** Test-only: inject a cached entitlement. */
export function _setCacheForTest(ent: PrismEntitlements, ttlMs: number = CACHE_TTL_MS): void {
    cache = { entitlements: ent, expiresAt: Date.now() + ttlMs };
}
