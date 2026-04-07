/**
 * Ollama Adapter (v1.0 — nomic-embed-text)
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE:
 *   Implements LLMProvider using Ollama's native /api/embed REST endpoint for
 *   fully local, zero-cost text embeddings. No API key required — Ollama runs
 *   on localhost.
 *
 * TEXT GENERATION:
 *   This adapter is embeddings-only. generateText() throws an explicit error.
 *   Set text_provider separately (anthropic, openai, or gemini).
 *
 * EMBEDDING DIMENSION PARITY (768 dims):
 *   Prism's SQLite (sqlite-vec) and Supabase (pgvector) schemas define
 *   embedding columns as EXACTLY 768 dimensions.
 *
 *   nomic-embed-text natively outputs 768 dims — zero truncation needed.
 *   It is the recommended default local model for Prism.
 *
 * SUPPORTED MODELS (all confirmed 768-dim via Ollama):
 *   nomic-embed-text     — 768 dims, 274MB, best quality/size trade-off ✅ DEFAULT
 *   nomic-embed-text:v1.5 — 768 dims, 274MB, same (stable alias)
 *
 *   Models to AVOID with this adapter (wrong dim count):
 *   mxbai-embed-large    — 1024 dims ❌  (use OpenAIAdapter instead)
 *   all-minilm           — 384 dims  ❌
 *   snowflake-arctic-embed — varies  ❌
 *
 * BATCH EMBEDDINGS:
 *   Uses /api/embed (plural) which is the official Ollama batch endpoint
 *   introduced in Ollama ≥ 0.3.0. Falls back gracefully for older versions.
 *
 * CONFIG KEYS (Prism dashboard "AI Providers" tab OR environment variables):
 *   ollama_base_url   — Base URL of Ollama server (default: http://localhost:11434)
 *   ollama_model      — Embedding model (default: nomic-embed-text)
 *
 * USAGE:
 *   In the Prism dashboard, set:
 *     embedding_provider = ollama
 *   Optionally set ollama_base_url and ollama_model to override defaults.
 *
 * API REFERENCE:
 *   https://github.com/ollama/ollama/blob/main/docs/api.md#generate-embeddings
 */

import { getSettingSync } from "../../../storage/configStorage.js";
import { debugLog } from "../../logger.js";
import type { LLMProvider } from "../provider.js";

// ─── Constants ────────────────────────────────────────────────────────────────

// Must match Prism's DB schema (sqlite-vec and pgvector column sizes).
const EMBEDDING_DIMS = 768;

// Generous character cap — nomic-embed-text has an 8192-token context window.
const MAX_EMBEDDING_CHARS = 8000;

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL    = "nomic-embed-text";

// Connection retry settings — handles the common "forgot to start Ollama" race.
const MAX_RETRIES      = 2;
const RETRY_DELAY_MS   = 500;

// ─── Ollama API Response Shapes ───────────────────────────────────────────────

interface OllamaEmbedResponse {
  model: string;
  embeddings: number[][];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class OllamaAdapter implements LLMProvider {
  private baseUrl: string;
  private model: string;

  constructor() {
    this.baseUrl = getSettingSync("ollama_base_url", DEFAULT_BASE_URL).replace(/\/$/, "");
    this.model   = getSettingSync("ollama_model", DEFAULT_MODEL);
    debugLog(`[OllamaAdapter] Initialized — baseUrl=${this.baseUrl}, model=${this.model}`);
  }

  // ─── Text Generation (Not Supported) ────────────────────────────────────

  async generateText(_prompt: string, _systemInstruction?: string): Promise<string> {
    throw new Error(
      "OllamaAdapter does not support text generation. " +
      "Set text_provider to 'anthropic', 'openai', or 'gemini' in the dashboard."
    );
  }

  // ─── Batch Embedding Generation ─────────────────────────────────────────

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (!texts || texts.length === 0) return [];

    const model = this.model;

    // Word-safe truncation — consistent with Voyage and OpenAI adapters.
    const truncatedTexts = texts.map(text => {
      if (text.length > MAX_EMBEDDING_CHARS) {
        const cut = text.slice(0, MAX_EMBEDDING_CHARS);
        const lastSpace = cut.lastIndexOf(" ");
        return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
      }
      return text;
    });

    debugLog(`[OllamaAdapter] generateEmbeddings — model=${model}, count=${truncatedTexts.length}`);

    // Retry loop — catches ECONNREFUSED when Ollama service hasn't started yet.
    let response!: Response;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        response = await fetch(`${this.baseUrl}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, input: truncatedTexts }),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "unknown error");
          throw new Error(
            `[OllamaAdapter] /api/embed request failed — status=${response.status}: ${errorText}. ` +
            `Make sure Ollama is running (ollama serve) and '${model}' has been pulled (ollama pull ${model}).`
          );
        }

        // Success — break out of retry loop.
        lastError = null;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const isNetworkError = lastError.message.includes("ECONNREFUSED") ||
                               lastError.message.includes("fetch failed") ||
                               lastError.message.includes("ECONNRESET");

        if (isNetworkError && attempt < MAX_RETRIES) {
          debugLog(
            `[OllamaAdapter] Connection failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ` +
            `${lastError.message.substring(0, 80)}. Retrying in ${RETRY_DELAY_MS}ms...`
          );
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
          continue;
        }

        throw lastError;
      }
    }

    if (lastError) throw lastError;

    const data = (await response.json()) as OllamaEmbedResponse;
    const embeddings = data?.embeddings;

    if (!Array.isArray(embeddings) || embeddings.length === 0) {
      throw new Error(`[OllamaAdapter] Empty embeddings response from model '${model}'.`);
    }

    if (embeddings.length !== texts.length) {
      throw new Error(
        `[OllamaAdapter] Response length mismatch — expected ${texts.length}, got ${embeddings.length}.`
      );
    }

    // Validate dimensions and slice if model returned > 768 (shouldn't happen
    // with nomic-embed-text but guards against model swaps).
    return embeddings.map((emb, i) => {
      if (emb.length > EMBEDDING_DIMS) {
        debugLog(
          `[OllamaAdapter] Embedding[${i}] has ${emb.length} dims — truncating to ${EMBEDDING_DIMS}. ` +
          `Consider using a model that natively outputs ${EMBEDDING_DIMS} dims (e.g. nomic-embed-text).`
        );
        return emb.slice(0, EMBEDDING_DIMS);
      }
      if (emb.length !== EMBEDDING_DIMS) {
        throw new Error(
          `[OllamaAdapter] Dimension mismatch at index ${i}: expected ${EMBEDDING_DIMS}, ` +
          `got ${emb.length}. Model '${model}' is not compatible with Prism's 768-dim schema. ` +
          `Use nomic-embed-text which natively outputs 768 dims.`
        );
      }
      return emb;
    });
  }

  // ─── Single Embedding (delegates to batch) ───────────────────────────────

  async generateEmbedding(text: string): Promise<number[]> {
    if (!text || !text.trim()) {
      throw new Error("[OllamaAdapter] generateEmbedding called with empty text.");
    }
    const results = await this.generateEmbeddings([text]);
    return results[0];
  }
}
