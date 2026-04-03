import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { VerificationRunner } from '../../src/verification/runner.js';
import type {
  VerificationConfig,
  VerificationHarness,
  TestAssertion,
} from '../../src/verification/schema.js';
import {
  TestSuiteSchema,
  computeRubricHash,
} from '../../src/verification/schema.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Test Fixtures ──────────────────────────────────────────────

const tmpDir = path.join(os.tmpdir(), `prism-runner-test-${Date.now()}`);

const FILE_EXISTS_ASSERTION: TestAssertion = {
  id: 'file-exists-check',
  layer: 'data',
  description: 'Check test file exists',
  severity: 'warn',
  assertion: { type: 'file_exists', target: path.join(tmpDir, 'exists.txt'), expected: true },
};

const FILE_CONTAINS_ASSERTION: TestAssertion = {
  id: 'file-contains-check',
  layer: 'data',
  description: 'Check file content',
  severity: 'gate',
  assertion: { type: 'file_contains', target: path.join(tmpDir, 'exists.txt'), expected: 'hello' },
};

const FILE_MISSING_ASSERTION: TestAssertion = {
  id: 'file-missing-check',
  layer: 'pipeline',
  description: 'Check missing file does not exist',
  severity: 'warn',
  assertion: { type: 'file_exists', target: path.join(tmpDir, 'nonexistent.txt'), expected: false },
};

const FILE_ABORT_ASSERTION: TestAssertion = {
  id: 'abort-file-check',
  layer: 'pipeline',
  description: 'Abort-level file check that fails',
  severity: 'abort',
  assertion: { type: 'file_exists', target: path.join(tmpDir, 'missing-abort.txt'), expected: true },
};

function buildSuite(tests: TestAssertion[]): string {
  return JSON.stringify({ tests });
}

function buildHarness(tests: TestAssertion[]): VerificationHarness {
  // Hash must be computed from Zod-parsed tests (same as runSuite does internally)
  const parsed = TestSuiteSchema.parse({ tests });
  return {
    project: 'test',
    conversation_id: 'test-conv',
    created_at: new Date().toISOString(),
    rubric_hash: computeRubricHash(parsed.tests),
    min_pass_rate: 0.5,
    tests: parsed.tests,
  };
}

// ── Test Suite ──────────────────────────────────────────────────

describe('VerificationRunner.runSuite', () => {

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'exists.txt'), 'hello world');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Basic Suite Execution ──

  describe('Basic execution', () => {

    it('returns passed=true when all assertions pass', async () => {
      const suite = buildSuite([FILE_EXISTS_ASSERTION, FILE_MISSING_ASSERTION]);
      const result = await VerificationRunner.runSuite(suite);

      expect(result.passed).toBe(true);
      expect(result.total).toBe(2);
      expect(result.passed_count).toBe(2);
      expect(result.failed_count).toBe(0);
      expect(result.skipped_count).toBe(0);
      expect(result.severity_gate.action).toBe('continue');
    });

    it('returns passed=false when any assertion fails', async () => {
      const failTest: TestAssertion = {
        ...FILE_EXISTS_ASSERTION,
        id: 'fail-test',
        assertion: { type: 'file_exists', target: path.join(tmpDir, 'nope.txt'), expected: true },
      };
      const suite = buildSuite([failTest]);
      const result = await VerificationRunner.runSuite(suite);

      expect(result.passed).toBe(false);
      expect(result.failed_count).toBe(1);
    });

    it('builds per-layer breakdown correctly', async () => {
      const suite = buildSuite([FILE_EXISTS_ASSERTION, FILE_MISSING_ASSERTION]);
      const result = await VerificationRunner.runSuite(suite);

      expect(result.by_layer['data']).toBeDefined();
      expect(result.by_layer['data'].total).toBe(1);
      expect(result.by_layer['data'].passed).toBe(1);
      expect(result.by_layer['pipeline']).toBeDefined();
      expect(result.by_layer['pipeline'].total).toBe(1);
      expect(result.by_layer['pipeline'].passed).toBe(1);
    });

    it('returns VerificationResult with duration_ms', async () => {
      const result = await VerificationRunner.runSuite(buildSuite([FILE_EXISTS_ASSERTION]));
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Parse Errors ──

  describe('Parse error handling', () => {

    it('returns synthetic abort failure on invalid JSON', async () => {
      const result = await VerificationRunner.runSuite('NOT_JSON');
      expect(result.passed).toBe(false);
      expect(result.total).toBe(1);
      expect(result.assertion_results[0].id).toBe('__parse_error__');
      expect(result.assertion_results[0].severity).toBe('abort');
      expect(result.severity_gate.action).toBe('abort');
    });

    it('returns synthetic abort failure on invalid schema', async () => {
      const result = await VerificationRunner.runSuite(JSON.stringify({ tests: [{ bad: true }] }));
      expect(result.passed).toBe(false);
      expect(result.assertion_results[0].id).toBe('__parse_error__');
    });
  });

  // ── Layer Filtering ──

  describe('Layer filtering', () => {

    it('skips assertions outside the active layers', async () => {
      const suite = buildSuite([FILE_EXISTS_ASSERTION, FILE_MISSING_ASSERTION]);
      const result = await VerificationRunner.runSuite(suite, {
        layers: ['data'],
      });

      expect(result.total).toBe(2);
      expect(result.passed_count).toBe(1); // data layer passes
      expect(result.skipped_count).toBe(1); // pipeline layer skipped

      const skipped = result.assertion_results.find(a => a.id === 'file-missing-check');
      expect(skipped?.skipped).toBe(true);
      expect(skipped?.skip_reason).toContain('Layer');
    });
  });

  // ── Severity Filtering ──

  describe('Severity filtering', () => {

    it('skips assertions below minimum severity', async () => {
      const suite = buildSuite([FILE_EXISTS_ASSERTION, FILE_CONTAINS_ASSERTION]);
      const result = await VerificationRunner.runSuite(suite, {
        minSeverity: 'gate',
      });

      const warnResult = result.assertion_results.find(a => a.id === 'file-exists-check');
      expect(warnResult?.skipped).toBe(true);
      expect(warnResult?.skip_reason).toContain('Severity');

      const gateResult = result.assertion_results.find(a => a.id === 'file-contains-check');
      expect(gateResult?.skipped).toBe(false);
    });
  });

  // ── Severity Gate Evaluation ──

  describe('Severity gates', () => {

    it('returns abort gate when abort-level assertion fails', async () => {
      const suite = buildSuite([FILE_ABORT_ASSERTION]);
      const result = await VerificationRunner.runSuite(suite);

      expect(result.passed).toBe(false);
      expect(result.severity_gate.action).toBe('abort');
      expect(result.severity_gate.failed_assertions.length).toBeGreaterThan(0);
    });

    it('returns block gate when gate-level assertion fails', async () => {
      const gateFail: TestAssertion = {
        id: 'gate-fail',
        layer: 'data',
        description: 'Gate-level failure',
        severity: 'gate',
        assertion: { type: 'file_exists', target: path.join(tmpDir, 'missing-gate.txt'), expected: true },
      };
      const result = await VerificationRunner.runSuite(buildSuite([gateFail]));

      expect(result.severity_gate.action).toBe('block');
    });

    it('continues on warn-level failures', async () => {
      const warnFail: TestAssertion = {
        id: 'warn-fail',
        layer: 'data',
        description: 'Warn-level failure',
        severity: 'warn',
        assertion: { type: 'file_exists', target: path.join(tmpDir, 'missing-warn.txt'), expected: true },
      };
      const result = await VerificationRunner.runSuite(buildSuite([warnFail]));

      expect(result.severity_gate.action).toBe('continue');
    });
  });

  // ── Dependency Chains ──

  describe('Dependency chains', () => {

    it('skips dependent assertion when dependency fails', async () => {
      const parent: TestAssertion = {
        id: 'parent',
        layer: 'data',
        description: 'Parent assertion that fails',
        severity: 'warn',
        assertion: { type: 'file_exists', target: path.join(tmpDir, 'nope.txt'), expected: true },
      };
      const child: TestAssertion = {
        id: 'child',
        layer: 'data',
        description: 'Child depends on parent',
        severity: 'warn',
        depends_on: 'parent',
        assertion: { type: 'file_exists', target: path.join(tmpDir, 'exists.txt'), expected: true },
      };

      const result = await VerificationRunner.runSuite(buildSuite([parent, child]));

      const childResult = result.assertion_results.find(a => a.id === 'child');
      expect(childResult?.skipped).toBe(true);
      expect(childResult?.skip_reason).toContain('Dependency');
      expect(childResult?.skip_reason).toContain('failed');
    });

    it('runs dependent assertion when dependency passes', async () => {
      const parent: TestAssertion = {
        id: 'parent-pass',
        layer: 'data',
        description: 'Parent assertion that passes',
        severity: 'warn',
        assertion: { type: 'file_exists', target: path.join(tmpDir, 'exists.txt'), expected: true },
      };
      const child: TestAssertion = {
        id: 'child-pass',
        layer: 'data',
        description: 'Child depends on passing parent',
        severity: 'warn',
        depends_on: 'parent-pass',
        assertion: { type: 'file_exists', target: path.join(tmpDir, 'exists.txt'), expected: true },
      };

      const result = await VerificationRunner.runSuite(buildSuite([parent, child]));

      const childResult = result.assertion_results.find(a => a.id === 'child-pass');
      expect(childResult?.passed).toBe(true);
      expect(childResult?.skipped).toBe(false);
    });

    it('skips assertion with missing dependency', async () => {
      const orphan: TestAssertion = {
        id: 'orphan',
        layer: 'data',
        description: 'Depends on non-existent',
        severity: 'warn',
        depends_on: 'does-not-exist',
        assertion: { type: 'file_exists', target: path.join(tmpDir, 'exists.txt'), expected: true },
      };

      const result = await VerificationRunner.runSuite(buildSuite([orphan]));

      const orphanResult = result.assertion_results.find(a => a.id === 'orphan');
      expect(orphanResult?.skipped).toBe(true);
      expect(orphanResult?.skip_reason).toContain('not found');
    });

    it('detects and skips cyclic dependencies', async () => {
      const a: TestAssertion = {
        id: 'cycle-a',
        layer: 'data',
        description: 'Cyclic A',
        severity: 'warn',
        depends_on: 'cycle-b',
        assertion: { type: 'file_exists', target: path.join(tmpDir, 'exists.txt'), expected: true },
      };
      const b: TestAssertion = {
        id: 'cycle-b',
        layer: 'data',
        description: 'Cyclic B',
        severity: 'warn',
        depends_on: 'cycle-a',
        assertion: { type: 'file_exists', target: path.join(tmpDir, 'exists.txt'), expected: true },
      };

      const result = await VerificationRunner.runSuite(buildSuite([a, b]));

      const aResult = result.assertion_results.find(r => r.id === 'cycle-a');
      const bResult = result.assertion_results.find(r => r.id === 'cycle-b');

      // At least one should be skipped due to the cycle
      const anySkipped = (aResult?.skipped || bResult?.skipped);
      expect(anySkipped).toBe(true);
    });
  });

  // ── Rubric Hash Validation ──

  describe('Rubric hash validation', () => {

    it('passes when harness rubric hash matches', async () => {
      const tests = [FILE_EXISTS_ASSERTION];
      const harness = buildHarness(tests);
      const suite = buildSuite(tests);

      const result = await VerificationRunner.runSuite(suite, { harness });
      expect(result.passed).toBe(true);
    });

    it('returns synthetic abort on rubric hash mismatch', async () => {
      const tests = [FILE_EXISTS_ASSERTION];
      const harness = buildHarness(tests);
      harness.rubric_hash = 'tampered-hash-value';

      const suite = buildSuite(tests);
      const result = await VerificationRunner.runSuite(suite, { harness });

      expect(result.passed).toBe(false);
      expect(result.assertion_results[0].id).toBe('__parse_error__');
      expect(result.assertion_results[0].error).toContain('Rubric hash mismatch');
    });
  });

  // ── VerificationConfig Integration ──

  describe('VerificationConfig integration', () => {

    it('respects config default_severity as floor for gate evaluation', async () => {
      // A warn-level failure with default_severity=gate should be treated as gate-level
      const warnFail: TestAssertion = {
        id: 'elevated-warn',
        layer: 'data',
        description: 'Warn assertion elevated to gate by config',
        severity: 'warn',
        assertion: { type: 'file_exists', target: path.join(tmpDir, 'nope.txt'), expected: true },
      };
      const config: VerificationConfig = {
        enabled: true,
        layers: ['data', 'agent', 'pipeline'],
        default_severity: 'gate', // floor elevator
      };

      const result = await VerificationRunner.runSuite(buildSuite([warnFail]), { config });

      // The warn-level failure is elevated to gate → action should be 'block'
      expect(result.severity_gate.action).toBe('block');
    });
  });

  // ── Duplicate IDs ──

  describe('Duplicate assertion IDs', () => {

    it('skips duplicate assertion IDs', async () => {
      const dup1: TestAssertion = { ...FILE_EXISTS_ASSERTION, id: 'dup-id' };
      const dup2: TestAssertion = { ...FILE_MISSING_ASSERTION, id: 'dup-id' };

      const result = await VerificationRunner.runSuite(buildSuite([dup1, dup2]));

      const dupResults = result.assertion_results.filter(a => a.id === 'dup-id');
      // Second assertion with same id should be skipped
      const hasSkipped = dupResults.some(r => r.skipped && r.skip_reason?.includes('Duplicate'));
      expect(hasSkipped).toBe(true);
    });
  });

  // ── Timeout ──

  describe('Timeouts', () => {

    it('fails assertion when timeout_ms elapses', async () => {
      // Use quickjs_eval with an infinite loop — either QuickJS interrupts it
      // or the withTimeout wrapper fires. Either way the assertion must fail.
      const slowTest: TestAssertion = {
        id: 'timeout-test',
        layer: 'data',
        description: 'QuickJS infinite loop with tiny timeout',
        severity: 'warn',
        timeout_ms: 50, // minimum allowed per schema
        assertion: { type: 'quickjs_eval', code: 'while(true){}', inputs: {} },
      };

      const result = await VerificationRunner.runSuite(buildSuite([slowTest]));
      const r = result.assertion_results.find(a => a.id === 'timeout-test');
      expect(r).toBeDefined();
      expect(r?.passed).toBe(false);
      // Error can be either timeout or QuickJS execution limit
      expect(r?.error).toBeDefined();
    });
  });

  // ── file_contains assertion ──

  describe('file_contains assertion', () => {

    it('passes when file contains expected string', async () => {
      const result = await VerificationRunner.runSuite(buildSuite([FILE_CONTAINS_ASSERTION]));
      const r = result.assertion_results.find(a => a.id === 'file-contains-check');
      expect(r?.passed).toBe(true);
    });

    it('fails when file does not contain expected string', async () => {
      const test: TestAssertion = {
        ...FILE_CONTAINS_ASSERTION,
        id: 'file-not-contains',
        assertion: { type: 'file_contains', target: path.join(tmpDir, 'exists.txt'), expected: 'NOT_IN_FILE' },
      };
      const result = await VerificationRunner.runSuite(buildSuite([test]));
      const r = result.assertion_results.find(a => a.id === 'file-not-contains');
      expect(r?.passed).toBe(false);
    });

    it('fails when file does not exist', async () => {
      const test: TestAssertion = {
        ...FILE_CONTAINS_ASSERTION,
        id: 'file-missing-contains',
        assertion: { type: 'file_contains', target: path.join(tmpDir, 'nope.txt'), expected: 'anything' },
      };
      const result = await VerificationRunner.runSuite(buildSuite([test]));
      const r = result.assertion_results.find(a => a.id === 'file-missing-contains');
      expect(r?.passed).toBe(false);
      expect(r?.error).toContain('not found');
    });
  });
});
