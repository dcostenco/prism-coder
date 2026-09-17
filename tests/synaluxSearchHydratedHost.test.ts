/**
 * Regression: the host that has NO Synalux credentials in its MCP env block at
 * all, and receives both of them from Prism's settings store during startup.
 *
 * This is the second half of the 2026-09-16 field defect. Making availability a
 * live read is not enough on its own: the portal request builder used to take
 * its base URL from the same module-load constant, behind a non-null assertion.
 * On this host that constant is undefined, so the first search on a correctly
 * hydrated enterprise account would have thrown a TypeError instead of
 * searching. Availability and addressability have to resolve together.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/config.js", () => ({
  // Nothing was captured at import time. Everything arrives later.
  PRISM_SYNALUX_BASE_URL: undefined,
  PRISM_SYNALUX_API_KEY: undefined,
  SYNALUX_CONFIGURED: false,
  BRAVE_API_KEY: undefined,
  BRAVE_ANSWERS_API_KEY: undefined,
  PRISM_DEBUG_LOGGING: false,
}));

vi.mock("../src/utils/logger.js", () => ({
  sanitizeForLog: vi.fn((s: string) => s),
  debugLog: vi.fn(),
}));

vi.mock("../src/utils/synaluxJwt.js", () => ({
  getSynaluxJwt: async () => "jwt-valid-token",
  invalidateSynaluxJwt: vi.fn(),
}));

const ENV_KEYS = ["PRISM_SYNALUX_BASE_URL", "SYNALUX_BASE_URL", "PRISM_SYNALUX_API_KEY"] as const;
const fetchMock = vi.fn();
const origFetch = globalThis.fetch;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  globalThis.fetch = origFetch;
});

describe("a host whose credentials arrive only from the settings store", () => {
  let synaluxSearch: typeof import("../src/utils/synaluxSearch.js");

  beforeEach(async () => {
    synaluxSearch = await import("../src/utils/synaluxSearch.js");
  });

  it("is unavailable before hydration and available after it", async () => {
    expect(synaluxSearch.synaluxSearchAvailable()).toBe(false);

    const ready = await synaluxSearch.hydrateSynaluxCredentials(async (name) =>
      name === "PRISM_SYNALUX_BASE_URL" ? "https://stored.portal.example"
        : name === "PRISM_SYNALUX_API_KEY" ? "test_subscription_from_settings"
          : "");

    expect(ready).toBe(true);
    expect(synaluxSearch.synaluxSearchAvailable()).toBe(true);
  });

  it("sends the search to the hydrated portal rather than throwing on a missing constant", async () => {
    await synaluxSearch.hydrateSynaluxCredentials(async (name) =>
      name === "PRISM_SYNALUX_BASE_URL" ? "https://stored.portal.example"
        : name === "PRISM_SYNALUX_API_KEY" ? "test_subscription_from_settings"
          : "");

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: "success", results: [], source: "firecrawl" }),
    });

    await expect(synaluxSearch.synaluxWebSearchRaw("q", 5)).resolves.toBeTypeOf("string");
    expect(fetchMock.mock.calls[0][0]).toBe("https://stored.portal.example/api/v1/prism/search");
  });

  it("reports a missing portal URL as an error, never as a TypeError on undefined", async () => {
    // Belt and braces: if some caller reaches the request builder without any
    // resolvable base URL, the failure has to name the cause.
    await expect(synaluxSearch.synaluxWebSearchRaw("q", 5)).rejects.toThrow(
      /no Synalux portal base URL is configured/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
