/**
 * Test Helpers & Fixtures — Prism MCP Test Framework
 *
 * ═══════════════════════════════════════════════════════════════════
 * PURPOSE:
 *   Reusable utilities for creating test databases, mock storage
 *   instances, and common fixtures used across all test suites.
 *
 * DESIGN PHILOSOPHY:
 *   - Each test gets its own ephemeral SQLite database (no sharing)
 *   - We override the data directory via env var before instantiation
 *   - Helper functions handle setup/teardown so tests stay clean
 *   - Fixtures provide realistic sample data for ledger, handoff,
 *     and agent registry entries
 *   - All helpers are extensively commented for contributor onboarding
 *
 * IMPORTANT: SqliteStorage reads its path from ~/.prism-mcp/data.db
 *   at initialization time. For test isolation, we override the
 *   HOME directory to a temp location so each test suite gets a
 *   completely separate database file.
 * ═══════════════════════════════════════════════════════════════════
 */

import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";

// ─────────────────────────────────────────────────────────────────
// DATABASE FACTORY
// ─────────────────────────────────────────────────────────────────

/**
 * Creates an ephemeral SQLite database for a single test suite.
 *
 * HOW IT WORKS:
 *   SqliteStorage.initialize() always creates its DB at:
 *     ~/.prism-mcp/data.db
 *
 *   To isolate tests, we temporarily override the HOME env var
 *   to a unique temp directory. Each test gets its own "home"
 *   with its own `.prism-mcp/data.db` inside.
 *
 * WHY THIS APPROACH:
 *   - No modifications to production code needed
 *   - Each test suite is fully isolated
 *   - Cleanup is trivial — just delete the temp directory
 *   - Works on macOS/Linux (HOME) and Windows (USERPROFILE)
 *
 * USAGE:
 *   const { storage, cleanup } = await createTestDb("my-test");
 *   // ... run tests against storage ...
 *   cleanup(); // removes the entire temp home directory
 *
 * @param testName - Human-readable name used in the temp directory name
 * @returns Object with `storage` (SqliteStorage instance) and `cleanup` function
 */
export async function createTestDb(testName: string) {
  // Generate a unique DB path per test suite.
  // Timestamp + random suffix prevents collisions even under parallel execution.
  const uniqueDir = join(
    tmpdir(),
    `prism-test-${testName}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(uniqueDir, { recursive: true });
  const dbPath = join(uniqueDir, "data.db");

  // ── True path injection — no env vars, no global state ─────────────────
  //
  // We pass dbPath directly to storage.initialize(dbPath). This is the only
  // correct isolation mechanism:
  //
  //   ❌ process.env.HOME mutation — process-global, races across parallel suites
  //   ❌ PRISM_DB_PATH env var    — still process-global, same race on async boundary
  //   ✅ initialize(dbPath)       — argument-scoped, zero observable global state
  //
  // SqliteStorage.initialize() opens a libsql connection to the injected path
  // and holds it for the lifetime of the instance. The path arg is not read
  // again after initialize() returns, so no race is possible at any point.
  const { SqliteStorage } = await import("../../src/storage/sqlite.js");
  const storage = new SqliteStorage();
  await storage.initialize(true, dbPath);

  return {
    storage,
    dbPath,
    /**
     * Cleanup: removes the temp directory.
     * Call in afterAll() or afterEach() to prevent disk leaks.
     */
    cleanup: () => {
      try { (storage as any).close?.(); } catch { /* non-fatal */ }
      try {
        if (existsSync(uniqueDir)) {
          rmSync(uniqueDir, { recursive: true, force: true });
        }
      } catch {
        // OS will clean tmpdir eventually — non-critical
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// FIXTURES: Realistic test data
// ─────────────────────────────────────────────────────────────────

/**
 * Standard test project name used across all test suites.
 * Using a consistent name makes it easy to grep test output.
 */
export const TEST_PROJECT = "prism-test-project";

/**
 * Standard test user ID matching Prism's default.
 * In production, this comes from PRISM_USER_ID env var.
 */
export const TEST_USER_ID = "default";

/**
 * Sample ledger entry representing a typical developer session.
 * Used in session memory tests to verify save/load/search flows.
 *
 * NOTE: The `role` field is intentionally omitted here to test
 * backward compatibility — it should default to 'global' in storage.
 */
export const SAMPLE_LEDGER_ENTRY = {
  project: TEST_PROJECT,
  conversation_id: "test-conv-001",
  summary: "Implemented user authentication with JWT tokens and bcrypt password hashing",
  todos: ["Add rate limiting to login endpoint", "Write integration tests"],
  files_changed: ["src/auth/login.ts", "src/middleware/auth.ts"],
  decisions: ["Use bcrypt over argon2 for password hashing due to Node.js compatibility"],
};

/**
 * Sample ledger entry WITH a role specified.
 * Used to test v3.0 role-scoped memory isolation.
 */
export const SAMPLE_ROLE_LEDGER_ENTRY = {
  project: TEST_PROJECT,
  conversation_id: "test-conv-002",
  summary: "QA agent found 3 edge cases in authentication flow during regression testing",
  todos: ["Fix null check on expired tokens"],
  files_changed: ["tests/auth.test.ts"],
  decisions: ["Block deploy until all auth tests pass"],
  role: "qa",
};

/**
 * Sample handoff state for testing session_save_handoff / load_context.
 * Represents the "live context" a developer agent would save at session end.
 */
export const SAMPLE_HANDOFF = {
  project: TEST_PROJECT,
  last_summary: "Refactored auth module to use middleware pattern",
  open_todos: ["Deploy to staging", "Run load tests"],
  active_branch: "feature/auth-refactor",
  key_context: "Auth middleware now validates JWT on every request",
};

/**
 * Sample handoff WITH a role — tests role-scoped handoff isolation.
 */
export const SAMPLE_ROLE_HANDOFF = {
  project: TEST_PROJECT,
  last_summary: "QA completed regression suite — 47/50 tests passing",
  open_todos: ["Fix 3 failing tests in edge case suite"],
  active_branch: "feature/auth-refactor",
  key_context: "3 tests fail on token expiry boundary condition",
  role: "qa",
};

/**
 * Sample agent registry entry for Hivemind tests.
 * Represents a developer agent registering itself with the team.
 */
export const SAMPLE_AGENT_REGISTRATION = {
  project: TEST_PROJECT,
  role: "dev",
  agent_name: "Claude Dev Agent",
  current_task: "Implementing auth middleware",
};

/**
 * Multiple agent registrations for team visibility tests.
 * Simulates a full Hivemind team working on a project.
 */
export const SAMPLE_TEAM: Array<{
  project: string;
  role: string;
  agent_name: string;
  current_task: string;
}> = [
  {
    project: TEST_PROJECT,
    role: "dev",
    agent_name: "Dev Agent",
    current_task: "Implementing auth middleware",
  },
  {
    project: TEST_PROJECT,
    role: "qa",
    agent_name: "QA Agent",
    current_task: "Running regression tests",
  },
  {
    project: TEST_PROJECT,
    role: "pm",
    agent_name: "PM Agent",
    current_task: "Writing sprint retrospective",
  },
  {
    project: TEST_PROJECT,
    role: "security",
    agent_name: "Security Agent",
    current_task: "Auditing dependency vulnerabilities",
  },
];

/**
 * Sample system settings for dashboard config tests.
 */
export const SAMPLE_SETTINGS: Record<string, string> = {
  auto_capture: "true",
  dashboard_theme: "dark",
  default_context_depth: "standard",
  hivemind_enabled: "false",
};
