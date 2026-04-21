/**
 * SQLite Storage Tests — Prism MCP v3.0
 *
 * ═══════════════════════════════════════════════════════════════════
 * SCOPE:
 *   Tests the SQLite storage layer including:
 *   1. Database initialization & migration safety
 *   2. Role-scoped ledger entries (v3.0)
 *   3. Role-scoped handoff state with UNIQUE constraint (v3.0)
 *   4. Agent registry CRUD operations (v3.0 Hivemind)
 *   5. System settings key-value store (v3.0 Dashboard)
 *   6. Backward compatibility (entries without role)
 *
 * ISOLATION:
 *   Each test uses createTestDb() which creates an ephemeral SQLite
 *   database in a temp directory. Cleanup happens in afterAll().
 *
 * API PATTERNS:
 *   All write methods accept a single object argument:
 *     - saveLedger(entry: LedgerEntry)
 *     - saveHandoff(handoff: HandoffEntry, expectedVersion?)
 *     - registerAgent(entry: AgentRegistryEntry)
 *   Read methods use positional arguments:
 *     - loadContext(project, level, userId, role?)
 *     - listTeam(project, userId, staleMinutes?)
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestDb,
  TEST_PROJECT,
  TEST_USER_ID,
  SAMPLE_SETTINGS,
} from "../helpers/fixtures.js";

// ─── Shared test state ───────────────────────────────────────────
// The storage instance and cleanup function are created once per
// suite — all tests in this file share the same database.
// This is intentional: we test that operations compose correctly.
let storage: any;
let cleanup: () => void;

beforeAll(async () => {
  const testDb = await createTestDb("sqlite-storage");
  storage = testDb.storage;
  cleanup = testDb.cleanup;
}, 15_000);

afterAll(() => {
  cleanup();
});

// ═══════════════════════════════════════════════════════════════════
// 1. DATABASE INITIALIZATION & MIGRATION SAFETY
// ═══════════════════════════════════════════════════════════════════

describe("Database Initialization", () => {
  /**
   * Verifies that initialize() can be called multiple times safely.
   * This happens in production when Prism restarts — the existing
   * database should be reused without data loss or migration errors.
   *
   * The key SQL pattern: CREATE TABLE IF NOT EXISTS
   */
  it("should survive re-initialization without errors", async () => {
    await expect(storage.initialize(true, storage.dbPath)).resolves.not.toThrow();
  });

  /**
   * Verifies that the v3.0 migrations created all expected tables.
   * We query the SQLite master schema to confirm table existence.
   *
   * Expected tables include:
   *   - session_ledger (with role column)
   *   - session_handoffs (rebuilt with role in UNIQUE constraint)
   *   - agent_registry (new in v3.0)
   *   - system_settings (new in v3.0 Dashboard)
   */
  it("should create all v3.0 tables", async () => {
    const result = await storage.db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );
    const tableNames = result.rows.map((r: any) => r.name);

    // Core tables from pre-v3.0
    expect(tableNames).toContain("session_ledger");
    expect(tableNames).toContain("session_handoffs");

    // New v3.0 tables
    expect(tableNames).toContain("agent_registry");
    expect(tableNames).toContain("system_settings");
  });

  /**
   * Verifies that the session_handoffs table has the correct UNIQUE
   * constraint on (project, user_id, role).
   *
   * WHY THIS MATTERS:
   *   The 4-step table rebuild was the most dangerous migration in v3.0.
   *   If the UNIQUE constraint is wrong, two agents with different roles
   *   could overwrite each other's handoff state.
   */
  it("should have UNIQUE(project, user_id, role) on session_handoffs", async () => {
    const result = await storage.db.execute(
      "SELECT sql FROM sqlite_master WHERE name='session_handoffs'"
    );
    const createSql = String(result.rows[0].sql);

    // The rebuilt table should have role in the UNIQUE constraint
    expect(createSql).toContain("UNIQUE");
    expect(createSql).toContain("role");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. LEDGER ENTRIES — Role-Scoped Memory
// ═══════════════════════════════════════════════════════════════════

describe("Ledger Entries (Role-Scoped)", () => {
  /**
   * Tests saving a ledger entry WITHOUT a role.
   * This verifies backward compatibility — pre-v3.0 clients that
   * don't send a role should work seamlessly, defaulting to 'global'.
   *
   * API: saveLedger(entry: LedgerEntry) — single object argument
   */
  it("should save a ledger entry without role (backward compat)", async () => {
    await expect(
      storage.saveLedger({
        project: TEST_PROJECT,
        conversation_id: "test-conv-001",
        user_id: TEST_USER_ID,
        summary: "Implemented user authentication with JWT tokens",
        todos: ["Add rate limiting"],
        files_changed: ["src/auth/login.ts"],
        decisions: ["Use bcrypt for password hashing"],
        // NOTE: role intentionally omitted — should default to 'global'
      })
    ).resolves.not.toThrow();
  });

  /**
   * Tests saving a ledger entry WITH a role.
   * This is the core v3.0 feature — each agent role gets its own
   * memory entries that can be filtered during context loading.
   */
  it("should save a role-scoped ledger entry", async () => {
    await expect(
      storage.saveLedger({
        project: TEST_PROJECT,
        conversation_id: "test-conv-002",
        user_id: TEST_USER_ID,
        summary: "QA agent found 3 edge cases in auth flow",
        todos: ["Fix null check on expired tokens"],
        files_changed: ["tests/auth.test.ts"],
        decisions: ["Block deploy until all auth tests pass"],
        role: "qa", // v3.0: role-scoped entry
      })
    ).resolves.not.toThrow();
  });

  /**
   * Tests that ledger entries can be retrieved and contain expected data.
   * Verifies that the PostgREST-style filter parser works correctly.
   */
  it("should retrieve saved ledger entries", async () => {
    const entries = await storage.getLedgerEntries({
      project: `eq.${TEST_PROJECT}`,
      order: "created_at.desc",
      limit: "10",
    });

    // We saved 2 entries above — should get at least 2 back
    expect(entries.length).toBeGreaterThanOrEqual(2);

    // Verify the QA summary is present
    const summaries = entries.map((e: any) => e.summary);
    expect(summaries).toContain("QA agent found 3 edge cases in auth flow");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. HANDOFF STATE — Role-Scoped with UNIQUE Constraint
// ═══════════════════════════════════════════════════════════════════

describe("Handoff State (Role-Scoped)", () => {
  /**
   * Tests saving a handoff without a role.
   * This should work exactly as pre-v3.0 — default to 'global'.
   *
   * API: saveHandoff(handoff: HandoffEntry, expectedVersion?)
   *   handoff is a single object with project, user_id, etc.
   */
  it("should save a global handoff (no role)", async () => {
    await expect(
      storage.saveHandoff({
        project: TEST_PROJECT,
        user_id: TEST_USER_ID,
        last_summary: "Refactored auth module to use middleware pattern",
        pending_todo: ["Deploy to staging", "Run load tests"],
        active_branch: "feature/auth-refactor",
        key_context: "Auth middleware now validates JWT on every request",
        // role omitted — defaults to 'global'
      })
    ).resolves.not.toThrow();
  });

  /**
   * Tests saving a role-scoped handoff.
   * This creates a SEPARATE handoff for the QA role on the same project.
   * The UNIQUE(project, user_id, role) constraint allows this because
   * 'qa' != 'global'.
   */
  it("should save a role-scoped handoff alongside global", async () => {
    await expect(
      storage.saveHandoff({
        project: TEST_PROJECT,
        user_id: TEST_USER_ID,
        last_summary: "QA completed regression suite — 47/50 tests passing",
        pending_todo: ["Fix 3 failing edge case tests"],
        active_branch: "feature/auth-refactor",
        key_context: "3 tests fail on token expiry boundary condition",
        role: "qa", // v3.0: role-scoped handoff
      })
    ).resolves.not.toThrow();
  });

  /**
   * Tests loading context for the global role.
   * Should return the global handoff, NOT the QA handoff.
   *
   * WHY THIS MATTERS:
   *   Context isolation is the core value proposition of Hivemind.
   *   A dev agent should only see dev context; a QA agent only QA context.
   *   If this bleeds, agents will have confused, mixed context.
   *
   * API: loadContext(project, level, userId, role?)
   */
  it("should load global context (default)", async () => {
    const context = await storage.loadContext(
      TEST_PROJECT, "standard", TEST_USER_ID
      // role omitted → defaults to 'global'
    );

    // Should return the global handoff summary, not QA
    expect(context).not.toBeNull();
    expect(context.last_summary).toBe("Refactored auth module to use middleware pattern");
    expect(context.recent_validations).toBeDefined();
    expect(Array.isArray(context.recent_validations)).toBe(true);
  });

  /**
   * Tests loading context for a specific role.
   * Should return ONLY the QA-scoped handoff data.
   */
  it("should load role-scoped context ('qa')", async () => {
    const context = await storage.loadContext(
      TEST_PROJECT, "standard", TEST_USER_ID, "qa" // v3.0: role filter
    );

    // Should return QA's handoff summary
    expect(context).not.toBeNull();
    expect(context.last_summary).toBe("QA completed regression suite — 47/50 tests passing");
  });

  /**
   * Tests that upserting a handoff for the same project+role replaces it.
   * The UNIQUE constraint should trigger ON CONFLICT UPDATE.
   */
  it("should upsert handoff for same project+role", async () => {
    const updatedSummary = "Updated: QA found 5 more edge cases";

    await storage.saveHandoff({
      project: TEST_PROJECT,
      user_id: TEST_USER_ID,
      last_summary: updatedSummary,
      pending_todo: ["Fix all 5 new edge cases"],
      active_branch: "feature/auth-refactor",
      key_context: "5 additional edge cases found in password reset flow",
      role: "qa",
    });

    // Loading QA context should now show the updated summary
    const context = await storage.loadContext(
      TEST_PROJECT, "standard", TEST_USER_ID, "qa"
    );
    expect(context.last_summary).toBe(updatedSummary);
  });

  /**
   * Tests that global handoff is untouched after QA upsert.
   * Verifies true role-level isolation in the UNIQUE constraint.
   */
  it("should not affect global handoff when upserting QA", async () => {
    const context = await storage.loadContext(
      TEST_PROJECT, "standard", TEST_USER_ID
    );
    // Global handoff should still be the original value
    expect(context.last_summary).toBe("Refactored auth module to use middleware pattern");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. AGENT REGISTRY — Hivemind Coordination
// ═══════════════════════════════════════════════════════════════════

describe("Agent Registry (Hivemind)", () => {
  /**
   * Tests registering a new agent.
   * This is the first step in Hivemind coordination — an agent
   * announces its presence and role to the team.
   *
   * API: registerAgent(entry: AgentRegistryEntry) — single object
   */
  it("should register a new agent", async () => {
    const result = await storage.registerAgent({
      project: TEST_PROJECT,
      user_id: TEST_USER_ID,
      role: "dev",
      agent_name: "Claude Dev Agent",
      current_task: "Implementing auth middleware",
    });

    expect(result).toBeDefined();
    expect(result.role).toBe("dev");
  });

  /**
   * Tests that registering the same role again upserts (updates).
   * An agent's task and name may change between sessions —
   * the registry should always reflect the latest state.
   */
  it("should upsert on re-registration (same project+role)", async () => {
    await storage.registerAgent({
      project: TEST_PROJECT,
      user_id: TEST_USER_ID,
      role: "dev",
      agent_name: "Claude Dev Agent v2",
      current_task: "Now working on password reset",
    });

    // Listing team should show updated info, not duplicate
    const team = await storage.listTeam(TEST_PROJECT, TEST_USER_ID);
    const devAgents = team.filter((a: any) => a.role === "dev");
    expect(devAgents.length).toBe(1); // No duplicate
    expect(devAgents[0].current_task).toBe("Now working on password reset");
  });

  /**
   * Tests registering multiple agents to build a full team roster.
   * This is the scenario where PM, QA, and Dev are all active.
   */
  it("should support multiple agents with different roles", async () => {
    // Register QA and PM agents
    await storage.registerAgent({
      project: TEST_PROJECT,
      user_id: TEST_USER_ID,
      role: "qa",
      agent_name: "QA Agent",
      current_task: "Running regression tests",
    });
    await storage.registerAgent({
      project: TEST_PROJECT,
      user_id: TEST_USER_ID,
      role: "pm",
      agent_name: "PM Agent",
      current_task: "Writing sprint retro",
    });

    const team = await storage.listTeam(TEST_PROJECT, TEST_USER_ID);

    // Should have at least dev + qa + pm = 3 agents
    expect(team.length).toBeGreaterThanOrEqual(3);

    // Verify each role is present
    const roles = team.map((a: any) => a.role);
    expect(roles).toContain("dev");
    expect(roles).toContain("qa");
    expect(roles).toContain("pm");
  });

  /**
   * Tests the heartbeat mechanism — agents pulse their status
   * periodically so the team knows they're still alive.
   *
   * API: heartbeatAgent(project, userId, role, currentTask?)
   */
  it("should update agent heartbeat", async () => {
    await expect(
      storage.heartbeatAgent(TEST_PROJECT, TEST_USER_ID, "dev", "Still coding auth")
    ).resolves.not.toThrow();

    // Verify the task was updated
    const team = await storage.listTeam(TEST_PROJECT, TEST_USER_ID);
    const dev = team.find((a: any) => a.role === "dev");
    expect(dev.current_task).toBe("Still coding auth");
  });

  /**
   * Tests deregistering an agent — removing it from the team.
   * This happens when an agent completes its work or is shut down.
   *
   * API: deregisterAgent(project, userId, role)
   */
  it("should deregister an agent", async () => {
    await storage.deregisterAgent(TEST_PROJECT, TEST_USER_ID, "pm");

    const team = await storage.listTeam(TEST_PROJECT, TEST_USER_ID);
    const roles = team.map((a: any) => a.role);
    expect(roles).not.toContain("pm"); // PM should be gone
    expect(roles).toContain("dev");    // Others remain
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. SYSTEM SETTINGS — Dashboard Config
// ═══════════════════════════════════════════════════════════════════

describe("System Settings (Dashboard)", () => {
  /**
   * Tests saving a single setting.
   * Settings use INSERT ON CONFLICT UPDATE (upsert) so the first
   * write is an INSERT and subsequent writes are UPDATEs.
   */
  it("should save and retrieve a single setting", async () => {
    await storage.setSetting("auto_capture", "true");

    const value = await storage.getSetting("auto_capture");
    expect(value).toBe("true");
  });

  /**
   * Tests upserting a setting — changing its value.
   * The key stays the same, value is updated.
   */
  it("should upsert an existing setting", async () => {
    // First save
    await storage.setSetting("dashboard_theme", "dark");
    expect(await storage.getSetting("dashboard_theme")).toBe("dark");

    // Update
    await storage.setSetting("dashboard_theme", "midnight");
    expect(await storage.getSetting("dashboard_theme")).toBe("midnight");
  });

  /**
   * Tests getting a setting that doesn't exist.
   * Should return null, not throw an error.
   */
  it("should return null for non-existent settings", async () => {
    const value = await storage.getSetting("nonexistent_key");
    expect(value).toBeNull();
  });

  /**
   * Tests saving multiple settings and retrieving them all at once.
   * The getAllSettings() method is used by the dashboard API to
   * populate the Settings modal with current values.
   */
  it("should save and retrieve all settings", async () => {
    // Set the remaining settings (auto_capture and dashboard_theme already set above)
    await storage.setSetting("default_context_depth", "standard");
    await storage.setSetting("hivemind_enabled", "false");

    // Retrieve all at once
    const allSettings = await storage.getAllSettings();

    // Verify each expected setting is present
    expect(allSettings.auto_capture).toBe("true");
    expect(allSettings.dashboard_theme).toBe("midnight"); // from upsert test above
    expect(allSettings.default_context_depth).toBe("standard");
    expect(allSettings.hivemind_enabled).toBe("false");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. DARK FACTORY PIPELINES & VERIFICATION HARNESS (v7.3 / v7.4)
// ═══════════════════════════════════════════════════════════════════

describe("Dark Factory Pipelines & Verification Harness", () => {
  // Use unique IDs per test run to prevent shared-state contamination across runs.
  // SQLite's terminal-state guard throws "already COMPLETED" when a subsequent
  // run reuses a pipeline ID that was transitioned to a terminal state in a
  // prior test. Unique suffixes ensure each run starts from a clean slate.
  const RUN_SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const PI_ID = `pipe-${RUN_SUFFIX}`;
  const VH_HASH = `rubric-hash-${RUN_SUFFIX}`;
  const VR_ID = `run-${RUN_SUFFIX}`;

  /**
   * Tests saving and retrieving a pipeline state, including new v7.4 fields
   * like eval_revisions, contract_payload, and notes.
   */
  it("should save and retrieve a PipelineState with adversarial eval info", async () => {
    const pipeline = {
      id: PI_ID,
      project: TEST_PROJECT,
      user_id: TEST_USER_ID,
      status: "RUNNING",
      current_step: "EVALUATE",
      iteration: 1,
      eval_revisions: 2,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      spec: JSON.stringify({ name: "Fix all tests" }),
      contract_payload: {
        criteria: [{ id: "c1", description: "Must pass type check" }]
      },
      notes: "Adversarial evaluator rejected first revision",
    };

    // Save pipeline
    await expect(storage.savePipeline(pipeline)).resolves.not.toThrow();

    // Get pipeline
    const fetched = await storage.getPipeline(PI_ID, TEST_USER_ID);
    expect(fetched).not.toBeNull();
    expect(fetched.id).toBe(PI_ID);
    expect(fetched.eval_revisions).toBe(2);
    expect(fetched.notes).toBe("Adversarial evaluator rejected first revision");
    expect(fetched.contract_payload).toBeDefined();
    expect(fetched.contract_payload.criteria[0].id).toBe("c1");
  });

  /**
   * Tests listPipelines filtering by status and project.
   */
  it("should list pipelines by project and status", async () => {
    const pipelines = await storage.listPipelines(TEST_PROJECT, "RUNNING", TEST_USER_ID);
    // The shared DB may have accumulated RUNNING records from prior runs.
    // Just verify OUR pipeline appears in the RUNNING list.
    expect(pipelines.length).toBeGreaterThanOrEqual(1);
    expect(pipelines.some((p: any) => p.id === PI_ID)).toBe(true);

    const completedPipelines = await storage.listPipelines(TEST_PROJECT, "COMPLETED", TEST_USER_ID);
    // OUR pipeline should not be in COMPLETED yet (it's still RUNNING).
    expect(completedPipelines.some((p: any) => p.id === PI_ID)).toBe(false);
  });

  /**
   * Tests safety guards: should throw if pipeline is already terminal.
   */
  it("should enforce safe pipeline state transitions", async () => {
    // Transition to COMPLETED
    const completedState = {
      id: PI_ID,
      project: TEST_PROJECT,
      user_id: TEST_USER_ID,
      status: "COMPLETED",
      current_step: "FINAL_EVAL",
      iteration: 2,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      spec: "{}",
    };
    await expect(storage.savePipeline(completedState)).resolves.not.toThrow();

    // Trying to update it again should throw terminal protection error
    const failedUpdate = { ...completedState, status: "RUNNING" };
    await expect(storage.savePipeline(failedUpdate)).rejects.toThrow(/already COMPLETED/);
  });

  /**
   * Tests Verification Harness storage.
   */
  it("should save and get VerificationHarness", async () => {
    const harness = {
      rubric_hash: VH_HASH,
      project: TEST_PROJECT,
      conversation_id: "conv-123",
      created_at: new Date().toISOString(),
      min_pass_rate: 0.9,
      tests: [{ id: "t1", command: "npm test" }]
    };

    await expect(storage.saveVerificationHarness(harness, TEST_USER_ID)).resolves.not.toThrow();

    const fetched = await storage.getVerificationHarness(VH_HASH, TEST_USER_ID);
    expect(fetched).not.toBeNull();
    expect(fetched.rubric_hash).toBe(VH_HASH);
    expect(fetched.tests.length).toBe(1);
  });

  /**
   * Tests Verification Run storage.
   */
  it("should save and retrieve ValidationResult run details", async () => {
    const vr = {
      id: VR_ID,
      rubric_hash: VH_HASH,
      project: TEST_PROJECT,
      conversation_id: "conv-123",
      run_at: new Date().toISOString(),
      passed: true,
      pass_rate: 1.0,
      critical_failures: 0,
      coverage_score: 85,
      result_json: "{}",
      gate_action: "PROCEED",
      gate_override: false,
    };

    await expect(storage.saveVerificationRun(vr as any, TEST_USER_ID)).resolves.not.toThrow();

    const fetched = await storage.getVerificationRun(VR_ID, TEST_USER_ID);
    expect(fetched).not.toBeNull();
    expect(fetched.id).toBe(VR_ID);
    expect(fetched.passed).toBe(true);
    expect(fetched.gate_override).toBe(false);

    const list = await storage.listVerificationRuns(TEST_PROJECT, TEST_USER_ID);
    // The list may contain runs from prior test invocations (shared in-memory DB).
    // Assert our run appears in the list rather than requiring exactly 1 row.
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.some((r: any) => r.id === VR_ID)).toBe(true);
  });
});
