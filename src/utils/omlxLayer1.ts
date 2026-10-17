/** Layer 1 on explicit oMLX: callLayer1 runs unchanged, and its one model
 * request goes to the classifier model on the same provider, through the owned
 * path, inside the call's device lease. */
import type { LocalGeneration, OmlxRequest } from "./omlxProvider.js";

/** The 9b, converted to MLX at 8 bits: the classifier measured on oMLX. */
export const OMLX_LAYER1_MODEL = "prism-coder-9b-mlx-8bit";
/** One classifier request. Longer than callLayer1's own per-attempt budget so a
 *  cold model answers the first attempt: a load from disk takes about 5 s, and
 *  the first read after a long idle exceeded 15 s (2026-10-17, refused) while a
 *  warm read takes under 1 s. The owned path proves every stop, so nothing is
 *  left running when it ends. */
export const OMLX_LAYER1_TIMEOUT_MS = 90_000;

function chatMessages(value: unknown): { role: string; content: string }[] | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const messages: { role: string; content: string }[] = [];
    for (const message of value) {
        if (!message || typeof message !== "object" || "images" in message) return undefined;
        const { role, content } = message as Record<string, unknown>;
        if (typeof role !== "string" || typeof content !== "string") return undefined;
        messages.push({ role, content });
    }
    return messages;
}

/** callLayer1's fetch on explicit oMLX. It makes no HTTP request; it answers
 *  callLayer1's own requests in process.
 *  - Only the chat request carries messages. The model-inspection lookup does
 *    not, and gets a 404, so callLayer1 leads with the empty system message the
 *    gate measured.
 *  - callLayer1's per-attempt signal is not forwarded: the owned job has its own
 *    deadline.
 *  - Every request asks the provider not to keep its prompt cache: a classifier
 *    request is unique and never reused. */
export function omlxLayer1Fetch(generate: (request: OmlxRequest) => Promise<LocalGeneration>): typeof fetch {
    return (async (_input: string | URL | Request, init?: RequestInit) => {
        let body: { messages?: unknown; options?: { num_predict?: unknown; temperature?: unknown }; think?: unknown };
        try { body = JSON.parse(String(init?.body)); } catch { return new Response(null, { status: 400 }); }
        if (!body || typeof body !== "object" || !("messages" in body)) return new Response(null, { status: 404 });
        const messages = chatMessages(body.messages);
        const maxTokens = body?.options?.num_predict;
        if (!messages || typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0)
            return new Response(null, { status: 400 });
        const temperature = body.options?.temperature;
        const result = await generate({ messages, maxTokens, temperature: typeof temperature === "number" ? temperature : 0,
            timeoutMs: OMLX_LAYER1_TIMEOUT_MS, think: body.think === true, cacheStore: false });
        return result.ok
            ? Response.json({ done: true, done_reason: result.doneReason, message: { role: "assistant", content: result.text } })
            : Response.json({ error: result.reason }, { status: 503 });
    }) as typeof fetch;
}
