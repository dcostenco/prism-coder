import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;
const fetchMock = vi.fn();

async function loadBraveApi(braveApiKey?: string) {
  vi.resetModules();
  vi.doMock("../src/config.js", () => ({
    BRAVE_API_KEY: braveApiKey,
    BRAVE_ANSWERS_API_KEY: undefined,
  }));
  vi.doMock("../src/utils/logger.js", () => ({
    debugLog: vi.fn(),
  }));
  vi.doMock("../src/utils/synaluxSearch.js", () => ({
    synaluxSearchAvailable: () => false,
    synaluxWebSearch: vi.fn(),
    synaluxWebSearchRaw: vi.fn(),
    synaluxLocalSearch: vi.fn(),
    synaluxLocalSearchRaw: vi.fn(),
    synaluxBraveAnswers: vi.fn(),
  }));
  return import("../src/utils/braveApi.js");
}

describe("standalone Brave credential boundary", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.doUnmock("../src/config.js");
    vi.doUnmock("../src/utils/logger.js");
    vi.doUnmock("../src/utils/synaluxSearch.js");
  });

  it("fails before network I/O when the standalone Brave key is missing", async () => {
    const braveApi = await loadBraveApi();

    await expect(braveApi.performWebSearchRaw("private query", 5, 0))
      .rejects.toThrow("BRAVE_API_KEY is not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses direct Brave only when a standalone key is explicitly configured", async () => {
    const braveApi = await loadBraveApi("standalone-key");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      web: {
        results: [{
          title: "Result",
          description: "Description",
          url: "https://example.com",
        }],
      },
    }), { status: 200 }));

    await braveApi.performWebSearchRaw("public query", 5, 0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("api.search.brave.com");
    expect(init.headers["X-Subscription-Token"]).toBe("standalone-key");
  });
});
