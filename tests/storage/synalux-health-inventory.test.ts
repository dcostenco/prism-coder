import { afterEach, describe, expect, it, vi } from 'vitest';
import { SynaluxStorage } from '../../src/storage/synalux.js';

const VALID_INVENTORY = { ledger_entries: 4, active_projects: 1, ledger_missing_embeddings: 2 };
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function storage() {
  vi.stubEnv('PRISM_SYNALUX_BASE_URL', 'https://portal.test');
  vi.stubEnv('PRISM_SYNALUX_API_KEY', 'synalux_sk_<fixture>');
  const instance = new SynaluxStorage();
  const read = vi.spyOn(instance as unknown as { portalPost(path: string, body: unknown): Promise<unknown> }, 'portalPost');
  return { instance, read };
}

describe('cloud health inventory must be measured before the dashboard displays counts', () => {
  it('preserves measured counts and accepts a genuinely empty inventory', async () => {
    const { instance, read } = storage();
    read.mockResolvedValueOnce({ inventory: VALID_INVENTORY });
    expect(await instance.getHealthStats('test-user')).toMatchObject({ missingEmbeddings: 2, totalActiveEntries: 4, totalHandoffs: 1 });
    read.mockResolvedValueOnce({ inventory: { ledger_entries: 0, active_projects: 0, ledger_missing_embeddings: 0 } });
    expect(await instance.getHealthStats('test-user')).toMatchObject({ missingEmbeddings: 0, totalActiveEntries: 0 });
  });

  it.each([
    undefined, {}, { ledger_missing_embeddings: 0 },
    { ...VALID_INVENTORY, ledger_entries: -1 },
    { ...VALID_INVENTORY, active_projects: 1.5 },
    { ...VALID_INVENTORY, ledger_entries: '4' },
    { ...VALID_INVENTORY, ledger_missing_embeddings: 5 },
  ])('reports unavailable coverage for malformed inventory %j', async inventory => {
    const { instance, read } = storage();
    read.mockResolvedValueOnce({ inventory });
    expect((await instance.getHealthStats('test-user')).missingEmbeddings).toBe(-1);
  });

  it('reports unavailable coverage when the portal read fails', async () => {
    const { instance, read } = storage();
    read.mockRejectedValueOnce(new Error('Controlled unavailable read'));
    expect((await instance.getHealthStats('test-user')).missingEmbeddings).toBe(-1);
  });
});
