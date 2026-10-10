import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { renderDashboardHTML } from '../../src/dashboard/ui.js';

const pages: JSDOM[] = [];
afterEach(async () => { await new Promise(resolve => setTimeout(resolve, 60)); pages.splice(0).forEach(page => page.window.close()); });

async function dashboard(settings: Record<string, string>, state: any, postStatus = 200, getStatus = 200) {
  const posts: any[] = [];
  let saved = state.saved;
  const currentState = () => ({...state,saved,pendingRestart:state.envOverride===null && saved!==state.active});
  const page = new JSDOM(renderDashboardHTML('toggle-test'), { runScripts: 'dangerously', virtualConsole: new VirtualConsole(), beforeParse(window) {
    window.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') { const body=JSON.parse(String(init.body)); posts.push(body); if(postStatus===200) saved=body.value==='true'; return new Response(JSON.stringify({ ok: postStatus < 300 }), { status: postStatus }); }
      if (url.startsWith('/api/settings')) return new Response(JSON.stringify({ settings:{...settings,PRISM_DARK_FACTORY_ENABLED:String(saved)}, darkFactory: currentState() }), { status: getStatus });
      if (url.startsWith('/api/projects')) return new Response(JSON.stringify({ projects: [] }));
      return new Response('{}');
    }) as typeof window.fetch;
  }});
  pages.push(page);
  await (page.window as any).loadSettings();
  await new Promise(resolve => setTimeout(resolve, 30));
  return { page, posts };
}

describe('Dark Factory dashboard toggle', () => {
  it('defaults on, posts the exact key, and keeps restart pending after reload', async () => {
    const { page, posts } = await dashboard({}, { saved: true, active: true, envOverride: null, pendingRestart: false });
    const toggle = page.window.document.getElementById('toggle-dark-factory') as HTMLButtonElement;
    expect(toggle.getAttribute('role')).toBe('switch'); await vi.waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    toggle.click(); await vi.waitFor(() => expect(posts[0]).toEqual({ key: 'PRISM_DARK_FACTORY_ENABLED', value: 'false' }));
    await vi.waitFor(() => expect(page.window.document.getElementById('dark-factory-state')?.textContent).toContain('Saved: off · Active: on · restart required'));
    await (page.window as any).loadSettings();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.classList.contains('active')).toBe(false);
    expect(page.window.document.getElementById('dark-factory-state')?.textContent).toContain('restart required');
  });
  it('shows environment false as effective off and disables the saved preference', async () => {
    const { page } = await dashboard({ PRISM_DARK_FACTORY_ENABLED: 'true' }, { saved: true, active: false, envOverride: false, pendingRestart: false });
    const toggle = page.window.document.getElementById('toggle-dark-factory') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true); expect(toggle.getAttribute('aria-checked')).toBe('false'); expect(toggle.classList.contains('active')).toBe(false);
  });
  it('marks settings unavailable on GET failure and rolls back a failed POST', async () => {
    const first = await dashboard({}, { saved: true, active: true, envOverride: null, pendingRestart: false }, 503, 200);
    const toggle = first.page.window.document.getElementById('toggle-dark-factory') as HTMLButtonElement; await vi.waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true')); toggle.click();
    await vi.waitFor(() => expect(first.posts).toHaveLength(1));
    await vi.waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(toggle.classList.contains('active')).toBe(true);
    const failed = await dashboard({}, { saved: true, active: true, envOverride: null, pendingRestart: false }, 200, 503);
    const unavailable = failed.page.window.document.getElementById('toggle-dark-factory') as HTMLButtonElement;
    expect(unavailable.disabled).toBe(true); expect(failed.page.window.document.getElementById('dark-factory-state')?.textContent).toMatch(/unavailable/i);
  });
  it('keeps the switch disabled while the initial settings request is unresolved', async () => {
    let resolve!: (body: string) => void;
    const pending = new Promise<string>(r => { resolve = r; });
    const page = new JSDOM(renderDashboardHTML('toggle-pending'), { runScripts: 'dangerously', beforeParse(window) { window.fetch = (() => pending.then(body => new Response(body))) as any; } }); pages.push(page);
    const toggle = page.window.document.getElementById('toggle-dark-factory') as HTMLButtonElement;
    const loading=(page.window as any).loadSettings();
    expect(toggle.disabled).toBe(true); resolve(JSON.stringify({ settings: {}, darkFactory: { saved: true, active: true, envOverride: null } }));
    await loading;
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });
});
