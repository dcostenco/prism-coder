/**
 * Hook-free startup is additive: connecting a host must not trade away the
 * memory, handoff, drift, routing, or inference capabilities users already
 * rely on.
 */
import { describe, expect, it } from "vitest";
import { getAllPossibleTools, PRISM_SERVER_INSTRUCTIONS } from "../src/server.js";

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
  });
});
