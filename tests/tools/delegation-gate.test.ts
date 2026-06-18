/**
 * Delegation Gate Tests
 *
 * Verifies that session_task_route refuses to delegate when
 * delegation_enabled is not explicitly "true". This enforces
 * the prism-infer-delegation skill's "off by default" rule in code.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/config.js", async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return {
        ...actual,
        PRISM_TASK_ROUTER_CONFIDENCE_THRESHOLD: 0.6,
        PRISM_TASK_ROUTER_MAX_CLAW_COMPLEXITY: 4,
        PRISM_LOCAL_LLM_ENABLED: true,
    };
});

const mockGetSetting = vi.fn();
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
    getExperienceBias: vi.fn(async () => ({ bias: 0, sampleCount: 0, rationale: "" })),
}));

vi.mock("../../src/utils/localLlm.js", () => ({
    callLocalLlm: vi.fn(),
}));

import { sessionTaskRouteHandler } from "../../src/tools/taskRouterHandler.js";

beforeEach(() => {
    vi.clearAllMocks();
});

describe("delegation gate", () => {
    it("returns host when delegation_enabled is not set (default)", async () => {
        mockGetSetting.mockResolvedValue("false");

        const result = await sessionTaskRouteHandler({
            task_description: "create a new file with boilerplate",
        });

        const body = JSON.parse(result.content[0].text);
        expect(body.target).toBe("host");
        expect(body.delegation_enabled).toBe(false);
        expect(body.rationale).toContain("Delegation is off");
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

    it("getSetting is called with 'delegation_enabled' and default 'false'", async () => {
        mockGetSetting.mockResolvedValue("false");

        await sessionTaskRouteHandler({
            task_description: "anything",
        });

        expect(mockGetSetting).toHaveBeenCalledWith("delegation_enabled", "false");
    });
});
