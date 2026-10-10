import { afterEach, describe, expect, it, vi } from 'vitest';
import { SynaluxStorage } from '../../src/storage/synalux.js';

const BASE_URL = 'https://portal.test';
const PROJECT = ' factory project & exact ';
const ROW = { id: 'pipeline-fixture', project: PROJECT, user_id: 'signed-owner', status: 'PAUSED',
  current_step: 'VERIFY', iteration: 2, eval_revisions: 1, started_at: '2026-10-09T00:00:00Z',
  updated_at: '2026-10-10T00:00:00Z', spec: JSON.stringify({ objective: 'fixture objective', maxIterations: 3 }),
  contract_payload: { criteria: [{ id: 'criterion', description: 'preserve stored contract', weight: 2 }], revision: 1 },
  notes: null, error: null, last_heartbeat: null };

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function client(pipelines: unknown, httpStatus = 200) {
  vi.stubEnv('PRISM_SYNALUX_BASE_URL', BASE_URL);
  vi.stubEnv('PRISM_SYNALUX_API_KEY', 'synalux_sk_<fixture>');
  vi.stubEnv('SUPABASE_URL', '');
  vi.stubEnv('SUPABASE_KEY', '');
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'success', jwt: 'fixture-jwt', expires_in: 900 })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'success', pipelines }), { status: httpStatus }));
  vi.stubGlobal('fetch', fetch);
  return { storage: new SynaluxStorage(), fetch };
}

describe('Factory reads through authenticated Portal without direct database credentials', () => {
  it('preserves exact project/status and the full stored contract; ownership comes from JWT', async () => {
    const { storage, fetch } = client([ROW]);
    expect(await storage.listPipelines(PROJECT, 'PAUSED', 'spoofed-user')).toEqual([ROW]);
    const [target, options] = fetch.mock.calls[1];
    const url = new URL(target);
    expect(url.origin + url.pathname).toBe(BASE_URL + '/api/v1/prism/factory/pipelines');
    expect([...url.searchParams]).toEqual([['project', PROJECT], ['status', 'PAUSED']]);
    expect(options.headers.Authorization).toBe('Bearer fixture-jwt');
  });

  it('accepts a genuinely empty list without filters', async () => {
    const { storage, fetch } = client([]);
    expect(await storage.listPipelines()).toEqual([]);
    expect(fetch.mock.calls[1][0]).toBe(BASE_URL + '/api/v1/prism/factory/pipelines');
  });

  it('propagates unavailable reads instead of certifying an empty Factory', async () => {
    const { storage } = client([], 503);
    await expect(storage.listPipelines()).rejects.toThrow('503');
  });

  it.each([
    { ...ROW, project: 'other-project' }, { ...ROW, status: 'RUNNING' },
    { ...ROW, current_step: null }, { ...ROW, current_step: '' }, { ...ROW, current_step: ' ' }, { ...ROW, iteration: -1 },
    { ...ROW, iteration: Number.MAX_SAFE_INTEGER + 1 }, { ...ROW, started_at: null },
    { ...ROW, updated_at: 'invalid-time' }, { ...ROW, id: ' ' }, { ...ROW, user_id: '' },
    { ...ROW, spec: 'corrupt' }, { ...ROW, spec: '[]' },
    { ...ROW, contract_payload: '{"criteria":[]}' }, { ...ROW, contract_payload: { criteria: [null] } },
  ])('rejects malformed or mismatched rows %j', async row => {
    const { storage } = client([row]);
    await expect(storage.listPipelines(PROJECT, 'PAUSED')).rejects.toThrow('unavailable');
  });

  it.each([null, {}, [ROW, ROW], Array.from({ length: 101 }, (_, index) => ({ ...ROW, id: `fixture-${index}` }))])(
    'rejects an invalid, duplicate or oversized list', async rows => {
      const { storage } = client(rows);
      await expect(storage.listPipelines()).rejects.toThrow('unavailable');
    },
  );
});
