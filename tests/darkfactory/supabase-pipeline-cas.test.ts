import { beforeEach, describe, expect, it, vi } from 'vitest';
const { patch, post } = vi.hoisted(() => ({ patch: vi.fn(), post: vi.fn() }));
vi.mock('../../src/utils/supabaseApi.js', () => ({ supabaseGet: vi.fn(), supabasePost: post, supabasePatch: patch, supabaseDelete: vi.fn(), supabaseRpc: vi.fn() }));
import { SupabaseStorage } from '../../src/storage/supabase.js';
import type { PipelineState } from '../../src/storage/interface.js';

const STATE: PipelineState = { id: 'isolated-cas-test', user_id: 'isolated-owner', project: 'local-http-contract', status: 'RUNNING', current_step: 'PLAN', iteration: 0, spec: '{}', started_at: '2026-10-10T00:00:00.000Z', updated_at: '2026-10-10T00:00:00.000Z', last_heartbeat: '2026-10-10T00:00:00.000Z', error: null };
beforeEach(() => { patch.mockReset(); post.mockReset(); });
describe('Supabase pipeline atomic write HTTP contract', () => {
  it('requires owner, caller version and nonterminal status in the PATCH and advances the caller version', async () => {
    const storage = new SupabaseStorage();
    vi.spyOn(storage, 'getPipeline').mockResolvedValue({ ...STATE });
    patch.mockResolvedValue([{ id: STATE.id }]);
    const state = { ...STATE };
    await storage.savePipeline(state);
    expect(patch.mock.calls[0][2]).toEqual({ id: `eq.${STATE.id}`, user_id: `eq.${STATE.user_id}`, updated_at: `eq.${STATE.updated_at}`, status: 'eq.RUNNING' });
    expect(state.updated_at).not.toBe(STATE.updated_at);
    expect(post).not.toHaveBeenCalled();
  });
  it('treats a zero-row stale/aborted PATCH as failure', async () => {
    const storage = new SupabaseStorage();
    vi.spyOn(storage, 'getPipeline').mockResolvedValue({ ...STATE });
    patch.mockResolvedValue([]);
    await expect(storage.savePipeline({ ...STATE })).rejects.toThrow(/changed concurrently/);
  });
  it('new rows use a plain INSERT without merge-duplicate overwrite semantics', async () => {
    const storage = new SupabaseStorage();
    vi.spyOn(storage, 'getPipeline').mockResolvedValue(null);
    post.mockResolvedValue([{ id: STATE.id }]);
    await storage.savePipeline({ ...STATE, status: 'PENDING' });
    expect(post.mock.calls[0][3]).toEqual({ Prefer: 'return=representation' });
    expect(patch).not.toHaveBeenCalled();
  });
  it('does not claim persistence when the table is unavailable', async () => {
    const storage = new SupabaseStorage();
    vi.spyOn(storage, 'getPipeline').mockResolvedValue(null);
    post.mockRejectedValue(new Error('Could not find the relation'));
    await expect(storage.savePipeline({ ...STATE, status: 'PENDING' })).rejects.toThrow(/not saved/);
  });
});
