/**
 * URL Validation — Edge Cases for the storage backend resolver
 *
 * ═══════════════════════════════════════════════════════════════════
 * SCOPE:
 *   Pinpoints isValidHttpUrl() (the gatekeeper used by both the
 *   synalux and supabase credential probes in src/storage/index.ts)
 *   against malformed, exotic, and adversarial inputs.
 *
 *   Integration coverage of the resolver itself — auto-resolution,
 *   dashboard fallback, env-var injection — lives in
 *   tests/storage-resolver.test.ts.
 *
 * HISTORY:
 *   This file used to mirror the resolver logic locally for testing,
 *   which let it drift from source. Rewritten to import the real
 *   helper after the ef7fdfd refactor exposed it as isValidHttpUrl.
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from "vitest";
import { isValidHttpUrl } from "../../src/storage/index.js";

describe("isValidHttpUrl — URL validation edge cases", () => {

    // ─── Accepted protocols ─────────────────────────────────────────

    it("accepts https:// URLs", () => {
        expect(isValidHttpUrl("https://abc123.supabase.co")).toBe(true);
    });

    it("accepts http:// URLs (dev/local)", () => {
        expect(isValidHttpUrl("http://localhost:54321")).toBe(true);
    });

    it("accepts URLs with paths", () => {
        expect(isValidHttpUrl("https://abc123.supabase.co/rest/v1")).toBe(true);
    });

    it("accepts URLs with ports", () => {
        expect(isValidHttpUrl("https://self-hosted.example.com:8443")).toBe(true);
    });

    it("accepts URLs with auth info", () => {
        expect(isValidHttpUrl("https://user:pass@abc123.supabase.co")).toBe(true);
    });

    it("accepts the synalux portal URL shape", () => {
        expect(isValidHttpUrl("https://portal.synalux.ai")).toBe(true);
    });

    // ─── Rejected: parseable but wrong protocol ─────────────────────

    it("rejects ftp:// URLs", () => {
        expect(isValidHttpUrl("ftp://files.example.com")).toBe(false);
    });

    it("rejects file:// URLs", () => {
        expect(isValidHttpUrl("file:///etc/passwd")).toBe(false);
    });

    it("rejects javascript: URLs", () => {
        expect(isValidHttpUrl("javascript:alert(1)")).toBe(false);
    });

    it("rejects data: URLs", () => {
        expect(isValidHttpUrl("data:text/html,<h1>hi</h1>")).toBe(false);
    });

    // ─── Rejected: unparseable ──────────────────────────────────────

    it("rejects empty strings", () => {
        expect(isValidHttpUrl("")).toBe(false);
    });

    it("rejects plain text", () => {
        expect(isValidHttpUrl("not-a-url")).toBe(false);
    });

    it("rejects URLs with only protocol", () => {
        expect(isValidHttpUrl("https://")).toBe(false);
    });

    it("rejects whitespace-only strings", () => {
        expect(isValidHttpUrl("  ")).toBe(false);
    });

    it("rejects URLs with mid-string whitespace", () => {
        expect(isValidHttpUrl("https:// abc.supabase.co")).toBe(false);
    });

    // ─── Rejected: deceptive strings ────────────────────────────────

    it("rejects unresolved template placeholders", () => {
        // Real bug seen in the wild: .env had ${SUPABASE_URL} and dotenv
        // didn't interpolate it. Without this check the resolver would
        // try to use the literal placeholder as a URL and crash later.
        expect(isValidHttpUrl("${SUPABASE_URL}")).toBe(false);
    });

    it("rejects null-like strings", () => {
        expect(isValidHttpUrl("null")).toBe(false);
        expect(isValidHttpUrl("undefined")).toBe(false);
    });

    // ─── Edge cases the validator does NOT defend against ──────────
    // These pass the protocol check; defense-in-depth lives downstream
    // (HTTP client TLS validation, server-side allow-listing, etc.).

    it("still does not block SSRF-style URLs at this layer", () => {
        // The resolver's URL check validates protocol only, never hostname.
        // SSRF defense belongs in the HTTP client (or an upstream allow-list),
        // not here. The original version of this test pinned the contract so
        // that "a future tightening is an explicit decision, not an accident";
        // this IS that decision, recorded rather than silently absorbed.
        //
        // Changed 2026-08-06: plain http to a REMOTE host is now rejected,
        // because the published privacy policy states cloud memory travels
        // over TLS and only the default base URL was making that true. The
        // metadata address over https still passes — hostname filtering
        // remains out of scope here.
        expect(isValidHttpUrl("https://169.254.169.254/latest/meta-data/")).toBe(true);
        expect(isValidHttpUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    });

    it("handles extremely long URLs without crashing", () => {
        const longUrl = "https://a" + "b".repeat(10000) + ".supabase.co";
        expect(isValidHttpUrl(longUrl)).toBe(true);
    });

    it("handles unicode hostnames", () => {
        expect(isValidHttpUrl("https://例え.jp/supabase")).toBe(true);
    });
});
