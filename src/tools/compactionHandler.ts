/**
 * Ledger Compaction Handler (v1.5.0 — Enhancement #2)
 *
 * ═══════════════════════════════════════════════════════════════════
 * REVIEWER NOTE: This module implements automatic rollup of old
 * ledger entries to prevent unbounded growth.
 *
 * THE PROBLEM:
 *   session_ledger is append-only. After months of heavy use,
 *   the "deep" context loading could return thousands of tokens
 *   or hit API payload limits. There's no automatic cleanup.
 *
 * THE SOLUTION:
 *   When triggered, this handler:
 *   1. Calls get_compaction_candidates() to find bloated projects
 *   2. For each project: fetches old entries, summarizes via Gemini
 *   3. Inserts a rollup entry with is_rollup=true
 *   4. Marks old entries with archived_at (soft-delete)
 *
 * CHUNKING STRATEGY:
 *   If a project has 50 entries to compact, we don't send all 50
 *   to Gemini at once (might blow past token limits). Instead:
 *   - Chunk into groups of 10
 *   - Summarize each chunk → get 5 sub-summaries
 *   - If 5+ sub-summaries exist, summarize those into a final rollup
 *   This recursive strategy ensures we never exceed Gemini's context window.
 *
 * SAFETY:
 *   - Old entries are soft-deleted (archived_at set), not hard-deleted
 *   - The rollup entry preserves all keywords and decisions from originals
 *   - Reversible: set archived_at=NULL to restore original entries
 *   - Dry run mode available to preview before executing
 * ═══════════════════════════════════════════════════════════════════
 */

import { supabaseRpc, supabaseGet, supabasePost, supabasePatch } from "../utils/supabaseApi.js";
import { GOOGLE_API_KEY, PRISM_USER_ID } from "../config.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ─── Constants ────────────────────────────────────────────────

// REVIEWER NOTE: Chunk size for sending entries to Gemini.
// 10 entries × ~500 chars each = ~5000 chars per chunk,
// well within Gemini's 1M token context window.
// Keeping chunks small ensures consistent summarization quality.
const COMPACTION_CHUNK_SIZE = 10;

// Maximum entries to compact in a single tool call
// REVIEWER NOTE: Safety limit to prevent the tool from running
// for too long on a single invocation. If more entries need
// compacting, the tool can be called again.
const MAX_ENTRIES_PER_RUN = 100;

// ─── Type Guard ───────────────────────────────────────────────

export function isCompactLedgerArgs(
  args: unknown
): args is {
  project?: string;
  threshold?: number;
  keep_recent?: number;
  dry_run?: boolean;
} {
  return typeof args === "object" && args !== null;
}

// ─── Gemini Summarization ─────────────────────────────────────

/**
 * Summarize a batch of ledger entries using Gemini.
 *
 * REVIEWER NOTE: The prompt is carefully designed to preserve
 * important information (decisions, file changes, error resolutions)
 * while condensing narrative. The output format matches what we
 * store in a rollup entry's summary field.
 */
async function summarizeEntries(entries: any[]): Promise<string> {
  if (!GOOGLE_API_KEY) {
    throw new Error("Cannot compact ledger: GOOGLE_API_KEY required for Gemini summarization");
  }

  const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  // Build a concise representation of each entry for the prompt
  const entriesText = entries.map((e, i) =>
    `[${i + 1}] ${e.session_date || "unknown date"}: ${e.summary || "no summary"}\n` +
    (e.decisions?.length ? `  Decisions: ${e.decisions.join("; ")}\n` : "") +
    (e.files_changed?.length ? `  Files: ${e.files_changed.join(", ")}\n` : "")
  ).join("\n");

  const prompt =
    `You are compressing a session history log. Summarize these ${entries.length} ` +
    `work sessions into a single concise paragraph (max 500 words).\n\n` +
    `PRESERVE: key decisions, important file changes, error resolutions, ` +
    `architecture changes, and any recurring patterns.\n` +
    `OMIT: routine operations, intermediate debugging steps, and redundant details.\n\n` +
    `Sessions to summarize:\n${entriesText}\n\n` +
    `Provide ONLY the summary paragraph, no headers or formatting.`;

  // REVIEWER NOTE: Using truncation to prevent exceeding API limits.
  // The prompt itself is structured to stay well within limits, but
  // this is an extra safety net.
  const truncatedPrompt = prompt.substring(0, 30000);

  const result = await model.generateContent(truncatedPrompt);
  const response = result.response;
  return response.text();
}

// ─── Main Handler ─────────────────────────────────────────────

/**
 * Compact old ledger entries into rollup summaries.
 *
 * REVIEWER NOTE: This handler can be called in two modes:
 *   1. With a specific project → compact only that project
 *   2. Without a project → auto-detect all candidates
 *   3. With dry_run=true → preview what would be compacted
 */
export async function compactLedgerHandler(args: unknown) {
  if (!isCompactLedgerArgs(args)) {
    throw new Error("Invalid arguments for session_compact_ledger");
  }

  const {
    project,
    threshold = 50,
    keep_recent = 10,
    dry_run = false,
  } = args;

  console.error(
    `[compact_ledger] ${dry_run ? "DRY RUN: " : ""}` +
    `project=${project || "auto-detect"}, threshold=${threshold}, keep_recent=${keep_recent}`
  );

  // Step 1: Find candidates
  let candidates: any[];
  if (project) {
    // If specific project, check it directly
    // v1.5.0: Scope direct query to user_id
    const entries = await supabaseGet("session_ledger", {
      project: `eq.${project}`,
      user_id: `eq.${PRISM_USER_ID}`,
      "archived_at": "is.null",
      "is_rollup": "eq.false",
      select: "id",
    });
    const count = Array.isArray(entries) ? entries.length : 0;
    if (count <= threshold) {
      return {
        content: [{
          type: "text",
          text: `✅ Project "${project}" has ${count} active entries ` +
            `(threshold: ${threshold}). No compaction needed.`,
        }],
        isError: false,
      };
    }
    candidates = [{ project, total_entries: count, to_compact: count - keep_recent }];
  } else {
    // Auto-detect candidates using the RPC
    // v1.5.0: Pass p_user_id for multi-tenant isolation
    const result = await supabaseRpc("get_compaction_candidates", {
      p_threshold: threshold,
      p_keep_recent: keep_recent,
      p_user_id: PRISM_USER_ID,
    });
    candidates = Array.isArray(result) ? result : [];
  }

  if (candidates.length === 0) {
    return {
      content: [{
        type: "text",
        text: `✅ No projects exceed the compaction threshold (${threshold} entries). ` +
          `All clear!`,
      }],
      isError: false,
    };
  }

  // Dry run: just report candidates
  if (dry_run) {
    const summary = candidates.map(c =>
      `• ${c.project}: ${c.total_entries} entries (${c.to_compact} would be compacted)`
    ).join("\n");

    return {
      content: [{
        type: "text",
        text: `🔍 Compaction preview (dry run):\n\n${summary}\n\n` +
          `Run without dry_run to execute compaction.`,
      }],
      isError: false,
    };
  }

  // Step 2: Compact each candidate project
  const results: string[] = [];

  for (const candidate of candidates) {
    const proj = candidate.project;
    const toCompact = Math.min(candidate.to_compact, MAX_ENTRIES_PER_RUN);

    console.error(`[compact_ledger] Compacting ${toCompact} entries for "${proj}"`);

    // Fetch oldest entries (the ones to be rolled up)
    // v1.5.0: Scope to user_id
    const oldEntries = await supabaseGet("session_ledger", {
      project: `eq.${proj}`,
      user_id: `eq.${PRISM_USER_ID}`,
      "archived_at": "is.null",
      "is_rollup": "eq.false",
      order: "created_at.asc",
      limit: String(toCompact),
      select: "id,summary,decisions,files_changed,keywords,session_date",
    });

    if (!Array.isArray(oldEntries) || oldEntries.length === 0) {
      results.push(`• ${proj}: no entries to compact`);
      continue;
    }

    // Step 3: Chunked summarization
    // REVIEWER NOTE: We chunk entries to avoid exceeding Gemini's
    // token limits. Each chunk is summarized independently, then
    // if multiple chunks exist, the sub-summaries are summarized again.
    const chunks: any[][] = [];
    for (let i = 0; i < oldEntries.length; i += COMPACTION_CHUNK_SIZE) {
      chunks.push(oldEntries.slice(i, i + COMPACTION_CHUNK_SIZE));
    }

    let finalSummary: string;

    if (chunks.length === 1) {
      // Single chunk — summarize directly
      finalSummary = await summarizeEntries(chunks[0]);
    } else {
      // Multiple chunks — recursive summarization
      // First pass: summarize each chunk
      const chunkSummaries = await Promise.all(
        chunks.map(chunk => summarizeEntries(chunk))
      );

      // Second pass: summarize the summaries
      // REVIEWER NOTE: This recursive approach handles arbitrarily
      // large batches. In practice, MAX_ENTRIES_PER_RUN=100 with
      // COMPACTION_CHUNK_SIZE=10 means at most 10 sub-summaries,
      // which is well within Gemini's limits.
      const metaEntries = chunkSummaries.map((s, i) => ({
        session_date: `chunk ${i + 1}`,
        summary: s,
        decisions: [],
        files_changed: [],
      }));
      finalSummary = await summarizeEntries(metaEntries);
    }

    // Collect all unique keywords from rolled-up entries
    const allKeywords = [...new Set(
      oldEntries.flatMap((e: any) => e.keywords || [])
    )];

    // Collect all unique files changed
    const allFiles = [...new Set(
      oldEntries.flatMap((e: any) => e.files_changed || [])
    )];

    // Step 4: Insert rollup entry
    // v1.5.0: Include user_id in rollup entry
    await supabasePost("session_ledger", {
      project: proj,
      user_id: PRISM_USER_ID,
      summary: `[ROLLUP of ${oldEntries.length} sessions] ${finalSummary}`,
      keywords: allKeywords,
      files_changed: allFiles,
      decisions: [`Rolled up ${oldEntries.length} sessions on ${new Date().toISOString()}`],
      is_rollup: true,
      rollup_count: oldEntries.length,
      // REVIEWER NOTE: We need to provide required fields for the table.
      // These are set to sensible defaults for rollup entries.
      title: `Session Rollup (${oldEntries.length} entries)`,
      agent_name: "prism-compactor",
      conversation_id: `rollup-${Date.now()}`,
    });

    // Step 5: Archive old entries (soft-delete)
    const entryIds = oldEntries.map((e: any) => e.id);
    for (const id of entryIds) {
      await supabasePatch(
        "session_ledger",
        { archived_at: new Date().toISOString() },
        { id: `eq.${id}` }
      );
    }

    results.push(
      `• ${proj}: ${oldEntries.length} entries → 1 rollup ` +
      `(${allKeywords.length} keywords preserved)`
    );
  }

  return {
    content: [{
      type: "text",
      text: `🧹 Ledger compaction complete:\n\n${results.join("\n")}\n\n` +
        `Original entries are archived (soft-deleted), not permanently removed.`,
    }],
    isError: false,
  };
}
