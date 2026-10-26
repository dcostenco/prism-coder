import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { detectOmlxImage } from "../../src/utils/omlxProvider.js";
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
    it("requires authenticated exact model capability and clamps context to server", async () => {
        const f = await fixture();
        const target = await detectOmlxImage(MODEL, { home: f.home, env: {}, fetchImpl: f.fetchImpl });
        expect(target).toMatchObject({ model: MODEL, contextTokens: 8192 });
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
