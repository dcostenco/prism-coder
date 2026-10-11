import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeActions } from '../../src/darkfactory/actionExecutor.js';

async function fixture(delay: number) {
  const root = await fs.mkdtemp(join(tmpdir(), 'factory-command-guard-'));
  await fs.writeFile(join(root, 'probe.test.cjs'), `const fs=require('node:fs');require('node:test')('guard',async()=>{fs.writeFileSync('ready','yes');await new Promise(r=>setTimeout(r,${delay}));fs.writeFileSync('late','bad');});\n`);
  const exists = (name: string) => fs.access(join(root, name)).then(() => true, () => false);
  const spec = { objective: 'isolated command authority check', maxIterations: 1, workingDirectory: root, testCommand: 'node --test probe.test.cjs' };
  return { root, exists, spec, action: { type: 'RUN_TEST' as const, targetPath: '.', command: spec.testCommand } };
}

describe('Factory command authority checks', () => {
  it('does not start another action after revocation during an authorized write', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'factory-inflight-write-'));
    const target = join(root, 'source.txt');
    await fs.writeFile(target, 'original');
    let running = true;
    const originalOpen = fs.open;
    fs.open = async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      const truncate = handle.truncate.bind(handle);
      handle.truncate = async length => { running = false; await truncate(length); };
      return handle;
    };
    try {
      await expect(executeActions([
        { type: 'WRITE_FILE', targetPath: 'source.txt', content: 'authorized-first-write' },
        { type: 'WRITE_FILE', targetPath: 'source.txt', content: 'must-not-start' },
      ], { objective: 'checked action boundaries', maxIterations: 1, workingDirectory: root, allowedWritePaths: ['source.txt'] }, async () => running)).rejects.toThrow(/stopped/);
      expect(await fs.readFile(target, 'utf8')).toBe('authorized-first-write');
    } finally { fs.open = originalOpen; await fs.rm(root, { recursive: true, force: true }); }
  });

  it('cancels through the local lease without repeatedly polling remote status', async () => {
    const f = await fixture(400);
    let remoteReads = 0;
    try {
      await expect(executeActions([f.action], f.spec, async () => { remoteReads++; return true; }, async () => !(await f.exists('ready')))).rejects.toThrow(/stopped/);
      expect(await f.exists('ready')).toBe(true);
      expect(remoteReads).toBeLessThanOrEqual(3);
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(await f.exists('late')).toBe(false);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });

  it('detects a remote abort even while the local lease remains held', async () => {
    const f = await fixture(1_700);
    try {
      await expect(executeActions([f.action], f.spec, async () => !(await f.exists('ready')), async () => true)).rejects.toThrow(/stopped/);
      expect(await f.exists('ready')).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 800));
      expect(await f.exists('late')).toBe(false);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
});
