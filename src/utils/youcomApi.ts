/**
 * You.com Web Search API Client
 *
 * Thin HTTP client for the You.com Search API. When YDC_API_KEY is set,
 * the `youcom_web_search` tool becomes available as an optional alternative
 * to the built-in Brave search tools.
 *
 * Authentication uses the X-API-Key header with the YDC_API_KEY env var.
 * Get a key at https://you.com/platform/api-keys
 *
 * API docs: https://you.com/docs/api-reference/search/v1-search
 */

import { YDC_API_KEY } from "../config.js";
import { debugLog } from "./logger.js";

const YOUCOM_SEARCH_API = "https://ydc-index.io/v1/search";
const YDC_API_KEY_MISSING_ERROR = "YDC_API_KEY is not configured";

interface YouComSearchWebResult {
  title: string;
  url: string;
  description?: string;
  snippets?: string[];
}

/** The documented API response shape. `results` wraps the web/news arrays. */
interface YouComSearchResponse {
  results?: {
    web?: YouComSearchWebResult[];
    news?: YouComSearchWebResult[];
  };
  metadata?: Record<string, unknown>;
  error?: string;
}

interface YouComApiError {
  error?: string;
  message?: string;
}

/**
 * Formats a single search result as a markdown-like text block,
 * matching the style used by the Brave search results in the codebase.
 */
function formatResult(result: YouComSearchWebResult, index: number): string {
  const lines: string[] = [];
  lines.push(`${index + 1}. ${result.title}`);
  lines.push(`   URL: ${result.url}`);
  if (result.description) {
    let desc = result.description;
    // Append first snippet as extra detail when the description is short
    if (result.snippets?.length && desc.length < 200) {
      desc += ` — ${result.snippets[0]}`;
    }
    lines.push(`   Description: ${desc}`);
  } else if (result.snippets?.length) {
    lines.push(`   Description: ${result.snippets[0]}`);
  }
  return lines.join("\n");
}

/**
 * Performs a web search using the You.com Search API and returns
 * formatted text results (title, URL, description).
 *
 * Gated on YDC_API_KEY being set; callers should check the
 * exported constant before registering the tool.
 */
export async function performYouComSearch(
  query: string,
  count: number = 10,
): Promise<string> {
  if (!YDC_API_KEY) {
    throw new Error(YDC_API_KEY_MISSING_ERROR);
  }

  const body = {
    query,
    count: Math.max(1, Math.min(count ?? 10, 20)),
  };

  debugLog(`[youcomApi] searching: query_chars=${query.length}, count=${body.count}`);

  let response: Response;
  try {
    response = await fetch(YOUCOM_SEARCH_API, {
      method: "POST",
      headers: {
        "X-API-Key": YDC_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    debugLog(`[youcomApi] network error: ${err?.message ?? err}`);
    throw new Error(`You.com search failed (network): ${err?.message ?? "unknown error"}`);
  }

  if (!response.ok) {
    let errorInfo: string;
    try {
      const errBody: YouComApiError = await response.json() as YouComApiError;
      errorInfo = errBody?.message ?? errBody?.error ?? response.statusText;
    } catch {
      errorInfo = await response.text().catch(() => response.statusText);
    }
    debugLog(`[youcomApi] HTTP ${response.status}: ${errorInfo.slice(0, 200)}`);
    throw new Error(
      `You.com search returned HTTP ${response.status}${errorInfo ? `: ${errorInfo.slice(0, 200)}` : ""}`
    );
  }

  let data: YouComSearchResponse;
  try {
    data = (await response.json()) as YouComSearchResponse;
  } catch (err: any) {
    debugLog(`[youcomApi] JSON parse error: ${err?.message ?? err}`);
    throw new Error("You.com search returned invalid JSON");
  }

  if (data.error) {
    debugLog(`[youcomApi] API error: ${data.error}`);
    throw new Error(`You.com search API error: ${data.error}`);
  }

  // The documented response wraps arrays under `results`.
  const results: YouComSearchWebResult[] = (data.results?.web ?? []);
  if (results.length === 0) {
    // Fall back to news if web is empty
    const newsResults = data.results?.news ?? [];
    if (newsResults.length === 0) {
      return `No results found for "${query}".\n`;
    }
    const formatted = newsResults.map((r, i) => formatResult(r, i));
    const header = `You.com news results for "${query}":\n${"=".repeat(60)}\n\n`;
    return header + formatted.join("\n\n") + "\n";
  }

  const formatted = results.map((r, i) => formatResult(r, i));
  const header = `You.com search results for "${query}":\n${"=".repeat(60)}\n\n`;
  return header + formatted.join("\n\n") + "\n";
}

/**
 * Returns true when YDC_API_KEY is set, so callers can conditionally
 * register the youcom_web_search tool.
 */
export function youcomSearchAvailable(): boolean {
  return !!YDC_API_KEY;
}