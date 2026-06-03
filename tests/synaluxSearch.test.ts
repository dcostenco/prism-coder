/**
 * synaluxSearch.ts + braveApi.ts Synalux-routing tests
 *
 * Pins:
 *   • SYNALUX_SEARCH_AVAILABLE reflects SYNALUX_CONFIGURED
 *   • synaluxWebSearch returns formatted text matching performWebSearch shape
 *   • synaluxWebSearchRaw returns Brave-compatible JSON envelope
 *   • synaluxScrape returns content string
 *   • JWT exchange: 401 → retry once with fresh JWT
 *   • JWT unavailable → throws
 *   • Portal error response → throws with message
 *   • Portal HTTP non-2xx → throws
 *   • braveApi: performWebSearch routes through synalux when available
 *   • braveApi: performWebSearch falls back to Brave on synalux failure
 *   • braveApi: performWebSearch skips synalux when offset > 0
 *   • braveApi: performWebSearchRaw routes through synalux when available
 *   • braveApi: performWebSearchRaw falls back to Brave on synalux failure
 *   • braveApi: performLocalSearch routes through synalux when available
 *   • braveApi: performLocalSearch falls back to Brave on synalux failure
 *   • braveApi: performLocalSearchRaw routes through synalux when available
 *   • braveApi: performLocalSearchRaw falls back to Brave on synalux failure
 *   • braveApi: performBraveAnswers routes through synalux when available
 *   • braveApi: performBraveAnswers falls back to Brave on synalux failure
 *   • synaluxLocalSearch returns formatted text
 *   • synaluxLocalSearchRaw returns compatible JSON envelope
 *   • synaluxBraveAnswers returns answer string
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock config before any imports ──────────────────────────

vi.mock("../src/config.js", () => ({
  BRAVE_API_KEY: "brave_test_key",
  BRAVE_ANSWERS_API_KEY: "brave_answers_test",
  SYNALUX_CONFIGURED: true,
  PRISM_SYNALUX_BASE_URL: "https://portal.test",
  PRISM_SYNALUX_API_KEY: "synalux_sk_test123",
  PRISM_DEBUG_LOGGING: false,
}));

vi.mock("../src/utils/logger.js", () => ({
  debugLog: vi.fn(),
}));

const mockGetJwt = vi.fn();
const mockInvalidateJwt = vi.fn();
vi.mock("../src/utils/synaluxJwt.js", () => ({
  getSynaluxJwt: (...a: any[]) => mockGetJwt(...a),
  invalidateSynaluxJwt: (...a: any[]) => mockInvalidateJwt(...a),
}));

const fetchMock = vi.fn();
const origFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  mockGetJwt.mockResolvedValue("jwt-valid-token");
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

// ── synaluxSearch.ts tests ───────────────────────────────────

describe("synaluxSearch", () => {
  let synaluxSearch: typeof import("../src/utils/synaluxSearch.js");

  beforeEach(async () => {
    synaluxSearch = await import("../src/utils/synaluxSearch.js");
  });

  describe("SYNALUX_SEARCH_AVAILABLE", () => {
    it("reflects SYNALUX_CONFIGURED from config", () => {
      expect(synaluxSearch.SYNALUX_SEARCH_AVAILABLE).toBe(true);
    });
  });

  describe("synaluxWebSearch", () => {
    it("calls portal /api/v1/prism/search with query and limit", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "success",
          results: [
            { title: "Result 1", url: "https://a.example", description: "Desc 1" },
            { title: "Result 2", url: "https://b.example", description: "Desc 2" },
          ],
          source: "firecrawl",
        }),
      });

      const result = await synaluxSearch.synaluxWebSearch("test query", 5);

      // Verify fetch was called correctly
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://portal.test/api/v1/prism/search");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer jwt-valid-token");
      expect(init.headers["X-Prism-Client"]).toBe("prism-mcp-search");
      expect(JSON.parse(init.body)).toEqual({ query: "test query", limit: 5 });

      // Verify formatted output matches performWebSearch shape
      expect(result).toContain("Title: Result 1");
      expect(result).toContain("Description: Desc 1");
      expect(result).toContain("URL: https://a.example");
      expect(result).toContain("Title: Result 2");
    });

    it("caps limit to 20", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "success", results: [] }),
      });

      await synaluxSearch.synaluxWebSearch("q", 50);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.limit).toBe(20);
    });

    it("returns empty string when no results", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "success", results: [] }),
      });

      const result = await synaluxSearch.synaluxWebSearch("no results");
      expect(result).toBe("");
    });

    it("handles missing result fields gracefully", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "success",
          results: [{ title: null, url: undefined, description: "" }],
        }),
      });

      const result = await synaluxSearch.synaluxWebSearch("partial");
      expect(result).toContain("Title: ");
      expect(result).toContain("URL: ");
    });
  });

  describe("synaluxWebSearchRaw", () => {
    it("returns Brave-compatible JSON envelope", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "success",
          results: [
            { title: "R1", url: "https://r1.example", description: "D1" },
          ],
        }),
      });

      const raw = await synaluxSearch.synaluxWebSearchRaw("q", 3);
      const parsed = JSON.parse(raw);

      // Must have Brave-compatible shape for code-mode sandbox
      expect(parsed).toHaveProperty("web.results");
      expect(parsed.web.results).toHaveLength(1);
      expect(parsed.web.results[0]).toEqual({
        title: "R1",
        description: "D1",
        url: "https://r1.example",
      });
    });
  });

  describe("synaluxScrape", () => {
    it("calls portal /api/v1/prism/scrape with url", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "success",
          content: "# Scraped Content",
        }),
      });

      const result = await synaluxSearch.synaluxScrape("https://example.com");

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://portal.test/api/v1/prism/scrape");
      expect(JSON.parse(init.body)).toEqual({ url: "https://example.com" });
      expect(result).toBe("# Scraped Content");
    });

    it("passes optional scrape options", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "success", content: "html" }),
      });

      await synaluxSearch.synaluxScrape("https://example.com", {
        formats: ["html"],
        onlyMainContent: false,
        waitFor: 5000,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.formats).toEqual(["html"]);
      expect(body.onlyMainContent).toBe(false);
      expect(body.waitFor).toBe(5000);
    });

    it("returns empty string when content is missing", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "success" }),
      });

      const result = await synaluxSearch.synaluxScrape("https://example.com");
      expect(result).toBe("");
    });
  });

  describe("synaluxLocalSearch", () => {
    it("calls portal /api/v1/prism/local-search and returns formatted text", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "success",
          results: [
            {
              name: "Joe's Pizza",
              address: "123 Main St, NY",
              phone: "(555) 123-4567",
              rating: "4.5 (200 reviews)",
              hours: "Mon-Fri 11am-10pm",
              description: "Best pizza in town",
            },
            {
              name: "Pizza Palace",
              address: "456 Oak Ave, NY",
              phone: "(555) 987-6543",
              rating: "4.2 (150 reviews)",
              hours: "Daily 10am-11pm",
              description: "Great slices",
            },
          ],
        }),
      });

      const result = await synaluxSearch.synaluxLocalSearch("pizza near me", 5);

      // Verify fetch was called correctly
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://portal.test/api/v1/prism/local-search");
      expect(JSON.parse(init.body)).toEqual({ query: "pizza near me", count: 5 });

      // Verify formatted output
      expect(result).toContain("Name: Joe's Pizza");
      expect(result).toContain("Address: 123 Main St, NY");
      expect(result).toContain("Phone: (555) 123-4567");
      expect(result).toContain("Rating: 4.5 (200 reviews)");
      expect(result).toContain("Hours: Mon-Fri 11am-10pm");
      expect(result).toContain("Description: Best pizza in town");
      expect(result).toContain("---");
      expect(result).toContain("Name: Pizza Palace");
    });

    it("returns empty string when no results", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "success", results: [] }),
      });

      const result = await synaluxSearch.synaluxLocalSearch("nowhere");
      expect(result).toBe("");
    });

    it("handles missing fields gracefully", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "success",
          results: [{ name: "", address: "", phone: "", rating: "", hours: "", description: "" }],
        }),
      });

      const result = await synaluxSearch.synaluxLocalSearch("partial");
      expect(result).toContain("Name: N/A");
      expect(result).toContain("Description: No description available");
    });
  });

  describe("synaluxLocalSearchRaw", () => {
    it("returns compatible JSON envelope", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "success",
          results: [
            {
              name: "Joe's Pizza",
              address: "123 Main St",
              phone: "(555) 123-4567",
              rating: "4.5",
              hours: "Mon-Fri 11am-10pm",
              description: "Best pizza",
            },
          ],
        }),
      });

      const raw = await synaluxSearch.synaluxLocalSearchRaw("pizza", 3);
      const parsed = JSON.parse(raw);

      expect(parsed.source).toBe("local");
      expect(parsed.query).toBe("pizza");
      expect(parsed.count).toBe(3);
      expect(parsed.poisData.results).toHaveLength(1);
      expect(parsed.poisData.results[0].name).toBe("Joe's Pizza");
      expect(parsed.descriptionsData.descriptions).toHaveProperty("0", "Best pizza");
    });
  });

  describe("synaluxBraveAnswers", () => {
    it("calls portal /api/v1/prism/answers and returns answer string", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "success",
          answer: "The capital of France is Paris.",
        }),
      });

      const result = await synaluxSearch.synaluxBraveAnswers("What is the capital of France?", "brave");

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://portal.test/api/v1/prism/answers");
      expect(JSON.parse(init.body)).toEqual({ query: "What is the capital of France?", model: "brave" });
      expect(result).toBe("The capital of France is Paris.");
    });

    it("omits model when not provided", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "success",
          answer: "42",
        }),
      });

      await synaluxSearch.synaluxBraveAnswers("meaning of life");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({ query: "meaning of life" });
      expect(body).not.toHaveProperty("model");
    });

    it("throws when answer is empty", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "success" }),
      });

      await expect(synaluxSearch.synaluxBraveAnswers("q")).rejects.toThrow("empty answer");
    });

    it("throws on portal error status", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "error", error: "Rate limited" }),
      });

      await expect(synaluxSearch.synaluxBraveAnswers("q")).rejects.toThrow("Rate limited");
    });
  });

  describe("JWT handling", () => {
    it("retries once on 401 with fresh JWT", async () => {
      // getSynaluxJwt returns initial token (from beforeEach)
      // Then after invalidation, returns refreshed token
      mockGetJwt
        .mockResolvedValueOnce("jwt-initial-token")
        .mockResolvedValueOnce("jwt-refreshed-token");

      // First portal call: 401
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });
      // Second portal call (after JWT refresh): success
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "success", results: [] }),
      });

      await synaluxSearch.synaluxWebSearch("q");

      expect(mockInvalidateJwt).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer jwt-initial-token");
      expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer jwt-refreshed-token");
    });

    it("throws when JWT is unavailable", async () => {
      mockGetJwt.mockResolvedValueOnce(null);

      await expect(synaluxSearch.synaluxWebSearch("q")).rejects.toThrow("no token available");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("throws when JWT re-exchange fails after 401", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });
      mockGetJwt.mockResolvedValueOnce(null);

      await expect(synaluxSearch.synaluxWebSearch("q")).rejects.toThrow("no token available");
    });
  });

  describe("error handling", () => {
    it("throws on portal error status", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "error", error: "Quota exceeded" }),
      });

      await expect(synaluxSearch.synaluxWebSearch("q")).rejects.toThrow("Quota exceeded");
    });

    it("throws on portal HTTP 500", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      await expect(synaluxSearch.synaluxWebSearch("q")).rejects.toThrow("HTTP 500");
    });

    it("throws on network failure", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

      await expect(synaluxSearch.synaluxWebSearch("q")).rejects.toThrow();
    });
  });
});

// ── braveApi.ts Synalux routing tests ────────────────────────

describe("braveApi synalux routing", () => {
  let braveApi: typeof import("../src/utils/braveApi.js");

  beforeEach(async () => {
    braveApi = await import("../src/utils/braveApi.js");
  });

  describe("performWebSearch with synalux", () => {
    it("routes through synalux when available and offset=0", async () => {
      // Synalux portal response
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "success",
          results: [{ title: "Via Synalux", url: "https://s.example", description: "Proxied" }],
        }),
      });

      const result = await braveApi.performWebSearch("test", 5, 0);

      // Should have called portal, not Brave
      const url = fetchMock.mock.calls[0][0];
      expect(url).toBe("https://portal.test/api/v1/prism/search");
      expect(result).toContain("Via Synalux");
    });

    it("falls back to Brave when synalux fails", async () => {
      // Call 1: synaluxWebSearch → portal fetch fails
      fetchMock.mockRejectedValueOnce(new Error("Portal down"));
      // Call 2: performWebSearchRaw → synaluxWebSearchRaw → portal fetch fails again
      fetchMock.mockRejectedValueOnce(new Error("Portal down"));
      // Call 3: performWebSearchRaw → direct Brave fetch succeeds
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          web: { results: [{ title: "Via Brave", description: "Direct", url: "https://b.example" }] },
        }),
      });

      const result = await braveApi.performWebSearch("test", 5, 0);
      expect(result).toContain("Via Brave");
    });

    it("skips synalux when offset > 0 (portal does not support pagination)", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          web: { results: [{ title: "Brave Direct", description: "d", url: "https://d.example" }] },
        }),
      });

      const result = await braveApi.performWebSearch("test", 5, 10);

      // Should go straight to Brave, not portal
      const url = fetchMock.mock.calls[0][0];
      expect(url.toString()).toContain("api.search.brave.com");
      expect(result).toContain("Brave Direct");
    });
  });

  describe("performLocalSearch with synalux", () => {
    it("routes through synalux when available", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "success",
          results: [
            {
              name: "Via Synalux Pizza",
              address: "123 Portal St",
              phone: "(555) 111-2222",
              rating: "4.8",
              hours: "Daily 10am-10pm",
              description: "Proxied local result",
            },
          ],
        }),
      });

      const result = await braveApi.performLocalSearch("pizza", 5);

      const url = fetchMock.mock.calls[0][0];
      expect(url).toBe("https://portal.test/api/v1/prism/local-search");
      expect(result).toContain("Via Synalux Pizza");
    });

    it("falls back to Brave when synalux fails", async () => {
      // synaluxLocalSearch → portal fails
      fetchMock.mockRejectedValueOnce(new Error("Portal down"));
      // performLocalSearchRaw → synaluxLocalSearchRaw → portal fails again
      fetchMock.mockRejectedValueOnce(new Error("Portal down"));
      // performLocalSearchRaw → direct Brave web search (location IDs step)
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          locations: { results: [{ id: "loc1" }] },
        }),
      });
      // getPoisData
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{
            id: "loc1",
            name: "Brave Pizza",
            address: { streetAddress: "456 Brave St", addressLocality: "NY", addressRegion: "NY", postalCode: "10001" },
            phone: "(555) 333-4444",
            rating: { ratingValue: 4.0, ratingCount: 50 },
            openingHours: ["Mon-Fri 9am-9pm"],
          }],
        }),
      });
      // getDescriptionsData
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          descriptions: { loc1: "Direct Brave result" },
        }),
      });

      const result = await braveApi.performLocalSearch("pizza", 5);
      expect(result).toContain("Brave Pizza");
    });
  });

  describe("performLocalSearchRaw with synalux", () => {
    it("routes through synalux when available", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "success",
          results: [{
            name: "Raw Local",
            address: "789 Raw St",
            phone: "(555) 555-5555",
            rating: "4.0",
            hours: "24/7",
            description: "Raw proxied",
          }],
        }),
      });

      const raw = await braveApi.performLocalSearchRaw("pizza", 3);
      const parsed = JSON.parse(raw);

      expect(parsed.source).toBe("local");
      expect(parsed.poisData.results[0].name).toBe("Raw Local");
    });

    it("falls back to Brave raw on synalux failure", async () => {
      // synaluxLocalSearchRaw → portal fails
      fetchMock.mockRejectedValueOnce(new Error("Portal down"));
      // Direct Brave: web search for location IDs → no locations → web fallback
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ web: { results: [] }, locations: { results: [] } }),
      });
      // performWebSearch inside fallback → synalux portal fails
      fetchMock.mockRejectedValueOnce(new Error("Portal down"));
      // performWebSearch → synaluxWebSearchRaw fails
      fetchMock.mockRejectedValueOnce(new Error("Portal down"));
      // performWebSearch → direct Brave web search
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          web: { results: [{ title: "Brave Fallback", description: "d", url: "u" }] },
        }),
      });

      const raw = await braveApi.performLocalSearchRaw("pizza", 3);
      const parsed = JSON.parse(raw);
      expect(parsed.source).toBe("web_fallback");
    });
  });

  describe("performBraveAnswers with synalux", () => {
    it("routes through synalux when available", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "success",
          answer: "Synalux says: Paris is the capital of France.",
        }),
      });

      const result = await braveApi.performBraveAnswers("capital of France");

      const url = fetchMock.mock.calls[0][0];
      expect(url).toBe("https://portal.test/api/v1/prism/answers");
      expect(result).toBe("Synalux says: Paris is the capital of France.");
    });

    it("falls back to Brave when synalux fails", async () => {
      // synaluxBraveAnswers → portal fails
      fetchMock.mockRejectedValueOnce(new Error("Portal down"));
      // Direct Brave Answers API
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "Direct Brave answer" } }],
        }),
      });

      const result = await braveApi.performBraveAnswers("capital of France");
      expect(result).toBe("Direct Brave answer");
    });
  });

  describe("performWebSearchRaw with synalux", () => {
    it("routes through synalux when available", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "success",
          results: [{ title: "Raw", url: "https://r.example", description: "Raw desc" }],
        }),
      });

      const raw = await braveApi.performWebSearchRaw("test", 5, 0);
      const parsed = JSON.parse(raw);

      // Must be Brave-compatible for code-mode sandbox
      expect(parsed.web.results[0].title).toBe("Raw");
    });

    it("falls back to Brave raw on synalux failure", async () => {
      // synaluxWebSearchRaw → portal fetch fails
      fetchMock.mockRejectedValueOnce(new Error("Portal down"));
      // Direct Brave API succeeds
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          web: { results: [{ title: "Brave Raw", description: "d", url: "u" }] },
        }),
      });

      const raw = await braveApi.performWebSearchRaw("test", 5, 0);
      const parsed = JSON.parse(raw);
      expect(parsed.web.results[0].title).toBe("Brave Raw");
    });
  });
});
