#!/usr/bin/env node

import { Command } from 'commander';
import { SqliteStorage } from './storage/sqlite.js';
import { handleVerifyStatus, handleGenerateHarness } from './verification/cliHandler.js';
import * as path from 'path';
import { getStorage, closeStorage } from './storage/index.js';
import { getSetting } from './storage/configStorage.js';
import { PRISM_USER_ID, SERVER_CONFIG } from './config.js';
import { getCurrentGitState } from './utils/git.js';

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

program
  .command('load <project>')
  .description('Load session context for a project (same output as session_load_context MCP tool)')
  .option('-l, --level <level>', 'Context depth: quick, standard, deep', 'standard')
  .option('-r, --role <role>', 'Role scope for context loading')
  .option('--json', 'Emit machine-readable JSON instead of formatted text')
  .action(async (project: string, options: { level: string; role?: string; json?: boolean }) => {
    try {
      const { level, role, json: jsonOutput } = options;

      const validLevels = ['quick', 'standard', 'deep'];
      if (!validLevels.includes(level)) {
        console.error(`Error: Invalid level "${level}". Must be one of: ${validLevels.join(', ')}`);
        process.exit(1);
      }

      // Use the shared storage singleton (respects PRISM_STORAGE, dashboard config, etc.)
      const storage = await getStorage();
      const effectiveRole = role || await getSetting('default_role', '') || undefined;
      const agentName = await getSetting('agent_name', '') || undefined;
      const data = await storage.loadContext(project, level, PRISM_USER_ID, effectiveRole);

      if (!data) {
        if (jsonOutput) {
          console.log(JSON.stringify({ error: `No session context found for project "${project}"` }));
        } else {
          console.log(`No session context found for project "${project}" at level ${level}.`);
          console.log('This project has no previous session history. Starting fresh.');
        }
        await closeStorage();
        process.exit(0);
      }

      const d = data as Record<string, any>;

      // Gather git state for enrichment
      const gitState = getCurrentGitState();

      if (jsonOutput) {
        // Machine-readable JSON envelope — matches what prism_session_loader.sh produced
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
        // Human-readable formatted output (same format as MCP tool)
        let output = '';
        if (agentName) output += `🤖 Agent: ${agentName}\n`;
        output += `📋 Session context for "${project}" (${level}):\n\n`;
        if (d.last_summary) output += `📝 Last Summary: ${d.last_summary}\n`;
        if (d.active_branch) output += `🌿 Active Branch: ${d.active_branch}\n`;
        if (d.key_context) output += `💡 Key Context: ${d.key_context}\n`;

        if (d.pending_todo?.length) {
          output += `\n✅ Open TODOs:\n` + d.pending_todo.map((t: string) => `  - ${t}`).join('\n') + '\n';
        }
        if (d.active_decisions?.length) {
          output += `\n⚖️ Active Decisions:\n` + d.active_decisions.map((dec: string) => `  - ${dec}`).join('\n') + '\n';
        }
        if (d.keywords?.length) {
          output += `\n🔑 Keywords: ${d.keywords.join(', ')}\n`;
        }
        if (d.recent_sessions?.length) {
          output += `\n⏳ Recent Sessions:\n` + d.recent_sessions.map((s: any) =>
            `  [${s.session_date?.split('T')[0]}] ${s.summary}`
          ).join('\n') + '\n';
        }

        if (d.version != null) {
          output += `\n🔑 Session version: ${d.version}. Pass expected_version: ${d.version} when saving handoff.`;
        }

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
