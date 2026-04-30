/**
 * Tests — SynaluxStorage search routings (Phase 3 Tier B + B.2).
 *
 * Covers searchKnowledge (action=knowledge_search) and searchMemory
 * (action=search_memory). Edge cases: malformed embedding strings,
 * missing optional params, server errors, empty results, activation
 * options dropped silently.
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
  debugLog: vi.fn(),
}));

async function importFreshSynaluxStorage() {
  vi.resetModules();
  process.env.PRISM_SYNALUX_BASE_URL = PORTAL_URL;
  process.env.PRISM_SYNALUX_API_KEY = REFRESH_TOKEN;
  const mod = await import("../../src/storage/synalux.js");
  return mod.SynaluxStorage;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Each call produces a fresh Response — Response bodies are streams
// and can only be read once, so reusing one across multiple
// mockResolvedValueOnce calls fails after the first .json().
function freshJwtResp() {
  return jsonResponse(200, { status: "success", jwt: "jwt-1", expires_in: 900 });
}

// ─── searchKnowledge ─────────────────────────────────────────────
describe("SynaluxStorage — searchKnowledge (knowledge_search action)", () => {
  const fetchMock = vi.fn();
  let SynaluxStorage: typeof import("../../src/storage/synalux.js")["SynaluxStorage"];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    SynaluxStorage = await importFreshSynaluxStorage();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("sends action=knowledge_search with all filter fields", async () => {
    fetchMock
      .mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", count: 2, results: [{ id: "a" }, { id: "b" }] }));

    const s = new SynaluxStorage();
    const out = await s.searchKnowledge({
      project: "demo",
      keywords: ["alpha", "beta"],
      category: "debugging",
      queryText: "regression",
      limit: 7,
      role: "dev",
    });

    expect(out).toEqual({ count: 2, results: [{ id: "a" }, { id: "b" }] });
    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body).toEqual({
      action: "knowledge_search",
      project: "demo",
      keywords: ["alpha", "beta"],
      category: "debugging",
      queryText: "regression",
      limit: 7,
      role: "dev",
    });
  });

  it("defaults missing optional fields and uses limit=10", async () => {
    fetchMock
      .mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", count: 0, results: [] }));

    const s = new SynaluxStorage();
    await s.searchKnowledge({});

    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body.limit).toBe(10);
    expect(body.keywords).toEqual([]);
    expect(body.project).toBeUndefined();
    expect(body.category).toBeUndefined();
    expect(body.queryText).toBeUndefined();
    expect(body.role).toBeUndefined();
  });

  it("returns {count:0, results:[]} when portal omits fields", async () => {
    fetchMock
      .mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(200, { status: "success" }));

    const s = new SynaluxStorage();
    const out = await s.searchKnowledge({ queryText: "anything" });
    expect(out).toEqual({ count: 0, results: [] });
  });

  it("coerces non-numeric count from portal response", async () => {
    fetchMock
      .mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", count: "garbage", results: [] }));

    const s = new SynaluxStorage();
    const out = await s.searchKnowledge({});
    expect(out?.count).toBe(0);
  });

  it("coerces non-array results to []", async () => {
    fetchMock
      .mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", count: 5, results: "not-an-array" }));

    const s = new SynaluxStorage();
    const out = await s.searchKnowledge({});
    expect(out?.results).toEqual([]);
  });

  it("propagates portal error", async () => {
    fetchMock
      .mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(500, { status: "error", error: "Failed to search knowledge" }));

    const s = new SynaluxStorage();
    await expect(s.searchKnowledge({})).rejects.toThrow(/Failed to search knowledge/);
  });
});

// ─── searchMemory ────────────────────────────────────────────────
describe("SynaluxStorage — searchMemory (search_memory action)", () => {
  const fetchMock = vi.fn();
  let SynaluxStorage: typeof import("../../src/storage/synalux.js")["SynaluxStorage"];

  function vec(dim: number, fill = 0.1): string {
    return JSON.stringify(Array.from({ length: dim }, () => fill));
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    SynaluxStorage = await importFreshSynaluxStorage();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("parses a JSON-stringified vector and forwards to portal", async () => {
    fetchMock
      .mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(200, {
        status: "success",
        count: 1,
        results: [{ id: "x", project: "p", summary: "s", similarity: 0.9 }],
      }));

    const s = new SynaluxStorage();
    const out = await s.searchMemory({
      queryEmbedding: vec(768, 0.2),
      project: "p",
      limit: 3,
      similarityThreshold: 0.65,
      userId: "ignored",
      role: "dev",
    });

    expect(out).toHaveLength(1);
    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body.action).toBe("search_memory");
    expect(body.project).toBe("p");
    expect(body.role).toBe("dev");
    expect(body.similarity_threshold).toBe(0.65);
    expect(body.limit).toBe(3);
    expect(Array.isArray(body.query_embedding)).toBe(true);
    expect(body.query_embedding).toHaveLength(768);
  });

  it("throws clearly when queryEmbedding is not valid JSON", async () => {
    const s = new SynaluxStorage();
    await expect(s.searchMemory({
      queryEmbedding: "{not-json",
      limit: 5, similarityThreshold: 0.7, userId: "x",
    })).rejects.toThrow(/JSON-stringified/);
  });

  it("throws when queryEmbedding parses to a non-array (e.g. number, object)", async () => {
    const s = new SynaluxStorage();
    await expect(s.searchMemory({
      queryEmbedding: "42",
      limit: 5, similarityThreshold: 0.7, userId: "x",
    })).rejects.toThrow(/parse to an array/);

    await expect(s.searchMemory({
      queryEmbedding: '{"a":1}',
      limit: 5, similarityThreshold: 0.7, userId: "x",
    })).rejects.toThrow(/parse to an array/);
  });

  it("does NOT pass userId in the portal body (server scopes via JWT)", async () => {
    fetchMock
      .mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", count: 0, results: [] }));

    const s = new SynaluxStorage();
    await s.searchMemory({
      queryEmbedding: vec(768),
      limit: 5, similarityThreshold: 0.7,
      userId: "client-thinks-this-user-id",
    });

    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("user_id");
    expect(body).not.toHaveProperty("userId");
  });

  it("does NOT forward the activation option (graph traversal stays client-side)", async () => {
    fetchMock
      .mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", count: 0, results: [] }));

    const s = new SynaluxStorage();
    await s.searchMemory({
      queryEmbedding: vec(768),
      limit: 5, similarityThreshold: 0.7, userId: "x",
      activation: { enabled: true, iterations: 5 },
    });

    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("activation");
  });

  it("returns [] when portal omits results array", async () => {
    fetchMock
      .mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", count: 0 }));

    const s = new SynaluxStorage();
    const out = await s.searchMemory({
      queryEmbedding: vec(768),
      limit: 5, similarityThreshold: 0.7, userId: "x",
    });
    expect(out).toEqual([]);
  });

  it("coerces non-array results to []", async () => {
    fetchMock
      .mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", count: 1, results: { not: "an-array" } }));

    const s = new SynaluxStorage();
    const out = await s.searchMemory({
      queryEmbedding: vec(768),
      limit: 5, similarityThreshold: 0.7, userId: "x",
    });
    expect(out).toEqual([]);
  });

  it("propagates portal error (e.g. embedding shape rejected)", async () => {
    fetchMock
      .mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(400, { status: "error", error: "query_embedding must have 768 dimensions, got 1" }));

    const s = new SynaluxStorage();
    await expect(s.searchMemory({
      queryEmbedding: vec(1),
      limit: 5, similarityThreshold: 0.7, userId: "x",
    })).rejects.toThrow(/768 dimensions/);
  });
});
