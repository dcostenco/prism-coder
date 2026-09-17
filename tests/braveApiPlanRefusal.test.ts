/**
 * A signed-in FREE account holding its own Brave key.
 *
 * Portal search is available to every `prism connect` login, so a
 * free account is routed to the portal, and the portal answers its search
 * with 403 "requires Standard plan or higher". Owner's decision: that
 * account may use the key it configured itself — the same footing as a user
 * who never signed in. Everything else the portal can say (outage, quota,
 * expired login, a 403 that is not about the plan) stays inside the privacy
 * boundary: no direct provider call with the original query.
 *
 * The real synaluxSearch client and portalError module are exercised; only
 * config, the JWT exchange, the logger and fetch are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;
const fetchMock = vi.fn();

const PLAN_REFUSAL = (feature: string) => ({
  ok: false,
  status: 403,
  text: async () =>
    JSON.stringify({ status: "error", error: `${feature} requires Standard plan or higher.`, upgrade_url: "/pricing" }),
});

const braveWebOk = (results: Array<{ title: string; url: string; description: string }>) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ web: { results } }),
  json: async () => ({ web: { results } }),
});

async function load(opts: { braveKey?: string; answersKey?: string } = {}) {
  vi.resetModules();
  vi.doMock("../src/config.js", () => ({
    BRAVE_API_KEY: opts.braveKey,
    BRAVE_ANSWERS_API_KEY: opts.answersKey,
    SYNALUX_CONFIGURED: true,
    PRISM_SYNALUX_BASE_URL: "https://portal.test",
    // Deliberately not token-shaped: a `synalux_sk_…` string in a public repo
    // is indistinguishable from a leak. The JWT exchange is mocked, so this
    // value is never read.
    PRISM_SYNALUX_API_KEY: "test-synalux-key",
    PRISM_DEBUG_LOGGING: false,
  }));
  vi.doMock("../src/utils/logger.js", () => ({
    debugLog: vi.fn(),
    sanitizeForLog: (s: string) => s,
  }));
  vi.doMock("../src/utils/synaluxJwt.js", () => ({
    getSynaluxJwt: vi.fn().mockResolvedValue("jwt-token"),
    invalidateSynaluxJwt: vi.fn(),
  }));
  return import("../src/utils/braveApi.js");
}

describe("a free account's own key answers a portal plan refusal", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.doUnmock("../src/config.js");
    vi.doUnmock("../src/utils/logger.js");
    vi.doUnmock("../src/utils/synaluxJwt.js");
  });

  it("web search (raw): the same query goes to Brave on the user's own key", async () => {
    const braveApi = await load({ braveKey: "own-key" });
    fetchMock
      .mockResolvedValueOnce(PLAN_REFUSAL("Cloud Search"))
      .mockResolvedValueOnce(braveWebOk([{ title: "Own", url: "https://own.example", description: "d" }]));

    const raw = await braveApi.performWebSearchRaw("free user query", 5, 0);

    expect(JSON.parse(raw).web.results[0].title).toBe("Own");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://portal.test/api/v1/prism/search");
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toContain("api.search.brave.com/res/v1/web/search");
    expect(new URL(String(url)).searchParams.get("q")).toBe("free user query");
    expect(init.headers["X-Subscription-Token"]).toBe("own-key");
  });

  it("web search (formatted): same rule, formatted output", async () => {
    const braveApi = await load({ braveKey: "own-key" });
    fetchMock
      .mockResolvedValueOnce(PLAN_REFUSAL("Cloud Search"))
      .mockResolvedValueOnce(braveWebOk([{ title: "Own", url: "https://own.example", description: "d" }]));

    const text = await braveApi.performWebSearch("free user query", 5, 0);

    expect(text).toContain("Title: Own");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers["X-Subscription-Token"]).toBe("own-key");
  });

  it("local search (raw): the direct path is used, and its web fallback stays direct", async () => {
    const braveApi = await load({ braveKey: "own-key" });
    fetchMock
      .mockResolvedValueOnce(PLAN_REFUSAL("Local Search"))
      // Brave locations search: nothing local → web fallback
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ locations: { results: [] } }) })
      .mockResolvedValueOnce(braveWebOk([{ title: "Nearby", url: "https://near.example", description: "d" }]));

    const raw = await braveApi.performLocalSearchRaw("coffee near me", 5);
    const parsed = JSON.parse(raw);

    expect(parsed.source).toBe("web_fallback");
    expect(parsed.formattedText).toContain("Title: Nearby");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://portal.test/api/v1/prism/local-search");
    for (const call of fetchMock.mock.calls.slice(1)) {
      expect(String(call[0])).toContain("api.search.brave.com");
      expect(call[1].headers["X-Subscription-Token"]).toBe("own-key");
    }
  });

  it("answers: Brave Answers on the user's own answers key", async () => {
    const braveApi = await load({ answersKey: "own-answers-key" });
    fetchMock
      .mockResolvedValueOnce(PLAN_REFUSAL("Answers"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "own answer" } }] }),
      });

    const answer = await braveApi.performBraveAnswers("free user question");

    expect(answer).toBe("own answer");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://portal.test/api/v1/prism/answers");
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toContain("api.search.brave.com/res/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer own-answers-key");
  });
});

describe("everything else the portal says stays inside the privacy boundary", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.doUnmock("../src/config.js");
    vi.doUnmock("../src/utils/logger.js");
    vi.doUnmock("../src/utils/synaluxJwt.js");
  });

  it("without an own key the plan refusal propagates and nothing else is called", async () => {
    const braveApi = await load({});
    fetchMock.mockResolvedValueOnce(PLAN_REFUSAL("Cloud Search"));

    await expect(braveApi.performWebSearchRaw("free user query", 5, 0)).rejects.toThrow("HTTP 403");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 403 that is not about the plan never escapes, key or no key", async () => {
    const braveApi = await load({ braveKey: "own-key" });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      // No `upgrade_url`, no "plan": the portal is refusing for some other reason.
      text: async () => JSON.stringify({ status: "error", error: "Forbidden" }),
    });

    await expect(braveApi.performWebSearchRaw("private query", 5, 0)).rejects.toThrow("HTTP 403");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a quota 429 never escapes even though it also carries upgrade_url", async () => {
    const braveApi = await load({ braveKey: "own-key" });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () =>
        JSON.stringify({ status: "error", error: "Daily search quota exceeded.", daily_used: 50, daily_limit: 50, upgrade_url: "/pricing" }),
    });

    await expect(braveApi.performWebSearchRaw("private query", 5, 0)).rejects.toThrow("HTTP 429");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an outage never escapes", async () => {
    const braveApi = await load({ braveKey: "own-key" });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, text: async () => "Search providers temporarily unavailable." });

    await expect(braveApi.performWebSearchRaw("private query", 5, 0)).rejects.toThrow("HTTP 503");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an expired login never escapes: 401, one JWT re-exchange, 401 again, stop", async () => {
    const braveApi = await load({ braveKey: "own-key" });
    const unauthorized = { ok: false, status: 401, text: async () => JSON.stringify({ error: "Unauthorized" }) };
    fetchMock.mockResolvedValueOnce(unauthorized).mockResolvedValueOnce(unauthorized);

    await expect(braveApi.performWebSearchRaw("private query", 5, 0)).rejects.toThrow("HTTP 401");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toBe("https://portal.test/api/v1/prism/search");
    }
  });
});
