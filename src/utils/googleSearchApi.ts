import { debugLog } from "./logger.js";

/**
 * Google Custom Search API Utility
 * ===============================
 *
 * Performs a web search using the Google Custom Search JSON API.
 * Requires: API Key and Search Engine ID (CX).
 *
 * @param apiKey - Google Search API Key
 * @param cx - Search Engine ID (CX)
 * @param query - The search query
 * @param count - Number of results to return (max 10)
 * @returns Array of result objects { title, url, snippet }
 */
export async function performGoogleSearch(
  apiKey: string,
  cx: string,
  query: string,
  count: number = 5
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  try {
    const safeCount = Math.min(Math.max(1, count), 10);
    const url = new URL("https://customsearch.googleapis.com/customsearch/v1");
    url.searchParams.append("key", apiKey);
    url.searchParams.append("cx", cx);
    url.searchParams.append("q", query);
    url.searchParams.append("num", safeCount.toString());

    const response = await fetch(url.toString());
    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Google Search API failed: ${JSON.stringify(error)}`);
    }

    const data = await response.json();
    const items = data.items || [];

    return items.map((item: any) => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet,
    }));
  } catch (err) {
    debugLog(`[GoogleSearch] Error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
