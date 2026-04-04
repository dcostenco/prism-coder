/**
 * Voyage AI Adapter (v1.0)
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE:
 *   Implements LLMProvider using Voyage AI's REST API for text embeddings.
 *   Voyage AI is the embedding provider officially recommended by Anthropic
 *   for use alongside Claude — it fills the gap left by Anthropic's lack
 *   of a native embedding API.
 *
 * TEXT GENERATION:
 *   Voyage AI is an embeddings-only service. generateText() throws an explicit
 *   error, the same pattern used by AnthropicAdapter.generateEmbedding().
 *   Set text_provider separately (anthropic, openai, or gemini).
 *
 * EMBEDDING DIMENSION PARITY (768 dims):
 *   Prism's SQLite (sqlite-vec) and Supabase (pgvector) schemas define
 *   embedding columns as EXACTLY 768 dimensions.
 *
 *   Voyage solution: voyage-3 and voyage-3-lite output 1024 dims by default,
 *   but both support the `output_dimension` parameter (Matryoshka Representation
 *   Learning), enabling truncation to 768 while preserving quality.
 *   voyage-3-lite at 768 dims is the fastest and most cost-efficient option.
 *
 * MODELS:
 *   voyage-3           — Highest quality, 1024 dims natively (MRL → 768)
 *   voyage-3-lite      — Fast & cheap, 512 dims natively (MRL → 768 NOT supported)
 *   voyage-3-large     — Best quality, use for offline indexing
 *   voyage-code-3      — Optimised for code (recommended for dev sessions)
 *
 *   NOTE: voyage-3-lite natively outputs 512 dims; it does NOT support
 *   output_dimension truncation to 768. Use voyage-3 for dimension parity.
 *   Default is voyage-3 for this reason.
 *
 * CONFIG KEYS (Prism dashboard "AI Providers" tab OR environment variables):
 *   voyage_api_key     — Required. Voyage AI API key (pa-...)
 *   voyage_model       — Embedding model (default: voyage-3)
 *
 * USAGE WITH ANTHROPIC TEXT PROVIDER:
 *   Set text_provider=anthropic, embedding_provider=voyage in the dashboard.
 *   This pairs Claude for reasoning with Voyage for semantic memory — the
 *   combination Anthropic recommends in their documentation.
 *
 * API REFERENCE:
 *   https://docs.voyageai.com/reference/embeddings-api
 */

import { getSettingSync } from "../../../storage/configStorage.js";
import { debugLog } from "../../logger.js";
import type { LLMProvider } from "../provider.js";

// ─── Constants ────────────────────────────────────────────────────────────────

// Must match Prism's DB schema (sqlite-vec and pgvector column sizes).
const EMBEDDING_DIMS = 768;

// voyage-3 supports up to 32,000 tokens. Character-based cap (consistent
// with OpenAI and Gemini adapters) avoids tokenizer dependency.
// 8000 chars ≈ 1500-2000 tokens for typical session summaries.
const MAX_EMBEDDING_CHARS = 8000;

// Default model: voyage-3 (supports output_dimension=768 via MRL)
// voyage-3-lite is NOT recommended as its native 512 dims < 768.
const DEFAULT_MODEL = "voyage-3";

const VOYAGE_API_BASE = "https://api.voyageai.com/v1";

// ─── Voyage Embeddings API Response ──────────────────────────────────────────

interface VoyageEmbeddingResponse {
  object: "list";
  data: Array<{
    object: "embedding";
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    total_tokens: number;
  };
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class VoyageAdapter implements LLMProvider {
  private apiKey: string;

  constructor() {
    const apiKey = getSettingSync("voyage_api_key", process.env.VOYAGE_API_KEY ?? "");

    if (!apiKey) {
      throw new Error(
        "VoyageAdapter requires a Voyage AI API key. " +
        "Get one free at https://dash.voyageai.com — then set VOYAGE_API_KEY " +
        "or configure it in the Mind Palace dashboard under 'AI Providers'."
      );
    }

    this.apiKey = apiKey;
    debugLog("[VoyageAdapter] Initialized");
  }

  // ─── Text Generation (Not Supported) ────────────────────────────────────

  async generateText(_prompt: string, _systemInstruction?: string): Promise<string> {
    // Voyage AI is an embeddings-only service.
    // Use text_provider=anthropic, openai, or gemini for text generation.
    throw new Error(
      "VoyageAdapter does not support text generation. " +
      "Voyage AI is an embeddings-only service. " +
      "Set text_provider to 'anthropic', 'openai', or 'gemini' in the dashboard."
    );
  }

  // ─── Embedding Generation ────────────────────────────────────────────────

  async generateEmbedding(text: string): Promise<number[]> {
    if (!text || !text.trim()) {
      throw new Error("[VoyageAdapter] generateEmbedding called with empty text");
    }

    // Truncate to character limit (consistent with other adapters)
    const truncated =
      text.length > MAX_EMBEDDING_CHARS
        ? text.slice(0, MAX_EMBEDDING_CHARS).replace(/\s+\S*$/, "")
        : text;

    const model = getSettingSync("voyage_model", DEFAULT_MODEL);

    debugLog(`[VoyageAdapter] generateEmbedding — model=${model}, chars=${truncated.length}`);

    const requestBody = {
      input: [truncated],
      model,
      // Request exactly 768 dims via Matryoshka truncation.
      // Supported by voyage-3, voyage-3-large, voyage-code-3.
      // voyage-3-lite (native 512 dims) will ignore this and return 512,
      // which will be caught by the dimension guard below.
      output_dimension: EMBEDDING_DIMS,
    };

    const response = await fetch(`${VOYAGE_API_BASE}/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(
        `[VoyageAdapter] API request failed — status=${response.status}: ${errorText}`
      );
    }

    const data = (await response.json()) as VoyageEmbeddingResponse;

    const embedding = data?.data?.[0]?.embedding;

    if (!Array.isArray(embedding)) {
      throw new Error("[VoyageAdapter] Unexpected response format — no embedding array found");
    }

    // Dimension guard: Prism's DB schema requires exactly 768 dims.
    // This catches voyage-3-lite (512) or future API changes silently early.
    if (embedding.length !== EMBEDDING_DIMS) {
      throw new Error(
        `[VoyageAdapter] Embedding dimension mismatch: expected ${EMBEDDING_DIMS}, ` +
        `got ${embedding.length}. ` +
        `Use voyage-3 (not voyage-3-lite) to get 768-dim output via MRL truncation. ` +
        `Change voyage_model in the Mind Palace dashboard.`
      );
    }

    debugLog(
      `[VoyageAdapter] Embedding generated — dims=${embedding.length}, ` +
      `tokens_used=${data.usage?.total_tokens ?? "unknown"}`
    );

    return embedding;
  }
}
