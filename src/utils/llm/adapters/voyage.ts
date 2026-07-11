import type { LLMProvider } from "../provider.js";
import { getSettingSync } from "../../../storage/configStorage.js";
import { debugLog } from "../../logger.js";

const EMBEDDING_DIMS = 768;
const MAX_EMBEDDING_CHARS = 120_000;
const TIMEOUT_MS = 30_000;
const API_URL = "https://api.voyageai.com/v1/embeddings";

export { VoyageEmbeddingAdapter as VoyageAdapter };

export class VoyageEmbeddingAdapter implements LLMProvider {
  private readonly apiKey: string;

  constructor() {
    const key = getSettingSync("voyage_api_key", process.env.VOYAGE_API_KEY ?? "");
    if (!key) {
      throw new Error("Voyage AI API key is required — set voyage_api_key in settings or VOYAGE_API_KEY env var");
    }
    this.apiKey = key;
  }

  async generateText(_prompt: string, _systemInstruction?: string): Promise<string> {
    throw new Error("VoyageEmbeddingAdapter only supports embeddings — use a different provider for text generation");
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Cannot generate embedding for empty or whitespace-only input");
    }

    const input = trimmed.length > MAX_EMBEDDING_CHARS ? trimmed.slice(0, MAX_EMBEDDING_CHARS) : trimmed;
    const model = getSettingSync("voyage_model", "voyage-3.5");

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input,
        model,
        input_type: "document",
        output_dimension: EMBEDDING_DIMS,
        truncation: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Voyage AI API error: HTTP ${response.status}`);
    }

    const json = await response.json() as {
      data: Array<{ embedding: number[] }>;
    };

    const embedding = json.data[0].embedding;

    if (embedding.length !== EMBEDDING_DIMS) {
      debugLog(`[voyage] Expected ${EMBEDDING_DIMS} dimensions but got ${embedding.length}`);
    }

    return embedding;
  }
}
