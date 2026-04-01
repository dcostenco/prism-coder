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
