import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, writeFile, readFile, symlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeActions, readContextFiles } from '../../src/darkfactory/actionExecutor.js';
import type { PipelineSpec } from '../../src/darkfactory/schema.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'factory-regressions-'));
  const outside = await mkdtemp(join(tmpdir(), 'factory-outside-'));
  await writeFile(join(root, 'source.txt'), 'before\n');
  await writeFile(join(root, 'other.txt'), 'protected\n');
  await writeFile(join(outside, 'private.txt'), 'outside-marker');
  const spec: PipelineSpec = { objective: 'isolated tests', maxIterations: 1, workingDirectory: root, allowedWritePaths: ['source.txt'], testCommand: 'node --test source.test.cjs' };
  return { root, outside, spec };
}

describe('Factory executor adversarial regressions', () => {
  it('rejects final symlinks in both READ_FILE and model context', async () => {
    const { root, outside, spec } = await fixture();
    await symlink(join(outside, 'private.txt'), join(root, 'link.txt'));
    await expect(executeActions([{ type: 'READ_FILE', targetPath: 'link.txt' }], spec, async () => true)).rejects.toThrow();
    await expect(readContextFiles({ ...spec, contextFiles: ['link.txt'] })).rejects.toThrow();
  });
  it('leaves no new file behind when later batch validation fails', async () => {
    const { root, spec } = await fixture();
    spec.allowedWritePaths = ['new.txt'];
    await expect(executeActions([{ type: 'WRITE_FILE', targetPath: 'new.txt', content: 'new' }, { type: 'READ_FILE', targetPath: '../outside.txt' }], spec, async () => true)).rejects.toThrow();
    await expect(access(join(root, 'new.txt'))).rejects.toThrow();
  });
  it('cannot patch a different file by lying in targetPath', async () => {
    const { root, spec } = await fixture();
    const patch = 'diff --git a/other.txt b/other.txt\n--- a/other.txt\n+++ b/other.txt\n@@ -1 +1 @@\n-protected\n+changed\n';
    await expect(executeActions([{ type: 'PATCH_FILE', targetPath: 'source.txt', patch }], spec, async () => true)).rejects.toThrow();
    expect(await readFile(join(root, 'other.txt'), 'utf8')).toBe('protected\n');
  });
  it('rejects package-root overrides instead of running an outside npm script', async () => {
    const { root, outside, spec } = await fixture();
    spec.testCommand = `npm test --prefix ${outside}`;
    await expect(executeActions([{ type: 'RUN_TEST', targetPath: '.', command: spec.testCommand }], spec, async () => true)).rejects.toThrow();
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('before\n');
  });
  it('uses a real failed assertion as failure evidence', async () => {
    const { root, spec } = await fixture();
    await writeFile(join(root, 'source.test.cjs'), "const test=require('node:test');const assert=require('node:assert/strict');test('regression',()=>assert.equal(1,2));");
    await expect(executeActions([{ type: 'RUN_TEST', targetPath: '.', command: spec.testCommand }], spec, async () => true)).rejects.toThrow(/RUN_TEST failed/);
  });
  it('an empty write allowlist prevents mutation', async () => {
    const { root, spec } = await fixture();
    await expect(executeActions([{ type: 'WRITE_FILE', targetPath: 'source.txt', content: 'changed' }], { ...spec, allowedWritePaths: [] }, async () => true)).rejects.toThrow();
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('before\n');
  });
  it.each(['pytest /tmp/outside_test.py', 'pytest ../outside_test.py', 'go test ./../outside', 'cargo test /tmp/outside', 'pytest --rootdir=/tmp'])('rejects outside test roots or command overrides: %s', async command => {
    const { root, spec } = await fixture();
    await expect(executeActions([{type:'RUN_TEST',targetPath:'.',command}], {...spec,testCommand:command}, async () => true)).rejects.toThrow();
    expect(await readFile(join(root,'source.txt'),'utf8')).toBe('before\n');
  });
  it('rejects a test path that resolves through an outside symlink', async () => {
    const {root,outside,spec}=await fixture();
    await symlink(outside,join(root,'tests'));
    const command='pytest tests/private.txt';
    await expect(executeActions([{type:'RUN_TEST',targetPath:'.',command}],{...spec,testCommand:command},async()=>true)).rejects.toThrow();
  });
  it('writes only through its opened descriptor when the pathname changes', async () => {
    const {root,outside,spec}=await fixture();
    const originalOpen=fs.open.bind(fs);
    const spy=vi.spyOn(fs,'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle=await originalOpen(...args);
      await fs.rename(join(root,'source.txt'),join(root,'original.txt'));
      await symlink(join(outside,'private.txt'),join(root,'source.txt'));
      return handle;
    });
    try {
      await executeActions([{type:'WRITE_FILE',targetPath:'source.txt',content:'changed'}],spec,async()=>true);
      expect(await readFile(join(outside,'private.txt'),'utf8')).toBe('outside-marker');
      expect(await readFile(join(root,'original.txt'),'utf8')).toBe('changed');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {spy.mockRestore();}
  });
  it('does not alter the file when abort arrives while its descriptor opens', async () => {
    const {root,spec}=await fixture();
    let running=true;
    const originalOpen=fs.open.bind(fs);
    const spy=vi.spyOn(fs,'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle=await originalOpen(...args);
      running=false;
      return handle;
    });
    try {
      await expect(executeActions([{type:'WRITE_FILE',targetPath:'source.txt',content:'changed'}],spec,async()=>running)).rejects.toThrow(/stopped/);
      expect(await readFile(join(root,'source.txt'),'utf8')).toBe('before\n');
    } finally {spy.mockRestore();}
  });
});
