import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectOmlx } from "../../src/utils/omlxProvider.js";

const KEY = "synthetic-inspection-key";
const MODEL = "fixture-local-model";
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

async function inspectStatus(overrides: Record<string, unknown>) {
    const home = await mkdtemp(join(tmpdir(), "prism-status-inspection-")); homes.push(home);
    await mkdir(join(home, ".omlx"));
    await writeFile(join(home, ".omlx/settings.json"), JSON.stringify({
        server: { host: "127.0.0.1", port: 8000 }, auth: { api_key: KEY },
    }));
    const status = { version: "0.7.1rc1", uptime_seconds: 1, models_loaded: 1, models_loading: 0,
        active_requests: 0, waiting_requests: 0, model_memory_used: 1, model_memory_max: 2, ...overrides };
    const fetchImpl = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(
        String(url).endsWith("/models") ? { data: [{ id: MODEL }] } : status,
    ))) as unknown as typeof fetch;
    return inspectOmlx({ home, env: {}, fetchImpl });
}

describe("read-only oMLX version inspection", () => {
    it.each(["0.7.0", "0.7.1rc1", "0.7.1rc1-prism-s28", "0.7.1-rc.1", "0.7.1+prism.s28"])(
        "accepts the status label %s without qualifying generation", async version => {
            expect(await inspectStatus({ version })).toMatchObject({
                advertised_models: [MODEL], status: { version }, idle_observed: true,
                generation_enabled: false, qualification: "not_qualified",
                evidence_scope: "authenticated_server_counters_only",
            });
        },
    );
    it.each(["0.7.1rc", "0.7.1rcx", "0.7.1rc1/other", "0.7.1rc1\n", " 0.7.1rc1", KEY, "0.7.1+" + "x".repeat(33)])(
        "rejects malformed or credential-bearing status labels: %j", async version => {
            await expect(inspectStatus({ version })).rejects.toThrow("omlx_inspection_status_invalid");
        },
    );
    it.each([{ active_requests: -1 }, { models_loading: 0.5 }, { model_memory_used: -1 }, { uptime_seconds: "1" }])(
        "does not relax counter and memory checks for a release candidate: %j", async overrides => {
            await expect(inspectStatus(overrides)).rejects.toThrow("omlx_inspection_status_invalid");
        },
    );
    it("preserves a busy observation rather than granting inference admission", async () => {
        expect(await inspectStatus({ active_requests: 1 })).toMatchObject({
            idle_observed: false, generation_enabled: false, qualification: "not_qualified",
        });
    });
});
