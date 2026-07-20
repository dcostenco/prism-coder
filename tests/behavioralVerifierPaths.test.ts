/**
 * verify_behavior — full path coverage.
 *
 * Companion to behavioralVerifierContract.test.ts (which pins the offline/no-config
 * path). This file mocks the portal ONLINE and exercises every branch of the handler:
 * a real portal scenario, the "not behavioral" short-circuit, and each fail-closed
 * branch (no JWT, non-200, network throw). The invariant under test across ALL of them
 * is the one the original bug broke: the handler must return a CallToolResult object
 * ({ content: [{ type: "text", text }] }), never a bare string, and — because this is a
 * SAFETY gate — must FAIL CLOSED (return a verification scenario) whenever the portal
 * can't be reached, never an empty or skipped result.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock factories are hoisted above module top-level, so shared values they
// reference must come from vi.hoisted (also hoisted, evaluated first).
const { PORTAL, getSynaluxJwt } = vi.hoisted(() => ({
    PORTAL: "https://portal.test",
    getSynaluxJwt: vi.fn(async (): Promise<string | null> => "jwt-abc"),
}));

// Portal configured/online for this whole file.
vi.mock("../src/config.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/config.js")>();
    return { ...actual, SYNALUX_CONFIGURED: true, PRISM_SYNALUX_BASE_URL: PORTAL };
});

// JWT exchange is a separate unit; default to a valid token, override per test.
vi.mock("../src/utils/synaluxJwt.js", () => ({
    getSynaluxJwt,
    invalidateSynaluxJwt: vi.fn(),
}));

import { verifyBehaviorHandler } from "../src/tools/behavioralVerifierHandler.js";

const ARGS = {
    file_path: "src/app/api/v1/billing/checkout/route.ts",
    change_summary: "add discount",
    workspace_id: "ws_123",
};

/** Every return, on every path, must satisfy the CallToolResult contract. */
function expectToolResult(result: Awaited<ReturnType<typeof verifyBehaviorHandler>>): string {
    expect(typeof result).toBe("object");
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0].type).toBe("text");
    expect(typeof result.content[0].text).toBe("string");
    expect(result.content[0].text.length).toBeGreaterThan(0);
    return result.content[0].text;
}

function jsonResponse(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
    getSynaluxJwt.mockResolvedValue("jwt-abc");
    vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("verify_behavior — online success paths", () => {
    it("requires_verification:true → formatted scenario in a content object", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, {
            requires_verification: true,
            domain: "billing",
            scenario: "What happens to an in-flight cart when the discount changes?",
            rules: ["Verify workspace ownership", "Do not drop the delivery fee"],
        })));

        const text = expectToolResult(await verifyBehaviorHandler(ARGS));
        expect(text).toContain("BEHAVIORAL VERIFICATION REQUIRED");
        expect(text).toContain("Domain: billing");
        expect(text).toContain("in-flight cart");
        expect(text).toContain("1. Verify workspace ownership");
        expect(text).toContain("2. Do not drop the delivery fee");
    });

    it("requires_verification:false → non-behavioral JSON in a content object", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, {
            requires_verification: false,
            reason: "pure formatting change",
        })));

        const text = expectToolResult(await verifyBehaviorHandler(ARGS));
        const parsed = JSON.parse(text);
        expect(parsed.requires_verification).toBe(false);
        expect(parsed.reason).toBe("pure formatting change");
    });

    it("forwards file_path, change_summary, workspace_id and the Bearer JWT to the portal", async () => {
        const fetchMock = vi.fn(async () => jsonResponse(200, { requires_verification: false }));
        vi.stubGlobal("fetch", fetchMock);

        await verifyBehaviorHandler(ARGS);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${PORTAL}/api/v1/prism/verify-behavior`);
        expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer jwt-abc");
        expect(JSON.parse(init.body as string)).toEqual({
            file_path: ARGS.file_path,
            change_summary: ARGS.change_summary,
            workspace_id: ARGS.workspace_id,
        });
    });
});

describe("verify_behavior — fail-closed branches (safety gate must never skip)", () => {
    it("no JWT → generic scenario, and the portal is NOT called", async () => {
        getSynaluxJwt.mockResolvedValue(null);
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const text = expectToolResult(await verifyBehaviorHandler(ARGS));
        expect(text).toContain("OFFLINE MODE");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("portal returns non-200 → generic scenario (fail-closed, not skipped)", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, {})));

        const text = expectToolResult(await verifyBehaviorHandler(ARGS));
        expect(text).toContain("OFFLINE MODE");
    });

    it("fetch throws (network / timeout) → generic scenario (fail-closed)", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ETIMEDOUT"); }));

        const text = expectToolResult(await verifyBehaviorHandler(ARGS));
        expect(text).toContain("OFFLINE MODE");
    });

    it("malformed portal JSON (missing requires_verification) → treated as non-behavioral, still an object", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { unexpected: "shape" })));

        const text = expectToolResult(await verifyBehaviorHandler(ARGS));
        const parsed = JSON.parse(text);
        expect(parsed.requires_verification).toBe(false);
    });
});
