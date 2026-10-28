import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const maintenance = vi.hoisted(() => ({ blocked: false }));
vi.mock('../../src/utils/localAiMaintenance.js', () => ({ checkLocalAiMaintenance: async () => {
    if (maintenance.blocked) throw new Error('maintenance needs operator recovery');
} }));
afterEach(() => { maintenance.blocked = false; });
describe('inference lease maintenance boundary', () => {
    it('refuses a new inference owner during durable maintenance and releases the rejected listener', async () => {
        vi.resetModules();
        const { acquireOmlxLease } = await import('../../src/utils/omlxProvider.js');
        const directory = await mkdtemp(join(tmpdir(), 'maintenance-lease-'));
        maintenance.blocked = true;
        await expect(acquireOmlxLease(0, { stateDirectory: directory })).rejects.toThrow('operator recovery');
        maintenance.blocked = false;
        const release = await acquireOmlxLease(0, { stateDirectory: directory });
        await release();
    });
});
