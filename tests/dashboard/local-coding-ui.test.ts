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
    const imageReply = { status: "passed", purpose: "image", message: "Execution complete.", output: "A blue circle <img src=x onerror=alert(1)>",
        reference: { source: "builtin-diagnostic", description: "Solid red square", width: 32, height: 32, format: "PNG", sha256: "a".repeat(64) } };
    function reply(f: ReturnType<typeof fixture>, value: unknown) { f.dom.window.fetch = async () => ({ ok: true, json: async () => value }) as Response; }
    function purpose(f: ReturnType<typeof fixture>, value: string) { (f.dom.window.document.getElementById('local-ai-test-purpose') as HTMLSelectElement).value = value; }
    it("labels the reference independently and renders a wrong AI observation as inert text", async () => {
        const f = fixture(); await f.load(); purpose(f, 'image'); reply(f, imageReply);
        await (f.dom.window as any).testLocalAi();
        const doc = f.dom.window.document;
        expect(doc.getElementById('local-ai-image-result')!.hidden).toBe(false);
        expect(doc.getElementById('local-ai-reference')!.textContent).toContain('Solid red square');
        expect(doc.getElementById('local-ai-observation')!.textContent).toBe(imageReply.output);
        expect(doc.getElementById('local-ai-observation')!.querySelector('*')).toBeNull();
        expect(doc.getElementById('local-ai-test-result')!.textContent).not.toContain('blue circle');
        expect(doc.getElementById('local-ai-image-result')!.textContent).toContain('AI observations');
        expect(doc.getElementById('local-ai-image-result')!.textContent).toContain('Reference facts');
    });
    it("clears old image facts before a new request and after a refusal", async () => {
        const f = fixture(); await f.load(); purpose(f, 'image'); reply(f, imageReply); await (f.dom.window as any).testLocalAi();
        let settle!: (value: Response) => void;
        f.dom.window.fetch = () => new Promise(resolve => { settle = resolve; });
        const pending = (f.dom.window as any).testLocalAi();
        expect(f.dom.window.document.getElementById('local-ai-image-result')!.hidden).toBe(true);
        expect(f.dom.window.document.getElementById('local-ai-reference')!.textContent).toBe('');
        settle({ ok: true, json: async () => ({ status: 'blocked', message: 'Refused', reason: 'omlx_memory_pressure' }) } as Response);
        await pending;
        expect(f.dom.window.document.getElementById('local-ai-observation')!.textContent).toBe('');
        expect(f.dom.window.document.getElementById('local-ai-test-result')!.textContent).toContain('omlx_memory_pressure');
    });
    it("ignores an in-flight image result when the selected purpose changes", async () => {
        const f = fixture(); await f.load(); purpose(f, 'image');
        let settle!: (value: Response) => void;
        f.dom.window.fetch = () => new Promise(resolve => { settle = resolve; });
        const pending = (f.dom.window as any).testLocalAi();
        purpose(f, 'coder'); (f.dom.window as any).clearLocalAiTestResult();
        settle({ ok: true, json: async () => imageReply } as Response); await pending;
        expect(f.dom.window.document.getElementById('local-ai-image-result')!.hidden).toBe(true);
        expect(f.dom.window.document.getElementById('local-ai-test-result')!.textContent).not.toContain('Execution complete');
    });
    it("keeps coding output in the existing result without image-reference claims", async () => {
        const f = fixture(); await f.load(); purpose(f, 'coder'); reply(f, { status: 'passed', message: 'Execution complete.', output: 'LOCAL_READY' });
        await (f.dom.window as any).testLocalAi();
        expect(f.dom.window.document.getElementById('local-ai-test-result')!.textContent).toContain('Response: LOCAL_READY');
        expect(f.dom.window.document.getElementById('local-ai-image-result')!.hidden).toBe(true);
    });
    it("shows the returned refusal reason so resource contention is actionable", async () => {
        const f = fixture(); await f.load();
        f.dom.window.fetch = async () => ({ ok: true, json: async () => ({ status: 'blocked', message: 'Local test was refused.', reason: 'omlx_memory_contention' }) }) as Response;
        await (f.dom.window as any).testLocalAi();
        expect(f.dom.window.document.getElementById('local-ai-test-result')!.textContent).toContain('Reason: omlx_memory_contention');
        expect(f.dom.window.document.getElementById('local-ai-test-result')!.querySelector('*')).toBeNull();
        expect((f.dom.window.document.getElementById('local-ai-test') as HTMLButtonElement).disabled).toBe(false);
    });
    it("saving models cannot activate a source selected only for preview", async () => {
        const f = fixture(); await f.load();
        f.field('source').value = 'managed';
        f.field('omlx-coder').value = 'new/build';
        await f.save();
        expect(f.posts[0].source).toBe('existing');
        expect(f.posts[0].models.omlx.coder).toBe('new/build');
    });
    it("offers server-only setup and separate upstream release notes while preserving the pinned source", () => {
        const f = fixture();
        expect(f.dom.window.document.getElementById('local-coding-install-server')!.textContent).toContain('server only');
        const links = [...f.dom.window.document.querySelectorAll('a')];
        expect(links.find(link => link.textContent === 'Latest upstream releases')?.href).toBe('https://github.com/jundot/omlx/releases');
        expect(links.find(link => link.textContent === 'Tested Prism-compatible source')?.href).toMatch(/^https:\/\/github.com\/dcostenco\/omlx\/commit\/[a-f0-9]{40}$/);
    });
    it("never tests a model when refreshing inventory", async () => {
        const f = fixture(); await f.load();
        expect(f.posts).toEqual([]);
        expect(f.field('start').disabled).toBe(true); // This fixture is already connected.
        expect(f.dom.window.document.getElementById('local-ai-test-result')!.textContent).toContain('Not tested');
    });
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
