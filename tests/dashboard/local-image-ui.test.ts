import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { localCodingPanelHTML, localCodingScript } from '../../src/dashboard/localCodingUI.js';
const windows: JSDOM[] = [];
afterEach(() => windows.splice(0).forEach(dom => dom.window.close()));
function fixture() {
    let settings: any = {};
    let outage = false, present = true, failed = false;
    const calls: string[] = [], posts: any[] = [];
    const dom = new JSDOM(localCodingPanelHTML(), { url: 'http://127.0.0.1', runScripts: 'outside-only' }); windows.push(dom);
    const reads: { gate: Promise<void>; data: unknown }[] = [];
    function snapshot(next: { outage?: boolean; present?: boolean } = {}) {
        const unavailable = next.outage ?? outage, installed = next.present ?? present;
        return { settings: JSON.parse(JSON.stringify(settings)), canManage: true, selectionApplied: false, availableMemoryBytes: 10 * 1024 ** 3,
            discovered: { omlx: installed && !unavailable ? [{ id: 'new/vlm', loaded: false, weightBytes: 4 * 1024 ** 3, capability: { vision: 'yes', source: 'omlx.engine_type' } }] : [],
                ollama: [{ id: 'future:tag', capability: { vision: 'unknown', source: 'metadata_unavailable' } }] },
            discoveryErrors: { omlx: unavailable ? 'Inventory unavailable' : null, ollama: null } };
    }
    dom.window.fetch = async (url: any, init: any) => {
        calls.push(String(url));
        if (url === '/api/local-coding') throw new Error('Coding metadata unavailable');
        if (init?.method === 'POST') { settings = JSON.parse(init.body); posts.push({ path: url, settings }); return { ok: true, json: async () => ({ saved: true }) } as Response; }
        const queued = reads.shift(), data = queued ? queued.data : snapshot();
        if (queued) await queued.gate;
        if (failed) throw new Error('Metadata request failed');
        return { ok: true, json: async () => data } as Response;
    };
    dom.window.eval(localCodingScript());
    const field = (name: string) => dom.window.document.getElementById('local-image-' + name) as HTMLSelectElement;
    return { dom, field, calls, posts, load: (reset = false) => (dom.window as any).loadLocalImages(reset), save: () => (dom.window as any).saveLocalImages({ preventDefault() {} }),
        outage: () => { outage = true; }, remove: () => { present = false; }, fail: () => { failed = true; },
        codingLoad: () => (dom.window as any).loadLocalCoding(false),
        defer: (next: { outage?: boolean; present?: boolean }) => { let release!: () => void;
            reads.push({ gate: new Promise<void>(resolve => { release = resolve; }), data: snapshot(next) }); return release; } };
}
describe('independent image selector journey', () => {
    it('explains per-request capability checks while unset preserves legacy routing', () => {
        const f = fixture();
        expect(f.dom.window.document.getElementById('local-image-boundary')?.textContent).toContain('server image-input capability');
        expect(f.dom.window.document.getElementById('local-image-boundary')?.textContent).toContain('Leave the backend unset');
    });
    it('starts unset, auto-detects arbitrary IDs, saves both backends and reopens without coding inheritance', async () => {
        const f = fixture(); await f.load();
        expect(f.field('backend').value).toBe('');
        expect(f.field('omlx-model').value).toBe('');
        expect(f.field('omlx-model').options[1].value).toBe('new/vlm');
        f.field('backend').value = 'omlx'; f.field('omlx-model').value = 'new/vlm'; f.field('ollama-model').value = 'future:tag';
        await f.save(); await f.load(true);
        expect(f.posts).toEqual([{ path: '/api/local-coding/image-preferences', settings: { backend: 'omlx', models: { omlx: 'new/vlm', ollama: 'future:tag' } } }]);
        expect(f.field('omlx-model').value).toBe('new/vlm');
        expect(f.calls.every(path => path.startsWith('/api/local-coding/image-'))).toBe(true);
        expect(f.field('omlx-metadata').textContent).toContain('Image peak RAM unknown');
        expect(f.field('omlx-metadata').textContent).not.toContain('Cold-load');
        expect(f.field('saved').textContent).toContain('compatibility on each request');
    });
    it('preserves edits on refresh; missing and unobservable choices stay distinct', async () => {
        const f = fixture(); await f.load(); f.field('omlx-model').value = 'new/vlm'; await f.save();
        f.field('backend').value = 'ollama'; f.remove(); await f.load();
        expect(f.field('backend').value).toBe('ollama');
        expect(f.field('omlx-model').selectedOptions[0].textContent).toContain('Unavailable:');
        f.outage(); await f.load();
        expect(f.field('omlx-model').value).toBe('new/vlm');
        expect(f.field('omlx-model').selectedOptions[0].textContent).toContain('Availability unknown:');
        expect(f.field('omlx-metadata').textContent).toContain('availability is unknown');
    });
    it('supplies only the exact unsaved Ollama ID for lazy metadata inspection', async () => {
        const f = fixture(); await f.load(); f.field('ollama-model').value = 'future:tag';
        await (f.dom.window as any).imageSelectionChanged('ollama');
        expect(f.calls.at(-1)).toBe('/api/local-coding/image-models?ollamaModel=future%3Atag');
        f.field('ollama-model').value = ''; await f.load();
        expect(f.calls.at(-1)).toBe('/api/local-coding/image-models?ollamaModel=');
    });
    it('keeps image controls usable independently of a failed coding request', async () => {
        const f = fixture(); await f.load(); await f.codingLoad();
        expect(f.field('save').disabled).toBe(false);
        expect(f.calls).toContain('/api/local-coding');
        expect(f.dom.window.document.getElementById('local-coding-save')!.hasAttribute('disabled')).toBe(true);
        f.fail(); await f.load();
        expect(f.field('error').textContent).toContain('Metadata request failed');
        expect(f.field('omlx-model').options.length).toBe(2);
    });
    it('does not let an older response enable saving while a newer read is pending', async () => {
        const f = fixture(); await f.load();
        const releaseA = f.defer({ outage: true }); const older = f.load();
        const releaseB = f.defer({ outage: false }); const newer = f.load();
        f.field('omlx-model').value = 'new/vlm'; releaseA(); await older;
        expect(f.field('save').disabled).toBe(true);
        expect(f.field('omlx-metadata').textContent).not.toContain('availability is unknown');
        await f.save(); expect(f.posts).toHaveLength(0);
        releaseB(); await newer;
        expect(f.field('omlx-model').value).toBe('new/vlm');
        expect(f.field('save').disabled).toBe(false);
    });
    it('ignores a late older outage payload after a newer healthy response', async () => {
        const f = fixture(); await f.load(); f.field('omlx-model').value = 'new/vlm';
        const releaseA = f.defer({ outage: true }); const older = f.load();
        const releaseB = f.defer({ outage: false }); const newer = f.load();
        releaseB(); await newer; releaseA(); await older;
        expect(f.field('omlx-model').selectedOptions[0].textContent).not.toContain('Availability unknown');
        expect(f.field('omlx-metadata').textContent).toContain('Installed');
        expect(f.field('save').disabled).toBe(false);
    });
});
