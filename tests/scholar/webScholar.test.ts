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
 *   to Brave Search, the portal and the academic sources. The core logic
 *   (topic selection, reentrancy) is pure business logic that doesn't need
 *   network.
 *
 * ARCHITECTURE NOTE:
 *   runWebScholar() is integration-heavy (search → local scrape → LLM → DB),
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
    // Portal ("paid") credentials. webScholar reads this through
    // synaluxSearch.js, which is mocked below to track this flag live.
    SYNALUX_SEARCH_AVAILABLE: false,
    SEMANTIC_SCHOLAR_API_KEY: undefined,
    PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN: 3,
    // This mock replaces config.js wholesale, so every named export the
    // module imports must appear here — a missing one fails ESM linking and
    // takes the whole suite down rather than failing one assertion.
    PRISM_SCHOLAR_SCRAPE_BUDGET_MS: 60_000,
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

// scrapeArticleLocal now opens a real pinned connection rather than going
// through global.fetch, so without this the suite would make live network
// calls to example.com. Scraping has its own coverage in freeSearch.test.ts
// and ssrf-*.test.ts; here it is a boundary to stub.
vi.mock("../../src/scholar/freeSearch.js", () => ({
  // Empty by default: with no API keys the Yahoo fallback yields nothing and
  // the run must skip rather than save. A test needing the fallback to
  // produce URLs overrides this explicitly.
  searchYahooFree: vi.fn().mockResolvedValue([]),
  scrapeArticleLocal: vi.fn().mockResolvedValue({
    title: "Mock Article",
    content: "Mock article body content used for synthesis.",
  }),
}));

vi.mock("../../src/storage/index.js", () => ({
  getStorage: vi.fn().mockResolvedValue(mockStorage),
}));

// The real module resolves portal availability at call time, from the live
// environment. Mirroring that here — a function over the shared mock flag —
// lets each case choose whether portal credentials are present, and keeps the
// mock's shape identical to the module it stands in for.
vi.mock("../../src/utils/synaluxSearch.js", () => ({
  synaluxSearchAvailable: () => mockConfig.SYNALUX_SEARCH_AVAILABLE,
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
  sanitizeForLog: vi.fn((s: string) => s),
  debugLog: vi.fn(),
}));

// Stub global fetch for the academic discovery calls
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
    // Make the first run crash. The crash must come from a stage that still
    // propagates: a failing web search no longer throws out of the pipeline
    // (it degrades to the free sources), so a synthesis failure is used here
    // to keep exercising the finally{} release path.
    const { getLLMProvider } = await import("../../src/utils/llm/factory.js");
    (getLLMProvider as any)().generateText.mockRejectedValueOnce(new Error("LLM provider timeout"));

    // First run should fail
    const failed = await runWebScholar();
    expect(failed).toMatch(/^Error:/);
    expect(mockStorage.saveLedger).not.toHaveBeenCalled();

    // Second run should succeed (lock was released in finally{})
    await runWebScholar();
    expect(mockStorage.saveLedger).toHaveBeenCalledTimes(1);
  });

  /**
   * Verifies nothing is saved when no discovery provider yields a URL.
   *
   * This is NOT a fast exit before external calls: with Brave's keys absent
   * the run still walks the free academic path (PubMed + ERIC + Semantic
   * Scholar, then Yahoo). Those are stubbed empty here, so there is nothing
   * to scrape and nothing to save — and the lock is still released.
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
// 1b. DISCOVERY PROVIDER SELECTION (tier / credential matrix)
// ═══════════════════════════════════════════════════════════════════

/**
 * Who gets web discovery, and off whose credentials.
 *
 * performWebSearchRaw serves portal users from Synalux-side credentials and
 * everyone else from their own BRAVE_API_KEY. Scholar must therefore gate on
 * whether a search is POSSIBLE, not on whether this machine holds a key.
 *
 * WHY THIS MATTERS:
 *   The gate used to read `BRAVE_API_KEY && FIRECRAWL_API_KEY`, which was
 *   wrong twice. A portal-configured user holding no local key was silently
 *   demoted to the free academic path — paying for search and getting the
 *   free-tier experience. And a user who set only BRAVE_API_KEY was demoted
 *   for want of a Firecrawl key that nothing spends, since scraping is always
 *   the local scraper.
 *
 *   Nothing else in the suite asserts WHICH source a run used: every branch
 *   still produces a report, so a wrong gate is invisible without these.
 */
describe("Web Scholar — Discovery Provider Selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.BRAVE_API_KEY = "test-brave-key";
    mockConfig.FIRECRAWL_API_KEY = "test-firecrawl-key";
    mockConfig.SYNALUX_SEARCH_AVAILABLE = false;
    mockConfig.PRISM_SCHOLAR_TOPICS = ["ai", "agents"];
    mockConfig.PRISM_ENABLE_HIVEMIND = false;
  });

  /** Paid tier: portal credentials, no local keys at all. THE REGRESSION. */
  it("uses web search for a portal user holding no local keys", async () => {
    const { performWebSearchRaw } = await import("../../src/utils/braveApi.js");
    mockConfig.SYNALUX_SEARCH_AVAILABLE = true;
    mockConfig.BRAVE_API_KEY = "";
    mockConfig.FIRECRAWL_API_KEY = "";

    await runWebScholar();

    // Before the fix this fell through to the academic path: 0 calls.
    expect(performWebSearchRaw).toHaveBeenCalledTimes(1);
    expect(mockStorage.saveLedger).toHaveBeenCalledTimes(1);
  });

  /** Free tier, own key: the user's BRAVE_API_KEY is what search runs on. */
  it("uses web search for a non-portal user who supplied their own Brave key", async () => {
    const { performWebSearchRaw } = await import("../../src/utils/braveApi.js");
    mockConfig.SYNALUX_SEARCH_AVAILABLE = false;

    await runWebScholar();

    expect(performWebSearchRaw).toHaveBeenCalledTimes(1);
    expect(mockStorage.saveLedger).toHaveBeenCalledTimes(1);
  });

  /** A local Brave key alone is enough — Firecrawl gates nothing. */
  it("uses web search with BRAVE_API_KEY alone, with no Firecrawl key", async () => {
    const { performWebSearchRaw } = await import("../../src/utils/braveApi.js");
    mockConfig.SYNALUX_SEARCH_AVAILABLE = false;
    mockConfig.FIRECRAWL_API_KEY = "";

    await runWebScholar();

    expect(performWebSearchRaw).toHaveBeenCalledTimes(1);
  });

  /** Both available: still one search. Which credential wins is the
   *  transport's decision (portal-first), deliberately not re-made here. */
  it("uses web search when both portal and local credentials are present", async () => {
    const { performWebSearchRaw } = await import("../../src/utils/braveApi.js");
    mockConfig.SYNALUX_SEARCH_AVAILABLE = true;

    await runWebScholar();

    expect(performWebSearchRaw).toHaveBeenCalledTimes(1);
  });

  /** No credentials anywhere: the free academic path, and Brave is never
   *  called — calling it would throw on the missing key. */
  it("uses the free path and never calls Brave when no credentials exist", async () => {
    const { performWebSearchRaw } = await import("../../src/utils/braveApi.js");
    const { searchYahooFree } = await import("../../src/scholar/freeSearch.js");
    (searchYahooFree as any).mockResolvedValueOnce([
      { url: "https://example.org/free-article" },
    ]);
    mockConfig.SYNALUX_SEARCH_AVAILABLE = false;
    mockConfig.BRAVE_API_KEY = "";
    mockConfig.FIRECRAWL_API_KEY = "";

    await runWebScholar();

    expect(performWebSearchRaw).not.toHaveBeenCalled();
    expect(mockStorage.saveLedger).toHaveBeenCalledTimes(1);
  });

  /**
   * THE REGRESSION the capability gate would otherwise introduce.
   *
   * Portal search is available to every `prism connect` login, free
   * plans included, and the portal answers a free plan's search with
   * 403 "Cloud Search requires Standard plan or higher". Before the gate
   * change such an account never reached the portal from Scholar — it took
   * the free academic path and got results. Routing it to web search and
   * letting the 403 end the run would turn a working free tier into
   * `Error: ...` with no articles.
   */
  it("continues on the free path when the portal refuses web search, and says so", async () => {
    const { performWebSearchRaw } = await import("../../src/utils/braveApi.js");
    const { searchYahooFree } = await import("../../src/scholar/freeSearch.js");
    (performWebSearchRaw as any).mockRejectedValueOnce(
      new Error("[synaluxSearch] /api/v1/prism/search HTTP 403: Cloud Search requires Standard plan or higher."),
    );
    (searchYahooFree as any).mockResolvedValueOnce([
      { url: "https://example.org/free-article" },
    ]);
    mockConfig.SYNALUX_SEARCH_AVAILABLE = true;
    mockConfig.BRAVE_API_KEY = "";

    const result = await runWebScholar();

    expect(performWebSearchRaw).toHaveBeenCalledTimes(1);
    expect(mockStorage.saveLedger).toHaveBeenCalledTimes(1);
    expect(result).toContain("web search was unavailable");
    expect(result).toContain("HTTP 403");
    expect(result).not.toMatch(/^Error:/);
  });

  /**
   * Scholar adds no attempt of its own. Whether the user's own key may
   * answer a refusal is decided inside the transport (braveApi.ts
   * portalFirst: yes on a plan refusal, never on an expired login or an
   * outage). Here the login is expired, a local key is present, and the
   * transport has said no: Scholar makes exactly one transport call and
   * continues on the free sources.
   */
  it("makes exactly one transport call on a refusal; the own-key decision belongs to the transport", async () => {
    const { performWebSearchRaw } = await import("../../src/utils/braveApi.js");
    const { searchYahooFree } = await import("../../src/scholar/freeSearch.js");
    (performWebSearchRaw as any).mockRejectedValueOnce(
      new Error("[synaluxSearch] /api/v1/prism/search HTTP 401: JWT re-exchange failed"),
    );
    (searchYahooFree as any).mockResolvedValueOnce([
      { url: "https://example.org/free-article" },
    ]);
    mockConfig.SYNALUX_SEARCH_AVAILABLE = true;
    mockConfig.BRAVE_API_KEY = "test-brave-key";

    const result = await runWebScholar();

    expect(performWebSearchRaw).toHaveBeenCalledTimes(1);
    expect(mockStorage.saveLedger).toHaveBeenCalledTimes(1);
    expect(result).toContain("web search was unavailable");
  });

  /** The ledger gets the clean report; only the caller sees the note. */
  it("keeps the fallback note out of the stored ledger", async () => {
    const { performWebSearchRaw } = await import("../../src/utils/braveApi.js");
    const { searchYahooFree } = await import("../../src/scholar/freeSearch.js");
    (performWebSearchRaw as any).mockRejectedValueOnce(new Error("HTTP 403"));
    (searchYahooFree as any).mockResolvedValueOnce([{ url: "https://example.org/free-article" }]);
    mockConfig.SYNALUX_SEARCH_AVAILABLE = true;
    mockConfig.BRAVE_API_KEY = "";

    await runWebScholar();

    const saved = mockStorage.saveLedger.mock.calls[0][0];
    expect(saved.summary).not.toContain("web search was unavailable");
    expect(saved.summary).toContain("Research:");
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
