// SUPABASE_URL / SUPABASE_KEY are read at call-time from process.env
// (not import-time) so dashboard-injected credentials are picked up.

/**
 * Lightweight Supabase REST API client.
 *
 * This module talks to Supabase using its built-in REST API (PostgREST).
 * It uses the native `fetch` function — no extra npm packages needed.
 *
 * How it works:
 *   - Every Supabase project exposes a REST API at <project-url>/rest/v1/
 *   - You authenticate by passing your API key in the "apikey" header
 *   - Tables are accessed as URL paths (e.g., /rest/v1/session_ledger)
 *   - RPC functions are called via /rest/v1/rpc/<function_name>
 *
 * This client provides three simple operations:
 *   - supabaseGet()  — read rows from a table (SELECT)
 *   - supabasePost() — insert a new row into a table (INSERT)
 *   - supabaseRpc()  — call a stored database function (RPC)
 */

// ─── Internal Request Helper ──────────────────────────────────

interface SupabaseRequestOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;        // e.g., "/rest/v1/session_ledger" or "/rest/v1/rpc/get_session_context"
  body?: unknown;       // JSON body for POST/PATCH requests
  params?: Record<string, string>;   // URL query parameters
  headers?: Record<string, string>;  // Extra headers (e.g., upsert preferences)
}

/**
 * Makes a single authenticated HTTP request to the Supabase REST API.
 * All public functions below delegate to this.
 */
async function supabaseRequest(opts: SupabaseRequestOptions): Promise<unknown> {
  // Read credentials at call time (not import time) so that dashboard-injected
  // values in process.env are picked up after storage/index.ts resolves them.
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) {
    throw new Error("Supabase not configured (SUPABASE_URL / SUPABASE_KEY missing)");
  }

  // Build the full URL with any query parameters
  const reqUrl = new URL(`${url}${opts.path}`);
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      reqUrl.searchParams.set(k, v);
    }
  }

  // Make the HTTP request with authentication headers
  const response = await fetch(reqUrl.toString(), {
    method: opts.method,
    headers: {
      "apikey": key,                    // Supabase API key (required for all requests)
      "Authorization": `Bearer ${key}`, // Also passed as Bearer token
      "Content-Type": "application/json",
      // "Prefer" header controls response behavior:
      //   - "return=representation" means return the inserted/updated row in the response
      //   - "return=minimal" means return nothing (faster for GETs)
      "Prefer": opts.method === "POST" ? "return=representation" : "return=minimal",
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });

  // Handle errors with a descriptive message
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Supabase ${opts.method} ${opts.path} failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  // Parse the response — some responses are empty (e.g., DELETE), so handle gracefully
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Read rows from a Supabase table.
 *
 * Example: supabaseGet("session_ledger", { project: "eq.my-app", order: "created_at.desc", limit: "5" })
 *   → GET /rest/v1/session_ledger?project=eq.my-app&order=created_at.desc&limit=5
 */
export async function supabaseGet(
  table: string,
  params?: Record<string, string>
): Promise<unknown> {
  return supabaseRequest({
    method: "GET",
    path: `/rest/v1/${table}`,
    params,
  });
}

/**
 * Insert a row into a Supabase table.
 *
 * Example: supabasePost("session_ledger", { project: "my-app", summary: "Did stuff" })
 *   → POST /rest/v1/session_ledger  with JSON body
 *
 * For upserts (insert-or-update), pass extra headers:
 *   supabasePost("session_handoffs", data, { on_conflict: "project" },
 *     { Prefer: "return=representation,resolution=merge-duplicates" })
 */
export async function supabasePost(
  table: string,
  data: unknown,
  params?: Record<string, string>,
  extraHeaders?: Record<string, string>
): Promise<unknown> {
  return supabaseRequest({
    method: "POST",
    path: `/rest/v1/${table}`,
    body: data,
    params,
    headers: extraHeaders,
  });
}

/**
 * Call a stored PostgreSQL function (RPC) in Supabase.
 *
 * Example: supabaseRpc("get_session_context", { p_project: "my-app", p_level: "standard" })
 *   → POST /rest/v1/rpc/get_session_context  with JSON body { p_project: "my-app", p_level: "standard" }
 */
export async function supabaseRpc(
  functionName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return supabaseRequest({
    method: "POST",
    path: `/rest/v1/rpc/${functionName}`,
    body: args,
  });
}

/**
 * Partially update rows in a Supabase table using PostgREST filters.
 *
 * REVIEWER NOTE: Added in v0.4.0 for the semantic search enhancement.
 * After inserting a ledger entry, we fire-and-forget an embedding
 * generation call, then PATCH the row to add the embedding vector.
 * This avoids blocking the main save operation on embedding latency.
 *
 * Example: supabasePatch("session_ledger", { embedding: "[0.1,0.2,...]" }, { id: "eq.abc123" })
 *   → PATCH /rest/v1/session_ledger?id=eq.abc123  with JSON body { embedding: [...] }
 */
export async function supabasePatch(
  table: string,
  data: unknown,
  params: Record<string, string>,
  extraHeaders?: Record<string, string>
): Promise<unknown> {
  return supabaseRequest({
    method: "PATCH",
    path: `/rest/v1/${table}`,
    body: data,
    params,
    headers: {
      "Prefer": "return=representation",
      ...(extraHeaders || {}),
    },
  });
}

/**
 * Delete rows from a Supabase table using PostgREST filters.
 *
 * Example: supabaseDelete("session_ledger", { project: "eq.my-app" })
 *   → DELETE /rest/v1/session_ledger?project=eq.my-app
 *
 * IMPORTANT: Always include filter params to avoid deleting all rows.
 * PostgREST requires at least one filter for DELETE operations.
 */
export async function supabaseDelete(
  table: string,
  params: Record<string, string>,
  extraHeaders?: Record<string, string>
): Promise<unknown> {
  return supabaseRequest({
    method: "DELETE",
    path: `/rest/v1/${table}`,
    params,
    headers: {
      "Prefer": "return=representation",
      ...(extraHeaders || {}),
    },
  });
}
