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

/** prism_infer multi-turn policy. Ruled by the PORTAL's plan table
 *  (portal/src/app/api/v1/prism/entitlements/route.ts): Prism is a thin
 *  client and never decides this itself. Absent from an older portal →
 *  DEFAULT_MULTI_TURN; wild values are clamped to the absolute ceiling. */
export interface MultiTurnEntitlement {
    enabled: boolean;
    max_turns: number;
    max_chars: number;
}

/** What a host with NO portal (unconfigured), a portal that says nothing
 *  (older deployment), or an assumed-free fallback gets: OFF. Multi-turn is
 *  a paid-plan feature (owner decision 2026-09-15); a client default that
 *  enabled it would hand a paid feature to anyone without an account. The
 *  caps here are what a paid plan gets when the portal omits them. */
export const DEFAULT_MULTI_TURN: MultiTurnEntitlement = { enabled: false, max_turns: 12, max_chars: 32_000 };
/** Structural ceiling no plan can exceed: the portal's own inference route
 *  takes at most 50 messages, and 128k chars ≈ 32k tokens — the largest
 *  local window. Above this the payload is malformed, not merely over plan. */
export const ABSOLUTE_MULTI_TURN: MultiTurnEntitlement = { enabled: true, max_turns: 50, max_chars: 128_000 };

/** The policy prism_infer enforces for these entitlements: portal values
 *  when present, clamped into the absolute ceiling; the default otherwise. */
export function multiTurnPolicy(ent: PrismEntitlements): MultiTurnEntitlement {
    const raw = ent.multi_turn;
    if (!raw || typeof raw !== "object") return DEFAULT_MULTI_TURN;
    const clampInt = (v: unknown, fallback: number, max: number): number =>
        typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : fallback;
    return {
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_MULTI_TURN.enabled,
        max_turns: clampInt(raw.max_turns, DEFAULT_MULTI_TURN.max_turns, ABSOLUTE_MULTI_TURN.max_turns),
        max_chars: clampInt(raw.max_chars, DEFAULT_MULTI_TURN.max_chars, ABSOLUTE_MULTI_TURN.max_chars),
    };
}

export interface PrismEntitlements {
    plan: string;
    model_ceiling: "2b" | "4b" | "9b" | "27b";
    daily_infer_limit: number;
    max_tokens: number;
    max_seats: number;
    features: {
        cloud_fallback: boolean;
        grounding_verifier: boolean;
        /** Private deterministic correction for direct route-mode drafts. */
        route_guard?: boolean;
        knowledge_search_unlimited: boolean;
        session_memory_unlimited: boolean;
        analytics_dashboard: boolean;
    };
    upgrade_url: string;
    /** Multi-turn policy from the portal's plan table; see multiTurnPolicy(). */
    multi_turn?: MultiTurnEntitlement;
    /** §5.5 — provenance of these values. Distinguishes "the portal says
     *  free" from "we ASSUMED free because resolution failed":
     *  - "portal": real portal data (fresh, cached, or last-known-good)
     *  - "unconfigured": no Synalux key on this machine — free is correct,
     *    not a degradation
     *  - "fallback_free": auth IS configured but JWT/fetch failed with no
     *    cached data — free-tier clamps were assumed. Strict callers
     *    (prism_infer strict_entitlements:true) fail loud on this.
     *  Absent (e.g. test-injected entitlements) is treated as "portal". */
    source?: "portal" | "unconfigured" | "fallback_free";
}

// ── Free-tier defaults (no auth) ──────────────────────────────────

export const FREE_ENTITLEMENTS: PrismEntitlements = {
    plan: "free",
    model_ceiling: "4b",
    daily_infer_limit: 50, // reserved, not enforced; cloud limits are portal-side
    max_tokens: 512,
    max_seats: 1,
    features: {
        cloud_fallback: false,
        grounding_verifier: false,
        route_guard: false,
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

// §5.5 negative cache: fallback_free is kept OUT of the main 5-min cache
// (recovery must not wait a full TTL), but an un-cached failure would make
// every sequential call during an outage pay the full JWT+fetch attempt
// (worst case ~10s on a hanging network). A short negative TTL caps that
// amplification while still retrying promptly.
const FALLBACK_NEGATIVE_TTL_MS = 25_000;
let negativeCache: { entitlements: PrismEntitlements; until: number } | null = null;

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
    // An entitlement the client cannot parse must never grant MORE than the
    // free floor. This previously returned `requested`, so while the portal
    // shipped retired tiers ('14b' standard, '32b' advanced/enterprise) the
    // plan gate evaporated and every paid caller chose its own ceiling
    // (measured 2026-08-14). Fail closed, and say so.
    if (planIdx === -1) {
        debugLog(
            `[entitlements] unrecognised plan ceiling "${planCeiling}" — ` +
            `clamping to the free floor "${FREE_ENTITLEMENTS.model_ceiling}" instead of honouring "${requested}"`,
        );
        return FREE_ENTITLEMENTS.model_ceiling;
    }
    return TIER_ORDER[Math.min(reqIdx, planIdx)];
}

// ── Fetch ─────────────────────────────────────────────────────────

async function fetchEntitlements(): Promise<PrismEntitlements> {
    // Re-read process.env because dashboard/bootstrap configuration can inject
    // credentials after config.ts captured its module-load constants.
    const baseUrl = process.env.PRISM_SYNALUX_BASE_URL?.trim() || PRISM_SYNALUX_BASE_URL;
    const apiKey = process.env.PRISM_SYNALUX_API_KEY?.trim();
    if ((!SYNALUX_CONFIGURED && !apiKey) || !baseUrl) {
        debugLog("[entitlements] no Synalux auth configured — free tier");
        return { ...FREE_ENTITLEMENTS, source: "unconfigured" };
    }

    const jwt = await getSynaluxJwt();
    if (!jwt) {
        debugLog("[entitlements] JWT exchange failed — free tier fallback (fallback_free)");
        return { ...FREE_ENTITLEMENTS, source: "fallback_free" };
    }

    try {
        const url = `${baseUrl}/api/v1/prism/entitlements`;
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
            return { ...FREE_ENTITLEMENTS, source: "fallback_free" };
        }

        const data = (await res.json()) as PrismEntitlements;

        if (!data.plan || !data.model_ceiling) {
            debugLog("[entitlements] malformed response");
            if (cache) return cache.entitlements;
            return { ...FREE_ENTITLEMENTS, source: "fallback_free" };
        }
        // §5.5: provenance — this is REAL portal data (a portal "free" plan
        // gets source:"portal", distinguishing it from an assumed fallback).
        data.source = "portal";

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
        debugLog("[entitlements] no cached entitlements — free tier fallback (cold start, fallback_free)");
        return { ...FREE_ENTITLEMENTS, source: "fallback_free" };
    }
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Get the current user's entitlements (5-minute cache; resolved per call —
 * plan v2 §5.5). Concurrent callers share a single in-flight fetch.
 * fallback_free results are never cached, so degraded resolution retries
 * on the next call.
 */
export async function getEntitlements(): Promise<PrismEntitlements> {
    const now = Date.now();
    if (cache && cache.expiresAt > now) {
        return cache.entitlements;
    }

    // §5.5: within the short negative window after a fallback_free
    // resolution, return it without re-attempting the portal.
    if (negativeCache && negativeCache.until > now) {
        return negativeCache.entitlements;
    }

    if (inFlight) return inFlight;

    inFlight = (async () => {
        try {
            const ent = await fetchEntitlements();
            // Only update cache if this is a REAL fetch (not a cached fallback).
            // fetchEntitlements returns cache.entitlements on error — detect by
            // checking if the returned object is the exact same reference.
            // §5.5: fallback_free results are also never cached — pinning an
            // assumed-free degradation for the TTL would delay recovery; the
            // next call retries the portal instead.
            const isFallback = (cache && ent === cache.entitlements) || ent.source === "fallback_free";
            if (!isFallback) {
                cache = { entitlements: ent, expiresAt: Date.now() + CACHE_TTL_MS };
            }
            // On fallback: DON'T refresh expiresAt — let it expire so we retry.
            if (ent.source === "fallback_free") {
                negativeCache = { entitlements: ent, until: Date.now() + FALLBACK_NEGATIVE_TTL_MS };
            } else {
                negativeCache = null;
            }
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
/** Cached entitlements WITHOUT a network round-trip, or null when cold.
 *  For display surfaces (the startup line) that must never add a portal
 *  fetch to startup; the first prism_infer result carries the policy anyway. */
export function peekEntitlements(): PrismEntitlements | null {
    return cache?.entitlements ?? null;
}

export function invalidateEntitlements(): void {
    cache = null;
    negativeCache = null;
}

/** Test-only: reset all state. */
export function _resetEntitlementsForTest(): void {
    cache = null;
    inFlight = null;
    negativeCache = null;
}

/** Test-only: inject a cached entitlement. */
export function _setCacheForTest(ent: PrismEntitlements, ttlMs: number = CACHE_TTL_MS): void {
    cache = { entitlements: ent, expiresAt: Date.now() + ttlMs };
}
