import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { renderDashboardHTML } from '../../src/dashboard/ui.js';
const pages: JSDOM[] = [];
afterEach(async () => { await new Promise(resolve=>setTimeout(resolve,60)); pages.splice(0).forEach(page=>page.window.close()); });
async function dashboard(envOverride: boolean | null = null, failPost = false) {
  let saved = true; const active = envOverride ?? true; const posts: any[] = [];
  const page = new JSDOM(renderDashboardHTML('actr-toggle-test'), { runScripts:'dangerously',virtualConsole:new VirtualConsole(),beforeParse(window) {
    window.fetch = (async (input: string, init?: RequestInit) => {
      if (init?.method==='POST') { const body=JSON.parse(String(init.body)); posts.push(body); if(!failPost) saved=body.value==='true'; return new Response(JSON.stringify({ok:!failPost}),{status:failPost?503:200}); }
      if(String(input).startsWith('/api/settings')) return new Response(JSON.stringify({settings:{},darkFactory:{saved:true,active:true,envOverride:null},actr:{saved,active,envOverride,pendingRestart:envOverride===null&&saved!==active}}));
      return new Response(JSON.stringify({projects:[]}));
    }) as any;
  }}); pages.push(page); await (page.window as any).loadSettings();
  return { page,posts,toggle:page.window.document.getElementById('toggle-actr') as HTMLButtonElement };
}
describe('automatic ACT-R dashboard setting',()=>{
  it('defaults on and keeps the saved opt-out with truthful restart state after reopening',async()=>{
    const {page,posts,toggle}=await dashboard(); expect(toggle.getAttribute('aria-checked')).toBe('true');
    toggle.click(); await vi.waitFor(()=>expect(posts[0]).toEqual({key:'PRISM_ACTR_ENABLED',value:'false'}));
    await vi.waitFor(()=>expect(page.window.document.getElementById('actr-state')?.textContent).toContain('restart required'));
    await (page.window as any).loadSettings(); expect(toggle.getAttribute('aria-checked')).toBe('false'); expect(toggle.disabled).toBe(false);
  });
  it('honors environment opt-out and disables the overridden preference',async()=>{
    const {toggle,page}=await dashboard(false); expect(toggle.disabled).toBe(true); expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(page.window.document.getElementById('actr-state')?.textContent).toContain('Environment override: off');
  });
  it('rolls back failed writes instead of claiming a saved preference',async()=>{
    const {toggle,posts}=await dashboard(null,true); toggle.click(); await vi.waitFor(()=>expect(posts).toHaveLength(1));
    await vi.waitFor(()=>expect(toggle.getAttribute('aria-checked')).toBe('true'));
  });
});
