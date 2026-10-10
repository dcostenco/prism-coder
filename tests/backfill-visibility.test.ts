import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PRISM_USER_ID } from '../src/config.js';
const { getStorageMock, generateEmbedding } = vi.hoisted(() => ({ getStorageMock: vi.fn(), generateEmbedding: vi.fn() }));
vi.mock('../src/storage/index.js', () => ({ getStorage: getStorageMock, activeStorageBackend: 'local' }));
vi.mock('../src/utils/llm/factory.js', () => ({ getEmbeddingProvider: () => ({ generateEmbedding }) }));
vi.mock('../src/utils/turboquant.js', () => ({ getDefaultCompressor: () => ({ bits: 2, compress: () => ({ radius: 1 }) }), serialize: () => Buffer.from('fixture') }));
import { backfillEmbeddingsHandler } from '../src/tools/hygieneHandlers.js';
const PROJECT = 'repair-scope-fixture';
const ROWS = [
  { id: 'active', project: PROJECT, user_id: PRISM_USER_ID, summary: 'active memory', deleted_at: null },
  { id: 'forgotten', project: PROJECT, user_id: PRISM_USER_ID, summary: 'forgotten memory', deleted_at: '2026-10-09' },
];
beforeEach(() => { vi.clearAllMocks(); generateEmbedding.mockResolvedValue([1, 0]); });

describe('embedding repair eligibility matches the memory scan', () => {
  it('repairs only active missing vectors and never sends forgotten text to the provider', async () => {
    const patchLedger = vi.fn().mockResolvedValue(undefined);
    getStorageMock.mockResolvedValue({ patchLedger, getLedgerEntries: vi.fn(async params => ROWS.filter(row =>
      params.user_id === 'eq.' + row.user_id && (!params.deleted_at || row.deleted_at === null))) });
    const result = await backfillEmbeddingsHandler({ project: PROJECT, limit: 20 });
    expect(generateEmbedding).toHaveBeenCalledTimes(1);
    expect(generateEmbedding).toHaveBeenCalledWith('active memory');
    expect(patchLedger).toHaveBeenCalledTimes(1);
    expect(patchLedger).toHaveBeenCalledWith('active', expect.any(Object));
    expect(result.content[0].text).toContain('Repaired: 1');
  });
});
