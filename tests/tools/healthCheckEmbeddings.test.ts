/**
 * session_health_check on Synalux cloud memory: an embedding repair that the Portal
 * refuses part-way keeps the repairs made before the refusal and says it stopped,
 * and failures recorded in this process are cleared once the server reports no
 * memory without a vector. Other stores are unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStorage: vi.fn(),
  generateEmbedding: vi.fn(),
  missing: 40,
}));

vi.mock("../../src/storage/index.js", () => ({ getStorage: mocks.getStorage, activeStorageBackend: "synalux" }));
vi.mock("../../src/utils/llm/factory.js", () => {
  const provider = vi.fn(() => ({ generateEmbedding: mocks.generateEmbedding }));
  return { getLLMProvider: provider, getEmbeddingProvider: provider };
});
vi.mock("../../src/utils/logger.js", () => ({ debugLog: vi.fn(), sanitizeForLog: (s: string) => s }));
vi.mock("../../src/server.js", () => ({ notifyResourceUpdate: vi.fn() }));
vi.mock("../../src/utils/healthCheck.js", () => ({
  runHealthCheck: () => ({
    status: "degraded",
    summary: "summary",
    totals: { activeEntries: 1, handoffs: 1, rollups: 0 },
    issues: mocks.missing > 0
      ? [{ check: "missing_embeddings", severity: "warning", message: "missing", suggestion: "repair", count: mocks.missing }]
      : [],
    counts: { errors: 0, warnings: mocks.missing > 0 ? 1 : 0, infos: 0 },
  }),
  scanForPromptInjection: async () => ({ safe: true }),
}));

import { sessionHealthCheckHandler } from "../../src/tools/hygieneHandlers.js";
import { SynaluxEmbeddingRefusedError } from "../../src/utils/llm/adapters/synalux.js";
import {
  clearEmbeddingFailures, embeddingFailureNotice, embeddingFailures, embeddingsRefusedForPlan,
  recordEmbeddingFailure, resetEmbeddingHealth,
} from "../../src/utils/embeddingHealth.js";

const METERED = { handoffVectors: false, localSdm: false, serverMetered: true };
const entries = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `e${from + i}`, project: "p", summary: `entry ${from + i}`, decisions: [] }));

function store(metered: boolean) {
  return {
    ...(metered ? { embeddingSupport: METERED } : {}),
    getHealthStats: vi.fn(async () => ({ missingEmbeddings: mocks.missing, activeLedgerSummaries: [] })),
    getEntriesMissingEmbeddings: vi.fn(async () => entries(50)),
    patchLedger: vi.fn(async () => undefined),
  };
}

describe("session_health_check embedding repair on cloud memory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEmbeddingHealth();
    mocks.missing = 40;
  });

  it("a refusal part-way keeps the repairs made before it and says the repair stopped", async () => {
    const storage = store(true);
    mocks.getStorage.mockResolvedValue(storage);
    let calls = 0;
    mocks.generateEmbedding.mockImplementation(async () => {
      calls += 1;
      if (calls > 30) throw new SynaluxEmbeddingRefusedError("embedding_daily_allowance", "2026-11-15T00:00:00.000Z");
      return Array.from({ length: 768 }, () => 0.01);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await sessionHealthCheckHandler({ auto_fix: true });
    error.mockRestore();
    const text = result.content[0].text as string;
    expect(calls).toBe(31);
    expect(storage.patchLedger).toHaveBeenCalledTimes(30);
    expect(text).toContain("Repaired 30 issues automatically.");
    expect(text).toContain("Embedding repair stopped: Synalux embedding allowance used for today (resets 2026-11-15T00:00:00.000Z)");
  });

  it("the server reporting nothing missing clears failures recorded in this process", async () => {
    mocks.getStorage.mockResolvedValue(store(true));
    recordEmbeddingFailure(new Error("Synalux embedding request failed (HTTP 502)"));
    mocks.missing = 0;
    const result = await sessionHealthCheckHandler({ auto_fix: false });
    expect(embeddingFailures().pending).toBe(0);
    expect(result.content[0].text).not.toContain("Semantic Index");
  });

  it("while the server still reports missing vectors, the recorded failures are shown", async () => {
    mocks.getStorage.mockResolvedValue(store(true));
    recordEmbeddingFailure(new Error("Synalux embedding request failed (HTTP 502)"));
    const result = await sessionHealthCheckHandler({ auto_fix: false });
    expect(result.content[0].text).toContain("### Semantic Index\n⚠️ 1 save pending semantic index: Synalux embedding request failed (HTTP 502)");
  });

  it("other stores: a refusal-shaped stat never stops the loop and nothing is cleared or shown", async () => {
    mocks.getStorage.mockResolvedValue(store(false));
    recordEmbeddingFailure(new Error("left from a cloud store"));
    mocks.missing = 0;
    const result = await sessionHealthCheckHandler({ auto_fix: false });
    expect(embeddingFailures().pending).toBe(1);
    expect(result.content[0].text).not.toContain("Semantic Index");
    clearEmbeddingFailures();
  });
});

describe("a plan without cloud embeddings", () => {
  beforeEach(() => { resetEmbeddingHealth(); });

  it("is remembered as one fixed line, not a growing count, until storage closes", () => {
    for (let i = 0; i < 3; i++) recordEmbeddingFailure(new SynaluxEmbeddingRefusedError("plan_not_eligible", null));
    expect(embeddingsRefusedForPlan()).toBe(true);
    expect(embeddingFailures().pending).toBe(0);
    expect(embeddingFailureNotice()).toBe("⚠️ Semantic index unavailable: Embeddings are not included in this Synalux plan\n");
    resetEmbeddingHealth();
    expect(embeddingsRefusedForPlan()).toBe(false);
    expect(embeddingFailureNotice()).toBe("");
  });
});
