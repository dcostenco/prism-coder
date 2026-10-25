import { describe, expect, it, vi } from "vitest";
import { localCodingRecommendation } from "../../src/utils/localCodingRecommendation.js";

const KEY = "fixture-synalux-token";
const reply = (extra = {}) => ({ schema: 1, backend: "omlx", role: "coder", model: "vendor/future-build", ...extra });
const fixture = (value: unknown = reply()) => {
    const token = vi.fn(async () => KEY);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(value))) as unknown as typeof fetch;
    return { token, fetchImpl, options: { baseUrl: "https://synalux.example", configured: true, token, fetchImpl } };
};
describe("metadata-only optional recommendation", () => {
    it("sends exactly backend and role and never accepts a remote recipe", async () => {
        const f = fixture();
        expect(await localCodingRecommendation("omlx", "coder", f.options)).toBe("vendor/future-build");
        const [url, options] = vi.mocked(f.fetchImpl).mock.calls[0];
        expect(new URL(String(url)).pathname).toBe("/api/v1/prism/local-model-recommendation");
        expect([...new URL(String(url)).searchParams]).toEqual([["backend", "omlx"], ["role", "coder"]]);
        expect(options).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: "Bearer " + KEY } });
        expect(options).not.toHaveProperty("body");
        const policy = fixture(reply({ policy: "private-recipe" }));
        expect(await localCodingRecommendation("omlx", "coder", policy.options)).toBeUndefined();
    });
    it("does no authentication or HTTP work when unconfigured or already aborted", async () => {
        const f = fixture();
        expect(await localCodingRecommendation("omlx", "coder", { ...f.options, configured: false })).toBeUndefined();
        const c = new AbortController(); c.abort();
        expect(await localCodingRecommendation("omlx", "coder", { ...f.options, signal: c.signal })).toBeUndefined();
        expect(f.token).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
    });
    it.each([null, [], {}, reply({ schema: 2 }), reply({ backend: "ollama" }), reply({ role: "reviewer" }),
        reply({ model: "bad\nname" }), reply({ model: KEY }), reply({ model: "x".repeat(257) })])
    ("rejects malformed or mismatched decisions: %j", async value => {
        const f = fixture(value);
        expect(await localCodingRecommendation("omlx", "coder", f.options)).toBeUndefined();
    });
    it.each([401, 403, 404, 429, 503])("treats HTTP %s as no hint", async status => {
        const f = fixture(); vi.mocked(f.fetchImpl).mockResolvedValue(new Response("private error", { status }));
        expect(await localCodingRecommendation("omlx", "coder", f.options)).toBeUndefined();
    });
    it("limits bytes and refuses unsafe origins without contacting them", async () => {
        const f = fixture(); vi.mocked(f.fetchImpl).mockResolvedValue(new Response("x".repeat(4097)));
        expect(await localCodingRecommendation("omlx", "coder", f.options)).toBeUndefined();
        vi.mocked(f.fetchImpl).mockClear(); f.token.mockClear();
        for (const baseUrl of ["http://remote.example", "https://user:password@remote.example", "https://remote.example/path", "https://remote.example?secret=1"]) {
            expect(await localCodingRecommendation("omlx", "coder", { ...f.options, baseUrl })).toBeUndefined();
        }
        expect(f.token).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
    });
    it("does not issue a request after a shared JWT result arrives too late", async () => {
        const f = fixture();
        f.token.mockImplementation(async () => { await new Promise(r => setTimeout(r, 30)); return KEY; });
        expect(await localCodingRecommendation("omlx", "coder", { ...f.options, deadlineMs: Date.now() + 5 })).toBeUndefined();
        await new Promise(r => setTimeout(r, 40));
        expect(f.fetchImpl).not.toHaveBeenCalled();
    });
    it("bounds a stalled response body and discards late replies", async () => {
        const f = fixture();
        vi.mocked(f.fetchImpl).mockResolvedValue(new Response(new ReadableStream({ start() {} })));
        expect(await localCodingRecommendation("omlx", "coder", { ...f.options, deadlineMs: Date.now() + 10 })).toBeUndefined();
        expect(vi.mocked(f.fetchImpl).mock.calls[0][1]?.signal?.aborted).toBe(true);
        const late = fixture();
        vi.mocked(late.fetchImpl).mockImplementation(async () => {
            await new Promise(r => setTimeout(r, 30)); return new Response(JSON.stringify(reply()));
        });
        expect(await localCodingRecommendation("omlx", "coder", { ...late.options, deadlineMs: Date.now() + 5 })).toBeUndefined();
        await new Promise(r => setTimeout(r, 40));
    });
});
