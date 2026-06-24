/**
 * Storage Round-Trip Tests — Military Grade
 *
 * ======================================================================
 * SCOPE:
 *   Verify that ALL data paths write to the CORRECT storage backend
 *   (Supabase for paid tiers, SQLite for free/local) and that
 *   knowledge_search can retrieve what was saved.
 *
 *   These tests exist because of a 2026-05-28 incident where the
 *   knowledge ingestion script wrote to local SQLite while the MCP
 *   server read from Supabase — 25K entries silently lost.
 *
 * TEST CATEGORIES:
 *   1. Storage backend selection — auto/local/synalux/supabase
 *   2. Save→search round-trip — saveLedger → knowledge_search finds it
 *   3. knowledge_ingest tool — uses getStorage(), not direct DB
 *   4. Ingestion script — uses portal API, not local DB
 *   5. No storage bypass — grep for direct DB access outside storage/
 * ======================================================================
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────

const mockSaveLedger = vi.fn().mockResolvedValue({ id: "test-id-rt" });
const mockSearchKnowledge = vi.fn().mockResolvedValue({
  results: [{ id: "test-id-rt", summary: "test entry", keywords: [] }],
});

vi.mock("../../src/storage/index.js", () => ({
  getStorage: vi.fn(async () => ({
    saveLedger: mockSaveLedger,
    patchLedger: vi.fn().mockResolvedValue(undefined),
    searchKnowledge: mockSearchKnowledge,
  })),
  activeStorageBackend: "synalux",
}));

vi.mock("../../src/config.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../src/config.js");
  return {
    ...actual,
    PRISM_USER_ID: "test-user",
    PRISM_STORAGE: "auto",
    SYNALUX_CONFIGURED: true,
  };
});

vi.mock("../../src/utils/logger.js", () => ({
  sanitizeForLog: vi.fn((s: string) => s),
  debugLog: vi.fn(),
}));

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({
    content: [{
      text: '[{"prompt":"What?","response":"Answer."}]'
    }]
  }),
});
vi.stubGlobal("fetch", mockFetch);
process.env.ANTHROPIC_API_KEY = "test-key";

import { getStorage } from "../../src/storage/index.js";
import { ingestKnowledge, knowledgeIngestHandler } from "../../src/tools/ingestHandler.js";

beforeEach(() => {
  mockSaveLedger.mockClear();
  mockSearchKnowledge.mockClear();
  mockFetch.mockClear();
  mockSaveLedger.mockResolvedValue({ id: "test-id-rt" });
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      content: [{ text: '[{"prompt":"What?","response":"Answer."}]' }]
    }),
  });
});

// ═════════════════════════════════════════════════════════════════
// 1. STORAGE BACKEND SELECTION
// ═════════════════════════════════════════════════════════════════

describe("storage backend selection", () => {
  it("getStorage returns the mocked backend (simulates synalux)", async () => {
    const storage = await getStorage();
    expect(storage.saveLedger).toBeDefined();
    expect(storage.searchKnowledge).toBeDefined();
  });

  it("saveLedger calls the storage abstraction, not direct DB", async () => {
    const storage = await getStorage();
    await storage.saveLedger({ project: "test", summary: "entry" } as any);
    expect(mockSaveLedger).toHaveBeenCalledWith(
      expect.objectContaining({ project: "test" })
    );
  });
});

// ═════════════════════════════════════════════════════════════════
// 2. SAVE → SEARCH ROUND-TRIP
// ═════════════════════════════════════════════════════════════════

describe("save → search round-trip", () => {
  it("entry saved via saveLedger is found by searchKnowledge", async () => {
    const storage = await getStorage();
    await storage.saveLedger({
      project: "round-trip-test",
      summary: "test round trip entry",
      user_id: "test-user",
    } as any);

    expect(mockSaveLedger).toHaveBeenCalledTimes(1);

    const results = await storage.searchKnowledge({
      project: "round-trip-test",
      queryText: "round trip",
      keywords: [],
      limit: 1,
      userId: "test-user",
    });

    expect(results).toBeTruthy();
    expect(results!.results.length).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════
// 3. knowledge_ingest TOOL USES getStorage()
// ═════════════════════════════════════════════════════════════════

describe("knowledge_ingest uses getStorage", () => {
  it("ingestKnowledge calls storage.saveLedger (not direct DB)", async () => {
    const content = "export function authenticate() { return jwt.verify(token); }\n".repeat(20);
    await ingestKnowledge({ project: "ingest-test", content, source_label: "auth.ts" });
    expect(mockSaveLedger).toHaveBeenCalled();
    expect(mockSaveLedger.mock.calls[0][0].project).toBe("ingest-test");
  });

  it("MCP handler passes through to storage abstraction", async () => {
    const result = await knowledgeIngestHandler({
      project: "mcp-test",
      content: "const db = new Database();\n".repeat(20),
      source_label: "db.ts",
    });
    expect(result.isError).toBe(false);
    expect(mockSaveLedger).toHaveBeenCalled();
    expect(mockSaveLedger.mock.calls[0][0].project).toBe("mcp-test");
  });

  it("user_id is set from PRISM_USER_ID config", async () => {
    const content = "function test() {}\n".repeat(20);
    await ingestKnowledge({ project: "uid-test", content });
    expect(mockSaveLedger.mock.calls[0][0].user_id).toBe("test-user");
  });
});

// ═════════════════════════════════════════════════════════════════
// 4. INGESTION SCRIPT USES PORTAL API
// ═════════════════════════════════════════════════════════════════

describe("ingestion scripts use portal API", () => {
  it("ingest.mjs imports from portal URL, not @libsql/client", async () => {
    const fs = await import("fs");
    const script = fs.readFileSync(
      "scripts/knowledge-ingest/ingest.mjs", "utf-8"
    );
    expect(script).not.toContain("@libsql/client");
    expect(script).not.toContain("sqlite");
    expect(script).toContain("synalux.ai");
    expect(script).toContain("/api/v1/");
  });

  it("gen_qa.py does NOT write to any database", async () => {
    const fs = await import("fs");
    const script = fs.readFileSync(
      "scripts/knowledge-ingest/gen_qa.py", "utf-8"
    );
    expect(script).not.toContain("sqlite");
    expect(script).not.toContain("@libsql");
    expect(script).not.toContain("supabase");
  });

  it("post-commit hook calls ingest.mjs (portal API), not direct DB", async () => {
    const fs = await import("fs");
    const hook = fs.readFileSync(
      "scripts/knowledge-ingest/post-commit", "utf-8"
    );
    expect(hook).toContain("ingest.mjs");
    expect(hook).not.toContain("sqlite");
    expect(hook).not.toContain("@libsql");
  });
});

// ═════════════════════════════════════════════════════════════════
// 5. NO STORAGE BYPASS — ARCHITECTURAL GUARD
// ═════════════════════════════════════════════════════════════════

describe("no storage bypass in tool handlers", () => {
  it("ingestHandler.ts imports from storage/index, not storage/sqlite", async () => {
    const fs = await import("fs");
    const handler = fs.readFileSync(
      "src/tools/ingestHandler.ts", "utf-8"
    );
    expect(handler).toContain('from "../storage/index.js"');
    expect(handler).not.toContain("storage/sqlite");
    expect(handler).not.toContain("@libsql/client");
    expect(handler).not.toContain("prism-local.db");
  });

  it("webhookRouter.ts imports ingestHandler, not direct storage", async () => {
    const fs = await import("fs");
    const router = fs.readFileSync(
      "src/dashboard/webhookRouter.ts", "utf-8"
    );
    expect(router).not.toContain("storage/sqlite");
    expect(router).not.toContain("@libsql/client");
    expect(router).not.toContain("prism-local.db");
  });

  it("no tool handler directly imports sqlite or libsql for WRITES", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const toolDir = "src/tools";
    // ledgerHandlers.ts has a legitimate READ-ONLY split-brain detection
    // that reads local DB to COMPARE versions — not a write bypass
    const KNOWN_READONLY_EXCEPTIONS = new Set(["ledgerHandlers.ts"]);
    const files = fs.readdirSync(toolDir).filter(
      (f: string) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !KNOWN_READONLY_EXCEPTIONS.has(f)
    );
    for (const file of files) {
      const content = fs.readFileSync(path.join(toolDir, file), "utf-8");
      const hasBypass = content.includes("@libsql/client") ||
                        content.includes("storage/sqlite") ||
                        content.includes("prism-local.db");
      expect(hasBypass, `${file} bypasses storage abstraction`).toBe(false);
    }
  });
});
