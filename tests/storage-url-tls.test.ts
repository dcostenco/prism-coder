import { describe, it, expect } from "vitest";
import { isValidHttpUrl } from "../src/storage/index.js";

/**
 * The privacy policy states that cloud memory "travels over TLS". Before this
 * guard that held only because the DEFAULT base URL is https — nothing stopped
 * a user pointing PRISM_SYNALUX_BASE_URL at plain http, which would have sent
 * session content (summaries, decisions, filenames) unencrypted while the
 * published policy said otherwise. A claim in a privacy policy should be
 * enforced by code, not left to a default.
 */
describe("cloud backend URL validation requires TLS", () => {
  it("accepts https for remote hosts", () => {
    expect(isValidHttpUrl("https://synalux.ai")).toBe(true);
    expect(isValidHttpUrl("https://example.com:8443/base")).toBe(true);
  });

  it("REJECTS plain http for remote hosts", () => {
    expect(isValidHttpUrl("http://synalux.ai")).toBe(false);
    expect(isValidHttpUrl("http://evil.example.com")).toBe(false);
    expect(isValidHttpUrl("http://192.168.1.10:3000")).toBe(false);
  });

  it("still allows http on loopback, where traffic never leaves the machine", () => {
    // The local Supabase stack runs here; blocking it would break local dev.
    expect(isValidHttpUrl("http://localhost:54321")).toBe(true);
    expect(isValidHttpUrl("http://127.0.0.1:54321")).toBe(true);
  });

  it("rejects non-http protocols and malformed input", () => {
    expect(isValidHttpUrl("ftp://synalux.ai")).toBe(false);
    expect(isValidHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isValidHttpUrl("not a url")).toBe(false);
  });
});
