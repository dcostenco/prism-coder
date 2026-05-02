/**
 * Brave Search API Client
 *
 * This module handles all communication with Brave's Search APIs.
 * Brave offers three search endpoints used by this server:
 *
 *   1. Web Search API (/v1/web/search)
 *      - Standard internet search returning titles, descriptions, URLs
 *      - Used by: brave_web_search, brave_web_search_code_mode
 *
 *   2. Local/POI Search API (/v1/local/pois + /v1/local/descriptions)
 *      - Business/place search returning addresses, ratings, hours, etc.
 *      - Uses a 3-step pipeline:  web search (to get location IDs)
 *                                  → POI details (address, phone, hours)
 *                                  → descriptions (business text)
 *      - Used by: brave_local_search, brave_local_search_code_mode
 *
 *   3. AI Grounding / Chat Completions API (/v1/chat/completions)
 *      - OpenAI-compatible endpoint for AI-grounded answers
 *      - Used by: brave_answers
 *
 * Each function comes in two variants:
 *   - "Raw" version (e.g., performWebSearchRaw): Returns raw JSON string from API
 *     Used by code-mode handlers that need to pass raw data to the QuickJS sandbox
 *   - "Formatted" version (e.g., performWebSearch): Returns human-readable text
 *     Used by standard search handlers
 *
 * Authentication: All requests use the BRAVE_API_KEY via X-Subscription-Token header.
 * The Brave Answers endpoint uses a separate BRAVE_ANSWERS_API_KEY via Bearer token.
 */

import { BRAVE_API_KEY, BRAVE_ANSWERS_API_KEY } from "../config.js";

// ─── TypeScript Interfaces for Brave API Responses ────────────
// These types match the shape of Brave's JSON responses so we get
// type safety when accessing fields like data.web.results[0].title
export interface BraveWeb {
  web?: {
    results?: Array<{
      title: string;
      description: string;
      url: string;
      language?: string;
      published?: string;
      rank?: number;
    }>;
  };
  locations?: {
    results?: Array<{
      id: string;
      title?: string;
    }>;
  };
}

export interface BraveLocation {
  id: string;
  name?: string;
  title?: string;
  address: {
    streetAddress?: string;
    addressLocality?: string;
    addressRegion?: string;
    postalCode?: string;
  };
  coordinates?: {
    latitude: number;
    longitude: number;
  };
  phone?: string;
  rating?: {
    ratingValue?: number;
    ratingCount?: number;
  };
  openingHours?: string[];
  priceRange?: string;
}

export interface BravePoiResponse {
  results: BraveLocation[];
}

export interface BraveDescription {
  descriptions: { [id: string]: string };
}

interface BraveAnswersMessage {
  role: "user" | "system" | "assistant";
  content: string;
}

interface BraveAnswersResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
  }>;
}

// Brave Answers API call (AI Grounding/OpenAI-compatible)
export async function performBraveAnswers(
  query: string,
  model: string = "brave"
) {
  if (!BRAVE_ANSWERS_API_KEY) {
    throw new Error("BRAVE_ANSWERS_API_KEY is not configured");
  }

  const url = new URL("https://api.search.brave.com/res/v1/chat/completions");
  const messages: BraveAnswersMessage[] = [{ role: "user", content: query }];

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${BRAVE_ANSWERS_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `Brave Answers API error: ${response.status} ${response.statusText
      }\n${await response.text()}`
    );
  }

  const data = (await response.json()) as BraveAnswersResponse;
  const content = data.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new Error("Brave Answers API returned an empty response");
  }

  return content;
}

// Raw web search API call
export async function performWebSearchRaw(
  query: string,
  count: number = 10,
  offset: number = 0
): Promise<string> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", Math.min(count, 20).toString()); // API limit
  url.searchParams.set("offset", offset.toString());

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": BRAVE_API_KEY!,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `Brave API error: ${response.status} ${response.statusText
      }\n${await response.text()}`
    );
  }

  return await response.text();
}

// Web search API call
export async function performWebSearch(
  query: string,
  count: number = 10,
  offset: number = 0
) {
  const textData = await performWebSearchRaw(query, count, offset);
  const data = JSON.parse(textData) as BraveWeb;

  // Extract just web results
  const results = (data.web?.results || []).map((result) => ({
    title: result.title || "",
    description: result.description || "",
    url: result.url || "",
  }));

  return results
    .map(
      (r) => `Title: ${r.title}\nDescription: ${r.description}\nURL: ${r.url}`
    )
    .join("\n\n");
}

// Get POI details
export async function getPoisData(ids: string[]): Promise<BravePoiResponse> {
  const url = new URL("https://api.search.brave.com/res/v1/local/pois");
  ids.filter(Boolean).forEach((id) => url.searchParams.append("ids", id));
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": BRAVE_API_KEY!,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `Brave API error: ${response.status} ${response.statusText
      }\n${await response.text()}`
    );
  }

  return (await response.json()) as BravePoiResponse;
}

// Get descriptions data
export async function getDescriptionsData(
  ids: string[]
): Promise<BraveDescription> {
  const url = new URL("https://api.search.brave.com/res/v1/local/descriptions");
  ids.filter(Boolean).forEach((id) => url.searchParams.append("ids", id));
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": BRAVE_API_KEY!,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `Brave API error: ${response.status} ${response.statusText
      }\n${await response.text()}`
    );
  }

  return (await response.json()) as BraveDescription;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// Raw local search API call with poi/details payload
export async function performLocalSearchRaw(
  query: string,
  count: number = 5
): Promise<string> {
  // Initial search to get location IDs
  const webUrl = new URL("https://api.search.brave.com/res/v1/web/search");
  webUrl.searchParams.set("q", query);
  webUrl.searchParams.set("search_lang", "en");
  webUrl.searchParams.set("result_filter", "locations");
  webUrl.searchParams.set("count", Math.min(count, 20).toString());

  const webResponse = await fetch(webUrl, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": BRAVE_API_KEY!,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!webResponse.ok) {
    throw new Error(
      `Brave API error: ${webResponse.status} ${webResponse.statusText
      }\n${await webResponse.text()}`
    );
  }

  const webData = (await webResponse.json()) as BraveWeb;
  const locationIds =
    webData.locations?.results
      ?.filter((r): r is { id: string; title?: string } => r.id != null)
      .map((r) => r.id) || [];

  if (locationIds.length === 0) {
    const fallback = await performWebSearch(query, count);
    return JSON.stringify({
      source: "web_fallback",
      query,
      count,
      formattedText: fallback,
    });
  }

  // Batch IDs to avoid Brave query.ids validation errors
  const uniqueIds = [...new Set(locationIds)];
  const idBatches = chunkArray(uniqueIds, 5);

  const [poisBatches, descBatches] = await Promise.all([
    Promise.all(idBatches.map((ids) => getPoisData(ids))),
    Promise.all(idBatches.map((ids) => getDescriptionsData(ids))),
  ]);

  const poisData: BravePoiResponse = {
    results: poisBatches.flatMap((batch) => batch.results || []),
  };

  const descriptionsData: BraveDescription = {
    descriptions: Object.assign(
      {},
      ...descBatches.map((batch) => batch.descriptions || {})
    ),
  };

  return JSON.stringify({
    source: "local",
    query,
    count,
    locationIds,
    poisData,
    descriptionsData,
  });
}

// Local search API call with poi details
export async function performLocalSearch(query: string, count: number = 5) {
  const rawData = await performLocalSearchRaw(query, count);
  const parsed = JSON.parse(rawData) as {
    source: "local" | "web_fallback";
    formattedText?: string;
    poisData?: BravePoiResponse;
    descriptionsData?: BraveDescription;
  };

  if (parsed.source === "web_fallback") {
    return parsed.formattedText || "No local results found";
  }

  return formatLocalResults(
    parsed.poisData || { results: [] },
    parsed.descriptionsData || { descriptions: {} }
  );
}

// Format local search results
export function formatLocalResults(
  poisData: BravePoiResponse,
  descData: BraveDescription
): string {
  return (
    (poisData.results || [])
      .map((poi) => {
        const address =
          [
            poi.address?.streetAddress ?? "",
            poi.address?.addressLocality ?? "",
            poi.address?.addressRegion ?? "",
            poi.address?.postalCode ?? "",
          ]
            .filter((part) => part !== "")
            .join(", ") || "N/A";

        return `Name: ${poi.name || poi.title || "N/A"}
Address: ${address}
Phone: ${poi.phone || "N/A"}
Rating: ${poi.rating?.ratingValue ?? "N/A"} (${poi.rating?.ratingCount ?? 0
          } reviews)
Price Range: ${poi.priceRange || "N/A"}
Hours: ${(poi.openingHours || []).join(", ") || "N/A"}
Description: ${descData.descriptions[poi.id] || "No description available"}
`;
      })
      .join("\n---\n") || "No local results found"
  );
}
