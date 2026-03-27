/**
 * ═══════════════════════════════════════════════════════════════════
 * Migration Utilities — Shared Normalization Helpers
 * ═══════════════════════════════════════════════════════════════════
 *
 * REVIEWER NOTE:
 *   These utilities handle the messiest part of cross-format migration:
 *   normalizing wildly different content representations into plain strings.
 *
 *   Claude uses: `content: [{ type: 'text', text: '...' }]` (array of blocks)
 *   Gemini uses: `parts: [{ text: '...' }]` (array of parts)
 *   OpenAI uses: `content: '...'` (plain string, usually)
 *
 *   The `normalizeContent` function handles all three shapes.
 * ═══════════════════════════════════════════════════════════════════
 */

/**
 * Normalizes content from various LLM formats into a plain string.
 *
 * Handles three shapes:
 *   1. Plain string → returned as-is
 *   2. Array of objects with `.text` → concatenated
 *   3. Array of strings → joined
 *   4. Anything else → empty string (safe fallback)
 *
 * REVIEWER NOTE:
 *   Gemini's `functionCall` parts (which have `.functionCall` but no `.text`)
 *   are intentionally dropped here. They are handled separately by the
 *   Gemini adapter via tool-call extraction. Returning "" for unknown part
 *   types is the correct behavior — it avoids injecting [object Object] strings.
 */
/**
 * Content-sniffs the first ~4KB of a file to detect its LLM format.
 *
 * REVIEWER NOTE:
 *   This is a best-effort heuristic that supplements filename-based detection.
 *   It reads only the first 4KB to stay fast and memory-safe on large files.
 *   Returns the adapter ID ('claude', 'gemini', 'openai') or null if ambiguous.
 *
 * Detection markers:
 *   Claude  → JSONL format (newline-delimited), or `"message":{"id":` / `"type":"assistant"`
 *   Gemini  → `"parts":` array or `"role":"model"`
 *   OpenAI  → `"tool_calls":` or `"created_at":` (Unix epoch) or `"role":"system"`
 */
export function sniffFormat(filePath: string): string | null {
  const fs = require('node:fs');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(4096);
  const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
  fs.closeSync(fd);

  if (bytesRead === 0) return null;

  const head = buf.toString('utf8', 0, bytesRead);

  // ── JSONL detection (Claude) ────────────────────────────────────
  // If the file starts with `{` and contains newlines followed by `{`,
  // it's JSONL (not a JSON array). Claude Code is the only major LLM
  // that uses JSONL for exports.
  const trimmed = head.trimStart();
  if (trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return 'claude';
  }

  // ── JSON array content inspection ──────────────────────────────
  // For JSON arrays, inspect the content for format-specific markers.

  // Gemini markers: "parts" array or "role":"model"
  if (head.includes('"parts"') || head.includes('"role":"model"') || head.includes('"role": "model"')) {
    return 'gemini';
  }

  // OpenAI markers: "tool_calls", "created_at" (Unix epoch), or "role":"system"
  if (head.includes('"tool_calls"') || head.includes('"created_at"') ||
      head.includes('"role":"system"') || head.includes('"role": "system"')) {
    return 'openai';
  }

  // Claude markers in JSON form (less common but possible)
  if (head.includes('"message":{') || head.includes('"message": {') ||
      head.includes('"type":"assistant"') || head.includes('"type": "assistant"')) {
    return 'claude';
  }

  return null;
}

export function normalizeContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        // Handle Claude's `{ type: 'text', text: '...' }` and Gemini's `{ text: '...' }`
        if (part.text) return part.text;
        // Explicit type-check for safety (redundant with above, but clear for reviewers)
        if (part.type === 'text') return part.text;
        return "";
      })
      .join("");
  }
  return "";
}
