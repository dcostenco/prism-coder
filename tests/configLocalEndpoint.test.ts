import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";

const saved = process.env.PRISM_LOCAL_LLM_URL;
afterEach(() => {
    if (saved === undefined) delete process.env.PRISM_LOCAL_LLM_URL;
    else process.env.PRISM_LOCAL_LLM_URL = saved;
    vi.resetModules();
});
async function endpoint(value?: string): Promise<string> {
    if (value === undefined) delete process.env.PRISM_LOCAL_LLM_URL;
    else process.env.PRISM_LOCAL_LLM_URL = value;
    vi.resetModules();
    return (await import("../src/config.js")).PRISM_LOCAL_LLM_URL;
}

describe("local Ollama default endpoint", () => {
    it("can check the local device even when hostname lookup cannot complete", async () => {
        const hostname = new URL(await endpoint()).hostname;
        const status = JSON.stringify({ models: [] });
        const server = createServer((_request, response) => response.end(status));
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        let lookups = 0;
        try {
            const body = await new Promise<string>((resolve, reject) => {
                const request = get({ hostname, port: (server.address() as AddressInfo).port, path: "/api/ps",
                    // A queued getaddrinfo job can outlive the resource deadline.
                    // No name service is needed to reach a numeric local endpoint.
                    lookup: () => { lookups++; }, signal: AbortSignal.timeout(250) }, response => {
                    let text = "";
                    response.setEncoding("utf8");
                    response.on("data", chunk => { text += chunk; });
                    response.on("end", () => resolve(text));
                    response.on("error", reject);
                });
                request.on("error", reject);
            });
            expect(JSON.parse(body)).toEqual({ models: [] });
            expect(lookups).toBe(0);
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
    it("uses the standard local IPv4 port when no override is set", async () => {
        expect(await endpoint()).toBe("http://127.0.0.1:11434");
        expect(await endpoint("")).toBe("http://127.0.0.1:11434");
    });
    it.each(["http://localhost:11434", "http://[::1]:11434", "http://ollama.example:11434"])
    ("preserves the operator-selected endpoint %s", async value => {
        expect(await endpoint(`  ${value}  `)).toBe(value);
    });
});
