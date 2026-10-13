/**
 * Device-key creation never exposes a partial key file and never replaces an
 * existing one, including when first runs race (CodeQL js/file-system-race).
 *
 * node:fs is wrapped only to inject a competitor at an exact point (just
 * before the key is linked into place) and to observe the final path while
 * the key bytes are being written; every call still reaches the real fs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { keyIdOf, rawFromPublicKey } from '../src/crypto/syncEnvelope.js';
import { loadOrCreateDeviceIdentity } from '../src/crypto/deviceKeys.js';

const hooks = vi.hoisted(() => ({
  beforeLink: null as null | ((target: string) => void),
  linkErrorCode: null as null | string,
  beforeFsync: null as null | (() => void),
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const linkSync: typeof real.linkSync = (existing, target) => {
    hooks.beforeLink?.(String(target));
    if (hooks.linkErrorCode) {
      const error = new Error(`synthetic ${hooks.linkErrorCode}`) as NodeJS.ErrnoException;
      error.code = hooks.linkErrorCode;
      throw error;
    }
    return real.linkSync(existing, target);
  };
  const fsyncSync: typeof real.fsyncSync = (fd) => {
    hooks.beforeFsync?.();
    return real.fsyncSync(fd);
  };
  return { ...real, default: { ...real, linkSync, fsyncSync }, linkSync, fsyncSync };
});

const KEY = 'sync-device-key.pem';

function competitorPem(): { pem: string; keyId: string } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return {
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    keyId: keyIdOf(rawFromPublicKey(publicKey)),
  };
}

describe('device key creation races', () => {
  let dir: string;
  let keyPath: string;
  const prevDataDir = process.env.PRISM_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'device-key-race-'));
    keyPath = join(dir, KEY);
    process.env.PRISM_DATA_DIR = dir;
    hooks.beforeLink = null;
    hooks.linkErrorCode = null;
    hooks.beforeFsync = null;
  });

  afterEach(async () => {
    if (prevDataDir === undefined) delete process.env.PRISM_DATA_DIR;
    else process.env.PRISM_DATA_DIR = prevDataDir;
    await rm(dir, { recursive: true, force: true });
  });

  it('publishes the complete key only, with 0600 and no temp file left', () => {
    const seenWhileWriting: boolean[] = [];
    hooks.beforeFsync = () => seenWhileWriting.push(existsSync(keyPath));
    const id = loadOrCreateDeviceIdentity();
    expect(id.created).toBe(true);
    // While the key bytes were written, the final path did not exist yet.
    expect(seenWhileWriting).toEqual([false]);
    expect(readdirSync(dir)).toEqual([KEY]);
    expect(readFileSync(keyPath, 'utf8')).toMatch(/BEGIN PRIVATE KEY/);
    if (process.platform !== 'win32') expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(loadOrCreateDeviceIdentity().keyId).toBe(id.keyId);
  });

  it('a first run that loses the race keeps and returns the winner key', () => {
    const winner = competitorPem();
    hooks.beforeLink = (target) => {
      hooks.beforeLink = null;
      writeFileSync(target, winner.pem, { mode: 0o600, flag: 'wx' });
    };
    const id = loadOrCreateDeviceIdentity();
    expect(id.created).toBe(false);
    expect(id.keyId).toBe(winner.keyId);
    expect(readFileSync(keyPath, 'utf8')).toBe(winner.pem);
    expect(readdirSync(dir)).toEqual([KEY]);
  });

  it('falls back to exclusive create on a filesystem without hard links', () => {
    hooks.linkErrorCode = 'EPERM';
    const id = loadOrCreateDeviceIdentity();
    expect(id.created).toBe(true);
    expect(readdirSync(dir)).toEqual([KEY]);
    if (process.platform !== 'win32') expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    hooks.linkErrorCode = null;
    expect(loadOrCreateDeviceIdentity().keyId).toBe(id.keyId);
  });

  it('the fallback also yields to a key that appears first', () => {
    const winner = competitorPem();
    hooks.linkErrorCode = 'EPERM';
    hooks.beforeLink = (target) => {
      hooks.beforeLink = null;
      writeFileSync(target, winner.pem, { mode: 0o600, flag: 'wx' });
    };
    const id = loadOrCreateDeviceIdentity();
    expect(id.created).toBe(false);
    expect(id.keyId).toBe(winner.keyId);
    expect(readFileSync(keyPath, 'utf8')).toBe(winner.pem);
  });

  it('an existing path that cannot be read is never rotated', () => {
    mkdirSync(keyPath);
    expect(() => loadOrCreateDeviceIdentity()).toThrow(/refusing to rotate/);
    expect(statSync(keyPath).isDirectory()).toBe(true);
  });

  it('concurrent first runs in separate processes agree on one identity', async () => {
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    // A constant program run from the repo root; the start time arrives through env.
    const program =
      "const until = Number(process.env.START_AT); while (Date.now() < until) {}" +
      "import('./src/crypto/deviceKeys.ts').then((m) => { const id = m.loadOrCreateDeviceIdentity();" +
      " process.stdout.write(JSON.stringify({ keyId: id.keyId, created: id.created })); });";
    const startAt = String(Date.now() + 1500);
    const runs = await Promise.all(Array.from({ length: 6 }, () => new Promise<{ keyId: string; created: boolean }>((done, fail) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], {
        cwd: repoRoot,
        env: { ...process.env, PRISM_DATA_DIR: dir, START_AT: startAt },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('error', fail);
      child.on('close', (code) => (code === 0 ? done(JSON.parse(out)) : fail(new Error(`exit ${code}: ${err}`))));
    })));
    expect(new Set(runs.map((run) => run.keyId)).size).toBe(1);
    expect(runs.filter((run) => run.created)).toHaveLength(1);
    expect(readdirSync(dir)).toEqual([KEY]);
  }, 30_000);
});
