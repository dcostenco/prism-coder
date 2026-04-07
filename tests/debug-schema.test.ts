import { createTestDb } from './tests/helpers/fixtures.js';
import { describe, it, expect, beforeAll } from 'vitest';

describe('schema debug', () => {
  let storage: any;
  beforeAll(async () => {
    const db = await createTestDb('debug');
    storage = db.storage;
  });

  it('should have valence column', async () => {
    const result = await storage.db.execute('PRAGMA table_info(session_ledger)');
    const columns = result.rows.map((r: any) => r.name);
    console.log('session_ledger columns:', columns);
    expect(columns).toContain('valence');
  });

  it('should have cognitive_budget column on handoffs', async () => {
    const result = await storage.db.execute('PRAGMA table_info(session_handoffs)');
    const columns = result.rows.map((r: any) => r.name);
    console.log('session_handoffs columns:', columns);
    expect(columns).toContain('cognitive_budget');
  });
});
