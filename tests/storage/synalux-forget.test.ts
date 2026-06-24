/**
 * Tests — SynaluxStorage forget_memory overrides (Phase 3 Tier A).
 *
 * Covers the soft- and hard-delete overrides that route through the
 * synalux portal's `forget_memory` action. The portal scopes deletes
 * to the caller's user_id server-side, so the client passes only the
 * memory_id and an optional reason — userId is intentionally ignored
 * by the override (defense-in-depth).
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

describe("SynaluxStorage — forget_memory routing", () => {
  const fetchMock = vi.fn();
  let SynaluxStorage: typeof import("../../src/storage/synalux.js")["SynaluxStorage"];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    SynaluxStorage = await importFreshSynaluxStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("softDeleteLedger sends action=forget_memory with hard_delete=false and reason", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", action: "forget_memory", mode: "soft_delete" }));

    const s = new SynaluxStorage();
    await s.softDeleteLedger("entry-uuid-123", "ignored-user-id", "user requested");

    const memoryCall = fetchMock.mock.calls[1];
    expect(memoryCall[0]).toBe(`${PORTAL_URL}/api/v1/prism/memory`);
    const body = JSON.parse((memoryCall[1] as RequestInit).body as string);
    expect(body).toEqual({
      action: "forget_memory",
      memory_id: "entry-uuid-123",
      hard_delete: false,
      reason: "user requested",
    });
  });

  it("softDeleteLedger sends reason=null when omitted", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", action: "forget_memory", mode: "soft_delete" }));

    const s = new SynaluxStorage();
    await s.softDeleteLedger("entry-uuid-456", "ignored");

    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body.reason).toBeNull();
  });

  it("hardDeleteLedger sends action=forget_memory with hard_delete=true and no reason", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", action: "forget_memory", mode: "hard_delete" }));

    const s = new SynaluxStorage();
    await s.hardDeleteLedger("entry-uuid-789", "ignored");

    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body).toEqual({
      action: "forget_memory",
      memory_id: "entry-uuid-789",
      hard_delete: true,
    });
  });

  it("propagates portal error on forget_memory failure", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(jsonResponse(500, { status: "error", error: "Failed to soft-delete memory" }));

    const s = new SynaluxStorage();
    await expect(s.softDeleteLedger("entry-uuid-fail", "ignored", "test"))
      .rejects.toThrow(/Failed to soft-delete memory/);
  });

  it("does NOT pass userId in the portal body (server scopes via JWT)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "success" }));

    const s = new SynaluxStorage();
    await s.softDeleteLedger("entry-uuid-x", "client-thinks-this-user-id", "x");

    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("user_id");
    expect(body).not.toHaveProperty("userId");
  });
});
