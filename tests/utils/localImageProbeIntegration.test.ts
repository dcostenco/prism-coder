import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectOllamaCodingModels } from '../../src/utils/ollamaCodingModels.js';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('coding deadlines survive the shared image metadata helper', () => {
    it('retains the caller-deadline cause if the wall clock trails its timer', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        vi.spyOn(Date, 'now').mockReturnValue(1000);
        const fetcher = vi.fn(() => new Promise<Response>(() => {}));
        let error: string | undefined;
        void inspectOllamaCodingModels('http://local', fetcher, { deadlineMs: 1050 })
            .catch(cause => { error = cause.message; });
        await vi.advanceTimersByTimeAsync(50);
        expect(error).toBe('ollama_model_probe_deadline');
    });

    it('keeps the private three-second cap distinct from caller deadlines', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        vi.spyOn(Date, 'now').mockReturnValue(1000);
        const fetcher = vi.fn(() => new Promise<Response>(() => {}));
        let error: string | undefined;
        void inspectOllamaCodingModels('http://local', fetcher)
            .catch(cause => { error = cause.message; });
        await vi.advanceTimersByTimeAsync(3000);
        expect(error).toBe('ollama_model_metadata_unavailable');
    });

    it('settles at the caller deadline when fetch ignores cancellation', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn(() => new Promise<Response>(() => {}));
        let error: string | undefined;
        void inspectOllamaCodingModels('http://local', fetcher, { deadlineMs: Date.now() + 50 })
            .catch(cause => { error = cause.message; });
        await vi.advanceTimersByTimeAsync(60);
        expect(error).toBe('ollama_model_probe_deadline');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('cancels both pending response readers when its caller aborts', async () => {
        vi.useFakeTimers();
        let cancellations = 0;
        const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new TextEncoder().encode('{"models":')); },
            cancel() { cancellations++; },
        })));
        const controller = new AbortController();
        let error: string | undefined;
        void inspectOllamaCodingModels('http://local', fetcher, { signal: controller.signal })
            .catch(cause => { error = cause.message; });
        await vi.advanceTimersByTimeAsync(1);
        controller.abort();
        await vi.advanceTimersByTimeAsync(1);
        expect(error).toBe('ollama_model_probe_deadline');
        expect(cancellations).toBe(2);
    });

    it('discards and cancels bodies delivered after the caller deadline', async () => {
        vi.useFakeTimers();
        const finish: Array<(response: Response) => void> = [];
        const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish.push(resolve); }));
        let error: string | undefined;
        void inspectOllamaCodingModels('http://local', fetcher, { deadlineMs: Date.now() + 50 })
            .catch(cause => { error = cause.message; });
        await vi.advanceTimersByTimeAsync(60);
        expect(error).toBe('ollama_model_probe_deadline');
        let cancellations = 0;
        for (const resolve of finish) resolve(new Response(new ReadableStream({ cancel() { cancellations++; } })));
        await vi.advanceTimersByTimeAsync(1);
        expect(cancellations).toBe(2);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
});
