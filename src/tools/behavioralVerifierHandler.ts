/**
 * Behavioral Verifier — thin client to Synalux portal API.
 *
 * Calls POST /api/v1/prism/verify-behavior with the file path
 * and returns a domain-specific scenario the agent must answer
 * before editing the file.
 *
 * Works without hooks — the skill injection tells the agent to
 * call this tool before behavioral edits.
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

export async function verifyBehaviorHandler(
    args: VerifyBehaviorArgs,
): Promise<string> {
    if (!SYNALUX_CONFIGURED || !PRISM_SYNALUX_BASE_URL) {
        return formatResult({
            requires_verification: false,
            reason: "Synalux portal not configured — behavioral verification unavailable. Proceed with caution.",
        });
    }

    const jwt = await getSynaluxJwt();
    if (!jwt) {
        return formatResult({
            requires_verification: false,
            reason: "Could not authenticate with Synalux portal — behavioral verification unavailable.",
        });
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
            debugLog(`[verify-behavior] portal returned ${res.status}`);
            return formatResult({
                requires_verification: false,
                reason: `Portal returned ${res.status} — verification unavailable.`,
            });
        }

        const data = (await res.json()) as VerifyBehaviorResult;
        return formatResult(data);
    } catch (err) {
        debugLog(`[verify-behavior] error: ${(err as Error).message}`);
        return formatResult({
            requires_verification: false,
            reason: "Portal unreachable — verification unavailable.",
        });
    }
}

function formatResult(data: VerifyBehaviorResult): string {
    if (!data.requires_verification) {
        return JSON.stringify({ requires_verification: false, reason: data.reason || "non-behavioral file" });
    }

    return [
        `⚠️ BEHAVIORAL VERIFICATION REQUIRED`,
        `Domain: ${data.domain}`,
        `File: ${data.scenario ? "" : "(no scenario matched)"}`,
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
