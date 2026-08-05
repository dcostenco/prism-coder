import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  materializeAgentDefinitions,
  resolveClaudeAgentsDir,
  validateAgentSection,
  type AgentSection,
} from "../src/agentManifestSync.js";
import {
  _resetSkillManifestSyncForTest,
  computeSkillManifestGeneration,
  synchronizeSkillManifest,
  type SkillManifest,
} from "../src/skillManifestSync.js";
import { FREE_NATIVE_SKILL_NAMES, REQUIRED_NATIVE_SKILL_NAMES } from "../src/tools/skillRouting.js";

const roots: string[] = [];
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "prism-agent-sync-"));
  roots.push(root);
  return root;
}

function definition(name: string, body = `# ${name} body\n`) {
  const content = `---\nname: ${name}\neffort: low\n---\n${body}`;
  return { name, content, digest: digest(content) };
}

function section(...agents: ReturnType<typeof definition>[]): AgentSection {
  return { agents, generation: digest(JSON.stringify(agents.map((agent) => agent.digest))) };
}

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("validateAgentSection", () => {
  it("returns null for a payload that predates agents", () => {
    expect(validateAgentSection({ schema_version: 1, skills: [] })).toBeNull();
  });

  it("parses a valid section and normalizes digest case", () => {
    const agent = definition("fast-scanner");
    const parsed = validateAgentSection({
      agents: [{ ...agent, digest: agent.digest.toUpperCase() }],
      agents_generation: digest("gen"),
    });
    expect(parsed?.agents).toEqual([agent]);
  });

  it("throws on drift instead of treating it as an empty section", () => {
    const agent = definition("fast-scanner");
    expect(() => validateAgentSection({ agents: [agent], agents_generation: "not-a-hash" }))
      .toThrow(/invalid agent section/);
    expect(() => validateAgentSection({ agents: [{ ...agent, digest: digest("other") }], agents_generation: digest("gen") }))
      .toThrow(/digest mismatch/);
    expect(() => validateAgentSection({ agents: [{ ...agent, name: "../escape" }], agents_generation: digest("gen") }))
      .toThrow(/invalid agent name/);
    expect(() => validateAgentSection({
      agents: [agent, { ...definition("FAST-scanner") }], agents_generation: digest("gen"),
    })).toThrow(/duplicate agent name/);
  });
});

describe("resolveClaudeAgentsDir", () => {
  it("auto-detects only when ~/.claude exists and no custom root is configured", async () => {
    const home = await tempRoot();
    expect(await resolveClaudeAgentsDir({ homeDir: home })).toBeNull();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".claude"));
    expect(await resolveClaudeAgentsDir({ homeDir: home })).toBe(join(home, ".claude", "agents"));
    expect(await resolveClaudeAgentsDir({ homeDir: home, agentsSkillsDir: "/custom" })).toBeNull();
    expect(await resolveClaudeAgentsDir({ homeDir: home, claudeCodeAgentsDir: false })).toBeNull();
    expect(await resolveClaudeAgentsDir({ homeDir: home, claudeCodeAgentsDir: "/explicit" })).toBe("/explicit");
  });
});

describe("materializeAgentDefinitions", () => {
  it("installs into an empty root and commits an owned index", async () => {
    const root = await tempRoot();
    const dir = join(root, "agents");
    const scanner = definition("fast-scanner");
    const outcome = await materializeAgentDefinitions(section(scanner), dir);
    expect(outcome).toEqual({ installed: ["fast-scanner"], updated: [], pruned: [], conflicts: [] });
    expect(await readFile(join(dir, "fast-scanner.md"), "utf8")).toBe(scanner.content);
    const index = JSON.parse(await readFile(join(dir, ".prism-agents.json"), "utf8"));
    expect(index.owner).toBe("prism-mcp");
    expect(index.files["fast-scanner"]).toBe(scanner.digest);
  });

  it("is idempotent: an unchanged section performs no writes", async () => {
    const dir = join(await tempRoot(), "agents");
    const scanner = definition("fast-scanner");
    await materializeAgentDefinitions(section(scanner), dir);
    const outcome = await materializeAgentDefinitions(section(scanner), dir);
    expect(outcome).toEqual({ installed: [], updated: [], pruned: [], conflicts: [] });
  });

  it("updates a pristine owned file when the definition changes", async () => {
    const dir = join(await tempRoot(), "agents");
    await materializeAgentDefinitions(section(definition("fast-scanner", "v1\n")), dir);
    const v2 = definition("fast-scanner", "v2\n");
    const outcome = await materializeAgentDefinitions(section(v2), dir);
    expect(outcome.updated).toEqual(["fast-scanner"]);
    expect(await readFile(join(dir, "fast-scanner.md"), "utf8")).toBe(v2.content);
  });

  it("NEVER overwrites a hand-edited managed file — conflict, bytes preserved", async () => {
    const dir = join(await tempRoot(), "agents");
    await materializeAgentDefinitions(section(definition("deep-verifier", "shipped\n")), dir);
    const handEdit = "---\nname: deep-verifier\neffort: max\n---\nlocal tuning\n";
    await writeFile(join(dir, "deep-verifier.md"), handEdit);
    const outcome = await materializeAgentDefinitions(section(definition("deep-verifier", "shipped v2\n")), dir);
    expect(outcome.conflicts).toEqual(["deep-verifier"]);
    expect(outcome.updated).toEqual([]);
    expect(await readFile(join(dir, "deep-verifier.md"), "utf8")).toBe(handEdit);
    // Ownership is dropped: the index no longer claims the edited file.
    const index = JSON.parse(await readFile(join(dir, ".prism-agents.json"), "utf8"));
    expect(index.files["deep-verifier"]).toBeUndefined();
  });

  it("never touches a foreign file it did not write, unless byte-identical", async () => {
    const dir = join(await tempRoot(), "agents");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    const foreign = "user-authored agent\n";
    await writeFile(join(dir, "fast-scanner.md"), foreign);
    const incoming = definition("fast-scanner");
    const outcome = await materializeAgentDefinitions(section(incoming), dir);
    expect(outcome.conflicts).toEqual(["fast-scanner"]);
    expect(await readFile(join(dir, "fast-scanner.md"), "utf8")).toBe(foreign);

    // Byte-identical foreign content is adopted without a write.
    await writeFile(join(dir, "fast-scanner.md"), incoming.content);
    const adopt = await materializeAgentDefinitions(section(incoming), dir);
    expect(adopt).toEqual({ installed: [], updated: [], pruned: [], conflicts: [] });
    const index = JSON.parse(await readFile(join(dir, ".prism-agents.json"), "utf8"));
    expect(index.files["fast-scanner"]).toBe(incoming.digest);
  });

  it("prunes a pristine owned file on entitlement loss but preserves a hand-edited one", async () => {
    const dir = join(await tempRoot(), "agents");
    const scanner = definition("fast-scanner");
    const verifier = definition("deep-verifier");
    await materializeAgentDefinitions(section(scanner, verifier), dir);
    await writeFile(join(dir, "deep-verifier.md"), "hand tuned\n");
    const outcome = await materializeAgentDefinitions(section(), dir);
    expect(outcome.pruned).toEqual(["fast-scanner"]);
    expect(outcome.conflicts).toEqual(["deep-verifier"]);
    const remaining = await readdir(dir);
    expect(remaining).not.toContain("fast-scanner.md");
    expect(await readFile(join(dir, "deep-verifier.md"), "utf8")).toBe("hand tuned\n");
  });
});

describe("synchronizeSkillManifest agent wiring", () => {
  function jsonResponse(value: unknown, status = 200): Promise<Response> {
    return Promise.resolve(new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }));
  }

  function skillEntry(name: string) {
    const content = `---\nname: ${name}\n---\n# ${name}\n`;
    const priority = REQUIRED_NATIVE_SKILL_NAMES.indexOf(name as typeof REQUIRED_NATIVE_SKILL_NAMES[number]);
    return {
      name, content, digest: digest(content), version: 1, source: "filesystem" as const,
      metadata: {
        protected: REQUIRED_NATIVE_SKILL_NAMES.includes(name as typeof REQUIRED_NATIVE_SKILL_NAMES[number]),
        priority: priority >= 0 ? priority : 100,
        categories: ["universal" as const],
      },
      files: { "SKILL.md": { content, digest: digest(content), encoding: "utf8" as const } },
    };
  }

  it("materializes served agents alongside skills and reports them with an agent: prefix", async () => {
    _resetSkillManifestSyncForTest();
    const fixture = await tempRoot();
    const agentsSkillsDir = join(fixture, "skills");
    const claudeCodeAgentsDir = join(fixture, ".claude", "agents");
    const skills = [...REQUIRED_NATIVE_SKILL_NAMES].map(skillEntry)
      .sort((a, b) => a.metadata.priority - b.metadata.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const snapshot: SkillManifest = {
      schema_version: 1, generation_algorithm: "sha256-json-v1", complete: true, generation: "",
      tier: "enterprise", routing_version: 42, skills,
    };
    snapshot.generation = computeSkillManifestGeneration(snapshot);
    const scanner = definition("fast-scanner");
    const payload = {
      ...snapshot,
      agents: [scanner],
      agents_generation: digest("agents-gen-1"),
    };

    const result = await synchronizeSkillManifest({
      agentsSkillsDir,
      claudeCodeSkillsDir: false,
      cursorSkillsDir: false,
      claudeCodeAgentsDir,
      applyManifest: vi.fn(async () => undefined),
      fetchImpl: vi.fn(() => jsonResponse(payload)) as unknown as typeof fetch,
      configuredCredential: true,
      getJwt: async () => "valid-paid-jwt",
    });

    expect(result.status).toBe("applied");
    expect(result.installed).toContain("agent:fast-scanner");
    expect(await readFile(join(claudeCodeAgentsDir, "fast-scanner.md"), "utf8")).toBe(scanner.content);

    // FROZEN CONTRACT: agents ride outside the skills generation. A payload
    // whose agents perturbed `generation` would have failed validation above,
    // so reaching "applied" here proves the server/client hash split holds.
    expect(payload.generation).toBe(computeSkillManifestGeneration(snapshot));
  });

  it("fails the fetch loudly on a malformed agent section instead of pruning", async () => {
    _resetSkillManifestSyncForTest();
    const fixture = await tempRoot();
    const agentsSkillsDir = join(fixture, "skills");
    const claudeCodeAgentsDir = join(fixture, ".claude", "agents");
    const scanner = definition("fast-scanner");
    const skills = [...REQUIRED_NATIVE_SKILL_NAMES].map(skillEntry)
      .sort((a, b) => a.metadata.priority - b.metadata.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const snapshot: SkillManifest = {
      schema_version: 1, generation_algorithm: "sha256-json-v1", complete: true, generation: "",
      tier: "enterprise", routing_version: 42, skills,
    };
    snapshot.generation = computeSkillManifestGeneration(snapshot);

    // Seed a managed agent, then serve a corrupt section: the file must survive.
    await materializeAgentDefinitions(section(scanner), claudeCodeAgentsDir);
    const corrupt = { ...snapshot, agents: [{ ...scanner, digest: digest("tampered") }], agents_generation: digest("g") };
    const result = await synchronizeSkillManifest({
      agentsSkillsDir,
      claudeCodeSkillsDir: false,
      cursorSkillsDir: false,
      claudeCodeAgentsDir,
      applyManifest: vi.fn(async () => undefined),
      fetchImpl: vi.fn(() => jsonResponse(corrupt)) as unknown as typeof fetch,
      configuredCredential: true,
      getJwt: async () => "valid-paid-jwt",
    });
    expect(result.status).toBe("failed");
    expect(await readFile(join(claudeCodeAgentsDir, "fast-scanner.md"), "utf8")).toBe(scanner.content);
  });
});
