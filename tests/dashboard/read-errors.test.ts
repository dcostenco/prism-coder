import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { renderDashboardHTML } from '../../src/dashboard/ui.js';
import { SupabaseStorage } from '../../src/storage/supabase.js';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import { supabaseRpc } from '../../src/utils/supabaseApi.js';

vi.mock('../../src/utils/supabaseApi.js', () => ({
  supabaseRpc: vi.fn(), supabaseGet: vi.fn(), supabasePost: vi.fn(),
  supabasePatch: vi.fn(), supabaseDelete: vi.fn(),
}));

const PROJECT = 'dashboard-read-regression';
const EMPTY_ANALYTICS = {
  totalEntries: 0, totalRollups: 0, rollupSavings: 0,
  avgSummaryLength: 0, sessionsByDay: [],
};
const EMPTY_RPC_ANALYTICS = {
  total_entries: 0, total_rollups: 0, rollup_savings: 0,
  avg_summary_length: 0, sessions_by_day: [],
};
const pages: JSDOM[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await new Promise(resolve => setTimeout(resolve, 10));
  pages.splice(0).forEach(page => page.window.close());
  vi.clearAllMocks();
});

async function dashboard(read: (url: string) => Promise<Response>) {
  const fetchResponse = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('/api/analytics') || url.startsWith('/api/pipelines') || url.startsWith('/api/project?')
      || url.startsWith('/api/retention') || url.startsWith('/api/team') || url.startsWith('/api/intent-health')) return read(url);
    const body = url.startsWith('/api/graph') ? { nodes: [], edges: [] }
      : url.startsWith('/api/projects') ? { projects: [] } : {};
    return new Response(JSON.stringify(body));
  };
  const page = new JSDOM(renderDashboardHTML('review'), {
    runScripts: 'dangerously', virtualConsole: new VirtualConsole(),
    beforeParse(window) { window.fetch = fetchResponse as typeof window.fetch; window.Date = Date; },
  });
  pages.push(page);
  await new Promise(resolve => setTimeout(resolve, 10));
  const select = page.window.document.getElementById('projectSelect') as HTMLSelectElement;
  select.add(new page.window.Option(PROJECT, PROJECT)); select.value = PROJECT;
  return page.window as unknown as Window & {
    loadAnalytics(project: string): Promise<void>; loadPipelines(): Promise<void>; loadProject(): Promise<void>;
    loadRetention(project: string): Promise<void>; loadTeam(): Promise<void>; fetchIntentHealth(project: string): void;
  };
}

describe('dashboard read failures must not impersonate empty data', () => {
  it('propagates an analytics RPC outage instead of returning believable zero statistics', async () => {
    vi.mocked(supabaseRpc).mockRejectedValueOnce(new Error('Read unavailable'));
    await expect(new SupabaseStorage().getAnalytics(PROJECT, 'test-user')).rejects.toThrow();
  });

  it('still accepts a successful, genuinely empty analytics result', async () => {
    vi.mocked(supabaseRpc).mockResolvedValueOnce(EMPTY_RPC_ANALYTICS);
    const result = await new SupabaseStorage().getAnalytics(PROJECT, 'test-user');
    expect(result).toMatchObject({ totalEntries: 0, totalRollups: 0, rollupSavings: 0, avgSummaryLength: 0 });
    expect(result.sessionsByDay).toHaveLength(14);
    expect(result.sessionsByDay.every(day => day.count === 0)).toBe(true);
  });

  it('generates consecutive UTC sparkline dates across a local DST transition in every fallback', async () => {
    vi.stubEnv('TZ', 'Africa/Cairo');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:30:00Z'));
    const expected = Array.from({ length: 14 }, (_, index) => new Date(Date.UTC(2026, 9, 19 + index)).toISOString().slice(0, 10));
    vi.mocked(supabaseRpc).mockResolvedValueOnce(EMPTY_RPC_ANALYTICS);
    const remote = await new SupabaseStorage().getAnalytics(PROJECT, 'test-user');
    expect(remote.sessionsByDay.map(day => day.date)).toEqual(expected);
    const local = Object.create(SqliteStorage.prototype) as SqliteStorage;
    Object.defineProperty(local, 'db', { value: { execute: vi.fn()
      .mockResolvedValueOnce({ rows: [EMPTY_RPC_ANALYTICS] }).mockResolvedValueOnce({ rows: [] }) } });
    expect((await local.getAnalytics(PROJECT, 'test-user')).sessionsByDay.map(day => day.date)).toEqual(expected);
    const window = await dashboard(async () => new Response(JSON.stringify(EMPTY_ANALYTICS)));
    await window.loadAnalytics(PROJECT);
    const labels = [...window.document.querySelectorAll('#sparkline [title]')].map(bar => bar.getAttribute('title')!.slice(0, 10));
    expect(labels).toEqual(expected);
  });

  it.each([
    { ...EMPTY_RPC_ANALYTICS, total_entries: 1, sessions_by_day: [{ date: '2026-10-09', count: 1 }] },
    { ...EMPTY_RPC_ANALYTICS, total_entries: 1.5 },
    { ...EMPTY_RPC_ANALYTICS, total_rollups: 1 },
  ])('rejects incomplete or inconsistent direct database statistics %j', async response => {
    vi.mocked(supabaseRpc).mockResolvedValueOnce(response);
    await expect(new SupabaseStorage().getAnalytics(PROJECT, 'test-user')).rejects.toThrow(/unavailable/i);
  });

  it('shows unavailable analytics, clears stale values, and retries the selected project', async () => {
    let unavailable = false;
    const requests: string[] = [];
    const window = await dashboard(async url => {
      requests.push(url);
      return new Response(JSON.stringify(unavailable ? { error: 'Read unavailable' } : EMPTY_ANALYTICS), { status: unavailable ? 503 : 200 });
    });
    await window.loadAnalytics(PROJECT);
    expect(window.document.getElementById('astat-entries')?.textContent).toBe('0');
    unavailable = true;
    await window.loadAnalytics(PROJECT);
    expect(window.document.getElementById('astat-entries')?.textContent).toBe('—');
    expect(window.document.getElementById('analyticsReadStatus')?.textContent).toMatch(/unavailable/i);
    unavailable = false;
    (window.document.getElementById('analyticsRetryBtn') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(window.document.getElementById('astat-entries')?.textContent).toBe('0'));
    expect(requests.at(-1)).toBe('/api/analytics?project=' + PROJECT);
  });

  it('does not turn a pipeline HTTP failure into a successful zero-pipeline result', async () => {
    const window = await dashboard(async () => new Response(JSON.stringify({ error: 'Read unavailable' }), { status: 500 }));
    await window.loadPipelines();
    await vi.waitFor(() => expect(window.document.getElementById('factoryList')?.textContent).not.toContain('Loading pipelines'));
    expect(window.document.getElementById('factoryCount')?.textContent).not.toBe('0 pipelines');
    expect(window.document.getElementById('factoryList')?.textContent).toMatch(/unavailable/i);
  });

  it('preserves the genuine empty pipeline state', async () => {
    const window = await dashboard(async () => new Response(JSON.stringify({ pipelines: [] })));
    await window.loadPipelines();
    await vi.waitFor(() => expect(window.document.getElementById('factoryCount')?.textContent).toBe('0 pipelines'));
    expect(window.document.getElementById('factoryList')?.textContent).toMatch(/No pipelines found/);
  });

  it('keeps an older analytics failure from replacing a newer project result', async () => {
    let finishOlder!: (response: Response) => void;
    const older = new Promise<Response>(resolve => { finishOlder = resolve; });
    let calls = 0;
    const window = await dashboard(async () => ++calls === 1 ? older
      : new Response(JSON.stringify({ ...EMPTY_ANALYTICS, totalEntries: 7 })));
    const olderRead = window.loadAnalytics(PROJECT);
    const nextProject = PROJECT + '-next';
    const select = window.document.getElementById('projectSelect') as HTMLSelectElement;
    const option = window.document.createElement('option'); option.value = nextProject; option.text = nextProject;
    select.add(option); select.value = nextProject;
    await window.loadAnalytics(nextProject);
    finishOlder(new Response(JSON.stringify({ error: 'Read unavailable' }), { status: 503 }));
    await olderRead;
    expect(window.document.getElementById('astat-entries')?.textContent).toBe('7');
    expect(window.document.getElementById('analyticsReadStatus')?.style.display).toBe('none');
  });

  it('rejects a malformed successful pipeline response instead of inventing an empty list', async () => {
    const window = await dashboard(async () => new Response('{}'));
    await window.loadPipelines();
    expect(window.document.getElementById('factoryList')?.textContent).toMatch(/unavailable/i);
    expect(window.document.getElementById('factoryCount')?.textContent).toBe('—');
  });

  it('keeps malformed analytics from partially displaying plausible metrics', async () => {
    const window = await dashboard(async () => new Response(JSON.stringify({
      ...EMPTY_ANALYTICS, totalEntries: 7, sessionsByDay: [null],
    })));
    await window.loadAnalytics(PROJECT);
    expect(window.document.getElementById('astat-entries')?.textContent).toBe('—');
    expect(window.document.getElementById('analyticsReadStatus')?.textContent).toMatch(/unavailable/i);
  });

  it('does not start child reads or overwrite the view when an older project response arrives last', async () => {
    let finishOlder!: (response: Response) => void;
    const older = new Promise<Response>(resolve => { finishOlder = resolve; });
    const requests: string[] = [];
    const nextProject = PROJECT + '-next';
    const projectResponse = (name: string) => new Response(JSON.stringify({
      context: { last_summary: name, pending_todo: [], recent_sessions: [] }, ledger: [], history: [],
    }));
    const window = await dashboard(async url => {
      if (url.startsWith('/api/project?')) return url.endsWith(PROJECT) ? older : projectResponse(nextProject);
      requests.push(url); return new Response(JSON.stringify(EMPTY_ANALYTICS));
    });
    const olderRead = window.loadProject();
    const select = window.document.getElementById('projectSelect') as HTMLSelectElement;
    const option = window.document.createElement('option'); option.value = nextProject; option.text = nextProject;
    select.add(option); select.value = nextProject;
    await window.loadProject();
    await vi.waitFor(() => expect(window.document.getElementById('summary')?.textContent).toContain(nextProject));
    finishOlder(projectResponse(PROJECT)); await olderRead;
    expect(window.document.getElementById('summary')?.textContent).toContain(nextProject);
    expect(requests.filter(url => url.startsWith('/api/analytics'))).toEqual(['/api/analytics?project=' + nextProject]);
  });

  it('does not let an older same-project retention read replace newer settings', async () => {
    let finishOlder!: (response: Response) => void;
    const older = new Promise<Response>(resolve => { finishOlder = resolve; });
    let calls = 0;
    const window = await dashboard(async () => ++calls === 1 ? older : new Response(JSON.stringify({ ttl_days: 2 })));
    const pending = window.loadRetention(PROJECT);
    await window.loadRetention(PROJECT);
    finishOlder(new Response(JSON.stringify({ ttl_days: 1 }))); await pending;
    expect((window.document.getElementById('ttlInput') as HTMLInputElement).value).toBe('2');
  });

  it.each(['team', 'intent'] as const)('keeps older same-project %s results from replacing the newest read', async kind => {
    let finishOlder!: (response: Response) => void;
    const older = new Promise<Response>(resolve => { finishOlder = resolve; });
    let calls = 0;
    const body = (newer: boolean) => kind === 'team'
      ? { team: [{ role: 'dev', status: 'active', current_task: newer ? 'newer-read' : 'older-read' }] }
      : { score: newer ? 70 : 10, staleness_days: 0, open_todo_count: 0, has_active_decisions: true, signals: [] };
    const window = await dashboard(async () => ++calls === 1 ? older : new Response(JSON.stringify(body(true))));
    const olderRead = kind === 'team' ? window.loadTeam() : window.fetchIntentHealth(PROJECT);
    if (kind === 'team') await window.loadTeam(); else window.fetchIntentHealth(PROJECT);
    const target = kind === 'team' ? 'teamList' : 'intentHealthCardContent';
    const expected = kind === 'team' ? 'newer-read' : '70';
    await vi.waitFor(() => expect(window.document.getElementById(target)?.textContent).toContain(expected));
    finishOlder(new Response(JSON.stringify(body(false))));
    await olderRead; await new Promise(resolve => setTimeout(resolve, 10));
    expect(window.document.getElementById(target)?.textContent).toContain(expected);
  });

  it('ignores a stale analytics refresh before it can clear the active project or invalidate its read', async () => {
    const requests: string[] = [];
    const window = await dashboard(async url => {
      requests.push(url); return new Response(JSON.stringify({ ...EMPTY_ANALYTICS, totalEntries: 2 }));
    });
    await window.loadAnalytics(PROJECT);
    await window.loadAnalytics(PROJECT + '-stale');
    expect(window.document.getElementById('astat-entries')?.textContent).toBe('2');
    expect(window.document.getElementById('analyticsReadStatus')?.style.display).toBe('none');
    expect(requests).toEqual(['/api/analytics?project=' + PROJECT]);
  });
});
