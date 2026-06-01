/**
 * Gemini Adapter (v4.5)
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE:
 *   Implements LLMProvider using Google's @google/generative-ai SDK.
 *   This is Prism's DEFAULT adapter and the result of consolidating LLM logic
 *   that was previously scattered across 6 different files into a single,
 *   well-guarded implementation.
 *
 * BEFORE v4.4 (scattered):
 *   - src/utils/embeddingApi.ts   → generateEmbedding logic
 *   - src/utils/googleAi.ts       → analyzePaperWithGemini text generation
 *   - compactionHandler.ts        → direct new GoogleGenerativeAI() instantiation
 *   - factMerger.ts               → direct new GoogleGenerativeAI() instantiation
 *   - briefing.ts                 → direct new GoogleGenerativeAI() instantiation
 *   - healthCheck.ts              → direct new GoogleGenerativeAI() instantiation
 *
 * AFTER v4.4 (consolidated here):
 *   All embedding guards, model constants, and SDK calls live in one place.
 *   All consumers call getLLMProvider() instead of touching the SDK directly.
 *
 * MODELS:
 *   Text:      gemini-2.5-flash       — fast, stable successor to deprecated 2.0-flash
 *   Embedding: gemini-embedding-001   — replaced text-embedding-004 (deprecated 2026-01)
 *              Uses Matryoshka Representation Learning (MRL) at 768 dims.
 *              Requires v1beta API endpoint (NOT v1).
 *
 * SDK NOTE:
 *   Still using @google/generative-ai@^0.24.1 (NOT the newer @google/genai).
 *   This is intentional — upgrading the SDK at the same time as introducing
 *   the abstraction layer would conflate two sources of behavioral change.
 *   SDK upgrade is a separate, future task.
 */

import {
  GoogleGenerativeAI,
  TaskType,
  type EmbedContentRequest,
} from "@google/generative-ai";
import { GOOGLE_API_KEY } from "../../../config.js";
import { debugLog } from "../../logger.js";
import type { LLMProvider } from "../provider.js";

// ─── Model Constants ──────────────────────────────────────────────────────────
// Defined as constants (not hardcoded strings) so external reviewers can see
// all model choices at a glance, and future changes only need one edit.

const TEXT_MODEL = process.env.PRISM_TEXT_MODEL || "gemini-2.5-flash";        // chat/instruction-following model
const EMBEDDING_MODEL = "gemini-embedding-001"; // vector embedding model (MRL-enabled)
const EMBEDDING_DIMS = 768;                     // fixed output dims — must match DB schema

// ─── Embedding Truncation Constants ──────────────────────────────────────────
// gemini-embedding-001 supports up to ~2048 tokens.
// We use a character-based limit (not token-based) because:
//   1. JS string.length returns UTF-16 code units, not tokens
//   2. Token counting would require an extra API call or tokenizer dependency
//   3. 8000 chars ≈ 1500-2000 tokens for typical prose — safely under the limit
// The word-boundary snap prevents splitting mid-word or mid-surrogate-pair.
const MAX_EMBEDDING_CHARS = 8000;

export class GeminiAdapter implements LLMProvider {
  // The underlying Google SDK client — initialized once per adapter instance.
  // The factory ensures only one adapter instance exists per process.
  private ai: GoogleGenerativeAI;

  constructor() {
    // Fail fast at construction time rather than at the first API call.
    // The factory catches this error and falls back gracefully.
    if (!GOOGLE_API_KEY) {
      throw new Error(
        "GeminiAdapter requires GOOGLE_API_KEY. " +
        "Set this environment variable to enable LLM features."
      );
    }
    this.ai = new GoogleGenerativeAI(GOOGLE_API_KEY);
  }

  // ─── Text Generation ─────────────────────────────────────────────────────

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    // getGenerativeModel() is lightweight — it just binds model name + options.
    // The HTTP call happens inside generateContent() below.
    const model = this.ai.getGenerativeModel({
      model: TEXT_MODEL,
      // Only spread systemInstruction if provided — avoids sending an empty field
      // which could confuse some model versions.
      ...(systemInstruction ? { systemInstruction } : {}),
    });

    const result = await model.generateContent(prompt);

    // result.response.text() extracts the first candidate's text content.
    // This matches the prior behavior in all 6 migrated call sites.
    return result.response.text();
  }

  // ─── Embedding Generation ────────────────────────────────────────────────

  private static _embeddingCache = new Map<string, { embedding: number[]; ts: number }>();
  private static _inflight = new Map<string, Promise<number[]>>();
  private static readonly EMBED_CACHE_MAX = 256;
  private static readonly EMBED_CACHE_TTL_MS = 5 * 60 * 1000;

  private getCachedEmbedding(key: string): number[] | null {
    const entry = GeminiAdapter._embeddingCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > GeminiAdapter.EMBED_CACHE_TTL_MS) {
      GeminiAdapter._embeddingCache.delete(key);
      return null;
    }
    // Move to tail for LRU on read
    GeminiAdapter._embeddingCache.delete(key);
    GeminiAdapter._embeddingCache.set(key, entry);
    return entry.embedding;
  }

  private setCachedEmbedding(key: string, embedding: number[]): void {
    // Delete-then-set moves the key to tail for correct LRU eviction
    GeminiAdapter._embeddingCache.delete(key);
    if (GeminiAdapter._embeddingCache.size >= GeminiAdapter.EMBED_CACHE_MAX) {
      const oldest = GeminiAdapter._embeddingCache.keys().next().value;
      if (oldest !== undefined) GeminiAdapter._embeddingCache.delete(oldest);
    }
    GeminiAdapter._embeddingCache.set(key, { embedding, ts: Date.now() });
  }

  async generateEmbedding(text: string): Promise<number[]> {
    // Guard: empty string would produce a useless/degenerate embedding.
    // Better to fail loudly here than store a zero-vector in the DB.
    if (!text || !text.trim()) {
      throw new Error("Cannot generate embedding for empty text.");
    }

    const trimmedText = text.trim();
    const cacheKey = `${trimmedText.substring(0, 500)}|L${trimmedText.length}`;
    const cached = this.getCachedEmbedding(cacheKey);
    if (cached) {
      debugLog(`[GeminiAdapter] Embedding cache HIT`);
      return cached;
    }

    // In-flight dedup: if another call is already generating this embedding, await it
    const inflight = GeminiAdapter._inflight.get(cacheKey);
    if (inflight) {
      debugLog(`[GeminiAdapter] Embedding in-flight dedup HIT`);
      return inflight;
    }

    const promise = this._generateEmbeddingImpl(trimmedText, cacheKey);
    GeminiAdapter._inflight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      GeminiAdapter._inflight.delete(cacheKey);
    }
  }

  private async _generateEmbeddingImpl(inputTextRaw: string, cacheKey: string): Promise<number[]> {

    // ── Truncation Guard ───────────────────────────────────────────────────
    // gemini-embedding-001 has a ~2048 token context window.
    // Long session summaries (esp. code-heavy ones) can easily exceed this.
    // We truncate proactively rather than let the API return a 400 error.
    let inputText = inputTextRaw;
    if (inputText.length > MAX_EMBEDDING_CHARS) {
      debugLog(
        `[GeminiAdapter] Embedding input truncated from ${inputText.length}` +
        ` to ~${MAX_EMBEDDING_CHARS} chars (word-safe)`
      );
      // Step 1: hard cut at the character limit
      inputText = inputText.substring(0, MAX_EMBEDDING_CHARS);
      // Step 2: snap back to the last word boundary to avoid:
      //   a) splitting a word mid-character (readability)
      //   b) splitting a UTF-16 surrogate pair (correctness)
      const lastSpace = inputText.lastIndexOf(" ");
      if (lastSpace > 0) {
        inputText = inputText.substring(0, lastSpace);
      }
    }

    // ── API Version Pin ────────────────────────────────────────────────────
    // gemini-embedding-001 is ONLY available on the v1beta endpoint.
    // Using the default v1 endpoint returns a 404/model-not-found error.
    // This was a known breaking change when migrating from text-embedding-004.
    const model = this.ai.getGenerativeModel(
      { model: EMBEDDING_MODEL },
      { apiVersion: "v1beta" }
    );

    debugLog(
      `[GeminiAdapter] Generating ${EMBEDDING_DIMS}-dim embedding` +
      ` for ${inputText.length} chars`
    );

    // ── Request Construction ───────────────────────────────────────────────
    // outputDimensionality is a valid API field (Matryoshka truncation) but
    // lags in the TypeScript type definitions as of @google/generative-ai@0.24.1.
    // We use a type assertion on the full object rather than a spread-cast hack
    // to keep the code readable while satisfying tsc.
    const request = {
      content: {
        role: "user" as const,  // "user" role is required by the embedding API
        parts: [{ text: inputText }],
      },
      taskType: TaskType.SEMANTIC_SIMILARITY, // optimizes for cosine similarity search
      outputDimensionality: EMBEDDING_DIMS,   // MRL truncation to 768 dims
    } as EmbedContentRequest;

    const result = await model.embedContent(request);
    const values = result.embedding.values;

    // ── Dimension Enforcement ──────────────────────────────────────────────
    // Hard check: throwing here is better than silently writing a wrong-size
    // vector to the DB, which would corrupt the pgvector/sqlite-vec index.
    if (!Array.isArray(values) || values.length !== EMBEDDING_DIMS) {
      throw new Error(
        `Embedding dimension mismatch: expected ${EMBEDDING_DIMS},` +
        ` got ${values?.length ?? "unknown"}`
      );
    }

    this.setCachedEmbedding(cacheKey, values);
    return values;
  }

  // ─── Image Description (VLM) ─────────────────────────────────────────────

  /**
   * Describe an image using Gemini's native multimodal capability.
   * gemini-2.5-flash handles images alongside text — the same model used for
   * text generation, so no extra SDK initialization is needed.
   */
  async generateImageDescription(
    imageBase64: string,
    mimeType: string,
    context?: string,
  ): Promise<string> {
    const model = this.ai.getGenerativeModel({ model: TEXT_MODEL });
    const prompt = context
      ? `Describe this image in rich detail for a developer knowledge base. User context: "${context}"`
      : "Describe this image in rich detail for a developer knowledge base. Include: UI elements, visible text, architectural components, and key observations.";

    const result = await model.generateContent([
      { inlineData: { data: imageBase64, mimeType } },
      prompt,
    ]);
    return result.response.text();
  }

  // ─── Image OCR ───────────────────────────────────────────────────────────
  //
  // The captioner runs this AFTER generateImageDescription so users can
  // semantically search by the literal text of a whiteboard / handwritten
  // note / document screenshot. It's a separate VLM call (not bundled into
  // the description prompt) because:
  //   1. The two prompts pull the model in different directions — caption
  //      wants prose, OCR wants verbatim with NO embellishment.
  //   2. Bundling would require parsing structured output, which makes
  //      every adapter responsible for a fragile JSON parse.
  // Extra cost: one VLM round trip per image. The captioner already
  // respects the 5MB / 20MB size caps so this doesn't change the
  // request shape.
  async extractImageText(
    imageBase64: string,
    mimeType: string,
  ): Promise<string> {
    const model = this.ai.getGenerativeModel({ model: TEXT_MODEL });

    const prompt =
      "Extract every readable line of text from this image, verbatim, " +
      "line by line, in reading order. Preserve original spelling and " +
      "punctuation. Do NOT add commentary, headers, or markdown. " +
      'If the image contains no readable text at all, return exactly "".';

    const result = await model.generateContent([
      { inlineData: { data: imageBase64, mimeType } },
      prompt,
    ]);
    const raw = result.response.text().trim();

    // Some VLMs love to wrap with quotes or add "Here is the text:"
    // prefixes despite the no-commentary instruction. Strip those so
    // the caller can store clean text.
    const cleaned = raw
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/^(here(?:'s| is)?(?: the(?: extracted)?(?: visible)? text)?:\s*)/i, '')
      .trim();

    return cleaned;
  }
}
