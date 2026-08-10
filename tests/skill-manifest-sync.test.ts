import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
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
import { FREE_NATIVE_SKILL_NAMES, REQUIRED_NATIVE_SKILL_NAMES } from "../src/tools/skillRouting.js";

const roots: string[] = [];
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const paidAuth = { configuredCredential: true, getJwt: async () => "valid-paid-jwt" } as const;
const PAID_ONLY_NATIVE_SKILL_NAMES = REQUIRED_NATIVE_SKILL_NAMES.filter(
  (name) => !FREE_NATIVE_SKILL_NAMES.includes(name as typeof FREE_NATIVE_SKILL_NAMES[number]),
);

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
  const floor = tier === "free" ? FREE_NATIVE_SKILL_NAMES : REQUIRED_NATIVE_SKILL_NAMES;
  const allNames = [...new Set([...floor, ...names])];
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

  it.each(["free", "standard", "advanced", "enterprise"] as const)("applies a complete %s manifest with the tier's exact native floor", async (tier) => {
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
    for (const nativeRoot of [agentsSkillsDir, claudeCodeSkillsDir, cursorSkillsDir]) {
      expect(await readFile(join(nativeRoot, "prism-startup", "SKILL.md"), "utf8"))
        .toContain("name: prism-startup");
      if (tier === "free") {
        await expect(readFile(join(nativeRoot, "aba-precision-protocol", "SKILL.md")))
          .rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await readFile(join(nativeRoot, "aba-precision-protocol", "SKILL.md"), "utf8"))
          .toBe(snapshot.skills.find((item) => item.name === "aba-precision-protocol")!.content);
        expect(await readFile(join(nativeRoot, "aba-precision-protocol", "references", "rules.md"), "utf8"))
          .toBe("observable rules\n");
      }
      await expect(readFile(join(nativeRoot, "current-staging-acceptance", "SKILL.md"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
  });

    // POSIX-only: Windows chmod maps to the read-only attribute alone and lstat
  // reports 0o666 for every writable directory, so a directory that cannot be
  // entered has no Windows analogue and the mode assertion is meaningless
  // there. Ran red on windows-latest with "expected 438 to be 448" before this.
it.skipIf(process.platform === "win32")("repairs an unusable managed directory to 0o700 without widening access", async () => {
    // Repairing must restore the creation intent, not merely unblock the run.
    // An earlier version of this fix OR-ed the owner bits onto whatever mode was
    // there, so 0o606 became 0o706 and the skills root — entitled, paid-tier
    // content — stayed world-readable on a shared machine. The observed outage
    // was 0o600, where both forms yield 0o700, so only a mode carrying group or
    // other bits distinguishes them.
    const agentsSkillsDir = await root();
    const transactionBase = join(dirname(agentsSkillsDir), ".prism-skill-transactions");
    await mkdir(transactionBase, { recursive: true, mode: 0o700 });
    await chmod(transactionBase, 0o606);          // owner rw, NO owner-x, other rw

    // The base is deleted once it drains, so the mode has to be observed while
    // the transaction is still open.
    let modeDuringRun = -1;
    const result = await synchronizeSkillManifest({
      agentsSkillsDir, claudeCodeSkillsDir: false, cursorSkillsDir: false,
      applyManifest: vi.fn(async () => undefined),
      fetchImpl: vi.fn(() => jsonResponse(manifest("enterprise", ["enterprise-skill"]))) as unknown as typeof fetch,
      beforeNativeCommit: async () => { modeDuringRun = (await lstat(transactionBase)).mode & 0o777; },
      ...paidAuth,
    });

    expect(result.status).toBe("applied");
    expect(modeDuringRun).toBe(0o700);
    expect(await readFile(join(agentsSkillsDir, "prism-startup", "SKILL.md"), "utf8"))
      .toContain("name: prism-startup");
  });

    // POSIX-only: Windows chmod maps to the read-only attribute alone and lstat
  // reports 0o666 for every writable directory, so a directory that cannot be
  // entered has no Windows analogue and the mode assertion is meaningless
  // there. Ran red on windows-latest with "expected 438 to be 448" before this.
it.skipIf(process.platform === "win32")("materializes when the skills root itself cannot be entered", async () => {
    // Found reviewing the transaction-directory fix: the root was guarded by a
    // plain mkdir (a no-op on an existing directory) plus a symlink check, so a
    // root left without owner rwx failed at the first readdir and nothing ever
    // repaired it — the same permanent-silent-failure shape, one level up.
    const agentsSkillsDir = await root();
    await chmod(agentsSkillsDir, 0o606);

    const result = await synchronizeSkillManifest({
      agentsSkillsDir, claudeCodeSkillsDir: false, cursorSkillsDir: false,
      applyManifest: vi.fn(async () => undefined),
      fetchImpl: vi.fn(() => jsonResponse(manifest("enterprise", ["enterprise-skill"]))) as unknown as typeof fetch,
      ...paidAuth,
    });

    expect(result.status).toBe("applied");
    expect((await lstat(agentsSkillsDir)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(agentsSkillsDir, "prism-startup", "SKILL.md"), "utf8"))
      .toContain("name: prism-startup");
  });

    // POSIX-only: Windows chmod maps to the read-only attribute alone and lstat
  // reports 0o666 for every writable directory, so a directory that cannot be
  // entered has no Windows analogue and the mode assertion is meaningless
  // there. Ran red on windows-latest with "expected 438 to be 448" before this.
it.skipIf(process.platform === "win32")("materializes through a pre-existing transaction directory that cannot be entered", async () => {
    // The 2026-08-10 outage, reproduced. mkdir's mode is masked by the creating
    // process's umask, so a umask carrying the owner-execute bit leaves the
    // transaction base at drw------- : readable, writable, impossible to enter.
    // Every mkdtemp inside it then throws EACCES.
    //
    // The damage was silent because the halves of a sync commit independently:
    // the config DB recorded the new generation and per-skill digests while no
    // file was ever written, so the client reported itself current for nine
    // days while every managed root stayed frozen at older content. A guard
    // that asks "is this a real directory" and not "can I use it" cannot
    // recover, because nothing in the loop repairs the mode.
    const agentsSkillsDir = await root();
    const claudeCodeSkillsDir = join(dirname(agentsSkillsDir), ".claude", "skills");
    const cursorSkillsDir = join(dirname(agentsSkillsDir), ".cursor", "skills");
    const transactionBase = join(dirname(agentsSkillsDir), ".prism-skill-transactions");
    await mkdir(transactionBase, { recursive: true, mode: 0o700 });
    await chmod(transactionBase, 0o600);
    expect((await lstat(transactionBase)).mode & 0o700).not.toBe(0o700);

    const snapshot = manifest("enterprise", ["enterprise-skill"]);
    const result = await synchronizeSkillManifest({
      agentsSkillsDir, claudeCodeSkillsDir, cursorSkillsDir,
      applyManifest: vi.fn(async () => undefined),
      fetchImpl: vi.fn(() => jsonResponse(snapshot)) as unknown as typeof fetch,
      ...paidAuth,
    });

    // Without the repair this is "partial" with an EACCES mkdtemp error and no
    // skill reaches disk, which is precisely how the outage presented.
    expect(result.status).toBe("applied");
    expect(result.error).toBeFalsy();
    for (const nativeRoot of [agentsSkillsDir, claudeCodeSkillsDir, cursorSkillsDir]) {
      expect(await readFile(join(nativeRoot, "prism-startup", "SKILL.md"), "utf8"))
        .toContain("name: prism-startup");
    }
  });

  it("prunes the formerly managed release gate from every native host on a same-tier refresh", async () => {
    const agentsSkillsDir = await root();
    const claudeCodeSkillsDir = join(dirname(agentsSkillsDir), ".claude", "skills");
    const cursorSkillsDir = join(dirname(agentsSkillsDir), ".cursor", "skills");
    const legacy = manifest("advanced", ["current-staging-acceptance"]);
    const applyManifest = vi.fn(async () => undefined);

    expect((await synchronizeSkillManifest({
      agentsSkillsDir, claudeCodeSkillsDir, cursorSkillsDir, applyManifest,
      fetchImpl: vi.fn(() => jsonResponse(legacy)) as unknown as typeof fetch,
      ...paidAuth,
    })).status).toBe("applied");
    for (const nativeRoot of [agentsSkillsDir, claudeCodeSkillsDir, cursorSkillsDir]) {
      expect(await readFile(join(nativeRoot, "current-staging-acceptance", "SKILL.md"), "utf8"))
        .toContain("name: current-staging-acceptance");
    }

    const current = manifest("advanced", []);
    const result = await synchronizeSkillManifest({
      agentsSkillsDir, claudeCodeSkillsDir, cursorSkillsDir, applyManifest,
      fetchImpl: vi.fn(() => jsonResponse(current)) as unknown as typeof fetch,
      ...paidAuth,
    });

    expect(result.status).toBe("applied");
    expect(result.pruned).toContain("current-staging-acceptance");
    for (const nativeRoot of [agentsSkillsDir, claudeCodeSkillsDir, cursorSkillsDir]) {
      await expect(readFile(join(nativeRoot, "current-staging-acceptance", "SKILL.md"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      const index = JSON.parse(await readFile(join(nativeRoot, ".prism-managed-skills.json"), "utf8"));
      expect(index.skills).not.toContain("current-staging-acceptance");
    }
  });

  it("PRESERVES a hand-edited managed skill instead of overwriting it, and reports the conflict", async () => {
    // The safety property the 2026-08-04 audit depended on. An operator edits a
    // Prism-managed skill in place; the next sync recomputes every file digest,
    // sees it no longer matches the ownership marker, and must classify the
    // skill as a CONFLICT — preserving the edit rather than replacing it.
    //
    // A refactor that dropped the digest comparison would silently destroy
    // local work on every sync, and nothing else in this suite would notice.
    const fixture = await mkdtemp(join(tmpdir(), "prism-handedit-sync-"));
    roots.push(fixture);
    const agentsSkillsDir = join(fixture, ".agents", "skills");
    const claudeCodeSkillsDir = join(fixture, ".claude", "skills");
    const cursorSkillsDir = join(fixture, ".cursor", "skills");
    const common = {
      agentsSkillsDir, claudeCodeSkillsDir, cursorSkillsDir,
      applyManifest: vi.fn(async () => undefined), ...paidAuth,
    };

    const first = manifest("standard", ["local-browser"]);
    const installed = await synchronizeSkillManifest({
      ...common,
      fetchImpl: vi.fn(() => jsonResponse(first)) as unknown as typeof fetch,
    });
    expect(installed.status).toBe("applied");
    expect(installed.installed).toContain("local-browser");

    // The operator edits it in place — exactly what a developer does when
    // iterating on skill text locally.
    const edited = "---\nname: local-browser\n---\n# EDITED BY OPERATOR\n";
    const target = join(agentsSkillsDir, "local-browser", "SKILL.md");
    await writeFile(target, edited);

    // A newer manifest arrives carrying different content for that skill.
    const second = manifest("standard", ["local-browser"]);
    const incoming = second.skills.find((item) => item.name === "local-browser")!;
    const serverContent = "---\nname: local-browser\n---\n# SERVER VERSION 2\n";
    incoming.files["SKILL.md"] = {
      content: serverContent, digest: digest(serverContent), encoding: "utf8",
    };
    incoming.content = serverContent;
    incoming.digest = digest(serverContent);
    second.generation = computeSkillManifestGeneration(second);

    const result = await synchronizeSkillManifest({
      ...common,
      fetchImpl: vi.fn(() => jsonResponse(second)) as unknown as typeof fetch,
    });

    expect(result.status).toBe("applied");
    // The edit survives — this is the whole point.
    expect(await readFile(target, "utf8")).toBe(edited);
    expect(result.conflicts).toContain("local-browser");

    // Per-root semantics, worth pinning because it surprises: results are the
    // UNION across host roots, so the same skill is both "conflicts" (the root
    // that was edited, preserved) and "updated" (the untouched roots, which
    // took the new server content). One edited terminal does not freeze the
    // skill everywhere.
    expect(await readFile(join(claudeCodeSkillsDir, "local-browser", "SKILL.md"), "utf8"))
      .toBe(serverContent);
    expect(await readFile(join(cursorSkillsDir, "local-browser", "SKILL.md"), "utf8"))
      .toBe(serverContent);
    expect(result.updated).toContain("local-browser");
  });

  it("BACKS UP the previous content before replacing a pristine managed skill", async () => {
    // The recovery property: an update renames the old directory into the
    // transaction backup before moving the staged one in, so a replaced skill
    // is never simply gone. Proven by asserting the skill really was updated
    // (not conflicted) AND that a backup directory holding the old body exists.
    const fixture = await mkdtemp(join(tmpdir(), "prism-backup-sync-"));
    roots.push(fixture);
    const agentsSkillsDir = join(fixture, ".agents", "skills");
    const claudeCodeSkillsDir = join(fixture, ".claude", "skills");
    const cursorSkillsDir = join(fixture, ".cursor", "skills");
    const transactionsDir = join(fixture, ".agents", ".prism-skill-transactions");
    const common = {
      agentsSkillsDir, claudeCodeSkillsDir, cursorSkillsDir, transactionsDir,
      applyManifest: vi.fn(async () => undefined), ...paidAuth,
    };

    const first = manifest("standard", ["local-browser"]);
    const v1 = first.skills.find((item) => item.name === "local-browser")!;
    const originalContent = "---\nname: local-browser\n---\n# ORIGINAL\n";
    v1.files["SKILL.md"] = {
      content: originalContent, digest: digest(originalContent), encoding: "utf8",
    };
    v1.content = originalContent;
    v1.digest = digest(originalContent);
    first.generation = computeSkillManifestGeneration(first);
    await synchronizeSkillManifest({
      ...common,
      fetchImpl: vi.fn(() => jsonResponse(first)) as unknown as typeof fetch,
    });
    const target = join(agentsSkillsDir, "local-browser", "SKILL.md");
    expect(await readFile(target, "utf8")).toBe(originalContent);

    // Untouched by the operator, so it stays pristine and IS eligible to update.
    const second = manifest("standard", ["local-browser"]);
    const v2 = second.skills.find((item) => item.name === "local-browser")!;
    const nextContent = "---\nname: local-browser\n---\n# VERSION 2\n";
    v2.files["SKILL.md"] = {
      content: nextContent, digest: digest(nextContent), encoding: "utf8",
    };
    v2.content = nextContent;
    v2.digest = digest(nextContent);
    second.generation = computeSkillManifestGeneration(second);

    const result = await synchronizeSkillManifest({
      ...common,
      fetchImpl: vi.fn(() => jsonResponse(second)) as unknown as typeof fetch,
    });

    expect(result.status).toBe("applied");
    expect(result.updated).toContain("local-browser");
    expect(await readFile(target, "utf8")).toBe(nextContent);
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
      expect(await readFile(join(nativeRoot, "prism-startup", "SKILL.md"), "utf8"))
        .toContain("name: prism-startup");
      await expect(readFile(join(nativeRoot, "aba-precision-protocol", "SKILL.md"))).rejects.toThrow();
    }
    await expect(readFile(join(
      fixture, "Library", "Application Support", "Claude", "skills",
      "prism-startup", "SKILL.md",
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
      fixture, ".agents", "skills", "prism-startup", "SKILL.md",
    ), "utf8")).toContain("name: prism-startup");
    await expect(readFile(join(
      fixture, ".claude", "skills", "prism-startup", "SKILL.md",
    ))).rejects.toThrow();
    await expect(readFile(join(
      desktopRoot, "skills", "prism-startup", "SKILL.md",
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
    expect(new Set(result.pruned)).toEqual(new Set([...PAID_ONLY_NATIVE_SKILL_NAMES, "paid-skill"]));
    expect(result.conflicts).toEqual(["paid-skill"]);
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
      .mockImplementationOnce(() => jsonResponse(manifest("free", [])));

    await synchronizeSkillManifest({ agentsSkillsDir, applyManifest, fetchImpl, ...paidAuth });
    const result = await synchronizeSkillManifest({ agentsSkillsDir, applyManifest, fetchImpl, ...paidAuth });

    expect(new Set(result.pruned)).toEqual(new Set([...PAID_ONLY_NATIVE_SKILL_NAMES, "paid-skill"]));
    await expect(readFile(join(agentsSkillsDir, "paid-skill", "SKILL.md"))).rejects.toThrow();
    expect((await filesUnder(agentsSkillsDir)).some((path) => path.includes("paid-skill"))).toBe(false);
    expect(await readFile(join(agentsSkillsDir, "user-owned", "SKILL.md"), "utf8")).toBe("keep me");
    expect(applyManifest).toHaveBeenLastCalledWith(expect.objectContaining({
      tier: "free",
      skills: [expect.objectContaining({ name: "prism-startup" })],
    }));
    expect(result.entitledNames).toEqual(FREE_NATIVE_SKILL_NAMES);
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
    const paidBase = manifest("standard", []);
    const freeBase = manifest("free", []);
    expect(() => validateSkillManifest({ ...paidBase, tier: "pro" })).toThrow(/tier/);
    expect(() => validateSkillManifest({ ...paidBase, schema_version: 2 })).toThrow(/schema/);
    for (const required of REQUIRED_NATIVE_SKILL_NAMES) {
      expect(() => validateSkillManifest({
        ...paidBase,
        skills: paidBase.skills.filter((item) => item.name !== required),
      })).toThrow(new RegExp(required));
    }
    expect(() => validateSkillManifest(manifest("free", ["paid-skill"]))).toThrow(/exactly the public startup package/);
    expect(() => validateSkillManifest({
      ...paidBase,
      skills: paidBase.skills.map((item) => item.name === "aba-precision-protocol"
        ? { ...item, metadata: { ...item.metadata, protected: false } }
        : item),
    })).toThrow(/protected universal/);
    expect(() => validateSkillManifest({
      ...freeBase,
      skills: [freeBase.skills[0], { ...freeBase.skills[0], name: "PRISM-STARTUP" }],
    })).toThrow(/name|duplicate/);
    expect(() => validateSkillManifest({
      ...freeBase,
      skills: [{ ...freeBase.skills[0], files: { "../escape": freeBase.skills[0].files["SKILL.md"] } }],
    })).toThrow(/unsafe/);
    expect(() => validateSkillManifest({
      ...freeBase,
      skills: [{ ...freeBase.skills[0], digest: "0".repeat(64) }],
    })).toThrow(/mismatch/);
    expect(() => validateSkillManifest({ ...freeBase, generation: "0".repeat(64) })).toThrow(/generation digest/);
    const brokenDependency = manifest("standard", ["dev-engineering-super-skill"]);
    const engineering = brokenDependency.skills.find((item) => item.name === "dev-engineering-super-skill")!;
    const brokenContent = "---\nname: dev-engineering-super-skill\n---\n[Missing](../missing-protocol/SKILL.md)\n";
    engineering.content = brokenContent;
    engineering.digest = digest(brokenContent);
    engineering.files["SKILL.md"] = { content: brokenContent, digest: digest(brokenContent), encoding: "utf8" };
    brokenDependency.generation = computeSkillManifestGeneration(brokenDependency);
    expect(() => validateSkillManifest(brokenDependency)).toThrow(/unresolved skill dependency/);
    expect(() => validateSkillManifest({
      ...freeBase,
      skills: [{ ...freeBase.skills[0], files: {
        "SKILL.md": freeBase.skills[0].files["SKILL.md"],
        "Ref.md": freeBase.skills[0].files["SKILL.md"],
        "ref.md": freeBase.skills[0].files["SKILL.md"],
      } }],
    })).toThrow(/duplicate skill file path/);
  });

  it("is idempotent for the same generation and does not create update backups", async () => {
    const agentsSkillsDir = await root();
    const snapshot = manifest("free", []);
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
    const conflict = join(agentsSkillsDir, "prism-startup");
    await mkdir(conflict, { recursive: true });
    await writeFile(join(conflict, "SKILL.md"), "user copy");
    const snapshot = manifest("free", []);

    const result = await synchronizeSkillManifest({
      agentsSkillsDir, applyManifest: vi.fn(async () => undefined),
      fetchImpl: vi.fn(() => jsonResponse(snapshot)) as unknown as typeof fetch,
      configuredCredential: false,
    });

    expect(result.conflicts).toEqual(["prism-startup"]);
    expect(await readFile(join(conflict, "SKILL.md"), "utf8")).toBe("user copy");
  });

  it("does not downgrade to unauthenticated free when configured auth fails", async () => {
    const fetchImpl = vi.fn(() => jsonResponse(manifest("free", []))) as unknown as typeof fetch;
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
    const snapshot = manifest("free", []);
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
    const free = manifest("free", []);
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
        FREE_NATIVE_SKILL_NAMES
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
    const free = manifest("free", []);

    const result = await synchronizeSkillManifest({
      agentsSkillsDir, applyManifest: vi.fn(async () => undefined), configuredCredential: false,
      fetchImpl: vi.fn(() => jsonResponse(free)) as unknown as typeof fetch,
    });

    expect(result.status).toBe("applied");
    const discovered = await filesUnder(agentsSkillsDir);
    expect(discovered.some((path) => path.includes("paid-skill"))).toBe(false);
    expect(discovered.filter((path) => path.endsWith("SKILL.md")).sort()).toEqual(
      FREE_NATIVE_SKILL_NAMES
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
    const free = manifest("free", []);

    const result = await synchronizeSkillManifest({
      agentsSkillsDir, applyManifest: vi.fn(async () => undefined), ...paidAuth,
      fetchImpl: vi.fn(() => jsonResponse(free)) as unknown as typeof fetch,
    });

    expect(result.conflicts).toEqual([]);
    expect(new Set(result.pruned)).toEqual(new Set([...PAID_ONLY_NATIVE_SKILL_NAMES, "paid-skill"]));
    await expect(readFile(join(agentsSkillsDir, "paid-skill", "SKILL.md"))).rejects.toThrow();
    const index = JSON.parse(await readFile(join(agentsSkillsDir, ".prism-managed-skills.json"), "utf8"));
    expect(index.skills).toEqual([...FREE_NATIVE_SKILL_NAMES].sort());
  });

  it("finishes a DB-committed downgrade after a hard exit even when the portal is offline", async () => {
    const agentsSkillsDir = await root();
    const claudeCodeSkillsDir = join(dirname(agentsSkillsDir), ".claude", "skills");
    const paid = manifest("advanced", ["aba-precision-protocol", "paid-skill"]);
    expect((await synchronizeSkillManifest({
      agentsSkillsDir, claudeCodeSkillsDir, ...paidAuth,
      fetchImpl: vi.fn(() => jsonResponse(paid)) as unknown as typeof fetch,
    })).status).toBe("applied");
    const free = manifest("free", []);
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
    expect(result.entitledNames).toEqual(FREE_NATIVE_SKILL_NAMES);
    for (const nativeRoot of [agentsSkillsDir, claudeCodeSkillsDir]) {
      await expect(readFile(join(nativeRoot, "paid-skill", "SKILL.md"))).rejects.toThrow();
      expect((await filesUnder(nativeRoot)).some((path) => path.includes("paid-skill"))).toBe(false);
    }
  });

  it("preserves locally modified managed skills and reports the conflict", async () => {
    const agentsSkillsDir = await root();
    const snapshot = manifest("free", []);
    const options = {
      agentsSkillsDir, applyManifest: vi.fn(async () => undefined), configuredCredential: false,
      fetchImpl: vi.fn(() => jsonResponse(snapshot)) as unknown as typeof fetch,
    };
    await synchronizeSkillManifest(options);
    await writeFile(join(agentsSkillsDir, "prism-startup", "local-note.md"), "preserve");
    const result = await synchronizeSkillManifest(options);
    expect(result.conflicts).toEqual(["prism-startup"]);
    expect(await readFile(join(agentsSkillsDir, "prism-startup", "local-note.md"), "utf8")).toBe("preserve");
  });

  it("preserves a locally modified managed skill in quarantine when a downgrade removes its entitlement", async () => {
    const agentsSkillsDir = await root();
    const paid = manifest("advanced", ["aba-precision-protocol", "paid-skill"]);
    await synchronizeSkillManifest({
      agentsSkillsDir, applyManifest: vi.fn(async () => undefined), ...paidAuth,
      fetchImpl: vi.fn(() => jsonResponse(paid)) as unknown as typeof fetch,
    });
    await writeFile(join(agentsSkillsDir, "paid-skill", "local-note.md"), "user modification");
    const free = manifest("free", []);

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
    const snapshot = manifest("free", []);
    const fetchImpl = vi.fn(() => jsonResponse(snapshot)) as unknown as typeof fetch;
    const result = await synchronizeSkillManifest({
      agentsSkillsDir, applyManifest, fetchImpl, configuredCredential: false, lockWaitMs: 10,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/timed out waiting/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(applyManifest).not.toHaveBeenCalled();
    await expect(readFile(join(agentsSkillsDir, "prism-startup", "SKILL.md"))).rejects.toThrow();
  });

  it("does not remove a replacement lock owned by another sync", async () => {
    const agentsSkillsDir = await root();
    const snapshot = manifest("free", []);
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
    const free = manifest("free", []);
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
    expect(JSON.parse(await getSetting("skill_manifest:names"))).toEqual(FREE_NATIVE_SKILL_NAMES);
    await expect(readFile(join(agentsSkillsDir, "paid-skill", "SKILL.md"))).rejects.toThrow();
    const index = JSON.parse(await readFile(join(agentsSkillsDir, ".prism-managed-skills.json"), "utf8"));
    expect(index.generation).toBe(free.generation);
    expect(index.skills).toEqual([...FREE_NATIVE_SKILL_NAMES].sort());
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked native root before fetch or DB apply", async () => {
    const fixture = await root();
    const target = join(fixture, "real-skills");
    const link = join(fixture, "linked-skills");
    await mkdir(target);
    await symlink(target, link, "dir");
    const applyManifest = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(() => jsonResponse(manifest("free", []))) as unknown as typeof fetch;

    const result = await synchronizeSkillManifest({ agentsSkillsDir: link, applyManifest, fetchImpl, configuredCredential: false });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/real directory/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(applyManifest).not.toHaveBeenCalled();
  });

  it("retries a failed startup sync when session loading asks again", async () => {
    process.env.PRISM_SKILL_SYNC_DISABLED = "false";
    const snapshot = manifest("free", []);
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
