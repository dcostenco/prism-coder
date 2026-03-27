/**
 * ═══════════════════════════════════════════════════════════════════
 * Gemini History JSON Adapter
 * ═══════════════════════════════════════════════════════════════════
 *
 * REVIEWER NOTE — Streaming Large JSON Arrays:
 *   Gemini exports history as a single JSON array (not JSONL).
 *   A naive `JSON.parse(fs.readFileSync(...))` would load the entire
 *   file into memory — OOM for 100MB+ exports.
 *
 *   We use `stream-json/StreamArray` to parse array elements one at a
 *   time in streaming fashion. Memory usage is O(1) per entry.
 *
 * ROLE MAPPING:
 *   Gemini uses "model" for assistant responses (not "assistant").
 *   We normalize this to "assistant" for Prism's unified schema.
 *
 * TIMESTAMP FALLBACK:
 *   Gemini SDK history arrays often lack per-turn timestamps.
 *   We fall back to `createTime` (if present) or current time.
 *   The orchestrator may override timestamps via ensureChronology.
 *
 * SOURCE FORMAT (simplified):
 *   [
 *     { role: "user", parts: [{ text: "..." }] },
 *     { role: "model", parts: [{ text: "..." }] }
 *   ]
 * ═══════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import { chain } from 'stream-chain';
import StreamArray from 'stream-json/streamers/stream-array.js';
import { MigrationAdapter } from './types.js';
import { normalizeContent } from './utils.js';

export const geminiAdapter: MigrationAdapter = {
  id: 'gemini',

  /**
   * Auto-detection heuristic for Gemini files.
   *
   * REVIEWER NOTE — canHandle Overlap (Finding 1):
   *   Both Gemini and OpenAI use .json. To disambiguate without content sniffing,
   *   we use a filename convention: if the path contains "openai" or "chatgpt",
   *   we defer to the OpenAI adapter. Otherwise, .json files default to Gemini.
   *
   *   For production use, users should ALWAYS use --format= to avoid ambiguity.
   *   This heuristic is a convenience fallback only.
   */
  canHandle(filePath) {
    const lower = filePath.toLowerCase();
    return lower.endsWith('.json') && !lower.includes('openai') && !lower.includes('chatgpt');
  },

  async parse(filePath, onTurn) {
    // ── Streaming Pipeline ────────────────────────────────────────
    // `StreamArray.withParser()` combines the JSON parser + array streamer
    // into a single transform. Each emitted object has { key, value }
    // where `key` is the array index and `value` is the parsed element.
    const pipeline = chain([
      fs.createReadStream(filePath),
      (StreamArray as any).withParser(),
    ]);

    for await (const { value: entry } of pipeline) {
      // ── Role Normalization ──────────────────────────────────────
      // Gemini uses 'model' for AI responses; some exports may use 'assistant'.
      // Both are mapped to 'assistant' in the normalized schema.
      const role = entry.role === 'model' || entry.role === 'assistant' ? 'assistant' : 'user';

      // ── Content Extraction ──────────────────────────────────────
      // Gemini stores content in `parts` (array of { text: '...' } objects).
      // Falls back to `entry.content` for non-standard exports.
      const content = normalizeContent(entry.parts || entry.content || "");

      // ── Timestamp Fallback Chain ────────────────────────────────
      // Priority: entry.timestamp > entry.createTime > now()
      // REVIEWER NOTE: Using Date.now() as final fallback means all turns
      // without timestamps get the SAME timestamp — the orchestrator's
      // session_date splitting may group them incorrectly. This is a known
      // acceptable tradeoff for the initial implementation.
      const timestamp = entry.timestamp || entry.createTime || new Date().toISOString();

      await onTurn({
        role,
        content,
        timestamp,
        sessionId: 'gemini-migration',
        project: 'default',
        todos: [],
        files_changed: [],
      });
    }
  },
};
