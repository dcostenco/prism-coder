/**
 * graphHandlers Step 3B/4 — Unit Tests
 *
 * ═══════════════════════════════════════════════════════════════════
 * SCOPE:
 *   Tests the core synthesis and context-assembly functions exported
 *   from src/tools/graphHandlers.ts using mocked storage/LLM:
 *
 *   1. synthesizeEdgesCore — neighbor cap, dedup, count accuracy
 *   2. assembleTestMeContext — target_id traversal, dedup, truncation
 *   3. generateTestMeQuestions — valid parse, malformed fallback
 *
 * APPROACH:
 *   Full vi.mock on storage + LLM factory. No real DB or network.
 *   Each test constructs a purpose-built mock storage with exactly
 *   the data shape needed to exercise the target code path.
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock Dependencies ──────────────────────────────────────────
// Mock storage — synthesizeEdgesCore calls getStorage() internally
vi.mock("../../src/storage/index.js", () => ({
  getStorage: vi.fn(),
}));

// Mock LLM factory — synthesis uses generateEmbedding, test-me uses generateText
vi.mock("../../src/utils/llm/factory.js", () => ({
  getLLMProvider: vi.fn(() => ({
    generateEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
    generateText: vi.fn(async () =>
      JSON.stringify([
        { q: "Q1", a: "A1" },
        { q: "Q2", a: "A2" },
        { q: "Q3", a: "A3" },
      ])
    ),
  })),
}));

// ─── Import mocked modules ──────────────────────────────────────
const { getStorage } = await import("../../src/storage/index.js");
const graphHandlers = await import("../../src/tools/graphHandlers.js");

// ═══════════════════════════════════════════════════════════════════
// SYNTHESIS — synthesizeEdgesCore
// ═══════════════════════════════════════════════════════════════════

describe("synthesizeEdgesCore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Verifies that when searchMemory returns more candidates than
   * max_neighbors_per_entry, only that many links are created.
   */
  it("respects max_neighbors_per_entry", async () => {
    const storageMock = {
      getLedgerEntries: vi.fn(async () => [
        { id: "a", embedding: JSON.stringify([1, 2, 3]), summary: "s1" },
      ]),
      searchMemory: vi.fn(async () => [
        { id: "b", similarity: 0.95 },
        { id: "c", similarity: 0.90 },
        { id: "d", similarity: 0.89 },
      ]),
      getLinksFrom: vi.fn(async () => []),
      createLink: vi.fn(async () => {}),
    };
    (getStorage as any).mockResolvedValue(storageMock);

    const out = await graphHandlers.synthesizeEdgesCore({
      project: "p",
      similarity_threshold: 0.7,
      max_entries: 10,
      max_neighbors_per_entry: 2,
      randomize_selection: false,
    });

    expect(out.success).toBe(true);
    expect(storageMock.createLink).toHaveBeenCalledTimes(2);
    expect(out.newLinks).toBe(2);
  });

  /**
   * When existing links already connect source → candidate,
   * createLink must NOT be called and skippedLinks should increment.
   */
  it("skips existing links (no duplicates created)", async () => {
    const storageMock = {
      getLedgerEntries: vi.fn(async () => [
        { id: "a", embedding: JSON.stringify([1]), summary: "s1" },
      ]),
      searchMemory: vi.fn(async () => [{ id: "b", similarity: 0.91 }]),
      getLinksFrom: vi.fn(async () => [{ target_id: "b" }]),
      createLink: vi.fn(async () => {}),
    };
    (getStorage as any).mockResolvedValue(storageMock);

    const out = await graphHandlers.synthesizeEdgesCore({
      project: "p",
      similarity_threshold: 0.7,
      max_entries: 5,
      max_neighbors_per_entry: 3,
      randomize_selection: false,
    });

    expect(storageMock.createLink).not.toHaveBeenCalled();
    expect(out.skippedLinks).toBe(1);
    expect(out.newLinks).toBe(0);
  });

  /**
   * Candidates below threshold should be counted in totalBelow
   * and NOT create links.
   */
  it("counts below-threshold candidates correctly", async () => {
    const storageMock = {
      getLedgerEntries: vi.fn(async () => [
        { id: "a", embedding: JSON.stringify([1, 2, 3]), summary: "s1" },
      ]),
      searchMemory: vi.fn(async () => [
        { id: "b", similarity: 0.95 },
        { id: "c", similarity: 0.3 },  // below 0.7
        { id: "d", similarity: 0.1 },  // below 0.7
      ]),
      getLinksFrom: vi.fn(async () => []),
      createLink: vi.fn(async () => {}),
    };
    (getStorage as any).mockResolvedValue(storageMock);

    const out = await graphHandlers.synthesizeEdgesCore({
      project: "p",
      similarity_threshold: 0.7,
      max_entries: 10,
      max_neighbors_per_entry: 5,
      randomize_selection: false,
    });

    expect(out.totalBelow).toBe(2);
    expect(out.newLinks).toBe(1);
    expect(out.totalCandidates).toBe(3);
  });

  /**
   * Self-matches (match.id === entry.id) should be silently
   * skipped — they must not count as candidates at all.
   */
  it("ignores self-matches in candidates", async () => {
    const storageMock = {
      getLedgerEntries: vi.fn(async () => [
        { id: "a", embedding: JSON.stringify([1, 2, 3]), summary: "s1" },
      ]),
      searchMemory: vi.fn(async () => [
        { id: "a", similarity: 1.0 },   // self — should be skipped
        { id: "b", similarity: 0.85 },
      ]),
      getLinksFrom: vi.fn(async () => []),
      createLink: vi.fn(async () => {}),
    };
    (getStorage as any).mockResolvedValue(storageMock);

    const out = await graphHandlers.synthesizeEdgesCore({
      project: "p",
      similarity_threshold: 0.7,
      max_entries: 10,
      max_neighbors_per_entry: 5,
      randomize_selection: false,
    });

    expect(out.newLinks).toBe(1);
    // Self-match is skipped before candidatesEvaluated++
    expect(out.totalCandidates).toBe(1);
  });

  /**
   * Created links must use 'synthesized_from' type and clamped strength.
   */
  it("creates links with correct type and clamped strength", async () => {
    const storageMock = {
      getLedgerEntries: vi.fn(async () => [
        { id: "a", embedding: JSON.stringify([1, 2, 3]), summary: "s1" },
      ]),
      searchMemory: vi.fn(async () => [
        { id: "b", similarity: 0.88 },
      ]),
      getLinksFrom: vi.fn(async () => []),
      createLink: vi.fn(async () => {}),
    };
    (getStorage as any).mockResolvedValue(storageMock);

    await graphHandlers.synthesizeEdgesCore({
      project: "p",
      similarity_threshold: 0.7,
      max_entries: 10,
      max_neighbors_per_entry: 3,
      randomize_selection: false,
    });

    expect(storageMock.createLink).toHaveBeenCalledWith(
      expect.objectContaining({
        source_id: "a",
        target_id: "b",
        link_type: "synthesized_from",
        strength: 0.88,
      }),
      expect.any(String) // PRISM_USER_ID
    );
  });

  /**
   * Randomized selection path should call getLedgerEntries twice:
   * once for ID fetch (select: "id"), once for full fetch (ids: [...]).
   */
  it("randomize_selection fetches IDs then full entries", async () => {
    const storageMock = {
      getLedgerEntries: vi.fn()
        .mockResolvedValueOnce([{ id: "x" }, { id: "y" }]) // ID fetch
        .mockResolvedValueOnce([                             // Full fetch
          { id: "x", embedding: JSON.stringify([1]), summary: "sx" },
          { id: "y", embedding: JSON.stringify([2]), summary: "sy" },
        ]),
      searchMemory: vi.fn(async () => []),
      getLinksFrom: vi.fn(async () => []),
      createLink: vi.fn(async () => {}),
    };
    (getStorage as any).mockResolvedValue(storageMock);

    const out = await graphHandlers.synthesizeEdgesCore({
      project: "p",
      similarity_threshold: 0.7,
      max_entries: 10,
      max_neighbors_per_entry: 3,
      randomize_selection: true,
    });

    expect(out.success).toBe(true);
    // First call: ID-only select
    expect(storageMock.getLedgerEntries).toHaveBeenCalledWith(
      expect.objectContaining({ select: "id" })
    );
    // Second call: full entry fetch by IDs
    expect(storageMock.getLedgerEntries).toHaveBeenCalledWith(
      expect.objectContaining({ ids: expect.any(Array) })
    );
    expect(out.entriesScanned).toBe(2);
  });

  /**
   * Empty ledger should succeed with zeroed counters.
   */
  it("handles empty ledger gracefully", async () => {
    const storageMock = {
      getLedgerEntries: vi.fn(async () => []),
      searchMemory: vi.fn(async () => []),
      getLinksFrom: vi.fn(async () => []),
      createLink: vi.fn(async () => {}),
    };
    (getStorage as any).mockResolvedValue(storageMock);

    const out = await graphHandlers.synthesizeEdgesCore({
      project: "p",
      similarity_threshold: 0.7,
      max_entries: 10,
      max_neighbors_per_entry: 3,
      randomize_selection: false,
    });

    expect(out.success).toBe(true);
    expect(out.entriesScanned).toBe(0);
    expect(out.newLinks).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// CONTEXT ASSEMBLY — assembleTestMeContext
// ═══════════════════════════════════════════════════════════════════

describe("assembleTestMeContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Link traversal must use `link.target_id` (not `link.to`).
   * If the target is a UUID-length string, it should resolve the entry.
   */
  it("uses target_id from memory links", async () => {
    const storageMock = {
      getLinksFrom: vi.fn(async () => [
        { target_id: "11111111-1111-1111-1111-111111111111" },
      ]),
      getLedgerEntries: vi.fn(async () => [
        { id: "11111111-1111-1111-1111-111111111111", summary: "linked summary content" },
      ]),
      searchKnowledge: vi.fn(async () => ({ results: [] })),
    };

    const ctx = await graphHandlers.assembleTestMeContext(
      "node",
      "proj",
      storageMock as any
    );

    expect(ctx.contextItems.length).toBeGreaterThan(0);
    expect(ctx.contextItems[0]).toContain("linked summary");
  });

  /**
   * When both graph links and searchKnowledge return the same entry,
   * it should appear only once in contextItems (dedup by ID).
   */
  it("deduplicates entries from links and semantic search", async () => {
    const sharedId = "22222222-2222-2222-2222-222222222222";
    const storageMock = {
      getLinksFrom: vi.fn(async () => [{ target_id: sharedId }]),
      getLedgerEntries: vi.fn(async () => [
        { id: sharedId, summary: "shared context" },
      ]),
      searchKnowledge: vi.fn(async () => ({
        results: [{ id: sharedId, summary: "shared context" }],
      })),
    };

    const ctx = await graphHandlers.assembleTestMeContext(
      "node",
      "proj",
      storageMock as any
    );

    // Should have exactly 1, not 2
    expect(ctx.contextItems).toHaveLength(1);
  });

  /**
   * Summaries longer than 300 chars must be truncated.
   */
  it("truncates summaries to 300 chars", async () => {
    const longSummary = "x".repeat(500);
    const storageMock = {
      getLinksFrom: vi.fn(async () => [
        { target_id: "33333333-3333-3333-3333-333333333333" },
      ]),
      getLedgerEntries: vi.fn(async () => [
        { id: "33333333-3333-3333-3333-333333333333", summary: longSummary },
      ]),
      searchKnowledge: vi.fn(async () => ({ results: [] })),
    };

    const ctx = await graphHandlers.assembleTestMeContext(
      "node",
      "proj",
      storageMock as any
    );

    expect(ctx.contextItems[0].length).toBeLessThanOrEqual(300);
  });

  /**
   * With no links and no search results, contextItems should be empty
   * (not throw).
   */
  it("handles empty graph gracefully", async () => {
    const storageMock = {
      getLinksFrom: vi.fn(async () => []),
      getLedgerEntries: vi.fn(async () => []),
      searchKnowledge: vi.fn(async () => ({ results: [] })),
    };

    const ctx = await graphHandlers.assembleTestMeContext(
      "node",
      "proj",
      storageMock as any
    );

    expect(ctx.contextItems).toEqual([]);
    expect(ctx.nodeId).toBe("node");
    expect(ctx.project).toBe("proj");
  });
});

// ═══════════════════════════════════════════════════════════════════
// LLM GENERATION — generateTestMeQuestions
// ═══════════════════════════════════════════════════════════════════

describe("generateTestMeQuestions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * When the LLM returns valid JSON with exactly 3 {q,a} objects,
   * the function should parse and return them.
   */
  it("parses valid 3-item Q/A response", async () => {
    const out = await graphHandlers.generateTestMeQuestions(
      { contextItems: ["some context"] },
      "node"
    );

    expect(out.questions).toHaveLength(3);
    expect(out.reason).toBeUndefined();
    for (const qa of out.questions) {
      expect(typeof qa.q).toBe("string");
      expect(typeof qa.a).toBe("string");
    }
  });

  /**
   * Malformed (non-JSON) LLM output should return generation_failed,
   * not throw.
   */
  it("returns generation_failed on malformed LLM output", async () => {
    const { getLLMProvider } = await import("../../src/utils/llm/factory.js");
    (getLLMProvider as any).mockReturnValueOnce({
      generateText: vi.fn(async () => "this is not json at all"),
    });

    const out = await graphHandlers.generateTestMeQuestions(
      { contextItems: ["x"] },
      "node"
    );

    expect(out.questions).toEqual([]);
    expect(out.reason).toBe("generation_failed");
  });

  /**
   * If LLM returns valid JSON but wrong shape (e.g. 2 items instead of 3),
   * it should still return generation_failed.
   */
  it("returns generation_failed on wrong array length", async () => {
    const { getLLMProvider } = await import("../../src/utils/llm/factory.js");
    (getLLMProvider as any).mockReturnValueOnce({
      generateText: vi.fn(async () =>
        JSON.stringify([{ q: "Q1", a: "A1" }, { q: "Q2", a: "A2" }])
      ),
    });

    const out = await graphHandlers.generateTestMeQuestions(
      { contextItems: ["x"] },
      "node"
    );

    expect(out.questions).toEqual([]);
    expect(out.reason).toBe("generation_failed");
  });

  /**
   * If LLM throws an error containing "API key", it should be
   * detected and reported as no_api_key.
   */
  it("returns no_api_key when provider throws auth error", async () => {
    const { getLLMProvider } = await import("../../src/utils/llm/factory.js");
    (getLLMProvider as any).mockReturnValueOnce({
      generateText: vi.fn(async () => { throw new Error("Invalid API key"); }),
    });

    const out = await graphHandlers.generateTestMeQuestions(
      { contextItems: ["x"] },
      "node"
    );

    expect(out.questions).toEqual([]);
    expect(out.reason).toBe("no_api_key");
  });
});
