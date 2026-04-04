/**
 * Anthropic Adapter (v4.5)
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE:
 *   Implements LLMProvider using Anthropic's official @anthropic-ai/sdk.
 *   Covers Claude 3.5 Sonnet, Claude 3 Haiku, Claude 3 Opus, etc.
 *
 * EMBEDDING LIMITATION:
 *   Anthropic does NOT offer a native text embedding API.
 *   Their official recommendation is Voyage AI (voyage-3, voyage-3-lite).
 *   `generateEmbedding()` throws an explicit, actionable error rather than
 *   silently returning garbage — the factory's auto-resolution logic means
 *   this should never be called in practice (see factory.ts).
 *
 * VLM CAPABILITY:
 *   Claude 3.5 Sonnet, Opus, and Haiku all support vision natively via the
 *   Messages API `image` content block. This adapter implements
 *   `generateImageDescription` (5MB base64 payload limit enforced in
 *   imageCaptioner.ts before the API call reaches this adapter).
 *
 * FACTORY RESOLUTION:
 *   When `text_provider = "anthropic"` and `embedding_provider = "auto"`,
 *   the factory automatically routes embeddings to the Gemini adapter.
 *   Users who want explicit control set `embedding_provider = "gemini"` or
 *   `embedding_provider = "openai"` in the Mind Palace dashboard.
 *
 * CONFIG KEYS (Prism dashboard "AI Providers" tab):
 *   anthropic_api_key  — Required. Claude API key (sk-ant-...)
 *   anthropic_model    — Chat model (default: claude-3-5-sonnet-20241022)
 *
 * MODEL SUGGESTIONS:
 *   claude-3-5-sonnet-20241022   — Best quality for compaction & summarization
 *   claude-3-haiku-20240307      — Fastest & cheapest; good for briefings
 *   claude-3-opus-20240229       — Most capable; use for complex fact merging
 */

import Anthropic from "@anthropic-ai/sdk";
import { getSettingSync } from "../../../storage/configStorage.js";
import { debugLog } from "../../logger.js";
import type { LLMProvider } from "../provider.js";

// ─── Constants ────────────────────────────────────────────────────────────────

// Default to Claude 3.5 Sonnet — best quality/cost ratio for the tasks
// Prism performs (compaction, briefing, fact merging, security scan).
const DEFAULT_MODEL = "claude-3-5-sonnet-20241022";

// Max output tokens for all Prism text-generation tasks.
// 4096 is sufficient for compaction summaries; raise if needed.
const MAX_TOKENS = 4096;

export class AnthropicAdapter implements LLMProvider {
  private client: Anthropic;

  constructor() {
    const apiKey = getSettingSync("anthropic_api_key", process.env.ANTHROPIC_API_KEY ?? "");

    if (!apiKey) {
      throw new Error(
        "AnthropicAdapter requires an API key. " +
        "Set ANTHROPIC_API_KEY or configure it in the Mind Palace dashboard."
      );
    }

    this.client = new Anthropic({ apiKey });
    debugLog("[AnthropicAdapter] Initialized");
  }

  // ─── Text Generation ─────────────────────────────────────────────────────

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    const model = getSettingSync("anthropic_model", DEFAULT_MODEL);

    debugLog(`[AnthropicAdapter] generateText — model=${model}`);

    // Anthropic's Messages API uses system as a top-level field (not a message role).
    // This maps cleanly to LLMProvider's systemInstruction parameter.
    const response = await this.client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      ...(systemInstruction ? { system: systemInstruction } : {}),
      messages: [{ role: "user", content: prompt }],
    });

    // Extract text from the first ContentBlock.
    // Anthropic returns an array of content blocks; we only use text blocks.
    const block = response.content[0];
    if (!block || block.type !== "text") {
      throw new Error(
        `[AnthropicAdapter] Unexpected response content type: ${block?.type ?? "empty"}`
      );
    }

    return block.text;
  }

  // ─── Embedding Generation (Not Supported) ────────────────────────────────

  async generateEmbedding(_text: string): Promise<number[]> {
    // This method should never be reached in normal operation:
    //   - factory.ts auto-resolves embedding_provider away from "anthropic"
    //   - The dashboard UI warns users if they select anthropic + auto
    //
    // If a user somehow bypasses the factory (e.g. by constructing this class
    // directly in a test), they get a clear, actionable error rather than a
    // silent zero-vector or crash.
    throw new Error(
      "AnthropicAdapter does not support text embeddings. " +
      "Anthropic has no native embedding API. " +
      "Their official recommendation is Voyage AI (voyage-3, voyage-3-lite). " +
      "In the Mind Palace dashboard, set 'Embedding Provider' to: " +
      "'voyage' (Anthropic-recommended, set VOYAGE_API_KEY), " +
      "'openai' (OpenAI cloud or local Ollama with nomic-embed-text), " +
      "or 'gemini' (Google AI, set GOOGLE_API_KEY)."
    );
  }

  // ─── Image Description (VLM) ─────────────────────────────────────────────

  /**
   * Describe an image using the Anthropic Messages API vision capability.
   * Claude 3.5 Sonnet (and Haiku/Opus) accept `image` content blocks with a
   * base64 `source`. imageCaptioner.ts enforces the 5MB payload limit before
   * this method is ever called.
   */
  async generateImageDescription(
    imageBase64: string,
    mimeType: string,
    context?: string,
  ): Promise<string> {
    const model = getSettingSync("anthropic_model", DEFAULT_MODEL);
    const prompt = context
      ? `Describe this image in rich detail for a developer knowledge base. User context: "${context}"`
      : "Describe this image in rich detail for a developer knowledge base. Include: UI elements, visible text, architectural components, and key observations.";

    debugLog(`[AnthropicAdapter] generateImageDescription — model=${model}`);

    const response = await this.client.messages.create({
      model,
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              // Anthropic requires the media_type to be a specific union type;
              // cast to `any` since mimeType is validated to be a supported
              // image format by imageCaptioner.ts before reaching here.
              media_type: mimeType as any,
              data: imageBase64,
            },
          },
          { type: "text", text: prompt },
        ],
      }],
    });

    const block = response.content[0];
    return block?.type === "text" ? block.text : "";
  }
}
