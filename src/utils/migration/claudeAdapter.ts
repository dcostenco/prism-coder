/**
 * ═══════════════════════════════════════════════════════════════════
 * Claude Code JSONL Adapter
 * ═══════════════════════════════════════════════════════════════════
 *
 * REVIEWER NOTE — Claude Code Streaming Deduplication:
 *   Claude Code does NOT write one clean JSON line per turn. It writes
 *   to the JSONL file DURING streaming. This means you see multiple
 *   JSON lines for the exact same `message.id` as the response streams in.
 *
 *   If we processed every `type: assistant` line blindly, we'd ingest
 *   highly fragmented or duplicate entries. The solution is to aggregate
 *   by `message.id` and only flush the LATEST version of each assistant
 *   message when a user message arrives (or at end-of-file).
 *
 * STREAMING STRATEGY:
 *   Uses Node's readline interface for true line-by-line processing.
 *   Memory usage is O(pending_assistant_chunks), not O(file_size).
 *   For a typical session, pending chunks rarely exceed 2-3 entries.
 *
 * SOURCE FORMAT (simplified):
 *   { type: "assistant", message: { id: "msg_xxx", content: [...] }, timestamp: "..." }
 *   { type: "user", content: "...", timestamp: "..." }
 * ═══════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import readline from 'node:readline';
import { MigrationAdapter, NormalizedTurn } from './types.js';
import { normalizeContent } from './utils.js';

export const claudeAdapter: MigrationAdapter = {
  id: 'claude',

  /**
   * Claude Code uses .jsonl (JSON Lines) format exclusively.
   * This is a reliable heuristic — no other major LLM uses .jsonl for exports.
   */
  canHandle(filePath) {
    return filePath.endsWith('.jsonl');
  },

  async parse(filePath, onTurn) {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity, // Handle both \n and \r\n line endings
    });

    // ── Deduplication Buffer ──────────────────────────────────────
    // Accumulates assistant chunks by message.id. When a user message
    // arrives, we flush all pending assistant messages (keeping only
    // the latest content for each ID) and then emit the user message.
    const pendingAssistantChunks = new Map<string, { content: string; tools: string[]; timestamp: string }>();

    for await (const line of rl) {
      if (!line.trim()) continue; // Skip blank lines
      try {
        const entry = JSON.parse(line);

        // ── Role Detection ─────────────────────────────────────────
        // Claude Code logs have two role indicators:
        //   1. `entry.type` (top-level) — "assistant" or "user"
        //   2. `entry.message.role` (nested) — "assistant" or "user"
        // We check both for robustness.
        const role = entry.type === 'assistant' || entry.message?.role === 'assistant' ? 'assistant' : 'user';

        // ── Content Extraction ─────────────────────────────────────
        // Content can be at `entry.content` or nested at `entry.message.content`.
        // Both may be strings or arrays of content blocks.
        const content = normalizeContent(entry.content || entry.message?.content || "");
        const timestamp = entry.timestamp || new Date().toISOString();

        // ── Message ID for Deduplication ───────────────────────────
        // Claude logs may use `entry.id`, `entry.message.id`, or `entry.requestId`.
        // Any of these can serve as the deduplication key.
        const messageId = entry.id || entry.message?.id || entry.requestId;

        if (role === 'assistant' && messageId) {
          // ── Streaming Chunk Aggregation ────────────────────────────
          // For assistant messages with an ID, we DON'T emit immediately.
          // Instead, we overwrite the buffer entry — the last chunk for a
          // given ID contains the complete content (Claude rewrites the
          // full message in the final streaming chunk).
          pendingAssistantChunks.set(messageId, { content, tools: [], timestamp });
          continue;
        }

        // ── User Message: Flush Pending Assistants ──────────────────
        // A user message signals the end of the previous assistant turn.
        // Flush all pending assistant chunks before emitting the user turn.
        if (role === 'user') {
          for (const [id, msg] of pendingAssistantChunks) {
            await onTurn({
              role: 'assistant',
              content: msg.content,
              timestamp: msg.timestamp,
              sessionId: 'claude-migration',
              project: 'default',
              todos: [],
              files_changed: [],
              messageId: id,
              tools: msg.tools,
            });
          }
          pendingAssistantChunks.clear();

          await onTurn({
            role: 'user',
            content,
            timestamp,
            sessionId: 'claude-migration',
            project: 'default',
            todos: [],
            files_changed: [],
            messageId,
          });
        }
      } catch (e) {
        // ── Malformed Line Handling ──────────────────────────────────
        // Skip lines that fail JSON parsing. This is expected for
        // corrupted exports or partial writes during Claude crashes.
      }
    }

    // ── Final Flush ──────────────────────────────────────────────────
    // If the file ends with assistant messages (no trailing user message),
    // we must flush any remaining pending chunks.
    for (const [id, msg] of pendingAssistantChunks) {
      await onTurn({
        role: 'assistant',
        content: msg.content,
        timestamp: msg.timestamp,
        sessionId: 'claude-migration',
        project: 'default',
        todos: [],
        files_changed: [],
        messageId: id,
        tools: msg.tools,
      });
    }
  },
};
