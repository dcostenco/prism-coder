import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const ID = "aabbccdd-0000-0000-0000-000000000001";
const DATE = "2026-10-11T12:00:00.000Z";
vi.mock("../../src/storage/supabase.js", () => ({ SupabaseStorage: class {
  logAccess() { throw new Error("Direct database forbidden"); }
  getAccessLog() { throw new Error("Direct database forbidden"); }
  updateLastAccessed() { throw new Error("Direct database forbidden"); }
} }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
describe("authenticated cloud access history", () => {
  const fetchMock = vi.fn();
  let storage: import("../../src/storage/synalux.js").SynaluxStorage;
  beforeEach(async () => {
    vi.resetModules(); vi.stubEnv("PRISM_SYNALUX_BASE_URL", "https://portal.test"); vi.stubEnv("PRISM_SYNALUX_API_KEY", "synalux_sk_<fixture>");
    vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset().mockResolvedValueOnce(json({ status: "success", jwt: "fixture-jwt", expires_in: 900 }));
    storage = new (await import("../../src/storage/synalux.js")).SynaluxStorage();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it("records one batched retrieval without owner, timestamp, query text or duplicate touches", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "success", recorded: 1 }));
    await storage.recordAccesses([ID, ID.toUpperCase()], "abcd");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ action: "record_access", entry_ids: [ID], context_hash: "abcd", record_history: true });
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer fixture-jwt");
  });
  it("returns durable dates for the ranking engine", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "success", accesses: [{ entry_id: ID, accessed_at: DATE }] }));
    expect((await storage.getAccessLog([ID], 5)).get(ID)).toEqual([new Date(DATE)]);
  });
  it("reads all candidate associations in one authenticated call", async () => {
    const second = ID.replace(/1$/, "2");
    fetchMock.mockResolvedValueOnce(json({status:"success",links:[{source_id:ID,target_id:second,strength:0.8}]}));
    expect(await storage.getCandidateLinks([ID,second])).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(JSON.parse(fetchMock.mock.calls[1][1].body).action).toBe("get_candidate_links");
  });
  it("surfaces service errors instead of substituting an empty history", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "error", error: "unavailable" }, 500));
    await expect(storage.getAccessLog([ID])).rejects.toThrow();
  });
  it.each([[{ entry_id: "foreign", accessed_at: DATE }], [{ entry_id: ID, accessed_at: "invalid" }], null])("rejects malformed response %j", async accesses => {
    fetchMock.mockResolvedValueOnce(json({ status: "success", accesses }));
    await expect(storage.getAccessLog([ID])).rejects.toThrow("Invalid memory access history");
  });
  it("preserves legacy touch semantics without adding a second event", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "success", recorded: 1 })); await storage.updateLastAccessed([ID]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).record_history).toBe(false);
  });
  it("rejects plaintext contexts before any network request", async () => {
    await expect(storage.recordAccesses([ID], "patient name")).rejects.toThrow(); expect(fetchMock).not.toHaveBeenCalled();
  });
});
