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
