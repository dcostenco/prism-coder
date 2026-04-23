/**
 * Local LLM Client — Ollama/prism-coder:7b Integration (v1.0.0)
 * ──────────────────────────────────────────────────────────────────
 * Thin HTTP wrapper around the Ollama /api/chat endpoint.
 *
 * DESIGN DECISIONS:
 *   - Non-streaming only: background ops (compaction, routing) need
 *     the full response before proceeding. Streaming is unnecessary.
 *   - Silent fail: returning null instead of throwing ensures callers
 *     can fall back to Gemini without crashing the MCP server.
 *   - Fire-and-forget safe: wrapped in try/catch, never propagates.
 *   - Default model: prism-coder:7b — fine-tuned on Prism tool schemas,
 *     8192-token context, Q8_0 quantization, ~8.1GB RAM footprint.
 *
 * FEATURE FLAG:
 *   Gated by PRISM_LOCAL_LLM_ENABLED env var (default: false).
 *   If Ollama is not reachable, this module silently returns null.
 *
 * USAGE:
 *   import { callLocalLlm } from "../utils/localLlm.js";
 *   const summary = await callLocalLlm("Summarize: ...");
 *   if (summary) { use(summary); } else { fallback to Gemini }
 */

import { debugLog } from "./logger.js";
import {
  PRISM_LOCAL_LLM_ENABLED,
  PRISM_LOCAL_LLM_MODEL,
  PRISM_LOCAL_LLM_URL,
  PRISM_LOCAL_LLM_TIMEOUT_MS,
} from "../config.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Redact credentials from a URL for safe logging (strips user:pass@). */
function redactUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "***";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "[invalid URL]";
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface OllamaToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: false;
  tools?: OllamaToolDef[];
  format?: Record<string, unknown>;
  options?: { num_ctx?: number; temperature?: number; top_p?: number };
}

interface OllamaChatResponse {
  message?: { content?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  error?: string;
}

// ─── Tool Schema Loader ──────────────────────────────────────────────────────

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

let _cachedTools: OllamaToolDef[] | null = null;

function loadToolDefinitions(): OllamaToolDef[] {
  if (_cachedTools) return _cachedTools;
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const schemaPath = path.resolve(thisDir, "../../training/data/tool_schema.json");
    if (fs.existsSync(schemaPath)) {
      const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
      _cachedTools = (schema.tools || []).map((t: any) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      debugLog(`[localLlm] Loaded ${_cachedTools!.length} tool definitions`);
      return _cachedTools!;
    }
  } catch (err) {
    debugLog(`[localLlm] Failed to load tool schema: ${err}`);
  }
  _cachedTools = [];
  return _cachedTools;
}

// ─── Core Function ────────────────────────────────────────────────────────────

/**
 * Call a local Ollama model and return the text response.
 *
 * @param userPrompt    - The user message to send.
 * @param model         - Ollama model tag. Defaults to PRISM_LOCAL_LLM_MODEL env var.
 * @param systemPrompt  - Optional system instruction. Defaults to Modelfile system prompt.
 * @returns             - Response string, or null on any failure.
 */
export async function callLocalLlm(
  userPrompt: string,
  model: string = PRISM_LOCAL_LLM_MODEL,
  systemPrompt?: string,
): Promise<string | null> {
  // ── Feature gate ──────────────────────────────────────────────────────────
  if (!PRISM_LOCAL_LLM_ENABLED) {
    debugLog("[localLlm] PRISM_LOCAL_LLM_ENABLED=false, skipping local LLM call");
    return null;
  }

  // ── Input validation ──────────────────────────────────────────────────────
  if (!userPrompt || !userPrompt.trim()) {
    debugLog("[localLlm] Empty prompt — skipping");
    return null;
  }

  // ── Build messages ────────────────────────────────────────────────────────
  const messages: OllamaChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: userPrompt });

  const payload: OllamaChatRequest = {
    model,
    messages,
    stream: false,
    options: { num_ctx: 8192, temperature: 0.3, top_p: 0.9 },
  };

  // Phase A: Pass tool definitions for native Ollama tool calling
  const tools = loadToolDefinitions();
  if (tools.length > 0) {
    payload.tools = tools;
  }

  // ── HTTP request ──────────────────────────────────────────────────────────
  const url = `${PRISM_LOCAL_LLM_URL}/api/chat`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PRISM_LOCAL_LLM_TIMEOUT_MS);

  try {
    debugLog(`[localLlm] Calling model="${model}" at ${redactUrl(url)} (timeout=${PRISM_LOCAL_LLM_TIMEOUT_MS}ms)`);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      // FIX (SSRF): reject 3xx redirects. A malicious Ollama endpoint (or MITM)
      // could redirect to internal services (e.g., AWS IMDS at 169.254.169.254).
      redirect: "error",
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      debugLog(`[localLlm] HTTP ${res.status} from Ollama: ${res.statusText}`);
      return null;
    }

    const data = await res.json() as OllamaChatResponse;

    if (data.error) {
      debugLog(`[localLlm] Ollama error: ${data.error}`);
      return null;
    }

    // Phase A: Check for native tool_calls FIRST (structured, no regex)
    if (data.message?.tool_calls && data.message.tool_calls.length > 0) {
      const tc = data.message.tool_calls[0];
      const toolCallJson = JSON.stringify({
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
      debugLog(`[localLlm] Native tool_call: ${tc.function.name}`);
      return toolCallJson;
    }

    // Fallback: parse text content (legacy format support)
    const rawContent = data.message?.content?.trim() ?? null;
    if (!rawContent) {
      debugLog("[localLlm] Empty content in Ollama response");
      return null;
    }

    // ── v11.5.1 Structural Processing ─────────────────────────
    // The local LLM may emit multiple formats depending on adapter:
    //   1. <|synalux_think|>...<|tool_call|>  (GRPO-aligned)
    //   2. <|im_start|>...<|im_end|>          (Qwen native ChatML)
    //   3. <think>...<tool_call>              (standard format)
    // We normalize all to return just the clean content/JSON.
    let content = rawContent;

    // Strip thinking blocks (all known formats)
    const thinkPatterns = [
      /<\|synalux_think\|>[\s\S]*?<\/\|synalux_think\|>\s*/,
      /<think>[\s\S]*?<\/think>\s*/,
    ];
    for (const pattern of thinkPatterns) {
      const m = content.match(pattern);
      if (m) {
        content = content.slice(m.index! + m[0].length).trim();
        break;
      }
    }

    // Extract tool call content (all known wrapper formats)
    const toolPatterns = [
      /<\|tool_call\|>([\s\S]*?)<\/\|tool_call\|>/,        // GRPO format
      /<tool_call>([\s\S]*?)<\/tool_call>/,                 // Standard format
      /<\|im_start\|>\s*(\{[\s\S]*?\})\s*<\|im_end\|>/,    // Qwen native
    ];
    for (const pattern of toolPatterns) {
      const m = content.match(pattern);
      if (m) {
        content = m[1].trim();
        break;
      }
    }

    debugLog(`[localLlm] Response received (${content.length} chars)`);
    return content;

  } catch (err) {
    clearTimeout(timeoutId);

    // AbortError = timeout
    if (err instanceof Error && err.name === "AbortError") {
      debugLog(`[localLlm] Timed out after ${PRISM_LOCAL_LLM_TIMEOUT_MS}ms — falling back`);
    } else {
      // Connection refused (Ollama not running) or other network error
      debugLog(`[localLlm] Network error: ${err instanceof Error ? err.message : String(err)}`);
    }

    return null;  // Silent fail — caller falls back to cloud LLM
  }
}

// ─── Availability Probe ───────────────────────────────────────────────────────

/**
 * Probe Ollama availability without making an LLM call.
 * Used for health checks and pre-flight validation.
 *
 * @returns true if Ollama responds to /api/tags within 3 seconds.
 */
export async function isLocalLlmAvailable(): Promise<boolean> {
  if (!PRISM_LOCAL_LLM_ENABLED) return false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${PRISM_LOCAL_LLM_URL}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}
