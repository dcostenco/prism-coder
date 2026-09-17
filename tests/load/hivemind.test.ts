/**
 * Load Tests — Concurrent Agent Operations
 *
 * ═══════════════════════════════════════════════════════════════════
 * SCOPE:
 *   Stress tests for the Hivemind storage layer under concurrent load.
 *   Simulates scenarios where multiple agents hit the same database
 *   simultaneously — the most realistic failure mode in production.
 *
 * WHAT WE TEST:
 *   1. Concurrent ledger writes — N agents writing entries in parallel
 *   2. Concurrent handoff upserts — N roles saving state simultaneously
 *   3. Agent registry storm — many registrations/heartbeats at once
 *   4. Mixed workload — reads + writes interleaved
 *   5. Settings write storm — rapid key-value updates
 *
 * WHY LOAD TESTS:
 *   SQLite uses file-level locking. In WAL mode (which Prism uses),
 *   concurrent reads are fine but concurrent writes can contend.
 *   These tests verify that:
 *   - Writes don't lose data (each entry is persisted)
 *   - Upserts don't create duplicates (UNIQUE constraints hold)
 *   - The database doesn't deadlock or timeout under pressure
 *   - WAL mode handles concurrent access gracefully
 *
 * API PATTERNS REFERENCE:
 *   - saveLedger(entry: LedgerEntry)              — single object
 *   - saveHandoff(handoff: HandoffEntry, ver?)     — object + version
 *   - registerAgent(entry: AgentRegistryEntry)     — single object
 *   - heartbeatAgent(project, userId, role, task?) — positional
 *   - loadContext(project, level, userId, role?)   — positional
 *   - listTeam(project, userId, staleMinutes?)     — positional
 *
 * TIMEOUT:
 *   Load tests use a 30-second timeout (vs 10s default) since
 *   they issue hundreds of sequential and parallel operations.
 *
 * RUNNING LOAD TESTS ONLY:
 *   npm run test:load
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestDb,
  TEST_PROJECT,
  TEST_USER_ID,
} from "../helpers/fixtures.js";

// ─── Shared test state ───────────────────────────────────────────
let storage: any;
let cleanup: () => void;

/**
 * CONCURRENCY_LEVEL controls how many parallel operations we fire.
 * Production Hivemind: typically 4-8 agents (dev, qa, pm, lead, etc.)
 * We test at 2-3x production levels to ensure headroom.
 */
const CONCURRENCY_LEVEL = 20;

/**
 * BURST_SIZE controls how many rapid-fire sequential operations
 * we perform in burst tests. Simulates a long session with
 * many ledger saves.
 */
const BURST_SIZE = 50;

beforeAll(async () => {
  const testDb = await createTestDb("load-test");
  storage = testDb.storage;
  cleanup = testDb.cleanup;
}, 60_000); // Extended timeout for DB creation

afterAll(() => {
  cleanup();
});

// ═══════════════════════════════════════════════════════════════════
// 1. CONCURRENT LEDGER WRITES
//    Simulates N agents all saving session logs at the same time.
//    Each write should succeed; no data should be lost.
// ═══════════════════════════════════════════════════════════════════

describe("Concurrent Ledger Writes", { timeout: 30_000 }, () => {
  /**
   * Fires N parallel saveLedger() calls.
   * Each one has a unique conversation_id and summary.
   * After all complete, we verify all N entries are in the database.
   *
   * API: saveLedger(entry: LedgerEntry) — single object argument
   */
  it(`should handle ${CONCURRENCY_LEVEL} parallel writes without data loss`, async () => {
    const writePromises = Array.from({ length: CONCURRENCY_LEVEL }, (_, i) =>
      storage.saveLedger({
        project: TEST_PROJECT,
        conversation_id: `load-test-conv-${i}`,
        user_id: TEST_USER_ID,
        summary: `Load test entry #${i} — testing concurrent writes`,
        todos: [`Todo from agent ${i}`],
        files_changed: [`file-${i}.ts`],
        decisions: [`Decision from agent ${i}`],
        role: i % 2 === 0 ? "dev" : "qa", // alternate roles
      })
    );

    // All writes should complete without errors
    const results = await Promise.allSettled(writePromises);
    const failures = results.filter(r => r.status === "rejected");

    if (failures.length > 0) {
      console.error("Failed writes:", failures.map(f =>
        (f as PromiseRejectedResult).reason?.message
      ));
    }

    expect(failures.length).toBe(0);

    // Verify all entries were persisted
    const entries = await storage.getLedgerEntries({
      project: `eq.${TEST_PROJECT}`,
      limit: String(CONCURRENCY_LEVEL + 10),
    });
    expect(entries.length).toBeGreaterThanOrEqual(CONCURRENCY_LEVEL);
  });

  /**
   * Sequential burst test — saves BURST_SIZE entries one after another.
   * Tests that rapid sequential writes don't cause SQLite locking issues.
   */
  it(`should handle ${BURST_SIZE} sequential writes without errors`, async () => {
    const startTime = Date.now();

    for (let i = 0; i < BURST_SIZE; i++) {
      await storage.saveLedger({
        project: TEST_PROJECT,
        conversation_id: `burst-conv-${i}`,
        user_id: TEST_USER_ID,
        summary: `Burst entry #${i}`,
        todos: [],
        files_changed: [],
        decisions: [],
        role: "dev",
      });
    }

    const elapsed = Date.now() - startTime;

    // Assert what the test is NAMED for: every write landed and is readable.
    // This previously asserted ONLY `elapsed < 10_000`, which is the wrong
    // thing twice over. It failed CI on 2026-09-16 because a shared Windows
    // runner was slow — 50 writes take 8ms here, so the budget had 1,250x
    // headroom and the failure carried no information about the code. And it
    // would have PASSED had all fifty writes silently failed, because nothing
    // checked that any of them persisted. A hang is already covered by the
    // 30s suite timeout, so the wall-clock assertion guarded nothing that
    // remained unguarded.
    const entries = await storage.getLedgerEntries({
      project: `eq.${TEST_PROJECT}`,
      limit: String(BURST_SIZE + CONCURRENCY_LEVEL + 10),
    });
    const burst = (entries as Array<{ conversation_id?: string }>)
      .filter((e) => e.conversation_id?.startsWith("burst-conv-"));
    expect(burst.length).toBe(BURST_SIZE);

    // Still logged for benchmarking; a number worth watching is not the same
    // as a number worth failing a build over.
    console.error(
      `[Load] ${BURST_SIZE} sequential writes: ${elapsed}ms ` +
      `(${(elapsed / BURST_SIZE).toFixed(1)}ms per write)`
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. CONCURRENT HANDOFF UPSERTS
//    Simulates multiple agents saving their role-scoped handoff state
//    at the same time. Tests the UNIQUE(project, user_id, role)
//    constraint under pressure.
// ═══════════════════════════════════════════════════════════════════

describe("Concurrent Handoff Upserts", { timeout: 30_000 }, () => {
  /**
   * Different roles saving handoffs simultaneously.
   * Each role has its own row in session_handoffs thanks to
   * UNIQUE(project, user_id, role), so there should be no conflicts.
   *
   * API: saveHandoff(handoff: HandoffEntry, expectedVersion?)
   */
  it("should handle parallel handoff saves from different roles", async () => {
    const roles = ["dev", "qa", "pm", "lead", "security", "ux", "cmo", "manager"];

    const handoffPromises = roles.map(role =>
      storage.saveHandoff({
        project: TEST_PROJECT,
        user_id: TEST_USER_ID,
        last_summary: `Handoff from ${role} agent`,
        pending_todo: [`${role} needs to follow up`],
        active_branch: "main",
        key_context: `Context from ${role}`,
        role, // v3.0: role-scoped handoff
      })
    );

    const results = await Promise.allSettled(handoffPromises);
    const failures = results.filter(r => r.status === "rejected");
    expect(failures.length).toBe(0);

    // Verify each role can load its own context
    // NOTE: Must use 'standard' level — 'quick' omits last_summary
    for (const role of roles) {
      const ctx = await storage.loadContext(
        TEST_PROJECT, "standard", TEST_USER_ID, role
      );
      expect(ctx).not.toBeNull();
      expect(ctx.last_summary).toBe(`Handoff from ${role} agent`);
    }

    // ── Invariant: no cross-role payload contamination
    // A WHERE clause bug that ignores the role column would cause role[0]
    // to return role[1]'s summary. This catches that silently.
    for (let i = 0; i < roles.length; i++) {
      const role = roles[i];
      const ctx = await storage.loadContext(TEST_PROJECT, "standard", TEST_USER_ID, role);
      const otherRole = roles[(i + 1) % roles.length];
      expect(ctx.last_summary).not.toBe(`Handoff from ${otherRole} agent`);
    }
  });

  /**
   * Same role upserting rapidly — simulates an agent that saves
   * handoff state many times during a long session.
   * Each upsert should overwrite the previous value.
   */
  it("should handle rapid upserts for same role without duplicates", async () => {
    const UPSERT_COUNT = 20;

    for (let i = 0; i < UPSERT_COUNT; i++) {
      await storage.saveHandoff({
        project: TEST_PROJECT,
        user_id: TEST_USER_ID,
        last_summary: `Dev iteration #${i}`,
        pending_todo: [`Todo iteration ${i}`],
        active_branch: "feature-branch",
        key_context: `Iteration ${i} context`,
        role: "dev",
      });
    }

    // Load context — should show the LAST write only
    const ctx = await storage.loadContext(
      TEST_PROJECT, "standard", TEST_USER_ID, "dev"
    );
    expect(ctx.last_summary).toBe(`Dev iteration #${UPSERT_COUNT - 1}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. AGENT REGISTRY STORM
//    Rapid registrations, heartbeats, and deregistrations.
//    Tests UNIQUE(project, user_id, role) under pressure.
// ═══════════════════════════════════════════════════════════════════

describe("Agent Registry Storm", { timeout: 30_000 }, () => {
  /**
   * Registers many agents in parallel.
   * Each has a unique role to avoid UNIQUE constraint violations.
   *
   * API: registerAgent(entry: AgentRegistryEntry)
   */
  it("should handle parallel registrations", async () => {
    const roles = Array.from({ length: CONCURRENCY_LEVEL }, (_, i) => `agent-${i}`);

    const registerPromises = roles.map(role =>
      storage.registerAgent({
        project: TEST_PROJECT,
        user_id: TEST_USER_ID,
        role,
        agent_name: `Agent ${role}`,
        current_task: `Task for ${role}`,
      })
    );

    const results = await Promise.allSettled(registerPromises);
    const failures = results.filter(r => r.status === "rejected");
    expect(failures.length).toBe(0);

    // All agents should be visible
    const team = await storage.listTeam(TEST_PROJECT, TEST_USER_ID);
    expect(team.length).toBeGreaterThanOrEqual(CONCURRENCY_LEVEL);

    // ── Invariant: exactly ONE row per role (no duplicates from upsert bugs)
    // If the UNIQUE(project, user_id, role) constraint silently allowed duplicate
    // rows, registeredRoles would be longer than uniqueRoles.
    const registeredRoles: string[] = team
      .filter((a: any) => a.role.startsWith("agent-"))
      .map((a: any) => a.role);
    const uniqueRoles = new Set(registeredRoles);
    expect(uniqueRoles.size).toBe(registeredRoles.length); // no duplicates

    // ── Invariant: each agent has the correct task (no cross-agent payload writes)
    for (const role of roles) {
      const agent = team.find((a: any) => a.role === role);
      expect(agent).toBeDefined();
      expect(agent.current_task).toBe(`Task for ${role}`);
    }
  });

  /**
   * Rapid heartbeats from the same agent.
   * Under rapid fire, each update should succeed without locking.
   *
   * API: heartbeatAgent(project, userId, role, currentTask?)
   */
  it("should handle rapid heartbeats without errors", async () => {
    const HEARTBEAT_COUNT = 30;

    for (let i = 0; i < HEARTBEAT_COUNT; i++) {
      await storage.heartbeatAgent(
        TEST_PROJECT,
        TEST_USER_ID,
        "agent-0",
        `Heartbeat task update #${i}`
      );
    }

    // Verify the last heartbeat task stuck
    const team = await storage.listTeam(TEST_PROJECT, TEST_USER_ID);
    const agent0 = team.find((a: any) => a.role === "agent-0");
    expect(agent0.current_task).toBe(`Heartbeat task update #${HEARTBEAT_COUNT - 1}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. MIXED WORKLOAD
//    Interleaved reads and writes across different features.
//    This is the most realistic production scenario.
// ═══════════════════════════════════════════════════════════════════

describe("Mixed Workload", { timeout: 30_000 }, () => {
  /**
   * Simulates a realistic production cycle:
   *   - Agent registers itself
   *   - Agent saves a ledger entry
   *   - Agent saves a handoff
   *   - Agent heartbeats
   *   - Agent loads context
   *   - Another agent does the same in parallel
   *
   * All operations should complete without data corruption.
   */
  it("should handle interleaved reads and writes", async () => {
    const agentWorkflow = async (role: string, index: number) => {
      const project = `mixed-project-${index}`;

      // 1. Register — announce presence to the team
      await storage.registerAgent({
        project,
        user_id: TEST_USER_ID,
        role,
        agent_name: `${role} Agent`,
        current_task: "Starting work",
      });

      // 2. Save ledger — record work done
      await storage.saveLedger({
        project,
        conversation_id: `mixed-conv-${index}`,
        user_id: TEST_USER_ID,
        summary: `${role} completed task ${index}`,
        todos: ["Follow-up needed"],
        files_changed: ["file.ts"],
        decisions: ["Decision made"],
        role,
      });

      // 3. Save handoff — persist session state for next boot
      await storage.saveHandoff({
        project,
        user_id: TEST_USER_ID,
        last_summary: `${role} finished session ${index}`,
        pending_todo: ["Next step"],
        active_branch: "main",
        key_context: "Done for now",
        role,
      });

      // 4. Heartbeat — pulse to keep alive
      await storage.heartbeatAgent(project, TEST_USER_ID, role, "Wrapping up");

      // 5. Load context — verify round-trip
      const ctx = await storage.loadContext(project, "standard", TEST_USER_ID, role);
      return ctx;
    };

    // Run 10 agent workflows in parallel
    const workflows = Array.from({ length: 10 }, (_, i) =>
      agentWorkflow(i % 2 === 0 ? "dev" : "qa", i)
    );

    const results = await Promise.allSettled(workflows);
    const failures = results.filter(r => r.status === "rejected");

    if (failures.length > 0) {
      console.error("Mixed workload failures:", failures.map(f =>
        (f as PromiseRejectedResult).reason?.message
      ));
    }

    expect(failures.length).toBe(0);

    // Verify at least one context loaded correctly
    const succeeded = results.filter(r => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    expect(succeeded.length).toBeGreaterThan(0);
    expect(succeeded[0].value.last_summary).toBeDefined();

    // ── Invariant: strict cross-project isolation
    // Each workflow writes exactly 1 ledger entry to its own project
    // (mixed-project-0, mixed-project-1, etc.). If data bleeds across
    // projects, these counts or summaries will be wrong.
    const projectZeroEntries = await storage.getLedgerEntries({
      project: `eq.mixed-project-0`,
      limit: "10",
    });
    expect(projectZeroEntries.length).toBe(1);
    expect(projectZeroEntries[0].summary).toBe("dev completed task 0");

    const projectOneEntries = await storage.getLedgerEntries({
      project: `eq.mixed-project-1`,
      limit: "10",
    });
    expect(projectOneEntries.length).toBe(1);
    expect(projectOneEntries[0].summary).toBe("qa completed task 1");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. SETTINGS WRITE STORM
//    Rapid key-value updates simulating a user frantically toggling
//    settings in the dashboard UI.
// ═══════════════════════════════════════════════════════════════════

describe("Settings Write Storm", { timeout: 30_000 }, () => {
  /**
   * Rapidly toggles a setting on/off many times.
   * The final value should be deterministic.
   */
  it("should handle rapid setting toggles", async () => {
    const TOGGLE_COUNT = 50;

    for (let i = 0; i < TOGGLE_COUNT; i++) {
      await storage.setSetting("auto_capture", i % 2 === 0 ? "true" : "false");
    }

    // 49 % 2 = 1 → last write was "false"
    const value = await storage.getSetting("auto_capture");
    expect(value).toBe("false");
  });

  /**
   * Saves many different keys in parallel.
   * Tests that different keys don't interfere with each other.
   */
  it("should handle parallel writes to different keys", async () => {
    const KEY_COUNT = 20;

    const promises = Array.from({ length: KEY_COUNT }, (_, i) =>
      storage.setSetting(`storm_key_${i}`, `value_${i}`)
    );

    const results = await Promise.allSettled(promises);
    const failures = results.filter(r => r.status === "rejected");
    expect(failures.length).toBe(0);

    // Verify all keys are retrievable
    const allSettings = await storage.getAllSettings();
    for (let i = 0; i < KEY_COUNT; i++) {
      expect(allSettings[`storm_key_${i}`]).toBe(`value_${i}`);
    }
  });
});
