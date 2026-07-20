/**
 * Contract test — verify_behavior handler MUST return a CallToolResult
 * object ({ content: [{ type: "text", text }] }), NOT a bare string.
 *
 * Regression guard: the handler originally shipped returning Promise<string>,
 * which the MCP SDK rejects at the result-validation boundary
 * ("expected object, received string", -32602). Every sibling tool handler
 * returns { content: [...] }; this one did not, and had zero test coverage,
 * so the contract violation went unnoticed until the tool was first invoked.
 *
 * This test fails against the string-returning bug and passes once the handler
 * wraps its scenario text in a content array. See the dispatch contract in
 * server.ts (result.content usage after the tool switch).
 */

import { describe, it, expect, vi } from "vitest";

// Force the offline/fallback path so the test is deterministic (no portal fetch).
// Spread the real config so unrelated exports keep working.
vi.mock("../src/config.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/config.js")>();
    return { ...actual, SYNALUX_CONFIGURED: false, PRISM_SYNALUX_BASE_URL: "" };
});

import { verifyBehaviorHandler } from "../src/tools/behavioralVerifierHandler.js";

describe("verify_behavior handler contract", () => {
    it("returns a CallToolResult object with a text content array, not a bare string", async () => {
        const result = await verifyBehaviorHandler({
            file_path: "src/app/api/v1/billing/checkout/route.ts",
            change_summary: "regression test",
        });

        // The exact failure the MCP SDK reported: a bare string at the root.
        expect(typeof result).toBe("object");
        expect(typeof result).not.toBe("string");

        // Shape required by server.ts dispatch + MCP CallToolResult schema.
        expect(Array.isArray(result.content)).toBe(true);
        expect(result.content.length).toBeGreaterThan(0);
        expect(result.content[0].type).toBe("text");
        expect(typeof result.content[0].text).toBe("string");
        expect(result.content[0].text.length).toBeGreaterThan(0);
    });
});
