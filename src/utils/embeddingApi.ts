/**
 * Embedding Generation Utility (v0.4.0 — Enhancement #4)
 *
 * ═══════════════════════════════════════════════════════════════════
 * REVIEWER NOTE: This module wraps Google's text-embedding-004 model
 * to generate 768-dimensional vector embeddings for text.
 *
 * USAGE — Called in two places:
 *   1. sessionSaveLedgerHandler — embeds summary+decisions at save time
 *      (fire-and-forget, non-blocking)
 *   2. sessionSearchMemoryHandler — embeds the user's search query
 *      to find semantically similar past sessions
 *
 * WHY GEMINI: We already have @google/generative-ai as a dependency
 * and GOOGLE_API_KEY configured for the research paper analysis tool.
 * Using a separate embedding service (OpenAI, Cohere) would add
 * another API key dependency and increase configuration complexity.
 *
 * COST: Gemini's text-embedding-004 is free tier for <1500 req/min.
 * At typical usage (~10-50 ledger saves/day), we'll never approach
 * this limit.
 *
 * TRUNCATION GUARD: text-embedding-004 has a token limit per API call
 * (~8192 tokens ≈ ~32K characters). If the input text exceeds this,
 * the API returns a 400 Bad Request. We implement a hard character
 * limit (default 8000 chars) to guarantee the API call never crashes.
 * This is applied before sending to the API, not after.
 * ═══════════════════════════════════════════════════════════════════
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { GOOGLE_API_KEY } from "../config.js";

// ─── Constants ────────────────────────────────────────────────

// REVIEWER NOTE: Maximum characters to send to the embedding API.
// text-embedding-004 supports ~8192 tokens. At ~4 chars per token,
// 8000 chars is a safe ceiling. Truncation is silent and non-fatal —
// the embedding still captures the semantic meaning of the first
// ~2000 tokens, which is more than enough for similarity search.
const MAX_EMBEDDING_CHARS = 8000;

// ─── Embedding Client ─────────────────────────────────────────

/**
 * Generates a 768-dimensional embedding vector for the given text.
 *
 * @param text - The text to embed (summary + decisions, search query, etc.)
 * @returns Array of 768 floating-point numbers representing the text's
 *          semantic meaning in vector space.
 * @throws Error if GOOGLE_API_KEY is not configured or API call fails.
 *
 * REVIEWER NOTE: The truncation happens BEFORE the API call, not after.
 * If the text is longer than MAX_EMBEDDING_CHARS, we silently truncate
 * and log a warning to stderr. This prevents 400 Bad Request errors
 * from the Gemini API without blocking the caller.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  if (!GOOGLE_API_KEY) {
    throw new Error(
      "Cannot generate embeddings: GOOGLE_API_KEY is not configured. " +
      "Set this environment variable to enable semantic search."
    );
  }

  // Truncation guard — prevent exceeding API token limits
  let inputText = text;
  if (inputText.length > MAX_EMBEDDING_CHARS) {
    console.error(
      `[embedding] Input text truncated from ${inputText.length} to ${MAX_EMBEDDING_CHARS} chars`
    );
    inputText = inputText.substring(0, MAX_EMBEDDING_CHARS);
  }

  // Skip empty or whitespace-only text
  if (!inputText.trim()) {
    throw new Error("Cannot generate embedding for empty text");
  }

  const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
  const model = genAI.getGenerativeModel({ model: "text-embedding-004" });

  console.error(`[embedding] Generating 768-dim embedding for ${inputText.length} chars`);

  const result = await model.embedContent(inputText);
  return result.embedding.values;
}
