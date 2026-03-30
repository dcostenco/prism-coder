/**
 * Tavily API Client
 *
 * This module provides Tavily Search and Extract helpers for the Web Scholar
 * pipeline. It serves as an additive alternative to Brave Search + Firecrawl
 * when TAVILY_API_KEY is set.
 *
 *   1. performTavilySearch — Web search returning URLs (mirrors Brave web search)
 *   2. performTavilyExtract — URL content extraction returning markdown (mirrors Firecrawl scrape)
 */

import { tavily } from "@tavily/core";

function getClient(apiKey: string) {
  return tavily({ apiKey });
}

// ─── Search ──────────────────────────────────────────────────

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

/**
 * Searches the web via Tavily and returns an array of result objects.
 */
export async function performTavilySearch(
  apiKey: string,
  query: string,
  maxResults: number = 10
): Promise<TavilySearchResult[]> {
  const client = getClient(apiKey);
  const response = await client.search(query, {
    maxResults,
    searchDepth: "advanced",
    topic: "general",
  });

  return (response.results || []).map((r: any) => ({
    title: r.title || "",
    url: r.url || "",
    content: r.content || "",
    score: r.score ?? 0,
  }));
}

// ─── Extract ─────────────────────────────────────────────────

export interface TavilyExtractResult {
  url: string;
  rawContent: string;
}

/**
 * Extracts article content from URLs via Tavily Extract.
 * Returns markdown content for each successfully extracted URL.
 */
export async function performTavilyExtract(
  apiKey: string,
  urls: string[]
): Promise<TavilyExtractResult[]> {
  if (urls.length === 0) return [];

  const client = getClient(apiKey);
  // Tavily extract accepts up to 20 URLs at once
  const batch = urls.slice(0, 20);
  const response = await client.extract(batch, {
    extractDepth: "basic",
  });

  return (response.results || []).map((r: any) => ({
    url: r.url || "",
    rawContent: r.rawContent || "",
  }));
}
