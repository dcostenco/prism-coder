/**
 * The remedy a refused save names actually clears the refusal.
 *
 * Every other ledger/handoff test mocks the context gate away (the handler
 * suites say so: "Gate is tested separately"), and the gate's own tests never
 * call a handler. So nothing proved the pair end to end: that the call a
 * `context_not_loaded` refusal asks for really unlocks the next save. If
 * registration ever stopped following the load call — a new early return, a path
 * that depends on the level, a changed project key — the refusal text would send
 * agents in a loop and every text-only contract test would stay green.
 *
 * Real gate, real handlers; only storage and the config store are stubbed.
 * These are characterization tests: they pass on today's gate and pin the claim
 * the recovery text makes. The text itself is pinned in
 * tests/startup-recovery-contract.test.ts and src/session/__tests__/sessionContext.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const receipts = vi.hoisted(() => {
  type Receipt = {
    conversationHash: string; projectHash: string; project: string;
    boundariesVersion: string; loadedAt: number; lastSeen: number;
  };
  const rows = new Map<string, Receipt>();
  return {
    rows,
    save: async (receipt: Receipt, expiresBefore: number) => {
      for (const [key, row] of rows) if (row.lastSeen < expiresBefore) rows.delete(key);
      rows.set(`${receipt.conversationHash}:${receipt.projectHash}`, receipt);
    },
    get: async (conversationHash: string, projectHash: string) =>
      rows.get(`${conversationHash}:${projectHash}`) ?? null,
  };
});

vi.mock("../../src/storage/index.js", () => ({ getStorage: vi.fn(), activeStorageBackend: "local" }));
vi.mock("../../src/storage/configStorage.js", () => ({
  getSetting: vi.fn(() => Promise.resolve("")),
  getAllSettings: vi.fn(() => Promise.resolve({})),
  getSettingSync: vi.fn(() => ""),
  initConfigStorage: vi.fn(),
  refreshConfigStorageCache: vi.fn(() => Promise.resolve()),
  saveSessionContextReceipt: receipts.save,
  getSessionContextReceipt: receipts.get,
}));
vi.mock("../../src/skillManifestSync.js", () => ({
  MATERIALIZED_GENERATION_KEY: "skill_manifest:materialized_generation",
  resolveCanonicalSkillsDir: () => "/nonexistent-skills-root",
  readNativeSkillBody: vi.fn(() => Promise.resolve(null)),
  awaitSkillManifestSync: vi.fn(() => Promise.resolve({
    status: "unchanged", installed: [], updated: [], pruned: [], conflicts: [],
  })),
}));
vi.mock("../../src/config.js", () => ({
  PRISM_USER_ID: "test-user-id", SESSION_MEMORY_ENABLED: true, PRISM_ENABLE_HIVEMIND: false,
  PRISM_AUTO_CAPTURE: false, PRISM_CAPTURE_PORTS: [], GOOGLE_API_KEY: "",
  SERVER_CONFIG: { name: "prism-test", version: "test" },
  PRISM_GRAPH_PRUNING_ENABLED: false, PRISM_GRAPH_PRUNE_MIN_STRENGTH: 0.15,
  PRISM_GRAPH_PRUNE_PROJECT_COOLDOWN_MS: 600_000, PRISM_GRAPH_PRUNE_SWEEP_BUDGET_MS: 30_000,
  PRISM_GRAPH_PRUNE_MAX_PROJECTS_PER_SWEEP: 25, PRISM_ACTR_ENABLED: false,
  PRISM_ACTR_ACCESS_LOG_RETENTION_DAYS: 90, SYNALUX_CONFIGURED: false,
}));
vi.mock("../../src/utils/logger.js", () => ({ sanitizeForLog: vi.fn((s: string) => s), debugLog: vi.fn() }));
vi.mock("../../src/utils/llm/factory.js", () => {
  const provider = vi.fn(() => ({ generateEmbedding: vi.fn(() => Promise.resolve(new Array(3072).fill(0.01))) }));
  return { getLLMProvider: provider, getEmbeddingProvider: provider };
});
vi.mock("../../src/utils/git.js", () => ({ getCurrentGitState: vi.fn(() => ({ isRepo: false })), getGitDrift: vi.fn() }));
vi.mock("../../src/utils/keywordExtractor.js", () => ({ toKeywordArray: vi.fn(() => ["keyword1", "keyword2"]) }));
vi.mock("../../src/utils/tracing.js", () => ({ createMemoryTrace: vi.fn(), traceToContentBlock: vi.fn() }));
vi.mock("../../src/utils/autoCapture.js", () => ({ captureLocalEnvironment: vi.fn() }));
vi.mock("../../src/utils/imageCaptioner.js", () => ({ fireCaptionAsync: vi.fn() }));
vi.mock("../../src/sync/factory.js", () => ({
  getSyncBus: vi.fn(() => ({ broadcastUpdate: vi.fn(), subscribe: vi.fn(), publish: vi.fn() })),
}));
vi.mock("../../src/server.js", () => ({ notifyResourceUpdate: vi.fn() }));
vi.mock("../../src/utils/cognitiveMemory.js", () => ({
  computeEffectiveImportance: vi.fn((importance: number) => importance),
  recordMemoryAccess: vi.fn(),
}));
vi.mock("../../src/utils/inferenceMetrics.js", () => ({
  formatInferenceMetrics: vi.fn(() => ""),
  resetInferenceMetrics: vi.fn(),
  getInferenceSnapshot: vi.fn(() => ({
    totalCalls: 0, localCalls: 0, cloudCalls: 0, localPct: 0, cloudPct: 0,
    promptTokensEvaluated: 0, promptTokensSubmittedEst: 0,
    totalCompletionTokens: 0, totalTokens: 0, avgLatencyMs: 0, byModel: {},
  })),
}));
vi.mock("../../src/tools/commonHelpers.js", () => ({
  redactSettings: vi.fn((s: Record<string, string>) => s),
  toMarkdown: vi.fn(() => "# Markdown Export"),
}));
vi.mock("../../src/utils/vaultExporter.js", () => ({ buildVaultDirectory: vi.fn(() => ({})) }));

import { getStorage } from "../../src/storage/index.js";
import {
  sessionLoadContextHandler,
  sessionSaveHandoffHandler,
  sessionSaveLedgerHandler,
} from "../../src/tools/ledgerHandlers.js";
import { SESSION_LOAD_CONTEXT_TOOL } from "../../src/tools/sessionMemoryDefinitions.js";

function makeStorage() {
  return {
    saveLedger: vi.fn(() => Promise.resolve([{ id: "entry-1", created_at: new Date().toISOString() }])),
    patchLedger: vi.fn(() => Promise.resolve()),
    saveHandoff: vi.fn(() => Promise.resolve({ status: "created", version: 1 })),
    getHandoffAtVersion: vi.fn(() => Promise.resolve(null)),
    // A project with real saved state, so the load takes the full (non-fresh) path.
    loadContext: vi.fn(() => Promise.resolve({
      last_summary: "Previous session summary", active_branch: "main", key_context: "ctx",
      pending_todo: ["todo"], active_decisions: ["decision"], keywords: ["k"], version: 7,
    })),
    listProjects: vi.fn(() => Promise.resolve([])),
    getLedgerEntries: vi.fn(() => Promise.resolve([])),
    getGraduatedInsights: vi.fn(() => Promise.resolve([])),
    getCompactionCandidates: vi.fn(() => Promise.resolve([])),
    decayImportance: vi.fn(() => Promise.resolve()),
    saveHistorySnapshot: vi.fn(() => Promise.resolve()),
    getHealthStats: vi.fn(() => Promise.resolve({})),
    searchKnowledge: vi.fn(() => Promise.resolve(null)),
    searchMemory: vi.fn(() => Promise.resolve([])),
    updateLastAccessed: vi.fn(),
    setSetting: vi.fn(),
    initialize: vi.fn(),
    close: vi.fn(),
  };
}

const text = (result: { content: Array<{ text?: string }> }): string => result.content[0]?.text ?? "";
const ledger = (project: string, conversation_id: string) => ({
  project, conversation_id, summary: "Implemented the recovery contract and verified it end to end",
});
const handoff = (project: string, conversation_id: string) => ({
  project, conversation_id, last_summary: "Recovered context, then saved", open_todos: ["next step"],
});
const load = (project: string, conversation_id?: string) => ({
  project, ...(conversation_id ? { conversation_id } : {}),
  toolAction: "Reload context", toolSummary: "context_not_loaded recovery",
});

let storage: ReturnType<typeof makeStorage>;

beforeEach(() => {
  receipts.rows.clear();
  storage = makeStorage();
  vi.mocked(getStorage).mockResolvedValue(storage as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the recovery a refusal names clears the refusal", () => {
  it("ledger: refused, session_load_context(project, conversation_id), the same save succeeds", async () => {
    const refused = await sessionSaveLedgerHandler(ledger("proj-a", "conv-ledger"));
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/^context_not_loaded:/);
    expect(storage.saveLedger).not.toHaveBeenCalled();

    const recovered = await sessionLoadContextHandler(load("proj-a", "conv-ledger"));
    expect(recovered.isError).toBe(false);

    const saved = await sessionSaveLedgerHandler(ledger("proj-a", "conv-ledger"));
    expect(saved.isError).toBeFalsy();
    expect(storage.saveLedger).toHaveBeenCalledTimes(1);
  });

  it("handoff, the other gated tool: same recovery, same result", async () => {
    const refused = await sessionSaveHandoffHandler(handoff("proj-h", "conv-handoff"));
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/^context_not_loaded:/);
    expect(storage.saveHandoff).not.toHaveBeenCalled();

    await sessionLoadContextHandler(load("proj-h", "conv-handoff"));

    const saved = await sessionSaveHandoffHandler(handoff("proj-h", "conv-handoff"));
    expect(saved.isError).toBeFalsy();
    // The load itself may refresh the cached morning briefing (at most once per
    // 4 h) with its own fire-and-forget handoff write, so assert on the LAST write.
    expect(storage.saveHandoff.mock.calls.at(-1)?.[0]).toMatchObject({
      project: "proj-h",
      last_summary: "Recovered context, then saved",
    });
  });

  it("a project startup did not load: recovering it leaves the already-loaded project working", async () => {
    await sessionLoadContextHandler(load("proj-startup", "conv-multi"));
    expect((await sessionSaveLedgerHandler(ledger("proj-startup", "conv-multi"))).isError).toBeFalsy();

    const refused = await sessionSaveLedgerHandler(ledger("proj-other", "conv-multi"));
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("the requested project was not loaded for this conversation");

    await sessionLoadContextHandler(load("proj-other", "conv-multi"));
    expect((await sessionSaveLedgerHandler(ledger("proj-other", "conv-multi"))).isError).toBeFalsy();
    expect((await sessionSaveLedgerHandler(ledger("proj-startup", "conv-multi"))).isError).toBeFalsy();
  });

  it("idle past the 6 h TTL: the same recovery works for a conversation that had been loaded", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T09:00:00Z"));
    await sessionLoadContextHandler(load("proj-ttl", "conv-ttl"));
    expect((await sessionSaveLedgerHandler(ledger("proj-ttl", "conv-ttl"))).isError).toBeFalsy();

    vi.setSystemTime(new Date("2026-10-01T16:30:00Z")); // 7.5 h later, no activity
    const refused = await sessionSaveLedgerHandler(ledger("proj-ttl", "conv-ttl"));
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/^context_not_loaded:/);

    await sessionLoadContextHandler(load("proj-ttl", "conv-ttl"));
    expect((await sessionSaveLedgerHandler(ledger("proj-ttl", "conv-ttl"))).isError).toBeFalsy();
  });

  it("the recovery also works for a project with no saved history (a fresh project is still registered)", async () => {
    storage.loadContext.mockResolvedValue(null as never);
    await sessionLoadContextHandler(load("proj-new", "conv-new"));
    expect((await sessionSaveLedgerHandler(ledger("proj-new", "conv-new"))).isError).toBeFalsy();
  });

  it("works at every context level, so 'quick' is a safe, cheap recovery", async () => {
    for (const level of ["quick", "standard", "deep"] as const) {
      const conv = `conv-level-${level}`;
      expect((await sessionSaveLedgerHandler(ledger("proj-level", conv))).isError).toBe(true);
      await sessionLoadContextHandler({ ...load("proj-level", conv), level });
      expect((await sessionSaveLedgerHandler(ledger("proj-level", conv))).isError).toBeFalsy();
    }
  });
});

describe("the literal call the refusal prints", () => {
  // The refusal ends its remedy with "Exact call: session_load_context({...})". An
  // agent that pastes it should be unblocked, whatever it believed the project or
  // the conversation_id to be. Executed here verbatim, with nothing added.
  const printedCall = (refusal: string): Record<string, unknown> => {
    const match = refusal.match(/ Exact call: session_load_context\((\{.*?\})\)\. \(Enforced/);
    expect(match, `no printed call in: ${refusal}`).not.toBeNull();
    return JSON.parse(match![1]);
  };

  it("ledger: executing the printed call unlocks the very save that was refused", async () => {
    const refused = await sessionSaveLedgerHandler(ledger("proj-literal", "conv-literal"));
    expect(refused.isError).toBe(true);
    const recovered = await sessionLoadContextHandler(printedCall(text(refused)));
    expect(recovered.isError).toBe(false);
    expect((await sessionSaveLedgerHandler(ledger("proj-literal", "conv-literal"))).isError).toBeFalsy();
    expect(storage.saveLedger).toHaveBeenCalledTimes(1);
  });

  it("handoff: same, for the other gated tool", async () => {
    const refused = await sessionSaveHandoffHandler(handoff("proj-literal-h", "conv-literal-h"));
    expect(refused.isError).toBe(true);
    await sessionLoadContextHandler(printedCall(text(refused)));
    expect((await sessionSaveHandoffHandler(handoff("proj-literal-h", "conv-literal-h"))).isError).toBeFalsy();
  });

  it("an id that is not the startup id (a host session id) still recovers, because the call echoes the id the save used", async () => {
    const hostSessionId = "01a0f3cf-cab5-7c72-b725-0d7711892a94";
    const refused = await sessionSaveLedgerHandler(ledger("proj-hostid", hostSessionId));
    expect(printedCall(text(refused)).conversation_id).toBe(hostSessionId);
    await sessionLoadContextHandler(printedCall(text(refused)));
    expect((await sessionSaveLedgerHandler(ledger("proj-hostid", hostSessionId))).isError).toBeFalsy();
  });
});

describe("what the recovery text says to match, and why", () => {
  it("without conversation_id the load registers nothing, so the save stays refused", async () => {
    await sessionLoadContextHandler(load("proj-noid"));
    const refused = await sessionSaveLedgerHandler(ledger("proj-noid", "conv-noid"));
    expect(refused.isError).toBe(true);
  });

  it("a different conversation_id does not unlock it", async () => {
    await sessionLoadContextHandler(load("proj-id", "conv-one"));
    expect((await sessionSaveLedgerHandler(ledger("proj-id", "conv-two"))).isError).toBe(true);
  });

  it("a different project string does not unlock it (the text says: the same project)", async () => {
    await sessionLoadContextHandler(load("Proj-Case", "conv-case"));
    expect((await sessionSaveLedgerHandler(ledger("proj-case", "conv-case"))).isError).toBe(true);
    expect((await sessionSaveLedgerHandler(ledger("Proj-Case", "conv-case"))).isError).toBeFalsy();
  });

  it("the refusal names parameters that exist on the recovery tool", async () => {
    const refused = text(await sessionSaveLedgerHandler(ledger("proj-names", "conv-names")));
    expect(refused).toContain("session_load_context");
    const props = Object.keys(
      (SESSION_LOAD_CONTEXT_TOOL.inputSchema as { properties: Record<string, unknown> }).properties,
    );
    for (const name of ["project", "conversation_id"]) {
      expect(refused).toContain(name);
      expect(props).toContain(name);
    }
  });
});
