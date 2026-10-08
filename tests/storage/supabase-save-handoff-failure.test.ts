/**
 * A handoff the Supabase RPC failed to save must not be reported as saved.
 *
 * SupabaseStorage.saveHandoff used to catch the RPC error and return
 * { status: "updated" }, so the handler replied "✅ Handoff updated" and the
 * agent ended its session believing the next one would start from it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSupabaseRpc = vi.fn();

vi.mock("../../src/utils/supabaseApi.js", () => ({
  supabaseRpc: (...args: unknown[]) => mockSupabaseRpc(...args),
  supabaseGet: vi.fn(),
  supabasePost: vi.fn(),
  supabasePatch: vi.fn(),
  supabaseDelete: vi.fn(),
}));

vi.mock("../../src/storage/configStorage.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  getAllSettings: vi.fn(async () => ({})),
}));

vi.mock("../../src/storage/supabaseMigrations.js", () => ({
  runAutoMigrations: vi.fn(async () => {}),
}));

const HANDOFF = { project: "widgets", user_id: "user-1", last_summary: "landed", version: 3 };

describe("SupabaseStorage.saveHandoff", () => {
  beforeEach(() => {
    vi.resetModules();
    mockSupabaseRpc.mockReset();
  });

  it("rejects when the RPC fails instead of reporting an update", async () => {
    mockSupabaseRpc.mockRejectedValueOnce(new Error("connection reset"));
    const { SupabaseStorage } = await import("../../src/storage/supabase.js");
    await expect(new SupabaseStorage().saveHandoff(HANDOFF, 3))
      .rejects.toThrow('Handoff for project "widgets" was not saved: connection reset');
  });

  it("still returns the RPC's own result when it succeeds or conflicts", async () => {
    const { SupabaseStorage } = await import("../../src/storage/supabase.js");
    mockSupabaseRpc.mockResolvedValueOnce([{ status: "updated", version: 4 }]);
    await expect(new SupabaseStorage().saveHandoff(HANDOFF, 3)).resolves.toEqual({ status: "updated", version: 4 });
    mockSupabaseRpc.mockResolvedValueOnce([{ status: "conflict", current_version: 5 }]);
    await expect(new SupabaseStorage().saveHandoff(HANDOFF, 3)).resolves.toEqual({ status: "conflict", current_version: 5 });
  });
});
