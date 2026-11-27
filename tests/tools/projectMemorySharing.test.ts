import { describe, expect, it, vi, beforeEach } from 'vitest';

process.env.PRISM_SYNALUX_BASE_URL = 'https://portal.test';
process.env.PRISM_SYNALUX_API_KEY = 'synalux_sk_';
const { SynaluxStorage } = await import('../../src/storage/synalux.js');

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('paid project memory operations', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends only explicitly selected project fields for sharing', async () => {
    const seen: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : null; seen.push(body);
      if (String(_url).endsWith('/api/v1/auth/jwt')) return response({ status: 'success', jwt: 'synthetic', expires_in: 900 });
      return response({ status: 'success', entry: { id: 'entry-1' }, visibility: 'workspace' });
    }));
    const storage = new SynaluxStorage();
    await expect(storage.shareProjectMemory({ project: 'p', summary: 'decision', decisions: ['d'] })).resolves.toEqual({ id: 'entry-1', visibility: 'workspace' });
    expect(seen.at(-1)).toMatchObject({ action: 'share_project_memory', project: 'p', summary: 'decision', decisions: ['d'] });
    expect(seen.at(-1)).not.toHaveProperty('last_summary');
  });

  it('uses portal history for an exact requested version and preserves snapshot fields', async () => {
    const seen: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : null; seen.push(body);
      if (String(_url).endsWith('/api/v1/auth/jwt')) return response({ status: 'success', jwt: 'synthetic', expires_in: 900 });
      return response({ status: 'success', versions: [{ version: 4, snapshot: { project: 'p', role: 'dev', version: 4, user_id: 'server-author', last_summary: 's', active_decisions: ['d'], keywords: ['k'] } }] });
    }));
    const storage = new SynaluxStorage();
    await expect(storage.getHandoffAtVersion('p', 4, 'u', 'dev')).resolves.toMatchObject({ last_summary: 's', active_decisions: ['d'], keywords: ['k'], user_id: 'server-author', project: 'p', role: 'dev', version: 4 });
    expect(seen.at(-1)).toMatchObject({ action: 'memory_history', project: 'p', target_version: 4, role: 'dev' });
  });

  it('propagates portal history errors instead of returning an empty base', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      if (String(_url).endsWith('/api/v1/auth/jwt')) return response({ status: 'success', jwt: 'synthetic', expires_in: 900 });
      return response({ status: 'error', error: 'workspace denied' }, 403);
    }));
    const storage = new SynaluxStorage();
    await expect(storage.getHandoffAtVersion('p', 4)).rejects.toThrow('workspace denied');
  });

  it('rejects a history response whose identity does not match the requested base', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      if (String(_url).endsWith('/api/v1/auth/jwt')) return response({ status: 'success', jwt: 'synthetic', expires_in: 900 });
      return response({ status: 'success', versions: [{ version: 4, snapshot: { project: 'other', role: 'dev', version: 3, user_id: 'server-author' } }] });
    }));
    const storage = new SynaluxStorage();
    await expect(storage.getHandoffAtVersion('p', 4, 'u', 'dev')).rejects.toThrow(/identity|history|mismatch/i);
  });
});
