/**
 * Two defects found by adversarial review of this branch, 2026-09-16.
 *
 * 1. Startup hydration published the portal base URL straight from the settings
 *    store, bypassing the plaintext-upgrade control that the storage layer has
 *    always applied. A self-hosted portal stored as `http://host` was published
 *    unchanged, so the search client would POST the query and an
 *    `Authorization: Bearer <JWT>` header over cleartext, and `prism connect`
 *    would then persist that URL into every host's MCP env block.
 *
 * 2. The CHANGELOG claimed search and entitlements "can no longer disagree
 *    about whether the portal is usable". They could: entitlements ignored the
 *    legacy SYNALUX_BASE_URL alias, accepted an unexpanded ${...} template and
 *    never checked the value was a URL. Four environments disagreed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const KEYS = ["PRISM_SYNALUX_BASE_URL", "SYNALUX_BASE_URL", "PRISM_SYNALUX_API_KEY"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe("a remote portal is never addressed in the clear", () => {
  it("upgrades a cleartext base URL hydrated from the settings store", async () => {
    const s = await import("../src/utils/synaluxSearch.js");

    await s.hydrateSynaluxCredentials(async (name) =>
      name === "PRISM_SYNALUX_BASE_URL" ? "http://portal.internal.example"
        : name === "PRISM_SYNALUX_API_KEY" ? "test_subscription_key" : "");

    expect(process.env.PRISM_SYNALUX_BASE_URL).toBe("https://portal.internal.example");
    expect(s.resolvePortalBaseUrl()).toBe("https://portal.internal.example");
  });

  it("upgrades a cleartext base URL supplied by the host environment", async () => {
    const s = await import("../src/utils/synaluxSearch.js");
    process.env.PRISM_SYNALUX_BASE_URL = "http://portal.internal.example";

    expect(s.resolvePortalBaseUrl()).toBe("https://portal.internal.example");
  });

  it("leaves loopback alone, where there is no wire to intercept", async () => {
    const s = await import("../src/utils/synaluxSearch.js");
    for (const local of ["http://localhost:3000", "http://127.0.0.1:8080"]) {
      process.env.PRISM_SYNALUX_BASE_URL = local;
      expect(s.resolvePortalBaseUrl()).toBe(local);
    }
  });

  it("falls through a malformed candidate instead of disabling search", async () => {
    // A one-character typo in one host config used to short-circuit the whole
    // chain and silently route every query to the direct provider.
    const s = await import("../src/utils/synaluxSearch.js");
    process.env.PRISM_SYNALUX_BASE_URL = "portal.internal.example";   // no scheme
    process.env.SYNALUX_BASE_URL = "https://good.portal.example";
    process.env.PRISM_SYNALUX_API_KEY = "test_subscription_key";

    expect(s.resolvePortalBaseUrl()).toBe("https://good.portal.example");
    expect(s.synaluxSearchAvailable()).toBe(true);
  });
});

describe("search and entitlements answer the portal question identically", () => {
  // Each row disagreed before the two were given one resolver.
  const ENVIRONMENTS: Array<[string, Record<string, string>]> = [
    ["legacy alias arriving after module load",
      { SYNALUX_BASE_URL: "https://legacy.portal.example", PRISM_SYNALUX_API_KEY: "k" }],
    ["unexpanded base template with a real alias behind it",
      { PRISM_SYNALUX_BASE_URL: "${PRISM_SYNALUX_BASE_URL}", SYNALUX_BASE_URL: "https://real.portal.example", PRISM_SYNALUX_API_KEY: "k" }],
    ["unexpanded key template",
      { PRISM_SYNALUX_BASE_URL: "https://p.example", PRISM_SYNALUX_API_KEY: "${PRISM_SYNALUX_API_KEY}" }],
    ["scheme-less base URL",
      { PRISM_SYNALUX_BASE_URL: "synalux.ai", PRISM_SYNALUX_API_KEY: "k" }],
  ];

  for (const [label, env] of ENVIRONMENTS) {
    it(`agrees on: ${label}`, async () => {
      Object.assign(process.env, env);
      const s = await import("../src/utils/synaluxSearch.js");
      const ent = await import("../src/utils/entitlements.js");
      ent._resetEntitlementsForTest();
      vi.spyOn(globalThis, "fetch" as never).mockRejectedValue(new Error("no network in test"));

      const searchSaysUsable = s.synaluxSearchAvailable();
      const result = await ent.getEntitlements();
      const entitlementsSaysUsable = result.source !== "unconfigured";

      expect(searchSaysUsable).toBe(entitlementsSaysUsable);
      ent._resetEntitlementsForTest();
    });
  }
});
