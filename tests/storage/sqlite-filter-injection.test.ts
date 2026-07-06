/**
 * Bug 8.1 regression — SQL injection via unvalidated filter column names
 * in SqliteStorage.parsePostgRESTFilters().
 *
 * Root cause: `key` from Object.entries(params) was interpolated directly
 * into the SQL WHERE clause without any validation. Values were parameterized
 * (safe), but an unvalidated key like "1=1 OR id" would inject arbitrary SQL.
 *
 * Fix: ALLOWED_FILTER_COLUMNS static allowlist added. Any key not in the set
 * throws before the operator-handling switch — defense in depth on top of
 * parameterized values.
 *
 * These tests must FAIL without the fix and PASS with it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb } from "../helpers/fixtures.js";

let storage: any;
let cleanup: () => void;

beforeAll(async () => {
  const testDb = await createTestDb("filter-injection");
  storage = testDb.storage;
  cleanup = testDb.cleanup;
}, 15_000);

afterAll(() => cleanup());

function parse(params: Record<string, string>) {
  return (storage as any).parsePostgRESTFilters(params);
}

describe("Bug 8.1 — ALLOWED_FILTER_COLUMNS blocks SQL injection", () => {
  it("throws for arbitrary unknown column names", () => {
    expect(() => parse({ evil_col: "eq.x" })).toThrow(
      /rejected unknown filter column "evil_col"/
    );
  });

  it("throws for SQL injection via key — space-separated condition", () => {
    expect(() => parse({ "1=1 OR id": "eq.anything" })).toThrow(
      /rejected unknown filter column/
    );
  });

  it("throws for SQL injection via key — semicolon statement terminator", () => {
    expect(() =>
      parse({ "id; DROP TABLE ledger_entries; --": "eq.x" })
    ).toThrow(/rejected unknown filter column/);
  });

  it("throws for SQL injection via key — UNION SELECT payload", () => {
    expect(() =>
      parse({ "id UNION SELECT * FROM sqlite_master--": "eq.x" })
    ).toThrow(/rejected unknown filter column/);
  });

  it("throws for camelCase that is not in the allowlist", () => {
    expect(() => parse({ userId: "eq.u-1" })).toThrow(
      /rejected unknown filter column "userId"/
    );
  });
});

describe("Bug 8.1 — allowed columns pass through without throwing", () => {
  it("allows project eq filter", () => {
    expect(() => parse({ project: "eq.my-app" })).not.toThrow();
  });

  it("allows user_id eq filter", () => {
    expect(() => parse({ user_id: "eq.u-1" })).not.toThrow();
  });

  it("allows archived_at is.null filter", () => {
    expect(() => parse({ archived_at: "is.null" })).not.toThrow();
  });

  it("allows embedding is.null filter", () => {
    expect(() => parse({ embedding: "is.null" })).not.toThrow();
  });

  it("allows importance gt filter", () => {
    expect(() => parse({ importance: "gt.0.5" })).not.toThrow();
  });

  it("allows confidence_score gte filter", () => {
    expect(() => parse({ confidence_score: "gte.0.8" })).not.toThrow();
  });

  it("allows multiple allowed filters in combination", () => {
    expect(() =>
      parse({ project: "eq.my-app", archived_at: "is.null", importance: "gt.0.3" })
    ).not.toThrow();
  });

  it("select, order, and limit are special params — not filtered through allowlist", () => {
    expect(() => parse({ select: "*", order: "created_at.desc", limit: "10" })).not.toThrow();
  });
});
