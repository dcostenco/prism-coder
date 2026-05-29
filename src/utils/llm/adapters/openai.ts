/**
 * OpenAI Adapter (v4.5)
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE:
 *   Implements LLMProvider using the official `openai` Node.js SDK.
 *   A single adapter that covers FOUR deployment scenarios:
 *
 *   1. Cloud OpenAI (default)
 *      apiKey  = OPENAI_API_KEY env var or dashboard setting
 *      baseURL = https://api.openai.com/v1  (default)
 *      Models: gpt-4o-mini (default text), text-embedding-3-small (embedding)
 *
 *   2. Ollama (local, open-source)
 *      apiKey  = (not needed — leave blank)
 *      baseURL = http://localhost:11434/v1
 *      Models: any model you've pulled (e.g. llama3.2, nomic-embed-text)
 *
 *   3. LM Studio (local GUI)
 *      apiKey  = (not needed — leave blank)
 *      baseURL = http://localhost:1234/v1
 *
 *   4. vLLM / custom OpenAI-compatible server
 *      apiKey  = (server-specific)
 *      baseURL = http://<host>:<port>/v1
 *
 * EMBEDDING DIMENSION PARITY (768 dims):
 *   Prism's SQLite (sqlite-vec) and Supabase (pgvector) schemas define
 *   embedding columns as EXACTLY 768 dimensions. This was chosen to match
 *   Gemini's native output size. All adapters MUST return 768-dim vectors.
 *
 *   OpenAI solution: text-embedding-3-* models support the `dimensions`
 *   parameter via Matryoshka Representation Learning (MRL), which produces
 *   a shorter but still high-quality vector. text-embedding-3-small at 768
 *   dims outperforms text-embedding-ada-002 at its native 1536 dims.
 *
 *   WARNING for local models (Ollama / LM Studio):
 *   Many locally-served models do NOT support the `dimensions` parameter.
 *   We log a warning but do NOT throw — the error will surface at the DB
 *   write boundary, which is the right place to enforce the constraint.
 *   Choose a local embedding model that natively outputs 768 dims
 *   (e.g. nomic-embed-text = 768, mxbai-embed-large = 1024 — avoid latter).
 *
 * CONFIG KEYS (Prism dashboard "AI Providers" tab OR environment variables):
 *   openai_api_key         — API key (empty = localhost/Ollama mode)
 *   openai_base_url        — Base URL (default: https://api.openai.com/v1)
 *   openai_model           — Chat model (default: gpt-4o-mini)
 *   openai_embedding_model — Embedding model (default: text-embedding-3-small)
 */

import OpenAI from "openai";
import { getSettingSync } from "../../../storage/configStorage.js";
import { debugLog } from "../../logger.js";
import type { LLMProvider } from "../provider.js";

// ─── Constants ────────────────────────────────────────────────────────────────

// Must match Prism's DB schema (sqlite-vec and pgvector column sizes).
// Changing this requires a DB migration — do not adjust casually.
const EMBEDDING_DIMS = 768;

// text-embedding-3-small has an 8191-token context window.
// We use a conservative character-based cap to avoid needing a tokenizer.
// 8000 chars ≈ 1500-2000 tokens for typical session summaries.
const MAX_EMBEDDING_CHARS = 8000;

export class OpenAIAdapter implements LLMProvider {
  // The OpenAI SDK client — stateful, holds the API key + base URL.
  // One instance per factory singleton = one instance per MCP server process.
  private client: OpenAI;

  constructor() {
    // Priority: dashboard setting → environment variable → empty string.
    // This lets users configure keys via the dashboard without touching .env.
    const apiKey  = getSettingSync("openai_api_key",  process.env.OPENAI_API_KEY ?? "");
    const baseURL = getSettingSync("openai_base_url", "https://api.openai.com/v1");

    // Detect local inference endpoints — these don't need a real API key.
    // Ollama and LM Studio use local HTTP servers with no authentication.
    const isLocal = baseURL.includes("localhost") || baseURL.includes("127.0.0.1");

    // Fail construction if no key AND we're pointing at a real API endpoint.
    // The factory will catch this and fall back to GeminiAdapter gracefully.
    if (!apiKey && !isLocal) {
      throw new Error(
        "OpenAI API key is not set and base URL is not a local endpoint. " +
        "Set OPENAI_API_KEY or configure a local base URL (e.g. http://localhost:11434/v1)."
      );
    }

    this.client = new OpenAI({
      // Ollama requires a non-empty string for apiKey even though it ignores it.
      // "ollama" is the conventional placeholder in the Ollama docs.
      apiKey:  apiKey || "ollama",
      baseURL,
    });

    debugLog(`[OpenAIAdapter] Initialized — baseURL=${baseURL}, keyless=${!apiKey}`);
  }

  // ─── Text Generation ─────────────────────────────────────────────────────

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    // Read model at call time (not constructor) so the user can hot-swap
    // the model setting without restarting the server.
    const model = getSettingSync("openai_model", "gpt-4o-mini");

    // Build message array: optional system message first, then user prompt.
    // This maps cleanly to Gemini's systemInstruction + user prompt pattern.
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (systemInstruction) {
      messages.push({ role: "system", content: systemInstruction });
    }
    messages.push({ role: "user", content: prompt });

    debugLog(`[OpenAIAdapter] generateText — model=${model}, messages=${messages.length}`);

    const response = await this.client.chat.completions.create({ model, messages });

    // choices[0] is always the primary completion. ?? "" returns empty string
    // on null content (e.g. if the model returned a function call instead).
    return response.choices[0]?.message?.content ?? "";
  }

  // ─── Embedding Generation ────────────────────────────────────────────────

  private static _embeddingCache = new Map<string, { embedding: number[]; ts: number }>();
  private static _inflight = new Map<string, Promise<number[]>>();
  private static readonly EMBED_CACHE_MAX = 256;
  private static readonly EMBED_CACHE_TTL_MS = 5 * 60 * 1000;

  async generateEmbedding(text: string): Promise<number[]> {
    // Guard: empty input produces a degenerate embedding — fail loudly.
    if (!text || !text.trim()) {
      throw new Error("Cannot generate embedding for empty text.");
    }

    const trimmedText = text.trim();
    const cacheKey = `${trimmedText.substring(0, 500)}|L${trimmedText.length}`;
    const entry = OpenAIAdapter._embeddingCache.get(cacheKey);
    if (entry && Date.now() - entry.ts < OpenAIAdapter.EMBED_CACHE_TTL_MS) {
      debugLog(`[OpenAIAdapter] Embedding cache HIT`);
      // Move to tail for LRU on read
      OpenAIAdapter._embeddingCache.delete(cacheKey);
      OpenAIAdapter._embeddingCache.set(cacheKey, entry);
      return entry.embedding;
    }

    // In-flight dedup
    const inflight = OpenAIAdapter._inflight.get(cacheKey);
    if (inflight) {
      debugLog(`[OpenAIAdapter] Embedding in-flight dedup HIT`);
      return inflight;
    }

    const promise = this._generateEmbeddingImpl(trimmedText, cacheKey);
    OpenAIAdapter._inflight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      OpenAIAdapter._inflight.delete(cacheKey);
    }
  }

  private async _generateEmbeddingImpl(inputTextRaw: string, cacheKey: string): Promise<number[]> {
    const model = getSettingSync("openai_embedding_model", "text-embedding-3-small");

    // ── Truncation Guard ───────────────────────────────────────────────────
    // text-embedding-3-small accepts up to 8191 tokens.
    // We apply the same preventive truncation as GeminiAdapter so behavior
    // is consistent regardless of which provider is active.
    let inputText = inputTextRaw;
    if (inputText.length > MAX_EMBEDDING_CHARS) {
      debugLog(
        `[OpenAIAdapter] Embedding input truncated from ${inputText.length}` +
        ` to ~${MAX_EMBEDDING_CHARS} chars (word-safe)`
      );
      // Hard cut, then snap back to last word boundary (avoids mid-word splits)
      inputText = inputText.substring(0, MAX_EMBEDDING_CHARS);
      const lastSpace = inputText.lastIndexOf(" ");
      if (lastSpace > 0) inputText = inputText.substring(0, lastSpace);
    }

    debugLog(`[OpenAIAdapter] generateEmbedding — model=${model}, dims=${EMBEDDING_DIMS}`);

    const response = await this.client.embeddings.create({
      model,
      input: inputText,
      // `dimensions` triggers Matryoshka truncation — produces a 768-dim vector
      // without the full 1536-dim generation + local truncation overhead.
      // ONLY works with text-embedding-3-* models. ada-002 ignores this field.
      dimensions: EMBEDDING_DIMS,
    });

    const embedding = response.data[0]?.embedding;

    // Hard check: null/empty response means the API returned nothing useful.
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error(`[OpenAIAdapter] Embedding response is empty for model "${model}"`);
    }

    // ── Dimension Warning (soft — not a hard throw) ────────────────────────
    // Why soft? Local models (Ollama) may ignore `dimensions` and return their
    // native size. A hard throw here would make Ollama completely unusable.
    // The mismatch will be caught at the DB write boundary (pgvector/sqlite-vec
    // will reject mismatched vector sizes with a clear error message).
    if (embedding.length !== EMBEDDING_DIMS) {
      console.warn(
        `[OpenAIAdapter] Embedding dimension mismatch: expected ${EMBEDDING_DIMS}, ` +
        `got ${embedding.length}. ` +
        `If using a local model, use one that natively outputs ${EMBEDDING_DIMS} dims ` +
        `(e.g. nomic-embed-text) or supports the Matryoshka 'dimensions' parameter.`
      );
    }

    OpenAIAdapter._embeddingCache.delete(cacheKey);
    if (OpenAIAdapter._embeddingCache.size >= OpenAIAdapter.EMBED_CACHE_MAX) {
      const oldest = OpenAIAdapter._embeddingCache.keys().next().value;
      if (oldest !== undefined) OpenAIAdapter._embeddingCache.delete(oldest);
    }
    OpenAIAdapter._embeddingCache.set(cacheKey, { embedding, ts: Date.now() });
    return embedding;
  }

  // ─── Image Description (VLM) ─────────────────────────────────────────────

  /**
   * Describe an image via the OpenAI Chat Completions vision API.
   * Uses the chat model (gpt-4o-mini default) since OpenAI embeds vision
   * into their chat API rather than a separate endpoint.
   * Works with any OpenAI-compatible server that supports vision
   * (Ollama with llava, LM Studio with vision models, etc.).
   */
  async generateImageDescription(
    imageBase64: string,
    mimeType: string,
    context?: string,
  ): Promise<string> {
    const model = getSettingSync("openai_model", "gpt-4o-mini");
    const prompt = context
      ? `Describe this image in rich detail for a developer knowledge base. User context: "${context}"`
      : "Describe this image in rich detail for a developer knowledge base. Include: UI elements, visible text, architectural components, and key observations.";

    const response = await this.client.chat.completions.create({
      model,
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          {
            type: "image_url",
            // OpenAI vision requires the data-URI prefix
            image_url: { url: `data:${mimeType};base64,${imageBase64}` },
          },
          { type: "text", text: prompt },
        ],
      }],
    });

    return response.choices[0]?.message?.content ?? "";
  }
}
