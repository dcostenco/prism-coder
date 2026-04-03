import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { SqliteStorage } from '../../src/storage/sqlite.js';

const exec = promisify(execCb);

// This test suite spans actual OS processes to verify the final binary contract.
describe('CLI Integration — Operator Contract & JSON Modes', () => {
  const cliPath = path.resolve(__dirname, '../../src/cli.ts');
  const dbPath = './prism-local.db';
  const harnessPath = './verification_harness.json';
  const execOpts = { env: { ...process.env, CI: '' } }; // Default to local env

  beforeAll(async () => {
    // Ensure clean state
    await fs.rm(dbPath, { force: true });
    await fs.rm(harnessPath, { force: true });
    
    // Create a dummy harness so we don't just hit the 'no file' branch
    await fs.writeFile(harnessPath, JSON.stringify({
      version: 1,
      conversation_id: 'c1',
      min_pass_rate: 1.0,
      tests: [{
        id: "sanity",
        layer: "testing",
        description: "sanity",
        severity: "block",
        assertion: { type: "file_contains", target: "package.json", expected: "name" }
      }]
    }));
  });

  afterAll(async () => {
    await fs.rm(dbPath, { force: true }).catch(() => {});
    await fs.rm(harnessPath, { force: true }).catch(() => {});
  });

  it('verify status (text mode) outputs human readable text', async () => {
    // We expect 0 exit code because there is no run, but it should not crash
    const { stdout, stderr } = await exec(`npx tsx "${cliPath}" verify status -p test-proj`, execOpts);
    
    expect(stdout).toContain('Checking verification status for project: test-proj');
    expect(stdout).toContain('No previous verification runs found');
    expect(stderr).toBe('');
  });

  it('verify status (--json mode) outputs schema-locked JSON', async () => {
    const { stdout, stderr } = await exec(`npx tsx "${cliPath}" verify status -p test-proj --json`, execOpts);
    
    const parsed = JSON.parse(stdout.trim());
    
    // Operator contract fields
    expect(parsed.schema_version).toBe(1);
    expect(parsed.project).toBe('test-proj');
    expect(parsed.no_runs).toBe(true);
    expect(parsed.exit_code).toBe(0);
    expect(stderr).toBe('');
  });

  it('verify generate (--json mode) registers harness and emits JSON', async () => {
    const { stdout, stderr } = await exec(`npx tsx "${cliPath}" verify generate -p test-proj --json`, execOpts);
    
    const parsed = JSON.parse(stdout.trim());
    
    expect(parsed.schema_version).toBe(1);
    expect(parsed.project).toBe('test-proj');
    expect(parsed.success).toBe(true);
    expect(parsed.test_count).toBe(1);
    expect(parsed.rubric_hash).toBeTruthy();
    expect(parsed.exit_code).toBe(0);
    expect(stderr).toBe('');
  });

  describe('End-to-end Strict-Policy Matrix (Drift)', () => {
    beforeAll(async () => {
      // Cause drift by mutating the local harness after generation
      await fs.writeFile(harnessPath, JSON.stringify({
        version: 1,
        conversation_id: 'c1',
        min_pass_rate: 1.0,
        tests: [{
          id: "drift-test",
          layer: "testing",
          description: "drift",
          severity: "block",
          assertion: { type: "file_contains", target: "package.json", expected: "version" }
        }]
      }));

      // Insert a fake run so drift is detected exactly (status requires a run)
      const storage = new SqliteStorage();
      await storage.initialize(dbPath);
      await (storage as any).db.execute({
        sql: "INSERT INTO verification_harnesses (rubric_hash, project, conversation_id, created_at, min_pass_rate, user_id, tests) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: ['old-fake-hash', 'test-proj', 'c1', new Date().toISOString(), 1.0, 'default', '[]']
      });
      await (storage as any).db.execute({
        sql: "INSERT INTO verification_runs (id, project, rubric_hash, conversation_id, run_at, passed, pass_rate, critical_failures, coverage_score, result_json, gate_action, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: ['fake-run', 'test-proj', 'old-fake-hash', 'c1', new Date().toISOString(), 1, 1, 0, 1, '{}', 'continue', 'default']
      });
      await storage.close();
    });

    it('Local Dev (CI=false, force=false) -> WARN, exit 0', async () => {
      const { stdout, stderr } = await exec(`npx tsx "${cliPath}" verify status -p test-proj --json`, execOpts);
      
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.drift.strict_env).toBe(false);
      expect(parsed.drift.policy).toBe('warn');
      expect(parsed.exit_code).toBe(0);
      
      // Phase 2 Diagnostics diff
      expect(parsed.drift.diff).toBeDefined();
      expect(parsed.drift.diff.added).toHaveLength(1);
      expect(parsed.drift.diff.added[0].id).toBe('drift-test');
      expect(parsed.drift.diff.removed).toHaveLength(0);
      expect(parsed.drift.diff.modified).toHaveLength(0);

      // Diagnostics v2: diff_counts
      expect(parsed.drift.diff_counts).toBeDefined();
      expect(parsed.drift.diff_counts.added).toBe(1);
      expect(parsed.drift.diff_counts.removed).toBe(0);
      expect(parsed.drift.diff_counts.modified).toBe(0);

      // Schema stability
      expect(parsed.schema_version).toBe(1);
    });

    it('Local Dev (text mode) renders diff_counts summary line', async () => {
      const { stdout } = await exec(`npx tsx "${cliPath}" verify status -p test-proj`, execOpts);
      
      // Diff Summary line should appear in human output
      expect(stdout).toContain('+1 added');
      expect(stdout).toContain('~0 modified');
      expect(stdout).toContain('-0 removed');
      // Individual changes line
      expect(stdout).toContain('+ drift-test:');
    });

    it('CI Environment (CI=true, force=false) -> BLOCKED, exit 1', async () => {
      const ciOpts = { env: { ...process.env, CI: 'true' } };
      let err: any;
      try {
        await exec(`npx tsx "${cliPath}" verify status -p test-proj --json`, ciOpts);
      } catch (e: any) {
        err = e;
      }
      
      expect(err).toBeDefined();
      // Code 1 because process.exitCode = 1
      expect(err.code).toBe(1);
      
      const parsed = JSON.parse(err.stdout.trim());
      expect(parsed.drift.strict_env).toBe(true);
      expect(parsed.drift.policy).toBe('blocked');
      expect(parsed.exit_code).toBe(1);
    });

    it('CI Environment + Force (CI=true, force=true) -> BYPASSED, exit 0', async () => {
      const ciOpts = { env: { ...process.env, CI: 'true' } };
      const { stdout } = await exec(`npx tsx "${cliPath}" verify status -p test-proj --force --json`, ciOpts);
      
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.drift.strict_env).toBe(true);
      expect(parsed.drift.policy).toBe('bypassed');
      expect(parsed.exit_code).toBe(0);
    });
  });
});
