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
      role: {
        type: "string",
        description: "Optional. Agent role for Hivemind scoping (e.g., 'dev', 'qa', 'pm'). Omit to let the server auto-resolve from dashboard settings.",
      },
    },
    required: ["project", "conversation_id", "summary"],
  },
};

// ─── Session Save Handoff ─────────────────────────────────────
// REVIEWER NOTE: v0.4.0 adds expected_version for Optimistic Concurrency
// Control (OCC). See Enhancement #5 in the implementation plan.
//
// UPGRADE PATH: The expected_version field is optional so v0.3.0
// clients still work without changes. When omitted, the version
// check is skipped entirely (backward compatible).

export const SESSION_SAVE_HANDOFF_TOOL: Tool = {
  name: "session_save_handoff",
  description:
    "Upsert the latest project handoff state for the next session to consume on boot. " +
    "This is the 'live context' that gets loaded when a new session starts. " +
    "Calling this replaces the previous handoff for the same project (upsert on project).\n\n" +
    "**v5.4 CRDT Merge**: On version conflict, a CRDT OR-Map engine automatically merges " +
    "your changes with concurrent work (Add-Wins OR-Set for arrays, Last-Writer-Wins for scalars). " +
    "Pass expected_version to enable concurrency control.\n\n" +
    "**v0.4.0 OCC**: If you received a version number from session_load_context, " +
    "/resume_session prompt, or memory resource attachment, you MUST pass it as " +
    "expected_version to prevent overwriting another session's changes.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project identifier — must match the project used in session_save_ledger.",
      },
      expected_version: {
        type: "integer",
        description:
          "v0.4.0: The version number you received when loading context. " +
          "Pass this to enable optimistic concurrency control. " +
          "If omitted, version check is skipped (backward compatible).",
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
      role: {
        type: "string",
        description: "Optional. Agent role for Hivemind scoping (e.g., 'dev', 'qa', 'pm'). Omit to let the server auto-resolve from dashboard settings.",
      },
      disable_merge: {
        type: "boolean",
        description: "Set to true to disable automatic CRDT merging and fail strictly on version conflict (original OCC behavior). Default: false.",
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
      role: {
        type: "string",
        description: "Optional. Agent role for Hivemind scoping (e.g., 'dev', 'qa', 'pm'). Omit to let the server auto-resolve from dashboard settings. When set, also injects active_team roster.",
      },
      // v4.0: Token Budget
      max_tokens: {
        type: "integer",
        description: "Maximum token budget for context response. Uses 1 token ≈ 4 chars heuristic. When set, the response is truncated to fit within the budget. Default: unlimited.",
      },
      toolAction: {
        type: "string",
        description: "Brief 2-5 word summary of what this tool is doing. Capitalize like a sentence.",
      },
      toolSummary: {
        type: "string",
        description: "Brief 2-5 word noun phrase describing what this tool call is about.",
      },
    },
    required: ["project", "toolAction", "toolSummary"],
  },
};

// ─── Knowledge Search ─────────────────────────────────────────
// Phase 1 Change: Added `enable_trace` optional boolean.
// When true, the handler returns a separate content[1] block with a
// MemoryTrace object (strategy="keyword", latency, result metadata).
// Default: false — output is identical to pre-Phase 1 behavior.

export const KNOWLEDGE_SEARCH_TOOL: Tool = {
  name: "knowledge_search",
  description:
    "Search accumulated knowledge across all sessions by keywords, category, or free text. " +
    "The knowledge base grows automatically as sessions are saved — keywords are extracted " +
    "from every ledger and handoff entry. Use this to find related past work, decisions, " +
    "and context from previous sessions.\n\n" +
    "Categories available: debugging, architecture, deployment, testing, configuration, " +
    "api-integration, data-migration, security, performance, documentation, ai-ml, " +
    "ui-frontend, resume",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Optional project filter. If omitted, searches across all projects.",
      },
      query: {
        type: "string",
        description: "Free-text search query. Searched against session summaries using full-text search.",
      },
      category: {
        type: "string",
        description: "Optional category filter (e.g. 'debugging', 'architecture', 'ai-ml'). " +
          "Filters results to sessions in this category.",
      },
      limit: {
        type: "integer",
        description: "Maximum results to return (default: 10, max: 50).",
        default: 10,
      },
      // Phase 1: Explainability — when true, appends a MemoryTrace JSON
      // object as content[1] in the response array.
      // MCP clients can parse content[1] programmatically for debugging.
      enable_trace: {
        type: "boolean",
        description: "If true, returns a separate MEMORY TRACE content block with search strategy, " +
          "latency breakdown, and scoring metadata for explainability. Default: false.",
      },
      activation: {
        type: "object",
        description: "Configuration for ACT-R inspired Spreading Activation. Use this to find structurally related memories beyond direct semantic/keyword hits.",
        properties: {
          enabled: { type: "boolean", description: "Enable spreading activation (default: false)." },
          iterations: { type: "integer", description: "Number of propagation loops (default: 3)." },
          spreadFactor: { type: "number", description: "Decay multiplier per step (default: 0.8)." },
          lateralInhibition: { type: "integer", description: "Maximum nodes returned (default: 7)." },
        }
      },
    },
    required: ["query"],
  },
};

// ─── Knowledge Forget ─────────────────────────────────────────

export const KNOWLEDGE_FORGET_TOOL: Tool = {
  name: "knowledge_forget",
  description:
    "Selectively forget (delete) accumulated knowledge entries. " +
    "Like a brain pruning bad memories — remove outdated, incorrect, or irrelevant " +
    "session entries to keep the knowledge base clean and relevant.\n\n" +
    "Forget modes:\n" +
    "- **By project**: Clear all knowledge for a specific project\n" +
    "- **By category**: Remove entries matching a category (e.g. 'debugging')\n" +
    "- **By age**: Forget entries older than N days\n" +
    "- **Full reset**: Wipe everything (requires confirm_all=true)\n\n" +
    "⚠️ This permanently deletes ledger entries. Handoff state is preserved unless explicitly cleared.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project to forget entries for. Required unless using confirm_all.",
      },
      category: {
        type: "string",
        description: "Optional: only forget entries in this category (e.g. 'debugging', 'resume').",
      },
      older_than_days: {
        type: "integer",
        description: "Optional: only forget entries older than this many days.",
      },
      clear_handoff: {
        type: "boolean",
        description: "Also clear the handoff (live state) for this project. Default: false.",
      },
      confirm_all: {
        type: "boolean",
        description: "Set to true to confirm wiping ALL entries for the project (safety flag).",
      },
      dry_run: {
        type: "boolean",
        description: "If true, only count what would be deleted without actually deleting. Default: false.",
      },
    },
  },
};

// ─── v0.4.0: Session Compact Ledger (Enhancement #2) ─────────
// REVIEWER NOTE: This tool triggers Gemini-powered summarization
// of old ledger entries into rollup records. See compactionHandler.ts
// for the implementation and migration 017 for the DB schema.

export const SESSION_COMPACT_LEDGER_TOOL: Tool = {
  name: "session_compact_ledger",
  description:
    "Auto-compact old session ledger entries by rolling them up into AI-generated summaries. " +
    "This prevents the ledger from growing indefinitely and keeps deep context loading fast.\n\n" +
    "How it works:\n" +
    "1. Finds projects with more entries than the threshold\n" +
    "2. Summarizes old entries using Gemini (keeps recent entries intact)\n" +
    "3. Inserts a rollup entry and archives the originals (soft-delete)\n\n" +
    "Use dry_run=true to preview what would be compacted without executing.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Optional: compact a specific project. If omitted, auto-detects all candidates.",
      },
      threshold: {
        type: "integer",
        description: "Minimum entries before compaction triggers (default: 50).",
        default: 50,
      },
      keep_recent: {
        type: "integer",
        description: "Number of recent entries to keep intact (default: 10).",
        default: 10,
      },
      dry_run: {
        type: "boolean",
        description: "If true, only preview what would be compacted without executing. Default: false.",
      },
    },
  },
};

// REVIEWER NOTE: Guard intentionally placed directly after the tool definition
// it covers. All four optional fields (project, threshold, keep_recent, dry_run)
// are validated — an LLM passing {threshold: "many"} now fails the guard instead
// of reaching the handler as a string.
export function isSessionCompactLedgerArgs(
  args: unknown
): args is {
  project?: string;
  threshold?: number;
  keep_recent?: number;
  dry_run?: boolean;
} {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (a.project !== undefined && typeof a.project !== "string") return false;
  if (a.threshold !== undefined && typeof a.threshold !== "number") return false;
  if (a.keep_recent !== undefined && typeof a.keep_recent !== "number") return false;
  if (a.dry_run !== undefined && typeof a.dry_run !== "boolean") return false;
  return true;
}

// ─── v0.4.0: Session Search Memory (Enhancement #4) ──────────
// REVIEWER NOTE: This tool uses pgvector embeddings for semantic
// (meaning-based) search. Unlike knowledge_search which uses keyword
// overlap, this finds results by meaning similarity.
//
// Example where this beats keyword search:
//   Query: "that weird API key error we fixed"
//   Match: "Resolved authentication failure by rotating credentials"
//   → Keyword search: MISS (no shared words)
//   → Semantic search: HIT (meaning overlap is high)

export const SESSION_SEARCH_MEMORY_TOOL: Tool = {
  name: "session_search_memory",
  description:
    "Search session history semantically (by meaning, not just keywords). " +
    "Uses vector embeddings to find sessions with similar context, even when " +
    "the exact wording differs. Requires pgvector extension in Supabase.\n\n" +
    "Complements knowledge_search (keyword-based) — use this when keyword " +
    "search returns no results or when the query is phrased differently " +
    "from stored summaries.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural language search query describing what you're looking for.",
      },
      project: {
        type: "string",
        description: "Optional: limit search to a specific project.",
      },
      limit: {
        type: "integer",
        description: "Maximum results to return (default: 5, max: 20).",
        default: 5,
      },
      similarity_threshold: {
        type: "number",
        description: "Minimum similarity score 0-1 (default: 0.7). Higher = more relevant, fewer results.",
        default: 0.7,
      },
      // Phase 1: Explainability — when true, appends a MemoryTrace JSON
      // object as content[1] in the response array. For semantic search,
      // the trace includes embedding_ms (Gemini API time) vs storage_ms
      // (pgvector query time) to pinpoint performance bottlenecks.
      enable_trace: {
        type: "boolean",
        description: "If true, returns a separate MEMORY TRACE content block with search strategy, " +
          "latency breakdown (embedding vs storage), and scoring metadata. Default: false.",
      },
      // v5.2: Context-Weighted Retrieval — biases search toward active work context
      context_boost: {
        type: "boolean",
        description: "If true, appends current project and working context to the search query " +
          "before embedding generation, naturally biasing results toward contextually relevant memories. " +
          "Useful when searching within a specific project context. Default: false.",
      },
      activation: {
        type: "object",
        description: "Configuration for ACT-R inspired Spreading Activation. Use this to find structurally related memories beyond direct semantic/keyword hits.",
        properties: {
          enabled: { type: "boolean", description: "Enable spreading activation (default: false)." },
          iterations: { type: "integer", description: "Number of propagation loops (default: 3)." },
          spreadFactor: { type: "number", description: "Decay multiplier per step (default: 0.8)." },
          lateralInhibition: { type: "integer", description: "Maximum nodes returned (default: 7)." },
        }
      },
    },
    required: ["query"],
  },
};

// ─── v1.5.0: Session Backfill Embeddings (Edge Case B Fix) ────
// REVIEWER NOTE: If the Gemini API was temporarily down when a ledger
// entry was saved, the fire-and-forget embedding catch() fires and
// the row is saved without an embedding. This tool scans for those
// orphaned rows and batch-generates the missing embeddings.

export const SESSION_BACKFILL_EMBEDDINGS_TOOL: Tool = {
  name: "session_backfill_embeddings",
  description:
    "Repair ledger entries that are missing vector embeddings. " +
    "This can happen if the Gemini API was temporarily unavailable when the entry was saved.\n\n" +
    "How it works:\n" +
    "1. Scans for active ledger entries where embedding IS NULL\n" +
    "2. Generates embeddings via Gemini text-embedding-004\n" +
    "3. Patches each row with the generated embedding\n\n" +
    "Run this periodically or after known API outages to ensure full semantic search coverage.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Optional: repair only a specific project. If omitted, repairs all projects.",
      },
      limit: {
        type: "integer",
        description: "Maximum entries to repair in one call (default: 20, max: 50). Keeps API costs predictable.",
        default: 20,
      },
      dry_run: {
        type: "boolean",
        description: "If true, only count missing embeddings without generating them. Default: false.",
      },
    },
  },
};

// ─── v6.0 Phase 3: Backfill Links Tool ───────────────────────

export const SESSION_BACKFILL_LINKS_TOOL: Tool = {
  name: "session_backfill_links",
  description:
    "Retroactively create graph edges (memory links) for all existing entries in a project. " +
    "This builds the associative memory graph from your existing session history.\n\n" +
    "Three strategies are run:\n" +
    "1. **Temporal Chaining**: Links consecutive entries within the same conversation\n" +
    "2. **Keyword Overlap**: Links entries sharing ≥3 keywords (bidirectional)\n" +
    "3. **Provenance**: Links rollup summaries to their archived originals\n\n" +
    "All strategies use INSERT OR IGNORE — safe to re-run multiple times.\n\n" +
    "**When to use:** Run once after upgrading to v6.0 to populate the graph for existing memories. " +
    "New entries are auto-linked on save (no manual action needed).",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project to backfill links for. Required.",
      },
    },
    required: ["project"],
  },
};

// ─── Type Guards ──────────────────────────────────────────────

export function isKnowledgeForgetArgs(
  args: unknown
): args is {
  project?: string;
  category?: string;
  older_than_days?: number;
  clear_handoff?: boolean;
  confirm_all?: boolean;
  dry_run?: boolean;
} {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (a.project !== undefined && typeof a.project !== "string") return false;
  if (a.category !== undefined && typeof a.category !== "string") return false;
  if (a.older_than_days !== undefined && typeof a.older_than_days !== "number") return false;
  if (a.clear_handoff !== undefined && typeof a.clear_handoff !== "boolean") return false;
  if (a.confirm_all !== undefined && typeof a.confirm_all !== "boolean") return false;
  if (a.dry_run !== undefined && typeof a.dry_run !== "boolean") return false;
  return true;
}

// Phase 1: Added enable_trace to the type guard.
// Optional boolean — when true, the handler returns a MemoryTrace content block.
// Default: false, so existing callers see no change in behavior.
export function isKnowledgeSearchArgs(
  args: unknown
): args is {
  project?: string;
  query: string;
  category?: string;
  limit?: number;
  enable_trace?: boolean;  // Phase 1: Explainability flag
} {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.query !== "string") return false;
  if (a.project !== undefined && typeof a.project !== "string") return false;
  if (a.category !== undefined && typeof a.category !== "string") return false;
  if (a.limit !== undefined && typeof a.limit !== "number") return false;
  if (a.enable_trace !== undefined && typeof a.enable_trace !== "boolean") return false;
  if (a.activation !== undefined && typeof a.activation !== "object") return false;
  return true;
}

export function isSessionSaveLedgerArgs(
  args: unknown
): args is {
  project: string;
  conversation_id: string;
  summary: string;
  todos?: string[];
  files_changed?: string[];
  decisions?: string[];
  role?: string;  // v3.0: Hivemind
} {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  // Required fields
  if (typeof a.project !== "string") return false;
  if (typeof a.conversation_id !== "string") return false;
  if (typeof a.summary !== "string") return false;
  // Optional array fields — guard against LLM passing a string instead of string[] and check elements
  if (a.todos !== undefined && (!Array.isArray(a.todos) || !a.todos.every(t => typeof t === "string"))) return false;
  if (a.files_changed !== undefined && (!Array.isArray(a.files_changed) || !a.files_changed.every(t => typeof t === "string"))) return false;
  if (a.decisions !== undefined && (!Array.isArray(a.decisions) || !a.decisions.every(t => typeof t === "string"))) return false;
  if (a.role !== undefined && typeof a.role !== "string") return false;
  return true;
}

// REVIEWER NOTE: v0.4.0 adds expected_version to the type guard
// for optimistic concurrency control. It's optional for backward compat.
// v5.4: Added disable_merge for CRDT bypass.
export function isSessionSaveHandoffArgs(
  args: unknown
): args is {
  project: string;
  expected_version?: number;
  open_todos?: string[];
  active_branch?: string;
  last_summary?: string;
  key_context?: string;
  role?: string;  // v3.0: Hivemind
  disable_merge?: boolean;  // v5.4: CRDT bypass
} {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.project !== "string") return false;
  if (a.expected_version !== undefined && typeof a.expected_version !== "number") return false;
  if (a.open_todos !== undefined && (!Array.isArray(a.open_todos) || !a.open_todos.every(t => typeof t === "string"))) return false;
  if (a.active_branch !== undefined && typeof a.active_branch !== "string") return false;
  if (a.last_summary !== undefined && typeof a.last_summary !== "string") return false;
  if (a.key_context !== undefined && typeof a.key_context !== "string") return false;
  if (a.role !== undefined && typeof a.role !== "string") return false;
  if (a.disable_merge !== undefined && typeof a.disable_merge !== "boolean") return false;
  return true;
}

// ─── v0.4.0: Type guard for semantic search ──────────────────
// Phase 1: Added enable_trace to the type guard.
// Optional boolean — when true, a MemoryTrace block (with embedding_ms,
// storage_ms, top_score, etc.) is appended as content[1] in the response.
export function isSessionSearchMemoryArgs(
  args: unknown
): args is {
  query: string;
  project?: string;
  limit?: number;
  similarity_threshold?: number;
  enable_trace?: boolean;  // Phase 1: Explainability flag
  context_boost?: boolean; // v5.2: Context-Weighted Retrieval
} {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.query !== "string") return false;
  if (a.project !== undefined && typeof a.project !== "string") return false;
  if (a.limit !== undefined && typeof a.limit !== "number") return false;
  if (a.similarity_threshold !== undefined && typeof a.similarity_threshold !== "number") return false;
  if (a.enable_trace !== undefined && typeof a.enable_trace !== "boolean") return false;
  if (a.context_boost !== undefined && typeof a.context_boost !== "boolean") return false;
  if (a.activation !== undefined && typeof a.activation !== "object") return false;
  return true;
}

// ─── v1.5.0: Type guard for backfill embeddings ──────────────
export function isBackfillEmbeddingsArgs(
  args: unknown
): args is {
  project?: string;
  limit?: number;
  dry_run?: boolean;
} {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (a.project !== undefined && typeof a.project !== "string") return false;
  if (a.limit !== undefined && typeof a.limit !== "number") return false;
  if (a.dry_run !== undefined && typeof a.dry_run !== "boolean") return false;
  return true;
}

export function isBackfillLinksArgs(
  args: unknown
): args is { project: string } {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.project !== "string") return false;
  return true;
}

export function isSessionLoadContextArgs(
  args: unknown
): args is { project: string; level?: "quick" | "standard" | "deep"; role?: string; max_tokens?: number; toolAction?: string; toolSummary?: string } {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.project !== "string") return false;
  if (a.level !== undefined && a.level !== "quick" && a.level !== "standard" && a.level !== "deep") return false;
  if (a.role !== undefined && typeof a.role !== "string") return false;
  if (a.max_tokens !== undefined && typeof a.max_tokens !== "number") return false;
  if (a.toolAction !== undefined && typeof a.toolAction !== "string") return false;
  if (a.toolSummary !== undefined && typeof a.toolSummary !== "string") return false;
  return true;
}

// ─── v2.0: Time Travel Tool Definitions ──────────────────────


export const MEMORY_HISTORY_TOOL: Tool = {
  name: "memory_history",
  description:
    "View the timeline of past memory states for this project. " +
    "Use this BEFORE memory_checkout to find the correct version to revert to. " +
    "Shows version numbers, timestamps, and summaries of each saved state.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project identifier to view history for.",
      },
      limit: {
        type: "number",
        description: "Maximum number of history entries to return (default: 10, max: 50).",
        default: 10,
      },
    },
    required: ["project"],
  },
};

export const MEMORY_CHECKOUT_TOOL: Tool = {
  name: "memory_checkout",
  description:
    "Time travel! Restores the project's memory to a specific past version. " +
    "This overwrites the current handoff state with the historical snapshot, " +
    "like a Git revert — the version number moves forward (no data is lost). " +
    "Call memory_history first to find the correct target_version.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project identifier to revert.",
      },
      target_version: {
        type: "number",
        description: "The version number to restore from history (get this from memory_history).",
      },
    },
    required: ["project", "target_version"],
  },
};

// ─── v2.0: Time Travel Type Guards ───────────────────────────

export function isMemoryHistoryArgs(
  args: unknown
): args is { project: string; limit?: number } {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.project !== "string") return false;
  if (a.limit !== undefined && typeof a.limit !== "number") return false;
  return true;
}

export function isMemoryCheckoutArgs(
  args: unknown
): args is { project: string; target_version: number } {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.project !== "string") return false;
  if (typeof a.target_version !== "number") return false;
  return true;
}

// ─── v2.0: Visual Memory Tool Definitions ────────────────────

export const SESSION_SAVE_IMAGE_TOOL: Tool = {
  name: "session_save_image",
  description:
    "Save a local image file into the project's permanent visual memory. " +
    "Use this to remember UI states, diagrams, architecture graphs, or bug screenshots. " +
    "The image is copied into Prism's media vault and indexed in the handoff metadata. " +
    "On the next session_load_context, the agent will see a lightweight index of available images.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project identifier — must match an existing project.",
      },
      file_path: {
        type: "string",
        description: "Absolute or relative path to the image file (png, jpg, jpeg, webp, gif, svg).",
      },
      description: {
        type: "string",
        description: "What does this image show? Used for indexing and context display.",
      },
    },
    required: ["project", "file_path", "description"],
  },
};

export const SESSION_VIEW_IMAGE_TOOL: Tool = {
  name: "session_view_image",
  description:
    "Retrieve an image from visual memory using its ID. " +
    "Returns the image as Base64 inline content for the LLM to analyze. " +
    "Use session_load_context first to see available image IDs.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project identifier.",
      },
      image_id: {
        type: "string",
        description: "The short image ID (e.g., '8f2a1b3c') from the visual memory index.",
      },
    },
    required: ["project", "image_id"],
  },
};

// ─── v2.0: Visual Memory Type Guards ─────────────────────────

export function isSessionSaveImageArgs(
  args: unknown
): args is { project: string; file_path: string; description: string } {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.project !== "string") return false;
  if (typeof a.file_path !== "string") return false;
  if (typeof a.description !== "string") return false;
  return true;
}

export function isSessionViewImageArgs(
  args: unknown
): args is { project: string; image_id: string } {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.project !== "string") return false;
  if (typeof a.image_id !== "string") return false;
  return true;
}

// ─── v2.2.0: Health Check (fsck) Tool Definition ─────────────

/**
 * MCP tool definition for the brain integrity checker.
 * Inspired by Mnemory's health check + Unix fsck.
 * Absorbs session_backfill_embeddings when auto_fix is true.
 */
export const SESSION_HEALTH_CHECK_TOOL: Tool = {
  name: "session_health_check",
  description:
    "Run integrity checks on the agent's memory (like fsck for filesystems). " +
    "Scans for missing embeddings, duplicate entries, orphaned handoffs, and stale rollups.\n\n" +
    "Checks performed:\n" +
    "1. **Missing embeddings** — entries that can't be found via semantic search\n" +
    "2. **Duplicate entries** — near-identical summaries wasting context tokens\n" +
    "3. **Orphaned handoffs** — handoff state with no backing ledger entries\n" +
    "4. **Stale rollups** — compaction artifacts with no archived originals\n\n" +
    "Use auto_fix=true to automatically repair missing embeddings and clean up orphans.",
  inputSchema: {
    type: "object",
    properties: {
      auto_fix: {
        type: "boolean",
        description:
          "If true, automatically repair issues (backfill embeddings, remove orphaned handoffs). Default: false.",
      },
    },
  },
};

/**
 * Type guard for session_health_check arguments.
 * Only optional auto_fix boolean — no required fields.
 */
export function isSessionHealthCheckArgs(
  args: unknown
): args is { auto_fix?: boolean } {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (a.auto_fix !== undefined && typeof a.auto_fix !== "boolean") return false;
  return true;
}

// ─── Phase 2: GDPR-Compliant Memory Deletion Tool ────────────
//
// This tool enables SURGICAL deletion of individual memory entries by ID.
// It supports two modes:
//   1. Soft Delete (default): Sets deleted_at = NOW(). The entry remains
//      in the database for audit trails but is excluded from ALL search
//      queries (both FTS5 and vector). This prevents the Top-K Hole
//      problem where LIMIT N queries return fewer results than expected.
//   2. Hard Delete: Physical removal from the database. Irreversible.
//      Use only when GDPR Article 17 requires complete erasure.
//
// DESIGN DECISION: This is intentionally separate from knowledge_forget,
// which operates on bulk filter criteria (project, category, age).
// session_forget_memory is surgical — one entry at a time — for
// precise GDPR compliance.

export const SESSION_FORGET_MEMORY_TOOL: Tool = {
  name: "session_forget_memory",
  description:
    "Forget (delete) a specific memory entry by its ID. " +
    "Supports two modes:\n\n" +
    "- **Soft delete** (default): Tombstones the entry — it stays in the database " +
    "for audit trails but is excluded from all search results. Reversible.\n" +
    "- **Hard delete**: Permanently removes the entry from the database. Irreversible. " +
    "Use only when GDPR Article 17 requires complete erasure.\n\n" +
    "⚠️ Soft delete is recommended for most use cases. The entry can be " +
    "restored in the future if needed.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description:
          "The UUID of the memory (ledger) entry to forget. " +
          "You can find this ID in search results returned by " +
          "session_search_memory or knowledge_search.",
      },
      hard_delete: {
        type: "boolean",
        description:
          "If true, permanently removes the entry (irreversible). " +
          "If false (default), soft-deletes by setting deleted_at timestamp. " +
          "Soft-deleted entries are excluded from searches but remain in the database.",
      },
      reason: {
        type: "string",
        description:
          "Optional GDPR Article 17 justification for the deletion. " +
          "Examples: 'User requested', 'Data retention policy', 'Outdated information'. " +
          "Stored alongside the tombstone for audit trail purposes.",
      },
    },
    required: ["memory_id"],
  },
};

/**
 * Type guard for session_forget_memory arguments.
 * Validates that memory_id (required) is present and is a string.
 * hard_delete and reason are optional.
 */
export function isSessionForgetMemoryArgs(
  args: unknown
): args is { memory_id: string; hard_delete?: boolean; reason?: string } {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.memory_id !== "string") return false;
  if (a.hard_delete !== undefined && typeof a.hard_delete !== "boolean") return false;
  if (a.reason !== undefined && typeof a.reason !== "string") return false;
  return true;
}

// ─── Phase 2: GDPR Export Tool ─────────────────────────────────────────
//
// Complements session_forget_memory (surgical deletion) with a full data
// portability export. Fulfills GDPR Article 20 (Right to Data Portability).
// API keys are always redacted from the exported settings object.

export const SESSION_EXPORT_MEMORY_TOOL: Tool = {
  name: "session_export_memory",
  description:
    "Export all of a project's memory to a local file. " +
    "Fulfills GDPR Article 20 (Right to Data Portability) and the " +
    "'local-first' portability promise.\n\n" +
    "**What is exported:**\n" +
    "- All session ledger entries (summaries, decisions, TODOs, file changes)\n" +
    "- Current handoff state (live project context)\n" +
    "- System settings (API keys are \"**REDACTED**\" for security)\n" +
    "- Visual memory index (descriptions, captions, timestamps; not the raw files)\n\n" +
    "**Formats:**\n" +
    "- `json` — machine-readable, suitable for import into another Prism instance\n" +
    "- `markdown` — human-readable, ideal for static archiving\n" +
    "- `vault` — Prism-Port: exports a compressed `.zip` of interrelated Markdown files with proper Obsidian/Logseq YAML frontmatter and `[[Wikilinks]]`\n\n" +
    "⚠️ Output directory must exist and be writable. " +
    "Filenames are auto-generated: `prism-export-<project>-<date>.(json|md|zip)`",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description:
          "Project to export. If omitted, exports ALL projects into separate files.",
      },
      format: {
        type: "string",
        enum: ["json", "markdown", "vault"],
        description: "Export format: 'json', 'markdown', or 'vault' (Obsidian .zip). Default: json.",
        default: "json",
      },
      output_dir: {
        type: "string",
        description:
          "Absolute path to the directory where the export file(s) will be written. " +
          "Must exist and be writable. Example: '/Users/admin/Desktop'.",
      },
    },
    required: ["output_dir"],
  },
};

/**
 * Type guard for session_export_memory arguments.
 * output_dir is required (must be an absolute path).
 * project and format are optional.
 */
export function isSessionExportMemoryArgs(
  args: unknown
): args is { project?: string; format?: "json" | "markdown" | "vault"; output_dir: string } {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  // Required
  if (typeof a.output_dir !== "string") return false;
  // Optional — validate types and enum membership
  if (a.project !== undefined && typeof a.project !== "string") return false;
  if (
    a.format !== undefined &&
    a.format !== "json" &&
    a.format !== "markdown" &&
    a.format !== "vault"
  ) return false;
  return true;
}

// ─── v3.1: Knowledge Set Retention (TTL) ─────────────────────

export const KNOWLEDGE_SET_RETENTION_TOOL: Tool = {
  name: "knowledge_set_retention",
  description:
    "Set an automatic data retention policy (TTL) for a project's memory. " +
    "Entries older than ttl_days will be soft-deleted (archived) automatically " +
    "on every server startup and every 12 hours while running.\n\n" +
    "**Use cases:**\n" +
    "- Set `ttl_days: 90` to auto-expire sessions older than 3 months\n" +
    "- Set `ttl_days: 0` to disable auto-expiry (default)\n\n" +
    "**Note:** Rollup/compaction entries are never expired — only raw sessions.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project to set retention policy for.",
      },
      ttl_days: {
        type: "integer",
        description:
          "Entries older than this many days are auto-expired. " +
          "Set to 0 to disable. Minimum: 7 days when enabled.",
        minimum: 0,
      },
    },
    required: ["project", "ttl_days"],
  },
};

export function isKnowledgeSetRetentionArgs(
  args: unknown
): args is { project: string; ttl_days: number } {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.project !== "string") return false;
  if (typeof a.ttl_days !== "number") return false;
  return true;
}

// ─── v4.0: Active Behavioral Memory Tools ────────────────────

export const SESSION_SAVE_EXPERIENCE_TOOL: Tool = {
  name: "session_save_experience",
  description:
    "Record a typed experience event. Unlike session_save_ledger (flat logs), " +
    "this captures structured behavioral data for pattern detection.\n\n" +
    "Event Types:\n" +
    "- **correction**: Agent was corrected by user\n" +
    "- **success**: Task completed successfully\n" +
    "- **failure**: Task failed\n" +
    "- **learning**: New knowledge acquired\n" +
    "- **validation_result**: Verification sandbox passed or failed",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project identifier.",
      },
      event_type: {
        type: "string",
        enum: ["correction", "success", "failure", "learning", "validation_result"],
        description: "Type of behavioral event.",
      },
      context: {
        type: "string",
        description: "What the agent was doing when the event occurred.",
      },
      action: {
        type: "string",
        description: "What action was tried.",
      },
      outcome: {
        type: "string",
        description: "What happened as a result.",
      },
      correction: {
        type: "string",
        description: "What should have been done instead (for correction type).",
      },
      confidence_score: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Agent's confidence in the outcome (1-100).",
      },
      role: {
        type: "string",
        description: "Optional. Agent role for Hivemind scoping. Omit to let the server auto-resolve from dashboard settings.",
      },
    },
    required: ["project", "event_type", "context", "action", "outcome"],
  },
};

export function isSessionSaveExperienceArgs(
  args: unknown
): args is {
  project: string;
  event_type: "correction" | "success" | "failure" | "learning" | "validation_result";
  context: string;
  action: string;
  outcome: string;
  correction?: string;
  confidence_score?: number;
  role?: string;
} {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.project !== "string") return false;
  if (
    typeof a.event_type !== "string" ||
    (a.event_type !== "correction" &&
      a.event_type !== "success" &&
      a.event_type !== "failure" &&
      a.event_type !== "learning" &&
      a.event_type !== "validation_result")
  ) return false;
  if (typeof a.context !== "string") return false;
  if (typeof a.action !== "string") return false;
  if (typeof a.outcome !== "string") return false;
  if (a.correction !== undefined && typeof a.correction !== "string") return false;
  if (a.confidence_score !== undefined && typeof a.confidence_score !== "number") return false;
  if (a.role !== undefined && typeof a.role !== "string") return false;
  return true;
}

export const KNOWLEDGE_UPVOTE_TOOL: Tool = {
  name: "knowledge_upvote",
  description:
    "Upvote a memory entry to increase its importance (graduation). " +
    "Entries with importance >= 7 become 'graduated' insights that always " +
    "surface in behavioral warnings.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The UUID of the ledger entry to upvote.",
      },
    },
    required: ["id"],
  },
};

export const KNOWLEDGE_DOWNVOTE_TOOL: Tool = {
  name: "knowledge_downvote",
  description:
    "Downvote a memory entry to decrease its importance. " +
    "Importance cannot go below 0.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The UUID of the ledger entry to downvote.",
      },
    },
    required: ["id"],
  },
};

export function isKnowledgeVoteArgs(
  args: unknown
): args is { id: string } {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.id !== "string") return false;
  return true;
}

// ─── v4.2: Knowledge Sync Rules Tool ─────────────────────────

export const KNOWLEDGE_SYNC_RULES_TOOL: Tool = {
  name: "knowledge_sync_rules",
  description:
    "Auto-sync graduated insights (importance >= 7) into your project's IDE rules file " +
    "(.cursorrules or .clauderules). This bridges behavioral memory with static IDE context — " +
    "turning dynamic agent learnings into always-on rules.\n\n" +
    "**How it works:**\n" +
    "1. Fetches graduated insights from the ledger\n" +
    "2. Formats them as markdown rules inside sentinel markers\n" +
    "3. Idempotently writes them into the target file at the project's configured repo_path\n\n" +
    "**Requirements:** The project must have a repo_path configured in the dashboard.\n\n" +
    "**Idempotency:** Uses `<!-- PRISM:AUTO-RULES:START -->` / `<!-- PRISM:AUTO-RULES:END -->` " +
    "sentinel markers. Running this tool multiple times produces the same file. " +
    "User-maintained content outside the sentinels is never touched.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project identifier. Must have a repo_path configured in the dashboard.",
      },
      target_file: {
        type: "string",
        description:
          "Target rules filename (default: '.cursorrules'). " +
          "Common values: '.cursorrules', '.clauderules'.",
      },
      dry_run: {
        type: "boolean",
        description: "If true, returns a preview of the rules block without writing to disk. Default: false.",
      },
    },
    required: ["project"],
  },
};

export function isKnowledgeSyncRulesArgs(
  args: unknown
): args is { project: string; target_file?: string; dry_run?: boolean } {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.project !== "string") return false;
  if (a.target_file !== undefined && typeof a.target_file !== "string") return false;
  if (a.dry_run !== undefined && typeof a.dry_run !== "boolean") return false;
  return true;
}

// ─── v5.1: Deep Storage Mode (The Purge) ──────────────────────
//
// REVIEWER NOTE: This tool is the storage optimization follow-up to v5.0's
// TurboQuant integration. Now that compressed blobs provide Tier-2 search,
// the original float32 embeddings (3KB each) for OLD entries are redundant.
//
// DESIGN DECISIONS:
//   - dry_run defaults to false (consistent with session_compact_ledger)
//   - older_than_days defaults to 30 and has a minimum of 7 (enforced at storage layer)
//   - project is optional: omit to purge across all projects
//   - No required fields — tool works with zero args (purges all projects, 30+ day old entries)
//
// SAFETY NET:
//   - Storage layer throws if olderThanDays < 7
//   - Only entries with BOTH embedding AND embedding_compressed are eligible
//   - Multi-tenant user_id guard is injected by the handler (not user-facing)

export const DEEP_STORAGE_PURGE_TOOL: Tool = {
  name: "deep_storage_purge",
  description:
    "v5.1 Deep Storage Mode: Purge high-precision float32 embedding vectors for entries " +
    "that already have TurboQuant compressed blobs, reclaiming ~90% of vector storage. " +
    "Only affects entries older than the specified threshold (default: 30 days, minimum: 7). " +
    "Entries without compressed blobs are NEVER touched. " +
    "Use dry_run=true to preview the impact before executing.\n\n" +
    "**When to use:** After running TurboQuant backfill (session_backfill_embeddings), " +
    "call this tool to reclaim disk space from legacy float32 vectors that are no longer " +
    "needed for search.\n\n" +
    "**Safety:** Tier-2 search (TurboQuant) maintains 95%+ accuracy with compressed blobs. " +
    "Tier-3 (FTS5 keyword) search is completely unaffected.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description:
          "Optional project filter. When omitted, purges across all projects.",
      },
      older_than_days: {
        type: "integer",
        description:
          "Only purge entries older than this many days. " +
          "Default: 30. Minimum: 7 (enforced). " +
          "Entries younger than this threshold keep full float32 precision " +
          "for Tier-1 native vector search.",
      },
      dry_run: {
        type: "boolean",
        description:
          "If true, reports eligible count and estimated byte savings " +
          "without purging any data. Default: false.",
      },
    },
    // No required fields — tool works with sensible defaults (30 days, all projects)
  },
};

/**
 * v5.1 Type guard for deep_storage_purge tool arguments.
 *
 * All fields are optional — the handler applies defaults:
 *   - project: omitted → purge across all projects
 *   - older_than_days: omitted → 30 days
 *   - dry_run: omitted → false
 */
export interface DeepStoragePurgeArgs {
  project?: string;
  older_than_days?: number;
  dry_run?: boolean;
}

export function isDeepStoragePurgeArgs(
  args: unknown
): args is DeepStoragePurgeArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (a.project !== undefined && typeof a.project !== "string") return false;
  if (a.older_than_days !== undefined && typeof a.older_than_days !== "number") return false;
  if (a.dry_run !== undefined && typeof a.dry_run !== "boolean") return false;
  return true;
}

// ─── v5.5: SDM Intuitive Recall Tool ──────────────────────────

export const SESSION_INTUITIVE_RECALL_TOOL: Tool = {
  name: "session_intuitive_recall",
  description:
    "Manually trigger the Sparse Distributed Memory (SDM) Intuitive Recall to surface latent patterns " +
    "and related memories for a given query without blowing up the context window. " +
    "Uses high-speed JS-space Hamming distance scanning on compressed embeddings.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project identifier.",
      },
      query: {
        type: "string",
        description: "The text query or context to trigger the recall.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of latent patterns to surface (default: 3).",
      },
      threshold: {
        type: "number",
        description: "Similarity threshold 0-1 (default: 0.55).",
      },
    },
    required: ["project", "query"],
  },
};

export interface SessionIntuitiveRecallArgs {
  project: string;
  query: string;
  limit?: number;
  threshold?: number;
}

export function isSessionIntuitiveRecallArgs(
  args: unknown
): args is SessionIntuitiveRecallArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.project !== "string") return false;
  if (typeof a.query !== "string") return false;
  // Optional numerics — guard against LLM passing strings like "10" or "high"
  if (a.limit !== undefined && typeof a.limit !== "number") return false;
  if (a.threshold !== undefined && typeof a.threshold !== "number") return false;
  return true;
}

// ─── v6.1: Storage Hygiene — VACUUM ──────────────────────────────────────────

export const MAINTENANCE_VACUUM_TOOL: Tool = {
  name: "maintenance_vacuum",
  description:
    "Reclaim disk space after large purge operations by running VACUUM on the local SQLite database.\n\n" +
    "Best called after `deep_storage_purge` removes many entries — SQLite reclaims page allocations " +
    "only when explicitly vacuumed, so the file size stays the same until you call this tool.\n\n" +
    "For remote (Supabase) backends, returns guidance on triggering maintenance via the dashboard.\n\n" +
    "**Note:** On large databases this may take up to 60 seconds. The tool runs synchronously " +
    "so you will know when it is safe to proceed.",
  inputSchema: {
    type: "object",
    properties: {
      dry_run: {
        type: "boolean",
        description:
          "If true, reports the current database file size without running VACUUM. " +
          "Use this to preview how large the database is before committing to a full vacuum.",
      },
    },
  },
};

export interface MaintenanceVacuumArgs {
  dry_run?: boolean;
}

export function isMaintenanceVacuumArgs(
  args: unknown
): args is MaintenanceVacuumArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (a.dry_run !== undefined && typeof a.dry_run !== "boolean") return false;
  return true;
}

// ─── v6.0 Phase 3: Edge Synthesis (On-Demand) ───────────────────────

export const SESSION_SYNTHESIZE_EDGES_TOOL: Tool = {
  name: "session_synthesize_edges",
  description:
    "Step 3A Edge Synthesis: Scans recent project entries with embeddings, finds high-similarity " +
    "but currently disconnected entries, and creates inferred links as 'synthesized_from'.\n\n" +
    "**On-Demand Graph Enrichment**: Use this tool periodically to discover semantic relationships " +
    "between structurally disconnected memory nodes. It batch processes the newest active entries.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project identifier.",
      },
      similarity_threshold: {
        type: "number",
        description: "Minimum cosine similarity score (0.0 to 1.0) to create a link. Default: 0.7.",
      },
      max_entries: {
        type: "integer",
        description: "Maximum number of recent entries to scan as sources. Default: 50. Max cap: 50.",
      },
      max_neighbors_per_entry: {
        type: "integer",
        description: "Maximum number of links to synthesize per source entry. Default: 3. Max cap: 5.",
      },
      randomize_selection: {
        type: "boolean",
        description: "If true, randomly sample active entries instead of taking the newest (default false). Ideal for wide-coverage background sweeps.",
      },
    },
    required: ["project"],
  },
};

export interface SessionSynthesizeEdgesArgs {
  project: string;
  similarity_threshold?: number;
  max_entries?: number;
  max_neighbors_per_entry?: number;
  randomize_selection?: boolean;
}

export function isSessionSynthesizeEdgesArgs(
  args: unknown
): args is SessionSynthesizeEdgesArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.project !== "string") return false;
  if (a.similarity_threshold !== undefined && typeof a.similarity_threshold !== "number") return false;
  if (a.max_entries !== undefined && typeof a.max_entries !== "number") return false;
  if (a.max_neighbors_per_entry !== undefined && typeof a.max_neighbors_per_entry !== "number") return false;
  if (a.randomize_selection !== undefined && typeof a.randomize_selection !== "boolean") return false;
  return true;
}


export const SESSION_COGNITIVE_ROUTE_TOOL: Tool = {
  name: "session_cognitive_route",
  description:
    "Resolve an HDC compositional state into a nearest semantic concept with policy-gated routing. " +
    "Returns concept, confidence, distance, ambiguity, convergence steps, and route outcome. " +
    "Use this for explainable cognitive recall decisions in v6.5.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project identifier.",
      },
      state: {
        type: "string",
        description: "Current state concept key (e.g. 'State:ActiveSession').",
      },
      role: {
        type: "string",
        description: "Role concept key used for transition binding.",
      },
      action: {
        type: "string",
        description: "Action concept key used for transition binding.",
      },
      fallback_threshold: {
        type: "number",
        description: "Optional route fallback threshold override (0 <= fallback < clarify <= 1).",
      },
      clarify_threshold: {
        type: "number",
        description: "Optional route clarify threshold override (0 <= fallback < clarify <= 1).",
      },
      explain: {
        type: "boolean",
        description: "If true, include expanded explainability details in the response. Default: true.",
      },
    },
    required: ["project", "state", "role", "action"],
  },
};

export interface SessionCognitiveRouteArgs {
  project: string;
  state: string;
  role: string;
  action: string;
  fallback_threshold?: number;
  clarify_threshold?: number;
  explain?: boolean;
}

export function isSessionCognitiveRouteArgs(
  args: unknown
): args is SessionCognitiveRouteArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.project !== "string") return false;
  if (typeof a.state !== "string") return false;
  if (typeof a.role !== "string") return false;
  if (typeof a.action !== "string") return false;
  if (a.fallback_threshold !== undefined && typeof a.fallback_threshold !== "number") return false;
  if (a.clarify_threshold !== undefined && typeof a.clarify_threshold !== "number") return false;
  if (a.explain !== undefined && typeof a.explain !== "boolean") return false;
  if (
    typeof a.fallback_threshold === "number" &&
    typeof a.clarify_threshold === "number" &&
    !(a.fallback_threshold >= 0 && a.fallback_threshold < a.clarify_threshold && a.clarify_threshold <= 1)
  ) return false;
  return true;
}

// ─── v7.1: Task Router Tool ──────────────────────────────────

export const SESSION_TASK_ROUTE_TOOL: Tool = {
  name: "session_task_route",
  description:
    "Analyze a coding task and recommend whether it should be handled by the host " +
    "cloud model or delegated to the local claw-code-agent (Qwen3).\n\n" +
    "**How to use:**\n" +
    "1. Call this tool BEFORE writing code or executing a complex task\n" +
    "2. Read the `target` field in the response\n" +
    "3. If target is `claw`, call `claw_run_task` with the task description\n" +
    "4. If target is `host`, handle the task yourself\n\n" +
    "**v7.1.0/v7.2.0:** Uses deterministic keyword/scope heuristics.\n" +
    "When a project is specified, routing is enhanced by analyzing past experience events " +
    "(success/failure/correction) to adjust confidence scores based on historical outcomes.",
  inputSchema: {
    type: "object",
    properties: {
      task_description: {
        type: "string",
        description: "The raw prompt or task description to analyze for routing.",
      },
      files_involved: {
        type: "array",
        items: { type: "string" },
        description: "Expected files to be created or modified by this task.",
      },
      estimated_scope: {
        type: "string",
        enum: ["minor_edit", "new_feature", "refactor", "bug_fix"],
        description:
          "Pre-categorize the task scope to improve routing accuracy. " +
          "'minor_edit' for small changes, 'new_feature' for scaffolding, " +
          "'refactor' for restructuring, 'bug_fix' for debugging.",
      },
      project: {
        type: "string",
        description: "Optional project identifier for context-aware routing.",
      },
    },
    required: ["task_description"],
  },
};

export interface SessionTaskRouteArgs {
  task_description: string;
  files_involved?: string[];
  estimated_scope?: "minor_edit" | "new_feature" | "refactor" | "bug_fix";
  project?: string;
}

export function isSessionTaskRouteArgs(
  args: unknown
): args is SessionTaskRouteArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.task_description !== "string") return false;
  if (
    a.files_involved !== undefined &&
    (!Array.isArray(a.files_involved) ||
      !a.files_involved.every((f: unknown) => typeof f === "string"))
  )
    return false;
  if (
    a.estimated_scope !== undefined &&
    a.estimated_scope !== "minor_edit" &&
    a.estimated_scope !== "new_feature" &&
    a.estimated_scope !== "refactor" &&
    a.estimated_scope !== "bug_fix"
  )
    return false;
  if (a.project !== undefined && typeof a.project !== "string") return false;
  return true;
}

// ─── v12.1: Onboarding Wizard Tool ─────────────────────────────

export const ONBOARDING_WIZARD_TOOL: Tool = {
  name: "onboarding_wizard",
  description:
    "Interactive setup wizard for new Prism users. Provides a step-by-step " +
    "guided experience to get productive in under 3 minutes.\n\n" +
    "**Actions:**\n" +
    "- `start` — Begin the wizard from step 1\n" +
    "- `next` — Advance to the next step\n" +
    "- `status` — Check current wizard progress\n" +
    "- `skip` — Skip to completion\n\n" +
    "Each step returns instructions, code snippets, and progress percentage.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["start", "next", "status", "skip"],
        description: "Wizard action to perform.",
      },
      project_name: {
        type: "string",
        description: "Optional project name to use in setup examples.",
      },
      ide_client: {
        type: "string",
        enum: ["claude_desktop", "cursor", "windsurf", "vscode", "other"],
        description: "IDE client for config generation.",
      },
    },
    required: ["action"],
  },
};

export interface OnboardingWizardArgs {
  action: "start" | "next" | "status" | "skip";
  project_name?: string;
  ide_client?: string;
}

export function isOnboardingWizardArgs(
  args: unknown
): args is OnboardingWizardArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.action !== "string") return false;
  if (!["start", "next", "status", "skip"].includes(a.action)) return false;
  if (a.project_name !== undefined && typeof a.project_name !== "string") return false;
  if (a.ide_client !== undefined && typeof a.ide_client !== "string") return false;
  return true;
}

// ─── v12.1: NER Entity Extraction Tool ───────────────────────

export const EXTRACT_ENTITIES_TOOL: Tool = {
  name: "extract_entities",
  description:
    "Extract named entities from raw text using rule-based + optional LLM extraction. " +
    "Automatically identifies technologies, file paths, decisions, TODOs, people, projects, " +
    "and configuration values without explicit tagging.\n\n" +
    "**Entity types:** PERSON, PROJECT, TECH, FILE, DECISION, TODO, CONFIG\n\n" +
    "Use this to auto-enrich session context with structured metadata from " +
    "raw conversation text.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Raw text to extract entities from.",
      },
      use_llm: {
        type: "boolean",
        description: "If true, also uses local LLM for higher-quality extraction. Default: false.",
      },
      project: {
        type: "string",
        description: "Optional project to auto-save extracted entities to.",
      },
    },
    required: ["text"],
  },
};

export interface ExtractEntitiesArgs {
  text: string;
  use_llm?: boolean;
  project?: string;
}

export function isExtractEntitiesArgs(
  args: unknown
): args is ExtractEntitiesArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.text !== "string") return false;
  if (a.use_llm !== undefined && typeof a.use_llm !== "boolean") return false;
  if (a.project !== undefined && typeof a.project !== "string") return false;
  return true;
}

// ─── v12.2: API Analytics Tool ───────────────────────────────

export const API_ANALYTICS_TOOL: Tool = {
  name: "api_analytics",
  description:
    "View API usage analytics per project or system-wide. " +
    "Shows call counts, success rates, latency, token usage, " +
    "top tools, and daily trends.\n\n" +
    "**Scopes:**\n" +
    "- `project` — Analytics for a specific project\n" +
    "- `system` — System-wide aggregate analytics",
  inputSchema: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["project", "system"],
        description: "Analytics scope: 'project' for per-project, 'system' for global.",
      },
      project: {
        type: "string",
        description: "Project identifier (required when scope='project').",
      },
      days: {
        type: "integer",
        description: "Number of days to analyze (default: 30).",
      },
    },
    required: ["scope"],
  },
};

export interface APIAnalyticsArgs {
  scope: "project" | "system";
  project?: string;
  days?: number;
}

export function isAPIAnalyticsArgs(
  args: unknown
): args is APIAnalyticsArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (a.scope !== "project" && a.scope !== "system") return false;
  if (a.project !== undefined && typeof a.project !== "string") return false;
  if (a.days !== undefined && typeof a.days !== "number") return false;
  return true;
}

// ─── v12.2: Database Backup Tool ─────────────────────────────

export const BACKUP_DATABASE_TOOL: Tool = {
  name: "backup_database",
  description:
    "Create, list, or restore SQLite database backups.\n\n" +
    "**Actions:**\n" +
    "- `create` — Create a new backup now\n" +
    "- `list` — List available backups with sizes and ages\n" +
    "- `restore` — Restore from a specific backup file\n" +
    "- `configure` — Set backup schedule (hourly/daily/weekly)\n\n" +
    "Backups are stored in ~/.prism/backups/ by default. " +
    "Automatic retention pruning keeps only the configured maximum.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "list", "restore", "configure"],
        description: "Backup action to perform.",
      },
      backup_path: {
        type: "string",
        description: "Path to backup file (required for 'restore' action).",
      },
      schedule: {
        type: "string",
        enum: ["hourly", "daily", "weekly", "manual"],
        description: "Backup schedule (for 'configure' action).",
      },
      max_backups: {
        type: "integer",
        description: "Maximum number of backups to retain (for 'configure' action). Default: 7.",
      },
    },
    required: ["action"],
  },
};

export interface BackupDatabaseArgs {
  action: "create" | "list" | "restore" | "configure";
  backup_path?: string;
  schedule?: "hourly" | "daily" | "weekly" | "manual";
  max_backups?: number;
}

export function isBackupDatabaseArgs(
  args: unknown
): args is BackupDatabaseArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (!["create", "list", "restore", "configure"].includes(a.action as string)) return false;
  if (a.backup_path !== undefined && typeof a.backup_path !== "string") return false;
  if (a.schedule !== undefined && !["hourly", "daily", "weekly", "manual"].includes(a.schedule as string)) return false;
  if (a.max_backups !== undefined && typeof a.max_backups !== "number") return false;
  return true;
}

// ─── v12.2: Notification Configuration Tool ──────────────────

export const CONFIGURE_NOTIFICATIONS_TOOL: Tool = {
  name: "configure_notifications",
  description:
    "Configure real-time notifications for memory events via webhook, Slack, or email.\n\n" +
    "**Actions:**\n" +
    "- `status` — Show current notification configuration\n" +
    "- `add_channel` — Add a notification channel (webhook/slack/email)\n" +
    "- `remove_channel` — Remove a channel by URL\n" +
    "- `test` — Send a test notification to all configured channels\n\n" +
    "**Events:** health_degradation, compaction_complete, backup_complete, " +
    "backup_failed, memory_threshold, new_graduated_insight, scheduler_error",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["status", "add_channel", "remove_channel", "test"],
        description: "Configuration action to perform.",
      },
      channel_type: {
        type: "string",
        enum: ["webhook", "slack", "email"],
        description: "Channel type (for add_channel).",
      },
      channel_url: {
        type: "string",
        description: "Channel URL (webhook endpoint, Slack webhook, or email relay).",
      },
      min_severity: {
        type: "string",
        enum: ["info", "warning", "critical"],
        description: "Minimum severity to notify. Default: 'warning'.",
      },
    },
    required: ["action"],
  },
};

export interface ConfigureNotificationsArgs {
  action: "status" | "add_channel" | "remove_channel" | "test";
  channel_type?: "webhook" | "slack" | "email";
  channel_url?: string;
  min_severity?: "info" | "warning" | "critical";
}

export function isConfigureNotificationsArgs(
  args: unknown
): args is ConfigureNotificationsArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (!["status", "add_channel", "remove_channel", "test"].includes(a.action as string)) return false;
  if (a.channel_type !== undefined && !["webhook", "slack", "email"].includes(a.channel_type as string)) return false;
  if (a.channel_url !== undefined && typeof a.channel_url !== "string") return false;
  return true;
}

// ─── v12.2: Natural Language Memory Query Tool ───────────────

export const QUERY_MEMORY_NATURAL_TOOL: Tool = {
  name: "query_memory_natural",
  description:
    "Query memories using natural language instead of structured tool syntax. " +
    "Automatically classifies intent, extracts keywords, and executes the " +
    "appropriate search strategy.\n\n" +
    "**Examples:**\n" +
    "- \"What did we decide about authentication?\"\n" +
    "- \"What's still open on the billing project?\"\n" +
    "- \"What files did we change last week?\"\n" +
    "- \"Show me recent work on the API\"\n\n" +
    "Returns the parsed intent, search results, and optionally an " +
    "LLM-synthesized answer.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "Natural language question about your memories.",
      },
      project: {
        type: "string",
        description: "Optional project scope for the query.",
      },
      synthesize: {
        type: "boolean",
        description: "If true, use local LLM to synthesize a natural language answer. Default: false.",
      },
    },
    required: ["question"],
  },
};

export interface QueryMemoryNaturalArgs {
  question: string;
  project?: string;
  synthesize?: boolean;
}

export function isQueryMemoryNaturalArgs(
  args: unknown
): args is QueryMemoryNaturalArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.question !== "string") return false;
  if (a.project !== undefined && typeof a.project !== "string") return false;
  if (a.synthesize !== undefined && typeof a.synthesize !== "boolean") return false;
  return true;
}


// ══════════════════════════════════════════════════════════════
// v12.3: Team Collaboration & RBAC
// ══════════════════════════════════════════════════════════════

export const MANAGE_RBAC_TOOL = {
  name: "manage_rbac",
  description: "Manage role-based access control for projects and memory partitions. Create/modify roles, assign users, check permissions.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["create_role", "delete_role", "assign_role", "revoke_role", "check_permission", "list_roles", "list_assignments"], description: "RBAC action to perform." },
      project: { type: "string", description: "Project to manage RBAC for." },
      role: { type: "string", description: "Role name (for create/delete/assign/revoke)." },
      user_id: { type: "string", description: "User ID (for assign/revoke)." },
      permission: { type: "string", description: "Permission to check (for check_permission)." },
      permissions: { type: "array", items: { type: "string" }, description: "Permissions list (for create_role)." },
    },
    required: ["action"],
  },
};

export interface ManageRbacArgs {
  action: string;
  project?: string;
  role?: string;
  user_id?: string;
  permission?: string;
  permissions?: string[];
}

export function isManageRbacArgs(args: unknown): args is ManageRbacArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  return typeof a.action === "string";
}

export const ENCRYPTED_SYNC_TOOL = {
  name: "encrypted_sync",
  description: "Synchronize session data between peers using AES-256-GCM encryption. Push/pull/status operations.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["push", "pull", "status", "configure"], description: "Sync action to perform." },
      project: { type: "string", description: "Project to sync." },
      peer_url: { type: "string", description: "Peer endpoint URL." },
      encryption_key: { type: "string", description: "Shared encryption key (for configure)." },
    },
    required: ["action"],
  },
};

export interface EncryptedSyncArgs {
  action: string;
  project?: string;
  peer_url?: string;
  encryption_key?: string;
}

export function isEncryptedSyncArgs(args: unknown): args is EncryptedSyncArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  return typeof a.action === "string";
}

// ══════════════════════════════════════════════════════════════
// v12.4: GitHub Integration & Automation
// ══════════════════════════════════════════════════════════════

export const GITHUB_SYNC_TOOL = {
  name: "github_sync",
  description: "Bidirectional sync between Prism memory entries and GitHub Issues/PRs. Export memory as issues or import issues as memory.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["push_to_github", "pull_from_github", "sync_status", "configure"], description: "GitHub sync action." },
      project: { type: "string", description: "Prism project to sync." },
      repo: { type: "string", description: "GitHub repo (owner/name)." },
      token: { type: "string", description: "GitHub personal access token." },
      entry_ids: { type: "array", items: { type: "string" }, description: "Specific entry IDs to push (optional)." },
    },
    required: ["action"],
  },
};

export interface GithubSyncArgs {
  action: string;
  project?: string;
  repo?: string;
  token?: string;
  entry_ids?: string[];
}

export function isGithubSyncArgs(args: unknown): args is GithubSyncArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  return typeof a.action === "string";
}

export const GENERATE_CHANGELOG_TOOL = {
  name: "generate_changelog",
  description: "Generate AI-powered changelogs from session ledger history. Outputs in Keep a Changelog format with optional LLM enhancement.",
  inputSchema: {
    type: "object" as const,
    properties: {
      project: { type: "string", description: "Project to generate changelog for." },
      from_date: { type: "string", description: "Start date (ISO 8601)." },
      to_date: { type: "string", description: "End date (ISO 8601)." },
      format: { type: "string", enum: ["markdown", "json", "html"], description: "Output format. Default: markdown." },
      use_llm: { type: "boolean", description: "Use LLM for enhanced summarization. Default: false." },
      include_files: { type: "boolean", description: "Include file change lists. Default: false." },
    },
    required: ["project"],
  },
};

export interface GenerateChangelogArgs {
  project: string;
  from_date?: string;
  to_date?: string;
  format?: string;
  use_llm?: boolean;
  include_files?: boolean;
}

export function isGenerateChangelogArgs(args: unknown): args is GenerateChangelogArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  return typeof a.project === "string";
}

export const GENERATE_CI_PIPELINE_TOOL = {
  name: "generate_ci_pipeline",
  description: "Generate GitHub Actions CI/CD workflows from project configuration or preset templates (node-test, npm-publish, python-test).",
  inputSchema: {
    type: "object" as const,
    properties: {
      project: { type: "string", description: "Project name for the workflow." },
      preset: { type: "string", enum: ["node-test", "npm-publish", "python-test", "custom"], description: "Preset template to use." },
      custom_config: { type: "object", description: "Custom pipeline configuration (for preset=custom)." },
    },
    required: ["project"],
  },
};

export interface GenerateCiPipelineArgs {
  project: string;
  preset?: string;
  custom_config?: Record<string, unknown>;
}

export function isGenerateCiPipelineArgs(args: unknown): args is GenerateCiPipelineArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  return typeof a.project === "string";
}

export const MEMORY_ATTESTATION_TOOL = {
  name: "memory_attestation",
  description: "Generate or verify SHA-256 Merkle tree attestation reports for memory integrity. Provides tamper detection and provable audit trails.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["generate", "verify", "proof"], description: "Attestation action." },
      project: { type: "string", description: "Project to attest." },
      entry_id: { type: "string", description: "Entry ID to verify or generate proof for." },
      report: { type: "object", description: "Previous attestation report (for verify)." },
    },
    required: ["action", "project"],
  },
};

export interface MemoryAttestationArgs {
  action: string;
  project: string;
  entry_id?: string;
  report?: Record<string, unknown>;
}

export function isMemoryAttestationArgs(args: unknown): args is MemoryAttestationArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  return typeof a.action === "string" && typeof a.project === "string";
}

// ══════════════════════════════════════════════════════════════
// v12.5: Cloud Runtime & Extensibility
// ══════════════════════════════════════════════════════════════

export const MANAGE_PLUGINS_TOOL = {
  name: "manage_plugins",
  description: "Manage Prism plugins/extensions. Discover, load, unload, and list plugins from the ~/.prism/plugins directory.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["discover", "load", "unload", "list", "validate"], description: "Plugin action." },
      plugin_name: { type: "string", description: "Plugin name (for load/unload/validate)." },
    },
    required: ["action"],
  },
};

export interface ManagePluginsArgs {
  action: string;
  plugin_name?: string;
}

export function isManagePluginsArgs(args: unknown): args is ManagePluginsArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  return typeof a.action === "string";
}

export const SYNALUX_PROXY_TOOL = {
  name: "synalux_proxy",
  description: "Manage the Synalux Cloud thin-client proxy. Configure, check health, list features, and send proxied requests.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["configure", "health", "features", "request", "status"], description: "Proxy action." },
      tier: { type: "string", enum: ["free", "standard", "advanced", "enterprise"], description: "Subscription tier (for configure)." },
      api_key: { type: "string", description: "Synalux API key (for configure)." },
      request: { type: "object", description: "Proxy request details (for request action)." },
    },
    required: ["action"],
  },
};

export interface SynaluxProxyArgs {
  action: string;
  tier?: string;
  api_key?: string;
  request?: Record<string, unknown>;
}

export function isSynaluxProxyArgs(args: unknown): args is SynaluxProxyArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  return typeof a.action === "string";
}

export const CLOUD_DELEGATE_TOOL = {
  name: "cloud_delegate",
  description: "Delegate compute-intensive tasks to Synalux Cloud agents. Create, dispatch, monitor, and cancel remote tasks with Prism memory injection.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["create", "dispatch", "status", "cancel", "list", "history", "configure"], description: "Delegate action." },
      task_type: { type: "string", enum: ["build", "test", "deploy", "analyze", "transform", "custom"], description: "Task type (for create)." },
      project: { type: "string", description: "Project context." },
      task_id: { type: "string", description: "Task ID (for dispatch/status/cancel)." },
      payload: { type: "object", description: "Task payload (for create)." },
      priority: { type: "string", enum: ["low", "normal", "high", "critical"], description: "Task priority." },
    },
    required: ["action"],
  },
};

export interface CloudDelegateArgs {
  action: string;
  task_type?: string;
  project?: string;
  task_id?: string;
  payload?: Record<string, unknown>;
  priority?: string;
}

export function isCloudDelegateArgs(args: unknown): args is CloudDelegateArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  return typeof a.action === "string";
}

export const VM_QUOTA_TOOL = {
  name: "vm_quota",
  description: "Check and manage tier-gated VM quotas. View limits, usage, and check if resource allocation is allowed for the current subscription tier.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["summary", "check_vm", "check_run", "set_tier", "usage"], description: "Quota action." },
      tier: { type: "string", enum: ["free", "standard", "advanced", "enterprise"], description: "Subscription tier (for set_tier)." },
      cpu_cores: { type: "number", description: "CPU cores requested (for check_vm)." },
      ram_gb: { type: "number", description: "RAM GB requested (for check_vm)." },
      storage_gb: { type: "number", description: "Storage GB requested (for check_vm)." },
      platform: { type: "string", description: "Target platform (for check_vm)." },
    },
    required: ["action"],
  },
};

export interface VmQuotaArgs {
  action: string;
  tier?: string;
  cpu_cores?: number;
  ram_gb?: number;
  storage_gb?: number;
  platform?: string;
}

export function isVmQuotaArgs(args: unknown): args is VmQuotaArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  return typeof a.action === "string";
}
