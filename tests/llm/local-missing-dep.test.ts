/**
 * LocalEmbeddingAdapter — broken/missing transformers.js
 *
 * Tests behaviour when @huggingface/transformers fails to load or is unavailable.
 *
 * Note: vitest wraps vi.mock factory errors with its own message, so we cannot
 * reliably simulate ERR_MODULE_NOT_FOUND by throwing from the factory. Instead
 * we mock the module to have a pipeline that throws on construction — which
 * exercises the same loadError → generateEmbedding-throws path that a missing
 * module would produce, just via a slightly different error code.
 *
 * Real-world ERR_MODULE_NOT_FOUND (user hasn't run `npm install
 * @huggingface/transformers`) is covered by the friendly error message in
 * local.ts which is verified in local.test.ts under "Pipeline failure".
 */

import { describe, it, expect, vi } from "vitest";

// ─── Mock: configStorage ─────────────────────────────────────────────────────
vi.mock("../../src/storage/configStorage.js", () => ({
  getSettingSync: vi.fn((_key: string, defaultValue?: string) => defaultValue ?? ""),
}));

// ─── Mock: logger ─────────────────────────────────────────────────────────────
vi.mock("../../src/utils/logger.js", () => ({
  debugLog: vi.fn(),
}));

// ─── Mock: transformers module with broken pipeline ───────────────────────────
// Simulates a corrupted or incompatible install. The import succeeds but
// pipeline() throws — exercising the same loadError path as a missing dep.
vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(() => {
    throw Object.assign(
      new Error("Cannot find module '@huggingface/transformers'"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
  }),
}));

describe("LocalEmbeddingAdapter — broken/corrupted transformers.js install", () => {
  it("loadPromise resolves (non-fatal) even when pipeline construction fails", async () => {
    const { LocalEmbeddingAdapter } = await import("../../src/utils/llm/adapters/local.js");
    const adapter = new LocalEmbeddingAdapter();
    // Must resolve, not reject — a crashed pipeline should not crash the server
    await expect(adapter.loadPromise).resolves.toBeUndefined();
  });

  it("generateEmbedding throws with the pipeline's error message", async () => {
    const { LocalEmbeddingAdapter } = await import("../../src/utils/llm/adapters/local.js");
    const adapter = new LocalEmbeddingAdapter();
    await adapter.loadPromise;
    await expect(adapter.generateEmbedding("test")).rejects.toThrow(
      /Cannot find module/,
    );
  });
});
