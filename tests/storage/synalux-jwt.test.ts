/**
 * Tests — SynaluxStorage JWT exchange + portal call dance (Phase 6).
 *
 * Covers the v13 thin-client auth flow: refresh token (synalux_sk_*)
 * exchanged for a 15-minute JWT, JWT cached and reused across calls,
 * 401 response triggers a single re-exchange + retry, concurrent
 * callers share one inflight exchange (rate-limit safe).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const PORTAL_URL = "https://portal.test";
const REFRESH_TOKEN = "synalux_sk_abcdef1234567890";

vi.mock("../../src/storage/supabase.js", () => ({
  SupabaseStorage: class {
    async initialize() { /* no-op */ }
    async close() { /* no-op */ }
  },
}));

vi.mock("../../src/utils/logger.js", () => ({
  sanitizeForLog: vi.fn((s: string) => s),
  debugLog: vi.fn(),
}));

async function importFreshSynaluxStorage(envOverrides: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = await import("../../src/storage/synalux.js");
  return mod.SynaluxStorage;
}

describe("SynaluxStorage — constructor validation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects when PRISM_SYNALUX_BASE_URL is unset", async () => {
    const SynaluxStorage = await importFreshSynaluxStorage({
      PRISM_SYNALUX_BASE_URL: undefined,
      PRISM_SYNALUX_API_KEY: REFRESH_TOKEN,
    });
    expect(() => new SynaluxStorage()).toThrow(/PRISM_SYNALUX_BASE_URL/);
  });

  it("rejects when PRISM_SYNALUX_API_KEY is unset", async () => {
    const SynaluxStorage = await importFreshSynaluxStorage({
      PRISM_SYNALUX_BASE_URL: PORTAL_URL,
      PRISM_SYNALUX_API_KEY: undefined,
    });
    expect(() => new SynaluxStorage()).toThrow(/PRISM_SYNALUX_API_KEY/);
  });

  it("rejects when PRISM_SYNALUX_API_KEY does not have synalux_sk_ prefix", async () => {
    const SynaluxStorage = await importFreshSynaluxStorage({
      PRISM_SYNALUX_BASE_URL: PORTAL_URL,
      PRISM_SYNALUX_API_KEY: "sb_secret_legacy_supabase_key",
    });
    expect(() => new SynaluxStorage()).toThrow(/synalux_sk_/);
  });

  it("trims trailing slashes from base URL", async () => {
    const SynaluxStorage = await importFreshSynaluxStorage({
      PRISM_SYNALUX_BASE_URL: PORTAL_URL + "///",
      PRISM_SYNALUX_API_KEY: REFRESH_TOKEN,
    });
    expect(() => new SynaluxStorage()).not.toThrow();
  });
});

describe("SynaluxStorage — JWT exchange + caching", () => {
  let SynaluxStorage: typeof import("../../src/storage/synalux.js")["SynaluxStorage"];

  const fetchMock = vi.fn();

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();

    SynaluxStorage = await importFreshSynaluxStorage({
      PRISM_SYNALUX_BASE_URL: PORTAL_URL,
      PRISM_SYNALUX_API_KEY: REFRESH_TOKEN,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("exchanges refresh token for JWT on first portal call", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", entry: { id: "e1" } }));

    const s = new SynaluxStorage();
    await s.saveLedger({
      project: "demo",
      conversation_id: "c1",
      summary: "hi",
      user_id: "default",
      todos: [],
      files_changed: [],
      decisions: [],
      keywords: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const exchangeCall = fetchMock.mock.calls[0];
    expect(exchangeCall[0]).toBe(`${PORTAL_URL}/api/v1/auth/jwt`);
    expect((exchangeCall[1] as RequestInit).headers).toMatchObject({
      "Authorization": `Bearer ${REFRESH_TOKEN}`,
    });
    const memoryCall = fetchMock.mock.calls[1];
    expect(memoryCall[0]).toBe(`${PORTAL_URL}/api/v1/prism/memory`);
    expect((memoryCall[1] as RequestInit).headers).toMatchObject({
      "Authorization": "Bearer jwt-1",
    });
  });

  it("reuses cached JWT for subsequent calls within TTL window", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", entry: {} }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", entry: {} }));

    const s = new SynaluxStorage();
    await s.saveLedger({ project: "demo", conversation_id: "c1", summary: "a", user_id: "u", todos: [], files_changed: [], decisions: [], keywords: [] });
    await s.saveLedger({ project: "demo", conversation_id: "c2", summary: "b", user_id: "u", todos: [], files_changed: [], decisions: [], keywords: [] });

    // Only one JWT exchange occurred.
    const exchangeCalls = fetchMock.mock.calls.filter(c => String(c[0]).endsWith("/api/v1/auth/jwt"));
    expect(exchangeCalls.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refreshes JWT when expiry is within leeway window", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", jwt: "jwt-1", expires_in: 60 })) // expires in 60s
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", entry: {} }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", jwt: "jwt-2", expires_in: 900 }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", entry: {} }));

    const s = new SynaluxStorage();
    await s.saveLedger({ project: "demo", conversation_id: "c1", summary: "a", user_id: "u", todos: [], files_changed: [], decisions: [], keywords: [] });

    // Advance past the leeway threshold (60s expiry, 60s leeway → already due).
    vi.setSystemTime(Date.now() + 1000);

    await s.saveLedger({ project: "demo", conversation_id: "c2", summary: "b", user_id: "u", todos: [], files_changed: [], decisions: [], keywords: [] });

    const exchangeCalls = fetchMock.mock.calls.filter(c => String(c[0]).endsWith("/api/v1/auth/jwt"));
    expect(exchangeCalls.length).toBe(2);
  });

  it("retries once on 401 with fresh JWT", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", jwt: "jwt-stale", expires_in: 900 }))
      .mockResolvedValueOnce(new Response("", { status: 401 })) // memory call rejects stale JWT
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", jwt: "jwt-fresh", expires_in: 900 }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", entry: { id: "e1" } }));

    const s = new SynaluxStorage();
    const result = await s.saveLedger({ project: "demo", conversation_id: "c1", summary: "ok", user_id: "u", todos: [], files_changed: [], decisions: [], keywords: [] });

    expect(result).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const lastCall = fetchMock.mock.calls[3];
    expect((lastCall[1] as RequestInit).headers).toMatchObject({
      "Authorization": "Bearer jwt-fresh",
    });
  });

  it("throws clear error when JWT exchange itself fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { status: "error", error: "Invalid or revoked API token" }));

    const s = new SynaluxStorage();
    await expect(s.saveLedger({ project: "demo", conversation_id: "c1", summary: "ok", user_id: "u", todos: [], files_changed: [], decisions: [], keywords: [] }))
      .rejects.toThrow(/JWT exchange failed.*Invalid or revoked/);
  });

  it("dedupes concurrent JWT exchanges (rate-limit safe)", async () => {
    let exchangeResolve: ((res: Response) => void) | null = null;
    const exchangePromise = new Promise<Response>((resolve) => { exchangeResolve = resolve; });

    fetchMock
      .mockReturnValueOnce(exchangePromise)
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", entry: {} }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", entry: {} }));

    const s = new SynaluxStorage();
    const p1 = s.saveLedger({ project: "demo", conversation_id: "c1", summary: "a", user_id: "u", todos: [], files_changed: [], decisions: [], keywords: [] });
    const p2 = s.saveLedger({ project: "demo", conversation_id: "c2", summary: "b", user_id: "u", todos: [], files_changed: [], decisions: [], keywords: [] });

    // Resolve the single inflight exchange — both should proceed using the same JWT.
    exchangeResolve!(jsonResponse(200, { status: "success", jwt: "jwt-shared", expires_in: 900 }));

    await Promise.all([p1, p2]);

    const exchangeCalls = fetchMock.mock.calls.filter(c => String(c[0]).endsWith("/api/v1/auth/jwt"));
    expect(exchangeCalls.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("dedupes identical concurrent context reads without caching completed results", async () => {
    let resolveContext: ((res: Response) => void) | null = null;
    const contextPromise = new Promise<Response>((resolve) => { resolveContext = resolve; });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", jwt: "jwt-shared", expires_in: 900 }))
      .mockReturnValueOnce(contextPromise)
      .mockResolvedValueOnce(jsonResponse(200, {
        status: "success",
        context: { last_summary: "refreshed context", version: 4 },
      }));

    const storage = new SynaluxStorage();
    const first = storage.loadContext("prism-mcp", "standard", "user-1", "global");
    const second = storage.loadContext("prism-mcp", "standard", "user-1", "global");
    resolveContext!(jsonResponse(200, {
      status: "success",
      context: { last_summary: "shared context", version: 3 },
    }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      { last_summary: "shared context", version: 3 },
      { last_summary: "shared context", version: 3 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(storage.loadContext("prism-mcp", "standard", "user-1", "global"))
      .resolves.toEqual({ last_summary: "refreshed context", version: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
