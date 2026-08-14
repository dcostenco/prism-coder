/**
 * shell_run must not go through a shell.
 *
 * CodeQL js/command-line-injection (CRITICAL, open on the PUBLIC repo):
 * scripts/prism-agent.mjs called execSync(trimmed) — a shell invocation on a
 * model-supplied string. The allowlist, newline reject and metacharacter block
 * make exploitation hard, but they are filters in front of a shell; the class
 * only disappears when the shell does. execFileSync with an argv array cannot
 * interpret metacharacters at all.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { shellRunTool } from "../scripts/prism-agent.mjs";

const SRC = readFileSync("scripts/prism-agent.mjs", "utf8");

describe("shell_run", () => {
  it("does not invoke a shell", () => {
    expect(SRC).toMatch(/execFileSync\(/);
    expect(SRC).not.toMatch(/execSync\(trimmed/);
  });

  it("still refuses commands outside the allowlist", () => {
    expect(shellRunTool("curl http://evil.example")).toMatch(/not in allowlist/);
  });

  it("still refuses metacharacters and newlines", () => {
    expect(shellRunTool("git status; rm -rf /")).toMatch(/allowlist|metacharacters/);
    expect(shellRunTool("git status\nrm -rf /")).toMatch(/newlines/);
  });

  it("runs an allowlisted command through execFileSync (no shell)", () => {
    const out = shellRunTool("git status");
    // Portable across runners: the point is that an allowlisted command still
    // executes and returns output rather than being refused by the new path.
    expect(out).not.toMatch(/not in allowlist|metacharacters|newlines/);
    expect(out.length).toBeGreaterThan(0);
  });
});
