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
    // Create a temp DB for each test
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-reconcile-"));
    dbPath = path.join(tmpDir, "test.db");
    storage = new SqliteStorage();
    await storage.initialize(dbPath);
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
    // supabaseGet call 1: handoffs
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
    // supabaseGet call 2: ledger for synced project
    mockSupabaseGet.mockResolvedValueOnce([]);

    const getTimestamps = () => storage.getHandoffTimestamps();
    const result = await reconcileHandoffs(storage, getTimestamps);

    expect(result.checked).toBe(1);
    expect(result.synced).toBe(1);
    expect(result.projects).toContain("prism-mcp");

    // Verify the handoff was written to local SQLite
    const context = await storage.loadContext("prism-mcp", "standard", "default");
    expect(context).not.toBeNull();
    expect((context as any).last_summary).toContain("Grant applications");
  });

  it("should NOT sync when local is newer than remote", async () => {
    // Save a local handoff first
    await storage.saveHandoff({
      project: "prism-mcp",
      user_id: "default",
      role: "global",
      last_summary: "Local is latest — v9.2.4 hardening",
      pending_todo: ["Local task"],
      keywords: ["local"],
    });

    // Remote has an OLDER handoff
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
      updated_at: "2020-01-01T00:00:00Z", // Very old
    }]);

    const getTimestamps = () => storage.getHandoffTimestamps();
    const result = await reconcileHandoffs(storage, getTimestamps);

    expect(result.checked).toBe(1);
    expect(result.synced).toBe(0);
    expect(result.ledgerEntriesSynced).toBe(0);

    // Verify local data is unchanged
    const context = await storage.loadContext("prism-mcp", "standard", "default");
    expect((context as any).last_summary).toContain("Local is latest");
  });

  it("should sync when remote is newer than local", async () => {
    // Save a local handoff first
    await storage.saveHandoff({
      project: "prism-mcp",
      user_id: "default",
      role: "global",
      last_summary: "Old local summary from dual-path fix",
      pending_todo: ["Test dual-path startup"],
      keywords: ["old"],
    });

    // Remote has a NEWER handoff
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
      updated_at: new Date(Date.now() + 86400000).toISOString(), // Tomorrow
    }]);
    // supabaseGet call 2: ledger for synced project
    mockSupabaseGet.mockResolvedValueOnce([]);

    const getTimestamps = () => storage.getHandoffTimestamps();
    const result = await reconcileHandoffs(storage, getTimestamps);

    expect(result.checked).toBe(1);
    expect(result.synced).toBe(1);

    // Verify local was updated with remote data
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
    // Local has two projects
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

    // supabaseGet call 1: handoffs
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
        updated_at: "2020-01-01T00:00:00Z", // Older than local
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
        updated_at: futureDate, // Newer than local
      },
    ]);
    // supabaseGet call 2: ledger for project-b (only synced project)
    mockSupabaseGet.mockResolvedValueOnce([]);

    const getTimestamps = () => storage.getHandoffTimestamps();
    const result = await reconcileHandoffs(storage, getTimestamps);

    expect(result.checked).toBe(2);
    expect(result.synced).toBe(1); // Only project-b
    expect(result.projects).toEqual(["project-b"]);

    // Verify project-a unchanged, project-b updated
    const contextA = await storage.loadContext("project-a", "standard", "default");
    expect((contextA as any).last_summary).toContain("Project A local");

    const contextB = await storage.loadContext("project-b", "standard", "default");
    expect((contextB as any).last_summary).toContain("Project B remote");
  });

  it("should work without getLocalTimestamps (fallback syncs all)", async () => {
    // supabaseGet call 1: handoffs
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
    // supabaseGet call 2: ledger
    mockSupabaseGet.mockResolvedValueOnce([]);

    // No getLocalTimestamps provided — should still sync
    const result = await reconcileHandoffs(storage);

    expect(result.synced).toBe(1);
    expect(result.projects).toContain("fallback-test");
  });

  // ═══════════════════════════════════════════════════════
  // LAYER 2: Ledger Reconciliation (recent session history)
  // ═══════════════════════════════════════════════════════

  it("should sync recent ledger entries for stale projects", async () => {
    // supabaseGet call 1: handoffs — remote is newer
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

    // supabaseGet call 2: ledger entries for prism-mcp
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

    // Verify ledger entries exist locally via direct query
    const entries = await storage.getLedgerEntries({
      project: `eq.prism-mcp`,
      user_id: `eq.default`,
    });
    const entryList = entries as any[];
    expect(entryList.length).toBeGreaterThanOrEqual(2);

    // Verify the Anthropic outreach entry is in the ledger
    const anthropicEntry = entryList.find(
      (e: any) => e.summary?.includes("Anthropic")
    );
    expect(anthropicEntry).toBeDefined();
    expect(anthropicEntry.summary).toContain("Alex Albert");
  });

  it("should NOT duplicate ledger entries that already exist locally", async () => {
    // Pre-populate local with one ledger entry
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

    // supabaseGet call 1: handoff
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

    // supabaseGet call 2: ledger — includes the entry that already exists
    mockSupabaseGet.mockResolvedValueOnce([
      {
        id: "ledger-existing", // Same ID as local
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
        id: "ledger-new", // New entry
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

    // Only the new entry should be synced
    expect(result.ledgerEntriesSynced).toBe(1);
  });

  it("should skip ledger sync for up-to-date projects", async () => {
    // Local is newer — no handoff sync needed
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

    // No sync happened — supabaseGet should only be called once (handoffs)
    // Ledger REST call should NOT have happened
    expect(result.synced).toBe(0);
    expect(result.ledgerEntriesSynced).toBe(0);
    expect(mockSupabaseGet).toHaveBeenCalledTimes(1);
  });
});
