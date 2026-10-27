import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { detectOmlxImage, inspectOmlxImageInput } from "../../src/utils/omlxProvider.js";
import { registerOperation } from "../../src/utils/omlxControl.js";

const MODEL = "vendor/future-vision";
async function fixture() {
    const home = await mkdtemp(join(tmpdir(), "prism-image-capability-"));
    const key = randomUUID();
    await mkdir(join(home, ".omlx"));
    await writeFile(join(home, ".omlx/settings.json"), JSON.stringify({ server: { host: "127.0.0.1", port: 8000 }, auth: { api_key: key }, sampling: { max_context_window: 16384 } }));
    await writeFile(join(home, ".omlx/model_settings.json"), JSON.stringify({ models: { [MODEL]: { max_context_window: 16384 } } }));
    const capability = { schema: "owned-png-v1", model_id: MODEL, enabled: true, context_tokens: 8192,
        settings_sha256: "a".repeat(64), limits: { images: 4, image_bytes: 131072, total_image_bytes: 196608,
            image_side: 2048, image_pixels: 4194304, total_image_pixels: 8388608 } };
    const fetchImpl = vi.fn(async (url: string | URL | Request) => Response.json(String(url).endsWith("/models")
        ? { data: [{ id: MODEL }] } : capability)) as unknown as typeof fetch;
    return { home, key, capability, fetchImpl };
}

describe("server-owned image capability", () => {
    it("identifies a missing image route without treating inventory or text control as image support", async () => {
        const f = await fixture();
        vi.mocked(f.fetchImpl).mockImplementation(async url => String(url).endsWith("/models")
            ? Response.json({ data: [{ id: MODEL }] }) : Response.json({ detail: "Not Found" }, { status: 404 }));
        await expect(detectOmlxImage(MODEL, { home: f.home, env: {}, fetchImpl: f.fetchImpl }))
            .rejects.toThrow("omlx_image_server_update_required");
        expect(await inspectOmlxImageInput(MODEL, { home: f.home, env: {}, fetchImpl: f.fetchImpl }))
            .toEqual({ model: MODEL, state: "update_required", reason: "omlx_image_server_update_required" });
        expect(vi.mocked(f.fetchImpl).mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    });
    it("reports a valid contract without returning credentials or an execution target", async () => {
        const f = await fixture();
        expect(await inspectOmlxImageInput(MODEL, { home: f.home, env: {}, fetchImpl: f.fetchImpl }))
            .toEqual({ model: MODEL, state: "available" });
    });
    it.each([401, 403, 500])("keeps HTTP %s unknown instead of prescribing a server upgrade", async status => {
        const f = await fixture();
        vi.mocked(f.fetchImpl).mockImplementation(async url => String(url).endsWith("/models")
            ? Response.json({ data: [{ id: MODEL }] }) : Response.json({ detail: f.key }, { status }));
        const result = await inspectOmlxImageInput(MODEL, { home: f.home, env: {}, fetchImpl: f.fetchImpl });
        expect(result).toMatchObject({ model: MODEL, state: "unknown" });
        expect(result.reason).toBe(status === 500 ? "omlx_inspection_http_failed" : "omlx_auth_failed");
        expect(JSON.stringify(result)).not.toContain(f.key);
    });
    it("separates a disabled contract from network and malformed-response failures", async () => {
        const f = await fixture();
        f.capability.enabled = false;
        expect(await inspectOmlxImageInput(MODEL, { home: f.home, env: {}, fetchImpl: f.fetchImpl }))
            .toMatchObject({ state: "not_enabled" });
        vi.mocked(f.fetchImpl).mockRejectedValue(new Error(f.key));
        const result = await inspectOmlxImageInput(MODEL, { home: f.home, env: {}, fetchImpl: f.fetchImpl });
        expect(result).toMatchObject({ state: "unknown" });
        expect(JSON.stringify(result)).not.toContain(f.key);
    });
    it("does not prescribe upgrading for a model-specific 404 or malformed contract", async () => {
        const f = await fixture();
        vi.mocked(f.fetchImpl).mockImplementation(async url => String(url).endsWith("/models")
            ? Response.json({ data: [{ id: MODEL }] }) : Response.json({ detail: "Model unavailable" }, { status: 404 }));
        expect(await inspectOmlxImageInput(MODEL, { home: f.home, env: {}, fetchImpl: f.fetchImpl }))
            .toMatchObject({ state: "unknown" });
        vi.mocked(f.fetchImpl).mockImplementation(async url => String(url).endsWith("/models")
            ? Response.json({ data: [{ id: MODEL }] }) : Response.json({ ...f.capability, settings_sha256: "invalid" }));
        expect(await inspectOmlxImageInput(MODEL, { home: f.home, env: {}, fetchImpl: f.fetchImpl }))
            .toMatchObject({ state: "unknown" });
    });
    it("settles a setup probe when the transport ignores cancellation", async () => {
        const f = await fixture();
        vi.mocked(f.fetchImpl).mockImplementation(() => new Promise(() => {}));
        const result = await inspectOmlxImageInput(MODEL, { home: f.home, env: {}, fetchImpl: f.fetchImpl, deadlineMs: Date.now() + 25 });
        expect(result).toEqual({ model: MODEL, state: "unknown", reason: "omlx_inspection_timeout" });
    });
    it("requires authenticated exact model capability and clamps context to server", async () => {
        const f = await fixture();
        const target = await detectOmlxImage(MODEL, { home: f.home, env: {}, fetchImpl: f.fetchImpl });
        expect(target).toMatchObject({ model: MODEL, contextTokens: 8192, settingsSha256: "a".repeat(64) });
        expect(JSON.stringify(target)).not.toContain(f.key);
        expect(vi.mocked(f.fetchImpl).mock.calls[1][0]).toBe("http://127.0.0.1:8000/prism-control/v1/models/vendor%2Ffuture-vision/image-input");
        expect(vi.mocked(f.fetchImpl).mock.calls.every(([, init]) => (init?.headers as Record<string, string>).Authorization === "Bearer " + f.key)).toBe(true);
    });
    it.each([{ enabled: false }, { enabled: 1 }, { model_id: "other" }, { schema: "unknown" },
        { context_tokens: true }, { context_tokens: 0 }, { settings_sha256: "bad" }, { limits: {} }])("refuses invalid contract %j", async bad => {
        const f = await fixture(); Object.assign(f.capability, bad);
        await expect(detectOmlxImage(MODEL, { home: f.home, env: {}, fetchImpl: f.fetchImpl })).rejects.toThrow("omlx_image_input_unavailable");
    });
    it("does not probe after the caller deadline", async () => {
        const f = await fixture();
        await expect(detectOmlxImage(MODEL, { home: f.home, env: {}, fetchImpl: f.fetchImpl, deadlineMs: Date.now() - 1 })).rejects.toThrow("omlx_inspection_timeout");
        expect(f.fetchImpl).not.toHaveBeenCalled();
    });
    it("refuses the full UTF-8 envelope before durable registration", async () => {
        const fetchImpl = vi.fn();
        expect(() => registerOperation({ base: "http://127.0.0.1/control", apiKey: randomUUID(), fetchImpl }, "job", "operation",
            { input: "界".repeat(100000) })).toThrow("omlx_control_request_too_large");
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
