/**
 * Update-available notice — the trigger half of self-update.
 *
 * `prism connect` can converge a machine to the latest release, but nothing
 * ever *ran* it: no launch agent, cron, or background updater exists, so
 * releases only reached machines whose operator happened to re-run connect.
 * The notice closes that gap at the only place every user reliably looks —
 * the first turn of a session.
 *
 * Split enforced by design review (2026-08-14):
 *  - `getUpdateNotice` is CACHE-ONLY. It runs on the prompt-critical path
 *    (session_bootstrap) and must never touch the npm registry.
 *  - `refreshUpdateCache` is the async half. Server startup kicks it
 *    fire-and-forget after initialization; it respects a 24-hour TTL so a
 *    machine pings the registry at most once a day no matter how many
 *    short-lived server processes spawn (codex exec starts one per run).
 *  - Offline is silent. A registry answer that is not plain semver is
 *    discarded, never cached, never rendered — the cached value ends up
 *    inside model-facing markdown, so it is validated on write AND on read.
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { isNewer } from "./selfUpdate.js";

export const UPDATE_CHECK_KEY = "update_check";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SEMVER = /^\d+\.\d+\.\d+$/;
const PACKAGE = "prism-mcp-server";

interface CacheShape {
  checked_at?: number;
  latest?: string;
}

async function readCache(
  getSetting: (key: string, fallback: string) => Promise<string>,
): Promise<CacheShape> {
  try {
    const parsed = JSON.parse(await getSetting(UPDATE_CHECK_KEY, "{}"));
    return typeof parsed === "object" && parsed !== null ? parsed as CacheShape : {};
  } catch {
    return {};
  }
}

function cacheIsFresh(cache: CacheShape, now: () => number): boolean {
  return typeof cache.checked_at === "number" &&
    now() - cache.checked_at < CACHE_TTL_MS &&
    now() - cache.checked_at >= 0; // a future timestamp is corruption, not freshness
}

export interface UpdateNoticeDeps {
  currentVersion: string;
  getSetting: (key: string, fallback: string) => Promise<string>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** Path this server is executing from (process.argv[1]); a path outside
   *  node_modules is a source checkout, where plain `prism connect` leaves
   *  the registration untouched and the right command is `--refresh`. */
  runningFrom?: string;
}

/** Cache-only: renders the notice line, or "" — never touches the network. */
export async function getUpdateNotice(deps: UpdateNoticeDeps): Promise<string> {
  const env = deps.env ?? process.env;
  if (env.PRISM_NO_UPDATE_CHECK === "1") return "";
  // A caller that could not determine its own version renders nothing —
  // a comparison against "" or "0.0.0" would call every release an update.
  if (!SEMVER.test(deps.currentVersion)) return "";
  const now = deps.now ?? Date.now;
  const cache = await readCache(deps.getSetting);
  if (!cacheIsFresh(cache, now)) return "";
  const latest = typeof cache.latest === "string" && SEMVER.test(cache.latest) ? cache.latest : "";
  if (!latest || !isNewer(deps.currentVersion, latest)) return "";

  let fromCheckout = false;
  if (deps.runningFrom) {
    let resolved = deps.runningFrom;
    try { resolved = realpathSync(deps.runningFrom); } catch { /* keep raw */ }
    fromCheckout = !resolved.includes("node_modules");
  }
  const command = fromCheckout ? "prism connect --refresh" : "prism connect";
  return `- ⬆️ **Update available:** Prism ${latest} (running ${deps.currentVersion}) — run \`${command}\``;
}

export interface RefreshDeps {
  getSetting: (key: string, fallback: string) => Promise<string>;
  setSetting: (key: string, value: string) => Promise<void>;
  fetchLatest?: () => Promise<string>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

function defaultFetchLatest(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "npm", ["view", PACKAGE, "version"],
      { encoding: "utf8", timeout: 10_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
    // A short-lived server process (codex exec) must be able to exit without
    // waiting on this check.
    child.unref?.();
  });
}

/** Async half: refresh the persisted cache when the TTL has lapsed.
 *  Never throws — offline machines boot silently. */
export async function refreshUpdateCache(deps: RefreshDeps): Promise<void> {
  const env = deps.env ?? process.env;
  if (env.PRISM_NO_UPDATE_CHECK === "1") return;
  if (env.VITEST || env.NODE_ENV === "test") {
    // Test runners never reach the network — same rule as self-update —
    // EXCEPT through an explicitly injected fetcher, which is the test.
    if (!deps.fetchLatest) return;
  }
  const now = deps.now ?? Date.now;
  try {
    const cache = await readCache(deps.getSetting);
    if (cacheIsFresh(cache, now)) return;
    const latest = (await (deps.fetchLatest ?? defaultFetchLatest)()).trim();
    if (!SEMVER.test(latest)) return;
    await deps.setSetting(UPDATE_CHECK_KEY, JSON.stringify({ checked_at: now(), latest }));
  } catch {
    // Offline, registry down, npm missing: silence. The notice simply
    // does not render until a later successful check.
  }
}
