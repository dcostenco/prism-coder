import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MANAGED_DIR_MODE, mkdirUsable, mkdirUsableSync, repairOwnerAccess,
} from "../src/utils/usableDirectory.js";

/**
 * These pin the properties the nine-day outage and its two follow-up reviews
 * turned up. Every one is POSIX-specific: Windows has no permission bits to
 * strip, so the failure being defended against cannot occur there.
 */
const roots: string[] = [];
afterEach(async () => {
  while (roots.length) {
    const dir = roots.pop()!;
    try { await chmod(dir, 0o700); } catch { /* best effort before removal */ }
    await rm(dir, { recursive: true, force: true });
  }
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "usable-dir-"));
  roots.push(dir);
  return dir;
}

const posix = it.skipIf(process.platform === "win32");
const mode = async (path: string) => (await lstat(path)).mode & 0o777;

describe("usable directory creation", () => {
  posix("creates every level enterable under a umask that strips owner-execute", async () => {
    const base = await root();
    const previous = process.umask(0o177);
    try {
      const deep = join(base, "a", "b", "c");
      await mkdirUsable(deep);
      for (const path of [join(base, "a"), join(base, "a", "b"), deep]) {
        expect(await mode(path), path).toBe(MANAGED_DIR_MODE);
      }
      // Enterable in practice, not merely by mode arithmetic.
      await writeFile(join(deep, "probe"), "ok");
      expect(await readdir(deep)).toContain("probe");
    } finally {
      process.umask(previous);
    }
  });

  posix("never alters a pre-existing ancestor's mode", async () => {
    // The dangerous failure mode of this helper: silently widening $HOME or any
    // directory the user configured deliberately. It may only touch what it makes.
    const base = await root();
    const existing = join(base, "shared");
    await mkdir(existing, { mode: 0o755 });
    await chmod(existing, 0o755);

    const previous = process.umask(0o177);
    try {
      await mkdirUsable(join(existing, "child"));
      expect(await mode(existing)).toBe(0o755);            // untouched
      expect(await mode(join(existing, "child"))).toBe(MANAGED_DIR_MODE);
    } finally {
      process.umask(previous);
    }
  });

  posix("mkdirUsableSync matches the async helper", async () => {
    const base = await root();
    const previous = process.umask(0o177);
    try {
      const deep = join(base, "x", "y");
      mkdirUsableSync(deep);
      expect(await mode(deep)).toBe(MANAGED_DIR_MODE);
      expect(await mode(join(base, "x"))).toBe(MANAGED_DIR_MODE);
    } finally {
      process.umask(previous);
    }
  });
});

describe("owner-access repair", () => {
  posix("repairs an unenterable directory to exactly 0o700", async () => {
    const base = await root();
    const target = join(base, "broken");
    await mkdir(target, { mode: 0o700 });
    await chmod(target, 0o606);                  // owner rw, no owner-x, other rw

    await repairOwnerAccess(target, (await lstat(target)).mode);
    // Not 0o706: OR-ing owner bits onto the existing mode would leave a
    // directory holding entitled content readable by every other user.
    expect(await mode(target)).toBe(MANAGED_DIR_MODE);
  });

  posix("leaves a usable group-shared directory alone", async () => {
    // 0o770 is conventional sharing and the owner can already use it, so the
    // repair must not fire and must not narrow it to 0o700.
    const base = await root();
    const target = join(base, "shared");
    await mkdir(target, { mode: 0o770 });
    await chmod(target, 0o770);

    await repairOwnerAccess(target, (await lstat(target)).mode);
    expect(await mode(target)).toBe(0o770);
  });

  posix("refuses to chmod through a symlink", async () => {
    // The repair acts on an open descriptor rather than the pathname, so a path
    // that resolves to something other than a directory cannot be used to
    // redirect the permission change onto another object.
    const base = await root();
    const victim = join(base, "victim");
    await writeFile(victim, "not a directory");
    await chmod(victim, 0o644);
    const link = join(base, "link");
    await symlink(victim, link);

    await expect(repairOwnerAccess(link, 0o000)).rejects.toThrow(/not a directory/);
    expect(await mode(victim)).toBe(0o644);      // unchanged
  });
});
