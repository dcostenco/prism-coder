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

describe("insecure cloud URLs are upgraded, not just rejected", () => {
  it("upgrades a remote http URL to https", async () => {
    const { upgradeInsecureCloudUrl } = await import("../src/storage/index.js");
    expect(upgradeInsecureCloudUrl("http://synalux.ai")).toBe("https://synalux.ai");
    expect(upgradeInsecureCloudUrl("http://example.com:8080/base")).toBe("https://example.com:8080/base");
  });

  it("leaves loopback alone — that traffic never crosses a network", () => {
    // The local Supabase stack serves plain http on 54321; upgrading it would
    // break local development for no security gain.
    return import("../src/storage/index.js").then(({ upgradeInsecureCloudUrl }) => {
      expect(upgradeInsecureCloudUrl("http://127.0.0.1:54321")).toBe("http://127.0.0.1:54321");
      expect(upgradeInsecureCloudUrl("http://localhost:54321")).toBe("http://localhost:54321");
    });
  });

  it("leaves https and malformed input untouched", async () => {
    const { upgradeInsecureCloudUrl } = await import("../src/storage/index.js");
    expect(upgradeInsecureCloudUrl("https://synalux.ai")).toBe("https://synalux.ai");
    expect(upgradeInsecureCloudUrl("not a url")).toBe("not a url");
  });

  it("an upgraded URL then PASSES validation, so the user is not blocked", async () => {
    const { upgradeInsecureCloudUrl, isValidHttpUrl } = await import("../src/storage/index.js");
    // Before: http://synalux.ai failed validation and surfaced as
    // "credentials are missing or invalid" — a message about the wrong thing.
    expect(isValidHttpUrl("http://synalux.ai")).toBe(false);
    expect(isValidHttpUrl(upgradeInsecureCloudUrl("http://synalux.ai"))).toBe(true);
  });
});
