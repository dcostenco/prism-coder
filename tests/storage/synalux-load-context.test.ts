/**
 * SynaluxStorage load-context contract.
 *
 * The handler formatter consumes a flat ContextResult. These tests prevent a
 * portal envelope change from silently hiding the developer's last summary,
 * TODOs, version, or recent sessions at startup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PORTAL_URL = "https://portal.test";
const REFRESH_TOKEN = "synalux_sk_abcdef1234567890";

vi.mock("../../src/storage/supabase.js", () => ({
  SupabaseStorage: class {},
}));

vi.mock("../../src/utils/logger.js", () => ({
  debugLog: vi.fn(),
}));

async function importStorage() {
  vi.resetModules();
  process.env.PRISM_SYNALUX_BASE_URL = PORTAL_URL;
  process.env.PRISM_SYNALUX_API_KEY = REFRESH_TOKEN;
  return (await import("../../src/storage/synalux.js")).SynaluxStorage;
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SynaluxStorage.loadContext", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PRISM_SYNALUX_BASE_URL;
    delete process.env.PRISM_SYNALUX_API_KEY;
  });

  async function load(portalBody: unknown, level = "standard") {
    fetchMock
      .mockResolvedValueOnce(response({ status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(response(portalBody));
    const SynaluxStorage = await importStorage();
    const storage = new SynaluxStorage();
    const result = await storage.loadContext("prism-mcp", level, "ignored-by-server", "dev");
    const request = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    return { result, request };
  }

  it.each(["quick", "standard", "deep"])("sends the selected %s depth to the portal", async (level) => {
    const { request } = await load({ status: "success", context: null }, level);
    expect(request).toMatchObject({ action: "load_context", project: "prism-mcp", level, role: "dev" });
  });

  it("prefers the canonical flat context contract", async () => {
    const context = {
      last_summary: "Fixed cloud context",
      pending_todo: ["Publish"],
      version: 8,
      recent_sessions: [{ summary: "Prior session" }],
    };
    const { result } = await load({ status: "success", context });
    expect(result).toEqual(context);
  });

  it("normalizes the legacy handoff envelope during rolling upgrades", async () => {
    const { result } = await load({
      status: "success",
      handoff: { last_summary: "Legacy summary", pending_todo: ["Keep compatibility"], version: 7 },
      recent_sessions: [{ summary: "Legacy recent session" }],
    });
    expect(result).toEqual({
      last_summary: "Legacy summary",
      pending_todo: ["Keep compatibility"],
      version: 7,
      recent_sessions: [{ summary: "Legacy recent session" }],
    });
  });

  it.each([
    { status: "success", context: null },
    { status: "success", handoff: null, recent_sessions: [] },
  ])("maps an empty portal context to null", async (portalBody) => {
    expect((await load(portalBody)).result).toBeNull();
  });
});
