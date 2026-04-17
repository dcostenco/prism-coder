/**
 * LLM Provider Factory (v4.5 — Voyage AI Embedding Support)
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE:
 *   Single point of resolution for the active LLMProvider.
 *   Composes a TEXT adapter and an EMBEDDING adapter independently, returning
 *   a single object that satisfies the LLMProvider interface. Consumers never
 *   know the difference — getLLMProvider() behavior is unchanged.
 *
 * SPLIT PROVIDER ARCHITECTURE:
 *   Two independent settings control text and embedding routing:
 *
 *   text_provider      — "gemini" (default) | "openai" | "anthropic"
 *   embedding_provider — "auto" (default)   | "gemini" | "openai" | "voyage" | "local"
 *
 *   When embedding_provider = "auto":
 *     * If text_provider is gemini or openai → use same provider for embeddings
 *     * If text_provider is anthropic → auto-fallback to gemini for embeddings
 *       (Anthropic has no native embedding API; consider setting
 *        embedding_provider=voyage for the Anthropic-recommended pairing)
 *
 * EXAMPLE CONFIGURATIONS:
 *   text_provider=gemini,    embedding_provider=auto   → Gemini+Gemini (default)
 *   text_provider=openai,    embedding_provider=auto   → OpenAI+OpenAI
 *   text_provider=anthropic, embedding_provider=auto   → Claude+Gemini (auto-bridge)
 *   text_provider=anthropic, embedding_provider=voyage → Claude+Voyage (Anthropic-recommended)
 *   text_provider=anthropic, embedding_provider=openai → Claude+Ollama (cost-optimized)
 *   text_provider=gemini,    embedding_provider=voyage → Gemini+Voyage (mixed)
 *
 * SINGLETON + GRACEFUL DEGRADATION:
 *   Same as before — instance cached per process, errors fall back to Gemini.
 *   Provider switches require an MCP server restart.
 *
 * TESTING:
 *   _resetLLMProvider() clears the singleton for test injection.
 *
 * ADDING NEW PROVIDERS:
 *   1. Implement LLMProvider in src/utils/llm/adapters/<name>.ts
 *   2. Add a case to buildTextAdapter() and/or buildEmbeddingAdapter() below
 *   3. Add the option to the dashboard "AI Providers" tab
 */

import { getSettingSync } from "../../storage/configStorage.js";
import type { LLMProvider } from "./provider.js";
import { GeminiAdapter } from "./adapters/gemini.js";
import { OpenAIAdapter } from "./adapters/openai.js";
import { AnthropicAdapter } from "./adapters/anthropic.js";
import { VoyageAdapter } from "./adapters/voyage.js";
import { LocalEmbeddingAdapter } from "./adapters/local.js";
import { DisabledTextAdapter } from "./adapters/disabledText.js";
import { TracingLLMProvider } from "./adapters/traced.js";

// Module-level singleton — one composed provider per MCP server process.
let providerInstance: LLMProvider | null = null;

// ─── Adapter Builders ─────────────────────────────────────────────────────────
// Separated from getLLMProvider() so they can be called independently for the
// text and embedding halves of the composite provider.

function buildTextAdapter(type: string): LLMProvider {
  switch (type) {
    case "anthropic": return new AnthropicAdapter();
    case "openai":    return new OpenAIAdapter();
    case "none":      return new DisabledTextAdapter();
    case "gemini":
    default:          return new GeminiAdapter();
  }
}

function buildEmbeddingAdapter(type: string): LLMProvider {
  // Note: "anthropic" is intentionally absent from this switch.
  // Anthropic has no embedding API, so it can never be an embedding provider.
  // The factory resolves "auto" away from "anthropic" before calling this.
  // For Anthropic text users, "voyage" is the Anthropic-recommended pairing.
  switch (type) {
    case "openai": return new OpenAIAdapter();
    case "voyage": return new VoyageAdapter();
    case "local":  return new LocalEmbeddingAdapter();
    case "gemini":
    default:       return new GeminiAdapter();
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Returns the singleton LLM provider, initializing it on first call.
 *
 * The returned object composes two independent adapters:
 *   - generateText()      → text adapter (text_provider setting)
 *   - generateEmbedding() → embedding adapter (embedding_provider setting)
 *
 * Consumers see no difference — the interface is identical to before.
 */
export function getLLMProvider(): LLMProvider {
  // Fast path: return cached composite instance
  if (providerInstance) return providerInstance;

  // ── Resolve text provider ─────────────────────────────────────────────
  const textType = getSettingSync("text_provider", "gemini");

  // ── Resolve embedding provider ────────────────────────────────────────
  let embedType = getSettingSync("embedding_provider", "auto");

  if (embedType === "auto") {
    // Anthropic has no embedding API — auto-bridge to Gemini.
    // For all other text providers, use the same provider for embeddings.
    embedType = textType === "anthropic" ? "gemini" : textType;

    if (textType === "anthropic") {
      console.info(
        "[LLMFactory] text_provider=anthropic with embedding_provider=auto: " +
        "routing embeddings to GeminiAdapter (Anthropic has no native embedding API). " +
        "For the Anthropic-recommended pairing, set embedding_provider=voyage in the dashboard " +
        "(voyage-3 supports 768-dim output via MRL). " +
        "Alternatively, set embedding_provider=openai to use Ollama/OpenAI."
      );
    }
  }

  try {
    const textAdapter  = buildTextAdapter(textType);
    const embedAdapter = buildEmbeddingAdapter(embedType);

    // Compose into a single LLMProvider-compatible object.
    // Methods are bound to their respective adapter instances so `this`
    // resolves correctly inside the adapter methods.
    const composed: LLMProvider = {
      generateText:      textAdapter.generateText.bind(textAdapter),
      generateEmbedding: embedAdapter.generateEmbedding.bind(embedAdapter),
    };

    // Pass VLM support through from the text adapter if it exists.
    // generateImageDescription is a text-generation concern (it calls the
    // text/vision model, not the embedding model). The text adapter owns it.
    if (textAdapter.generateImageDescription) {
      composed.generateImageDescription = textAdapter.generateImageDescription.bind(textAdapter);
    }

    // ── v4.6.0: Wrap with OTel tracing decorator ─────────────────────────
    // TracingLLMProvider is a zero-overhead no-op when otel_enabled=false.
    // The text provider name is used as the primary span attribute label.
    providerInstance = new TracingLLMProvider(composed, textType);

    if (textType !== embedType) {
      console.info(
        `[LLMFactory] Split provider: text=${textType}, embedding=${embedType}`
      );
    }
  } catch (err) {
    // Init failure (e.g. missing API key) → fall back to full Gemini provider.
    // A crash here would silently kill the MCP server.
    console.error(
      `[LLMFactory] Failed to initialise providers (text=${textType}, embed=${embedType}): ${err instanceof Error ? err.message : String(err)}. ` +
      `Falling back to GeminiAdapter for both.`
    );
    const fallback = new GeminiAdapter();
    const fallbackComposed: LLMProvider = {
      generateText:      fallback.generateText.bind(fallback),
      generateEmbedding: fallback.generateEmbedding.bind(fallback),
    };
    if (fallback.generateImageDescription) {
      fallbackComposed.generateImageDescription = fallback.generateImageDescription.bind(fallback);
    }
    providerInstance = new TracingLLMProvider(fallbackComposed, "gemini");
  }

  return providerInstance;
}

/**
 * Reset the cached singleton.
 * ONLY for unit tests — never call in production code.
 */
export function _resetLLMProvider(): void {
  providerInstance = null;
}

export function _setLLMProviderForTest(mock: LLMProvider): void {
  providerInstance = mock;
}
