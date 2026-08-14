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
import { runPackageUpdate, buildAutoupdatePlist, AUTOUPDATE_LABEL } from "../src/autoUpdate.js";

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
    const plist = buildAutoupdatePlist("/usr/local/bin/prism");
    expect(plist).toContain(AUTOUPDATE_LABEL);
    expect(plist).toContain("<string>/usr/local/bin/prism</string>");
    expect(plist).toContain("<string>update</string>");
    expect(plist).toContain("<string>--if-idle</string>");
    expect(plist).not.toContain("connect");
    expect(plist).toContain("StartCalendarInterval");
  });
});
