/**
 * Synalux Portal Search & Scrape Client
 * ─────────────────────────────────────────────────────────────
 * Routes web search and scrape calls through the Synalux portal
 * so API keys (Brave, Firecrawl, etc.) live server-side. The
 * portal endpoints:
 *
 *   POST /api/v1/prism/search  — { query, limit? }
 *        returns { status, results: [{title, url, description}], source }
 *
 *   POST /api/v1/prism/scrape  — { url, formats?, onlyMainContent?, waitFor? }
 *        returns { status, content }
 *
 * Auth uses the shared JWT exchange from synaluxJwt.ts (same
 * refresh-token dance as SynaluxStorage, but without requiring
 * the full storage class). Falls back gracefully: callers check
 * SYNALUX_SEARCH_AVAILABLE before calling.
 */

import { debugLog } from "./logger.js";
import { getSynaluxJwt, invalidateSynaluxJwt } from "./synaluxJwt.js";
import {
  PRISM_SYNALUX_BASE_URL,
  SYNALUX_CONFIGURED,
} from "../config.js";

// ─── Public availability flag ────────────────────────────────
/** True when Synalux portal credentials are configured. */
export const SYNALUX_SEARCH_AVAILABLE: boolean = SYNALUX_CONFIGURED;

// ─── Types ───────────────────────────────────────────────────

interface SynaluxSearchResult {
  title: string;
  url: string;
  description: string;
}

interface SynaluxLocalResult {
  name: string;
  address: string;
  phone: string;
  rating: string;
  hours: string;
  description: string;
}

interface SynaluxLocalSearchResponse {
  status: string;
  results?: SynaluxLocalResult[];
  error?: string;
}

interface SynaluxAnswersResponse {
  status: string;
  answer?: string;
  error?: string;
}

interface SynaluxSearchResponse {
  status: string;
  results?: SynaluxSearchResult[];
  source?: string;
  error?: string;
}

interface SynaluxScrapeOptions {
  formats?: string[];
  onlyMainContent?: boolean;
  waitFor?: number;
}

interface SynaluxScrapeResponse {
  status: string;
  content?: string;
  error?: string;
}

// ─── Internal helpers ────────────────────────────────────────

/**
 * POST to a portal endpoint with JWT auth. Retries once on 401
 * (JWT may have just expired). Throws on network or HTTP errors.
 */
async function portalPost<T>(path: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  const baseUrl = PRISM_SYNALUX_BASE_URL!.replace(/\/+$/, "");
  const url = `${baseUrl}${path}`;

  const send = async (jwt: string): Promise<Response> => {
    return fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${jwt}`,
        "X-Prism-Client": "prism-mcp-search",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  };

  let jwt = await getSynaluxJwt();
  if (!jwt) {
    throw new Error("[synaluxSearch] JWT exchange failed — no token available");
  }

  let res = await send(jwt);

  // Retry once on 401 (stale JWT)
  if (res.status === 401) {
    debugLog("[synaluxSearch] 401 on first attempt, re-exchanging JWT");
    invalidateSynaluxJwt();
    jwt = await getSynaluxJwt();
    if (!jwt) {
      throw new Error("[synaluxSearch] JWT re-exchange failed after 401");
    }
    res = await send(jwt);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`[synaluxSearch] ${path} HTTP ${res.status}: ${text}`);
  }

  return (await res.json()) as T;
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Web search via Synalux portal. Returns formatted text matching
 * the shape of performWebSearch() in braveApi.ts.
 */
export async function synaluxWebSearch(query: string, count: number = 10): Promise<string> {
  debugLog(`[synaluxSearch] web search: q="${query}", limit=${count}`);

  const data = await portalPost<SynaluxSearchResponse>("/api/v1/prism/search", {
    query,
    limit: Math.min(count, 20),
  });

  if (data.status === "error") {
    throw new Error(`[synaluxSearch] portal error: ${data.error || "unknown"}`);
  }

  const results = (data.results || []).map((r) => ({
    title: r.title || "",
    description: r.description || "",
    url: r.url || "",
  }));

  debugLog(`[synaluxSearch] got ${results.length} results (source=${data.source || "portal"})`);

  return results
    .map((r) => `Title: ${r.title}\nDescription: ${r.description}\nURL: ${r.url}`)
    .join("\n\n");
}

/**
 * Web search via Synalux portal — returns raw JSON string.
 * Used by code-mode handlers that pass raw data to the QuickJS sandbox.
 */
export async function synaluxWebSearchRaw(query: string, count: number = 10): Promise<string> {
  debugLog(`[synaluxSearch] web search raw: q="${query}", limit=${count}`);

  const data = await portalPost<SynaluxSearchResponse>("/api/v1/prism/search", {
    query,
    limit: Math.min(count, 20),
  });

  if (data.status === "error") {
    throw new Error(`[synaluxSearch] portal error: ${data.error || "unknown"}`);
  }

  // Re-shape into the Brave-compatible format that code-mode handlers expect
  const braveCompatible = {
    web: {
      results: (data.results || []).map((r) => ({
        title: r.title || "",
        description: r.description || "",
        url: r.url || "",
      })),
    },
  };

  debugLog(`[synaluxSearch] raw: ${braveCompatible.web.results.length} results`);

  return JSON.stringify(braveCompatible);
}

/**
 * Local/POI search via Synalux portal.
 * Returns formatted text matching performLocalSearch() shape.
 */
export async function synaluxLocalSearch(query: string, count: number = 5): Promise<string> {
  debugLog(`[synaluxSearch] local search: q="${query}", count=${count}`);

  const data = await portalPost<SynaluxLocalSearchResponse>("/api/v1/prism/local-search", {
    query,
    count: Math.min(count, 20),
  });

  if (data.status === "error") {
    throw new Error(`[synaluxSearch] portal error: ${data.error || "unknown"}`);
  }

  const results = data.results || [];

  debugLog(`[synaluxSearch] local: got ${results.length} results`);

  return results
    .map((r) =>
      `Name: ${r.name || "N/A"}\nAddress: ${r.address || "N/A"}\nPhone: ${r.phone || "N/A"}\nRating: ${r.rating || "N/A"}\nHours: ${r.hours || "N/A"}\nDescription: ${r.description || "No description available"}`
    )
    .join("\n---\n");
}

/**
 * Local/POI search raw — returns JSON string for code-mode sandbox.
 */
export async function synaluxLocalSearchRaw(query: string, count: number = 5): Promise<string> {
  debugLog(`[synaluxSearch] local search raw: q="${query}", count=${count}`);

  const data = await portalPost<SynaluxLocalSearchResponse>("/api/v1/prism/local-search", {
    query,
    count: Math.min(count, 20),
  });

  if (data.status === "error") {
    throw new Error(`[synaluxSearch] portal error: ${data.error || "unknown"}`);
  }

  const results = data.results || [];

  debugLog(`[synaluxSearch] local raw: ${results.length} results`);

  // Build envelope compatible with code-mode sandbox expectations
  const envelope = {
    source: "local" as const,
    query,
    count,
    poisData: { results },
    descriptionsData: {
      descriptions: Object.fromEntries(
        results.map((r, i) => [String(i), r.description || ""])
      ),
    },
  };

  return JSON.stringify(envelope);
}

/**
 * AI-grounded answers via Synalux portal.
 */
export async function synaluxBraveAnswers(query: string, model?: string): Promise<string> {
  debugLog(`[synaluxSearch] answers: q="${query}", model=${model || "default"}`);

  const body: Record<string, unknown> = { query };
  if (model) body.model = model;

  const data = await portalPost<SynaluxAnswersResponse>("/api/v1/prism/answers", body);

  if (data.status === "error") {
    throw new Error(`[synaluxSearch] portal error: ${data.error || "unknown"}`);
  }

  if (!data.answer) {
    throw new Error("[synaluxSearch] answers endpoint returned empty answer");
  }

  return data.answer;
}

/**
 * Scrape a URL via Synalux portal. Returns the extracted content string.
 */
export async function synaluxScrape(url: string, options?: SynaluxScrapeOptions): Promise<string> {
  debugLog(`[synaluxSearch] scrape: url="${url}"`);

  const body: Record<string, unknown> = { url };
  if (options?.formats) body.formats = options.formats;
  if (options?.onlyMainContent !== undefined) body.onlyMainContent = options.onlyMainContent;
  if (options?.waitFor !== undefined) body.waitFor = options.waitFor;

  const data = await portalPost<SynaluxScrapeResponse>("/api/v1/prism/scrape", body);

  if (data.status === "error") {
    throw new Error(`[synaluxSearch] scrape error: ${data.error || "unknown"}`);
  }

  return data.content || "";
}
