import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferDeps, PrismInferArgs } from "../../src/tools/prismInferHandler.js";
import { FREE_ENTITLEMENTS } from "../../src/utils/entitlements.js";

const state = vi.hoisted(() => ({ memoryReads: 0, roles: {} as Record<string, unknown> }));
vi.mock("../../src/utils/executionRoles.js", () => ({
    readExecutionAssignments: async () => state.roles,
    configuredHostProfiles: async () => [],
}));
vi.mock("../../src/utils/localCodingSettings.js", async importOriginal => ({ ...await importOriginal<any>(),
    readLocalCodingSettings: async () => ({ backend: "omlx", source: "existing", models: { omlx: { coder: "fixture-coder", reviewer: "fixture-reviewer" } } }) }));
vi.mock("../../src/utils/localImageSettings.js", async importOriginal => ({ ...await importOriginal<any>(), readLocalImageSettings: async () => ({}) }));
vi.mock("../../src/storage/index.js", async importOriginal => ({ ...await importOriginal<any>(), getStorage: async () => ({
    loadContext: async () => { state.memoryReads++; return { last_summary: "Frozen routine project context." }; },
}) }));
vi.mock("../../src/utils/inferenceMetrics.js", async importOriginal => ({ ...await importOriginal<any>(), recordInference: vi.fn(), formatInferenceMetrics: () => "" }));
vi.mock("../../src/utils/omlxProvider.js", async importOriginal => ({ ...await importOriginal<any>(),
    withInferenceResourceLease: async (_uses: boolean, work: () => Promise<unknown>) => work(),
    withOllamaResourceLease: async (work: () => Promise<unknown>) => work() }));
let temp: string;
beforeEach(() => {
    vi.resetModules(); temp = mkdtempSync(join(tmpdir(), "prism-host-entrypoint-")); state.memoryReads = 0; state.roles = {};
    vi.stubEnv("PRISM_HOST_TASKS", "required"); vi.stubEnv("PRISM_DATA_DIR", temp); vi.stubEnv("PRISM_CONFIG_PATH", join(temp, "config.db"));
});
afterEach(async () => {
    (await import("../../src/storage/configStorage.js")).closeConfigStorage();
    vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(temp, { recursive: true, force: true });
});
const ask = (): PrismInferArgs => ({ prompt: "Draft a Python identity helper.", mode: "code", local_backend: "omlx", local_model: "fixture-coder",
    cloud_fallback: false, escalation: "report", verify: false });
async function fixture(verdict = "OBVIOUS_NOT_RESERVED") {
    const { createOmlxTarget } = await import("../../src/utils/omlxProvider.js");
    const target = createOmlxTarget("http://127.0.0.1:18000/v1", "fixture-coder", 65536, "synthetic-host-test-key");
    const generate = vi.fn(async () => ({ ok: true as const, text: "def identity(value):\n    return value\n", doneReason: "stop" as const }));
    const deps = { entitlements: { ...FREE_ENTITLEMENTS, plan: "standard", source: "portal", model_ceiling: "27b",
        features: { ...FREE_ENTITLEMENTS.features, cloud_fallback: true } }, freemem: () => 30 * 1024 ** 3,
        ollamaUrl: "http://127.0.0.1:11434", listTags: vi.fn(), listLoaded: vi.fn(), callLocal: vi.fn(), callCloud: vi.fn(),
        omlx: { detect: vi.fn(async () => target), acquire: vi.fn(async () => async () => {}),
            listLoaded: vi.fn(async () => new Set<string>()), unload: vi.fn(async () => {}), generate },
        callLayer1: vi.fn(async () => verdict), classifierInputPolicy: async () => null, secondReadPolicy: async () => null,
    } as unknown as InferDeps;
    return { deps, generate };
}
function body(result: { content: Array<{ text: string }> }) { return JSON.parse(result.content[0]!.text); }

describe("host-authorized inference entrypoints", () => {
    it("ordinary MCP callers only prepare; caller approval flags never generate", async () => {
        const f = await fixture(), { prismInferHandler, runInfer } = await import("../../src/tools/prismInferHandler.js");
        const response = await prismInferHandler({ ...ask(), host_authorized: true, approved: true }, f.deps);
        expect(response.structuredContent?.status).toBe("host_authorization_required");
        expect(f.generate).not.toHaveBeenCalled(); expect(f.deps.callLayer1).not.toHaveBeenCalled();
        const direct = await runInfer(ask(), f.deps);
        expect(direct.gate_outcome?.reason).toBe("host_authorization_required");
        expect(f.deps.callCloud).not.toHaveBeenCalled(); expect(f.deps.listTags).not.toHaveBeenCalled();
    });
    it("trusted bridge backend context cannot authorize a model operation", async () => {
        const f = await fixture(), { prismInferHandler } = await import("../../src/tools/prismInferHandler.js");
        const response = await prismInferHandler(ask(), f.deps, { requiredLocalBackend: "omlx" });
        expect(response.structuredContent?.status).toBe("host_authorization_required");
        expect(f.generate).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
        expect(f.deps.callLayer1).not.toHaveBeenCalled();
    });
    it("the host executes the frozen prepared memory without reading it again", async () => {
        const f = await fixture(), { prismInferHandler } = await import("../../src/tools/prismInferHandler.js");
        const h = await import("../../src/utils/hostTasks.js");
        const response = await prismInferHandler({ ...ask(), project: "fixture-project", context_depth: "standard" }, f.deps);
        expect(state.memoryReads).toBe(1);
        const packet = body(response); expect(packet.host_task.execution.system).toContain("Frozen routine project context.");
        const result = await h.executeApprovedHostTask(packet, async (_kind, input) => prismInferHandler(input, f.deps));
        expect(result.structuredContent?.backend).toBe("omlx"); expect(f.generate).toHaveBeenCalledTimes(1);
        expect(state.memoryReads).toBe(1); expect(f.deps.callCloud).not.toHaveBeenCalled(); expect(f.deps.listTags).not.toHaveBeenCalled();
    });
    it("pins the saved reviewer assignment without replacing it with the coder", async () => {
        const f = await fixture(), { prismInferHandler } = await import("../../src/tools/prismInferHandler.js");
        const response = body(await prismInferHandler({ ...ask(), local_model: undefined, local_role: "reviewer" }, f.deps));
        expect(response.host_task.execution.local_backend).toBe("omlx");
        expect(response.host_task.execution.local_model).toBe("fixture-reviewer"); expect(f.generate).not.toHaveBeenCalled();
    });
    it("pins the new execution-role model instead of the legacy saved model", async () => {
        state.roles = { reviewer: { runtime: "omlx", model: "role-reviewer" } };
        const f = await fixture(), { prismInferHandler } = await import("../../src/tools/prismInferHandler.js");
        const response = body(await prismInferHandler({ ...ask(), local_backend: undefined, local_model: undefined, local_role: "reviewer" }, f.deps));
        expect(response.host_task.execution).toMatchObject({ local_backend: "omlx", local_model: "role-reviewer" });
        expect(f.generate).not.toHaveBeenCalled();
    });
    it.each(["host", "synalux"] as const)("never substitutes a legacy local worker for a %s role", async runtime => {
        state.roles = { coder: runtime === "host" ? { runtime, profile: "a".repeat(64) } : { runtime } };
        const f = await fixture(), { prismInferHandler } = await import("../../src/tools/prismInferHandler.js");
        const response = await prismInferHandler({ ...ask(), local_backend: undefined, local_model: undefined, cloud_fallback: undefined }, f.deps);
        expect(response.isError).toBe(true);
        expect(response.content[0]?.text).toContain("host_task_nonlocal_assignment_requires_host");
        expect(response.structuredContent?.host_task).toBeUndefined();
        expect(f.generate).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it.each(["host", "synalux"] as const)("keeps an explicit local override of a %s role bound to local execution", async runtime => {
        state.roles = { coder: runtime === "host" ? { runtime, profile: "a".repeat(64) } : { runtime } };
        const f = await fixture(), { prismInferHandler } = await import("../../src/tools/prismInferHandler.js");
        const response = body(await prismInferHandler(ask(), f.deps));
        expect(response.host_task.execution).toMatchObject({ local_backend: "omlx", local_model: "fixture-coder" });
        expect(f.generate).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it("matches the approval before adding a restrictive runtime cloud default", async () => {
        const f = await fixture(), { prismInferHandler } = await import("../../src/tools/prismInferHandler.js");
        const h = await import("../../src/utils/hostTasks.js");
        const packet = body(await prismInferHandler({ ...ask(), cloud_fallback: undefined }, f.deps));
        const result = await h.executeApprovedHostTask(packet, async (_kind, input) => prismInferHandler(input, f.deps));
        expect(result.structuredContent?.backend).toBe("omlx");
        expect(f.generate).toHaveBeenCalledTimes(1); expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it("honors the configured backend override before freezing the worker choice", async () => {
        vi.stubEnv("PRISM_LOCAL_CODING_BACKEND", "ollama");
        const f = await fixture(), { prismInferHandler } = await import("../../src/tools/prismInferHandler.js");
        const response = body(await prismInferHandler({ ...ask(), local_backend: undefined }, f.deps));
        expect(response.host_task.execution.local_backend).toBe("ollama");
        expect(response.host_task.execution.local_model).toBe("fixture-coder"); expect(f.generate).not.toHaveBeenCalled();
    });
    it("retains the immediate crisis intercept without requiring an execution approval", async () => {
        const f = await fixture(), { prismInferHandler } = await import("../../src/tools/prismInferHandler.js");
        const response = await prismInferHandler({ ...ask(), prompt: "I might hurt myself tonight." }, f.deps);
        expect(response.structuredContent?.backend).toBe("safety_gate"); expect(f.generate).not.toHaveBeenCalled();
        expect(f.deps.callLayer1).not.toHaveBeenCalled();
    });
    it.each(["OBVIOUS_RESERVED", "UNCERTAIN", "ERROR"])("host approval preserves the %s veto", async verdict => {
        const f = await fixture(verdict), { prismInferHandler } = await import("../../src/tools/prismInferHandler.js");
        const h = await import("../../src/utils/hostTasks.js");
        const packet = body(await prismInferHandler(ask(), f.deps));
        const result = await h.executeApprovedHostTask(packet, async (_kind, input) => prismInferHandler(input, f.deps));
        expect(result.structuredContent?.backend).toBe("refused"); expect(f.generate).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
    });
    it("unapproved web/synthesis requests do no retrieval, classification or inference", async () => {
        const { queryMemoryNaturalHandler } = await import("../../src/tools/queryMemoryNaturalHandler.js");
        const deps = { searchMemory: vi.fn(), searchWeb: vi.fn(), infer: vi.fn(), classifyBoundary: vi.fn(), getEntitlements: vi.fn(), fetchPage: vi.fn() };
        const result = await queryMemoryNaturalHandler({ question: "What changed in the routine helper?" }, deps);
        expect(body(result).status).toBe("host_authorization_required");
        for (const fn of Object.values(deps)) expect(fn).not.toHaveBeenCalled();
    });
    it("query approval prepares a new evidence-bound draft; it cannot generate under the query grant", async () => {
        const f = await fixture(), { prismInferHandler } = await import("../../src/tools/prismInferHandler.js");
        const { queryMemoryNaturalHandler } = await import("../../src/tools/queryMemoryNaturalHandler.js");
        const h = await import("../../src/utils/hostTasks.js");
        const deps = { searchMemory: vi.fn(async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ evidence_snippets: [{ source: "fixture-source", content: "The helper sorts ascending." }] }) }] })),
            infer: vi.fn((args: unknown) => prismInferHandler(args, f.deps)), searchWeb: vi.fn(), classifyBoundary: vi.fn(), getEntitlements: vi.fn(), fetchPage: vi.fn() };
        const query = { question: "What is the routine helper behavior?", web_fallback: false,
            cloud_fallback: false, verify: false, route_guard: "local" as const };
        const first = body(await queryMemoryNaturalHandler(query, deps));
        expect(first.host_task.request).toEqual(query);
        const result = await h.executeApprovedHostTask(first, async (_kind, input) => queryMemoryNaturalHandler(input, deps));
        const second = body(result);
        expect(second.status).toBe("host_authorization_required"); expect(second.host_task.record.kind).toBe("prism_infer");
        expect(second.host_task.execution.system).toContain("The helper sorts ascending.");
        expect(second.host_task.request).toMatchObject({ cloud_fallback: false, verify: false, route_guard: "local" });
        expect(second.host_task.execution).toMatchObject({ cloud_fallback: false, verify: false, route_guard: "local" });
        expect(second.host_task.record.id).not.toBe(first.host_task.record.id);
        expect(f.generate).not.toHaveBeenCalled(); expect(deps.searchMemory).toHaveBeenCalledTimes(1);
        const changed = structuredClone(second);
        changed.host_task.execution.verify = true;
        await expect(h.executeApprovedHostTask(changed, async (_kind, input) => prismInferHandler(input, f.deps))).rejects.toThrow();
        expect(f.generate).not.toHaveBeenCalled();
    });
    it.each(["OBVIOUS_RESERVED", "UNCERTAIN", "ERROR"])("local-only query drafting retains the %s safety veto after both approvals", async verdict => {
        const f = await fixture(verdict), { prismInferHandler } = await import("../../src/tools/prismInferHandler.js");
        const { queryMemoryNaturalHandler } = await import("../../src/tools/queryMemoryNaturalHandler.js");
        const h = await import("../../src/utils/hostTasks.js");
        const deps = { searchMemory: vi.fn(async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ evidence_snippets: [{ source: "fixture-source", content: "The helper sorts ascending." }] }) }] })),
            infer: vi.fn((args: unknown) => prismInferHandler(args, f.deps)), searchWeb: vi.fn(), classifyBoundary: vi.fn(), getEntitlements: vi.fn(), fetchPage: vi.fn() };
        const first = body(await queryMemoryNaturalHandler({ question: "What is the routine helper behavior?", web_fallback: false,
            cloud_fallback: false, verify: false, route_guard: "local" }, deps));
        const second = body(await h.executeApprovedHostTask(first, async (_kind, input) => queryMemoryNaturalHandler(input, deps)));
        const result = await h.executeApprovedHostTask(second, async (_kind, input) => prismInferHandler(input, f.deps));
        expect(result.structuredContent?.backend).toBe("refused");
        expect(f.generate).not.toHaveBeenCalled(); expect(f.deps.callCloud).not.toHaveBeenCalled();
        expect(deps.searchWeb).not.toHaveBeenCalled();
    });
    it("local retrieval without synthesis or web keeps its existing behavior", async () => {
        const { queryMemoryNaturalHandler } = await import("../../src/tools/queryMemoryNaturalHandler.js");
        const deps = { searchMemory: vi.fn(async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ evidence_snippets: [{ source: "fixture", content: "Routine evidence." }] }) }] })),
            infer: vi.fn(), searchWeb: vi.fn(), classifyBoundary: vi.fn(), getEntitlements: vi.fn(), fetchPage: vi.fn() };
        const result = body(await queryMemoryNaturalHandler({ question: "Show routine evidence.", synthesize: false, web_fallback: false }, deps));
        expect(result.status).toBe("ok"); expect(result.retrieval).toBe("memory"); expect(deps.infer).not.toHaveBeenCalled();
    });
});
