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
const { mockDebugLog } = vi.hoisted(() => ({
  mockDebugLog: vi.fn(),
}));

vi.mock("../../src/utils/logger.js", () => ({
  debugLog: mockDebugLog,
}));

// Mock storage — synthesizeEdgesCore calls getStorage() internally
vi.mock("../../src/storage/index.js", () => ({
  getStorage: vi.fn(),
}));

// Mock LLM factory — synthesis uses generateEmbedding, test-me uses generateText
vi.mock("../../src/utils/llm/factory.js", () => {
  const provider = vi.fn(() => ({
    generateEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
    generateText: vi.fn(async () =>
      JSON.stringify([
        { q: "Q1", a: "A1" },
        { q: "Q2", a: "A2" },
        { q: "Q3", a: "A3" },
      ])
    ),
  }));
  return { getLLMProvider: provider, getEmbeddingProvider: provider };
});

// ─── Import mocked modules ──────────────────────────────────────
const { getStorage } = await import("../../src/storage/index.js");
const graphHandlers = await import("../../src/tools/graphHandlers.js");

// ═══════════════════════════════════════════════════════════════════
// KNOWLEDGE SEARCH — explicit empty-result contract
// ═══════════════════════════════════════════════════════════════════

describe("knowledgeSearchHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a successful zero-row response as a memory miss", async () => {
    const storageMock = {
      searchKnowledge: vi.fn(async () => ({ count: 0, results: [] })),
    };
    (getStorage as any).mockResolvedValue(storageMock);

    const out = await graphHandlers.knowledgeSearchHandler({
      query: "unfamiliar SDK syntax",
      project: "prism",
      limit: 5,
    });

    expect(out.isError).toBe(false);
    expect(out.content[0].text).toContain("No knowledge found");
    expect(out.content[0].text).not.toContain("Found 0 knowledge entries");
    expect(out.content).toHaveLength(1);
    expect(mockDebugLog.mock.calls.flat().join("\n")).not.toContain(
      "unfamiliar SDK syntax",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// SYNTHESIS — synthesizeEdgesCore
// ═══════════════════════════════════════════════════════════════════

describe("semantic-search initialization order", () => {
  it("waits for auto storage resolution before constructing the embedding provider", async () => {
    vi.clearAllMocks();
    const { getEmbeddingProvider } = await import("../../src/utils/llm/factory.js");
    let resolveStorage!: (value: unknown) => void;
    const pendingStorage = new Promise(resolve => { resolveStorage = resolve; });
    const storage = { searchMemory: vi.fn().mockResolvedValue([]) };
    vi.mocked(getStorage).mockImplementationOnce(() => pendingStorage as any);
    vi.mocked(getEmbeddingProvider).mockReturnValueOnce({
      generateEmbedding: vi.fn().mockResolvedValue([1, 2, 3]),
    });

    const search = graphHandlers.sessionSearchMemoryHandler({ query: "pos" });
    await Promise.resolve();
    expect(getEmbeddingProvider).not.toHaveBeenCalled();

    resolveStorage(storage);
    await search;
    expect(getEmbeddingProvider).toHaveBeenCalledOnce();
    expect(storage.searchMemory).toHaveBeenCalledOnce();
  });
});

// Cloud memory answers a failed query embedding
// with labelled keyword matches, and skips intuitive recall, whose local index never holds its vectors.
describe("cloud memory embedding failures", () => {
  const METERED = { handoffVectors: false, localSdm: false, serverMetered: true };
  const keywordResult = { count: 1, results: [{ id: "k1", project: "prism", summary: "keyword hit", created_at: "2026-11-14T00:00:00Z" }] };
  beforeEach(() => { vi.clearAllMocks(); });

  it("a query that cannot be embedded on cloud memory gets keyword matches, labelled with the reason", async () => {
    const { getEmbeddingProvider } = await import("../../src/utils/llm/factory.js");
    const storage = { embeddingSupport: METERED, searchKnowledge: vi.fn(async () => keywordResult), searchMemory: vi.fn() };
    vi.mocked(getStorage).mockResolvedValue(storage as any);
    vi.mocked(getEmbeddingProvider).mockReturnValueOnce({
      generateEmbedding: vi.fn().mockRejectedValue(new Error("Synalux embedding allowance used for today")),
    } as any);
    const out = await graphHandlers.sessionSearchMemoryHandler({ query: "pos", project: "prism" });
    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toMatch(/^🔤 Keyword search used; semantic search unavailable: Synalux embedding allowance used for today/);
    expect(storage.searchKnowledge).toHaveBeenCalledOnce();
    expect(storage.searchMemory).not.toHaveBeenCalled();
  });

  it("the fallback keeps the caller's trace request", async () => {
    const { getEmbeddingProvider } = await import("../../src/utils/llm/factory.js");
    const storage = { embeddingSupport: METERED, searchKnowledge: vi.fn(async () => keywordResult), searchMemory: vi.fn() };
    vi.mocked(getStorage).mockResolvedValue(storage as any);
    vi.mocked(getEmbeddingProvider).mockReturnValueOnce({ generateEmbedding: vi.fn().mockRejectedValue(new Error("refused")) } as any);
    const out = await graphHandlers.sessionSearchMemoryHandler({ query: "pos", project: "prism", enable_trace: true });
    // The label goes on the first block; the keyword search's trace and evidence blocks follow unchanged.
    expect(out.content[0].text).toMatch(/^🔤 Keyword search used/);
    expect(out.content[1].text).toMatch(/^=== MEMORY TRACE ===[\s\S]*"strategy": "keyword"/);
  });

  it("other stores keep the error and its hint, with no keyword search", async () => {
    const { getEmbeddingProvider } = await import("../../src/utils/llm/factory.js");
    const storage = { searchKnowledge: vi.fn(async () => keywordResult), searchMemory: vi.fn() };
    vi.mocked(getStorage).mockResolvedValue(storage as any);
    vi.mocked(getEmbeddingProvider).mockReturnValueOnce({ generateEmbedding: vi.fn().mockRejectedValue(new Error("no key")) } as any);
    const out = await graphHandlers.sessionSearchMemoryHandler({ query: "pos" });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/Failed to generate embedding for query: no key/);
    expect(storage.searchKnowledge).not.toHaveBeenCalled();
  });

  it("when the keyword search fails too, the original error comes back", async () => {
    const { getEmbeddingProvider } = await import("../../src/utils/llm/factory.js");
    const storage = { embeddingSupport: METERED, searchKnowledge: vi.fn().mockRejectedValue(new Error("portal down")), searchMemory: vi.fn() };
    vi.mocked(getStorage).mockResolvedValue(storage as any);
    vi.mocked(getEmbeddingProvider).mockReturnValueOnce({ generateEmbedding: vi.fn().mockRejectedValue(new Error("refused")) } as any);
    const out = await graphHandlers.sessionSearchMemoryHandler({ query: "pos" });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/Failed to generate embedding for query: refused/);
  });

  it("intuitive recall on cloud memory says it is not available and pays for no embedding", async () => {
    const { getEmbeddingProvider } = await import("../../src/utils/llm/factory.js");
    vi.mocked(getStorage).mockResolvedValue({ embeddingSupport: METERED } as any);
    const out = await graphHandlers.sessionIntuitiveRecallHandler({ project: "prism", query: "pos" });
    expect(out).toEqual({ content: [{ type: "text", text: "Intuitive recall is not available on Synalux cloud memory yet." }], isError: false });
    expect(getEmbeddingProvider).not.toHaveBeenCalled();
  });
});

describe("synthesizeEdgesCore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [{ max_entries: 51 }, "max_entries must be an integer from 1 to 50"],
    [{ max_entries: 1.5 }, "max_entries must be an integer from 1 to 50"],
    [{ max_neighbors_per_entry: 6 }, "max_neighbors_per_entry must be an integer from 1 to 5"],
    [{ max_neighbors_per_entry: 0 }, "max_neighbors_per_entry must be an integer from 1 to 5"],
    [{ similarity_threshold: Number.NaN }, "similarity_threshold must be a finite number from 0 to 1"],
    [{ similarity_threshold: 1.1 }, "similarity_threshold must be a finite number from 0 to 1"],
  ])("rejects invalid synthesis bounds before storage or embedding work: %o", async (invalid, message) => {
    const { getEmbeddingProvider } = await import("../../src/utils/llm/factory.js");

    await expect(graphHandlers.synthesizeEdgesCore({
      project: "p",
      ...invalid,
    })).rejects.toThrow(message);

    expect(getStorage).not.toHaveBeenCalled();
    expect(getEmbeddingProvider).not.toHaveBeenCalled();
  });

  it("embeds legacy cloud rows before searching and batches their new links", async () => {
    const events: string[] = [];
    const storageMock = {
      getGraphSynthesisEntries: vi.fn(async () => [
        { id: "a", summary: "graph synthesis first", decisions: [] },
        { id: "b", summary: "graph synthesis second", decisions: [] },
      ]),
      patchLedger: vi.fn(async (id: string) => { events.push(`patch:${id}`); }),
      searchMemory: vi.fn(async ({ queryEmbedding }: { queryEmbedding: string }) => {
        events.push(`search:${queryEmbedding}`);
        return queryEmbedding === JSON.stringify([0.1, 0.2, 0.3])
          ? [{ id: "b", similarity: 0.91 }]
          : [{ id: "a", similarity: 0.91 }];
      }),
      getDashboardMemoryGraph: vi.fn(async () => ({ nodes: [], edges: [], truncated: false })),
      createLinks: vi.fn(async (links: unknown[]) => { events.push(`links:${links.length}`); }),
      getLinksFrom: vi.fn(() => { throw new Error("cloud synthesis must use the bounded graph snapshot"); }),
      createLink: vi.fn(() => { throw new Error("cloud synthesis must batch link writes"); }),
    };
    (getStorage as any).mockResolvedValue(storageMock);
    const { getEmbeddingProvider } = await import("../../src/utils/llm/factory.js");
    vi.mocked(getEmbeddingProvider).mockReturnValueOnce({
      generateEmbedding: vi.fn()
        .mockResolvedValueOnce([0.1, 0.2, 0.3])
        .mockResolvedValueOnce([0.3, 0.2, 0.1]),
    });

    const out = await graphHandlers.synthesizeEdgesCore({
      project: "synalux-pos",
      max_entries: 2,
      max_neighbors_per_entry: 1,
      randomize_selection: true,
    });

    expect(out).toMatchObject({ success: true, entriesScanned: 2, embeddingsCreated: 2, newLinks: 2 });
    expect(storageMock.patchLedger).toHaveBeenNthCalledWith(1, "a", {
      embedding: JSON.stringify([0.1, 0.2, 0.3]),
      only_if_missing: true,
    });
    expect(storageMock.patchLedger).toHaveBeenNthCalledWith(2, "b", {
      embedding: JSON.stringify([0.3, 0.2, 0.1]),
      only_if_missing: true,
    });
    expect(events.indexOf("patch:b")).toBeLessThan(events.findIndex(event => event.startsWith("search:")));
    expect(storageMock.createLinks).toHaveBeenCalledOnce();
    expect(storageMock.createLinks).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ source_id: "a", target_id: "b", link_type: "synthesized_from" }),
      expect.objectContaining({ source_id: "b", target_id: "a", link_type: "synthesized_from" }),
    ]), "default");
  });

  it("reuses stored cloud vectors and existing links on a repeated synthesis", async () => {
    const generateEmbedding = vi.fn(() => { throw new Error("stored vectors must be reused"); });
    const storageMock = {
      getGraphSynthesisEntries: vi.fn(async () => [
        { id: "a", summary: "first", embedding: "[0.1,0.2,0.3]" },
        { id: "b", summary: "second", embedding: "[0.3,0.2,0.1]" },
      ]),
      patchLedger: vi.fn(() => { throw new Error("stored vectors must not be patched"); }),
      searchMemory: vi.fn(async ({ queryEmbedding }: { queryEmbedding: string }) =>
        queryEmbedding === "[0.1,0.2,0.3]"
          ? [{ id: "b", similarity: 0.91 }]
          : [{ id: "a", similarity: 0.91 }]),
      getDashboardMemoryGraph: vi.fn(async () => ({
        nodes: [],
        edges: [
          { source_id: "a", target_id: "b", link_type: "synthesized_from", strength: 0.91 },
          { source_id: "b", target_id: "a", link_type: "synthesized_from", strength: 0.91 },
        ],
        truncated: false,
      })),
      createLinks: vi.fn(() => { throw new Error("existing links must not be rewritten"); }),
      getLinksFrom: vi.fn(() => { throw new Error("cloud synthesis must use the graph snapshot"); }),
      createLink: vi.fn(() => { throw new Error("cloud synthesis must batch link writes"); }),
    };
    (getStorage as any).mockResolvedValue(storageMock);
    const { getEmbeddingProvider } = await import("../../src/utils/llm/factory.js");
    vi.mocked(getEmbeddingProvider).mockReturnValueOnce({ generateEmbedding });

    const out = await graphHandlers.synthesizeEdgesCore({
      project: "synalux-pos", max_entries: 2, max_neighbors_per_entry: 1,
    });

    expect(out).toMatchObject({
      success: true, entriesScanned: 2, embeddingsCreated: 0, skippedLinks: 2, newLinks: 0,
    });
    expect(generateEmbedding).not.toHaveBeenCalled();
    expect(storageMock.patchLedger).not.toHaveBeenCalled();
    expect(storageMock.createLinks).not.toHaveBeenCalled();
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

// ── Evidence snippets must carry the record date ────────────────────────────
// The date exists in storage (sqlite.ts selects and maps l.created_at) and was
// dropped here, at the snippet layer, so grounding evidence reached the model
// undated. This pins the mapping — a structural test, because the snippet
// builders are inline `.map()` calls with no seam to invoke directly.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("evidence snippets carry the record date", () => {
    const src = readFileSync(resolve(process.cwd(), "src/tools/graphHandlers.ts"), "utf8");
    // Index-based, not a fixed character window: a comment added inside a
    // builder silently pushed it out of a 400- then 900-char window twice,
    // which read as "builder missing" rather than "window too small".
    const builders = [...src.matchAll(/evidenceSnippets\s*=/g)].map((m) => {
        const end = src.indexOf(".filter(", m.index!);
        return src.slice(m.index!, src.indexOf(")", end) + 1);
    });

    it("finds both snippet builders", () => {
        // knowledge_search and session_search_memory. If a third appears, it
        // needs the same treatment — this fails until the count is updated.
        expect(builders).toHaveLength(2);
    });

    it.each([0, 1])("builder %i maps a date onto every snippet", (i) => {
        // session_date FIRST. It is when the work happened; created_at is when
        // the row was written and is assigned on save, so it cannot be
        // backdated — an import would stamp every migrated memory as brand new,
        // failing silently toward "fresh", the worst direction for a staleness
        // signal. Proven by probe: a row seeded with a 431-day-old created_at
        // came back stamped today.
        expect(builders[i], "session_date must be preferred over write date").toMatch(
            /recorded:\s*r\.session_date\s*\?\?\s*r\.created_at\s*\?\?\s*r\.updated_at\s*\?\?\s*r\.timestamp/,
        );
    });

    it.each([0, 1])("builder %i still requires content, not a date", (i) => {
        // A row without a date must still be emitted — undated evidence beats
        // no evidence, and describeAge renders nothing for it.
        expect(builders[i]).toMatch(/\.filter\(/);
        expect(builders[i], "date must be optional in the filter").not.toMatch(/s\.recorded/);
    });
});
