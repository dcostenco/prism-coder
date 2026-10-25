import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectOmlxImageModels } from '../../src/utils/omlxProvider.js';
import { inspectOllamaImageModels } from '../../src/utils/ollamaCodingModels.js';

afterEach(() => vi.useRealTimers());
const id = 'arbitrary/future:version';
function ollama(show: unknown = { capabilities: ['vision'] }) {
    const fetcher = vi.fn(async (url: any, _init?: RequestInit) => new Response(JSON.stringify(
        String(url).endsWith('/api/tags') ? { models: [{ name: id, size: 100 }, { name: 'text:tag' }] } :
        String(url).endsWith('/api/ps') ? { models: [{ name: id, size_vram: 120 }] } : show)));
    return fetcher;
}
describe('read-only exact image-model discovery', () => {
    it('lazily probes only an installed exact ID; never pulls, generates or guesses a suffix', async () => {
        const fetcher = ollama();
        const first = await inspectOllamaImageModels(undefined, 'http://local', fetcher);
        expect(first[0]).toEqual({ id, loaded: true, weightBytes: 100, loadedBytes: 120, capability: { vision: 'unknown', source: 'metadata_unavailable' } });
        expect(fetcher).toHaveBeenCalledTimes(2);
        const selected = await inspectOllamaImageModels(id, 'http://local', fetcher);
        expect(selected[0].capability.vision).toBe('yes');
        expect(selected[1].capability.vision).toBe('unknown');
        expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]!.body))).toEqual({ model: id });
        expect(fetcher.mock.calls.every(call => call[1]?.redirect === 'error')).toBe(true);
        const calls = fetcher.mock.calls.length;
        await inspectOllamaImageModels('future:version', 'http://local', fetcher);
        expect(fetcher.mock.calls.length - calls).toBe(2);
        expect(new Set(fetcher.mock.calls.map(call => new URL(String(call[0])).pathname))).toEqual(new Set(['/api/tags', '/api/ps', '/api/show']));
    });
    it('does not cache capability when a model is replaced under the same ID', async () => {
        expect((await inspectOllamaImageModels(id, 'http://local', ollama()))[0].capability.vision).toBe('yes');
        expect((await inspectOllamaImageModels(id, 'http://local', ollama({ capabilities: ['completion'] })))[0].capability.vision).toBe('no');
    });
    it('bounds a stalled exact capability probe and preserves known installation as unknown vision', async () => {
        vi.useFakeTimers();
        const base = ollama();
        const fetcher = vi.fn((url: any, init?: RequestInit) => String(url).endsWith('/api/show') ? new Promise<Response>(() => {}) : base(url, init));
        const pending = inspectOllamaImageModels(id, 'http://local', fetcher);
        await vi.advanceTimersByTimeAsync(3001);
        expect((await pending)[0].capability.vision).toBe('unknown');
        expect(fetcher).toHaveBeenCalledTimes(3);
    });
    it('rejects duplicate/oversized inventory and malformed selected IDs before show', async () => {
        const duplicate = async () => new Response(JSON.stringify({ models: [{ name: id }, { name: id }] }));
        await expect(inspectOllamaImageModels(id, 'http://local', duplicate)).rejects.toThrow('inventory_invalid');
        const large = async () => new Response(' '.repeat(1024 * 1024 + 1));
        await expect(inspectOllamaImageModels(id, 'http://local', large)).rejects.toThrow('metadata_invalid');
        const fetcher = ollama();
        await expect(inspectOllamaImageModels('bad\nmodel', 'http://local', fetcher)).rejects.toThrow('id_invalid');
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('returns only sanitized oMLX metadata, with VLM advertisement distinct from memory and testing', async () => {
        const fixtureCredential = randomUUID();
        const home = await mkdtemp(join(tmpdir(), 'prism-image-metadata-'));
        await mkdir(join(home, '.omlx'));
        await writeFile(join(home, '.omlx/settings.json'), JSON.stringify({ server: { host: '127.0.0.1', port: 8000 }, auth: { api_key: fixtureCredential } }));
        const fetchImpl = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify({ models: [
            { id: 'future/vlm', engine_type: 'vlm', loaded: false, estimated_size: 100, resident_estimated_size: 80, actual_size: 500, path: '/private/model', api_key: fixtureCredential },
            { id: 'vision-in-name', engine_type: 'llm', loaded: true, actual_size: 200 },
            { id: 'other', engine_type: 'new-engine' },
        ] })));
        const result = await inspectOmlxImageModels({ home, env: {}, fetchImpl });
        expect(result[0]).toEqual({ id: 'future/vlm', loaded: false, weightBytes: 100, residentEstimateBytes: 80, capability: { vision: 'yes', source: 'omlx.engine_type' } });
        expect(result[1].capability.vision).toBe('no');
        expect(result[2].capability.vision).toBe('unknown');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(String(fetchImpl.mock.calls[0][0])).toBe('http://127.0.0.1:8000/v1/models/status');
        expect(JSON.stringify(result)).not.toMatch(/private|qualified|enabled|peak/);
        expect(JSON.stringify(result)).not.toContain(fixtureCredential);
    });
});
