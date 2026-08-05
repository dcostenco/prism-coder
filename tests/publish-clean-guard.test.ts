import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(process.cwd(), "scripts/check-publish-clean.mjs");
const tempRepos: string[] = [];

function createCommittedRepo(): string {
  const repo = mkdtempSync(resolve(tmpdir(), "prism-publish-guard-"));
  tempRepos.push(repo);

  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "tests@prism.invalid"], {
    cwd: repo,
  });
  execFileSync("git", ["config", "user.name", "Prism Tests"], { cwd: repo });
  writeFileSync(resolve(repo, ".gitignore"), "dist/\n");
  writeFileSync(resolve(repo, "tracked.txt"), "committed\n");
  execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: repo });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repo });
  return repo;
}

function runGuard(repo: string) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const repo of tempRepos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe("npm publish cleanliness guard", () => {
  it("allows a release only when its artifact is reproducible from Git", () => {
    const result = runGuard(createCommittedRepo());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("blocks modified tracked source before npm can build it", () => {
    const repo = createCommittedRepo();
    writeFileSync(resolve(repo, "tracked.txt"), "uncommitted\n");

    const result = runGuard(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("working tree is not clean");
    expect(result.stderr).toContain("tracked.txt");
  });

  it("blocks untracked source from entering an immutable package", () => {
    const repo = createCommittedRepo();
    writeFileSync(resolve(repo, "untracked.ts"), "export const leaked = true;\n");

    const result = runGuard(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("working tree is not clean");
    expect(result.stderr).toContain("untracked.ts");
  });
});

// ── Private-identifier leak guard (mirrors .github/workflows/ci.yml) ─────────
// The CI guard checked ONE term (the private repo name) and stayed green while
// a private Vercel team slug and a private client project name shipped in the
// published npm package. Running it here too means it fails at `npm test`,
// before a publish, not after. Terms are split so this file cannot self-match.
describe("private identifiers must not appear in tracked files", () => {
  const TERMS = [
    "synalux" + "-private",
    "dcostencos" + "-projects",
    "bcba" + "-private",
    "/Users/" + "admin",
  ];
  const IGNORE = /package-lock\.json|\.github\/workflows\/ci\.yml|tests\/publish-clean-guard\.test\.ts/;

  it.each(TERMS)("no tracked file contains %s", (term) => {
    const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
      .split("\n").filter(Boolean).filter((f) => !IGNORE.test(f));
    const hits = spawnSync("grep", ["-ln", term, ...tracked], { encoding: "utf8" })
      .stdout.split("\n").filter(Boolean);
    expect(hits, `private identifier leaked into: ${hits.join(", ")}`).toEqual([]);
  });
});

describe("published-version conflict guard", () => {
    // The manifest guard proves server.json and package.json AGREE. It says
    // nothing about whether the version ADVANCED — so main accumulated a
    // session of shipped work while both files sat at 20.6.0, agreeing with
    // each other and with npm, and disagreeing with reality. npm only
    // rejected it after a full build and pack.
    //
    // Driven through the SUBPROCESS, not import(): importing this .mjs under
    // vitest fails on Windows, while spawning it is already proven here.
    function repoWithPackage(name: string, version: string): string {
        const repo = createCommittedRepo();
        writeFileSync(resolve(repo, "package.json"), JSON.stringify({ name, version }, null, 2));
        execFileSync("git", ["add", "package.json"], { cwd: repo });
        execFileSync("git", ["commit", "--quiet", "-m", "package"], { cwd: repo });
        return repo;
    }

    it("blocks a version npm already serves", () => {
        // prism-mcp-server@20.6.0 is published; re-publishing it must fail.
        const result = runGuard(repoWithPackage("prism-mcp-server", "20.6.0"));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("already published");
        expect(result.stderr).toContain("server.json");
    });

    it("allows a version that advances past the published one", () => {
        const result = runGuard(repoWithPackage("prism-mcp-server", "999.0.0"));
        expect(result.stderr).not.toContain("already published");
        expect(result.status).toBe(0);
    });

    it("fails OPEN for a package the registry does not know", () => {
        // A first release must still work, so an unknown package cannot block.
        const result = runGuard(repoWithPackage("prism-guard-fixture-does-not-exist-xyz", "1.0.0"));
        expect(result.stderr).not.toContain("already published");
        expect(result.status).toBe(0);
    });
});
