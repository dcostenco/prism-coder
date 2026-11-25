/**
 * session_set_program_register — MCP tool handler (drift-fix slice D-2a).
 *
 * Writes a program's lanes to the account's register on the Synalux portal: the lanes that decide
 * which work is stalled. It is the only writer until the dashboard (D-3). The portal records every
 * state change as a tool edit ("unconfirmed") until the owner confirms it there, and never removes
 * a lane. Prism only validates the shape and shows the portal's read-back.
 */
import { isSetProgramRegisterArgs } from "./sessionMemoryDefinitions.js";
import { getStorage } from "../storage/index.js";
import { debugLog } from "../utils/logger.js";
import { cleanBlock } from "../session/laneStatus.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export async function sessionSetProgramRegisterHandler(args: unknown): Promise<ToolResult> {
  if (!isSetProgramRegisterArgs(args)) {
    return {
      content: [{ type: "text", text: "Invalid arguments for session_set_program_register. Required: project (string), program (1-24 letters, digits or hyphens), lanes (array of {id, ...}; at least one)." }],
      isError: true,
    };
  }
  try {
    const storage = await getStorage();
    if (typeof (storage as { setProgramRegister?: unknown }).setProgramRegister !== "function") {
      return {
        content: [{ type: "text", text: "session_set_program_register needs the Synalux cloud memory (Standard plan or higher)." }],
        isError: true,
      };
    }
    const result = await (storage as unknown as {
      setProgramRegister(project: string, program: string, lanes: unknown[], conversationId?: string): Promise<Record<string, unknown>>;
    }).setProgramRegister(args.project, args.program, args.lanes, args.conversation_id);
    const block = typeof result.lane_block === "string" ? cleanBlock(result.lane_block) : "";
    const version = typeof result.version === "number" ? result.version : null;
    const head = `Register ${result.changed === true ? "saved" : "unchanged"} for ${cleanBlock(args.program, 24)}${version === null ? "" : ` (v${version})`}.`;
    return { content: [{ type: "text", text: [head, block].filter(Boolean).join("\n") }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debugLog(`[session_set_program_register] Failed: ${message}`);
    // An older portal answers an unknown action with 400: say what to do, not just that it failed.
    const old = /\/api\/v1\/prism\/memory failed: (Invalid action|HTTP 400)/.test(message)
      ? " The portal may be older than this tool (it has no program register yet); update the portal, or keep using the lane list in the plan."
      : "";
    return { content: [{ type: "text", text: `Error saving the program register: ${cleanBlock(message, 300)}.${old}` }], isError: true };
  }
}
