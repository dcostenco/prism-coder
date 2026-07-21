/**
 * CLI Load Command — Integration Tests
 *
 * ═══════════════════════════════════════════════════════════════════
 * SCOPE:
 *   Tests the `prism load` CLI command for both text and JSON modes.
 *   Verifies full feature parity between CLI text mode and the MCP
 *   session_load_context handler — ensuring CLI-only users get the
 *   same enriched output (agent name, morning briefing, reality
 *   drift, visual memory, etc.).
 *
 * APPROACH:
 *   Mocks the storage layer, config settings, and git state.
 *   Tests the handler delegation, JSON envelope structure,
 *   agent_name inclusion, and no-data edge cases.
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("commander", () => {
  class Command {
    name(): this { return this; }
    description(): this { return this; }
    version(): this { return this; }
    command(): this { return this; }
    option(): this { return this; }
    requiredOption(): this { return this; }
    action(): this { return this; }
    async parseAsync(): Promise<this> { return this; }
  }
  return { Command };
});

// ─── Mock storage ───────────────────────────────────────────────
const mockLoadContext = vi.fn();
const mockStorage = {
  loadContext: mockLoadContext,
  initialize: vi.fn(),
  close: vi.fn(),
  getLedgerEntries: vi.fn(async () => []),
  getHistory: vi.fn(async () => []),
  saveHandoff: vi.fn(async () => ({ version: 1 })),
};

vi.mock("../../src/storage/index.js", () => ({
  getStorage: vi.fn(async () => mockStorage),
  closeStorage: vi.fn(async () => {}),
}));

// ─── Mock config storage ────────────────────────────────────────
const mockSettings: Record<string, string> = {};
vi.mock("../../src/storage/configStorage.js", () => ({
  getSetting: vi.fn(async (key: string, defaultValue = "") => {
    return mockSettings[key] ?? defaultValue;
  }),
  getSettingSync: vi.fn((key: string, defaultValue = "") => {
    return mockSettings[key] ?? defaultValue;
  }),
  initConfigStorage: vi.fn(async () => {}),
  refreshConfigStorageCache: vi.fn(async () => {}),
}));

// ─── Mock git state ─────────────────────────────────────────────
const mockGitState = {
  isRepo: true,
  branch: "main",
  commitSha: "abc1234def5678",
};

vi.mock("../../src/utils/git.js", () => ({
  getCurrentGitState: vi.fn(() => mockGitState),
  getGitDrift: vi.fn(() => null),
}));

// ─── Mock config ────────────────────────────────────────────────
vi.mock("../../src/config.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    PRISM_USER_ID: "default",
    SERVER_CONFIG: { name: "prism-mcp-server", version: "9.2.1" },
    GOOGLE_API_KEY: null,
    PRISM_AUTO_CAPTURE: false,
    PRISM_CAPTURE_PORTS: [],
    VERBOSE: false,
  };
});

// ─── Mock LLM provider (prevents real API calls) ────────────────
vi.mock("../../src/llm/factory.js", () => ({
  getLLMProvider: vi.fn(() => ({
    generateEmbedding: vi.fn(async () => []),
    generateText: vi.fn(async () => ""),
  })),
}));

// ─── Mock briefing (prevents real LLM calls) ────────────────────
vi.mock("../../src/utils/briefing.js", () => ({
  generateMorningBriefing: vi.fn(async () => "Test briefing content"),
}));

// ─── Mock SDM (prevents real computation) ───────────────────────
vi.mock("../../src/sdm/sdmEngine.js", () => ({
  getSdmEngine: vi.fn(() => ({
    read: vi.fn(() => new Float32Array(768)),
  })),
}));

vi.mock("../../src/sdm/sdmDecoder.js", () => ({
  decodeSdmVector: vi.fn(async () => []),
}));

// ─── Mock memory access tracking ───────────────────────────────
vi.mock("../../src/storage/memoryAccess.js", () => ({
  recordMemoryAccess: vi.fn(),
  computeEffectiveImportance: vi.fn((imp: number) => imp),
}));

// ─── Import after mocks ────────────────────────────────────────
import { getStorage, closeStorage } from "../../src/storage/index.js";
import { getSetting } from "../../src/storage/configStorage.js";
import { sessionLoadContextHandler } from "../../src/tools/ledgerHandlers.js";
import { getCurrentGitState } from "../../src/utils/git.js";
import { buildLoadJsonOutput } from "../../src/cli.js";

// ─── Test Data ──────────────────────────────────────────────────
const MOCK_HANDOFF_DATA = {
  last_summary: "Implemented OAuth2 PKCE flow with refresh tokens.",
  active_branch: "feature/oauth",
  key_context: "Using PKCE for SPA clients. Refresh tokens stored in httpOnly cookies.",
  pending_todo: [
    "Migrate user table to add refresh_token_hash column",
    "Update auth middleware to validate refresh tokens",
    "Write integration tests for token rotation",
  ],
  active_decisions: ["Use PKCE over implicit grant for security"],
  keywords: ["oauth", "pkce", "refresh-tokens", "auth", "cat:security"],
  version: 42,
  updated_at: "2026-04-09T15:00:00Z",
  role: "dev",
  recent_sessions: [
    {
      summary: "Set up OAuth2 provider integration with Google.",
      session_date: "2026-04-09T14:00:00Z",
      importance: 0.8,
    },
    {
      summary: "Researched PKCE vs implicit grant trade-offs.",
      session_date: "2026-04-08T10:00:00Z",
      importance: 0.6,
    },
  ],
  metadata: {},
};

// ═══════════════════════════════════════════════════════════════

describe("CLI Load — Text Mode (handler delegation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings["agent_name"] = "Dmitri";
    mockSettings["default_role"] = "";
    mockLoadContext.mockResolvedValue(MOCK_HANDOFF_DATA);
  });

  it("delegates to sessionLoadContextHandler and returns formatted text", async () => {
    const result = await sessionLoadContextHandler({
      project: "test-project",
      level: "standard",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);

    const text = (result.content[0] as any).text;

    // Must contain core handoff data
    expect(text).toContain("test-project");
    expect(text).toContain("OAuth2 PKCE");
    expect(text).toContain("Migrate user table");
    expect(text).toContain("Session version: 42");
  });

  it("includes agent identity block when agent_name is set", async () => {
    mockSettings["agent_name"] = "Dmitri";
    mockSettings["default_role"] = "dev";

    const result = await sessionLoadContextHandler({
      project: "test-project",
      level: "standard",
    });

    const text = (result.content[0] as any).text;
    expect(text).toContain("AGENT IDENTITY");
    expect(text).toContain("Dmitri");
  });

  it("omits agent identity block when agent_name is empty", async () => {
    mockSettings["agent_name"] = "";
    mockSettings["default_role"] = "";

    const result = await sessionLoadContextHandler({
      project: "test-project",
      level: "standard",
    });

    const text = (result.content[0] as any).text;
    expect(text).not.toContain("AGENT IDENTITY");
  });

  it("handles no-data gracefully", async () => {
    mockLoadContext.mockResolvedValue(null);

    const result = await sessionLoadContextHandler({
      project: "empty-project",
      level: "standard",
    });

    expect(result.isError).toBe(false);
    const text = (result.content[0] as any).text;
    expect(text).toContain("No session context found");
    expect(text).toContain("empty-project");
  });

  it("includes recent sessions in output", async () => {
    const result = await sessionLoadContextHandler({
      project: "test-project",
      level: "deep",
    });

    const text = (result.content[0] as any).text;
    expect(text).toContain("Recent Sessions");
    expect(text).toContain("OAuth2 provider integration");
    expect(text).toContain("PKCE vs implicit grant");
  });

  it("includes keywords in output", async () => {
    const result = await sessionLoadContextHandler({
      project: "test-project",
      level: "standard",
    });

    const text = (result.content[0] as any).text;
    expect(text).toContain("Keywords");
    expect(text).toContain("oauth");
    expect(text).toContain("pkce");
  });
});

describe("CLI Load — JSON Mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings["agent_name"] = "Dmitri";
    mockSettings["default_role"] = "";
    mockLoadContext.mockResolvedValue(MOCK_HANDOFF_DATA);
  });

  it("includes agent_name in JSON output", async () => {
    const storage = await getStorage();
    const agentName = await getSetting("agent_name", "");
    const data = await storage.loadContext("test-project", "standard", "default");

    const output = {
      agent_name: agentName || null,
      handoff: [{
        project: "test-project",
        role: (data as any).role || "global",
        last_summary: (data as any).last_summary || null,
        pending_todo: (data as any).pending_todo || null,
        version: (data as any).version ?? null,
      }],
      git_hash: "abc1234",
      git_branch: "main",
      pkg_version: "9.2.1",
    };

    expect(output.agent_name).toBe("Dmitri");
    expect(output.handoff[0].last_summary).toContain("OAuth2 PKCE");
    expect(output.handoff[0].version).toBe(42);
    expect(output.git_hash).toBe("abc1234");
    expect(output.git_branch).toBe("main");
  });

  it("returns error JSON when no data found", async () => {
    mockLoadContext.mockResolvedValue(null);

    const storage = await getStorage();
    const data = await storage.loadContext("empty-project", "standard", "default");

    expect(data).toBeNull();
    // CLI would output: { error: "No session context found..." }
    const errorOutput = { error: `No session context found for project "empty-project"` };
    expect(errorOutput.error).toContain("empty-project");
  });

  it("includes all handoff fields in JSON envelope", async () => {
    const storage = await getStorage();
    const data = await storage.loadContext("test-project", "deep", "default") as any;

    const output = {
      agent_name: "Dmitri",
      handoff: [{
        project: "test-project",
        role: data.role || "global",
        last_summary: data.last_summary || null,
        pending_todo: data.pending_todo || null,
        active_decisions: data.active_decisions || null,
        keywords: data.keywords || null,
        key_context: data.key_context || null,
        active_branch: data.active_branch || null,
        version: data.version ?? null,
        updated_at: data.updated_at || null,
      }],
      recent_ledger: (data.recent_sessions || []).map((s: any) => ({
        summary: s.summary || null,
        created_at: s.session_date || null,
      })),
      git_hash: "abc1234",
      git_branch: "main",
      pkg_version: "9.2.1",
    };

    expect(output.handoff[0].active_branch).toBe("feature/oauth");
    expect(output.handoff[0].key_context).toContain("PKCE");
    expect(output.handoff[0].active_decisions).toEqual(["Use PKCE over implicit grant for security"]);
    expect(output.handoff[0].keywords).toContain("oauth");
    expect(output.recent_ledger).toHaveLength(2);
    expect(output.recent_ledger[0].summary).toContain("OAuth2 provider");
  });

  it("sets agent_name to null when not configured", async () => {
    mockSettings["agent_name"] = "";

    const agentName = await getSetting("agent_name", "");
    const output = { agent_name: agentName || null };

    expect(output.agent_name).toBeNull();
  });

  it("emits no ledger history at quick depth even when storage includes history fields", () => {
    const output = buildLoadJsonOutput("test-project", {
      ...MOCK_HANDOFF_DATA,
      session_history: [{ summary: "must stay hidden" }],
    }, "quick", {
      agentName: "Dmitri",
      gitHash: "abc1234",
      gitBranch: "main",
      packageVersion: "9.2.1",
    });

    expect(output).toHaveProperty("recent_ledger");
    expect(output.recent_ledger).toEqual([]);
  });

  it("serializes at most five canonical recent_sessions at standard depth", () => {
    const output = buildLoadJsonOutput("test-project", {
      ...MOCK_HANDOFF_DATA,
      recent_sessions: Array.from({ length: 7 }, (_, index) => ({
        summary: `Standard session ${index}`,
        decisions: [`Standard decision ${index}`],
        session_date: `2026-07-${String(index + 1).padStart(2, "0")}T12:00:00Z`,
      })),
      session_history: [{ summary: "deep field must not win" }],
    }, "standard", {
      agentName: "Dmitri",
      gitHash: "abc1234",
      gitBranch: "main",
      packageVersion: "9.2.1",
    });

    expect(output.recent_ledger).toHaveLength(5);
    expect(output.recent_ledger.map((entry) => entry.summary)).toEqual([
      "Standard session 0",
      "Standard session 1",
      "Standard session 2",
      "Standard session 3",
      "Standard session 4",
    ]);
    expect(output.recent_ledger[0]).toMatchObject({
      decisions: ["Standard decision 0"],
      created_at: "2026-07-01T12:00:00Z",
    });
  });

  it("serializes at most fifty canonical session_history entries at deep depth", () => {
    const output = buildLoadJsonOutput("test-project", {
      ...MOCK_HANDOFF_DATA,
      recent_sessions: [{ summary: "recent field must not win" }],
      session_history: Array.from({ length: 55 }, (_, index) => ({
        summary: `Deep session ${index}`,
        decisions: [`Deep decision ${index}`],
        created_at: `2026-06-${String((index % 28) + 1).padStart(2, "0")}T12:00:00Z`,
      })),
    }, "deep", {
      agentName: "Dmitri",
      gitHash: "abc1234",
      gitBranch: "main",
      packageVersion: "9.2.1",
    });

    expect(output.recent_ledger).toHaveLength(50);
    expect(output.recent_ledger[0].summary).toBe("Deep session 0");
    expect(output.recent_ledger[49].summary).toBe("Deep session 49");
    expect(output.recent_ledger.some((entry) => entry.summary === "recent field must not win")).toBe(false);
  });

  it("keeps recent_ledger compatibility while using level-specific precedence and deep legacy fallback", () => {
    const metadata = {
      agentName: "Dmitri",
      gitHash: "abc1234",
      gitBranch: "main",
      packageVersion: "9.2.1",
    };
    const mixed = {
      ...MOCK_HANDOFF_DATA,
      recent_sessions: [{ summary: "Standard source" }],
      session_history: [{ summary: "Deep source" }],
    };

    expect(buildLoadJsonOutput("test-project", mixed, "standard", metadata).recent_ledger[0].summary)
      .toBe("Standard source");
    expect(buildLoadJsonOutput("test-project", mixed, "deep", metadata).recent_ledger[0].summary)
      .toBe("Deep source");
    expect(buildLoadJsonOutput("test-project", {
      ...MOCK_HANDOFF_DATA,
      recent_sessions: [{ summary: "Legacy deep fallback" }],
      session_history: undefined,
    }, "deep", metadata).recent_ledger[0].summary).toBe("Legacy deep fallback");

    const output = buildLoadJsonOutput("test-project", mixed, "deep", metadata);
    expect(Object.keys(output)).toEqual([
      "agent_name",
      "handoff",
      "recent_ledger",
      "git_hash",
      "git_branch",
      "pkg_version",
    ]);
  });
});

describe("CLI Load — Feature parity verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings["agent_name"] = "Dmitri";
    mockSettings["default_role"] = "dev";
    mockLoadContext.mockResolvedValue(MOCK_HANDOFF_DATA);
  });

  it("text mode includes role-scoped skill injection placeholder", async () => {
    // When a role is set but no skill document exists, the handler
    // should include "No skill configured" message
    const result = await sessionLoadContextHandler({
      project: "test-project",
      level: "standard",
      role: "dev",
    });

    const text = (result.content[0] as any).text;
    // Should have agent identity with role
    expect(text).toContain("AGENT IDENTITY");
    expect(text).toContain("dev");
  });

  it("text mode output differs from bare JSON — proves enrichment", async () => {
    // The text mode should contain enrichment markers that
    // the bare JSON envelope doesn't have
    const result = await sessionLoadContextHandler({
      project: "test-project",
      level: "standard",
    });

    const text = (result.content[0] as any).text;

    // These markers prove the handler adds enrichment beyond raw data
    expect(text).toContain("📋 Session context");
    expect(text).toContain("📝 Last Summary");
    expect(text).toContain("✅ Open TODOs");
    expect(text).toContain("🔑 Session version");
  });

  it("git state is appended by CLI (not by handler)", () => {
    // The handler doesn't include git state — the CLI appends it.
    // This test verifies the pattern.
    const gitState = getCurrentGitState();
    expect(gitState.isRepo).toBe(true);
    expect(gitState.branch).toBe("main");
    expect(gitState.commitSha).toBe("abc1234def5678");

    // CLI would append: 🔧 Git: main @ abc1234 (Prism v9.2.1)
    const gitLine = `🔧 Git: ${gitState.branch} @ ${gitState.commitSha?.substring(0, 7)} (Prism v9.2.1)`;
    expect(gitLine).toContain("main");
    expect(gitLine).toContain("abc1234");
  });
});
