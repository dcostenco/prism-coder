import { randomBytes } from "crypto";
import { safeCompare } from "./authUtils.js";

/**
 * Default-on per-request token for the dashboard data API — remediation #2 of
 * GHSA-9cvx-7x8q-3g6m. Defense-in-depth ON TOP OF the Host/Origin guard: the
 * token is minted at startup and surfaced only through the server's own stdout,
 * so a DNS-rebound page (which never sees that log) cannot present it even if
 * the Host guard were bypassed or an operator misconfigured the origin.
 *
 * Token mode is INACTIVE when the operator has configured real auth
 * (PRISM_DASHBOARD_USER/PASS or JWKS) — that is the gate then — or when
 * explicitly opted out via PRISM_DASHBOARD_NO_TOKEN for a trusted, local-only
 * box. The Host guard still runs in every mode.
 */

export interface DashboardTokenConfig {
  /** True when PRISM_DASHBOARD_USER/PASS or JWKS auth is configured. */
  authEnabled: boolean;
  /** Raw env PRISM_DASHBOARD_TOKEN — pin a known token instead of a random one. */
  pinnedToken?: string;
  /** Raw env PRISM_DASHBOARD_NO_TOKEN — opt out of the default token. */
  optOut?: string;
}

function isTruthy(v: string | undefined): boolean {
  const s = (v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/**
 * Resolve the active dashboard token, or null when token mode is off. A pinned
 * token wins over a random one so operators can share a stable URL; an empty or
 * whitespace-only pin is ignored (falls back to a random token).
 */
export function resolveDashboardToken(cfg: DashboardTokenConfig): string | null {
  if (cfg.authEnabled) return null; // real auth is the gate
  if (isTruthy(cfg.optOut)) return null; // explicit opt-out (Host guard still applies)
  const pinned = (cfg.pinnedToken || "").trim();
  if (pinned) return pinned;
  return randomBytes(32).toString("hex");
}

/** Extract the prism_dashboard_token cookie value, if present. */
export function dashboardTokenCookieName(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid dashboard port');
  return `prism_dashboard_token_${port}`;
}

export function tokenFromCookie(cookieHeader: string | undefined, cookieName = 'prism_dashboard_token'): string | null {
  // Capture the whole value (any run of non-";", non-space) so pinned tokens
  // with hyphens/underscores match; the name is anchored to start-or-"; " so a
  // look-alike cookie (evil_prism_dashboard_token=…) cannot match.
  const entry = (cookieHeader || '').split(';').map(c => c.trim()).find(c => c.startsWith(`${cookieName}=`));
  const value = entry?.slice(cookieName.length + 1);
  return value && !/\s/.test(value) ? value : null;
}

/**
 * True when the request presents the active token via the cookie, the
 * X-Prism-Dashboard-Token header, or a ?token= query param. Every comparison is
 * timing-safe and only runs against the single active token.
 */
export function requestHasToken(
  headers: { cookie?: string; headerToken?: string | null },
  queryToken: string | null,
  activeToken: string,
  cookieName = 'prism_dashboard_token',
): boolean {
  const candidates = [tokenFromCookie(headers.cookie, cookieName), tokenFromCookie(headers.cookie), headers.headerToken ?? null, queryToken];
  return candidates.some((c) => c !== null && safeCompare(c, activeToken));
}

/** Build the Set-Cookie value that stores the token for a browser session. */
export function buildTokenCookie(token: string, maxAgeMs: number, secure: boolean, cookieName = 'prism_dashboard_token'): string {
  return (
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; ` +
    `Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? "; Secure" : ""}`
  );
}
