/**
 * Default-on dashboard token — remediation #2 of GHSA-9cvx-7x8q-3g6m.
 *
 * The token is defense-in-depth beneath the Host guard: a secret minted at
 * startup and shown only in the server's stdout, so a DNS-rebound page cannot
 * present it. These cases pin when the token is active, how it is matched, and
 * that matching is exact and constant-time-safe (length-mismatch → false).
 */
import { describe, expect, it } from "vitest";
import { CookieJar } from 'jsdom';
import {
  resolveDashboardToken,
  requestHasToken,
  tokenFromCookie,
  buildTokenCookie,
  dashboardTokenCookieName,
} from "../../src/dashboard/dashboardToken.js";

describe("dashboard token gate (GHSA-9cvx-7x8q-3g6m #2)", () => {
  it('keeps both dashboard instances authorized when a browser opens a second localhost port', () => {
    const jar = new CookieJar();
    const first = dashboardTokenCookieName(33001);
    const second = dashboardTokenCookieName(33002);
    jar.setCookieSync(buildTokenCookie('first-token', 60000, false, first), 'http://localhost:33001/');
    jar.setCookieSync(buildTokenCookie('second-token', 60000, false, second), 'http://localhost:33002/');
    // Cookies share a hostname across ports. A second bootstrap must not replace
    // the first instance's credential, nor authorize it with the other token.
    const cookie = jar.getCookieStringSync('http://localhost:33001/');
    expect(requestHasToken({ cookie }, null, 'first-token', first)).toBe(true);
    expect(requestHasToken({ cookie }, null, 'second-token', second)).toBe(true);
    expect(requestHasToken({ cookie }, null, 'first-token', second)).toBe(false);
  });

  it('still accepts an exact legacy cookie without trusting another instance token', () => {
    const name = dashboardTokenCookieName(33001);
    expect(requestHasToken({ cookie: 'prism_dashboard_token=active' }, null, 'active', name)).toBe(true);
    expect(requestHasToken({ cookie: 'prism_dashboard_token_33002=active' }, null, 'active', name)).toBe(false);
    expect(tokenFromCookie('evil_prism_dashboard_token_33001=active', name)).toBeNull();
  });

  it.each([0, -1, 65536, 3001.5, NaN])('rejects an invalid instance port %s', (port) => {
    expect(() => dashboardTokenCookieName(port)).toThrow('Invalid dashboard port');
  });

  describe("resolveDashboardToken", () => {
    it("mints a random 64-hex token on a default (no-auth) install", () => {
      const t = resolveDashboardToken({ authEnabled: false });
      expect(t).toMatch(/^[a-f0-9]{64}$/);
    });

    it("mints a DIFFERENT token each call (not a fixed constant)", () => {
      const a = resolveDashboardToken({ authEnabled: false });
      const b = resolveDashboardToken({ authEnabled: false });
      expect(a).not.toBe(b);
    });

    it("is off when real auth is configured — that is the gate then", () => {
      expect(resolveDashboardToken({ authEnabled: true })).toBeNull();
    });

    it.each(["1", "true", "TRUE", "yes", "on"])(
      "honors the PRISM_DASHBOARD_NO_TOKEN opt-out value %s",
      (optOut) => {
        expect(resolveDashboardToken({ authEnabled: false, optOut })).toBeNull();
      },
    );

    it.each(["", "  ", "0", "false", "no", undefined])(
      "keeps the token active for non-opt-out value %s",
      (optOut) => {
        expect(resolveDashboardToken({ authEnabled: false, optOut })).not.toBeNull();
      },
    );

    it("pins a provided token verbatim, ignoring a whitespace-only pin", () => {
      expect(resolveDashboardToken({ authEnabled: false, pinnedToken: "PINNED-abc123" })).toBe(
        "PINNED-abc123",
      );
      expect(resolveDashboardToken({ authEnabled: false, pinnedToken: "   " })).toMatch(
        /^[a-f0-9]{64}$/,
      );
    });

    it("does not pin when auth is enabled (auth wins over a pin)", () => {
      expect(
        resolveDashboardToken({ authEnabled: true, pinnedToken: "PINNED-abc123" }),
      ).toBeNull();
    });
  });

  describe("tokenFromCookie", () => {
    it("extracts the token from a cookie header among others", () => {
      expect(tokenFromCookie("foo=1; prism_dashboard_token=abc123; bar=2")).toBe("abc123");
      expect(tokenFromCookie("prism_dashboard_token=xyz")).toBe("xyz");
    });

    it("returns null when absent, empty, or a look-alike cookie name", () => {
      expect(tokenFromCookie(undefined)).toBeNull();
      expect(tokenFromCookie("")).toBeNull();
      expect(tokenFromCookie("other=1")).toBeNull();
      // a differently-named cookie sharing the suffix must NOT match — the name
      // is anchored to start-of-header or "; ".
      expect(tokenFromCookie("evil_prism_dashboard_token=abc")).toBeNull();
      expect(tokenFromCookie("xprism_dashboard_token=abc")).toBeNull();
    });
  });

  describe("requestHasToken", () => {
    const ACTIVE = "s3cr3t-active-token";

    it("accepts the token via cookie", () => {
      expect(
        requestHasToken({ cookie: `prism_dashboard_token=${ACTIVE}` }, null, ACTIVE),
      ).toBe(true);
    });

    it("accepts the token via X-Prism-Dashboard-Token header", () => {
      expect(requestHasToken({ headerToken: ACTIVE }, null, ACTIVE)).toBe(true);
    });

    it("accepts the token via ?token= query", () => {
      expect(requestHasToken({}, ACTIVE, ACTIVE)).toBe(true);
    });

    it("rejects when no channel carries the token", () => {
      expect(requestHasToken({}, null, ACTIVE)).toBe(false);
      expect(requestHasToken({ cookie: "prism_dashboard_token=" }, null, ACTIVE)).toBe(false);
    });

    it("rejects a wrong or truncated token (exact match only)", () => {
      expect(requestHasToken({ headerToken: "wrong" }, null, ACTIVE)).toBe(false);
      expect(requestHasToken({ headerToken: ACTIVE.slice(0, -1) }, null, ACTIVE)).toBe(false);
      expect(requestHasToken({ cookie: `prism_dashboard_token=${ACTIVE}x` }, null, ACTIVE)).toBe(
        false,
      );
    });
  });

  describe("buildTokenCookie", () => {
    it("is HttpOnly + SameSite=Strict with a whole-second Max-Age", () => {
      const c = buildTokenCookie("tok", 86_400_000, false);
      expect(c).toContain("prism_dashboard_token=tok");
      expect(c).toContain("HttpOnly");
      expect(c).toContain("SameSite=Strict");
      expect(c).toContain("Max-Age=86400");
      expect(c).not.toContain("Secure");
    });

    it("adds Secure when requested", () => {
      expect(buildTokenCookie("tok", 1000, true)).toContain("; Secure");
    });
  });
});
