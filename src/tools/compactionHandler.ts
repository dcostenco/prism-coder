/**
 * Ledger Compaction Handler (v2.0 — StorageBackend Refactor)
 *
 * ═══════════════════════════════════════════════════════════════════
 * v2.0 CHANGES: Replaced direct supabaseGet/Post/Rpc/Patch calls
 * with StorageBackend methods via getStorage(). Zero behavior change.
 * ═══════════════════════════════════════════════════════════════════
 */

import { getStorage } from "../storage/index.js";
import { GOOGLE_API_KEY, PRISM_USER_ID } from "../config.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ─── Constants ────────────────────────────────────────────────

const COMPACTION_CHUNK_SIZE = 10;
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

async function summarizeEntries(entries: any[]): Promise<string> {
  if (!GOOGLE_API_KEY) {
    throw new Error("Cannot compact ledger: GOOGLE_API_KEY required for Gemini summarization");
  }

  const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

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

  const truncatedPrompt = prompt.substring(0, 30000);

  const result = await model.generateContent(truncatedPrompt);
  const response = result.response;
  return response.text();
}

// ─── Main Handler ─────────────────────────────────────────────

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

  const storage = await getStorage();

  // Step 1: Find candidates
  let candidates: any[];
  if (project) {
    // If specific project, check it directly
    const entries = await storage.getLedgerEntries({
      project: `eq.${project}`,
      user_id: `eq.${PRISM_USER_ID}`,
      "archived_at": "is.null",
      "is_rollup": "eq.false",
      select: "id",
    });
    const count = entries.length;
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
    // Auto-detect candidates using storage backend
    candidates = await storage.getCompactionCandidates(threshold, keep_recent, PRISM_USER_ID);
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
    const oldEntries = await storage.getLedgerEntries({
      project: `eq.${proj}`,
      user_id: `eq.${PRISM_USER_ID}`,
      "archived_at": "is.null",
      "is_rollup": "eq.false",
      order: "created_at.asc",
      limit: String(toCompact),
      select: "id,summary,decisions,files_changed,keywords,session_date",
    });

    if (oldEntries.length === 0) {
      results.push(`• ${proj}: no entries to compact`);
      continue;
    }

    // Step 3: Chunked summarization
    const chunks: any[][] = [];
    for (let i = 0; i < oldEntries.length; i += COMPACTION_CHUNK_SIZE) {
      chunks.push(oldEntries.slice(i, i + COMPACTION_CHUNK_SIZE));
    }

    let finalSummary: string;

    if (chunks.length === 1) {
      finalSummary = await summarizeEntries(chunks[0]);
    } else {
      const chunkSummaries = await Promise.all(
        chunks.map(chunk => summarizeEntries(chunk))
      );

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

    // Step 4: Insert rollup entry via storage backend
    await storage.saveLedger({
      project: proj,
      user_id: PRISM_USER_ID,
      summary: `[ROLLUP of ${oldEntries.length} sessions] ${finalSummary}`,
      keywords: allKeywords,
      files_changed: allFiles,
      decisions: [`Rolled up ${oldEntries.length} sessions on ${new Date().toISOString()}`],
      is_rollup: true,
      rollup_count: oldEntries.length,
      conversation_id: `rollup-${Date.now()}`,
    });

    // Step 5: Archive old entries (soft-delete)
    for (const entry of oldEntries) {
      await storage.patchLedger((entry as any).id, {
        archived_at: new Date().toISOString(),
      });
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
