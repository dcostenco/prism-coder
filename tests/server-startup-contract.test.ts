/**
 * Hook-free startup is additive: connecting a host must not trade away the
 * memory, handoff, drift, routing, or inference capabilities users already
 * rely on.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import * as infer from "../src/tools/prismInferHandler.js";
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
  it("forwards an MCP Cancel notification to prism_infer through the shipped server", async () => {
    const server = createServer();
    const client = new Client({ name: "cancel-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let entered!: (signal: AbortSignal | undefined) => void;
    const forwarded = new Promise<AbortSignal | undefined>(resolve => { entered = resolve; });
    let ended!: () => void;
    const exit = new Promise<void>(resolve => { ended = resolve; });
    const handler = vi.spyOn(infer, "prismInferHandler").mockImplementation(async (_args, _deps, context) => {
      entered(context?.signal);
      await exit;
      return { content: [] };
    });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const stop = new AbortController();
      const call = client.callTool({ name: "prism_infer", arguments: { prompt: "Draft a helper" } }, undefined, { signal: stop.signal });
      const finished = call.catch(() => undefined);
      const signal = await forwarded;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
      const aborted = new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
      stop.abort();
      await aborted;
      await finished;
    } finally {
      ended();
      await client.close();
      await server.close();
      handler.mockRestore();
    }
  });
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
    // Was /empty object/ — this assertion is why the zero-argument contract
    // survived the 2026-08-02 switch to prompt-passing. The tool DESCRIPTION is
    // what a host reads to decide how to call the tool, so it outranks the
    // server instructions in practice: while it said "with an empty object",
    // hosts passed {} and turn-one keyword routing never fired, defeating the
    // change. Pinned to the new contract, and to its negation.
    expect(bootstrapDescription).toMatch(/verbatim first message as \{prompt: "<first user message>"\}/i);
    expect(bootstrapDescription).toMatch(/ON-DEVICE/);
    expect(bootstrapDescription).toMatch(/never leaves the machine/i);
    expect(bootstrapDescription).not.toMatch(/exactly once with an empty object/i);
    expectVerbatimStartupContract(bootstrapDescription);
    expect(bootstrapDescription).toMatch(/Do not guess or pass a project or depth/i);
    expect(loadDescription).toMatch(/explicit project reload/i);
    expect(loadDescription).toMatch(/fallback only when session_bootstrap is unavailable/i);
    expect(loadDescription).not.toMatch(/at the start of every conversation/i);
    // Was `exactly once with {}` until 2026-08-02. The zero-argument contract
    // meant prompt-keyword routing could never fire on turn one — the turn an
    // incident report arrives on. The prompt is now passed and matched
    // on-device, so both halves are pinned here.
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/call session_bootstrap exactly once/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/verbatim first message as \{prompt: "<first user message>"\}/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/ON-DEVICE/);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/never leaves the machine/i);
    expect(PRISM_SERVER_INSTRUCTIONS).not.toMatch(/exactly once with \{\}/);
    expectVerbatimStartupContract(PRISM_SERVER_INSTRUCTIONS);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/Do not substitute session_load_context/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/session_save_handoff to preserve state/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/session_detect_drift/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/Prism local-first orchestration/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/Never create host-native or background subagents for routine work/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/A host-native subagent is a last resort: at most one, no nesting/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/Prism evidence workflow/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/one trustworthy correlated reproduction is enough/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/Inspect every artifact used to support the claim/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/active agent must open it and compare its visible state/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/do not ask the user to verify it/i);
    expect(PRISM_SERVER_INSTRUCTIONS).toMatch(/screenshot is an observation, not absolute truth/i);
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
