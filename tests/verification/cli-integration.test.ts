import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { exec as execCb, execFile as execFileCb, spawn, type ChildProcess } from 'child_process';
import { createServer as createHttpServer } from 'node:http';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { mkdtempSync } from 'node:fs';
import * as os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import { readDashboardAccessUrl } from '../../src/dashboard/dashboardAccess.js';

const exec = promisify(execCb);
const execFile = promisify(execFileCb);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('CLI Integration — Operator Contract & JSON Modes', { timeout: 30_000 }, () => {
  const cliPath = path.resolve(__dirname, '../../dist/cli.js');
  
  // Unique, owner-only temp dir (mkdtemp random suffix) for the duration of this
  // test file — not a predictable path, so a pre-planted symlink can't be followed.
  const tmpBase = mkdtempSync(path.join(os.tmpdir(), 'prism-cli-'));
  const dbPath = path.join(tmpBase, 'prism-test.db');
  const harnessPath = path.join(tmpBase, 'harness.json');
  
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
    await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
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
      // (Don't log baseEnv values — CodeQL js/clear-text-logging flags env
      // vars as potentially sensitive; harnessPath above is sufficient for
      // diagnosing this failure.)
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

async function reserveLoopbackPort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a dashboard test port');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('CLI Integration — accountless Prism Free dashboard', { timeout: 30_000 }, () => {
  const cliPath = path.resolve(__dirname, '../../dist/cli.js');
  const dashboardModule = pathToFileURL(path.resolve(__dirname, '../../dist/dashboard/server.js')).href;
  const configStorageModule = pathToFileURL(path.resolve(__dirname, '../../dist/storage/configStorage.js')).href;
  const sqliteStorageModule = pathToFileURL(path.resolve(__dirname, '../../dist/storage/sqlite.js')).href;
  const localToken = 'integration-local-capability';
  const localProject = 'signed-out-local-project';
  let home: string;
  let port: number;
  let dashboardProcess: ChildProcess | null = null;
  let dashboardStderr = '';
  let dashboardEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    home = mkdtempSync(path.join(os.tmpdir(), 'prism-free-dashboard-'));
    port = await reserveLoopbackPort();
    dashboardEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PRISM_DASHBOARD_PORT: String(port),
      PRISM_DASHBOARD_TOKEN: localToken,
      PRISM_DASHBOARD_NO_TOKEN: '',
      PRISM_DASHBOARD_USER: '',
      PRISM_DASHBOARD_PASS: '',
      PRISM_JWKS_URI: '',
      AUTH_JWKS_URI: '',
      // Preserve a user's cloud preference while proving deliberate sign-out
      // still serves the local Free dashboard without a restart.
      PRISM_STORAGE: 'synalux',
      PRISM_SYNALUX_BASE_URL: 'https://portal.synalux.example',
      PRISM_SYNALUX_API_KEY: 'stale-token-must-not-be-used',
      PRISM_DATA_DIR: path.join(home, 'data'),
      PRISM_CONFIG_PATH: path.join(home, 'config.db'),
      PRISM_SKILL_SYNC_DISABLED: 'true',
    };

    dashboardProcess = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          const { setSetting } = await import(${JSON.stringify(configStorageModule)});
          await setSetting('PRISM_SYNALUX_SIGNED_OUT', 'true');
          await setSetting('PRISM_SYNALUX_API_KEY', '');
          const { SqliteStorage } = await import(${JSON.stringify(sqliteStorageModule)});
          const local = new SqliteStorage();
          await local.initialize(true);
          await local.saveHandoff({
            project: ${JSON.stringify(localProject)},
            user_id: 'default',
            last_summary: 'Signed-out local handoff',
            pending_todo: ['Keep local projects available'],
            keywords: ['local-free'],
          });
          await local.saveLedger({
            project: ${JSON.stringify(localProject)},
            conversation_id: 'signed-out-dashboard-regression',
            user_id: 'default',
            summary: 'Signed-out local session',
            keywords: ['local-free'],
          });
          await local.close();
          const { startDashboardServer } = await import(${JSON.stringify(dashboardModule)});
          await startDashboardServer();
        `,
      ],
      { cwd: path.resolve(__dirname, '../..'), env: dashboardEnv, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    dashboardProcess.stderr?.on('data', (chunk) => { dashboardStderr += String(chunk); });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (dashboardProcess.exitCode !== null) {
        throw new Error(`Dashboard fixture exited early (${dashboardProcess.exitCode}): ${dashboardStderr}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
        if (response.status === 200) return;
      } catch { /* server is still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Dashboard fixture did not start: ${dashboardStderr}`);
  });

  afterAll(async () => {
    if (dashboardProcess && dashboardProcess.exitCode === null) {
      dashboardProcess.kill();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        dashboardProcess?.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  it('opens local Free access through the CLI while account linking remains optional and gated', async () => {
    const coldPage = await fetch(`http://127.0.0.1:${port}/`);
    expect(coldPage.status).toBe(200);
    const coldHtml = await coldPage.text();
    expect(coldHtml).toContain('Open the current Prism dashboard');
    expect(coldHtml).toContain('account and plan remain unchanged');
    expect(coldHtml).not.toContain('Local Prism Free');
    expect(coldHtml).toContain('prism dashboard');
    expect(coldHtml).not.toContain(localToken);
    expect(dashboardStderr).not.toContain(localToken);

    const unauthenticatedApi = await fetch(`http://127.0.0.1:${port}/api/account`);
    expect(unauthenticatedApi.status).toBe(401);

    const unauthenticatedProbe = await fetch(`http://127.0.0.1:${port}/api/dashboard/probe`);
    expect(unauthenticatedProbe.status).toBe(401);

    const { stdout } = await execFile(process.execPath, [cliPath, 'dashboard', '--print'], {
      cwd: path.resolve(__dirname, '../..'),
      env: dashboardEnv,
    });
    const dashboardUrl = stdout.trim();
    expect(dashboardUrl).toBe(readDashboardAccessUrl(home));
    expect(new URL(dashboardUrl).searchParams.get('token')).toBe(localToken);

    const establishSession = await fetch(dashboardUrl, { redirect: 'manual' });
    expect(establishSession.status).toBe(302);
    expect(establishSession.headers.get('location')).toBe('/');
    const cookie = establishSession.headers.get('set-cookie')?.split(';', 1)[0];
    expect(cookie).toMatch(new RegExp(`^prism_dashboard_token_${port}=`));

    const account = await fetch(`http://127.0.0.1:${port}/api/account`, {
      headers: { Cookie: cookie ?? '' },
    });
    expect(account.status).toBe(200);
    await expect(account.json()).resolves.toMatchObject({
      signed_in: false,
      configured: false,
      plan: 'free',
    });

    const projects = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      headers: { Cookie: cookie ?? '' },
    });
    expect(projects.status).toBe(200);
    await expect(projects.json()).resolves.toMatchObject({ projects: [localProject] });

    const project = await fetch(
      `http://127.0.0.1:${port}/api/project?name=${encodeURIComponent(localProject)}`,
      { headers: { Cookie: cookie ?? '' } },
    );
    expect(project.status).toBe(200);
    await expect(project.json()).resolves.toMatchObject({
      context: { last_summary: 'Signed-out local handoff' },
      ledger: [{ summary: 'Signed-out local session' }],
    });

    const graph = await fetch(
      `http://127.0.0.1:${port}/api/graph?project=${encodeURIComponent(localProject)}`,
      { headers: { Cookie: cookie ?? '' } },
    );
    expect(graph.status).toBe(200);
    await expect(graph.json()).resolves.toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: localProject }),
        expect.objectContaining({ id: 'local-free' }),
      ]),
    });

    const accountCodeCannotUnlockLocalAccess = await fetch(`http://127.0.0.1:${port}/api/account/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'synalux_code_not_a_real_code' }),
    });
    expect(accountCodeCannotUnlockLocalAccess.status).toBe(401);
  });
});
