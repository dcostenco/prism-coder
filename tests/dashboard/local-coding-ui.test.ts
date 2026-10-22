import { afterEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { localCodingPanelHTML, localCodingScript } from "../../src/dashboard/localCodingUI.js";
const windows: JSDOM[] = [];
afterEach(() => { windows.splice(0).forEach(dom => dom.window.close()); });
function fixture() {
    let settings: any = { backend: "auto", source: "existing" };
    const posts: any[] = [];
    let discoveryErrors: any = {};
    let inventory = [{ id: "new/build", loaded: false, weightBytes: 12 * 1024 ** 3 }];
    const dom = new JSDOM(localCodingPanelHTML(), { url: "http://127.0.0.1", runScripts: "outside-only" }); windows.push(dom);
    dom.window.fetch = async (_url: any, init: any) => {
        if (init?.method === "POST") { settings = JSON.parse(init.body); posts.push(settings); return { ok: true, json: async () => ({ saved: true }) } as Response; }
        return { ok: true, json: async () => ({ settings, preference: { envOverride: null }, canManage: true,
            connection: { connected: true, control: true, model: "new/build", models: inventory.map(m => m.id) },
            discovered: { omlx: inventory, ollama: [{ id: "next:tag", loaded: true }] }, discoveryErrors, availableMemoryBytes: 20 * 1024 ** 3,
            managed: { supported: true, installed: true, models: [], freeDiskGB: 100, job: null, server: { connected: true } } }) } as Response;
    };
    dom.window.eval(localCodingScript());
    const field = (name: string) => dom.window.document.getElementById('local-coding-' + name) as HTMLSelectElement;
    return { dom, posts, field, load: () => (dom.window as any).loadLocalCoding(false), save: () => (dom.window as any).saveLocalCoding({ preventDefault() {} }),
        removeModel: () => { inventory = []; }, failInventory: () => { inventory = []; discoveryErrors = { omlx: 'Inventory unavailable' }; } };
}
describe("local model assignment controls", () => {
    it("discovers IDs and saves one model for both roles, retaining selections after reopen", async () => {
        const f = fixture(); await f.load();
        expect(f.field('omlx-coder').options[1].value).toBe('new/build');
        for (const role of ['coder','reviewer']) { f.field('omlx-' + role).value = 'new/build'; f.field('ollama-' + role).value = 'next:tag'; }
        await f.save();
        expect(f.posts[0].models).toEqual({ omlx: { coder: 'new/build', reviewer: 'new/build' }, ollama: { coder: 'next:tag', reviewer: 'next:tag' } });
        (f.dom.window as any).localCodingLoaded = false;
        await f.load(); expect(f.field('omlx-reviewer').value).toBe('new/build'); expect(f.field('ollama-reviewer').value).toBe('next:tag');
        expect(f.field('omlx-reviewer-memory').textContent).toContain('Reported weights: 12.0 GiB');
        expect(f.field('ollama-reviewer-memory').textContent).toContain('RAM requirements unknown');
    });
    it("preserves unsaved choices on refresh and shows a missing saved ID instead of replacing it", async () => {
        const f = fixture(); await f.load(); f.field('omlx-reviewer').value = 'new/build'; await f.load();
        expect(f.field('omlx-reviewer').value).toBe('new/build'); await f.save(); f.removeModel(); await f.load();
        expect(f.field('omlx-reviewer').value).toBe('new/build'); expect(f.field('omlx-reviewer').selectedOptions[0].textContent).toContain('Unavailable');
        expect(f.field('omlx-reviewer-memory').textContent).toContain('refused rather than replaced');
    });
    it('labels failed discovery as unknown rather than a missing model', async () => {
        const f = fixture(); await f.load(); f.field('omlx-reviewer').value = 'new/build'; await f.save(); f.failInventory(); await f.load();
        expect(f.field('omlx-reviewer').selectedOptions[0].textContent).toContain('Availability unknown');
        expect(f.field('omlx-reviewer-memory').textContent).toContain('unknown');
        expect(f.field('omlx-reviewer-memory').textContent).not.toContain('refused');
    });
});
