/**
 * `prism update` — the scheduled-safe package updater.
 *
 * Design review 2026-08-14: a timer must NOT run `prism connect` — connect
 * writes host configuration and expects hosts to be closed, which a timer
 * cannot guarantee. `prism update` therefore:
 *   - updates ONLY the global npm package (running servers keep their code;
 *     the next process start picks up the new release)
 *   - with --if-idle, DEFERS while any Prism MCP server process is running
 *   - takes a single-instance lock so overlapping runs cannot race npm
 *   - never touches host configuration, hooks, or hook trust (there is no
 *     code path to them — asserted here by the deps surface)
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPackageUpdate, buildAutoupdatePlist, resolvePrismBin, schedulerPath, AUTOUPDATE_LABEL } from "../src/autoUpdate.js";

const base = () => ({
  currentVersion: "20.11.1",
  fetchLatest: vi.fn(() => "20.12.0"),
  install: vi.fn(),
  listPrismProcesses: vi.fn((): string[] => []),
  acquireLock: vi.fn(() => () => {}),
  env: {} as NodeJS.ProcessEnv,
  log: () => {},
});

describe("runPackageUpdate", () => {
  it("updates the global package when newer and idle", () => {
    const deps = base();
    const result = runPackageUpdate(deps);
    expect(result.action).toBe("updated");
    expect(deps.install).toHaveBeenCalledWith("20.12.0");
  });

  it("reports current without installing when already latest", () => {
    const deps = { ...base(), fetchLatest: vi.fn(() => "20.11.1") };
    expect(runPackageUpdate(deps).action).toBe("current");
    expect(deps.install).not.toHaveBeenCalled();
  });

  it("--if-idle DEFERS while any Prism MCP process runs — never installs under a live server", () => {
    const deps = {
      ...base(),
      ifIdle: true,
      listPrismProcesses: vi.fn(() => ["1234 node /x/prism-mcp-server/dist/server.js"]),
    };
    const result = runPackageUpdate(deps);
    expect(result.action).toBe("deferred");
    expect(deps.install).not.toHaveBeenCalled();
    expect(deps.fetchLatest).not.toHaveBeenCalled(); // no work at all while busy
  });

  it("without --if-idle, running servers do not block (explicit foreground update)", () => {
    const deps = {
      ...base(),
      listPrismProcesses: vi.fn(() => ["1234 node /x/dist/server.js"]),
    };
    expect(runPackageUpdate(deps).action).toBe("updated");
  });

  it("--if-idle treats an UNVERIFIABLE process list as busy, not idle", () => {
    const deps = {
      ...base(),
      ifIdle: true,
      listPrismProcesses: vi.fn((): string[] => { throw new Error("ps unavailable"); }),
    };
    const result = runPackageUpdate(deps);
    expect(result.action).toBe("deferred");
    expect(deps.install).not.toHaveBeenCalled();
  });

  it("refuses to run concurrently — a held lock aborts before any npm work", () => {
    const deps = { ...base(), acquireLock: vi.fn(() => null) };
    const result = runPackageUpdate(deps);
    expect(result.action).toBe("locked");
    expect(deps.fetchLatest).not.toHaveBeenCalled();
    expect(deps.install).not.toHaveBeenCalled();
  });

  it("releases the lock on every path, including install failure", () => {
    const release = vi.fn();
    const deps = {
      ...base(),
      acquireLock: vi.fn(() => release),
      install: vi.fn(() => { throw new Error("npm exploded"); }),
    };
    expect(runPackageUpdate(deps).action).toBe("failed");
    expect(release).toHaveBeenCalledOnce();

    const release2 = vi.fn();
    runPackageUpdate({ ...base(), acquireLock: vi.fn(() => release2) });
    expect(release2).toHaveBeenCalledOnce();
  });

  it("rejects a non-semver registry answer", () => {
    const deps = { ...base(), fetchLatest: vi.fn(() => "banana") };
    expect(runPackageUpdate(deps).action).toBe("failed");
    expect(deps.install).not.toHaveBeenCalled();
  });

  it("never downgrades a dev build", () => {
    const deps = { ...base(), currentVersion: "20.12.0-local.3" };
    expect(runPackageUpdate(deps).action).toBe("skipped");
    expect(deps.install).not.toHaveBeenCalled();
  });

  it("respects PRISM_NO_SELF_UPDATE=1", () => {
    const deps = { ...base(), env: { PRISM_NO_SELF_UPDATE: "1" } as NodeJS.ProcessEnv };
    expect(runPackageUpdate(deps).action).toBe("skipped");
  });
});

describe("buildAutoupdatePlist", () => {
  it("schedules `prism update --if-idle` — never connect, never host config", () => {
    const plist = buildAutoupdatePlist("/usr/local/bin/prism", "/usr/local/bin:/usr/bin:/bin");
    expect(plist).toContain(AUTOUPDATE_LABEL);
    expect(plist).toContain("<string>/usr/local/bin/prism</string>");
    expect(plist).toContain("<string>update</string>");
    expect(plist).toContain("<string>--if-idle</string>");
    expect(plist).not.toContain("connect");
    expect(plist).toContain("StartCalendarInterval");
  });

  // Measured 2026-08-14, simulating launchd's environment:
  //   env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin prism update --if-idle
  //   -> env: node: No such file or directory
  // launchd gives an agent a minimal PATH that excludes /usr/local/bin, where
  // node and npm live on a standard macOS install. Without an explicit PATH
  // the scheduled updater could never start, and would have failed silently
  // into a log file nobody reads. The plist must carry a PATH that contains
  // the interpreter running this code.
  it("carries a PATH that includes the running node's directory", () => {
    const plist = buildAutoupdatePlist("/usr/local/bin/prism", "/opt/homebrew/bin:/usr/bin:/bin");
    expect(plist).toContain("EnvironmentVariables");
    const pathValue = plist.split("<key>PATH</key>")[1]?.split("</string>")[0] ?? "";
    expect(pathValue).toContain("/opt/homebrew/bin");
  });

  it("escapes XML metacharacters so a path with & or < cannot corrupt the plist", () => {
    const plist = buildAutoupdatePlist("/opt/a&b/prism", "/opt/a&b:/usr/bin");
    expect(plist).not.toMatch(/[^&]&[^ag]/);   // no bare ampersands
    expect(plist).toContain("&amp;");
  });
});

describe("resolvePrismBin — which CLI the scheduler runs", () => {
  it("prefers the npm global bin over whatever PATH resolves", () => {
    const warnings: string[] = [];
    const bin = resolvePrismBin((l) => warnings.push(l), {
      npmPrefix: () => "/Users/dev/.npm-global\n",
      whichPrism: () => "/Users/dev/bin/prism\n",
      exists: () => true,
    });
    // join() is platform-native: the Windows runner produces backslashes.
    expect(bin).toBe(join("/Users/dev/.npm-global", "bin", "prism"));
    expect(warnings).toEqual([]);
  });

  it("does NOT call a PATH shim a source checkout (the 20.12.0 false positive)", () => {
    // Live shape: /Users/dev/bin/prism is a two-line bash script that execs the
    // real bin. readlink -f on a regular file returns the file itself, and the
    // first version of this code read "not under node_modules" as "checkout".
    const warnings: string[] = [];
    const bin = resolvePrismBin((l) => warnings.push(l), {
      npmPrefix: () => "",
      whichPrism: () => "/Users/dev/bin/prism\n",
      readlink: () => "/Users/dev/bin/prism\n",
      exists: () => false,
    });
    expect(bin).toBe("/Users/dev/bin/prism");
    expect(warnings).toEqual([]);
  });

  it("still warns for a genuine source checkout", () => {
    const warnings: string[] = [];
    resolvePrismBin((l) => warnings.push(l), {
      npmPrefix: () => "",
      whichPrism: () => "/Users/dev/prism/dist/cli.js\n",
      readlink: () => "/Users/dev/prism/dist/cli.js\n",
      exists: () => false,
    });
    expect(warnings.join(" ")).toMatch(/source checkout/);
  });
});

describe("schedulerPath", () => {
  it("leads with the running interpreter's directory and keeps launchd's defaults", () => {
    const path = schedulerPath("/usr/local/bin/node");
    expect(path.startsWith("/usr/local/bin:")).toBe(true);
    expect(path).toContain("/usr/bin");
    expect(path.split(":").filter((d) => d === "/usr/local/bin")).toHaveLength(1); // no duplicate
  });

  it("covers a Homebrew-ARM node too", () => {
    expect(schedulerPath("/opt/homebrew/bin/node").startsWith("/opt/homebrew/bin:")).toBe(true);
  });

  it("never derives a garbage directory from a slashless interpreter path", () => {
    // Review catch: lastIndexOf("/") === -1 made slice(0, -1) chop the last
    // character, so a bare "node" yielded the directory "nod" — a truthy value
    // that skipped the fallback and put a nonexistent dir at the FRONT of the
    // scheduler PATH. Unreachable with a real process.execPath, which is
    // absolute; a PATH built from a lie is still a PATH that can misresolve.
    expect(schedulerPath("node").split(":")[0]).toBe("/usr/local/bin");
    expect(schedulerPath("").split(":")[0]).toBe("/usr/local/bin");
  });
});

describe("autoupdateStatus — a plist that cannot run must not report a clean 'enabled'", () => {
  it("flags a 20.12.0-era PATH-less plist as needing repair", async () => {
    const { autoupdateStatus } = await import("../src/autoUpdate.js");
    const fakeHome = mkdtempSync(join(tmpdir(), "prism-agent-"));
    mkdirSync(join(fakeHome, "Library", "LaunchAgents"), { recursive: true });
    const prev = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const { autoupdatePlistPath } = await import("../src/autoUpdate.js");
      // Only meaningful on darwin; elsewhere status reports unsupported.
      if (process.platform !== "darwin") return;
      writeFileSync(autoupdatePlistPath(), "<plist><dict><key>Label</key></dict></plist>");
      const status = autoupdateStatus();
      expect(status.enabled).toBe(true);
      expect(status.detail).toMatch(/may not run/);
      expect(status.detail).toMatch(/repair/);
      // Never assert a failure we have not measured on this machine.
      expect(status.detail).not.toMatch(/CANNOT RUN/);
    } finally {
      if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
    }
  });
});

describe("runPackageUpdate compares the INSTALLED package, not the running CLI", () => {
  // Measured 2026-08-14 on a real machine: the checkout CLI (20.12.0) reported
  // "20.12.0 is current" while the globally installed package — the only thing
  // this command updates — sat at 20.11.1 with 20.12.0 on npm. A command that
  // reports "current" while the artifact it manages is stale is the same class
  // of failure this whole feature exists to end.
  const base = () => ({
    currentVersion: "20.12.0",          // the CLI you happen to be running
    installedVersion: () => "20.11.1",  // what is actually installed globally
    fetchLatest: vi.fn(() => "20.12.0"),
    install: vi.fn(),
    acquireLock: vi.fn(() => () => {}),
    env: {} as NodeJS.ProcessEnv,
  });

  it("updates when the INSTALLED package is behind, even if the running CLI is current", () => {
    const deps = base();
    const result = runPackageUpdate(deps);
    expect(result.action).toBe("updated");
    expect(deps.install).toHaveBeenCalledWith("20.12.0");
  });

  it("falls back to the running version when the installed one cannot be read", () => {
    const deps = { ...base(), installedVersion: () => { throw new Error("not installed"); } };
    expect(runPackageUpdate(deps).action).toBe("current");
  });

  it("applies the dev-build guard to the INSTALLED version", () => {
    const deps = { ...base(), installedVersion: () => "20.13.0-local.2" };
    expect(runPackageUpdate(deps).action).toBe("skipped");
    expect(deps.install).not.toHaveBeenCalled();
  });
});
