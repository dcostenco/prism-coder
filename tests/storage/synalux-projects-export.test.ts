/**
 * Tests — SynaluxStorage listProjects (action=list_projects) and
 * exportLedger (action=export_memory, paginated).
 *
 * Both portal actions shipped in Phase 3 but the client overrides were
 * never written, so on paid thin-client installs (no SUPABASE_URL) both
 * paths fell through to SupabaseStorage and threw "Supabase not
 * configured" — session_export_memory and the 3 listProjects call sites
 * were dead on exactly the tier that pays for them (2026-08-18 audit).
 */

import { readDashboardLedger } from "../../src/dashboard/ledgerReader.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const PORTAL_URL = "https://portal.test";
const REFRESH_TOKEN = "synalux_sk_abcdef1234567890";

vi.mock("../../src/storage/supabase.js", () => ({
  SupabaseStorage: class {
    async initialize() { /* no-op */ }
    async close() { /* no-op */ }
    // The fall-through failure this migration removes. If an override is
    // deleted, tests fail HERE with the real production symptom.
    async listProjects() { throw new Error("Supabase not configured (SUPABASE_URL / SUPABASE_KEY missing)"); }
    async getLedgerEntries() { throw new Error("Supabase not configured (SUPABASE_URL / SUPABASE_KEY missing)"); }
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

function freshJwtResp() {
  return jsonResponse(200, { status: "success", jwt: "jwt-1", expires_in: 900 });
}

describe("SynaluxStorage — listProjects (action=list_projects)", () => {
  const fetchMock = vi.fn();
  let SynaluxStorage: typeof import("../../src/storage/synalux.js")["SynaluxStorage"];

  beforeEach(async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    SynaluxStorage = await importFreshSynaluxStorage();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("returns project names from the portal inventory payload", async () => {
    fetchMock
      .mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(200, {
        status: "success",
        action: "list_projects",
        count: 2,
        projects: [
          { project: "alpha", ledger: 10, handoffs: 1, history: 3 },
          { project: "beta", ledger: 4, handoffs: 1, history: 0 },
        ],
      }));

    const s = new SynaluxStorage();
    const out = await s.listProjects();

    expect(out).toEqual(["alpha", "beta"]);
    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body).toEqual({ action: "list_projects" });
  });

  it("tolerates malformed rows rather than returning undefined names", async () => {
    fetchMock
      .mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(200, {
        status: "success",
        projects: [{ project: "good" }, { ledger: 5 }, null, "bare-string", { project: "" }],
      }));

    const s = new SynaluxStorage();
    expect(await s.listProjects()).toEqual(["good", "bare-string"]);
  });

  it("throws on a 200 missing projects[] — drift is not an empty inventory", async () => {
    // The portal returns projects:[] for genuinely none; a missing field is
    // a contract change and must not read as "no projects".
    fetchMock
      .mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", items: [] }));

    const s = new SynaluxStorage();
    await expect(s.listProjects()).rejects.toThrow(/contract drift/);
  });
});

describe("SynaluxStorage — exportLedger (action=export_memory)", () => {
  const fetchMock = vi.fn();
  let SynaluxStorage: typeof import("../../src/storage/synalux.js")["SynaluxStorage"];

  beforeEach(async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    SynaluxStorage = await importFreshSynaluxStorage();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("collects a single page and stops when has_more is false", async () => {
    fetchMock
      .mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(200, {
        status: "success",
        action: "export_memory",
        ledger: [{ id: "1", summary: "a" }, { id: "2", summary: "b" }],
        page: { offset: 0, limit: 1000, returned: 2, total: 2, has_more: false, next_offset: null },
      }));

    const s = new SynaluxStorage();
    const rows = await s.exportLedger("demo");

    expect(rows).toEqual([{ id: "1", summary: "a" }, { id: "2", summary: "b" }]);
    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body).toEqual({ action: "export_memory", project: "demo", offset: 0, limit: 1000 });
  });

  it("follows next_offset across pages in order", async () => {
    fetchMock
      .mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(200, {
        status: "success",
        ledger: [{ id: "1" }],
        page: { has_more: true, next_offset: 1000 },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        status: "success",
        ledger: [{ id: "2" }],
        page: { has_more: false, next_offset: null },
      }));

    const s = new SynaluxStorage();
    const rows = await s.exportLedger("demo");

    expect(rows).toEqual([{ id: "1" }, { id: "2" }]);
    const second = JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string);
    expect(second.offset).toBe(1000);
  });

  it("throws on a 200 missing ledger[] — drift must not become an empty backup", async () => {
    // R1 adversarial review: coercing a renamed/missing field to [] writes
    // an empty export file that reports ✅ success. For a backup path, that
    // is strictly worse than an error.
    fetchMock
      .mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", rows: [{ id: "1" }] }));

    const s = new SynaluxStorage();
    await expect(s.exportLedger("demo")).rejects.toThrow(/contract drift/);
  });

  it("throws on a 200 missing page info — refuses a possibly-truncated export", async () => {
    // Without page.has_more the client cannot know whether more rows exist;
    // breaking out silently would ship a partial backup marked complete.
    fetchMock
      .mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", ledger: [{ id: "1" }] }));

    const s = new SynaluxStorage();
    await expect(s.exportLedger("demo")).rejects.toThrow(/possibly-truncated/);
  });

  it("caps pagination at 10 pages — a lying has_more cannot loop forever", async () => {
    fetchMock.mockResolvedValueOnce(freshJwtResp());
    for (let i = 0; i < 20; i++) {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, {
        status: "success",
        ledger: [{ id: String(i) }],
        page: { has_more: true, next_offset: (i + 1) * 1000 },
      }));
    }

    const s = new SynaluxStorage();
    const rows = await s.exportLedger("demo");

    expect(rows).toHaveLength(10);
    // 1 JWT call + 10 export pages, then the cap stops it.
    expect(fetchMock.mock.calls.length).toBe(11);
  });
});

describe("Dashboard ledger backend contract", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("shows the newest completed cloud checkpoint without direct Supabase credentials", async () => {
    fetchMock.mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(200, {
        status: "success", ledger: [{ id: "older", created_at: "2026-01-01" }],
        page: { total: 12001, has_more: true, next_offset: 1 },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        status: "success", ledger: [{ id: "completed-checkpoint", created_at: "2026-09-18" }],
        page: { total: 12001, has_more: false, next_offset: null },
      }));
    const Storage = await importFreshSynaluxStorage();
    const rows = await readDashboardLedger(new Storage(), "synalux", "checkpoint-project", "created_at.desc", 1);
    expect(rows).toEqual([{ id: "completed-checkpoint", created_at: "2026-09-18" }]);
    expect(fetchMock.mock.calls.slice(1).map(call => JSON.parse(call[1].body))).toEqual([
      { action: "export_memory", project: "checkpoint-project", offset: 0, limit: 1 },
      { action: "export_memory", project: "checkpoint-project", offset: 12000, limit: 1 },
    ]);
    expect(fetchMock.mock.calls.slice(1).every(call => call[1].headers.Authorization === "Bearer jwt-1")).toBe(true);
  });

  it("keeps cloud vault exports in chronological order", async () => {
    fetchMock.mockResolvedValueOnce(freshJwtResp()).mockResolvedValueOnce(jsonResponse(200, {
      status: "success", ledger: [{ id: "latest", created_at: "2026-09-18" }, { id: "earliest", created_at: "2026-01-01" }], page: { total: 2 },
    }));
    const Storage = await importFreshSynaluxStorage();
    expect(await readDashboardLedger(new Storage(), "synalux", "checkpoint-project", "created_at.asc", 1000)).toEqual([
      { id: "earliest", created_at: "2026-01-01" }, { id: "latest", created_at: "2026-09-18" },
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).offset).toBe(0);
  });

  it("rechecks the tail when another checkpoint completes during the read", async () => {
    fetchMock.mockResolvedValueOnce(freshJwtResp());
    for (const total of [12001, 12002, 12002]) {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, {
        status: "success", ledger: [{ id: `checkpoint-${total}`, created_at: "2026-09-18" }], page: { total },
      }));
    }
    const Storage = await importFreshSynaluxStorage();
    expect(await readDashboardLedger(new Storage(), "synalux", "checkpoint-project", "created_at.desc", 1))
      .toEqual([{ id: "checkpoint-12002", created_at: "2026-09-18" }]);
    expect(fetchMock.mock.calls.slice(1).map(call => JSON.parse(call[1].body).offset)).toEqual([0, 12000, 12001]);
  });

  it("refuses a continuously changing tail instead of certifying stale recent sessions", async () => {
    fetchMock.mockResolvedValueOnce(freshJwtResp());
    for (const total of [12001, 12002, 12003, 12004]) {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: "success", ledger: [], page: { total } }));
    }
    const Storage = await importFreshSynaluxStorage();
    await expect(readDashboardLedger(new Storage(), "synalux", "checkpoint-project", "created_at.desc", 1)).rejects.toThrow("changed during read");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("surfaces a changed export contract instead of hiding recent checkpoints", async () => {
    fetchMock.mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(200, { status: "success", ledger: [], page: { has_more: false } }));
    const Storage = await importFreshSynaluxStorage();
    await expect(readDashboardLedger(new Storage(), "synalux", "checkpoint-project", "created_at.desc", 20)).rejects.toThrow("contract drift");
  });

  it.each([0, -1, 1001, 1.5])("rejects unsafe window limit %s before reading cloud data", async limit => {
    const Storage = await importFreshSynaluxStorage();
    await expect(readDashboardLedger(new Storage(), "synalux", "checkpoint-project", "created_at.desc", limit)).rejects.toThrow("Invalid dashboard ledger limit");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a refused cloud read instead of showing an empty recent list", async () => {
    fetchMock.mockResolvedValueOnce(freshJwtResp())
      .mockResolvedValueOnce(jsonResponse(403, { status: "error", error: "Cloud read refused" }));
    const Storage = await importFreshSynaluxStorage();
    await expect(readDashboardLedger(new Storage(), "synalux", "checkpoint-project", "created_at.desc", 20)).rejects.toThrow("Cloud read refused");
  });

  it.each(["local", "supabase"])("preserves %s dashboard query semantics", async backend => {
    const rows = [{ id: "existing-row" }];
    const storage = { getDashboardLedger: vi.fn(), getLedgerEntries: vi.fn().mockResolvedValue(rows) };
    expect(await readDashboardLedger(storage, backend, "checkpoint-project", "created_at.desc", 20)).toBe(rows);
    expect(storage.getLedgerEntries).toHaveBeenCalledWith({ project: "eq.checkpoint-project", order: "created_at.desc", limit: "20" });
    expect(storage.getDashboardLedger).not.toHaveBeenCalled();
  });
});

describe("SynaluxStorage — dashboard graph ledger", () => {
  const fetchMock = vi.fn();
  let SynaluxStorage: typeof import("../../src/storage/synalux.js")["SynaluxStorage"];

  beforeEach(async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    SynaluxStorage = await importFreshSynaluxStorage();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("uses the authenticated portal projection instead of inherited Supabase reads", async () => {
    const rows = [{ project: "example-project", keywords: ["debugging"], created_at: "2026-09-18" }];
    fetchMock.mockResolvedValueOnce(freshJwtResp()).mockResolvedValueOnce(jsonResponse(200, {
      status: "success", action: "dashboard_ledger", ledger: rows,
    }));

    const s = new SynaluxStorage();
    await expect(s.getDashboardGraphEntries({
      project: " example-project ",
      createdAfter: "2026-09-01T00:00:00.000Z",
      minImportance: 1,
      keywords: ["debugging"],
      limit: 200,
    })).resolves.toEqual(rows);
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      action: "dashboard_ledger",
      project: "example-project",
      created_after: "2026-09-01T00:00:00.000Z",
      min_importance: 1,
      keywords: ["debugging"],
      limit: 200,
    });
  });

  it.each([0, -1, 201, 1.5])("rejects unsafe graph limit %s before network access", async limit => {
    const s = new SynaluxStorage();
    await expect(s.getDashboardGraphEntries({ limit })).rejects.toThrow("Invalid dashboard graph limit");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed filters before network access", async () => {
    const s = new SynaluxStorage();
    await expect(s.getDashboardGraphEntries({ limit: 10, createdAfter: "bad" })).rejects.toThrow("timestamp");
    await expect(s.getDashboardGraphEntries({ limit: 10, createdAfter: "1" })).rejects.toThrow("timestamp");
    await expect(s.getDashboardGraphEntries({ limit: 10, minImportance: 1.5 })).rejects.toThrow("importance");
    await expect(s.getDashboardGraphEntries({ limit: 10, minImportance: 2147483648 })).rejects.toThrow("importance");
    await expect(s.getDashboardGraphEntries({ limit: 10, keywords: [] })).rejects.toThrow("keywords");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails loudly when the portal response omits ledger[]", async () => {
    fetchMock.mockResolvedValueOnce(freshJwtResp()).mockResolvedValueOnce(jsonResponse(200, {
      status: "success", rows: [],
    }));
    const s = new SynaluxStorage();
    await expect(s.getDashboardGraphEntries({ limit: 30 })).rejects.toThrow("ledger[] is required");
  });
});
