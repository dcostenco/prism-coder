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
 * synaluxSearchAvailable() before calling.
 */

import { debugLog } from "./logger.js";
import { upgradeInsecureCloudUrl } from "./secureUrl.js";
import { PortalHttpError } from "./portalError.js";
import { getSynaluxJwt, invalidateSynaluxJwt } from "./synaluxJwt.js";
import {
  PRISM_SYNALUX_API_KEY,
  PRISM_SYNALUX_BASE_URL,
} from "../config.js";

// ─── Public availability flag ────────────────────────────────

/** A `${...}` template the shell never expanded is not a credential. config.ts
 *  rejects those at load; the live read rejects them too, or a half-written host
 *  config sends every search to a portal that can only answer 401. */
function usableEnvValue(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed.includes("${")) return undefined;
  return trimmed;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Whether the portal can serve a search, resolved at CALL time.
 *
 *  This used to be a module-load constant taken from SYNALUX_CONFIGURED, and
 *  that was wrong for the most common installation. `prism connect` copies the
 *  subscription key into the host's MCP env block only when the key already
 *  happened to be in the environment; otherwise it lives in Prism's settings
 *  store and reaches process.env during startup. A constant read before that
 *  froze "unconfigured" for the life of the process, so a paying subscriber's
 *  every search skipped the portal and demanded a Brave key they had no reason
 *  to own — while entitlements, resolved later from the same hydrated key,
 *  correctly reported their paid plan. Measured 2026-09-16.
 *
 *  The resolution order below is deliberately the same one fetchEntitlements()
 *  uses (live env first, module-load constant as the fallback). Search and
 *  entitlements answering "is the portal usable" differently IS the defect. */
export function resolvePortalBaseUrl(): string | undefined {
  // Each candidate is validated in turn: a typo in one host config must fall
  // through to the settings store rather than disabling portal search outright.
  for (const candidate of [
    usableEnvValue(process.env.PRISM_SYNALUX_BASE_URL),
    usableEnvValue(process.env.SYNALUX_BASE_URL),
    PRISM_SYNALUX_BASE_URL,
  ]) {
    if (!candidate || !isHttpUrl(candidate)) continue;
    // Never hand back a cleartext transport URL for a remote host: this client
    // sends the query and a bearer JWT over it.
    return upgradeInsecureCloudUrl(candidate).replace(/\/+$/, "");
  }
  return undefined;
}

/** The subscription key, resolved the one way every portal client resolves it. */
export function usablePortalKey(): string | undefined {
  return usableEnvValue(process.env.PRISM_SYNALUX_API_KEY) ?? PRISM_SYNALUX_API_KEY;
}

export function synaluxSearchAvailable(): boolean {
  return !!resolvePortalBaseUrl() && !!usablePortalKey();
}

/** Put the subscription key where every consumer reads it — process.env —
 *  taking the settings store as the fallback source. Idempotent, and it never
 *  overwrites a value the environment already supplied. */
export async function hydrateSynaluxCredentials(
  getSetting: (key: string, fallback: string) => Promise<string>,
): Promise<boolean> {
  try {
    const baseUrl =
      usableEnvValue(process.env.PRISM_SYNALUX_BASE_URL)
      ?? usableEnvValue(process.env.SYNALUX_BASE_URL)
      ?? usableEnvValue(await getSetting("PRISM_SYNALUX_BASE_URL", ""))
      ?? usableEnvValue(await getSetting("SYNALUX_BASE_URL", ""))
      ?? PRISM_SYNALUX_BASE_URL;
    // Validate AND secure before publishing. process.env is shared with storage
    // and entitlements, so a settings row holding a non-URL would poison every
    // portal client in the process — and a cleartext http:// row would put the
    // bearer JWT of every one of them on the wire in the clear.
    if (baseUrl && isHttpUrl(baseUrl)) {
      process.env.PRISM_SYNALUX_BASE_URL =
        upgradeInsecureCloudUrl(baseUrl).replace(/\/+$/, "");
    }
    const apiKey =
      usableEnvValue(process.env.PRISM_SYNALUX_API_KEY)
      ?? usableEnvValue(await getSetting("PRISM_SYNALUX_API_KEY", ""))
      ?? PRISM_SYNALUX_API_KEY;
    if (apiKey) process.env.PRISM_SYNALUX_API_KEY = apiKey;
    return synaluxSearchAvailable();
  } catch {
    return synaluxSearchAvailable();   // a settings read must never break startup
  }
}

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
  timeoutMs?: number;
}

interface SynaluxScrapeResponse {
  status: string;
  content?: string;
  data?: {
    markdown?: string;
    html?: string;
    rawHtml?: string;
  };
  error?: string;
}

// ─── Internal helpers ────────────────────────────────────────

/**
 * POST to a portal endpoint with JWT auth. Retries once on 401
 * (JWT may have just expired). Throws on network or HTTP errors.
 */
async function portalPost<T>(path: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  // Resolved, never the module-load constant: availability is now decided from
  // the live environment, so a portal that is reachable must also be addressable.
  // Reading a frozen constant here would throw on the very installation this
  // routing exists to serve.
  const baseUrl = resolvePortalBaseUrl();
  if (!baseUrl) {
    throw new Error("[synaluxSearch] no Synalux portal base URL is configured");
  }
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
    // Same message as before; the typed error lets braveApi.ts recognise a
    // plan refusal without parsing the message.
    throw new PortalHttpError(path, res.status, text);
  }

  return (await res.json()) as T;
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Web search via Synalux portal. Returns formatted text matching
 * the shape of performWebSearch() in braveApi.ts.
 */
export async function synaluxWebSearch(query: string, count: number = 10): Promise<string> {
  debugLog(`[synaluxSearch] web search: query_chars=${query.length}, limit=${count}`);

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
  debugLog(`[synaluxSearch] web search raw: query_chars=${query.length}, limit=${count}`);

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
  debugLog(`[synaluxSearch] local search: query_chars=${query.length}, count=${count}`);

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
  debugLog(`[synaluxSearch] local search raw: query_chars=${query.length}, count=${count}`);

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
  debugLog(`[synaluxSearch] answers: query_chars=${query.length}, model=${model || "default"}`);

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
  debugLog(`[synaluxSearch] scrape: url_chars=${url.length}`);

  const body: Record<string, unknown> = { url };
  if (options?.formats) body.formats = options.formats;
  if (options?.onlyMainContent !== undefined) body.onlyMainContent = options.onlyMainContent;
  if (options?.waitFor !== undefined) body.waitFor = options.waitFor;

  const data = await portalPost<SynaluxScrapeResponse>(
    "/api/v1/prism/scrape",
    body,
    options?.timeoutMs,
  );

  if (data.status === "error") {
    throw new Error(`[synaluxSearch] scrape error: ${data.error || "unknown"}`);
  }

  return data.content ||
    data.data?.markdown ||
    data.data?.html ||
    data.data?.rawHtml ||
    "";
}
