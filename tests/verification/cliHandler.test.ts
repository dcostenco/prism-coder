import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleVerifyStatus } from '../../src/verification/cliHandler.js';
import { StorageBackend } from '../../src/storage/interface.js';
import * as fs from 'fs/promises';
import { VerificationHarness, computeRubricHash } from '../../src/verification/schema.js';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

describe('CLI Handler - verify status', () => {
  let logSpy: any;
  let errorSpy: any;
  let mockStorage: StorageBackend;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    mockStorage = {
      listVerificationRuns: vi.fn(),
    } as unknown as StorageBackend;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints warning if no runs found', async () => {
    vi.mocked(mockStorage.listVerificationRuns).mockResolvedValue([]);
    
    await handleVerifyStatus(mockStorage, 'test-project');
    
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No previous verification runs found'));
  });

  it('detects synchronization when hashes match', async () => {
    const harnessObj: VerificationHarness = {
      project: 'test',
      conversation_id: '123',
      created_at: '',
      rubric_hash: '',
      min_pass_rate: 0.8,
      tests: [
        { id: '1', layer: 'data', description: 'test', severity: 'warn', assertion: { type: 'sqlite_query', target: 'a', expected: 'a' } }
      ]
    };
    const realHash = computeRubricHash(harnessObj.tests);
    harnessObj.rubric_hash = realHash;

    vi.mocked(mockStorage.listVerificationRuns).mockResolvedValue([
      { 
        rubric_hash: realHash, 
        run_at: '2026-04-03',
        pass_rate: 1.0,
        passed: true,
        critical_failures: 0,
        coverage_score: 1.0,
        gate_action: 'continue',
        id: "1",
        project: "test-project",
        conversation_id: "c1",
        result_json: "{}"
      }
    ]);

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(harnessObj));

    await handleVerifyStatus(mockStorage, 'test-project');
    
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Harness is synchronized'));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('detects drift when hashes do not match', async () => {
    vi.mocked(mockStorage.listVerificationRuns).mockResolvedValue([
      { 
        rubric_hash: 'old-hash-123', 
        run_at: '2026-04-03',
        pass_rate: 1.0,
        passed: true,
        critical_failures: 0,
        coverage_score: 1.0,
        gate_action: 'continue',
        id: "2",
        project: "test-project",
        conversation_id: "c2",
        result_json: "{}"
      }
    ]);

    const localHarness = { tests: [] };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(localHarness));

    await handleVerifyStatus(mockStorage, 'test-project');
    
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('CONFIGURATION DRIFT DETECTED'));
  });
});
