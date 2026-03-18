/**
 * MCP Server — Core Entry Point
 *
 * This file sets up the Model Context Protocol (MCP) server, registers all
 * tools, and handles incoming tool requests from the client (e.g., Claude Desktop).
 *
 * How MCP works (simplified):
 *   1. The AI client (e.g., Claude) connects to this server via stdin/stdout
 *   2. The client asks "what tools do you have?" → we respond with the tool list
 *   3. The client calls a specific tool (e.g., "brave_web_search") with arguments
 *   4. We route the call to the correct handler function and return the result
 *
 * Tool registration is dynamic:
 *   - 7 base tools are always registered (search, analysis, code-mode, etc.)
 *   - 3 session memory tools are conditionally registered only when Supabase is configured
 *   - This means users can run the server without Supabase and everything still works
 *
 * Architecture:
 *   server.ts (this file)  →  routes tool calls by name
 *   tools/definitions.ts   →  defines tool schemas (what arguments each tool accepts)
 *   tools/handlers.ts      →  implements tool logic (what each tool actually does)
 *   utils/*.ts              →  API clients (Brave, Gemini, Supabase, QuickJS sandbox)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  InitializeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { SERVER_CONFIG, SESSION_MEMORY_ENABLED } from "./config.js";

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
  sessionSaveLedgerHandler,
  sessionSaveHandoffHandler,
  sessionLoadContextHandler,
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
const SESSION_MEMORY_TOOLS: Tool[] = [
  SESSION_SAVE_LEDGER_TOOL,    // session_save_ledger — append immutable session log
  SESSION_SAVE_HANDOFF_TOOL,   // session_save_handoff — upsert latest project state
  SESSION_LOAD_CONTEXT_TOOL,   // session_load_context — progressive context loading
];

// Combine: if session memory is enabled, add those tools too
const ALL_TOOLS: Tool[] = [
  ...BASE_TOOLS,
  ...(SESSION_MEMORY_ENABLED ? SESSION_MEMORY_TOOLS : []),
];

// ─── Server Factory ──────────────────────────────────────────────

/**
 * Creates and configures the MCP server with all tool handlers.
 *
 * The server handles three types of requests:
 *   - initialize: Client handshake (exchange protocol version and capabilities)
 *   - list_tools: Client asks what tools are available
 *   - call_tool:  Client calls a specific tool with arguments
 */
export function createServer() {
  console.error(`Creating MCP server with name: ${SERVER_CONFIG.name}, version: ${SERVER_CONFIG.version}`);
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
      },
    }
  );

  // ── Handler: Initialize ──
  // Called once when the client first connects. Exchanges protocol version and capabilities.
  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    console.error(`Received initialize request from client: ${request.params.clientInfo?.name || 'unknown'}`);

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
      },
    };
  });

  // ── Handler: List Tools ──
  // Returns the full list of available tools so the client knows what it can call.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error("Received list tools request");
    return {
      tools: ALL_TOOLS,
    };
  });

  // ── Handler: Call Tool ──
  // Routes each tool call to the correct handler function based on the tool name.
  // Each handler validates its arguments, calls the appropriate API, and returns a result.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    console.error(`Received call tool request for: ${request.params.name}`);

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
        // Even though these tools won't appear in the tool list without Supabase,
        // we still guard each handler call in case of direct invocation.

        case "session_save_ledger":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          return await sessionSaveLedgerHandler(args);

        case "session_save_handoff":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          return await sessionSaveHandoffHandler(args);

        case "session_load_context":
          if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured. Set SUPABASE_URL and SUPABASE_KEY.");
          return await sessionLoadContextHandler(args);

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

// ─── Server Startup ─────────────────────────────────────────────

/**
 * Starts the MCP server using stdio transport.
 *
 * The stdio transport means:
 *   - The server reads JSON-RPC messages from stdin
 *   - The server writes JSON-RPC responses to stdout
 *   - Log messages go to stderr (so they don't conflict with the protocol)
 *
 * This is how MCP clients like Claude Desktop communicate with tool servers.
 */
export async function startServer() {
  console.error("Initializing server...");
  const server = createServer();

  console.error("Creating stdio transport...");
  const transport = new StdioServerTransport();

  console.error("Connecting server to transport...");
  await server.connect(transport);

  console.error("Brave Search MCP Server running on stdio");

  // Keep the process alive — without this, Node.js would exit
  // because there are no active event loop handles after the
  // synchronous setup completes.
  setInterval(() => {
    // Heartbeat to keep the process running
  }, 10000);
}

startServer().catch((error) => {
  console.error('Fatal error running server:', error);
  process.exit(1);
});
