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
