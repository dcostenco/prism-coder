import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { SqliteStorage } from '../../src/storage/sqlite.js';

const exec = promisify(execCb);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('CLI Integration — Operator Contract & JSON Modes', { timeout: 30_000 }, () => {
  const cliPath = path.resolve(__dirname, '../../dist/cli.js');
  
  // Use stable temp paths for the duration of this test file
  const testId = Date.now();
  const dbPath = path.resolve(os.tmpdir(), `prism-test-${testId}.db`);
  const harnessPath = path.resolve(os.tmpdir(), `harness-${testId}.json`);
  
  const baseEnv = { 
    ...process.env, 
    PRISM_DB_PATH: dbPath,
    PRISM_HARNESS_PATH: harnessPath,
    CI: '', 
    GITHUB_ACTIONS: '', 
    GITLAB_CI: '', 
    PRISM_STRICT_VERIFICATION: '' 
  };

  beforeAll(async () => {
    // Ensure clean state
    await fs.rm(dbPath, { force: true }).catch(() => {});
    await fs.rm(`${dbPath}-wal`, { force: true }).catch(() => {});
    await fs.rm(`${dbPath}-shm`, { force: true }).catch(() => {});
    await fs.rm(harnessPath, { force: true }).catch(() => {});
    
    // Create a dummy harness
    const harnessContent = JSON.stringify({
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
    });
    await fs.writeFile(harnessPath, harnessContent);
    
    // Double check it exists
    const exists = await fs.access(harnessPath).then(() => true).catch(() => false);
    if (!exists) throw new Error(`Failed to create harness at ${harnessPath}`);
  });

  afterAll(async () => {
    await fs.rm(dbPath, { force: true }).catch(() => {});
    await fs.rm(`${dbPath}-wal`, { force: true }).catch(() => {});
    await fs.rm(`${dbPath}-shm`, { force: true }).catch(() => {});
    await fs.rm(harnessPath, { force: true }).catch(() => {});
  });

  it('verify status (text mode) outputs human readable text', async () => {
    const { stdout } = await exec(`node "${cliPath}" verify status -p test-proj`, { env: baseEnv });
    expect(stdout).toContain('Checking verification status for project: test-proj');
  });

  it('verify status (--json mode) outputs schema-locked JSON', async () => {
    const { stdout } = await exec(`node "${cliPath}" verify status -p test-proj --json`, { env: baseEnv });
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.schema_version).toBe(1);
    expect(parsed.no_runs).toBe(true);
  });

  it('verify generate (--json mode) registers harness and emits JSON', async () => {
    const { stdout } = await exec(`node "${cliPath}" verify generate -p test-proj --json`, { env: baseEnv });
    const parsed = JSON.parse(stdout.trim());
    
    if (parsed.file_missing) {
      console.error('CLI reported file missing. Path:', harnessPath);
      console.error('Env PRISM_HARNESS_PATH:', baseEnv.PRISM_HARNESS_PATH);
    }
    
    expect(parsed.success).toBe(true);
    expect(parsed.test_count).toBe(1);
  });

  describe('End-to-end Strict-Policy Matrix (Drift)', () => {
    beforeAll(async () => {
      // Mutate the local harness to cause drift
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

      // Insert a fake run into the DB
      const storage = new SqliteStorage();
      await storage.initialize(true, dbPath);
      await (storage as any).db.execute({
        sql: "INSERT OR IGNORE INTO verification_harnesses (rubric_hash, project, conversation_id, created_at, min_pass_rate, user_id, tests) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: ['old-fake-hash', 'test-proj', 'c1', new Date().toISOString(), 1.0, 'default', '[]']
      });
      await (storage as any).db.execute({
        sql: "INSERT OR IGNORE INTO verification_runs (id, project, rubric_hash, conversation_id, run_at, passed, pass_rate, critical_failures, coverage_score, result_json, gate_action, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: ['fake-run', 'test-proj', 'old-fake-hash', 'c1', new Date().toISOString(), 1, 1, 0, 1, '{}', 'continue', 'default']
      });
      await storage.close();
    });

    it('Local Dev (CI=false) -> WARN, exit 0', async () => {
      const { stdout } = await exec(`node "${cliPath}" verify status -p test-proj --json`, { env: baseEnv });
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.drift).toBeDefined();
      expect(parsed.drift.policy).toBe('warn');
      expect(parsed.exit_code).toBe(0);
    });

    it('CI Environment (CI=true) -> BLOCKED, exit 1', async () => {
      const ciEnv = { ...baseEnv, CI: 'true' };
      try {
        await exec(`node "${cliPath}" verify status -p test-proj --json`, { env: ciEnv });
        throw new Error('Should have failed');
      } catch (err: any) {
        if (err.message === 'Should have failed') throw err;
        const parsed = JSON.parse(err.stdout.trim());
        expect(parsed.drift.policy).toBe('blocked');
        expect(parsed.exit_code).toBe(1);
      }
    });

    it('CI Environment + Force -> BYPASSED, exit 0', async () => {
      const ciEnv = { ...baseEnv, CI: 'true' };
      const { stdout } = await exec(`node "${cliPath}" verify status -p test-proj --force --json`, { env: ciEnv });
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.drift.policy).toBe('bypassed');
      expect(parsed.exit_code).toBe(0);
    });
  });
});
