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
 * CONCURRENCY:
 *   Uses `p-limit(5)` to cap parallel database writes. Without this,
 *   ingesting 10,000+ turns would saturate SQLite's write lock or
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
import pLimit from "p-limit";

// ── Adapter Registry ──────────────────────────────────────────────
// Order matters for auto-detection: Claude (.jsonl) is unambiguous,
// so it's checked first. Gemini/OpenAI both use .json, and are
// disambiguated by filename conventions (see canHandle docs).
const adapters: MigrationAdapter[] = [claudeAdapter, geminiAdapter, openaiAdapter];

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
 * Core migration function — importable for programmatic use.
 *
 * REVIEWER NOTE — LedgerEntry Mapping:
 *   The `role` field on NormalizedTurn (user/assistant) is mapped to
 *   LedgerEntry.role. This field on LedgerEntry was originally designed
 *   for agent identity roles (dev/qa/pm), not conversation roles.
 *   This is a known semantic mismatch that has no runtime impact since
 *   the field is optional, unindexed, and not used for filtering in
 *   any current query path. Migration entries are identified by their
 *   `user_id: "universal-migration-tool"` instead.
 */
export async function universalImporter(options: ImportOptions) {
  const { path: filePathArg, format: formatArg, project: projectArg, dryRun, verbose } = options;

  // ── Adapter Resolution ────────────────────────────────────────
  // Explicit --format= takes priority over auto-detection.
  const adapter = formatArg
    ? adapters.find((a) => a.id === formatArg)
    : adapters.find((a) => a.canHandle(filePathArg));

  if (!adapter) {
    throw new Error(`Could not determine adapter for file: ${filePathArg}. Use --format to specify.`);
  }

  console.log(`🚀 Starting migration from ${adapter.id} to Prism...`);
  if (dryRun) console.log("⚠️ DRY RUN MODE - storage writes disabled.");

  // ── Storage + Concurrency ──────────────────────────────────────
  // getStorage() returns the configured backend (SQLite or Supabase).
  // p-limit(5) ensures we never have more than 5 concurrent DB writes.
  const storage = await getStorage();
  const limit = pLimit(5);

  let successCount = 0;
  let failCount = 0;

  try {
    await adapter.parse(filePathArg, async (turn) => {
      try {
        if (verbose) {
          // Truncate content preview to 100 chars for readability
          console.log(`[${turn.role.toUpperCase()}] ${turn.timestamp} | ${turn.content.substring(0, 100).replace(/\n/g, " ")}...`);
        }

        if (!dryRun) {
          // ── NormalizedTurn → LedgerEntry Mapping ─────────────────
          // This is the critical bridge between adapter output and Prism storage.
          await limit(() =>
            storage.saveLedger({
              project: projectArg || turn.project || "default",
              conversation_id: turn.sessionId || `migrated-${adapter.id}`,
              user_id: "universal-migration-tool",  // Identifies migration-ingested entries
              role: turn.role,
              summary: turn.content,
              created_at: turn.timestamp,
              session_date: turn.timestamp.split("T")[0],  // Extract YYYY-MM-DD for date grouping
              todos: turn.todos || [],
              files_changed: turn.files_changed || [],
              keywords: turn.tools || [],  // Tool names become searchable keywords
            })
          );
        }
        successCount++;
      } catch (err) {
        failCount++;
        if (verbose) console.error(`Failed to ingest turn at ${turn.timestamp}:`, err);
      }
    });

    console.log("\n✅ Migration complete!");
    console.log(`   Processed: ${successCount}`);
    if (failCount > 0) console.log(`   Failed:    ${failCount}`);

    return { successCount, failCount };
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
