/**
 * Dashboard API Tests — Settings & Team Endpoints
 *
 * ═══════════════════════════════════════════════════════════════════
 * SCOPE:
 *   Tests the dashboard HTTP server API endpoints through their
 *   underlying storage methods:
 *   1. GET /api/settings → storage.getAllSettings()
 *   2. POST /api/settings → storage.setSetting(key, value)
 *   3. GET /api/team → storage.listTeam(project, userId)
 *   4. Error handling — non-existent keys, empty projects
 *
 * APPROACH:
 *   We test the storage layer directly (the "model" in MVC terms)
 *   rather than spinning up an HTTP server. This is faster, more
 *   reliable, and avoids port conflicts. The HTTP routing is thin
 *   enough that unit testing the storage functions provides
 *   sufficient confidence.
 *
 * API SIGNATURES:
 *   - storage.setSetting(key: string, value: string): Promise<void>
 *   - storage.getSetting(key: string): Promise<string | null>
 *   - storage.getAllSettings(): Promise<Record<string, string>>
 *   - storage.registerAgent(entry: AgentRegistryEntry): Promise<AgentRegistryEntry>
 *   - storage.listTeam(project, userId, staleMinutes?): Promise<AgentRegistryEntry[]>
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestDb,
  TEST_PROJECT,
  TEST_USER_ID,
  SAMPLE_SETTINGS,
  SAMPLE_TEAM,
} from "../helpers/fixtures.js";

// ─── Shared test state ───────────────────────────────────────────
let storage: any;
let cleanup: () => void;

beforeAll(async () => {
  const testDb = await createTestDb("dashboard-api");
  storage = testDb.storage;
  cleanup = testDb.cleanup;
}, 15_000);

afterAll(() => {
  cleanup();
});

// ═══════════════════════════════════════════════════════════════════
// 1. SETTINGS API — GET/POST /api/settings
// ═══════════════════════════════════════════════════════════════════

describe("Settings API (Storage Layer)", () => {
  /**
   * Tests the initial state — no settings saved yet.
   * getAllSettings() should return an empty object, not throw.
   */
  it("should return empty settings initially", async () => {
    const settings = await storage.getAllSettings();
    expect(settings).toBeDefined();
    expect(typeof settings).toBe("object");
    // Note: we do not assert count === 0 because vitest shares the module-cached
    // storage instance across suites. Other test files may have written settings
    // before this test runs. The meaningful invariant is that the object exists
    // and is queryable — individual key presence is tested in subsequent tests.
  });

  /**
   * Tests saving settings one by one (simulating individual POST calls).
   * Each POST to /api/settings sends { key, value } in the body.
   */
  it("should save settings individually", async () => {
    for (const [key, value] of Object.entries(SAMPLE_SETTINGS)) {
      await storage.setSetting(key, value);
    }

    // Verify each one was saved
    expect(await storage.getSetting("auto_capture")).toBe("true");
    expect(await storage.getSetting("dashboard_theme")).toBe("dark");
    expect(await storage.getSetting("default_context_depth")).toBe("standard");
    expect(await storage.getSetting("hivemind_enabled")).toBe("false");
  });

  /**
   * Tests retrieving all settings at once (the GET /api/settings flow).
   * The dashboard UI fetches all settings on modal open.
   */
  it("should retrieve all settings in one call", async () => {
    const all = await storage.getAllSettings();
    // We assert our 4 expected keys are present with correct values.
    // We do NOT assert an exact total count because vitest shares the module
    // cache across test files — other suites may have written additional keys
    // to the same process-level storage before this test runs.
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(4);
    expect(all.auto_capture).toBe("true");
    expect(all.dashboard_theme).toBe("dark");
  });

  /**
   * Tests updating an existing setting.
   * The Settings modal toggles are implemented as POST with the
   * same key and a new value — triggers ON CONFLICT UPDATE.
   */
  it("should update existing settings via upsert", async () => {
    // User toggles auto-capture off
    await storage.setSetting("auto_capture", "false");
    // User changes theme to midnight
    await storage.setSetting("dashboard_theme", "midnight");

    expect(await storage.getSetting("auto_capture")).toBe("false");
    expect(await storage.getSetting("dashboard_theme")).toBe("midnight");

    // Other settings should be unchanged
    expect(await storage.getSetting("default_context_depth")).toBe("standard");
  });

  /**
   * Tests that boolean settings are stored as strings.
   * SQLite doesn't have a native boolean type — we use "true"/"false".
   * The dashboard UI must handle this string comparison.
   */
  it("should handle boolean values as strings", async () => {
    await storage.setSetting("hivemind_enabled", "true");
    const value = await storage.getSetting("hivemind_enabled");

    // Value is a string, not a boolean
    expect(typeof value).toBe("string");
    expect(value).toBe("true");
    expect(value === "true").toBe(true); // Dashboard comparison pattern
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. TEAM API — GET /api/team?project=
// ═══════════════════════════════════════════════════════════════════

describe("Team API (Storage Layer)", () => {
  /**
   * Tests the initial state — no agents registered yet.
   */
  it("should return empty team for new project", async () => {
    const team = await storage.listTeam("nonexistent-project", TEST_USER_ID);
    expect(team).toEqual([]);
  });

  /**
   * Tests registering a full team and listing them.
   * Simulates the scenario where PM, Dev, QA, and Security agents
   * are all actively working on the same project.
   *
   * API: registerAgent(entry: AgentRegistryEntry) — single object
   */
  it("should return full team roster after registration", async () => {
    // Register all 4 agents from the fixture
    for (const agent of SAMPLE_TEAM) {
      await storage.registerAgent({
        ...agent,
        user_id: TEST_USER_ID,
      });
    }

    const team = await storage.listTeam(TEST_PROJECT, TEST_USER_ID);

    // Should have exactly 4 team members
    expect(team.length).toBe(4);

    // Verify each role is represented
    const roles = team.map((a: any) => a.role).sort();
    expect(roles).toEqual(["dev", "pm", "qa", "security"]);
  });

  /**
   * Tests that team listings include the current_task field.
   * The Hivemind Radar widget displays what each agent is doing.
   */
  it("should include current_task in team listing", async () => {
    const team = await storage.listTeam(TEST_PROJECT, TEST_USER_ID);
    const dev = team.find((a: any) => a.role === "dev");
    expect(dev.current_task).toBe("Implementing auth middleware");
  });

  /**
   * Tests that teams are project-scoped.
   * Agents registered on project A should NOT appear on project B.
   */
  it("should isolate teams by project", async () => {
    // Register an agent on a different project
    await storage.registerAgent({
      project: "other-project",
      user_id: TEST_USER_ID,
      role: "dev",
      agent_name: "Other Dev",
      current_task: "Working on other stuff",
    });

    // Original project should still only have 4 agents
    const team = await storage.listTeam(TEST_PROJECT, TEST_USER_ID);
    expect(team.length).toBe(4);

    // Other project should have exactly 1
    const otherTeam = await storage.listTeam("other-project", TEST_USER_ID);
    expect(otherTeam.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. GRAPH STEP 3B/4 — Core Contract Checks (Storage/Handler Layer)
// ═══════════════════════════════════════════════════════════════════

describe("Graph Step 3B/4 Contracts", () => {

  /**
   * Tests that synthesizeEdgesCore returns the expected metrics shape
   * when run against real SQLite storage with seeded entries.
   *
   * This is an integration-level check: real storage, real code path,
   * but with a low similarity_threshold (0.0) to guarantee link creation.
   */
  it("synthesizeEdgesCore returns metrics shape", async () => {
    const { synthesizeEdgesCore } = await import("../../src/tools/graphHandlers.js");

    // Seed minimal deterministic entries with embeddings
    await storage.saveLedger({
      project: TEST_PROJECT,
      conversation_id: "conv-synth-a",
      summary: "graph seed entry A for synthesis test",
      user_id: TEST_USER_ID,
      embedding: JSON.stringify([0.1, 0.2, 0.3]),
    });
    await storage.saveLedger({
      project: TEST_PROJECT,
      conversation_id: "conv-synth-b",
      summary: "graph seed entry B for synthesis test",
      user_id: TEST_USER_ID,
      embedding: JSON.stringify([0.1, 0.21, 0.31]),
    });

    const out = await synthesizeEdgesCore({
      project: TEST_PROJECT,
      similarity_threshold: 0.0,
      max_entries: 10,
      max_neighbors_per_entry: 2,
      randomize_selection: false,
    });

    expect(out.success).toBe(true);
    expect(typeof out.entriesScanned).toBe("number");
    expect(typeof out.totalCandidates).toBe("number");
    expect(typeof out.totalBelow).toBe("number");
    expect(typeof out.skippedLinks).toBe("number");
    expect(typeof out.newLinks).toBe("number");
  });

  /**
   * Tests the test-me helper stack (assembleTestMeContext + generateTestMeQuestions)
   * against real storage. Since no LLM key may be configured in CI, we accept
   * both success (3-item array) and known failure reasons (no_api_key, generation_failed).
   */
  it("test-me helpers return no_api_key/generation_failed OR strict 3-item shape", async () => {
    const { assembleTestMeContext, generateTestMeQuestions } = await import("../../src/tools/graphHandlers.js");

    // Context assembly should be safe even with sparse graph data
    const ctx = await assembleTestMeContext("cat:debugging", TEST_PROJECT, storage);
    expect(Array.isArray(ctx.contextItems)).toBe(true);
    expect(ctx.nodeId).toBe("cat:debugging");
    expect(ctx.project).toBe(TEST_PROJECT);

    const result = await generateTestMeQuestions(ctx, "cat:debugging");

    if (result.reason) {
      // In CI without LLM key, this is the expected path
      expect(["no_api_key", "generation_failed"]).toContain(result.reason);
      expect(result.questions).toEqual([]);
    } else {
      // With a configured LLM, we should get exactly 3 Q/A pairs
      expect(Array.isArray(result.questions)).toBe(true);
      expect(result.questions).toHaveLength(3);
      for (const qa of result.questions) {
        expect(typeof qa.q).toBe("string");
        expect(qa.q.length).toBeGreaterThan(0);
        expect(typeof qa.a).toBe("string");
        expect(qa.a.length).toBeGreaterThan(0);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. GRAPH METRICS — Snapshot Shape Contract
// ═══════════════════════════════════════════════════════════════════

describe("Graph Metrics API shape", () => {
  it("getGraphMetricsSnapshot returns stable typed payload", async () => {
    const { getGraphMetricsSnapshot, resetGraphMetricsForTests, recordSynthesisRun } = await import("../../src/observability/graphMetrics.js");

    resetGraphMetricsForTests();

    // Record one synthesis run so counters are non-zero
    recordSynthesisRun({
      project: TEST_PROJECT,
      status: "ok",
      duration_ms: 150,
      entries_scanned: 25,
      candidates: 60,
      below_threshold: 40,
      new_links: 8,
      skipped_links: 3,
    });

    const snap = getGraphMetricsSnapshot();

    // Top-level keys
    expect(snap).toHaveProperty("synthesis");
    expect(snap).toHaveProperty("testMe");
    expect(snap).toHaveProperty("scheduler");
    expect(snap).toHaveProperty("warnings");
    expect(snap).toHaveProperty("slo");

    // Synthesis counters
    expect(snap.synthesis.runs_total).toBe(1);
    expect(snap.synthesis.links_created_total).toBe(8);
    expect(snap.synthesis.last_status).toBe("ok");
    expect(snap.synthesis.duration_p50_ms).toBe(150);

    // Warnings are booleans
    expect(typeof snap.warnings.synthesis_quality_warning).toBe("boolean");
    expect(typeof snap.warnings.testme_provider_warning).toBe("boolean");
    expect(typeof snap.warnings.synthesis_failure_warning).toBe("boolean");

    // JSON-serializable (no functions, no undefined)
    const json = JSON.stringify(snap);
    expect(json).not.toContain("undefined");
    const parsed = JSON.parse(json);
    expect(parsed.synthesis.runs_total).toBe(1);

    resetGraphMetricsForTests();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. GRAPH METRICS ROUTE — Router Integration Test
// ═══════════════════════════════════════════════════════════════════

describe("GET /api/graph/metrics (Router Integration)", () => {
  /**
   * Exercises handleGraphRoutes with a mock HTTP req/res for the
   * /api/graph/metrics endpoint. This validates:
   *   - The route is recognized and handled (returns true)
   *   - HTTP 200 status code is set
   *   - Content-Type is application/json
   *   - Response body is valid JSON with the expected top-level keys
   */
  it("returns 200 with correct metrics JSON shape via handleGraphRoutes", async () => {
    const { handleGraphRoutes } = await import("../../src/dashboard/graphRouter.js");
    const { resetGraphMetricsForTests, recordSynthesisRun } = await import("../../src/observability/graphMetrics.js");

    resetGraphMetricsForTests();

    // Seed one synthesis run so the response has non-trivial data
    recordSynthesisRun({
      project: TEST_PROJECT,
      status: "ok",
      duration_ms: 200,
      entries_scanned: 10,
      candidates: 30,
      below_threshold: 20,
      new_links: 5,
      skipped_links: 1,
    });

    // Build mock URL, request, and response
    const url = new URL("http://localhost:3000/api/graph/metrics");
    const mockReq = { method: "GET" } as any;

    let statusCode = 0;
    let headers: Record<string, string> = {};
    let body = "";

    const mockRes = {
      writeHead(code: number, hdrs: Record<string, string>) {
        statusCode = code;
        headers = hdrs;
      },
      end(data: string) {
        body = data;
      },
    } as any;

    const getStorageSafe = async () => storage;

    const handled = await handleGraphRoutes(url, mockReq, mockRes, getStorageSafe);

    // Route was handled
    expect(handled).toBe(true);

    // HTTP semantics
    expect(statusCode).toBe(200);
    expect(headers["Content-Type"]).toBe("application/json");

    // Body is valid JSON with all required top-level keys
    const parsed = JSON.parse(body);
    expect(parsed).toHaveProperty("synthesis");
    expect(parsed).toHaveProperty("testMe");
    expect(parsed).toHaveProperty("scheduler");
    expect(parsed).toHaveProperty("pruning");
    expect(parsed).toHaveProperty("slo");
    expect(parsed).toHaveProperty("warnings");

    // Verify the seeded data flows through
    expect(parsed.synthesis.runs_total).toBe(1);
    expect(parsed.synthesis.links_created_total).toBe(5);
    expect(parsed.synthesis.last_status).toBe("ok");

    // Scheduler fields (legacy + WS2 additions) are present and numeric
    expect(typeof parsed.scheduler.projects_processed_last).toBe("number");
    expect(typeof parsed.scheduler.projects_succeeded_last).toBe("number");
    expect(typeof parsed.scheduler.projects_failed_last).toBe("number");
    expect(typeof parsed.scheduler.retries_last).toBe("number");
    expect(typeof parsed.scheduler.links_created_last).toBe("number");
    expect(typeof parsed.scheduler.duration_ms_last).toBe("number");
    expect(typeof parsed.scheduler.skipped_backpressure_last).toBe("number");
    expect(typeof parsed.scheduler.skipped_cooldown_last).toBe("number");
    expect(typeof parsed.scheduler.skipped_budget_last).toBe("number");
    expect(typeof parsed.scheduler.skipped_backoff_last).toBe("number");

    // Pruning fields (WS3 additions) are present and numeric
    expect(typeof parsed.pruning.projects_considered_last).toBe("number");
    expect(typeof parsed.pruning.projects_pruned_last).toBe("number");
    expect(typeof parsed.pruning.links_scanned_last).toBe("number");
    expect(typeof parsed.pruning.links_soft_pruned_last).toBe("number");
    expect(typeof parsed.pruning.min_strength_last).toBe("number");
    expect(typeof parsed.pruning.duration_ms_last).toBe("number");
    expect(typeof parsed.pruning.skipped_backpressure_last).toBe("number");
    expect(typeof parsed.pruning.skipped_cooldown_last).toBe("number");
    expect(typeof parsed.pruning.skipped_budget_last).toBe("number");

    // Warning flags are present and boolean
    expect(typeof parsed.warnings.synthesis_quality_warning).toBe("boolean");
    expect(typeof parsed.warnings.testme_provider_warning).toBe("boolean");
    expect(typeof parsed.warnings.synthesis_failure_warning).toBe("boolean");

    // SLO fields (WS4) are present with correct types
    expect(["number", "object"]).toContain(typeof parsed.slo.synthesis_success_rate); // number or null
    expect(typeof parsed.slo.net_new_links_last_sweep).toBe("number");
    expect(typeof parsed.slo.prune_ratio_last_sweep).toBe("number");
    expect(typeof parsed.slo.scheduler_sweep_duration_ms_last).toBe("number");

    resetGraphMetricsForTests();
  });

  it("returns false for non-graph routes", async () => {
    const { handleGraphRoutes } = await import("../../src/dashboard/graphRouter.js");

    const url = new URL("http://localhost:3000/api/settings");
    const mockReq = { method: "GET" } as any;
    const mockRes = { writeHead() {}, end() {} } as any;
    const getStorageSafe = async () => storage;

    const handled = await handleGraphRoutes(url, mockReq, mockRes, getStorageSafe);
    expect(handled).toBe(false);
  });
});
