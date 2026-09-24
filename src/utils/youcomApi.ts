/**
 * You.com Web Search API Client
 *
 * Thin HTTP client for the You.com Search API. When YOUCOM_API_KEY is set,
 * the `youcom_web_search` tool becomes available as an optional alternative
 * to the built-in Brave search tools.
 *
 * You.com offers two access modes:
 *   1. Authenticated (YDC_API_KEY) — full web search + URL content extraction
 *   2. Keyless free tier — basic web search only (no API key needed)
 *
 * Authentication: Use the YDC_API_KEY environment variable.
 * Get a key at https://you.com/platform/api-keys
 */

import { YOUCOM_API_KEY } from "../config.js";
import { debugLog } from "./logger.js";

const YOUS_SEARCH_API = "https://api.you.com/api/v1/search";
const YOUCOM_API_KEY_MISSING_ERROR = "YOUCOM_API_KEY is not configured";

interface YouComSearchResult {
  title: string;
  url: string;
  description?: string;
  snippet?: string;
  date?: string;
}

interface YouComSearchResponse {
  results?: YouComSearchResult[];
  error?: string;
}

/**
 * Formats a single search result as a markdown-like text block,
 * matching the style used by the Brave search results in the codebase.
 */
function formatResult(result: YouComSearchResult, index: number): string {
  const lines: string[] = [];
  lines.push(`${index + 1}. ${result.title}`);
  lines.push(`   URL: ${result.url}`);
  if (result.description) {
    lines.push(`   Description: ${result.description}`);
  }
  if (result.date) {
    lines.push(`   Date: ${result.date}`);
  }
  return lines.join("\n");
}

/**
 * Performs a web search using the You.com Search API and returns
 * formatted text results (title, URL, description).
 *
 * Gated on YOUCOM_API_KEY being set; callers should check the
 * exported constant before registering the tool.
 */
export async function performYouComSearch(
  query: string,
  count: number = 10,
): Promise<string> {
  if (!YOUCOM_API_KEY) {
    throw new Error(YOUCOM_API_KEY_MISSING_ERROR);
  }

  const params = new URLSearchParams({
    query,
  });
  if (count > 0) {
    params.set("count", String(Math.min(count, 20)));
  }

  const url = `${YOUS_SEARCH_API}?${params.toString()}`;
  debugLog(`[youcomApi] searching: query_chars=${query.length}, count=${count}`);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${YOUCOM_API_KEY}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    debugLog(`[youcomApi] network error: ${err?.message ?? err}`);
    throw new Error(`You.com search failed (network): ${err?.message ?? "unknown error"}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    debugLog(`[youcomApi] HTTP ${response.status}: ${body.slice(0, 200)}`);
    throw new Error(
      `You.com search returned HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`
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

  const results = data.results ?? [];
  if (results.length === 0) {
    return `No results found for "${query}".\n`;
  }

  const formatted = results.map((r, i) => formatResult(r, i));
  const header = `You.com search results for "${query}":\n${"=".repeat(60)}\n\n`;
  return header + formatted.join("\n\n") + "\n";
}

/**
 * Returns true when YOUCOM_API_KEY is set, so callers can conditionally
 * register the youcom_web_search tool.
 */
export function youcomSearchAvailable(): boolean {
  return !!YOUCOM_API_KEY;
}