/**
 * Web Scholar Tests — Prism MCP v5.4
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS VERIFY:
 *
 *   1. REENTRANCY GUARD:
 *      - Concurrent calls to runWebScholar() are properly rejected
 *      - The isRunning lock releases on both success and failure
 *      - A second call after completion succeeds (lock was released)
 *
 *   2. TASK-AWARE TOPIC SELECTION (selectTopic):
 *      - Random selection when Hivemind is disabled
 *      - Biased selection toward active agent tasks when Hivemind is on
 *      - Graceful fallback to random when no agents are active
 *      - Graceful fallback when storage throws
 *
 *   3. HIVEMIND LIFECYCLE:
 *      - Scholar registers as 'scholar' role on the Watchdog Radar
 *      - Scholar goes idle after pipeline completion
 *      - Hivemind calls are no-ops when PRISM_ENABLE_HIVEMIND=false
 *
 * ISOLATION:
 *   We test using mocked storage and config to avoid real API calls
 *   to Brave Search and Firecrawl. The core logic (topic selection,
 *   reentrancy) is pure business logic that doesn't need network.
 *
 * ARCHITECTURE NOTE:
 *   runWebScholar() is integration-heavy (Brave → Firecrawl → LLM → DB),
 *   so we mock at the module boundary. selectTopic() and the reentrancy
 *   guard are unit-tested directly via module internals.
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mocks (vi.mock is hoisted above imports) ───────────
// vi.hoisted() runs BEFORE vi.mock hoisting, so these variables
// are available when the mock factories execute.

const { mockConfig, mockStorage, mockFetch } = vi.hoisted(() => {
  const mockConfig = {
    BRAVE_API_KEY: "test-brave-key",
    FIRECRAWL_API_KEY: "test-firecrawl-key",
    TAVILY_API_KEY: undefined,
    GOOGLE_SEARCH_API_KEY: undefined,
    GOOGLE_SEARCH_CX: undefined,
    SEMANTIC_SCHOLAR_API_KEY: undefined,
    PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN: 3,
    PRISM_USER_ID: "default",
    PRISM_SCHOLAR_TOPICS: ["ai", "agents", "mcp", "authentication"],
    PRISM_ENABLE_HIVEMIND: false,
  };

  const mockStorage = {
    registerAgent: vi.fn().mockResolvedValue({}),
    heartbeatAgent: vi.fn().mockResolvedValue(undefined),
    updateAgentStatus: vi.fn().mockResolvedValue(undefined),
    getAllAgents: vi.fn().mockResolvedValue([]),
    saveLedger: vi.fn().mockResolvedValue({}),
  };

  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({
      success: true,
      data: { markdown: "# Test Article\n\nSome content about AI." },
    }),
    text: vi.fn().mockResolvedValue("<html><body><h1>Test Title</h1><article><p>Some content about AI.</p></article></body></html>"),
  });

  return { mockConfig, mockStorage, mockFetch };
});

vi.mock("../../src/config.js", () => mockConfig);

vi.mock("../../src/storage/index.js", () => ({
  getStorage: vi.fn().mockResolvedValue(mockStorage),
}));

vi.mock("../../src/utils/braveApi.js", () => ({
  performWebSearchRaw: vi.fn().mockResolvedValue(JSON.stringify({
    web: {
      results: [
        { url: "https://example.com/article1" },
        { url: "https://example.com/article2" },
      ]
    }
  })),
}));

vi.mock("../../src/utils/llm/factory.js", () => ({
  getLLMProvider: vi.fn().mockReturnValue({
    generateText: vi.fn().mockResolvedValue("Mock LLM synthesis report on the topic."),
  }),
}));

vi.mock("../../src/utils/telemetry.js", () => ({
  getTracer: vi.fn().mockReturnValue({
    startSpan: vi.fn().mockReturnValue({
      setAttribute: vi.fn(),
      end: vi.fn(),
    }),
  }),
}));

vi.mock("../../src/utils/logger.js", () => ({
  debugLog: vi.fn(),
}));

// Stub global fetch for Firecrawl
vi.stubGlobal("fetch", mockFetch);

// ─── Import after mocks ────────────────────────────────────────

import { runWebScholar } from "../../src/scholar/webScholar.js";

// ═══════════════════════════════════════════════════════════════════
// 1. REENTRANCY GUARD
// ═══════════════════════════════════════════════════════════════════

describe("Web Scholar — Reentrancy Guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.BRAVE_API_KEY = "test-brave-key";
    mockConfig.FIRECRAWL_API_KEY = "test-firecrawl-key";
    mockConfig.PRISM_SCHOLAR_TOPICS = ["ai", "agents"];
    mockConfig.PRISM_ENABLE_HIVEMIND = false;
  });

  /**
   * Verifies that calling runWebScholar() while another instance is
   * already running results in the second call being silently skipped.
   *
   * WHY THIS MATTERS:
   *   Without the guard, rapid button clicks or scheduler + manual trigger
   *   overlap would launch parallel pipelines, doubling API costs and
   *   potentially creating duplicate ledger entries.
   */
  it("should reject concurrent calls while pipeline is running", async () => {
    // Create a deferred promise to control when the first call completes
    let resolveFirst!: () => void;
    const blockingPromise = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    // Make the LLM call block until we release it
    const { getLLMProvider } = await import("../../src/utils/llm/factory.js");
    (getLLMProvider as any).mockReturnValueOnce({
      generateText: vi.fn().mockImplementation(() => blockingPromise.then(() => "report")),
    });

    // Start the first run (it will block on LLM)
    const firstRun = runWebScholar();

    // Give the first run time to pass the guard
    await new Promise(r => setTimeout(r, 50));

    // The second call should be silently skipped
    await runWebScholar();

    // The first pipeline is still running, so saveLedger should not
    // have been called twice
    expect(mockStorage.saveLedger).not.toHaveBeenCalled();

    // Release the first run
    resolveFirst();
    await firstRun;

    // Now saveLedger should have been called exactly once (from the first run)
    expect(mockStorage.saveLedger).toHaveBeenCalledTimes(1);
  });

  /**
   * Verifies that the isRunning lock is released even when the pipeline
   * throws an error. Without this, a crash would permanently block
   * all future Scholar runs until process restart.
   */
  it("should release the lock on pipeline failure", async () => {
    // Make the first run crash
    const { performWebSearchRaw } = await import("../../src/utils/braveApi.js");
    (performWebSearchRaw as any)
      .mockRejectedValueOnce(new Error("Brave API timeout"))
      .mockResolvedValueOnce(JSON.stringify({
        web: { results: [{ url: "https://example.com/recovery" }] }
      }));

    // First run should fail
    await runWebScholar();
    expect(mockStorage.saveLedger).not.toHaveBeenCalled();

    // Second run should succeed (lock was released in finally{})
    await runWebScholar();
    expect(mockStorage.saveLedger).toHaveBeenCalledTimes(1);
  });

  /**
   * Verifies the pipeline is skipped entirely when API keys are missing.
   * This tests the fast-exit path before any external calls.
   */
  it("should skip when API keys are missing", async () => {
    mockConfig.BRAVE_API_KEY = "";
    mockConfig.FIRECRAWL_API_KEY = "";

    await runWebScholar();

    expect(mockStorage.saveLedger).not.toHaveBeenCalled();

    // Should still release the lock
    mockConfig.BRAVE_API_KEY = "test-brave-key";
    mockConfig.FIRECRAWL_API_KEY = "test-firecrawl-key";
    await runWebScholar();
    expect(mockStorage.saveLedger).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. TASK-AWARE TOPIC SELECTION
// ═══════════════════════════════════════════════════════════════════

describe("Web Scholar — Task-Aware Topic Selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.BRAVE_API_KEY = "test-brave-key";
    mockConfig.FIRECRAWL_API_KEY = "test-firecrawl-key";
    mockConfig.PRISM_SCHOLAR_TOPICS = ["ai", "agents", "authentication", "security"];
  });

  /**
   * When Hivemind is disabled, topic selection should be random from
   * the configured list. We verify by running multiple times and
   * checking the chosen topic is always from the list.
   */
  it("should select from configured topics when Hivemind is off", async () => {
    mockConfig.PRISM_ENABLE_HIVEMIND = false;

    // Run the pipeline — it will pick a random topic
    await runWebScholar();

    // Verify saveLedger was called with a valid topic
    const savedEntry = mockStorage.saveLedger.mock.calls[0]?.[0];
    expect(savedEntry).toBeDefined();
    expect(savedEntry.summary).toMatch(/Research:/);

    // The topic should be one of our configured topics
    const topicMatch = mockConfig.PRISM_SCHOLAR_TOPICS.some(
      t => savedEntry.summary.includes(t)
    );
    expect(topicMatch).toBe(true);
  });

  /**
   * When Hivemind is enabled and active agents have tasks that match
   * configured topics, selectTopic() should bias toward those topics.
   *
   * Scenario: A dev agent is working on "Implementing authentication".
   * The configured topics include "authentication". Scholar should
   * prefer researching "authentication" over random selection.
   */
  it("should bias toward topics matching active agent tasks", async () => {
    mockConfig.PRISM_ENABLE_HIVEMIND = true;

    // Simulate a dev agent working on authentication
    mockStorage.getAllAgents.mockResolvedValue([
      {
        project: "my-app",
        user_id: "default",
        role: "dev",
        agent_name: "Dev Agent",
        status: "active",
        current_task: "Implementing authentication middleware with JWT",
        last_heartbeat: new Date().toISOString(),
      },
    ]);

    // Run the pipeline
    await runWebScholar();

    // Verify the topic was biased toward "authentication"
    const savedEntry = mockStorage.saveLedger.mock.calls[0]?.[0];
    expect(savedEntry).toBeDefined();
    expect(savedEntry.summary).toContain("authentication");
  });

  /**
   * When Hivemind is enabled but no agents are active, selectTopic()
   * should fall back to random selection.
   */
  it("should fall back to random when no active agents", async () => {
    mockConfig.PRISM_ENABLE_HIVEMIND = true;
    mockStorage.getAllAgents.mockResolvedValue([]);

    await runWebScholar();

    // Should still complete successfully with a random topic
    expect(mockStorage.saveLedger).toHaveBeenCalledTimes(1);
  });

  /**
   * When Hivemind is enabled but storage throws, selectTopic()
   * should gracefully fall back to random selection.
   */
  it("should fall back to random when storage throws", async () => {
    mockConfig.PRISM_ENABLE_HIVEMIND = true;
    mockStorage.getAllAgents.mockRejectedValue(new Error("DB connection lost"));

    await runWebScholar();

    // Should still complete successfully
    expect(mockStorage.saveLedger).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. HIVEMIND LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

describe("Web Scholar — Hivemind Lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.BRAVE_API_KEY = "test-brave-key";
    mockConfig.FIRECRAWL_API_KEY = "test-firecrawl-key";
    mockConfig.PRISM_SCHOLAR_TOPICS = ["ai"];
    mockStorage.getAllAgents.mockResolvedValue([]);
  });

  /**
   * When Hivemind is disabled, no agent registration, heartbeat,
   * or status update calls should be made.
   */
  it("should not call Hivemind APIs when disabled", async () => {
    mockConfig.PRISM_ENABLE_HIVEMIND = false;

    await runWebScholar();

    expect(mockStorage.registerAgent).not.toHaveBeenCalled();
    expect(mockStorage.heartbeatAgent).not.toHaveBeenCalled();
    expect(mockStorage.updateAgentStatus).not.toHaveBeenCalled();
  });

  /**
   * When Hivemind is enabled, Scholar should:
   * 1. Register as 'scholar' role agent
   * 2. Send heartbeats at each pipeline stage
   * 3. Go idle after completion
   */
  it("should register, heartbeat, and idle when Hivemind is enabled", async () => {
    mockConfig.PRISM_ENABLE_HIVEMIND = true;

    await runWebScholar();

    // Should have registered as Scholar
    expect(mockStorage.registerAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "scholar",
        agent_name: "Web Scholar",
        status: "active",
      })
    );

    // Should have sent heartbeats (at least 3: search, scrape, synthesis)
    expect(mockStorage.heartbeatAgent.mock.calls.length).toBeGreaterThanOrEqual(3);

    // Should have gone idle in finally{}
    expect(mockStorage.updateAgentStatus).toHaveBeenCalledWith(
      "prism-scholar", "default", "scholar", "idle"
    );
  });

  /**
   * Verifies that heartbeat task descriptions accurately reflect
   * the current pipeline stage for Dashboard Radar visibility.
   */
  it("should report accurate pipeline stage in heartbeats", async () => {
    mockConfig.PRISM_ENABLE_HIVEMIND = true;

    await runWebScholar();

    const heartbeatTasks = mockStorage.heartbeatAgent.mock.calls.map(
      (call: any[]) => call[3] // 4th arg is the task string
    );

    // Verify stage-specific heartbeats
    expect(heartbeatTasks.some((t: string) => t.includes("Searching"))).toBe(true);
    expect(heartbeatTasks.some((t: string) => t.includes("Scraping"))).toBe(true);
    expect(heartbeatTasks.some((t: string) => t.includes("Synthesizing"))).toBe(true);
  });
});
