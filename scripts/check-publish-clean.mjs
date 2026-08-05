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

function checkServerManifest(repoRoot) {
  const read = (name) => JSON.parse(readFileSync(join(repoRoot, name), "utf8"));
  return serverManifestVersionMismatches(read("package.json"), read("server.json"));
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
    const problems = checkServerManifest(process.cwd());
    if (problems.length) {
      console.error(
        "npm publish blocked: server.json disagrees with package.json.\n" +
          "The MCP Registry listing would ship stale versions:\n  " +
          problems.join("\n  "),
      );
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`npm publish blocked: unable to verify server.json: ${message}`);
    process.exitCode = 1;
  }
}
