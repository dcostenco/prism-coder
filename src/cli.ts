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
import { connectHosts, normalizeHostName } from './connect.js';

const program = new Command();

program
  .name('prism')
  .description('Prism — The Mind Palace for AI Agents')
  .version(SERVER_CONFIG.version);

// ─── prism connect ────────────────────────────────────────────
// Registers this installed package with supported MCP hosts. The
// merge is additive: an existing `prism` or `prism-mcp` entry is
// reported and left byte-for-byte untouched.

program
  .command('connect')
  .description('Register Prism with installed MCP hosts (close hosts before writing)')
  .option('--host <name>', 'Target one host: claude-code, claude-desktop, cursor, gemini, or codex')
  .option('--all', 'Target all supported hosts instead of auto-detecting installed hosts')
  .option('--dry-run', 'Preview configuration changes without writing files')
  .option('--refresh', 'Refresh only entries previously created by Prism; custom entries stay untouched')
  .action(async (options: { host?: string; all?: boolean; dryRun?: boolean; refresh?: boolean }) => {
    try {
      if (!options.dryRun) {
        console.log('Close target MCP hosts before registration so they cannot edit configuration concurrently.');
      }
      const hosts = options.host ? [normalizeHostName(options.host)] : undefined;
      const summary = connectHosts({
        all: !!options.all,
        dryRun: !!options.dryRun,
        refresh: !!options.refresh,
        hosts,
      });

      if (summary.results.length === 0) {
        console.error('No supported MCP hosts detected. Use --host <name> or --all to target one explicitly.');
        process.exitCode = 1;
        return;
      }

      for (const result of summary.results) {
        if (result.status === 'registered') {
          console.log(`✓ ${result.label}: registered (${result.path})`);
        } else if (result.status === 'would-register') {
          console.log(`• ${result.label}: would register (${result.path})`);
        } else if (result.status === 'refreshed') {
          console.log(`✓ ${result.label}: Prism-managed entry refreshed (${result.path})`);
        } else if (result.status === 'would-refresh') {
          console.log(`• ${result.label}: would refresh Prism-managed entry (${result.path})`);
        } else if (result.status === 'existing') {
          console.log(`− ${result.label}: already registered — untouched (${result.path})`);
        } else {
          console.error(`✗ ${result.label}: ${result.message || 'registration failed'} (${result.path})`);
          process.exitCode = 1;
        }
      }

      if (options.dryRun) {
        console.log('\nDry run complete — no files changed.');
      } else if (summary.results.some((result) =>
        result.status === 'registered' || result.status === 'refreshed' || result.status === 'existing')) {
        // Codex discovers native skills before it starts MCP servers. Syncing
        // only from server startup therefore makes a fresh install require a
        // second host restart. Materialize the entitlement snapshot before
        // this registration command exits so the first launch sees it.
        const { triggerSkillManifestSync } = await import('./skillManifestSync.js');
        const skillSync = await triggerSkillManifestSync();
        if (skillSync.status === 'failed' || skillSync.status === 'partial') {
          throw new Error(`Synalux skill synchronization failed: ${skillSync.error || skillSync.status}`);
        }
        if (skillSync.status !== 'disabled') {
          const changed = skillSync.installed.length + skillSync.updated.length + skillSync.pruned.length;
          console.log(`✓ Synalux skills: ${skillSync.tier || 'free'} tier (${changed} changed)`);
          if (skillSync.conflicts.length > 0) {
            console.error(`⚠ Preserved locally modified skill conflicts: ${skillSync.conflicts.join(', ')}`);
          }
        }
      }
      if (!summary.usedApiKey) {
        console.log('PRISM_SYNALUX_API_KEY is not set; no Synalux subscription key was copied into new registrations.');
      }
    } catch (err) {
      console.error(`Connect failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

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
  .option('-l, --level <level>', 'Context depth: quick, standard, deep (defaults to dashboard setting)')
  .option('-r, --role <role>', 'Role scope for context loading')
  .option('-s, --storage <backend>', 'Storage backend: auto (default, prefers cloud), local (SQLite), or supabase. Overrides PRISM_STORAGE env var.')
  .option('--json', 'Emit machine-readable JSON instead of formatted text')
  .action(async (project: string, options: { level?: string; role?: string; storage?: string; json?: boolean }) => {
    try {
      const { level: requestedLevel, role, storage, json: jsonOutput } = options;

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
      if (requestedLevel && !validLevels.includes(requestedLevel)) {
        console.error(`Error: Invalid level "${requestedLevel}". Must be one of: ${validLevels.join(', ')}`);
        process.exit(1);
      }
      const configuredLevel = requestedLevel ?? await getSetting('default_context_depth', 'standard');
      const level = validLevels.includes(configuredLevel) ? configuredLevel : 'standard';

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
        const result = await sessionLoadContextHandler({ project, ...(requestedLevel ? { level: requestedLevel } : {}), role });

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
      await closeStorage().catch(() => { });
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
      await closeStorage().catch(() => { });
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
      await closeStorage().catch(() => { });
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
    const localDbPath = process.env.PRISM_DB_PATH || './prism-local.db';
    await storage.initialize(true, localDbPath);

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
    const localDbPath = process.env.PRISM_DB_PATH || './prism-local.db';
    await storage.initialize(true, localDbPath);

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
      await closeStorage().catch(() => { });
      process.exit(1);
    }
  });

// ─── prism scm ────────────────────────────────────────────────
// Synalux SCM integration — thin API client that calls Synalux
// endpoints. All engines run server-side; Prism only renders.
//
// Subcommands:
//   prism scm search <query>   — Multi-repo code search
//   prism scm review <file>    — AI code review
//   prism scm scan <file>      — Secret detection + license compliance
//   prism scm dora             — DORA metrics for the current project

const scmCmd = program
  .command('scm')
  .description('Synalux SCM — source control, AI review, security scanning, DORA metrics');

scmCmd
  .command('search <query>')
  .description('Search code across repos (supports exact, regex, symbol, semantic modes)')
  .option('-m, --mode <mode>', 'Search mode: exact, regex, symbol, semantic', 'exact')
  .option('-r, --repo <owner/name>', 'Target repo (e.g. "synalux/portal")')
  .option('-p, --pattern <glob>', 'File pattern filter (e.g. "*.ts")')
  .option('-n, --max-results <n>', 'Maximum results', '20')
  .option('--json', 'Emit machine-readable JSON output')
  .action(async (query: string, options: {
    mode: string; repo?: string; pattern?: string;
    maxResults: string; json?: boolean;
  }) => {
    try {
      const { ScmClient } = await import('./scm/client.js');
      const client = new ScmClient();
      const repo = options.repo || path.basename(process.cwd());

      const results = await client.search(repo, {
        query,
        mode: options.mode as any,
        file_patterns: options.pattern ? [options.pattern] : undefined,
        max_results: parseInt(options.maxResults) || 20,
      });

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log(`🔍 ${results.total_matches} match(es) in ${results.search_time_ms}ms\n`);
        for (const r of results.results) {
          console.log(`  ${r.file}:${r.line_number}  (score: ${r.score})`);
          console.log(`    ${r.content.trim()}\n`);
        }
        if (results.truncated) console.log(`  ... truncated. Use --max-results to see more.`);
      }
    } catch (err) {
      console.error(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

scmCmd
  .command('review <files...>')
  .description('AI code review — security, performance, and style analysis')
  .option('-r, --repo <owner/name>', 'Target repo')
  .option('--hipaa', 'Enable HIPAA compliance check')
  .option('--json', 'Emit machine-readable JSON output')
  .action(async (filePaths: string[], options: { repo?: string; hipaa?: boolean; json?: boolean }) => {
    try {
      const fs = await import('fs');
      const { ScmClient } = await import('./scm/client.js');
      const client = new ScmClient();
      const repo = options.repo || path.basename(process.cwd());

      const files = filePaths.map(fp => ({
        name: path.basename(fp),
        content: fs.readFileSync(path.resolve(fp), 'utf-8'),
      }));

      const result = await client.review(repo, files, { hipaa: options.hipaa });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const icon = result.review.overall_score >= 80 ? '✅' : result.review.overall_score >= 60 ? '⚠️' : '❌';
        console.log(`${icon} AI Review Score: ${result.review.overall_score}/100`);
        console.log(`   Findings: ${result.review.total_findings} | Auto-approve: ${result.review.auto_approve ? 'yes' : 'no'}`);
        if (result.hipaa) {
          const h = result.hipaa;
          console.log(`${h.compliant ? '✅' : '❌'} HIPAA: ${h.compliant ? 'Compliant' : 'VIOLATIONS'} (score: ${h.score})`);
        }
      }
    } catch (err) {
      console.error(`Review failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

scmCmd
  .command('scan <files...>')
  .description('Security scan — secret detection, license compliance, Dockerfile best practices')
  .option('-r, --repo <owner/name>', 'Target repo')
  .option('--json', 'Emit machine-readable JSON output')
  .action(async (filePaths: string[], options: { repo?: string; json?: boolean }) => {
    try {
      const fs = await import('fs');
      const { ScmClient } = await import('./scm/client.js');
      const client = new ScmClient();
      const repo = options.repo || path.basename(process.cwd());

      const files = filePaths.map(fp => ({
        name: path.basename(fp),
        content: fs.readFileSync(path.resolve(fp), 'utf-8'),
      }));

      const result = await client.scan(repo, files);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const icon = result.summary.pass ? '✅' : '❌';
        console.log(`${icon} Security Scan: ${result.summary.total_findings} finding(s)`);
        if (result.summary.critical > 0) console.log(`   🔴 Critical: ${result.summary.critical}`);
        if (result.summary.high > 0) console.log(`   🟠 High: ${result.summary.high}`);
        if (result.summary.medium > 0) console.log(`   🟡 Medium: ${result.summary.medium}`);
        console.log(`   Duration: ${result.summary.scan_duration_ms}ms`);
      }
    } catch (err) {
      console.error(`Scan failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

scmCmd
  .command('dora')
  .description('Show DORA metrics for the current project')
  .option('-r, --repo <owner/name>', 'Target repo')
  .option('-p, --period <period>', 'Period label (e.g. "2024-Q4")')
  .option('--json', 'Emit machine-readable JSON output')
  .action(async (options: { repo?: string; period?: string; json?: boolean }) => {
    try {
      const { ScmClient } = await import('./scm/client.js');
      const client = new ScmClient();
      const repo = options.repo || path.basename(process.cwd());

      const dora = await client.dora(repo, options.period);

      if (options.json) {
        console.log(JSON.stringify(dora, null, 2));
      } else {
        console.log(`📊 DORA Metrics — ${dora.period}`);
        console.log(`   Deploy Frequency: ${dora.deployment_frequency.value.toFixed(2)}/day (${dora.deployment_frequency.level})`);
        console.log(`   Lead Time:        ${dora.lead_time.value.toFixed(1)}h (${dora.lead_time.level})`);
        console.log(`   Change Failure:   ${dora.change_failure_rate.value.toFixed(1)}% (${dora.change_failure_rate.level})`);
        console.log(`   MTTR:             ${dora.mttr.value.toFixed(1)}h (${dora.mttr.level})`);
        console.log(`   Overall:          ${dora.overall_level.toUpperCase()}`);
      }
    } catch (err) {
      console.error(`DORA failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── prism register-models ────────────────────────────────────
// Convenience: alias namespaced HF-style prism-coder tags
// (`dcostenco/prism-coder:9b`) to the bare tags (`prism-coder:9b`)
// some external tooling expects. The MCP picker handles both forms
// natively as of v15.5, so this command is OPTIONAL — useful only
// when a user wants to run `ollama run prism-coder:9b` directly,
// or for tools that pre-date the picker's namespace fallback.

program
  .command('register-models')
  .description('Alias namespaced prism-coder Ollama tags to bare tags (optional convenience)')
  .option('-u, --url <url>', 'Ollama base URL', process.env.PRISM_LOCAL_LLM_URL || 'http://localhost:11434')
  .option('--dry-run', 'Print what would be aliased without running ollama cp')
  .action(async (options: { url: string; dryRun?: boolean }) => {
    type OllamaModel = { name: string };
    let installed: OllamaModel[] = [];
    try {
      const res = await fetch(`${options.url}/api/tags`, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) {
        console.error(`Ollama /api/tags returned HTTP ${res.status}. Is Ollama running at ${options.url}?`);
        process.exit(1);
      }
      const data = (await res.json()) as { models?: OllamaModel[] };
      installed = data.models ?? [];
    } catch (err) {
      console.error(`Cannot reach Ollama at ${options.url}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    const installedNames = new Set(installed.map(m => m.name));
    const candidates = installed
      .map(m => m.name)
      .filter(n => /\/prism-coder:/.test(n))
      .map(n => ({ from: n, to: n.replace(/^[^/]+\//, '') }))
      .filter(({ to }) => !installedNames.has(to));

    if (candidates.length === 0) {
      console.log('Nothing to do — no namespaced prism-coder tags need aliasing.');
      return;
    }

    console.log(`Found ${candidates.length} model(s) to alias:`);
    for (const { from, to } of candidates) {
      console.log(`  ${from}  →  ${to}`);
    }

    if (options.dryRun) {
      console.log('\n(dry-run — no changes made)');
      return;
    }

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    let ok = 0;
    let fail = 0;
    for (const { from, to } of candidates) {
      try {
        await exec('ollama', ['cp', from, to]);
        console.log(`  ✓ aliased ${to}`);
        ok++;
      } catch (err) {
        console.error(`  ✗ ${from} → ${to}: ${err instanceof Error ? err.message : String(err)}`);
        fail++;
      }
    }
    console.log(`\nDone. Aliased ${ok}, failed ${fail}.`);
    if (fail > 0) process.exit(1);
  });

await program.parseAsync(process.argv);
