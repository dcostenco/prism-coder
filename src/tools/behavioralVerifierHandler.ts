/**
 * Behavioral Verifier — thin client to Synalux portal API.
 *
 * Calls POST /api/v1/prism/verify-behavior with the file path
 * and returns a domain-specific scenario the agent must answer
 * before editing the file.
 *
 * FAIL-CLOSED: if the portal is unreachable, returns a generic
 * verification challenge rather than skipping verification.
 */

import { PRISM_SYNALUX_BASE_URL, SYNALUX_CONFIGURED } from "../config.js";
import { getSynaluxJwt } from "../utils/synaluxJwt.js";
import { debugLog } from "../utils/logger.js";

interface VerifyBehaviorArgs {
    file_path: string;
    change_summary: string;
    project?: string;
    workspace_id?: string;
}

interface VerifyBehaviorResult {
    requires_verification: boolean;
    domain?: string;
    scenario?: string;
    rules?: string[];
    reason?: string;
}

const FALLBACK_SCENARIO = [
    "⚠️ BEHAVIORAL VERIFICATION (OFFLINE MODE)",
    "",
    "Portal unreachable — using generic verification.",
    "Before editing this file, answer ALL of these:",
    "",
    "1. What does the end user experience BEFORE vs AFTER this change?",
    "2. Does this endpoint verify the caller owns/belongs-to the resource?",
    "3. Can a user from workspace A access workspace B's data by guessing an ID?",
    "4. If this is a revert, was the original change actually correct?",
    "",
    "Answer concretely. If you cannot, READ THE FILE FIRST.",
].join("\n");

/**
 * MCP tool entrypoint. Every tool handler MUST return a CallToolResult
 * object ({ content: [{ type: "text", text }] }) — returning a bare string
 * makes the MCP SDK reject the result ("expected object, received string",
 * -32602). See the dispatch contract in server.ts (result.content usage).
 */
export async function verifyBehaviorHandler(
    args: VerifyBehaviorArgs,
): Promise<{ content: { type: "text"; text: string }[] }> {
    return { content: [{ type: "text", text: await buildScenarioText(args) }] };
}

async function buildScenarioText(
    args: VerifyBehaviorArgs,
): Promise<string> {
    if (!SYNALUX_CONFIGURED || !PRISM_SYNALUX_BASE_URL) {
        return FALLBACK_SCENARIO;
    }

    const jwt = await getSynaluxJwt();
    if (!jwt) {
        console.error("[verify-behavior] ⚠️ JWT unavailable — fail-closed with generic scenario");
        return FALLBACK_SCENARIO;
    }

    try {
        const url = `${PRISM_SYNALUX_BASE_URL}/api/v1/prism/verify-behavior`;
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${jwt}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                file_path: args.file_path,
                change_summary: args.change_summary,
                workspace_id: args.workspace_id,
            }),
            signal: AbortSignal.timeout(5_000),
        });

        if (!res.ok) {
            console.error(`[verify-behavior] ⚠️ portal returned ${res.status} — fail-closed. URL: ${url}`);
            return FALLBACK_SCENARIO;
        }

        const data = (await res.json()) as VerifyBehaviorResult;
        return formatResult(data);
    } catch (err) {
        console.error(`[verify-behavior] ⚠️ VERIFICATION FAILED: ${(err as Error).message} — using generic fallback`);
        return FALLBACK_SCENARIO;
    }
}

function formatResult(data: VerifyBehaviorResult): string {
    if (!data.requires_verification) {
        return JSON.stringify({ requires_verification: false, reason: data.reason || "non-behavioral file" });
    }

    return [
        `⚠️ BEHAVIORAL VERIFICATION REQUIRED`,
        `Domain: ${data.domain}`,
        ``,
        `Before making this edit, answer this scenario:`,
        ``,
        data.scenario || "(generic) Describe what the end user experiences BEFORE vs AFTER this change.",
        ``,
        `RULES:`,
        ...(data.rules || []).map((r, i) => `${i + 1}. ${r}`),
        ``,
        `Answer the scenario in your next message before proceeding with the edit.`,
    ].join("\n");
}
