import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const settings = vi.hoisted(() => ({ backend: "omlx", model: "fixture-coder", account: "" }));
vi.mock("../../src/storage/configStorage.js", async importOriginal => ({ ...await importOriginal<any>(),
    getSetting: async (key: string, fallback: unknown) => key === "PRISM_SYNALUX_API_KEY" ? settings.account : fallback }));
vi.mock("../../src/utils/localCodingSettings.js", () => ({ readLocalCodingSettings: async () => ({ backend: settings.backend, source: "existing", model: settings.model }) }));
vi.mock("../../src/utils/localImageSettings.js", () => ({ readLocalImageSettings: async () => ({}) }));
let temp: string;
beforeEach(() => {
    vi.resetModules(); temp = mkdtempSync(join(tmpdir(), "prism-host-task-"));
    vi.stubEnv("PRISM_HOST_TASKS", "required"); vi.stubEnv("PRISM_DATA_DIR", temp); vi.stubEnv("PRISM_CONFIG_PATH", join(temp, "config.db"));
    settings.backend = "omlx"; settings.model = "fixture-coder"; settings.account = "";
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(temp, { recursive: true, force: true }); });
const request = () => ({ prompt: "Explain the supplied routine data.", system: "Use supplied evidence.",
    messages: [{ role: "user", content: "Earlier accepted context." }], evidence: [{ source: "fixture", content: "Data." }],
    images: ["fixture-image-bytes"], local_backend: "omlx" });

describe("host-mediated task execution", () => {
    it("MCP flags and a prepared packet alone never enter the provider scope", async () => {
        const h = await import("../../src/utils/hostTasks.js");
        const ask = { ...request(), approved: true, host_authorized: true };
        const packet = await h.prepareHostTask("prism_infer", ask, ask);
        expect(h.approvedHostTask("prism_infer", ask)).toBeUndefined();
        expect(() => h.consumeHostExecution("prism_infer", ask)).toThrow("host_authorization_required");
        const response = h.hostTaskResponse(packet);
        expect(response.structuredContent.status).toBe("host_authorization_required");
    });
    it("executes the exact prepared snapshot once without a second preparation", async () => {
        const h = await import("../../src/utils/hostTasks.js"), ask = request();
        const prepared = { ...ask, system: "Frozen project memory and source evidence." };
        const packet = await h.prepareHostTask("prism_infer", ask, prepared, { memory: { project: "fixture", depth: "standard" } });
        const result = await h.executeApprovedHostTask(h.hostTaskResponse(packet).structuredContent, async (kind, input) => {
            expect(kind).toBe("prism_infer");
            expect(h.approvedHostTask(kind, input)?.execution.system).toBe(prepared.system);
            h.consumeHostExecution(kind, prepared);
            expect(() => h.consumeHostExecution(kind, prepared)).toThrow();
            return "bounded-result";
        });
        expect(result).toBe("bounded-result");
        await expect(h.executeApprovedHostTask(packet, async () => "replayed")).rejects.toThrow("already_used");
    });
    it.each(["prompt", "system", "messages", "evidence", "images"])("refuses changed %s before host execution", async key => {
        const h = await import("../../src/utils/hostTasks.js"), ask = request();
        const packet = await h.prepareHostTask("prism_infer", ask, ask);
        const changed = h.snapshotHostTask(packet) as any;
        changed.execution[key] = key === "prompt" || key === "system" ? "substituted" : [];
        const execute = vi.fn(); await expect(h.executeApprovedHostTask(changed, execute)).rejects.toThrow("binding_changed");
        expect(execute).not.toHaveBeenCalled();
    });
    it("freezes caller input before asynchronous routing reads", async () => {
        const h = await import("../../src/utils/hostTasks.js"), ask = request();
        const pending = h.prepareHostTask("prism_infer", ask, ask); ask.prompt = "Changed after submission.";
        const packet = await pending; expect(packet.request.prompt).toBe("Explain the supplied routine data.");
    });
    it("refuses changed saved backend/model without spending a valid packet", async () => {
        const h = await import("../../src/utils/hostTasks.js"), ask = request();
        const packet = await h.prepareHostTask("prism_infer", ask, ask);
        settings.model = "another-model";
        await expect(h.executeApprovedHostTask(packet, async () => "bad")).rejects.toThrow("binding_changed");
        expect(readdirSync(join(temp, "host-tasks"))).not.toContain(packet.record.id + ".used");
    });
    it("a query approval cannot authorize a later evidence-bearing draft", async () => {
        const h = await import("../../src/utils/hostTasks.js");
        const query = { question: "Summarize the routine project evidence." };
        const packet = await h.prepareHostTask("query_memory_natural", query, query);
        await h.executeApprovedHostTask(packet, async (kind, input) => {
            h.consumeHostExecution(kind, input);
            expect(h.approvedHostTask("prism_infer", request())).toBeUndefined();
            expect(() => h.consumeHostExecution("prism_infer", request())).toThrow();
        });
    });
    it("rejects a changed account without disclosing its credential or consuming the approval", async () => {
        const h = await import("../../src/utils/hostTasks.js"), ask = request();
        const packet = await h.prepareHostTask("prism_infer", ask, ask);
        settings.account = "synthetic-account-credential";
        await expect(h.executeApprovedHostTask(packet, async () => "bad")).rejects.toThrow("binding_changed");
        expect(JSON.stringify(packet)).not.toContain(settings.account);
        expect(readdirSync(join(temp, "host-tasks"))).not.toContain(packet.record.id + ".used");
    });
    it("a failed execution burns the approval and never authorizes an automatic retry", async () => {
        const h = await import("../../src/utils/hostTasks.js"), ask = request();
        const packet = await h.prepareHostTask("prism_infer", ask, ask);
        await expect(h.executeApprovedHostTask(packet, async (kind) => { h.consumeHostExecution(kind, ask); throw new Error("fixture-failure"); })).rejects.toThrow("fixture-failure");
        await expect(h.executeApprovedHostTask(packet, async () => "retry")).rejects.toThrow("already_used");
    });
});
