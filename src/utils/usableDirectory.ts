/**
 * Directory creation and repair that a restrictive umask cannot defeat.
 *
 * WHY THIS EXISTS (2026-08-10)
 * Skill delivery died silently for nine days. `.prism-skill-transactions` had
 * been created with `mkdir(..., { mode: 0o700 })`, but mkdir's mode is masked by
 * the process umask: a umask carrying the owner-execute bit yields drw-------,
 * a directory that can be read and written but never entered. Every subsequent
 * mkdtemp threw EACCES, materialization aborted, and — because the config DB
 * half of a sync commits before the file half — the client went on reporting the
 * new generation while every managed skill root stayed frozen at older content.
 *
 * The first fix repaired a directory that was already broken and left the cause
 * alone: a umask that is still restrictive masks every directory created after
 * it, so a repaired base simply gained a brand-new unusable child. Node exposes
 * no per-call umask, so the only portable defeat is to create one level at a
 * time and repair what we just made.
 *
 * These helpers are shared rather than duplicated because the same trap exists
 * anywhere Prism creates a private directory — skill roots, agent roots, and the
 * config DB's parent — and a guard applied at two of three sites is not a guard.
 */
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";

/** Mode every Prism-managed directory is created with and repaired to. */
export const MANAGED_DIR_MODE = 0o700;

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

/**
 * Restore owner rwx on a managed directory that exists but cannot be entered.
 *
 * Restores 0o700 EXACTLY rather than OR-ing owner bits onto whatever is there.
 * These directories hold entitled skill content and pre-rollback backups;
 * repairing 0o066 to 0o766 would "fix" an outage by leaving them world-readable.
 *
 * Prism-managed directories REQUIRE owner rwx, so a deliberate sharing mode that
 * withholds it — 0o670, say — is discarded rather than preserved. Conventional
 * sharing is unaffected: this only fires on a directory the owner cannot use,
 * which is broken by any definition. A 0o770 directory is left untouched.
 *
 * Applies the change through an open descriptor, not the pathname. A pathname
 * chmod re-resolves the path, so a process able to swap the directory for a
 * symlink between the check and the change could redirect the permission change
 * somewhere else entirely. fchmod acts on the object already opened.
 *
 * POSIX only. On Windows chmod maps to the read-only attribute alone and lstat
 * reports 0o666 for every writable directory, so the condition can never be
 * satisfied and the failure being repaired has no analogue there.
 */
export async function repairOwnerAccess(path: string, mode: number): Promise<void> {
  if (process.platform === "win32") return;
  if ((mode & MANAGED_DIR_MODE) === MANAGED_DIR_MODE) return;
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    await chmod(path, MANAGED_DIR_MODE);   // platforms that refuse to open a directory
    return;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory()) throw new Error(`managed path is not a directory: ${path}`);
    await handle.chmod(MANAGED_DIR_MODE);
  } finally {
    await handle.close();
  }
}

/**
 * Create a directory, and any missing ancestors, that the owner can enter.
 *
 * `recursive: true` applies the same masked mode to every level it creates, so
 * under a hostile umask the first new ancestor is already untraversable and the
 * call fails partway with EACCES before anything can repair it.
 *
 * Repairs ONLY directories this call creates. A pre-existing ancestor — $HOME
 * and everything above it — keeps exactly the mode the user configured; silently
 * widening those would be a worse bug than the one being fixed.
 */
export async function mkdirUsable(target: string): Promise<void> {
  if (process.platform === "win32") {
    await mkdir(target, { recursive: true, mode: MANAGED_DIR_MODE });
    return;
  }
  const segments = target.split(sep).filter(Boolean);
  let current = isAbsolute(target) ? "" : ".";
  for (const segment of segments) {
    current = current === "" ? `${sep}${segment}` : `${current}${sep}${segment}`;
    try {
      await mkdir(current, { mode: MANAGED_DIR_MODE });
    } catch (error) {
      if (isErrno(error, "EEXIST")) continue;   // not ours — do not touch its mode
      throw error;
    }
    await repairOwnerAccess(current, (await lstat(current)).mode);
  }
}

/**
 * Synchronous twin of {@link mkdirUsable}, for callers on a sync path.
 *
 * The config DB's parent is created before any await is possible, and it holds
 * the entitlement snapshot, so it needs the same umask defeat and the same
 * private mode. Kept beside the async version deliberately: two implementations
 * of this rule in different files is how one of them ends up wrong.
 */
export function mkdirUsableSync(target: string): void {
  if (process.platform === "win32") {
    mkdirSync(target, { recursive: true, mode: MANAGED_DIR_MODE });
    return;
  }
  const segments = target.split(sep).filter(Boolean);
  let current = isAbsolute(target) ? "" : ".";
  for (const segment of segments) {
    current = current === "" ? `${sep}${segment}` : `${current}${sep}${segment}`;
    try {
      mkdirSync(current, { mode: MANAGED_DIR_MODE });
    } catch (error) {
      if (isErrno(error, "EEXIST")) continue;   // not ours — do not touch its mode
      throw error;
    }
    if ((lstatSync(current).mode & MANAGED_DIR_MODE) !== MANAGED_DIR_MODE) {
      chmodSync(current, MANAGED_DIR_MODE);
    }
  }
}
