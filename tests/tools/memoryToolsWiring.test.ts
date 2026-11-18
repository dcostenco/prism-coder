import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { computeConfigFingerprint } from "../../src/utils/configFingerprint.js";

const mockEmbedding = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));

vi.mock("../../src/utils/llm/factory.js", () => ({
  getLLMProvider: vi.fn(() => ({
    generateEmbedding: vi.fn(async () => mockEmbedding),
    generateText: vi.fn(async () => ""),
    recommendedSimilarityThreshold: 0.5,
  })),
}));

describe("Prism memory tools wiring, schema, and end-to-end SQLite dispatch", () => {
  let tempDir: string;
  let client: Client;
  let closeStorage: () => Promise<void>;
  let savedEnv: Record<string, string | undefined>;
  let SESSION_LOAD_CONTEXT_TOOL: any;
  let SESSION_BACKFILL_EMBEDDINGS_TOOL: any;
  let SESSION_INTUITIVE_RECALL_TOOL: any;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-wiring-"));
    savedEnv = {
      PRISM_DATA_DIR: process.env.PRISM_DATA_DIR,
      PRISM_STORAGE: process.env.PRISM_STORAGE,
      PRISM_HDC_ENABLED: process.env.PRISM_HDC_ENABLED,
      PRISM_ENABLE_HIVEMIND: process.env.PRISM_ENABLE_HIVEMIND,
      PRISM_TASK_ROUTER_ENABLED: process.env.PRISM_TASK_ROUTER_ENABLED,
      PRISM_DARK_FACTORY_ENABLED: process.env.PRISM_DARK_FACTORY_ENABLED,
      PRISM_ENABLE_DASHBOARD: process.env.PRISM_ENABLE_DASHBOARD,
      PRISM_SCHEDULER_ENABLED: process.env.PRISM_SCHEDULER_ENABLED,
    };

    process.env.PRISM_DATA_DIR = tempDir;
    process.env.PRISM_STORAGE = "local";
    process.env.PRISM_HDC_ENABLED = "true";
    process.env.PRISM_ENABLE_HIVEMIND = "true";
    process.env.PRISM_TASK_ROUTER_ENABLED = "false";
    process.env.PRISM_DARK_FACTORY_ENABLED = "false";
    process.env.PRISM_ENABLE_DASHBOARD = "false";
    process.env.PRISM_SCHEDULER_ENABLED = "false";

    vi.resetModules();

    const toolsIndex = await import("../../src/tools/index.js");
    SESSION_LOAD_CONTEXT_TOOL = toolsIndex.SESSION_LOAD_CONTEXT_TOOL;
    SESSION_BACKFILL_EMBEDDINGS_TOOL = (toolsIndex as Record<string, unknown>).SESSION_BACKFILL_EMBEDDINGS_TOOL;
    SESSION_INTUITIVE_RECALL_TOOL = toolsIndex.SESSION_INTUITIVE_RECALL_TOOL;

    const configStorage = await import("../../src/storage/configStorage.js");
    await configStorage.initConfigStorage();

    const storageMod = await import("../../src/storage/index.js");
    closeStorage = storageMod.closeStorage;
    await closeStorage();
    await storageMod.getStorage();

    const { createServer } = await import("../../src/mcpServer.js");
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: "wiring-test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    if (client) {
      await client.close().catch(() => {});
    }
    if (closeStorage) {
      await closeStorage().catch(() => {});
    }
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("re-exports SESSION_BACKFILL_EMBEDDINGS_TOOL and SESSION_INTUITIVE_RECALL_TOOL from tools/index", () => {
    expect(SESSION_BACKFILL_EMBEDDINGS_TOOL).toBeDefined();
    expect(SESSION_BACKFILL_EMBEDDINGS_TOOL.name).toBe("session_backfill_embeddings");
    expect(SESSION_INTUITIVE_RECALL_TOOL).toBeDefined();
    expect(SESSION_INTUITIVE_RECALL_TOOL.name).toBe("session_intuitive_recall");
  });

  it("tools/list includes session_intuitive_recall and session_backfill_embeddings with 36 tools total when HDC + Hivemind are enabled", async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);

    expect(names).toContain("session_intuitive_recall");
    expect(names).toContain("session_backfill_embeddings");
    expect(tools).toHaveLength(36);
  });

  it("SESSION_LOAD_CONTEXT_TOOL requires only project and omits toolAction/toolSummary", () => {
    expect(SESSION_LOAD_CONTEXT_TOOL.inputSchema.required).toEqual(["project"]);
    expect(SESSION_LOAD_CONTEXT_TOOL.inputSchema.properties).not.toHaveProperty("toolAction");
    expect(SESSION_LOAD_CONTEXT_TOOL.inputSchema.properties).not.toHaveProperty("toolSummary");
  });

  it("calling session_load_context with project and level succeeds", async () => {
    const result = await client.callTool({
      name: "session_load_context",
      arguments: { project: "dev", level: "standard" },
    });
    expect(result.isError).not.toBe(true);
  });

  it("calling session_intuitive_recall, session_save_ledger, session_save_handoff, and session_save_experience persists rows readable via knowledge_search", async () => {
    const ledgerRes = await client.callTool({
      name: "session_save_ledger",
      arguments: {
        project: "dev",
        conversation_id: "conv-wiring-1",
        summary: "Wired quantum-lattice telemetry pipeline for local verification",
        decisions: ["Use SQLite WAL mode for local tests"],
      },
    });
    expect(ledgerRes.isError).not.toBe(true);

    const handoffRes = await client.callTool({
      name: "session_save_handoff",
      arguments: {
        project: "dev",
        last_summary: "Completed quantum-lattice telemetry wiring",
        active_branch: "feat/test-branch",
        open_todos: ["Verify recall output"],
      },
    });
    expect(handoffRes.isError).not.toBe(true);

    const experienceRes = await client.callTool({
      name: "session_save_experience",
      arguments: {
        project: "dev",
        event_type: "learning",
        context: "Testing quantum-lattice telemetry persistence",
        action: "Use deterministic embeddings in local SQLite tests",
        outcome: "All wiring checks passed without external network calls",
      },
    });
    expect(experienceRes.isError).not.toBe(true);

    const recallRes = await client.callTool({
      name: "session_intuitive_recall",
      arguments: {
        project: "dev",
        query: "quantum-lattice telemetry",
      },
    });
    expect(recallRes.isError).not.toBe(true);
    const recallText = (recallRes.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(recallText).toContain("SDM Intuitive Recall");

    const searchRes = await client.callTool({
      name: "knowledge_search",
      arguments: {
        project: "dev",
        query: "quantum-lattice",
      },
    });
    expect(searchRes.isError).not.toBe(true);
    const searchText = (searchRes.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(searchText).toContain("quantum-lattice");
  });

  it("computeConfigFingerprint changes when PRISM_HDC_ENABLED or PRISM_ENABLE_HIVEMIND changes", () => {
    const base = { PRISM_USER_ID: "u1", PRISM_STORAGE: "local" };
    expect(computeConfigFingerprint({ ...base, PRISM_HDC_ENABLED: "false" })).not.toBe(
      computeConfigFingerprint({ ...base, PRISM_HDC_ENABLED: "true" })
    );
    expect(computeConfigFingerprint({ ...base, PRISM_ENABLE_HIVEMIND: "false" })).not.toBe(
      computeConfigFingerprint({ ...base, PRISM_ENABLE_HIVEMIND: "true" })
    );
  });
});
