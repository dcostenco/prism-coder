/**
 * shell_run must not go through a shell.
 *
 * CodeQL js/command-line-injection (CRITICAL, open on the PUBLIC repo):
 * scripts/prism-agent.mjs called execSync(trimmed) — a shell invocation on a
 * model-supplied string. The allowlist, newline reject and metacharacter block
 * make exploitation hard, but they are filters in front of a shell; the class
 * only disappears when the shell does.
 *
 * Driven through a SUBPROCESS, not import(): importing these .mjs scripts
 * under vitest fails on Windows. tests/publish-clean-guard.test.ts records the
 * same lesson — this suite reintroduced the failure by importing directly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const SCRIPT = resolve(ROOT, "scripts/prism-agent.mjs");
const SRC = readFileSync(SCRIPT, "utf8");

/** Call shellRunTool inside a child process (Windows-safe). */
function shellRun(command: string): string {
  const r = spawnSync(
    process.execPath,
    ["-e",
     `import(${JSON.stringify(pathToFileURL(SCRIPT).href)})` +
     `.then(m => process.stdout.write(String(m.shellRunTool(process.argv[1]))))`,
     command],
    { encoding: "utf8", cwd: ROOT },
  );
  return (r.stdout || "") + (r.stderr || "");
}

describe("shell_run", () => {
  it("does not invoke a shell", () => {
    expect(SRC).toMatch(/execFileSync\(/);
    expect(SRC).not.toMatch(/execSync\(trimmed/);
  });

  it("keeps the allowlist and metacharacter filters as defence in depth", () => {
    expect(SRC).toMatch(/SHELL_ALLOWLIST/);
    expect(SRC).toMatch(/newlines and null bytes not allowed/);
    expect(SRC).toMatch(/shell metacharacters not allowed/);
  });

  it("refuses commands outside the allowlist", () => {
    expect(shellRun("curl http://evil.example")).toMatch(/not in allowlist/);
  });

  it("refuses metacharacters and newlines", () => {
    expect(shellRun("git status; rm -rf /")).toMatch(/allowlist|metacharacters/);
    expect(shellRun("git status\nrm -rf /")).toMatch(/newlines/);
  });

  it("still runs an allowlisted command", () => {
    const out = shellRun("git status");
    expect(out).not.toMatch(/not in allowlist|metacharacters|newlines/);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("the executable is never model-derived", () => {
  it("spawns only literals from a fixed table", () => {
    expect(SRC).toMatch(/const SHELL_BINARIES = Object\.freeze\(/);
    expect(SRC).toMatch(/const file = SHELL_BINARIES\[requested\]/);
    expect(SRC).not.toMatch(/execFileSync\(requested/);
  });

  it("refuses an executable outside the table even if the allowlist regex passed", () => {
    expect(shellRun("curl --version")).toMatch(/not in allowlist|not permitted/);
  });
});
