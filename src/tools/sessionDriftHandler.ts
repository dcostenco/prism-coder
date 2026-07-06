/**
 * session_detect_drift — MCP Tool Handler
 *
 * Thin-client dispatcher: validates args, delegates to the Synalux portal
 * (POST /api/v1/prism/memory action=detect_drift) which owns the embedding
 * + detection logic, and returns the structured result.
 *
 * Prism-mcp never does NLP or embedding here — that is portal-side.
 */

import { isSessionDetectDriftArgs } from "./sessionMemoryDefinitions.js";
import { getStorage } from "../storage/index.js";
import { debugLog } from "../utils/logger.js";

export async function sessionDetectDriftHandler(
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (!isSessionDetectDriftArgs(args)) {
    return {
      content: [{ type: "text", text: "Invalid arguments for session_detect_drift. Required: project (string), goal (string). Optional: window_hours (number), min_directional_ratio (number)." }],
      isError: true,
    };
  }

  try {
    const storage = await getStorage();

    // SynaluxStorage exposes detectDrift(); SqliteStorage falls through to
    // an error because it has no embedding stack. Free-tier users without
    // portal access receive a clear upgrade message.
    if (typeof (storage as any).detectDrift !== "function") {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "error",
            error: "session_detect_drift requires cloud memory (Standard plan or higher). Set SUPABASE_URL and SUPABASE_KEY to enable.",
            upgrade_url: "/pricing",
          }),
        }],
        isError: true,
      };
    }

    // Build extra params for domain-specific signals
    const extra: Record<string, unknown> = {};
    if (args.domain) extra.domain = args.domain;
    if (args.behavior_functions) extra.behavior_functions = args.behavior_functions;
    if (args.contraindications) extra.contraindications = args.contraindications;
    if (args.client_descriptors) extra.client_descriptors = args.client_descriptors;
    if (args.assessment_type) extra.assessment_type = args.assessment_type;

    const result = await (storage as any).detectDrift(
      args.project,
      args.goal,
      args.window_hours,
      args.min_directional_ratio,
      Object.keys(extra).length > 0 ? extra : undefined,
    );

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    debugLog(`[session_detect_drift] Failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      content: [{ type: "text", text: `Error running drift detection: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}
