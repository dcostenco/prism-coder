/**
 * Compaction Handler Tests — session_compact_ledger
 *
 * ======================================================================
 * SCOPE:
 *   End-to-end handler tests for compactLedgerHandler and its helpers
 *   exported from compactionHandler.ts. Each test uses a mocked storage
 *   backend and mocked LLM provider so no real database or API is hit.
 *
 * MOCK STRATEGY:
 *   vi.mock() factories are hoisted above const declarations by Vitest.
 *   All mock references use vi.mocked() AFTER imports (same pattern as
 *   ledgerHandlers.test.ts).
 *
 * LOCATION:
 *   tests/tools/compactionHandler.test.ts — matches the vitest include
 *   pattern (tests/**\/*.test.ts).
 * ======================================================================
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
const localPolicy = vi.hoisted(() => ({ force: false, strict: false, enabled: false, infer: vi.fn() }));

// ======================================================================
// MOCKS — must be declared before imports that depend on them
// ======================================================================

vi.mock("../../src/storage/index.js", () => ({
  getStorage: vi.fn(),
  activeStorageBackend: "local",
}));

vi.mock("../../src/storage/configStorage.js", () => ({
  getSetting: vi.fn(() => Promise.resolve("")),
  getAllSettings: vi.fn(() => Promise.resolve({})),
  getSettingSync: vi.fn(() => ""),
  initConfigStorage: vi.fn(),
}));

vi.mock("../../src/config.js", () => ({
  PRISM_USER_ID: "test-user-id",
  SESSION_MEMORY_ENABLED: true,
  PRISM_ENABLE_HIVEMIND: false,
  PRISM_AUTO_CAPTURE: false,
  PRISM_CAPTURE_PORTS: [],
  GOOGLE_API_KEY: "",
  SERVER_CONFIG: { name: "prism-test", version: "test" },
  get PRISM_LOCAL_LLM_ENABLED() { return localPolicy.enabled; },
  get PRISM_STRICT_LOCAL_MODE() { return localPolicy.strict; },
  get PRISM_FORCE_LOCAL() { return localPolicy.force; },
  SYNALUX_CONFIGURED: false,
}));

vi.mock("../../src/utils/logger.js", () => ({
  sanitizeForLog: vi.fn((s: string) => s),
  debugLog: vi.fn(),
}));

const mockGenerateText = vi.fn(() =>
  Promise.resolve(JSON.stringify({
    summary: "Rolled-up summary of sessions",
    principles: [
      { concept: "Error handling", description: "Always catch async errors", related_entities: ["ts"] },
    ],
    causal_links: [],
  }))
);

vi.mock("../../src/utils/llm/factory.js", () => ({
  getLLMProvider: vi.fn(() => ({
    generateText: mockGenerateText,
    generateEmbedding: vi.fn(() => Promise.resolve(new Array(768).fill(0.01))),
  })),
}));

vi.mock("../../src/utils/localLlm.js", () => ({
  callLocalLlm: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("../../src/tools/prismInferHandler.js", () => ({ inferText: localPolicy.infer }));

// ======================================================================
// IMPORTS — after mocks
// ======================================================================

import { getStorage } from "../../src/storage/index.js";
import { checkInputSafety, MEDICAL_RESPONSE } from "../../src/utils/safetyGate.js";
import {
  compactLedgerHandler,
  isCompactLedgerArgs,
} from "../../src/tools/compactionHandler.js";

const mockGetStorage = vi.mocked(getStorage);

// ======================================================================
// HELPERS — build a fresh storage stub per test
// ======================================================================

function makeStorageStub() {
  return {
    saveLedger: vi.fn(() =>
      Promise.resolve([{ id: "rollup-uuid-001", created_at: new Date().toISOString() }])
    ),
    patchLedger: vi.fn(() => Promise.resolve()),
    getLedgerEntries: vi.fn(() => Promise.resolve([])),
    deleteLedger: vi.fn(() => Promise.resolve([])),
    softDeleteLedger: vi.fn(() => Promise.resolve()),
    hardDeleteLedger: vi.fn(() => Promise.resolve()),
    saveHandoff: vi.fn(() => Promise.resolve({ status: "created", version: 1 })),
    getHandoffAtVersion: vi.fn(() => Promise.resolve(null)),
    deleteHandoff: vi.fn(() => Promise.resolve()),
    loadContext: vi.fn(() => Promise.resolve(null)),
    searchKnowledge: vi.fn(() => Promise.resolve(null)),
    searchMemory: vi.fn(() => Promise.resolve([])),
    saveHistorySnapshot: vi.fn(() => Promise.resolve()),
    getHistory: vi.fn(() => Promise.resolve([])),
    listProjects: vi.fn(() => Promise.resolve([])),
    getHealthStats: vi.fn(() => Promise.resolve({})),
    decayImportance: vi.fn(() => Promise.resolve()),
    registerAgent: vi.fn(),
    heartbeatAgent: vi.fn(),
    listTeam: vi.fn(),
    deregisterAgent: vi.fn(),
    getAllAgents: vi.fn(),
    updateAgentStatus: vi.fn(),
    getSettingFn: vi.fn(),
    setSetting: vi.fn(),
    getAllSettingsFn: vi.fn(),
    getAnalytics: vi.fn(),
    expireByTTL: vi.fn(),
    adjustImportance: vi.fn(),
    getGraduatedInsights: vi.fn(() => Promise.resolve([])),
    getCompactionCandidates: vi.fn(() => Promise.resolve([])),
    initialize: vi.fn(),
    close: vi.fn(),
    updateLastAccessed: vi.fn(),
    createLink: vi.fn(() => Promise.resolve()),
    upsertSemanticKnowledge: vi.fn(() => Promise.resolve("semantic-uuid-001")),
  };
}

/**
 * Build N fake ledger entries for testing compaction.
 */
function makeFakeEntries(count: number, project = "test-project") {
  return Array.from({ length: count }, (_, i) => ({
    id: `entry-${String(i + 1).padStart(3, "0")}`,
    project,
    summary: `Session ${i + 1} summary — implemented feature ${i + 1}`,
    decisions: [`Decision from session ${i + 1}`],
    files_changed: [`src/file${i + 1}.ts`],
    keywords: [`keyword${i + 1}`, "shared-kw"],
    session_date: new Date(2026, 4, 1 + i).toISOString(),
  }));
}

// ======================================================================
// TEST SUITE
// ======================================================================

describe("compactionHandler", () => {
  let storage: ReturnType<typeof makeStorageStub>;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(localPolicy, { force: false, strict: false, enabled: false });
    localPolicy.infer.mockResolvedValue(null);
    storage = makeStorageStub();
    mockGetStorage.mockResolvedValue(storage as any);

    // Reset generateText to default behavior
    mockGenerateText.mockResolvedValue(
      JSON.stringify({
        summary: "Rolled-up summary of sessions",
        principles: [
          { concept: "Error handling", description: "Always catch async errors", related_entities: ["ts"] },
        ],
        causal_links: [],
      })
    );
  });

  // ====================================================================
  // 1. Type Guard — isCompactLedgerArgs
  // ====================================================================

  describe("isCompactLedgerArgs", () => {
    it("accepts an empty object (all fields are optional)", () => {
      expect(isCompactLedgerArgs({})).toBe(true);
    });

    it("accepts valid args with all fields", () => {
      expect(
        isCompactLedgerArgs({
          project: "my-project",
          threshold: 30,
          keep_recent: 5,
          dry_run: true,
        })
      ).toBe(true);
    });

    it("rejects null", () => {
      expect(isCompactLedgerArgs(null)).toBe(false);
    });

    it("rejects undefined", () => {
      expect(isCompactLedgerArgs(undefined)).toBe(false);
    });

    it("rejects a string", () => {
      expect(isCompactLedgerArgs("not an object")).toBe(false);
    });

    it("rejects a number", () => {
      expect(isCompactLedgerArgs(42)).toBe(false);
    });
  });

  // ====================================================================
  // 2. Handler throws on invalid args
  // ====================================================================

  describe("input validation", () => {
    it("throws on null args", async () => {
      await expect(compactLedgerHandler(null)).rejects.toThrow(
        "Invalid arguments for session_compact_ledger"
      );
    });

    it("throws on undefined args", async () => {
      await expect(compactLedgerHandler(undefined)).rejects.toThrow(
        "Invalid arguments for session_compact_ledger"
      );
    });

    it("throws on string args", async () => {
      await expect(compactLedgerHandler("bad")).rejects.toThrow(
        "Invalid arguments for session_compact_ledger"
      );
    });
  });

  // ====================================================================
  // 3. No compaction needed — below threshold
  // ====================================================================

  describe("below threshold — no compaction", () => {
    it("returns 'no compaction needed' when specific project is below threshold", async () => {
      // Project has 10 entries, threshold is 50 (default)
      storage.getLedgerEntries.mockResolvedValueOnce(
        makeFakeEntries(10)
      );

      const result = await compactLedgerHandler({ project: "test-project" });

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("No compaction needed");
      expect(result.content[0].text).toContain("test-project");
      expect(result.content[0].text).toContain("10 active entries");
    });

    it("returns 'all clear' when auto-detect finds no candidates", async () => {
      storage.getCompactionCandidates.mockResolvedValue([]);

      const result = await compactLedgerHandler({});

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("No projects exceed the compaction threshold");
    });
    it.each([9, 10])("retains every entry when a project exceeds the threshold but has only %s entries", async count => {
      const entries = makeFakeEntries(count);
      // SQLite treats a nonpositive limit as an unbounded read.
      storage.getLedgerEntries.mockResolvedValue(entries);
      const result = await compactLedgerHandler({ project: "test-project", threshold: 5, keep_recent: 10 });

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("No compaction needed");
      expect(storage.getLedgerEntries).toHaveBeenCalledTimes(1);
      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(storage.patchLedger).not.toHaveBeenCalled();
    });
    it.each([true, false])("excludes nonpositive automatic candidates from the operation (dry run: %s)", async dry_run => {
      storage.getCompactionCandidates.mockResolvedValue([
        { project: "keep-all", total_entries: 10, to_compact: 0 },
        { project: "keep-fewer", total_entries: 9, to_compact: -1 },
      ]);
      storage.getLedgerEntries.mockResolvedValue(makeFakeEntries(10));

      const result = await compactLedgerHandler({ threshold: 5, keep_recent: 10, dry_run });

      expect(result.isError).toBe(false);
      expect(result.content[0].text).not.toMatch(/keep-all|keep-fewer/);
      expect(storage.getLedgerEntries).not.toHaveBeenCalled();
      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(storage.patchLedger).not.toHaveBeenCalled();
    });
  });

  // ====================================================================
  // 4. Dry run mode
  // ====================================================================

  describe("dry run", () => {
    it("reports candidates without compacting", async () => {
      storage.getCompactionCandidates.mockResolvedValue([
        { project: "proj-a", total_entries: 80, to_compact: 70 },
        { project: "proj-b", total_entries: 60, to_compact: 50 },
      ]);

      const result = await compactLedgerHandler({ dry_run: true });

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("dry run");
      expect(result.content[0].text).toContain("proj-a");
      expect(result.content[0].text).toContain("80 entries");
      expect(result.content[0].text).toContain("70 would be compacted");
      expect(result.content[0].text).toContain("proj-b");
      // No saveLedger or patchLedger calls in dry run
      expect(storage.saveLedger).not.toHaveBeenCalled();
      expect(storage.patchLedger).not.toHaveBeenCalled();
    });

    it("dry run with specific project over threshold", async () => {
      // First call: count query returning 60 entries
      storage.getLedgerEntries.mockResolvedValueOnce(makeFakeEntries(60));

      const result = await compactLedgerHandler({
        project: "big-project",
        threshold: 50,
        keep_recent: 10,
        dry_run: true,
      });

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("dry run");
      expect(result.content[0].text).toContain("big-project");
      expect(storage.saveLedger).not.toHaveBeenCalled();
    });
  });

  // ====================================================================
  // 5. Full compaction — creates rollup entry
  // ====================================================================

  describe("full compaction", () => {
    it("compacts entries for a given project and creates a rollup", async () => {
      const entries = makeFakeEntries(15);

      // First call: count query (returns entries for count check)
      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60)) // count query
        .mockResolvedValueOnce(entries);             // fetch oldest entries

      const result = await compactLedgerHandler({
        project: "test-project",
        threshold: 50,
        keep_recent: 10,
      });

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("compaction complete");
      expect(result.structuredContent).toEqual({ projects_compacted: 1 });

      // Rollup entry created
      expect(storage.saveLedger).toHaveBeenCalledTimes(1);
      const rollupArg = storage.saveLedger.mock.calls[0][0];
      expect(rollupArg.is_rollup).toBe(true);
      expect(rollupArg.rollup_count).toBe(15);
      expect(rollupArg.project).toBe("test-project");
      expect(rollupArg.summary).toContain("[ROLLUP of 15 sessions]");
    });

    it("rollup entry preserves all unique keywords from original entries", async () => {
      const entries = [
        { ...makeFakeEntries(1)[0], keywords: ["alpha", "shared"] },
        { ...makeFakeEntries(1)[0], id: "entry-002", keywords: ["beta", "shared"] },
        { ...makeFakeEntries(1)[0], id: "entry-003", keywords: ["gamma"] },
      ];

      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60)) // count
        .mockResolvedValueOnce(entries);              // fetch

      await compactLedgerHandler({ project: "test-project", threshold: 50 });

      const rollupArg = storage.saveLedger.mock.calls[0][0];
      expect(rollupArg.keywords).toEqual(
        expect.arrayContaining(["alpha", "beta", "gamma", "shared"])
      );
      // "shared" appears once (deduped)
      expect(rollupArg.keywords.filter((k: string) => k === "shared")).toHaveLength(1);
    });

    it("rollup entry preserves all unique files_changed", async () => {
      const entries = [
        { ...makeFakeEntries(1)[0], files_changed: ["src/a.ts", "src/b.ts"] },
        { ...makeFakeEntries(1)[0], id: "entry-002", files_changed: ["src/b.ts", "src/c.ts"] },
      ];

      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60))
        .mockResolvedValueOnce(entries);

      await compactLedgerHandler({ project: "test-project", threshold: 50 });

      const rollupArg = storage.saveLedger.mock.calls[0][0];
      expect(rollupArg.files_changed).toEqual(
        expect.arrayContaining(["src/a.ts", "src/b.ts", "src/c.ts"])
      );
      expect(rollupArg.files_changed).toHaveLength(3);
    });

    it("rollup conversation_id starts with 'rollup-'", async () => {
      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60))
        .mockResolvedValueOnce(makeFakeEntries(5));

      await compactLedgerHandler({ project: "test-project", threshold: 50 });

      const rollupArg = storage.saveLedger.mock.calls[0][0];
      expect(rollupArg.conversation_id).toMatch(/^rollup-\d+$/);
    });
  });

  // ====================================================================
  // 6. Archives original entries after compaction (soft-delete)
  // ====================================================================

  describe("archiving original entries", () => {
    it("patches each original entry with archived_at timestamp", async () => {
      const entries = makeFakeEntries(5);

      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60))
        .mockResolvedValueOnce(entries);

      await compactLedgerHandler({ project: "test-project", threshold: 50 });

      // Each of the 5 entries should be patched with archived_at
      expect(storage.patchLedger).toHaveBeenCalledTimes(5);

      for (let i = 0; i < 5; i++) {
        const [id, patch] = storage.patchLedger.mock.calls[i];
        expect(id).toBe(entries[i].id);
        expect(patch).toHaveProperty("archived_at");
        // archived_at is an ISO string
        expect(typeof patch.archived_at).toBe("string");
        expect(new Date(patch.archived_at as string).getTime()).not.toBeNaN();
      }
    });

    it("response confirms soft-delete, not permanent removal", async () => {
      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60))
        .mockResolvedValueOnce(makeFakeEntries(3));

      const result = await compactLedgerHandler({ project: "test-project", threshold: 50 });

      expect(result.content[0].text).toContain("archived (soft-deleted)");
      expect(result.content[0].text).toContain("not permanently removed");
    });
  });

  // ====================================================================
  // 7. spawned_from links created between rollup and originals
  // ====================================================================

  describe("spawned_from links", () => {
    it("creates a spawned_from link for each original entry", async () => {
      const entries = makeFakeEntries(3);

      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60))
        .mockResolvedValueOnce(entries);

      await compactLedgerHandler({ project: "test-project", threshold: 50 });

      // 3 spawned_from links + possible semantic links
      const spawnedCalls = storage.createLink.mock.calls.filter(
        (call: any[]) => call[0].link_type === "spawned_from"
      );
      expect(spawnedCalls).toHaveLength(3);

      for (let i = 0; i < 3; i++) {
        expect(spawnedCalls[i][0].source_id).toBe("rollup-uuid-001");
        expect(spawnedCalls[i][0].target_id).toBe(entries[i].id);
        expect(spawnedCalls[i][0].strength).toBe(1.0);
      }
    });

    it("link creation failure does not abort compaction", async () => {
      const entries = makeFakeEntries(2);

      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60))
        .mockResolvedValueOnce(entries);

      // First link creation fails, second succeeds
      storage.createLink
        .mockRejectedValueOnce(new Error("FK violation"))
        .mockResolvedValue(undefined);

      const result = await compactLedgerHandler({ project: "test-project", threshold: 50 });

      // Compaction still completes
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("compaction complete");
      // Original entries still archived
      expect(storage.patchLedger).toHaveBeenCalledTimes(2);
    });
  });

  // ====================================================================
  // 8. Semantic principles and causal links
  // ====================================================================

  describe("semantic knowledge and causal links", () => {
    it("upserts semantic knowledge for each principle from LLM", async () => {
      mockGenerateText.mockResolvedValue(
        JSON.stringify({
          summary: "Summary",
          principles: [
            { concept: "Retry logic", description: "Always retry transient failures", related_entities: ["http"] },
            { concept: "Logging", description: "Structured logging saves debugging time", related_entities: ["pino"] },
          ],
          causal_links: [],
        })
      );

      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60))
        .mockResolvedValueOnce(makeFakeEntries(3));

      await compactLedgerHandler({ project: "test-project", threshold: 50 });

      expect(storage.upsertSemanticKnowledge).toHaveBeenCalledTimes(2);
      expect(storage.upsertSemanticKnowledge).toHaveBeenCalledWith(
        expect.objectContaining({
          project: "test-project",
          concept: "Retry logic",
          description: "Always retry transient failures",
        })
      );
    });

    it("creates related_to links from rollup to semantic nodes", async () => {
      mockGenerateText.mockResolvedValue(
        JSON.stringify({
          summary: "Summary",
          principles: [
            { concept: "Testing", description: "Write tests first", related_entities: [] },
          ],
          causal_links: [],
        })
      );

      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60))
        .mockResolvedValueOnce(makeFakeEntries(2));

      await compactLedgerHandler({ project: "test-project", threshold: 50 });

      const relatedCalls = storage.createLink.mock.calls.filter(
        (call: any[]) => call[0].link_type === "related_to"
      );
      expect(relatedCalls).toHaveLength(1);
      expect(relatedCalls[0][0].source_id).toBe("rollup-uuid-001");
      expect(relatedCalls[0][0].target_id).toBe("semantic-uuid-001");
      expect(relatedCalls[0][0].strength).toBe(0.8);
    });

    it("skips causal links referencing chunk- IDs (meta-summarization artifacts)", async () => {
      mockGenerateText.mockResolvedValue(
        JSON.stringify({
          summary: "Summary",
          principles: [],
          causal_links: [
            { source_id: "chunk-0", target_id: "chunk-1", relation: "led_to", reason: "chunk link" },
            { source_id: "entry-001", target_id: "entry-002", relation: "caused_by", reason: "real link" },
          ],
        })
      );

      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60))
        .mockResolvedValueOnce(makeFakeEntries(2));

      await compactLedgerHandler({ project: "test-project", threshold: 50 });

      const causalCalls = storage.createLink.mock.calls.filter(
        (call: any[]) =>
          call[0].link_type === "led_to" || call[0].link_type === "caused_by"
      );
      // Only the real link, not the chunk- one
      expect(causalCalls).toHaveLength(1);
      expect(causalCalls[0][0].source_id).toBe("entry-001");
      expect(causalCalls[0][0].target_id).toBe("entry-002");
    });
  });

  // ====================================================================
  // 9. Handles empty ledger gracefully
  // ====================================================================

  describe("empty ledger handling", () => {
    it("returns 'no entries to compact' when fetch returns empty array", async () => {
      // Count query returns 60 (over threshold), but actual fetch returns 0
      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60))
        .mockResolvedValueOnce([]);

      const result = await compactLedgerHandler({ project: "test-project", threshold: 50 });

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("no entries to compact");
      expect(result.structuredContent).toEqual({ projects_compacted: 0 });
      expect(storage.saveLedger).not.toHaveBeenCalled();
    });

    it("skips LLM call when no entries are fetched", async () => {
      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60))
        .mockResolvedValueOnce([]);

      await compactLedgerHandler({ project: "test-project", threshold: 50 });

      expect(mockGenerateText).not.toHaveBeenCalled();
    });
  });

  // ====================================================================
  // 10. LLM API failure handling
  // ====================================================================

  describe("LLM failure handling", () => {
    it.each([true, false])("refuses safety-gated compaction input before either provider (local enabled: %s)", async enabled => {
      localPolicy.enabled = enabled;
      localPolicy.infer.mockImplementation(async (prompt: string) => checkInputSafety(prompt));
      const quotedRecord = { ...makeFakeEntries(1)[0], summary: "Synthetic quoted example. What dose of this vitamin should I take?" };
      expect(checkInputSafety(quotedRecord.summary)).toBe(MEDICAL_RESPONSE);
      storage.getLedgerEntries.mockResolvedValueOnce(makeFakeEntries(11)).mockResolvedValueOnce([quotedRecord]);

      await expect(compactLedgerHandler({ project: "test-project", threshold: 5 })).rejects.toThrow(/input safety gate/i);

      expect(localPolicy.infer).not.toHaveBeenCalled();
      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(storage.saveLedger).not.toHaveBeenCalled();
      expect(storage.patchLedger).not.toHaveBeenCalled();
    });

    it.each([
      MEDICAL_RESPONSE,
      " \n ",
      JSON.stringify({ summary: MEDICAL_RESPONSE }),
      JSON.stringify({ principles: [], causal_links: [] }),
    ])("refuses unusable generated compaction output %j before any write", async output => {
      mockGenerateText.mockResolvedValue(output);
      storage.getLedgerEntries.mockResolvedValueOnce(makeFakeEntries(11)).mockResolvedValueOnce(makeFakeEntries(1));

      await expect(compactLedgerHandler({ project: "test-project", threshold: 5 })).rejects.toThrow(/usable summary/i);

      expect(storage.saveLedger).not.toHaveBeenCalled();
      expect(storage.patchLedger).not.toHaveBeenCalled();
    });

    it.each([
      ["blank summary", '<|tool_call|>{"summary":" "}</|tool_call|>'],
      ["safety notice", '<|tool_call|>' + JSON.stringify({ summary: MEDICAL_RESPONSE }) + '</|tool_call|>'],
      ["unterminated wrapper", '<|tool_call|>{"summary":"Partial rollup"}'],
      ["truncated control marker", '<|tool_ca'],
      ["malformed JSON", '<|tool_call|>{"summary":</|tool_call|>'],
      ["untagged truncated JSON", '{"summary":"Partial rollup"'],
      ["reasoning only", '<|synalux_think|>Working on the summary.</|synalux_think|>'],
      ["non-JSON tool body", '<tool_call>Plain text inside a JSON envelope.</tool_call>'],
    ])("refuses a structured compaction reply with %s before any write", async (_case, output) => {
      mockGenerateText.mockResolvedValue(output);
      storage.getLedgerEntries.mockResolvedValueOnce(makeFakeEntries(11)).mockResolvedValueOnce(makeFakeEntries(1));

      await expect(compactLedgerHandler({ project: "test-project", threshold: 5 })).rejects.toThrow(/usable summary/i);

      expect(storage.saveLedger).not.toHaveBeenCalled();
      expect(storage.patchLedger).not.toHaveBeenCalled();
    });

    it.each([false, true])("stores only the summary of a valid tagged compaction reply (local: %s)", async local => {
      const summary = "A valid rollup documenting <think>literal markers</think>.";
      const closeTag = local ? "</tool_call>" : "</|tool_call|>";
      const output = '<|synalux_think|>Reasoning belongs outside the rollup.</|synalux_think|>\n'
        + '<|tool_call|>' + JSON.stringify({ summary, principles: [], causal_links: [] }) + closeTag;
      localPolicy.enabled = local;
      localPolicy.infer.mockResolvedValue(output);
      mockGenerateText.mockResolvedValue(output);
      const [older] = makeFakeEntries(1);
      storage.getLedgerEntries.mockResolvedValueOnce(makeFakeEntries(11)).mockResolvedValueOnce([older]);

      const result = await compactLedgerHandler({ project: "test-project", threshold: 5 });

      expect(result.isError).toBe(false);
      expect(storage.saveLedger).toHaveBeenCalledWith(expect.objectContaining({ summary: `[ROLLUP of 1 sessions] ${summary}` }));
      expect(storage.patchLedger).toHaveBeenCalledOnce();
      expect(storage.patchLedger).toHaveBeenCalledWith(older.id, expect.objectContaining({ archived_at: expect.any(String) }));
    });

    it.each(["force", "strict"] as const)("keeps forced local memory off cloud when %s is set and local summarization is disabled", async flag => {
      localPolicy[flag] = true;
      storage.getLedgerEntries.mockResolvedValueOnce(makeFakeEntries(60)).mockResolvedValueOnce(makeFakeEntries(3));
      const result = await compactLedgerHandler({ project: "test-project", threshold: 50 });
      expect(result.isError).toBe(true);
      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(storage.saveLedger).not.toHaveBeenCalled();
    });

    it.each(["force", "strict"] as const)("binds the local-only compaction dispatch when %s is set", async flag => {
      localPolicy[flag] = true;
      localPolicy.enabled = true;
      storage.getLedgerEntries.mockResolvedValueOnce(makeFakeEntries(60)).mockResolvedValueOnce(makeFakeEntries(3));
      const result = await compactLedgerHandler({ project: "test-project", threshold: 50 });
      expect(localPolicy.infer).toHaveBeenCalledWith(expect.any(String), { mode: "chat", localOnly: true });
      expect(result.isError).toBe(true);
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it("retains successful on-device compaction in forced local memory", async () => {
      localPolicy.force = true;
      localPolicy.enabled = true;
      localPolicy.infer.mockResolvedValue('{"summary":"Local rollup","principles":[],"causal_links":[]}');
      storage.getLedgerEntries.mockResolvedValueOnce(makeFakeEntries(60)).mockResolvedValueOnce(makeFakeEntries(3));
      const result = await compactLedgerHandler({ project: "test-project", threshold: 50 });
      expect(result.isError).toBe(false);
      expect(storage.saveLedger).toHaveBeenCalledOnce();
      expect(mockGenerateText).not.toHaveBeenCalled();
    });
    it("propagates non-HIPAA LLM errors as thrown exceptions", async () => {
      mockGenerateText.mockRejectedValue(new Error("Gemini 503: Service Unavailable"));

      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60))
        .mockResolvedValueOnce(makeFakeEntries(3));

      await expect(
        compactLedgerHandler({ project: "test-project", threshold: 50 })
      ).rejects.toThrow("Gemini 503: Service Unavailable");
    });

    it("returns graceful MCP error for HIPAA strict mode failure", async () => {
      mockGenerateText.mockRejectedValue(
        new Error(
          "[HIPAA] Local LLM failed and PRISM_STRICT_LOCAL_MODE=true. " +
          "Cloud fallback is blocked to prevent unauthorized PHI disclosure."
        )
      );

      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60))
        .mockResolvedValueOnce(makeFakeEntries(3));

      const result = await compactLedgerHandler({ project: "test-project", threshold: 50 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("[HIPAA]");
      expect(result.content[0].text).toContain("data residency");
      // No rollup created, no entries archived
      expect(storage.saveLedger).not.toHaveBeenCalled();
      expect(storage.patchLedger).not.toHaveBeenCalled();
    });

    it("preserves the plain text summary fallback", async () => {
      mockGenerateText.mockResolvedValue("This is just a plain text summary, not JSON.");

      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60))
        .mockResolvedValueOnce(makeFakeEntries(2));

      const result = await compactLedgerHandler({ project: "test-project", threshold: 50 });

      // Should still succeed — parseCompactionResponse falls back
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("compaction complete");

      const rollupArg = storage.saveLedger.mock.calls[0][0];
      expect(rollupArg.summary).toContain("[ROLLUP of 2 sessions]");
    });
  });

  // ====================================================================
  // 11. Chunked summarization for large entry sets
  // ====================================================================

  describe("chunked summarization", () => {
    it("sends every archived entry to a complete chunk even when XML escaping expands the prompt", async () => {
      const entries = makeFakeEntries(4).map((entry, index) => ({
        ...entry,
        summary: "durable-marker-" + index + "\n\n" + "&".repeat(2400),
      }));
      storage.getLedgerEntries.mockResolvedValueOnce(makeFakeEntries(60)).mockResolvedValueOnce(entries);

      const result = await compactLedgerHandler({ project: "test-project", threshold: 50 });

      expect(result.isError).toBe(false);
      const prompts = mockGenerateText.mock.calls.map(call => call[0] as unknown as string);
      for (const [index, entry] of entries.entries()) {
        expect(prompts.some(prompt => prompt?.includes("durable-marker-" + index)
          && prompt.includes("</raw_user_log>"))).toBe(true);
        expect(storage.patchLedger).toHaveBeenCalledWith(entry.id, expect.objectContaining({ archived_at: expect.any(String) }));
      }
    });

    it("keeps every original active when a single entry cannot fit without truncation", async () => {
      const entries = makeFakeEntries(2);
      entries[0].summary = "&".repeat(6000);
      storage.getLedgerEntries.mockResolvedValueOnce(makeFakeEntries(60)).mockResolvedValueOnce(entries);

      await expect(compactLedgerHandler({ project: "test-project", threshold: 50 })).rejects.toThrow(/compaction prompt limit/i);

      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(storage.saveLedger).not.toHaveBeenCalled();
      expect(storage.patchLedger).not.toHaveBeenCalled();
    });

    it("splits entries into chunks of COMPACTION_CHUNK_SIZE (10)", async () => {
      // 25 entries => 3 chunks (10, 10, 5) + 1 meta-summarization
      const entries = makeFakeEntries(25);

      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60))
        .mockResolvedValueOnce(entries);

      await compactLedgerHandler({ project: "test-project", threshold: 50 });

      // 3 chunk calls + 1 meta-summary call = 4 total LLM calls
      expect(mockGenerateText).toHaveBeenCalledTimes(4);
    });

    it("single chunk does not trigger meta-summarization", async () => {
      // 8 entries = 1 chunk (< 10), no meta step
      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60))
        .mockResolvedValueOnce(makeFakeEntries(8));

      await compactLedgerHandler({ project: "test-project", threshold: 50 });

      // Just 1 LLM call
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
    });
  });

  // ====================================================================
  // 12. MAX_ENTRIES_PER_RUN cap
  // ====================================================================

  describe("MAX_ENTRIES_PER_RUN cap", () => {
    it("caps entries fetched at 100 even if more are eligible", async () => {
      // 200 entries eligible but should only fetch 100
      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(200)) // count query
        .mockResolvedValueOnce(makeFakeEntries(5));   // actual fetch (mock 5 for simplicity)

      await compactLedgerHandler({ project: "test-project", threshold: 50, keep_recent: 10 });

      // Second getLedgerEntries call should have limit=100 (200 - 10 = 190, capped to 100)
      const fetchCall = storage.getLedgerEntries.mock.calls[1];
      expect(fetchCall[0].limit).toBe("100");
    });
  });

  // ====================================================================
  // 13. Multi-project auto-detect compaction
  // ====================================================================

  describe("multi-project auto-detect", () => {
    it("compacts multiple projects in sequence", async () => {
      storage.getCompactionCandidates.mockResolvedValue([
        { project: "proj-a", total_entries: 80, to_compact: 70 },
        { project: "proj-b", total_entries: 60, to_compact: 50 },
      ]);

      // Each project: fetch returns some entries
      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(3, "proj-a"))
        .mockResolvedValueOnce(makeFakeEntries(2, "proj-b"));

      // saveLedger returns rollup IDs for each project
      storage.saveLedger
        .mockResolvedValueOnce([{ id: "rollup-a" }])
        .mockResolvedValueOnce([{ id: "rollup-b" }]);

      const result = await compactLedgerHandler({});

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("proj-a");
      expect(result.content[0].text).toContain("proj-b");
      expect(storage.saveLedger).toHaveBeenCalledTimes(2);
    });
  });

  // ====================================================================
  // 14. Rollup entry missing from saveLedger response
  // ====================================================================

  describe("rollup write confirmation", () => {
    it.each([2, 3])("keeps deleted entries out of the count and prompt with %i active entries", async (count) => {
      const entries = makeFakeEntries(count + 1).map((entry, index) => ({
        ...entry,
        summary: index === 0 ? "soft-deleted private entry" : "active-entry-" + index,
        deleted_at: index === 0 ? "2026-11-22T00:00:00Z" : null,
      }));
      storage.getLedgerEntries.mockImplementation(async (query: Record<string, string>) => {
        const matched = query.deleted_at === "is.null" ? entries.slice(1) : entries;
        return query.limit ? matched.slice(0, Number(query.limit)) : matched;
      });

      const result = await compactLedgerHandler({ project: "test-project", threshold: 2, keep_recent: 1 });

      expect(result.isError).toBe(false);
      if (count === 2) {
        expect(mockGenerateText).not.toHaveBeenCalled();
        expect(storage.patchLedger).not.toHaveBeenCalled();
      } else {
        expect(mockGenerateText).toHaveBeenCalledWith(expect.stringContaining("active-entry-2"));
        expect(mockGenerateText).not.toHaveBeenCalledWith(expect.stringContaining("soft-deleted private entry"));
        expect(storage.patchLedger.mock.calls.map(call => call[0])).toEqual([entries[1].id, entries[2].id]);
      }
    });

    it.each([{ saved: null }, { saved: [] }, { saved: [{}] }, { saved: { id: " " } }])(
        "preserves the originals when saveLedger returns no id ($saved)", async ({ saved }) => {
      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60))
        .mockResolvedValueOnce(makeFakeEntries(3));

      storage.saveLedger.mockResolvedValue(saved);

      const result = await compactLedgerHandler({ project: "test-project", threshold: 50 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("rollup ID");
      expect(result.structuredContent?.projects_compacted ?? 0).toBe(0);
      expect(storage.createLink).not.toHaveBeenCalled();
      expect(storage.patchLedger).not.toHaveBeenCalled();
    });

    it("uses the ID returned by the SQLite deduplicated rollup result", async () => {
      const entries = makeFakeEntries(3);
      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60))
        .mockResolvedValueOnce(entries);
      storage.saveLedger.mockResolvedValue({ id: "existing-rollup", deduplicated: true });

      const result = await compactLedgerHandler({ project: "test-project", threshold: 50 });

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({ projects_compacted: 1 });
      expect(storage.createLink).toHaveBeenCalledWith(
        expect.objectContaining({ source_id: "existing-rollup", target_id: entries[0].id, link_type: "spawned_from" }),
        expect.any(String),
      );
      expect(storage.patchLedger).toHaveBeenCalledTimes(entries.length);
    });
  });

  // ====================================================================
  // 15. Entries with missing optional fields
  // ====================================================================

  describe("entries with missing optional fields", () => {
    it("handles entries without keywords or files_changed", async () => {
      const entries = [
        { id: "bare-001", summary: "Bare entry", session_date: "2026-05-01" },
        { id: "bare-002", summary: "Another bare entry", session_date: "2026-05-02" },
      ];

      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60))
        .mockResolvedValueOnce(entries);

      const result = await compactLedgerHandler({ project: "test-project", threshold: 50 });

      expect(result.isError).toBe(false);
      const rollupArg = storage.saveLedger.mock.calls[0][0];
      // Empty arrays since entries had no keywords/files
      expect(rollupArg.keywords).toEqual([]);
      expect(rollupArg.files_changed).toEqual([]);
    });
  });

  // ====================================================================
  // 16. Custom threshold and keep_recent
  // ====================================================================

  describe("custom threshold and keep_recent", () => {
    it("retains newest creation when only the newest entry has never been accessed", async () => {
      const entries = makeFakeEntries(11).map((entry, index) => ({
        ...entry,
        created_at: entry.session_date,
        last_accessed_at: index === 10 ? null : "2026-12-01T00:00:00Z",
      }));
      const [oldest] = entries;
      const newest = entries[10];
      storage.getLedgerEntries.mockResolvedValueOnce(entries)
        .mockImplementationOnce(async (query?: Record<string, string>) => {
          expect(query?.limit).toBe("1");
          return [query?.order?.startsWith("created_at.asc") ? oldest : newest];
        });

      const result = await compactLedgerHandler({ project: "test-project", threshold: 5, keep_recent: 10 });

      expect(result.isError).toBe(false);
      expect(storage.patchLedger).toHaveBeenCalledExactlyOnceWith(oldest.id, expect.objectContaining({ archived_at: expect.any(String) }));
    });

    it("uses custom threshold for the compaction gate", async () => {
      // 25 entries with threshold 20 => should compact
      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(25)) // count
        .mockResolvedValueOnce(makeFakeEntries(5)); // fetch (25 - 20 keep = 5)

      const result = await compactLedgerHandler({
        project: "test-project",
        threshold: 20,
        keep_recent: 20,
      });

      expect(result.isError).toBe(false);
      expect(storage.saveLedger).toHaveBeenCalledTimes(1);
    });

    it("skips compaction when under custom threshold", async () => {
      storage.getLedgerEntries.mockResolvedValueOnce(makeFakeEntries(15));

      const result = await compactLedgerHandler({
        project: "test-project",
        threshold: 20,
      });

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("No compaction needed");
      expect(result.content[0].text).toContain("15 active entries");
    });
  });

  // ====================================================================
  // 17. Storage failure propagation
  // ====================================================================

  describe("storage failures", () => {
    it("propagates getStorage initialization failure", async () => {
      mockGetStorage.mockRejectedValue(new Error("Storage init failed"));

      await expect(compactLedgerHandler({ project: "p" })).rejects.toThrow(
        "Storage init failed"
      );
    });

    it("propagates getLedgerEntries failure", async () => {
      storage.getLedgerEntries.mockRejectedValue(new Error("DB read error"));

      await expect(
        compactLedgerHandler({ project: "test-project" })
      ).rejects.toThrow("DB read error");
    });

    it("propagates saveLedger failure during rollup creation", async () => {
      storage.getLedgerEntries
        .mockResolvedValueOnce(makeFakeEntries(60))
        .mockResolvedValueOnce(makeFakeEntries(3));

      storage.saveLedger.mockRejectedValue(new Error("Rollup insert failed"));

      await expect(
        compactLedgerHandler({ project: "test-project", threshold: 50 })
      ).rejects.toThrow("Rollup insert failed");
    });
  });
});
