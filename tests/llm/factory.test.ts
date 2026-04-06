/**
 * LLM Provider Factory — Split Provider Tests (v4.5 Voyage AI)
 *
 * Validates the factory's text_provider + embedding_provider composition logic
 * without making real API calls. Uses _resetLLMProvider() between tests.
 *
 * v4.4 Split Architecture:
 *   text_provider      → governs generateText()
 *   embedding_provider → governs generateEmbedding() ("auto" follows text_provider,
 *                        except anthropic→auto routes embeddings to Gemini)
 *
 * v4.5 Voyage AI:
 *   embedding_provider=voyage → uses VoyageAdapter (Anthropic-recommended pairing)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { _resetLLMProvider, getLLMProvider } from "../../src/utils/llm/factory.js";
import { GeminiAdapter } from "../../src/utils/llm/adapters/gemini.js";
import { OpenAIAdapter } from "../../src/utils/llm/adapters/openai.js";
import { AnthropicAdapter } from "../../src/utils/llm/adapters/anthropic.js";
import { VoyageAdapter } from "../../src/utils/llm/adapters/voyage.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────
// We mock getSettingSync so tests don't need a real SQLite DB.
vi.mock("../../src/storage/configStorage.js", () => ({
  getSettingSync: vi.fn((key: string, defaultValue?: string) => defaultValue ?? ""),
}));

// Vitest requires constructor-style mocks (not arrow fns) for `new Class()`.
vi.mock("../../src/utils/llm/adapters/gemini.js", () => ({
  GeminiAdapter: vi.fn(function (this: any) {
    this.generateText = vi.fn();
    this.generateEmbedding = vi.fn();
  }),
}));

vi.mock("../../src/utils/llm/adapters/openai.js", () => ({
  OpenAIAdapter: vi.fn(function (this: any) {
    this.generateText = vi.fn();
    this.generateEmbedding = vi.fn();
  }),
}));

vi.mock("../../src/utils/llm/adapters/anthropic.js", () => ({
  AnthropicAdapter: vi.fn(function (this: any) {
    this.generateText = vi.fn();
    // generateEmbedding intentionally throws in the real adapter;
    // the mock just omits it to test the routing, not the error behavior.
    this.generateEmbedding = vi.fn().mockRejectedValue(
      new Error("Anthropic does not support embeddings")
    );
  }),
}));

vi.mock("../../src/utils/llm/adapters/voyage.js", () => ({
  VoyageAdapter: vi.fn(function (this: any) {
    this.generateEmbedding = vi.fn();
    // generateText intentionally throws in the real adapter;
    // the mock omits it to test routing logic, not the error behavior.
    this.generateText = vi.fn().mockRejectedValue(
      new Error("Voyage AI does not support text generation")
    );
  }),
}));

import { getSettingSync } from "../../src/storage/configStorage.js";
const mockGetSettingSync = vi.mocked(getSettingSync);
const mockVoyageAdapter = vi.mocked(VoyageAdapter);

// Helper: mock both text_provider and embedding_provider together
function mockProviders(text: string, embedding = "auto", extras: Record<string, string> = {}) {
  mockGetSettingSync.mockImplementation((key: string, def?: string) => {
    if (key === "text_provider") return text;
    if (key === "embedding_provider") return embedding;
    return extras[key] ?? def ?? "";
  });
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("LLM Provider Factory — Split Architecture", () => {
  beforeEach(() => {
    _resetLLMProvider();
    vi.clearAllMocks();
  });

  // ── Default behavior ──────────────────────────────────────────────────────

  it("defaults to Gemini+Gemini when no settings are configured", () => {
    // Both settings return their defaults ("gemini" and "auto")
    mockGetSettingSync.mockImplementation((_k, def) => def ?? "");
    const provider = getLLMProvider();
    // Factory creates two GeminiAdapter instances: one for text, one for embeddings
    expect(GeminiAdapter).toHaveBeenCalledTimes(2);
    expect(OpenAIAdapter).not.toHaveBeenCalled();
    expect(AnthropicAdapter).not.toHaveBeenCalled();
    expect(provider).toBeDefined();
    expect(typeof provider.generateText).toBe("function");
    expect(typeof provider.generateEmbedding).toBe("function");
  });

  // ── Matched providers ─────────────────────────────────────────────────────

  it("Gemini + auto → both methods use GeminiAdapter", () => {
    mockProviders("gemini", "auto");
    getLLMProvider();
    // Two GeminiAdapter instances: one for text, one for embeddings
    expect(GeminiAdapter).toHaveBeenCalledTimes(2);
    expect(OpenAIAdapter).not.toHaveBeenCalled();
  });

  it("OpenAI + auto → both methods use OpenAIAdapter", () => {
    mockProviders("openai", "auto", { openai_api_key: "sk-test", openai_base_url: "https://api.openai.com/v1" });
    getLLMProvider();
    // Two OpenAIAdapter instances: one for text, one for embeddings
    expect(OpenAIAdapter).toHaveBeenCalledTimes(2);
    expect(GeminiAdapter).not.toHaveBeenCalled();
  });

  // ── Anthropic split (auto-bridge) ─────────────────────────────────────────

  it("Anthropic + auto → AnthropicAdapter for text, GeminiAdapter for embeddings", () => {
    const infoSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockProviders("anthropic", "auto", { anthropic_api_key: "sk-ant-test" });
    getLLMProvider();
    expect(AnthropicAdapter).toHaveBeenCalledOnce(); // text
    expect(GeminiAdapter).toHaveBeenCalledOnce();    // embedding fallback
    expect(OpenAIAdapter).not.toHaveBeenCalled();
    // Should log the auto-bridge info message
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("routing embeddings to GeminiAdapter"));
    infoSpy.mockRestore();
  });

  // ── Explicit split provider ───────────────────────────────────────────────

  it("Anthropic text + OpenAI embeddings → AnthropicAdapter + OpenAIAdapter", () => {
    const infoSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockProviders("anthropic", "openai", {
      anthropic_api_key: "sk-ant-test",
      openai_base_url: "http://localhost:11434/v1", // Ollama
    });
    getLLMProvider();
    expect(AnthropicAdapter).toHaveBeenCalledOnce(); // text
    expect(OpenAIAdapter).toHaveBeenCalledOnce();    // embedding
    expect(GeminiAdapter).not.toHaveBeenCalled();
    // Should log the split info message
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("Split provider: text=anthropic, embedding=openai"));
    infoSpy.mockRestore();
  });

  it("Gemini text + explicit OpenAI embeddings → split adapter", () => {
    const infoSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockProviders("gemini", "openai", { openai_base_url: "http://localhost:11434/v1" });
    getLLMProvider();
    expect(GeminiAdapter).toHaveBeenCalledOnce();  // text
    expect(OpenAIAdapter).toHaveBeenCalledOnce();  // embedding
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("Split provider: text=gemini, embedding=openai"));
    infoSpy.mockRestore();
  });

  // ── Voyage AI embedding provider ─────────────────────────────────────────

  it("Anthropic text + Voyage embeddings → AnthropicAdapter + VoyageAdapter", () => {
    const infoSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockProviders("anthropic", "voyage", {
      anthropic_api_key: "sk-ant-test",
      voyage_api_key: "pa-test",
    });
    getLLMProvider();
    expect(AnthropicAdapter).toHaveBeenCalledOnce(); // text
    expect(mockVoyageAdapter).toHaveBeenCalledOnce(); // embedding
    expect(GeminiAdapter).not.toHaveBeenCalled();
    expect(OpenAIAdapter).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("Split provider: text=anthropic, embedding=voyage")
    );
    infoSpy.mockRestore();
  });

  it("Gemini text + Voyage embeddings → GeminiAdapter + VoyageAdapter", () => {
    const infoSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockProviders("gemini", "voyage", { voyage_api_key: "pa-test" });
    getLLMProvider();
    expect(GeminiAdapter).toHaveBeenCalledOnce();     // text
    expect(mockVoyageAdapter).toHaveBeenCalledOnce(); // embedding
    expect(OpenAIAdapter).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("Split provider: text=gemini, embedding=voyage")
    );
    infoSpy.mockRestore();
  });

  it("Anthropic + auto auto-bridge message mentions Voyage as recommended option", () => {
    const infoSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockProviders("anthropic", "auto", { anthropic_api_key: "sk-ant-test" });
    getLLMProvider();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("embedding_provider=voyage")
    );
    infoSpy.mockRestore();
  });

  // ── Singleton ─────────────────────────────────────────────────────────────

  it("returns the same singleton on repeated calls", () => {
    mockProviders("gemini");
    const a = getLLMProvider();
    const b = getLLMProvider();
    expect(a).toBe(b);
    expect(GeminiAdapter).toHaveBeenCalledTimes(2); // two inits (text + embed), but only once total across both getLLMProvider() calls
  });

  // ── Graceful fallback ─────────────────────────────────────────────────────

  it("falls back to Gemini+Gemini when text adapter throws on init", () => {
    mockProviders("openai", "auto", { openai_api_key: "" }); // missing key
    vi.mocked(OpenAIAdapter).mockImplementationOnce(() => {
      throw new Error("Missing API key");
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = getLLMProvider();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Falling back to GeminiAdapter for both"));
    expect(GeminiAdapter).toHaveBeenCalledOnce();
    expect(provider).toBeDefined();
    consoleSpy.mockRestore();
  });

  // ── Reset ─────────────────────────────────────────────────────────────────

  it("_resetLLMProvider() forces re-initialisation on next call", () => {
    mockProviders("gemini");
    getLLMProvider();
    _resetLLMProvider();
    getLLMProvider();
    // Each call creates 2 GeminiAdapters (text + embed) ⇒ 4 total across two inits
    expect(GeminiAdapter).toHaveBeenCalledTimes(4);
  });
});
