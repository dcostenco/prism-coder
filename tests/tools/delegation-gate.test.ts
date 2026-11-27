/**
 * Delegation Gate Tests
 *
 * Verifies local-first default routing and the explicit operator opt-out.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/config.js", async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return {
        ...actual,
        PRISM_TASK_ROUTER_CONFIDENCE_THRESHOLD: 0.6,
        PRISM_TASK_ROUTER_MAX_CLAW_COMPLEXITY: 10,
        PRISM_LOCAL_LLM_ENABLED: true,
    };
});

const mockGetSetting = vi.fn();
const mockGetExperienceBias = vi.fn();
const mockCallLocalLlm = vi.fn();  // now stands in for inferText
const execution = vi.hoisted(() => ({ roles: vi.fn(async () => ({} as Record<string, unknown>)), hosts: vi.fn(async () => [] as any[]) }));
vi.mock("../../src/utils/executionRoles.js", () => ({ readExecutionAssignments: execution.roles, configuredHostProfiles: execution.hosts }));
vi.mock("../../src/storage/configStorage.js", () => ({
    getSetting: (...args: unknown[]) => mockGetSetting(...args),
}));

vi.mock("../../src/storage/index.js", () => ({
    getStorage: vi.fn(async () => ({})),
}));

vi.mock("../../src/utils/keywordExtractor.js", () => ({
    toKeywordArray: vi.fn(() => []),
}));

vi.mock("../../src/tools/routerExperience.js", () => ({
    getExperienceBias: (...args: unknown[]) => mockGetExperienceBias(...args),
}));

// 2026-08-15: the router used to call the low-level localLlm helper directly,
// which skipped the entitlement ceiling, RAM gate, tier walk, quality gate and
// Layer 1. It now goes through inferText -> runInfer like every other model
// call in prism, so the mock moves with it.
vi.mock("../../src/tools/prismInferHandler.js", () => ({
    inferText: (...args: unknown[]) => mockCallLocalLlm(...args),
}));

import { sessionTaskRouteHandler } from "../../src/tools/taskRouterHandler.js";

beforeEach(() => {
    vi.clearAllMocks();
    mockGetExperienceBias.mockResolvedValue({ bias: 0, sampleCount: 0, rationale: "" });
    mockCallLocalLlm.mockResolvedValue(null);
    execution.roles.mockResolvedValue({}); execution.hosts.mockResolvedValue([]);
});

describe("delegation gate", () => {
    it("hands off the exact saved host role without invoking a local tie-breaker", async () => {
        mockGetSetting.mockImplementation(async (_key, value) => value);
        const profile = {id:'a'.repeat(64),provider:'fixture',model:'host-model',effort:'high',status:'configured'};
        execution.roles.mockResolvedValue({coder:{runtime:'host',profile:profile.id}}); execution.hosts.mockResolvedValue([profile]);
        const body = JSON.parse((await sessionTaskRouteHandler({task_description:'Generate a short helper for text formatting.'})).content[0].text);
        expect(body).toMatchObject({target:'host',recommended_tool:null,host_profile:profile});
        expect(mockCallLocalLlm).not.toHaveBeenCalled();
        execution.hosts.mockResolvedValue([]);
        const unavailable = JSON.parse((await sessionTaskRouteHandler({task_description:'Generate a short helper for text formatting.'})).content[0].text);
        expect(unavailable).toMatchObject({target:'host',recommended_tool:null}); expect(unavailable.host_profile).toBeUndefined();
    });
    it("allows local routing when delegation_enabled is not set", async () => {
        mockGetSetting.mockImplementation(async (_key, defaultValue) => defaultValue);

        const result = await sessionTaskRouteHandler({
            task_description: "create a new file with boilerplate",
        });

        const body = JSON.parse(result.content[0].text);
        expect(["claw", "host"]).toContain(body.target);
        expect(body.delegation_enabled).toBeUndefined();
    });

    it("returns host when delegation_enabled is explicitly 'false'", async () => {
        mockGetSetting.mockResolvedValue("false");

        const result = await sessionTaskRouteHandler({
            task_description: "rename a variable",
        });

        const body = JSON.parse(result.content[0].text);
        expect(body.target).toBe("host");
    });

    it("allows routing when delegation_enabled is 'true'", async () => {
        mockGetSetting.mockResolvedValue("true");

        const result = await sessionTaskRouteHandler({
            task_description: "create a new file with boilerplate",
        });

        const body = JSON.parse(result.content[0].text);
        // With delegation on, the router runs its heuristic — result depends on the task
        expect(body.target).toBeDefined();
        expect(["claw", "host"]).toContain(body.target);
        expect(body.delegation_enabled).toBeUndefined(); // only set when gate blocks
    });

    it("getSetting is called with the local-first default", async () => {
        mockGetSetting.mockResolvedValue("false");

        await sessionTaskRouteHandler({
            task_description: "anything",
        });

        expect(mockGetSetting).toHaveBeenCalledWith("delegation_enabled", "true");
    });

    it("does not expose private routing evidence in the MCP payload", async () => {
        mockGetSetting.mockResolvedValue("true");

        const result = await sessionTaskRouteHandler({
            task_description: "fix typo in README, simple change",
            files_involved: ["README.md"],
            estimated_scope: "minor_edit",
        });

        const body = JSON.parse(result.content[0].text);
        expect(body.target).toBe("claw");
        expect(body).not.toHaveProperty("_rawComposite");
        expect(body).not.toHaveProperty("_hardHostBoundary");
        expect(body).not.toHaveProperty("_boundedHighComplexity");
        expect(body).not.toHaveProperty("_minimumComplexity");
    });

    it("preserves the 27B complexity signal through negative experience bias", async () => {
        mockGetSetting.mockResolvedValue("true");
        mockGetExperienceBias.mockResolvedValue({
            bias: -0.3,
            sampleCount: 10,
            rationale: "Past local attempts were mixed.",
        });

        const result = await sessionTaskRouteHandler({
            task_description:
                "Implement a self-contained dynamic programming algorithm from this complete specification with multiple edge cases.",
            files_involved: ["src/solver.ts"],
            estimated_scope: "new_feature",
            project: "prism-mcp",
        });

        const body = JSON.parse(result.content[0].text);
        expect(body.target).toBe("claw");
        expect(body.complexity_score).toBeGreaterThanOrEqual(7);
        expect(body.recommended_args.task_complexity).toBe(body.complexity_score);
    });

    it("never lets positive experience override a hard host boundary", async () => {
        mockGetSetting.mockResolvedValue("true");
        mockGetExperienceBias.mockResolvedValue({
            bias: 0.3,
            sampleCount: 10,
            rationale: "Past local attempts succeeded.",
        });

        const result = await sessionTaskRouteHandler({
            task_description: "Perform a security audit and investigate the authentication vulnerability",
            files_involved: ["src/auth.ts"],
            estimated_scope: "bug_fix",
            project: "prism-mcp",
        });

        const body = JSON.parse(result.content[0].text);
        expect(body.target).toBe("host");
        expect(body.recommended_tool).toBeNull();
        expect(body.recommended_args).toBeUndefined();
    });

    it("uses prism_infer only as a low-confidence delegability review", async () => {
        mockGetSetting.mockResolvedValue("true");
        mockCallLocalLlm.mockResolvedValue("claw");

        const result = await sessionTaskRouteHandler({
            task_description: "work on this isolated code",
        });

        const body = JSON.parse(result.content[0].text);
        expect(mockCallLocalLlm).toHaveBeenCalledOnce();
        expect(body.target).toBe("claw");
        expect(body.complexity_score).toBe(5);
        expect(body.recommended_args.task_complexity).toBe(5);
    });
});
