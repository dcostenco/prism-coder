/**
 * supabase-verification.test.ts
 *
 * Mocked API-level assertions for SupabaseStorage verification run persistence.
 *
 * Strategy: vi.mock the supabaseApi transport helpers so no real HTTP calls
 * are made. Tests drive both saveVerificationRun + getVerificationRun/
 * listVerificationRuns request/response cycles, asserting:
 *
 *   1. The correct payload is *sent* to Supabase (serialization)
 *   2. The correct TypeScript object is *returned* to callers (deserialization)
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ Cross-backend parity table — three canonical states                         │
 * │                                                                             │
 * │ State            │ SQLite (write)    │ SQLite (read)     │ Supabase (write) │ Supabase (read)  │
 * │──────────────────│───────────────────│───────────────────│──────────────────│──────────────────│
 * │ bypass           │ gate_override=1   │ gate_override=true│ gate_override=   │ gate_override=   │
 * │                  │ override_reason=  │ override_reason=  │ true (boolean)   │ true (Boolean()) │
 * │                  │ "<string>"        │ "<string>"        │ override_reason= │ override_reason= │
 * │                  │                   │                   │ "<string>"       │ "<string>"       │
 * │──────────────────│───────────────────│───────────────────│──────────────────│──────────────────│
 * │ non-bypass       │ gate_override=0   │ gate_override=    │ gate_override=   │ gate_override=   │
 * │                  │ override_reason=  │ false             │ false (?? false) │ false (Boolean())│
 * │                  │ null              │ override_reason=  │ override_reason= │ override_reason= │
 * │                  │                   │ undefined         │ null (|| null)   │ undefined        │
 * │                  │                   │ (|| undefined)    │                  │ (|| undefined)   │
 * │──────────────────│───────────────────│───────────────────│──────────────────│──────────────────│
 * │ empty-string "" │ gate_override=1   │ gate_override=true│ gate_override=   │ gate_override=   │
 * │ (coercion edge) │ override_reason=  │ override_reason=  │ true (boolean)   │ true (Boolean()) │
 * │                  │ null (|| null)    │ undefined         │ override_reason= │ override_reason= │
 * │                  │                   │ (|| undefined)    │ null (|| null)   │ undefined        │
 * │                  │                   │                   │                  │ (|| undefined)   │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * SQLite round-trip coverage: tests/verification/harness.test.ts
 *   - bypass path:         harness.test.ts:164-212
 *   - non-bypass path:     harness.test.ts:219-261
 *   - empty-string edge:   harness.test.ts:392-419
 *   - tenant isolation:    harness.test.ts:341-391
 *
 * Supabase coverage (this file):
 *   - bypass serialization:       saveVerificationRun serialization describe
 *   - non-bypass serialization:   saveVerificationRun serialization describe
 *   - empty-string serialization: saveVerificationRun serialization describe
 *   - deserialization (get):      getVerificationRun deserialization describe
 *   - deserialization (list):     listVerificationRuns deserialization describe
 *   - query param isolation (get):  getVerificationRun deserialization describe
 *   - query param isolation (list): listVerificationRuns deserialization describe
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ValidationResult } from "../../src/verification/schema.js";

// ─── Mock transport helpers BEFORE importing SupabaseStorage ──────────────────
//
// We mock the module that SupabaseStorage imports from, not SupabaseStorage
// itself. This lets the real deserialization logic run while we control the
// raw response rows returned from Supabase.

vi.mock("../../src/utils/supabaseApi.js", () => ({
  supabasePost: vi.fn().mockResolvedValue([]),
  supabaseGet:  vi.fn().mockResolvedValue([]),
  supabaseRpc:  vi.fn().mockResolvedValue(null),
  supabasePatch: vi.fn().mockResolvedValue([]),
  supabaseDelete: vi.fn().mockResolvedValue([]),
}));

// Config must be mocked before SupabaseStorage is imported (it reads env vars)
vi.mock("../../src/config.js", () => ({
  PRISM_USER_ID: "test-user",
  SUPABASE_URL:  "https://mock.supabase.co",
  SUPABASE_KEY:  "mock-key",
}));

// configStorage referenced by SupabaseStorage constructor
vi.mock("../../src/storage/configStorage.js", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  getSettingSync: vi.fn(() => "false"),
  setSetting: vi.fn().mockResolvedValue(undefined),
  getAllSettings: vi.fn().mockResolvedValue({}),
}));


// supabaseMigrations — runAutoMigrations should be a no-op in tests
vi.mock("../../src/storage/supabaseMigrations.js", () => ({
  runAutoMigrations: vi.fn().mockResolvedValue(undefined),
}));

import { SupabaseStorage } from "../../src/storage/supabase.js";
import { supabasePost, supabaseGet } from "../../src/utils/supabaseApi.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal harness row that Supabase would return (native booleans). */
function makeRunRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "run-test",
    rubric_hash: "hash-abc",
    project: "proj",
    conversation_id: "conv-1",
    run_at: new Date().toISOString(),
    passed: false,
    pass_rate: 0.5,
    critical_failures: 1,
    coverage_score: 0.9,
    result_json: "{}",
    gate_action: "abort",
    // Supabase returns native JSON booleans (not 0/1)
    gate_override: false,
    override_reason: null,
    user_id: "test-user",
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SupabaseStorage — Verification Run Persistence", () => {
  let storage: SupabaseStorage;
  // Typed aliases — avoids per-assertion `as ReturnType<typeof vi.fn>` casts (issue #5)
  let postMock: ReturnType<typeof vi.fn>;
  let getMock:  ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    postMock = supabasePost as ReturnType<typeof vi.fn>;
    getMock  = supabaseGet  as ReturnType<typeof vi.fn>;
    storage  = new SupabaseStorage();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // saveVerificationRun — serialization contract
  // ══════════════════════════════════════════════════════════════════════════

  describe("saveVerificationRun serialization", () => {
    it("sends gate_override=true and override_reason string (bypass path)", async () => {
      const run: ValidationResult = {
        id: "run-bypass",
        rubric_hash: "hash-abc",
        project: "proj",
        conversation_id: "conv-1",
        run_at: new Date().toISOString(),
        passed: false,
        pass_rate: 0.4,
        critical_failures: 2,
        coverage_score: 0.8,
        result_json: "{}",
        gate_action: "abort",
        gate_override: true,
        override_reason: "Approved by team lead — known flaky assertion",
      };

      await storage.saveVerificationRun(run, "test-user");

      expect(postMock).toHaveBeenCalledOnce();
      const [table, payload] = postMock.mock.calls[0];

      expect(table).toBe("verification_runs");
      expect(payload.gate_override).toBe(true);
      expect(payload.override_reason).toBe("Approved by team lead — known flaky assertion");
      expect(payload.gate_action).toBe("abort");
      expect(payload.passed).toBe(false);
      // Supabase uses native booleans (not 0/1 integers)
      expect(typeof payload.gate_override).toBe("boolean");
    });

    it("sends gate_override=false and override_reason=null (non-bypass path)", async () => {
      const run: ValidationResult = {
        id: "run-nobypass",
        rubric_hash: "hash-abc",
        project: "proj",
        conversation_id: "conv-1",
        run_at: new Date().toISOString(),
        passed: false,
        pass_rate: 0.0,
        critical_failures: 3,
        coverage_score: 1.0,
        result_json: "{}",
        gate_action: "block",
        // gate_override intentionally omitted
      };

      await storage.saveVerificationRun(run, "test-user");

      expect(postMock).toHaveBeenCalledOnce();
      const [, payload] = postMock.mock.calls[0];

      // gate_override ?? false → false (matches the H2 fix in supabase.ts)
      expect(payload.gate_override).toBe(false);
      // override_reason || null → null  (no string pollution)
      expect(payload.override_reason).toBeNull();
    });

    it("sends override_reason=null for empty-string input (documented coercion)", async () => {
      // Edge case: empty string is falsy; storage coerces it to null on write.
      // CONTRACT: callers must provide a non-empty string or omit the field entirely.
      const run: ValidationResult = {
        id: "run-emptystr",
        rubric_hash: "hash-abc",
        project: "proj",
        conversation_id: "conv-1",
        run_at: new Date().toISOString(),
        passed: false,
        pass_rate: 0.0,
        critical_failures: 1,
        coverage_score: 1.0,
        result_json: "{}",
        gate_action: "block",
        gate_override: true,
        override_reason: "",   // empty string — treated as absent
      };

      await storage.saveVerificationRun(run, "test-user");

      expect(postMock).toHaveBeenCalledOnce();
      const [, payload] = postMock.mock.calls[0];
      // "" || null → null on write; `|| undefined` on read → undefined
      expect(payload.override_reason).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // getVerificationRun — deserialization contract
  // ══════════════════════════════════════════════════════════════════════════

  describe("getVerificationRun deserialization", () => {
    it("returns gate_override=true and override_reason string (bypass row)", async () => {
      const fakeRow = makeRunRow({
        gate_override: true,
        override_reason: "Approved by team lead",
      });
      getMock.mockResolvedValueOnce([fakeRow]);

      const result = await storage.getVerificationRun("run-bypass", "test-user");

      expect(result).not.toBeNull();
      expect(result?.gate_override).toBe(true);
      expect(result?.override_reason).toBe("Approved by team lead");
    });

    it("returns gate_override=false and override_reason=undefined (non-bypass row)", async () => {
      const fakeRow = makeRunRow({
        gate_override: false,
        override_reason: null,   // Supabase sends null for missing text columns
      });
      getMock.mockResolvedValueOnce([fakeRow]);

      const result = await storage.getVerificationRun("run-nobypass", "test-user");

      expect(result).not.toBeNull();
      expect(result?.gate_override).toBe(false);
      // The storage layer converts null → undefined (|| undefined)
      expect(result?.override_reason).toBeUndefined();
    });

    it("returns null when run does not exist", async () => {
      getMock.mockResolvedValueOnce([]);

      const result = await storage.getVerificationRun("nonexistent", "test-user");
      expect(result).toBeNull();
    });

    // Mirrors "passes correct query params" in listVerificationRuns below.
    // Asserts that getVerificationRun ALWAYS sends both id AND user_id filters.
    // A missing user_id would allow cross-tenant reads — this locks
    // the query contract so a future refactor can't silently drop it.
    it("passes correct query params (id + userId filters)", async () => {
      getMock.mockResolvedValueOnce([]);

      await storage.getVerificationRun("my-run-id", "my-user");

      expect(getMock).toHaveBeenCalledOnce();
      const [table, query] = getMock.mock.calls[0];
      expect(table).toBe("verification_runs");
      // Both filters must be present — either alone would allow cross-tenant reads
      expect(query.id).toBe("eq.my-run-id");
      expect(query.user_id).toBe("eq.my-user");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // listVerificationRuns — deserialization + field parity
  // ══════════════════════════════════════════════════════════════════════════

  describe("listVerificationRuns deserialization", () => {
    it("deserializes mixed bypass/non-bypass rows with correct field semantics", async () => {
      const bypassRow = makeRunRow({
        id: "run-1",
        gate_action: "abort",
        gate_override: true,
        override_reason: "Approved override",
        passed: false,
      });

      const noBypassRow = makeRunRow({
        id: "run-2",
        gate_action: "continue",
        gate_override: false,
        override_reason: null,
        passed: true,
        pass_rate: 1.0,
        critical_failures: 0,
      });

      // NOTE: the *ordering* of rows is determined by the query param `order: "run_at.desc"`
      // that the storage layer sends to Supabase — asserted separately in
      // "passes correct query params" below. This test validates deserialization
      // of a pre-ordered slice (not that the storage layer sorts).
      getMock.mockResolvedValueOnce([noBypassRow, bypassRow]);

      const list = await storage.listVerificationRuns("proj", "test-user");

      expect(list.length).toBe(2);

      // First row (newer, non-bypass)
      expect(list[0].id).toBe("run-2");
      expect(list[0].gate_override).toBe(false);
      expect(list[0].override_reason).toBeUndefined();
      expect(list[0].passed).toBe(true);

      // Second row (older, bypass)
      expect(list[1].id).toBe("run-1");
      expect(list[1].gate_override).toBe(true);
      expect(list[1].override_reason).toBe("Approved override");
      expect(list[1].passed).toBe(false);
    });

    it("returns empty array when no runs exist", async () => {
      getMock.mockResolvedValueOnce([]);

      const list = await storage.listVerificationRuns("proj", "test-user");
      expect(list).toEqual([]);
    });

    it("passes correct query params (project + userId filters)", async () => {
      getMock.mockResolvedValueOnce([]);

      await storage.listVerificationRuns("my-project", "my-user");

      expect(getMock).toHaveBeenCalledOnce();
      const [table, query] = getMock.mock.calls[0];
      expect(table).toBe("verification_runs");
      expect(query.project).toBe("eq.my-project");
      expect(query.user_id).toBe("eq.my-user");
      expect(query.order).toBe("run_at.desc");
    });
  });
});
