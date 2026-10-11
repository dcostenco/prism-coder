import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PORTAL_URL = "https://portal.test";
const ENTRY_ID = "aabbccdd-0000-0000-0000-000000000001";
const REFRESH_TOKEN = "synalux_sk_<fixture>";
vi.mock("../../src/storage/supabase.js", () => ({
  SupabaseStorage: class {
    async adjustImportance() { throw new Error("Direct Supabase fallback must not run"); }
    async getGraduatedInsights() { throw new Error("Direct Supabase fallback must not run"); }
    async decayImportance() { throw new Error("Direct Supabase fallback must not run"); }
  },
}));
vi.mock("../../src/utils/logger.js", () => ({ debugLog: vi.fn(), sanitizeForLog: (s: string) => s }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
describe("Synalux importance persistence", () => {
  const fetchMock = vi.fn();
  let storage: import("../../src/storage/synalux.js").SynaluxStorage;
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("PRISM_SYNALUX_BASE_URL", PORTAL_URL);
    vi.stubEnv("PRISM_SYNALUX_API_KEY", REFRESH_TOKEN);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset().mockResolvedValueOnce(json({ status: "success", jwt: "fixture-jwt", expires_in: 900 }));
    const { SynaluxStorage } = await import("../../src/storage/synalux.js");
    storage = new SynaluxStorage();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("preserves a correction's supplied initial score instead of silently saving zero", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "success", entry: { id: ENTRY_ID, importance: 1 } }));
    await storage.saveLedger({ project: "importance-fixture", summary: "Correction fixture", importance: 1, event_type: "correction", conversation_id: "fixture-conversation" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ action: "save_ledger", importance: 1 });
  });

  it.each([1, -1])("routes vote %s through Portal without a caller-selected owner", async delta => {
    fetchMock.mockResolvedValueOnce(json({ status: "success", entry: { id: ENTRY_ID, importance: 5 } }));
    await storage.adjustImportance(ENTRY_ID, delta, "caller-supplied-owner");
    expect(fetchMock.mock.calls[1][0]).toBe(PORTAL_URL + "/api/v1/prism/memory");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ action: "adjust_importance", id: ENTRY_ID, delta });
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer fixture-jwt");
  });

  it("accepts uppercase UUIDs when PostgreSQL returns the canonical lowercase ID", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "success", entry: { id: ENTRY_ID, importance: 5 } }));
    await storage.adjustImportance(ENTRY_ID.toUpperCase(), 1, "default");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).id).toBe(ENTRY_ID);
  });

  it.each([0, 2, 0.5, NaN])("rejects unsupported vote %s before network access", async delta => {
    await expect(storage.adjustImportance(ENTRY_ID, delta, "default")).rejects.toThrow("delta");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, { id: "foreign-entry", importance: 5 }, { id: ENTRY_ID, importance: -1 }, { id: ENTRY_ID, importance: "5" }])("refuses a success response without the requested updated score", async entry => {
    fetchMock.mockResolvedValueOnce(json({ status: "success", entry }));
    await expect(storage.adjustImportance(ENTRY_ID, 1, "default")).rejects.toThrow("contract drift");
  });

  it("surfaces missing/foreign entry failure instead of reporting an upvote", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "error", error: "Memory entry not found" }, 404));
    await expect(storage.adjustImportance(ENTRY_ID, 1, "default")).rejects.toThrow("Memory entry not found");
  });

  it("reads all graduated insight pages through Portal without choosing an owner", async () => {
    const project = "importance-fixture";
    const rows = [ENTRY_ID, "aabbccdd-0000-0000-0000-000000000002"].map(id => ({ id, project, summary: "Graduated fixture", importance: 7 }));
    fetchMock.mockResolvedValueOnce(json({ status: "success", insights: [rows[0]], page: { total: 2, has_more: true, next_offset: 1 } }))
      .mockResolvedValueOnce(json({ status: "success", insights: [rows[1]], page: { total: 2, has_more: false, next_offset: null } }));
    expect(await storage.getGraduatedInsights(project, "foreign-owner")).toEqual(rows);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ action: "graduated_insights", project, min_importance: 7, offset: 0 });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).offset).toBe(1);
  });

  it("surfaces incomplete graduated reads instead of writing partial IDE rules", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "success", insights: [], page: { total: 1, has_more: false } }));
    await expect(storage.getGraduatedInsights("importance-fixture", "default")).rejects.toThrow("incomplete");
  });

  it("routes existing stale-score decay through Portal without choosing an owner", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "success", decayed: 2 }));
    await storage.decayImportance("importance-fixture", "foreign-owner", 30);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ action: "decay_importance", project: "importance-fixture", days: 30 });
  });

  it("rejects decay success without a verified affected count", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "success" }));
    await expect(storage.decayImportance("importance-fixture", "default", 30)).rejects.toThrow("contract drift");
  });
});
