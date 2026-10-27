/**
 * Hard-link publication exposes a complete key and never replaces an existing
 * identity. The compatibility fallback retains exclusive creation.
 *
 * Wrappers exercise competing publication and selected filesystem failures.
 * Calls without an injected failure use the real filesystem.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
  beforeFsync: null as null | ((fd: number) => void),
  chmodErrorCode: null as null | string,
  unlinkErrorCode: null as null | string,
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
    hooks.beforeFsync?.(fd);
    return real.fsyncSync(fd);
  };
  const fchmodSync: typeof real.fchmodSync = (fd, mode) => {
    if (hooks.chmodErrorCode) throw Object.assign(new Error(`synthetic ${hooks.chmodErrorCode}`), { code: hooks.chmodErrorCode });
    return real.fchmodSync(fd, mode);
  };
  const unlinkSync: typeof real.unlinkSync = path => {
    if (hooks.unlinkErrorCode) throw Object.assign(new Error(`synthetic ${hooks.unlinkErrorCode}`), { code: hooks.unlinkErrorCode });
    return real.unlinkSync(path);
  };
  return { ...real, default: { ...real, linkSync, fsyncSync, fchmodSync, unlinkSync }, linkSync, fsyncSync, fchmodSync, unlinkSync };
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
    hooks.chmodErrorCode = null;
    hooks.unlinkErrorCode = null;
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
    const publishedDuringSync: boolean[] = [];
    hooks.beforeFsync = () => publishedDuringSync.push(existsSync(keyPath));
    const id = loadOrCreateDeviceIdentity();
    expect(id.created).toBe(true);
    expect(readdirSync(dir)).toEqual([KEY]);
    // Unlike the hard-link path, the fallback final file exists during writes.
    expect(publishedDuringSync).toEqual([false, true]);
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

  it('closes and removes the staged file if syncing fails, allowing a clean retry', () => {
    let descriptor = -1;
    hooks.beforeFsync = fd => { descriptor = fd; throw new Error('sync failed'); };
    expect(() => loadOrCreateDeviceIdentity()).toThrow('sync failed');
    expect(descriptor).toBeGreaterThanOrEqual(0);
    expect(() => fstatSync(descriptor)).toThrow();
    expect(readdirSync(dir)).toEqual([]);
    hooks.beforeFsync = null;
    expect(loadOrCreateDeviceIdentity().created).toBe(true);
  });

  it('propagates an unexpected publication failure and cleans its private staging file', () => {
    hooks.linkErrorCode = 'EIO';
    expect(() => loadOrCreateDeviceIdentity()).toThrow('synthetic EIO');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a disappearing winner after one publication attempt', () => {
    let attempts = 0;
    hooks.beforeLink = () => { if (++attempts > 1) throw new Error('unexpected retry'); };
    hooks.linkErrorCode = 'EEXIST';
    expect(() => loadOrCreateDeviceIdentity()).toThrow(/unavailable.*refusing to rotate/);
    expect(attempts).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('fails loudly if post-publication cleanup fails but keeps the published identity stable', () => {
    hooks.unlinkErrorCode = 'EPERM';
    expect(() => loadOrCreateDeviceIdentity()).toThrow('synthetic EPERM');
    const published = readFileSync(keyPath, 'utf8');
    const firstRead = loadOrCreateDeviceIdentity();
    expect(firstRead.created).toBe(false);
    expect(loadOrCreateDeviceIdentity().keyId).toBe(firstRead.keyId);
    expect(readFileSync(keyPath, 'utf8')).toBe(published);
    const leftovers = readdirSync(dir).filter(name => name !== KEY);
    expect(leftovers).toHaveLength(1);
    if (process.platform !== 'win32') expect(statSync(join(dir, leftovers[0])).mode & 0o777).toBe(0o600);
  });

  it('retains the primary operation failure when staging cleanup fails too', () => {
    hooks.linkErrorCode = 'EIO';
    hooks.unlinkErrorCode = 'EPERM';
    let failure: unknown;
    try { loadOrCreateDeviceIdentity(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors;
    expect(errors.map(error => error.code)).toEqual(['EIO', 'EPERM']);
    expect((failure as Error).cause).toBe(errors[0]);
    expect((failure as Error).message).toContain('synthetic EIO');
    expect(existsSync(keyPath)).toBe(false);
  });

  it('refuses unprotectable storage before publishing and gives relocation guidance', () => {
    hooks.chmodErrorCode = 'EPERM';
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => loadOrCreateDeviceIdentity()).toThrow(/PRISM_DATA_DIR.*private key permissions/);
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  it.each(['win32', 'linux'])('handles the Windows-specific unsupported-link error only on %s', platform => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    hooks.linkErrorCode = 'EISDIR';
    try {
      if (platform === 'win32') {
        const identity = loadOrCreateDeviceIdentity();
        expect(identity.created).toBe(true);
        expect(loadOrCreateDeviceIdentity().keyId).toBe(identity.keyId);
      } else {
        expect(() => loadOrCreateDeviceIdentity()).toThrow('synthetic EISDIR');
        expect(existsSync(keyPath)).toBe(false);
      }
    } finally { Object.defineProperty(process, 'platform', descriptor); }
  });

  it('does not reinterpret an unknown link failure as lack of hard-link support', () => {
    hooks.linkErrorCode = 'UNKNOWN';
    expect(() => loadOrCreateDeviceIdentity()).toThrow('synthetic UNKNOWN');
    expect(readdirSync(dir)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('preserves a dangling key symlink without recursion or creating its target', () => {
    const missing = join(dir, 'absent.pem');
    symlinkSync(missing, keyPath);
    let attempts = 0;
    hooks.beforeLink = () => { if (++attempts > 1) throw new Error('unexpected retry'); };
    expect(() => loadOrCreateDeviceIdentity()).toThrow(/unavailable.*refusing to rotate/);
    expect(attempts).toBe(1);
    expect(lstatSync(keyPath).isSymbolicLink()).toBe(true);
    expect(existsSync(missing)).toBe(false);
    expect(readdirSync(dir)).toEqual([KEY]);
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
