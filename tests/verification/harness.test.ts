import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  TestSuiteSchema,
  computeRubricHash,
  TestAssertion,
  VerificationHarness,
  ValidationResult
} from "../../src/verification/schema.js";
import { SqliteStorage } from "../../src/storage/sqlite.js";
import { resolve } from "path";
import * as fs from "fs";

describe("Verification Harness & Runs", () => {
  let dbPath: string;

  afterEach(() => {
    if (dbPath && fs.existsSync(dbPath)) {
      try { fs.unlinkSync(dbPath); } catch(e) {}
    }
  });

  describe("Schema Validation", () => {
    it("parses valid test suites", () => {
      const suite = {
        tests: [
          {
            id: "test1",
            layer: "data",
            description: "A test",
            severity: "gate",
            assertion: {
              type: "sqlite_query",
              target: "SELECT 1",
              expected: 1
            }
          }
        ]
      };
      
      const parsed = TestSuiteSchema.parse(suite);
      expect(parsed.tests.length).toBe(1);
      expect(parsed.tests[0].assertion.type).toBe("sqlite_query");
    });
  });

  describe("Rubric Hash Stability", () => {
    const test1: TestAssertion = {
      id: "a-test",
      layer: "data",
      description: "Test A",
      severity: "warn",
      assertion: { type: "file_exists", target: "a.txt", expected: true }
    };
    
    const test2: TestAssertion = {
      id: "b-test",
      layer: "pipeline",
      description: "Test B",
      severity: "abort",
      assertion: { type: "file_contains", target: "b.txt", expected: "hello" }
    };

    it("generates deterministic hashes regardless of order", () => {
      const hash1 = computeRubricHash([test1, test2]);
      const hash2 = computeRubricHash([test2, test1]);
      expect(hash1).toBe(hash2);
    });

    it("changes hash when content changes", () => {
      const hash1 = computeRubricHash([test1]);
      
      const modified: TestAssertion = {
        ...test1,
        description: "Modified Test A"
      };
      
      const hash2 = computeRubricHash([modified]);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("SQLite Round-trip Tests", () => {
    let storage: SqliteStorage;

    beforeEach(async () => {
      dbPath = resolve(__dirname, `test-harness-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      storage = new SqliteStorage();
      await storage.initialize(dbPath);
    });

    afterEach(async () => {
      if (storage) {
        await storage.close();
      }
    });

    it("saves and retrieves VerificationHarness", async () => {
      const harness: VerificationHarness = {
        project: "test-proj",
        conversation_id: "conv-1",
        created_at: new Date().toISOString(),
        rubric_hash: "fakehash123",
        min_pass_rate: 0.8,
        tests: [
          {
            id: "test1",
            layer: "data",
            description: "A test",
            severity: "gate",
            assertion: { type: "sqlite_query", target: "SELECT 1", expected: 1 }
          }
        ],
        metadata: { source: "vitest" }
      };

      await storage.saveVerificationHarness(harness, 'test-user');
      const retrieved = await storage.getVerificationHarness("fakehash123", 'test-user');
      
      expect(retrieved).not.toBeNull();
      expect(retrieved?.project).toBe(harness.project);
      expect(retrieved?.min_pass_rate).toBe(harness.min_pass_rate);
      expect(retrieved?.tests.length).toBe(1);
      expect(retrieved?.tests[0].id).toBe("test1");
      expect(retrieved?.metadata?.source).toBe("vitest");
    });

    it("saves and retrieves ValidationResult (baseline continue, no override)", async () => {
      const harness: VerificationHarness = {
        project: "test-proj",
        conversation_id: "conv-1",
        created_at: new Date().toISOString(),
        rubric_hash: "hash456",
        min_pass_rate: 0.8,
        tests: []
      };
      await storage.saveVerificationHarness(harness, 'test-user');

      const run: ValidationResult = {
        id: "run-1",
        rubric_hash: "hash456",
        project: "test-proj",
        conversation_id: "conv-1",
        run_at: new Date().toISOString(),
        passed: true,
        pass_rate: 1.0,
        critical_failures: 0,
        coverage_score: 1.0,
        result_json: "{}",
        gate_action: "continue"
      };

      await storage.saveVerificationRun(run, 'test-user');

      const retrieved = await storage.getVerificationRun("run-1", 'test-user');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(run.id);
      expect(retrieved?.rubric_hash).toBe(run.rubric_hash);
      expect(retrieved?.passed).toBe(true);
      expect(retrieved?.coverage_score).toBe(1.0);
      expect(retrieved?.gate_action).toBe("continue");

      const list = await storage.listVerificationRuns("test-proj", 'test-user');
      expect(list.length).toBe(1);
      expect(list[0].id).toBe("run-1");
    });

    // ── Bypass path ─────────────────────────────────────────────
    // Asserts that gate_override=true and a non-empty override_reason
    // survive a full SQLite round-trip via both getVerificationRun
    // and listVerificationRuns.

    it("persists gate_override=true and override_reason (bypass path)", async () => {
      const harness: VerificationHarness = {
        project: "test-proj",
        conversation_id: "conv-2",
        created_at: new Date().toISOString(),
        rubric_hash: "hash-bypass",
        min_pass_rate: 0.8,
        tests: []
      };
      await storage.saveVerificationHarness(harness, 'test-user');

      const bypassRun: ValidationResult = {
        id: "run-bypass",
        rubric_hash: "hash-bypass",
        project: "test-proj",
        conversation_id: "conv-2",
        run_at: new Date().toISOString(),
        passed: false,
        pass_rate: 0.4,
        critical_failures: 2,
        coverage_score: 0.8,
        result_json: "{\"failures\":[\"test-a\",\"test-b\"]}",
        gate_action: "abort",
        gate_override: true,
        override_reason: "Sprint deadline — known flaky assertions, manually verified safe"
      };

      await storage.saveVerificationRun(bypassRun, 'test-user');

      // --- getVerificationRun ---
      const retrieved = await storage.getVerificationRun("run-bypass", 'test-user');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.gate_action).toBe("abort");
      expect(retrieved?.gate_override).toBe(true);
      expect(retrieved?.override_reason).toBe(
        "Sprint deadline — known flaky assertions, manually verified safe"
      );
      expect(retrieved?.passed).toBe(false);
      expect(retrieved?.critical_failures).toBe(2);

      // --- listVerificationRuns ---
      const list = await storage.listVerificationRuns("test-proj", 'test-user');
      const found = list.find(r => r.id === "run-bypass");
      expect(found).toBeDefined();
      expect(found?.gate_override).toBe(true);
      expect(found?.override_reason).toBe(
        "Sprint deadline — known flaky assertions, manually verified safe"
      );
      // Symmetric: assert critical_failures is round-tripped correctly in list too
      expect(found?.critical_failures).toBe(2);
    });

    // ── Non-bypass path ──────────────────────────────────────────
    // Asserts that when gate_override is omitted (non-bypass execution),
    // the retrieved record has gate_override=false and override_reason
    // is absent (undefined, not the string "undefined").

    it("persists gate_override=false and absent override_reason (non-bypass path)", async () => {
      const harness: VerificationHarness = {
        project: "test-proj",
        conversation_id: "conv-3",
        created_at: new Date().toISOString(),
        rubric_hash: "hash-nobypass",
        min_pass_rate: 0.8,
        tests: []
      };
      await storage.saveVerificationHarness(harness, 'test-user');

      const noBypassRun: ValidationResult = {
        id: "run-nobypass",
        rubric_hash: "hash-nobypass",
        project: "test-proj",
        conversation_id: "conv-3",
        run_at: new Date().toISOString(),
        passed: false,
        pass_rate: 0.0,
        critical_failures: 3,
        coverage_score: 1.0,
        result_json: "{}",
        gate_action: "block"
        // gate_override intentionally omitted (non-bypass)
        // override_reason intentionally omitted
      };

      await storage.saveVerificationRun(noBypassRun, 'test-user');

      // --- getVerificationRun ---
      const retrieved = await storage.getVerificationRun("run-nobypass", 'test-user');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.gate_action).toBe("block");
      expect(retrieved?.gate_override).toBe(false);
      // override_reason must be absent (undefined), not the string 'undefined' or null
      expect(retrieved?.override_reason).toBeUndefined();

      // --- listVerificationRuns ---
      const list = await storage.listVerificationRuns("test-proj", 'test-user');
      const found = list.find(r => r.id === "run-nobypass");
      expect(found?.gate_override).toBe(false);
      expect(found?.override_reason).toBeUndefined();
    });

    // ── Retrieval ordering & multi-run consistency ───────────────
    // Asserts that listVerificationRuns returns both records with
    // correct fields when two runs coexist (bypass and non-bypass).

    it("listVerificationRuns returns both bypass and non-bypass records with correct fields", async () => {
      // Seed harness
      const harness: VerificationHarness = {
        project: "multi-proj",
        conversation_id: "conv-multi",
        created_at: new Date().toISOString(),
        rubric_hash: "hash-multi",
        min_pass_rate: 0.9,
        tests: []
      };
      await storage.saveVerificationHarness(harness, 'test-user');

      const run1: ValidationResult = {
        id: "multi-run-1",
        rubric_hash: "hash-multi",
        project: "multi-proj",
        conversation_id: "conv-multi",
        // ISO-8601 with UTC 'Z' suffix: lexicographic order == chronological order.
        // SQLite compares run_at as text (ORDER BY run_at DESC), so 'Z' format
        // is required for correct sort. Both Date.toISOString() calls emit 'Z'.
        run_at: new Date(Date.now() - 5000).toISOString(), // older
        passed: false,
        pass_rate: 0.3,
        critical_failures: 1,
        coverage_score: 0.9,
        result_json: "{}",
        gate_action: "abort",
        gate_override: true,
        override_reason: "Hotfix bypass approved by team lead"
      };

      const run2: ValidationResult = {
        id: "multi-run-2",
        rubric_hash: "hash-multi",
        project: "multi-proj",
        conversation_id: "conv-multi",
        run_at: new Date().toISOString(), // newer
        passed: true,
        pass_rate: 1.0,
        critical_failures: 0,
        coverage_score: 1.0,
        result_json: "{}",
        gate_action: "continue"
        // gate_override intentionally omitted
      };

      await storage.saveVerificationRun(run1, 'test-user');
      await storage.saveVerificationRun(run2, 'test-user');

      const list = await storage.listVerificationRuns("multi-proj", 'test-user');
      expect(list.length).toBe(2);

      // Most-recent first (ORDER BY run_at DESC)
      expect(list[0].id).toBe("multi-run-2");
      expect(list[1].id).toBe("multi-run-1");

      // Bypass record fields
      const bypassRecord = list.find(r => r.id === "multi-run-1");
      expect(bypassRecord?.gate_override).toBe(true);
      expect(bypassRecord?.override_reason).toBe("Hotfix bypass approved by team lead");

      // Non-bypass record fields
      const cleanRecord = list.find(r => r.id === "multi-run-2");
      expect(cleanRecord?.gate_override).toBe(false);
      expect(cleanRecord?.override_reason).toBeUndefined();
    });

    // ── Cross-user tenant isolation ──────────────────────────────
    // Asserts that verification runs are scoped to userId.
    // A missing `AND user_id = ?` clause in the query would cause
    // run saved by user-A to leak to user-B — this test catches that.

    it("does not return runs belonging to another user (tenant isolation)", async () => {
      const harness: VerificationHarness = {
        project: "isolated-proj",
        conversation_id: "conv-iso",
        created_at: new Date().toISOString(),
        rubric_hash: "hash-isolation",
        min_pass_rate: 0.8,
        tests: []
      };
      // Save harness under user-A (harnesses also have user isolation)
      await storage.saveVerificationHarness(harness, 'user-A');

      const run: ValidationResult = {
        id: "run-isolated",
        rubric_hash: "hash-isolation",
        project: "isolated-proj",
        conversation_id: "conv-iso",
        run_at: new Date().toISOString(),
        passed: true,
        pass_rate: 1.0,
        critical_failures: 0,
        coverage_score: 1.0,
        result_json: "{}",
        gate_action: "continue",
        gate_override: true,
        override_reason: "user-A bypass"
      };
      await storage.saveVerificationRun(run, 'user-A');

      // user-B should not see user-A's run via getVerificationRun
      const leaked = await storage.getVerificationRun("run-isolated", 'user-B');
      expect(leaked).toBeNull();

      // user-B should not see user-A's run via listVerificationRuns
      const leakedList = await storage.listVerificationRuns("isolated-proj", 'user-B');
      expect(leakedList).toHaveLength(0);

      // Sanity: user-A can still retrieve their own run
      const owned = await storage.getVerificationRun("run-isolated", 'user-A');
      expect(owned).not.toBeNull();
      expect(owned?.override_reason).toBe("user-A bypass");
    });

    // ── Edge case: empty-string override_reason ──────────────────
    // The storage layer uses `|| null` (Supabase) / `|| undefined` (SQLite)
    // when reading override_reason. An empty string is falsy in JS, so it
    // would be coerced to undefined on read — this is intentional.
    //
    // CONTRACT: callers MUST provide a non-empty string or omit the field.
    // An empty `override_reason: ""` is treated as absent by the storage layer.

    it("coerces empty-string override_reason to undefined (documented edge case)", async () => {
      const harness: VerificationHarness = {
        project: "test-proj",
        conversation_id: "conv-empty",
        created_at: new Date().toISOString(),
        rubric_hash: "hash-emptystr",
        min_pass_rate: 0.8,
        tests: []
      };
      await storage.saveVerificationHarness(harness, 'test-user');

      const run: ValidationResult = {
        id: "run-emptystr",
        rubric_hash: "hash-emptystr",
        project: "test-proj",
        conversation_id: "conv-empty",
        run_at: new Date().toISOString(),
        passed: false,
        pass_rate: 0.0,
        critical_failures: 1,
        coverage_score: 1.0,
        result_json: "{}",
        gate_action: "block",
        gate_override: true,
        override_reason: ""  // empty string — treated as absent by storage
      };

      await storage.saveVerificationRun(run, 'test-user');

      // Documented behavior: empty string is coerced to undefined on read
      const retrieved = await storage.getVerificationRun("run-emptystr", 'test-user');
      expect(retrieved?.override_reason).toBeUndefined();
    });
  });
});
