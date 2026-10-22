import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { callOllamaGenerate, groundAnswer, probeTemplateOverhead } from '../../src/tools/prismInferHandler.js';
import { parseAnswerCheckPolicy } from '../../src/utils/inferencePolicy.js';
const text = readFileSync(new URL('../fixtures/answer-check-policy.synthetic.json', import.meta.url), 'utf8');
const policy = parseAnswerCheckPolicy(text, createHash('sha256').update(text).digest('hex'))!;
afterEach(() => vi.unstubAllGlobals());
describe('selected model context binding', () => {
    it('pins generation, template probes and all answer-check attempts to the admitted context', async () => {
        const requests: any[] = [];
        const fetcher = vi.fn(async (url: any, init?: RequestInit) => {
            if (String(url).endsWith('/api/show')) return new Response(JSON.stringify({ system: '' }));
            requests.push(JSON.parse(String(init?.body)));
            return new Response(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 3, message: { content: 'PASS' } }));
        });
        vi.stubGlobal('fetch', fetcher);
        const id = 'context-binding:tag';
        await callOllamaGenerate('http://local', id, 'code', 'system', 128, 0, 1000, false, undefined, undefined, 4096);
        await probeTemplateOverhead('http://local', id, true, 4096);
        await groundAnswer({ policy, ollamaUrl: 'http://local', model: id, prompt: 'code', messages: [], answer: 'answer', numCtx: 4096, fetchImpl: fetcher });
        expect(requests.length).toBeGreaterThanOrEqual(3);
        expect(requests.every(request => request.model === id && request.options.num_ctx === 4096)).toBe(true);
        // A cache entry measured at another context must not bypass the pin.
        await probeTemplateOverhead('http://local', id, true, 2048);
        expect(requests.at(-1).options.num_ctx).toBe(2048);
    });
});
