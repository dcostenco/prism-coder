/**
 * Regression for dashboard account persistence across a transient outage.
 *
 * This deliberately keeps the real resolver, shared JWT helper, and
 * SynaluxStorage class in the path. Only durable settings and the unused
 * Supabase parent are replaced. A failed validation must not publish a
 * singleton that permanently captures the rejected launcher credential.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => new Map<string, string>());
const testSynaluxKey = (suffix: string) => ["synalux", "sk", suffix].join("_");

vi.mock("../../src/storage/configStorage.js", () => ({
  getSetting: vi.fn(async (key: string, defaultValue?: string) =>
    settings.get(key) ?? defaultValue ?? ""),
  getSettingSync: vi.fn((key: string, defaultValue?: string) =>
    settings.get(key) ?? defaultValue ?? ""),
  initConfigStorage: vi.fn(async () => {}),
}));

vi.mock("../../src/storage/supabase.js", () => ({
  SupabaseStorage: class {
    async initialize() {}
    async close() {}
  },
}));

const ENV_KEYS = [
  "PRISM_STORAGE",
  "PRISM_FORCE_LOCAL",
  "PRISM_SYNALUX_BASE_URL",
  "PRISM_SYNALUX_API_KEY",
  "SYNALUX_BASE_URL",
  "SUPABASE_URL",
  "SUPABASE_KEY",
] as const;

const savedEnv = new Map<string, string | undefined>();
let storageModule: typeof import("../../src/storage/index.js") | undefined;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  settings.clear();
  storageModule = undefined;
  vi.resetModules();
});

afterEach(async () => {
  await storageModule?.closeStorage();
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

describe("Synalux account recovery through the storage resolver", () => {
  it("recovers after an outage without retaining the rejected launcher key", async () => {
    const portalOrigin = "https://portal.synalux.example";
    const launcherKey = testSynaluxKey("revoked_launcher");
    const persistedKey = testSynaluxKey("persisted_account");

    process.env.PRISM_STORAGE = "synalux";
    process.env.PRISM_SYNALUX_BASE_URL = portalOrigin;
    process.env.PRISM_SYNALUX_API_KEY = launcherKey;
    settings.set("PRISM_SYNALUX_SIGNED_OUT", "false");
    settings.set("PRISM_SYNALUX_BASE_URL", portalOrigin);
    settings.set("PRISM_SYNALUX_API_KEY", persistedKey);

    let networkAvailable = false;
    let persistedExchanges = 0;
    const authorizations: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
      authorizations.push(authorization);

      if (!networkAvailable) throw new Error("temporary outage");

      if (url === `${portalOrigin}/api/v1/auth/jwt`) {
        if (authorization === `Bearer ${launcherKey}`) {
          return jsonResponse(401, { status: "error", error: "revoked" });
        }
        if (authorization === `Bearer ${persistedKey}`) {
          persistedExchanges += 1;
          return jsonResponse(200, {
            status: "success",
            jwt: persistedExchanges === 1 ? "resolver-jwt" : "storage-jwt",
            expires_in: 900,
          });
        }
      }

      if (url === `${portalOrigin}/api/v1/prism/memory`) {
        expect(authorization).toBe("Bearer storage-jwt");
        expect(JSON.parse(String(init?.body))).toEqual({ action: "list_projects" });
        return jsonResponse(200, {
          status: "success",
          projects: [{ project: "team-project" }],
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    storageModule = await import("../../src/storage/index.js");

    await expect(storageModule.getStorage()).rejects.toThrow(
      /could not validate.*Synalux.*credential/i,
    );

    networkAvailable = true;
    const storage = await storageModule.getStorage();
    await expect(storage.listProjects()).resolves.toEqual(["team-project"]);

    expect(process.env.PRISM_SYNALUX_API_KEY).toBe(persistedKey);
    expect(authorizations).toEqual([
      `Bearer ${launcherKey}`,
      `Bearer ${launcherKey}`,
      `Bearer ${persistedKey}`,
      `Bearer ${persistedKey}`,
      "Bearer storage-jwt",
    ]);
  });
});
