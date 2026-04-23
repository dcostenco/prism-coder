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
  .version(SERVER_CONFIG.version)
  .action(async () => {
    // Default action: show greeting with auth info
    try {
      const { initConfigStorage } = await import('./storage/configStorage.js');
      await initConfigStorage();
      const { getAuthStatus } = await import('./auth.js');
      const auth = await getAuthStatus();

      console.log(`\n🧠 Prism v${SERVER_CONFIG.version} — The Mind Palace for AI Agents`);
      if (auth.loggedIn) {
        console.log(`👤 ${auth.email}  ·  📋 ${auth.plan || 'Free'} plan`);
      } else {
        console.log('👤 Not logged in  ·  Run \`prism login\` to authenticate');
      }
      console.log(`\nRun \`prism prompt\` for interactive mode, or \`prism --help\` for all commands.\n`);
    } catch {
      console.log(`\n🧠 Prism v${SERVER_CONFIG.version}\nRun \`prism --help\` for all commands.\n`);
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

// ─── prism login ─────────────────────────────────────────────
// OAuth login flow — opens browser for Synalux authentication.
// Also supports --email/--plan flags for manual setup.

program
  .command('login')
  .description('Authenticate with Synalux Cloud via OAuth, or set identity manually')
  .option('-e, --email <email>', 'Set email directly (skips OAuth)')
  .option('-p, --plan <plan>', 'Set subscription plan: Free, Advanced, Enterprise', 'Enterprise')
  .action(async (options: { email?: string; plan?: string }) => {
    try {
      const { initConfigStorage, setSetting: setSettingLocal } = await import('./storage/configStorage.js');
      await initConfigStorage();

      if (options.email) {
        // Manual identity setup — no OAuth needed
        await setSettingLocal('prism_auth_email', options.email);
        await setSettingLocal('prism_auth_plan', options.plan || 'Enterprise');
        await setSettingLocal('prism_auth_token', 'manual');
        await setSettingLocal('prism_auth_expires', String(Math.floor(Date.now() / 1000) + 365 * 24 * 3600));
        console.log(`\n✅ Logged in as ${options.email} (${options.plan || 'Enterprise'} plan)`);
        console.log('   Prism Cloud features are now active.\n');
        return;
      }

      // Full OAuth flow
      const { login } = await import('./auth.js');
      const result = await login();

      if (result.success) {
        console.log(`\n✅ Logged in as ${result.email} (${result.plan} plan)`);
        console.log('   Prism Cloud features are now active.\n');
      } else {
        console.error(`\n❌ Login failed: ${result.error}\n`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`❌ Login error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── prism logout ────────────────────────────────────────────

program
  .command('logout')
  .description('Sign out of Synalux Cloud and clear stored tokens')
  .action(async () => {
    try {
      const { initConfigStorage } = await import('./storage/configStorage.js');
      await initConfigStorage();

      const { logout } = await import('./auth.js');
      await logout();

      console.log('✅ Logged out of Synalux Cloud. Operating in Free tier.');
    } catch (err) {
      console.error(`❌ Logout error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── prism status ────────────────────────────────────────────

program
  .command('status')
  .description('Show current authentication state and cloud tier')
  .option('--json', 'Emit machine-readable JSON output')
  .action(async (options) => {
    try {
      const { initConfigStorage } = await import('./storage/configStorage.js');
      await initConfigStorage();

      const { getAuthStatus } = await import('./auth.js');
      const authStatus = await getAuthStatus();

      if (options.json) {
        console.log(JSON.stringify(authStatus, null, 2));
      } else if (authStatus.loggedIn) {
        console.log(`🔐 Logged in as: ${authStatus.email}`);
        console.log(`📋 Plan: ${authStatus.plan}`);
        if (authStatus.expiresAt) {
          console.log(`⏰ Token expires: ${authStatus.expiresAt.toLocaleString()}`);
        }
      } else {
        console.log('🔓 Not logged in. Run `prism login` to authenticate with Synalux Cloud.');
      }
    } catch (err) {
      console.error(`❌ Status error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── Legacy: prism trial (deprecated) ────────────────────────
program
  .command('trial')
  .description('[DEPRECATED] Use `prism login` instead')
  .action(() => {
    console.log('⚠️  `prism trial` is deprecated. Use `prism login` for OAuth-based authentication.');
    console.log('   This gives you the same 30-day trial via Synalux Cloud.\n');
    console.log('   Run: prism login');
    process.exit(0);
  });

// ═══════════════════════════════════════════════════════════════
// ─── SEARCH COMMANDS ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

program
  .command('search <query>')
  .description('Search session memory by keywords or semantically')
  .option('--semantic', 'Use vector/semantic search instead of keyword search')
  .option('-p, --project <name>', 'Limit search to a specific project')
  .option('-c, --category <cat>', 'Filter by category (debugging, architecture, etc.)')
  .option('-l, --limit <n>', 'Max results to return', '10')
  .option('-s, --storage <backend>', 'Storage backend: local or supabase')
  .option('--json', 'Emit machine-readable JSON output')
  .action(async (query: string, options: {
    semantic?: boolean; project?: string; category?: string;
    limit?: string; storage?: string; json?: boolean;
  }) => {
    try {
      if (options.storage) {
        process.env.PRISM_STORAGE = options.storage;
      }

      let result: any;
      if (options.semantic) {
        const { sessionSearchMemoryHandler } = await import('./tools/graphHandlers.js');
        result = await sessionSearchMemoryHandler({
          query,
          project: options.project,
          limit: parseInt(options.limit || '5'),
        });
      } else {
        const { knowledgeSearchHandler } = await import('./tools/graphHandlers.js');
        result = await knowledgeSearchHandler({
          query,
          project: options.project,
          category: options.category,
          limit: parseInt(options.limit || '10'),
        });
      }

      if (options.json) {
        console.log(JSON.stringify({
          success: !result.isError,
          text: (result.content[0] as any)?.text || '',
        }, null, 2));
      } else {
        console.log((result.content[0] as any)?.text || 'No results found.');
      }

      await closeStorage();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => { });
      process.exit(1);
    }
  });

// ═══════════════════════════════════════════════════════════════
// ─── MEMORY MANAGEMENT COMMANDS ──────────────────────────────
// ═══════════════════════════════════════════════════════════════

program
  .command('history <project>')
  .description('View the timeline of past memory states (versions)')
  .option('-l, --limit <n>', 'Max entries to return', '10')
  .option('-s, --storage <backend>', 'Storage backend: local or supabase')
  .option('--json', 'Emit machine-readable JSON output')
  .action(async (project: string, options: { limit?: string; storage?: string; json?: boolean }) => {
    try {
      if (options.storage) process.env.PRISM_STORAGE = options.storage;
      const { memoryHistoryHandler } = await import('./tools/ledgerHandlers.js');
      const result = await memoryHistoryHandler({ project, limit: parseInt(options.limit || '10') });

      if (options.json) {
        console.log(JSON.stringify({ success: !result.isError, text: (result.content[0] as any)?.text || '' }, null, 2));
      } else {
        console.log((result.content[0] as any)?.text || 'No history found.');
      }
      await closeStorage();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => { });
      process.exit(1);
    }
  });

program
  .command('checkout <project> <version>')
  .description('Time-travel: restore memory to a specific past version')
  .option('-s, --storage <backend>', 'Storage backend: local or supabase')
  .action(async (project: string, version: string, options: { storage?: string }) => {
    try {
      if (options.storage) process.env.PRISM_STORAGE = options.storage;
      const { memoryCheckoutHandler } = await import('./tools/ledgerHandlers.js');
      const result = await memoryCheckoutHandler({ project, target_version: parseInt(version) });
      console.log((result.content[0] as any)?.text || 'Done');
      if (result.isError) process.exit(1);
      await closeStorage();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => { });
      process.exit(1);
    }
  });

program
  .command('forget <memory_id>')
  .description('Delete a specific memory entry by ID')
  .option('--hard', 'Permanently delete (irreversible). Default is soft-delete.')
  .option('--reason <text>', 'Justification for deletion (GDPR audit trail)')
  .option('-s, --storage <backend>', 'Storage backend: local or supabase')
  .action(async (memoryId: string, options: { hard?: boolean; reason?: string; storage?: string }) => {
    try {
      if (options.storage) process.env.PRISM_STORAGE = options.storage;
      const { sessionForgetMemoryHandler } = await import('./tools/ledgerHandlers.js');
      const result = await sessionForgetMemoryHandler({
        memory_id: memoryId,
        hard_delete: !!options.hard,
        reason: options.reason,
      });
      console.log((result.content[0] as any)?.text || 'Done');
      if (result.isError) process.exit(1);
      await closeStorage();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => { });
      process.exit(1);
    }
  });

program
  .command('forget-bulk')
  .description('Bulk forget entries by project, category, or age')
  .option('-p, --project <name>', 'Project to forget entries for')
  .option('-c, --category <cat>', 'Only forget entries in this category')
  .option('--older-than <days>', 'Only forget entries older than N days', parseInt)
  .option('--confirm-all', 'Confirm wiping ALL entries (safety flag)')
  .option('--clear-handoff', 'Also clear the handoff state')
  .option('--dry-run', 'Preview what would be deleted without executing')
  .option('-s, --storage <backend>', 'Storage backend: local or supabase')
  .option('--json', 'Emit machine-readable JSON output')
  .action(async (options: {
    project?: string; category?: string; olderThan?: number;
    confirmAll?: boolean; clearHandoff?: boolean; dryRun?: boolean;
    storage?: string; json?: boolean;
  }) => {
    try {
      if (options.storage) process.env.PRISM_STORAGE = options.storage;
      const { knowledgeForgetHandler } = await import('./tools/graphHandlers.js');
      const result = await knowledgeForgetHandler({
        project: options.project,
        category: options.category,
        older_than_days: options.olderThan,
        confirm_all: options.confirmAll,
        clear_handoff: options.clearHandoff,
        dry_run: options.dryRun,
      });
      if (options.json) {
        console.log(JSON.stringify({ success: !result.isError, text: (result.content[0] as any)?.text || '' }, null, 2));
      } else {
        console.log((result.content[0] as any)?.text || 'Done');
      }
      if (result.isError) process.exit(1);
      await closeStorage();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => { });
      process.exit(1);
    }
  });

program
  .command('export')
  .description("Export a project's memory to a local file (JSON, Markdown, or Obsidian Vault)")
  .option('-p, --project <name>', 'Project to export (omit for all)')
  .requiredOption('-o, --output-dir <path>', 'Output directory (must exist)')
  .option('-f, --format <fmt>', 'Export format: json, markdown, or vault', 'json')
  .option('-s, --storage <backend>', 'Storage backend: local or supabase')
  .action(async (options: { project?: string; outputDir: string; format?: string; storage?: string }) => {
    try {
      if (options.storage) process.env.PRISM_STORAGE = options.storage;
      const { sessionExportMemoryHandler } = await import('./tools/ledgerHandlers.js');
      const result = await sessionExportMemoryHandler({
        project: options.project,
        output_dir: options.outputDir,
        format: options.format || 'json',
      });
      console.log((result.content[0] as any)?.text || 'Done');
      if (result.isError) process.exit(1);
      await closeStorage();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => { });
      process.exit(1);
    }
  });

// ═══════════════════════════════════════════════════════════════
// ─── KNOWLEDGE CURATION COMMANDS ─────────────────────────────
// ═══════════════════════════════════════════════════════════════

program
  .command('upvote <id>')
  .description('Increase a memory entry\'s importance (graduation at ≥ 7)')
  .option('-s, --storage <backend>', 'Storage backend: local or supabase')
  .action(async (id: string, options: { storage?: string }) => {
    try {
      if (options.storage) process.env.PRISM_STORAGE = options.storage;
      const { knowledgeUpvoteHandler } = await import('./tools/graphHandlers.js');
      const result = await knowledgeUpvoteHandler({ id });
      console.log((result.content[0] as any)?.text || 'Done');
      if (result.isError) process.exit(1);
      await closeStorage();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => { });
      process.exit(1);
    }
  });

program
  .command('downvote <id>')
  .description('Decrease a memory entry\'s importance')
  .option('-s, --storage <backend>', 'Storage backend: local or supabase')
  .action(async (id: string, options: { storage?: string }) => {
    try {
      if (options.storage) process.env.PRISM_STORAGE = options.storage;
      const { knowledgeDownvoteHandler } = await import('./tools/graphHandlers.js');
      const result = await knowledgeDownvoteHandler({ id });
      console.log((result.content[0] as any)?.text || 'Done');
      if (result.isError) process.exit(1);
      await closeStorage();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => { });
      process.exit(1);
    }
  });

program
  .command('sync-rules <project>')
  .description('Sync graduated insights (importance ≥ 7) to IDE rules file')
  .option('--target <file>', 'Target rules file', '.cursorrules')
  .option('--dry-run', 'Preview rules block without writing')
  .option('-s, --storage <backend>', 'Storage backend: local or supabase')
  .action(async (project: string, options: { target?: string; dryRun?: boolean; storage?: string }) => {
    try {
      if (options.storage) process.env.PRISM_STORAGE = options.storage;
      const { knowledgeSyncRulesHandler } = await import('./tools/graphHandlers.js');
      const result = await knowledgeSyncRulesHandler({
        project,
        target_file: options.target || '.cursorrules',
        dry_run: options.dryRun,
      });
      console.log((result.content[0] as any)?.text || 'Done');
      if (result.isError) process.exit(1);
      await closeStorage();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => { });
      process.exit(1);
    }
  });

// ═══════════════════════════════════════════════════════════════
// ─── MAINTENANCE COMMANDS ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

program
  .command('compact')
  .description('Auto-compact old session entries into AI-generated summaries')
  .option('-p, --project <name>', 'Project to compact (omit for auto-detect)')
  .option('--threshold <n>', 'Min entries before compaction triggers', '50')
  .option('--keep-recent <n>', 'Recent entries to keep intact', '10')
  .option('--dry-run', 'Preview what would be compacted without executing')
  .option('-s, --storage <backend>', 'Storage backend: local or supabase')
  .option('--json', 'Emit machine-readable JSON output')
  .action(async (options: {
    project?: string; threshold?: string; keepRecent?: string;
    dryRun?: boolean; storage?: string; json?: boolean;
  }) => {
    try {
      if (options.storage) process.env.PRISM_STORAGE = options.storage;
      const { compactLedgerHandler } = await import('./tools/compactionHandler.js');
      const result = await compactLedgerHandler({
        project: options.project,
        threshold: parseInt(options.threshold || '50'),
        keep_recent: parseInt(options.keepRecent || '10'),
        dry_run: options.dryRun,
      });
      if (options.json) {
        console.log(JSON.stringify({ success: !result.isError, text: (result.content[0] as any)?.text || '' }, null, 2));
      } else {
        console.log((result.content[0] as any)?.text || 'Done');
      }
      if (result.isError) process.exit(1);
      await closeStorage();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => { });
      process.exit(1);
    }
  });

program
  .command('health')
  .description('Run integrity checks on memory DB (missing embeddings, duplicates, orphans)')
  .option('--auto-fix', 'Automatically repair issues')
  .option('-s, --storage <backend>', 'Storage backend: local or supabase')
  .option('--json', 'Emit machine-readable JSON output')
  .action(async (options: { autoFix?: boolean; storage?: string; json?: boolean }) => {
    try {
      if (options.storage) process.env.PRISM_STORAGE = options.storage;
      const { sessionHealthCheckHandler } = await import('./tools/hygieneHandlers.js');
      const result = await sessionHealthCheckHandler({ auto_fix: options.autoFix });
      if (options.json) {
        console.log(JSON.stringify({ success: !result.isError, text: (result.content[0] as any)?.text || '' }, null, 2));
      } else {
        console.log((result.content[0] as any)?.text || 'Done');
      }
      if (result.isError) process.exit(1);
      await closeStorage();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => { });
      process.exit(1);
    }
  });

program
  .command('vacuum')
  .description('Reclaim disk space by running VACUUM on the SQLite database')
  .option('--dry-run', 'Report DB size without vacuuming')
  .option('-s, --storage <backend>', 'Storage backend: local or supabase')
  .action(async (options: { dryRun?: boolean; storage?: string }) => {
    try {
      if (options.storage) process.env.PRISM_STORAGE = options.storage;
      const { maintenanceVacuumHandler } = await import('./tools/hygieneHandlers.js');
      const result = await maintenanceVacuumHandler({ dry_run: options.dryRun });
      console.log((result.content[0] as any)?.text || 'Done');
      if (result.isError) process.exit(1);
      await closeStorage();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => { });
      process.exit(1);
    }
  });

program
  .command('purge')
  .description('Purge old float32 embedding vectors to reclaim ~90% storage')
  .option('--older-than <days>', 'Only purge entries older than N days', '30')
  .option('-p, --project <name>', 'Limit to a specific project')
  .option('--dry-run', 'Preview impact without purging')
  .option('-s, --storage <backend>', 'Storage backend: local or supabase')
  .action(async (options: { olderThan?: string; project?: string; dryRun?: boolean; storage?: string }) => {
    try {
      if (options.storage) process.env.PRISM_STORAGE = options.storage;
      const { deepStoragePurgeHandler } = await import('./tools/hygieneHandlers.js');
      const result = await deepStoragePurgeHandler({
        older_than_days: parseInt(options.olderThan || '30'),
        project: options.project,
        dry_run: options.dryRun,
      });
      console.log((result.content[0] as any)?.text || 'Done');
      if (result.isError) process.exit(1);
      await closeStorage();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => { });
      process.exit(1);
    }
  });

program
  .command('retention <project> <days>')
  .description('Set auto-expiry TTL policy for a project (0 to disable)')
  .option('-s, --storage <backend>', 'Storage backend: local or supabase')
  .action(async (project: string, days: string, options: { storage?: string }) => {
    try {
      if (options.storage) process.env.PRISM_STORAGE = options.storage;
      const { knowledgeSetRetentionHandler } = await import('./tools/hygieneHandlers.js');
      const result = await knowledgeSetRetentionHandler({ project, ttl_days: parseInt(days) });
      console.log((result.content[0] as any)?.text || 'Done');
      if (result.isError) process.exit(1);
      await closeStorage();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => { });
      process.exit(1);
    }
  });

// ═══════════════════════════════════════════════════════════════
// ─── GRAPH COMMANDS ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

program
  .command('backfill-links <project>')
  .description('Build associative memory graph edges for existing entries')
  .option('-s, --storage <backend>', 'Storage backend: local or supabase')
  .action(async (project: string, options: { storage?: string }) => {
    try {
      if (options.storage) process.env.PRISM_STORAGE = options.storage;
      const { sessionBackfillLinksHandler } = await import('./tools/hygieneHandlers.js');
      const result = await sessionBackfillLinksHandler({ project });
      console.log((result.content[0] as any)?.text || 'Done');
      if (result.isError) process.exit(1);
      await closeStorage();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => { });
      process.exit(1);
    }
  });

program
  .command('backfill-embeddings')
  .description('Backfill TurboQuant compressed embedding blobs for existing entries')
  .option('-p, --project <name>', 'Limit to a specific project')
  .option('-s, --storage <backend>', 'Storage backend: local or supabase')
  .action(async (options: { project?: string; storage?: string }) => {
    try {
      if (options.storage) process.env.PRISM_STORAGE = options.storage;
      const { backfillEmbeddingsHandler } = await import('./tools/hygieneHandlers.js');
      const result = await backfillEmbeddingsHandler({ project: options.project });
      console.log((result.content[0] as any)?.text || 'Done');
      if (result.isError) process.exit(1);
      await closeStorage();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => { });
      process.exit(1);
    }
  });

program
  .command('synthesize <project>')
  .description('Discover and create semantic relationship edges between memories')
  .option('--threshold <n>', 'Min cosine similarity (0-1)', '0.7')
  .option('--max-entries <n>', 'Max entries to scan', '50')
  .option('--randomize', 'Randomly sample instead of newest entries')
  .option('-s, --storage <backend>', 'Storage backend: local or supabase')
  .action(async (project: string, options: {
    threshold?: string; maxEntries?: string; randomize?: boolean; storage?: string;
  }) => {
    try {
      if (options.storage) process.env.PRISM_STORAGE = options.storage;
      const { sessionSynthesizeEdgesHandler } = await import('./tools/graphHandlers.js');
      const result = await sessionSynthesizeEdgesHandler({
        project,
        similarity_threshold: parseFloat(options.threshold || '0.7'),
        max_entries: parseInt(options.maxEntries || '50'),
        randomize_selection: options.randomize,
      });
      console.log((result.content[0] as any)?.text || 'Done');
      if (result.isError) process.exit(1);
      await closeStorage();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      await closeStorage().catch(() => { });
      process.exit(1);
    }
  });

// ═══════════════════════════════════════════════════════════════
// ─── DASHBOARD COMMAND ───────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

program
  .command('dashboard')
  .description('Launch the Prism web dashboard in your browser')
  .option('--port <n>', 'Port to run dashboard on', '9315')
  .action(async (options: { port?: string }) => {
    try {
      const port = parseInt(options.port || '9315');
      console.log(`🚀 Starting Prism Dashboard on http://localhost:${port}`);
      console.log('   Press Ctrl+C to stop.\n');

      const { initConfigStorage } = await import('./storage/configStorage.js');
      await initConfigStorage();

      // The dashboard is served via the MCP server's built-in HTTP handler
      const { createServer } = await import('./server.js');
      const server = await createServer();

      // Keep the process alive
      process.on('SIGINT', async () => {
        console.log('\n👋 Dashboard stopped.');
        await closeStorage();
        process.exit(0);
      });

      // Dashboard runs until interrupted
      await new Promise(() => { }); // hang forever
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── prism prompt [project] ──────────────────────────────────
// Interactive AI agent terminal — like Gemini CLI.
// Uses Gemini function calling with local workspace tools.

program
  .command('prompt')
  .description('Interactive AI agent terminal — chat, read files, run commands, search memory')
  .argument('[project]', 'Project to load context for', 'prism-mcp')
  .option('-s, --storage <backend>', 'Storage backend: local or supabase')
  .action(async (project: string, options: { storage?: string }) => {
    if (options.storage) process.env.PRISM_STORAGE = options.storage;

    try {
      const { initConfigStorage } = await import('./storage/configStorage.js');
      await initConfigStorage();

      const { getAuthStatus } = await import('./auth.js');
      const auth = await getAuthStatus();

      // ─── Banner ─────────────────────────────────────────────
      console.log(`\n🧠 Prism v${SERVER_CONFIG.version} — Agent Terminal`);
      if (auth.loggedIn) {
        console.log(`👤 ${auth.email}  ·  📋 ${auth.plan || 'Free'} plan`);
      }
      console.log(`📂 Project: ${project}  ·  📁 ${process.cwd()}`);

      // ─── Load project context ───────────────────────────────
      const storage = await getStorage();
      const contextData = await storage.loadContext(project, 'standard', PRISM_USER_ID) as any;

      let systemContext = `You are Prism, a powerful AI agent running in the user's terminal. You have access to tools for reading/writing files, running shell commands, and searching the user's memory.

Current project: ${project}
Working directory: ${process.cwd()}

Guidelines:
- Use tools proactively — read files, run commands, search memory when needed.
- Be concise and helpful. Show relevant code snippets.
- For shell commands, prefer non-destructive reads. Ask before destructive operations.
- When editing files, explain what you're changing and why.
`;

      if (contextData) {
        if (contextData.last_summary) {
          systemContext += `\nLast session: ${contextData.last_summary}`;
        }
        if (contextData.pending_todo?.length) {
          systemContext += `\nOpen TODOs:\n${contextData.pending_todo.map((t: string) => `- ${t}`).join('\n')}`;
        }
        if (contextData.key_context) {
          systemContext += `\nKey context: ${contextData.key_context}`;
        }
        console.log(`✅ Loaded ${contextData.pending_todo?.length || 0} TODOs, ${contextData.keywords?.length || 0} keywords`);
      } else {
        console.log('⚠️  No session context found — starting fresh');
      }

      // ─── Initialize Gemini with function calling ────────────
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const { GOOGLE_API_KEY } = await import('./config.js');
      const { AGENT_TOOL_DECLARATIONS, executeAgentTool } = await import('./agent/agentTools.js');
      const { McpBridge, discoverMcpConfigs } = await import('./agent/mcpBridge.js');

      if (!GOOGLE_API_KEY) {
        console.error('❌ GEMINI_API_KEY required for agent mode.');
        await closeStorage();
        process.exit(1);
        return;
      }

      // ─── MCP Server Discovery & Connection ──────────────────
      const mcpBridge = new McpBridge();
      const mcpConfigs = discoverMcpConfigs(process.cwd());
      const mcpServerNames = Object.keys(mcpConfigs);

      if (mcpServerNames.length > 0) {
        console.log(`\n🔌 Found ${mcpServerNames.length} MCP server(s):`);
        for (const [name, config] of Object.entries(mcpConfigs)) {
          try {
            const tools = await mcpBridge.connect(name, config);
            console.log(`  ✅ ${name} — ${tools.length} tool(s): ${tools.map(t => t.name).join(', ')}`);
          } catch (e) {
            console.log(`  ❌ ${name} — failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      // Merge built-in + MCP tools
      const allToolDeclarations = [
        ...AGENT_TOOL_DECLARATIONS,
        ...mcpBridge.getGeminiFunctionDeclarations(),
      ];

      const ai = new GoogleGenerativeAI(GOOGLE_API_KEY);
      const model = ai.getGenerativeModel({
        model: 'gemini-2.5-flash',
        systemInstruction: systemContext,
        tools: [{ functionDeclarations: allToolDeclarations }],
      });

      // Start a multi-turn chat
      const chat = model.startChat({ history: [] });

      console.log('\nType your questions below. Use /help for commands. Ctrl+C to exit.\n');

      // ─── REPL ───────────────────────────────────────────────
      const readline = await import('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '🧠 › ',
      });

      rl.prompt();

      rl.on('line', async (line: string) => {
        const input = line.trim();
        if (!input) { rl.prompt(); return; }

        // ─── Slash commands ─────────────────────────────────
        if (input === '/help') {
          console.log('\n  /image <path> [question]  — analyze an image');
          console.log('  /search <query>          — search Prism memory');
          console.log('  /todos                   — show open TODOs');
          console.log('  /context                 — show loaded context');
          console.log('  /exit                    — quit\n');
          rl.prompt();
          return;
        }
        if (input === '/exit' || input === '/quit') {
          rl.close();
          return;
        }
        if (input === '/todos') {
          if (contextData?.pending_todo?.length) {
            console.log('\n📋 Open TODOs:');
            contextData.pending_todo.forEach((t: string, i: number) => console.log(`  ${i + 1}. ${t}`));
          } else {
            console.log('\n✅ No open TODOs.');
          }
          console.log('');
          rl.prompt();
          return;
        }
        if (input === '/context') {
          console.log(`\n📂 Project: ${project}`);
          if (contextData?.last_summary) console.log(`📝 Last: ${contextData.last_summary}`);
          if (contextData?.active_branch) console.log(`🌿 Branch: ${contextData.active_branch}`);
          if (contextData?.keywords?.length) console.log(`🏷️  Keywords: ${contextData.keywords.join(', ')}`);
          console.log('');
          rl.prompt();
          return;
        }
        if (input.startsWith('/search ')) {
          const query = input.substring(8).trim();
          try {
            const { knowledgeSearchHandler } = await import('./tools/graphHandlers.js');
            const result = await knowledgeSearchHandler({ query, project, limit: 5 });
            const text = result.content?.[0] && 'text' in result.content[0] ? result.content[0].text : 'No results';
            console.log(`\n${text}\n`);
          } catch (e) {
            console.log(`\n❌ Search error: ${e instanceof Error ? e.message : String(e)}\n`);
          }
          rl.prompt();
          return;
        }

        // ─── /image command — multimodal ───────────────────
        if (input.startsWith('/image ')) {
          const parts = input.substring(7).trim().split(/\s+/);
          const imgPath = parts[0];
          const question = parts.slice(1).join(' ') || 'Describe this image in detail.';

          try {
            const fs = await import('fs');
            const resolvedPath = imgPath.startsWith('/') ? imgPath : (await import('path')).resolve(process.cwd(), imgPath);
            if (!fs.existsSync(resolvedPath)) {
              console.log(`\n❌ File not found: ${resolvedPath}\n`);
              rl.prompt();
              return;
            }

            const data = fs.readFileSync(resolvedPath);
            const base64 = data.toString('base64');
            const ext = resolvedPath.split('.').pop()?.toLowerCase() || 'png';
            const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
            const mimeType = mimeMap[ext] || 'image/png';

            console.log(`\n📸 Analyzing ${imgPath}...`);
            const result = await chat.sendMessage([
              { inlineData: { data: base64, mimeType } },
              question,
            ]);
            console.log(`\n${result.response.text()}\n`);
          } catch (e) {
            console.log(`\n❌ Image error: ${e instanceof Error ? e.message : String(e)}\n`);
          }
          rl.prompt();
          return;
        }

        // ─── Normal message — send to Gemini with tool calling loop ──
        try {
          let result = await chat.sendMessage(input);
          let response = result.response;

          // Function calling loop — execute tools until model is done
          let loopCount = 0;
          const MAX_TOOL_LOOPS = 10;

          while (loopCount < MAX_TOOL_LOOPS) {
            const calls = response.functionCalls();
            if (!calls || calls.length === 0) break;

            loopCount++;

            // Execute all tool calls
            const toolResults = [];
            for (const call of calls) {
              console.log(`  🔧 ${call.name}(${JSON.stringify(call.args).substring(0, 80)}...)`);
              try {
                const toolOutput = mcpBridge.hasToolName(call.name)
                  ? await mcpBridge.callTool(call.name, call.args as Record<string, unknown>)
                  : await executeAgentTool(
                    call.name,
                    call.args as Record<string, unknown>,
                    project,
                  );
                toolResults.push({
                  functionResponse: {
                    name: call.name,
                    response: { result: toolOutput },
                  },
                });
              } catch (e) {
                toolResults.push({
                  functionResponse: {
                    name: call.name,
                    response: { error: e instanceof Error ? e.message : String(e) },
                  },
                });
              }
            }

            // Send tool results back to model
            result = await chat.sendMessage(toolResults);
            response = result.response;
          }

          // Print final text response
          const text = response.text();
          if (text) {
            console.log(`\n${text}\n`);
          }
        } catch (e) {
          console.log(`\n❌ Error: ${e instanceof Error ? e.message : String(e)}\n`);
        }

        rl.prompt();
      });

      rl.on('close', async () => {
        console.log('\n👋 Session ended.');
        await mcpBridge.disconnectAll();
        await closeStorage();
        process.exit(0);
      });

      // Keep running
      await new Promise(() => { });
    } catch (err) {
      console.error(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program.parse(process.argv);

