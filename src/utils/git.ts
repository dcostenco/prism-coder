/**
 * Git Utility — Reality Drift Detection (v2.0 — Step 5)
 *
 * Safe, graceful interaction with the local Git repo.
 * Never throws — always returns a safe default if Git isn't available
 * or the project path isn't a repo.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS:
 *   When a developer manually refactors code between agent sessions,
 *   the agent's memory becomes stale ("reality drift"). Prism solves
 *   this by auto-capturing the Git state on every handoff save and
 *   checking for drift on every context load.
 *
 * DESIGN DECISIONS:
 *   - Uses child_process.execSync (not async) — these are fast Git
 *     plumbing commands that complete in <10ms.
 *   - Uses stdio: 'pipe' to suppress stderr from non-repo directories.
 *   - getGitDrift uses --name-status (not raw diff) to protect the
 *     LLM's context window. A 10,000-line refactor shows up as just
 *     "M  src/schema.ts" — no token explosion.
 * ═══════════════════════════════════════════════════════════════════
 */

import { execSync, execFileSync } from "child_process";

export interface GitState {
  isRepo: boolean;
  branch: string | null;
  commitSha: string | null;
}

/**
 * Get the current Git branch and HEAD commit SHA.
 * Returns { isRepo: false } gracefully if not a Git repo.
 */
export function getCurrentGitState(
  projectPath: string = process.cwd()
): GitState {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: projectPath,
      stdio: "pipe",
      timeout: 5000,
    })
      .toString()
      .trim();

    const commitSha = execSync("git rev-parse HEAD", {
      cwd: projectPath,
      stdio: "pipe",
      timeout: 5000,
    })
      .toString()
      .trim();

    return { isRepo: true, branch, commitSha };
  } catch {
    // Not a repo, git not installed, or timeout
    return { isRepo: false, branch: null, commitSha: null };
  }
}

/**
 * Get the list of files changed between `oldSha` and current HEAD.
 * Returns compact --name-status format (e.g., "M  src/index.ts").
 * Returns null if the SHA is invalid (rebased, force-pushed, etc.).
 */
export function getGitDrift(
  oldSha: string,
  projectPath: string = process.cwd()
): string | null {
  // SECURITY: Validate SHA format before passing to git.
  // Without this, a corrupted DB entry like "; rm -rf /" would be
  // shell-injected via the old template string approach.
  if (!/^[0-9a-f]{4,40}$/i.test(oldSha)) {
    return null;
  }

  try {
    // Use execFileSync (no shell) to prevent injection even if
    // validation is somehow bypassed. Args are passed as array.
    const diff = execFileSync(
      "git",
      ["diff", "--name-status", oldSha, "HEAD"],
      {
        cwd: projectPath,
        stdio: "pipe",
        timeout: 10000,
      }
    )
      .toString()
      .trim();

    return diff || null;
  } catch {
    // Old SHA was rebased/deleted, or not a repo
    return null;
  }
}
