/**
 * A refused session_save_ledger must not count as a GATE 5 drift checkpoint.
 *
 * The server used to reset the drift timer after EVERY returned ledger result,
 * so a save refused with context_not_loaded silenced the hourly "save and
 * check drift" reminder while nothing was saved. The handler now resets the
 * timer itself, on its write path only (unit-tested in
 * src/tools/__tests__/ledgerHandlers.test.ts). This test drives the real
 * server dispatch over an in-memory MCP transport.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/session/sessionContext.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/session/sessionContext.js")>();
  return { ...actual, noteDriftCheck: vi.fn(actual.noteDriftCheck) };
});

import { noteDriftCheck } from "../src/session/sessionContext.js";
import { createServer } from "../src/server.js";

describe("session_save_ledger through the server", () => {
  it("a save refused with context_not_loaded does not reset the drift timer", async () => {
    const server = createServer();
    const client = new Client({ name: "ledger-drift-test", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      vi.mocked(noteDriftCheck).mockClear();

      const result = await client.callTool({
        name: "session_save_ledger",
        arguments: {
          project: "never-loaded-project",
          conversation_id: "conv-never-loaded-0001",
          summary: "Implemented feature X",
        },
      });

      const text = (result.content as Array<{ type: string; text?: string }>)
        .map((c) => c.text ?? "").join("\n");
      expect(result.isError).toBe(true);
      expect(text).toContain("context_not_loaded");
      expect(noteDriftCheck).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});
