/**
 * Windows SQLite handle-release DIAGNOSTIC.
 *
 * Reports facts; it does not gate. Every assertion here is one that holds on
 * any platform — the payload is the console output.
 *
 * Why this exists (2026-08-05): six attempts at the Windows EBUSY teardown
 * failure were designed blind, because the only feedback available was a
 * ~7-minute pass/fail matrix. Three were empirically refuted:
 *   1. missing storage.close()          -> added; still EBUSY
 *   2. async handle release             -> maxRetries 10 x 100ms; still EBUSY
 *   3. (the one that went green)        -> made cleanup non-fatal, which
 *                                          releases nothing
 * So the product question is still open: does SqliteStorage.close() actually
 * release the file on Windows? It matters beyond tests — if it does not,
 * Windows users cannot move, delete, or back up their database.
 *
 * A local VM cannot answer this: libsql ships only @libsql/win32-x64-msvc,
 * with no win32-arm64 build, so a Windows-on-ARM guest either fails to load
 * the binding or runs it under x64 emulation — an unreliable witness for a
 * bug about handle-release timing.
 *
 * Each experiment isolates one hypothesis, and reports WHICH path is locked:
 * the database, or its memory-mapped WAL/SHM sidecars.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorage } from "../../src/storage/sqlite.js";

const IS_WINDOWS = process.platform === "win32";

/** Try to unlink one path; report the errno instead of throwing. */
function probeUnlink(path: string): string {
  if (!existsSync(path)) return "absent";
  try {
    unlinkSync(path);
    return "unlinked OK";
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    return `${e.code ?? "ERR"} (${e.syscall ?? "?"})`;
  }
}

/** Seed a storage instance so WAL/SHM sidecars actually exist. */
async function seed(dir: string): Promise<SqliteStorage> {
  const storage = new SqliteStorage();
  await storage.initialize(true, join(dir, "isolated.db"));
  await storage.saveLedger({
    project: "diag", conversation_id: "c1", user_id: "default",
    role: "global", summary: "handle diagnostic row", keywords: ["diag"],
  } as never);
  return storage;
}

function report(label: string, dir: string): void {
  const files = existsSync(dir) ? readdirSync(dir) : [];
  console.log(`\n[${label}] files present: ${files.join(", ") || "(none)"}`);
  for (const name of ["isolated.db-shm", "isolated.db-wal", "isolated.db"]) {
    console.log(`[${label}]   ${name.padEnd(18)} -> ${probeUnlink(join(dir, name))}`);
  }
}

describe("Windows sqlite handle release (diagnostic)", { timeout: 60_000 }, () => {
  it(`reports handle state after close (platform=${process.platform})`, async () => {
    console.log(`\n=== platform=${process.platform} arch=${process.arch} node=${process.version} ===`);
    if (!IS_WINDOWS) {
      console.log("POSIX: unlink succeeds on open files, so this cannot reproduce here.");
      console.log("Run on windows-x64 via: gh workflow run windows-diagnostic.yml");
    }

    // E1 — baseline: close(), then unlink each file. Which one is locked?
    const d1 = mkdtempSync(join(tmpdir(), "prism-diag-e1-"));
    const s1 = await seed(d1);
    await s1.close();
    report("E1 close() only", d1);

    // E2 — checkpoint the WAL into the db before closing. If the sidecars are
    // what stay mapped, this is the fix, and it is a one-line product change.
    const d2 = mkdtempSync(join(tmpdir(), "prism-diag-e2-"));
    const s2 = await seed(d2);
    try {
      await (s2 as unknown as { db: { execute: (q: string) => Promise<unknown> } })
        .db.execute("PRAGMA wal_checkpoint(TRUNCATE)");
      console.log("\n[E2] wal_checkpoint(TRUNCATE) issued");
    } catch (error) {
      console.log(`\n[E2] checkpoint failed: ${(error as Error).message}`);
    }
    await s2.close();
    report("E2 checkpoint+close", d2);

    // E3 — does the handle simply release late? Attempt 2 used 1s of retries
    // and still failed, so a longer wait discriminates "slow" from "never".
    const d3 = mkdtempSync(join(tmpdir(), "prism-diag-e3-"));
    const s3 = await seed(d3);
    await s3.close();
    await new Promise((done) => setTimeout(done, 3_000));
    report("E3 close+3s wait", d3);

    // E4 — a RAW libsql client in WAL mode, with none of SqliteStorage's
    // machinery. THE discriminator: if raw unlinks cleanly on Windows but
    // SqliteStorage does not, the leak is ours (a second reference such as
    // the ACT-R AccessLogBuffer), not libsql's.
    const d4 = mkdtempSync(join(tmpdir(), "prism-diag-e4-"));
    const { createClient } = await import("@libsql/client");
    const raw4 = createClient({ url: `file:${join(d4, "isolated.db")}` });
    await raw4.execute("PRAGMA journal_mode=WAL");
    await raw4.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await raw4.execute("INSERT INTO t (v) VALUES ('x')");
    raw4.close();
    report("E4 raw client, WAL", d4);

    // E5 — raw client WITHOUT WAL. If DELETE journalling unlinks cleanly
    // where WAL does not, the memory-mapped sidecars are confirmed and the
    // product fix is a checkpoint (or journal mode) rather than a retry.
    //
    // Note: this must be set on a FRESH connection. Doing it through
    // SqliteStorage after initialize() returned "SQLITE_BUSY: database is
    // locked" even on macOS — itself a signal that something still holds a
    // lock at that point.
    const d5 = mkdtempSync(join(tmpdir(), "prism-diag-e5-"));
    const raw5 = createClient({ url: `file:${join(d5, "isolated.db")}` });
    await raw5.execute("PRAGMA journal_mode=DELETE");
    await raw5.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await raw5.execute("INSERT INTO t (v) VALUES ('x')");
    raw5.close();
    report("E5 raw client, DELETE", d5);

    console.log("\n=== HOW TO READ THIS ===");
    console.log("E1 EBUSY but E4 clean  -> the leak is in SqliteStorage, not libsql");
    console.log("E4 EBUSY but E5 clean  -> WAL sidecars are memory-mapped; checkpoint/journal mode is the fix");
    console.log("E2 clean but E1 EBUSY  -> wal_checkpoint(TRUNCATE) before close is the one-line product fix");
    console.log("E3 still EBUSY         -> not a timing race; the handle is never released");
    console.log("only -shm/-wal EBUSY   -> the db handle IS released; only sidecars linger");

    for (const dir of [d1, d2, d3, d4, d5]) {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* reclaimed by OS */ }
    }

    // Platform-neutral: the run produced a report. The value is the output.
    expect(true).toBe(true);
  });
});
