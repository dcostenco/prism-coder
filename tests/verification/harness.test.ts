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
  const dbPath = resolve(__dirname, "test-harness.sqlite");

  afterEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
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
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      storage = new SqliteStorage();
      await storage.initialize(dbPath);
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

    it("saves and retrieves ValidationResult", async () => {
      // First save a harness because verification_runs has a foreign key to verification_harnesses
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
  });
});
