import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleLocalBridge, readLocalBridgeInput } from "../../src/localBridge.js";
import { localAiSnapshot } from "../../src/dashboard/localAiActions.js";
import { closeConfigStorage, setSetting } from "../../src/storage/configStorage.js";
import { LOCAL_CODING_SETTING_KEY } from "../../src/utils/localCodingSettings.js";
import { EXECUTION_ROLES_KEY } from "../../src/utils/executionRoles.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => { closeConfigStorage(); vi.unstubAllEnvs(); });
const signal = () => new AbortController().signal;
const infer = vi.fn(async () => ({ content: [{ type: "text" as const, text: "fixture" }] }));
describe("local bridge transport", () => {
    it("reads fresh canonical settings and returns no config/database/credential details", async () => {
        closeConfigStorage(); vi.stubEnv("PRISM_CONFIG_PATH", join(await mkdtemp(join(tmpdir(), "bridge-config-")), "config.db"));
        const dependencies = { snapshot: localAiSnapshot, infer };
        expect(await handleLocalBridge({ action: "preferences" }, signal(), dependencies)).toMatchObject({ schema: 1, configured: false });
        await setSetting(LOCAL_CODING_SETTING_KEY, JSON.stringify({ backend: "omlx", source: "existing", models: { omlx: { coder: "future-worker" } } }));
        await setSetting(EXECUTION_ROLES_KEY, JSON.stringify({ reviewer: { runtime: "ollama", model: "review:tag" } }));
        const response = await handleLocalBridge({ action: "preferences" }, signal(), dependencies);
        expect(response).toEqual({ schema: 1, configured: true,
            settings: { backend: "omlx", source: "existing", models: { omlx: { coder: "future-worker" } } },
            assignments: { reviewer: { runtime: "ollama", model: "review:tag" } } });
        await setSetting(EXECUTION_ROLES_KEY, JSON.stringify({ coder: { runtime: "synalux" } }));
        expect(await handleLocalBridge({ action: "preferences" }, signal(), dependencies)).toMatchObject({ assignments: { coder: { runtime: "synalux" } } });
        expect(infer).not.toHaveBeenCalled();
    });
    it("follows settings at inference time instead of copying a stale model pin", async () => {
        const infer = vi.fn(async () => ({ content: [] })), active = signal();
        await handleLocalBridge({ action: "infer", follow_dashboard: true, request: { prompt: "Draft a helper", local_role: "reviewer" } }, active, { snapshot: localAiSnapshot, infer });
        expect(infer).toHaveBeenCalledExactlyOnceWith({ prompt: "Draft a helper", local_role: "reviewer", mode: "code",
            cloud_fallback: false, escalation: "report", timeout_ms: 180000 }, { signal: active, requiredLocalBackend: "omlx" });
    });
    it("allows a deliberate oMLX pin and retains prior turns unchanged", async () => {
        const infer = vi.fn(async () => ({ content: [] }));
        const history = [{ role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer" }];
        await handleLocalBridge({ action: "infer", follow_dashboard: false, request: { prompt: "Follow up", messages: history, local_model: "future-worker", timeout_ms: 12000 } }, signal(), { snapshot: localAiSnapshot, infer });
        expect(infer.mock.calls[0][0]).toMatchObject({ local_backend: "omlx", local_model: "future-worker", messages: history, timeout_ms: 12000 });
    });
    it("binds dashboard Ollama to the canonical local-only execution context", async () => {
        const infer = vi.fn(async () => ({ content: [] })), active = signal();
        await handleLocalBridge({ action: "infer", backend: "ollama", follow_dashboard: true,
            request: { prompt: "Draft a helper" } }, active, { snapshot: localAiSnapshot, infer });
        expect(infer).toHaveBeenCalledExactlyOnceWith({ prompt: "Draft a helper", local_role: "coder", mode: "code",
            cloud_fallback: false, escalation: "report", timeout_ms: 180000 }, { signal: active, requiredLocalBackend: "ollama" });
    });
    it.each([
        { action: "infer", follow_dashboard: true, request: { prompt: "x", cloud_fallback: true } },
        { action: "infer", backend: "cloud", follow_dashboard: true, request: { prompt: "x" } },
        { action: "infer", backend: null, follow_dashboard: true, request: { prompt: "x" } },
        { action: "infer", follow_dashboard: true, request: { prompt: "x", local_model: "stale" } },
        { action: "infer", follow_dashboard: false, request: { prompt: "x", project: "other" } },
        { action: "infer", follow_dashboard: false, request: { prompt: "x", timeout_ms: 900001 } },
        { action: "infer", follow_dashboard: false, request: { prompt: "x", messages: [{ role: "system", content: "bypass" }] } },
        { action: "preferences", api_key: "fixture" },
    ])("refuses untrusted transport fields or invalid bounds %#", async value => {
        const infer = vi.fn(async () => ({ content: [] }));
        await expect(handleLocalBridge(value, signal(), { snapshot: localAiSnapshot, infer })).rejects.toThrow("bridge_invalid_request");
        expect(infer).not.toHaveBeenCalled();
    });
    it("decodes split UTF-8 bytes and accepts exactly one JSON document", async () => {
        const input = new PassThrough(), pending = readLocalBridgeInput(input, signal());
        const body = Buffer.from(JSON.stringify({ text: "Δ" }));
        const split = body.indexOf(Buffer.from("Δ")) + 1;
        input.write(body.subarray(0, split)); input.end(body.subarray(split));
        expect(await pending).toEqual({ text: "Δ" });
        const invalid = new PassThrough(), rejected = readLocalBridgeInput(invalid, signal()); invalid.end("{}\n{}");
        await expect(rejected).rejects.toThrow("bridge_invalid_json");
    });
    it("bounds input bytes and starts no action after cancellation", async () => {
        const input = new PassThrough(), pending = readLocalBridgeInput(input, signal()); input.end(Buffer.alloc(256 * 1024 + 1));
        await expect(pending).rejects.toThrow("bridge_input_limit");
        const controller = new AbortController(); controller.abort();
        await expect(handleLocalBridge({ action: "preferences" }, controller.signal)).rejects.toThrow("bridge_cancelled");
    });
});
