import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = resolve("scripts/sync-skills.sh");
const tempHomes: string[] = [];
const sqliteAvailable = spawnSync("sqlite3", ["-version"]).status === 0;

function makeFixture(): { dbPath: string; home: string; skillsDir: string } {
  const home = mkdtempSync(join(tmpdir(), "prism-sync-skills-"));
  tempHomes.push(home);
  const dbDir = join(home, ".prism-mcp");
  const skillsDir = join(home, "skills");
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(join(skillsDir, "demo"), { recursive: true });
  writeFileSync(join(skillsDir, "demo", "SKILL.md"), "developer checkout content\n");
  return { dbPath: join(dbDir, "prism-config.db"), home, skillsDir };
}

function sqlite(dbPath: string, sql: string): string {
  return execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" }).trim();
}

function runSync(
  home: string,
  skillsDir: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  return spawnSync("bash", [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, SYNALUX_SKILLS_DIR: skillsDir, ...env },
  });
}

function createLegacySchema(dbPath: string): void {
  sqlite(dbPath, [
    "CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    "INSERT INTO system_settings (key, value) VALUES ('skill:demo', 'old content');",
    "INSERT INTO system_settings (key, value) VALUES ('skill:orphan', 'remove me');",
  ].join(" "));
}

afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32" || !sqliteAvailable)(
  "legacy skill sync compatibility",
  () => {
    it.each([
      ["old DB", false],
      ["schema-only automatic-sync DB", true],
    ])("is a no-op by default for an %s", (_case, includeManagedTable) => {
      const { dbPath, home, skillsDir } = makeFixture();
      createLegacySchema(dbPath);
      if (includeManagedTable) {
        sqlite(
          dbPath,
          "CREATE TABLE prism_managed_skills (name TEXT PRIMARY KEY, digest TEXT NOT NULL);",
        );
      }

      const result = runSync(home, skillsDir);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Legacy local skill sync skipped");
      expect(sqlite(dbPath, "SELECT value FROM system_settings WHERE key='skill:demo';"))
        .toBe("old content");
      expect(sqlite(dbPath, "SELECT value FROM system_settings WHERE key='skill:orphan';"))
        .toBe("remove me");
    });

    it("skips an explicit legacy sync when automatic tier sync owns the DB", () => {
      const { dbPath, home, skillsDir } = makeFixture();
      sqlite(dbPath, [
        "CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        "INSERT INTO system_settings (key, value) VALUES ('skill:demo', 'authoritative manifest content');",
        "CREATE TABLE prism_managed_skills (name TEXT PRIMARY KEY, digest TEXT NOT NULL);",
        `INSERT INTO system_settings (key, value) VALUES
          ('skill_manifest:owner', 'prism'),
          ('skill_manifest:generation', '${"a".repeat(64)}'),
          ('skill_manifest:names', '["demo"]');`,
      ].join(" "));
      const before = readFileSync(dbPath);

      const result = runSync(home, skillsDir, ["--legacy-local"]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Automatic tier skill sync owns this Prism DB");
      expect(readFileSync(dbPath)).toEqual(before);
      expect(sqlite(dbPath, "SELECT value FROM system_settings WHERE key='skill:demo';"))
        .toBe("authoritative manifest content");
    });

    it("updates checkout content and prunes orphans only after explicit opt-in", () => {
      const { dbPath, home, skillsDir } = makeFixture();
      createLegacySchema(dbPath);

      const result = runSync(home, skillsDir, ["--legacy-local"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Synced 1 skills");
      expect(sqlite(dbPath, "SELECT value FROM system_settings WHERE key='skill:demo';"))
        .toBe("developer checkout content");
      expect(sqlite(dbPath, "SELECT COUNT(*) FROM system_settings WHERE key='skill:orphan';"))
        .toBe("0");
    });

  },
);
