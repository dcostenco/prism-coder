/**
 * Tool Re-exports
 *
 * This file acts as the public API for all tools in the project.
 * Instead of importing from individual files, other modules can import
 * everything they need from this single file:
 *
 *   import { WEB_SEARCH_TOOL, webSearchHandler } from "./tools/index.js";
 *
 * This pattern keeps imports clean and makes it easy to add new tools —
 * just add a new export line here when you create a new tool file.
 *
 * REVIEWER NOTE: v0.4.0 adds 2 new tool definitions and 2 new handlers:
 *   - SESSION_COMPACT_LEDGER_TOOL + compactLedgerHandler (from compactionHandler.ts)
 *   - SESSION_SEARCH_MEMORY_TOOL + sessionSearchMemoryHandler (from sessionMemoryHandlers.ts)
 */

// ── Search & Analysis Tools ──
// These are the 7 base tools that are always available.
// Definitions = tool schemas (name, description, input parameters)
// Handlers = the actual implementation logic
export { WEB_SEARCH_TOOL, BRAVE_WEB_SEARCH_CODE_MODE_TOOL, LOCAL_SEARCH_TOOL, BRAVE_LOCAL_SEARCH_CODE_MODE_TOOL, CODE_MODE_TRANSFORM_TOOL, BRAVE_ANSWERS_TOOL, RESEARCH_PAPER_ANALYSIS_TOOL } from "./definitions.js";
export { webSearchHandler, braveWebSearchCodeModeHandler, localSearchHandler, braveLocalSearchCodeModeHandler, codeModeTransformHandler, braveAnswersHandler, researchPaperAnalysisHandler } from "./handlers.js";

// ── Session Memory Tools (Optional) ──
// These tools are only active when Supabase is configured (SUPABASE_URL + SUPABASE_KEY).
// The conditional registration happens in server.ts, not here.
// This file always exports them — server.ts decides whether to include them in the tool list.
//
// v0.4.0: Added SESSION_COMPACT_LEDGER_TOOL and SESSION_SEARCH_MEMORY_TOOL
export { SESSION_SAVE_LEDGER_TOOL, SESSION_SAVE_HANDOFF_TOOL, SESSION_LOAD_CONTEXT_TOOL, KNOWLEDGE_SEARCH_TOOL, KNOWLEDGE_FORGET_TOOL, SESSION_COMPACT_LEDGER_TOOL, SESSION_SEARCH_MEMORY_TOOL, MEMORY_HISTORY_TOOL, MEMORY_CHECKOUT_TOOL, SESSION_SAVE_IMAGE_TOOL, SESSION_VIEW_IMAGE_TOOL, SESSION_HEALTH_CHECK_TOOL, SESSION_FORGET_MEMORY_TOOL, SESSION_EXPORT_MEMORY_TOOL, KNOWLEDGE_SET_RETENTION_TOOL, SESSION_SAVE_EXPERIENCE_TOOL, KNOWLEDGE_UPVOTE_TOOL, KNOWLEDGE_DOWNVOTE_TOOL, KNOWLEDGE_SYNC_RULES_TOOL, DEEP_STORAGE_PURGE_TOOL, SESSION_INTUITIVE_RECALL_TOOL, SESSION_BACKFILL_LINKS_TOOL, MAINTENANCE_VACUUM_TOOL, isDeepStoragePurgeArgs, SESSION_SYNTHESIZE_EDGES_TOOL, isSessionSynthesizeEdgesArgs, SESSION_COGNITIVE_ROUTE_TOOL, isSessionCognitiveRouteArgs, SESSION_TASK_ROUTE_TOOL, isSessionTaskRouteArgs } from "./sessionMemoryDefinitions.js";

// 1. Ledger (Core CRUD & State)
export {
    sessionSaveLedgerHandler,
    sessionSaveHandoffHandler,
    sessionLoadContextHandler,
    sessionSaveExperienceHandler,
    sessionSaveImageHandler,
    sessionViewImageHandler,
    memoryHistoryHandler,
    memoryCheckoutHandler,
    sessionForgetMemoryHandler,
    sessionExportMemoryHandler
} from "./ledgerHandlers.js";

// 2. Graph (Semantic Search & Weighting)
export {
    sessionSearchMemoryHandler,
    knowledgeSearchHandler,
    sessionIntuitiveRecallHandler,
    knowledgeUpvoteHandler,
    knowledgeDownvoteHandler,
    knowledgeForgetHandler,
    knowledgeSyncRulesHandler,
    sessionSynthesizeEdgesHandler,
    sessionCognitiveRouteHandler
} from "./graphHandlers.js";

// 3. Hygiene (Maintenance & Integrity)
export {
    deepStoragePurgeHandler,
    maintenanceVacuumHandler,
    sessionHealthCheckHandler,
    backfillEmbeddingsHandler,
    sessionBackfillLinksHandler,
    knowledgeSetRetentionHandler
} from "./hygieneHandlers.js";
// ── Compaction Handler (v0.4.0 — Enhancement #2) ──
// The compaction handler is in a separate file because it's significantly
// more complex than the other session memory handlers (chunked Gemini
// API calls, recursive summarization, etc.).
export { compactLedgerHandler } from "./compactionHandler.js";

// ── Agent Registry Tools (v3.0 — Hivemind, Optional) ──
// These tools are only registered when PRISM_ENABLE_HIVEMIND=true.
// server.ts handles the conditional registration.
export { AGENT_REGISTRY_TOOLS, getRoleIcon } from "./agentRegistryDefinitions.js";
export { agentRegisterHandler, agentHeartbeatHandler, agentListTeamHandler } from "./agentRegistryHandlers.js";

// ── Task Router (v7.1 — Heuristic Routing, Optional) ──
// Registered when PRISM_TASK_ROUTER_ENABLED=true.
// server.ts handles the conditional registration.
export { sessionTaskRouteHandler } from "./taskRouterHandler.js";

// ── Dark Factory Pipeline Tools (v7.3 — Autonomous Execution, Optional) ──
// Registered when PRISM_DARK_FACTORY_ENABLED=true.
// server.ts handles the conditional registration.
export {
  SESSION_START_PIPELINE_TOOL,
  SESSION_CHECK_PIPELINE_STATUS_TOOL,
  SESSION_ABORT_PIPELINE_TOOL,
  isStartPipelineArgs,
  isCheckPipelineStatusArgs,
  isAbortPipelineArgs,
} from "./pipelineDefinitions.js";
export {
  sessionStartPipelineHandler,
  sessionCheckPipelineStatusHandler,
  sessionAbortPipelineHandler,
} from "./pipelineHandlers.js";
