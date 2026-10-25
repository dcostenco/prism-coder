import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleLocalCodingRoutes } from '../../src/dashboard/localCodingRouter.js';
import { parseLocalImageSettings, type LocalImageSettings } from '../../src/utils/localImageSettings.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
async function fixture() {
    let settings: LocalImageSettings = {};
    const saveImages = vi.fn(async (value: unknown) => { settings = parseLocalImageSettings(value); });
    const forbidden = vi.fn(async () => { throw new Error('image preferences must not call coding setup or model probes'); });
    const server = createServer(async (req, res) => {
        const handled = await handleLocalCodingRoutes(new URL(req.url!, 'http://127.0.0.1'), req, res, {
            imageSettings: async () => settings, saveImageSettings: saveImages,
            settings: forbidden, save: forbidden, preference: forbidden, inspect: forbidden,
            detect: forbidden, control: forbidden, configuredModel: forbidden,
            omlxModels: forbidden, ollamaModels: forbidden,
            setup: { status: forbidden, install: forbidden, start: forbidden },
        });
        if (!handled) { res.writeHead(404); res.end(); }
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    const path = base + '/api/local-coding/image-preferences';
    const post = (body: unknown, origin = base, contentType = 'application/json') => fetch(path, {
        method: 'POST', headers: { 'Content-Type': contentType, Origin: origin }, body: JSON.stringify(body),
    });
    return { path, post, saveImages, forbidden };
}

describe('image preference branches in the existing local-model handler', () => {
    it('discovers separately, preserves missing saved IDs, and never calls coding setup', async () => {
        const settings = { backend: 'ollama' as const, models: { ollama: 'saved:tag', omlx: 'removed/build' } };
        const ollamaImageModels = vi.fn(async () => []);
        const forbidden = vi.fn(async () => { throw Error('coding metadata must stay separate'); });
        const overrides = { imageSettings: async () => settings, omlxImageModels: async () => { throw Error('/private/path credential'); },
            ollamaImageModels, settings: forbidden, availableMemory: () => 123 };
        async function get(query = '') {
            let status: number | undefined, body: any;
            await handleLocalCodingRoutes(new URL('http://127.0.0.1/api/local-coding/image-models' + query),
                { method: 'GET', socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage,
                { writeHead(value: number) { status = value; }, end(value: string) { body = JSON.parse(value); } } as unknown as ServerResponse, overrides);
            return { status, body };
        }
        const result = await get();
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ settings, selectionApplied: false, discovered: { omlx: [], ollama: [] }, discoveryErrors: { omlx: 'oMLX image inventory unavailable.', ollama: null } });
        expect(JSON.stringify(result)).not.toMatch(/private|credential/);
        expect(ollamaImageModels).toHaveBeenLastCalledWith('saved:tag');
        await get('?ollamaModel=future%3Atag'); expect(ollamaImageModels).toHaveBeenLastCalledWith('future:tag');
        await get('?ollamaModel='); expect(ollamaImageModels).toHaveBeenLastCalledWith(undefined);
        const calls = ollamaImageModels.mock.calls.length;
        expect((await get('?ollamaModel=invalid%0Aid')).status).toBe(400);
        expect(ollamaImageModels.mock.calls).toHaveLength(calls);
        expect(forbidden).not.toHaveBeenCalled();
    });
    it('rejects non-loopback mutation before reading a body or saving', async () => {
        const saveImageSettings = vi.fn();
        let status: number | undefined;
        const req = { method: 'POST', socket: { remoteAddress: '192.0.2.10' }, headers: {
            host: 'dashboard.example', origin: 'http://dashboard.example', 'content-type': 'application/json',
        } } as IncomingMessage;
        const res = { writeHead(value: number) { status = value; }, end() {} } as unknown as ServerResponse;
        expect(await handleLocalCodingRoutes(new URL('http://dashboard.example/api/local-coding/image-preferences'), req, res, { saveImageSettings })).toBe(true);
        expect(status).toBe(403);
        expect(saveImageSettings).not.toHaveBeenCalled();
    });
    it('saves arbitrary backend IDs, reloads independently and makes no inference-readiness claim', async () => {
        const f = await fixture();
        expect(await (await fetch(f.path)).json()).toEqual({ settings: {}, selectionApplied: false });
        const settings = { backend: 'omlx', models: { omlx: 'future/image-build', ollama: 'future:tag' } };
        expect((await f.post(settings)).status).toBe(200);
        const response = await fetch(f.path);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(await response.json()).toEqual({ settings, selectionApplied: false });
        expect((await f.post({})).status).toBe(200);
        expect(await (await fetch(f.path)).json()).toEqual({ settings: {}, selectionApplied: false });
        expect(f.forbidden).not.toHaveBeenCalled();
    });
    it.each(['https://untrusted.invalid', 'http://127.0.0.1:1', 'null'])('rejects origin %s before image storage', async origin => {
        const f = await fixture();
        expect((await f.post({ backend: 'omlx' }, origin)).status).toBe(403);
        expect(f.saveImages).not.toHaveBeenCalled();
    });
    it('rejects wrong content type and oversized bodies before storage', async () => {
        const f = await fixture();
        expect((await f.post({}, undefined, 'text/plain')).status).toBe(403);
        expect((await f.post({ models: { omlx: 'x'.repeat(5000) } })).status).toBe(400);
        expect(f.saveImages).not.toHaveBeenCalled();
    });
    it('rejects readiness fields and leaves the last valid selection intact', async () => {
        const f = await fixture();
        const settings = { backend: 'ollama', models: { ollama: 'future:tag' } };
        expect((await f.post(settings)).status).toBe(200);
        for (const field of ['enabled', 'qualified', 'receipt']) {
            expect((await f.post({ ...settings, [field]: true })).status).toBe(400);
        }
        expect((await (await fetch(f.path)).json()).settings).toEqual(settings);
        expect(f.forbidden).not.toHaveBeenCalled();
    });
    it('distinguishes a missing JSON body from deliberate clearing', async () => {
        const f = await fixture();
        const settings = { backend: 'omlx', models: { omlx: 'future/build' } };
        expect((await f.post(settings)).status).toBe(200);
        const writes = f.saveImages.mock.calls.length;
        expect((await fetch(f.path, { method: 'POST', headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
        expect(f.saveImages.mock.calls).toHaveLength(writes);
        expect((await (await fetch(f.path)).json()).settings).toEqual(settings);
        expect((await f.post({})).status).toBe(200);
        expect((await (await fetch(f.path)).json()).settings).toEqual({});
    });
});
