/**
 * `prism update` / `prism autoupdate` — unattended-safe package updates.
 *
 * Why this is NOT `prism connect` on a timer (design review 2026-08-14):
 * connect writes host configuration and expects hosts to be closed — a
 * condition no scheduler can guarantee. This module's whole authority is
 * `npm install -g prism-mcp-server@<latest>`:
 *   - host configuration, hooks, and hook trust are untouchable from here —
 *     there is no code path to them;
 *   - running server processes keep the code they booted with; the next
 *     process start picks up the new release (global registrations resolve
 *     through the bin symlink);
 *   - `--if-idle` defers entirely while any Prism MCP server process is
 *     alive, and an UNVERIFIABLE process list counts as busy — fail safe;
 *   - a single-instance lock prevents overlapping npm runs (a scheduler
 *     firing while an operator updates by hand).
 *
 * Configuration migrations stay behind a visible `prism connect` run.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isNewer } from "./selfUpdate.js";

const PACKAGE = "prism-mcp-server";
const SEMVER = /^\d+\.\d+\.\d+$/;
export const AUTOUPDATE_LABEL = "com.synalux.prism.autoupdate";

export interface PackageUpdateDeps {
  /** Version of the CLI process making the request. Used only as a fallback. */
  currentVersion: string;
  /** Version of the globally INSTALLED package — the artifact this command
   *  actually updates. Measured 2026-08-14: comparing the running CLI instead
   *  let `prism update` report "current" from a 20.12.0 checkout while the
   *  installed package sat at 20.11.1 and never moved. */
  installedVersion?: () => string;
  /** Fetch the latest published version; throws on network failure. */
  fetchLatest?: () => string;
  /** Run the global install; throws on failure. */
  install?: (version: string) => void;
  /** Describe running Prism MCP server processes; throws when undeterminable. */
  listPrismProcesses?: () => string[];
  /** Take the single-instance lock; null when another update holds it. */
  acquireLock?: () => (() => void) | null;
  ifIdle?: boolean;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface PackageUpdateResult {
  action: "updated" | "current" | "deferred" | "locked" | "failed" | "skipped";
  detail: string;
  latest?: string;
}

function defaultFetchLatest(): string {
  return execFileSync("npm", ["view", PACKAGE, "version"], {
    encoding: "utf8",
    timeout: 15_000,
  }).trim();
}

/** Read the version of the globally installed package. npm puts it under
 *  <prefix>/lib/node_modules on POSIX and <prefix>/node_modules on Windows. */
function defaultInstalledVersion(): string {
  const prefix = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8", timeout: 15_000 }).trim();
  for (const candidate of [
    join(prefix, "lib", "node_modules", PACKAGE, "package.json"),
    join(prefix, "node_modules", PACKAGE, "package.json"),
  ]) {
    if (existsSync(candidate)) {
      const version = JSON.parse(readFileSync(candidate, "utf8"))?.version;
      if (typeof version === "string" && version.trim()) return version.trim();
    }
  }
  return "";
}

function defaultInstall(version: string): void {
  execFileSync("npm", ["install", "-g", `${PACKAGE}@${version}`], {
    stdio: "inherit",
    timeout: 300_000,
  });
}

/** Lines for live Prism MCP server processes. Throws when `ps` is unusable —
 *  the caller treats that as busy, never as idle. */
export function defaultListPrismProcesses(): string[] {
  const out = execFileSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return out
    .split("\n")
    .filter((line) => /server\.js/.test(line) && /prism/i.test(line))
    .map((line) => line.trim());
}

const LOCK_DIR = () => join(homedir(), ".prism-mcp");
const LOCK_FILE = () => join(LOCK_DIR(), "update.lock");

/** O_EXCL lockfile with stale-holder recovery (dead pid → reclaim once). */
export function defaultAcquireLock(): (() => void) | null {
  mkdirSync(LOCK_DIR(), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_FILE(), "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => { try { rmSync(LOCK_FILE(), { force: true }); } catch { /* released is released */ } };
    } catch {
      try {
        const holder = parseInt(readFileSync(LOCK_FILE(), "utf8").trim(), 10);
        if (Number.isInteger(holder)) {
          try {
            process.kill(holder, 0); // alive → genuinely locked
            return null;
          } catch {
            rmSync(LOCK_FILE(), { force: true }); // stale → reclaim and retry
            continue;
          }
        }
        rmSync(LOCK_FILE(), { force: true }); // unreadable holder → reclaim
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function runPackageUpdate(deps: PackageUpdateDeps): PackageUpdateResult {
  const env = deps.env ?? process.env;
  const log = deps.log ?? (() => {});

  if (env.PRISM_NO_SELF_UPDATE === "1") {
    return { action: "skipped", detail: "PRISM_NO_SELF_UPDATE=1" };
  }
  if ((env.VITEST || env.NODE_ENV === "test") && !deps.fetchLatest) {
    return { action: "skipped", detail: "test environment" };
  }
  if (deps.ifIdle) {
    let running: string[];
    try {
      running = (deps.listPrismProcesses ?? defaultListPrismProcesses)();
    } catch (error) {
      return {
        action: "deferred",
        detail: `cannot verify idleness (${error instanceof Error ? error.message.split("\n")[0] : String(error)}) — deferring`,
      };
    }
    if (running.length > 0) {
      return {
        action: "deferred",
        detail: `${running.length} Prism MCP process(es) running — deferred until idle`,
      };
    }
  }

  // The version that matters is the INSTALLED one; the running CLI may be a
  // checkout, a shim, or an older global. Probing shells out to npm, so tests
  // reach it only through an injected dep.
  let targetVersion = deps.currentVersion;
  // Test detection must read the REAL process env: suites pass env: {} to
  // exercise the policy guards, and that would otherwise let this probe shell
  // out to npm from inside the test run (caught by a 57ms test that suddenly
  // consulted the machine's actual install).
  const inTest = Boolean(
    env.VITEST || env.NODE_ENV === "test" ||
    process.env.VITEST || process.env.NODE_ENV === "test",
  );
  const mayProbe = Boolean(deps.installedVersion) || !inTest;
  if (mayProbe) {
    try {
      const installed = (deps.installedVersion ?? defaultInstalledVersion)().trim();
      if (installed) targetVersion = installed;
    } catch { /* not installed / npm unavailable — compare the running version */ }
  }
  if (targetVersion.includes("-")) {
    return { action: "skipped", detail: `dev build ${targetVersion} — not touching it` };
  }

  const release = (deps.acquireLock ?? defaultAcquireLock)();
  if (!release) {
    return { action: "locked", detail: "another prism update is already running" };
  }
  try {
    let latest: string;
    try {
      latest = (deps.fetchLatest ?? defaultFetchLatest)();
    } catch (error) {
      return { action: "failed", detail: `registry unreachable (${error instanceof Error ? error.message.split("\n")[0] : String(error)})` };
    }
    if (!SEMVER.test(latest)) {
      return { action: "failed", detail: `registry returned unexpected version "${latest}"` };
    }
    if (!isNewer(targetVersion, latest)) {
      return { action: "current", detail: `installed package ${targetVersion} is current`, latest };
    }
    log(`prism ${targetVersion} → ${latest}: updating the global package …`);
    try {
      (deps.install ?? defaultInstall)(latest);
    } catch (error) {
      return { action: "failed", detail: `npm install -g failed (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`, latest };
    }
    return { action: "updated", detail: `global package now ${latest}; running servers pick it up on their next start`, latest };
  } finally {
    release();
  }
}

// ─── LaunchAgent (macOS) scheduling ──────────────────────────────

export function autoupdatePlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${AUTOUPDATE_LABEL}.plist`);
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** The PATH a scheduled run needs. launchd hands an agent a minimal
 *  PATH (/usr/bin:/bin:/usr/sbin:/sbin) that excludes /usr/local/bin and
 *  /opt/homebrew/bin — where node and npm live on a standard macOS install.
 *  Measured 2026-08-14: without this the agent died at `env: node: No such
 *  file or directory` before running a single line of Prism. The directory
 *  of the interpreter running this code leads, because that is provably the
 *  node the operator uses. */
export function schedulerPath(execPath: string = process.execPath): string {
  const lastSlash = execPath.lastIndexOf("/");
  const nodeDir = lastSlash > 0 ? execPath.slice(0, lastSlash) : "/usr/local/bin";
  const defaults = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [nodeDir, ...defaults.filter((dir) => dir !== nodeDir)].join(":");
}

/** Daily 03:30 local, catch-up on wake (LaunchAgents coalesce missed runs). */
export function buildAutoupdatePlist(prismBin: string, pathEnv: string = schedulerPath()): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AUTOUPDATE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(prismBin)}</string>
    <string>update</string>
    <string>--if-idle</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(pathEnv)}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>StandardOutPath</key><string>/tmp/${AUTOUPDATE_LABEL}.log</string>
  <key>StandardErrorPath</key><string>/tmp/${AUTOUPDATE_LABEL}.log</string>
</dict>
</plist>
`;
}

export interface AutoupdateStatus {
  supported: boolean;
  enabled: boolean;
  plistPath: string;
  detail: string;
}

export function autoupdateStatus(): AutoupdateStatus {
  const plistPath = autoupdatePlistPath();
  if (process.platform !== "darwin") {
    return { supported: false, enabled: false, plistPath, detail: "scheduled updates are macOS-only for now (LaunchAgent)" };
  }
  const enabled = existsSync(plistPath);
  if (!enabled) {
    return { supported: true, enabled, plistPath, detail: "disabled" };
  }
  // 20.12.0 wrote a plist with no PATH. launchd hands an agent
  // /usr/bin:/bin:/usr/sbin:/sbin, which excludes the directories holding node
  // and npm on a standard macOS install, so that generation could never run —
  // and it failed into a log file nobody reads. Say so instead of reporting a
  // confident "enabled".
  let healthy = false;
  try {
    healthy = readFileSync(plistPath, "utf8").includes("<key>PATH</key>");
  } catch { /* unreadable — treat as needing repair */ }
  return {
    supported: true,
    enabled,
    plistPath,
    detail: healthy
      ? `enabled — daily 03:30, log: /tmp/${AUTOUPDATE_LABEL}.log`
      // Deliberately "may not run", not "cannot": launchd's default PATH does
      // contain /usr/bin, so an operator whose node lives there is fine. On a
      // standard install (Homebrew, /usr/local) it never runs. Claiming a
      // certain failure we have not measured on THIS machine would be the same
      // overclaim in the other direction.
      : "enabled, but this agent predates the PATH fix and may not run (launchd's default PATH omits /usr/local/bin and /opt/homebrew/bin) — re-run `prism autoupdate enable` to repair",
  };
}

/** Resolve the `prism` the scheduler should run.
 *
 *  Prefers the npm global bin over `which prism`: the scheduled job must run
 *  the INSTALLED CLI deterministically, and an interactive PATH can front it
 *  with a wrapper. On the machine this was written for, `which prism` returns
 *  a hand-written bash shim that execs the real bin — harmless, but resolving
 *  it with readlink returns the shim itself, which an earlier version of this
 *  code then mislabeled "a source checkout". Only a path that positively
 *  looks like a repo checkout (a dist/ sibling of a package.json, outside
 *  node_modules) earns the warning now, and it is a warning, never a refusal. */
export interface BinResolutionDeps {
  npmPrefix?: () => string;
  whichPrism?: () => string;
  readlink?: (path: string) => string;
  exists?: (path: string) => boolean;
}

export function resolvePrismBin(log: (line: string) => void, deps: BinResolutionDeps = {}): string {
  const exists = deps.exists ?? existsSync;
  let globalBin: string | undefined;
  try {
    const prefix = (deps.npmPrefix ?? (() =>
      execFileSync("npm", ["prefix", "-g"], { encoding: "utf8", timeout: 15_000 })))().trim();
    if (prefix) {
      const candidate = join(prefix, "bin", "prism");
      if (exists(candidate)) globalBin = candidate;
    }
  } catch { /* npm unavailable — fall back to PATH lookup */ }
  if (globalBin) return globalBin;

  let bin = "";
  try {
    bin = (deps.whichPrism ?? (() =>
      execFileSync("which", ["prism"], { encoding: "utf8", timeout: 5_000 })))().trim();
  } catch { /* not on PATH */ }
  if (!bin) throw new Error("`prism` not found — install it with: npm install -g prism-mcp-server");
  let real = bin;
  try {
    real = (deps.readlink ?? ((p: string) =>
      execFileSync("readlink", ["-f", p], { encoding: "utf8", timeout: 5_000 })))(bin).trim() || bin;
  } catch { /* keep bin */ }
  if (!real.includes("node_modules") && /\/dist\/[^/]+$/.test(real)) {
    log(`⚠ ${bin} resolves to a source checkout (${real}); the scheduled job will run that CLI — it still updates only the global package`);
  }
  return bin;
}

export function enableAutoupdate(log: (line: string) => void): AutoupdateStatus {
  if (process.platform !== "darwin") return autoupdateStatus();
  const plistPath = autoupdatePlistPath();
  const bin = resolvePrismBin(log);
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath, buildAutoupdatePlist(bin));
  // Reload cleanly whether or not a previous generation was loaded.
  try { execFileSync("launchctl", ["unload", plistPath], { timeout: 10_000, stdio: "ignore" }); } catch { /* not loaded */ }
  execFileSync("launchctl", ["load", "-w", plistPath], { timeout: 10_000 });
  return autoupdateStatus();
}

export function disableAutoupdate(): AutoupdateStatus {
  if (process.platform !== "darwin") return autoupdateStatus();
  const plistPath = autoupdatePlistPath();
  try { execFileSync("launchctl", ["unload", plistPath], { timeout: 10_000, stdio: "ignore" }); } catch { /* not loaded */ }
  rmSync(plistPath, { force: true });
  return autoupdateStatus();
}
