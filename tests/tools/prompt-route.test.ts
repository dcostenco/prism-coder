/**
 * session_route_prompt — mid-session routing.
 *
 * The behaviours that matter are the CHEAP ones. An instruction telling the
 * agent to call this on every new task is only defensible if the common answer
 * costs almost nothing, so "no match" and "already loaded" are pinned as hard
 * as the injection path itself.
 */
import { describe, it, expect } from "vitest";
import {
  routePrompt,
  reshapeForInlineBudget,
  MAX_ROUTED_SKILLS,
  MAX_ROUTED_CHARS,
  HOOK_INLINE_SAFE_CHARS,
} from "../../src/tools/promptRouteHandler.js";

const BODIES: Record<string, string> = {
  "visual-screenshot-verification": "# visual\nRender it and look at it.",
  "verified-shipping": "# shipping\nEvidence before claims.",
  "playwright-screenshot-discipline": "# playwright\nValidate every capture.",
  "team-private-skill": "# private\nAccount-scoped body.",
};

const deps = (over: Partial<Parameters<typeof routePrompt>[2]> = {}) => ({
  resolvePromptSkillNames: async (prompt: string) =>
    /ui\s*\/?\s*ux|not sticky|overlap/i.test(prompt)
      ? ["visual-screenshot-verification", "playwright-screenshot-discipline", "verified-shipping"]
      : [],
  collectTriggers: async () => ({ triggers: {}, localNames: new Set<string>() }),
  entitledNames: async () => new Set(Object.keys(BODIES)),
  getBody: async (name: string) => BODIES[name] ?? "",
  manifestVersion: async () => 32,
  ...over,
});

describe("the cheap path — this is called often, so silence must be nearly free", () => {
  it("returns one line when nothing matches", async () => {
    const r = await routePrompt("rename this variable", [], deps());
    expect(r.names).toEqual([]);
    expect(r.text).toBe("No new skills for this prompt.");
    expect(r.text.length).toBeLessThan(60);
  });

  it("returns nothing new when the caller already has every match", async () => {
    // The repeat-call case. Without this, an every-turn instruction would
    // re-inject the same bodies and the budget would drain by turn three.
    const loaded = ["visual-screenshot-verification", "playwright-screenshot-discipline", "verified-shipping"];
    const r = await routePrompt("make a UI/UX review", loaded, deps());
    expect(r.names).toEqual([]);
    expect(r.alreadyLoaded).toHaveLength(3);
    expect(r.text).toBe("No new skills for this prompt.");
  });

  it("injects ONLY the skill that is genuinely missing", async () => {
    const r = await routePrompt("make a UI/UX review", ["visual-screenshot-verification", "verified-shipping"], deps());
    expect(r.names).toEqual(["playwright-screenshot-discipline"]);
    expect(r.text).toContain("Validate every capture");
    expect(r.text).not.toContain("Render it and look at it");
  });

  it("an empty prompt routes nothing rather than matching everything", async () => {
    const r = await routePrompt("   ", [], deps());
    expect(r.names).toEqual([]);
  });
});

describe("machine-written turns are not routed as if a person typed them", () => {
  // Measured 2026-09-23 over 30 days of Claude Code sessions: most hook skill
  // loads came from turns the host delivers but no person wrote — task
  // notifications, agent hand-backs. A reviewer's report that mentions UI/UX
  // is not a request for the UI/UX skills.
  const recording = () => {
    const asked: string[] = [];
    const d = deps({
      resolvePromptSkillNames: async (prompt: string) => {
        asked.push(prompt);
        if (/simulator/i.test(prompt)) return ["verified-shipping"];
        return /ui\s*\/?\s*ux/i.test(prompt) ? ["visual-screenshot-verification"] : [];
      },
    });
    return { asked, d };
  };
  const agentFinished =
    "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n" +
    '<summary>Agent "Adversarial review" finished</summary>\n' +
    "<result>The UI/UX review found the modal overlaps the toolbar.</result>\n</task-notification>";
  const backgroundDone =
    "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n" +
    '<summary>Background command "Build the app for the iPhone simulator" completed (exit code 0)</summary>\n' +
    "<result>UI/UX snapshot tests passed</result>\n</task-notification>";

  it.each([
    ["an agent's task notification", agentFinished],
    ["an agent hand-back relayed as a message", 'Another Claude session sent a message:\n<agent-message from="a2">UI/UX findings attached</agent-message>'],
    ["a bare agent message", '<agent-message from="a3">UI/UX findings attached</agent-message>'],
    ["a cross-session message", '<cross-session-message from="s1">please do a UI/UX pass</cross-session-message>'],
    ["a continuation summary", "This session is being continued from a previous conversation. The user asked for a UI/UX review."],
    ["a notification after leading whitespace", `\n  ${agentFinished}`],
  ])("%s routes nothing and never reaches the matcher", async (_label, turn) => {
    const { asked, d } = recording();
    const r = await routePrompt(turn, [], d);
    expect(r.names).toEqual([]);
    expect(asked).toEqual([]);
    expect(r.text.length).toBeLessThan(60);
  });

  it("a finished background command routes on its own summary, never on its output", async () => {
    const { asked, d } = recording();
    const r = await routePrompt(backgroundDone, [], d);
    expect(asked).toEqual(['Background command "Build the app for the iPhone simulator" completed (exit code 0)']);
    expect(r.names).toEqual(["verified-shipping"]);
  });

  it("a person who pastes a notification after their own words still routes", async () => {
    // The markers are matched at the START only. A substring test would drop
    // a real request whenever someone pastes machine output to ask about it.
    const { asked, d } = recording();
    const prompt = `why did this UI/UX review fail?\n${agentFinished}`;
    const r = await routePrompt(prompt, [], d);
    expect(asked).toEqual([prompt]);
    expect(r.names).toEqual(["visual-screenshot-verification"]);
  });

  it("a person's sentence that merely mentions another session still routes", async () => {
    const { d } = recording();
    const r = await routePrompt("Another Claude session broke the UI/UX, review it", [], d);
    expect(r.names).toEqual(["visual-screenshot-verification"]);
  });

  it("a person's sentence that starts like the relay line still routes", async () => {
    // The host's relay line ends in a colon; a sentence that merely starts
    // with the same words is a person talking.
    const { d } = recording();
    const r = await routePrompt("Another Claude session sent a message about the UI/UX, review it", [], d);
    expect(r.names).toEqual(["visual-screenshot-verification"]);
  });

  it("a task notification whose tag carries attributes is still machine-written", async () => {
    const { asked, d } = recording();
    const r = await routePrompt(agentFinished.replace("<task-notification>", '<task-notification id="n1">'), [], d);
    expect(r.names).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("only a summary that STARTS with Background command routes", async () => {
    const { asked, d } = recording();
    const turn = agentFinished.replace(
      '<summary>Agent "Adversarial review" finished</summary>',
      '<summary>Agent "Adversarial review" finished after a Background command build for the simulator</summary>',
    );
    const r = await routePrompt(turn, [], d);
    expect(r.names).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe("injection", () => {
  it("returns bodies with an IMPERATIVE header, not a decorative list", async () => {
    // A bare list of names is what the original delivery bug produced: the
    // agent saw names and did nothing with them.
    const r = await routePrompt("the totals are not sticky", [], deps());
    expect(r.names).toContain("visual-screenshot-verification");
    expect(r.text).toMatch(/Read and follow them before proceeding/);
    expect(r.text).toContain("Render it and look at it.");
  });

  it("stamps the routing table's version on the header, so a recorded load can be attributed", async () => {
    const r = await routePrompt("the totals are not sticky", [], deps({
      resolvePromptRouting: async () => ({ names: ["visual-screenshot-verification"], tableVersion: 41 }),
      resolvePromptSkillNames: async () => { throw new Error("the versioned resolver must be preferred"); },
    }));
    expect(r.names).toEqual(["visual-screenshot-verification"]);
    expect(r.header).toMatch(/\n\nRouting table v41\.$/);
    expect(r.text).toContain("Routing table v41.");
    // The skills line itself stays a plain list: transcript readers parse it.
    expect(r.text).toMatch(/^\*\*Skills now active for this task:\*\* visual-screenshot-verification\n/);
  });

  it("states no version when no public table was matched", async () => {
    const noTable = await routePrompt("the totals are not sticky", [], deps({
      resolvePromptRouting: async () => ({ names: ["visual-screenshot-verification"] }),
    }));
    expect(noTable.text).not.toContain("Routing table");
    const unwired = await routePrompt("the totals are not sticky", [], deps());
    expect(unwired.text).not.toContain("Routing table");
  });

  it("caps how many bodies one call can inject", async () => {
    const many = Array.from({ length: 9 }, (_, i) => `skill${i}`);
    const r = await routePrompt("ui/ux", [], deps({
      resolvePromptSkillNames: async () => many,
      entitledNames: async () => new Set(many),
      getBody: async (n: string) => `# ${n}\nbody`,
    }));
    expect(r.names).toHaveLength(MAX_ROUTED_SKILLS);
    expect(r.overflow).toHaveLength(9 - MAX_ROUTED_SKILLS);
    expect(r.text).toContain("Also matched, not injected");
  });

  it("drops a body that would blow the character ceiling, and says so", async () => {
    const huge = "x".repeat(MAX_ROUTED_CHARS + 1);
    const r = await routePrompt("ui/ux", [], deps({
      resolvePromptSkillNames: async () => ["big", "small"],
      entitledNames: async () => new Set(["big", "small"]),
      getBody: async (n: string) => (n === "big" ? huge : "# small\nfits"),
    }));
    expect(r.names).toEqual(["small"]);
    expect(r.overflow).toContain("big");
  });

  it("says a routed skill has no content instead of returning a bare name", async () => {
    // Routed-but-undeliverable is the exact defect this feature exists to
    // surface, so it must be loud rather than an empty section.
    const r = await routePrompt("ui/ux", [], deps({
      resolvePromptSkillNames: async () => ["ghost"],
      entitledNames: async () => new Set(["ghost"]),
      getBody: async () => "",
    }));
    expect(r.names).toEqual(["ghost"]);
    expect(r.text).toMatch(/no content on this machine/i);
  });

  it("injects a user-owned local body when no delivered cache body exists", async () => {
    const r = await routePrompt("local workflow", [], deps({
      resolvePromptSkillNames: async () => ["my-local"],
      collectTriggers: async () => ({
        triggers: { "\\blocal\\b": ["my-local"] },
        localNames: new Set(["my-local"]),
        localBodies: new Map([["my-local", "# my-local\nLOCAL BODY"]]),
      }),
      entitledNames: async () => new Set(),
      getBody: async () => "",
    }));
    expect(r.names).toEqual(["my-local"]);
    expect(r.text).toContain("LOCAL BODY");
  });

  it("does not let a same-name local file shadow a delivered platform body", async () => {
    const r = await routePrompt("shared workflow", [], deps({
      resolvePromptSkillNames: async () => ["shared-skill"],
      collectTriggers: async () => ({
        triggers: { "\\bshared\\b": ["shared-skill"] },
        localNames: new Set(["shared-skill"]),
        localBodies: new Map([["shared-skill", "LOCAL SHADOW"]]),
      }),
      entitledNames: async () => new Set(["shared-skill"]),
      getBody: async () => "PLATFORM BODY",
    }));
    expect(r.text).toContain("PLATFORM BODY");
    expect(r.text).not.toContain("LOCAL SHADOW");
  });

  it("does not expose a stale cached paid body through an unentitled same-name local skill", async () => {
    const r = await routePrompt("shared workflow", [], deps({
      resolvePromptSkillNames: async () => ["shared-skill"],
      collectTriggers: async () => ({
        triggers: { "\\bshared\\b": ["shared-skill"] },
        localNames: new Set(["shared-skill"]),
        localBodies: new Map([["shared-skill", "SAFE LOCAL BODY"]]),
      }),
      entitledNames: async () => new Set(),
      getBody: async () => "STALE PAID BODY",
    }));
    expect(r.text).toContain("SAFE LOCAL BODY");
    expect(r.text).not.toContain("STALE PAID BODY");
  });
});

describe("host inline budget — hosts hard-cap hook context (Claude Code 10k chars, Codex ~2.5k tokens)", () => {
  // Three live instances on 2026-08-13: 13.2KB/18KB/18.9KB injections were
  // offloaded by Claude Code to a file the model never read past a 2KB
  // preview. The full payload must therefore be OUR offload, with an
  // imperative pointer that survives any preview window.
  const SIX_K = "R".repeat(6_000);
  const threeBigSkills = () => deps({
    resolvePromptSkillNames: async () => ["alpha", "beta", "gamma"],
    entitledNames: async () => new Set(["alpha", "beta", "gamma"]),
    getBody: async (n: string) => `# ${n}\n${SIX_K}`,
  });

  it("pins the budget under Claude Code's documented 10,000-char hook cap", () => {
    expect(HOOK_INLINE_SAFE_CHARS).toBeLessThan(10_000);
    expect(HOOK_INLINE_SAFE_CHARS).toBeGreaterThan(8_000);
  });

  it("over budget: inline fits the cap, the file gets the FULL text, and the Read pointer sits in the first 2KB", async () => {
    const r = await routePrompt("ui/ux", [], threeBigSkills());
    expect(r.text.length).toBeGreaterThan(HOOK_INLINE_SAFE_CHARS); // precondition: this IS the failing payload
    let written: string | undefined;
    const shaped = reshapeForInlineBudget(r, HOOK_INLINE_SAFE_CHARS, (full) => {
      written = full;
      return "/tmp/prism-test/route-1.md";
    });
    expect(shaped.offloaded).toBe(true);
    expect(shaped.text.length).toBeLessThanOrEqual(HOOK_INLINE_SAFE_CHARS);
    expect(written).toBe(r.text); // byte-complete: the file is the payload, not a summary
    const preview = shaped.text.slice(0, 2_048); // what Claude Code's preview would show
    expect(preview).toContain("/tmp/prism-test/route-1.md");
    expect(preview).toMatch(/Read that file now/i);
    expect(preview).toContain("**Skills now active for this task:** alpha, beta, gamma");
  });

  it("inlines whole priority bodies that still fit under the budget", async () => {
    const r = await routePrompt("ui/ux", [], threeBigSkills());
    const shaped = reshapeForInlineBudget(r, HOOK_INLINE_SAFE_CHARS, () => "/tmp/p.md");
    // 6k bodies: the first fits under 9.8k alongside header+pointer, the rest must not.
    expect(shaped.text).toContain("### alpha");
    expect(shaped.text).not.toContain("### gamma");
  });

  it("under budget: text passes through untouched and nothing is written", async () => {
    const r = await routePrompt("make a UI/UX review", [], deps());
    let calls = 0;
    const shaped = reshapeForInlineBudget(r, HOOK_INLINE_SAFE_CHARS, () => {
      calls += 1;
      return "/tmp/never.md";
    });
    expect(shaped.offloaded).toBe(false);
    expect(shaped.text).toBe(r.text);
    expect(calls).toBe(0);
  });

  it("offload write failure degrades LOUDLY: skipped skills are named with a fetch instruction", async () => {
    const r = await routePrompt("ui/ux", [], threeBigSkills());
    const shaped = reshapeForInlineBudget(r, HOOK_INLINE_SAFE_CHARS, () => undefined);
    expect(shaped.text.length).toBeLessThanOrEqual(HOOK_INLINE_SAFE_CHARS);
    expect(shaped.text).toMatch(/knowledge_search/);
    expect(shaped.text).toContain("gamma"); // the dropped skill is named, not silently gone
  });

  it("a 400-skill match cannot blow the budget through the overflow header, and the pointer stays in the first 2KB", async () => {
    // Adversarial review measured the unbounded overflow list at 12,950 header
    // chars for 400 matched skills — over the host cap before any body, with
    // the pointer pushed past every preview window. The cap must hold by
    // construction, not because the catalog happens to be small.
    const many = Array.from({ length: 400 }, (_, i) => `team-scoped-skill-with-a-long-name-${String(i).padStart(3, "0")}`);
    const r = await routePrompt("ui/ux", [], deps({
      resolvePromptSkillNames: async () => many,
      entitledNames: async () => new Set(many),
      getBody: async () => `# body\n${"x".repeat(6_000)}`,
    }));
    const shaped = reshapeForInlineBudget(r, HOOK_INLINE_SAFE_CHARS, () => "/tmp/prism-test/route-400.md");
    expect(shaped.text.length).toBeLessThanOrEqual(HOOK_INLINE_SAFE_CHARS);
    expect(shaped.text.slice(0, 2_048)).toContain("/tmp/prism-test/route-400.md");
    expect(shaped.text).toContain("+"); // capped overflow list says "+N more" instead of listing 397 names
  });

  it("writer failure with long skill names cannot overrun the budget — the footer reserve is computed, not guessed", async () => {
    // Measured pre-fix: fixed reserve of 300 emitted 9,899 > 9,800 with two
    // ~148-char skipped names.
    const longNames = ["a".repeat(148), "b".repeat(148), "c".repeat(148)];
    const r = await routePrompt("ui/ux", [], deps({
      resolvePromptSkillNames: async () => longNames,
      entitledNames: async () => new Set(longNames),
      // Sized so the first body lands just under the old fixed reserve's fill
      // line (budget−300) while the real footer for the two skipped 148-char
      // names is ~417 chars — the geometry the review measured overrunning.
      getBody: async () => `# body\n${"x".repeat(8_700)}`,
    }));
    const shaped = reshapeForInlineBudget(r, HOOK_INLINE_SAFE_CHARS, () => undefined);
    expect(shaped.text.length).toBeLessThanOrEqual(HOOK_INLINE_SAFE_CHARS);
    // The footer must arrive INTACT — a guessed reserve plus the final clamp
    // would slice its tail off, which the length assertion alone cannot see.
    // (This is the mutation-killing check for the computed reserve.)
    expect(shaped.text.endsWith("before proceeding.**")).toBe(true);
  });

  it("giant delivered names cannot destroy the pointer — it leads the text, so even the clamp preserves it", async () => {
    // Round-2 review: with the pointer AFTER the header, 4,000-char names put
    // the header at 12,127 chars and the clamp sliced the pointer off
    // entirely — an offload file on disk that nothing tells the model to
    // read. Skill names have no enforced bound anywhere (portal manifest).
    const giants = ["G".repeat(4_000), "H".repeat(4_000), "I".repeat(4_000)];
    const r = await routePrompt("ui/ux", [], deps({
      resolvePromptSkillNames: async () => giants,
      entitledNames: async () => new Set(giants),
      getBody: async () => `# body\n${"x".repeat(6_000)}`,
    }));
    const shaped = reshapeForInlineBudget(r, HOOK_INLINE_SAFE_CHARS, () => "/tmp/prism-test/route-giant.md");
    expect(shaped.text.length).toBeLessThanOrEqual(HOOK_INLINE_SAFE_CHARS); // kills clamp deletion
    expect(shaped.text.slice(0, 2_048)).toContain("/tmp/prism-test/route-giant.md"); // kills pointer-after-header
    expect(shaped.text.slice(0, 2_048)).toMatch(/Read that file now/i);
  });

  it("moderately long names cannot push the pointer past the 2KB preview window", async () => {
    // The more reachable round-2 regime: 200-char names (within NAME_MAX),
    // header 2,372 chars, clamp never fires — yet the trailing pointer sat at
    // offset ~2,374, past every preview window.
    const mediums = Array.from({ length: 11 }, (_, i) => `${"m".repeat(196)}${String(i).padStart(3, "0")}`);
    const r = await routePrompt("ui/ux", [], deps({
      resolvePromptSkillNames: async () => mediums,
      entitledNames: async () => new Set(mediums),
      getBody: async () => `# body\n${"x".repeat(6_000)}`,
    }));
    const shaped = reshapeForInlineBudget(r, HOOK_INLINE_SAFE_CHARS, () => "/tmp/prism-test/route-med.md");
    expect(shaped.text.slice(0, 2_048)).toContain("/tmp/prism-test/route-med.md");
  });

  it("the exact-fixpoint reserve does not skip a body that fits — no over-reservation regression", async () => {
    // Round-2 finding 3: reserving for ALL delivered names (instead of the
    // actually-skipped set) skipped a body that previously inlined. Geometry:
    // three long-named skills, third body huge (skipped either way). The
    // fixpoint reserves only for the ONE skipped name (~263 chars), so the
    // second body fits; an all-names reserve (~563) would skip it too.
    const names = [`A${"a".repeat(147)}`, `B${"b".repeat(147)}`, `C${"c".repeat(147)}`];
    const bodies: Record<string, string> = {
      [names[0]]: `#1\n${"x".repeat(4_000)}`,
      [names[1]]: `#2\n${"y".repeat(4_512)}`,
      [names[2]]: `#3\n${"z".repeat(6_000)}`,
    };
    const r = await routePrompt("ui/ux", [], deps({
      resolvePromptSkillNames: async () => names,
      entitledNames: async () => new Set(names),
      getBody: async (n: string) => bodies[n] ?? "",
    }));
    const shaped = reshapeForInlineBudget(r, HOOK_INLINE_SAFE_CHARS, () => undefined);
    expect(shaped.text.length).toBeLessThanOrEqual(HOOK_INLINE_SAFE_CHARS);
    expect(shaped.text).toContain("y".repeat(100)); // second body INLINED — kills the all-names reserve
    expect(shaped.text).toContain(`### ${names[1]}`);
    expect(shaped.text).toMatch(/Not inlined .*C/s); // the huge third is named, not silently gone
    expect(shaped.text.endsWith("before proceeding.**")).toBe(true); // footer intact under the clamp
  });
});

describe("entitlement and privacy", () => {
  it("refuses a matched skill the account is not entitled to", async () => {
    const r = await routePrompt("ui/ux", [], deps({ entitledNames: async () => new Set<string>() }));
    expect(r.names).toEqual([]);
  });

  it("allows a LOCAL skill that entitlement cannot see", async () => {
    // Local skills live on disk and are absent from the delivery manifest, so
    // the entitlement filter would drop them without this bypass — the same
    // one session_bootstrap applies.
    const r = await routePrompt("ui/ux", [], deps({
      resolvePromptSkillNames: async () => ["local-private-skill"],
      entitledNames: async () => new Set<string>(),
      collectTriggers: async () => ({
        triggers: {},
        localNames: new Set(["local-private-skill"]),
        localBodies: new Map([["local-private-skill", "# local\nLocal body"]]),
      }),
    }));
    expect(r.names).toEqual(["local-private-skill"]);
    expect(r.text).toContain("Local body");
  });

  it("still routes when on-device trigger collection fails", async () => {
    const r = await routePrompt("make a UI/UX review", [], deps({
      collectTriggers: async () => { throw new Error("disk gone"); },
    }));
    expect(r.names.length).toBeGreaterThan(0);
  });

  it("never throws when the matcher itself fails — the turn must survive", async () => {
    const r = await routePrompt("ui/ux", [], deps({
      resolvePromptSkillNames: async () => { throw new Error("table unreachable"); },
    }));
    expect(r.names).toEqual([]);
    expect(r.text).toBe("No new skills for this prompt.");
  });
});
