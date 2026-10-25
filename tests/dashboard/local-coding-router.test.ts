import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { handleLocalCodingRoutes } from "../../src/dashboard/localCodingRouter.js";
import { parseLocalCodingSettings, type LocalCodingSettings } from "../../src/utils/localCodingSettings.js";
import { OmlxError } from "../../src/utils/omlxProvider.js";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
async function fixture(overrides = {}) {
    let saved: LocalCodingSettings = { backend: "auto", source: "existing" };
    const install = vi.fn(async () => ({ id: "fixture", state: "running" }));
    const start = vi.fn(async () => ({ starting: true, running: false }));
    const server = createServer(async (req, res) => {
        const handled = await handleLocalCodingRoutes(new URL(req.url!, "http://127.0.0.1"), req, res, {
            setup: { install, start, status: async () => ({ supported: true, installed: false, memoryGB: 48, freeDiskGB: 100,
                requirements: { memoryGB: 32, freeDiskGB: 40 }, models: [], job: null, server: { connected: false, models: [] } }) },
            settings: async () => saved,
            save: async value => { saved = parseLocalCodingSettings(value); },
            preference: async () => ({ saved: saved.backend, effective: saved.backend, envOverride: null, model: saved.model, configured: false }),
            inspect: async () => { throw new OmlxError("omlx_auth_unavailable"); },
            omlxModels: async () => [], ollamaModels: async () => [], availableMemory: () => 20 * 1024 ** 3,
            ...overrides,
        });
        if (!handled) { res.writeHead(404); res.end(); }
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
    const post = (path: string, body: unknown = {}, origin = base) => fetch(base + path, {
        method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body),
    });
    return { base, post, install, start };
}

describe("dashboard local coding actions", () => {
    it("discovers both backends and persists the same model for both roles", async () => {
        const models = { omlx: { coder: "new/build", reviewer: "new/build" }, ollama: { coder: "future:tag", reviewer: "future:tag" } };
        const f = await fixture({ ollamaModels: async () => [{ id: "future:tag", loaded: false, weightBytes: 12345678 }] });
        expect((await f.post("/api/local-coding/preferences", { backend: "auto", source: "existing", models })).status).toBe(200);
        expect(await (await fetch(f.base + "/api/local-coding")).json()).toMatchObject({ settings: { models },
            discovered: { ollama: [{ id: "future:tag", weightBytes: 12345678 }] }, availableMemoryBytes: 20 * 1024 ** 3 });
        expect(f.install).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
    });
    it("keeps recovery controls available when preference inspection fails", async () => {
        const f = await fixture({ preference: async () => { throw new Error("broken config"); } });
        const result = await fetch(f.base + "/api/local-coding");
        expect(result.status).toBe(200);
        expect(await result.json()).toMatchObject({ canManage: true, settings: { backend: "auto" }, preferenceError: expect.any(String) });
        expect((await f.post("/api/local-coding/preferences", { backend: "ollama", source: "managed" })).status).toBe(200);
    });
    it("persists all backend/model/source fields together and reads them after reopening", async () => {
        const f = await fixture();
        const settings = { backend: "omlx", source: "managed", model: "Qwen3.8-27B-oQ4e-mtp" };
        expect((await f.post("/api/local-coding/preferences", settings)).status).toBe(200);
        const reopened = await (await fetch(f.base + "/api/local-coding")).json();
        expect(reopened.settings).toEqual(settings);
        expect(reopened.preference.effective).toBe("omlx");
        expect(f.install).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
    });
    it("requires a deliberate empty-body install action and rejects custom repositories/commands", async () => {
        const f = await fixture();
        expect((await f.post("/api/local-coding/install", { repo: "arbitrary/source" })).status).toBe(400);
        expect(f.install).not.toHaveBeenCalled();
        expect((await f.post("/api/local-coding/install")).status).toBe(202);
        expect(f.install).toHaveBeenCalledTimes(1);
    });
    it("preserves no-body install and start actions", async () => {
        const f = await fixture();
        for (const action of ["install", "start"]) {
            expect((await fetch(f.base + "/api/local-coding/" + action, {
                method: "POST", headers: { "Content-Type": "application/json", Origin: f.base },
            })).status).toBe(202);
        }
        expect(f.install).toHaveBeenCalledTimes(1);
        expect(f.start).toHaveBeenCalledTimes(1);
    });
    it("rejects cross-origin and cross-port writes before any install or save", async () => {
        const f = await fixture();
        for (const origin of ["https://untrusted.invalid", "http://127.0.0.1:1", "null"]) {
            expect((await f.post("/api/local-coding/install", {}, origin)).status).toBe(403);
        }
        expect(f.install).not.toHaveBeenCalled();
    });
    it("does not expose raw configuration errors or tokens", async () => {
        const f = await fixture();
        f.install.mockRejectedValue(new Error("synthetic-secret-token"));
        const result = await f.post("/api/local-coding/install");
        expect(result.status).toBe(400);
        expect(await result.text()).not.toContain("synthetic-secret-token");
    });
    it.each([
        { backend: "cloud", source: "existing" }, { backend: "omlx", source: "remote" },
        { backend: "omlx", source: "managed", command: "arbitrary" },
        { backend: "omlx", source: "existing", model: "bad\nmodel" },
    ])("rejects invalid saved preference records", async settings => {
        const f = await fixture();
        expect((await f.post("/api/local-coding/preferences", settings)).status).toBe(400);
        expect((await (await fetch(f.base + "/api/local-coding")).json()).settings).toEqual({ backend: "auto", source: "existing" });
    });
});
