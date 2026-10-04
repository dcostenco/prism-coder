/**
 * Every text an agent reads agrees on one thing: a save refused with
 * `context_not_loaded` is recovered by session_load_context for that project
 * with the same conversation_id, then one retry — and nothing forbids it.
 *
 * Why this exists: the save gate's refusal said "call session_load_context",
 * while the managed host block said "Do not call `session_load_context`". An
 * agent obeying the block (the higher-priority text) could never follow the
 * refusal, and a long-running thread simply stopped saving. Each surface was
 * individually reasonable; the contradiction lived BETWEEN them, which is why
 * 4,000+ per-surface tests did not notice.
 *
 * Scope here: the server instructions, the tool descriptions and the in-repo
 * agent-facing documents. The three host blocks are asserted in
 * tests/tools/cli-connect.test.ts (expectContextRecoveryContract) and the gate's
 * own refusal text in src/session/__tests__/sessionContext.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAllPossibleTools, PRISM_SERVER_INSTRUCTIONS } from "../src/server.js";
import { CONTEXT_RECOVERY_POLICY_LINES, CONTEXT_RECOVERY_POLICY_TEXT } from "../src/contextRecoveryPolicy.js";
import { findRecoveryBlockers, flatten } from "./helpers/contextRecovery.js";

const REPO = join(__dirname, "..");
const read = (relative: string): string => readFileSync(join(REPO, relative), "utf8");

// Claude Code renders only the first 2,048 characters of a server's MCP
// instructions (observed live 2026-10-02: the text ends mid-word at 2,048 with
// "[truncated]"). The remedy has to be inside that window to be seen there.
const CLAUDE_CODE_INSTRUCTION_WINDOW = 2_048;
// Codex drops EVERY parameter description when a tool's compact schema exceeds
// 5,000 bytes (tests/tools/prismInferSchemaBudget.test.ts). JSON.stringify is an
// upper bound on that size, so staying under it with headroom is strictly safer.
const CODEX_SCHEMA_BUDGET = 5_000 - 200;

const SESSION_TOOLS = [
  "session_bootstrap",
  "session_load_context",
  "session_save_ledger",
  "session_save_handoff",
  "session_detect_drift",
  "session_route_prompt",
];

type SchemaProps = Record<string, { description?: string }>;

function surfaceTexts(): Array<[string, string]> {
  const tools = getAllPossibleTools();
  const texts: Array<[string, string]> = [["server instructions", PRISM_SERVER_INSTRUCTIONS]];
  for (const name of SESSION_TOOLS) {
    const tool = tools.find((t) => t.name === name);
    expect(tool, `${name} is advertised`).toBeDefined();
    texts.push([`${name} description`, tool?.description ?? ""]);
    const props = ((tool?.inputSchema as { properties?: SchemaProps })?.properties ?? {}) as SchemaProps;
    for (const [prop, spec] of Object.entries(props)) {
      texts.push([`${name}.${prop} description`, spec.description ?? ""]);
    }
  }
  return texts;
}

describe("the blocker detector is itself trustworthy", () => {
  it("flags the unconditional ban the managed host blocks used to carry", () => {
    expect(findRecoveryBlockers(
      "Do not use shell commands or file reads as a substitute. Do not call `session_load_context`. If discovery fails, stop.",
    )).toHaveLength(1);
    expect(findRecoveryBlockers(
      "Do not use shell commands as a substitute. Do not call\n`session_load_context`. If discovery fails, stop.",
    )).toHaveLength(1);
  });

  it("flags 'only for a reload' wording that rations the recovery away", () => {
    expect(findRecoveryBlockers(
      "Use `session_load_context(project)` only for an explicit project reload or when `session_bootstrap` is unavailable.",
    )).toHaveLength(1);
    expect(findRecoveryBlockers(
      "Do not substitute session_load_context while session_bootstrap is available; use session_load_context only for an explicit project reload or as an older-server fallback.",
    )).toHaveLength(1);
  });

  it("flags a ban reworded with extra words in it", () => {
    for (const ban of [
      "Never again call session_load_context.",
      "Do not ever use `session_load_context` after startup.",
      "Must not call the session_load_context tool mid-session.",
    ]) expect(findRecoveryBlockers(ban), ban).toEqual([ban]);
  });

  it("does not flag the scoped rule, the recovery, or unrelated prose", () => {
    expect(findRecoveryBlockers("do not use `session_load_context` in place of it.")).toEqual([]);
    expect(findRecoveryBlockers(
      "Do not substitute session_load_context for the startup call while session_bootstrap is available.",
    )).toEqual([]);
    expect(findRecoveryBlockers(
      "Use session_load_context to recover when a save is refused with context_not_loaded, for an explicit project reload, or as an older-server fallback.",
    )).toEqual([]);
    expect(findRecoveryBlockers("Do not call the deploy script. Use prism-mcp only when no project can be derived.")).toEqual([]);
  });
});

describe("server instructions and tool descriptions", () => {
  it("none forbids or rations session_load_context", () => {
    const offenders = surfaceTexts().flatMap(([where, text]) =>
      findRecoveryBlockers(text).map((sentence) => `${where}: ${sentence}`));
    expect(offenders).toEqual([]);
  });

  it("the server instructions name the recovery, inside the window Claude Code renders", () => {
    const text = PRISM_SERVER_INSTRUCTIONS;
    const marker = "recovery is not a second startup";
    const at = text.indexOf(marker);
    expect(at, "recovery sentence is present").toBeGreaterThan(-1);
    expect(at + marker.length).toBeLessThanOrEqual(CLAUDE_CODE_INSTRUCTION_WINDOW);
    expect(flatten(text)).toContain(
      "Use session_load_context to recover when a save is refused with context_not_loaded " +
      "(pass that save's project and conversation_id, then retry the save once; recovery is not a second startup)",
    );
    // Startup itself is still exactly-once and still not replaceable.
    expect(text).toMatch(/call session_bootstrap exactly once/i);
    expect(text).toMatch(/Do not substitute session_load_context for the startup call/i);
  });

  it("each save tool and the load tool state the same remedy", () => {
    const tools = getAllPossibleTools();
    const description = (name: string) => flatten(tools.find((t) => t.name === name)?.description ?? "");
    for (const save of ["session_save_ledger", "session_save_handoff"]) {
      expect(description(save), save).toContain("refused with context_not_loaded");
      expect(description(save), save).toContain(
        "call session_load_context with the same project and conversation_id, then retry the save once",
      );
    }
    expect(description("session_load_context")).toContain(
      "recover when session_save_ledger or session_save_handoff is refused with context_not_loaded",
    );
    // Pins that already existed and still hold: reload, and the older-server fallback.
    expect(description("session_load_context")).toMatch(/explicit project reload/i);
    expect(description("session_load_context")).toMatch(/fallback only when session_bootstrap is unavailable/i);
    // The first-turn tool says it is the startup call only, and where recovery lives instead.
    expect(description("session_bootstrap")).toContain("Do not substitute session_load_context for this startup call");
    expect(description("session_bootstrap")).toContain("first-turn startup call only");
    expect(description("session_bootstrap")).toContain("rather than repeating this startup display");
  });

  it("the load tool's conversation_id says what recovery needs: without it nothing is registered", () => {
    const load = getAllPossibleTools().find((t) => t.name === "session_load_context");
    const props = (load?.inputSchema as { properties: SchemaProps }).properties;
    const text = flatten(props.conversation_id.description ?? "");
    expect(text).toContain("recovery from context_not_loaded");
    expect(text).toContain("without it nothing is registered");
    expect(text).not.toMatch(/Required on non-Claude hosts/);
  });

  it("the extra text keeps every session tool under Codex's schema budget, so parameter text survives", () => {
    const tools = getAllPossibleTools();
    for (const name of SESSION_TOOLS) {
      const schema = tools.find((t) => t.name === name)?.inputSchema;
      const bytes = Buffer.byteLength(JSON.stringify(schema), "utf8");
      expect(bytes, name).toBeLessThanOrEqual(CODEX_SCHEMA_BUDGET);
    }
  });
});

describe("the shared host-block policy", () => {
  // The three managed blocks (Claude Code, Gemini CLI, Codex) splice these lines
  // unchanged (asserted per host in tests/tools/cli-connect.test.ts). One text, so
  // the hosts cannot drift apart the way three hand-written paragraphs did.
  it("is a single section whose first line is its heading", () => {
    expect(CONTEXT_RECOVERY_POLICY_LINES[0]).toBe("## Prism context recovery");
    expect(CONTEXT_RECOVERY_POLICY_LINES.filter((line) => line.startsWith("## "))).toHaveLength(1);
  });

  it("states the whole contract: scope, call, identifiers, retry, and what not to do", () => {
    const text = flatten(CONTEXT_RECOVERY_POLICY_TEXT);
    expect(text).toContain("Startup is the one turn-one `session_bootstrap` call.");
    expect(text).toContain("`session_save_ledger` or `session_save_handoff` with `context_not_loaded`");
    expect(text).toContain("That is a recovery step, not a second startup.");
    expect(text).toContain(
      "Call `session_load_context` with the same `project` and the same `conversation_id` as the refused save",
    );
    expect(text).toContain("then retry the save once");
    expect(text).toContain("Do not repeat `session_bootstrap` or print a startup display for it.");
    expect(text).toContain("a local note is a fallback after that, never a substitute for the reload");
  });

  it("does not forbid or ration session_load_context", () => {
    expect(findRecoveryBlockers(CONTEXT_RECOVERY_POLICY_TEXT)).toEqual([]);
  });

  it("fits next to the startup block without crowding Codex's 32 KiB AGENTS.md limit", () => {
    expect(Buffer.byteLength(CONTEXT_RECOVERY_POLICY_TEXT, "utf8")).toBeLessThan(900);
  });
});

describe("in-repo agent-facing documents", () => {
  const AGENT_FACING = [
    "plugins/prism/skills/prism-startup/SKILL.md",
    ".agents/rules/prism-startup.md",
  ];
  const HUMAN_DOCS = ["docs/COMPACTION.md", "docs/IDE_SETUP.md", "docs/SETUP_GEMINI.md", "README.md"];

  it("none forbids or rations session_load_context", () => {
    const offenders = [...AGENT_FACING, ...HUMAN_DOCS].flatMap((file) =>
      findRecoveryBlockers(read(file)).map((sentence) => `${file}: ${sentence}`));
    expect(offenders).toEqual([]);
  });

  it.each(AGENT_FACING)("%s tells the agent the recovery, scoped away from startup", (file) => {
    const text = flatten(read(file)).replace(/`/g, "");
    expect(text).toContain("context_not_loaded");
    expect(text).toMatch(
      /session_load_context(?:\(project, conversation_id\))? with the same project and (?:the same )?conversation_id/,
    );
    expect(text).toContain("retry the save once");
    expect(text).toMatch(/not a second startup/);
    expect(text).toMatch(/do not repeat session_bootstrap/i);
    expect(text).toMatch(/a local note is a fallback after that, never a substitute/);
  });

  it("the startup skill's re-entry rule is scoped to startup, and its recovery section exists once", () => {
    const text = read("plugins/prism/skills/prism-startup/SKILL.md");
    expect(flatten(text)).toContain("This re-entry rule covers startup only");
    expect(text.match(/^## Recovering from `context_not_loaded`$/gm)).toHaveLength(1);
  });
});
