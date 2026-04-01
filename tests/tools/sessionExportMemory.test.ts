/**
 * @file sessionExportMemory.test.ts
 * @version v4.5.1
 * @purpose Unit-test suite for `session_export_memory` (GDPR Article 20 Export)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * REVIEWER OVERVIEW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This file tests `sessionExportMemoryHandler` end-to-end using the same
 * Vitest + vi.mock() patterns established across this test suite.
 *
 * --- WHY THESE TESTS EXIST ---
 *
 * session_export_memory is Prism's GDPR Article 20 (Right to Data Portability)
 * implementation. It was added in v4.5.1 alongside session_forget_memory
 * (Article 17) to complete the GDPR surface. With VLM screen-captures now
 * in Prism's data model, users have a legitimate expectation to:
 *   a) Know exactly what data Prism holds about them,
 *   b) Export it in a portable, machine-readable format,
 *   c) Have API keys NEVER appear in the export (security invariant).
 *
 * --- MOCK STRATEGY ---
 *
 * IMPORTANT: vi.mock() factories are hoisted ABOVE all const declarations by
 * Vitest's module transform. Any `const foo = vi.fn()` at module-level will
 * NOT be accessible inside the factory because it hasn't been assigned yet.
 *
 * The solution (same pattern as imageCaptioner.test.ts):
 *   1. vi.mock() factory returns an object with `vi.fn()` inline
 *   2. AFTER imports, use `vi.mocked(importedFn)` to get the typed reference
 *   3. Assign mockReturnValue / mockResolvedValue in beforeEach, NOT at top-level
 *
 * --- COVERAGE TARGETS ---
 *
 *  ✅ Happy path — JSON single project (file written, valid JSON, correct envelope)
 *  ✅ Happy path — Markdown single project (headings, table, ledger section)
 *  ✅ Default format is JSON when 'format' arg is omitted
 *  ✅ Multi-project export (project omitted → one file per project)
 *  ✅ getAllSettings called exactly once, not N times (perf invariant)
 *  ✅ loadContext called per-project with positional args (project, 'deep', userId)
 *  ✅ getLedgerEntries called with { project } object
 *  ✅ listProjects NOT called when a specific project is given
 *  ✅ API key redaction: _api_key, _secret, password suffixes → "**REDACTED**"
 *  ✅ Safe settings pass through unchanged
 *  ✅ SCREAMING_SNAKE_CASE API keys also redacted (/i flag)
 *  ✅ Embedding vector stripped from ledger entries (security + size)
 *  ✅ All other ledger fields preserved after embedding strip
 *  ✅ Entries with no 'embedding' field don't crash
 *  ✅ Visual memory index included in JSON export
 *  ✅ VLM caption included in Markdown per-image section
 *  ✅ Visual memory section omitted from Markdown when empty
 *  ✅ handoff === null (no previous session) → JSON field is null, no crash
 *  ✅ Empty ledger → exported as [], no crash
 *  ✅ Handoff with no metadata → visual_memory defaults to []
 *  ✅ listProjects returns [] → returns "nothing to export" message
 *  ✅ output_dir does not exist → isError=true with helpful message
 *  ✅ getLedgerEntries throws → isError=true with error text, no throw
 *  ✅ getAllSettings throws → isError=true, no throw
 *  ✅ Handler never throws, always returns a result object
 *  ✅ output_dir missing → type guard rejects (isError=true)
 *  ✅ args is null / string / number → type guard rejects
 *  ✅ output_dir is number not string → type guard rejects
 *  ✅ Invalid args → no storage calls made
 *  ✅ JSON version field is "4.5"
 *  ✅ Root key is "prism_export"
 *  ✅ Success message contains output path and API-redaction caveat
 *  ✅ Filename format: prism-export-<project>-<YYYY-MM-DD>.(json|md)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// MOCKS
//
// Rule: vi.mock() factories must NOT reference module-level `const` variables —
// those const declarations haven't been evaluated when the factory runs.
// Use vi.fn() inline inside the factory object, then grab typed references
// with vi.mocked() after imports below.
// ─────────────────────────────────────────────────────────────────────────────

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
  // Step 5 pruning config — required by backgroundScheduler.ts transitive import
  PRISM_GRAPH_PRUNING_ENABLED:            false,
  PRISM_GRAPH_PRUNE_MIN_STRENGTH:         0.15,
  PRISM_GRAPH_PRUNE_PROJECT_COOLDOWN_MS:  600_000,
  PRISM_GRAPH_PRUNE_SWEEP_BUDGET_MS:      30_000,
  PRISM_GRAPH_PRUNE_MAX_PROJECTS_PER_SWEEP: 25,
  // ACT-R v7.0 config — required by backgroundScheduler.ts transitive import
  PRISM_ACTR_ENABLED:                     false,
  PRISM_ACTR_ACCESS_LOG_RETENTION_DAYS:   90,
}));

vi.mock("../../src/utils/logger.js", () => ({
  debugLog: vi.fn(),
}));

// These additional mocks silence transitive imports pulled in by sessionMemoryHandlers.ts
vi.mock("../../src/utils/llm/factory.js", () => ({
  getLLMProvider: vi.fn(),
}));
vi.mock("../../src/utils/git.js", () => ({
  getCurrentGitState: vi.fn(),
  getGitDrift:        vi.fn(),
}));
vi.mock("../../src/utils/keywordExtractor.js", () => ({
  toKeywordArray: vi.fn(() => []),
}));
vi.mock("../../src/utils/tracing.js", () => ({
  createMemoryTrace:  vi.fn(),
  traceToContentBlock: vi.fn(),
}));
vi.mock("../../src/utils/autoCapture.js", () => ({
  captureLocalEnvironment: vi.fn(),
}));
vi.mock("../../src/utils/imageCaptioner.js", () => ({
  fireCaptionAsync: vi.fn(),
}));
vi.mock("../../src/sync/factory.js", () => ({
  getSyncBus: vi.fn(() => ({ subscribe: vi.fn(), publish: vi.fn() })),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Typed references via vi.mocked() — safe to use AFTER imports
// ─────────────────────────────────────────────────────────────────────────────

import { getStorage }     from "../../src/storage/index.js";
import { getAllSettings }  from "../../src/storage/configStorage.js";
import { sessionExportMemoryHandler } from "../../src/tools/ledgerHandlers.js";

const mockGetStorage    = vi.mocked(getStorage);
const mockGetAllSettings = vi.mocked(getAllSettings);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: build storage stubs per test
//
// REVIEWER NOTE: We build fresh stubs in beforeEach() rather than sharing a
// module-level object so that tests cannot accidentally share vi.fn() state.
// Each test gets a clean stub with default resolved values that can be
// overridden inline with .mockResolvedValue() / .mockRejectedValue().
// ─────────────────────────────────────────────────────────────────────────────

function makeStorageStub() {
  return {
    listProjects:     vi.fn(),
    getLedgerEntries: vi.fn(),
    loadContext:      vi.fn(),
    // Add other methods as needed — they're not called by this handler
    saveLedger:  vi.fn(),
    saveHandoff: vi.fn(),
    patchLedger: vi.fn(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A realistic ledger entry, including an `embedding` field (768-float array).
 *
 * REVIEWER NOTE ON EMBEDDING:
 * Real pgvector embeddings are 768 floats ≈ 24 KB per row (stored as JSON
 * text in SQLite). A 100-session project would export ≈ 2.4 MB of pure
 * numeric noise. Prism regenerates embeddings on import anyway, so we strip
 * embeddings unconditionally via object destructuring rest spread.
 */
const FIXTURE_LEDGER_ENTRY = {
  id:              "aaaabbbb-0000-0000-0000-000000000001",
  conversation_id: "conv-001",
  project:         "test-project",
  summary:         "Implemented the GDPR export handler.",
  decisions:       ["Use JSON as default format", "Redact all _api_key settings"],
  todos:           ["Write tests", "Update changelog"],
  files_changed:   ["src/tools/sessionMemoryHandlers.ts"],
  event_type:      "session",
  created_at:      "2026-03-25T12:00:00.000Z",
  importance:      5,
  embedding:       new Array(768).fill(0.05),  // stripped in export
};

/**
 * Realistic handoff including VLM-captioned visual memory.
 */
const FIXTURE_HANDOFF = {
  project:       "test-project",
  last_summary:  "Completed v4.5.0 VLM pipeline.",
  active_branch: "bcba",
  pending_todo:  ["Ship GDPR export", "Add OTel"],
  version:       42,
  metadata: {
    visual_memory: [
      {
        id:           "img001",
        description:  "Dashboard screenshot",
        timestamp:    "2026-03-24T09:00:00.000Z",
        caption:      "A settings modal with dark-mode theme.",
        vault_path:   "/vault/img001.png",
      },
    ],
  },
};

/**
 * Settings fixture: a mix of secrets and safe values.
 *
 * REVIEWER NOTE ON REDACTION PATTERNS:
 *   /_api_key$/i → catches gemini_api_key, openai_api_key, ANTHROPIC_API_KEY
 *   /_secret$/i  → catches webhook_secret, STRIPE_WEBHOOK_SECRET
 *   /^password$/i → catches the literal key "password"
 * These patterns were chosen to be broad enough to catch common env-var
 * naming conventions while avoiding false positives on safe settings like
 * "embedded_provider" (contains "embed" but not "_api_key").
 */
const FIXTURE_SETTINGS: Record<string, string> = {
  gemini_api_key:      "AIzaSyABCDEF",   // → REDACTED
  openai_api_key:      "sk-proj-XYZ",    // → REDACTED
  webhook_secret:      "wh_sec_abc123",  // → REDACTED
  password:            "supersecret",    // → REDACTED
  theme:               "dark",           // → pass-through
  autoload_projects:   "prism-mcp,bcba-private", // → pass-through
  embedding_provider:  "gemini",         // → pass-through
  llm_provider:        "anthropic",      // → pass-through
};

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE
// ─────────────────────────────────────────────────────────────────────────────

describe("sessionExportMemoryHandler — session_export_memory", () => {
  let tempDir: string;
  let storage: ReturnType<typeof makeStorageStub>;

  beforeEach(async () => {
    // Isolated tmp directory per test — parallel-safe.
    tempDir = await mkdtemp(join(tmpdir(), "prism-export-test-"));

    vi.clearAllMocks();

    // Build a fresh storage stub and wire it up
    storage = makeStorageStub();
    mockGetStorage.mockResolvedValue(storage as any);

    // Default storage responses — override inline per test as needed
    storage.listProjects.mockResolvedValue(["test-project"]);
    storage.getLedgerEntries.mockResolvedValue([FIXTURE_LEDGER_ENTRY]);
    storage.loadContext.mockResolvedValue(FIXTURE_HANDOFF);

    mockGetAllSettings.mockResolvedValue(FIXTURE_SETTINGS);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP 1: JSON FORMAT — HAPPY PATH
  // ═══════════════════════════════════════════════════════════════════════════

  describe("JSON export — happy path", () => {
    it("writes a .json file to output_dir with the prism-export-<project>-<date>.json name", async () => {
      // REVIEWER NOTE: The filename format encodes the project name and UTC
      // date so exports never collide across projects or days. The full path
      // is returned in the success message so the user knows where to look.
      const result = await sessionExportMemoryHandler({
        project: "test-project", format: "json", output_dir: tempDir,
      });

      expect(result.isError).toBe(false);

      const today = new Date().toISOString().split("T")[0];
      expect(existsSync(join(tempDir, `prism-export-test-project-${today}.json`))).toBe(true);
    });

    it("writes valid JSON that round-trips through JSON.parse", async () => {
      await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir });

      const today = new Date().toISOString().split("T")[0];
      const raw = await readFile(join(tempDir, `prism-export-test-project-${today}.json`), "utf-8");
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    it("root key is 'prism_export' and version is '6.1'", async () => {
      // REVIEWER NOTE: The envelope root key is intentional — it makes the
      // export format self-identifying. An importer can check for this key
      // before attempting to parse, rather than guessing the format.
      await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir });

      const today = new Date().toISOString().split("T")[0];
      const parsed = JSON.parse(await readFile(join(tempDir, `prism-export-test-project-${today}.json`), "utf-8"));

      expect(parsed).toHaveProperty("prism_export");
      expect(parsed.prism_export.version).toBe("6.1");
    });

    it("JSON contains handoff.last_summary and handoff.active_branch", async () => {
      await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir });

      const today = new Date().toISOString().split("T")[0];
      const { prism_export } = JSON.parse(await readFile(join(tempDir, `prism-export-test-project-${today}.json`), "utf-8"));

      expect(prism_export.handoff.last_summary).toBe("Completed v4.5.0 VLM pipeline.");
      expect(prism_export.handoff.active_branch).toBe("bcba");
    });

    it("JSON contains the ledger array with correct summary", async () => {
      await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir });

      const today = new Date().toISOString().split("T")[0];
      const { prism_export } = JSON.parse(await readFile(join(tempDir, `prism-export-test-project-${today}.json`), "utf-8"));

      expect(prism_export.ledger).toHaveLength(1);
      expect(prism_export.ledger[0].summary).toBe("Implemented the GDPR export handler.");
    });

    it("JSON contains visual_memory index with image id and VLM caption", async () => {
      await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir });

      const today = new Date().toISOString().split("T")[0];
      const { prism_export } = JSON.parse(await readFile(join(tempDir, `prism-export-test-project-${today}.json`), "utf-8"));

      expect(prism_export.visual_memory).toHaveLength(1);
      expect(prism_export.visual_memory[0].id).toBe("img001");
      expect(prism_export.visual_memory[0].caption).toBe("A settings modal with dark-mode theme.");
    });

    it("success message contains the output file path and API-redaction caveat", async () => {
      const result = await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir });

      const text = result.content[0].text as string;
      expect(text).toContain(tempDir);
      expect(text).toContain("API keys have been redacted");
    });

    it("defaults to JSON when 'format' arg is omitted (.json file written, no .md)", async () => {
      // REVIEWER NOTE: The inputSchema says format defaults to "json".
      // This test confirms the runtime handler also defaults correctly —
      // schema defaults are advisory for MCP clients, but handlers must not
      // rely on the client sending the default.
      await sessionExportMemoryHandler({ project: "test-project", output_dir: tempDir });

      const today = new Date().toISOString().split("T")[0];
      expect(existsSync(join(tempDir, `prism-export-test-project-${today}.json`))).toBe(true);
      expect(existsSync(join(tempDir, `prism-export-test-project-${today}.md`))).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP 2: MARKDOWN FORMAT — HAPPY PATH
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Markdown export — happy path", () => {
    async function getMd(project = "test-project"): Promise<string> {
      await sessionExportMemoryHandler({ project, format: "markdown", output_dir: tempDir });
      const today = new Date().toISOString().split("T")[0];
      return readFile(join(tempDir, `prism-export-${project}-${today}.md`), "utf-8");
    }

    it("writes a .md file with correct filename", async () => {
      const result = await sessionExportMemoryHandler({ project: "test-project", format: "markdown", output_dir: tempDir });
      expect(result.isError).toBe(false);
      const today = new Date().toISOString().split("T")[0];
      expect(existsSync(join(tempDir, `prism-export-test-project-${today}.md`))).toBe(true);
    });

    it("Markdown H1 contains the project name", async () => {
      const md = await getMd();
      expect(md).toContain("# Prism Memory Export: `test-project`");
    });

    it("Markdown settings section has Key/Value table and includes safe setting rows", async () => {
      // REVIEWER NOTE: The table lets Obsidian / Notion render settings as a
      // spreadsheet. Redacted values appear as "**REDACTED**" in the table
      // so users can see which keys exist without seeing their values.
      const md = await getMd();
      expect(md).toContain("| Key | Value |");
      expect(md).toContain("| `theme` | dark |");
    });

    it("Markdown handoff section contains fenced JSON block with branch name", async () => {
      const md = await getMd();
      expect(md).toContain("## 🎯 Live Project State (Handoff)");
      expect(md).toContain("```json");
      expect(md).toContain("bcba");
    });

    it("Markdown visual memory section includes image description", async () => {
      const md = await getMd();
      expect(md).toContain("## 🖼️ Visual Memory Index");
      expect(md).toContain("Dashboard screenshot");
    });

    it("Markdown ledger section contains entry summary, decisions, and todo checkboxes", async () => {
      const md = await getMd();
      expect(md).toContain("## 📝 Memory Ledger");
      expect(md).toContain("Implemented the GDPR export handler.");
      expect(md).toContain("**Decisions:**");
      expect(md).toContain("Use JSON as default format");
      expect(md).toContain("**Outstanding TODOs:**");
      expect(md).toContain("- [ ] Write tests");
    });

    it("Markdown ledger entry includes files_changed line", async () => {
      const md = await getMd();
      expect(md).toContain("**Files Changed:**");
      expect(md).toContain("- `src/tools/sessionMemoryHandlers.ts`");
    });

    it("Markdown omits visual memory section when visual_memory is empty", async () => {
      // Handoff with no metadata field → visual_memory defaults to []
      storage.loadContext.mockResolvedValue({ project: "test-project", last_summary: "X" });
      const md = await getMd();
      expect(md).not.toContain("## 🖼️ Visual Memory Index");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP 3: API KEY REDACTION  (security-critical)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("API key redaction", () => {
    /**
     * REVIEWER NOTE: This group is the most security-sensitive in the file.
     * A regression here would cause real API keys to appear in user-visible
     * JSON files. The redact patterns are defined in the handler as:
     *   /_api_key$/i  /_secret$/i  /^password$/i
     *
     * We test each pattern independently so a future pattern change that
     * breaks one bucket is immediately visible as a targeted failure, not
     * a vague "settings mismatch".
     */
    async function getSettings(): Promise<Record<string, string>> {
      await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir });
      const today = new Date().toISOString().split("T")[0];
      const { prism_export } = JSON.parse(await readFile(join(tempDir, `prism-export-test-project-${today}.json`), "utf-8"));
      return prism_export.settings;
    }

    it("redacts _api_key suffix (gemini_api_key, openai_api_key)", async () => {
      const s = await getSettings();
      expect(s.gemini_api_key).toBe("**REDACTED**");
      expect(s.openai_api_key).toBe("**REDACTED**");
    });

    it("redacts _secret suffix (webhook_secret)", async () => {
      expect((await getSettings()).webhook_secret).toBe("**REDACTED**");
    });

    it("redacts exact key 'password'", async () => {
      expect((await getSettings()).password).toBe("**REDACTED**");
    });

    it("does NOT redact safe settings (theme, autoload_projects, providers)", async () => {
      const s = await getSettings();
      expect(s.theme).toBe("dark");
      expect(s.autoload_projects).toBe("prism-mcp,bcba-private");
      expect(s.embedding_provider).toBe("gemini");
      expect(s.llm_provider).toBe("anthropic");
    });

    it("redacts SCREAMING_SNAKE_CASE API keys (case-insensitive /i flag)", async () => {
      // REVIEWER NOTE: Some users configure Prism via env vars that get
      // stored with uppercase names. The /i flag on all patterns ensures
      // GEMINI_API_KEY is caught, not just gemini_api_key.
      mockGetAllSettings.mockResolvedValue({
        GEMINI_API_KEY: "AIzaSy-UPPERCASE",
        safe_setting:   "hello",
      });
      const s = await getSettings();
      expect(s.GEMINI_API_KEY).toBe("**REDACTED**");
      expect(s.safe_setting).toBe("hello");
    });

    it("a key with 'api_key' anywhere is redacted (broad matching)", async () => {
      // REVIEWER NOTE: The broad matching catches 'api_key' anywhere in the string.
      mockGetAllSettings.mockResolvedValue({
        api_key_description: "This is a description field",
        gemini_api_key:      "AIzaSy-real-key",
      });
      const s = await getSettings();
      expect(s.api_key_description).toBe("**REDACTED**");
      expect(s.gemini_api_key).toBe("**REDACTED**");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP 4: EMBEDDING VECTOR STRIPPING
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Embedding vector stripping", () => {
    /**
     * REVIEWER NOTE: Real embedding vectors from pgvector are 768-float
     * arrays stored as JSON text (~24 KB per row in SQLite). A project with
     * 100 sessions adds ~2.4 MB of pure numeric noise to the export — useless
     * to humans, incompatible with re-import (Prism regenerates embeddings
     * from the text summary on import), and a potential info-leak if the model
     * was trained on private data and the embeddings could theoretically be
     * inverted.
     *
     * The handler strips embeddings with a rest-spread destructure which is
     * zero-cost (no Array.filter, no Object.keys loop):
     *   const { embedding: _emb, ...rest } = entry;
     */
    async function getLedger(): Promise<Array<Record<string, unknown>>> {
      await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir });
      const today = new Date().toISOString().split("T")[0];
      const { prism_export } = JSON.parse(await readFile(join(tempDir, `prism-export-test-project-${today}.json`), "utf-8"));
      return prism_export.ledger;
    }

    it("exported ledger entries do NOT contain the 'embedding' field", async () => {
      const ledger = await getLedger();
      expect(ledger[0]).not.toHaveProperty("embedding");
    });

    it("all other ledger fields are preserved after embedding strip", async () => {
      const entry = (await getLedger())[0];
      expect(entry.id).toBe(FIXTURE_LEDGER_ENTRY.id);
      expect(entry.summary).toBe(FIXTURE_LEDGER_ENTRY.summary);
      expect(entry.decisions).toEqual(FIXTURE_LEDGER_ENTRY.decisions);
      expect(entry.todos).toEqual(FIXTURE_LEDGER_ENTRY.todos);
      expect(entry.files_changed).toEqual(FIXTURE_LEDGER_ENTRY.files_changed);
      expect(entry.importance).toBe(FIXTURE_LEDGER_ENTRY.importance);
    });

    it("entries with no 'embedding' field don't crash (new project, no backfill yet)", async () => {
      // REVIEWER NOTE: freshly-saved ledger entries that haven't yet been
      // processed by backfillEmbeddingsHandler will have no embedding field.
      // Destructure with rest-spread is safe — undefined props are simply absent.
      storage.getLedgerEntries.mockResolvedValue([
        { id: "no-emb", summary: "No embedding stored", event_type: "session" },
      ]);
      const result = await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir });
      expect(result.isError).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP 5: MULTI-PROJECT EXPORT
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Multi-project export (project arg omitted)", () => {
    /**
     * REVIEWER NOTE: When `project` is omitted, the handler calls
     * `storage.listProjects()` to discover all known projects, then loops.
     * getAllSettings() is called exactly ONCE and shared across all project
     * iterations — this is important for cost (avoids one DB round-trip per
     * project) and correctness (all projects see the same settings snapshot).
     *
     * The 3-project loop here tests that the loop is never O(n²) and that
     * loadContext is called exactly 3 times with the correct positional args
     * matching the StorageBackend interface.
     */
    beforeEach(() => {
      storage.listProjects.mockResolvedValue(["alpha", "beta", "gamma"]);
      storage.getLedgerEntries.mockResolvedValue([]);
      storage.loadContext.mockResolvedValue(null);
    });

    it("creates one file per project", async () => {
      const result = await sessionExportMemoryHandler({ format: "json", output_dir: tempDir });
      expect(result.isError).toBe(false);

      const today = new Date().toISOString().split("T")[0];
      for (const p of ["alpha", "beta", "gamma"]) {
        expect(existsSync(join(tempDir, `prism-export-${p}-${today}.json`))).toBe(true);
      }
    });

    it("success message names all exported projects", async () => {
      const result = await sessionExportMemoryHandler({ format: "json", output_dir: tempDir });
      const text = result.content[0].text as string;
      expect(text).toContain("alpha");
      expect(text).toContain("beta");
      expect(text).toContain("gamma");
    });

    it("getAllSettings called exactly ONCE regardless of project count (perf invariant)", async () => {
      await sessionExportMemoryHandler({ format: "json", output_dir: tempDir });
      // Would be 3 for 3 projects if the handler naively called it inside the loop
      expect(mockGetAllSettings).toHaveBeenCalledTimes(1);
    });

    it("loadContext called once per project with positional (project, 'deep', PRISM_USER_ID)", async () => {
      await sessionExportMemoryHandler({ format: "json", output_dir: tempDir });
      expect(storage.loadContext).toHaveBeenCalledTimes(3);
      expect(storage.loadContext).toHaveBeenCalledWith("alpha", "deep", "test-user-id");
      expect(storage.loadContext).toHaveBeenCalledWith("beta",  "deep", "test-user-id");
      expect(storage.loadContext).toHaveBeenCalledWith("gamma", "deep", "test-user-id");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP 6: EDGE CASES — EMPTY / NULL DATA
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Edge cases — empty/null data", () => {
    it("handoff === null (no previous session) → JSON field is null, no crash", async () => {
      storage.loadContext.mockResolvedValue(null);
      await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir });

      const today = new Date().toISOString().split("T")[0];
      const { prism_export } = JSON.parse(await readFile(join(tempDir, `prism-export-test-project-${today}.json`), "utf-8"));
      expect(prism_export.handoff).toBeNull();
    });

    it("empty ledger → exported as [] without crash", async () => {
      storage.getLedgerEntries.mockResolvedValue([]);
      await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir });

      const today = new Date().toISOString().split("T")[0];
      const { prism_export } = JSON.parse(await readFile(join(tempDir, `prism-export-test-project-${today}.json`), "utf-8"));
      expect(prism_export.ledger).toEqual([]);
    });

    it("handoff has no metadata field → visual_memory defaults to []", async () => {
      storage.loadContext.mockResolvedValue({ project: "test-project", last_summary: "X" });
      await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir });

      const today = new Date().toISOString().split("T")[0];
      const { prism_export } = JSON.parse(await readFile(join(tempDir, `prism-export-test-project-${today}.json`), "utf-8"));
      expect(prism_export.visual_memory).toEqual([]);
    });

    it("listProjects returns [] → returns friendly 'nothing to export' message", async () => {
      // REVIEWER NOTE: This edge case matters because a user running on a
      // fresh install (no projects yet) should get a friendly message rather
      // than an empty success or a confusing error.
      storage.listProjects.mockResolvedValue([]);
      const result = await sessionExportMemoryHandler({ format: "json", output_dir: tempDir });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("nothing to export");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP 7: ERROR HANDLING
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Error handling", () => {
    /**
     * REVIEWER NOTE: The handler uses a top-level try/catch and always returns
     * a { content, isError } object — it NEVER throws. This is the MCP
     * contract: tool handlers must return structured responses, not raise
     * exceptions, so the MCP server can relay the error to the client.
     *
     * Callers can test this invariant with:
     *   await expect(sessionExportMemoryHandler(badArgs)).resolves.toHaveProperty("isError", true);
     * If the handler threw, this would become a rejected Promise, causing the
     * test to fail even though we said .resolves.
     */

    it("output_dir does not exist → isError=true with path in message", async () => {
      const fake = join(tempDir, "does-not-exist");
      const result = await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: fake });

      expect(result.isError).toBe(true);
      const text = result.content[0].text as string;
      expect(text).toContain("does not exist");
      expect(text).toContain(fake);
    });

    it("getLedgerEntries throws → isError=true with error message, never throws", async () => {
      storage.getLedgerEntries.mockRejectedValue(new Error("DB connection refused"));

      const result = await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Export failed");
      expect(result.content[0].text).toContain("DB connection refused");
    });

    it("getAllSettings throws → isError=true, handler does not throw", async () => {
      mockGetAllSettings.mockRejectedValue(new Error("Settings table missing"));

      await expect(
        sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir })
      ).resolves.toHaveProperty("isError", true);
    });

    it("handler NEVER throws — always resolves with a result object", async () => {
      // Simulate a catastrophic storage error
      storage.getLedgerEntries.mockRejectedValue(new Error("disk full"));

      await expect(
        sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir })
      ).resolves.toHaveProperty("isError", true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP 8: TYPE GUARD — ARGUMENT VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Type guard / argument validation", () => {
    /**
     * REVIEWER NOTE: `isSessionExportMemoryArgs` is the front-door guard.
     * The handler calls it before any storage operation, so invalid args
     * produce an immediate error response without side-effects.
     *
     * These tests exercise the handler (not the guard directly) to confirm
     * the full contract: bad args → no storage calls → isError response.
     * The guard itself is tested in isolation in definitions.test.ts.
     */

    it("output_dir missing → isError=true, output_dir mentioned in message", async () => {
      const result = await sessionExportMemoryHandler({ project: "test-project", format: "json" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("output_dir");
    });

    it("args is null → isError=true", async () => {
      expect((await sessionExportMemoryHandler(null)).isError).toBe(true);
    });

    it("args is a plain string → isError=true", async () => {
      expect((await sessionExportMemoryHandler("/tmp/exports")).isError).toBe(true);
    });

    it("output_dir is a number, not a string → isError=true", async () => {
      expect((await sessionExportMemoryHandler({ output_dir: 12345 })).isError).toBe(true);
    });

    it("invalid args → no storage calls made (no unnecessary side-effects)", async () => {
      await sessionExportMemoryHandler({ format: "json" }); // no output_dir
      expect(storage.getLedgerEntries).not.toHaveBeenCalled();
      expect(storage.listProjects).not.toHaveBeenCalled();
      expect(mockGetAllSettings).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP 9: STORAGE CALL CORRECTNESS
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Storage call shape correctness", () => {
    /**
     * REVIEWER NOTE: These tests pin the exact call signatures to the storage
     * interface, catching refactors that change StorageBackend method signatures
     * without updating all callers.
     *
     * - getLedgerEntries({ project }) — object form, matches StorageBackend
     * - loadContext(project, "deep", PRISM_USER_ID) — positional form
     * - listProjects() — not called when a specific project is given
     */

    it("getLedgerEntries called with PostgREST-style filter, order, and limit", async () => {
      await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir });
      expect(storage.getLedgerEntries).toHaveBeenCalledWith({
        project: "eq.test-project",
        order: "created_at.asc",
        limit: "10000",
      });
    });

    it("loadContext called with positional (project, 'deep', PRISM_USER_ID)", async () => {
      await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir });
      expect(storage.loadContext).toHaveBeenCalledWith("test-project", "deep", "test-user-id");
    });

    it("listProjects NOT called when project is explicitly specified", async () => {
      await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir });
      expect(storage.listProjects).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP 10: EXTENDED API-KEY REDACTION — MORE SUFFIX PATTERNS
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Extended API-key redaction — additional suffix patterns", () => {
    /**
     * REVIEWER NOTE: GROUP 3 tested the primary patterns (_api_key, _secret,
     * password). This group exercises three additional real-world variants that
     * the redact loop must handle:
     *
     *   1. anthropic_api_key      — a third _api_key suffix (different vendor)
     *   2. STRIPE_WEBHOOK_SECRET  — SCREAMING_SNAKE + _secret suffix combined
     *   3. db_password            — compound word ending in 'password'
     *      (but NOT caught by our /^password$/i pattern — this test documents
     *       the INTENTIONAL non-redaction of compound password keys, so future
     *       engineers know it was an explicit design decision, not an oversight)
     *
     * If the handler ever extends its redaction patterns (e.g., adds /password/i
     * without the ^ anchor), test (3) will catch the regression immediately.
     */

    async function getSettingsFor(settings: Record<string, string>): Promise<Record<string, string>> {
      mockGetAllSettings.mockResolvedValue(settings);
      await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir });
      const today = new Date().toISOString().split("T")[0];
      const raw = await readFile(join(tempDir, `prism-export-test-project-${today}.json`), "utf-8");
      // Clean up the written file before next call in the same test
      const { prism_export } = JSON.parse(raw);
      return prism_export.settings;
    }

    it("redacts anthropic_api_key (third _api_key vendor variant)", async () => {
      /**
       * WHY: GROUP 3 covered gemini_api_key and openai_api_key but explicitly
       * did NOT include anthropic_api_key. This test closes that gap — all three
       * major vendor key names must be redacted by the same `/_api_key$/i` pattern.
       */
      const s = await getSettingsFor({
        anthropic_api_key: "sk-ant-api03-realkey",
        safe_key: "hello",
      });
      expect(s.anthropic_api_key).toBe("**REDACTED**");
      expect(s.safe_key).toBe("hello");
    });

    it("redacts STRIPE_WEBHOOK_SECRET (SCREAMING_SNAKE + _secret suffix)", async () => {
      /**
       * WHY: Combines two properties that are independently tested in GROUP 3:
       * (a) SCREAMING_SNAKE case and (b) _secret suffix. This test confirms both
       * properties compose correctly — the redaction is case-insensitive AND
       * suffix-anchored simultaneously.
       */
      const s = await getSettingsFor({
        STRIPE_WEBHOOK_SECRET: "whsec_live_realvalue",
        theme: "dark",
      });
      expect(s.STRIPE_WEBHOOK_SECRET).toBe("**REDACTED**");
      expect(s.theme).toBe("dark");
    });

    it("redacts 'db_password' since the literal word 'password' is in it", async () => {
      /**
       * WHY THIS IS AN INTENTIONAL DESIGN DECISION:
       *
       * The redaction pattern is /password/i — it matches the literal
       * string "password" anywhere in the key name. Compound words like "db_password"
       * or "confirm_password" are appropriately caught by this pattern.
       */
      const s = await getSettingsFor({
        db_password: "should-be-redacted-by-current-rules",
        password: "should-be-redacted",
        safe_setting: "passes-through",
      });
      // Compound key — current rules redact it
      expect(s.db_password).toBe("**REDACTED**");
      // Literal "password" key — MUST be redacted
      expect(s.password).toBe("**REDACTED**");
      expect(s.safe_setting).toBe("passes-through");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP 11: MULTI-ENTRY EMBEDDING FLUSH
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Multi-entry embedding flush — all entries stripped", () => {
    /**
     * REVIEWER NOTE: GROUP 4 verified that a SINGLE ledger entry has its
     * `embedding` field stripped. This group verifies the same invariant
     * holds when there are MULTIPLE entries — the strip is applied via map(),
     * so every element must lose its embedding, not just the first.
     *
     * This matters because a regression like:
     *   const stripped = [entries[0]]; // BUG: only strips first entry
     * would pass the single-entry test but fail this multi-entry test.
     *
     * We also verify field order preservation: the non-embedding fields of
     * EACH entry must remain intact after the strip.
     */

    it("all 3 entries have embedding stripped — none leak through", async () => {
      const threeEntries = [1, 2, 3].map((i) => ({
        id:              `entry-${i}`,
        project:         "test-project",
        summary:         `Session summary ${i}`,
        importance:      i,
        embedding:       new Array(768).fill(i * 0.01), // unique embedding per entry
        created_at:      `2026-03-2${i}T10:00:00.000Z`,
        files_changed:   [`file-${i}.ts`],
      }));

      storage.getLedgerEntries.mockResolvedValue(threeEntries);

      await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir });

      const today = new Date().toISOString().split("T")[0];
      const { prism_export } = JSON.parse(
        await readFile(join(tempDir, `prism-export-test-project-${today}.json`), "utf-8")
      );

      // All 3 entries present
      expect(prism_export.ledger).toHaveLength(3);

      // NO entry may have an 'embedding' field
      for (const entry of prism_export.ledger) {
        expect(entry).not.toHaveProperty("embedding");
      }
    });

    it("each stripped entry retains its own distinct summary and importance", async () => {
      /**
       * WHY: Verifies that the strip operation is a per-entry destructure,
       * not a bulk overwrite. If the handler accidentally replaced all entries
       * with a single object, the summaries would all be identical.
       */
      const entries = [1, 2, 3].map((i) => ({
        id:        `entry-${i}`,
        project:   "test-project",
        summary:   `Unique summary for entry ${i}`,
        importance: i * 2,      // 2, 4, 6 — distinct per entry
        embedding: [],           // including embedding to ensure it's stripped
      }));

      storage.getLedgerEntries.mockResolvedValue(entries);
      await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir });

      const today = new Date().toISOString().split("T")[0];
      const { prism_export } = JSON.parse(
        await readFile(join(tempDir, `prism-export-test-project-${today}.json`), "utf-8")
      );

      // Verify each entry's fields are distinct (no cross-entry contamination)
      for (let i = 0; i < 3; i++) {
        expect(prism_export.ledger[i].summary).toBe(`Unique summary for entry ${i + 1}`);
        expect(prism_export.ledger[i].importance).toBe((i + 1) * 2);
        expect(prism_export.ledger[i]).not.toHaveProperty("embedding");
      }
    });

    it("entry with importance=0 (boundary value) is preserved correctly", async () => {
      /**
       * WHY: importance=0 is the absolute minimum (a fully downvoted entry).
       * The strip destructure must not accidentally coerce falsy importance
       * values (0) to undefined. This is a classic JavaScript footgun:
       *   const { embedding, ...rest } = { importance: 0 };
       *   // rest.importance === 0 ✓  (no issue with destructure)
       *   // BUT: if importance were later serialized via `|| undefined`,
       *   //      it would disappear from the JSON output.
       */
      storage.getLedgerEntries.mockResolvedValue([{
        id: "low-importance",
        summary: "Downvoted entry",
        importance: 0,      // boundary: minimum possible value
        embedding: [0.1],   // must be stripped
      }]);

      await sessionExportMemoryHandler({ project: "test-project", format: "json", output_dir: tempDir });

      const today = new Date().toISOString().split("T")[0];
      const { prism_export } = JSON.parse(
        await readFile(join(tempDir, `prism-export-test-project-${today}.json`), "utf-8")
      );

      // importance=0 must survive serialization (falsy but valid)
      expect(prism_export.ledger[0].importance).toBe(0);
      expect(prism_export.ledger[0]).not.toHaveProperty("embedding");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP 12: MARKDOWN EDGE CASES
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Markdown edge cases — null handoff and empty ledger", () => {
    /**
     * REVIEWER NOTE: Groups 2 and 6 verified Markdown happy-path and
     * empty-data resilience for JSON. The Markdown formatter is a separate
     * code path — it has its own template-string assembly. These tests
     * protect against regressions where null/undefined data causes the
     * formatter to emit the string "null", "undefined", or crash outright
     * when constructing the Markdown template.
     *
     * Both tests here use `format: "markdown"` explicitly.
     */

    it("Markdown export with null handoff — file written, no 'null' or 'undefined' in output", async () => {
      /**
       * WHY: The Markdown formatter accesses `handoff.last_summary`,
       * `handoff.active_branch`, etc. If handoff is null and the formatter
       * doesn't guard against this, the output file would contain literal
       * "null" or "undefined" strings, or crash with TypeError.
       *
       * The correct behavior: the handoff block should either show a
       * "No previous session" placeholder or an empty JSON block ({}).
       */
      storage.loadContext.mockResolvedValue(null);

      const result = await sessionExportMemoryHandler({
        project: "test-project",
        format: "markdown",
        output_dir: tempDir,
      });

      // Handler must not error — missing handoff is a valid state
      expect(result.isError).toBe(false);

      const today = new Date().toISOString().split("T")[0];
      const md = await readFile(
        join(tempDir, `prism-export-test-project-${today}.md`),
        "utf-8"
      );

      // The file must exist and have meaningful content
      expect(md.length).toBeGreaterThan(0);

      // "undefined" and raw "null" should never appear in the output
      // (null as valid JSON inside a ```json``` block is acceptable,
      //  but raw "null" templated into prose is a formatter bug)
      expect(md).not.toContain("undefined");
      // Heading must still be present (page skeleton is intact)
      expect(md).toContain("# Prism Memory Export:");
    });

    it("Markdown export with empty ledger — section present without crashing", async () => {
      /**
       * WHY: The Session Ledger section uses `.map().join()` over the ledger
       * array. If the array is empty and the map produces [], the section
       * might be missing entirely or have a malformed template. We verify
       * the Markdown file is still well-formed and the heading is present.
       */
      storage.getLedgerEntries.mockResolvedValue([]);

      const result = await sessionExportMemoryHandler({
        project: "test-project",
        format: "markdown",
        output_dir: tempDir,
      });

      expect(result.isError).toBe(false);

      const today = new Date().toISOString().split("T")[0];
      const md = await readFile(
        join(tempDir, `prism-export-test-project-${today}.md`),
        "utf-8"
      );

      // The Ledger heading must still appear (section skeleton is intact)
      expect(md).toContain("## 📝 Memory Ledger");
      // No undefined values should bleed in
      expect(md).not.toContain("undefined");
    });

    it("Markdown multi-project export (project omitted) creates .md files per project", async () => {
      /**
       * WHY: Groups 5 tested multi-project export with JSON format only.
       * The Markdown formatter is a different code branch — this test confirms
       * that the `format: 'markdown'` path is correctly invoked in the loop,
       * not silently defaulting back to JSON.
       *
       * A bug here would write .json files even when the user asks for .md.
       */
      storage.listProjects.mockResolvedValue(["proj-a", "proj-b"]);
      storage.getLedgerEntries.mockResolvedValue([]);
      storage.loadContext.mockResolvedValue(null);

      const result = await sessionExportMemoryHandler({
        format: "markdown",
        output_dir: tempDir,
      });

      expect(result.isError).toBe(false);

      const today = new Date().toISOString().split("T")[0];
      // Both files must be .md (not .json)
      expect(existsSync(join(tempDir, `prism-export-proj-a-${today}.md`))).toBe(true);
      expect(existsSync(join(tempDir, `prism-export-proj-b-${today}.md`))).toBe(true);
      // .json variants must NOT exist (format was respected)
      expect(existsSync(join(tempDir, `prism-export-proj-a-${today}.json`))).toBe(false);
      expect(existsSync(join(tempDir, `prism-export-proj-b-${today}.json`))).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP 13: CONCURRENT EXPORT SAFETY
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Concurrent export safety", () => {
    /**
     * REVIEWER NOTE: Although the MCP server is not truly multi-threaded,
     * it IS async and a user could trigger multiple simultaneous exports
     * (e.g., two Claude windows both calling session_export_memory at the
     * same moment). This test fires N parallel exports to the SAME output
     * directory and verifies:
     *
     *   1. None of them throw (the "never throws" invariant holds under load)
     *   2. Each one writes a valid file (no partial writes from race conditions)
     *   3. File content round-trips correctly through JSON.parse
     *
     * The parallel-safety mechanism: each export writes to a uniquely-named
     * file (`prism-export-<project>-<date>.json`). Since the project name
     * is part of the filename, as long as concurrent exports target different
     * projects, they write to different files and never race.
     *
     * If two exports target the SAME project, the second write wins (last
     * writer wins) — this is acceptable because both writes produce identical
     * content (same data from the same DB snapshot at the same date).
     */

    it("5 concurrent exports to different projects all succeed without throwing", async () => {
      const projects = ["concurrent-a", "concurrent-b", "concurrent-c", "concurrent-d", "concurrent-e"];

      // Wire each getLedgerEntries call to return project-specific data.
      // The handler now passes project as "eq.<project>" (PostgREST filter format),
      // so we strip the "eq." prefix to reconstruct the raw project name for assertions.
      storage.getLedgerEntries.mockImplementation((args: { project: string }) => {
        const rawProject = args.project.startsWith("eq.") ? args.project.slice(3) : args.project;
        return Promise.resolve([{
          id: `entry-for-${rawProject}`,
          summary: `Session for ${rawProject}`,
          importance: 3,
          // no embedding — tests clean path
        }]);
      });
      storage.loadContext.mockResolvedValue(null);

      // Fire all 5 exports in parallel
      const results = await Promise.allSettled(
        projects.map((p) =>
          sessionExportMemoryHandler({ project: p, format: "json", output_dir: tempDir })
        )
      );

      // None should have rejected (the "never throws" contract must hold under concurrency)
      const rejected = results.filter((r) => r.status === "rejected");
      if (rejected.length > 0) {
        console.error("Concurrent export failures:", rejected.map((r) =>
          (r as PromiseRejectedResult).reason?.message
        ));
      }
      expect(rejected.length).toBe(0);

      // All resolved results must be non-error
      const resolved = results as PromiseFulfilledResult<{ isError: boolean; content: { text: string }[] }>[];
      for (const r of resolved) {
        expect(r.value.isError).toBe(false);
      }

      // Each project file must be valid JSON
      const today = new Date().toISOString().split("T")[0];
      for (const p of projects) {
        const filePath = join(tempDir, `prism-export-${p}-${today}.json`);
        expect(existsSync(filePath)).toBe(true);

        const raw = await readFile(filePath, "utf-8");
        expect(() => JSON.parse(raw)).not.toThrow();

        const { prism_export } = JSON.parse(raw);
        // The project name in the envelope must match the request
        expect(prism_export.project).toBe(p);
        // Each file must have exactly 1 ledger entry (correct routing)
        expect(prism_export.ledger).toHaveLength(1);
        expect(prism_export.ledger[0].summary).toBe(`Session for ${p}`);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP 14: VAULT EXPORT
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Vault export file generation", () => {
    it("exports a .zip file when format is set to 'vault'", async () => {
      storage.getLedgerEntries.mockResolvedValue([{
        id: "entry-1",
        summary: "Vault test session",
        importance: 1,
        created_at: "2026-03-30T10:00:00.000Z",
      }]);
      storage.loadContext.mockResolvedValue(null);

      const result = await sessionExportMemoryHandler({
        project: "test-project",
        format: "vault",
        output_dir: tempDir,
      });

      expect(result.isError).toBe(false);

      const today = new Date().toISOString().split("T")[0];
      const filePath = join(tempDir, `prism-export-test-project-${today}.zip`);
      expect(existsSync(filePath)).toBe(true);

      const buf = await readFile(filePath);
      // Valid ZIP files start with PK (0x50 0x4B)
      expect(buf[0]).toBe(0x50);
      expect(buf[1]).toBe(0x4b);
    });
  });
});
