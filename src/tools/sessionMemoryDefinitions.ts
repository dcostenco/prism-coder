import { type Tool } from "@modelcontextprotocol/sdk/types.js";

// ─── Session Save Ledger ─────────────────────────────────────

export const SESSION_SAVE_LEDGER_TOOL: Tool = {
  name: "session_save_ledger",
  description:
    "Save an immutable session log entry to the session ledger. " +
    "Use this at the END of each work session to record what was accomplished. " +
    "The ledger is append-only — entries cannot be updated or deleted. " +
    "This creates a permanent audit trail of all agent work sessions.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project identifier (e.g. 'bcba-private', 'my-app'). Used to group and filter sessions.",
      },
      conversation_id: {
        type: "string",
        description: "Unique conversation/session identifier.",
      },
      summary: {
        type: "string",
        description: "Brief summary of what was accomplished in this session.",
      },
      todos: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of open TODO items remaining after this session.",
      },
      files_changed: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of files created or modified during this session.",
      },
      decisions: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of key decisions made during this session.",
      },
    },
    required: ["project", "conversation_id", "summary"],
  },
};

// ─── Session Save Handoff ─────────────────────────────────────

export const SESSION_SAVE_HANDOFF_TOOL: Tool = {
  name: "session_save_handoff",
  description:
    "Upsert the latest project handoff state for the next session to consume on boot. " +
    "This is the 'live context' that gets loaded when a new session starts. " +
    "Calling this replaces the previous handoff for the same project (upsert on project).",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project identifier — must match the project used in session_save_ledger.",
      },
      open_todos: {
        type: "array",
        items: { type: "string" },
        description: "Current open TODO items that need attention in the next session.",
      },
      active_branch: {
        type: "string",
        description: "Git branch or context the next session should resume on.",
      },
      last_summary: {
        type: "string",
        description: "Summary of the most recent session — used for quick context recovery.",
      },
      key_context: {
        type: "string",
        description: "Free-form critical context the next session needs to know.",
      },
    },
    required: ["project"],
  },
};

// ─── Session Load Context ─────────────────────────────────────

export const SESSION_LOAD_CONTEXT_TOOL: Tool = {
  name: "session_load_context",
  description:
    "Load session context for a project using progressive context loading. " +
    "Use this at the START of a new session to recover previous work state. " +
    "Three levels available:\n" +
    "- **quick**: Just the latest project state — keywords and open TODOs (~50 tokens)\n" +
    "- **standard**: Project state plus recent session summaries and decisions (~200 tokens, recommended)\n" +
    "- **deep**: Everything — full session history with all files changed, TODOs, and decisions (~1000+ tokens)",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project identifier to load context for.",
      },
      level: {
        type: "string",
        enum: ["quick", "standard", "deep"],
        description: "How much context to load: 'quick' (just TODOs), 'standard' (recommended — includes recent summaries), or 'deep' (full history). Default: standard.",
      },
    },
    required: ["project"],
  },
};

// ─── Type Guards ──────────────────────────────────────────────

export function isSessionSaveLedgerArgs(
  args: unknown
): args is {
  project: string;
  conversation_id: string;
  summary: string;
  todos?: string[];
  files_changed?: string[];
  decisions?: string[];
} {
  return (
    typeof args === "object" &&
    args !== null &&
    "project" in args &&
    typeof (args as { project: string }).project === "string" &&
    "conversation_id" in args &&
    typeof (args as { conversation_id: string }).conversation_id === "string" &&
    "summary" in args &&
    typeof (args as { summary: string }).summary === "string"
  );
}

export function isSessionSaveHandoffArgs(
  args: unknown
): args is {
  project: string;
  open_todos?: string[];
  active_branch?: string;
  last_summary?: string;
  key_context?: string;
} {
  return (
    typeof args === "object" &&
    args !== null &&
    "project" in args &&
    typeof (args as { project: string }).project === "string"
  );
}

export function isSessionLoadContextArgs(
  args: unknown
): args is { project: string; level?: "quick" | "standard" | "deep" } {
  return (
    typeof args === "object" &&
    args !== null &&
    "project" in args &&
    typeof (args as { project: string }).project === "string"
  );
}
