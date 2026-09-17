/**
 * Regression: an enterprise subscriber's web search must reach the Synalux
 * portal, not die asking for a provider key in the server's own environment.
 *
 * Field defect, measured 2026-09-16. Portal search availability was a
 * module-load constant derived from SYNALUX_CONFIGURED, which reads
 * process.env at import time. `prism connect` copies PRISM_SYNALUX_API_KEY
 * into the host's MCP env block only when that key already happened to be in
 * the environment when connect ran; on a machine that logged in through the
 * settings store it writes PRISM_SYNALUX_BASE_URL and no key. The key reached
 * process.env later, during startup — after the constant had frozen `false`.
 *
 * The visible result: every search skipped the portal and failed with
 * "BRAVE_API_KEY is not configured", while entitlements — resolved from that
 * same later-hydrated key — correctly reported the paid plan. Search and
 * entitlements disagreeing about whether the portal is usable IS the defect,
 * so the last suite here pins that they agree.
 *
 * Every mock below is the real broken host: base URL captured at load, no
 * subscription key at load, no Brave key anywhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/config.js", () => ({
  // What `prism connect` actually wrote into the host env block, as config.ts
  // captured it at import time.
  PRISM_SYNALUX_BASE_URL: "https://portal.test",
  PRISM_SYNALUX_API_KEY: undefined,
  SYNALUX_CONFIGURED: false,
  // No provider key in THIS server's environment, which is a property of the
  // process, not of the account. That is why the fallback was a hard failure.
  BRAVE_API_KEY: undefined,
  BRAVE_ANSWERS_API_KEY: undefined,
  PRISM_DEBUG_LOGGING: false,
}));

vi.mock("../src/utils/logger.js", () => ({
  sanitizeForLog: vi.fn((s: string) => s),
  debugLog: vi.fn(),
}));

const mockGetJwt = vi.fn();
const mockInvalidateJwt = vi.fn();
vi.mock("../src/utils/synaluxJwt.js", () => ({
  getSynaluxJwt: (...a: unknown[]) => mockGetJwt(...a),
  invalidateSynaluxJwt: (...a: unknown[]) => mockInvalidateJwt(...a),
}));

const ENV_KEYS = [
  "PRISM_SYNALUX_BASE_URL",
  "SYNALUX_BASE_URL",
  "PRISM_SYNALUX_API_KEY",
  "BRAVE_API_KEY",
] as const;

const fetchMock = vi.fn();
const origFetch = globalThis.fetch;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  // Hermetic: this machine really does carry these in its shell.
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  mockGetJwt.mockResolvedValue("jwt-valid-token");
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  globalThis.fetch = origFetch;
});

function portalReturns(results: Array<{ title: string; url: string; description: string }>) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ status: "success", results, source: "firecrawl" }),
  });
}

describe("portal search availability follows the live credentials", () => {
  let synaluxSearch: typeof import("../src/utils/synaluxSearch.js");

  beforeEach(async () => {
    synaluxSearch = await import("../src/utils/synaluxSearch.js");
  });

  it("is false on the host `prism connect` left without a subscription key", () => {
    // Base URL is in the config constant; the key is nowhere. This was the
    // whole installed population that hit the bug.
    expect(synaluxSearch.synaluxSearchAvailable()).toBe(false);
  });

  it("becomes true when the key reaches the environment after module load", () => {
    expect(synaluxSearch.synaluxSearchAvailable()).toBe(false);
    // Startup hydration from the settings store. A module-load constant could
    // never observe this; that is the entire defect.
    process.env.PRISM_SYNALUX_API_KEY = "test_subscription_hydrated_at_startup";
    expect(synaluxSearch.synaluxSearchAvailable()).toBe(true);
  });

  it("accepts a base URL that only arrives in the environment", () => {
    process.env.PRISM_SYNALUX_API_KEY = "test_subscription_live";
    process.env.PRISM_SYNALUX_BASE_URL = "https://enterprise.portal.example";
    expect(synaluxSearch.synaluxSearchAvailable()).toBe(true);
    expect(synaluxSearch.resolvePortalBaseUrl()).toBe("https://enterprise.portal.example");
  });

  it("honours the legacy SYNALUX_BASE_URL alias, as config.ts does", () => {
    process.env.PRISM_SYNALUX_API_KEY = "test_subscription_live";
    process.env.SYNALUX_BASE_URL = "https://legacy.portal.example/";
    expect(synaluxSearch.synaluxSearchAvailable()).toBe(true);
    // Trailing slash stripped, so the joined path never doubles it.
    expect(synaluxSearch.resolvePortalBaseUrl()).toBe("https://legacy.portal.example");
  });

  it("treats an unexpanded ${...} template as no credential at all", () => {
    // A half-written host config. Reading it as a key would send every search
    // to a portal that can only answer 401, with no route back to Brave.
    process.env.PRISM_SYNALUX_API_KEY = "${PRISM_SYNALUX_API_KEY}";
    expect(synaluxSearch.synaluxSearchAvailable()).toBe(false);
    process.env.PRISM_SYNALUX_API_KEY = "test_subscription_live";
    process.env.PRISM_SYNALUX_BASE_URL = "${PRISM_SYNALUX_BASE_URL}";
    expect(synaluxSearch.resolvePortalBaseUrl()).toBe("https://portal.test");
  });

  it("skips a base URL that is not http(s) and uses the next candidate", () => {
    // A bad value in one host config must not disable portal search outright
    // while a good one is configured elsewhere; it falls through instead.
    process.env.PRISM_SYNALUX_API_KEY = "test_subscription_live";
    process.env.PRISM_SYNALUX_BASE_URL = "ftp://portal.example";
    expect(synaluxSearch.resolvePortalBaseUrl()).toBe("https://portal.test");
    expect(synaluxSearch.synaluxSearchAvailable()).toBe(true);
  });

  it("ignores whitespace-only credentials", () => {
    process.env.PRISM_SYNALUX_API_KEY = "   ";
    expect(synaluxSearch.synaluxSearchAvailable()).toBe(false);
  });

  it("addresses the portal it just declared reachable", async () => {
    // Before the fix the request builder read the module-load constant behind a
    // non-null assertion. Once availability could be true without that constant,
    // a live-env-only install would have thrown TypeError instead of searching.
    process.env.PRISM_SYNALUX_API_KEY = "test_subscription_live";
    process.env.PRISM_SYNALUX_BASE_URL = "https://enterprise.portal.example/";
    portalReturns([{ title: "T", url: "https://a.example", description: "D" }]);

    await synaluxSearch.synaluxWebSearchRaw("query", 5);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://enterprise.portal.example/api/v1/prism/search",
    );
  });
});

describe("hydrateSynaluxCredentials", () => {
  let synaluxSearch: typeof import("../src/utils/synaluxSearch.js");

  beforeEach(async () => {
    synaluxSearch = await import("../src/utils/synaluxSearch.js");
  });

  it("takes the key from the settings store when the environment has none", async () => {
    expect(synaluxSearch.synaluxSearchAvailable()).toBe(false);
    const ready = await synaluxSearch.hydrateSynaluxCredentials(
      async (name) => (name === "PRISM_SYNALUX_API_KEY" ? "test_subscription_from_settings" : ""),
    );
    expect(ready).toBe(true);
    expect(synaluxSearch.synaluxSearchAvailable()).toBe(true);
  });

  it("never overwrites a key the environment already supplied", async () => {
    process.env.PRISM_SYNALUX_API_KEY = "test_subscription_from_env";
    await synaluxSearch.hydrateSynaluxCredentials(async () => "test_subscription_from_settings");
    expect(process.env.PRISM_SYNALUX_API_KEY).toBe("test_subscription_from_env");
  });

  it("normalises the stored base URL before publishing it", async () => {
    await synaluxSearch.hydrateSynaluxCredentials(async (name) =>
      name === "PRISM_SYNALUX_API_KEY" ? "test_subscription_from_settings"
        : name === "PRISM_SYNALUX_BASE_URL" ? "https://stored.portal.example//"
          : "");
    expect(process.env.PRISM_SYNALUX_BASE_URL).toBe("https://stored.portal.example");
  });

  it("refuses to publish a stored base URL that is not a URL", async () => {
    // A settings row holding a key, a path, or free text. process.env is shared
    // with storage and entitlements, so publishing it would break every portal
    // client in the process rather than only this search.
    await synaluxSearch.hydrateSynaluxCredentials(async () => "test_subscription_not_a_url");
    expect(process.env.PRISM_SYNALUX_BASE_URL).toBeUndefined();
  });

  it("does not publish an unexpanded template from the settings store", async () => {
    await synaluxSearch.hydrateSynaluxCredentials(async () => "${PRISM_SYNALUX_API_KEY}");
    expect(process.env.PRISM_SYNALUX_API_KEY).toBeUndefined();
    expect(synaluxSearch.synaluxSearchAvailable()).toBe(false);
  });

  it("survives a settings read that throws, because startup must not break", async () => {
    await expect(
      synaluxSearch.hydrateSynaluxCredentials(async () => {
        throw new Error("settings db locked");
      }),
    ).resolves.toBe(false);
  });
});

describe("a subscriber's search reaches the portal instead of demanding a Brave key", () => {
  let braveApi: typeof import("../src/utils/braveApi.js");

  beforeEach(async () => {
    braveApi = await import("../src/utils/braveApi.js");
  });

  it("routes performWebSearchRaw through the portal once the key is live", async () => {
    process.env.PRISM_SYNALUX_API_KEY = "test_subscription_hydrated_at_startup";
    portalReturns([{ title: "Result 1", url: "https://a.example", description: "Desc 1" }]);

    const raw = await braveApi.performWebSearchRaw("bcba reinforcement schedules", 5);

    expect(fetchMock.mock.calls[0][0]).toBe("https://portal.test/api/v1/prism/search");
    expect(JSON.parse(raw).web.results[0].title).toBe("Result 1");
  });

  it("routes performWebSearch through the portal once the key is live", async () => {
    process.env.PRISM_SYNALUX_API_KEY = "test_subscription_hydrated_at_startup";
    portalReturns([{ title: "Result 1", url: "https://a.example", description: "Desc 1" }]);

    const text = await braveApi.performWebSearch("bcba reinforcement schedules", 5);

    expect(fetchMock.mock.calls[0][0]).toBe("https://portal.test/api/v1/prism/search");
    expect(text).toContain("Title: Result 1");
  });

  it("never raises BRAVE_API_KEY on a search that the portal can serve", async () => {
    // The reported symptom, verbatim from the screenshot.
    process.env.PRISM_SYNALUX_API_KEY = "test_subscription_hydrated_at_startup";
    portalReturns([]);
    await expect(braveApi.performWebSearchRaw("q", 5)).resolves.toBeTypeOf("string");
    expect(fetchMock.mock.calls[0][0]).toContain("portal.test");
  });

  it("still demands a Brave key when there is genuinely no subscription", async () => {
    // The guard must keep working. No key in env, none in config: the portal is
    // not usable and the direct provider is the only path left.
    await expect(braveApi.performWebSearchRaw("q", 5)).rejects.toThrow(
      "BRAVE_API_KEY is not configured",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not reach for the portal mid-flight once a search has started", async () => {
    // Availability is read once per call. A key that lands between the branch
    // and the request must not produce a portal call with no credential.
    const promise = braveApi.performWebSearchRaw("q", 5);
    process.env.PRISM_SYNALUX_API_KEY = "test_subscription_too_late";
    await expect(promise).rejects.toThrow("BRAVE_API_KEY is not configured");
  });
});

describe("search and entitlements agree on whether the portal is usable", () => {
  // The user-visible contradiction: the portal reported an enterprise plan
  // while search insisted nothing was configured. Both modules resolve the
  // credential the same way now, so pin that they answer together.
  let synaluxSearch: typeof import("../src/utils/synaluxSearch.js");
  let entitlements: typeof import("../src/utils/entitlements.js");

  beforeEach(async () => {
    synaluxSearch = await import("../src/utils/synaluxSearch.js");
    entitlements = await import("../src/utils/entitlements.js");
    entitlements._resetEntitlementsForTest();
  });

  afterEach(() => {
    entitlements._resetEntitlementsForTest();
  });

  it("both treat a key hydrated after load as a configured portal", async () => {
    process.env.PRISM_SYNALUX_API_KEY = "test_subscription_hydrated_at_startup";
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ plan: "enterprise", features: {} }),
    });

    const ent = await entitlements.getEntitlements();

    expect(synaluxSearch.synaluxSearchAvailable()).toBe(true);
    // A JWT exchange only happens when entitlements considered the portal
    // configured; the unconfigured branch returns before it.
    expect(mockGetJwt).toHaveBeenCalled();
    expect(ent.source).not.toBe("unconfigured");
  });

  it("both treat a host with no key at all as unconfigured", async () => {
    const ent = await entitlements.getEntitlements();

    expect(synaluxSearch.synaluxSearchAvailable()).toBe(false);
    expect(mockGetJwt).not.toHaveBeenCalled();
    expect(ent.source).toBe("unconfigured");
  });
});
