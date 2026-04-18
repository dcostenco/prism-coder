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

// ─── Types ────────────────────────────────────────────────────────────────────

interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: false;  // always non-streaming for background ops
  options?: {
    num_ctx?: number;
    temperature?: number;
    top_p?: number;
  };
}

interface OllamaChatResponse {
  message?: { content?: string };
  done?: boolean;
  error?: string;
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
    options: {
      num_ctx: 8192,    // match Modelfile context window
      temperature: 0.3, // match Modelfile temperature
      top_p: 0.9,       // match Modelfile top_p
    },
  };

  // ── HTTP request ──────────────────────────────────────────────────────────
  const url = `${PRISM_LOCAL_LLM_URL}/api/chat`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PRISM_LOCAL_LLM_TIMEOUT_MS);

  try {
    debugLog(`[localLlm] Calling model="${model}" at ${url} (timeout=${PRISM_LOCAL_LLM_TIMEOUT_MS}ms)`);

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

    const content = data.message?.content?.trim() ?? null;
    if (!content) {
      debugLog("[localLlm] Empty content in Ollama response");
      return null;
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
