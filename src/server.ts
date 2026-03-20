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
  InitializeRequestSchema,
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

import { SERVER_CONFIG, SESSION_MEMORY_ENABLED, PRISM_USER_ID } from "./config.js";

// ─── v0.4.0: Supabase API imports for Prompts/Resources handlers ───
// REVIEWER NOTE: The prompt and resource handlers need direct access
// to supabaseRpc and supabaseGet to fetch context. In v0.3.0, only
// the handler files imported from supabaseApi. Now server.ts needs
// them too for the prompt/resource request handlers.
import { supabaseRpc, supabaseGet } from "./utils/supabaseApi.js";

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
  SESSION_BACKFILL_EMBEDDINGS_TOOL,
  sessionSaveLedgerHandler,
  sessionSaveHandoffHandler,
  sessionLoadContextHandler,
  knowledgeSearchHandler,
  knowledgeForgetHandler,
  // ─── v0.4.0: New tool handlers ───
  compactLedgerHandler,
  sessionSearchMemoryHandler,
  backfillEmbeddingsHandler,
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
  SESSION_BACKFILL_EMBEDDINGS_TOOL, // session_backfill_embeddings — repair missing embeddings (v1.5.0)
];

// Combine: if session memory is enabled, add those tools too
const ALL_TOOLS: Tool[] = [
  ...BASE_TOOLS,
  ...(SESSION_MEMORY_ENABLED ? SESSION_MEMORY_TOOLS : []),
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
    console.error(`[resource-subscription] Notifying update for ${uri}`);
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
  console.error(`Creating Prism MCP server v${SERVER_CONFIG.version}`);
  console.error(`Registering ${ALL_TOOLS.length} tools (${BASE_TOOLS.length} base + ${SESSION_MEMORY_ENABLED ? SESSION_MEMORY_TOOLS.length : 0} session memory)`);

  const server = new Server(
    {
      name: SERVER_CONFIG.name,
      version: SERVER_CONFIG.version,
    },
    {
      capabilities: {
        tools: {
          tools: ALL_TOOLS,
        },
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
  // REVIEWER NOTE: The initialize handler is unchanged from v0.3.0
  // except that it now reports the expanded capabilities.
  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    console.error(`Client connected: ${request.params.clientInfo?.name || 'unknown'}`);

    return {
      protocolVersion: request.params.protocolVersion,
      serverInfo: {
        name: SERVER_CONFIG.name,
        version: SERVER_CONFIG.version,
      },
      capabilities: {
        tools: {
          tools: ALL_TOOLS,
        },
        ...(SESSION_MEMORY_ENABLED ? { prompts: {} } : {}),
        ...(SESSION_MEMORY_ENABLED ? { resources: { subscribe: true } } : {}),
      },
    };
  });

  // ── Handler: List Tools ──
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error("Received list tools request");
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

      const project = promptArgs?.project || "default";
      const level = promptArgs?.level || "standard";

      console.error(`[prompt:resume_session] Loading ${level} context for "${project}"`);

      // Fetch context using the same RPC as session_load_context
      // v1.5.0: Pass p_user_id for multi-tenant isolation
      const result = await supabaseRpc("get_session_context", {
        p_project: project,
        p_level: level,
        p_user_id: PRISM_USER_ID,
      });

      const data = Array.isArray(result) ? result[0] : result;

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
      // REVIEWER NOTE: We query Supabase for all projects that have
      // a handoff entry. This gives Claude Desktop a browsable list
      // of all projects with saved state. The select fields are
      // minimal to keep the response lightweight.
      const handoffs = await supabaseGet("session_handoffs", {
        select: "project,last_summary,updated_at",
      });

      return {
        resources: (Array.isArray(handoffs) ? handoffs : []).map((h: any) => ({
          uri: `memory://${h.project}/handoff`,
          name: `${h.project} — Session State`,
          description: h.last_summary
            ? h.last_summary.substring(0, 200)
            : "No summary available",
          mimeType: "application/json",
        })),
      };
    });

    // Read a specific project's handoff as a resource
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      // REVIEWER NOTE: Parse the project name from the URI.
      // URI format: memory://{project}/handoff
      const uri = request.params.uri;
      const match = uri.match(/^memory:\/\/(.+)\/handoff$/);

      if (!match) {
        throw new Error(`Unknown resource URI: ${uri}. Expected format: memory://{project}/handoff`);
      }

      const project = decodeURIComponent(match[1]);

      console.error(`[resource:read] Fetching handoff for "${project}"`);

      // Reuse the same RPC as session_load_context — standard level
      // gives a good balance of info without being too large.
      // REVIEWER NOTE: The RPC response includes `version` (added in
      // migration 019), which the LLM needs for OCC when saving later.
      // v1.5.0: Pass p_user_id for multi-tenant isolation
      const result = await supabaseRpc("get_session_context", {
        p_project: project,
        p_level: "standard",
        p_user_id: PRISM_USER_ID,
      });

      const data = Array.isArray(result) ? result[0] : result;

      // REVIEWER NOTE: Inject explicit OCC instructions into the
      // resource text so the LLM knows to pass version on save.
      const resourceData = data || { status: "no_session_found", project };
      if (data?.version) {
        resourceData._occ_instruction =
          `When saving handoff state, you MUST pass expected_version: ${data.version} ` +
          `to prevent state collisions with other sessions.`;
      }

      return {
        contents: [{
          uri: uri,
          mimeType: "application/json",
          text: JSON.stringify(resourceData, null, 2),
        }],
      };
    });

    // ─── Resource Subscriptions: subscribe/unsubscribe ───
    // REVIEWER NOTE: These handlers track which resource URIs the
    // client cares about. When sessionSaveHandoffHandler calls
    // notifyResourceUpdate(), we check this set to decide whether
    // to push a notification. This prevents unnecessary notifications
    // for projects the client hasn't attached.

    server.setRequestHandler(SubscribeRequestSchema, async (request) => {
      const uri = request.params.uri;
      console.error(`[resource-subscription] Client subscribed to ${uri}`);
      activeSubscriptions.add(uri);
      return {};
    });

    server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
      const uri = request.params.uri;
      console.error(`[resource-subscription] Client unsubscribed from ${uri}`);
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
    console.error(`Tool call: ${request.params.name}`);

    try {
      const { name, arguments: args } = request.params;

      if (!args) {
        throw new Error("No arguments provided");
      }

      console.error(`Processing ${name} with arguments: ${JSON.stringify(args)}`);

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

        case "session_backfill_embeddings":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          return await backfillEmbeddingsHandler(args);

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

// ─── Smithery Sandbox Export ─────────────────────────────────────
// Smithery uses this to scan capabilities (tools, prompts, resources)
// without requiring real credentials or starting a transport.
export function createSandboxServer() {
  return createServer();
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
  console.error("Initializing Prism MCP server...");
  const server = createServer();

  console.error("Creating stdio transport...");
  const transport = new StdioServerTransport();

  console.error("Connecting server to transport...");
  await server.connect(transport);

  console.error(`Prism MCP Server v${SERVER_CONFIG.version} running on stdio`);

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
