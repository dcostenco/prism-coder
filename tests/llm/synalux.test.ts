import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStorage: vi.fn(),
  getSynaluxJwt: vi.fn(),
  invalidateSynaluxJwt: vi.fn(),
  resolvePortalBaseUrl: vi.fn(),
}));

vi.mock("../../src/storage/index.js", () => ({
  getStorage: mocks.getStorage,
  activeStorageBackend: "synalux",
}));
vi.mock("../../src/storage/supabase.js", () => ({
  SupabaseStorage: class {},
}));
vi.mock("../../src/utils/synaluxJwt.js", () => ({
  getSynaluxJwt: mocks.getSynaluxJwt,
  invalidateSynaluxJwt: mocks.invalidateSynaluxJwt,
}));
vi.mock("../../src/utils/synaluxSearch.js", () => ({
  resolvePortalBaseUrl: mocks.resolvePortalBaseUrl,
}));
vi.mock("../../src/server.js", () => ({ notifyResourceUpdate: vi.fn() }));

import { SynaluxStorage } from "../../src/storage/synalux.js";
import { backfillEmbeddingsHandler, embeddingRepairLimit } from "../../src/tools/hygieneHandlers.js";
import { compactLedgerHandler } from "../../src/tools/compactionHandler.js";
import { DEFAULT_SCHEDULER_CONFIG, runSchedulerSweep } from "../../src/backgroundScheduler.js";
import {
  _resetLLMProvider,
} from "../../src/utils/llm/factory.js";
import { SynaluxEmbeddingAdapter, SynaluxEmbeddingRefusedError } from "../../src/utils/llm/adapters/synalux.js";
import { embeddingSupportOf, FULL_EMBEDDING_SUPPORT } from "../../src/storage/interface.js";
import { embeddingFailures, clearEmbeddingFailures, recordEmbeddingFailure } from "../../src/utils/embeddingHealth.js";

const MODEL = "gemini-embedding-001";
const TASK_TYPE = "SEMANTIC_SIMILARITY";
const vector = Array.from({ length: 768 }, () => 0.01);

function embeddingResponse(patch: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    model: MODEL,
    dimensions: 768,
    task_type: TASK_TYPE,
    embedding: vector,
    ...patch,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Synalux embedding client", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    mocks.resolvePortalBaseUrl.mockReturnValue("https://portal.test");
    mocks.getSynaluxJwt.mockResolvedValue("jwt-fixture");
    fetchMock.mockResolvedValue(embeddingResponse());
    _resetLLMProvider();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends a JWT to Portal, not a provider key or caller tier", async () => {
    await expect(new SynaluxEmbeddingAdapter().generateEmbedding("pos")).resolves.toEqual(vector);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://portal.test/api/v1/prism/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer jwt-fixture" }),
        body: JSON.stringify({ text: "pos" }),
      }),
    );
    expect(JSON.stringify(fetchMock.mock.calls[0])).not.toContain("GOOGLE_API_KEY");
  });

  it.each([
    ["model", { model: "nomic" }],
    ["dimensions", { dimensions: 767 }],
    ["task type", { task_type: "RETRIEVAL_DOCUMENT" }],
    ["missing task type", { task_type: undefined }],
    ["vector length", { embedding: Array(767).fill(1) }],
    ["all-zero vector", { embedding: Array(768).fill(0) }],
    ["non-numeric vector", { embedding: Array(768).fill("1") }],
  ])("rejects an incompatible %s", async (_name, patch) => {
    fetchMock.mockResolvedValue(embeddingResponse(patch));
    await expect(new SynaluxEmbeddingAdapter().generateEmbedding("pos")).rejects.toThrow("incompatible");
  });

  it("fails clearly when Synalux credentials cannot produce a JWT", async () => {
    mocks.getSynaluxJwt.mockResolvedValue(null);
    await expect(new SynaluxEmbeddingAdapter().generateEmbedding("pos")).rejects.toThrow(
      "authentication unavailable",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes once on 401 and resumes the same embedding request", async () => {
    mocks.getSynaluxJwt.mockResolvedValueOnce("expired-jwt").mockResolvedValueOnce("fresh-jwt");
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(embeddingResponse());

    await expect(new SynaluxEmbeddingAdapter().generateEmbedding("pos")).resolves.toEqual(vector);
    expect(mocks.invalidateSynaluxJwt).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer fresh-jwt",
    });
  });

  it("paces one 429 retry using Retry-After, then resumes the same request", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(embeddingResponse());

    await expect(new SynaluxEmbeddingAdapter(sleep).generateEmbedding("pos")).resolves.toEqual(vector);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe((fetchMock.mock.calls[1][1] as RequestInit).body);
  });

  it("bounds Retry-After and never loops on repeated 429 responses", async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    fetchMock.mockResolvedValue(
      new Response(null, { status: 429, headers: { "Retry-After": "999999" } }),
    );

    await expect(new SynaluxEmbeddingAdapter(sleep).generateEmbedding("pos")).rejects.toThrow("HTTP 429");
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not silently switch embedding models when Portal is absent", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(new SynaluxEmbeddingAdapter().generateEmbedding("pos")).rejects.toThrow("not deployed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { project: "prism" }])(
    "refuses unsupported Synalux compaction before discovery or a ledger write (%j)",
    async (args) => {
      vi.stubEnv("PRISM_SYNALUX_BASE_URL", "https://portal.test");
      vi.stubEnv("PRISM_SYNALUX_API_KEY", ["synalux", "sk", "fixture0000000000"].join("_"));
      const storage = new SynaluxStorage();
      const list = vi.fn().mockResolvedValue([]);
      const discover = vi.fn().mockResolvedValue([]);
      Object.assign(storage, { getLedgerEntries: list, getCompactionCandidates: discover });
      mocks.getStorage.mockResolvedValue(storage);

      const result = await compactLedgerHandler(args);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Synalux cloud ledger compaction is unavailable");
      expect(list).not.toHaveBeenCalled();
      expect(discover).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("skips unsupported Synalux compaction before scheduled discovery", async () => {
    vi.stubEnv("PRISM_SYNALUX_BASE_URL", "https://portal.test");
    vi.stubEnv("PRISM_SYNALUX_API_KEY", ["synalux", "sk", "fixture0000000000"].join("_"));
    vi.stubEnv("PRISM_STORAGE_BACKEND", "local");
    const storage = new SynaluxStorage();
    const discover = vi.fn().mockResolvedValue([{ project: "prism", total_entries: 60, to_compact: 50 }]);
    Object.assign(storage, {
      getCompactionCandidates: discover,
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
      decayLinks: vi.fn().mockResolvedValue(0),
      listProjects: vi.fn().mockResolvedValue([]),
    });
    mocks.getStorage.mockResolvedValue(storage);

    const sweep = await runSchedulerSweep({ ...DEFAULT_SCHEDULER_CONFIG,
      enableTTLSweep: false, enableDecay: false, enableDeepPurge: false, enableSdmFlush: false,
      enableEdgeSynthesis: false, enableGraphPruning: false, enableAccessLogPrune: false });

    expect(discover).not.toHaveBeenCalled();
    expect(sweep.tasks.compaction).toEqual({ ran: false, projectsCompacted: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("truncates text above 8,000 characters at a word boundary", async () => {
    await new SynaluxEmbeddingAdapter().generateEmbedding(`${"word ".repeat(1600)}partial`);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.text.length).toBeLessThanOrEqual(8_000);
    expect(body.text).toMatch(/word$/);
    expect(body.text).not.toContain("partial");
  });

  it("repairs through the handler with no Google key and preserves only-if-missing to Portal", async () => {
    if (process.env.PRISM_ASSERT_NO_GOOGLE_KEYS === "1") {
      // This assertion runs after tests/setup.ts has called dotenv.config().
      // The isolated child acceptance command must fail if .env restored either key.
      expect(process.env.GOOGLE_API_KEY).toBeUndefined();
      expect(process.env.GEMINI_API_KEY).toBeUndefined();
    }

    vi.stubEnv("PRISM_SYNALUX_BASE_URL", "https://portal.test");
    vi.stubEnv("PRISM_SYNALUX_API_KEY", ["synalux", "sk", "fixture0000000000"].join("_"));
    const storage = new SynaluxStorage();
    mocks.getStorage.mockResolvedValue(storage);
    mocks.getSynaluxJwt.mockResolvedValue("embedding-jwt");
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/v1/auth/jwt")) {
        return new Response(JSON.stringify({ status: "success", jwt: "storage-jwt", expires_in: 900 }));
      }
      if (url.endsWith("/api/v1/prism/embeddings")) return embeddingResponse();
      if (url.endsWith("/api/v1/prism/memory")) {
        const body = JSON.parse(init.body as string);
        if (body.action === "list_missing_embeddings") {
          return new Response(JSON.stringify({
            status: "success",
            entries: [{ id: "entry-fixture", project: "prism", summary: "repair me", decisions: [] }],
          }));
        }
        if (body.action === "save_embedding") {
          return new Response(JSON.stringify({ status: "success" }));
        }
      }
      throw new Error(`Unexpected test request: ${url}`);
    });

    const result = await backfillEmbeddingsHandler({ project: "prism", limit: 1 });

    expect(result.isError).toBe(false);
    expect((result as any)._stats).toMatchObject({ repaired: 1, failed: 0 });
    const saveCall = fetchMock.mock.calls.find(([, init]) => {
      if (typeof (init as RequestInit).body !== "string") return false;
      return JSON.parse((init as RequestInit).body as string).action === "save_embedding";
    });
    expect(saveCall).toBeDefined();
    expect(JSON.parse((saveCall![1] as RequestInit).body as string)).toMatchObject({
      action: "save_embedding",
      memory_id: "entry-fixture",
      only_if_missing: true,
    });
  });

  // The Portal's 403 codes are typed, never retried,
  // and stop a repair run on cloud memory.
  it.each([
    [{ code: "embedding_daily_allowance", reset_at: "2026-11-15T00:00:00.000Z" }, "embedding_daily_allowance", "2026-11-15T00:00:00.000Z", /allowance used for today \(resets 2026-11-15/],
    [{ code: "plan_not_eligible" }, "plan_not_eligible", null, /not included in this Synalux plan/],
    [{ error: "forbidden" }, null, null, /refused \(HTTP 403\)/],
  ])("a 403 %j is a typed refusal, not retried", async (body, code, resetAt, message) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 403 }));
    const error = await new SynaluxEmbeddingAdapter(async () => undefined).generateEmbedding("hello").catch((e) => e);
    expect(error).toBeInstanceOf(SynaluxEmbeddingRefusedError);
    expect(error).toMatchObject({ code, resetAt });
    expect(String(error.message)).toMatch(message);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 403 with a body that is not JSON is still a refusal", async () => {
    fetchMock.mockResolvedValue(new Response("<html>forbidden</html>", { status: 403 }));
    await expect(new SynaluxEmbeddingAdapter().generateEmbedding("hello")).rejects.toMatchObject({ code: null, resetAt: null });
  });

  it("on cloud memory a refusal ends the repair run: one call, the rest left for later", async () => {
    vi.stubEnv("PRISM_SYNALUX_BASE_URL", "https://portal.test");
    vi.stubEnv("PRISM_SYNALUX_API_KEY", ["synalux", "sk", "fixture0000000000"].join("_"));
    mocks.getStorage.mockResolvedValue(new SynaluxStorage());
    let embeddingCalls = 0;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/v1/auth/jwt")) return new Response(JSON.stringify({ status: "success", jwt: "storage-jwt", expires_in: 900 }));
      if (url.endsWith("/api/v1/prism/embeddings")) {
        embeddingCalls += 1;
        return new Response(JSON.stringify({ code: "embedding_daily_allowance", reset_at: "2026-11-15T00:00:00.000Z" }), { status: 403 });
      }
      if (url.endsWith("/api/v1/prism/memory") && JSON.parse(init.body as string).action === "list_missing_embeddings") {
        return new Response(JSON.stringify({ status: "success", entries: ["a", "b", "c"].map((id) => ({ id, project: "prism", summary: `entry ${id}`, decisions: [] })) }));
      }
      throw new Error(`Unexpected test request: ${url}`);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await backfillEmbeddingsHandler({ project: "prism", limit: 3 }) as any;
    error.mockRestore();
    expect(embeddingCalls).toBe(1);
    expect(result._stats).toMatchObject({ repaired: 0, failed: 1, refused: expect.stringMatching(/allowance used for today/) });
    expect(result.content[0].text).toMatch(/Stopped: Synalux embedding allowance used for today/);
  });

  it("cloud memory declares what it keeps; other stores keep everything", () => {
    vi.stubEnv("PRISM_SYNALUX_BASE_URL", "https://portal.test");
    vi.stubEnv("PRISM_SYNALUX_API_KEY", ["synalux", "sk", "fixture0000000000"].join("_"));
    expect(new SynaluxStorage().embeddingSupport).toEqual({ handoffVectors: false, localSdm: false, serverMetered: true });
    expect(embeddingSupportOf(undefined)).toEqual(FULL_EMBEDDING_SUPPORT);
    expect(embeddingSupportOf({})).toEqual({ handoffVectors: true, localSdm: true, serverMetered: false });
  });
});

describe("embedding repair loops", () => {
  it("other stores never stop early", () => {
    const limit = embeddingRepairLimit(false);
    for (let i = 0; i < 5; i++) expect(limit.stop({ repaired: 0, refused: "x" })).toBe(false);
  });

  it("cloud memory stops on a refusal, or when a batch repairs nothing twice in a row", () => {
    expect(embeddingRepairLimit(true).stop({ repaired: 3, refused: "allowance used" })).toBe(true);
    const limit = embeddingRepairLimit(true);
    expect(limit.stop({ repaired: 0 })).toBe(false);   // one retry
    expect(limit.stop({ repaired: 2 })).toBe(false);   // progress resets the count
    expect(limit.stop({ repaired: 0 })).toBe(false);
    expect(limit.stop({ repaired: 0 })).toBe(true);
    expect(embeddingRepairLimit(true).stop(undefined)).toBe(false);
  });
});

describe("embedding failures on cloud memory", () => {
  beforeEach(() => { clearEmbeddingFailures(); });

  it("counts failures and keeps the last reason, one line and bounded", () => {
    recordEmbeddingFailure(new Error("first"));
    recordEmbeddingFailure(new Error(`Synalux embedding allowance used for today\n${"x".repeat(400)}`));
    const state = embeddingFailures();
    expect(state.pending).toBe(2);
    expect(state.lastReason).not.toContain("\n");
    expect(state.lastReason!.length).toBeLessThanOrEqual(160);
    clearEmbeddingFailures();
    expect(embeddingFailures()).toEqual({ pending: 0, lastReason: null, planRefusal: null });
  });
});
