/**
 * Tests — prism-mcp Project Resolver (local config storage variant)
 *
 * Mirrors the Synalux portal project-resolver test suite
 * but exercises the prism-mcp port that reads/writes the local
 * prism-config.db `repo_path:*` settings instead of the synalux portal
 * `prism_projects` table.
 *
 * Includes the regression case for the 2026-04-30 prism-aac Azure-leak
 * memory-loss bug: declared project="prism-mcp", files under prism-aac.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/storage/configStorage.js", () => ({
  getAllSettings: vi.fn(() => Promise.resolve({})),
  setSetting: vi.fn(() => Promise.resolve()),
  getSetting: vi.fn(() => Promise.resolve("")),
  initConfigStorage: vi.fn(),
  getSettingSync: vi.fn(() => ""),
}));

vi.mock("../../src/utils/logger.js", () => ({
  sanitizeForLog: vi.fn((s: string) => s),
  debugLog: vi.fn(),
}));

import {
  getAllSettings,
  setSetting,
} from "../../src/storage/configStorage.js";
import {
  resolveProject,
  commonPathPrefix,
} from "../../src/utils/projectResolver.js";

const mockGetAllSettings = vi.mocked(getAllSettings);
const mockSetSetting = vi.mocked(setSetting);

describe("commonPathPrefix", () => {
  it("returns longest shared directory across multiple files", () => {
    expect(
      commonPathPrefix([
        "/Users/admin/prism-aac/src/index.ts",
        "/Users/admin/prism-aac/src/tts.ts",
      ])
    ).toBe("/Users/admin/prism-aac/src");
  });

  it("falls back to repo root when files diverge into subdirs", () => {
    expect(
      commonPathPrefix([
        "/Users/admin/prism-aac/src/index.ts",
        "/Users/admin/prism-aac/tests/foo.test.ts",
      ])
    ).toBe("/Users/admin/prism-aac");
  });

  it("returns empty string when only a single file with no parent dir", () => {
    expect(commonPathPrefix(["/etc/passwd"])).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(commonPathPrefix([])).toBe("");
  });

  it("normalizes Windows backslashes", () => {
    expect(
      commonPathPrefix([
        "C:\\repos\\prism\\src\\a.ts",
        "C:\\repos\\prism\\src\\b.ts",
      ])
    ).toBe("C:/repos/prism/src");
  });
});

describe("resolveProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllSettings.mockResolvedValue({});
    mockSetSetting.mockResolvedValue(undefined);
  });

  it("accepts the declared project as-is when files_changed is empty", async () => {
    const result = await resolveProject("anything", []);
    expect(result).toEqual({ ok: true, project: "anything" });
  });

  it("accepts when files_changed is undefined", async () => {
    const result = await resolveProject("anything", undefined);
    expect(result).toEqual({ ok: true, project: "anything" });
  });

  it("REJECTS the original prism-aac → prism-mcp memory-loss case", async () => {
    mockGetAllSettings.mockResolvedValue({
      "repo_path:prism-aac": "/Users/admin/prism-aac",
      "repo_path:prism-mcp": "/Users/admin/prism",
    });

    const result = await resolveProject("prism-mcp", [
      "/Users/admin/prism-aac/src/index.ts",
      "/Users/admin/prism-aac/services/aiProvider.ts",
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('declared "prism-mcp"');
      expect(result.error).toContain('"prism-aac"');
      expect(result.hint).toContain('project="prism-aac"');
    }
  });

  it("accepts when declared project matches the registry-derived project", async () => {
    mockGetAllSettings.mockResolvedValue({
      "repo_path:prism-aac": "/Users/admin/prism-aac",
    });

    const result = await resolveProject("prism-aac", [
      "/Users/admin/prism-aac/src/index.ts",
    ]);

    expect(result).toEqual({ ok: true, project: "prism-aac" });
  });

  it("auto-creates registry entry on first save with derivable prefix", async () => {
    mockGetAllSettings.mockResolvedValue({});

    const result = await resolveProject("fresh-project", [
      "/Users/admin/fresh-project/src/index.ts",
      "/Users/admin/fresh-project/src/main.ts",
    ]);

    expect(result).toEqual({
      ok: true,
      project: "fresh-project",
      autoCreated: true,
    });
    expect(mockSetSetting).toHaveBeenCalledWith(
      "repo_path:fresh-project",
      "/Users/admin/fresh-project/src"
    );
  });

  it("accepts new project without auto-create when no path prefix derivable", async () => {
    mockGetAllSettings.mockResolvedValue({});

    const result = await resolveProject("loose", ["/etc/passwd"]);

    expect(result).toEqual({ ok: true, project: "loose" });
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it("ignores non-repo_path keys in the settings table", async () => {
    mockGetAllSettings.mockResolvedValue({
      "repo_path:prism-aac": "/Users/admin/prism-aac",
      "compaction_auto": "true",
      "agent_name": "claude",
      "default_role": "dev",
      "SUPABASE_URL": "https://example.com",
    });

    const result = await resolveProject("prism-aac", [
      "/Users/admin/prism-aac/src/index.ts",
    ]);

    expect(result).toEqual({ ok: true, project: "prism-aac" });
  });

  it("picks the longest matching repo_path when registry has nested entries", async () => {
    mockGetAllSettings.mockResolvedValue({
      "repo_path:monorepo": "/Users/admin",
      "repo_path:prism-aac": "/Users/admin/prism-aac",
    });

    const result = await resolveProject("monorepo", [
      "/Users/admin/prism-aac/src/index.ts",
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('"prism-aac"');
    }
  });

  it("survives setSetting failure during auto-create", async () => {
    mockGetAllSettings.mockResolvedValue({});
    mockSetSetting.mockRejectedValueOnce(new Error("disk full"));

    const result = await resolveProject("fresh", [
      "/Users/admin/fresh/a.ts",
      "/Users/admin/fresh/b.ts",
    ]);

    expect(result).toEqual({
      ok: true,
      project: "fresh",
      autoCreated: true,
    });
  });

  it("trims and ignores empty repo_path values", async () => {
    mockGetAllSettings.mockResolvedValue({
      "repo_path:prism-aac": "/Users/admin/prism-aac",
      "repo_path:empty-one": "",
      "repo_path:whitespace": "   ",
    });

    const result = await resolveProject("prism-aac", [
      "/Users/admin/prism-aac/src/index.ts",
    ]);

    expect(result).toEqual({ ok: true, project: "prism-aac" });
  });
});
