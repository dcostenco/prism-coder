import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const observed = vi.hoisted(() => ({ provider: vi.fn(() => { throw new Error("provider must not be entered"); }) }));
vi.mock("../../src/utils/llm/factory.js", () => ({ getLLMProvider: observed.provider }));
beforeEach(() => { vi.resetModules(); vi.stubEnv("PRISM_HOST_TASKS", "required"); observed.provider.mockClear(); });
afterEach(() => vi.unstubAllEnvs());
describe("host task caller boundaries", () => {
    it("automatic routing retains bounded work in the host instead of starting an incompatible pipeline", async () => {
        const { routeFactoryPrompt } = await import("../../src/darkfactory/promptRouting.js");
        const result = routeFactoryPrompt("Fix helper.ts and run tests.", { enabled: true, project: "fixture", working_directory: "/fixture", files_involved: ["helper.ts"], test_command: "node --test helper.test.ts" });
        expect(result.target).toBe("host"); expect(result.recommended_tool).toBeNull(); expect(result.reason).toContain("Host-authorized");
    });
    it("direct pipeline creation refuses before persisting any work", async () => {
        const { sessionStartPipelineHandler } = await import("../../src/tools/pipelineHandlers.js");
        const result = await sessionStartPipelineHandler({ project: "fixture", objective: "Routine helper task.", working_directory: "/fixture" });
        expect(result.isError).toBe(true); expect(result.content[0]?.text).toContain("host_authorization_required");
    });
    it("previously queued autonomous steps cannot invoke a model in this mode", async () => {
        const { invokeClawAgent } = await import("../../src/darkfactory/clawInvocation.js");
        const result = await invokeClawAgent({} as any, {} as any);
        expect(result.success).toBe(false); expect(result.resultText).toContain("host_authorization_required"); expect(observed.provider).not.toHaveBeenCalled();
    });
    it("internal inference cannot turn required host authorization into backend-unavailable fallback", async () => {
        const { inferText } = await import("../../src/tools/prismInferHandler.js");
        await expect(inferText("Summarize the routine supplied data.")).rejects.toThrow("host_authorization_required");
    });
});
