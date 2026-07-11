/**
 * Voyage AI Embedding Adapter
 *
 * Clean-room implementation from Voyage AI REST API documentation:
 * https://docs.voyageai.com/reference/embeddings-api
 *
 * Voyage AI provides embedding-only models. This adapter implements
 * the LLMProvider interface for embeddings; generateText() is unsupported.
 *
 * Recommended model: voyage-3.5 (supports output_dimension via MRL).
 */

import type { LLMProvider } from "../provider.js";
import { getSettingSync } from "../../../storage/configStorage.js";
import { debugLog } from "../../logger.js";

const API_URL = "https://api.voyageai.com/v1/embeddings";
const DEFAULT_MODEL = "voyage-3.5";
const TARGET_DIMS = 768;
const MAX_INPUT_CHARS = 120_000;

interface EmbeddingResponse {
  object: string;
  data: Array<{ object: string; embedding: number[]; index: number }>;
  model: string;
  usage: { total_tokens: number };
}

export class VoyageAdapter implements LLMProvider {
  private readonly apiKey: string;

  constructor() {
    const key = getSettingSync("voyage_api_key", process.env.VOYAGE_API_KEY ?? "");
    if (!key) {
      throw new Error(
        "VoyageAdapter requires VOYAGE_API_KEY. " +
        "Get one at https://dash.voyageai.com — then set VOYAGE_API_KEY " +
        "or voyage_api_key in the dashboard.",
      );
    }
    this.apiKey = key;
    debugLog("[VoyageAdapter] Initialized");
  }

  async generateText(): Promise<string> {
    throw new Error(
      "VoyageAdapter does not support text generation. " +
      "Voyage AI is an embeddings-only service. " +
      "Use a text provider (anthropic, gemini, openai) for generation.",
    );
  }

  async generateEmbedding(text: string): Promise<number[]> {
    if (!text || !text.trim()) {
      throw new Error("[VoyageAdapter] generateEmbedding called with empty text");
    }

    const truncated = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
    const model = getSettingSync("voyage_model", DEFAULT_MODEL);

    debugLog(`[VoyageAdapter] generateEmbedding — model=${model}, chars=${truncated.length}`);

    const body: Record<string, unknown> = {
      input: [truncated],
      model,
      input_type: "document",
      truncation: true,
      output_dimension: TARGET_DIMS,
    };

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `[VoyageAdapter] API request failed — status=${response.status}: ${errorText}`,
      );
    }

    const data = (await response.json()) as EmbeddingResponse;

    if (!data.data?.[0]?.embedding) {
      throw new Error("[VoyageAdapter] Unexpected response format — no embedding array found");
    }

    const embedding = data.data[0].embedding;

    if (embedding.length !== TARGET_DIMS) {
      debugLog(
        `[VoyageAdapter] Embedding dimension mismatch: expected ${TARGET_DIMS}, ` +
        `got ${embedding.length}. Model ${model} may not support output_dimension=${TARGET_DIMS}.`,
      );
    }

    debugLog(
      `[VoyageAdapter] Embedding generated — dims=${embedding.length}, ` +
      `tokens=${data.usage?.total_tokens ?? "?"}`,
    );

    return embedding;
  }
}
