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
        "/Users/example/prism-aac/src/index.ts",
        "/Users/example/prism-aac/src/tts.ts",
      ])
    ).toBe("/Users/example/prism-aac/src");
  });

  it("falls back to repo root when files diverge into subdirs", () => {
    expect(
      commonPathPrefix([
        "/Users/example/prism-aac/src/index.ts",
        "/Users/example/prism-aac/tests/foo.test.ts",
      ])
    ).toBe("/Users/example/prism-aac");
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

  it("WARNS on the original memory-loss case and saves as declared (v14: never refuses)", async () => {
    mockGetAllSettings.mockResolvedValue({
      "repo_path:prism-aac": "/Users/example/prism-aac",
      "repo_path:prism-mcp": "/Users/example/prism",
    });

    const result = await resolveProject("prism-mcp", [
      "/Users/example/prism-aac/src/index.ts",
      "/Users/example/prism-aac/services/aiProvider.ts",
    ]);

    // 2026-08-13: this used to hard-reject — and live registries turned out to
    // contain auto-created junk, so the reject was dropping legitimate saves.
    // The wrong-project signal survives as an advisory warning.
    expect(result.ok).toBe(true);
    expect(result.project).toBe("prism-mcp");
    expect(result.warning).toContain('"prism-aac"');
    expect(result.warning).toContain('"prism-mcp"');
  });

  it("accepts when declared project matches the registry-derived project", async () => {
    mockGetAllSettings.mockResolvedValue({
      "repo_path:prism-aac": "/Users/example/prism-aac",
    });

    const result = await resolveProject("prism-aac", [
      "/Users/example/prism-aac/src/index.ts",
    ]);

    expect(result).toEqual({ ok: true, project: "prism-aac" });
  });

  it("auto-creates registry entry on first save with derivable prefix", async () => {
    mockGetAllSettings.mockResolvedValue({});

    const result = await resolveProject("fresh-project", [
      "/Users/example/fresh-project/src/index.ts",
      "/Users/example/fresh-project/src/main.ts",
    ]);

    expect(result).toEqual({
      ok: true,
      project: "fresh-project",
      autoCreated: true,
    });
    expect(mockSetSetting).toHaveBeenCalledWith(
      "repo_path:fresh-project",
      "/Users/example/fresh-project/src"
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
      "repo_path:prism-aac": "/Users/example/prism-aac",
      "compaction_auto": "true",
      "agent_name": "claude",
      "default_role": "dev",
      "SUPABASE_URL": "https://example.com",
    });

    const result = await resolveProject("prism-aac", [
      "/Users/example/prism-aac/src/index.ts",
    ]);

    expect(result).toEqual({ ok: true, project: "prism-aac" });
  });

  it("picks the longest matching repo_path when registry has nested entries", async () => {
    mockGetAllSettings.mockResolvedValue({
      "repo_path:monorepo": "/Users/example",
      "repo_path:prism-aac": "/Users/example/prism-aac",
    });

    const result = await resolveProject("monorepo", [
      "/Users/example/prism-aac/src/index.ts",
    ]);

    // Longest-match derivation is unchanged; since v14 it surfaces as a
    // warning on the saved-as-declared result instead of a rejection.
    expect(result.ok).toBe(true);
    expect(result.project).toBe("monorepo");
    expect(result.warning).toContain('"prism-aac"');
  });

  it("survives setSetting failure during auto-create", async () => {
    mockGetAllSettings.mockResolvedValue({});
    mockSetSetting.mockRejectedValueOnce(new Error("disk full"));

    const result = await resolveProject("fresh", [
      "/Users/example/fresh/a.ts",
      "/Users/example/fresh/b.ts",
    ]);

    expect(result).toEqual({
      ok: true,
      project: "fresh",
      autoCreated: true,
    });
  });

  it("trims and ignores empty repo_path values", async () => {
    mockGetAllSettings.mockResolvedValue({
      "repo_path:prism-aac": "/Users/example/prism-aac",
      "repo_path:empty-one": "",
      "repo_path:whitespace": "   ",
    });

    const result = await resolveProject("prism-aac", [
      "/Users/example/prism-aac/src/index.ts",
    ]);

    expect(result).toEqual({ ok: true, project: "prism-aac" });
  });
});
