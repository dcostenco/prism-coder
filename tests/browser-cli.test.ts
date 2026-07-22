/**
 * Prism Browser delivery and local-test safety contract.
 *
 * The catalog is not sufficient evidence: the npm tarball, CLI forwarding,
 * Python policy helpers, and a real pre-navigation injection must agree.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  pythonCandidates,
  hasPlaywrightRuntime,
  resolveBundledBrowserScript,
  resolvePythonCommand,
} from '../src/browserCli.js';

const scriptPath = resolve('scripts/dev/browse.py');
const python = resolvePythonCommand();
const playwrightRuntimeAvailable = python ? hasPlaywrightRuntime(python) : false;
const tempDirs: string[] = [];

function expectPosixMode(path: string, mode: number): void {
  // Windows reports synthesized 0666/0777 mode bits; ACLs, not POSIX bits,
  // own access control there. Keep the permission contract strict on Unix.
  if (process.platform !== 'win32') {
    expect(statSync(path).mode & 0o777).toBe(mode);
  }
}

function makeTempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

function importSnippet(body: string): string {
  return [
    'import importlib.util, json',
    `spec = importlib.util.spec_from_file_location("prism_browse", ${JSON.stringify(scriptPath)})`,
    'browse = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(browse)',
    body,
  ].join('\n');
}

function runPython(body: string, env: NodeJS.ProcessEnv = process.env) {
  if (!python) throw new Error('Python 3 unavailable');
  return spawnSync(
    python.executable,
    [...python.prefixArgs, '-c', importSnippet(body)],
    { encoding: 'utf8', env, shell: false, timeout: 20_000 },
  );
}

function playwrightBrowserRoot(): string | null {
  if (!python) return null;
  const probe = spawnSync(
    python.executable,
    [...python.prefixArgs, '-c', [
      'from pathlib import Path',
      'from playwright.sync_api import sync_playwright',
      'with sync_playwright() as p:',
      ' print(p.chromium.executable_path)',
    ].join('\n')],
    { encoding: 'utf8', shell: false, timeout: 20_000 },
  );
  if (probe.status !== 0) return null;
  const executable = probe.stdout.trim();
  if (!existsSync(executable)) return null;
  let cursor = dirname(executable);
  while (dirname(cursor) !== cursor && !basename(cursor).startsWith('chromium')) {
    cursor = dirname(cursor);
  }
  return basename(cursor).startsWith('chromium') ? dirname(cursor) : null;
}

afterAll(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('Prism Browser package and launcher contract', () => {
  it('ships the browser implementation in the npm allowlist', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('scripts/dev/browse.py');
    expect(pkg.files).toContain('docs/prism-browser.md');
    expect(existsSync(scriptPath)).toBe(true);
    expect(resolveBundledBrowserScript()).toBe(scriptPath);
  });

  it('honors an explicit Python executable without shell parsing', () => {
    expect(pythonCandidates({ PRISM_PYTHON: '/opt/test/python' }, 'darwin')).toEqual([
      { executable: '/opt/test/python', prefixArgs: [] },
    ]);
  });

  it.skipIf(!python || !playwrightRuntimeAvailable)(
    'verifies the installed Python browser runtime before launching',
    () => {
    expect(hasPlaywrightRuntime(python!)).toBe(true);
    },
  );
});

describe.skipIf(!python)('Prism Browser Python safety helpers', () => {
  it('accepts only loopback and self-contained test URLs', () => {
    const result = runPython([
      'urls = [',
      ' "http://127.0.0.1:3000", "https://localhost/app", "http://app.localhost",',
      ' "data:text/html,ok", "about:blank", "https://localhost.evil.test",',
      ' "https://example.com", "file:///tmp/test.html", "javascript:alert(1)",',
      ']',
      'print(json.dumps([browse.is_local_test_url(url) for url in urls]))',
    ].join('\n'));

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      true, true, true, true, true, false, false, false, false,
    ]);
  });

  it('rejects profile traversal and chooses profile settings deterministically', () => {
    const body = [
      'invalid = []',
      'for name in ["../escape", "/tmp/escape", "two words", ""]:',
      ' try: browse.validate_profile_name(name)',
      ' except ValueError: invalid.append(name)',
      'print(json.dumps({"invalid": invalid, "index": browse.stable_profile_index("qa-profile", 5)}))',
    ].join('\n');
    const first = runPython(body);
    const second = runPython(body);

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual(JSON.parse(second.stdout));
    expect(JSON.parse(first.stdout).invalid).toEqual([
      '../escape', '/tmp/escape', 'two words', '',
    ]);
  });

  it('redacts URL secrets and PHI from a private audit log', () => {
    const home = makeTempDir('prism-browser-audit-');
    const result = runPython([
      'browse.audit_log(',
      ' "open",',
      ' "https://user:password@example.test/private?token=secret#fragment",',
      ' "contact=patient@example.test source=https://example.test/path?code=hidden",',
      ')',
      'print(browse.AUDIT_LOG_PATH)',
    ].join('\n'), { ...process.env, HOME: home });

    expect(result.status, result.stderr).toBe(0);
    const auditPath = result.stdout.trim();
    const audit = readFileSync(auditPath, 'utf8');
    expectPosixMode(auditPath, 0o600);
    expectPosixMode(dirname(auditPath), 0o700);
    expect(audit).toContain('https://example.test/private');
    expect(audit).toContain('[EMAIL-REDACTED]');
    expect(audit).not.toMatch(/user|password|token|secret|fragment|hidden/);
  });

  it('requires local-only mode before loading a custom script', () => {
    const dir = makeTempDir('prism-browser-script-');
    const initPath = join(dir, 'init.js');
    writeFileSync(initPath, 'window.__prismInjected = true;\n', 'utf8');
    chmodSync(initPath, 0o600);
    const result = spawnSync(
      python!.executable,
      [...python!.prefixArgs, scriptPath, '--skip-fv-check', '--inject', initPath, 'pipe'],
      { encoding: 'utf8', input: '', shell: false, timeout: 20_000 },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--inject requires --local-only');
  });

  it('keeps the structured REPL help synchronized with executable commands', () => {
    const result = runPython([
      'import io, sys',
      'class Session:',
      ' profile = "help-test"',
      ' stealth_level = "light"',
      'sys.stdin = io.StringIO("help\\nquit\\n")',
      'browse.run_repl(Session())',
    ].join('\n'));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('press <key>');
    expect(result.stdout).toContain('screenshot [path]');
  });
});

const browserRoot = playwrightBrowserRoot();

describe.skipIf(!python || !browserRoot)('Prism Browser real local acceptance', () => {
  it('reuses a named profile across separate browser launches', () => {
    const home = makeTempDir('prism-browser-profile-home-');
    const result = runPython([
      'with browse.StealthBrowserSession(profile="paid-proof", headless=True, stealth_level="light", local_only=True) as first:',
      ' first._context.add_cookies([{',
      '  "name": "prism_acceptance", "value": "persisted",',
      '  "url": "http://localhost", "expires": 1893456000,',
      ' }])',
      'with browse.StealthBrowserSession(profile="paid-proof", headless=True, stealth_level="light", local_only=True) as second:',
      ' cookies = second._context.cookies("http://localhost")',
      'print(json.dumps({cookie["name"]: cookie["value"] for cookie in cookies}))',
    ].join('\n'), {
      ...process.env,
      HOME: home,
      PLAYWRIGHT_BROWSERS_PATH: browserRoot!,
    });

    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      prism_acceptance: 'persisted',
    });
  }, 70_000);

  it('injects before page code, supports pipe interactions, and refuses remote navigation', () => {
    const home = makeTempDir('prism-browser-e2e-home-');
    const initPath = join(home, 'preload.js');
    writeFileSync(initPath, 'window.__prismInjected = "ready";\n', 'utf8');
    const html = [
      '<main>',
      '<div id="state"></div>',
      '<div id="network">pending</div>',
      '<input id="field" />',
      '<script>',
      'document.querySelector("#state").textContent = window.__prismInjected || "missing";',
      'fetch("https://example.com/probe?token=must-not-leave-host")',
      ' .then(() => { document.querySelector("#network").textContent = "leaked"; })',
      ' .catch(() => { document.querySelector("#network").textContent = "blocked"; });',
      '</script>',
      '</main>',
    ].join('');
    const input = [
      `open data:text/html,${encodeURIComponent(html)}`,
      'wait-for #state',
      'read-dom #state',
      'eval new Promise(resolve => { const check = () => { const value = document.querySelector("#network").textContent; if (value !== "pending") resolve(value); else setTimeout(check, 10); }; check(); })',
      'type #field local-first',
      'eval document.querySelector("#field").value',
      'eval window.__prismPipeState = 41',
      'eval ++window.__prismPipeState',
      'open https://example.com/?token=must-not-leave-host',
      '',
    ].join('\n');
    const result = spawnSync(
      python!.executable,
      [
        ...python!.prefixArgs,
        scriptPath,
        '--headless',
        '--skip-fv-check',
        '--stealth',
        'light',
        '--local-only',
        '--inject',
        initPath,
        'pipe',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          PLAYWRIGHT_BROWSERS_PATH: browserRoot!,
        },
        input,
        shell: false,
        timeout: 60_000,
      },
    );

    expect(result.signal, result.stderr).toBeNull();
    expect(result.status).toBe(1);
    const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(rows[0]).toMatchObject({ status: 'ok' });
    expect(rows[1]).toMatchObject({ status: 'ok', found: true });
    expect(rows[2]).toMatchObject({ status: 'ok', text: 'ready' });
    expect(rows[3]).toMatchObject({ status: 'ok', result: 'blocked' });
    expect(rows[4]).toMatchObject({ status: 'ok', action: 'type', chars: 11 });
    expect(rows[5]).toMatchObject({ status: 'ok', result: 'local-first' });
    expect(rows[6]).toMatchObject({ status: 'ok', result: '41' });
    expect(rows[7]).toMatchObject({ status: 'ok', result: '42' });
    expect(rows[8]).toMatchObject({ status: 'error', error_type: 'ValueError' });
    expect(rows[8].message).toContain('--local-only permits only loopback');

    const audit = readFileSync(join(home, '.browser_data', 'audit.log'), 'utf8');
    expect(audit).toContain('data:[redacted]');
    expect(audit).toContain('request_blocked | https://example.com/probe');
    expect(audit).not.toContain('must-not-leave-host');
    expect(audit).not.toContain('__prismInjected');
  }, 70_000);
});
