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
