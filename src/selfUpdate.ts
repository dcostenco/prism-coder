/**
 * Self-update for `prism connect` — the converge command.
 *
 * The operator's model, which this implements: connect re-checks EVERYTHING —
 * package version, host configs, hooks, skills — and applies what's needed.
 * Before this, `npm i -g` and `prism connect` were two separate steps, and a
 * machine that ran only the second stayed on old code with fresh config: the
 * "hook exists but the CLI behind it is stale" state observed live on
 * 2026-08-13, where a rebuilt hook called a pre-fix global CLI and quietly
 * injected two skills instead of three.
 *
 * After a successful update, the caller RE-EXECS the new binary so the rest
 * of connect runs with the code it just installed — reconciliation logic from
 * the new version, not the old one.
 *
 * What this deliberately does NOT do: touch Codex hook trust. Convergence
 * covers everything software may legitimately converge; approving our own
 * execution is not in that set.
 */
import { execFileSync } from "node:child_process";

export interface SelfUpdateDeps {
  /** Currently running version (package.json). */
  currentVersion: string;
  /** Fetch the latest published version; throws on network failure. */
  fetchLatest?: () => string;
  /** Run the global install; throws on failure. */
  install?: (version: string) => void;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface SelfUpdateResult {
  action: "updated" | "current" | "skipped" | "failed";
  detail: string;
  latest?: string;
}

const PACKAGE = "prism-mcp-server";

function defaultFetchLatest(): string {
  return execFileSync("npm", ["view", PACKAGE, "version"], {
    encoding: "utf8",
    timeout: 15_000,
  }).trim();
}

function defaultInstall(version: string): void {
  // Inherits the operator's npm prefix (.npmrc / NPM_CONFIG_PREFIX), so the
  // update lands where their `prism` actually resolves from.
  execFileSync("npm", ["install", "-g", `${PACKAGE}@${version}`], {
    stdio: "inherit",
    timeout: 300_000,
  });
}

/** Plain numeric semver compare; returns true when b is newer than a. */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}

export function maybeSelfUpdate(deps: SelfUpdateDeps): SelfUpdateResult {
  const env = deps.env ?? process.env;
  const log = deps.log ?? (() => {});
  const fetchLatest = deps.fetchLatest ?? defaultFetchLatest;
  const install = deps.install ?? defaultInstall;

  if (env.PRISM_NO_SELF_UPDATE === "1") {
    return { action: "skipped", detail: "PRISM_NO_SELF_UPDATE=1" };
  }
  // Test runners must never reach the network or npm -g.
  if (env.VITEST || env.NODE_ENV === "test") {
    return { action: "skipped", detail: "test environment" };
  }
  // A -local.N or any prerelease build is a developer's hand-installed
  // artifact; "updating" it to the registry release would be a DOWNGRADE of
  // intent. Converging dev builds is the developer's call, not ours.
  if (deps.currentVersion.includes("-")) {
    return { action: "skipped", detail: `dev build ${deps.currentVersion} — not touching it` };
  }

  let latest: string;
  try {
    latest = fetchLatest();
  } catch (error) {
    // Offline connect must still converge configs with the code it has.
    return { action: "failed", detail: `registry unreachable (${error instanceof Error ? error.message.split("\n")[0] : String(error)}) — continuing with ${deps.currentVersion}` };
  }
  if (!/^\d+\.\d+\.\d+$/.test(latest)) {
    return { action: "failed", detail: `registry returned unexpected version "${latest}" — continuing` };
  }
  if (!isNewer(deps.currentVersion, latest)) {
    return { action: "current", detail: `${deps.currentVersion} is current`, latest };
  }

  log(`prism ${deps.currentVersion} → ${latest}: updating before configuring …`);
  try {
    install(latest);
  } catch (error) {
    return { action: "failed", detail: `npm install -g failed (${error instanceof Error ? error.message.split("\n")[0] : String(error)}) — continuing with ${deps.currentVersion}`, latest };
  }
  return { action: "updated", detail: `now on ${latest}`, latest };
}
