/**
 * Hook-free startup is additive: connecting a host must not trade away the
 * memory, handoff, drift, routing, or inference capabilities users already
 * rely on.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  createSandboxServer,
  createServer,
  getAllPossibleTools,
  PRISM_SERVER_INSTRUCTIONS,
} from "../src/server.js";

function expectVerbatimStartupContract(instructions: string): void {
  const normalized = instructions.replace(/\s+/g, " ");
  expect(normalized).toContain(
    "Print the complete tool result verbatim as the entire first-turn startup display, before any optional answer.",
  );
  expect(normalized).toContain(
    "Do not summarize, paraphrase, rename headings, reformat, or omit any returned section.",
  );
  expect(normalized).toContain(
    "For a greeting-only prompt, stop after the verbatim startup display.",
  );
}

describe("Prism startup tool contract", () => {
  it("adds session_bootstrap while preserving the established Prism surface", () => {
    const tools = getAllPossibleTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      "session_bootstrap",
      "session_load_context",
      "session_save_ledger",
      "session_save_handoff",
      "session_detect_drift",
      "session_task_route",
      "knowledge_search",
      "session_search_memory",
      "memory_history",
      "prism_infer",
    ]));
    expect(new Set(names).size).toBe(names.length);
    expect(tools.find((tool) => tool.name === "session_bootstrap")?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    expect(names.indexOf("session_bootstrap")).toBeLessThan(names.indexOf("session_load_context"));
    const bootstrapDescription = tools.find((tool) => tool.name === "session_bootstrap")?.description || "";
    const loadDescription = tools.find((tool) => tool.name === "session_load_context")?.description || "";
    expect(bootstrapDescription).toMatch(/first user turn of every conversation/i);
    expect(bootstrapDescription).toMatch(/empty object/i);
    expectVerbatimStartupContract(bootstrapDescription);
    expect(bootstrapDescription).toMatch(/Do not guess or pass a project or depth/i);
    expect(loadDescription).toMatch(/explicit project reload/i);
    expect(loadDescription).toMatch(/fallback only when session_bootstrap is unavailable/i);
    expect(loadDescription).not.toMatch(/at the start of every conversation/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/call session_bootstrap exactly once with \{\}/i);
    expectVerbatimStartupContract(PRISM_SERVER_INSTRUCTIONS);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/Do not substitute session_load_context/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/session_save_handoff to preserve state/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/session_detect_drift/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/Prism local-first orchestration/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/Never create host-native or background subagents for routine work/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/A host-native subagent is a last resort: at most one, no nesting/i);
  });

  it.each([
    ["runtime", createServer],
    ["sandbox", createSandboxServer],
  ])("advertises diagnostic logging during the %s initialize handshake", async (_name, factory) => {
    const server = factory();
    const client = new Client(
      { name: "prism-startup-contract-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      expect(client.getServerCapabilities()?.logging).toEqual({});
    } finally {
      await client.close();
    }
  });

  it("emits SDK logging notifications after initialization", async () => {
    const server = createServer();
    const client = new Client(
      { name: "prism-logging-notification-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const notification = new Promise<{ level: string; data: unknown }>((resolve) => {
      client.setNotificationHandler(LoggingMessageNotificationSchema, message => {
        resolve(message.params);
      });
    });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      await server.sendLoggingMessage({
        level: "info",
        data: "Prism diagnostic notification",
      });

      await expect(notification).resolves.toMatchObject({
        level: "info",
        data: "Prism diagnostic notification",
      });
    } finally {
      await client.close();
    }
  });
});
