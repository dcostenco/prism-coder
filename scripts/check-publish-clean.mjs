#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every version the MCP Registry serves for this server, so a publish cannot
 * ship a listing that disagrees with the npm tarball.
 *
 * Why this guard exists (2026-08-05): the registry advertised 1.5.0 and
 * server.json carried 2.3.4 while npm latest was 20.6.0. Nothing tied the two
 * files together, so the public discovery surface — the default place Claude
 * and Codex users look for servers — silently drifted ~19 majors behind the
 * shipping build. The failure was invisible because npm publish succeeded
 * every time; only the storefront was stale.
 */
export function serverManifestVersionMismatches(packageJson, serverJson) {
  const expected = packageJson.version;
  const problems = [];
  if (serverJson.version !== expected) {
    problems.push(`server.json version is ${serverJson.version}, expected ${expected}`);
  }
  for (const [index, pkg] of (serverJson.packages ?? []).entries()) {
    if (pkg.identifier === packageJson.name && pkg.version !== expected) {
      problems.push(`server.json packages[${index}].version is ${pkg.version}, expected ${expected}`);
    }
  }
  return problems;
}

/**
 * Every OTHER manifest that carries a version and is published to a
 * storefront. The Codex plugin manifest sat at 20.6.0 through the 20.7.0
 * release and was caught only by reading it before a marketplace submission
 * — server.json was guarded, this was not. Any file listed here is held to
 * the same rule: if it declares a version, it must be package.json's.
 */
const VERSIONED_MANIFESTS = ["plugins/prism/.codex-plugin/plugin.json"];

function checkVersionedManifests(repoRoot, expected) {
  const problems = [];
  for (const relative of VERSIONED_MANIFESTS) {
    let raw;
    try {
      raw = readFileSync(join(repoRoot, relative), "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") continue; // not this repo's concern
      throw error;
    }
    const manifest = JSON.parse(raw);
    if (manifest.version !== undefined && manifest.version !== expected) {
      problems.push(`${relative} version is ${manifest.version}, expected ${expected}`);
    }
  }
  return problems;
}

function checkManifestVersions(repoRoot) {
  // A repo without a registry manifest has nothing to drift: repos that never
  // published to the MCP Registry (and the guard's own test fixtures) must
  // pass untouched. Only an EXISTING manifest is held to the sync contract —
  // a present-but-corrupt server.json still fails loudly via the caller.
  let rawServer;
  let rawPackage;
  try {
    rawServer = readFileSync(join(repoRoot, "server.json"), "utf8");
    rawPackage = readFileSync(join(repoRoot, "package.json"), "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  const packageJson = JSON.parse(rawPackage);
  return [
    ...serverManifestVersionMismatches(packageJson, JSON.parse(rawServer)),
    ...checkVersionedManifests(repoRoot, packageJson.version),
  ];
}

/**
 * Refuse a version that npm already serves.
 *
 * Why (2026-08-05): the manifest guard above proves server.json and
 * package.json AGREE — it says nothing about whether the version ADVANCED.
 * So `main` accumulated a session's worth of shipped work while both files
 * sat at 20.6.0, agreeing with each other and with npm, and disagreeing with
 * reality. The publish ran the full build and pack before npm rejected it
 * with "You cannot publish over the previously published versions".
 *
 * Fails OPEN on network trouble or an unpublished package: a first release
 * and an offline release must both still work. Only a definite match blocks.
 */
export function publishedVersionConflict(name, version, lookup) {
  let published;
  try {
    published = lookup(name);
  } catch {
    return null; // never published, offline, or registry unreachable
  }
  if (!published || published !== version) return null;
  return `${name}@${version} is already published. Bump the version in ` +
    `package.json, server.json (incl. packages[].version), and every entry in ` +
    `VERSIONED_MANIFESTS — naming only some of them is how the Codex plugin ` +
    `manifest drifted a full release behind.`;
}

function npmLatestVersion(name) {
  // Test seam. Without it this check's own tests assert against the LIVE
  // registry, so they encode whatever is published at the moment they were
  // written — and publishing 20.7.0 immediately falsified a test that had
  // hard-coded 20.6.0 as "already published". A guard whose tests break every
  // time you release is worse than no tests.
  const override = process.env.PRISM_GUARD_PUBLISHED_VERSION;
  if (override !== undefined) {
    if (override === "") throw new Error("simulated: package not published");
    return override;
  }
  return execFileSync("npm", ["view", name, "version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15_000,
  }).trim();
}

function workingTreeStatus(repoRoot) {
  return execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

// Only gate when run as the prepublishOnly script. Importing this module —
// which the regression test does — must stay side-effect free, or the checks
// below would run against the test's cwd and set a failing exit code.
const IS_MAIN = process.argv[1]
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  try {
    const status = workingTreeStatus(process.cwd());
    if (status) {
      console.error(
        "npm publish blocked: the Prism working tree is not clean.\n" +
          "Commit, move, or restore every change before publishing:\n" +
          status,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`npm publish blocked: unable to verify Git state: ${message}`);
    process.exitCode = 1;
  }

  try {
    const problems = checkManifestVersions(process.cwd());
    if (problems.length) {
      console.error(
        "npm publish blocked: a versioned manifest disagrees with package.json.\n" +
          "The MCP Registry listing would ship stale versions:\n  " +
          problems.join("\n  "),
      );
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`npm publish blocked: unable to verify the versioned manifests: ${message}`);
    process.exitCode = 1;
  }

  // --manifest-only: verify the manifests agree, but SKIP the
  // already-published check. The registry publish workflow runs AFTER npm
  // publish, so "this version is on npm" is its correct precondition, not an
  // error — without this flag the guard blocks the very republish it exists
  // to protect (it did, on 20.7.0). npm publish itself passes no flag and
  // still gets the full gate.
  const manifestOnly = process.argv.includes("--manifest-only");

  if (manifestOnly) {
    console.log("manifest-only mode: skipping the published-version check.");
  } else try {
    let raw;
    try {
      raw = readFileSync(join(process.cwd(), "package.json"), "utf8");
    } catch (error) {
      // No package.json means nothing to publish (and is the shape of this
      // guard's own fixtures). Stay silent — a stderr warning here would make
      // the reproducibility test, which asserts empty stderr, fail.
      if (error && error.code === "ENOENT") raw = null;
      else throw error;
    }
    if (raw) {
      const pkg = JSON.parse(raw);
      const conflict = publishedVersionConflict(pkg.name, pkg.version, npmLatestVersion);
      if (conflict) {
        console.error(`npm publish blocked: ${conflict}`);
        process.exitCode = 1;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`npm publish: skipped the published-version check (${message})`);
  }
}
