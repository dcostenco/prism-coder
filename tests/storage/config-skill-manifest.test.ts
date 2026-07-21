import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir: string;
let dbPath: string;
let storage: typeof import("../../src/storage/configStorage.js");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "prism-config-manifest-"));
  dbPath = join(dir, "config.db");
  process.env.PRISM_CONFIG_PATH = dbPath;
  storage = await import("../../src/storage/configStorage.js");
  await storage.initConfigStorage();
});

afterAll(async () => {
  storage.closeConfigStorage();
  delete process.env.PRISM_CONFIG_PATH;
  await rm(dir, { recursive: true, force: true });
});

describe("atomic managed-skill config storage", () => {
  it("prunes only Prism-managed content on downgrade", async () => {
    await storage.setSetting("skill:user-role", "user owned");
    await storage.applyManagedSkillManifest({
      generation: "a".repeat(64), tier: "advanced", routingVersion: 1,
      skills: [
        { name: "aba-precision-protocol", content: "aba-v1", digest: "1".repeat(64) },
        { name: "paid-skill", content: "paid", digest: "2".repeat(64) },
      ],
    });
    await storage.applyManagedSkillManifest({
      generation: "b".repeat(64), tier: "free", routingVersion: 2,
      skills: [{ name: "aba-precision-protocol", content: "aba-v2", digest: "3".repeat(64) }],
    });

    expect(await storage.getSetting("skill:aba-precision-protocol")).toBe("aba-v2");
    expect(await storage.getSetting("skill:paid-skill", "missing")).toBe("missing");
    expect(await storage.getSetting("skill:user-role")).toBe("user owned");
    expect(JSON.parse(await storage.getSetting("skill_manifest:names"))).toEqual(["aba-precision-protocol"]);
  });

  it("rolls back content and generation together when any statement fails", async () => {
    const external = createClient({ url: `file:${dbPath}` });
    await external.execute(`
      CREATE TRIGGER reject_manifest_generation
      BEFORE UPDATE ON system_settings
      WHEN NEW.key = 'skill_manifest:generation'
      BEGIN
        SELECT RAISE(ABORT, 'forced atomicity failure');
      END
    `);

    await expect(storage.applyManagedSkillManifest({
      generation: "c".repeat(64), tier: "standard", routingVersion: 3,
      skills: [{ name: "aba-precision-protocol", content: "must-roll-back", digest: "4".repeat(64) }],
    })).rejects.toThrow(/forced atomicity failure/);

    const content = await external.execute({ sql: "SELECT value FROM system_settings WHERE key = ?", args: ["skill:aba-precision-protocol"] });
    const generation = await external.execute({ sql: "SELECT value FROM system_settings WHERE key = ?", args: ["skill_manifest:generation"] });
    expect(content.rows[0].value).toBe("aba-v2");
    expect(generation.rows[0].value).toBe("b".repeat(64));
    external.close();
  });
});
