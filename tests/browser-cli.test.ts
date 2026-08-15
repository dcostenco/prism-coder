/**
 * Prism Browser delivery and local-test safety contract.
 *
 * The catalog is not sufficient evidence: the npm tarball, CLI forwarding,
 * Python policy helpers, and a real pre-navigation injection must agree.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  pythonCandidates,
  hasPlaywrightRuntime,
  resolveBundledBrowserScript,
  resolvePythonCommand,
} from '../src/browserCli.js';

const scriptPath = resolve('scripts/dev/browse.py');
const python = resolvePythonCommand();

// These suites scrub HOME for isolation. On a machine where playwright lives
// in the USER site-packages (~/Library/Python/.../site-packages), scrubbing
// HOME also removes it from sys.path, so browse.py died with
// ModuleNotFoundError while the availability probe — which ran with the REAL
// process.env — reported the runtime as present. 14 tests failed instead of
// skipping. Carry the interpreter's user-site directory through explicitly,
// and probe under the SAME env the runs use.
const userSitePackages: string = (() => {
  if (!python) return '';
  const r = spawnSync(python.executable,
    [...python.prefixArgs, '-c', 'import site; print(site.getusersitepackages())'],
    { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : '';
})();

/** Scrubbed HOME that still resolves the Python runtime. */
function scrubbedEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const pythonPath = [userSitePackages, process.env.PYTHONPATH].filter(Boolean).join(':');
  return { ...process.env, HOME: home, ...(pythonPath ? { PYTHONPATH: pythonPath } : {}), ...extra };
}

const playwrightRuntimeAvailable = python
  ? hasPlaywrightRuntime(python, scrubbedEnv(tmpdir()))
  : false;
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
  it('ships the browser implementation in the npm allowlist', async () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('scripts/dev/browse.py');
    expect(pkg.files).toContain('docs/prism-browser.md');
    expect(existsSync(scriptPath)).toBe(true);
    expect(resolveBundledBrowserScript()).toBe(scriptPath);
  });

  it('honors an explicit Python executable without shell parsing', async () => {
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
  it('accepts only loopback and self-contained test URLs', async () => {
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

  it('rejects profile traversal and chooses profile settings deterministically', async () => {
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

  it('redacts URL secrets and PHI from a private audit log', async () => {
    const home = makeTempDir('prism-browser-audit-');
    const result = runPython([
      'browse.audit_log(',
      ' "open",',
      ' "https://user:password@example.test/private?token=secret#fragment",',
      ' "contact=patient@example.test source=https://example.test/path?code=hidden",',
      ')',
      'print(browse.AUDIT_LOG_PATH)',
    ].join('\n'), scrubbedEnv(home));

    expect(result.status, result.stderr).toBe(0);
    const auditPath = result.stdout.trim();
    const audit = readFileSync(auditPath, 'utf8');
    expectPosixMode(auditPath, 0o600);
    expectPosixMode(dirname(auditPath), 0o700);
    expect(audit).toContain('https://example.test/private');
    expect(audit).toContain('[EMAIL-REDACTED]');
    expect(audit).not.toMatch(/user|password|token|secret|fragment|hidden/);
  });

  it('requires local-only mode before loading a custom script', async () => {
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

  it('keeps the structured REPL help synchronized with executable commands', async () => {
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

describe.skipIf(!python || !browserRoot || !playwrightRuntimeAvailable)('Prism Browser real local acceptance', () => {
  it('reuses a named profile across separate browser launches', async () => {
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
    ].join('\n'), scrubbedEnv(home, { PLAYWRIGHT_BROWSERS_PATH: browserRoot! }));

    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      prism_acceptance: 'persisted',
    });
  }, 70_000);

  it('injects before page code, supports pipe interactions, and refuses remote navigation', async () => {
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
          ...scrubbedEnv(home),
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
    // eval returns the native JSON value, not a Python str() repr.
    expect(rows[6]).toMatchObject({ status: 'ok', result: 41 });
    expect(rows[7]).toMatchObject({ status: 'ok', result: 42 });
    expect(rows[8]).toMatchObject({ status: 'error', error_type: 'ValueError' });
    expect(rows[8].message).toContain('--local-only permits only loopback');

    const audit = readFileSync(join(home, '.browser_data', 'audit.log'), 'utf8');
    expect(audit).toContain('data:[redacted]');
    expect(audit).toContain('request_blocked | https://example.com/probe');
    expect(audit).not.toContain('must-not-leave-host');
    expect(audit).not.toContain('__prismInjected');
  }, 70_000);
});

// ---------------------------------------------------------------------------
// Regression contract for the 2026-07-29 adversarial review.
//
// Every case below reproduces a defect that was confirmed against the running
// CLI: silently unapplied stealth, a headless identity leak, a corrupted
// Object.getOwnPropertyDescriptor, discarded HTTP status, assertions that could
// not fail, Python reprs instead of JSON, an unenforced --local-only socket
// boundary, a no-op --cleanup, unvalidated screenshots, unreachable popups,
// and silent config fallback.
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

interface PipeRun {
  status: number | null;
  rows: Row[];
  stdout: string;
  stderr: string;
  home: string;
}

// One HOME for the whole regression block keeps the audit trail in a single
// file, but every run needs its own --profile: two Chromium instances cannot
// share a user-data-dir, and the second one blocks on the profile lock.
let sharedHome: string | null = null;
let profileCounter = 0;
function regressionHome(): string {
  if (!sharedHome) sharedHome = makeTempDir('prism-browser-regress-home-');
  return sharedHome;
}

// Must be async: spawnSync blocks the Node event loop, so an in-process
// fixture server cannot answer the browser's requests and every navigation
// stalls until it times out.
function runBrowser(
  args: string[],
  input: string,
  options: { home?: string; cwd?: string } = {},
): Promise<PipeRun> {
  const home = options.home ?? regressionHome();
  const env: NodeJS.ProcessEnv = scrubbedEnv(home);
  if (browserRoot) env.PLAYWRIGHT_BROWSERS_PATH = browserRoot;
  profileCounter += 1;
  return new Promise<PipeRun>((settle) => {
    const child = spawn(
      python!.executable,
      [
        ...python!.prefixArgs, scriptPath,
        '--headless', '--skip-fv-check', '--fast',
        '--profile', `regress-${profileCounter}`,
        ...args,
      ],
      { env, cwd: options.cwd, shell: false },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const rows = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as Row;
          } catch {
            return { unparsed: line } as Row;
          }
        });
      settle({ status: code, rows, stdout, stderr, home });
    });
    child.stdin.end(input);
  });
}

function runPipe(
  args: string[],
  commands: string[],
  options: { home?: string; cwd?: string } = {},
): Promise<PipeRun> {
  return runBrowser([...args, 'pipe'], `${commands.join('\n')}\n`, options);
}

function firstExternalIPv4(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

describe.skipIf(!python)('Prism Browser policy helpers (regression)', () => {
  it('fails loudly on an unparseable viewport instead of silently defaulting', async () => {
    const result = runPython([
      'out = {}',
      'for value in ["1440x900", "1440X900", "bogus", "1440x", "x900", ""]:',
      ' try: out[value] = list(browse.parse_viewport(value))',
      ' except ValueError: out[value] = "error"',
      'print(json.dumps(out))',
    ].join('\n'));

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      '1440x900': [1440, 900],
      '1440X900': [1440, 900],
      bogus: 'error',
      '1440x': 'error',
      x900: 'error',
      '': 'error',
    });
  });

  it('parses quoted selectors so a selector may contain spaces', async () => {
    const result = runPython([
      'print(json.dumps([',
      ' browse.split_args(\'"div > .cell" "two words"\', 2),',
      ' browse.split_args("#field local-first", 2),',
      ' browse.split_args("#field local first here", 2),',
      ']))',
    ].join('\n'));

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      ['div > .cell', 'two words'],
      ['#field', 'local-first'],
      ['#field', 'local first here'],
    ]);
  });

  it('sanitizes record identifiers held in an audited URL path', async () => {
    const result = runPython([
      'print(browse.redact_audit_target("https://ehr.test/patients/123456789/notes?token=x"))',
    ].join('\n'));

    expect(result.status, result.stderr).toBe(0);
    const redacted = result.stdout.trim();
    expect(redacted).toContain('[SSN-REDACTED]');
    expect(redacted).not.toContain('123456789');
    expect(redacted).not.toContain('token');
  });

  it('rejects ES module syntax that could never run as a preload script', async () => {
    const dir = makeTempDir('prism-browser-module-');
    const modulePath = join(dir, 'preload.mjs');
    writeFileSync(modulePath, 'export const flag = true;\n', 'utf8');
    const result = runPython([
      'try:',
      ` browse.load_local_init_script(${JSON.stringify(modulePath)})`,
      ' print("accepted")',
      'except ValueError as exc:',
      ' print(f"rejected: {exc}")',
    ].join('\n'));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('rejected:');
    expect(result.stdout).toContain('module');
  });

  it('fails the encryption check closed when it cannot be evaluated', async () => {
    const result = runPython([
      'def boom(*args, **kwargs): raise OSError("fdesetup unavailable")',
      'browse.subprocess.run = boom',
      'print(json.dumps({"allowed": browse.check_filevault()}))',
    ].join('\n'));

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ allowed: false });
  });

  it('derives client-hint metadata that agrees with the advertised user agent', async () => {
    const result = runPython([
      'ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36'
        + ' (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"',
      'major, full = browse.chrome_version_parts(ua)',
      'meta = browse.build_user_agent_metadata(ua)',
      'print(json.dumps({',
      ' "major": major, "full": full,',
      ' "brandVersions": sorted({b["version"] for b in meta["brands"]}),',
      ' "uaDataPlatform": meta["platform"],',
      ' "secChUa": browse.build_sec_ch_ua(major),',
      '}))',
    ].join('\n'));

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.major).toBe('131');
    expect(parsed.full).toBe('131.0.0.0');
    expect(parsed.brandVersions).toContain('131');
    expect(parsed.uaDataPlatform).toBe('macOS');
    expect(parsed.secChUa).toContain('v="131"');
    expect(parsed.secChUa).not.toContain('Headless');
  });

  it('reports what deletion actually guarantees on a copy-on-write volume', async () => {
    const dir = makeTempDir('prism-browser-wipe-');
    const target = join(dir, 'evidence.png');
    writeFileSync(target, 'not-really-a-png', 'utf8');
    const result = runPython([
      `print(json.dumps(browse.secure_delete(${JSON.stringify(target)})))`,
    ].join('\n'));

    expect(result.status, result.stderr).toBe(0);
    const outcome = JSON.parse(result.stdout);
    expect(outcome.removed).toBe(true);
    expect(outcome.overwritten).toBe(true);
    expect(outcome.guarantee).toContain('copy-on-write');
    expect(existsSync(target)).toBe(false);
  });
});

describe.skipIf(!python || !browserRoot || !playwrightRuntimeAvailable)('Prism Browser runtime regression', () => {
  let server: Server | null = null;
  let origin = '';
  const requestLog: Array<{ path: string; headers: Record<string, string | undefined> }> = [];

  const fixturePage = (body: string, title = 'Fixture Page') =>
    `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = req.url ?? '/';
      requestLog.push({ path, headers: req.headers as Record<string, string | undefined> });
      if (path === '/boom') {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(fixturePage('<p>server exploded</p>', '500 Internal Server Error'));
        return;
      }
      if (path === '/throws') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fixturePage(
          '<div id="app">ready</div>'
          + '<script>setTimeout(function () { throw new Error("REGRESSION_PAGE_ERROR"); }, 10);</script>',
        ));
        return;
      }
      if (path === '/second') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fixturePage('<div id="app">second</div>', 'Second Window'));
        return;
      }
      if (path === '/headers') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fixturePage('<div id="app">headers</div><script>fetch("/sub.txt");</script>'));
        return;
      }
      if (path === '/sub.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('sub');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      // The popup handler is attached with addEventListener rather than an
      // inline attribute: nested quoting inside an inline handler is a fixture
      // hazard, not the behavior under test.
      res.end(fixturePage(
        '<div id="app">ready</div><span class="cell">a</span><span class="cell">b</span>'
        + '<button id="go">Go</button>'
        + '<script>document.getElementById("go").addEventListener("click", function () {'
        + ' window.open("/second", "_blank");'
        + '});</script>',
      ));
    });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', () => done()));
    const address = server!.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((done) => server!.close(() => done()));
    server = null;
  });

  it('applies the stealth library instead of swallowing a constructor error', async () => {
    const run = await runPipe([], [`open ${origin}/`, 'fingerprint']);

    expect(run.status, run.stderr).toBe(0);
    const report = run.rows.find((row) => row.action === 'fingerprint');
    expect(report, run.stdout).toBeDefined();
    expect(report!.degraded).toEqual([]);
    expect(report!.report.consistent).toBe(true);

    const audit = readFileSync(join(run.home, '.browser_data', 'audit.log'), 'utf8');
    expect(audit).toContain('playwright-stealth | applied_v2');
    expect(audit).not.toContain('unexpected keyword argument');
  }, 70_000);

  it('keeps the user agent, client hints, and platform mutually consistent', async () => {
    const probe = 'JSON.stringify({'
      + 'ua: navigator.userAgent,'
      + 'brands: navigator.userAgentData.brands.map(b => b.brand + "/" + b.version).join(","),'
      + 'platform: navigator.platform,'
      + 'uaDataPlatform: navigator.userAgentData.platform'
      + '})';
    const run = await runPipe([], [`open ${origin}/headers`, 'wait 1', `eval ${probe}`]);

    expect(run.status, run.stderr).toBe(0);
    const evaluated = run.rows.find((row) => typeof row.result === 'string' && row.result.includes('brands'));
    expect(evaluated, run.stdout).toBeDefined();
    const observed = JSON.parse(evaluated!.result as string);

    // The headless build must not announce itself in either channel.
    expect(observed.brands).not.toContain('Headless');
    expect(observed.ua).not.toContain('Headless');
    expect(observed.platform).toBe('MacIntel');
    expect(observed.uaDataPlatform).toBe('macOS');

    const uaMajor = /Chrome\/(\d+)/.exec(observed.ua)?.[1];
    expect(uaMajor).toBeTruthy();
    expect(observed.brands).toContain(`Chromium/${uaMajor}`);

    const navigation = requestLog.filter((entry) => entry.path === '/headers').at(-1);
    const subresource = requestLog.filter((entry) => entry.path === '/sub.txt').at(-1);
    expect(navigation, 'navigation request not observed').toBeDefined();
    expect(subresource, 'subresource request not observed').toBeDefined();
    expect(navigation!.headers['sec-ch-ua']).toContain(`v="${uaMajor}"`);
    expect(navigation!.headers['sec-ch-ua']).not.toContain('Headless');
    expect(subresource!.headers['sec-ch-ua']).not.toContain('Headless');

    // Real Chrome sends Upgrade-Insecure-Requests only on navigations.
    expect(navigation!.headers['upgrade-insecure-requests']).toBe('1');
    expect(subresource!.headers['upgrade-insecure-requests']).toBeUndefined();
  }, 70_000);

  it('leaves Object.getOwnPropertyDescriptor and descriptor reads intact', async () => {
    const probe = 'JSON.stringify({'
      + 'iframeDescriptor: Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow") !== undefined,'
      + 'plainObject: Object.getOwnPropertyDescriptor({ contentWindow: 1 }, "contentWindow") !== undefined,'
      + 'gopdNative: Object.getOwnPropertyDescriptor.toString().includes("[native code]"),'
      + 'webglNative: WebGLRenderingContext.prototype.getParameter.toString().includes("[native code]")'
      + '})';
    const run = await runPipe([], [`open ${origin}/`, `eval ${probe}`]);

    expect(run.status, run.stderr).toBe(0);
    const evaluated = run.rows.find((row) => typeof row.result === 'string' && row.result.includes('iframeDescriptor'));
    expect(evaluated, run.stdout).toBeDefined();
    const observed = JSON.parse(evaluated!.result as string);

    expect(observed.iframeDescriptor).toBe(true);
    expect(observed.plainObject).toBe(true);
    expect(observed.gopdNative).toBe(true);
    // The WebGL patch must not expose its own source to a detector.
    expect(observed.webglNative).toBe(true);
  }, 70_000);

  it('treats an HTTP error page as a failure unless explicitly allowed', async () => {
    const failing = await runPipe([], [`open ${origin}/boom`]);
    expect(failing.status).toBe(1);
    expect(failing.rows[0]).toMatchObject({ status: 'failed', http_status: 500 });
    expect(failing.rows[0].message).toContain('HTTP 500');

    const allowed = await runPipe(['--allow-http-error'], [`open ${origin}/boom`]);
    expect(allowed.status).toBe(0);
    expect(allowed.rows[0]).toMatchObject({ status: 'ok', http_status: 500 });
  }, 70_000);

  it('fails assertions on wrong values and returns native JSON from eval', async () => {
    const run = await runPipe([], [
      `open ${origin}/`,
      'assert-title Fixture Page',
      'assert-text #app ready',
      'assert-count .cell 2',
      'assert-eval 1 === 1',
      'assert-title Wrong Title',
      'assert-text #app absent-text',
      'assert-count .cell 5',
      'assert-eval 1 === 2',
      'eval ({ a: 1, b: [2, 3] })',
      'eval null',
      'eval 41 + 1',
    ]);

    expect(run.status).toBe(1);
    const [, passTitle, passText, passCount, passEval,
      failTitle, failText, failCount, failEval,
      evalObject, evalNull, evalNumber] = run.rows;

    for (const row of [passTitle, passText, passCount, passEval]) {
      expect(row, run.stdout).toMatchObject({ status: 'ok', passed: true });
    }
    for (const row of [failTitle, failText, failCount, failEval]) {
      expect(row, run.stdout).toMatchObject({ status: 'failed', passed: false });
      expect(row.message).toBeTruthy();
    }
    expect(failCount).toMatchObject({ expected: 5, actual: 2 });

    // Python reprs ("None", "False", "{'a': 1}") are not JSON and broke every
    // programmatic consumer.
    expect(evalObject).toMatchObject({ status: 'ok', result: { a: 1, b: [2, 3] } });
    expect(evalNull.result).toBeNull();
    expect(evalNumber).toMatchObject({ result: 42 });
  }, 70_000);

  it('surfaces uncaught page exceptions and fails the run', async () => {
    const run = await runPipe([], [`open ${origin}/throws`, 'wait 1', 'assert-no-page-errors']);

    expect(run.status).toBe(1);
    const withDiagnostics = run.rows.find((row) => row.diagnostics?.page_errors?.length);
    expect(withDiagnostics, run.stdout).toBeDefined();
    expect(JSON.stringify(withDiagnostics!.diagnostics.page_errors)).toContain('REGRESSION_PAGE_ERROR');

    const assertion = run.rows.find((row) => row.assertion === 'no-page-errors');
    expect(assertion).toMatchObject({ status: 'failed', passed: false });
    expect(JSON.stringify(assertion!.page_errors)).toContain('REGRESSION_PAGE_ERROR');
  }, 70_000);

  it('captures console errors and failed requests for debugging', async () => {
    const run = await runPipe([], [
      `open ${origin}/`,
      'eval console.error("REGRESSION_CONSOLE") || true',
      'diagnostics',
    ]);

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('REGRESSION_CONSOLE');
  }, 70_000);

  it('stops a pipe run at the first failure when asked', async () => {
    const dir = makeTempDir('prism-browser-failfast-');
    const marker = join(dir, 'must-not-be-written.png');
    const run = await runPipe(['--fail-fast'], [`open ${origin}/boom`, `screenshot ${marker}`]);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('--fail-fast');
    // A stale-page screenshot after a failed navigation is exactly how a green
    // looking artifact gets captured for the wrong page.
    expect(existsSync(marker)).toBe(false);
  }, 70_000);

  it('writes unique screenshot names and refuses to call an empty frame evidence', async () => {
    const dir = makeTempDir('prism-browser-shots-');
    const captured = await runPipe([], [`open ${origin}/`, 'screenshot', 'screenshot'], { cwd: dir });

    expect(captured.status, captured.stderr).toBe(0);
    const paths = captured.rows.filter((row) => row.path).map((row) => row.path as string);
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
    for (const path of paths) expect(existsSync(path)).toBe(true);

    const blank = await runPipe([], ['open about:blank', 'screenshot'], { cwd: dir });
    expect(blank.status).toBe(1);
    const shot = blank.rows.find((row) => row.path);
    expect(shot, blank.stdout).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(shot!.warnings)).toContain('no text or visual elements');
  }, 90_000);

  it('honors --cleanup in pipe mode instead of leaving the capture on disk', async () => {
    const dir = makeTempDir('prism-browser-cleanup-');
    const run = await runPipe(['--cleanup'], [`open ${origin}/`, 'screenshot'], { cwd: dir });

    expect(run.status, run.stderr).toBe(0);
    const cleanup = run.rows.find((row) => row.action === 'cleanup');
    expect(cleanup, run.stdout).toBeDefined();
    expect(cleanup!.removed).toBe(true);
    expect(existsSync(cleanup!.path as string)).toBe(false);
  }, 70_000);

  it('makes a popup reachable so OAuth-style flows can be driven', async () => {
    const run = await runPipe([], [
      `open ${origin}/`,
      'click #go',
      'wait 1',
      'pages',
      'switch-page 1',
      'assert-title Second Window',
    ]);

    expect(run.status, run.stderr).toBe(0);
    const listing = run.rows.find((row) => row.action === 'pages');
    expect(listing, run.stdout).toBeDefined();
    expect(listing!.count).toBe(2);
    expect(run.rows.at(-1)).toMatchObject({ status: 'ok', passed: true, assertion: 'title-contains' });
  }, 70_000);
});

describe.skipIf(!python || !browserRoot || !playwrightRuntimeAvailable || !firstExternalIPv4())(
  'Prism Browser --local-only socket boundary',
  () => {
    let listener: TcpServer | null = null;
    let hits = 0;
    let target = '';

    beforeAll(async () => {
      const host = firstExternalIPv4()!;
      listener = createTcpServer((socket) => {
        hits += 1;
        socket.destroy();
      });
      await new Promise<void>((done) => listener!.listen(0, '0.0.0.0', () => done()));
      const address = listener!.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      target = `${host}:${port}`;
    });

    afterAll(async () => {
      if (listener) await new Promise<void>((done) => listener!.close(() => done()));
      listener = null;
    });

    it('blocks WebSocket, EventSource, and WebRTC egress that request routing cannot see', async () => {
      hits = 0;
      const html = '<html><body><script>'
        + 'window.__result = [];'
        + `try { new WebSocket('ws://${target}/leak'); window.__result.push('ws-allowed'); }`
        + " catch (e) { window.__result.push('ws-blocked:' + e.name); }"
        + `try { new EventSource('http://${target}/sse'); window.__result.push('sse-allowed'); }`
        + " catch (e) { window.__result.push('sse-blocked:' + e.name); }"
        + "try { new RTCPeerConnection(); window.__result.push('rtc-allowed'); }"
        + " catch (e) { window.__result.push('rtc-blocked:' + e.name); }"
        + '</script></body></html>';

      const run = await runPipe(['--local-only'], [
        `open data:text/html,${encodeURIComponent(html)}`,
        'wait 2',
        'eval JSON.stringify(window.__result)',
      ]);

      const evaluated = run.rows.find((row) => typeof row.result === 'string' && row.result.includes('blocked'));
      expect(evaluated, run.stdout).toBeDefined();
      const outcome = JSON.parse(evaluated!.result as string) as string[];
      expect(outcome).toEqual([
        'ws-blocked:SecurityError',
        'sse-blocked:SecurityError',
        'rtc-blocked:SecurityError',
      ]);

      // The confirmed hole: a WebSocket upgrade previously reached a
      // non-loopback listener while --local-only reported the run as isolated.
      expect(hits).toBe(0);
    }, 70_000);
  },
);

describe.skipIf(!python)('screenshot cap is viewport-bound, not viewport-normalizing', () => {
  // Regression, 2026-08-13: `_enforce_max_edge` shelled straight to `sips -Z`,
  // which resamples in BOTH directions. Every macOS capture came out at exactly
  // the cap on its long edge — a 1440x900 viewport was written as 1900x1187 —
  // so a screenshot asserted as viewport-bound was not evidence of what
  // rendered, and every acceptance gate built on that assertion was reading a
  // resampled image. The Pillow branch had always guarded correctly; only the
  // sips branch upscaled.
  //
  // These tests probe pixel dimensions through the same path the fix uses, so
  // they fail on the pre-fix code (which upscales the small PNG to the cap)
  // and pass after it.
  function writePng(dir: string, name: string, width: number, height: number): string {
    const path = join(dir, name);
    const result = runPython([
      'from PIL import Image',
      `Image.new("RGB", (${width}, ${height}), (10, 20, 30)).save(${JSON.stringify(path)})`,
      'print("ok")',
    ].join('\n'));
    if (result.status !== 0) return '';   // Pillow absent — caller skips
    return path;
  }

  function dimensions(path: string): [number, number] {
    const probe = runPython([
      'from PIL import Image',
      `im = Image.open(${JSON.stringify(path)})`,
      'print(json.dumps(list(im.size)))',
    ].join('\n'));
    return JSON.parse(probe.stdout.trim()) as [number, number];
  }

  it('leaves an already-small capture byte-identical', () => {
    const dir = makeTempDir('prism-capture-small-');
    const path = writePng(dir, 'small.png', 1440, 900);
    if (!path) return;                    // no Pillow in this runtime

    const before = statSync(path).size;
    const run = runPython([
      `warning = browse._enforce_max_edge(${JSON.stringify(path)}, 2000)`,
      'print(json.dumps({"warning": warning}))',
    ].join('\n'));
    expect(run.status, run.stderr).toBe(0);

    // The assertion that would have caught the original bug: a sub-cap image
    // must come back untouched, not resampled to the cap.
    expect(dimensions(path)).toEqual([1440, 900]);
    expect(statSync(path).size).toBe(before);
  });

  it('still shrinks a genuinely oversized capture', () => {
    const dir = makeTempDir('prism-capture-big-');
    const path = writePng(dir, 'big.png', 1200, 3000);
    if (!path) return;

    const run = runPython([
      `warning = browse._enforce_max_edge(${JSON.stringify(path)}, 2000)`,
      'print(json.dumps({"warning": warning}))',
    ].join('\n'));
    expect(run.status, run.stderr).toBe(0);

    const [width, height] = dimensions(path);
    expect(Math.max(width, height)).toBeLessThanOrEqual(2000);
    expect(width).toBeLessThan(1200);     // proportional, not cropped
  });

  it('caps at 2000 so a 1920-wide desktop viewport is never resampled', () => {
    // 1900 sat just under the standard 1920 desktop width, so the most common
    // UI-evidence capture was the one guaranteed to be rewritten.
    const source = readFileSync(scriptPath, 'utf8');
    expect(source).toMatch(/_enforce_max_edge\(path,\s*2000\)/);
    expect(source).not.toMatch(/_enforce_max_edge\(path,\s*1900\)/);
  });
});
