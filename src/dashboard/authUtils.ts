/**
 * Dashboard authentication helpers extracted from server.ts for direct unit testing.
 */

import { randomBytes } from "crypto";
import type * as http from "http";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyOptions } from "jose";

// ─────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────

/** Injectable auth configuration — decoupled from process.env for testing */
export interface AuthConfig {
  authEnabled: boolean;
  authUser: string;
  authPass: string;
  activeSessions: Map<string, number>; // token → expiry timestamp
  /** Optional JWT audience for JWKS verification (prevents cross-service token confusion) */
  jwtAudience?: string;
  /** Optional JWT issuer for JWKS verification */
  jwtIssuer?: string;
}

/**
 * Extended request type — attaches agent identity after successful JWT verification.
 * Downstream handlers can read `req.agent_id` for audit logging / traceability.
 */
export interface PrismAuthenticatedRequest extends http.IncomingMessage {
  agent_id?: string;
}

/** Rate limiter options */
export interface RateLimiterOptions {
  maxAttempts: number;   // Max attempts in the window
  windowMs: number;      // Window duration in milliseconds
}

/** Rate limiter state per IP */
interface RateLimiterEntry {
  timestamps: number[];  // Timestamps of recent attempts
}

// ─────────────────────────────────────────────────────────────────
// TIMING-SAFE COMPARISON
// ─────────────────────────────────────────────────────────────────

/**
 * Timing-safe string comparison to prevent timing attacks.
 *
 * Returns false immediately for different lengths (this leaks length
 * information, but credential length is not considered secret in
 * HTTP Basic Auth where the header is visible).
 *
 * For equal-length strings, iterates ALL characters regardless of
 * where mismatches occur, accumulating XOR differences.
 */
export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ─────────────────────────────────────────────────────────────────
// TOKEN GENERATION
// ─────────────────────────────────────────────────────────────────

/**
 * Generate a random 64-character hex session token.
 */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

// ─────────────────────────────────────────────────────────────────
// JWKS SETUP
// ─────────────────────────────────────────────────────────────────

let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;

export function initJWKS(uri: string) {
  try {
    jwksCache = createRemoteJWKSet(new URL(uri));
    console.error(`[Auth] 🔑 JWKS remote key set initialized: ${uri}`);
  } catch (err) {
    console.error(`[Auth] ❌ Failed to initialize JWKS from ${uri}:`, err);
  }
}

/**
 * Reset JWKS cache — for testing only.
 * @internal
 */
export function _resetJWKS(cache: ReturnType<typeof createRemoteJWKSet> | null = null) {
  jwksCache = cache;
}

/** Expose JWKS cache state for testing. @internal */
export function _getJWKSCache() {
  return jwksCache;
}

// ─────────────────────────────────────────────────────────────────
// AUTHENTICATION CHECK
// ─────────────────────────────────────────────────────────────────

/**
 * Check if a request is authenticated against the provided config.
 *
 * Authentication is checked in priority order:
 *   1. Auth disabled (authEnabled === false) → pass-through
 *   2. Bearer JWT token verified against JWKS remote key set
 *   3. Valid, non-expired session cookie
 *   4. Valid Basic Auth credentials
 *
 * Side effects:
 *   - Expired session tokens are lazily cleaned up when encountered
 *   - On successful JWT verification, `req.agent_id` is set for
 *     downstream traceability (audit logging, access control)
 */
export async function isAuthenticated(
  req: http.IncomingMessage,
  config: AuthConfig,
): Promise<boolean> {
  if (!config.authEnabled) return true;

  // Check Bearer Token (JWKS)
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ") && jwksCache) {
    try {
      const token = authHeader.slice(7);
      const verifyOpts: JWTVerifyOptions = {
        clockTolerance: 30, // 30s clock skew tolerance
      };
      if (config.jwtAudience) verifyOpts.audience = config.jwtAudience;
      if (config.jwtIssuer) verifyOpts.issuer = config.jwtIssuer;

      const { payload } = await jwtVerify(token, jwksCache, verifyOpts);
      // Attach agent_id to the request for downstream traceability
      (req as PrismAuthenticatedRequest).agent_id =
        (payload as Record<string, unknown>).agent_id as string || payload.sub;
      return true;
    } catch (err) {
      const code = (err as { code?: string }).code || "UNKNOWN";
      console.error(`[Auth] JWT verification failed (${code}):`, (err as Error).message);
      return false;
    }
  }

  // Check session cookie first
  const cookies = req.headers.cookie || "";
  const match = cookies.match(/prism_session=([a-f0-9]{64})/);
  if (match) {
    const token = match[1];
    const expiry = config.activeSessions.get(token);
    if (expiry && expiry > Date.now()) return true;
    // Expired or unknown — lazy cleanup
    if (expiry) config.activeSessions.delete(token);
  }

  // Check Basic Auth header
  if (authHeader.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
      const colonIndex = decoded.indexOf(":");
      if (colonIndex === -1) return false;
      const user = decoded.slice(0, colonIndex);
      const pass = decoded.slice(colonIndex + 1);
      return safeCompare(user, config.authUser) && safeCompare(pass, config.authPass);
    } catch {
      // Malformed Base64 — reject
      return false;
    }
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────
// RATE LIMITER
// ─────────────────────────────────────────────────────────────────

/**
 * Creates a sliding-window rate limiter.
 *
 * Returns an object with:
 *   - isAllowed(key): boolean — check and record an attempt
 *   - reset(key): void — clear attempts for a key
 *   - clear(): void — clear all state (for testing)
 *
 * The limiter automatically prunes stale entries on each check
 * to prevent unbounded memory growth from unique IPs.
 */
export function createRateLimiter(opts: RateLimiterOptions) {
  const store = new Map<string, RateLimiterEntry>();
  let lastPrune = Date.now();

  // Prune stale entries every 5 minutes to prevent memory leaks
  const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

  function pruneStale(now: number): void {
    if (now - lastPrune < PRUNE_INTERVAL_MS) return;
    lastPrune = now;
    for (const [key, entry] of store) {
      // Keep only timestamps within the window
      entry.timestamps = entry.timestamps.filter(t => now - t < opts.windowMs);
      if (entry.timestamps.length === 0) {
        store.delete(key);
      }
    }
  }

  return {
    /**
     * Check if an attempt from the given key is allowed.
     * Records the attempt and returns false if rate limit exceeded.
     */
    isAllowed(key: string): boolean {
      const now = Date.now();
      pruneStale(now);

      let entry = store.get(key);
      if (!entry) {
        entry = { timestamps: [] };
        store.set(key, entry);
      }

      // Filter to only timestamps within the window
      entry.timestamps = entry.timestamps.filter(t => now - t < opts.windowMs);

      if (entry.timestamps.length >= opts.maxAttempts) {
        return false; // Rate limited
      }

      entry.timestamps.push(now);
      return true;
    },

    /** Reset attempts for a specific key */
    reset(key: string): void {
      store.delete(key);
    },

    /** Clear all state — useful for testing */
    clear(): void {
      store.clear();
      lastPrune = Date.now();
    },

    /** Get current store size — for testing */
    get size(): number {
      return store.size;
    },
  };
}
