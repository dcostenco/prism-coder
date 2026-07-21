/**
 * Synalux JWT Exchange + Cache
 * ─────────────────────────────────────────────────────────────
 * The synalux portal demotes `synalux_sk_` API tokens to refresh-only;
 * all real API routes (chat, inference, soap) require a short-lived
 * EdDSA JWT obtained via POST /api/v1/auth/jwt.
 *
 * This module:
 *   1. Exchanges the long-lived sk_ token for a 15-minute JWT
 *   2. Caches the JWT in-memory until ~2min before expiry
 *   3. Exposes getSynaluxJwt() — returns a fresh JWT, exchanging if needed
 *   4. Exposes invalidateSynaluxJwt() — drop cache on 401
 *
 * SECURITY: Never log the raw sk_ token or JWT value.
 *
 * RATE LIMIT: portal allows 1 exchange per ~5–30 seconds per user.
 * We exchange at most once per ~13 min in steady state, so this is
 * never an issue under normal operation.
 */

import { debugLog } from "./logger.js";
import { PRISM_SYNALUX_BASE_URL, PRISM_SYNALUX_API_KEY } from "../config.js";

interface ExchangeResponse {
    status?: string;
    jwt?: string;
    expires_in?: number;
    token_type?: string;
    error?: string;
}

/** ~2-minute safety margin before the portal-issued JWT expires. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

/** Hard floor on cache lifetime in case portal returns a tiny expires_in. */
const MIN_CACHE_MS = 60_000;

interface CacheEntry {
    jwt: string;
    expiresAt: number; // epoch ms — wall clock
}

let cache: CacheEntry | null = null;
let inFlight: Promise<string | null> | null = null;

/**
 * Returns a usable JWT, exchanging from the sk_ token if needed.
 * Returns null when synalux is not configured or exchange fails.
 *
 * Concurrent callers share a single in-flight exchange (no thundering herd).
 */
export async function getSynaluxJwt(): Promise<string | null> {
    // Re-read process.env because storage/dashboard configuration can inject
    // credentials after config.ts captured its module-load constants.
    const baseUrl = process.env.PRISM_SYNALUX_BASE_URL?.trim() ||
        process.env.SYNALUX_BASE_URL?.trim() || PRISM_SYNALUX_BASE_URL;
    const apiKey = process.env.PRISM_SYNALUX_API_KEY?.trim() || PRISM_SYNALUX_API_KEY;
    if (!baseUrl || !apiKey) {
        return null;
    }

    const now = Date.now();
    if (cache && cache.expiresAt > now + REFRESH_MARGIN_MS) {
        return cache.jwt;
    }

    if (inFlight) return inFlight;

    inFlight = (async () => {
        try {
            const url = `${baseUrl}/api/v1/auth/jwt`;
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                signal: AbortSignal.timeout(10_000),
                redirect: "error",
            });

            if (!res.ok) {
                debugLog(`[synaluxJwt] exchange HTTP ${res.status}`);
                cache = null;
                return null;
            }

            const data = (await res.json()) as ExchangeResponse;
            if (!data?.jwt) {
                debugLog(`[synaluxJwt] exchange returned no jwt (status=${data?.status})`);
                cache = null;
                return null;
            }

            const ttlMs = Math.max(MIN_CACHE_MS, (data.expires_in ?? 900) * 1000);
            cache = { jwt: data.jwt, expiresAt: Date.now() + ttlMs };
            debugLog(`[synaluxJwt] exchanged ok, ttl=${ttlMs}ms`);
            return data.jwt;
        } catch (err) {
            debugLog(`[synaluxJwt] exchange error: ${err instanceof Error ? err.message : String(err)}`);
            cache = null;
            return null;
        } finally {
            inFlight = null;
        }
    })();

    return inFlight;
}

/** Force the next getSynaluxJwt() to re-exchange. Call on 401. */
export function invalidateSynaluxJwt(): void {
    cache = null;
}

/** Test-only: clear all state. */
export function _resetSynaluxJwtForTest(): void {
    cache = null;
    inFlight = null;
}
