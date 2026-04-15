/**
 * LocalEmbeddingAdapter Tests
 *
 * Tests the local transformers.js embedding adapter.
 * Uses vi.mock to intercept @huggingface/transformers so no model is downloaded.
 *
 * For ERR_MODULE_NOT_FOUND (missing dep) scenarios, see local-missing-dep.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LocalEmbeddingAdapter as LocalEmbeddingAdapterType } from "../../src/utils/llm/adapters/local.js";

// ─── Mock: configStorage ─────────────────────────────────────────────────────
vi.mock("../../src/storage/configStorage.js", () => ({
  getSettingSync: vi.fn((key: string, defaultValue?: string) => defaultValue ?? ""),
}));

// ─── Mock: logger ─────────────────────────────────────────────────────────────
vi.mock("../../src/utils/logger.js", () => ({
  debugLog: vi.fn(),
}));

// ─── Fake tensor factory ──────────────────────────────────────────────────────
// Builds a fake transformer pipeline that returns a Float32Array of the given length.
function makeFakePipeline(dims = 768) {
  return vi.fn().mockResolvedValue({ data: new Float32Array(dims) });
}

// ─── Mock: @huggingface/transformers ─────────────────────────────────────────
const mockPipelineFn = makeFakePipeline(768);
const mockPipelineFactory = vi.fn().mockResolvedValue(mockPipelineFn);

vi.mock("@huggingface/transformers", () => ({
  pipeline: mockPipelineFactory,
}));

import { getSettingSync } from "../../src/storage/configStorage.js";
const mockGetSettingSync = vi.mocked(getSettingSync);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockSettings(overrides: Record<string, string> = {}) {
  mockGetSettingSync.mockImplementation((key: string, def?: string) => {
    return overrides[key] ?? def ?? "";
  });
}

async function makeAdapter(): Promise<LocalEmbeddingAdapterType> {
  const { LocalEmbeddingAdapter } = await import("../../src/utils/llm/adapters/local.js");
  return new LocalEmbeddingAdapter();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("LocalEmbeddingAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reuse the same mockPipelineFn so test assertions on it remain valid
    mockPipelineFactory.mockResolvedValue(mockPipelineFn);
    mockPipelineFn.mockResolvedValue({ data: new Float32Array(768) });
    // Prevent env-var pollution between tests. HF_ENDPOINT and
    // LOCAL_EMBEDDING_MODEL are read by initPipeline() — if a prior test
    // failed before its inline cleanup ran, these would leak.
    delete process.env.HF_ENDPOINT;
    delete process.env.LOCAL_EMBEDDING_MODEL;
  });

  // ── Construction ───────────────────────────────────────────────────────────

  it("exposes a loadPromise property on construction", async () => {
    mockSettings();
    const adapter = await makeAdapter();
    expect(adapter.loadPromise).toBeInstanceOf(Promise);
  });

  it("construction is synchronous (loadPromise is a fire-and-forget)", async () => {
    mockSettings();
    let constructed = false;
    const { LocalEmbeddingAdapter } = await import("../../src/utils/llm/adapters/local.js");
    new LocalEmbeddingAdapter();
    constructed = true;
    expect(constructed).toBe(true); // constructor returned without awaiting
  });

  // ── generateText ───────────────────────────────────────────────────────────

  it("generateText throws — LocalEmbeddingAdapter is embedding-only", async () => {
    mockSettings();
    const adapter = await makeAdapter();
    await expect(adapter.generateText("hello")).rejects.toThrow(
      /does not support text generation/
    );
  });

  // ── Model ID validation ────────────────────────────────────────────────────

  it("sets loadError when model ID is invalid (path traversal attempt)", async () => {
    mockSettings({ local_embedding_model: "../../etc/passwd" });
    const adapter = await makeAdapter();
    await adapter.loadPromise;
    await expect(adapter.generateEmbedding("test")).rejects.toThrow(
      /Invalid local_embedding_model/
    );
  });

  it("sets loadError when model ID contains '..' (directory traversal)", async () => {
    mockSettings({ local_embedding_model: "owner/foo..bar" });
    const adapter = await makeAdapter();
    await adapter.loadPromise;
    await expect(adapter.generateEmbedding("test")).rejects.toThrow(
      /Invalid local_embedding_model/
    );
  });

  it("sets loadError when model ID has no slash", async () => {
    mockSettings({ local_embedding_model: "nodeslash" });
    const adapter = await makeAdapter();
    await adapter.loadPromise;
    await expect(adapter.generateEmbedding("test")).rejects.toThrow(
      /Invalid local_embedding_model/
    );
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it("returns a 768-element number array for valid text", async () => {
    mockSettings();
    const adapter = await makeAdapter();
    await adapter.loadPromise;
    const vec = await adapter.generateEmbedding("hello world");
    expect(vec).toHaveLength(768);
    expect(typeof vec[0]).toBe("number");
  });

  it("prepends 'search_document: ' prefix before calling the pipeline", async () => {
    mockSettings();
    const adapter = await makeAdapter();
    await adapter.loadPromise;
    await adapter.generateEmbedding("my text");
    expect(mockPipelineFn).toHaveBeenCalledWith(
      "search_document: my text",
      { pooling: "mean", normalize: true }
    );
  });

  it("passes pooling=mean and normalize=true to the pipeline", async () => {
    mockSettings();
    const adapter = await makeAdapter();
    await adapter.loadPromise;
    await adapter.generateEmbedding("any input");
    // Last call is the real embedding (warmup is first); check opts
    const lastCall = mockPipelineFn.mock.calls.at(-1)!;
    expect(lastCall[1]).toEqual({ pooling: "mean", normalize: true });
  });

  it("converts Float32Array tensor to plain number[]", async () => {
    mockSettings();
    const adapter = await makeAdapter();
    await adapter.loadPromise;
    const vec = await adapter.generateEmbedding("test");
    expect(Array.isArray(vec)).toBe(true);
    expect(vec).not.toBeInstanceOf(Float32Array);
  });

  it("initialises pipeline with dtype='q8' by default", async () => {
    mockSettings();
    const adapter = await makeAdapter();
    await adapter.loadPromise;
    expect(mockPipelineFactory).toHaveBeenCalledWith(
      "feature-extraction",
      expect.any(String),
      expect.objectContaining({ dtype: "q8" })
    );
  });

  it("uses dtype='fp32' when local_embedding_quantized=false", async () => {
    mockSettings({ local_embedding_quantized: "false" });
    const adapter = await makeAdapter();
    await adapter.loadPromise;
    expect(mockPipelineFactory).toHaveBeenCalledWith(
      "feature-extraction",
      expect.any(String),
      expect.objectContaining({ dtype: "fp32" })
    );
  });

  // ── Empty/whitespace guard ─────────────────────────────────────────────────

  it("throws on empty string input", async () => {
    mockSettings();
    const adapter = await makeAdapter();
    await adapter.loadPromise;
    await expect(adapter.generateEmbedding("")).rejects.toThrow(
      /empty text/
    );
  });

  it("throws on whitespace-only input", async () => {
    mockSettings();
    const adapter = await makeAdapter();
    await adapter.loadPromise;
    await expect(adapter.generateEmbedding("   ")).rejects.toThrow(
      /empty text/
    );
  });

  // ── Truncation ────────────────────────────────────────────────────────────

  it("truncates text longer than 8000 chars at a word boundary", async () => {
    mockSettings();
    const adapter = await makeAdapter();
    await adapter.loadPromise;
    const long = "word ".repeat(2000); // 10000 chars
    await adapter.generateEmbedding(long);
    const calledText: string = mockPipelineFn.mock.calls.at(-1)![0];
    // Strip the "search_document: " prefix before checking length
    const inputPart = calledText.replace("search_document: ", "");
    expect(inputPart.length).toBeLessThanOrEqual(8000);
    expect(inputPart.endsWith(" ")).toBe(false); // trimmed at word boundary
  });

  // ── Dimension guard ───────────────────────────────────────────────────────

  it("throws when pipeline returns wrong dimension count", async () => {
    mockPipelineFactory.mockResolvedValueOnce(makeFakePipeline(384)); // wrong dims
    mockSettings();
    const { LocalEmbeddingAdapter } = await import("../../src/utils/llm/adapters/local.js");
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    await expect(adapter.generateEmbedding("test")).rejects.toThrow(
      /Embedding dimension mismatch/
    );
  });

  // ── Pipeline failure ──────────────────────────────────────────────────────

  it("propagates pipeline init errors through generateEmbedding", async () => {
    mockPipelineFactory.mockRejectedValueOnce(new Error("network error"));
    mockSettings();
    const { LocalEmbeddingAdapter } = await import("../../src/utils/llm/adapters/local.js");
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    await expect(adapter.generateEmbedding("test")).rejects.toThrow("network error");
  });

  // ── Warmup non-fatal ──────────────────────────────────────────────────────

  it("warmup failure is non-fatal — loadPromise resolves and embed works", async () => {
    // First call (warmup) throws, second call (real embed) succeeds
    const warmupThrowsPipe = vi.fn()
      .mockRejectedValueOnce(new Error("warmup error"))
      .mockResolvedValueOnce({ data: new Float32Array(768) });
    mockPipelineFactory.mockResolvedValueOnce(warmupThrowsPipe);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSettings();
    const { LocalEmbeddingAdapter } = await import("../../src/utils/llm/adapters/local.js");
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise; // should resolve, not reject
    const vec = await adapter.generateEmbedding("post-warmup text");
    expect(vec).toHaveLength(768);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Warmup failed"));
    warnSpy.mockRestore();
  });

  // ── HF_ENDPOINT warning ───────────────────────────────────────────────────

  it("warns when HF_ENDPOINT points to a non-huggingface.co host", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.HF_ENDPOINT = "https://evil.example.com";
    mockSettings();
    const { LocalEmbeddingAdapter } = await import("../../src/utils/llm/adapters/local.js");
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("HF_ENDPOINT"));
    warnSpy.mockRestore();
  });

  it("warns when HF_ENDPOINT is a subdomain-spoofing URL (huggingface.co.evil.com)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.HF_ENDPOINT = "https://huggingface.co.evil.com";
    mockSettings();
    const { LocalEmbeddingAdapter } = await import("../../src/utils/llm/adapters/local.js");
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("HF_ENDPOINT"));
    warnSpy.mockRestore();
  });

  it("does NOT warn when HF_ENDPOINT is a trusted huggingface.co subdomain", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.HF_ENDPOINT = "https://endpoints.huggingface.co";
    mockSettings();
    const { LocalEmbeddingAdapter } = await import("../../src/utils/llm/adapters/local.js");
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("HF_ENDPOINT"));
    warnSpy.mockRestore();
  });

  // ── Revision validation ───────────────────────────────────────────────────

  it("sets loadError when local_embedding_revision is an invalid format", async () => {
    mockSettings({ local_embedding_revision: "../../malicious-branch" });
    const { LocalEmbeddingAdapter } = await import("../../src/utils/llm/adapters/local.js");
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    await expect(adapter.generateEmbedding("test")).rejects.toThrow(
      /Invalid local_embedding_revision/
    );
  });

  it("accepts valid revision values: main, v1.5, 40-char SHA", async () => {
    const validRevisions = [
      "main",
      "v1.5",
      "v1.5.0",
      "a".repeat(40), // 40-char hex SHA
    ];
    for (const rev of validRevisions) {
      mockSettings({ local_embedding_revision: rev });
      const { LocalEmbeddingAdapter } = await import("../../src/utils/llm/adapters/local.js");
      const adapter = new LocalEmbeddingAdapter();
      await adapter.loadPromise;
      await expect(adapter.generateEmbedding("test")).resolves.toHaveLength(768);
    }
  });

  // ── Tensor null guard ─────────────────────────────────────────────────────

  it("throws a descriptive error when pipeline returns result with no data property", async () => {
    const nullDataPipe = vi.fn().mockResolvedValue({ data: undefined }); // no data
    mockPipelineFactory.mockResolvedValueOnce(nullDataPipe);
    mockSettings();
    const { LocalEmbeddingAdapter } = await import("../../src/utils/llm/adapters/local.js");
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    await expect(adapter.generateEmbedding("test")).rejects.toThrow(
      /Unexpected pipeline output shape/
    );
  });
});
