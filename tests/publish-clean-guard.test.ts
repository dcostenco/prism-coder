import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { privateIdentifierTerms } from "../scripts/private-identifier-terms.mjs";

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

describe("versioned-manifest coverage", () => {
  it("guards every manifest that a release bumps in lockstep", () => {
    // The brand-alias package is published to npm and version-locked with
    // prism-mcp-server, but was NOT in this list — a review of the 20.13.0
    // staging caught it left a full release behind while every other manifest
    // moved, which the guard would not have flagged. Pin it so it cannot fall
    // out of coverage silently.
    //
    // Read via SUBPROCESS, not import(): a top-level import of this .mjs
    // under vitest fails to parse on Windows — the exact failure mode the
    // published-version guard below already documents — and the 20.13.0
    // release reintroduced the import anyway, turning main's Windows CI red.
    // The path travels via env, NOT argv: the script's IS_MAIN guard compares
    // argv[1] to its own path, so passing it as an argument executes the full
    // publish check against this repo (exit 1 on any released version).
    const out = spawnSync(process.execPath, [
      "-e",
      "const{pathToFileURL}=require('node:url');import(pathToFileURL(process.env.GUARD_SCRIPT).href).then(m=>console.log(JSON.stringify(m.VERSIONED_MANIFESTS)))",
    ], { encoding: "utf8", env: { ...process.env, GUARD_SCRIPT: SCRIPT } });
    expect(out.status, out.stderr).toBe(0);
    const manifests: string[] = JSON.parse(out.stdout);
    expect(manifests).toContain("packages/prism-coder/package.json");
    expect(manifests).toContain("plugins/prism/.codex-plugin/plugin.json");
    expect(manifests).toContain("plugins/prism/.claude-plugin/plugin.json");
  });
});

describe("mcp launcher pin guard", () => {
  // The plugin catalogs reject unpinned auto-exec MCP launchers (their CI
  // gate landed 2026-08-19 while prism-coder sat in review with exactly
  // `npx -y prism-mcp-server`). The pin is now a lockstep surface: this
  // exercises the exported checker with inline fixtures via the same
  // subprocess pattern the manifest-coverage test documents (top-level
  // import of the .mjs breaks vitest on Windows).
  it("flags unpinned and wrong-version launchers, passes the exact pin", () => {
    const out = spawnSync(process.execPath, [
      "-e",
      `const{pathToFileURL}=require('node:url');import(pathToFileURL(process.env.GUARD_SCRIPT).href).then(m=>{
        const f=m.mcpLauncherPinMismatches;
        console.log(JSON.stringify([
          f({mcpServers:{a:{command:'npx',args:['-y','prism-mcp-server']}}}, '1.2.3').length,
          f({mcpServers:{a:{command:'npx',args:['-y','prism-mcp-server@1.0.0']}}}, '1.2.3').length,
          f({mcpServers:{a:{command:'npx',args:['-y','prism-mcp-server@1.2.3']}}}, '1.2.3').length,
          f({mcpServers:{a:{command:'npx',args:['-y','some-other-package']}}}, '1.2.3').length,
          f({}, '1.2.3').length,
        ]))})`,
    ], { encoding: "utf8", env: { ...process.env, GUARD_SCRIPT: SCRIPT } });
    expect(out.status, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual([1, 1, 0, 0, 0]);
  });

  it("WIRING: the gate itself fails a repo whose only defect is a stale pin", () => {
    // Mutant analysis during authoring showed the two tests below never
    // exercise checkManifestVersions' wiring: dropping the checkMcpLauncherPin
    // call left them green. This drives the composed gate over a fixture repo
    // that is version-consistent EVERYWHERE except the launcher pin.
    const dir = mkdtempSync(resolve(tmpdir(), "pin-wiring-"));
    tempRepos.push(dir);
    const { mkdirSync } = require("node:fs");
    mkdirSync(resolve(dir, "plugins/prism"), { recursive: true });
    writeFileSync(resolve(dir, "package.json"), JSON.stringify({ name: "prism-mcp-server", version: "9.9.9" }));
    writeFileSync(resolve(dir, "server.json"), JSON.stringify({
      version: "9.9.9", description: "x",
      packages: [{ identifier: "prism-mcp-server", version: "9.9.9" }],
    }));
    writeFileSync(resolve(dir, "plugins/prism/.mcp.json"), JSON.stringify({
      mcpServers: { "prism-mcp": { command: "npx", args: ["-y", "prism-mcp-server@1.0.0"] } },
    }));
    const out = spawnSync(process.execPath, [
      "-e",
      `const{pathToFileURL}=require('node:url');import(pathToFileURL(process.env.GUARD_SCRIPT).href).then(m=>console.log(JSON.stringify(m.checkManifestVersions(process.env.FIXTURE))))`,
    ], { encoding: "utf8", env: { ...process.env, GUARD_SCRIPT: SCRIPT, FIXTURE: dir } });
    expect(out.status, out.stderr).toBe(0);
    const problems: string[] = JSON.parse(out.stdout);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('must be pinned "prism-mcp-server@9.9.9"');
  });

  it("the REAL plugin manifest is pinned to the REAL package version", () => {
    const mcp = JSON.parse(readFileSync(resolve(process.cwd(), "plugins/prism/.mcp.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    const args: string[] = mcp.mcpServers["prism-mcp"].args;
    expect(args).toContain(`prism-mcp-server@${pkg.version}`);
    expect(args).not.toContain("prism-mcp-server");
  });
});

describe("release-notes version guard", () => {
  // CHANGELOG/README entries are written before the bump, so at publish time
  // they can announce a version the package does not carry (20.18.0 notes on
  // a 20.17.3 package, 2026-09-01). The rule is "never AHEAD of package.json",
  // not "equal": the first draft of this guard demanded equality and was red
  // on main the day it was written — CHANGELOG had led with 20.15.0 through
  // five releases (notes lag by convention) — so it would have blocked every
  // one of those publishes (round-10 review). Only the FIRST versioned
  // heading is read; older entries are history.
  function docsGuard(cases: string) {
    const out = spawnSync(process.execPath, [
      "-e",
      `const{pathToFileURL}=require('node:url');import(pathToFileURL(process.env.GUARD_SCRIPT).href).then(m=>{
        const f=m.docsVersionMismatches;
        const D=(path,text)=>({path,text});
        console.log(JSON.stringify([${cases}]))})`,
    ], { encoding: "utf8", env: { ...process.env, GUARD_SCRIPT: SCRIPT } });
    expect(out.status, out.stderr).toBe(0);
    return JSON.parse(out.stdout) as string[][];
  }

  it("flags notes that run AHEAD of the package; agreement, lag, and absence pass", () => {
    const [agree, ahead, behind, logOnly, readmeOnly, none, unreleased, unparseable] = docsGuard(`
      f([D('CHANGELOG.md','# Changelog\\n\\n## 2.0.0 — 2026-09-01\\n\\n- new\\n\\n## 1.0.0\\n'), D('README.md','# Prism\\n\\n## What\\'s New in v2.0.0\\n\\ntext\\n\\n## What\\'s New in v1.0.0\\n')], '2.0.0'),
      f([D('CHANGELOG.md','# Changelog\\n\\n## 2.0.0 — 2026-09-01\\n\\n- new\\n\\n## 1.0.0\\n'), D('README.md','# Prism\\n\\n## What\\'s New in v2.0.0\\n\\ntext\\n\\n## What\\'s New in v1.0.0\\n')], '1.0.0'),
      f([D('CHANGELOG.md','# Changelog\\n\\n## 20.15.0 — 2026-08-24\\n'), D('README.md','## What\\'s New in v20.17.2\\n')], '20.17.3'),
      f([D('CHANGELOG.md','## 2.0.0\\n'), D('README.md',null)], '1.0.0'),
      f([D('CHANGELOG.md',null), D('README.md','## What\\'s New in v2.0.0\\n')], '1.0.0'),
      f([D('CHANGELOG.md',null), D('README.md',null)], '1.0.0'),
      f([D('CHANGELOG.md','# Changelog\\n\\n## Unreleased\\n\\n## 1.0.1\\n')], '1.0.0'),
      f([D('CHANGELOG.md','## 2.0.0\\n')], 'not-a-version'),
    `);
    expect(agree).toEqual([]);
    expect(ahead).toEqual([
      "CHANGELOG.md leads with 2.0.0, ahead of package.json 1.0.0",
      "README.md leads with 2.0.0, ahead of package.json 1.0.0",
    ]);
    expect(behind).toEqual([]); // main's real shape on 2026-09-01: notes lag the bump
    expect(logOnly).toHaveLength(1);
    expect(readmeOnly).toHaveLength(1);
    expect(none).toEqual([]);
    // "Unreleased" is not a version, so the first VERSIONED heading is read —
    // and 1.0.1 is ahead of a 1.0.0 package.
    expect(unreleased).toEqual(["CHANGELOG.md leads with 1.0.1, ahead of package.json 1.0.0"]);
    expect(unparseable).toEqual([]); // the manifest checks own a bad package version
  });

  it("compares numerically, reads only headings, ignores fenced code, and takes a range's NEWER bound", () => {
    const [numeric, patchless, prerelease, prose, fenced, rangeReleased, rangeAhead, rangePatchless, changelogRange, descending, keepAChangelog, translated] = docsGuard(`
      f([D('CHANGELOG.md','## 20.9.0\\n')], '20.10.0'),
      f([D('README.md','## What\\'s New in v20.7\\n')], '20.7.2'),
      f([D('CHANGELOG.md','## 1.0.0\\n'), D('README.md','## What\\'s New in v1.0.0\\n')], '1.0.0-rc.1'),
      f([D('README.md','Prism\\n\\nSee What\\'s New in v9.0.0 below.\\n\\n## What\\'s New in v1.0.0\\n')], '1.0.0'),
      f([D('CHANGELOG.md','# Changelog\\n\\n\`\`\`md\\n## 9.0.0\\n\`\`\`\\n\\n## 1.0.0\\n')], '1.0.0'),
      f([D('README.md','## What\\'s New in v20.10.0 – v20.11.0\\n')], '20.11.0'),
      f([D('README.md','## What\\'s New in v20.17.3 – v20.18.0\\n')], '20.17.3'),
      f([D('README.md','## What\\'s New in v20.7 – v20.8.0\\n')], '20.7.2'),
      f([D('CHANGELOG.md','## 20.17.3 – 20.18.0\\n')], '20.17.3'),
      f([D('CHANGELOG.md','## 20.18.0 — supersedes 20.17.3\\n')], '20.17.3'),
      f([D('CHANGELOG.md','## [2.0.0] - 2026-09-01\\n')], '1.0.0'),
      f([D('docs/i18n/README_de.md','## What\\'s New in v2.0.0\\n')], '1.0.0'),
    `);
    expect(numeric).toEqual([]); // "20.9.0" > "20.10.0" as strings, behind as versions
    expect(patchless).toEqual([]); // v20.7 reads as 20.7.0
    expect(prerelease).toEqual([]);
    expect(prose).toEqual([]);
    expect(fenced).toEqual([]);
    // A range announces its newer bound: released → passes; the round-11
    // case (upper bound ahead, package at the lower) → flagged. Reading the
    // first capture alone passed it.
    expect(rangeReleased).toEqual([]);
    expect(rangeAhead).toEqual(["README.md leads with 20.18.0, ahead of package.json 20.17.3"]);
    expect(rangePatchless).toEqual(["README.md leads with 20.8.0, ahead of package.json 20.7.2"]);
    // Both halves scan the whole line: a CHANGELOG regex that stopped at the
    // first version token survived every README range case above.
    expect(changelogRange).toEqual(["CHANGELOG.md leads with 20.18.0, ahead of package.json 20.17.3"]);
    // The HIGHEST token on the line, not the last one (round-12 review).
    expect(descending).toEqual(["CHANGELOG.md leads with 20.18.0, ahead of package.json 20.17.3"]);
    expect(keepAChangelog).toEqual(["CHANGELOG.md leads with 2.0.0, ahead of package.json 1.0.0"]);
    expect(translated).toEqual(["docs/i18n/README_de.md leads with 2.0.0, ahead of package.json 1.0.0"]);
  });

  it("a typographic apostrophe, a BOM, or CRLF line endings do not disable the README half", () => {
    const [curly, bom, bomCurly, crlf, dateInHeading] = docsGuard(`
      f([D('README.md','# Prism\\n\\n## What’s New in v2.0.0\\n')], '1.0.0'),
      f([D('README.md','\\uFEFF## What\\'s New in v2.0.0\\n')], '1.0.0'),
      f([D('docs/i18n/README_ja.md','\\uFEFF## What’s New in v2.0.0\\n')], '1.0.0'),
      f([D('CHANGELOG.md','# Changelog\\r\\n\\r\\n## 2.0.0 — 2026-09-01\\r\\n')], '1.0.0'),
      f([D('CHANGELOG.md','## 1.0.0 — 2026-09-01 (supersedes 0.9.0)\\n')], '1.0.0'),
    `);
    expect(curly).toEqual(["README.md leads with 2.0.0, ahead of package.json 1.0.0"]);
    expect(bom).toEqual(["README.md leads with 2.0.0, ahead of package.json 1.0.0"]);
    expect(bomCurly).toEqual(["docs/i18n/README_ja.md leads with 2.0.0, ahead of package.json 1.0.0"]);
    expect(crlf).toEqual(["CHANGELOG.md leads with 2.0.0, ahead of package.json 1.0.0"]);
    // Only version-shaped tokens count, and the newest one is the announcement.
    expect(dateInHeading).toEqual([]);
  });

  it("WIRING: the gate itself fails a repo whose only defect is release notes ahead of the package, translations included", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "docs-wiring-"));
    tempRepos.push(dir);
    const { mkdirSync } = require("node:fs");
    mkdirSync(resolve(dir, "docs/i18n"), { recursive: true });
    writeFileSync(resolve(dir, "package.json"), JSON.stringify({ name: "prism-mcp-server", version: "9.9.9" }));
    writeFileSync(resolve(dir, "server.json"), JSON.stringify({
      version: "9.9.9", description: "x",
      packages: [{ identifier: "prism-mcp-server", version: "9.9.9" }],
    }));
    writeFileSync(resolve(dir, "CHANGELOG.md"), "# Changelog\n\n## 9.10.0 — 2026-09-02\n\n- next\n\n## 9.9.9 — 2026-09-01\n");
    writeFileSync(resolve(dir, "README.md"), "# Prism\n\n## What's New in v9.9.9\n");
    writeFileSync(resolve(dir, "docs/i18n/README_fr.md"), "# Prism\n\n## What's New in v9.9.9\n");
    writeFileSync(resolve(dir, "docs/i18n/README_ja.md"), "# Prism\n\n## What's New in v10.0.0\n");
    writeFileSync(resolve(dir, "docs/i18n/notes.md"), "## What's New in v99.0.0\n"); // not a README, not read
    const out = spawnSync(process.execPath, [
      "-e",
      `const{pathToFileURL}=require('node:url');import(pathToFileURL(process.env.GUARD_SCRIPT).href).then(m=>console.log(JSON.stringify(m.checkManifestVersions(process.env.FIXTURE))))`,
    ], { encoding: "utf8", env: { ...process.env, GUARD_SCRIPT: SCRIPT, FIXTURE: dir } });
    expect(out.status, out.stderr).toBe(0);
    const problems: string[] = JSON.parse(out.stdout);
    expect(problems).toEqual([
      "CHANGELOG.md leads with 9.10.0, ahead of package.json 9.9.9",
      "docs/i18n/README_ja.md leads with 10.0.0, ahead of package.json 9.9.9",
    ]);
  });

  it("the REAL repo's CHANGELOG, README and every translated README are in the guard's scope", () => {
    // Scope on this repo, not a fixture. Deliberately NOT asserting "none
    // ahead" here: a feature branch writes its notes before the bump, so
    // that assertion would red `npm test` on every such branch — the same
    // workflow-blocking class the equality guard had. Ahead-ness is judged
    // at publish time only (prepublishOnly + registry-publish).
    const out = spawnSync(process.execPath, [
      "-e",
      `const{pathToFileURL}=require('node:url');import(pathToFileURL(process.env.GUARD_SCRIPT).href).then(m=>console.log(JSON.stringify(m.releaseNoteDocPaths(process.cwd()))))`,
    ], { encoding: "utf8", cwd: process.cwd(), env: { ...process.env, GUARD_SCRIPT: SCRIPT } });
    expect(out.status, out.stderr).toBe(0);
    const paths: string[] = JSON.parse(out.stdout);
    expect(paths.slice(0, 2)).toEqual(["CHANGELOG.md", "README.md"]);
    expect(paths.length).toBeGreaterThan(2);
    // `/` on every host: the name is reported verbatim in the gate's message
    // and is the same document on Windows. The earlier `[\\/]` tolerance here
    // hid a `docs\i18n\…` report that the WIRING test above then caught only
    // on the Windows CI leg.
    expect(paths.slice(2).every((p) => /^docs\/i18n\/README_[a-z]+\.md$/.test(p))).toBe(true);
  });
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
// before a publish, not after. The terms come from the one canonical list, so
// this file neither repeats nor assembles them (tests/privateIdentifierScan.test.ts
// covers names assembled from pieces).
describe("private identifiers must not appear in tracked files", () => {
  const TERMS = privateIdentifierTerms();
  const IGNORE = /package-lock\.json|\.github\/workflows\/ci\.yml|tests\/publish-clean-guard\.test\.ts/;

  // Titled by position, never by value: test titles land in CI logs, and the
  // logs of a public repository are public.
  it.each(TERMS.map((term, i) => [i + 1, term] as const))("no tracked file contains private identifier #%i", (_index, term) => {
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
    function runGuardWithPublished(repo: string, published: string) {
        return spawnSync(process.execPath, [SCRIPT], {
            cwd: repo,
            encoding: "utf8",
            env: { ...process.env, PRISM_GUARD_PUBLISHED_VERSION: published },
        });
    }

    function repoWithPackage(name: string, version: string): string {
        const repo = createCommittedRepo();
        writeFileSync(resolve(repo, "package.json"), JSON.stringify({ name, version }, null, 2));
        execFileSync("git", ["add", "package.json"], { cwd: repo });
        execFileSync("git", ["commit", "--quiet", "-m", "package"], { cwd: repo });
        return repo;
    }

    it("blocks a version npm already serves", () => {
        // Pinned via the seam, NOT the live registry: hard-coding a real
        // published version made this test fail the moment 20.7.0 shipped.
        const result = runGuardWithPublished(repoWithPackage("pkg", "20.6.0"), "20.6.0");
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("already published");
        expect(result.stderr).toContain("server.json");
    });

    it("allows a version that advances past the published one", () => {
        const result = runGuardWithPublished(repoWithPackage("pkg", "20.7.0"), "20.6.0");
        expect(result.stderr).not.toContain("already published");
        expect(result.status).toBe(0);
    });

    // The MCP Registry rejects a description over 100 chars with a 422 — at
    // publish time, on main, after every local gate passed. Measured
    // 2026-08-06 when a 369-char description rewrite failed exactly there.
    // The guard must catch it before a PR merges, not after.
    function repoWithDescription(description: string): string {
        const repo = repoWithPackage("pkg", "1.0.0");
        writeFileSync(
            resolve(repo, "server.json"),
            JSON.stringify({ name: "io.github.x/pkg", version: "1.0.0", description }, null, 2),
        );
        execFileSync("git", ["add", "server.json"], { cwd: repo });
        execFileSync("git", ["commit", "--quiet", "-m", "server"], { cwd: repo });
        return repo;
    }

    it("blocks a server.json description the registry would 422", () => {
        const result = spawnSync(process.execPath, [SCRIPT, "--manifest-only"], {
            cwd: repoWithDescription("x".repeat(101)),
            encoding: "utf8",
            env: { ...process.env },
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("MCP Registry rejects over 100");
    });

    it("allows a description at exactly the registry limit", () => {
        const result = spawnSync(process.execPath, [SCRIPT, "--manifest-only"], {
            cwd: repoWithDescription("x".repeat(100)),
            encoding: "utf8",
            env: { ...process.env },
        });
        expect(result.stderr).not.toContain("MCP Registry");
        expect(result.status).toBe(0);
    });

    it("--manifest-only skips the published check, because the registry republish runs AFTER npm publish", () => {
        // Without this the guard blocks the very republish it exists to
        // protect: the registry workflow runs post-publish, so "this version
        // is on npm" is its correct precondition. Observed on 20.7.0.
        const repo = repoWithPackage("pkg", "20.6.0");
        const full = runGuardWithPublished(repo, "20.6.0");
        expect(full.status).toBe(1);
        expect(full.stderr).toContain("already published");

        const scoped = spawnSync(process.execPath, [SCRIPT, "--manifest-only"], {
            cwd: repo,
            encoding: "utf8",
            env: { ...process.env, PRISM_GUARD_PUBLISHED_VERSION: "20.6.0" },
        });
        expect(scoped.status).toBe(0);
        expect(scoped.stderr).not.toContain("already published");
    });

    it("fails OPEN for a package the registry does not know", () => {
        // A first release must still work, so an unknown package cannot block.
        const result = runGuardWithPublished(repoWithPackage("pkg", "1.0.0"), "");
        expect(result.stderr).not.toContain("already published");
        expect(result.status).toBe(0);
    });
});
