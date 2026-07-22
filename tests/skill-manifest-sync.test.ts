import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetSkillManifestSyncForTest,
  awaitSkillManifestSync,
  computeSkillManifestGeneration,
  synchronizeSkillManifest,
  triggerSkillManifestSync,
  validateSkillManifest,
  type SkillManifest,
} from "../src/skillManifestSync.js";
import {
  applyManagedSkillManifest, getSetting, refreshConfigStorageCache,
} from "../src/storage/configStorage.js";
import { REQUIRED_NATIVE_SKILL_NAMES } from "../src/tools/skillRouting.js";

const roots: string[] = [];
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const paidAuth = { configuredCredential: true, getJwt: async () => "valid-paid-jwt" } as const;

function skill(name: string, extraFiles: Record<string, string> = {}) {
  const content = `---\nname: ${name}\n---\n# ${name}\n`;
  const protectedPriority = REQUIRED_NATIVE_SKILL_NAMES.indexOf(
    name as typeof REQUIRED_NATIVE_SKILL_NAMES[number],
  );
  const rawFiles = { "SKILL.md": content, ...extraFiles };
  const files = Object.fromEntries(Object.entries(rawFiles).map(([path, value]) => [
    path, { content: value, digest: digest(value), encoding: "utf8" as const },
  ]));
  return {
    name, content, digest: digest(content), version: 1, source: "filesystem" as const,
    metadata: {
      protected: REQUIRED_NATIVE_SKILL_NAMES.includes(name as typeof REQUIRED_NATIVE_SKILL_NAMES[number]),
      priority: protectedPriority >= 0 ? protectedPriority : 100,
      categories: ["universal" as const],
    },
    files,
  };
}

function manifest(tier: SkillManifest["tier"], names: string[]): SkillManifest {
  const allNames = [...new Set([...REQUIRED_NATIVE_SKILL_NAMES, ...names])];
  const skills = allNames
    .map((name) => skill(name, name === "aba-precision-protocol" ? { "references/rules.md": "observable rules\n" } : {}))
    .sort((a, b) => a.metadata.priority - b.metadata.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const value: SkillManifest = {
    schema_version: 1, generation_algorithm: "sha256-json-v1", complete: true, generation: "",
    tier, routing_version: 42, skills,
  };
  value.generation = computeSkillManifestGeneration(value);
  return value;
}

function jsonResponse(value: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }));
}

async function root(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "prism-skill-sync-"));
  roots.push(fixture);
  const value = join(fixture, "skills");
  await mkdir(value);
  return value;
}

async function filesUnder(path: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

afterEach(async () => {
  _resetSkillManifestSyncForTest();
  delete process.env.PRISM_SKILLS_TOKEN;
  delete process.env.PRISM_SYNALUX_API_KEY;
  delete process.env.PRISM_SYNALUX_BASE_URL;
  delete process.env.SYNALUX_BASE_URL;
  process.env.PRISM_SKILL_SYNC_DISABLED = "true";
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("subscription-tier skill manifest sync", () => {
  it("pins the portal sha256-json-v1 canonical contract", () => {
    expect(computeSkillManifestGeneration({
      tier: "standard",
      routing_version: 42,
      skills: [{
        name: "aba-precision-protocol",
        content: "unused-by-generation",
        digest: "a".repeat(64),
        version: 1,
        source: "filesystem",
        metadata: { protected: true, priority: 0, categories: ["universal"] },
        files: { "SKILL.md": { content: "unused", digest: "a".repeat(64), encoding: "utf8" } },
      }],
    })).toBe("2f7e621172e8e7952c289beaa6143f24667a0796c75ac4fa707019baaab07bc7");
  });

  it("accepts portal native metadata and includes minimum_plan in generation parity", () => {
    const snapshot = manifest("standard", ["marketing-super-skill"]);
    const native = snapshot.skills.find((item) => item.name === "marketing-super-skill")!;
    native.metadata = {
      protected: false,
      priority: 300,
      categories: ["native"],
      minimum_plan: "standard",
    };
    const generationWithoutNativeMetadata = snapshot.generation;
    snapshot.generation = computeSkillManifestGeneration(snapshot);

    expect(snapshot.generation).not.toBe(generationWithoutNativeMetadata);
    expect(validateSkillManifest(snapshot)).toEqual(snapshot);

    for (const minimumPlan of ["free", "pro", null] as const) {
      const invalid = structuredClone(snapshot) as any;
      const invalidNative = invalid.skills.find((item: { name: string }) => item.name === "marketing-super-skill");
      if (minimumPlan === null) delete invalidNative.metadata.minimum_plan;
      else invalidNative.metadata.minimum_plan = minimumPlan;
      expect(() => validateSkillManifest(invalid)).toThrow(/minimum_plan|native skill/);
    }
  });

  it.each(["free", "standard", "advanced", "enterprise"] as const)("applies a complete %s manifest and installs guardrails plus hook-free startup", async (tier) => {
    const agentsSkillsDir = await root();
    const claudeCodeSkillsDir = join(dirname(agentsSkillsDir), ".claude", "skills");
    const cursorSkillsDir = join(dirname(agentsSkillsDir), ".cursor", "skills");
    const applyManifest = vi.fn(async () => undefined);
    const snapshot = manifest(tier, tier === "free" ? [] : [`${tier}-skill`]);
    const result = await synchronizeSkillManifest({
      agentsSkillsDir, claudeCodeSkillsDir, cursorSkillsDir, applyManifest,
      fetchImpl: vi.fn(() => jsonResponse(snapshot)) as unknown as typeof fetch,
      configuredCredential: tier !== "free",
      getJwt: async () => tier === "free" ? null : "valid-paid-jwt",
    });

    expect(result.status).toBe("applied");
    expect(applyManifest).toHaveBeenCalledWith(expect.objectContaining({ tier, generation: snapshot.generation }));
    expect(await readFile(join(agentsSkillsDir, "aba-precision-protocol", "SKILL.md"), "utf8"))
      .toBe(snapshot.skills.find((item) => item.name === "aba-precision-protocol")!.content);
    expect(await readFile(join(agentsSkillsDir, "aba-precision-protocol", "references", "rules.md"), "utf8")).toBe("observable rules\n");
    expect(await readFile(join(claudeCodeSkillsDir, "aba-precision-protocol", "SKILL.md"), "utf8"))
      .toBe(snapshot.skills.find((item) => item.name === "aba-precision-protocol")!.content);
    expect(await readFile(join(claudeCodeSkillsDir, "aba-precision-protocol", "references", "rules.md"), "utf8"))
      .toBe("observable rules\n");
    expect(await readFile(join(cursorSkillsDir, "aba-precision-protocol", "references", "rules.md"), "utf8"))
      .toBe("observable rules\n");
    for (const nativeRoot of [agentsSkillsDir, claudeCodeSkillsDir, cursorSkillsDir]) {
      expect(await readFile(join(nativeRoot, "prism-startup", "SKILL.md"), "utf8"))
        .toContain("name: prism-startup");
    }
  });

  it("materializes the prompt-routed direct Synalux local-browser package in every native host root", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "prism-local-browser-sync-"));
    roots.push(fixture);
    const agentsSkillsDir = join(fixture, ".agents", "skills");
    const claudeCodeSkillsDir = join(fixture, ".claude", "skills");
    const cursorSkillsDir = join(fixture, ".cursor", "skills");
    const snapshot = manifest("standard", ["local-browser"]);
    const browser = snapshot.skills.find((item) => item.name === "local-browser")!;
    browser.metadata.categories = ["prompt"];
    const testContent = "def test_contract():\n    assert True\n";
    browser.files["test_local_browser.py"] = {
      content: testContent,
      digest: digest(testContent),
      encoding: "utf8",
    };
    snapshot.generation = computeSkillManifestGeneration(snapshot);

    const result = await synchronizeSkillManifest({
      agentsSkillsDir,
      claudeCodeSkillsDir,
      cursorSkillsDir,
      applyManifest: vi.fn(async () => undefined),
      fetchImpl: vi.fn(() => jsonResponse(snapshot)) as unknown as typeof fetch,
      ...paidAuth,
    });

    expect(result.status).toBe("applied");
    for (const nativeRoot of [agentsSkillsDir, claudeCodeSkillsDir, cursorSkillsDir]) {
      expect(await readFile(join(nativeRoot, "local-browser", "SKILL.md"), "utf8"))
        .toContain("name: local-browser");
      expect(await readFile(join(nativeRoot, "local-browser", "test_local_browser.py"), "utf8"))
        .toBe(testContent);
    }
  });

  it("installs every sibling skill referenced by an entitled SKILL.md", async () => {
    const agentsSkillsDir = await root();
    const claudeCodeSkillsDir = join(dirname(agentsSkillsDir), ".claude", "skills");
    const snapshot = manifest("standard", ["dev-engineering-super-skill"]);
    const engineering = snapshot.skills.find((item) => item.name === "dev-engineering-super-skill")!;
    const content = "---\nname: dev-engineering-super-skill\n---\n[ABA Precision Protocol](../aba-precision-protocol/SKILL.md)\n";
    engineering.content = content;
    engineering.digest = digest(content);
    engineering.files["SKILL.md"] = { content, digest: digest(content), encoding: "utf8" };
    snapshot.generation = computeSkillManifestGeneration(snapshot);

    const result = await synchronizeSkillManifest({
      agentsSkillsDir, claudeCodeSkillsDir,
      applyManifest: vi.fn(async () => undefined),
      fetchImpl: vi.fn(() => jsonResponse(snapshot)) as unknown as typeof fetch,
      ...paidAuth,
    });

    expect(result.status).toBe("applied");
    for (const nativeRoot of [agentsSkillsDir, claudeCodeSkillsDir]) {
      const engineeringPath = join(nativeRoot, "dev-engineering-super-skill", "SKILL.md");
      const installedContent = await readFile(engineeringPath, "utf8");
      const dependency = installedContent.match(/\.\.\/([a-z0-9_-]+)\/SKILL\.md/)?.[1];
      expect(dependency).toBe("aba-precision-protocol");
      expect(await readFile(resolve(dirname(engineeringPath), "..", dependency!, "SKILL.md"), "utf8"))
        .toContain("name: aba-precision-protocol");
    }
  });

  it("auto-detects Claude Code and Cursor but never treats Claude Desktop as a filesystem skill host", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "prism-skill-hosts-"));
    roots.push(fixture);
    await writeFile(join(fixture, ".claude.json"), "{}\n");
    await mkdir(join(fixture, ".cursor"));
    await mkdir(join(fixture, "Library", "Application Support", "Claude"), { recursive: true });
    const snapshot = manifest("free", []);

    const result = await synchronizeSkillManifest({
      homeDir: fixture,
      applyManifest: vi.fn(async () => undefined),
      configuredCredential: false,
      fetchImpl: vi.fn(() => jsonResponse(snapshot)) as unknown as typeof fetch,
    });

    expect(result.status).toBe("applied");
    for (const nativeRoot of [
      join(fixture, ".agents", "skills"),
      join(fixture, ".claude", "skills"),
      join(fixture, ".cursor", "skills"),
    ]) {
      expect(await readFile(join(nativeRoot, "aba-precision-protocol", "SKILL.md"), "utf8"))
        .toContain("name: aba-precision-protocol");
    }
    await expect(readFile(join(
      fixture, "Library", "Application Support", "Claude", "skills",
      "aba-precision-protocol", "SKILL.md",
    ))).rejects.toThrow();
  });

  it("does not create a Claude skill root for a Claude Desktop-only installation", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "prism-skill-desktop-only-"));
    roots.push(fixture);
    const desktopRoot = join(fixture, "Library", "Application Support", "Claude");
    await mkdir(desktopRoot, { recursive: true });
    const snapshot = manifest("free", []);

    expect((await synchronizeSkillManifest({
      homeDir: fixture,
      applyManifest: vi.fn(async () => undefined),
      configuredCredential: false,
      fetchImpl: vi.fn(() => jsonResponse(snapshot)) as unknown as typeof fetch,
    })).status).toBe("applied");

    expect(await readFile(join(
      fixture, ".agents", "skills", "aba-precision-protocol", "SKILL.md",
    ), "utf8")).toContain("name: aba-precision-protocol");
    await expect(readFile(join(
      fixture, ".claude", "skills", "aba-precision-protocol", "SKILL.md",
    ))).rejects.toThrow();
    await expect(readFile(join(
      desktopRoot, "skills", "aba-precision-protocol", "SKILL.md",
    ))).rejects.toThrow();
  });

  it("deduplicates Cursor's documented symlink to the canonical Agent Skills root", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "prism-cursor-skills-link-"));
    roots.push(fixture);
    const agentsSkillsDir = join(fixture, ".agents", "skills");
    const cursorHome = join(fixture, ".cursor");
    const cursorSkillsDir = join(cursorHome, "skills");
    await mkdir(agentsSkillsDir, { recursive: true });
    await mkdir(cursorHome);
    await symlink(join("..", ".agents", "skills"), cursorSkillsDir);
    const snapshot = manifest("free", []);

    const result = await synchronizeSkillManifest({
      homeDir: fixture,
      applyManifest: vi.fn(async () => undefined),
      configuredCredential: false,
      fetchImpl: vi.fn(() => jsonResponse(snapshot)) as unknown as typeof fetch,
    });

    expect(result.status).toBe("applied");
    expect((await lstat(cursorSkillsDir)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(cursorSkillsDir, "prism-startup", "SKILL.md"), "utf8"))
      .toContain("name: prism-startup");
    expect((await readdir(agentsSkillsDir)).filter((name) => name === ".prism-managed-skills.json"))
      .toHaveLength(1);
  });

  it("fails before mutation when Cursor's native skill root is an unrelated user symlink", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "prism-cursor-skills-conflict-"));
    roots.push(fixture);
    const agentsSkillsDir = join(fixture, ".agents", "skills");
    const cursorHome = join(fixture, ".cursor");
    const userSkillsDir = join(fixture, "user-owned-skills");
    const cursorSkillsDir = join(cursorHome, "skills");
    await mkdir(agentsSkillsDir, { recursive: true });
    await mkdir(cursorHome);
    await mkdir(userSkillsDir);
    await writeFile(join(userSkillsDir, "SENTINEL.md"), "preserve me\n");
    await symlink(userSkillsDir, cursorSkillsDir);
    const fetchImpl = vi.fn(() => jsonResponse(manifest("free", []))) as unknown as typeof fetch;
    const applyManifest = vi.fn(async () => undefined);

    const result = await synchronizeSkillManifest({
      homeDir: fixture, applyManifest, configuredCredential: false, fetchImpl,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/user-owned symlink; preserved without changes/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(applyManifest).not.toHaveBeenCalled();
    expect((await lstat(cursorSkillsDir)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(userSkillsDir, "SENTINEL.md"), "utf8")).toBe("preserve me\n");
    await expect(readFile(join(agentsSkillsDir, "prism-startup", "SKILL.md"))).rejects.toThrow();
  });

  it("downgrades every managed discovery root while preserving unowned and locally modified host content", async () => {
    const agentsSkillsDir = await root();
    const claudeCodeSkillsDir = join(dirname(agentsSkillsDir), ".claude", "skills");
    const cursorSkillsDir = join(dirname(agentsSkillsDir), ".cursor", "skills");
    const claudeUnowned = join(claudeCodeSkillsDir, "user-owned");
    const claudeSameNameConflict = join(claudeCodeSkillsDir, "aba-precision-protocol");
    const cursorUnowned = join(cursorSkillsDir, "user-owned");
    const cursorSameNameConflict = join(cursorSkillsDir, "aba-precision-protocol");
    await mkdir(claudeUnowned, { recursive: true });
    await mkdir(claudeSameNameConflict, { recursive: true });
    await mkdir(cursorUnowned, { recursive: true });
    await mkdir(cursorSameNameConflict, { recursive: true });
    await writeFile(join(claudeUnowned, "SKILL.md"), "keep my Claude skill");
    await writeFile(join(claudeSameNameConflict, "SKILL.md"), "keep my same-name Claude skill");
    await writeFile(join(cursorUnowned, "SKILL.md"), "keep my Cursor skill");
    await writeFile(join(cursorSameNameConflict, "SKILL.md"), "keep my same-name Cursor skill");
    const applyManifest = vi.fn(async () => undefined);
    const paid = manifest("enterprise", ["paid-skill"]);
    const free = manifest("free", []);

    const paidResult = await synchronizeSkillManifest({
      agentsSkillsDir, claudeCodeSkillsDir, cursorSkillsDir, applyManifest, ...paidAuth,
      fetchImpl: vi.fn(() => jsonResponse(paid)) as unknown as typeof fetch,
    });
    expect(paidResult.conflicts).toEqual(["aba-precision-protocol"]);
    await writeFile(join(claudeCodeSkillsDir, "paid-skill", "local-note.md"), "preserve this edit");
    await writeFile(join(cursorSkillsDir, "paid-skill", "local-note.md"), "preserve this Cursor edit");
    const result = await synchronizeSkillManifest({
      agentsSkillsDir, claudeCodeSkillsDir, cursorSkillsDir, applyManifest, ...paidAuth,
      fetchImpl: vi.fn(() => jsonResponse(free)) as unknown as typeof fetch,
    });

    expect(result.status).toBe("applied");
    expect(result.pruned).toEqual(["paid-skill"]);
    expect(result.conflicts).toEqual(["aba-precision-protocol", "paid-skill"]);
    for (const nativeRoot of [agentsSkillsDir, claudeCodeSkillsDir, cursorSkillsDir]) {
      await expect(readFile(join(nativeRoot, "paid-skill", "SKILL.md"))).rejects.toThrow();
    }
    expect(await readFile(join(claudeUnowned, "SKILL.md"), "utf8")).toBe("keep my Claude skill");
    expect(await readFile(join(claudeSameNameConflict, "SKILL.md"), "utf8"))
      .toBe("keep my same-name Claude skill");
    expect(await readFile(join(cursorUnowned, "SKILL.md"), "utf8")).toBe("keep my Cursor skill");
    expect(await readFile(join(cursorSameNameConflict, "SKILL.md"), "utf8"))
      .toBe("keep my same-name Cursor skill");
    for (const [nativeRoot, expected] of [
      [claudeCodeSkillsDir, "preserve this edit"],
      [cursorSkillsDir, "preserve this Cursor edit"],
    ] as const) {
      const quarantine = join(dirname(nativeRoot), ".prism-skill-quarantine");
      const preserved = (await readdir(quarantine)).find((name) => name.startsWith("paid-skill-"));
      expect(preserved).toBeTruthy();
      expect(await readFile(join(quarantine, preserved!, "local-note.md"), "utf8")).toBe(expected);
    }
  });

  it("upgrades and downgrades while pruning only marked Prism-managed native skills", async () => {
    const agentsSkillsDir = await root();
    await mkdir(join(agentsSkillsDir, "user-owned"), { recursive: true });
    await writeFile(join(agentsSkillsDir, "user-owned", "SKILL.md"), "keep me");
    const applyManifest = vi.fn(async () => undefined);
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => jsonResponse(manifest("advanced", ["aba-precision-protocol", "paid-skill"])))
      .mockImplementationOnce(() => jsonResponse(manifest("free", ["aba-precision-protocol"])));

    await synchronizeSkillManifest({ agentsSkillsDir, applyManifest, fetchImpl, ...paidAuth });
    const result = await synchronizeSkillManifest({ agentsSkillsDir, applyManifest, fetchImpl, ...paidAuth });

    expect(result.pruned).toEqual(["paid-skill"]);
    await expect(readFile(join(agentsSkillsDir, "paid-skill", "SKILL.md"))).rejects.toThrow();
    expect((await filesUnder(agentsSkillsDir)).some((path) => path.includes("paid-skill"))).toBe(false);
    expect(await readFile(join(agentsSkillsDir, "user-owned", "SKILL.md"), "utf8")).toBe("keep me");
    expect(applyManifest).toHaveBeenLastCalledWith(expect.objectContaining({
      tier: "free",
      skills: expect.arrayContaining([expect.objectContaining({ name: "aba-precision-protocol" })]),
    }));
  });

  it("leaves last-good DB and native state untouched on partial payloads and outages", async () => {
    const agentsSkillsDir = await root();
    const applyManifest = vi.fn(async () => undefined);
    const good = manifest("standard", ["aba-precision-protocol", "paid-skill"]);
    await synchronizeSkillManifest({ agentsSkillsDir, applyManifest, fetchImpl: vi.fn(() => jsonResponse(good)) as unknown as typeof fetch, ...paidAuth });
    applyManifest.mockClear();

    const partial = { ...good, complete: false, skills: [good.skills[0]] };
    const partialResult = await synchronizeSkillManifest({ agentsSkillsDir, applyManifest, fetchImpl: vi.fn(() => jsonResponse(partial)) as unknown as typeof fetch, ...paidAuth });
    const outageResult = await synchronizeSkillManifest({ agentsSkillsDir, applyManifest, fetchImpl: vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch, ...paidAuth });

    expect(partialResult.status).toBe("failed");
    expect(outageResult.status).toBe("failed");
    expect(applyManifest).not.toHaveBeenCalled();
    expect(await readFile(join(agentsSkillsDir, "paid-skill", "SKILL.md"), "utf8"))
      .toBe(good.skills.find((item) => item.name === "paid-skill")!.content);
  });

  it("rejects traversal, duplicate/case-colliding names, bad hashes, unknown tiers, and an incomplete protected floor", () => {
    const base = manifest("free", ["aba-precision-protocol"]);
    expect(() => validateSkillManifest({ ...base, tier: "pro" })).toThrow(/tier/);
    expect(() => validateSkillManifest({ ...base, schema_version: 2 })).toThrow(/schema/);
    for (const required of REQUIRED_NATIVE_SKILL_NAMES) {
      expect(() => validateSkillManifest({
        ...base,
        skills: base.skills.filter((item) => item.name !== required),
      })).toThrow(new RegExp(required));
    }
    expect(() => validateSkillManifest(manifest("free", ["paid-skill"]))).toThrow(/exactly the protected skill floor/);
    expect(() => validateSkillManifest({
      ...base,
      skills: base.skills.map((item) => item.name === "aba-precision-protocol"
        ? { ...item, metadata: { ...item.metadata, protected: false } }
        : item),
    })).toThrow(/protected universal/);
    expect(() => validateSkillManifest({ ...base, skills: [base.skills[0], { ...base.skills[0], name: "ABA-PRECISION-PROTOCOL" }] })).toThrow(/name|duplicate/);
    expect(() => validateSkillManifest({ ...base, skills: [{ ...base.skills[0], files: { "../escape": base.skills[0].files["SKILL.md"] } }] })).toThrow(/unsafe/);
    expect(() => validateSkillManifest({ ...base, skills: [{ ...base.skills[0], digest: "0".repeat(64) }] })).toThrow(/mismatch/);
    expect(() => validateSkillManifest({ ...base, generation: "0".repeat(64) })).toThrow(/generation digest/);
    const brokenDependency = manifest("standard", ["dev-engineering-super-skill"]);
    const engineering = brokenDependency.skills.find((item) => item.name === "dev-engineering-super-skill")!;
    const brokenContent = "---\nname: dev-engineering-super-skill\n---\n[Missing](../missing-protocol/SKILL.md)\n";
    engineering.content = brokenContent;
    engineering.digest = digest(brokenContent);
    engineering.files["SKILL.md"] = { content: brokenContent, digest: digest(brokenContent), encoding: "utf8" };
    brokenDependency.generation = computeSkillManifestGeneration(brokenDependency);
    expect(() => validateSkillManifest(brokenDependency)).toThrow(/unresolved skill dependency/);
    expect(() => validateSkillManifest({
      ...base,
      skills: [{ ...base.skills[0], files: {
        "SKILL.md": base.skills[0].files["SKILL.md"],
        "Ref.md": base.skills[0].files["SKILL.md"],
        "ref.md": base.skills[0].files["SKILL.md"],
      } }],
    })).toThrow(/duplicate skill file path/);
  });

  it("is idempotent for the same generation and does not create update backups", async () => {
    const agentsSkillsDir = await root();
    const snapshot = manifest("free", ["aba-precision-protocol"]);
    const options = {
      agentsSkillsDir, applyManifest: vi.fn(async () => undefined), configuredCredential: false,
      fetchImpl: vi.fn(() => jsonResponse(snapshot)) as unknown as typeof fetch,
    };
    expect((await synchronizeSkillManifest(options)).status).toBe("applied");
    const second = await synchronizeSkillManifest(options);
    expect(second.status).toBe("unchanged");
    expect(second.updated).toEqual([]);
    expect((await readdir(agentsSkillsDir)).some((name) => name === ".prism-backups")).toBe(false);
  });

  it("preserves an unowned same-name native conflict", async () => {
    const agentsSkillsDir = await root();
    const conflict = join(agentsSkillsDir, "aba-precision-protocol");
    await mkdir(conflict, { recursive: true });
    await writeFile(join(conflict, "SKILL.md"), "user copy");
    const snapshot = manifest("free", ["aba-precision-protocol"]);

    const result = await synchronizeSkillManifest({
      agentsSkillsDir, applyManifest: vi.fn(async () => undefined),
      fetchImpl: vi.fn(() => jsonResponse(snapshot)) as unknown as typeof fetch,
      configuredCredential: false,
    });

    expect(result.conflicts).toEqual(["aba-precision-protocol"]);
    expect(await readFile(join(conflict, "SKILL.md"), "utf8")).toBe("user copy");
  });

  it("does not downgrade to unauthenticated free when configured auth fails", async () => {
    const fetchImpl = vi.fn(() => jsonResponse(manifest("free", ["aba-precision-protocol"]))) as unknown as typeof fetch;
    const applyManifest = vi.fn(async () => undefined);
    const result = await synchronizeSkillManifest({
      agentsSkillsDir: await root(), fetchImpl, applyManifest,
      configuredCredential: true, getJwt: async () => null,
    });
    expect(result.status).toBe("failed");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(applyManifest).not.toHaveBeenCalled();
  });

  it("rejects a paid manifest returned to an unauthenticated client", async () => {
    const snapshot = manifest("standard", ["paid-skill"]);
    const applyManifest = vi.fn(async () => undefined);
    const result = await synchronizeSkillManifest({
      agentsSkillsDir: await root(), applyManifest, configuredCredential: false,
      fetchImpl: vi.fn(() => jsonResponse(snapshot)) as unknown as typeof fetch,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/unauthenticated.*free tier/);
    expect(applyManifest).not.toHaveBeenCalled();
  });

  it("refreshes a JWT once on 401 and never sends credentials across redirects", async () => {
    const snapshot = manifest("standard", ["aba-precision-protocol"]);
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => jsonResponse({}, 401))
      .mockImplementationOnce(() => jsonResponse(snapshot));
    const getJwt = vi.fn().mockResolvedValueOnce("old-jwt").mockResolvedValueOnce("fresh-jwt");
    const invalidateJwt = vi.fn();
    const result = await synchronizeSkillManifest({
      agentsSkillsDir: await root(), applyManifest: vi.fn(async () => undefined),
      fetchImpl, configuredCredential: true, getJwt, invalidateJwt,
    });
    expect(result.status).toBe("applied");
    expect(invalidateJwt).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[1][1]).toEqual(expect.objectContaining({ redirect: "error" }));
    expect((fetchImpl.mock.calls[1][1] as RequestInit).headers).toEqual(expect.objectContaining({ Authorization: "Bearer fresh-jwt" }));
  });

  it("normalizes the legacy SYNALUX_BASE_URL alias to the canonical endpoint", async () => {
    process.env.SYNALUX_BASE_URL = "https://legacy.synalux.test///";
    const snapshot = manifest("free", ["aba-precision-protocol"]);
    const fetchImpl = vi.fn(() => jsonResponse(snapshot)) as unknown as typeof fetch;
    await synchronizeSkillManifest({
      agentsSkillsDir: await root(), applyManifest: vi.fn(async () => undefined), fetchImpl,
      configuredCredential: false,
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://legacy.synalux.test/api/v1/prism/skill-manifest", expect.anything());
    expect(process.env.PRISM_SYNALUX_BASE_URL).toBe("https://legacy.synalux.test");
  });

  it.each([
    ["after prune", { afterNativePrune: async () => { throw new Error("injected prune failure"); } }],
    ["before stage", { beforeNativeStage: async () => { throw new Error("injected stage failure"); } }],
    ["before index commit", { beforeNativeCommit: async () => { throw new Error("injected commit failure"); } }],
    ["before cleanup", { beforeNativeCleanup: async () => { throw new Error("injected cleanup failure"); } }],
  ])("keeps downgraded skills outside discovery when native sync fails %s", async (_phase, hooks) => {
    const agentsSkillsDir = await root();
    const claudeCodeSkillsDir = join(dirname(agentsSkillsDir), ".claude", "skills");
    const applyManifest = vi.fn(async () => undefined);
    const paid = manifest("advanced", ["aba-precision-protocol", "paid-skill", "second-paid-skill"]);
    await synchronizeSkillManifest({
      agentsSkillsDir, claudeCodeSkillsDir, applyManifest, ...paidAuth,
      fetchImpl: vi.fn(() => jsonResponse(paid)) as unknown as typeof fetch,
    });
    const free = manifest("free", ["aba-precision-protocol"]);
    const result = await synchronizeSkillManifest({
      agentsSkillsDir, claudeCodeSkillsDir, applyManifest, ...paidAuth,
      fetchImpl: vi.fn(() => jsonResponse(free)) as unknown as typeof fetch,
      ...hooks,
    });
    expect(result.status).toBe("partial");
    for (const nativeRoot of [agentsSkillsDir, claudeCodeSkillsDir]) {
      await expect(readFile(join(nativeRoot, "paid-skill", "SKILL.md"))).rejects.toThrow();
      const discovered = await filesUnder(nativeRoot);
      expect(discovered.some((path) => path.includes("paid-skill"))).toBe(false);
      expect(discovered.filter((path) => path.endsWith("SKILL.md")).sort()).toEqual(
        REQUIRED_NATIVE_SKILL_NAMES
          .map((name) => join(nativeRoot, name, "SKILL.md"))
          .sort(),
      );
    }
  });

  it("quarantines legacy Prism transaction directories outside native discovery", async () => {
    const agentsSkillsDir = await root();
    const legacy = join(agentsSkillsDir, ".prism-transaction-crash", "paid-skill");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "SKILL.md"), "legacy paid transaction content");
    const free = manifest("free", ["aba-precision-protocol"]);

    const result = await synchronizeSkillManifest({
      agentsSkillsDir, applyManifest: vi.fn(async () => undefined), configuredCredential: false,
      fetchImpl: vi.fn(() => jsonResponse(free)) as unknown as typeof fetch,
    });

    expect(result.status).toBe("applied");
    const discovered = await filesUnder(agentsSkillsDir);
    expect(discovered.some((path) => path.includes("paid-skill"))).toBe(false);
    expect(discovered.filter((path) => path.endsWith("SKILL.md")).sort()).toEqual(
      REQUIRED_NATIVE_SKILL_NAMES
        .map((name) => join(agentsSkillsDir, name, "SKILL.md"))
        .sort(),
    );
  });

  it("recovers marker-owned installs across generations and prunes them on downgrade", async () => {
    const agentsSkillsDir = await root();
    const paid = manifest("advanced", ["aba-precision-protocol", "paid-skill"]);
    await synchronizeSkillManifest({
      agentsSkillsDir, applyManifest: vi.fn(async () => undefined), ...paidAuth,
      fetchImpl: vi.fn(() => jsonResponse(paid)) as unknown as typeof fetch,
    });
    // Exact hard-exit state: target renames landed but the index rename did not.
    await rm(join(agentsSkillsDir, ".prism-managed-skills.json"));
    const free = manifest("free", ["aba-precision-protocol"]);

    const result = await synchronizeSkillManifest({
      agentsSkillsDir, applyManifest: vi.fn(async () => undefined), ...paidAuth,
      fetchImpl: vi.fn(() => jsonResponse(free)) as unknown as typeof fetch,
    });

    expect(result.conflicts).toEqual([]);
    expect(result.pruned).toEqual(["paid-skill"]);
    await expect(readFile(join(agentsSkillsDir, "paid-skill", "SKILL.md"))).rejects.toThrow();
    const index = JSON.parse(await readFile(join(agentsSkillsDir, ".prism-managed-skills.json"), "utf8"));
    expect(index.skills).toEqual([...REQUIRED_NATIVE_SKILL_NAMES].sort());
  });

  it("finishes a DB-committed downgrade after a hard exit even when the portal is offline", async () => {
    const agentsSkillsDir = await root();
    const claudeCodeSkillsDir = join(dirname(agentsSkillsDir), ".claude", "skills");
    const paid = manifest("advanced", ["aba-precision-protocol", "paid-skill"]);
    expect((await synchronizeSkillManifest({
      agentsSkillsDir, claudeCodeSkillsDir, ...paidAuth,
      fetchImpl: vi.fn(() => jsonResponse(paid)) as unknown as typeof fetch,
    })).status).toBe("applied");
    const free = manifest("free", ["aba-precision-protocol"]);
    await applyManagedSkillManifest({
      generation: free.generation, tier: free.tier, routingVersion: free.routing_version,
      skills: free.skills.map(({ name, content, digest }) => ({ name, content, digest })),
    });

    const restarted = await synchronizeSkillManifest({
      agentsSkillsDir, claudeCodeSkillsDir, ...paidAuth,
      fetchImpl: vi.fn(async () => { throw new Error("portal offline after crash"); }) as unknown as typeof fetch,
    });

    expect(restarted.status).toBe("failed");
    for (const nativeRoot of [agentsSkillsDir, claudeCodeSkillsDir]) {
      await expect(readFile(join(nativeRoot, "paid-skill", "SKILL.md"))).rejects.toThrow();
      expect((await filesUnder(nativeRoot)).some((path) => path.includes("paid-skill"))).toBe(false);
    }
  });

  it("creates an absent Cursor skill root before scanning committed entitlement recovery", async () => {
    const agentsSkillsDir = await root();
    const cursorSkillsDir = join(dirname(agentsSkillsDir), ".cursor", "skills");
    const snapshot = manifest("free", []);
    await applyManagedSkillManifest({
      generation: snapshot.generation,
      tier: snapshot.tier,
      routingVersion: snapshot.routing_version,
      skills: snapshot.skills.map(({ name, content, digest }) => ({ name, content, digest })),
    });

    const result = await synchronizeSkillManifest({
      agentsSkillsDir,
      cursorSkillsDir,
      configuredCredential: false,
      fetchImpl: vi.fn(() => jsonResponse(snapshot)) as unknown as typeof fetch,
    });

    expect(result.status).toBe("applied");
    expect(await readFile(join(cursorSkillsDir, "prism-startup", "SKILL.md"), "utf8"))
      .toContain("name: prism-startup");
  });

  it("enforces a validated downgrade even when the config DB transaction fails", async () => {
    const agentsSkillsDir = await root();
    const claudeCodeSkillsDir = join(dirname(agentsSkillsDir), ".claude", "skills");
    let rejectApply = false;
    const applyManifest = vi.fn(async () => {
      if (rejectApply) throw new Error("config DB is read-only");
    });
    const paid = manifest("advanced", ["paid-skill"]);
    expect((await synchronizeSkillManifest({
      agentsSkillsDir, claudeCodeSkillsDir, applyManifest, configuredCredential: true,
      getJwt: async () => "paid-jwt",
      fetchImpl: vi.fn(() => jsonResponse(paid)) as unknown as typeof fetch,
    })).status).toBe("applied");

    rejectApply = true;
    const free = manifest("free", []);
    const result = await synchronizeSkillManifest({
      agentsSkillsDir, claudeCodeSkillsDir, applyManifest, ...paidAuth,
      fetchImpl: vi.fn(() => jsonResponse(free)) as unknown as typeof fetch,
    });

    expect(result.status).toBe("partial");
    expect(result.error).toMatch(/config DB apply incomplete/);
    expect(result.entitledNames).toEqual(REQUIRED_NATIVE_SKILL_NAMES);
    for (const nativeRoot of [agentsSkillsDir, claudeCodeSkillsDir]) {
      await expect(readFile(join(nativeRoot, "paid-skill", "SKILL.md"))).rejects.toThrow();
      expect((await filesUnder(nativeRoot)).some((path) => path.includes("paid-skill"))).toBe(false);
    }
  });

  it("preserves locally modified managed skills and reports the conflict", async () => {
    const agentsSkillsDir = await root();
    const snapshot = manifest("free", ["aba-precision-protocol"]);
    const options = {
      agentsSkillsDir, applyManifest: vi.fn(async () => undefined), configuredCredential: false,
      fetchImpl: vi.fn(() => jsonResponse(snapshot)) as unknown as typeof fetch,
    };
    await synchronizeSkillManifest(options);
    await writeFile(join(agentsSkillsDir, "aba-precision-protocol", "local-note.md"), "preserve");
    const result = await synchronizeSkillManifest(options);
    expect(result.conflicts).toEqual(["aba-precision-protocol"]);
    expect(await readFile(join(agentsSkillsDir, "aba-precision-protocol", "local-note.md"), "utf8")).toBe("preserve");
  });

  it("preserves a locally modified managed skill in quarantine when a downgrade removes its entitlement", async () => {
    const agentsSkillsDir = await root();
    const paid = manifest("advanced", ["aba-precision-protocol", "paid-skill"]);
    await synchronizeSkillManifest({
      agentsSkillsDir, applyManifest: vi.fn(async () => undefined), ...paidAuth,
      fetchImpl: vi.fn(() => jsonResponse(paid)) as unknown as typeof fetch,
    });
    await writeFile(join(agentsSkillsDir, "paid-skill", "local-note.md"), "user modification");
    const free = manifest("free", ["aba-precision-protocol"]);

    const result = await synchronizeSkillManifest({
      agentsSkillsDir, applyManifest: vi.fn(async () => undefined), ...paidAuth,
      fetchImpl: vi.fn(() => jsonResponse(free)) as unknown as typeof fetch,
    });

    expect(result.conflicts).toEqual(["paid-skill"]);
    await expect(readFile(join(agentsSkillsDir, "paid-skill", "SKILL.md"))).rejects.toThrow();
    const quarantine = join(dirname(agentsSkillsDir), ".prism-skill-quarantine");
    const preserved = (await readdir(quarantine)).find((name) => name.startsWith("paid-skill-"));
    expect(preserved).toBeTruthy();
    expect(await readFile(join(quarantine, preserved!, "local-note.md"), "utf8")).toBe("user modification");
  });

  it("fails without fetching or mutating DB when the native lock stays live", async () => {
    const agentsSkillsDir = await root();
    await writeFile(join(agentsSkillsDir, ".prism-sync.lock"), JSON.stringify({ pid: process.pid }));
    const applyManifest = vi.fn(async () => undefined);
    const snapshot = manifest("free", ["aba-precision-protocol"]);
    const fetchImpl = vi.fn(() => jsonResponse(snapshot)) as unknown as typeof fetch;
    const result = await synchronizeSkillManifest({
      agentsSkillsDir, applyManifest, fetchImpl, configuredCredential: false, lockWaitMs: 10,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/timed out waiting/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(applyManifest).not.toHaveBeenCalled();
    await expect(readFile(join(agentsSkillsDir, "aba-precision-protocol", "SKILL.md"))).rejects.toThrow();
  });

  it("does not remove a replacement lock owned by another sync", async () => {
    const agentsSkillsDir = await root();
    const snapshot = manifest("free", ["aba-precision-protocol"]);
    let enteredFetch!: () => void;
    let releaseFetch!: () => void;
    const fetchEntered = new Promise<void>((resolve) => { enteredFetch = resolve; });
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const fetchImpl = vi.fn(async () => {
      enteredFetch();
      await fetchGate;
      return jsonResponse(snapshot);
    }) as unknown as typeof fetch;
    const sync = synchronizeSkillManifest({
      agentsSkillsDir, applyManifest: vi.fn(async () => undefined), fetchImpl, configuredCredential: false,
    });
    await fetchEntered;
    const lockPath = join(agentsSkillsDir, ".prism-sync.lock");
    await rename(lockPath, `${lockPath}.displaced`);
    const replacement = {
      owner: "prism-skill-sync-v1", pid: process.pid,
      started_at: new Date().toISOString(), token: "replacement-owner-token",
    };
    await writeFile(lockPath, `${JSON.stringify(replacement)}\n`);
    releaseFetch();

    expect((await sync).status).toBe("applied");
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(replacement);
  });

  it("serializes fetch, DB, and native state across competing generations", async () => {
    const agentsSkillsDir = await root();
    const paid = manifest("advanced", ["aba-precision-protocol", "paid-skill"]);
    const free = manifest("free", ["aba-precision-protocol"]);
    let enteredPaidFetch!: () => void;
    let releasePaidFetch!: () => void;
    const paidEntered = new Promise<void>((resolve) => { enteredPaidFetch = resolve; });
    const paidGate = new Promise<void>((resolve) => { releasePaidFetch = resolve; });
    const paidFetch = vi.fn(async () => {
      enteredPaidFetch();
      await paidGate;
      return jsonResponse(paid);
    }) as unknown as typeof fetch;
    const freeFetch = vi.fn(() => jsonResponse(free)) as unknown as typeof fetch;

    const first = synchronizeSkillManifest({ agentsSkillsDir, fetchImpl: paidFetch, ...paidAuth });
    await paidEntered;
    const second = synchronizeSkillManifest({ agentsSkillsDir, fetchImpl: freeFetch, ...paidAuth });
    await Promise.resolve();
    expect(freeFetch).not.toHaveBeenCalled();
    releasePaidFetch();
    expect((await first).status).toBe("applied");
    expect((await second).status).toBe("applied");

    await refreshConfigStorageCache();
    expect(await getSetting("skill_manifest:generation")).toBe(free.generation);
    expect(JSON.parse(await getSetting("skill_manifest:names"))).toEqual(REQUIRED_NATIVE_SKILL_NAMES);
    await expect(readFile(join(agentsSkillsDir, "paid-skill", "SKILL.md"))).rejects.toThrow();
    const index = JSON.parse(await readFile(join(agentsSkillsDir, ".prism-managed-skills.json"), "utf8"));
    expect(index.generation).toBe(free.generation);
    expect(index.skills).toEqual([...REQUIRED_NATIVE_SKILL_NAMES].sort());
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked native root before fetch or DB apply", async () => {
    const fixture = await root();
    const target = join(fixture, "real-skills");
    const link = join(fixture, "linked-skills");
    await mkdir(target);
    await symlink(target, link, "dir");
    const applyManifest = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(() => jsonResponse(manifest("free", ["aba-precision-protocol"]))) as unknown as typeof fetch;

    const result = await synchronizeSkillManifest({ agentsSkillsDir: link, applyManifest, fetchImpl, configuredCredential: false });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/real directory/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(applyManifest).not.toHaveBeenCalled();
  });

  it("retries a failed startup sync when session loading asks again", async () => {
    process.env.PRISM_SKILL_SYNC_DISABLED = "false";
    const snapshot = manifest("free", ["aba-precision-protocol"]);
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("startup outage"))
      .mockImplementationOnce(() => jsonResponse(snapshot)) as unknown as typeof fetch;
    const options = {
      agentsSkillsDir: await root(), applyManifest: vi.fn(async () => undefined),
      fetchImpl, configuredCredential: false,
    };
    expect((await triggerSkillManifestSync(options)).status).toBe("failed");
    expect((await awaitSkillManifestSync(options)).status).toBe("applied");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight fetch and applies DB state before native materialization", async () => {
    process.env.PRISM_SKILL_SYNC_DISABLED = "false";
    const agentsSkillsDir = await root();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const snapshot = manifest("enterprise", ["aba-precision-protocol"]);
    const fetchImpl = vi.fn(async () => { await gate; return (await jsonResponse(snapshot)); }) as unknown as typeof fetch;
    const applyManifest = vi.fn(async () => undefined);
    const options = { agentsSkillsDir, fetchImpl, applyManifest, ...paidAuth };
    const first = triggerSkillManifestSync(options);
    const second = triggerSkillManifestSync(options);
    release();
    expect(await first).toEqual(await second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(applyManifest).toHaveBeenCalledTimes(1);

    const failedRoot = await root();
    const failed = await synchronizeSkillManifest({ ...options, agentsSkillsDir: failedRoot, applyManifest: vi.fn(async () => { throw new Error("atomic rollback"); }) });
    expect(failed.status).toBe("partial");
    await expect(readFile(join(failedRoot, "aba-precision-protocol", "SKILL.md"))).rejects.toThrow();
  });
});
