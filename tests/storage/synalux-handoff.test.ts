/**
 * SynaluxStorage save-handoff contract.
 *
 * The portal's canonical response places the OCC result under `result`.
 * Losing that envelope makes a durable save look like version `undefined`
 * and prevents downstream snapshot/embedding work from recognizing success.
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

describe("SynaluxStorage.saveHandoff", () => {
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

  it("unwraps the portal result envelope with the authoritative OCC version", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(response({
        status: "success",
        action: "save_handoff",
        result: { status: "updated", version: 16 },
      }));

    const SynaluxStorage = await importStorage();
    const storage = new SynaluxStorage();
    const result = await storage.saveHandoff({
      project: "prismcoach",
      user_id: "ignored-by-server",
      last_summary: "Verified durable handoff",
      pending_todo: ["Restart host"],
    }, 15);

    expect(result).toEqual({ status: "updated", version: 16 });
    const request = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(request).toMatchObject({
      action: "save_handoff",
      project: "prismcoach",
      expected_version: 15,
    });
  });

  it("retains compatibility with the legacy handoff envelope", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(response({
        status: "success",
        handoff: { status: "created", version: 1 },
      }));

    const SynaluxStorage = await importStorage();
    const storage = new SynaluxStorage();
    const result = await storage.saveHandoff({
      project: "new-project",
      user_id: "ignored-by-server",
    });

    expect(result).toEqual({ status: "created", version: 1 });
  });
  it("uses a distinct restore action so an older portal cannot silently treat restore as a partial save", async () => {
    fetchMock.mockResolvedValueOnce(response({status:"success",jwt:"jwt-1",expires_in:900}))
      .mockResolvedValueOnce(response({status:"success",action:"restore_handoff",result:{status:"updated",version:3,history_saved:true}}));
    const SynaluxStorage=await importStorage();
    await new SynaluxStorage().saveHandoff({project:"restore",user_id:"ignored-by-server",role:"dev",key_context:null,active_branch:null},2,{restoreContextFields:true});
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({action:"restore_handoff",project:"restore",role:"dev",expected_version:2,key_context:null,active_branch:null});
  });
  it("fails closed without ordinary-save fallback when the portal does not support restoration", async () => {
    fetchMock.mockResolvedValueOnce(response({status:"success",jwt:"jwt-1",expires_in:900}))
      .mockResolvedValueOnce(new Response(JSON.stringify({error:"Invalid action"}),{status:400,headers:{"content-type":"application/json"}}));
    const SynaluxStorage=await importStorage();
    await expect(new SynaluxStorage().saveHandoff({project:"restore",user_id:"ignored-by-server",role:"dev"},2,{restoreContextFields:true})).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).action).toBe("restore_handoff");
  });
  it("does not accept an older version-only success as confirmed restoration", async () => {
    fetchMock.mockResolvedValueOnce(response({status:"success",jwt:"jwt-1",expires_in:900}))
      .mockResolvedValueOnce(response({status:"success",result:{version:3}}));
    const SynaluxStorage=await importStorage();
    await expect(new SynaluxStorage().saveHandoff({project:"restore",user_id:"ignored",role:"dev"},2,{restoreContextFields:true}))
      .rejects.toThrow("restoration was not confirmed");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({action:"restore_handoff",key_context:null,active_branch:null});
  });

  it("normalizes the older version-only RPC result", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(response({
        status: "success",
        action: "save_handoff",
        result: { version: 7 },
      }));

    const SynaluxStorage = await importStorage();
    const storage = new SynaluxStorage();

    await expect(storage.saveHandoff({
      project: "rolling-upgrade",
      user_id: "ignored-by-server",
    })).resolves.toEqual({ status: "updated", version: 7 });
  });

  it.each([
    { name: "null", result: null, error: "missing result" },
    { name: "unversioned", result: { status: "updated" }, error: "malformed OCC result" },
    { name: "unknown status", result: { status: "success", version: 4 }, error: "malformed OCC result" },
  ])("fails loud for a $name handoff result", async ({ result, error }) => {
    fetchMock
      .mockResolvedValueOnce(response({ status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(response({
        status: "success",
        action: "save_handoff",
        result,
      }));

    const SynaluxStorage = await importStorage();
    const storage = new SynaluxStorage();

    await expect(storage.saveHandoff({
      project: "invalid-response",
      user_id: "ignored-by-server",
    })).rejects.toThrow(error);
  });

  it("routes handoff history snapshots through the authenticated portal", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(response({
        status: "success",
        action: "save_history_snapshot",
        project: "prismcoach",
        version: 21,
      }));

    const SynaluxStorage = await importStorage();
    const storage = new SynaluxStorage();
    await storage.saveHistorySnapshot({
      project: "prismcoach",
      user_id: "ignored-by-server",
      version: 21,
      last_summary: "Verified snapshot persistence",
      pending_todo: ["Restart host"],
    }, "main");

    const request = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(request).toMatchObject({
      action: "save_history_snapshot",
      project: "prismcoach",
      version: 21,
      branch: "main",
      snapshot: {
        last_summary: "Verified snapshot persistence",
      },
    });
  });

  it.each([
    { name: "null", snapshot: { project: "prismcoach", role: null, version: 21, last_summary: "legacy" } },
    { name: "omitted", snapshot: { project: "prismcoach", version: 21, last_summary: "legacy" } },
  ])("accepts $name legacy global handoff role", async ({ snapshot }) => {
    fetchMock
      .mockResolvedValueOnce(response({ status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(response({ status: "success", versions: [{ version: 21, snapshot }] }));

    const SynaluxStorage = await importStorage();
    const storage = new SynaluxStorage();
    await expect(storage.getHandoffAtVersion("prismcoach", 21)).resolves.toEqual(snapshot);
  });

  it("rejects a legacy null role for a non-global request", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(response({ status: "success", versions: [{ version: 21, snapshot: { project: "prismcoach", role: null, version: 21 } }] }));

    const SynaluxStorage = await importStorage();
    const storage = new SynaluxStorage();
    await expect(storage.getHandoffAtVersion("prismcoach", 21, "user", "dev"))
      .rejects.toThrow("Handoff history identity mismatch");
  });

  it.each([
    { name: "wrong project", snapshot: { project: "other", role: "global", version: 21 } },
    { name: "wrong version", snapshot: { project: "prismcoach", role: "global", version: 20 } },
  ])("rejects a global snapshot with $name", async ({ snapshot }) => {
    fetchMock
      .mockResolvedValueOnce(response({ status: "success", jwt: "jwt-1", expires_in: 900 }))
      .mockResolvedValueOnce(response({ status: "success", versions: [{ version: 21, snapshot }] }));

    const SynaluxStorage = await importStorage();
    const storage = new SynaluxStorage();
    await expect(storage.getHandoffAtVersion("prismcoach", 21)).rejects.toThrow("Handoff history identity mismatch");
  });
});
