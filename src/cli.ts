#!/usr/bin/env node

import { Command } from 'commander';
import { SqliteStorage } from './storage/sqlite.js';
import { handleVerifyStatus, handleGenerateHarness } from './verification/cliHandler.js';
import * as path from 'path';
import { getStorage, closeStorage } from './storage/index.js';
import { getSetting } from './storage/configStorage.js';
import { PRISM_USER_ID, SERVER_CONFIG } from './config.js';
import { getCurrentGitState } from './utils/git.js';
import { sessionLoadContextHandler } from './tools/ledgerHandlers.js';

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
        const storage = await getStorage();
        const effectiveRole = role || await getSetting('default_role', '') || undefined;
        const agentName = await getSetting('agent_name', '') || undefined;
        const data = await storage.loadContext(project, level, PRISM_USER_ID, effectiveRole);

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

program.parse(process.argv);
