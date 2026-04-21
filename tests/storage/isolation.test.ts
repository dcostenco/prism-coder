/**
 * DB Isolation Regression Tests
 *
 * ═══════════════════════════════════════════════════════════════════
 * PURPOSE:
 *   Proves that concurrent SqliteStorage instances are fully isolated
 *   from each other — no data leakage across parallel test suites.
 *
 * BACKGROUND:
 *   Earlier iterations used process.env.HOME and then process.env.PRISM_DB_PATH
 *   to control which DB file SqliteStorage opened. Both are process-global and
 *   racy when tests run concurrently: suite B can mutate the env var between
 *   suite A's write and suite A's call to initialize().
 *
 *   The current approach passes dbPath directly to initialize(dbPath), which
 *   is an argument-scoped value with zero global state. These tests verify
 *   that guarantee holds even when multiple instances are created in parallel.
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from "vitest";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";

// We import SqliteStorage directly to test the low-level isolation guarantee
// without the createTestDb() helper (which we're also testing indirectly).
import { SqliteStorage } from "../../src/storage/sqlite.js";

/**
 * Creates an ephemeral SqliteStorage at a unique temp path.
 * Returns storage + a cleanup function.
 * This intentionally does NOT use createTestDb() — it tests the primitive.
 */
async function makeIsolatedStorage(label: string) {
  const dir = join(tmpdir(), `prism-isolation-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "data.db");

  const storage = new SqliteStorage();
  await storage.initialize(true, dbPath); // ← direct arg, no env vars

  const cleanup = () => {
    try { (storage as any).close?.(); } catch { /* non-fatal */ }
    try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  };

  return { storage, dbPath, cleanup };
}

describe("SqliteStorage — concurrent instance isolation", { timeout: 30_000 }, () => {
  /**
   * Core regression test: two storages created concurrently must have
   * distinct DB paths and must not share data.
   *
   * If the old env-var approach were in use, one instance could steal
   * the other's path and they'd both write to the same file.
   */
  it("two concurrent instances get distinct DB paths", async () => {
    const [a, b] = await Promise.all([
      makeIsolatedStorage("a"),
      makeIsolatedStorage("b"),
    ]);

    try {
      // Paths must be distinct
      expect(a.dbPath).not.toBe(b.dbPath);

      // Write a unique ledger entry into each DB
      await a.storage.saveLedger({
        project: "project-a",
        user_id: "default",
        conversation_id: "conv-a",
        summary: "Written only to DB A",
        todos: [],
        files_changed: [],
        decisions: [],
      });

      await b.storage.saveLedger({
        project: "project-b",
        user_id: "default",
        conversation_id: "conv-b",
        summary: "Written only to DB B",
        todos: [],
        files_changed: [],
        decisions: [],
      });

      // A's DB must NOT contain B's entry
      const aEntries = await a.storage.getLedgerEntries({ project: "eq.project-b", limit: "5" });
      expect(aEntries.length).toBe(0);

      // B's DB must NOT contain A's entry
      const bEntries = await b.storage.getLedgerEntries({ project: "eq.project-a", limit: "5" });
      expect(bEntries.length).toBe(0);

      // Each DB contains exactly its own entry
      const aOwn = await a.storage.getLedgerEntries({ project: "eq.project-a", limit: "5" });
      expect(aOwn.length).toBe(1);
      expect(aOwn[0].summary).toBe("Written only to DB A");

      const bOwn = await b.storage.getLedgerEntries({ project: "eq.project-b", limit: "5" });
      expect(bOwn.length).toBe(1);
      expect(bOwn[0].summary).toBe("Written only to DB B");
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  /**
   * Stress variant: 5 concurrent instances, each writing unique data.
   * No cross-instance data should appear in any other instance's DB.
   *
   * This would reliably fail if PRISM_DB_PATH were still being used,
   * because one of the 5 concurrent initialize() calls would race.
   */
  it("5 concurrent instances have fully isolated data", async () => {
    const instances = await Promise.all(
      Array.from({ length: 5 }, (_, i) => makeIsolatedStorage(`stress-${i}`))
    );

    try {
      // Write a unique entry to each instance
      await Promise.all(
        instances.map((inst, i) =>
          inst.storage.saveLedger({
            project: `stress-project-${i}`,
            user_id: "default",
            conversation_id: `stress-conv-${i}`,
            summary: `Exclusive entry for instance ${i}`,
            todos: [],
            files_changed: [],
            decisions: [],
          })
        )
      );

      // Each instance must see ONLY its own entry — not any other's
      for (let i = 0; i < instances.length; i++) {
        const own = await instances[i].storage.getLedgerEntries({
          project: `eq.stress-project-${i}`,
          limit: "10",
        });
        expect(own.length).toBe(1);
        expect(own[0].summary).toBe(`Exclusive entry for instance ${i}`);

        // Spot-check: the next instance's project must not appear here
        const neighbour = (i + 1) % instances.length;
        const leaked = await instances[i].storage.getLedgerEntries({
          project: `eq.stress-project-${neighbour}`,
          limit: "5",
        });
        expect(leaked.length).toBe(0);
      }
    } finally {
      instances.forEach(inst => inst.cleanup());
    }
  });

  /**
   * createTestDb() helper itself must produce isolated instances.
   * This tests the full fixture path used by all other test suites.
   */
  it("createTestDb() produces independent isolated instances", async () => {
    const { createTestDb } = await import("../helpers/fixtures.js");

    const [db1, db2] = await Promise.all([
      createTestDb("isolation-1"),
      createTestDb("isolation-2"),
    ]);

    try {
      expect(db1.dbPath).not.toBe(db2.dbPath);

      await db1.storage.saveLedger({
        project: "fixture-project-1",
        user_id: "default",
        conversation_id: "fconv-1",
        summary: "Only in fixture DB 1",
        todos: [],
        files_changed: [],
        decisions: [],
      });

      const leakedInDb2 = await db2.storage.getLedgerEntries({
        project: "eq.fixture-project-1",
        limit: "5",
      });
      expect(leakedInDb2.length).toBe(0);
    } finally {
      db1.cleanup();
      db2.cleanup();
    }
  });
});
