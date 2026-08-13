/**
 * Self-update inside `prism connect` — the converge command.
 *
 * The dangerous cases are the SKIPS and FAILURES, because each one is a
 * machine that keeps working with the code it has: a converge command that
 * bricks a machine on a network error, or "upgrades" a developer's
 * hand-installed build to an older registry release, teaches people to stop
 * running it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, symlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "selfupd-")); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));
import { maybeSelfUpdate, isNewer } from "../src/selfUpdate.js";

const noEnv = {}; // deliberately NOT process.env — vitest sets VITEST there

describe("version comparison", () => {
  it.each([
    ["20.10.0", "20.11.0", true],
    ["20.10.0", "21.0.0", true],
    ["20.10.0", "20.10.1", true],
    ["20.10.0", "20.10.0", false],
    ["20.11.0", "20.10.9", false],
    ["20.10.0", "3.9.9", false],
  ])("%s -> %s newer=%s", (a, b, want) => {
    expect(isNewer(a, b)).toBe(want);
  });
});

describe("invocation-path guard", () => {
  it("a checkout path skips — npm would update the global while re-exec ran old code", () => {
    const r = maybeSelfUpdate({
      currentVersion: "20.10.0", env: noEnv, invokedFrom: "/Users/dev/prism/dist/cli.js",
      fetchLatest: () => { throw new Error("must not fetch"); },
      install: () => { throw new Error("must not install"); },
    });
    expect(r.action).toBe("skipped");
    expect(r.detail).toContain("checkout");
  });

  it("a global BIN SYMLINK does NOT skip — argv[1] has no node_modules but its realpath does", () => {
    // The empirical case that broke the first version of this guard.
    const bin = join(tmp, "bin"); const lib = join(tmp, "lib", "node_modules", "pkg", "dist");
    mkdirSync(bin, { recursive: true }); mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, "cli.js"), "");
    symlinkSync(join("..", "lib", "node_modules", "pkg", "dist", "cli.js"), join(bin, "prism"));
    const r = maybeSelfUpdate({
      currentVersion: "20.10.0", env: noEnv, invokedFrom: join(bin, "prism"),
      fetchLatest: () => "20.10.0", // current → clean stop after passing the guard
      install: () => { throw new Error("must not install"); },
    });
    expect(r.action).toBe("current");
  });
});

describe("maybeSelfUpdate", () => {
  it("updates and reports when the registry is ahead", () => {
    const installed: string[] = [];
    const r = maybeSelfUpdate({
      currentVersion: "20.10.0",
      env: noEnv,
      fetchLatest: () => "20.11.0",
      install: (v) => installed.push(v),
    });
    expect(r.action).toBe("updated");
    expect(installed).toEqual(["20.11.0"]);
  });

  it("does nothing when current", () => {
    const r = maybeSelfUpdate({
      currentVersion: "20.11.0", env: noEnv,
      fetchLatest: () => "20.11.0",
      install: () => { throw new Error("must not install"); },
    });
    expect(r.action).toBe("current");
  });

  it("NEVER touches a dev build — registry 'latest' would be a downgrade of intent", () => {
    const r = maybeSelfUpdate({
      currentVersion: "20.10.1-local.6", env: noEnv,
      fetchLatest: () => { throw new Error("must not even fetch"); },
      install: () => { throw new Error("must not install"); },
    });
    expect(r.action).toBe("skipped");
    expect(r.detail).toContain("dev build");
  });

  it("offline: reports and continues — a converge command must not brick on network", () => {
    const r = maybeSelfUpdate({
      currentVersion: "20.10.0", env: noEnv,
      fetchLatest: () => { throw new Error("ENOTFOUND registry.npmjs.org"); },
      install: () => { throw new Error("must not install"); },
    });
    expect(r.action).toBe("failed");
    expect(r.detail).toContain("continuing with 20.10.0");
  });

  it("a failed install continues with the current version rather than aborting connect", () => {
    const r = maybeSelfUpdate({
      currentVersion: "20.10.0", env: noEnv,
      fetchLatest: () => "20.11.0",
      install: () => { throw new Error("EACCES"); },
    });
    expect(r.action).toBe("failed");
    expect(r.detail).toContain("npm install -g failed");
  });

  it("garbage from the registry is refused, not installed", () => {
    const r = maybeSelfUpdate({
      currentVersion: "20.10.0", env: noEnv,
      fetchLatest: () => "banana; rm -rf /",
      install: () => { throw new Error("must not install"); },
    });
    expect(r.action).toBe("failed");
    expect(r.detail).toContain("unexpected version");
  });

  it("PRISM_NO_SELF_UPDATE=1 and test environments skip without network", () => {
    for (const env of [{ PRISM_NO_SELF_UPDATE: "1" }, { VITEST: "true" }, { NODE_ENV: "test" }]) {
      const r = maybeSelfUpdate({
        currentVersion: "20.10.0", env,
        fetchLatest: () => { throw new Error("must not fetch"); },
        install: () => { throw new Error("must not install"); },
      });
      expect(r.action).toBe("skipped");
    }
  });
});
