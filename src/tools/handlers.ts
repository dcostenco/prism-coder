/**
 * Tool Handlers (Implementations)
 *
 * This file contains the actual LOGIC for each tool. Each handler:
 *   1. Validates arguments using a type guard from definitions.ts
 *   2. Calls the appropriate API client from utils/
 *   3. Returns a formatted MCP response { content: [...], isError: boolean }
 *
 * Handler pattern:
 *   - Every handler returns { content: [{ type: "text", text: "..." }], isError: false }
 *   - On error, either throw (caught by server.ts) or return { isError: true }
 *   - All logging goes to console.error (stderr) to avoid corrupting the MCP protocol on stdout
 *
 * Code Mode handlers follow a 3-step pipeline:
 *   Step 1: Fetch raw API data (full JSON response from Brave Search)
 *   Step 2: Run user-provided JavaScript against that data in a QuickJS sandbox
 *   Step 3: Return only the script's output + size reduction metrics
 *
 * The size reduction header (e.g., "12.5KB -> 0.3KB (97.6% reduction)")
 * helps the AI understand how much token budget was saved.
 */

import { performWebSearch, performWebSearchRaw, performLocalSearch, performLocalSearchRaw, performBraveAnswers } from "../utils/braveApi.js";
import { getLLMProvider } from "../utils/llm/factory.js";
import { 
  isBraveWebSearchArgs, 
  isBraveLocalSearchArgs, 
  isBraveAnswersArgs, 
  isGeminiResearchPaperAnalysisArgs, 
  isBraveWebSearchCodeModeArgs, 
  isBraveLocalSearchCodeModeArgs, 
  isCodeModeTransformArgs,
  isScholarResearchArgs,
} from "./definitions.js";
import { runInSandbox } from "../utils/executor.js";
import { CODE_MODE_TEMPLATES, getTemplateNames } from "../templates/codeMode.js";
import { debugLog } from "../utils/logger.js";
import { runWebScholar } from "../scholar/webScholar.js";

// ─── Simple Search Handlers ──────────────────────────────────

/** Performs a standard web search and returns formatted text results. */
export async function webSearchHandler(args: unknown) {
  if (!isBraveWebSearchArgs(args)) {
    throw new Error("Invalid arguments for brave_web_search");
  }

  const { query, count = 10, offset = 0 } = args;
  const results = await performWebSearch(query, count, offset);

  return {
    content: [{ type: "text", text: results }],
    isError: false,
  };
}

// ─── Code Mode Handlers ──────────────────────────────────────
// These handlers use the 3-step pipeline: fetch → sandbox → reduce

/**
 * Web search + JavaScript extraction.
 * Fetches raw search results, runs user code in QuickJS sandbox,
 * and returns the extracted output with size reduction metrics.
 */
export async function braveWebSearchCodeModeHandler(args: unknown) {
  if (!isBraveWebSearchCodeModeArgs(args)) {
    throw new Error("Invalid arguments for brave_web_search_code_mode");
  }

  const { query, count = 10, offset = 0, code, language = "javascript" } = args;

  if (language.toLowerCase() !== "javascript") {
    return {
      content: [{ type: "text", text: "Unsupported language. Only 'javascript' is supported." }],
      isError: true,
    };
  }

  // 1. Fetch raw data
  debugLog(`Fetching web search for code mode: "${query}"`);
  const rawDataStr = await performWebSearchRaw(query, count, offset);
  const beforeSizeKB = (Buffer.byteLength(rawDataStr, 'utf8') / 1024).toFixed(1);

  // 2. Run code mode sandbox
  debugLog(`Executing code mode sandbox...`);
  const { stdout, error, executionTimeMs } = await runInSandbox(rawDataStr, code);

  if (error) {
    return {
      content: [{ type: "text", text: `Sandboxed Execution Failed:\n${error}` }],
      isError: true,
    };
  }

  // 3. Compute reduction
  const finalOutput = stdout.trim() || "[No output from script]";
  const afterSizeKB = (Buffer.byteLength(finalOutput, 'utf8') / 1024).toFixed(1);
  const reductionPct = (100 - (Number(afterSizeKB) / Number(beforeSizeKB)) * 100).toFixed(1);

  const header = `[code-mode: ${beforeSizeKB}KB -> ${afterSizeKB}KB (${reductionPct}% reduction) in ${executionTimeMs}ms]\n\n`;

  return {
    content: [{ type: "text", text: header + finalOutput }],
    isError: false,
  };
}

/**
 * Local search + JavaScript extraction.
 * Same pattern as web search code mode, but uses Brave's local/POI search.
 */
export async function braveLocalSearchCodeModeHandler(args: unknown) {
  if (!isBraveLocalSearchCodeModeArgs(args)) {
    throw new Error("Invalid arguments for brave_local_search_code_mode");
  }

  const { query, count = 5, code, language = "javascript" } = args;

  if (language.toLowerCase() !== "javascript") {
    return {
      content: [{ type: "text", text: "Unsupported language. Only 'javascript' is supported." }],
      isError: true,
    };
  }

  debugLog(`Fetching local search for code mode: "${query}"`);
  const rawDataStr = await performLocalSearchRaw(query, count);
  const beforeSizeKB = (Buffer.byteLength(rawDataStr, "utf8") / 1024).toFixed(1);

  debugLog("Executing local search code mode sandbox...");
  const { stdout, error, executionTimeMs } = await runInSandbox(rawDataStr, code);

  if (error) {
    return {
      content: [{ type: "text", text: `Sandboxed Execution Failed:\n${error}` }],
      isError: true,
    };
  }

  const finalOutput = stdout.trim() || "[No output from script]";
  const afterSizeKB = (Buffer.byteLength(finalOutput, "utf8") / 1024).toFixed(1);
  const reductionPct = (100 - (Number(afterSizeKB) / Number(beforeSizeKB)) * 100).toFixed(1);

  const header = `[code-mode: ${beforeSizeKB}KB -> ${afterSizeKB}KB (${reductionPct}% reduction) in ${executionTimeMs}ms]\n\n`;

  return {
    content: [{ type: "text", text: header + finalOutput }],
    isError: false,
  };
}

// ─── Universal Transform Handler ─────────────────────────────

/**
 * Takes raw output from ANY MCP tool + a JavaScript extraction script OR template.
 * If `template` is provided, substitutes the pre-built script before running sandbox.
 * Not tied to Brave Search — works with any text/JSON data.
 */
export async function codeModeTransformHandler(args: unknown) {
  if (!isCodeModeTransformArgs(args)) {
    throw new Error("Invalid arguments for code_mode_transform");
  }

  const { data, language = "javascript", source_tool = "unknown" } = args;

  if (language.toLowerCase() !== "javascript") {
    return {
      content: [{ type: "text", text: "Unsupported language. Only 'javascript' is supported." }],
      isError: true,
    };
  }

  // ─── Resolve script: template takes priority over custom code ───
  let scriptToRun = args.code;
  let templateUsed = "custom";

  if (args.template) {
    const tmpl = CODE_MODE_TEMPLATES[args.template];
    if (!tmpl) {
      return {
        content: [{ type: "text", text: `Unknown template '${args.template}'. Available templates: ${getTemplateNames().join(", ")}` }],
        isError: true,
      };
    }
    scriptToRun = tmpl;
    templateUsed = args.template;
  }

  if (!scriptToRun) {
    return {
      content: [{ type: "text", text: `You must provide either 'code' or a valid 'template'. Available templates: ${getTemplateNames().join(", ")}` }],
      isError: true,
    };
  }

  const beforeSizeKB = (Buffer.byteLength(data, "utf8") / 1024).toFixed(1);
  debugLog(`[code_mode_transform] source=${source_tool}, template=${templateUsed}, input=${beforeSizeKB}KB`);

  const { stdout, error, executionTimeMs } = await runInSandbox(data, scriptToRun);

  if (error) {
    return {
      content: [{ type: "text", text: `Sandboxed Execution Failed:\n${error}` }],
      isError: true,
    };
  }

  const finalOutput = stdout.trim() || "[No output from script]";
  const afterSizeKB = (Buffer.byteLength(finalOutput, "utf8") / 1024).toFixed(1);
  const reductionPct = (100 - (Number(afterSizeKB) / Number(beforeSizeKB)) * 100).toFixed(1);

  const header = `[code-mode-transform (${source_tool}${templateUsed !== "custom" ? `, template: ${templateUsed}` : ""}): ${beforeSizeKB}KB -> ${afterSizeKB}KB (${reductionPct}% reduction) in ${executionTimeMs}ms]\n\n`;

  return {
    content: [{ type: "text", text: header + finalOutput }],
    isError: false,
  };
}

// ─── Simple Lookup Handlers ─────────────────────────────────

/** Searches for local businesses and returns formatted POI details. */
export async function localSearchHandler(args: unknown) {
  if (!isBraveLocalSearchArgs(args)) {
    throw new Error("Invalid arguments for brave_local_search");
  }

  const { query, count = 5 } = args;
  const results = await performLocalSearch(query, count);

  return {
    content: [{ type: "text", text: results }],
    isError: false,
  };
}

/** Returns AI-grounded answers using Brave's chat completions endpoint. */
export async function braveAnswersHandler(args: unknown) {
  if (!isBraveAnswersArgs(args)) {
    throw new Error("Invalid arguments for brave_answers");
  }

  const { query, model = "brave" } = args;
  const answer = await performBraveAnswers(query, model);

  return {
    content: [{ type: "text", text: answer }],
    isError: false,
  };
}

// ─── Research Paper Analysis ─────────────────────────────────

/**
 * Analyzes a research paper using Google Gemini.
 * Supports multiple analysis types (summary, critique, etc.).
 * Validates minimum paper length (100 chars) to avoid meaningless analysis.
 */
export async function researchPaperAnalysisHandler(args: unknown) {
  if (!isGeminiResearchPaperAnalysisArgs(args)) {
    throw new Error("Invalid arguments for gemini_research_paper_analysis");
  }

  const { paperContent, analysisType = "comprehensive", additionalContext } = args;

  // Check if paper content is too short
  if (paperContent.length < 100) {
    return {
      content: [{
        type: "text",
        text: "The provided paper content is too short for meaningful analysis. Please provide more comprehensive text."
      }],
      isError: true,
    };
  }

  try {
    debugLog(`Analyzing research paper (${analysisType} analysis)...`);

    // Build the analysis prompt (mirrors the original analyzePaperWithGemini logic)
    let prompt = `I need you to perform a detailed ${analysisType} analysis of the following research paper.\n\n`;
    if (additionalContext) {
      prompt += `Additional context: ${additionalContext}\n\n`;
    }
    prompt += `Research paper content:\n${paperContent}\n\n`;
    switch (analysisType.toLowerCase()) {
      case "summary":
        prompt += "Provide a comprehensive summary including the research question, methodology, key findings, and conclusions.";
        break;
      case "critique":
        prompt += "Provide a critical evaluation of the research methodology, validity of findings, limitations, and suggestions for improvement.";
        break;
      case "literature review":
        prompt += "Analyze how this paper fits into the broader research landscape, identifying key related works and research gaps.";
        break;
      case "key findings":
        prompt += "Extract and explain the most significant findings and their implications.";
        break;
      default:
        prompt += "Perform a comprehensive analysis including summary, methodology assessment, key findings, limitations, and significance.";
    }

    const llm = getLLMProvider();
    const analysis = await llm.generateText(prompt);

    return {
      content: [{ type: "text", text: analysis }],
      isError: false,
    };
  } catch (error) {
    console.error("Research paper analysis error:", error);
    return {
      content: [{
        type: "text",
        text: `Error analyzing research paper: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true,
    };
  }
}
