/**
 * Cross-Backend Handoff & Ledger Reconciliation Tests (v9.2.4)
 *
 * Verifies that reconcileHandoffs() correctly detects stale local
 * data and syncs newer handoffs AND recent ledger entries from Supabase.
 *
 * NOTE: These tests mock Supabase REST calls — no real network required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reconcileHandoffs } from "../../src/storage/reconcile.js";
import { SqliteStorage } from "../../src/storage/sqlite.js";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

// Mock the supabaseApi module
vi.mock("../../src/utils/supabaseApi.js", () => ({
  supabaseGet: vi.fn(),
  supabasePost: vi.fn(),
  supabaseRpc: vi.fn(),
  supabasePatch: vi.fn(),
  supabaseDelete: vi.fn(),
}));

import { supabaseGet } from "../../src/utils/supabaseApi.js";
const mockSupabaseGet = vi.mocked(supabaseGet);

describe("Cross-Backend Handoff & Ledger Reconciliation", () => {
  let storage: SqliteStorage;
  let dbPath: string;

  beforeEach(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-reconcile-"));
    dbPath = path.join(tmpDir, "test.db");
    storage = new SqliteStorage();
    await storage.initialize(true, dbPath);
    mockSupabaseGet.mockReset();
  });

  afterEach(async () => {
    await storage.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + "-wal"); } catch {}
    try { fs.unlinkSync(dbPath + "-shm"); } catch {}
  });

  // ═══════════════════════════════════════════════════════
  // LAYER 1: Handoff Reconciliation
  // ═══════════════════════════════════════════════════════

  it("should sync a newer remote handoff into empty local SQLite", async () => {
    mockSupabaseGet.mockResolvedValueOnce([{
      project: "prism-mcp",
      user_id: "default",
      role: "global",
      last_summary: "Grant applications submitted — $487K pipeline",
      pending_todo: ["Watch inbox for EV response"],
      active_decisions: ["Support-only mode until financing approved"],
      keywords: ["grants", "funding", "STF", "SFF"],
      key_context: "Prism MCP v9.2.3",
      active_branch: "main",
      version: 5,
      metadata: {},
      updated_at: "2026-04-09T22:00:00Z",
    }]);
    mockSupabaseGet.mockResolvedValueOnce([]);

    const getTimestamps = () => storage.getHandoffTimestamps();
    const result = await reconcileHandoffs(storage, getTimestamps);

    expect(result.checked).toBe(1);
    expect(result.synced).toBe(1);
    expect(result.projects).toContain("prism-mcp");

    const context = await storage.loadContext("prism-mcp", "standard", "default");
    expect(context).not.toBeNull();
    expect((context as any).last_summary).toContain("Grant applications");
  });

  it("should NOT sync when local is newer than remote", async () => {
    await storage.saveHandoff({
      project: "prism-mcp",
      user_id: "default",
      role: "global",
      last_summary: "Local is latest — v9.2.4 hardening",
      pending_todo: ["Local task"],
      keywords: ["local"],
    });

    mockSupabaseGet.mockResolvedValueOnce([{
      project: "prism-mcp",
      user_id: "default",
      role: "global",
      last_summary: "Old remote summary",
      pending_todo: [],
      active_decisions: [],
      keywords: [],
      key_context: null,
      active_branch: null,
      version: 1,
      metadata: {},
      updated_at: "2020-01-01T00:00:00Z",
    }]);

    const getTimestamps = () => storage.getHandoffTimestamps();
    const result = await reconcileHandoffs(storage, getTimestamps);

    expect(result.checked).toBe(1);
    expect(result.synced).toBe(0);
    expect(result.ledgerEntriesSynced).toBe(0);

    const context = await storage.loadContext("prism-mcp", "standard", "default");
    expect((context as any).last_summary).toContain("Local is latest");
  });

  it("should sync when remote is newer than local", async () => {
    await storage.saveHandoff({
      project: "prism-mcp",
      user_id: "default",
      role: "global",
      last_summary: "Old local summary from dual-path fix",
      pending_todo: ["Test dual-path startup"],
      keywords: ["old"],
    });

    mockSupabaseGet.mockResolvedValueOnce([{
      project: "prism-mcp",
      user_id: "default",
      role: "global",
      last_summary: "All 4 cash grants submitted — $487K pipeline",
      pending_todo: ["Watch inbox for EV response", "LTFF decision in 4-6 weeks"],
      active_decisions: ["Support-only mode"],
      keywords: ["grants", "STF", "SFF", "EV", "LTFF"],
      key_context: "Prism MCP v9.2.3 — support only",
      active_branch: "main",
      version: 5,
      metadata: {},
      updated_at: new Date(Date.now() + 86400000).toISOString(),
    }]);
    mockSupabaseGet.mockResolvedValueOnce([]);

    const getTimestamps = () => storage.getHandoffTimestamps();
    const result = await reconcileHandoffs(storage, getTimestamps);

    expect(result.checked).toBe(1);
    expect(result.synced).toBe(1);

    const context = await storage.loadContext("prism-mcp", "standard", "default");
    expect((context as any).last_summary).toContain("$487K pipeline");
    expect((context as any).pending_todo).toContain("Watch inbox for EV response");
  });

  it("should handle Supabase being unreachable (offline mode)", async () => {
    mockSupabaseGet.mockRejectedValueOnce(new Error("Network unreachable"));

    const getTimestamps = () => storage.getHandoffTimestamps();
    const result = await reconcileHandoffs(storage, getTimestamps);

    expect(result.checked).toBe(0);
    expect(result.synced).toBe(0);
    expect(result.ledgerEntriesSynced).toBe(0);
  });

  it("should handle empty Supabase response", async () => {
    mockSupabaseGet.mockResolvedValueOnce([]);

    const getTimestamps = () => storage.getHandoffTimestamps();
    const result = await reconcileHandoffs(storage, getTimestamps);

    expect(result.checked).toBe(0);
    expect(result.synced).toBe(0);
  });

  it("should handle multiple projects — only sync stale ones", async () => {
    await storage.saveHandoff({
      project: "project-a",
      user_id: "default",
      last_summary: "Project A local (up to date)",
      pending_todo: [],
    });
    await storage.saveHandoff({
      project: "project-b",
      user_id: "default",
      last_summary: "Project B local (stale)",
      pending_todo: [],
    });

    const futureDate = new Date(Date.now() + 86400000).toISOString();

    mockSupabaseGet.mockResolvedValueOnce([
      {
        project: "project-a",
        user_id: "default",
        role: "global",
        last_summary: "Project A remote (old)",
        pending_todo: [],
        active_decisions: [],
        keywords: [],
        key_context: null,
        active_branch: null,
        version: 1,
        metadata: {},
        updated_at: "2020-01-01T00:00:00Z",
      },
      {
        project: "project-b",
        user_id: "default",
        role: "global",
        last_summary: "Project B remote (newer!)",
        pending_todo: ["New remote task"],
        active_decisions: [],
        keywords: ["updated"],
        key_context: null,
        active_branch: null,
        version: 3,
        metadata: {},
        updated_at: futureDate,
      },
    ]);
    mockSupabaseGet.mockResolvedValueOnce([]);

    const getTimestamps = () => storage.getHandoffTimestamps();
    const result = await reconcileHandoffs(storage, getTimestamps);

    expect(result.checked).toBe(2);
    expect(result.synced).toBe(1);
    expect(result.projects).toEqual(["project-b"]);

    const contextA = await storage.loadContext("project-a", "standard", "default");
    expect((contextA as any).last_summary).toContain("Project A local");

    const contextB = await storage.loadContext("project-b", "standard", "default");
    expect((contextB as any).last_summary).toContain("Project B remote");
  });

  it("should work without getLocalTimestamps (fallback syncs all)", async () => {
    mockSupabaseGet.mockResolvedValueOnce([{
      project: "fallback-test",
      user_id: "default",
      role: "global",
      last_summary: "Synced via fallback path",
      pending_todo: [],
      active_decisions: [],
      keywords: [],
      key_context: null,
      active_branch: null,
      version: 1,
      metadata: {},
      updated_at: "2026-04-09T22:00:00Z",
    }]);
    mockSupabaseGet.mockResolvedValueOnce([]);

    const result = await reconcileHandoffs(storage);

    expect(result.synced).toBe(1);
    expect(result.projects).toContain("fallback-test");
  });

  // ═══════════════════════════════════════════════════════
  // LAYER 2: Ledger Reconciliation
  // ═══════════════════════════════════════════════════════

  it("should sync recent ledger entries for stale projects", async () => {
    mockSupabaseGet.mockResolvedValueOnce([{
      project: "prism-mcp",
      user_id: "default",
      role: "global",
      last_summary: "Grant session — all submitted",
      pending_todo: [],
      active_decisions: [],
      keywords: [],
      key_context: null,
      active_branch: null,
      version: 5,
      metadata: {},
      updated_at: new Date(Date.now() + 86400000).toISOString(),
    }]);

    mockSupabaseGet.mockResolvedValueOnce([
      {
        id: "ledger-001",
        project: "prism-mcp",
        conversation_id: "conv-grant-1",
        summary: "Submitted STF grant application for €300K",
        user_id: "default",
        role: "global",
        todos: ["Track STF timeline"],
        files_changed: [],
        decisions: ["Focus on infrastructure angle"],
        keywords: ["STF", "grant", "EU"],
        event_type: "session",
        importance: 0,
        created_at: "2026-04-08T15:00:00Z",
        session_date: "2026-04-08T15:00:00Z",
      },
      {
        id: "ledger-002",
        project: "prism-mcp",
        conversation_id: "conv-grant-2",
        summary: "Sent Anthropic outreach email to Alex Albert",
        user_id: "default",
        role: "global",
        todos: ["Follow up if no response in 2 weeks"],
        files_changed: [],
        decisions: ["Use devrel@ and personal email"],
        keywords: ["Anthropic", "outreach", "email"],
        event_type: "session",
        importance: 0,
        created_at: "2026-04-08T18:00:00Z",
        session_date: "2026-04-08T18:00:00Z",
      },
    ]);

    const getTimestamps = () => storage.getHandoffTimestamps();
    const result = await reconcileHandoffs(storage, getTimestamps);

    expect(result.synced).toBe(1);
    expect(result.ledgerEntriesSynced).toBe(2);

    const entries = await storage.getLedgerEntries({
      project: `eq.prism-mcp`,
      user_id: `eq.default`,
    });
    const entryList = entries as any[];
    expect(entryList.length).toBeGreaterThanOrEqual(2);

    const anthropicEntry = entryList.find(
      (e: any) => e.summary?.includes("Anthropic")
    );
    expect(anthropicEntry).toBeDefined();
    expect(anthropicEntry.summary).toContain("Alex Albert");
  });

  it("should NOT duplicate ledger entries that already exist locally", async () => {
    await storage.saveLedger({
      id: "ledger-existing",
      project: "prism-mcp",
      conversation_id: "conv-local",
      summary: "Already exists locally",
      user_id: "default",
      role: "global",
      todos: [],
      keywords: [],
    });

    mockSupabaseGet.mockResolvedValueOnce([{
      project: "prism-mcp",
      user_id: "default",
      role: "global",
      last_summary: "Updated remote",
      pending_todo: [],
      active_decisions: [],
      keywords: [],
      key_context: null,
      active_branch: null,
      version: 2,
      metadata: {},
      updated_at: new Date(Date.now() + 86400000).toISOString(),
    }]);

    mockSupabaseGet.mockResolvedValueOnce([
      {
        id: "ledger-existing",
        project: "prism-mcp",
        conversation_id: "conv-local",
        summary: "Already exists locally",
        user_id: "default",
        role: "global",
        todos: [],
        files_changed: [],
        decisions: [],
        keywords: [],
        event_type: "session",
        importance: 0,
        created_at: "2026-04-07T10:00:00Z",
        session_date: "2026-04-07T10:00:00Z",
      },
      {
        id: "ledger-new",
        project: "prism-mcp",
        conversation_id: "conv-remote",
        summary: "New from Supabase",
        user_id: "default",
        role: "global",
        todos: [],
        files_changed: [],
        decisions: [],
        keywords: [],
        event_type: "session",
        importance: 0,
        created_at: "2026-04-08T10:00:00Z",
        session_date: "2026-04-08T10:00:00Z",
      },
    ]);

    const getTimestamps = () => storage.getHandoffTimestamps();
    const result = await reconcileHandoffs(storage, getTimestamps);

    expect(result.ledgerEntriesSynced).toBe(1);
  });

  it("should skip ledger sync for up-to-date projects", async () => {
    await storage.saveHandoff({
      project: "prism-mcp",
      user_id: "default",
      last_summary: "Local is fresh",
      pending_todo: [],
    });

    mockSupabaseGet.mockResolvedValueOnce([{
      project: "prism-mcp",
      user_id: "default",
      role: "global",
      last_summary: "Old remote",
      pending_todo: [],
      active_decisions: [],
      keywords: [],
      key_context: null,
      active_branch: null,
      version: 1,
      metadata: {},
      updated_at: "2020-01-01T00:00:00Z",
    }]);

    const getTimestamps = () => storage.getHandoffTimestamps();
    const result = await reconcileHandoffs(storage, getTimestamps);

    expect(result.synced).toBe(0);
    expect(result.ledgerEntriesSynced).toBe(0);
    expect(mockSupabaseGet).toHaveBeenCalledTimes(1);
  });

  // ═══════════════════════════════════════════════════════
  // EDGE CASES (from code review)
  // ═══════════════════════════════════════════════════════

  it("should handle malformed JSON in handoff fields without crashing", async () => {
    mockSupabaseGet.mockResolvedValueOnce([{
      project: "corrupt-test",
      user_id: "default",
      role: "global",
      last_summary: "Valid summary",
      pending_todo: "{not valid json[",         // Malformed JSON string
      active_decisions: "also broken {{{",       // Malformed JSON string
      keywords: null,                            // null
      key_context: "some context",
      active_branch: null,
      version: 1,
      metadata: null,                            // null metadata
      updated_at: new Date(Date.now() + 86400000).toISOString(),
    }]);
    mockSupabaseGet.mockResolvedValueOnce([]);

    const getTimestamps = () => storage.getHandoffTimestamps();
    const result = await reconcileHandoffs(storage, getTimestamps);

    // Should sync successfully despite malformed fields — defaults to []
    expect(result.synced).toBe(1);

    const context = await storage.loadContext("corrupt-test", "standard", "default");
    expect(context).not.toBeNull();
    expect((context as any).last_summary).toContain("Valid summary");
    // pending_todo should default to empty array, not crash
    expect((context as any).pending_todo).toEqual([]);
  });

  it("should deduplicate multi-role projects in ledger sync", async () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString();

    // Same project, two roles — both stale
    mockSupabaseGet.mockResolvedValueOnce([
      {
        project: "multi-role",
        user_id: "default",
        role: "global",
        last_summary: "Global role",
        pending_todo: [],
        active_decisions: [],
        keywords: [],
        key_context: null,
        active_branch: null,
        version: 1,
        metadata: {},
        updated_at: futureDate,
      },
      {
        project: "multi-role",
        user_id: "default",
        role: "dev",
        last_summary: "Dev role",
        pending_todo: [],
        active_decisions: [],
        keywords: [],
        key_context: null,
        active_branch: null,
        version: 1,
        metadata: {},
        updated_at: futureDate,
      },
    ]);
    // Only ONE ledger call should happen (deduped project)
    mockSupabaseGet.mockResolvedValueOnce([]);

    const getTimestamps = () => storage.getHandoffTimestamps();
    const result = await reconcileHandoffs(storage, getTimestamps);

    expect(result.synced).toBe(2); // Both roles synced
    // But supabaseGet should be called exactly 2 times:
    //   1. handoffs fetch
    //   2. ledger fetch for "multi-role" (ONCE, not twice)
    expect(mockSupabaseGet).toHaveBeenCalledTimes(2);
  });

  it("should handle Supabase timeout gracefully", async () => {
    // Simulate a slow Supabase that never resolves
    mockSupabaseGet.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(resolve, 60_000))
    );

    const getTimestamps = () => storage.getHandoffTimestamps();
    const start = Date.now();
    const result = await reconcileHandoffs(storage, getTimestamps);
    const elapsed = Date.now() - start;

    // Should timeout at ~5s, not hang for 60s
    expect(elapsed).toBeLessThan(10_000);
    expect(result.synced).toBe(0);
    expect(result.checked).toBe(0);
  });
});
