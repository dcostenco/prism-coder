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

describe("injection", () => {
  it("returns bodies with an IMPERATIVE header, not a decorative list", async () => {
    // A bare list of names is what the original delivery bug produced: the
    // agent saw names and did nothing with them.
    const r = await routePrompt("the totals are not sticky", [], deps());
    expect(r.names).toContain("visual-screenshot-verification");
    expect(r.text).toMatch(/Read and follow them before proceeding/);
    expect(r.text).toContain("Render it and look at it.");
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
      resolvePromptSkillNames: async () => ["team-private-skill"],
      entitledNames: async () => new Set<string>(),
      collectTriggers: async () => ({ triggers: {}, localNames: new Set(["team-private-skill"]) }),
    }));
    expect(r.names).toEqual(["team-private-skill"]);
    expect(r.text).toContain("Account-scoped body");
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
