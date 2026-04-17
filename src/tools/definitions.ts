/**
 * Tool Definitions (Schemas)
 *
 * This file defines the SHAPE of each tool — its name, description, and
 * what input arguments it accepts. These definitions are sent to the AI client
 * (e.g., Claude Desktop) so it knows what tools are available and how to call them.
 *
 * Each tool definition has:
 *   - name:         Unique identifier used to route calls in server.ts
 *   - description:  Human-readable text shown to the AI so it knows when to use the tool
 *   - inputSchema:  JSON Schema describing the accepted arguments (types, required fields, defaults)
 *
 * The corresponding IMPLEMENTATIONS (what the tools actually do) are in handlers.ts.
 *
 * Tool Categories:
 *   1. Search Tools       — brave_web_search, brave_local_search
 *   2. Code Mode Tools    — brave_web_search_code_mode, brave_local_search_code_mode, code_mode_transform
 *   3. AI Analysis Tools  — brave_answers, gemini_research_paper_analysis
 *   4. Session Memory     — defined separately in sessionMemoryDefinitions.ts (optional)
 *
 * Adding a new tool:
 *   1. Define it here (schema + type guard)
 *   2. Implement the handler in handlers.ts
 *   3. Export both from tools/index.ts
 *   4. Add a case to the switch statement in server.ts
 */

import { type Tool } from "@modelcontextprotocol/sdk/types.js";

// ─── Search Tools ─────────────────────────────────────────────

// Code Mode: Search + JavaScript extraction
// The "code mode" pattern works like this:
//   1. Perform a regular Brave search to get raw API JSON
//   2. Run user-provided JavaScript code against that JSON in a QuickJS sandbox
//   3. Return only the extracted/transformed output (much smaller than the full response)
// This dramatically reduces token usage when the AI only needs specific fields from search results.

export const BRAVE_WEB_SEARCH_CODE_MODE_TOOL: Tool = {
  name: "brave_web_search_code_mode",
  description:
    "Performs a web search using the Brave Search API, and then runs a custom JavaScript code string against the RAW API RESPONSE in a secure QuickJS sandbox. " +
    "This drastically reduces context window usage by only returning the output of your script. " +
    "Use this for broad information gathering, recent events, or when you need diverse web sources and only need specific parts of the result. " +
    "Your script should read the 'DATA' global variable (a JSON string of the API response), process it, and use console.log() to print the desired output.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query (max 400 chars, 50 words)",
      },
      count: {
        type: "number",
        description: "Number of results (1-20, default 10)",
        default: 10,
      },
      offset: {
        type: "number",
        description: "Pagination offset (max 9, default 0)",
        default: 0,
      },
      code: {
        type: "string",
        description: "JavaScript code to execute against the 'DATA' variable. E.g. `const r = JSON.parse(DATA); console.log(r.web.results.map(x => x.title).join(', '));`",
      },
      language: {
        type: "string",
        description: "Language of the code. Only 'javascript' is supported.",
        default: "javascript",
      }
    },
    required: ["query", "code"],
  },
};

// Standard web search — returns formatted text results (title, description, URL).
// This is the simplest search tool. For extracting specific fields, use the code mode variant above.
export const WEB_SEARCH_TOOL: Tool = {
  name: "brave_web_search",
  description:
    "Performs a web search using the Brave Search API, ideal for general queries, news, articles, and online content. " +
    "Use this for broad information gathering, recent events, or when you need diverse web sources. " +
    "Supports pagination, content filtering, and freshness controls. " +
    "Maximum 20 results per request, with offset for pagination. ",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query (max 400 chars, 50 words)",
      },
      count: {
        type: "number",
        description: "Number of results (1-20, default 10)",
        default: 10,
      },
      offset: {
        type: "number",
        description: "Pagination offset (max 9, default 0)",
        default: 0,
      },
    },
    required: ["query"],
  },
};

// ─── Local/Business Search Tools ──────────────────────────────

// Searches for physical businesses and places (restaurants, stores, services).
// Returns structured data: name, address, phone, rating, hours, price range.
// If no local results are found, automatically falls back to a regular web search.
export const LOCAL_SEARCH_TOOL: Tool = {
  name: "brave_local_search",
  description:
    "Searches for local businesses and places using Brave's Local Search API. " +
    "Best for queries related to physical locations, businesses, restaurants, services, etc. " +
    "Returns detailed information including:\n" +
    "- Business names and addresses\n" +
    "- Ratings and review counts\n" +
    "- Phone numbers and opening hours\n" +
    "Use this when the query implies 'near me' or mentions specific locations. " +
    "Automatically falls back to web search if no local results are found.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Local search query (e.g. 'pizza near Central Park')",
      },
      count: {
        type: "number",
        description: "Number of results (1-20, default 5)",
        default: 5,
      },
    },
    required: ["query"],
  },
};

// Code mode variant for local search — same pattern as web search code mode.
// Useful when you only need specific fields from the detailed POI (Point of Interest) data.
export const BRAVE_LOCAL_SEARCH_CODE_MODE_TOOL: Tool = {
  name: "brave_local_search_code_mode",
  description:
    "Performs a local search using Brave APIs, and then runs a custom JavaScript code string against the RAW API RESPONSE in a secure QuickJS sandbox. " +
    "This reduces context window usage by only returning the output of your script. " +
    "Use this for local/business lookups when you only need specific fields from large local payloads. " +
    "Your script should read the 'DATA' global variable (a JSON string payload) and use console.log() to print the desired output.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Local search query (e.g. 'pizza near Central Park')",
      },
      count: {
        type: "number",
        description: "Number of results (1-20, default 5)",
        default: 5,
      },
      code: {
        type: "string",
        description: "JavaScript code to execute against the 'DATA' variable.",
      },
      language: {
        type: "string",
        description: "Language of the code. Only 'javascript' is supported.",
        default: "javascript",
      },
    },
    required: ["query", "code"],
  },
};

// ─── Universal Transform Tool ─────────────────────────────────

// This is NOT tied to Brave Search — it works with output from ANY MCP tool.
// Pass it raw data from any source + a JavaScript extraction script,
// and it returns only the fields you need. Great for reducing token usage.
export const CODE_MODE_TRANSFORM_TOOL: Tool = {
  name: "code_mode_transform",
  description:
    "A universal code-mode transformer. Takes RAW TEXT or JSON output from ANY MCP tool (GitHub, Firecrawl, chrome-devtools, camoufox, codegraphcontext, videoMcp, arxiv, etc.) " +
    "and runs a custom JavaScript code string against it in a secure QuickJS sandbox. " +
    "Use this as a second step after calling any tool that returns large payloads — pass the raw output as 'data' and a JS extraction script as 'code'. " +
    "Your script reads the 'DATA' global variable (a string of the tool output) and uses console.log() to print only the fields you need. " +
    "NEW in v2.1: Pass 'template' instead of 'code' for instant extraction. " +
    "Available templates: github_issues, github_prs, jira_tickets, dom_links, dom_headings, api_endpoints, slack_messages, csv_summary. " +
    "Example: { data: '<raw JSON>', template: 'github_issues' } — no custom code needed.",
  inputSchema: {
    type: "object",
    properties: {
      data: {
        type: "string",
        description: "The raw text or JSON output from another MCP tool to process.",
      },
      code: {
        type: "string",
        description:
          "JavaScript code to execute. The 'DATA' global variable contains the raw data string. Use console.log() to output your extraction. " +
          "Optional if using a template.",
      },
      template: {
        type: "string",
        description:
          "Name of a pre-built extraction template. Use instead of writing custom 'code'. " +
          "Options: github_issues, github_prs, jira_tickets, dom_links, dom_headings, api_endpoints, slack_messages, csv_summary.",
      },
      language: {
        type: "string",
        description: "Language of the code. Only 'javascript' is supported.",
        default: "javascript",
      },
      source_tool: {
        type: "string",
        description: "Optional. Name of the MCP tool that produced the data (for logging/metrics only).",
      },
    },
    required: ["data"],
  },
};

// ─── AI Analysis Tools ────────────────────────────────────────

// AI-grounded answers — uses Brave's AI grounding endpoint (OpenAI-compatible API).
// Returns concise, web-grounded answers rather than raw search results.
// Requires a separate BRAVE_ANSWERS_API_KEY.
export const BRAVE_ANSWERS_TOOL: Tool = {
  name: "brave_answers",
  description:
    "Returns direct AI answers grounded in Brave Search using Brave AI Grounding. " +
    "Uses an OpenAI-compatible chat completions endpoint and is best for concise answer generation with live web grounding.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Question or prompt to answer",
      },
      model: {
        type: "string",
        description: "Model name for Brave AI Grounding (default: brave)",
        default: "brave",
      },
    },
    required: ["query"],
  },
};

// Analyzes academic research papers using Google's Gemini model.
// Supports multiple analysis types: summary, critique, literature review, key findings.
// Requires a configured text provider (Gemini, OpenAI, or Anthropic).
export const RESEARCH_PAPER_ANALYSIS_TOOL: Tool = {
  name: "gemini_research_paper_analysis",
  description:
    "Performs in-depth analysis of research papers using Google's Gemini-2.0-flash model. " +
    "Ideal for academic research, literature reviews, and deep understanding of scientific papers. " +
    "Can extract key findings, provide critical evaluation, summarize complex research, " +
    "and place papers within the broader research landscape. " +
    "Best for long-form academic content that requires expert analysis.",
  inputSchema: {
    type: "object",
    properties: {
      paperContent: {
        type: "string",
        description: "The full text of the research paper to analyze",
      },
      analysisType: {
        type: "string",
        description: "Type of analysis to perform (summary, critique, literature review, key findings, or comprehensive)",
        enum: ["summary", "critique", "literature review", "key findings", "comprehensive"],
        default: "comprehensive",
      },
      additionalContext: {
        type: "string",
        description: "Optional additional context or specific questions to guide the analysis",
      },
    },
    required: ["paperContent"],
  },
};

// ─── Type Guards ──────────────────────────────────────────────
//
// Type guards validate that incoming tool arguments match the expected shape.
// They are used by handlers to safely access argument properties without
// runtime errors. Each guard checks that required fields exist and are
// the correct type.
//
// Pattern: if (!isMyToolArgs(args)) throw new Error("Invalid arguments");

/** Validates arguments for brave_web_search */
export function isBraveWebSearchArgs(
  args: unknown
): args is { query: string; count?: number; offset?: number } {
  return (
    typeof args === "object" &&
    args !== null &&
    "query" in args &&
    typeof (args as { query: string }).query === "string"
  );
}

export function isBraveLocalSearchArgs(
  args: unknown
): args is { query: string; count?: number } {
  return (
    typeof args === "object" &&
    args !== null &&
    "query" in args &&
    typeof (args as { query: string }).query === "string"
  );
}

export function isBraveAnswersArgs(
  args: unknown
): args is { query: string; model?: string } {
  return (
    typeof args === "object" &&
    args !== null &&
    "query" in args &&
    typeof (args as { query: string }).query === "string"
  );
}

export function isGeminiResearchPaperAnalysisArgs(
  args: unknown
): args is { paperContent: string; analysisType?: string; additionalContext?: string } {
  return (
    typeof args === "object" &&
    args !== null &&
    "paperContent" in args &&
    typeof (args as { paperContent: string }).paperContent === "string"
  );
}

export function isBraveWebSearchCodeModeArgs(
  args: unknown
): args is { query: string; count?: number; offset?: number; code: string; language?: string } {
  return (
    typeof args === "object" &&
    args !== null &&
    "query" in args &&
    typeof (args as { query: string }).query === "string" &&
    "code" in args &&
    typeof (args as { code: string }).code === "string"
  );
}

export function isBraveLocalSearchCodeModeArgs(
  args: unknown
): args is { query: string; count?: number; code: string; language?: string } {
  return (
    typeof args === "object" &&
    args !== null &&
    "query" in args &&
    typeof (args as { query: string }).query === "string" &&
    "code" in args &&
    typeof (args as { code: string }).code === "string"
  );
}

export function isCodeModeTransformArgs(
  args: unknown
): args is { data: string; code?: string; template?: string; language?: string; source_tool?: string } {
  return (
    typeof args === "object" &&
    args !== null &&
    "data" in args &&
    typeof (args as { data: string }).data === "string"
  );
}
