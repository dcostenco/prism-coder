/**
 * @file youcomApi.test.ts
 * @purpose Unit-test suite for the You.com Search API client (performYouComSearch)
 *
 * Tests cover:
 *   1. Request shape — POST to ydc-index.io/v1/search with X-API-Key header
 *   2. Response parsing — { web: [...], news: [...] }
 *   3. HTTP-error, invalid-JSON and API-error paths
 *   4. News fallback when web results are empty
 *   5. No results path
 *   6. Missing API key
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to mock fetch at the global level since youcomApi uses it directly.
const mockFetch = vi.fn();

// Save original fetch to restore after
const originalFetch = globalThis.fetch;

// Mock config module — must include all exports used by the tested module
// (youcomApi imports config for YDC_API_KEY; logger imports PRISM_DEBUG_LOGGING)
vi.mock("../../src/config.js", () => ({
  YDC_API_KEY: "test-api-key-12345",
  PRISM_DEBUG_LOGGING: false,
  BRAVE_API_KEY: "mock-brave-key",
  BRAVE_ANSWERS_API_KEY: "",
  GOOGLE_API_KEY: "",
  SERVER_CONFIG: { name: "prism-test", version: "1.0.0" },
  PRISM_USER_ID: "test-user",
  SESSION_MEMORY_ENABLED: true,
  PRISM_ENABLE_HIVEMIND: false,
  PRISM_AUTO_CAPTURE: false,
  PRISM_CAPTURE_PORTS: [],
  PRISM_HDC_ENABLED: false,
  PRISM_DARK_FACTORY_ENABLED: false,
  PRISM_TASK_ROUTER_ENABLED_ENV: false,
  PRISM_SCHEDULER_ENABLED: false,
  PRISM_SCHOLAR_ENABLED: false,
  PRISM_FORCE_LOCAL: false,
  SUPABASE_URL: undefined,
  SUPABASE_KEY: undefined,
  SUPABASE_CONFIGURED: false,
  SYNALUX_CONFIGURED: false,
  PRISM_SYNALUX_BASE_URL: undefined,
  PRISM_SYNALUX_API_KEY: undefined,
  PRISM_STORAGE: "local",
  PRISM_HDC_POLICY_FALLBACK_THRESHOLD: 0.85,
  PRISM_HDC_POLICY_CLARIFY_THRESHOLD: 0.95,
  PRISM_GRAPH_PRUNING_ENABLED: false,
  PRISM_GRAPH_PRUNE_MIN_STRENGTH: 0.15,
  PRISM_GRAPH_PRUNE_PROJECT_COOLDOWN_MS: 600000,
  PRISM_GRAPH_PRUNE_SWEEP_BUDGET_MS: 30000,
  PRISM_GRAPH_PRUNE_MAX_PROJECTS_PER_SWEEP: 25,
  PRISM_ACTR_ENABLED: false,
  PRISM_ACTR_DECAY: 0.5,
  PRISM_ACTR_WEIGHT_SIMILARITY: 0.7,
  PRISM_ACTR_WEIGHT_ACTIVATION: 0.3,
  PRISM_ACTR_SIGMOID_MIDPOINT: -2.0,
  PRISM_ACTR_SIGMOID_STEEPNESS: 1.0,
  PRISM_ACTR_MAX_ACCESSES_PER_ENTRY: 50,
  PRISM_ACTR_BUFFER_FLUSH_MS: 5000,
  PRISM_ACTR_ACCESS_LOG_RETENTION_DAYS: 90,
  PRISM_TURBOQUANT_TIEBREAKER_EPSILON: 0,
  PRISM_LOCAL_LLM_ENABLED: false,
  PRISM_LOCAL_LLM_MODEL: "prism-coder:9b",
  PRISM_LOCAL_LLM_URL: "http://localhost:11434",
  PRISM_SCHEDULER_INTERVAL_MS: 43200000,
  PRISM_SCHOLAR_INTERVAL_MS: 0,
  PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN: 3,
  PRISM_SCHOLAR_SCRAPE_BUDGET_MS: 60000,
  PRISM_SCHOLAR_TOPICS: ["ai"],
  PRISM_LINK_DECAY_DAYS: 30,
  PRISM_VERIFICATION_HARNESS_ENABLED: false,
  PRISM_VERIFICATION_LAYERS: ["data"],
  PRISM_VERIFICATION_DEFAULT_SEVERITY: "warn",
  WATCHDOG_INTERVAL_MS: 60000,
  WATCHDOG_STALE_MIN: 5,
  WATCHDOG_FROZEN_MIN: 15,
  WATCHDOG_OFFLINE_MIN: 30,
  WATCHDOG_LOOP_THRESHOLD: 5,
  FIRECRAWL_API_KEY: "",
  VOYAGE_API_KEY: "",
  SEMANTIC_SCHOLAR_API_KEY: "",
  PRISM_AUTOLOAD_PROJECTS: undefined,
}));

// Dynamic import so mocks are in place first
async function getModule() {
  return import("../../src/utils/youcomApi.js");
}

/** Build a fake You.com API response shape */
function fakeSuccessResponse(webResults: number = 3, newsResults: number = 0) {
  const web = Array.from({ length: webResults }, (_, i) => ({
    title: `Web Result ${i + 1}`,
    url: `https://example.com/web-${i + 1}`,
    description: `Description for web result ${i + 1}`,
  }));
  const news = Array.from({ length: newsResults }, (_, i) => ({
    title: `News Result ${i + 1}`,
    url: `https://news.example.com/news-${i + 1}`,
    description: `Description for news result ${i + 1}`,
  }));
  return { web, news };
}

describe("performYouComSearch", () => {
  beforeEach(() => {
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends POST to ydc-index.io/v1/search with X-API-Key header and JSON body", async () => {
    const resp = fakeSuccessResponse(2);
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(resp), { status: 200 }));

    const { performYouComSearch } = await getModule();
    const result = await performYouComSearch("test query", 5);

    expect(result).toContain("test query");
    expect(result).toContain("Web Result 1");
    expect(result).toContain("Web Result 2");

    // Verify request shape
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://ydc-index.io/v1/search");
    expect(opts.method).toBe("POST");
    expect(opts.headers["X-API-Key"]).toBe("test-api-key-12345");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    const parsedBody = JSON.parse(opts.body);
    expect(parsedBody.query).toBe("test query");
    expect(parsedBody.count).toBe(5);
  });

  it("parses { web, news } response correctly", async () => {
    const resp = fakeSuccessResponse(3);
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(resp), { status: 200 }));

    const { performYouComSearch } = await getModule();
    const result = await performYouComSearch("query", 10);

    // Should list all 3 web results
    expect(result).toContain("Web Result 1");
    expect(result).toContain("Web Result 2");
    expect(result).toContain("Web Result 3");
    expect(result).toContain("https://example.com/web-1");
    expect(result).toContain("search results");
  });

  it("falls back to news when web results are empty", async () => {
    const resp = fakeSuccessResponse(0, 2);
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(resp), { status: 200 }));

    const { performYouComSearch } = await getModule();
    const result = await performYouComSearch("news query");

    expect(result).toContain("news results");
    expect(result).toContain("News Result 1");
    expect(result).toContain("News Result 2");
    expect(result).toContain("https://news.example.com/news-1");
  });

  it("returns no-results message when both web and news are empty", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ web: [], news: [] }), { status: 200 })
    );

    const { performYouComSearch } = await getModule();
    const result = await performYouComSearch("nothing");

    expect(result).toContain("No results found");
    expect(result).toContain("nothing");
  });

  it("throws on HTTP error with message from response body", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "payment_required", message: "Your prepaid credit balance has been depleted." }),
        { status: 402, statusText: "Payment Required" }
      )
    );

    const { performYouComSearch } = await getModule();
    await expect(performYouComSearch("paid query")).rejects.toThrow(
      /You.com search returned HTTP 402/
    );
  });

  it("throws on HTTP error without JSON body (uses statusText)", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" })
    );

    const { performYouComSearch } = await getModule();
    await expect(performYouComSearch("error query")).rejects.toThrow(
      /You.com search returned HTTP 500/
    );
  });

  it("throws on invalid JSON response", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("not json", { status: 200 })
    );

    const { performYouComSearch } = await getModule();
    await expect(performYouComSearch("bad json")).rejects.toThrow(
      /You.com search returned invalid JSON/
    );
  });

  it("throws on API-level error field", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "rate_limited" }), { status: 200 })
    );

    const { performYouComSearch } = await getModule();
    await expect(performYouComSearch("rate limited")).rejects.toThrow(
      /You.com search API error: rate_limited/
    );
  });

  it("throws on network error", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    const { performYouComSearch } = await getModule();
    await expect(performYouComSearch("network fail")).rejects.toThrow(
      /You.com search failed \(network\)/
    );
  });

  it("caps count at 20", async () => {
    const resp = fakeSuccessResponse(1);
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(resp), { status: 200 }));

    const { performYouComSearch } = await getModule();
    await performYouComSearch("lots", 50);

    const [, opts] = mockFetch.mock.calls[0];
    const parsedBody = JSON.parse(opts.body);
    expect(parsedBody.count).toBe(20);
  });
});

describe("youcomSearchAvailable", () => {
  it("returns true when YDC_API_KEY is set", async () => {
    const { youcomSearchAvailable } = await getModule();
    expect(youcomSearchAvailable()).toBe(true);
  });
});