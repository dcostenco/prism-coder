import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import { SafetyController } from '../../src/darkfactory/safetyController.js';
import type { PipelineState, PipelineStatus } from '../../src/storage/interface.js';

let storage: SqliteStorage | undefined;
afterEach(async () => { await storage?.close(); storage = undefined; });

describe('Factory progress remains writable while lifecycle is RUNNING', () => {
  it('persists queue pickup, step progress, heartbeat and abort without reviving an aborted run', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'factory-progress-'));
    storage = new SqliteStorage();
    await storage.initialize(true, join(folder, 'data.db'));
    const timestamp = new Date().toISOString();
    const queued: PipelineState = {
      id: randomUUID(), project: 'factory-progress-test', user_id: 'isolated-test-owner',
      status: 'PENDING', current_step: 'INIT', iteration: 0,
      spec: JSON.stringify({ objective: 'Verify isolated lifecycle persistence', workingDirectory: folder, maxIterations: 1 }),
      error: null, started_at: timestamp, updated_at: timestamp, last_heartbeat: timestamp,
    };
    await storage.savePipeline(queued);
    const running = { ...queued, status: 'RUNNING' as const };
    await storage.savePipeline(running);
    const heartbeat = new Date(Date.now() + 1000).toISOString();
    await storage.savePipeline({ ...running, current_step: 'PLAN', last_heartbeat: heartbeat });
    const staleHeartbeat = { ...running, current_step: 'EXECUTE' as const };
    const saved = await storage.getPipeline(queued.id, queued.user_id);
    expect(saved).toMatchObject({ status: 'RUNNING', current_step: 'PLAN', last_heartbeat: heartbeat });
    await storage.savePipeline({ ...saved!, status: 'ABORTED' });
    await expect(storage.savePipeline(staleHeartbeat)).rejects.toThrow(/already ABORTED|changed concurrently/);
    await expect(storage.savePipeline(running)).rejects.toThrow('already ABORTED');
    expect(await storage.getPipeline(queued.id, queued.user_id)).toMatchObject({ status: 'ABORTED' });
  });

  it('rejects a stale writer after another instance completes the pipeline', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'factory-progress-cas-'));
    const first = new SqliteStorage();
    const second = new SqliteStorage();
    await first.initialize(true, join(folder, 'data.db'));
    await second.initialize(true, join(folder, 'data.db'));
    const timestamp = new Date().toISOString();
    const state: PipelineState = { id: randomUUID(), project: 'cas', user_id: 'owner', status: 'PENDING', current_step: 'INIT', iteration: 0, spec: '{}', error: null, started_at: timestamp, updated_at: timestamp, last_heartbeat: timestamp };
    await first.savePipeline(state);
    const running = { ...state, status: 'RUNNING' as const };
    await second.savePipeline(running);
    const stale = { ...running, current_step: 'PLAN' as const };
    const originalGet = first.getPipeline.bind(first);
    let readReady!: () => void;
    let releaseWrite!: () => void;
    const readDone = new Promise<void>(resolve => { readReady = resolve; });
    const writeReleased = new Promise<void>(resolve => { releaseWrite = resolve; });
    first.getPipeline = async (...args) => {
      const result = await originalGet(...args);
      if (result?.status === 'RUNNING') { readReady(); await writeReleased; }
      return result;
    };
    const staleWrite = first.savePipeline(stale);
    await readDone;
    await second.savePipeline({ ...running, status: 'COMPLETED' });
    releaseWrite();
    await expect(staleWrite).rejects.toThrow(/already COMPLETED|changed concurrently/);
    expect((await first.getPipeline(state.id, state.user_id))?.status).toBe('COMPLETED');
    await first.close(); await second.close(); storage = undefined;
  });

  it.each(['ABORTED', 'COMPLETED'] as PipelineStatus[])('does not permit %s to resume or accept a same-status write', (terminal) => {
    expect(SafetyController.validateTransition(terminal, 'RUNNING')).toBe(false);
    expect(SafetyController.validateTransition(terminal, terminal)).toBe(false);
  });

  it('still rejects skipping the queue directly to completion', () => {
    expect(SafetyController.validateTransition('PENDING', 'COMPLETED')).toBe(false);
  });
});
