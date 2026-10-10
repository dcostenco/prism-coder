import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { renderDashboardHTML } from '../../src/dashboard/ui.js';

const NODES = [
  { id: 'first-session', label: 'First session', group: 'memory', value: 1 },
  { id: 'second-session', label: 'Second session', group: 'memory', value: 1 },
];
const EDGES = [{ from: NODES[0].id, to: NODES[1].id }];
const EMPTY_GRAPH = { graphType: 'memory', nodes: [], edges: [] };
const FULL_GRAPH = { graphType: 'memory', nodes: NODES, edges: EDGES };
const pages: JSDOM[] = [];
afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 10));
  pages.splice(0).forEach(page => page.window.close());
});

async function dashboard(read: (url: string) => Promise<Response>) {
  const destroyed = vi.fn();
  const renderVisibility: string[] = [];
  const page = new JSDOM(renderDashboardHTML('review'), {
    runScripts: 'dangerously', virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      window.vis = { Network: class {
        constructor() { renderVisibility.push(window.document.getElementById('content')?.style.display || ''); }
        on() {} destroy() { destroyed(); }
      } } as never;
      window.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url === '/api/graph' || url.startsWith('/api/graph?')) return read(url);
        const body = url.startsWith('/api/project?') ? { context: { last_summary: 'Graph display regression' }, ledger: [], history: [] }
          : url.startsWith('/api/projects') ? { projects: [] } : {};
        return new Response(JSON.stringify(body));
      }) as typeof window.fetch;
    },
  });
  pages.push(page);
  await new Promise(resolve => setTimeout(resolve, 20));
  return { window: page.window as unknown as Window & { loadGraph(): Promise<void>; loadProject(): Promise<void> }, destroyed, renderVisibility };
}

describe('graph filters preserve the selected request and truthful visible counts', () => {
  it('clears previous counts when the selected filter matches no sessions', async () => {
    let empty = false;
    const { window, destroyed } = await dashboard(async () => new Response(JSON.stringify(empty ? EMPTY_GRAPH : FULL_GRAPH)));
    await vi.waitFor(() => expect(window.document.querySelector('.graph-stats')?.textContent).toBe('2 sessions · 1 stored links'));
    empty = true;
    const importance = window.document.getElementById('graphImportanceFilter') as HTMLSelectElement;
    importance.value = '7'; importance.dispatchEvent(new window.Event('change'));
    await vi.waitFor(() => expect(window.document.querySelector('.graph-stats')?.textContent).toBe('0 sessions · 0 stored links'));
    expect(window.document.getElementById('network-container')?.textContent).toMatch(/match these filters/);
    expect(destroyed).toHaveBeenCalledOnce();
  });

  it('shows an unavailable graph without keeping old counts after a failed read', async () => {
    let unavailable = false;
    const { window } = await dashboard(async () => new Response(JSON.stringify(unavailable ? { error: 'Unavailable' } : FULL_GRAPH), { status: unavailable ? 503 : 200 }));
    unavailable = true; await window.loadGraph();
    expect(window.document.querySelector('.graph-stats')?.textContent).toMatch(/unavailable/i);
    expect(window.document.getElementById('network-container')?.textContent).toMatch(/unavailable/i);
  });

  it('ignores a late graph response for previously selected filters', async () => {
    let pending!: (response: Response) => void;
    const older = new Promise<Response>(resolve => { pending = resolve; });
    let holdOlder = false;
    const { window } = await dashboard(async url => holdOlder && !url.includes('min_importance') ? older
      : new Response(JSON.stringify(url.includes('min_importance') ? EMPTY_GRAPH : FULL_GRAPH)));
    holdOlder = true; const olderRead = window.loadGraph();
    (window.document.getElementById('graphImportanceFilter') as HTMLSelectElement).value = '7';
    await window.loadGraph();
    pending(new Response(JSON.stringify(FULL_GRAPH))); await olderRead;
    expect(window.document.querySelector('.graph-stats')?.textContent).toBe('0 sessions · 0 stored links');
    expect(window.document.getElementById('network-container')?.textContent).toMatch(/match these filters/);
  });

  it('recreates the graph after the selected project panel becomes visible', async () => {
    const { window, renderVisibility } = await dashboard(async () => new Response(JSON.stringify(FULL_GRAPH)));
    const select = window.document.getElementById('projectSelect') as HTMLSelectElement;
    const option = window.document.createElement('option'); option.value = 'graph-display-regression'; option.text = option.value;
    select.add(option); select.value = option.value;
    await window.loadProject();
    await vi.waitFor(() => expect(renderVisibility.at(-1)).toBe('grid'));
  });
});
