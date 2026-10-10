import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeActions } from '../../src/darkfactory/actionExecutor.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

const setup = async () => { const dir = await mkdtemp(join(tmpdir(), 'factory-actions-')); await writeFile(join(dir, 'source.txt'), 'before\n'); return { dir, spec: { objective: 'x', maxIterations: 1, workingDirectory: dir, allowedWritePaths: ['source.txt'], testCommand: 'node --test source.test.cjs' } as any }; };

describe('Factory action executor', () => {
  it('writes and reads actual bounded workspace files', async () => {
    const { dir, spec } = await setup();
    const result = await executeActions([{ type: 'WRITE_FILE', targetPath: 'source.txt', content: 'after\n' }, { type: 'READ_FILE', targetPath: 'source.txt' }], spec, async () => true);
    expect(result.join('\n')).toContain('after'); expect(await readFile(join(dir, 'source.txt'), 'utf8')).toBe('after\n');
  });
  it('rejects a symlink target and invalid second action before writing', async () => {
    const { dir, spec } = await setup(); await symlink('/tmp', join(dir, 'link'));
    await expect(executeActions([{ type: 'WRITE_FILE', targetPath: 'source.txt', content: 'bad' }, { type: 'WRITE_FILE', targetPath: 'link/escape', content: 'bad' }], spec, async () => true)).rejects.toThrow();
    expect(await readFile(join(dir, 'source.txt'), 'utf8')).toBe('before\n');
  });
  it.each(['node --test -e x', 'cargo publish', 'npm test && echo bad'])('rejects unsafe test command %s', async command => {
    const { spec } = await setup(); spec.testCommand = command;
    await expect(executeActions([{ type: 'RUN_TEST', targetPath: 'source.test.cjs', command }], spec, async () => true)).rejects.toThrow();
  });
  it('fails closed when the pipeline stops before actions', async () => {
    const { spec } = await setup(); await expect(executeActions([{ type: 'WRITE_FILE', targetPath: 'source.txt', content: 'bad' }], spec, async () => false)).rejects.toThrow(/stopped/);
  });
  it('runs real passing and failing node tests and applies one-file patches', async () => {
    const { dir, spec } = await setup();
    await writeFile(join(dir, 'pass.test.cjs'), "const test=require('node:test');test('pass',()=>{});\n");
    spec.testCommand = 'node --test pass.test.cjs';
    expect((await executeActions([{ type: 'RUN_TEST', targetPath: '.', command: spec.testCommand }], spec, async () => true)).join()).toContain('passed');
    spec.testCommand = 'node --test missing.test.cjs';
    await expect(executeActions([{ type: 'RUN_TEST', targetPath: '.', command: spec.testCommand }], spec, async () => true)).rejects.toThrow(/failed/);
    await run('git', ['init'], { cwd: dir }); await run('git', ['add', 'source.txt'], { cwd: dir });
    const patch = 'diff --git a/source.txt b/source.txt\n--- a/source.txt\n+++ b/source.txt\n@@ -1 +1 @@\n-before\n+patched\n';
    spec.allowedWritePaths = ['source.txt'];
    expect((await executeActions([{ type: 'PATCH_FILE', targetPath: 'source.txt', patch }], spec, async () => true)).join()).toContain('ok');
    expect(await readFile(join(dir, 'source.txt'), 'utf8')).toBe('patched\n');
    await expect(executeActions([{ type: 'PATCH_FILE', targetPath: 'source.txt', patch: patch.replace('--- a/source.txt', 'rename from source.txt') }], spec, async () => true)).rejects.toThrow();
  });
});
