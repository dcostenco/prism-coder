import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { handleLocalCodingRoutes } from "../../src/dashboard/localCodingRouter.js";
import { parseLocalCodingSettings, type LocalCodingSettings } from "../../src/utils/localCodingSettings.js";
import { OmlxError } from "../../src/utils/omlxProvider.js";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

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
    it("keeps server reference facts separate even when the model describes the wrong image", async () => {
        const infer = vi.fn(async () => ({ structuredContent: { backend: "omlx", model_picked: "future/vision", used_cloud: false,
            output: "A blue circle", reference: { description: "forged by model" }, gate_outcome: { status: "success" } } }));
        const f = await fixture({ infer, imageSettings: async () => ({ backend: "omlx", models: { omlx: "future/vision" } }) });
        const data = await (await f.post("/api/local-coding/test", { backend: "omlx", purpose: "image" })).json();
        const bytes = Buffer.from((infer.mock.calls[0] as unknown as [any])[0].images[0], "base64");
        expect(data).toMatchObject({ status: "passed", output: "A blue circle", reference: {
            source: "builtin-diagnostic", description: "Solid red square", width: 32, height: 32, format: "PNG",
            sha256: createHash("sha256").update(bytes).digest("hex"),
        } });
        expect(bytes.readUInt32BE(16)).toBe(32); expect(bytes.readUInt32BE(20)).toBe(32);
        expect(bytes[24]).toBe(8); expect(bytes[25]).toBe(2); // RGB8, no interlace.
        const chunks: Buffer[] = [];
        for (let i = 8; i < bytes.length;) { const size = bytes.readUInt32BE(i); if (bytes.toString("ascii", i + 4, i + 8) === "IDAT") chunks.push(bytes.subarray(i + 8, i + 8 + size)); i += 12 + size; }
        const raw = inflateSync(Buffer.concat(chunks)), stride = 96, pixels = Buffer.alloc(32 * stride);
        for (let y = 0; y < 32; y++) for (let x = 0; x < stride; x++) {
            const filter = raw[y * (stride + 1)], left = x >= 3 ? pixels[y * stride + x - 3] : 0, up = y ? pixels[(y - 1) * stride + x] : 0;
            expect([0, 1, 2]).toContain(filter); // These are the filters in this fixed diagnostic.
            pixels[y * stride + x] = (raw[y * (stride + 1) + x + 1] + (filter === 1 ? left : filter === 2 ? up : 0)) & 255;
        }
        for (let i = 0; i < pixels.length; i += 3) expect([...pixels.subarray(i, i + 3)]).toEqual([255, 0, 0]);
    });
    it("withholds reference and output on a blocked image diagnostic", async () => {
        const f = await fixture({ imageSettings: async () => ({ models: { omlx: "future/vision" } }),
            infer: async () => ({ structuredContent: { backend: "omlx", model_picked: "future/vision", output: "stale text", used_cloud: false,
                gate_outcome: { status: "refused", reason: "omlx_memory_pressure" } } }) });
        const data = await (await f.post("/api/local-coding/test", { backend: "omlx", purpose: "image" })).json();
        expect(data.status).toBe("blocked"); expect(data.reference).toBeUndefined(); expect(data.output).toBeUndefined();
    });
    it.each([
        { role: "coder", model: "prism-coder:4b", reportedBackend: "ollama-4b" },
        { role: "reviewer", model: "prism-coder:4b", reportedBackend: "ollama-4b" },
        { role: "coder", model: "vendor/future:tag", reportedBackend: "ollama-vendor/future:tag" },
        { role: "reviewer", model: "vendor/future:tag", reportedBackend: "ollama-vendor/future:tag" },
    ])("recognizes production Ollama diagnostic results: $role / $model", async ({ role, model, reportedBackend }) => {
        const infer = vi.fn(async () => ({ structuredContent: { backend: reportedBackend, model_picked: model, used_cloud: false,
            output: "LOCAL_READY", gate_outcome: { status: "success", served_anyway: false } } }));
        const f = await fixture({ infer, settings: async () => ({ backend: "ollama", source: "existing", models: { ollama: { [role]: model } } }) });
        expect(await (await f.post("/api/local-coding/test", { backend: "ollama", purpose: role })).json()).toMatchObject({ status: "passed", model });
        expect(infer).toHaveBeenCalledWith(expect.objectContaining({ local_backend: "ollama", local_model: model, local_role: role, cloud_fallback: false }));
    });
    it.each([
        { backend: "omlx" }, { backend: "openrouter-local" }, { backend: "ollama-" },
        { model_picked: "different/model" }, { used_cloud: true }, { output: "" },
        { gate_outcome: { status: "degraded", served_anyway: true } },
        { gate_outcome: { status: "refused", served_anyway: false } },
    ])("keeps diagnostic backend/model/cloud/quality boundaries: %j", async change => {
        const model = "vendor/future:tag";
        const f = await fixture({ settings: async () => ({ backend: "ollama", source: "existing", models: { ollama: { coder: model } } }),
            infer: async () => ({ structuredContent: { backend: "ollama-vendor/future:tag", model_picked: model, used_cloud: false,
                output: "LOCAL_READY", gate_outcome: { status: "success", served_anyway: false }, ...change } }) });
        expect(await (await f.post("/api/local-coding/test", { backend: "ollama", purpose: "coder" })).json()).toMatchObject({ status: "blocked" });
    });
    it("reports the control connection independently of a coding model on an empty server", async () => {
        const f = await fixture({ inspect: async () => ({ url: "http://127.0.0.1:8127/v1", advertised_models: [] }), connectionControl: async () => true });
        expect(await (await fetch(f.base + "/api/local-coding")).json()).toMatchObject({ connection: { connected: true, control: true, models: [] } });
    });
    it("installs server-only without requesting pack downloads", async () => {
        const f = await fixture();
        expect((await f.post("/api/local-coding/install-server")).status).toBe(202);
        expect(f.install).toHaveBeenCalledExactlyOnceWith({ models: false });
    });
    it("previews all roles without changing preferences or inferring", async () => {
        const infer = vi.fn(), activateSource = vi.fn();
        const snapshot = { revision: "a".repeat(64), settings: { backend: "auto", source: "existing", models: { omlx: { coder: "same/build", reviewer: "same/build" } } }, image: { models: { omlx: "other/vision" } } };
        const f = await fixture({ infer, activateSource, snapshot: async () => snapshot,
            inspectSource: async () => ({ control: true, connected: true, models: ["same/build"] }) });
        const result = await (await fetch(f.base + "/api/local-coding/connection-preview?source=existing")).json();
        expect(result.canActivate).toBe(true);
        expect(result.assignments).toEqual([{ purpose: "coder", model: "same/build", available: true }, { purpose: "reviewer", model: "same/build", available: true }, { purpose: "image", model: "other/vision", available: false }]);
        expect(infer).not.toHaveBeenCalled(); expect(activateSource).not.toHaveBeenCalled();
        expect((await f.post("/api/local-coding/activate-connection", { source: "existing", revision: snapshot.revision })).status).toBe(200);
        expect(activateSource).toHaveBeenCalledWith("existing", snapshot.revision);
    });
    it("refuses unowned managed activation before a settings write", async () => {
        const activateSource = vi.fn();
        const f = await fixture({ activateSource, inspectSource: async () => ({ connected: true, control: true, models: [] }) });
        expect((await f.post("/api/local-coding/activate-connection", { source: "managed", revision: "a".repeat(64) })).status).toBe(409);
        expect(activateSource).not.toHaveBeenCalled();
    });
    it("runs only an explicit bounded saved-model image diagnostic without coding classifier", async () => {
        const infer = vi.fn(async (args: any) => ({ structuredContent: { backend: "omlx", model_picked: args.image_model, used_cloud: false, output: "red square", gate_outcome: { status: "success" } } }));
        const f = await fixture({ infer, imageSettings: async () => ({ backend: "omlx", models: { omlx: "future/vision" } }) });
        expect((await (await f.post("/api/local-coding/test", { backend: "omlx", purpose: "image" })).json()).status).toBe("passed");
        expect(infer).toHaveBeenCalledWith(expect.objectContaining({ image_backend: "omlx", image_model: "future/vision", cloud_fallback: false, strict_entitlements: true, images: [expect.stringMatching(/^iVBOR/)] }));
        expect((await f.post("/api/local-coding/test", { backend: "omlx", purpose: "image", prompt: "custom" })).status).toBe(400);
        expect((await f.post("/api/local-coding/test", { backend: "omlx", purpose: "image" }, "https://untrusted.invalid")).status).toBe(403);
        expect(infer).toHaveBeenCalledOnce();
    });
    it("distinguishes missing coding safety dependency and unsupported Ollama images", async () => {
        const infer = vi.fn();
        const f = await fixture({ infer, settings: async () => ({ backend: "omlx", source: "existing", models: { omlx: { coder: "future/coder" } } }),
            inspect: async () => ({ advertised_models: [] }), imageSettings: async () => ({ models: { ollama: "future:vision" } }) });
        expect(await (await f.post("/api/local-coding/test", { backend: "omlx", purpose: "coder" })).json()).toMatchObject({ status: "blocked", reason: "classifier_missing" });
        expect(await (await f.post("/api/local-coding/test", { backend: "ollama", purpose: "image" })).json()).toMatchObject({ status: "blocked", reason: "local_image_backend_not_enabled" });
        expect(infer).not.toHaveBeenCalled();
    });
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
