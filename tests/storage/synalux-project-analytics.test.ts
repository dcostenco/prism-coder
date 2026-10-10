import { afterEach, describe, expect, it, vi } from 'vitest';
import { SynaluxStorage } from '../../src/storage/synalux.js';

const PROJECT = 'analytics project & exact';
const BASE_URL = 'https://portal.test';
const DAYS = Array.from({ length: 14 }, (_, index) => ({ date: new Date(Date.UTC(2026, 8, 26 + index)).toISOString().slice(0, 10), count: 0 }));
const ANALYTICS = { totalEntries: 4, totalRollups: 1, rollupSavings: 2, avgSummaryLength: 3,
  sessionsByDay: DAYS.map((day, index) => ({ ...day, count: index > 11 ? 1 : 0 })) };

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function client(response: unknown, status = 200) {
  vi.stubEnv('PRISM_SYNALUX_BASE_URL', BASE_URL);
  vi.stubEnv('PRISM_SYNALUX_API_KEY', 'synalux_sk_<fixture>');
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'success', jwt: 'fixture-jwt', expires_in: 900 })))
    .mockResolvedValueOnce(new Response(JSON.stringify(response), { status }));
  vi.stubGlobal('fetch', fetch);
  return { storage: new SynaluxStorage(), fetch };
}

describe('paid dashboard analytics uses the authenticated Portal instead of direct Supabase', () => {
  it('preserves project encoding and uses JWT ownership instead of a caller-supplied user ID', async () => {
    const { storage, fetch } = client({ status: 'success', project: PROJECT, analytics: ANALYTICS });
    expect(await storage.getAnalytics(PROJECT, 'spoofed-user')).toEqual(ANALYTICS);
    const [target, options] = fetch.mock.calls[1];
    const url = new URL(target);
    expect(url.origin + url.pathname).toBe(BASE_URL + '/api/v1/prism/analytics');
    expect([...url.searchParams]).toEqual([['view', 'project'], ['project', PROJECT]]);
    expect(options.headers.Authorization).toBe('Bearer fixture-jwt');
  });

  it('accepts genuinely empty project statistics without requiring direct database credentials', async () => {
    const empty = { totalEntries: 0, totalRollups: 0, rollupSavings: 0, avgSummaryLength: 0, sessionsByDay: DAYS };
    const { storage } = client({ status: 'success', project: PROJECT, analytics: empty });
    expect(await storage.getAnalytics(PROJECT, 'irrelevant-user')).toEqual(empty);
  });

  it('propagates an unavailable read without inventing empty statistics', async () => {
    const { storage } = client({ error: 'Project analytics unavailable' }, 503);
    await expect(storage.getAnalytics(PROJECT, 'irrelevant-user')).rejects.toThrow('unavailable');
  });

  it.each([
    { ...ANALYTICS, totalEntries: '4' }, { ...ANALYTICS, totalRollups: 5 },
    { ...ANALYTICS, sessionsByDay: [] }, { ...ANALYTICS, sessionsByDay: DAYS.map(day => ({ ...day, count: 1 })) },
    { ...ANALYTICS, sessionsByDay: DAYS.map(day => ({ ...day, date: '2026-02-30' })) },
  ])('rejects malformed or inconsistent statistics %j', async analytics => {
    const { storage } = client({ status: 'success', project: PROJECT, analytics });
    await expect(storage.getAnalytics(PROJECT, 'irrelevant-user')).rejects.toThrow('unavailable');
  });

  it('rejects a result correlated to a different project', async () => {
    const { storage } = client({ status: 'success', project: 'other-project', analytics: ANALYTICS });
    await expect(storage.getAnalytics(PROJECT, 'irrelevant-user')).rejects.toThrow('unavailable');
  });
});
