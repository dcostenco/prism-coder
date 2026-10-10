import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
const { createServer } = vi.hoisted(() => ({ createServer: vi.fn(() => ({ listen: vi.fn() })) }));
vi.mock('node:http', () => ({ default: { createServer } }));
let handler: (request: unknown, response: unknown) => Promise<unknown>;
beforeAll(async () => { await import('./docker/model-proxy.mjs'); handler = createServer.mock.calls[0][0]; });
afterEach(() => vi.unstubAllGlobals());
async function request(method: string, url: string, model?: string) {
  const req = { method, url, headers: {}, async *[Symbol.asyncIterator]() { if (model) yield Buffer.from(JSON.stringify({ model })); } };
  const res = { writeHead: vi.fn(), end: vi.fn() };
  const fetch = vi.fn(async () => new Response(JSON.stringify({ models: [], choices: [{ message: { content: '{}' } }] })));
  vi.stubGlobal('fetch', fetch); await handler(req, res); return { fetch, res };
}
describe('isolated Factory model proxy destinations', () => {
  it.each([['GET', '/v1/models', undefined, 'models'], ['POST', '/v1/chat/completions', 'prism-coder:4b', 'chat/completions']])('forwards %s %s to a fixed URL and rejects redirects', async (method, path, model, endpoint) => {
    const { fetch } = await request(method!, path!, model);
    expect(fetch).toHaveBeenCalledWith(`http://host.docker.internal:11434/v1/${endpoint}`, expect.objectContaining({ redirect: 'error' }));
  });
  it.each(['/v1/models?redirect=http://169.254.169.254/', '//169.254.169.254/', '/api/pull', '/v1/chat/completions/../models'])('refuses unlisted caller path %s before forwarding', async path => {
    const { fetch, res } = await request('GET', path); expect(fetch).not.toHaveBeenCalled(); expect(res.writeHead).toHaveBeenCalledWith(404);
  });
  it('refuses an unlisted model before forwarding', async () => {
    const { fetch, res } = await request('POST', '/v1/chat/completions', 'unlisted-fixture-model'); expect(fetch).not.toHaveBeenCalled(); expect(res.writeHead).toHaveBeenCalledWith(400);
  });
});
