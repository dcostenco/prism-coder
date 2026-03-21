/**
 * Fact Merger — Async LLM Contradiction Resolution (v2.3.0)
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHAT THIS DOES:
 *   When the agent saves a handoff with key_context that contradicts
 *   existing state (e.g., old says "Postgres", new says "MySQL"),
 *   this module uses Gemini to intelligently merge the facts —
 *   keeping the newest truth and deduplicating redundant info.
 *
 * HOW IT'S USED:
 *   Called as a fire-and-forget background task from
 *   sessionSaveHandoffHandler. The agent gets an instant "✅ Saved"
 *   response while merging happens in the background (~2-3s).
 *
 * WHY ASYNC (FIRE-AND-FORGET):
 *   Prism's zero-bloat philosophy means we never make the agent
 *   wait for an LLM call. The handoff is saved immediately with
 *   the raw user-provided context. The merger then:
 *     1. Loads the old context from the database
 *     2. Sends old + new to Gemini for intelligent merging
 *     3. Silently patches the database with the clean result
 *
 * OCC RACE CONDITION HANDLING:
 *   If the user saves another handoff while the merger is running,
 *   the merger's save will fail due to the version mismatch (OCC).
 *   This is GOOD behavior — active user input always takes precedence
 *   over background merging. We catch the error silently and log:
 *   "Merge skipped due to active session."
 *
 * REQUIREMENTS:
 *   - GOOGLE_API_KEY must be set (skips gracefully if not)
 *   - Uses gemini-2.5-flash for speed (~2-3s per merge)
 * ═══════════════════════════════════════════════════════════════════
 */

import { GoogleGenerativeAI } from "@google/generative-ai";  // Gemini SDK for LLM calls
import { GOOGLE_API_KEY } from "../config.js";               // API key from environment

/**
 * Merge old and new key_context using Gemini to resolve contradictions.
 *
 * The LLM is instructed to:
 *   - Keep the NEW UPDATE as the source of truth for contradictions
 *   - Deduplicate redundant information across both contexts
 *   - Preserve unique facts from both old and new
 *   - Return only the consolidated raw text (no markdown, no preamble)
 *
 * @param oldContext  - The existing key_context from the database
 * @param newContext  - The freshly provided key_context from the agent
 * @returns The merged, deduplicated context string
 * @throws If Gemini call fails (caller should catch and log)
 *
 * @example
 *   // Old: "We use Postgres for the main DB"
 *   // New: "Switched to MySQL for the main DB"
 *   // Result: "We use MySQL for the main DB"
 */
export async function consolidateFacts(
  oldContext: string,
  newContext: string
): Promise<string> {
  // Guard: need API key to call Gemini
  if (!GOOGLE_API_KEY) {
    console.error("[FactMerger] Skipped — no GOOGLE_API_KEY configured");
    return newContext;  // fallback: just use the new context as-is
  }

  // Guard: if either context is empty, no merging needed
  if (!oldContext || oldContext.trim().length === 0) {
    return newContext;  // nothing to merge with — use new context
  }
  if (!newContext || newContext.trim().length === 0) {
    return oldContext;  // no new context provided — keep old
  }

  // Guard: if old and new are identical, skip the LLM call entirely
  if (oldContext.trim() === newContext.trim()) {
    console.error("[FactMerger] Old and new context are identical — skipping merge");
    return newContext;  // no changes needed
  }

  // Initialize Gemini with the configured API key
  const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);

  // Use gemini-2.5-flash for speed — merges should complete in ~2-3s
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
  });

  // Build the merge prompt — instructs Gemini to resolve contradictions
  // and deduplicate while keeping the NEW UPDATE as source of truth
  const prompt = "You are a memory consolidation engine for an AI agent.\n\n" +
    "OLD MEMORY:\n" + oldContext + "\n\n" +
    "NEW UPDATE:\n" + newContext + "\n\n" +
    "INSTRUCTIONS:\n" +
    "1. Merge these facts into a single, clean context block.\n" +
    "2. If the NEW UPDATE contradicts the OLD MEMORY, the NEW UPDATE wins " +
    "(e.g., if old says Postgres and new says MySQL, keep MySQL).\n" +
    "3. Deduplicate redundant information — don't repeat the same fact twice.\n" +
    "4. Preserve unique facts from both old and new that don't conflict.\n" +
    "5. Return ONLY the consolidated raw text. No markdown, no preamble, " +
    "no explanation — just the merged facts.";

  // Call Gemini to perform the intelligent merge
  const result = await model.generateContent(prompt);

  // Extract and trim the merged text from Gemini's response
  const mergedText = result.response.text().trim();

  // Log the merge result for debugging (to stderr, not stdout)
  console.error(
    "[FactMerger] Merged context (" +
    oldContext.length + " chars old + " +
    newContext.length + " chars new → " +
    mergedText.length + " chars merged)"
  );

  return mergedText;  // return the cleanly merged context
}
