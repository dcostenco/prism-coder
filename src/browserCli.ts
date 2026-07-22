import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface PythonCommand {
  executable: string;
  prefixArgs: string[];
}

export function resolveBundledBrowserScript(): string {
  return fileURLToPath(new URL('../scripts/dev/browse.py', import.meta.url));
}

export function pythonCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PythonCommand[] {
  if (env.PRISM_PYTHON) {
    return [{ executable: env.PRISM_PYTHON, prefixArgs: [] }];
  }
  return platform === 'win32'
    ? [
        { executable: 'py', prefixArgs: ['-3'] },
        { executable: 'python', prefixArgs: [] },
      ]
    : [
        { executable: 'python3', prefixArgs: [] },
        { executable: 'python', prefixArgs: [] },
      ];
}

export function resolvePythonCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PythonCommand | null {
  for (const candidate of pythonCandidates(env, platform)) {
    const result = spawnSync(
      candidate.executable,
      [...candidate.prefixArgs, '--version'],
      { env, encoding: 'utf8', shell: false },
    );
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

export function hasPlaywrightRuntime(
  python: PythonCommand,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const result = spawnSync(
    python.executable,
    [...python.prefixArgs, '-c', 'import playwright.sync_api'],
    { env, encoding: 'utf8', shell: false },
  );
  return !result.error && result.status === 0;
}

export async function runBrowserCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const scriptPath = resolveBundledBrowserScript();
  if (!existsSync(scriptPath)) {
    throw new Error(`Bundled Prism Browser script is missing: ${scriptPath}`);
  }

  const python = resolvePythonCommand(env);
  if (!python) {
    throw new Error(
      'Python 3 is required for Prism Browser. Set PRISM_PYTHON to a Python 3 executable.',
    );
  }
  if (!args.includes('--help') && !args.includes('-h') && !hasPlaywrightRuntime(python, env)) {
    throw new Error(
      'Python Playwright is required. Run: pip3 install playwright playwright-stealth && python3 -m playwright install chromium',
    );
  }

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(
      python.executable,
      [...python.prefixArgs, scriptPath, ...args],
      { env, shell: false, stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Prism Browser terminated by signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}
