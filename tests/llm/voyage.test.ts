/**
 * VoyageAdapter Unit Tests
 *
 * Tests the Voyage AI embedding adapter in isolation using mocked fetch.
 * Covers: successful embeddings, dimension guard, empty text, generateText error,
 * API error handling, and model override.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGetSettingSync = vi.fn();

vi.mock("../../src/storage/configStorage.js", () => ({
  getSettingSync: (...args: any[]) => mockGetSettingSync(...args),
}));

vi.mock("../../src/utils/logger.js", () => ({
  debugLog: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn() as Mock;
vi.stubGlobal("fetch", mockFetch);

import { VoyageAdapter } from "../../src/utils/llm/adapters/voyage.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function defaultSettings(key: string, fallback?: string): string {
  if (key === "voyage_api_key") return "pa-test-key-12345";
  if (key === "voyage_model") return "voyage-3";
  return fallback ?? "";
}

function make768Embedding(): number[] {
  return Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.01));
}

function makeVoyageResponse(embedding: number[], model = "voyage-3") {
  return {
    ok: true,
    json: async () => ({
      object: "list",
      data: [{ object: "embedding", embedding, index: 0 }],
      model,
      usage: { total_tokens: 42 },
    }),
    text: async () => "",
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("VoyageAdapter", () => {
  let adapter: VoyageAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockGetSettingSync.mockImplementation(defaultSettings);
    adapter = new VoyageAdapter();
  });

  // ── Construction ──────────────────────────────────────────────────────────

  it("constructs successfully with a valid API key", () => {
    expect(adapter).toBeDefined();
  });

  it("throws if no API key is available", () => {
    mockGetSettingSync.mockImplementation((key: string) => {
      if (key === "voyage_api_key") return "";
      return "";
    });
    expect(() => new VoyageAdapter()).toThrow("Voyage AI API key");
  });

  // ── generateText (not supported) ─────────────────────────────────────────

  it("generateText throws with actionable error message", async () => {
    await expect(adapter.generateText("hello")).rejects.toThrow(
      "does not support text generation"
    );
  });

  // ── generateEmbedding — success ──────────────────────────────────────────

  it("returns 768-dim embedding on success", async () => {
    const expected = make768Embedding();
    mockFetch.mockResolvedValueOnce(makeVoyageResponse(expected));

    const result = await adapter.generateEmbedding("test session context");

    expect(result).toHaveLength(768);
    expect(result).toEqual(expected);

    // Verify fetch was called correctly
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Authorization"]).toBe("Bearer pa-test-key-12345");

    const body = JSON.parse(opts.body);
    expect(body.model).toBe("voyage-3");
    expect(body.output_dimension).toBeUndefined();
    expect(body.input).toEqual(["test session context"]);
  });

  // ── Dimension guard ──────────────────────────────────────────────────────

  it("throws dimension mismatch for 512-dim response (voyage-3-lite)", async () => {
    const wrongDims = Array.from({ length: 512 }, () => 0.1);
    mockFetch.mockResolvedValueOnce(makeVoyageResponse(wrongDims, "voyage-3-lite"));

    await expect(adapter.generateEmbedding("test")).rejects.toThrow(
      "dimension mismatch"
    );
  });

  it("truncates 1024-dim response to 768 (client-side MRL)", async () => {
    const bigDims = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.01));
    mockFetch.mockResolvedValueOnce(makeVoyageResponse(bigDims));

    const result = await adapter.generateEmbedding("test");
    expect(result).toHaveLength(768);
    expect(result).toEqual(bigDims.slice(0, 768));
  });

  // ── Empty/invalid input ──────────────────────────────────────────────────

  it("throws on empty string input", async () => {
    await expect(adapter.generateEmbedding("")).rejects.toThrow("empty text");
  });

  it("throws on whitespace-only input", async () => {
    await expect(adapter.generateEmbedding("   \n  ")).rejects.toThrow("empty text");
  });

  // ── Text truncation ──────────────────────────────────────────────────────

  it("truncates text longer than 8000 chars", async () => {
    const longText = "a".repeat(10000);
    const expected = make768Embedding();
    mockFetch.mockResolvedValueOnce(makeVoyageResponse(expected));

    await adapter.generateEmbedding(longText);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input[0].length).toBeLessThanOrEqual(8000);
  });

  // ── API error handling ───────────────────────────────────────────────────

  it("throws on HTTP 401 (invalid API key)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Invalid API key",
    });

    await expect(adapter.generateEmbedding("test")).rejects.toThrow(
      "status=401"
    );
  });

  it("throws on HTTP 429 (rate limit) after max retries", async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "Rate limit exceeded",
    });

    let caughtError: any = null;
    const promise = adapter.generateEmbedding("test").catch(e => { caughtError = e; });
    
    // Fast-forward through all retries
    await vi.runAllTimersAsync();
    await promise;
    
    expect(caughtError).toBeDefined();
    expect(caughtError.message).toMatch(/status=429/);

    vi.useRealTimers();
  });

  it("throws on malformed response (no embedding array)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await expect(adapter.generateEmbedding("test")).rejects.toThrow(
      "Unexpected response length"
    );
  });

  // ── Model override ──────────────────────────────────────────────────────

  it("uses custom model from settings", async () => {
    mockGetSettingSync.mockImplementation((key: string, fallback?: string) => {
      if (key === "voyage_api_key") return "pa-test-key-12345";
      if (key === "voyage_model") return "voyage-code-3";
      return fallback ?? "";
    });

    const expected = make768Embedding();
    mockFetch.mockResolvedValueOnce(makeVoyageResponse(expected, "voyage-code-3"));

    const customAdapter = new VoyageAdapter();
    await customAdapter.generateEmbedding("function hello() {}");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe("voyage-code-3");
  });
});
