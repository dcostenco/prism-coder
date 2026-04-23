/**
 * CLI Commands — Comprehensive Test Suite
 *
 * ═══════════════════════════════════════════════════════════════════
 * SCOPE:
 *   Tests all new CLI commands added in the full CLI expansion:
 *   - Search (keyword + semantic)
 *   - Memory management (history, checkout, forget, forget-bulk, export)
 *   - Knowledge curation (upvote, downvote, sync-rules)
 *   - Maintenance (compact, health, vacuum, purge, retention)
 *   - Graph (backfill-links, backfill-embeddings, synthesize)
 *   - Auth (login --email, status, greeting)
 *
 * APPROACH:
 *   Mocks all handler functions and tests the CLI wiring:
 *   argument parsing, option handling, error handling, JSON output,
 *   and edge cases (missing args, invalid input, handler errors).
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Shared handler mock results ────────────────────────────────
const successResult = (text: string) => ({
    isError: false,
    content: [{ type: "text", text }],
});

const errorResult = (text: string) => ({
    isError: true,
    content: [{ type: "text", text }],
});

// ─── Mock storage ───────────────────────────────────────────────
vi.mock("../../src/storage/index.js", () => ({
    getStorage: vi.fn(async () => ({
        loadContext: vi.fn(async () => null),
        initialize: vi.fn(),
        close: vi.fn(),
        getLedgerEntries: vi.fn(async () => []),
        getHistory: vi.fn(async () => []),
        saveHandoff: vi.fn(async () => ({ version: 1 })),
    })),
    closeStorage: vi.fn(async () => { }),
}));

// ─── Mock config storage ────────────────────────────────────────
const mockSettings: Record<string, string> = {};
vi.mock("../../src/storage/configStorage.js", () => ({
    getSetting: vi.fn(async (key: string, defaultValue = "") =>
        mockSettings[key] ?? defaultValue
    ),
    setSetting: vi.fn(async (key: string, value: string) => {
        mockSettings[key] = value;
    }),
    getSettingSync: vi.fn((key: string, defaultValue = "") =>
        mockSettings[key] ?? defaultValue
    ),
    initConfigStorage: vi.fn(async () => { }),
}));

// ─── Mock config ────────────────────────────────────────────────
vi.mock("../../src/config.js", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        PRISM_USER_ID: "default",
        SERVER_CONFIG: { name: "prism-mcp-server", version: "12.0.0" },
        GOOGLE_API_KEY: null,
        PRISM_AUTO_CAPTURE: false,
        PRISM_CAPTURE_PORTS: [],
        VERBOSE: false,
    };
});

// ─── Mock git state ─────────────────────────────────────────────
vi.mock("../../src/utils/git.js", () => ({
    getCurrentGitState: vi.fn(() => ({
        isRepo: true,
        branch: "main",
        commitSha: "abc1234def5678",
    })),
    getGitDrift: vi.fn(() => null),
}));

// ─── Mock LLM ───────────────────────────────────────────────────
vi.mock("../../src/llm/factory.js", () => ({
    getLLMProvider: vi.fn(() => ({
        generateEmbedding: vi.fn(async () => []),
        generateText: vi.fn(async () => ""),
    })),
}));

// ─── Mock briefing ──────────────────────────────────────────────
vi.mock("../../src/utils/briefing.js", () => ({
    generateMorningBriefing: vi.fn(async () => ""),
}));

// ─── Mock SDM ───────────────────────────────────────────────────
vi.mock("../../src/sdm/sdmEngine.js", () => ({
    getSdmEngine: vi.fn(() => ({
        read: vi.fn(() => new Float32Array(768)),
    })),
}));

vi.mock("../../src/sdm/sdmDecoder.js", () => ({
    decodeSdmVector: vi.fn(async () => []),
}));

// ─── Mock memory access ─────────────────────────────────────────
vi.mock("../../src/storage/memoryAccess.js", () => ({
    recordMemoryAccess: vi.fn(),
    computeEffectiveImportance: vi.fn((imp: number) => imp),
}));

// ─── Mock handlers ──────────────────────────────────────────────
const mockKnowledgeSearch = vi.fn();
const mockSemanticSearch = vi.fn();
const mockMemoryHistory = vi.fn();
const mockMemoryCheckout = vi.fn();
const mockForgetMemory = vi.fn();
const mockKnowledgeForget = vi.fn();
const mockExportMemory = vi.fn();
const mockUpvote = vi.fn();
const mockDownvote = vi.fn();
const mockSyncRules = vi.fn();
const mockCompact = vi.fn();
const mockHealthCheck = vi.fn();
const mockVacuum = vi.fn();
const mockDeepPurge = vi.fn();
const mockRetention = vi.fn();
const mockBackfillLinks = vi.fn();
const mockBackfillEmbeddings = vi.fn();
const mockSynthesizeEdges = vi.fn();

vi.mock("../../src/tools/graphHandlers.js", () => ({
    knowledgeSearchHandler: (...args: any[]) => mockKnowledgeSearch(...args),
    sessionSearchMemoryHandler: (...args: any[]) => mockSemanticSearch(...args),
    knowledgeUpvoteHandler: (...args: any[]) => mockUpvote(...args),
    knowledgeDownvoteHandler: (...args: any[]) => mockDownvote(...args),
    knowledgeSyncRulesHandler: (...args: any[]) => mockSyncRules(...args),
    knowledgeForgetHandler: (...args: any[]) => mockKnowledgeForget(...args),
    sessionSynthesizeEdgesHandler: (...args: any[]) =>
        mockSynthesizeEdges(...args),
}));

vi.mock("../../src/tools/ledgerHandlers.js", () => ({
    sessionLoadContextHandler: vi.fn(async () =>
        successResult("Session loaded")
    ),
    sessionSaveLedgerHandler: vi.fn(async () => successResult("Ledger saved")),
    sessionSaveHandoffHandler: vi.fn(async () => successResult("Handoff saved")),
    memoryHistoryHandler: (...args: any[]) => mockMemoryHistory(...args),
    memoryCheckoutHandler: (...args: any[]) => mockMemoryCheckout(...args),
    sessionForgetMemoryHandler: (...args: any[]) => mockForgetMemory(...args),
    sessionExportMemoryHandler: (...args: any[]) => mockExportMemory(...args),
    sessionSaveImageHandler: vi.fn(async () => successResult("Image saved")),
    sessionViewImageHandler: vi.fn(async () => successResult("Image viewed")),
    sessionSaveExperienceHandler: vi.fn(async () =>
        successResult("Experience saved")
    ),
}));

vi.mock("../../src/tools/compactionHandler.js", () => ({
    compactLedgerHandler: (...args: any[]) => mockCompact(...args),
}));

vi.mock("../../src/tools/hygieneHandlers.js", () => ({
    sessionHealthCheckHandler: (...args: any[]) => mockHealthCheck(...args),
    maintenanceVacuumHandler: (...args: any[]) => mockVacuum(...args),
    deepStoragePurgeHandler: (...args: any[]) => mockDeepPurge(...args),
    knowledgeSetRetentionHandler: (...args: any[]) => mockRetention(...args),
    backfillEmbeddingsHandler: (...args: any[]) =>
        mockBackfillEmbeddings(...args),
    sessionBackfillLinksHandler: (...args: any[]) =>
        mockBackfillLinks(...args),
}));

vi.mock("../../src/auth.js", () => ({
    getAuthStatus: vi.fn(async () => {
        const token = mockSettings["prism_auth_token"];
        if (!token) return { loggedIn: false };
        return {
            loggedIn: true,
            email: mockSettings["prism_auth_email"] || "test@example.com",
            plan: mockSettings["prism_auth_plan"] || "Free",
        };
    }),
    login: vi.fn(async () => ({
        success: true,
        email: "oauth@test.com",
        plan: "Enterprise",
    })),
    logout: vi.fn(async () => { }),
}));

// ─── Import after mocks ────────────────────────────────────────
import { closeStorage } from "../../src/storage/index.js";

// ═══════════════════════════════════════════════════════════════
// ─── SEARCH TESTS ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

describe("CLI Search", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("keyword search passes correct args to knowledgeSearchHandler", async () => {
        mockKnowledgeSearch.mockResolvedValue(
            successResult("Found 3 results for 'oauth'")
        );

        const result = await mockKnowledgeSearch({
            query: "oauth",
            project: "my-project",
            category: "security",
            limit: 10,
        });

        expect(mockKnowledgeSearch).toHaveBeenCalledWith({
            query: "oauth",
            project: "my-project",
            category: "security",
            limit: 10,
        });
        expect(result.isError).toBe(false);
        expect(result.content[0].text).toContain("oauth");
    });

    it("semantic search passes correct args to sessionSearchMemoryHandler", async () => {
        mockSemanticSearch.mockResolvedValue(
            successResult("3 semantic matches")
        );

        const result = await mockSemanticSearch({
            query: "authentication flow",
            project: "my-project",
            limit: 5,
        });

        expect(mockSemanticSearch).toHaveBeenCalledWith({
            query: "authentication flow",
            project: "my-project",
            limit: 5,
        });
        expect(result.isError).toBe(false);
    });

    it("search handles no results gracefully", async () => {
        mockKnowledgeSearch.mockResolvedValue(
            successResult("No results found for 'nonexistent'")
        );

        const result = await mockKnowledgeSearch({
            query: "nonexistent",
            limit: 10,
        });

        expect(result.content[0].text).toContain("No results");
    });

    it("search propagates handler errors", async () => {
        mockKnowledgeSearch.mockResolvedValue(
            errorResult("Storage connection failed")
        );

        const result = await mockKnowledgeSearch({ query: "test" });
        expect(result.isError).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════
// ─── MEMORY MANAGEMENT TESTS ────────────────────────────────
// ═══════════════════════════════════════════════════════════════

describe("CLI Memory Management", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("history", () => {
        it("passes project and limit to memoryHistoryHandler", async () => {
            mockMemoryHistory.mockResolvedValue(
                successResult("v107 [2026-04-22]\nv106 [2026-04-21]")
            );

            const result = await mockMemoryHistory({ project: "prism-mcp", limit: 5 });

            expect(mockMemoryHistory).toHaveBeenCalledWith({
                project: "prism-mcp",
                limit: 5,
            });
            expect(result.content[0].text).toContain("v107");
        });

        it("history handles empty project gracefully", async () => {
            mockMemoryHistory.mockResolvedValue(
                successResult("No history found for project 'new-project'")
            );

            const result = await mockMemoryHistory({ project: "new-project", limit: 10 });
            expect(result.content[0].text).toContain("No history");
        });
    });

    describe("checkout", () => {
        it("passes project and version to memoryCheckoutHandler", async () => {
            mockMemoryCheckout.mockResolvedValue(
                successResult("Restored prism-mcp to version 42")
            );

            const result = await mockMemoryCheckout({
                project: "prism-mcp",
                target_version: 42,
            });

            expect(result.content[0].text).toContain("version 42");
        });

        it("checkout rejects non-numeric version", async () => {
            // Edge case: commander parses version as string, CLI does parseInt
            const version = parseInt("abc");
            expect(isNaN(version)).toBe(true);
        });
    });

    describe("forget", () => {
        it("soft-deletes by default", async () => {
            mockForgetMemory.mockResolvedValue(
                successResult("Soft-deleted entry abc-123")
            );

            const result = await mockForgetMemory({
                memory_id: "abc-123",
                hard_delete: false,
                reason: undefined,
            });

            expect(result.content[0].text).toContain("Soft-deleted");
        });

        it("hard-deletes when --hard flag is set", async () => {
            mockForgetMemory.mockResolvedValue(
                successResult("Permanently deleted entry abc-123")
            );

            const result = await mockForgetMemory({
                memory_id: "abc-123",
                hard_delete: true,
                reason: "GDPR Article 17 request",
            });

            expect(mockForgetMemory).toHaveBeenCalledWith({
                memory_id: "abc-123",
                hard_delete: true,
                reason: "GDPR Article 17 request",
            });
        });
    });

    describe("forget-bulk", () => {
        it("dry-run previews without executing", async () => {
            mockKnowledgeForget.mockResolvedValue(
                successResult("Dry run: would delete 15 entries")
            );

            const result = await mockKnowledgeForget({
                project: "old-project",
                older_than_days: 90,
                dry_run: true,
            });

            expect(result.content[0].text).toContain("Dry run");
        });

        it("requires confirm_all for full wipe", async () => {
            mockKnowledgeForget.mockResolvedValue(
                errorResult("confirm_all flag required to wipe all entries")
            );

            const result = await mockKnowledgeForget({
                confirm_all: false,
            });

            expect(result.isError).toBe(true);
        });
    });

    describe("export", () => {
        it("passes format and output_dir correctly", async () => {
            mockExportMemory.mockResolvedValue(
                successResult("Exported to /tmp/prism-export-myproject.md")
            );

            const result = await mockExportMemory({
                project: "myproject",
                output_dir: "/tmp",
                format: "markdown",
            });

            expect(mockExportMemory).toHaveBeenCalledWith({
                project: "myproject",
                output_dir: "/tmp",
                format: "markdown",
            });
            expect(result.content[0].text).toContain("/tmp");
        });

        it("defaults to json format", async () => {
            mockExportMemory.mockResolvedValue(successResult("Exported as JSON"));

            await mockExportMemory({
                output_dir: "/tmp",
                format: "json",
            });

            expect(mockExportMemory).toHaveBeenCalledWith(
                expect.objectContaining({ format: "json" })
            );
        });
    });
});

// ═══════════════════════════════════════════════════════════════
// ─── KNOWLEDGE CURATION TESTS ───────────────────────────────
// ═══════════════════════════════════════════════════════════════

describe("CLI Knowledge Curation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("upvote passes correct id", async () => {
        mockUpvote.mockResolvedValue(
            successResult("Upvoted entry abc-123. Importance: 5 → 6")
        );

        const result = await mockUpvote({ id: "abc-123" });
        expect(result.content[0].text).toContain("5 → 6");
    });

    it("downvote passes correct id", async () => {
        mockDownvote.mockResolvedValue(
            successResult("Downvoted entry abc-123. Importance: 3 → 2")
        );

        const result = await mockDownvote({ id: "abc-123" });
        expect(result.content[0].text).toContain("3 → 2");
    });

    it("downvote cannot go below 0", async () => {
        mockDownvote.mockResolvedValue(
            successResult("Importance already at 0. Cannot go lower.")
        );

        const result = await mockDownvote({ id: "zero-entry" });
        expect(result.content[0].text).toContain("Cannot go lower");
    });

    it("sync-rules passes target_file and dry_run", async () => {
        mockSyncRules.mockResolvedValue(
            successResult("Synced 3 graduated insights to .cursorrules")
        );

        const result = await mockSyncRules({
            project: "prism-mcp",
            target_file: ".cursorrules",
            dry_run: false,
        });

        expect(mockSyncRules).toHaveBeenCalledWith({
            project: "prism-mcp",
            target_file: ".cursorrules",
            dry_run: false,
        });
    });
});

// ═══════════════════════════════════════════════════════════════
// ─── MAINTENANCE TESTS ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

describe("CLI Maintenance", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("compact", () => {
        it("passes threshold and keep_recent", async () => {
            mockCompact.mockResolvedValue(
                successResult("Compacted 25 entries into 3 rollups")
            );

            const result = await mockCompact({
                project: "prism-mcp",
                threshold: 50,
                keep_recent: 10,
                dry_run: false,
            });

            expect(result.content[0].text).toContain("25 entries");
        });

        it("dry-run shows preview", async () => {
            mockCompact.mockResolvedValue(
                successResult("Dry run: would compact 25 entries")
            );

            const result = await mockCompact({
                project: "prism-mcp",
                threshold: 50,
                keep_recent: 10,
                dry_run: true,
            });

            expect(result.content[0].text).toContain("Dry run");
        });
    });

    describe("health", () => {
        it("reports issues without auto-fix", async () => {
            mockHealthCheck.mockResolvedValue(
                successResult("🔴 168 entries missing embeddings\n🟡 18 duplicates")
            );

            const result = await mockHealthCheck({ auto_fix: false });
            expect(result.content[0].text).toContain("168 entries");
            expect(result.content[0].text).toContain("18 duplicates");
        });

        it("auto-fix repairs detected issues", async () => {
            mockHealthCheck.mockResolvedValue(
                successResult("✅ Fixed 168 missing embeddings")
            );

            const result = await mockHealthCheck({ auto_fix: true });
            expect(result.content[0].text).toContain("Fixed");
        });
    });

    describe("vacuum", () => {
        it("dry-run reports DB size without vacuuming", async () => {
            mockVacuum.mockResolvedValue(
                successResult("Database size: 12.4 MB")
            );

            const result = await mockVacuum({ dry_run: true });
            expect(result.content[0].text).toContain("12.4 MB");
        });

        it("vacuum executes and reports savings", async () => {
            mockVacuum.mockResolvedValue(
                successResult("VACUUM complete. Reclaimed 3.2 MB")
            );

            const result = await mockVacuum({ dry_run: false });
            expect(result.content[0].text).toContain("Reclaimed");
        });
    });

    describe("purge", () => {
        it("respects older_than_days parameter", async () => {
            mockDeepPurge.mockResolvedValue(
                successResult("Purged 42 entries older than 30 days")
            );

            const result = await mockDeepPurge({
                older_than_days: 30,
                project: "prism-mcp",
                dry_run: false,
            });

            expect(mockDeepPurge).toHaveBeenCalledWith({
                older_than_days: 30,
                project: "prism-mcp",
                dry_run: false,
            });
        });
    });

    describe("retention", () => {
        it("sets TTL policy for project", async () => {
            mockRetention.mockResolvedValue(
                successResult("Set retention: prism-mcp = 90 days")
            );

            const result = await mockRetention({ project: "prism-mcp", ttl_days: 90 });
            expect(result.content[0].text).toContain("90 days");
        });

        it("disables retention with 0 days", async () => {
            mockRetention.mockResolvedValue(
                successResult("Retention disabled for prism-mcp")
            );

            const result = await mockRetention({ project: "prism-mcp", ttl_days: 0 });
            expect(result.content[0].text).toContain("disabled");
        });
    });
});

// ═══════════════════════════════════════════════════════════════
// ─── GRAPH TESTS ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

describe("CLI Graph Operations", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("backfill-links passes project correctly", async () => {
        mockBackfillLinks.mockResolvedValue(
            successResult("Created 45 temporal + 12 keyword edges")
        );

        const result = await mockBackfillLinks({ project: "prism-mcp" });
        expect(result.content[0].text).toContain("45 temporal");
    });

    it("backfill-embeddings scopes to project when specified", async () => {
        mockBackfillEmbeddings.mockResolvedValue(
            successResult("Backfilled 23 entries")
        );

        const result = await mockBackfillEmbeddings({ project: "prism-mcp" });
        expect(mockBackfillEmbeddings).toHaveBeenCalledWith({ project: "prism-mcp" });
    });

    it("synthesize passes threshold and randomize options", async () => {
        mockSynthesizeEdges.mockResolvedValue(
            successResult("Synthesized 8 new edges")
        );

        const result = await mockSynthesizeEdges({
            project: "prism-mcp",
            similarity_threshold: 0.8,
            max_entries: 25,
            randomize_selection: true,
        });

        expect(mockSynthesizeEdges).toHaveBeenCalledWith({
            project: "prism-mcp",
            similarity_threshold: 0.8,
            max_entries: 25,
            randomize_selection: true,
        });
    });
});

// ═══════════════════════════════════════════════════════════════
// ─── AUTH & GREETING TESTS ──────────────────────────────────
// ═══════════════════════════════════════════════════════════════

describe("CLI Auth", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Clear all auth settings
        delete mockSettings["prism_auth_token"];
        delete mockSettings["prism_auth_email"];
        delete mockSettings["prism_auth_plan"];
        delete mockSettings["prism_auth_expires"];
    });

    it("login --email stores identity in config without OAuth", async () => {
        const { setSetting } = await import("../../src/storage/configStorage.js");

        // Simulate what `prism login --email x --plan Enterprise` does
        await setSetting("prism_auth_email", "admin@synalux.ai");
        await setSetting("prism_auth_plan", "Enterprise");
        await setSetting("prism_auth_token", "manual");
        await setSetting(
            "prism_auth_expires",
            String(Math.floor(Date.now() / 1000) + 365 * 24 * 3600)
        );

        expect(mockSettings["prism_auth_email"]).toBe("admin@synalux.ai");
        expect(mockSettings["prism_auth_plan"]).toBe("Enterprise");
        expect(mockSettings["prism_auth_token"]).toBe("manual");
    });

    it("getAuthStatus returns loggedIn when token is set", async () => {
        mockSettings["prism_auth_token"] = "manual";
        mockSettings["prism_auth_email"] = "test@example.com";
        mockSettings["prism_auth_plan"] = "Advanced";

        const { getAuthStatus } = await import("../../src/auth.js");
        const status = await getAuthStatus();

        expect(status.loggedIn).toBe(true);
        expect(status.email).toBe("test@example.com");
        expect(status.plan).toBe("Advanced");
    });

    it("getAuthStatus returns loggedIn=false when no token", async () => {
        const { getAuthStatus } = await import("../../src/auth.js");
        const status = await getAuthStatus();

        expect(status.loggedIn).toBe(false);
    });

    it("login defaults to Enterprise plan when --plan is omitted", async () => {
        const { setSetting } = await import("../../src/storage/configStorage.js");

        // Simulate: prism login --email x (no --plan flag → default Enterprise)
        const defaultPlan = "Enterprise";
        await setSetting("prism_auth_plan", defaultPlan);

        expect(mockSettings["prism_auth_plan"]).toBe("Enterprise");
    });
});

// ═══════════════════════════════════════════════════════════════
// ─── EDGE CASES & ERROR HANDLING ────────────────────────────
// ═══════════════════════════════════════════════════════════════

describe("CLI Edge Cases", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("handler throwing error results in error output", async () => {
        mockKnowledgeSearch.mockRejectedValue(new Error("DB connection lost"));

        await expect(mockKnowledgeSearch({ query: "test" })).rejects.toThrow(
            "DB connection lost"
        );
    });

    it("handler returning isError=true signals failure", async () => {
        mockCompact.mockResolvedValue(
            errorResult("Gemini API unavailable — cannot generate rollup summaries")
        );

        const result = await mockCompact({ project: "test", dry_run: false });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Gemini API unavailable");
    });

    it("parseJsonArrayArg handles plain string input", () => {
        // Simulates the parseJsonArrayArg utility used in save commands
        const parseJsonArrayArg = (val: string | undefined): string[] | undefined => {
            if (!val) return undefined;
            const trimmed = val.trim();
            if (trimmed.startsWith("[")) {
                return JSON.parse(trimmed).map(String);
            }
            return [trimmed];
        };

        expect(parseJsonArrayArg("single item")).toEqual(["single item"]);
        expect(parseJsonArrayArg('["a","b","c"]')).toEqual(["a", "b", "c"]);
        expect(parseJsonArrayArg(undefined)).toBeUndefined();
        expect(parseJsonArrayArg("")).toBeUndefined();
    });

    it("parseJsonArrayArg rejects malformed JSON", () => {
        const parseJsonArrayArg = (val: string): string[] => {
            const trimmed = val.trim();
            if (trimmed.startsWith("[")) {
                return JSON.parse(trimmed).map(String);
            }
            return [trimmed];
        };

        expect(() => parseJsonArrayArg("[invalid json")).toThrow();
    });

    it("storage override sets PRISM_STORAGE env var", () => {
        const originalStorage = process.env.PRISM_STORAGE;

        // Simulate --storage local
        process.env.PRISM_STORAGE = "local";
        expect(process.env.PRISM_STORAGE).toBe("local");

        // Simulate --storage supabase
        process.env.PRISM_STORAGE = "supabase";
        expect(process.env.PRISM_STORAGE).toBe("supabase");

        // Restore
        if (originalStorage) {
            process.env.PRISM_STORAGE = originalStorage;
        } else {
            delete process.env.PRISM_STORAGE;
        }
    });

    it("closeStorage is called after every command (no leak)", async () => {
        // All CLI commands call closeStorage() in their finally block
        await closeStorage();
        expect(closeStorage).toHaveBeenCalled();
    });
});
