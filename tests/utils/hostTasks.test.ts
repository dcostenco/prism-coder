import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { pbkdf2 } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_TASK_TTL_MS } from "../../src/utils/hostTaskRecords.js";
vi.mock("node:crypto", async importOriginal => {
    const crypto = await importOriginal<typeof import("node:crypto")>();
    return { ...crypto, pbkdf2: vi.fn(crypto.pbkdf2) };
});
const settings = vi.hoisted(() => ({ backend: "omlx", model: "fixture-coder", account: "" }));
const execution = vi.hoisted(() => ({ roles: {} as Record<string, unknown>, profiles: [] as unknown[] }));
vi.mock("../../src/utils/executionRoles.js", () => ({
    readExecutionAssignments: async () => execution.roles,
    configuredHostProfiles: async () => execution.profiles,
}));
vi.mock("../../src/storage/configStorage.js", async importOriginal => ({ ...await importOriginal<any>(),
    getSetting: async (key: string, fallback: unknown) => key === "PRISM_SYNALUX_API_KEY" ? settings.account : fallback }));
vi.mock("../../src/utils/localCodingSettings.js", () => ({ readLocalCodingSettings: async () => ({ backend: settings.backend, source: "existing", model: settings.model }) }));
vi.mock("../../src/utils/localImageSettings.js", () => ({ readLocalImageSettings: async () => ({}) }));
let temp: string;
beforeEach(() => {
    vi.resetModules(); temp = mkdtempSync(join(tmpdir(), "prism-host-task-"));
    vi.stubEnv("PRISM_HOST_TASKS", "required"); vi.stubEnv("PRISM_DATA_DIR", temp); vi.stubEnv("PRISM_CONFIG_PATH", join(temp, "config.db"));
    settings.backend = "omlx"; settings.model = "fixture-coder"; settings.account = "";
    execution.roles = {}; execution.profiles = [];
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
    it.each(["roles", "profiles"] as const)("refuses changed %s without spending a prepared approval", async field => {
        const h = await import("../../src/utils/hostTasks.js"), ask = request();
        const packet = await h.prepareHostTask("prism_infer", ask, ask);
        if (field === "roles") execution.roles = { reviewer: { runtime: "omlx", model: "different-model" } };
        else execution.profiles = [{ id: "different-profile", model: "different-model" }];
        const execute = vi.fn();
        await expect(h.executeApprovedHostTask(packet, execute)).rejects.toThrow("binding_changed");
        expect(execute).not.toHaveBeenCalled();
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
        settings.account = "synthetic-original-credential";
        const packet = await h.prepareHostTask("prism_infer", ask, ask);
        expect(JSON.stringify(packet)).not.toContain(settings.account);
        settings.account = "synthetic-account-credential";
        await expect(h.executeApprovedHostTask(packet, async () => "bad")).rejects.toThrow("binding_changed");
        expect(readdirSync(join(temp, "host-tasks"))).not.toContain(packet.record.id + ".used");
    });
    it("salts each environment binding and verifies it after loading the host module anew", async () => {
        const h = await import("../../src/utils/hostTasks.js"), ask = request();
        const first = await h.prepareHostTask("prism_infer", ask, ask);
        const second = await h.prepareHostTask("prism_infer", ask, ask);
        expect(first.record.id).not.toBe(second.record.id);
        expect(first.record.environment_sha256).not.toBe(second.record.environment_sha256);

        vi.resetModules();
        const host = await import("../../src/utils/hostTasks.js");
        const wrong = { ...first, record: { ...first.record, environment_sha256: second.record.environment_sha256 } };
        const execute = vi.fn(async () => "accepted");
        await expect(host.executeApprovedHostTask(wrong, execute)).rejects.toThrow("host_task_record_invalid");
        expect(execute).not.toHaveBeenCalled();
        await expect(host.executeApprovedHostTask(first, execute)).resolves.toBe("accepted");
    });
    it.each([256, 255])("bounds derivation when %i host tasks are already pending", async pending => {
        const h = await import("../../src/utils/hostTasks.js"), ask = request();
        const directory = join(temp, "host-tasks");
        const now = Date.now();
        mkdirSync(directory, { mode: 0o700 });
        for (let number = 0; number < pending; number++) {
            const id = number.toString(16).padStart(48, "0");
            const record = { version: 1, id, kind: "prism_infer", request_sha256: "a".repeat(64),
                task_sha256: "b".repeat(64), environment_sha256: "c".repeat(64),
                created_at: now, expires_at: now + HOST_TASK_TTL_MS };
            writeFileSync(join(directory, id + ".json"), JSON.stringify(record), { mode: 0o600 });
        }
        vi.mocked(pbkdf2).mockClear();
        const remaining = 256 - pending;
        const attempts = Array.from({ length: remaining + 1 }, () => h.prepareHostTask("prism_infer", ask, ask));
        const results = await Promise.allSettled(attempts);
        expect(results.filter(outcome => outcome.status === "fulfilled")).toHaveLength(remaining);
        expect(results.at(-1)).toMatchObject({ status: "rejected", reason: new Error("host_task_pending_limit") });
        expect(pbkdf2).toHaveBeenCalledTimes(remaining);
    });
    it.each(["expired", "spent", "absent"] as const)("rejects a %s record before deriving the environment proof", async state => {
        const h = await import("../../src/utils/hostTasks.js"), ask = request();
        const packet = await h.prepareHostTask("prism_infer", ask, ask);
        if (state === "expired") vi.spyOn(Date, "now").mockReturnValue(packet.record.expires_at);
        if (state === "spent") await h.executeApprovedHostTask(packet, async () => "first-use");
        if (state === "absent") unlinkSync(join(temp, "host-tasks", packet.record.id + ".json"));
        vi.mocked(pbkdf2).mockClear();
        const execute = vi.fn();
        const failure = { expired: "host_task_expired", spent: "host_task_already_used", absent: "host_task_binding_changed" };
        await expect(h.executeApprovedHostTask(packet, execute)).rejects.toThrow(failure[state]);
        expect(pbkdf2).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
    });
    it("a failed execution burns the approval and never authorizes an automatic retry", async () => {
        const h = await import("../../src/utils/hostTasks.js"), ask = request();
        const packet = await h.prepareHostTask("prism_infer", ask, ask);
        await expect(h.executeApprovedHostTask(packet, async (kind) => { h.consumeHostExecution(kind, ask); throw new Error("fixture-failure"); })).rejects.toThrow("fixture-failure");
        await expect(h.executeApprovedHostTask(packet, async () => "retry")).rejects.toThrow("already_used");
    });
});
