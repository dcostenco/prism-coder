import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSupabaseRpc = vi.fn();
const mockSupabaseGet = vi.fn();
const mockSupabasePost = vi.fn();
const mockSupabasePatch = vi.fn();
const mockSupabaseDelete = vi.fn();

vi.mock("../../src/utils/supabaseApi.js", () => ({
  supabaseRpc: (...args: any[]) => mockSupabaseRpc(...args),
  supabaseGet: (...args: any[]) => mockSupabaseGet(...args),
  supabasePost: (...args: any[]) => mockSupabasePost(...args),
  supabasePatch: (...args: any[]) => mockSupabasePatch(...args),
  supabaseDelete: (...args: any[]) => mockSupabaseDelete(...args),
}));

vi.mock("../../src/storage/configStorage.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  getAllSettings: vi.fn(async () => ({})),
}));

vi.mock("../../src/storage/supabaseMigrations.js", () => ({
  runAutoMigrations: vi.fn(async () => {}),
}));


describe("SupabaseStorage summarizeWeakLinks", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSupabaseRpc.mockReset();
    mockSupabaseGet.mockReset();
  });

  it("uses RPC aggregate result when available", async () => {
    // First RPC call in summarizeWeakLinks is the aggregate endpoint
    mockSupabaseRpc.mockResolvedValueOnce([
      {
        sources_considered: 7,
        links_scanned: 42,
        links_soft_pruned: 9,
      },
    ]);

    const { SupabaseStorage } = await import("../../src/storage/supabase.js");
    const storage = new SupabaseStorage();

    const result = await storage.summarizeWeakLinks("proj", "user", 0.15, 25, 25);

    expect(mockSupabaseRpc).toHaveBeenCalledWith("prism_summarize_weak_links", {
      p_project: "proj",
      p_user_id: "user",
      p_min_strength: 0.15,
      p_max_source_entries: 25,
      p_max_links_per_source: 25,
    });

    expect(result).toEqual({
      sources_considered: 7,
      links_scanned: 42,
      links_soft_pruned: 9,
    });
  });

  it("falls back to iterative path when RPC fails", async () => {
    // RPC fast-path fails
    mockSupabaseRpc.mockRejectedValueOnce(new Error("rpc missing"));

    // Fallback getLedgerEntries path
    mockSupabaseGet.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]);

    // Fallback getLinksFrom uses prism_get_links_from RPC twice
    mockSupabaseRpc
      .mockResolvedValueOnce([
        { source_id: "a", target_id: "x", link_type: "related_to", strength: 0.1 },
        { source_id: "a", target_id: "y", link_type: "related_to", strength: 0.8 },
      ])
      .mockResolvedValueOnce([
        { source_id: "b", target_id: "z", link_type: "related_to", strength: 0.05 },
      ]);

    const { SupabaseStorage } = await import("../../src/storage/supabase.js");
    const storage = new SupabaseStorage();

    const result = await storage.summarizeWeakLinks("proj", "user", 0.15, 25, 25);

    expect(result).toEqual({
      sources_considered: 2,
      links_scanned: 3,
      links_soft_pruned: 2,
    });

    // Ensure fallback actually used link RPCs after aggregate failure
    expect(mockSupabaseRpc).toHaveBeenCalledWith("prism_get_links_from", expect.any(Object));
  });
});


describe("SupabaseStorage ACT-R access log methods", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSupabaseRpc.mockReset();
    mockSupabaseGet.mockReset();
    mockSupabasePost.mockReset();
    mockSupabasePatch.mockReset();
    mockSupabaseDelete.mockReset();
  });

  it("logAccess calls prism_log_access as fire-and-forget", async () => {
    mockSupabaseRpc.mockResolvedValueOnce(null);

    const { SupabaseStorage } = await import("../../src/storage/supabase.js");
    const storage = new SupabaseStorage();

    storage.logAccess("11111111-1111-1111-1111-111111111111", "ctx-hash");
    await Promise.resolve();

    expect(mockSupabaseRpc).toHaveBeenCalledWith(
      "prism_log_access",
      expect.objectContaining({
        p_user_id: "default",
        p_entry_id: "11111111-1111-1111-1111-111111111111",
        p_context_hash: "ctx-hash",
      })
    );

    const args = mockSupabaseRpc.mock.calls[0][1];
    expect(typeof args.p_accessed_at).toBe("string");
  });

  it("getAccessLog returns grouped Date arrays from RPC rows", async () => {
    mockSupabaseRpc.mockResolvedValueOnce([
      {
        entry_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        accessed_at: "2026-04-01T12:00:00.000Z",
      },
      {
        entry_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        accessed_at: "2026-04-01T11:00:00.000Z",
      },
      {
        entry_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        accessed_at: "2026-04-01T10:00:00.000Z",
      },
    ]);

    const { SupabaseStorage } = await import("../../src/storage/supabase.js");
    const storage = new SupabaseStorage();

    const map = await storage.getAccessLog([
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    ], 10);

    expect(mockSupabaseRpc).toHaveBeenCalledWith("prism_get_access_log", {
      p_user_id: "default",
      p_entry_ids: [
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      ],
      p_max_per_entry: 10,
    });

    expect(map.get("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")?.length).toBe(2);
    expect(map.get("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")?.length).toBe(1);
    expect(map.get("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")?.[0]).toBeInstanceOf(Date);
  });

  it("getAccessLog returns empty map on RPC failure", async () => {
    mockSupabaseRpc.mockRejectedValueOnce(new Error("rpc missing"));

    const { SupabaseStorage } = await import("../../src/storage/supabase.js");
    const storage = new SupabaseStorage();

    const map = await storage.getAccessLog(["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"], 5);
    expect(map.size).toBe(0);
  });

  it("pruneAccessLog returns numeric count from scalar RPC response", async () => {
    mockSupabaseRpc.mockResolvedValueOnce(7);

    const { SupabaseStorage } = await import("../../src/storage/supabase.js");
    const storage = new SupabaseStorage();

    const count = await storage.pruneAccessLog(90);
    expect(count).toBe(7);
    expect(mockSupabaseRpc).toHaveBeenCalledWith("prism_prune_access_log", {
      p_older_than_days: 90,
    });
  });

  it("pruneAccessLog returns numeric count from PostgREST scalar wrapper", async () => {
    mockSupabaseRpc.mockResolvedValueOnce([{ prism_prune_access_log: 5 }]);

    const { SupabaseStorage } = await import("../../src/storage/supabase.js");
    const storage = new SupabaseStorage();

    const count = await storage.pruneAccessLog(14);
    expect(count).toBe(5);
  });

  it("pruneAccessLog returns 0 on RPC failure", async () => {
    mockSupabaseRpc.mockRejectedValueOnce(new Error("rpc missing"));

    const { SupabaseStorage } = await import("../../src/storage/supabase.js");
    const storage = new SupabaseStorage();

    const count = await storage.pruneAccessLog(30);
    expect(count).toBe(0);
  });
});
