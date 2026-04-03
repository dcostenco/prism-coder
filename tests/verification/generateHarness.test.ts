import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleGenerateHarness } from '../../src/verification/cliHandler.js';
import { StorageBackend } from '../../src/storage/interface.js';
import type { TestAssertion, VerificationHarness } from '../../src/verification/schema.js';
import * as fs from 'fs/promises';
import { computeRubricHash } from '../../src/verification/schema.js';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

// ── Shared fixture ──
const TEST_ASSERTION: TestAssertion = {
  id: 't1',
  layer: 'data',
  description: 'test',
  severity: 'warn',
  assertion: { type: 'file_exists' as const, target: 'a.txt', expected: true },
};

function makeHarnessJson(overrides?: Partial<{ tests: TestAssertion[]; min_pass_rate: number }>) {
  return JSON.stringify({
    tests: overrides?.tests ?? [TEST_ASSERTION],
    ...(overrides?.min_pass_rate != null ? { min_pass_rate: overrides.min_pass_rate } : {}),
  });
}

function makeExistingHarness(tests: TestAssertion[]): VerificationHarness {
  return {
    project: 'test-project',
    conversation_id: 'old',
    created_at: '2026-01-01',
    rubric_hash: computeRubricHash(tests),
    min_pass_rate: 0.8,
    tests,
  };
}

describe('CLI Handler - handleGenerateHarness', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let mockStorage: StorageBackend;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockStorage = {
      saveVerificationHarness: vi.fn().mockResolvedValue(undefined),
      getVerificationHarness: vi.fn().mockResolvedValue(null),
    } as unknown as StorageBackend;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Happy Path ──

  it('registers a new harness from valid JSON file', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(makeHarnessJson());

    await handleGenerateHarness(mockStorage, 'test-project');

    expect(mockStorage.saveVerificationHarness).toHaveBeenCalledTimes(1);

    const savedArg = vi.mocked(mockStorage.saveVerificationHarness).mock.calls[0][0];
    expect(savedArg.project).toBe('test-project');
    expect(savedArg.rubric_hash).toBe(computeRubricHash([TEST_ASSERTION]));
    expect(savedArg.tests.length).toBe(1);
    expect(savedArg.created_at).toBeDefined();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Success'));
  });

  // ── File Not Found ──

  it('prints error when harness file does not exist', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT: no such file'));

    await handleGenerateHarness(mockStorage, 'test-project');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to read'));
    expect(mockStorage.saveVerificationHarness).not.toHaveBeenCalled();
  });

  // ── Invalid JSON ──

  it('prints error when file contains invalid JSON', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('NOT VALID JSON {{{');

    await handleGenerateHarness(mockStorage, 'test-project');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid JSON'));
    expect(mockStorage.saveVerificationHarness).not.toHaveBeenCalled();
  });

  // ── Duplicate Hash Detection ──

  it('blocks registration when harness with same hash already exists', async () => {
    const dupAssertion: TestAssertion = { ...TEST_ASSERTION, description: 'dup' };
    vi.mocked(fs.readFile).mockResolvedValue(makeHarnessJson({ tests: [dupAssertion] }));
    vi.mocked(mockStorage.getVerificationHarness!).mockResolvedValue(
      makeExistingHarness([dupAssertion])
    );

    await handleGenerateHarness(mockStorage, 'test-project');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already exists'));
    expect(mockStorage.saveVerificationHarness).not.toHaveBeenCalled();
  });

  // ── --force Bypass ──

  it('re-registers harness when --force is set even if hash exists', async () => {
    const forceAssertion: TestAssertion = { ...TEST_ASSERTION, description: 'force' };
    vi.mocked(fs.readFile).mockResolvedValue(makeHarnessJson({ tests: [forceAssertion] }));
    vi.mocked(mockStorage.getVerificationHarness!).mockResolvedValue(
      makeExistingHarness([forceAssertion])
    );

    await handleGenerateHarness(mockStorage, 'test-project', true);

    // --force should skip the duplicate check and persist anyway
    expect(mockStorage.saveVerificationHarness).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Success'));
  });

  // ── Backend Without getVerificationHarness ──

  it('proceeds when storage backend lacks getVerificationHarness', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(makeHarnessJson());

    // Simulate a backend that doesn't implement getVerificationHarness
    const limitedStorage = {
      saveVerificationHarness: vi.fn().mockResolvedValue(undefined),
      getVerificationHarness: undefined,
    } as unknown as StorageBackend;

    await handleGenerateHarness(limitedStorage, 'test-project');

    expect(limitedStorage.saveVerificationHarness).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Success'));
  });

  // ── Metadata Stamping ──

  it('stamps project, created_at, and rubric_hash on saved harness', async () => {
    const metaAssertion: TestAssertion = {
      id: 'meta',
      layer: 'pipeline',
      description: 'meta test',
      severity: 'gate',
      assertion: { type: 'file_exists' as const, target: 'e.txt', expected: true },
    };
    vi.mocked(fs.readFile).mockResolvedValue(makeHarnessJson({ tests: [metaAssertion], min_pass_rate: 0.9 }));

    await handleGenerateHarness(mockStorage, 'my-project');

    const saved = vi.mocked(mockStorage.saveVerificationHarness).mock.calls[0][0];
    expect(saved.project).toBe('my-project');
    expect(saved.rubric_hash).toBe(computeRubricHash([metaAssertion]));
    expect(new Date(saved.created_at).getTime()).not.toBeNaN();
  });
});

