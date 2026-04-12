#!/usr/bin/env node

import { Command } from 'commander';
import { SqliteStorage } from './storage/sqlite.js';
import { handleVerifyStatus, handleGenerateHarness } from './verification/cliHandler.js';
import * as path from 'path';
import { getStorage, closeStorage } from './storage/index.js';
import { getSetting } from './storage/configStorage.js';
import { PRISM_USER_ID, SERVER_CONFIG } from './config.js';
import { getCurrentGitState } from './utils/git.js';
import { sessionLoadContextHandler, sessionSaveLedgerHandler, sessionSaveHandoffHandler } from './tools/ledgerHandlers.js';

const program = new Command();

program
  .name('prism')
  .description('Prism — The Mind Palace for AI Agents')
  .version(SERVER_CONFIG.version);

// ─── prism load <project> ─────────────────────────────────────
// Loads session context using the same storage layer as the MCP
// session_load_context tool. Works with both SQLite and Supabase.
// Designed for environments that cannot use MCP tools directly
// (Antigravity, Bash scripts, CI/CD pipelines).
//
// CRITICAL: --storage flag (v9.2.2)
// When multiple MCP clients use different storage backends (e.g.
// Claude Desktop → Supabase, Antigravity → SQLite), the CLI must
// be told which backend to read from. Without this, the CLI
// inherits PRISM_STORAGE from the shell env (defaulting to
// supabase), which may differ from the MCP server's config.
// This causes a "split-brain" where the CLI returns stale state
// from the wrong backend.
//
// TEXT MODE: Delegates to the real sessionLoadContextHandler for
// full feature parity — morning briefing, reality drift detection,
// SDM recall, visual memory, skill injection, behavioral warnings,
// importance scores, recent validations. Any future MCP enrichments
// automatically appear in CLI too.
//
// JSON MODE: Structured envelope for programmatic consumption
// (session loader scripts, CI/CD pipelines, etc.).

program
  .command('load <project>')
  .description('Load session context for a project (same output as session_load_context MCP tool)')
  .option('-l, --level <level>', 'Context depth: quick, standard, deep', 'standard')
  .option('-r, --role <role>', 'Role scope for context loading')
  .option('-s, --storage <backend>', 'Storage backend: local (SQLite) or supabase. Overrides PRISM_STORAGE env var.')
  .option('--json', 'Emit machine-readable JSON instead of formatted text')
  .action(async (project: string, options: { level: string; role?: string; storage?: string; json?: boolean }) => {
    try {
      const { level, role, storage, json: jsonOutput } = options;

      // v9.2.2: --storage flag overrides PRISM_STORAGE env var to prevent
      // split-brain when CLI environment differs from MCP server config.
      if (storage) {
        const validStorages = ['local', 'supabase'];
        if (!validStorages.includes(storage)) {
          console.error(`Error: Invalid storage "${storage}". Must be one of: ${validStorages.join(', ')}`);
          process.exit(1);
        }
        process.env.PRISM_STORAGE = storage;
      }

      const validLevels = ['quick', 'standard', 'deep'];
      if (!validLevels.includes(level)) {
        console.error(`Error: Invalid level "${level}". Must be one of: ${validLevels.join(', ')}`);
        process.exit(1);
      }

      if (jsonOutput) {
        // ── JSON mode: structured output for programmatic consumption ──
        const storageBackend = await getStorage();
        const effectiveRole = role || await getSetting('default_role', '') || undefined;
        const agentName = await getSetting('agent_name', '') || undefined;
        const data = await storageBackend.loadContext(project, level, PRISM_USER_ID, effectiveRole);

        if (!data) {
          console.log(JSON.stringify({ error: `No session context found for project "${project}"` }));
          await closeStorage();
          process.exit(0);
        }

        const d = data as Record<string, any>;
        const gitState = getCurrentGitState();

        const output = {
          agent_name: agentName || null,
          handoff: [{
            project,
            role: effectiveRole || d.role || 'global',
            last_summary: d.last_summary || null,
            pending_todo: d.pending_todo || null,
            active_decisions: d.active_decisions || null,
            keywords: d.keywords || null,
            key_context: d.key_context || null,
            active_branch: d.active_branch || null,
            version: d.version ?? null,
            updated_at: d.updated_at || null,
          }],
          recent_ledger: (d.recent_sessions || []).map((s: any) => ({
            summary: s.summary || null,
            decisions: s.decisions || null,
            keywords: s.keywords || null,
            created_at: s.session_date || s.created_at || null,
          })),
          git_hash: gitState.commitSha ? gitState.commitSha.substring(0, 7) : null,
          git_branch: gitState.branch || null,
          pkg_version: SERVER_CONFIG.version,
        };
        console.log(JSON.stringify(output, null, 2));
      } else {
        // ── Text mode: full parity with MCP session_load_context ──
        // Delegates to the real handler so all enrichments (morning briefing,
        // reality drift, SDM recall, visual memory, skill injection,
        // behavioral warnings, etc.) are included automatically.
        const result = await sessionLoadContextHandler({ project, level, role });

        // Surface handler-level errors (e.g. invalid args, storage failures)
        if (result.isError) {
          console.error((result.content[0] as any)?.text || 'Unknown error loading context');
          await closeStorage();
          process.exit(1);
        }

        let output = '';
        if (result.content?.[0]) {
          output = (result.content[0] as any).text;
        }

        // Append git state (not included in the MCP handler output)
        const gitState = getCurrentGitState();
        if (gitState.isRepo) {
          output += `\n\n🔧 Git: ${gitState.branch} @ ${gitState.commitSha?.substring(0, 7)} (Prism v${SERVER_CONFIG.version})`;
        }

        console.log(output);
      }

      await closeStorage();
    } catch (err) {
      console.error(`Error loading context: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => {});
      process.exit(1);
    }
  });

// ─── prism save ───────────────────────────────────────────────
// Saves session state using the same storage layer as the MCP
// session_save_ledger and session_save_handoff tools. Works with
// both SQLite and Supabase.
//
// Designed for Antigravity and other environments that cannot use
// MCP tools directly. This is the counterpart to `prism load`.
//
// Two subcommands:
//   prism save ledger <project>  — append immutable session log entry
//   prism save handoff <project> — update live project state for next session

const saveCmd = program
  .command('save')
  .description('Save session state (ledger entries and handoff)');

/**
 * Parse a CLI string argument that may be a JSON array or a plain string.
 * Returns string[] for arrays, wraps plain strings in an array.
 */
function parseJsonArrayArg(val: string | undefined, fieldName: string): string[] | undefined {
  if (!val) return undefined;
  const trimmed = val.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      return parsed.map(String);
    } catch (err) {
      console.error(`Error: --${fieldName} must be a valid JSON array. Got: ${trimmed}`);
      process.exit(1);
    }
  }
  // Plain string → single-element array
  return [trimmed];
}

saveCmd
  .command('ledger <project>')
  .description('Save an immutable session log entry (same as session_save_ledger MCP tool)')
  .requiredOption('-c, --conversation-id <id>', 'Unique conversation/session identifier')
  .requiredOption('-m, --summary <text>', 'Summary of what was accomplished')
  .option('-t, --todos <json>', 'Open TODO items as JSON array, e.g. \'["item1","item2"]\'')
  .option('-f, --files-changed <json>', 'Files changed as JSON array')
  .option('-d, --decisions <json>', 'Key decisions as JSON array')
  .option('-r, --role <role>', 'Agent role for Hivemind scoping')
  .option('-s, --storage <backend>', 'Storage backend: local (SQLite) or supabase')
  .option('--json', 'Emit machine-readable JSON output')
  .action(async (project: string, options: {
    conversationId: string;
    summary: string;
    todos?: string;
    filesChanged?: string;
    decisions?: string;
    role?: string;
    storage?: string;
    json?: boolean;
  }) => {
    try {
      // Storage override
      if (options.storage) {
        const validStorages = ['local', 'supabase'];
        if (!validStorages.includes(options.storage)) {
          console.error(`Error: Invalid storage "${options.storage}". Must be one of: ${validStorages.join(', ')}`);
          process.exit(1);
        }
        process.env.PRISM_STORAGE = options.storage;
      }

      const args = {
        project,
        conversation_id: options.conversationId,
        summary: options.summary,
        todos: parseJsonArrayArg(options.todos, 'todos'),
        files_changed: parseJsonArrayArg(options.filesChanged, 'files-changed'),
        decisions: parseJsonArrayArg(options.decisions, 'decisions'),
        role: options.role,
      };

      const result = await sessionSaveLedgerHandler(args);

      if (options.json) {
        console.log(JSON.stringify({
          success: !result.isError,
          text: (result.content[0] as any)?.text || '',
        }, null, 2));
      } else {
        console.log((result.content[0] as any)?.text || 'Done');
      }

      if (result.isError) {
        await closeStorage();
        process.exit(1);
      }

      await closeStorage();
    } catch (err) {
      console.error(`Error saving ledger: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => {});
      process.exit(1);
    }
  });

saveCmd
  .command('handoff <project>')
  .description('Update the live project state for next session (same as session_save_handoff MCP tool)')
  .option('-m, --last-summary <text>', 'Summary of the most recent session')
  .option('-t, --open-todos <json>', 'Current open TODO items as JSON array')
  .option('-k, --key-context <text>', 'Free-form critical context for next session')
  .option('-b, --active-branch <branch>', 'Git branch or context to resume on')
  .option('-v, --expected-version <n>', 'Version for optimistic concurrency control', parseInt)
  .option('-r, --role <role>', 'Agent role for Hivemind scoping')
  .option('-s, --storage <backend>', 'Storage backend: local (SQLite) or supabase')
  .option('--json', 'Emit machine-readable JSON output')
  .action(async (project: string, options: {
    lastSummary?: string;
    openTodos?: string;
    keyContext?: string;
    activeBranch?: string;
    expectedVersion?: number;
    role?: string;
    storage?: string;
    json?: boolean;
  }) => {
    try {
      // Storage override
      if (options.storage) {
        const validStorages = ['local', 'supabase'];
        if (!validStorages.includes(options.storage)) {
          console.error(`Error: Invalid storage "${options.storage}". Must be one of: ${validStorages.join(', ')}`);
          process.exit(1);
        }
        process.env.PRISM_STORAGE = options.storage;
      }

      const args = {
        project,
        last_summary: options.lastSummary,
        open_todos: parseJsonArrayArg(options.openTodos, 'open-todos'),
        key_context: options.keyContext,
        active_branch: options.activeBranch,
        expected_version: options.expectedVersion,
        role: options.role,
      };

      const result = await sessionSaveHandoffHandler(args);

      if (options.json) {
        console.log(JSON.stringify({
          success: !result.isError,
          text: (result.content[0] as any)?.text || '',
        }, null, 2));
      } else {
        console.log((result.content[0] as any)?.text || 'Done');
      }

      if (result.isError) {
        await closeStorage();
        process.exit(1);
      }

      await closeStorage();
    } catch (err) {
      console.error(`Error saving handoff: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => {});
      process.exit(1);
    }
  });

// ─── prism verify ─────────────────────────────────────────────

const verifyCmd = program
  .command('verify')
  .description('Manage the verification harness');

verifyCmd
  .command('status')
  .description('Check the current verification state and view config drift')
  .option('-p, --project <name>', 'Project name', path.basename(process.cwd()))
  .option('-f, --force', 'Bypass verification failures and drift tracking constraints')
  .option('-u, --user <id>', 'User ID for tenant isolation', 'default')
  .option('--json', 'Emit machine-readable JSON output with stable keys')
  .action(async (options) => {
    const storage = new SqliteStorage();
    await storage.initialize('./prism-local.db');

    // H4 fix: Ensure storage is closed on exit to flush WAL and prevent data loss
    try {
      await handleVerifyStatus(storage, options.project, !!options.force, options.user, !!options.json);
    } finally {
      await storage.close();
    }
  });

verifyCmd
  .command('generate')
  .description('Bless the current ./verification_harness.json as the canonical rubric')
  .option('-p, --project <name>', 'Project name', path.basename(process.cwd()))
  .option('-f, --force', 'Bypass verification failures and drift tracking constraints')
  .option('-u, --user <id>', 'User ID for tenant isolation', 'default')
  .option('--json', 'Emit machine-readable JSON output with stable keys')
  .action(async (options) => {
    const storage = new SqliteStorage();
    await storage.initialize('./prism-local.db');

    // H4 fix: Ensure storage is closed on exit to flush WAL and prevent data loss
    try {
      await handleGenerateHarness(storage, options.project, !!options.force, options.user, !!options.json);
    } finally {
      await storage.close();
    }
  });
// ─── prism sync ───────────────────────────────────────────────
// M4: Bidirectional reconciliation commands.
// `prism sync push` pushes local SQLite data to Supabase.

const syncCmd = program
  .command('sync')
  .description('Cross-backend data synchronization');

syncCmd
  .command('push')
  .description('Push local SQLite data to Supabase (handoffs + recent ledger)')
  .option('--json', 'Emit machine-readable JSON output')
  .action(async (options) => {
    try {
      // Force local storage mode to read from SQLite
      process.env.PRISM_STORAGE = 'local';
      const storage = await getStorage();

      // Verify Supabase credentials are available
      const { getSetting } = await import('./storage/configStorage.js');
      const sbUrl = process.env.SUPABASE_URL || await getSetting('SUPABASE_URL');
      const sbKey = process.env.SUPABASE_KEY || await getSetting('SUPABASE_KEY');
      if (!sbUrl || !sbKey) {
        console.error('❌ Supabase credentials not configured. Set SUPABASE_URL and SUPABASE_KEY.');
        await closeStorage();
        process.exit(1);
      }
      // Ensure process.env has the credentials for supabaseApi.ts
      process.env.SUPABASE_URL = sbUrl;
      process.env.SUPABASE_KEY = sbKey;

      const { pushReconciliation } = await import('./storage/reconcile.js');
      const { SqliteStorage } = await import('./storage/sqlite.js');
      const sqliteInstance = storage as InstanceType<typeof SqliteStorage>;
      const getTimestamps = () => sqliteInstance.getHandoffTimestamps();

      const result = await pushReconciliation(storage, getTimestamps);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.handoffsPushed === 0 && result.ledgerEntriesPushed === 0) {
          console.log('✅ Supabase is already up-to-date with local data.');
        } else {
          console.log(`✅ Pushed ${result.handoffsPushed} handoff(s) + ${result.ledgerEntriesPushed} ledger entries to Supabase`);
          if (result.projects.length > 0) {
            console.log(`   Projects: ${result.projects.join(', ')}`);
          }
        }
      }

      await closeStorage();
    } catch (err) {
      console.error(`Error during sync push: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => {});
      process.exit(1);
    }
  });

program.parse(process.argv);
