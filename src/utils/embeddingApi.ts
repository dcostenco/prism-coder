/**
 * Embedding Generation Utility (v0.5.0 — Model Migration)
 *
 * ═══════════════════════════════════════════════════════════════════
 * REVIEWER NOTE: This module wraps Google's gemini-embedding-001 model
 * to generate 768-dimensional vector embeddings for text.
 *
 * MIGRATION (2026-03): text-embedding-004 was deprecated Jan 14, 2026.
 * Replaced with gemini-embedding-001 (GA on v1 API). The new model
 * supports Matryoshka Representation Learning (MRL) for flexible
 * output dimensions (768, 1536, 3072). We use 768 for compatibility
 * with existing pgvector columns.
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
 * COST: Gemini's gemini-embedding-001 is free tier for <1500 req/min.
 * At typical usage (~10-50 ledger saves/day), we'll never approach
 * this limit.
 *
 * TRUNCATION GUARD: gemini-embedding-001 supports up to 2048 tokens
 * per input. We implement a hard character limit (default 8000 chars)
 * to guarantee the API call never crashes. This is applied before
 * sending to the API, not after.
 * ═══════════════════════════════════════════════════════════════════
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { GOOGLE_API_KEY } from "../config.js";

// ─── Constants ────────────────────────────────────────────────

// REVIEWER NOTE: Maximum characters to send to the embedding API.
// gemini-embedding-001 supports up to 2048 tokens. At ~4 chars/token,
// 8000 chars is a safe ceiling. Truncation is silent and non-fatal —
// the embedding still captures the semantic meaning of the leading
// content, which is more than enough for similarity search.
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
  // REVIEWER NOTE (v1.5.0 fix): JavaScript's substring() counts UTF-16
  // code units. If the cut point lands in the middle of a surrogate pair
  // (e.g., emoji 🚀 or complex CJK characters), the result contains an
  // invalid trailing byte (\uFFFD) that some APIs reject with 400.
  // Fix: truncate at the last word boundary before the limit.
  let inputText = text;
  if (inputText.length > MAX_EMBEDDING_CHARS) {
    console.error(
      `[embedding] Input text truncated from ${inputText.length} to ~${MAX_EMBEDDING_CHARS} chars (word-safe)`
    );
    inputText = inputText.substring(0, MAX_EMBEDDING_CHARS);
    // Snap back to the last space to avoid splitting a word or surrogate pair
    const lastSpace = inputText.lastIndexOf(' ');
    if (lastSpace > 0) {
      inputText = inputText.substring(0, lastSpace);
    }
  }

  // Skip empty or whitespace-only text
  if (!inputText.trim()) {
    throw new Error("Cannot generate embedding for empty text");
  }

  const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
  const model = genAI.getGenerativeModel(
    { model: "gemini-embedding-001" },
    { apiVersion: "v1beta" }  // gemini-embedding-001 requires v1beta
  );

  console.error(`[embedding] Generating 768-dim embedding for ${inputText.length} chars`);

  const result = await model.embedContent(inputText);
  return result.embedding.values;
}
