import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { SqliteStorage } from '../../src/storage/sqlite.js';

const OWNER = 'importance-owner';
const PROJECT = 'importance-project';

describe('SQLite importance protects inactive and other-owner memory', () => {
  let db: Client;
  let storage: SqliteStorage;

  beforeEach(async () => {
    db = createClient({ url: 'file::memory:' });
    await db.executeMultiple(`CREATE TABLE session_ledger (
      id TEXT PRIMARY KEY, project TEXT, user_id TEXT, importance INTEGER,
      event_type TEXT, created_at TEXT, last_accessed_at TEXT,
      deleted_at TEXT, archived_at TEXT
    );`);
    await db.execute('ALTER TABLE session_ledger ADD COLUMN is_rollup INTEGER DEFAULT 0');
    for (const id of ['active', 'archived', 'deleted', 'other-owner']) {
      await db.execute({ sql: `INSERT INTO session_ledger
        (id, project, user_id, importance, event_type, created_at, last_accessed_at, deleted_at, archived_at) VALUES
        (?, ?, ?, 3, 'correction', datetime('now', '-60 days'), NULL, ?, ?)`,
      args: [id, PROJECT, id === 'other-owner' ? 'other-owner' : OWNER,
        id === 'deleted' ? '2020-01-01' : null, id === 'archived' ? '2020-01-01' : null] });
    }
    storage = Object.create(SqliteStorage.prototype) as SqliteStorage;
    Object.defineProperty(storage, 'db', { value: db });
  });
  afterEach(() => db.close());

  async function scores() {
    const result = await db.execute('SELECT id, importance FROM session_ledger ORDER BY id');
    return Object.fromEntries(result.rows.map(row => [row.id, row.importance]));
  }

  it('votes on active owned memory and keeps the zero floor', async () => {
    await storage.adjustImportance('active', 1, OWNER);
    expect((await scores()).active).toBe(4);
    for (let i = 0; i < 5; i++) await storage.adjustImportance('active', -1, OWNER);
    expect((await scores()).active).toBe(0);
  });

  it.each(['missing', 'archived', 'deleted', 'other-owner'])('rejects a vote on %s without claiming success or changing memory', async id => {
    const before = await scores();
    await expect(storage.adjustImportance(id, 1, OWNER)).rejects.toThrow('Memory entry not found');
    expect(await scores()).toEqual(before);
  });

  it.each(['standalone', 'TTL'])('%s decay preserves archived history and other-owner memory', async mode => {
    if (mode === 'standalone') await storage.decayImportance(PROJECT, OWNER, 30);
    else expect(await storage.expireByTTL(PROJECT, 365, OWNER)).toEqual({ expired: 0 });
    expect(await scores()).toEqual({ active: 2, archived: 3, deleted: 3, 'other-owner': 3 });
  });
});
