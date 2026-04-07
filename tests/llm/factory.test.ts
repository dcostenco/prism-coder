/**
 * LLM Provider Factory — Split Provider Tests (v4.6 Ollama + Voyage AI)
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
 *
 * v4.6 Ollama Local:
 *   embedding_provider=ollama → uses OllamaAdapter (fully local, zero-cost)
 *   auto + OLLAMA_HOST env    → routes to OllamaAdapter (second priority after Voyage)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _resetLLMProvider, getLLMProvider } from "../../src/utils/llm/factory.js";
import { GeminiAdapter } from "../../src/utils/llm/adapters/gemini.js";
import { OpenAIAdapter } from "../../src/utils/llm/adapters/openai.js";
import { AnthropicAdapter } from "../../src/utils/llm/adapters/anthropic.js";
import { VoyageAdapter } from "../../src/utils/llm/adapters/voyage.js";
import { OllamaAdapter } from "../../src/utils/llm/adapters/ollama.js";

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
    this.generateEmbedding = vi.fn().mockRejectedValue(
      new Error("Anthropic does not support embeddings")
    );
  }),
}));

vi.mock("../../src/utils/llm/adapters/voyage.js", () => ({
  VoyageAdapter: vi.fn(function (this: any) {
    this.generateEmbedding = vi.fn();
    this.generateText = vi.fn().mockRejectedValue(
      new Error("Voyage AI does not support text generation")
    );
  }),
}));

vi.mock("../../src/utils/llm/adapters/ollama.js", () => ({
  OllamaAdapter: vi.fn(function (this: any) {
    this.generateEmbedding = vi.fn();
    this.generateEmbeddings = vi.fn();
    this.generateText = vi.fn().mockRejectedValue(
      new Error("OllamaAdapter does not support text generation")
    );
  }),
}));

import { getSettingSync } from "../../src/storage/configStorage.js";
const mockGetSettingSync = vi.mocked(getSettingSync);
const mockVoyageAdapter = vi.mocked(VoyageAdapter);
const mockOllamaAdapter = vi.mocked(OllamaAdapter);

// Helper: mock both text_provider and embedding_provider together
function mockProviders(text: string, embedding = "auto", extras: Record<string, string> = {}) {
  mockGetSettingSync.mockImplementation((key: string, def?: string) => {
    if (key === "text_provider") return text;
    if (key === "embedding_provider") return embedding;
    return extras[key] ?? def ?? "";
  });
}

// ─── Env var helpers ──────────────────────────────────────────────────────────

function setEnvVars(vars: Record<string, string>) {
  for (const [key, val] of Object.entries(vars)) {
    process.env[key] = val;
  }
}

function clearEnvVars(keys: string[]) {
  for (const key of keys) {
    delete process.env[key];
  }
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("LLM Provider Factory — Split Architecture", () => {
  beforeEach(() => {
    _resetLLMProvider();
    vi.clearAllMocks();
    clearEnvVars(["VOYAGE_API_KEY", "OLLAMA_HOST", "OLLAMA_BASE_URL"]);
  });

  afterEach(() => {
    clearEnvVars(["VOYAGE_API_KEY", "OLLAMA_HOST", "OLLAMA_BASE_URL"]);
  });

  // ── Default behavior ──────────────────────────────────────────────────────

  it("defaults to Gemini+Gemini when no settings are configured", () => {
    mockGetSettingSync.mockImplementation((_k, def) => def ?? "");
    const provider = getLLMProvider();
    expect(GeminiAdapter).toHaveBeenCalledTimes(2);
    expect(OpenAIAdapter).not.toHaveBeenCalled();
    expect(AnthropicAdapter).not.toHaveBeenCalled();
    expect(OllamaAdapter).not.toHaveBeenCalled();
    expect(provider).toBeDefined();
    expect(typeof provider.generateText).toBe("function");
    expect(typeof provider.generateEmbedding).toBe("function");
  });

  // ── Matched providers ─────────────────────────────────────────────────────

  it("Gemini + auto → both methods use GeminiAdapter", () => {
    mockProviders("gemini", "auto");
    getLLMProvider();
    expect(GeminiAdapter).toHaveBeenCalledTimes(2);
    expect(OpenAIAdapter).not.toHaveBeenCalled();
  });

  it("OpenAI + auto → both methods use OpenAIAdapter", () => {
    mockProviders("openai", "auto", { openai_api_key: "sk-test", openai_base_url: "https://api.openai.com/v1" });
    getLLMProvider();
    expect(OpenAIAdapter).toHaveBeenCalledTimes(2);
    expect(GeminiAdapter).not.toHaveBeenCalled();
  });

  // ── Anthropic split (auto-bridge) ─────────────────────────────────────────

  it("Anthropic + auto → AnthropicAdapter for text, GeminiAdapter for embeddings", () => {
    const infoSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockProviders("anthropic", "auto", { anthropic_api_key: "sk-ant-test" });
    getLLMProvider();
    expect(AnthropicAdapter).toHaveBeenCalledOnce();
    expect(GeminiAdapter).toHaveBeenCalledOnce();
    expect(OpenAIAdapter).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("routing embeddings to GeminiAdapter"));
    infoSpy.mockRestore();
  });

  // ── Explicit split provider ───────────────────────────────────────────────

  it("Anthropic text + OpenAI embeddings → AnthropicAdapter + OpenAIAdapter", () => {
    const infoSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockProviders("anthropic", "openai", {
      anthropic_api_key: "sk-ant-test",
      openai_base_url: "http://localhost:11434/v1",
    });
    getLLMProvider();
    expect(AnthropicAdapter).toHaveBeenCalledOnce();
    expect(OpenAIAdapter).toHaveBeenCalledOnce();
    expect(GeminiAdapter).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("Split provider: text=anthropic, embedding=openai"));
    infoSpy.mockRestore();
  });

  it("Gemini text + explicit OpenAI embeddings → split adapter", () => {
    const infoSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockProviders("gemini", "openai", { openai_base_url: "http://localhost:11434/v1" });
    getLLMProvider();
    expect(GeminiAdapter).toHaveBeenCalledOnce();
    expect(OpenAIAdapter).toHaveBeenCalledOnce();
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
    expect(AnthropicAdapter).toHaveBeenCalledOnce();
    expect(mockVoyageAdapter).toHaveBeenCalledOnce();
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
    expect(GeminiAdapter).toHaveBeenCalledOnce();
    expect(mockVoyageAdapter).toHaveBeenCalledOnce();
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

  // ── Ollama embedding provider (v4.6) ─────────────────────────────────────

  it("Explicit embedding_provider=ollama → creates OllamaAdapter", () => {
    const infoSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockProviders("gemini", "ollama");
    getLLMProvider();
    expect(GeminiAdapter).toHaveBeenCalledOnce();
    expect(mockOllamaAdapter).toHaveBeenCalledOnce();
    expect(mockVoyageAdapter).not.toHaveBeenCalled();
    expect(OpenAIAdapter).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("Split provider: text=gemini, embedding=ollama")
    );
    infoSpy.mockRestore();
  });

  it("Anthropic text + Ollama embeddings → split adapter", () => {
    const infoSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockProviders("anthropic", "ollama", { anthropic_api_key: "sk-ant-test" });
    getLLMProvider();
    expect(AnthropicAdapter).toHaveBeenCalledOnce();
    expect(mockOllamaAdapter).toHaveBeenCalledOnce();
    expect(GeminiAdapter).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("Split provider: text=anthropic, embedding=ollama")
    );
    infoSpy.mockRestore();
  });

  // ── Auto-routing with OLLAMA_HOST env var ────────────────────────────────

  it("auto + OLLAMA_HOST env → routes to OllamaAdapter", () => {
    const infoSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setEnvVars({ OLLAMA_HOST: "http://localhost:11434" });
    mockProviders("gemini", "auto");
    getLLMProvider();
    expect(GeminiAdapter).toHaveBeenCalledOnce();
    expect(mockOllamaAdapter).toHaveBeenCalledOnce();
    expect(mockVoyageAdapter).not.toHaveBeenCalled();
    infoSpy.mockRestore();
  });

  it("auto + OLLAMA_BASE_URL env → routes to OllamaAdapter", () => {
    const infoSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setEnvVars({ OLLAMA_BASE_URL: "http://192.168.1.100:11434" });
    mockProviders("anthropic", "auto", { anthropic_api_key: "sk-ant-test" });
    getLLMProvider();
    expect(AnthropicAdapter).toHaveBeenCalledOnce();
    expect(mockOllamaAdapter).toHaveBeenCalledOnce();
    expect(GeminiAdapter).not.toHaveBeenCalled();
    infoSpy.mockRestore();
  });

  // ── Voyage takes priority over Ollama in auto mode ───────────────────────

  it("auto + VOYAGE_API_KEY + OLLAMA_HOST → Voyage wins", () => {
    const infoSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setEnvVars({
      VOYAGE_API_KEY: "pa-test-key",
      OLLAMA_HOST: "http://localhost:11434",
    });
    mockProviders("gemini", "auto");
    getLLMProvider();
    expect(mockVoyageAdapter).toHaveBeenCalledOnce();
    expect(mockOllamaAdapter).not.toHaveBeenCalled();
    infoSpy.mockRestore();
  });

  // ── Anthropic auto-bridge mentions Ollama as alternative ─────────────────

  it("Anthropic + auto bridge message mentions ollama as zero-cost option", () => {
    const infoSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockProviders("anthropic", "auto", { anthropic_api_key: "sk-ant-test" });
    getLLMProvider();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("embedding_provider=ollama")
    );
    infoSpy.mockRestore();
  });

  // ── Singleton ─────────────────────────────────────────────────────────────

  it("returns the same singleton on repeated calls", () => {
    mockProviders("gemini");
    const a = getLLMProvider();
    const b = getLLMProvider();
    expect(a).toBe(b);
    expect(GeminiAdapter).toHaveBeenCalledTimes(2);
  });

  // ── Graceful fallback ─────────────────────────────────────────────────────

  it("falls back to Gemini+Gemini when text adapter throws on init", () => {
    mockProviders("openai", "auto", { openai_api_key: "" });
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

  it("falls back to Gemini when OllamaAdapter throws on init", () => {
    mockProviders("gemini", "ollama");
    vi.mocked(OllamaAdapter).mockImplementationOnce(() => {
      throw new Error("ECONNREFUSED — Ollama not running");
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = getLLMProvider();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Falling back to GeminiAdapter"));
    expect(provider).toBeDefined();
    consoleSpy.mockRestore();
  });

  // ── Reset ─────────────────────────────────────────────────────────────────

  it("_resetLLMProvider() forces re-initialisation on next call", () => {
    mockProviders("gemini");
    getLLMProvider();
    _resetLLMProvider();
    getLLMProvider();
    expect(GeminiAdapter).toHaveBeenCalledTimes(4);
  });
});
