/** Adapt classifier requests to the owned local oMLX provider. */
import type { LocalGeneration, OmlxRequest } from "./omlxProvider.js";
import { validateOmlxMessages, type OmlxImageMessage } from "./omlxImages.js";

/** Classifier model used by this adapter. */
export const OMLX_LAYER1_MODEL = "prism-coder-9b-mlx-8bit";
/** Maximum adapter request duration, further bounded by the caller's budget. */
export const OMLX_LAYER1_TIMEOUT_MS = 90_000;

function chatMessages(value: unknown): OmlxImageMessage[] | undefined {
    try { return validateOmlxMessages(value); } catch { return undefined; }
}

/** Handle chat requests through the supplied local generator with cache storage disabled. */
export function omlxLayer1Fetch(generate: (request: OmlxRequest) => Promise<LocalGeneration>, remainingMs: () => number = () => OMLX_LAYER1_TIMEOUT_MS): typeof fetch {
    return (async (_input: string | URL | Request, init?: RequestInit) => {
        // Each read is bounded by the call's remaining timeout_ms as well, so an
        // oversize prompt read in windows cannot outlast the budget the caller set.
        const timeoutMs = Math.min(OMLX_LAYER1_TIMEOUT_MS, Math.floor(remainingMs()));
        if (timeoutMs <= 0) return Response.json({ error: "timeout" }, { status: 503 });
        let body: { messages?: unknown; options?: { num_predict?: unknown; temperature?: unknown }; think?: unknown };
        try { body = JSON.parse(String(init?.body)); } catch { return new Response(null, { status: 400 }); }
        if (!body || typeof body !== "object" || !("messages" in body)) return new Response(null, { status: 404 });
        const messages = chatMessages(body.messages);
        const maxTokens = body?.options?.num_predict;
        if (!messages || typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0)
            return new Response(null, { status: 400 });
        const temperature = body.options?.temperature;
        const result = await generate({ messages: messages as OmlxRequest["messages"], maxTokens, temperature: typeof temperature === "number" ? temperature : 0,
            timeoutMs, think: body.think === true, cacheStore: false });
        return result.ok
            ? Response.json({ done: true, done_reason: result.doneReason, message: { role: "assistant", content: result.text } })
            : Response.json({ error: result.reason }, { status: 503 });
    }) as typeof fetch;
}
