/**
 * OllamaAdapter — Unit Tests
 *
 * Tests the Ollama embedding adapter WITHOUT requiring a live Ollama server.
 * All HTTP calls are mocked via vi.stubGlobal("fetch").
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────
// Must be set up BEFORE importing the adapter (modules are evaluated at import).
// Paths must match what the *source module* uses (relative to ~project root for vi.mock).
vi.mock("../../src/storage/configStorage.js", () => ({
  getSettingSync: vi.fn((key: string, defaultValue?: string) => defaultValue ?? ""),
}));

vi.mock("../../src/utils/logger.js", () => ({
  debugLog: vi.fn(),
}));

import { OllamaAdapter } from "../../src/utils/llm/adapters/ollama.js";
import { getSettingSync } from "../../src/storage/configStorage.js";
import { debugLog } from "../../src/utils/logger.js";

const mockGetSettingSync = vi.mocked(getSettingSync);
const mockDebugLog = vi.mocked(debugLog);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a mock Response with the shape Ollama /api/embed returns. */
function mockOllamaResponse(embeddings: number[][], status = 200): Response {
  const body = JSON.stringify({ model: "nomic-embed-text", embeddings });
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Generate a fake 768-dim embedding vector. */
function fakeVec(seed: number): number[] {
  return Array.from({ length: 768 }, (_, i) => Math.sin(seed + i) * 0.01);
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("OllamaAdapter", () => {
  let adapter: OllamaAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    mockGetSettingSync.mockImplementation((key: string, def?: string) => def ?? "");
    adapter = new OllamaAdapter();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Construction ────────────────────────────────────────────────────────

  it("initializes with default baseUrl and model", () => {
    expect(mockGetSettingSync).toHaveBeenCalledWith("ollama_base_url", "http://localhost:11434");
    expect(mockGetSettingSync).toHaveBeenCalledWith("ollama_model", "nomic-embed-text");
    expect(mockDebugLog).toHaveBeenCalledWith(
      expect.stringContaining("baseUrl=http://localhost:11434")
    );
  });

  it("strips trailing slash from baseUrl", () => {
    mockGetSettingSync.mockImplementation((key: string, def?: string) => {
      if (key === "ollama_base_url") return "http://myhost:11434/";
      return def ?? "";
    });
    const a = new OllamaAdapter();
    // The constructed URL should not have a double-slash
    fetchSpy.mockResolvedValueOnce(mockOllamaResponse([fakeVec(1)]));
    a.generateEmbedding("test").catch(() => {}); // fire the fetch
    // The URL should be http://myhost:11434/api/embed (no double slash)
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://myhost:11434/api/embed",
      expect.anything()
    );
  });

  // ── Text Generation (throws) ────────────────────────────────────────────

  it("generateText() throws — embeddings only adapter", async () => {
    await expect(adapter.generateText("hello")).rejects.toThrow(
      "does not support text generation"
    );
  });

  // ── Single Embedding ────────────────────────────────────────────────────

  it("generateEmbedding() returns a 768-dim vector", async () => {
    const vec = fakeVec(42);
    fetchSpy.mockResolvedValueOnce(mockOllamaResponse([vec]));

    const result = await adapter.generateEmbedding("hello world");
    expect(result).toHaveLength(768);
    expect(result).toEqual(vec);
  });

  it("generateEmbedding() throws on empty text", async () => {
    await expect(adapter.generateEmbedding("")).rejects.toThrow("empty text");
    await expect(adapter.generateEmbedding("   ")).rejects.toThrow("empty text");
  });

  // ── Batch Embeddings ────────────────────────────────────────────────────

  it("generateEmbeddings() returns multiple vectors", async () => {
    const vecs = [fakeVec(1), fakeVec(2), fakeVec(3)];
    fetchSpy.mockResolvedValueOnce(mockOllamaResponse(vecs));

    const results = await adapter.generateEmbeddings(["a", "b", "c"]);
    expect(results).toHaveLength(3);
    expect(results[0]).toHaveLength(768);
    expect(results[2]).toEqual(vecs[2]);
  });

  it("generateEmbeddings() returns [] for empty input", async () => {
    const result = await adapter.generateEmbeddings([]);
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── Truncation ──────────────────────────────────────────────────────────

  it("truncates text at word boundary when exceeding 8000 chars", async () => {
    // Create a string that's 8100 chars: "word " repeated
    const longText = "word ".repeat(1620); // 5 chars × 1620 = 8100
    expect(longText.length).toBe(8100);

    fetchSpy.mockResolvedValueOnce(mockOllamaResponse([fakeVec(1)]));
    await adapter.generateEmbeddings([longText]);

    // The fetch body should contain a truncated input
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.input[0].length).toBeLessThanOrEqual(8000);
    // Should NOT equal the original (truncation happened)
    expect(body.input[0].length).toBeLessThan(longText.length);
  });

  // ── Dimension Validation ────────────────────────────────────────────────

  it("silently truncates embeddings > 768 dims", async () => {
    const bigVec = Array.from({ length: 1024 }, (_, i) => i * 0.001);
    fetchSpy.mockResolvedValueOnce(mockOllamaResponse([bigVec]));

    const result = await adapter.generateEmbedding("test");
    expect(result).toHaveLength(768);
    expect(mockDebugLog).toHaveBeenCalledWith(
      expect.stringContaining("truncating to 768")
    );
  });

  it("throws on embeddings < 768 dims", async () => {
    const smallVec = Array.from({ length: 384 }, () => 0.01);
    fetchSpy.mockResolvedValueOnce(mockOllamaResponse([smallVec]));

    await expect(adapter.generateEmbedding("test")).rejects.toThrow(
      "Dimension mismatch"
    );
  });

  // ── Response Count Validation ────────────────────────────────────────────

  it("throws when response count doesn't match input count", async () => {
    // Send 2 texts but return 1 embedding
    fetchSpy.mockResolvedValueOnce(mockOllamaResponse([fakeVec(1)]));
    await expect(adapter.generateEmbeddings(["a", "b"])).rejects.toThrow(
      "Response length mismatch"
    );
  });

  // ── HTTP Error Handling ─────────────────────────────────────────────────

  it("throws on non-200 HTTP response with actionable message", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("model not found", { status: 404 })
    );

    await expect(adapter.generateEmbedding("test")).rejects.toThrow(
      /status=404.*ollama serve/
    );
  });

  it("throws on empty embeddings response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ model: "nomic-embed-text", embeddings: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(adapter.generateEmbedding("test")).rejects.toThrow(
      "Empty embeddings response"
    );
  });

  // ── Retry Logic ─────────────────────────────────────────────────────────

  it("retries on ECONNREFUSED then succeeds", async () => {
    const vec = fakeVec(99);
    // First call fails with ECONNREFUSED, second succeeds
    fetchSpy
      .mockRejectedValueOnce(new TypeError("fetch failed: ECONNREFUSED"))
      .mockResolvedValueOnce(mockOllamaResponse([vec]));

    const result = await adapter.generateEmbedding("test");
    expect(result).toHaveLength(768);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(mockDebugLog).toHaveBeenCalledWith(
      expect.stringContaining("Connection failed")
    );
  });

  it("throws after exhausting retries on persistent network errors", async () => {
    fetchSpy
      .mockRejectedValueOnce(new TypeError("fetch failed: ECONNREFUSED"))
      .mockRejectedValueOnce(new TypeError("fetch failed: ECONNREFUSED"))
      .mockRejectedValueOnce(new TypeError("fetch failed: ECONNREFUSED"));

    await expect(adapter.generateEmbedding("test")).rejects.toThrow(
      "ECONNREFUSED"
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("does NOT retry non-network errors (e.g. 500 responses)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("internal error", { status: 500 })
    );

    await expect(adapter.generateEmbedding("test")).rejects.toThrow("status=500");
    expect(fetchSpy).toHaveBeenCalledTimes(1); // no retry
  });

  // ── Request Shape ───────────────────────────────────────────────────────

  it("sends correct request body shape to /api/embed", async () => {
    fetchSpy.mockResolvedValueOnce(mockOllamaResponse([fakeVec(1), fakeVec(2)]));
    await adapter.generateEmbeddings(["hello", "world"]);

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:11434/api/embed",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.model).toBe("nomic-embed-text");
    expect(body.input).toEqual(["hello", "world"]);
  });
});
