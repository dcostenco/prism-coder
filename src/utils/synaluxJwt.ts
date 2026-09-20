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
import { isSynaluxSignedOut } from "./synaluxCredentialState.js";

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

type ExchangeAttempt =
    | { kind: "success"; jwt: string; ttlMs: number }
    | { kind: "http_error"; status: number }
    | { kind: "invalid_response" }
    | { kind: "network_error" };

let cache: CacheEntry | null = null;
let inFlight: Promise<string | null> | null = null;
let generation = 0;

async function exchangeJwt(baseUrl: string, apiKey: string): Promise<ExchangeAttempt> {
    try {
        const res = await fetch(`${baseUrl}/api/v1/auth/jwt`, {
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
            return { kind: "http_error", status: res.status };
        }

        const data = (await res.json()) as ExchangeResponse;
        if (!data?.jwt) {
            debugLog(`[synaluxJwt] exchange returned no jwt (status=${data?.status})`);
            return { kind: "invalid_response" };
        }

        return {
            kind: "success",
            jwt: data.jwt,
            ttlMs: Math.max(MIN_CACHE_MS, (data.expires_in ?? 900) * 1000),
        };
    } catch (err) {
        debugLog(`[synaluxJwt] exchange error: ${err instanceof Error ? err.message : String(err)}`);
        return { kind: "network_error" };
    }
}

interface PersistedCredentialState {
    signedOut: boolean;
    baseUrl: string;
    apiKey: string;
}

async function readPersistedCredentialState(): Promise<PersistedCredentialState | null> {
    try {
        const { getSetting } = await import("../storage/configStorage.js");
        const signedOut = (await getSetting("PRISM_SYNALUX_SIGNED_OUT", "")) === "true";
        const baseUrl = normalizePortalBaseUrl(await getSetting("PRISM_SYNALUX_BASE_URL", ""));
        const apiKey = (await getSetting("PRISM_SYNALUX_API_KEY", "")).trim();
        return { signedOut, baseUrl, apiKey };
    } catch (err) {
        debugLog(`[synaluxJwt] persisted credential lookup failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}

function normalizePortalBaseUrl(raw: string): string {
    try {
        const parsed = new URL(raw.trim());
        const loopback = parsed.hostname === "localhost" ||
            parsed.hostname === "127.0.0.1" || parsed.hostname === "::1" || parsed.hostname === "[::1]";
        if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return "";
        return parsed.origin;
    } catch {
        return "";
    }
}

const SYNALUX_API_KEY_PREFIX = ["synalux", "sk", ""].join("_");

export function isUsableSynaluxApiKey(apiKey: string): boolean {
    return apiKey.startsWith(SYNALUX_API_KEY_PREFIX) && apiKey.length <= 512;
}

/**
 * Returns a usable JWT, exchanging from the sk_ token if needed.
 * Returns null when synalux is not configured or exchange fails.
 *
 * Concurrent callers share a single in-flight exchange (no thundering herd).
 */
export async function getSynaluxJwt(): Promise<string | null> {
    if (isSynaluxSignedOut()) return null;
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

    const requestGeneration = generation;
    let exchange!: Promise<string | null>;
    exchange = (async () => {
        try {
            let attempt = await exchangeJwt(baseUrl, apiKey);
            const requestOrigin = normalizePortalBaseUrl(baseUrl);

            // MCP launchers can keep an older environment snapshot after the
            // dashboard saves a freshly-linked account token. A valid explicit
            // environment token remains authoritative; only an authentication
            // rejection may try the newer persisted token, and only once.
            if (attempt.kind === "http_error" && (attempt.status === 401 || attempt.status === 403)) {
                const persisted = await readPersistedCredentialState();
                if (
                    persisted &&
                    !persisted.signedOut &&
                    !isSynaluxSignedOut() &&
                    !!persisted.baseUrl &&
                    persisted.baseUrl === requestOrigin &&
                    isUsableSynaluxApiKey(persisted.apiKey) &&
                    persisted.apiKey !== apiKey
                ) {
                    // The saved key may only recover the same portal origin.
                    // Callers can resolve their request URL before this helper
                    // returns, so cross-origin recovery would expose either the
                    // refresh key or its short-lived JWT to the launcher URL.
                    const recovered = await exchangeJwt(persisted.baseUrl, persisted.apiKey);
                    if (recovered.kind === "success") {
                        // Re-read after the network boundary. A sign-out or a
                        // newer account link must win over this older retry.
                        const current = await readPersistedCredentialState();
                        if (
                            current &&
                            !current.signedOut &&
                            !isSynaluxSignedOut() &&
                            generation === requestGeneration &&
                            current.baseUrl === persisted.baseUrl &&
                            current.apiKey === persisted.apiKey
                        ) {
                            process.env.PRISM_SYNALUX_API_KEY = persisted.apiKey;
                            attempt = recovered;
                            debugLog("[synaluxJwt] recovered from a stale launcher credential");
                        } else {
                            cache = null;
                            return null;
                        }
                    }
                }
            }

            if (attempt.kind !== "success") {
                cache = null;
                return null;
            }

            // Sign-out/invalidation may happen while the network request is in
            // flight. Never publish or return a credential from the old
            // generation after that boundary has moved.
            if (isSynaluxSignedOut() || generation !== requestGeneration) {
                return null;
            }

            cache = { jwt: attempt.jwt, expiresAt: Date.now() + attempt.ttlMs };
            debugLog(`[synaluxJwt] exchanged ok, ttl=${attempt.ttlMs}ms`);
            return attempt.jwt;
        } catch (err) {
            debugLog(`[synaluxJwt] exchange error: ${err instanceof Error ? err.message : String(err)}`);
            cache = null;
            return null;
        } finally {
            if (inFlight === exchange) inFlight = null;
        }
    })();
    inFlight = exchange;

    return exchange;
}

/** Force the next getSynaluxJwt() to re-exchange. Call on 401. */
export function invalidateSynaluxJwt(): void {
    generation += 1;
    cache = null;
    // The old request cannot be cancelled portably, but it is generation-bound
    // above. Detach it so a new sign-in can exchange immediately.
    inFlight = null;
}

/** Test-only: clear all state. */
export function _resetSynaluxJwtForTest(): void {
    generation += 1;
    cache = null;
    inFlight = null;
}
