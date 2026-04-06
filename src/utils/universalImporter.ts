#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════
 * Universal History Importer — Strategy Pattern Orchestrator
 * ═══════════════════════════════════════════════════════════════════
 *
 * REVIEWER NOTE — Architecture:
 *   This module serves two purposes:
 *   1. LIBRARY: The `universalImporter()` function is importable for
 *      programmatic use (e.g., tests, future MCP tool integration).
 *   2. CLI: The `runCLI()` function parses argv and invokes the library.
 *
 *   The CLI entry point is guarded by an `isMain` check so importing
 *   this module in tests doesn't trigger `process.exit()`.
 *
 * CONVERSATION GROUPING (v5.2.1):
 *   Individual turns are grouped into logical conversations using a
 *   time-gap heuristic (default: 30 minutes of silence = new conversation).
 *   Each conversation is stored as ONE summary ledger entry, not per-turn.
 *   This prevents a 100MB import from creating 50,000 individual rows.
 *
 * DEDUPLICATION:
 *   Each conversation gets a deterministic ID based on adapter + start
 *   timestamp. Before writing, we check if that conversation_id already
 *   exists for user_id "universal-migration-tool". Re-running the same
 *   import is a no-op.
 *
 * CONCURRENCY:
 *   Uses `p-limit(5)` to cap parallel database writes. Without this,
 *   ingesting many conversations would saturate SQLite's write lock or
 *   exhaust Supabase connection pool limits.
 *
 * ADAPTER RESOLUTION:
 *   Priority: explicit --format= flag > canHandle() auto-detection.
 *   Auto-detection is filename-based (see each adapter's canHandle docs).
 *   For ambiguous files, --format= is mandatory.
 * ═══════════════════════════════════════════════════════════════════
 */

import { getStorage } from "../storage/index.js";
import { claudeAdapter } from "./migration/claudeAdapter.js";
import { geminiAdapter } from "./migration/geminiAdapter.js";
import { openaiAdapter } from "./migration/openaiAdapter.js";
import { MigrationAdapter } from "./migration/types.js";
import { NormalizedTurn } from "./migration/types.js";
import { sniffFormat } from "./migration/utils.js";
import pLimit from "p-limit";

// ── Adapter Registry ──────────────────────────────────────────────
// Order matters for auto-detection: Claude (.jsonl) is unambiguous,
// so it's checked first. Gemini/OpenAI both use .json, and are
// disambiguated by filename conventions (see canHandle docs).
// If filename detection fails, content-sniffing is used as a fallback.
const adapters: MigrationAdapter[] = [claudeAdapter, geminiAdapter, openaiAdapter];

// ── Conversation Grouping Constants ──────────────────────────────
// A gap of 30+ minutes between turns signals a new conversation.
// This matches typical coding session patterns: developers take breaks,
// switch tasks, or come back the next day.
const CONVERSATION_GAP_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Configuration for the universal importer.
 * All fields except `path` are optional with sensible defaults.
 */
export interface ImportOptions {
  path: string;          // Absolute or relative path to the source file
  format?: string;       // Explicit adapter ID ('claude', 'gemini', 'openai')
  project?: string;      // Target Prism project name (overrides adapter default)
  dryRun?: boolean;      // Process and validate without writing to storage
  verbose?: boolean;     // Print each turn as it's processed
}

/**
 * Build a human-readable summary from a group of conversation turns.
 *
 * Output format:
 *   [Imported] <first user message (truncated to 300 chars)>
 *
 *   Conversation: X turns (Y user, Z assistant)
 *   Time range: <start> → <end>
 *   Tools used: tool1, tool2, ...    (if any)
 */
function buildConversationSummary(turns: NormalizedTurn[]): string {
  const firstUserTurn = turns.find(t => t.role === 'user');
  const turnCount = turns.length;
  const userTurnCount = turns.filter(t => t.role === 'user').length;
  const assistantTurnCount = turns.filter(t => t.role === 'assistant').length;

  const startTime = turns[0].timestamp;
  const endTime = turns[turns.length - 1].timestamp;

  // Topic: first user message, truncated for readability
  const topic = firstUserTurn
    ? firstUserTurn.content.substring(0, 300).replace(/\n/g, ' ').trim()
    : 'No user message';

  // Collect all unique tools used across the conversation
  const allTools = [...new Set(turns.flatMap(t => t.tools || []).filter(Boolean))];
  const toolsSummary = allTools.length > 0 ? `\nTools used: ${allTools.join(', ')}` : '';

  // Collect all unique files referenced
  const allFiles = [...new Set(turns.flatMap(t => t.files_changed || []).filter(Boolean))];
  const filesSummary = allFiles.length > 0 ? `\nFiles: ${allFiles.slice(0, 10).join(', ')}${allFiles.length > 10 ? ` (+${allFiles.length - 10} more)` : ''}` : '';

  return `[Imported] ${topic}\n\n` +
    `Conversation: ${turnCount} turns (${userTurnCount} user, ${assistantTurnCount} assistant)\n` +
    `Time range: ${startTime} → ${endTime}` +
    toolsSummary +
    filesSummary;
}

/**
 * Generate a deterministic conversation_id from adapter name + start timestamp.
 * Ensures re-running the same import produces the same IDs for dedup.
 */
function makeConversationId(adapterId: string, firstTimestamp: string): string {
  // Use epoch ms for uniqueness, but keep human-readable prefix
  const epoch = new Date(firstTimestamp).getTime();
  return `import-${adapterId}-${epoch}`;
}

/**
 * Core migration function — importable for programmatic use.
 *
 * REVIEWER NOTE — Conversation Grouping Pipeline:
 *   1. Adapter streams individual turns via onTurn callback
 *   2. Turns are buffered and grouped by 30-min time gaps
 *   3. Each conversation group is summarized into ONE ledger entry
 *   4. Duplicate conversations (same conversation_id) are skipped
 *
 *   This means a 100MB file with 200 conversations → 200 ledger entries,
 *   NOT 50,000 individual turn rows.
 */
export async function universalImporter(options: ImportOptions) {
  const { path: filePathArg, format: formatArg, project: projectArg, dryRun, verbose } = options;

  // ── Adapter Resolution (Three-Stage Pipeline) ───────────────────
  // Stage 1: Explicit --format= flag (highest priority, always correct)
  // Stage 2: Filename-based canHandle() heuristic (fast, reliable for .jsonl)
  // Stage 3: Content-sniffing fallback (reads first 4KB to detect markers)
  let adapter: MigrationAdapter | undefined;

  if (formatArg) {
    // Stage 1: Explicit format flag
    adapter = adapters.find((a) => a.id === formatArg);
  }

  if (!adapter) {
    // Stage 2: Filename-based auto-detection
    adapter = adapters.find((a) => a.canHandle(filePathArg));
  }

  if (!adapter) {
    // Stage 3: Content-sniffing fallback
    const sniffed = sniffFormat(filePathArg);
    if (sniffed) {
      adapter = adapters.find((a) => a.id === sniffed);
      if (adapter) {
        console.log(`🔍 Auto-detected format: ${sniffed} (via content sniffing)`);
      }
    }
  }

  if (!adapter) {
    throw new Error(`Could not determine adapter for file: ${filePathArg}. Use --format to specify.`);
  }

  console.log(`🚀 Starting migration from ${adapter.id} to Prism...`);
  if (dryRun) console.log("⚠️ DRY RUN MODE - storage writes disabled.");

  // ── Storage + Concurrency ──────────────────────────────────────
  const storage = await getStorage();
  const limit = pLimit(5);

  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;
  let conversationCount = 0;

  // ── Conversation Grouping Buffer ───────────────────────────────
  // Accumulates turns until a time gap > 30 min is detected,
  // then flushes the buffer as one conversation summary.
  let conversationBuffer: NormalizedTurn[] = [];
  let lastTurnTime: Date | null = null;

  /**
   * Flush the current conversation buffer as a single ledger entry.
   * Called when a time gap is detected or at end-of-file.
   */
  async function flushConversation() {
    if (conversationBuffer.length === 0) return;

    const turns = conversationBuffer;
    conversationBuffer = []; // Reset buffer immediately

    const targetProject = projectArg || turns[0].project || "default";
    const conversationId = makeConversationId(adapter!.id, turns[0].timestamp);
    const summary = buildConversationSummary(turns);

    // Collect metadata from all turns
    const allTools = [...new Set(turns.flatMap(t => t.tools || []).filter(Boolean))];
    const allFiles = [...new Set(turns.flatMap(t => t.files_changed || []).filter(Boolean))];
    const sessionDate = turns[0].timestamp.split("T")[0]; // YYYY-MM-DD

    conversationCount++;

    if (verbose) {
      const turnCount = turns.length;
      console.log(`📦 Conversation #${conversationCount}: ${turnCount} turns (${sessionDate}) → ${conversationId}`);
    }

    if (dryRun) {
      successCount += turns.length;
      return;
    }

    try {
      // ── Deduplication Check ──────────────────────────────────────
      // Query existing entries with the same deterministic conversation_id
      // and migration user_id. If found, skip — this conversation was
      // already imported in a previous run.
      const existing = await storage.getLedgerEntries({
        conversation_id: `eq.${conversationId}`,
        user_id: 'eq.universal-migration-tool',
        limit: '1',
      });

      if ((existing as any[]).length > 0) {
        skipCount += turns.length;
        if (verbose) {
          console.log(`⏭️  Skipping duplicate: ${conversationId}`);
        }
        return;
      }

      // ── Store Single Summary Entry ──────────────────────────────
      await limit(() =>
        storage.saveLedger({
          project: targetProject,
          conversation_id: conversationId,
          user_id: "universal-migration-tool",
          role: "global",
          summary,
          created_at: turns[0].timestamp,
          session_date: sessionDate,
          todos: [],
          files_changed: allFiles,
          keywords: allTools,
        })
      );

      successCount += turns.length;
    } catch (err) {
      failCount += turns.length;
      if (verbose) console.error(`Failed to ingest conversation ${conversationId}:`, err);
    }
  }

  try {
    // ── Streaming Parse + Conversation Windowing ──────────────────
    // Memory usage: O(turns_per_conversation), NOT O(file_size).
    // A typical conversation is 20-200 turns — easily fits in memory.
    await adapter.parse(filePathArg, async (turn) => {
      const turnTime = new Date(turn.timestamp);

      // Detect conversation boundary: time gap > 30 min
      if (lastTurnTime && (turnTime.getTime() - lastTurnTime.getTime()) > CONVERSATION_GAP_MS) {
        await flushConversation();
      }

      conversationBuffer.push(turn);
      lastTurnTime = turnTime;
    });

    // ── Final Flush ──────────────────────────────────────────────
    // Flush the last conversation (no trailing time gap to trigger it)
    await flushConversation();

    console.log("\n✅ Migration complete!");
    console.log(`   Conversations: ${conversationCount}`);
    console.log(`   Turns processed: ${successCount}`);
    if (skipCount > 0) console.log(`   Skipped (dup): ${skipCount}`);
    if (failCount > 0) console.log(`   Failed:         ${failCount}`);

    return { successCount, failCount, skipCount, conversationCount };
  } catch (err) {
    console.error("\n❌ Fatal error during migration:", err);
    throw err;
  } finally {
    // ── Cleanup ────────────────────────────────────────────────────
    // Close DB handle if running as standalone CLI (not in server context).
    if (typeof (storage as any).close === 'function') {
      await (storage as any).close();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// CLI Entry Point — only runs when invoked directly via `node`
// ═══════════════════════════════════════════════════════════════════

async function runCLI() {
  const args = process.argv.slice(2);
  const filePathArg = args.find((a) => !a.startsWith("-"));
  const formatArg = args.find((a) => a.startsWith("--format="))?.split("=")[1];
  const projectArg = args.find((a) => a.startsWith("--project="))?.split("=")[1];
  const dryRun = args.includes("--dry-run") || args.includes("-d");
  const verbose = args.includes("--verbose") || args.includes("-v");

  if (!filePathArg) {
    console.log(`
Prism Universal History Importer
Usage: node universalImporter.js <file> [options]

Options:
  --format=<claude|gemini|openai>  Force a specific format adapter
  --project=<name>                Override target project name (default: "default")
  --dry-run, -d                   Process and validate without saving to storage
  --verbose, -v                   Print detailed turn information during processing
    `);
    process.exit(0);
  }

  try {
    await universalImporter({
      path: filePathArg,
      format: formatArg,
      project: projectArg,
      dryRun,
      verbose
    });
  } catch (err) {
    process.exit(1);
  }
}

// ── Main Guard ─────────────────────────────────────────────────────
// Only invoke CLI when this file is the direct entry point.
// Importing this module from tests or other code won't trigger CLI.
const isMain = process.argv[1]?.includes('universalImporter');
if (isMain) {
  runCLI();
}
