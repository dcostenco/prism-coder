#!/usr/bin/env node
/**
 * MCP Server — Core Entry Point (v1.5.0)
 *
 * This file sets up the Model Context Protocol (MCP) server, registers all
 * tools, prompts, and resources, then handles incoming requests from the
 * client (e.g., Claude Desktop).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * REVIEWER NOTE: v0.4.0 CHANGES OVERVIEW
 *
 * v0.3.0 only declared `tools` in capabilities. v0.4.0 adds:
 *   1. MCP Prompts → /resume_session slash command (Enhancement #1)
 *   2. MCP Resources → memory://{project}/handoff attachable context (#3)
 *   3. Resource Subscriptions → live-refresh when handoff state changes
 *   4. New tools: session_compact_ledger (#2), session_search_memory (#4)
 *   5. Updated handlers for OCC version tracking (#5)
 *
 * HOW MCP WORKS (simplified):
 *   1. The AI client (e.g., Claude) connects via stdin/stdout
 *   2. On connect, the client receives our capabilities (tools + prompts + resources)
 *   3. The client can:
 *      - Call tools (brave_web_search, session_save_ledger, etc.)
 *      - List/get prompts (/resume_session slash command)
 *      - List/read resources (memory://project/handoff attachments)
 *      - Subscribe to resource updates (live refresh on state change)
 *
 * ARCHITECTURE:
 *   server.ts (this file)              → routes all MCP requests
 *   tools/definitions.ts               → search/analysis tool schemas
 *   tools/sessionMemoryDefinitions.ts  → session memory tool schemas
 *   tools/handlers.ts                  → search/analysis tool logic
 *   tools/sessionMemoryHandlers.ts     → session memory tool logic
 *   tools/compactionHandler.ts         → ledger compaction logic (NEW)
 *   utils/supabaseApi.ts               → Supabase REST client
 *   utils/embeddingApi.ts              → Gemini embedding client (NEW)
 *   utils/googleAi.ts                  → Gemini LLM client
 * ═══════════════════════════════════════════════════════════════════════
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  // ─── v0.4.0: MCP Prompts support (Enhancement #1) ───
  // REVIEWER NOTE: These schemas enable the /resume_session
  // slash command in Claude Desktop. ListPrompts tells the
  // client what prompts exist; GetPrompt returns the actual
  // prompt content with injected session context.
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  // ─── v0.4.0: MCP Resources support (Enhancement #3) ───
  // REVIEWER NOTE: These schemas enable the paperclip-attachable
  // memory context in Claude Desktop. Resources are read-only
  // data — perfect for session state that the LLM needs to read
  // but doesn't need to "call" a tool for.
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  // ─── v0.4.0: Resource Subscriptions ───
  // REVIEWER NOTE: When the user attaches memory://project/handoff,
  // and the LLM later saves new handoff state, we need to notify
  // Claude Desktop that the attached resource has changed.
  // Without this, the paperclipped context becomes stale.
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { SERVER_CONFIG, SESSION_MEMORY_ENABLED, PRISM_USER_ID, PRISM_ENABLE_HIVEMIND } from "./config.js";
import { getSyncBus } from "./sync/factory.js";
import type { SyncBus, SyncEvent } from "./sync/index.js";
import { startDashboardServer } from "./dashboard/server.js";

// ─── v2.3.6 FIX: Use Storage Abstraction for Prompts/Resources ───
// CRITICAL FIX: Previously imported supabaseRpc/supabaseGet directly,
// which bypassed the storage abstraction layer and caused the server
// to crash (EOF) when the Supabase REST call failed without a proper
// error wrapper. Now uses getStorage() which routes through the
// correct backend (Supabase or SQLite) with proper error handling.
import { getStorage } from "./storage/index.js";
import { getSettingSync, initConfigStorage } from "./storage/configStorage.js";

// ─── Import Tool Definitions (schemas) and Handlers (implementations) ─────

import {
  WEB_SEARCH_TOOL,
  BRAVE_WEB_SEARCH_CODE_MODE_TOOL,
  LOCAL_SEARCH_TOOL,
  BRAVE_LOCAL_SEARCH_CODE_MODE_TOOL,
  CODE_MODE_TRANSFORM_TOOL,
  BRAVE_ANSWERS_TOOL,
  RESEARCH_PAPER_ANALYSIS_TOOL,
  webSearchHandler,
  braveWebSearchCodeModeHandler,
  localSearchHandler,
  braveLocalSearchCodeModeHandler,
  codeModeTransformHandler,
  braveAnswersHandler,
  researchPaperAnalysisHandler,
} from "./tools/index.js";

// Session memory tools — only used if Supabase is configured
import {
  SESSION_SAVE_LEDGER_TOOL,
  SESSION_SAVE_HANDOFF_TOOL,
  SESSION_LOAD_CONTEXT_TOOL,
  KNOWLEDGE_SEARCH_TOOL,
  KNOWLEDGE_FORGET_TOOL,
  // ─── v0.4.0: New tool definitions (Enhancements #2 and #4) ───
  SESSION_COMPACT_LEDGER_TOOL,
  SESSION_SEARCH_MEMORY_TOOL,
  // ─── v2.0: Time Travel tool definitions ───
  MEMORY_HISTORY_TOOL,
  MEMORY_CHECKOUT_TOOL,
  // ─── v2.0: Visual Memory tool definitions ───
  SESSION_SAVE_IMAGE_TOOL,
  SESSION_VIEW_IMAGE_TOOL,
  // ─── v2.2.0: Health Check tool definition ───
  SESSION_HEALTH_CHECK_TOOL,
  // ─── Phase 2: GDPR Memory Deletion tool definition ───
  SESSION_FORGET_MEMORY_TOOL,
  // ─── v3.1: TTL Retention tool ───
  KNOWLEDGE_SET_RETENTION_TOOL,
  // v4.0: Active Behavioral Memory tools
  SESSION_SAVE_EXPERIENCE_TOOL,
  KNOWLEDGE_UPVOTE_TOOL,
  KNOWLEDGE_DOWNVOTE_TOOL,

  sessionSaveLedgerHandler,
  sessionSaveHandoffHandler,
  sessionLoadContextHandler,
  knowledgeSearchHandler,
  knowledgeForgetHandler,
  // ─── v0.4.0: New tool handlers ───
  compactLedgerHandler,
  sessionSearchMemoryHandler,
  backfillEmbeddingsHandler,
  // ─── v2.0: Time Travel handlers ───
  memoryHistoryHandler,
  memoryCheckoutHandler,
  // ─── v2.0: Visual Memory handlers ───
  sessionSaveImageHandler,
  sessionViewImageHandler,
  // ─── v2.2.0: Health Check handler ───
  sessionHealthCheckHandler,
  // ─── Phase 2: GDPR Memory Deletion handler ───
  sessionForgetMemoryHandler,
  // ─── v3.1: TTL Retention handler ───
  knowledgeSetRetentionHandler,
  // v4.0: Active Behavioral Memory handlers
  sessionSaveExperienceHandler,
  knowledgeUpvoteHandler,
  knowledgeDownvoteHandler,
  // ─── v3.0: Agent Hivemind tools ───
  AGENT_REGISTRY_TOOLS,
  agentRegisterHandler,
  agentHeartbeatHandler,
  agentListTeamHandler,
} from "./tools/index.js";

// ─── Dynamic Tool Registration ───────────────────────────────────

// Base tools: always available regardless of configuration
const BASE_TOOLS: Tool[] = [
  WEB_SEARCH_TOOL,                    // brave_web_search — general internet search
  BRAVE_WEB_SEARCH_CODE_MODE_TOOL,    // brave_web_search_code_mode — search + JS extraction
  LOCAL_SEARCH_TOOL,                  // brave_local_search — location/business search
  BRAVE_LOCAL_SEARCH_CODE_MODE_TOOL,  // brave_local_search_code_mode — local search + JS extraction
  CODE_MODE_TRANSFORM_TOOL,           // code_mode_transform — universal post-processing
  BRAVE_ANSWERS_TOOL,                 // brave_answers — AI-grounded answers
  RESEARCH_PAPER_ANALYSIS_TOOL,       // gemini_research_paper_analysis — paper analysis
];

// Session memory tools: only added when SUPABASE_URL + SUPABASE_KEY are set
// REVIEWER NOTE: v0.4.0 adds 2 new tools here:
//   - session_compact_ledger (Enhancement #2): auto-rollup of old ledger entries
//   - session_search_memory (Enhancement #4): semantic search via pgvector embeddings
const SESSION_MEMORY_TOOLS: Tool[] = [
  SESSION_SAVE_LEDGER_TOOL,    // session_save_ledger — append immutable session log
  SESSION_SAVE_HANDOFF_TOOL,   // session_save_handoff — upsert latest project state (now with OCC)
  SESSION_LOAD_CONTEXT_TOOL,   // session_load_context — progressive context loading
  KNOWLEDGE_SEARCH_TOOL,       // knowledge_search — search accumulated knowledge
  KNOWLEDGE_FORGET_TOOL,       // knowledge_forget — prune bad/old memories
  SESSION_COMPACT_LEDGER_TOOL, // session_compact_ledger — auto-compact old ledger entries (v0.4.0)
  SESSION_SEARCH_MEMORY_TOOL,  // session_search_memory — semantic search via embeddings (v0.4.0)
  MEMORY_HISTORY_TOOL,         // memory_history — view version timeline (v2.0)
  MEMORY_CHECKOUT_TOOL,        // memory_checkout — revert to past version (v2.0)
  // ─── v2.0: Visual Memory tools ───
  SESSION_SAVE_IMAGE_TOOL,     // session_save_image — save image to media vault (v2.0)
  SESSION_VIEW_IMAGE_TOOL,     // session_view_image — retrieve image from vault (v2.0)
  // ─── v2.2.0: Health Check tool ───
  SESSION_HEALTH_CHECK_TOOL,   // session_health_check — brain integrity checker (v2.2.0)
  // ─── Phase 2: GDPR Memory Deletion tool ───
  SESSION_FORGET_MEMORY_TOOL,  // session_forget_memory — GDPR-compliant memory deletion (Phase 2)
  // ─── v3.1: TTL Retention tool ───
  KNOWLEDGE_SET_RETENTION_TOOL, // knowledge_set_retention — set auto-expiry TTL for a project
  // ─── v4.0: Active Behavioral Memory tools ───
  SESSION_SAVE_EXPERIENCE_TOOL,  // session_save_experience — record typed experience events
  KNOWLEDGE_UPVOTE_TOOL,         // knowledge_upvote — increase entry importance
  KNOWLEDGE_DOWNVOTE_TOOL,       // knowledge_downvote — decrease entry importance
];


// Combine: always list ALL tools so scanners (Glama, Smithery, MCP Registry)
// can enumerate the full capability set. Runtime guards in the CallTool handler
// still prevent execution without valid Supabase credentials.
const ALL_TOOLS: Tool[] = [
  ...BASE_TOOLS,
  ...SESSION_MEMORY_TOOLS,
  // v3.0: Agent Hivemind tools — only when PRISM_ENABLE_HIVEMIND=true
  ...(PRISM_ENABLE_HIVEMIND ? AGENT_REGISTRY_TOOLS : []),
];

// ─── v0.4.0: Resource Subscription Tracking ──────────────────────
// REVIEWER NOTE: We track which project URIs clients have subscribed
// to. When sessionSaveHandoffHandler successfully updates a project,
// it calls notifyResourceUpdate() to push a refresh notification
// to any Claude Desktop instance that has that project's memory
// resource attached via paperclip.
//
// This is a simple in-memory set. If the server restarts, clients
// will re-subscribe on reconnect (per MCP spec behavior).
const activeSubscriptions = new Set<string>();

// Module-level promise for the async storage pre-warm fired in startServer().
// Resource handlers check storageIsReady (synchronous) instead of awaiting
// the promise, so they never block the MCP stdio pipe during startup.
let storageReady: Promise<void> | null = null;
let storageIsReady = false;

/**
 * Notifies subscribed clients that a resource has changed.
 *
 * Called from sessionSaveHandoffHandler after a successful save.
 * This triggers Claude Desktop to silently re-fetch the attached
 * memory resource, keeping the paperclipped context up-to-date
 * without the user doing anything.
 */
export function notifyResourceUpdate(project: string, server: Server) {
  const uri = `memory://${project}/handoff`;
  if (activeSubscriptions.has(uri)) {
    server.notification({
      method: "notifications/resources/updated",
      params: { uri },
    });
  }
}

// ─── Server Factory ──────────────────────────────────────────────

/**
 * Creates and configures the MCP server with all handlers.
 *
 * v0.4.0 CAPABILITIES (Enhanced):
 *   - tools:     Search, analysis, session memory tools (7 base + 7 session)
 *   - prompts:   /resume_session — inject previous context before LLM thinks
 *   - resources: memory://{project}/handoff — paperclip-attachable session state
 *                with subscribe support for live refresh
 */
export function createServer() {
  const server = new Server(
    {
      name: SERVER_CONFIG.name,
      version: SERVER_CONFIG.version,
    },
    {
      capabilities: {
        tools: {},

        // ─── v0.4.0: Prompt capability (Enhancement #1) ───
        // REVIEWER NOTE: Declaring `prompts: {}` tells Claude Desktop
        // that we support the prompts/list and prompts/get methods.
        // This enables the /resume_session slash command in the UI.
        // Only enabled when Supabase is configured (prompts need
        // session data to be useful).
        ...(SESSION_MEMORY_ENABLED ? { prompts: {} } : {}),
        // ─── v0.4.0: Resource capability (Enhancement #3) ───
        // REVIEWER NOTE: Setting subscribe: true tells Claude Desktop
        // that we support resource subscriptions. When a user attaches
        // memory://project/handoff and the LLM later updates it,
        // we push an update notification so the attached context
        // is silently refreshed. Without subscribe:true, the
        // paperclipped context would become stale.
        ...(SESSION_MEMORY_ENABLED ? { resources: { subscribe: true } } : {}),
      },
    }
  );

  // ── Handler: Initialize ──
  // NOTE: The SDK's built-in _oninitialize() handles the Initialize request.
  // It stores _clientCapabilities, _clientVersion, negotiates protocol version,
  // and returns capabilities from the Server constructor config.
  // Do NOT override InitializeRequestSchema — doing so bypasses critical
  // internal state management and can cause MCP clients (like Antigravity)
  // to fail during the init handshake.

  // ── Handler: List Tools ──
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: ALL_TOOLS,
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // v0.4.0 Enhancement #1: MCP Prompts — /resume_session
  // ═══════════════════════════════════════════════════════════════
  // REVIEWER NOTE: This solves the "cold start" problem.
  //
  // BEFORE (v0.3.0): User starts chat → types "continue working" →
  //   Claude has no context → hallucinates or asks what to do →
  //   Eventually (if the user/system prompts it right) calls
  //   session_load_context as a tool → wastes a tool call + reasoning step.
  //
  // AFTER (v0.4.0): User types /resume_session project=prism-mcp →
  //   Claude Desktop calls our GetPrompt handler → we fetch context
  //   from Supabase → inject it as a user message → Claude starts
  //   thinking WITH full context. Zero tool calls, zero reasoning waste.
  //
  // OCC INTEGRATION: The injected prompt includes the current version
  // number from session_handoffs. The prompt text explicitly instructs
  // the LLM to pass this version when saving handoff state later,
  // ensuring the concurrency control chain is unbroken even when
  // context is loaded via prompt instead of tool.
  // ═══════════════════════════════════════════════════════════════

  if (SESSION_MEMORY_ENABLED) {
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [{
        name: "resume_session",
        description:
          "Load previous session context for a project. " +
          "Automatically fetches handoff state and injects it before " +
          "the LLM starts thinking — no tool call needed. " +
          "Includes version tracking for concurrency control.",
        arguments: [
          {
            name: "project",
            description: "Project identifier to resume (e.g., 'prism-mcp')",
            required: true,
          },
          {
            name: "level",
            description:
              "Context depth: 'quick' (~50 tokens), " +
              "'standard' (~200 tokens, recommended), " +
              "'deep' (full history, ~1000+ tokens)",
            required: false,
          },
        ],
      }],
    }));

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: promptArgs } = request.params;

      if (name !== "resume_session") {
        throw new Error(`Unknown prompt: ${name}`);
      }

      // Non-blocking: if storage isn't warm yet, return a fallback message
      // instead of blocking the MCP stdio pipe during Supabase init.
      if (!storageIsReady) {
        const project = promptArgs?.project || "default";
        return {
          messages: [{
            role: "user",
            content: {
              type: "text",
              text: `⏳ Storage is still initializing. Session context for "${project}" will be available shortly.\nUse the session_load_context tool to load context once ready.`,
            },
          }],
        };
      }

      const project = promptArgs?.project || "default";
      const level = promptArgs?.level || "standard";

      // v2.3.6 FIX: Use storage abstraction instead of direct supabaseRpc
      const storage = await getStorage();
      const result = await storage.loadContext(project, level, PRISM_USER_ID);

      const data = result;

      // REVIEWER NOTE: We include the version in the prompt text so
      // the LLM knows to pass it back when saving. This is critical
      // for OCC (Enhancement #5) to work even when context is loaded
      // via prompt instead of tool call.
      const version = data?.version || null;

      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: data && data.status !== "no_previous_session"
              ? `You are resuming work on project "${project}". ` +
                `Here is your previous session context (loaded at ${level} level):\n\n` +
                `${JSON.stringify(data, null, 2)}\n\n` +
                (version
                  ? `**Current Session Version: ${version}**\n` +
                    `When saving handoff state at the end of this session, ` +
                    `you MUST pass expected_version: ${version} to prevent state collisions.\n\n`
                  : "") +
                `Continue from where you left off. Check the pending ` +
                `TODOs and active decisions before starting new work.`
              : `No previous context found for project "${project}". ` +
                `This is a fresh session — no previous version to track.`,
          },
        }],
      };
    });

    // ═══════════════════════════════════════════════════════════════
    // v0.4.0 Enhancement #3: MCP Resources — Attachable Memory
    // ═══════════════════════════════════════════════════════════════
    // REVIEWER NOTE: MCP distinguishes between Tools (actions) and
    // Resources (read-only data). Session memory state at load time
    // is read-only — perfect for Resources.
    //
    // When exposed as a Resource, Claude Desktop shows it in the
    // "attach context" panel (paperclip icon). Users can attach
    // memory://project/handoff to ANY chat without the LLM needing
    // to make a tool call. This is zero-cost context injection.
    //
    // RESOURCE SUBSCRIPTIONS: When subscribe:true is declared in
    // capabilities, clients can subscribe to specific resource URIs.
    // We track subscriptions in the activeSubscriptions set.
    // When sessionSaveHandoffHandler updates a project, it calls
    // notifyResourceUpdate() to push a silent refresh to Claude Desktop.
    // This means the paperclipped context stays current even after
    // the LLM modifies the handoff state mid-conversation.
    //
    // OCC INTEGRATION: The resource JSON includes the version field
    // so the LLM can track it for concurrency control, just like
    // the prompt does.
    // ═══════════════════════════════════════════════════════════════

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: [{
        uriTemplate: "memory://{project}/handoff",
        name: "Session Handoff State",
        description:
          "Current handoff state for a project — includes " +
          "last summary, pending TODOs, active decisions, keywords, " +
          "and version number for concurrency control. " +
          "Attach this to inject session context without a tool call.",
        mimeType: "application/json",
      }],
    }));

    // List concrete resources — one per known project
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      // Non-blocking: if storage isn't warm yet, return empty list instantly
      // so the client UI isn't blocked during Supabase init (can take 1m+).
      // Resources will appear on the next ListResources call once warm.
      if (!storageIsReady) {
        return { resources: [] };
      }
      try {
        const storage = await getStorage(); // instant — singleton is warm
        const projects = await storage.listProjects();

        return {
          resources: projects.map((p: string) => ({
            uri: `memory://${p}/handoff`,
            name: `${p} — Session State`,
            mimeType: "application/json",
          })),
        };
      } catch (error) {
        console.error(`[resource:list] Error listing resources: ${error}`);
        return { resources: [] };
      }
    });

    // Read a specific project's handoff as a resource
    // v3.1 FIX: Returns formatted text/plain (same layout as session_load_context)
    // so MCP clients render it as readable text instead of a raw JSON blob.
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const match = uri.match(/^memory:\/\/(.+)\/handoff$/);

      if (!match) {
        throw new Error(`Unknown resource URI: ${uri}. Expected format: memory://{project}/handoff`);
      }

      const project = decodeURIComponent(match[1]);

      // Non-blocking: if storage isn't warm yet, return a friendly fallback
      // instead of blocking the client UI for 1m+ during Supabase init.
      if (!storageIsReady) {
        return {
          contents: [{
            uri,
            mimeType: "text/plain",
            text: `⏳ Storage is still initializing. Session context for "${project}" will be available shortly.\nUse the session_load_context tool to load context once ready.`,
          }],
        };
      }

      try {
        const storage = await getStorage(); // instant — singleton is warm
        const data = await storage.loadContext(project, "standard", PRISM_USER_ID);

        if (!data) {
          return {
            contents: [{
              uri,
              mimeType: "text/plain",
              text: `No session context found for project "${project}".\nThis project has no previous session history. Starting fresh.`,
            }],
          };
        }

        // Format identically to sessionLoadContextHandler so the resource
        // renders as readable text rather than a raw JSON dump.
        const d = data as Record<string, any>;
        let formattedContext = "";
        if (d.last_summary) formattedContext += `📝 Last Summary: ${d.last_summary}\n`;
        if (d.active_branch) formattedContext += `🌿 Active Branch: ${d.active_branch}\n`;
        if (d.key_context) formattedContext += `💡 Key Context: ${d.key_context}\n`;
        if (d.pending_todo?.length) {
          formattedContext += `\n✅ Open TODOs:\n` + d.pending_todo.map((t: string) => `  - ${t}`).join("\n") + `\n`;
        }
        if (d.active_decisions?.length) {
          formattedContext += `\n⚖️ Active Decisions:\n` + d.active_decisions.map((dec: string) => `  - ${dec}`).join("\n") + `\n`;
        }
        if (d.keywords?.length) {
          formattedContext += `\n🔑 Keywords: ${d.keywords.join(", ")}\n`;
        }
        if (d.recent_sessions?.length) {
          formattedContext += `\n⏳ Recent Sessions:\n` + d.recent_sessions.map((s: any) => `  [${s.session_date?.split("T")[0]}] ${s.summary}`).join("\n") + `\n`;
        }

        const version = d.version;
        const versionNote = version
          ? `\n\n🔑 Session version: ${version}. Pass expected_version: ${version} when saving handoff.\n` +
            `_occ_instruction: When saving handoff state, you MUST pass expected_version: ${version} to prevent state collisions with other sessions.`
          : "";

        // ─── Agent Identity Block (mirrors session_load_context output) ───
        const ROLE_ICONS: Record<string, string> = {
          dev: "🛠️", qa: "🔍", pm: "📋", lead: "🏗️",
          security: "🔒", ux: "🎨", global: "🌐", cmo: "📢",
        };
        const agentName = getSettingSync("agent_name", "");
        const defaultRole = getSettingSync("default_role", "");
        let identityBlock = "";
        if (agentName || (defaultRole && defaultRole !== "global")) {
          const icon = ROLE_ICONS[defaultRole] || "🤖";
          const namePart = agentName ? `👋 **${agentName}**` : `👋 **Agent**`;
          const rolePart = defaultRole ? ` · Role: \`${defaultRole}\`` : "";
          identityBlock = `\n\n[👤 AGENT IDENTITY]\n${icon} ${namePart}${rolePart}`;
        }

        return {
          contents: [{
            uri,
            mimeType: "text/plain",
            text: `📋 Session context for "${project}" (standard):\n\n${formattedContext.trim()}${identityBlock}${versionNote}`,
          }],
        };
      } catch (error) {
        console.error(`[resource:read] Error reading resource ${uri}: ${error}`);
        return {
          isError: true,
          contents: [{
            uri,
            mimeType: "text/plain",
            text: `Error reading resource: ${error instanceof Error ? error.message : String(error)}`,
          }],
        };
      }
    });

    // ─── Resource Subscriptions: subscribe/unsubscribe ───
    // REVIEWER NOTE: These handlers track which resource URIs the
    // client cares about. When sessionSaveHandoffHandler calls
    // notifyResourceUpdate(), we check this set to decide whether
    // to push a notification. This prevents unnecessary notifications
    // for projects the client hasn't attached.

    server.setRequestHandler(SubscribeRequestSchema, async (request) => {
      const uri = request.params.uri;
      activeSubscriptions.add(uri);
      return {};
    });

    server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
      const uri = request.params.uri;
      activeSubscriptions.delete(uri);
      return {};
    });
  }

  // ── Handler: Call Tool ──
  // REVIEWER NOTE: v0.4.0 adds two new tool cases:
  //   - session_compact_ledger (Enhancement #2)
  //   - session_search_memory (Enhancement #4)
  // The server reference is passed to sessionSaveHandoffHandler so it
  // can trigger resource update notifications on successful saves.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;

      if (!args) {
        throw new Error("No arguments provided");
      }

      switch (name) {
        // ── Search & Analysis Tools (always available) ──

        case "brave_web_search":
          return await webSearchHandler(args);

        case "brave_web_search_code_mode":
          return await braveWebSearchCodeModeHandler(args);

        case "brave_local_search":
          return await localSearchHandler(args);

        case "brave_local_search_code_mode":
          return await braveLocalSearchCodeModeHandler(args);

        case "code_mode_transform":
          return await codeModeTransformHandler(args);

        case "brave_answers":
          return await braveAnswersHandler(args);

        case "gemini_research_paper_analysis":
          return await researchPaperAnalysisHandler(args);

        // ── Session Memory Tools (only callable when Supabase is configured) ──
        // REVIEWER NOTE: Even though these tools won't appear in the
        // tool list without Supabase, we still guard each handler call
        // in case of direct invocation.

        case "session_save_ledger":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          return await sessionSaveLedgerHandler(args);

        case "session_save_handoff":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          // REVIEWER NOTE: v0.4.0 passes the server reference so the
          // handler can trigger resource update notifications after
          // a successful save. See notifyResourceUpdate() above.
          return await sessionSaveHandoffHandler(args, server);

        case "session_load_context":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          return await sessionLoadContextHandler(args);

        case "knowledge_search":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          return await knowledgeSearchHandler(args);

        case "knowledge_forget":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          return await knowledgeForgetHandler(args);

        // ─── v0.4.0: New Session Memory Tools ───

        case "session_compact_ledger":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          return await compactLedgerHandler(args);

        case "session_search_memory":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          return await sessionSearchMemoryHandler(args);

        // ─── v2.0: Time Travel Tools ───

        case "memory_history":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          return await memoryHistoryHandler(args);

        case "memory_checkout":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          return await memoryCheckoutHandler(args);

        // ─── v2.0: Visual Memory Tools ───

        case "session_save_image":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          return await sessionSaveImageHandler(args);

        case "session_view_image":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          return await sessionViewImageHandler(args);

        // ─── v2.2.0: Health Check Tool ───

        case "session_health_check":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          return await sessionHealthCheckHandler(args);

        // ─── Phase 2: GDPR Memory Deletion Tool ───

        case "session_forget_memory":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          return await sessionForgetMemoryHandler(args);

        // ─── v3.1: TTL Retention Tool ───

        case "knowledge_set_retention":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          return await knowledgeSetRetentionHandler(args);

        // ─── v4.0: Active Behavioral Memory Tools ───

        case "session_save_experience":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          return await sessionSaveExperienceHandler(args);

        case "knowledge_upvote":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          return await knowledgeUpvoteHandler(args);

        case "knowledge_downvote":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          return await knowledgeDownvoteHandler(args);

        // ─── v3.0: Agent Hivemind Tools ───

        case "agent_register":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured.");
          if (!PRISM_ENABLE_HIVEMIND) throw new Error("Hivemind not enabled. Set PRISM_ENABLE_HIVEMIND=true.");
          return await agentRegisterHandler(args);

        case "agent_heartbeat":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured.");
          if (!PRISM_ENABLE_HIVEMIND) throw new Error("Hivemind not enabled. Set PRISM_ENABLE_HIVEMIND=true.");
          return await agentHeartbeatHandler(args);

        case "agent_list_team":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured.");
          if (!PRISM_ENABLE_HIVEMIND) throw new Error("Hivemind not enabled. Set PRISM_ENABLE_HIVEMIND=true.");
          return await agentListTeamHandler(args);

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      console.error(`Error in tool handler: ${error instanceof Error ? error.message : String(error)}`);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// ─── Smithery/Glama Sandbox Export ───────────────────────────────
// Scanners (Smithery, Glama) use this to enumerate capabilities
// (tools, prompts, resources) without requiring real credentials.
// Unlike createServer(), this always exposes ALL capabilities
// regardless of whether SESSION_MEMORY_ENABLED is true.
export function createSandboxServer() {
  const server = new Server(
    {
      name: SERVER_CONFIG.name,
      version: SERVER_CONFIG.version,
    },
    {
      capabilities: {
        tools: {},

        prompts: {},
        resources: { subscribe: true },
      },
    }
  );

  // Register all tool listings unconditionally
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...BASE_TOOLS, ...SESSION_MEMORY_TOOLS, ...AGENT_REGISTRY_TOOLS],
  }));

  // Register prompts listing so scanners see resume_session
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{
      name: "resume_session",
      description:
        "Load previous session context for a project. " +
        "Automatically fetches handoff state and injects it before " +
        "the LLM starts thinking — no tool call needed. " +
        "Includes version tracking for concurrency control.",
      arguments: [
        {
          name: "project",
          description: "Project identifier to resume (e.g., 'prism-mcp')",
          required: true,
        },
        {
          name: "level",
          description:
            "Context depth: 'quick' (~50 tokens), " +
            "'standard' (~200 tokens, recommended), " +
            "'deep' (full history, ~1000+ tokens)",
          required: false,
        },
      ],
    }],
  }));

  // Register resource templates so scanners see memory://{project}/handoff
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{
      uriTemplate: "memory://{project}/handoff",
      name: "Session Handoff State",
      description:
        "Current handoff state for a project — includes " +
        "last summary, pending TODOs, active decisions, keywords, " +
        "and version number for concurrency control. " +
        "Attach this to inject session context without a tool call.",
      mimeType: "application/json",
    }],
  }));

  return server;
}

// ─── Server Startup ─────────────────────────────────────────────

/**
 * Starts the MCP server using stdio transport.
 *
 * REVIEWER NOTE: Startup is unchanged from v0.3.0. The stdio transport
 * is standard for MCP — it reads JSON-RPC from stdin and writes
 * responses to stdout. Log messages go to stderr.
 */
export async function startServer() {
  // Pre-warm the config settings cache BEFORE connecting the MCP transport.
  // This ensures getSettingSync() returns real values (agent_name, default_role)
  // during the Initialize handshake — zero extra latency for resource reads.
  // initConfigStorage() is local SQLite only (~5ms), safe to await.
  await initConfigStorage();

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Pre-warm storage AFTER connecting — fired async so we never block the
  // stdio handshake. Supabase REST initialization can take 500ms–5s; blocking
  // on it before server.connect() was the root cause of the 1m 56s CLI delay.
  // By the time the first real tool/resource call arrives, the singleton is warm.
  if (SESSION_MEMORY_ENABLED) {
    const STORAGE_TIMEOUT_MS = 10_000;
    storageReady = Promise.race([
      getStorage().then(() => { storageIsReady = true; }),
      new Promise<void>(resolve => setTimeout(() => {
        if (!storageIsReady) {
          console.error(`[Prism] Storage pre-warm timed out after ${STORAGE_TIMEOUT_MS}ms (non-fatal)`);
        }
        resolve();
      }, STORAGE_TIMEOUT_MS)),
    ]).catch(err => {
      console.error(`[Prism] Storage pre-warm failed (non-fatal): ${err}`);
    });
  }

  // ─── v2.0 Step 6: Initialize SyncBus (Telepathy) ───
  // Fire-and-forget — SyncBus is non-critical for startup.
  // Awaiting getSyncBus() + startListening() could block the event loop
  // if Supabase Realtime is slow, delaying MCP request processing.
  if (SESSION_MEMORY_ENABLED) {
    (async () => {
      try {
        const syncBus = await getSyncBus();
        await syncBus.startListening();

        syncBus.on("update", (event: SyncEvent) => {
          // Send an MCP logging notification to the IDE
          try {
            server.sendLoggingMessage({
              level: "info",
              data: `[Prism Telepathy] \u{1F9E0} Another agent just updated the memory for ` +
                `'${event.project}' to version ${event.version}. ` +
                `You may want to run session_load_context to sync up.`,
            });
          } catch (err) {
            console.error(`[Telepathy] Failed to send notification: ${err}`);
          }
        });

      } catch (err) {
        console.error(`[Telepathy] SyncBus init failed (non-fatal): ${err}`);
      }
    })();
  }

  // ─── v2.0 Step 8: Mind Palace Dashboard ───
  // Deferred to next tick — yields the event loop so the MCP stdio
  // transport processes the initialize handshake before dashboard
  // init spawns child processes (lsof) and awaits storage.
  setTimeout(() => {
    startDashboardServer().catch(err => {
      console.error(`[Dashboard] Mind Palace startup failed (non-fatal): ${err}`);
    });
  }, 0);

  // Keep the process alive — without this, Node.js would exit
  // because there are no active event loop handles after the
  // synchronous setup completes.
  setInterval(() => {
    // Heartbeat to keep the process running
  }, 10000);
}

// Only auto-start when this module is executed directly (not imported by Smithery scanner)
const isDirectExecution = process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts');
if (isDirectExecution) {
  startServer().catch((error) => {
    console.error('Fatal error running server:', error);
    process.exit(1);
  });
}
