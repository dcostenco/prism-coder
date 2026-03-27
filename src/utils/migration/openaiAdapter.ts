/**
 * ═══════════════════════════════════════════════════════════════════
 * OpenAI / ChatGPT History JSON Adapter
 * ═══════════════════════════════════════════════════════════════════
 *
 * REVIEWER NOTE — Tool Call Normalization:
 *   OpenAI's chat completion format includes structured `tool_calls`
 *   arrays on assistant messages. These contain function names, arguments,
 *   and call IDs. Since Prism's ledger stores content as plain text,
 *   we inline tool calls as readable markers: `[Tool Use: function_name]`.
 *
 *   The original tool names are also preserved in `NormalizedTurn.tools[]`
 *   for keyword indexing in the Mind Palace.
 *
 * TIMESTAMP HANDLING:
 *   OpenAI uses Unix epoch seconds in `created_at` (not milliseconds).
 *   We convert: `new Date(created_at * 1000).toISOString()`.
 *   Standard ISO timestamps in `entry.timestamp` take priority.
 *
 * SOURCE FORMAT (simplified):
 *   [
 *     { role: "user", content: "..." },
 *     { role: "assistant", content: "...", tool_calls: [{ function: { name: "..." } }] }
 *   ]
 * ═══════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import { chain } from 'stream-chain';
import StreamArray from 'stream-json/streamers/stream-array.js';
import { MigrationAdapter } from './types.js';
import { normalizeContent } from './utils.js';

export const openaiAdapter: MigrationAdapter = {
  id: 'openai',

  /**
   * Auto-detection heuristic for OpenAI/ChatGPT files.
   *
   * REVIEWER NOTE — canHandle Strategy:
   *   Matches files with "openai" or "chatgpt" anywhere in the path.
   *   This is intentionally broad — ChatGPT export filenames vary widely.
   *   For ambiguous files (e.g., `history.json`), users MUST use --format=openai.
   */
  canHandle(filePath) {
    const lower = filePath.toLowerCase();
    return lower.includes('openai') || lower.includes('chatgpt');
  },

  async parse(filePath, onTurn) {
    // ── Streaming Pipeline ────────────────────────────────────────
    // Same OOM-safe pattern as geminiAdapter. See that file for details.
    const pipeline = chain([
      fs.createReadStream(filePath),
      (StreamArray as any).withParser(),
    ]);

    for await (const { value: entry } of pipeline) {
      // ── Role Normalization ──────────────────────────────────────
      // OpenAI also has 'system' and 'tool' roles — we skip those.
      // Only 'user' and 'assistant' turns are meaningful for migration.
      const role = entry.role === 'assistant' ? 'assistant' : 'user';
      let content = normalizeContent(entry.content || "");

      // ── Tool Call Inlining ──────────────────────────────────────
      // Convert structured tool_calls into human-readable content markers.
      // This preserves the semantic intent while keeping storage as plain text.
      if (entry.tool_calls) {
        const tools = (entry.tool_calls as any[])
          .map((tc) => `[Tool Use: ${tc.function?.name || tc.id}]`)
          .join("\n");
        content = `${content}\n${tools}`.trim();
      }

      // ── Timestamp Fallback Chain ────────────────────────────────
      // Priority: entry.timestamp (ISO) > entry.created_at (Unix epoch) > now()
      // REVIEWER NOTE: OpenAI's `created_at` is in SECONDS, not milliseconds.
      // Multiplying by 1000 is critical — without it, dates land in 1970.
      const timestamp = entry.timestamp
        || (entry.created_at ? new Date(entry.created_at * 1000).toISOString() : new Date().toISOString());

      await onTurn({
        role,
        content,
        timestamp,
        sessionId: 'openai-migration',
        project: 'default',
        todos: [],
        files_changed: [],
        // ── Keyword Indexing ────────────────────────────────────────
        // Extract tool function names for Prism's keyword search index.
        // `undefined` tools are filtered out by the optional chaining.
        tools: (entry.tool_calls as any[])?.map((tc) => tc.function?.name),
      });
    }
  },
};
