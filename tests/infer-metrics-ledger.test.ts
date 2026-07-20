/**
 * Persistent inference-metrics ledger tests (plan v2 §5.6).
 * Writes to a TEMP DB via PRISM_INFER_LEDGER_DB_PATH — never the real config store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  appendInferMetric,
  queryInferMetrics,
  _resetInferLedgerForTest,
} from '../src/storage/inferMetricsLedger.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'infer-ledger-'));
  process.env.PRISM_INFER_LEDGER_DB_PATH = join(dir, 'test.db');
  _resetInferLedgerForTest();
});

afterEach(async () => {
  delete process.env.PRISM_INFER_LEDGER_DB_PATH;
  _resetInferLedgerForTest();
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // libsql-js#228: close() cannot finalize prepared statements, so Windows
    // may retain this test-only file until V8 GC. The runner owns and removes
    // its temp tree at process exit; unexpected cleanup errors still fail.
    if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code ?? '')) {
      throw error;
    }
  }
});

async function flush(expectTotal?: number) {
  // appendInferMetric is fire-and-forget; poll until rows land (Windows CI has
  // measured multi-second SQLite first-writes — a fixed sleep is flaky there).
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const agg = await queryInferMetrics();
    if (expectTotal === undefined) { if (agg !== null) return; }
    else if (agg && agg.total >= expectTotal) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('infer metrics ledger', () => {
  it('appends rows and aggregates them', async () => {
    appendInferMetric({ backend: 'ollama-9b', model: 'prism-coder:9b', used_cloud: false, prompt_tokens: 70, completion_tokens: 90, latency_ms: 2000, mode: 'code' });
    appendInferMetric({ backend: 'ollama-9b', model: 'prism-coder:9b', used_cloud: false, prompt_tokens: 30, completion_tokens: 10, latency_ms: 1000 });
    appendInferMetric({ backend: 'synalux-cloud', model: null, used_cloud: true, latency_ms: 3000 });
    await flush(3);

    const agg = await queryInferMetrics();
    expect(agg).not.toBeNull();
    expect(agg!.total).toBe(3);
    expect(agg!.local).toBe(2);
    expect(agg!.cloud).toBe(1);
    expect(agg!.prompt_tokens).toBe(100);
    expect(agg!.completion_tokens).toBe(100);
    expect(agg!.avg_latency_ms).toBe(2000);
    expect(agg!.by_backend['ollama-9b']).toBe(2);
  });

  it('persists across module reset (simulated server restart)', async () => {
    appendInferMetric({ backend: 'ollama-4b', model: 'prism-coder:4b', used_cloud: false, latency_ms: 500 });
    await flush(1);
    _resetInferLedgerForTest(); // same DB path, fresh client — like a new process
    const agg = await queryInferMetrics();
    expect(agg!.total).toBe(1);
    expect(agg!.by_backend['ollama-4b']).toBe(1);
  });

  it('reopens the ledger after repeated resets without losing persisted rows', async () => {
    appendInferMetric({ backend: 'ollama-4b', model: 'prism-coder:4b', used_cloud: false });
    await flush(1);

    _resetInferLedgerForTest();
    _resetInferLedgerForTest();
    appendInferMetric({ backend: 'ollama-9b', model: 'prism-coder:9b', used_cloud: false });
    await flush(2);

    const agg = await queryInferMetrics();
    expect(agg!.total).toBe(2);
    expect(agg!.by_backend['ollama-4b']).toBe(1);
    expect(agg!.by_backend['ollama-9b']).toBe(1);
  });

  it('records gate outcome for degraded serves (Phase-1 contract slot)', async () => {
    appendInferMetric({ backend: 'ollama-2b', model: 'prism-coder:2b', used_cloud: false, gate_outcome: 'gate_failed_served', latency_ms: 800 });
    await flush(1);
    const agg = await queryInferMetrics();
    expect(agg!.total).toBe(1);
  });

  it('sinceTs filters the window', async () => {
    appendInferMetric({ backend: 'ollama-9b', model: 'prism-coder:9b', used_cloud: false, latency_ms: 100 });
    await flush(1);
    const future = Date.now() + 60_000;
    const agg = await queryInferMetrics(future);
    expect(agg!.total).toBe(0);
  });

  it('never throws when the DB path is unwritable (hot path protected)', async () => {
    // A regular file cannot also be a parent directory on any supported OS.
    // This deterministically exercises initialization failure without relying
    // on Unix root permissions or platform-specific absolute-path syntax.
    const blockedParent = join(dir, 'not-a-directory');
    writeFileSync(blockedParent, 'block directory creation');
    process.env.PRISM_INFER_LEDGER_DB_PATH = join(blockedParent, 'test.db');
    _resetInferLedgerForTest();
    expect(() => appendInferMetric({ backend: 'ollama-9b', model: null, used_cloud: false })).not.toThrow();
    await new Promise((r) => setTimeout(r, 300));
    const agg = await queryInferMetrics();
    expect(agg).toBeNull(); // init fails (mkdir on unwritable root), not crashed
  });
});

describe('infer metrics ledger — sandbox honoring', () => {
  it('writes under PRISM_DATA_DIR when no explicit override (test-suite safety)', async () => {
    delete process.env.PRISM_INFER_LEDGER_DB_PATH;
    process.env.PRISM_DATA_DIR = dir; // simulate tests/setup.ts sandbox
    _resetInferLedgerForTest();
    appendInferMetric({ backend: 'ollama-9b', model: 'prism-coder:9b', used_cloud: false });
    const deadline = Date.now() + 15_000;
    let agg = null;
    while (Date.now() < deadline) {
      agg = await queryInferMetrics();
      if (agg && agg.total >= 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    delete process.env.PRISM_DATA_DIR;
    expect(agg?.total).toBe(1);
    const { existsSync } = await import('fs');
    expect(existsSync(join(dir, 'prism-config.db'))).toBe(true); // sandboxed file, not ~/.prism-mcp
  });
});
