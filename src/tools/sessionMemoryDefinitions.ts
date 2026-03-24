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
        description: "v3.0: Agent role for Hivemind scoping (e.g., 'dev', 'qa', 'pm'). Defaults to 'global'.",
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
        description: "v3.0: Agent role for Hivemind scoping (e.g., 'dev', 'qa', 'pm'). Defaults to 'global'.",
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
        description: "v3.0: Agent role for Hivemind scoping (e.g., 'dev', 'qa', 'pm'). Defaults to 'global'. When set, also injects active_team roster.",
      },
      // v4.0: Token Budget
      max_tokens: {
        type: "integer",
        description: "Maximum token budget for context response. Uses 1 token ≈ 4 chars heuristic. When set, the response is truncated to fit within the budget. Default: unlimited.",
      },
    },
    required: ["project"],
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
    },
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
  return typeof args === "object" && args !== null;
}

// Phase 1: Added enable_trace to the type guard.
// Optional boolean — when true, the handler returns a MemoryTrace content block.
// Default: false, so existing callers see no change in behavior.
export function isKnowledgeSearchArgs(
  args: unknown
): args is {
  project?: string;
  query?: string;
  category?: string;
  limit?: number;
  enable_trace?: boolean;  // Phase 1: Explainability flag
} {
  return typeof args === "object" && args !== null;
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

// REVIEWER NOTE: v0.4.0 adds expected_version to the type guard
// for optimistic concurrency control. It's optional for backward compat.
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
} {
  return (
    typeof args === "object" &&
    args !== null &&
    "project" in args &&
    typeof (args as { project: string }).project === "string"
  );
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
} {
  return (
    typeof args === "object" &&
    args !== null &&
    "query" in args &&
    typeof (args as { query: string }).query === "string"
  );
}

// ─── v1.5.0: Type guard for backfill embeddings ──────────────
export function isBackfillEmbeddingsArgs(
  args: unknown
): args is {
  project?: string;
  limit?: number;
  dry_run?: boolean;
} {
  return typeof args === "object" && args !== null;
}

export function isSessionLoadContextArgs(
  args: unknown
): args is { project: string; level?: "quick" | "standard" | "deep"; role?: string } {
  return (
    typeof args === "object" &&
    args !== null &&
    "project" in args &&
    typeof (args as { project: string }).project === "string"
  );
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
  return (
    typeof args === "object" &&
    args !== null &&
    "project" in args &&
    typeof (args as { project: string }).project === "string"
  );
}

export function isMemoryCheckoutArgs(
  args: unknown
): args is { project: string; target_version: number } {
  return (
    typeof args === "object" &&
    args !== null &&
    "project" in args &&
    typeof (args as { project: string }).project === "string" &&
    "target_version" in args &&
    typeof (args as { target_version: number }).target_version === "number"
  );
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
  return (
    typeof args === "object" &&
    args !== null &&
    "project" in args &&
    typeof (args as { project: string }).project === "string" &&
    "file_path" in args &&
    typeof (args as { file_path: string }).file_path === "string" &&
    "description" in args &&
    typeof (args as { description: string }).description === "string"
  );
}

export function isSessionViewImageArgs(
  args: unknown
): args is { project: string; image_id: string } {
  return (
    typeof args === "object" &&
    args !== null &&
    "project" in args &&
    typeof (args as { project: string }).project === "string" &&
    "image_id" in args &&
    typeof (args as { image_id: string }).image_id === "string"
  );
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
    "Scans for missing embeddings, duplicate entries, orphaned handoffs, and stale rollups.\\n\\n" +
    "Checks performed:\\n" +
    "1. **Missing embeddings** — entries that can't be found via semantic search\\n" +
    "2. **Duplicate entries** — near-identical summaries wasting context tokens\\n" +
    "3. **Orphaned handoffs** — handoff state with no backing ledger entries\\n" +
    "4. **Stale rollups** — compaction artifacts with no archived originals\\n\\n" +
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
  return typeof args === "object" && args !== null;  // any object is valid
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
  return (
    typeof args === "object" &&
    args !== null &&
    "memory_id" in args &&
    typeof (args as { memory_id: string }).memory_id === "string"
  );
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
  return (
    typeof args === "object" &&
    args !== null &&
    "project" in args &&
    typeof (args as { project: string }).project === "string" &&
    "ttl_days" in args &&
    typeof (args as { ttl_days: number }).ttl_days === "number"
  );
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
    "- **learning**: New knowledge acquired",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project identifier.",
      },
      event_type: {
        type: "string",
        enum: ["correction", "success", "failure", "learning"],
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
        description: "Agent role for Hivemind scoping. Defaults to 'global'.",
      },
    },
    required: ["project", "event_type", "context", "action", "outcome"],
  },
};

export function isSessionSaveExperienceArgs(
  args: unknown
): args is {
  project: string;
  event_type: string;
  context: string;
  action: string;
  outcome: string;
  correction?: string;
  confidence_score?: number;
  role?: string;
} {
  return (
    typeof args === "object" &&
    args !== null &&
    "project" in args &&
    typeof (args as any).project === "string" &&
    "event_type" in args &&
    typeof (args as any).event_type === "string" &&
    "context" in args &&
    typeof (args as any).context === "string" &&
    "action" in args &&
    typeof (args as any).action === "string" &&
    "outcome" in args &&
    typeof (args as any).outcome === "string"
  );
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
  return (
    typeof args === "object" &&
    args !== null &&
    "id" in args &&
    typeof (args as { id: string }).id === "string"
  );
}
