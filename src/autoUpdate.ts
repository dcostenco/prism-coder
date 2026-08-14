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
  currentVersion: string;
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
  if (deps.currentVersion.includes("-")) {
    return { action: "skipped", detail: `dev build ${deps.currentVersion} — not touching it` };
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
    if (!isNewer(deps.currentVersion, latest)) {
      return { action: "current", detail: `${deps.currentVersion} is current`, latest };
    }
    log(`prism ${deps.currentVersion} → ${latest}: updating the global package …`);
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

/** Daily 03:30 local, catch-up on wake (LaunchAgents coalesce missed runs). */
export function buildAutoupdatePlist(prismBin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AUTOUPDATE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${prismBin}</string>
    <string>update</string>
    <string>--if-idle</string>
  </array>
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
  return {
    supported: true,
    enabled,
    plistPath,
    detail: enabled ? `enabled — daily 03:30, log: /tmp/${AUTOUPDATE_LABEL}.log` : "disabled",
  };
}

/** Resolve the `prism` bin the LaunchAgent should run. Warns (does not
 *  refuse) when it resolves outside node_modules — a checkout CLI still
 *  updates the global package, but the operator should know which code
 *  their scheduler runs. */
export function resolvePrismBin(log: (line: string) => void): string {
  const bin = execFileSync("which", ["prism"], { encoding: "utf8", timeout: 5_000 }).trim();
  if (!bin) throw new Error("`prism` not found on PATH — install with: npm install -g prism-mcp-server");
  try {
    const real = execFileSync("readlink", ["-f", bin], { encoding: "utf8", timeout: 5_000 }).trim();
    if (real && !real.includes("node_modules")) {
      log(`⚠ ${bin} resolves to a source checkout (${real}); the scheduled update will run that CLI (it still updates only the global package)`);
    }
  } catch { /* readlink unavailable — proceed with the raw path */ }
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
