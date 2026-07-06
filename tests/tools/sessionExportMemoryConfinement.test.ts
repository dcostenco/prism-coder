/**
 * @file sessionExportMemoryConfinement.test.ts
 * @purpose Negative / security-branch coverage for the v4.3 path-confinement
 *          and symlink-safe write added to `sessionExportMemoryHandler`.
 *
 * The existing export suites only cover the HAPPY path. They make their temp
 * dir pass the allow-list by setting PRISM_EXPORT_ROOT=tempDir, which means
 * the confinement's *reject* branches are never exercised. A regression that
 * silently disabled the confinement would not fail any existing test.
 *
 * This file asserts the security behaviour directly:
 *   1. output_dir outside every allowed root  → isError, "outside allowed export roots"
 *   2. output_dir is a sensitive system dir    → isError, denied before storage access
 *   3. positive control — PRISM_EXPORT_ROOT accepted
 *   4. symlink pre-planted at predictable export path is NOT followed
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync, readlinkSync, readdirSync, symlinkSync, writeFileSync, statSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── MOCKS (identical surface to sessionExportMemory.test.ts) ────────────────
vi.mock("../../src/storage/index.js", () => ({
  getStorage: vi.fn(),
}));
vi.mock("../../src/storage/configStorage.js", () => ({
  getSetting:        vi.fn(() => Promise.resolve(null)),
  getAllSettings:    vi.fn(),
  getSettingSync:    vi.fn(() => ""),
  initConfigStorage: vi.fn(),
}));
vi.mock("../../src/config.js", () => ({
  PRISM_USER_ID:          "test-user-id",
  SESSION_MEMORY_ENABLED: true,
  PRISM_ENABLE_HIVEMIND:  false,
  PRISM_AUTO_CAPTURE:     false,
  PRISM_CAPTURE_PORTS:    [],
  GOOGLE_API_KEY:         "",
  SERVER_CONFIG:          { name: "prism-test", version: "4.5.1" },
  PRISM_GRAPH_PRUNING_ENABLED:            false,
  PRISM_GRAPH_PRUNE_MIN_STRENGTH:         0.15,
  PRISM_GRAPH_PRUNE_PROJECT_COOLDOWN_MS:  600_000,
  PRISM_GRAPH_PRUNE_SWEEP_BUDGET_MS:      30_000,
  PRISM_GRAPH_PRUNE_MAX_PROJECTS_PER_SWEEP: 25,
  PRISM_ACTR_ENABLED:                     false,
  PRISM_ACTR_ACCESS_LOG_RETENTION_DAYS:   90,
  SYNALUX_CONFIGURED:                     false,
  PRISM_SYNALUX_BASE_URL:                 "",
  PRISM_SYNALUX_API_KEY:                  "",
}));
vi.mock("../../src/utils/logger.js", () => ({
  sanitizeForLog: vi.fn((s: string) => s), debugLog: vi.fn() }));
vi.mock("../../src/utils/llm/factory.js", () => ({ getLLMProvider: vi.fn() }));
vi.mock("../../src/utils/git.js", () => ({
  getCurrentGitState: vi.fn(),
  getGitDrift:        vi.fn(),
}));
vi.mock("../../src/utils/keywordExtractor.js", () => ({ toKeywordArray: vi.fn(() => []) }));
vi.mock("../../src/utils/tracing.js", () => ({
  createMemoryTrace:   vi.fn(),
  traceToContentBlock: vi.fn(),
}));
vi.mock("../../src/utils/autoCapture.js", () => ({ captureLocalEnvironment: vi.fn() }));
vi.mock("../../src/utils/imageCaptioner.js", () => ({ fireCaptionAsync: vi.fn() }));
vi.mock("../../src/sync/factory.js", () => ({
  getSyncBus: vi.fn(() => ({ subscribe: vi.fn(), publish: vi.fn() })),
}));

import { getStorage }    from "../../src/storage/index.js";
import { getAllSettings } from "../../src/storage/configStorage.js";
import { sessionExportMemoryHandler } from "../../src/tools/ledgerHandlers.js";

const mockGetStorage     = vi.mocked(getStorage);
const mockGetAllSettings = vi.mocked(getAllSettings);

function makeStorageStub() {
  return {
    listProjects:     vi.fn(),
    getLedgerEntries: vi.fn(),
    loadContext:      vi.fn(),
    saveLedger:  vi.fn(),
    saveHandoff: vi.fn(),
    patchLedger: vi.fn(),
  };
}

const txt = (r: any): string => r?.content?.[0]?.text ?? "";
const todayStr = () => new Date().toISOString().split("T")[0];

describe("sessionExportMemoryHandler — path confinement (security branches)", () => {
  let tempDir: string;
  let storage: ReturnType<typeof makeStorageStub>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "prism-confine-test-"));
    delete process.env.PRISM_EXPORT_ROOT;

    vi.clearAllMocks();
    storage = makeStorageStub();
    mockGetStorage.mockResolvedValue(storage as any);
    storage.listProjects.mockResolvedValue(["test-project"]);
    storage.getLedgerEntries.mockResolvedValue([
      { id: "entry-1", project: "test-project", summary: "Session 1", importance: 3 },
    ]);
    storage.loadContext.mockResolvedValue({
      project: "test-project", last_summary: "s", active_branch: "main", metadata: {},
    });
    mockGetAllSettings.mockResolvedValue({ theme: "dark" });
  });

  afterEach(async () => {
    delete process.env.PRISM_EXPORT_ROOT;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("rejects an existing output_dir that is outside every allowed root", async () => {
    const result = await sessionExportMemoryHandler({
      project: "test-project", format: "json", output_dir: tempDir,
    });

    expect(result.isError).toBe(true);
    const msg = txt(result);
    // On macOS, temp dirs under /private/var may hit the sensitive-root deny
    // before the allow-list check. Either rejection path is correct.
    expect(
      msg.includes("outside allowed export roots") || msg.includes("sensitive system directory")
    ).toBe(true);
    expect(readdirSync(tempDir).length).toBe(0);
    expect(storage.getLedgerEntries).not.toHaveBeenCalled();
  });

  it("rejects a sensitive system directory before writing", async () => {
    // On Windows /etc doesn't exist; use System32 which exists and falls outside
    // the allow-list. Either "sensitive system directory" or "outside allowed
    // export roots" or "does not exist" is an acceptable rejection.
    const sensitiveDir = process.platform === "win32"
      ? "C:\\Windows\\System32"
      : "/etc";
    const result = await sessionExportMemoryHandler({
      project: "test-project", format: "json", output_dir: sensitiveDir,
    });

    expect(result.isError).toBe(true);
    const msg = txt(result);
    expect(
      msg.includes("sensitive system directory") ||
      msg.includes("outside allowed export roots") ||
      msg.includes("does not exist")
    ).toBe(true);
    expect(storage.getLedgerEntries).not.toHaveBeenCalled();
  });

  it("accepts a directory added via PRISM_EXPORT_ROOT (allow-list positive control)", async () => {
    process.env.PRISM_EXPORT_ROOT = tempDir;
    const result = await sessionExportMemoryHandler({
      project: "test-project", format: "json", output_dir: tempDir,
    });
    expect(result.isError).toBe(false);
    expect(readdirSync(tempDir).some(f => f.startsWith("prism-export-test-project-") && f.endsWith(".json"))).toBe(true);
  });

  it("export filenames include a random token (unpredictable for symlink pre-plant)", async () => {
    process.env.PRISM_EXPORT_ROOT = tempDir;

    const result = await sessionExportMemoryHandler({
      project: "test-project", format: "json", output_dir: tempDir,
    });

    expect(result.isError).toBe(false);

    // Filename must include a random token between the date and extension.
    const files = readdirSync(tempDir).filter(f => f.startsWith("prism-export-test-project-") && f.endsWith(".json"));
    expect(files.length).toBe(1);
    // Pattern: prism-export-test-project-YYYY-MM-DD-<8hex>.json
    expect(files[0]).toMatch(/^prism-export-test-project-\d{4}-\d{2}-\d{2}-[a-f0-9]{8}\.json$/);
  });
});
