/**
 * Frontmatter-declared prompt triggers — the fix for scoped skills being
 * delivered but never routed.
 *
 * Account/team skills cannot appear in the PUBLIC routing table (their names
 * and trigger words would be world-readable), so they were installed and inert:
 * a saved skill never surfaced on any prompt, on any host. Triggers now ride
 * inside the skill body, which already arrives over the authenticated manifest.
 *
 * The tests that matter most here are the NEGATIVE ones — a trigger that fires
 * on everything is worse than no trigger — and the SAFETY ones, because these
 * patterns are user-authored and compiled on the startup path of every session
 * the skill is shared with.
 */
import { describe, it, expect } from "vitest";
import {
  extractSkillTriggers,
  collectScopedTriggers,
  MAX_TRIGGERS_PER_SKILL,
  MAX_TRIGGER_LENGTH,
} from "../../src/tools/scopedSkillTriggers.js";
import { _applyPromptRouting } from "../../src/tools/skillRouting.js";

const skill = (triggers: string, name = "acme-billing") =>
  `---\nname: ${name}\ndescription: a scoped skill\n${triggers}\n---\n# ${name}\nbody\n`;

describe("extractSkillTriggers — frontmatter shapes", () => {
  it("reads a YAML block list", () => {
    const { triggers } = extractSkillTriggers(
      "acme-billing",
      skill('prompt_triggers:\n  - "\\binvoice\\b"\n  - "quarterly close"'),
    );
    expect(Object.keys(triggers)).toEqual(["\\binvoice\\b", "quarterly close"]);
    expect(triggers["\\binvoice\\b"]).toEqual(["acme-billing"]);
  });

  it("reads an inline array", () => {
    const { triggers } = extractSkillTriggers("acme-billing", skill('prompt_triggers: ["alpha", "beta"]'));
    expect(Object.keys(triggers).sort()).toEqual(["alpha", "beta"]);
  });

  it("applies YAML double-quote escaping so \\b becomes a word boundary, not a literal backslash", () => {
    // The silent-inert trap: a double-quoted YAML scalar means one backslash.
    // Passing the raw text through produces a regex that never fires, which
    // looks identical to the delivery bug this feature fixes.
    const { triggers } = extractSkillTriggers("t", skill('prompt_triggers:\n  - "\\binvoice\\b"', "t"));
    const pattern = Object.keys(triggers)[0];
    expect(pattern).toBe("\\binvoice\\b");
    expect(new RegExp(pattern, "i").test("submit the invoice today")).toBe(true);
    expect(new RegExp(pattern, "i").test("invoiced")).toBe(false);
  });

  it("takes single-quoted scalars literally, as YAML specifies", () => {
    const { triggers } = extractSkillTriggers("t", skill("prompt_triggers:\n  - '\\bclose\\b'", "t"));
    expect(Object.keys(triggers)[0]).toBe("\\bclose\\b");
  });

  it("returns nothing for a skill that declares none — the overwhelming majority", () => {
    const { triggers, errors } = extractSkillTriggers("plain", `---\nname: plain\ndescription: d\n---\n# plain`);
    expect(triggers).toEqual({});
    expect(errors).toEqual([]);
  });

  it("stops the block list at the next key instead of swallowing the frontmatter", () => {
    // An unterminated list used to consume `description:` and register it as a
    // trigger — a pattern matching most prompts, on a skill nobody asked for.
    const { triggers } = extractSkillTriggers(
      "acme-billing",
      `---\nname: acme-billing\nprompt_triggers:\n  - "real"\ndescription: not a trigger\n---\n# x`,
    );
    expect(Object.keys(triggers)).toEqual(["real"]);
  });
});

describe("safety — user-authored patterns run on the startup path", () => {
  it("REFUSES a catastrophically backtracking pattern before compiling it", () => {
    // JavaScript has no regex timeout: once (a+)+ starts on a hostile input
    // there is no way to interrupt it, so it must never be compiled. A team
    // skill carrying one would hang startup for every member.
    const { triggers, errors } = extractSkillTriggers("evil", skill('prompt_triggers:\n  - "(a+)+$"', "evil"));
    expect(triggers).toEqual({});
    expect(errors[0].reason).toMatch(/backtrack/i);
  });

  it("refuses an invalid regex rather than throwing during startup", () => {
    const { triggers, errors } = extractSkillTriggers("bad", skill('prompt_triggers:\n  - "([unclosed"', "bad"));
    expect(triggers).toEqual({});
    expect(errors[0].reason).toMatch(/invalid regex/i);
  });

  it("caps pattern length", () => {
    const long = "a".repeat(MAX_TRIGGER_LENGTH + 1);
    const { triggers, errors } = extractSkillTriggers("long", skill(`prompt_triggers:\n  - "${long}"`, "long"));
    expect(triggers).toEqual({});
    expect(errors[0].reason).toMatch(/exceeds/i);
  });

  it("caps trigger count and reports the dropped ones instead of truncating silently", () => {
    const many = Array.from({ length: MAX_TRIGGERS_PER_SKILL + 2 }, (_, i) => `  - "pattern${i}"`).join("\n");
    const { triggers, errors } = extractSkillTriggers("many", skill(`prompt_triggers:\n${many}`, "many"));
    expect(Object.keys(triggers)).toHaveLength(MAX_TRIGGERS_PER_SKILL);
    expect(errors).toHaveLength(2);
    expect(errors[0].reason).toMatch(/exceeds 5 triggers/);
  });
});

describe("routing — matched scoped skills join the prompt category", () => {
  const triggers = collectScopedTriggers([
    ["acme-billing", skill('prompt_triggers:\n  - "\\bNorthwind Payments\\b"\n  - "\\bledger\\b.{0,20}\\binvoice\\b"')],
    ["plain-skill", `---\nname: plain-skill\ndescription: d\n---\n# no triggers`],
  ]).triggers;

  it("POSITIVE: a realistic prompt surfaces the scoped skill", () => {
    const matched = _applyPromptRouting([], "how do I submit the Northwind Payments invoice?", triggers);
    expect(matched.map((s) => s.name)).toContain("acme-billing");
    expect(matched.find((s) => s.name === "acme-billing")?.category).toBe("prompt");
  });

  it("POSITIVE: the second declared trigger fires independently", () => {
    const matched = _applyPromptRouting([], "the ledger portal rejected my invoice", triggers);
    expect(matched.map((s) => s.name)).toContain("acme-billing");
  });

  it("NEGATIVE: unrelated prompts do NOT load it — 6 controls", () => {
    const controls = [
      "fix the failing test in the payment module",
      "what changed in the last release?",
      "write a migration for the users table",
      "the sidebar is broken in dark mode",
      "summarize yesterday's session",
      "deploy the portal to production",
    ];
    for (const prompt of controls) {
      expect(_applyPromptRouting([], prompt, triggers).map((s) => s.name)).not.toContain("acme-billing");
    }
  });

  it("a skill declaring no triggers is never routed by this mechanism", () => {
    const everything = ["invoice", "Northwind Payments", "anything at all"];
    for (const prompt of everything) {
      expect(_applyPromptRouting([], prompt, triggers).map((s) => s.name)).not.toContain("plain-skill");
    }
  });
});
