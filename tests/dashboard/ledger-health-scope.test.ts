import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readDashboardLedger } from '../../src/dashboard/ledgerReader.js';
import { SqliteStorage } from '../../src/storage/sqlite.js';
import { SupabaseStorage } from '../../src/storage/supabase.js';
import { supabaseGet } from '../../src/utils/supabaseApi.js';

vi.mock('../../src/utils/supabaseApi.js', () => ({ supabaseGet: vi.fn(), supabaseRpc: vi.fn(), supabasePost: vi.fn(), supabasePatch: vi.fn(), supabaseDelete: vi.fn() }));
const OWNER = 'scope-owner';
const PROJECT = 'scope-project';
const FIXTURE = [
  { id: 'active', user_id: OWNER, project: PROJECT, summary: 'active', archived_at: null, deleted_at: null, is_rollup: false },
  { id: 'archived', user_id: OWNER, project: PROJECT, summary: 'retained history', archived_at: '2026-10-09', deleted_at: null, is_rollup: false },
  { id: 'forgotten', user_id: OWNER, project: PROJECT, summary: 'must not reappear', archived_at: null, deleted_at: '2026-10-09', is_rollup: true },
  { id: 'other-owner', user_id: 'other-owner', project: PROJECT, summary: 'private', archived_at: null, deleted_at: null, is_rollup: false },
];
const clients: Client[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.close()); vi.clearAllMocks(); });

describe('dashboard memory visibility agrees with ownership and soft deletion', () => {
  it.each(['local', 'supabase'])('preserves archived history but hides forgotten and other-owner rows in %s', async backend => {
    const storage = { getLedgerEntries: vi.fn(async params => FIXTURE.filter(row =>
      (!params.user_id || params.user_id === 'eq.' + row.user_id)
      && (!params.deleted_at || row.deleted_at === null))), getDashboardLedger: vi.fn() };
    const rows = await readDashboardLedger(storage, backend, PROJECT, 'created_at.desc', 20, OWNER);
    expect(rows.map((row: any) => row.id)).toEqual(['active', 'archived']);
  });

  it('excludes forgotten entries from native health counts, repair work and rollup checks', async () => {
    const db = createClient({ url: 'file::memory:' }); clients.push(db);
    await db.executeMultiple('CREATE TABLE session_ledger(id TEXT, user_id TEXT, project TEXT, summary TEXT, archived_at TEXT, deleted_at TEXT, is_rollup INTEGER, embedding TEXT); CREATE TABLE session_handoffs(user_id TEXT, project TEXT, metadata TEXT);');
    for (const row of FIXTURE) await db.execute({ sql: 'INSERT INTO session_ledger VALUES (?,?,?,?,?,?,?,NULL)',
      args: [row.id, row.user_id, row.project, row.summary, row.archived_at, row.deleted_at, Number(row.is_rollup)] });
    await db.execute({ sql: 'INSERT INTO session_handoffs VALUES (?,?,?)', args: [OWNER, PROJECT, '{}'] });
    const storage = Object.create(SqliteStorage.prototype) as SqliteStorage;
    Object.defineProperty(storage, 'db', { value: db });
    const stats = await storage.getHealthStats(OWNER);
    expect(stats).toMatchObject({ totalActiveEntries: 1, missingEmbeddings: 1, totalRollups: 0, staleRollups: 0 });
    expect(stats.activeLedgerSummaries.map(row => row.id)).toEqual(['active']);
  });

  it('applies the same visibility rules to direct Supabase health reads', async () => {
    vi.mocked(supabaseGet).mockImplementation(async (table, params: any) => {
      if (table === 'session_handoffs') return [{ project: PROJECT, metadata: {} }];
      return FIXTURE.filter(row => params.user_id === 'eq.' + row.user_id
        && (params.archived_at === 'is.null' ? row.archived_at === null : row.archived_at !== null)
        && (!params.deleted_at || row.deleted_at === null)
        && (!params.is_rollup || row.is_rollup));
    });
    const stats = await new SupabaseStorage().getHealthStats(OWNER);
    expect(stats).toMatchObject({ totalActiveEntries: 1, missingEmbeddings: 1, totalRollups: 0, staleRollups: 0 });
  });
});
