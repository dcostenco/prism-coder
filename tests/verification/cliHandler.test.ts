/**
 * cliHandler.test.ts
 *
 * Unit tests for verify status and verify generate CLI handlers.
 *
 * Strategy: test computeVerifyStatus / computeGenerateHarness (pure typed result)
 * separately from handleVerifyStatus / handleGenerateHarness (render + exitCode side-effects).
 * This keeps assertion logic out of console-spy gymnastics.
 *
 * Branch coverage map:
 *   no_runs                  — "prints warning if no runs found"
 *   synchronized             — "detects synchronization when hashes match"
 *   drift/warn (local dev)   — "detects drift — local dev (warn policy)"
 *   drift/blocked (CI)       — "detects drift — strict env (blocked policy)"
 *   drift/bypassed (--force) — "detects drift — force bypass (bypassed policy)"
 *   harness_missing          — "returns harness_missing when file not found"
 *   harness_invalid_json     — "returns harness_invalid_json on bad JSON"
 *   override badge           — "includes override_reason in text badge"
 *   --json mode              — "emits stable JSON object in --json mode"
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handleVerifyStatus,
  computeVerifyStatus,
  computeGenerateHarness,
  ModifiedTestAssertion,
} from '../../src/verification/cliHandler.js';
import { StorageBackend } from '../../src/storage/interface.js';
import * as fs from 'fs/promises';
import { VerificationHarness, computeRubricHash } from '../../src/verification/schema.js';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const BASE_RUN = {
  id: 'run-1',
  project: 'test-project',
  conversation_id: 'c1',
  result_json: '{}',
  run_at: '2026-04-03',
  passed: true,
  pass_rate: 1.0,
  critical_failures: 0,
  coverage_score: 1.0,
  gate_action: 'continue',
};

const HARNESS_OBJ: VerificationHarness = {
  project: 'test',
  conversation_id: '123',
  created_at: '',
  rubric_hash: '',
  min_pass_rate: 0.8,
  tests: [
    {
      id: '1',
      layer: 'data',
      description: 'test',
      severity: 'warn',
      assertion: { type: 'sqlite_query', target: 'a', expected: 'a' },
    },
  ],
};

/** Build a mock storage with listVerificationRuns returning the given runs */
function makeStorage(runs: any[] = []): StorageBackend {
  return {
    listVerificationRuns: vi.fn().mockResolvedValue(runs),
    getVerificationHarness: vi.fn().mockResolvedValue(null),
    saveVerificationHarness: vi.fn().mockResolvedValue(undefined),
  } as unknown as StorageBackend;
}

/** Compute the real hash for HARNESS_OBJ */
function realHash(): string {
  return computeRubricHash(HARNESS_OBJ.tests);
}

// ─── computeVerifyStatus — pure result shape ──────────────────────────────────

describe('computeVerifyStatus', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // Reset process.exitCode after each test
    process.exitCode = 0;
    // Restore env vars touched by tests
    delete process.env.CI;
    delete process.env.PRISM_STRICT_VERIFICATION;
  });

  it('returns no_runs=true when no runs found', async () => {
    const result = await computeVerifyStatus(makeStorage([]), 'proj');
    expect(result.no_runs).toBe(true);
    expect(result.exit_code).toBe(0);
    expect(result.recommended_action).toContain('prism verify generate');
  });

  it('returns synchronized=true when hashes match', async () => {
    const hash = realHash();
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ ...HARNESS_OBJ, rubric_hash: hash }));

    const result = await computeVerifyStatus(
      makeStorage([{ ...BASE_RUN, rubric_hash: hash }]),
      'proj',
    );

    expect(result.synchronized).toBe(true);
    expect(result.drift).toBeUndefined();
    expect(result.exit_code).toBe(0);
  });

  it('returns drift.policy=warn in local dev (no CI env)', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ tests: [] }));

    const result = await computeVerifyStatus(
      makeStorage([{ ...BASE_RUN, rubric_hash: 'old-hash' }]),
      'proj',
    );

    expect(result.synchronized).toBe(false);
    expect(result.drift?.policy).toBe('warn');
    expect(result.drift?.strict_env).toBe(false);
    expect(result.exit_code).toBe(0);
  });

  it('returns drift.policy=blocked when CI=true', async () => {
    process.env.CI = 'true';
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ tests: [] }));

    const result = await computeVerifyStatus(
      makeStorage([{ ...BASE_RUN, rubric_hash: 'old-hash' }]),
      'proj',
    );

    expect(result.drift?.policy).toBe('blocked');
    expect(result.drift?.strict_env).toBe(true);
    expect(result.exit_code).toBe(1);
  });

  it('returns drift.policy=blocked when PRISM_STRICT_VERIFICATION=true', async () => {
    process.env.PRISM_STRICT_VERIFICATION = 'true';
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ tests: [] }));

    const result = await computeVerifyStatus(
      makeStorage([{ ...BASE_RUN, rubric_hash: 'old-hash' }]),
      'proj',
    );

    expect(result.drift?.policy).toBe('blocked');
    expect(result.exit_code).toBe(1);
  });

  it('returns drift.policy=bypassed when force=true regardless of env', async () => {
    process.env.CI = 'true'; // strict env — but force wins
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ tests: [] }));

    const result = await computeVerifyStatus(
      makeStorage([{ ...BASE_RUN, rubric_hash: 'old-hash' }]),
      'proj',
      /* force */ true,
    );

    expect(result.drift?.policy).toBe('bypassed');
    // force bypasses the block, so exit_code stays 0
    expect(result.exit_code).toBe(0);
  });

  it('returns harness_missing=true when file not found', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

    const result = await computeVerifyStatus(
      makeStorage([{ ...BASE_RUN, rubric_hash: 'hash' }]),
      'proj',
    );

    expect(result.harness_missing).toBe(true);
    expect(result.synchronized).toBeNull();
    expect(result.exit_code).toBe(0);
  });

  it('returns harness_invalid_json=true on malformed JSON', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('{ not valid json }}}');

    const result = await computeVerifyStatus(
      makeStorage([{ ...BASE_RUN, rubric_hash: 'hash' }]),
      'proj',
    );

    expect(result.harness_invalid_json).toBe(true);
    expect(result.exit_code).toBe(1);
  });

  it('propagates override_reason in last_run', async () => {
    const hash = realHash();
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ ...HARNESS_OBJ, rubric_hash: hash }));

    const result = await computeVerifyStatus(
      makeStorage([{
        ...BASE_RUN,
        rubric_hash: hash,
        gate_override: true,
        override_reason: 'Known flaky — ticket #42',
      }]),
      'proj',
    );

    expect(result.last_run?.gate_override).toBe(true);
    expect(result.last_run?.override_reason).toBe('Known flaky — ticket #42');
  });

  describe('Phase 2 Diagnostics: Structured Drift Diff', () => {
    it('populates added, removed, and modified structurally and strictly by ID', async () => {
      // Historical harness (stored)
      const storedHarness = {
        ...HARNESS_OBJ,
        tests: [
          { id: 't1', description: 'same', assertion: { type: 'sqlite_query' } },
          { id: 't2', description: 'will-modify', assertion: { type: 'http_status' } },
          { id: 't3', description: 'will-remove', assertion: { type: 'file_exists' } }
        ]
      };
      const storedHash = computeRubricHash(storedHarness.tests as any);

      // Local harness
      const localHarness = {
        ...HARNESS_OBJ,
        tests: [
          { id: 't1', description: 'same', assertion: { type: 'sqlite_query' } }, // same
          { id: 't2', description: 'modified!', assertion: { type: 'http_status' } }, // modified
          { id: 't4', description: 'added', assertion: { type: 'file_contains' } } // added
        ]
      };
      const localHash = computeRubricHash(localHarness.tests as any);

      // Mock the filesystem
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(localHarness));
      
      // Setup Storage mock
      const storage = makeStorage([{ ...BASE_RUN, rubric_hash: storedHash }]);
      storage.getVerificationHarness = vi.fn().mockResolvedValue(storedHarness);

      const result = await computeVerifyStatus(storage, 'proj');

      expect(result.synchronized).toBe(false);
      expect(result.drift?.diff).toBeDefined();
      
      const diff = result.drift!.diff!;
      expect(diff.added).toHaveLength(1);
      expect(diff.added[0].id).toBe('t4');

      expect(diff.removed).toHaveLength(1);
      expect(diff.removed[0].id).toBe('t3');

      expect(diff.modified).toHaveLength(1);
      expect(diff.modified[0].id).toBe('t2');
      expect(diff.modified[0].description).toBe('modified!');
      
      // Ensure sorted by ID
      expect(storage.getVerificationHarness).toHaveBeenCalledWith(storedHash, 'default');
    });

    it('includes diff_counts matching diff array lengths', async () => {
      const storedHarness = {
        ...HARNESS_OBJ,
        tests: [
          { id: 't1', description: 'same', assertion: { type: 'sqlite_query' } },
          { id: 't2', description: 'will-modify', assertion: { type: 'http_status' } },
          { id: 't3', description: 'will-remove', assertion: { type: 'file_exists' } }
        ]
      };
      const storedHash = computeRubricHash(storedHarness.tests as any);

      const localHarness = {
        ...HARNESS_OBJ,
        tests: [
          { id: 't1', description: 'same', assertion: { type: 'sqlite_query' } },
          { id: 't2', description: 'modified!', assertion: { type: 'http_status' } },
          { id: 't4', description: 'added', assertion: { type: 'file_contains' } }
        ]
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(localHarness));
      const storage = makeStorage([{ ...BASE_RUN, rubric_hash: storedHash }]);
      storage.getVerificationHarness = vi.fn().mockResolvedValue(storedHarness);

      const result = await computeVerifyStatus(storage, 'proj');

      expect(result.drift?.diff_counts).toBeDefined();
      expect(result.drift!.diff_counts!.added).toBe(1);
      expect(result.drift!.diff_counts!.removed).toBe(1);
      expect(result.drift!.diff_counts!.modified).toBe(1);

      // Counts must match array lengths
      expect(result.drift!.diff_counts!.added).toBe(result.drift!.diff!.added.length);
      expect(result.drift!.diff_counts!.removed).toBe(result.drift!.diff!.removed.length);
      expect(result.drift!.diff_counts!.modified).toBe(result.drift!.diff!.modified.length);
    });

    it('populates changed_keys on modified entries with exact field names', async () => {
      const storedHarness = {
        ...HARNESS_OBJ,
        tests: [
          { id: 't1', description: 'original', severity: 'warn', assertion: { type: 'sqlite_query', target: 'a', expected: 'a' } },
          { id: 't2', description: 'unchanged', severity: 'warn', assertion: { type: 'http_status', target: 'b', expected: 'b' } },
        ]
      };
      const storedHash = computeRubricHash(storedHarness.tests as any);

      const localHarness = {
        ...HARNESS_OBJ,
        tests: [
          // t1: description and assertion changed, severity unchanged
          { id: 't1', description: 'updated', severity: 'warn', assertion: { type: 'sqlite_query', target: 'a', expected: 'z' } },
          // t2: only severity changed
          { id: 't2', description: 'unchanged', severity: 'abort', assertion: { type: 'http_status', target: 'b', expected: 'b' } },
        ]
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(localHarness));
      const storage = makeStorage([{ ...BASE_RUN, rubric_hash: storedHash }]);
      storage.getVerificationHarness = vi.fn().mockResolvedValue(storedHarness);

      const result = await computeVerifyStatus(storage, 'proj');
      const modified = result.drift!.diff!.modified as ModifiedTestAssertion[];

      expect(modified).toHaveLength(2);

      // t1: description + assertion changed
      const t1 = modified.find(m => m.id === 't1')!;
      expect(t1.changed_keys).toContain('description');
      expect(t1.changed_keys).toContain('assertion');
      expect(t1.changed_keys).not.toContain('severity');
      expect(t1.changed_keys).not.toContain('id');

      // t2: only severity changed
      const t2 = modified.find(m => m.id === 't2')!;
      expect(t2.changed_keys).toEqual(['severity']);

      // changed_keys must be sorted alphabetically
      for (const mod of modified) {
        const sorted = [...mod.changed_keys].sort();
        expect(mod.changed_keys).toEqual(sorted);
      }
    });

    it('safely skips diff generation if historical harness fails to load', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(HARNESS_OBJ));
      const storage = makeStorage([{ ...BASE_RUN, rubric_hash: 'old-hash' }]);
      storage.getVerificationHarness = vi.fn().mockRejectedValue(new Error('DB Error'));

      const result = await computeVerifyStatus(storage, 'proj');
      expect(result.synchronized).toBe(false);
      expect(result.drift?.diff).toBeUndefined(); // Should degrade gracefully
      expect(result.drift?.diff_counts).toBeUndefined(); // Counts also absent
    });
  });
});

// ─── handleVerifyStatus — render + exitCode side-effects ──────────────────────

describe('handleVerifyStatus', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy   = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy  = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
    delete process.env.CI;
    delete process.env.PRISM_STRICT_VERIFICATION;
  });

  it('prints warning if no runs found', async () => {
    await handleVerifyStatus(makeStorage([]), 'proj');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No previous verification runs found'));
  });

  it('prints synchronized when hashes match', async () => {
    const hash = realHash();
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ ...HARNESS_OBJ, rubric_hash: hash }));

    await handleVerifyStatus(
      makeStorage([{ ...BASE_RUN, rubric_hash: hash }]),
      'proj',
    );

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Harness is synchronized'));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('prints drift warn in local dev', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ tests: [] }));

    await handleVerifyStatus(
      makeStorage([{ ...BASE_RUN, rubric_hash: 'old-hash' }]),
      'proj',
    );

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[DRIFT]'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('prism verify generate'));
  });

  it('prints drift blocked and sets exitCode=1 in CI', async () => {
    process.env.CI = 'true';
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ tests: [] }));

    await handleVerifyStatus(
      makeStorage([{ ...BASE_RUN, rubric_hash: 'old-hash' }]),
      'proj',
    );

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[BLOCKED]'));
    expect(process.exitCode).toBe(1);
  });

  it('prints drift bypassed (not blocked) when --force in CI', async () => {
    process.env.CI = 'true';
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ tests: [] }));

    await handleVerifyStatus(
      makeStorage([{ ...BASE_RUN, rubric_hash: 'old-hash' }]),
      'proj',
      /* force */ true,
    );

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[BYPASSED]'));
    // exitCode must stay 0 — force overrides the block
    expect(process.exitCode).toBe(0);
  });

  it('prints harness_missing notice without error', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

    await handleVerifyStatus(
      makeStorage([{ ...BASE_RUN, rubric_hash: 'hash' }]),
      'proj',
    );

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No local verification_harness.json'));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('prints error on invalid JSON', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('{bad json');

    await handleVerifyStatus(
      makeStorage([{ ...BASE_RUN, rubric_hash: 'hash' }]),
      'proj',
    );

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid JSON'));
    expect(process.exitCode).toBe(1);
  });

  it('includes override_reason in text badge when present', async () => {
    const hash = realHash();
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ ...HARNESS_OBJ, rubric_hash: hash }));

    await handleVerifyStatus(
      makeStorage([{
        ...BASE_RUN,
        rubric_hash: hash,
        gate_override: true,
        override_reason: 'Approved by team lead',
      }]),
      'proj',
    );

    // Should log something like "[OVERRIDDEN: Approved by team lead] YES"
    const allLogs = logSpy.mock.calls.flat().join('\n');
    expect(allLogs).toContain('[OVERRIDDEN: Approved by team lead]');
  });

  it('emits stable JSON object in --json mode', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ tests: [] }));

    await handleVerifyStatus(
      makeStorage([{ ...BASE_RUN, rubric_hash: 'old-hash' }]),
      'proj',
      /* force */ false,
      /* userId */ 'default',
      /* jsonMode */ true,
    );

    expect(stdoutSpy).toHaveBeenCalledOnce();
    const raw = (stdoutSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(raw);

    // Stable required keys matching the Operator Contract
    expect(parsed.schema_version).toBe(1);
    expect(parsed).toHaveProperty('project');
    expect(parsed).toHaveProperty('no_runs');
    expect(parsed).toHaveProperty('synchronized');
    expect(parsed).toHaveProperty('exit_code');
    expect(parsed).toHaveProperty('recommended_action');
    // No console.log/error/warn should have fired
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('renders diff_counts summary and changed_keys brackets in human mode', async () => {
    const storedHarness = {
      ...HARNESS_OBJ,
      tests: [
        { id: 't1', description: 'original', severity: 'warn', assertion: { type: 'sqlite_query', target: 'a', expected: 'a' } },
        { id: 't2', description: 'will-remove', severity: 'warn', assertion: { type: 'file_exists', target: 'b', expected: 'b' } },
      ]
    };
    const storedHash = computeRubricHash(storedHarness.tests as any);

    const localHarness = {
      ...HARNESS_OBJ,
      tests: [
        { id: 't1', description: 'updated', severity: 'warn', assertion: { type: 'sqlite_query', target: 'a', expected: 'a' } },
        { id: 't3', description: 'brand-new', severity: 'warn', assertion: { type: 'file_contains', target: 'c', expected: 'c' } },
      ]
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(localHarness));
    const storage = makeStorage([{ ...BASE_RUN, rubric_hash: storedHash }]);
    storage.getVerificationHarness = vi.fn().mockResolvedValue(storedHarness);

    await handleVerifyStatus(storage, 'proj');

    const allLogs = logSpy.mock.calls.flat().join('\n');

    // Diff Summary line
    expect(allLogs).toContain('+1 added');
    expect(allLogs).toContain('~1 modified');
    expect(allLogs).toContain('-1 removed');

    // Changed keys bracket on modified entry
    expect(allLogs).toContain('~ t1: updated [description]');
  });

  it('emits diff_counts and changed_keys in --json mode', async () => {
    const storedHarness = {
      ...HARNESS_OBJ,
      tests: [
        { id: 't1', description: 'original', severity: 'warn', assertion: { type: 'sqlite_query', target: 'a', expected: 'a' } },
      ]
    };
    const storedHash = computeRubricHash(storedHarness.tests as any);

    const localHarness = {
      ...HARNESS_OBJ,
      tests: [
        { id: 't1', description: 'changed', severity: 'warn', assertion: { type: 'sqlite_query', target: 'a', expected: 'a' } },
      ]
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(localHarness));
    const storage = makeStorage([{ ...BASE_RUN, rubric_hash: storedHash }]);
    storage.getVerificationHarness = vi.fn().mockResolvedValue(storedHarness);

    await handleVerifyStatus(storage, 'proj', false, 'default', true);

    const raw = (stdoutSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(raw);

    // JSON stability: diff_counts present
    expect(parsed.drift.diff_counts).toEqual({ added: 0, removed: 0, modified: 1 });

    // JSON stability: changed_keys on modified entries
    expect(parsed.drift.diff.modified[0].changed_keys).toEqual(['description']);
    expect(parsed.drift.diff.modified[0].id).toBe('t1');

    // schema_version unchanged
    expect(parsed.schema_version).toBe(1);
  });
});

// ─── computeGenerateHarness — pure result shape ───────────────────────────────

describe('computeGenerateHarness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('returns file_missing when file does not exist', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

    const result = await computeGenerateHarness(makeStorage(), 'proj');

    expect(result.file_missing).toBe(true);
    expect(result.exit_code).toBe(1);
  });

  it('returns invalid_json on malformed file', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('{broken');

    const result = await computeGenerateHarness(makeStorage(), 'proj');

    expect(result.invalid_json).toBe(true);
    expect(result.exit_code).toBe(1);
  });

  it('returns already_exists when hash already registered and not force', async () => {
    const hash = realHash();
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(HARNESS_OBJ));

    const storage = {
      getVerificationHarness: vi.fn().mockResolvedValue({ rubric_hash: hash }),
      saveVerificationHarness: vi.fn(),
      listVerificationRuns: vi.fn().mockResolvedValue([]),
    } as unknown as StorageBackend;

    const result = await computeGenerateHarness(storage, 'proj', /* force */ false);

    expect(result.already_exists).toBe(true);
    expect(result.exit_code).toBe(0);
    // No write should have been attempted
    expect((storage.saveVerificationHarness as any).mock.calls).toHaveLength(0);
  });

  it('re-registers when force=true even if already exists', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(HARNESS_OBJ));

    const storage = {
      getVerificationHarness: vi.fn().mockResolvedValue({ rubric_hash: 'old' }),
      saveVerificationHarness: vi.fn().mockResolvedValue(undefined),
      listVerificationRuns: vi.fn().mockResolvedValue([]),
    } as unknown as StorageBackend;

    const result = await computeGenerateHarness(storage, 'proj', /* force */ true);

    expect(result.success).toBe(true);
    expect(result.exit_code).toBe(0);
    expect((storage.saveVerificationHarness as any).mock.calls).toHaveLength(1);
  });

  it('returns success with rubric_hash and test_count on happy path', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(HARNESS_OBJ));

    const storage = makeStorage();
    const result = await computeGenerateHarness(storage, 'proj');

    expect(result.success).toBe(true);
    expect(result.rubric_hash).toBeTruthy();
    expect(result.test_count).toBe(HARNESS_OBJ.tests.length);
    expect(result.exit_code).toBe(0);
  });
});
