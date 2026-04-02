import { type Tool } from "@modelcontextprotocol/sdk/types.js";

// ─── session_start_pipeline ─────────────────────────────────

export const SESSION_START_PIPELINE_TOOL: Tool = {
  name: "session_start_pipeline",
  description:
    "Start an autonomous Dark Factory pipeline. The pipeline runs in the background " +
    "and executes a PLAN → EXECUTE → VERIFY cycle up to `max_iterations` times.\n\n" +
    "**Requires:** `PRISM_DARK_FACTORY_ENABLED=true` in the environment.\n\n" +
    "**How it works:**\n" +
    "1. Call this tool with an objective (what to accomplish)\n" +
    "2. The pipeline is queued and executes autonomously in the background\n" +
    "3. Use `session_check_pipeline_status` to poll for results\n\n" +
    "**Safety:**\n" +
    "- Pipelines are scoped to a `working_directory` — no filesystem escape\n" +
    "- Strict iteration cap (default: 3) prevents infinite loops\n" +
    "- Wall-clock timeout (default: 15min) prevents runaway execution\n" +
    "- All operations are logged to the session ledger for audit",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project identifier. Required for scoping and audit.",
      },
      objective: {
        type: "string",
        description:
          "What the pipeline should accomplish. Be specific — this becomes the LLM's system prompt objective.",
      },
      working_directory: {
        type: "string",
        description:
          "Absolute path to the working directory. The pipeline can only modify " +
          "files within this directory. Defaults to the project's repo_path if configured.",
      },
      max_iterations: {
        type: "number",
        description:
          "Maximum PLAN→EXECUTE→VERIFY loop iterations (default: 3, max: 10). " +
          "Each iteration is one complete cycle. Most tasks complete in 1-2 iterations.",
      },
      context_files: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional list of specific files to focus on. Paths are relative " +
          "to the working directory.",
      },
      model_override: {
        type: "string",
        description:
          "Optional model name to use instead of the default LLM. " +
          "Useful for routing to a local model (e.g., 'qwen3') via Claw.",
      },
    },
    required: ["project", "objective"],
  },
};

// ─── session_check_pipeline_status ──────────────────────────

export const SESSION_CHECK_PIPELINE_STATUS_TOOL: Tool = {
  name: "session_check_pipeline_status",
  description:
    "Check the status of a Dark Factory pipeline. Returns the current step, " +
    "iteration count, and any error messages.\n\n" +
    "**Statuses:**\n" +
    "- `PENDING` — Queued, waiting for runner pickup\n" +
    "- `RUNNING` — Currently executing a step\n" +
    "- `COMPLETED` — Successfully finished all steps\n" +
    "- `FAILED` — Encountered an error or exceeded limits\n" +
    "- `ABORTED` — Manually cancelled",
  inputSchema: {
    type: "object",
    properties: {
      pipeline_id: {
        type: "string",
        description: "The pipeline ID returned by `session_start_pipeline`.",
      },
      project: {
        type: "string",
        description: "Optional project filter. If omitted, searches across all projects.",
      },
    },
    required: ["pipeline_id"],
  },
};

// ─── session_abort_pipeline ─────────────────────────────────

export const SESSION_ABORT_PIPELINE_TOOL: Tool = {
  name: "session_abort_pipeline",
  description:
    "Abort a running Dark Factory pipeline. The pipeline will be marked as ABORTED " +
    "and the background runner will stop processing it on the next tick.\n\n" +
    "**Note:** This is a 'kill switch' — the runner detects the status change via " +
    "the storage status guard and gracefully stops execution.",
  inputSchema: {
    type: "object",
    properties: {
      pipeline_id: {
        type: "string",
        description: "The pipeline ID to abort.",
      },
    },
    required: ["pipeline_id"],
  },
};

// ─── Type Guards ────────────────────────────────────────────

export interface StartPipelineArgs {
  project: string;
  objective: string;
  working_directory?: string;
  max_iterations?: number;
  context_files?: string[];
  model_override?: string;
}

export function isStartPipelineArgs(args: unknown): args is StartPipelineArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.project !== "string" || !a.project.trim()) return false;
  if (typeof a.objective !== "string" || !a.objective.trim()) return false;
  if (a.working_directory !== undefined && typeof a.working_directory !== "string") return false;
  if (a.max_iterations !== undefined && (typeof a.max_iterations !== "number" || a.max_iterations < 1 || a.max_iterations > 10)) return false;
  if (a.context_files !== undefined && (!Array.isArray(a.context_files) || !a.context_files.every((f: unknown) => typeof f === "string"))) return false;
  if (a.model_override !== undefined && typeof a.model_override !== "string") return false;
  return true;
}

export interface CheckPipelineStatusArgs {
  pipeline_id: string;
  project?: string;
}

export function isCheckPipelineStatusArgs(args: unknown): args is CheckPipelineStatusArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.pipeline_id !== "string" || !a.pipeline_id.trim()) return false;
  if (a.project !== undefined && typeof a.project !== "string") return false;
  return true;
}

export interface AbortPipelineArgs {
  pipeline_id: string;
}

export function isAbortPipelineArgs(args: unknown): args is AbortPipelineArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.pipeline_id !== "string" || !a.pipeline_id.trim()) return false;
  return true;
}
