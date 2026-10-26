import { describe, expect, it, vi } from "vitest";
import { callLayer1, layer1ClassifierContent } from "../../src/utils/layer1.js";
import { OMLX_LAYER1_MODEL, OMLX_LAYER1_TIMEOUT_MS, omlxLayer1Fetch } from "../../src/utils/omlxLayer1.js";
import type { LocalGeneration, OmlxRequest } from "../../src/utils/omlxProvider.js";

const OLLAMA = "http://127.0.0.1:11434";
const PROMPT = "write a function that sorts an array of numbers";
const PNG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).toString("base64");

function recording(answer: (request: OmlxRequest) => Promise<LocalGeneration> | LocalGeneration) {
    const requests: OmlxRequest[] = [];
    const fetchImpl = omlxLayer1Fetch(async request => { requests.push(request); return answer(request); });
    return { requests, fetchImpl };
}

describe("Layer 1 on explicit oMLX: callLayer1 through the owned-path adapter", () => {
    it("sends callLayer1's one request with the empty system message, 16 tokens, temperature 0, thinking off and no cache store", async () => {
        const { requests, fetchImpl } = recording(() => ({ ok: true, text: "OBVIOUS_NOT_RESERVED", doneReason: "stop" }));
        const verdict = await callLayer1(PROMPT, OLLAMA, OMLX_LAYER1_MODEL, fetchImpl, undefined, { strictErrors: true });
        expect(verdict).toBe("OBVIOUS_NOT_RESERVED");
        expect(requests).toEqual([{
            messages: [{ role: "system", content: "" }, { role: "user", content: layer1ClassifierContent(PROMPT) }],
            maxTokens: 16, temperature: 0, timeoutMs: OMLX_LAYER1_TIMEOUT_MS, think: false, cacheStore: false,
        }]);
    });

    it("reads a reserved verdict", async () => {
        const { fetchImpl } = recording(() => ({ ok: true, text: "OBVIOUS_RESERVED", doneReason: "stop" }));
        expect(await callLayer1(PROMPT, OLLAMA, OMLX_LAYER1_MODEL, fetchImpl, undefined, { strictErrors: true })).toBe("OBVIOUS_RESERVED");
    });

    it("turns a failed generation into ERROR after callLayer1's one retry", async () => {
        const { requests, fetchImpl } = recording(() => ({ ok: false, reason: "omlx_provider_busy" }));
        expect(await callLayer1(PROMPT, OLLAMA, OMLX_LAYER1_MODEL, fetchImpl, undefined, { strictErrors: true })).toBe("ERROR");
        expect(requests).toHaveLength(2);
    });

    // callLayer1 gives its first attempt 1.5 s. The adapter does not forward
    // that signal: a cold model that answers after 2 s still decides on the
    // first attempt, with no second owned job.
    it("lets a slow first answer decide instead of timing out at callLayer1's budget", async () => {
        const { requests, fetchImpl } = recording(() => new Promise(resolve =>
            setTimeout(() => resolve({ ok: true, text: "OBVIOUS_NOT_RESERVED", doneReason: "stop" }), 2_000)));
        expect(await callLayer1(PROMPT, OLLAMA, OMLX_LAYER1_MODEL, fetchImpl, undefined, { strictErrors: true })).toBe("OBVIOUS_NOT_RESERVED");
        expect(requests).toHaveLength(1);
    }, 10_000);

    it("bounds each read by the call's remaining budget, and starts none with no budget left", async () => {
        let remaining = 5_000;
        const requests: OmlxRequest[] = [];
        const fetchImpl = omlxLayer1Fetch(async request => { requests.push(request); return { ok: true, text: "OBVIOUS_NOT_RESERVED", doneReason: "stop" }; }, () => remaining);
        expect(await callLayer1(PROMPT, OLLAMA, OMLX_LAYER1_MODEL, fetchImpl, undefined, { strictErrors: true })).toBe("OBVIOUS_NOT_RESERVED");
        expect(requests.map(r => r.timeoutMs)).toEqual([5_000]);
        remaining = 0;
        expect(await callLayer1(PROMPT, OLLAMA, OMLX_LAYER1_MODEL, fetchImpl, undefined, { strictErrors: true })).toBe("ERROR");
        expect(requests).toHaveLength(1);
    });

    it("stops reading an oversize prompt at the first unrecoverable window under strict errors", async () => {
        const long = "a harmless sentence about sorting numbers. ".repeat(300); // ~13,000 chars: 4 windows
        const { requests, fetchImpl } = recording(() => ({ ok: false, reason: "timeout" }));
        expect(await callLayer1(long, OLLAMA, OMLX_LAYER1_MODEL, fetchImpl, undefined, { strictErrors: true, readOversizeWhole: true })).toBe("ERROR");
        // both attempts of the first window, and nothing for the other three
        expect(requests.length).toBeLessThanOrEqual(2);
    });

    // 2026-10-17: the first explicit-oMLX call after a long idle was refused
    // (omlx_classifier_error) because the 9b's first read took over 15 s.
    it("waits out a cold first read slower than 15 s instead of refusing", async () => {
        vi.useFakeTimers();
        try {
            const { requests, fetchImpl } = recording(request => new Promise(resolve => setTimeout(() => resolve(
                request.timeoutMs > 20_000
                    ? { ok: true, text: "OBVIOUS_NOT_RESERVED", doneReason: "stop" }
                    : { ok: false, reason: "timeout" }), Math.min(20_000, request.timeoutMs))));
            const verdict = callLayer1(PROMPT, OLLAMA, OMLX_LAYER1_MODEL, fetchImpl, undefined, { strictErrors: true });
            await vi.advanceTimersByTimeAsync(60_000);
            expect(await verdict).toBe("OBVIOUS_NOT_RESERVED");
            expect(requests).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("answers only the chat request, and refuses a malformed body without a model request", async () => {
        const { requests, fetchImpl } = recording(() => ({ ok: true, text: "OBVIOUS_NOT_RESERVED", doneReason: "stop" }));
        // The model-inspection lookup callLayer1 makes first: no messages, so a 404.
        expect((await fetchImpl(`${OLLAMA}/api/show`, { method: "POST", body: JSON.stringify({ model: OMLX_LAYER1_MODEL }) })).status).toBe(404);
        expect((await fetchImpl(`${OLLAMA}/api/show`, { method: "POST", body: "not json" })).status).toBe(400);
        const chat = (body: unknown) => fetchImpl(`${OLLAMA}/api/chat`, { method: "POST", body: JSON.stringify(body) });
        const messages = [{ role: "user", content: "x" }];
        expect((await chat({ messages, options: { num_predict: 1.5 } })).status).toBe(400);
        expect((await chat({ messages, options: { num_predict: 0 } })).status).toBe(400);
        expect((await chat({ messages: [{ role: "user", content: "x", images: ["AA=="] }], options: { num_predict: 16 } })).status).toBe(400);
        expect(requests).toHaveLength(0);
        expect((await chat({ messages: [{ role: "user", content: "x", images: [PNG] }], options: { num_predict: 16 } })).status).toBe(200);
        expect(requests[0]?.messages).toEqual([{ role: "user", content: "x", images: [PNG] }]);
        expect((await chat({ messages: [], options: { num_predict: 16 } })).status).toBe(400);
        expect(requests).toHaveLength(1);
    });
});
