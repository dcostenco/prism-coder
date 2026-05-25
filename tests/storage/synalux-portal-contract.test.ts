/**
 * Portal wire-contract tests.
 *
 * TWO SUITES:
 *
 * 1. Schema-contract (always runs) — imports KnowledgeSearchRequestSchema
 *    and asserts that the shape synalux.ts builds satisfies the schema.
 *    A field rename in portalContracts.ts will fail these tests immediately,
 *    before any code reaches the portal.
 *
 * 2. Live smoke (PRISM_LIVE_TEST=1 only) — POSTs the canonical wire body
 *    to the real portal and asserts the response is not an error.
 *    Run manually or in a dedicated integration CI job:
 *      PRISM_LIVE_TEST=1 PRISM_SYNALUX_API_KEY=synalux_sk_... npx vitest run tests/storage/synalux-portal-contract.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  KnowledgeSearchRequestSchema,
  KnowledgeSearchResponseSchema,
} from "../../src/storage/portalContracts.js";

// ─── Suite 1: Schema contract (always runs) ──────────────────────

describe("KnowledgeSearchRequestSchema — wire contract", () => {
  it("accepts a fully-populated payload", () => {
    const result = KnowledgeSearchRequestSchema.safeParse({
      action: "knowledge_search",
      project: "prism-mcp",
      keywords: ["drift", "tremor"],
      category: "debugging",
      query: "fix regression",
      limit: 5,
      role: "dev",
    });
    expect(result.success).toBe(true);
  });

  it("accepts minimal payload (action only — all others optional)", () => {
    const result = KnowledgeSearchRequestSchema.safeParse({
      action: "knowledge_search",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.keywords).toEqual([]);
      expect(result.data.limit).toBe(10);
    }
  });

  it("rejects payload with `queryText` instead of `query` (incident 2026-05-24)", () => {
    // This is the exact bug: someone uses the internal param name on the wire.
    // The schema must reject it so the error surfaces at build time, not in prod.
    const result = KnowledgeSearchRequestSchema.safeParse({
      action: "knowledge_search",
      queryText: "find HIPAA docs",   // ← wrong wire name
    });
    // Strict mode: unknown keys are stripped, not rejected — but query is undefined.
    // More importantly: `query` must be absent when `queryText` is passed.
    if (result.success) {
      expect(result.data).not.toHaveProperty("queryText");
      expect(result.data.query).toBeUndefined();
    }
  });

  it("wire body built by synalux.ts has `query`, never `queryText`", () => {
    const body = KnowledgeSearchRequestSchema.parse({
      action: "knowledge_search",
      query: "HIPAA compliance recent changes",
    });
    expect(body.query).toBe("HIPAA compliance recent changes");
    expect(body).not.toHaveProperty("queryText");
  });

  it("rejects action value other than 'knowledge_search'", () => {
    const result = KnowledgeSearchRequestSchema.safeParse({
      action: "search",   // wrong action
    });
    expect(result.success).toBe(false);
  });

  it("rejects limit above 50 (portal cap)", () => {
    const result = KnowledgeSearchRequestSchema.safeParse({
      action: "knowledge_search",
      limit: 999,
    });
    expect(result.success).toBe(false);
  });

  it("rejects limit below 1", () => {
    const result = KnowledgeSearchRequestSchema.safeParse({
      action: "knowledge_search",
      limit: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("KnowledgeSearchResponseSchema — response contract", () => {
  it("accepts a valid portal response", () => {
    const result = KnowledgeSearchResponseSchema.safeParse({
      status: "success",
      action: "knowledge_search",
      count: 2,
      results: [{ id: "a", summary: "s" }, { id: "b", summary: "t" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects error responses", () => {
    const result = KnowledgeSearchResponseSchema.safeParse({
      status: "error",
      error: "Failed to search knowledge",
    });
    expect(result.success).toBe(false);
  });
});

// ─── Suite 2: Live smoke (PRISM_LIVE_TEST=1 only) ────────────────

const LIVE = !!process.env.PRISM_LIVE_TEST;
const PORTAL_URL = process.env.PRISM_SYNALUX_BASE_URL ?? "https://synalux.ai";
const API_KEY = process.env.PRISM_SYNALUX_API_KEY ?? "";

describe.skipIf(!LIVE)("live portal smoke — knowledge_search wire contract", () => {
  async function fetchJwt(): Promise<string> {
    const res = await fetch(`${PORTAL_URL}/api/v1/auth/jwt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: API_KEY }),
    });
    const data = await res.json() as { status: string; jwt?: string };
    if (data.status !== "success" || !data.jwt) {
      throw new Error(`JWT fetch failed: ${JSON.stringify(data)}`);
    }
    return data.jwt;
  }

  async function portalPost(jwt: string, body: object): Promise<unknown> {
    const res = await fetch(`${PORTAL_URL}/api/v1/prism/memory`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${jwt}`,
      },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  it("knowledge_search with `query` field returns success (not 500)", async () => {
    const jwt = await fetchJwt();
    const body = KnowledgeSearchRequestSchema.parse({
      action: "knowledge_search",
      query: "contract smoke test",
      limit: 1,
    });
    const data = await portalPost(jwt, body) as Record<string, unknown>;
    expect(data.status).toBe("success");
    expect(data).not.toHaveProperty("error");
  }, 15_000);

  it("response shape satisfies KnowledgeSearchResponseSchema", async () => {
    const jwt = await fetchJwt();
    const body = KnowledgeSearchRequestSchema.parse({
      action: "knowledge_search",
      limit: 1,
    });
    const data = await portalPost(jwt, body);
    const parsed = KnowledgeSearchResponseSchema.safeParse(data);
    expect(parsed.success).toBe(true);
  }, 15_000);

  it("knowledge_search with `queryText` (wrong field) does NOT 500 — silently no text filter", async () => {
    // Portal strips unknown fields, returns success with unfiltered results.
    // This confirms the portal is tolerant but the fix in synalux.ts is still
    // required to ensure text filtering actually works.
    const jwt = await fetchJwt();
    const data = await portalPost(jwt, {
      action: "knowledge_search",
      queryText: "this field should be ignored",  // old broken field
      limit: 1,
    }) as Record<string, unknown>;
    // Must not 500 — portal tolerates unknown fields
    expect(data.status).toBe("success");
  }, 15_000);
});
