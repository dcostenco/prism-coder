/**
 * Hook-free startup is additive: connecting a host must not trade away the
 * memory, handoff, drift, routing, or inference capabilities users already
 * rely on.
 */
import { describe, expect, it } from "vitest";
import { getAllPossibleTools } from "../src/server.js";

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
  });
});
