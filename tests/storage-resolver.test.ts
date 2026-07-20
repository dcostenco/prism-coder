/**
 * Storage backend resolver — regression tests for the synalux dashboard-config
 * fallback in getStorage().
 *
 * Bug history: when an MCP client (e.g. some VSCode extensions) doesn't pass
 * PRISM_SYNALUX_BASE_URL / PRISM_SYNALUX_API_KEY through to the spawned server
 * process, the resolver previously dropped to local-only — even when those
 * credentials were stored in ~/.prism-mcp/prism-config.db via the dashboard.
 * The fix probes the config DB and injects the credentials into process.env at
 * runtime so SynaluxStorage and downstream consumers can pick them up.
 *
 * SYNALUX_CONFIGURED in src/config.ts is captured at module-load time, so the
 * resolver must track readiness in a local `synaluxReady` variable that the
 * runtime injection can promote — these tests pin that contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockGetEntitlements = vi.hoisted(() => vi.fn());
vi.mock("../src/utils/entitlements.js", () => ({
  getEntitlements: mockGetEntitlements,
}));

function entitlement(plan: string, memory: boolean, source = "portal") {
  return {
    plan,
    source,
    features: { session_memory_unlimited: memory },
  };
}

// ─── Mock config DB ─────────────────────────────────────────────
// Each test mutates `mockSettings` to simulate what the dashboard wrote.
const mockSettings: Record<string, string> = {};
vi.mock("../src/storage/configStorage.js", () => ({
  getSetting: vi.fn(async (key: string, defaultValue?: string) => {
    return mockSettings[key] ?? defaultValue ?? "";
  }),
  getSettingSync: vi.fn((key: string, defaultValue?: string) => {
    return mockSettings[key] ?? defaultValue ?? "";
  }),
  initConfigStorage: vi.fn(async () => {}),
}));

// ─── Mock backend constructors ──────────────────────────────────
// We don't want real network/DB activity. Each backend exposes a tag we can
// assert against.
const sqliteInstances: object[] = [];
const supabaseInstances: object[] = [];
const synaluxInstances: object[] = [];

vi.mock("../src/storage/sqlite.js", () => ({
  SqliteStorage: class {
    tag = "sqlite";
    constructor() { sqliteInstances.push(this); }
    async initialize() {}
    async close() {}
    getHandoffTimestamps() { return []; }
  },
}));

vi.mock("../src/storage/supabase.js", () => ({
  SupabaseStorage: class {
    tag = "supabase";
    constructor() { supabaseInstances.push(this); }
    async initialize() {}
    async close() {}
  },
}));

vi.mock("../src/storage/synalux.js", () => ({
  SynaluxStorage: class {
    tag = "synalux";
    constructor() { synaluxInstances.push(this); }
    async initialize() {}
    async close() {}
  },
}));

// Reconciliation does a dynamic import — stub so the test doesn't hit it.
vi.mock("../src/storage/reconcile.js", () => ({
  reconcileHandoffs: vi.fn(async () => {}),
}));

// ─── Test helpers ───────────────────────────────────────────────
// The storage module caches a singleton. We reset modules between tests so
// each call to getStorage() runs the resolver fresh and re-reads
// SYNALUX_CONFIGURED from a clean module state.
async function freshGetStorage() {
  const mod = await import("../src/storage/index.js");
  await mod.closeStorage();
  return mod.getStorage();
}

const SYNALUX_ENV_KEYS = [
  "PRISM_SYNALUX_BASE_URL",
  "PRISM_SYNALUX_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_KEY",
  "PRISM_STORAGE",
  "PRISM_FORCE_LOCAL",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of SYNALUX_ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of SYNALUX_ENV_KEYS) delete process.env[k];
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  sqliteInstances.length = 0;
  supabaseInstances.length = 0;
  synaluxInstances.length = 0;
  mockGetEntitlements.mockReset();
  mockGetEntitlements.mockResolvedValue(entitlement("standard", true));
  vi.resetModules();
});

afterEach(() => {
  for (const k of SYNALUX_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("getStorage — synalux dashboard-config fallback", () => {
  it("auto-resolves to synalux when env vars are missing but dashboard config has them", async () => {
    process.env.PRISM_STORAGE = "auto";
    mockSettings.PRISM_SYNALUX_BASE_URL = "https://portal.synalux.example";
    mockSettings.PRISM_SYNALUX_API_KEY = "test-api-key";

    const storage = await freshGetStorage();

    expect((storage as { tag?: string }).tag).toBe("synalux");
    expect(synaluxInstances).toHaveLength(1);
    expect(sqliteInstances).toHaveLength(0);
    // Credentials must be injected into process.env so SynaluxStorage and
    // downstream HTTP clients can read them without a separate DB lookup.
    expect(process.env.PRISM_SYNALUX_BASE_URL).toBe("https://portal.synalux.example");
    expect(process.env.PRISM_SYNALUX_API_KEY).toBe("test-api-key");
  });

  it("explicit PRISM_STORAGE=synalux still picks up dashboard credentials when env vars are missing", async () => {
    // This is the second-probe path at the guardrail — exercises the bug
    // where SYNALUX_CONFIGURED (module-load constant) would have forced
    // a fallback to local even after credentials were available.
    process.env.PRISM_STORAGE = "synalux";
    mockSettings.PRISM_SYNALUX_BASE_URL = "https://portal.synalux.example";
    mockSettings.PRISM_SYNALUX_API_KEY = "test-api-key";

    const storage = await freshGetStorage();

    expect((storage as { tag?: string }).tag).toBe("synalux");
    expect(process.env.PRISM_SYNALUX_BASE_URL).toBe("https://portal.synalux.example");
    expect(mockGetEntitlements).not.toHaveBeenCalled();
  });

  it.each([
    ["free", false, "sqlite"],
    ["standard", true, "synalux"],
    ["advanced", true, "synalux"],
    ["enterprise", true, "synalux"],
  ])("auto storage honors the %s tier memory entitlement", async (plan, memory, expected) => {
    process.env.PRISM_STORAGE = "auto";
    process.env.PRISM_SYNALUX_BASE_URL = "https://portal.synalux.example";
    process.env.PRISM_SYNALUX_API_KEY = "synalux_sk_test";
    mockGetEntitlements.mockResolvedValue(entitlement(plan, memory));

    const storage = await freshGetStorage();

    expect((storage as { tag?: string }).tag).toBe(expected);
    expect(synaluxInstances).toHaveLength(memory ? 1 : 0);
    expect(sqliteInstances).toHaveLength(memory ? 0 : 1);
  });

  it("fails closed when a configured account's entitlement cannot be resolved", async () => {
    process.env.PRISM_STORAGE = "auto";
    process.env.PRISM_SYNALUX_BASE_URL = "https://portal.synalux.example";
    process.env.PRISM_SYNALUX_API_KEY = "synalux_sk_test";
    mockGetEntitlements.mockResolvedValue(entitlement("free", false, "fallback_free"));

    await expect(freshGetStorage()).rejects.toThrow(/Could not verify.*entitlement.*split session history/i);
    expect(synaluxInstances).toHaveLength(0);
    expect(sqliteInstances).toHaveLength(0);
    expect(supabaseInstances).toHaveLength(0);
  });

  it("fails closed on an inconsistent unconfigured result after credentials were found", async () => {
    process.env.PRISM_STORAGE = "auto";
    process.env.PRISM_SYNALUX_BASE_URL = "https://portal.synalux.example";
    process.env.PRISM_SYNALUX_API_KEY = "synalux_sk_test";
    mockGetEntitlements.mockResolvedValue(entitlement("free", false, "unconfigured"));

    await expect(freshGetStorage()).rejects.toThrow(/Could not verify.*entitlement/i);
    expect(sqliteInstances).toHaveLength(0);
  });

  it("fails closed when entitlement provenance is not the portal", async () => {
    process.env.PRISM_STORAGE = "auto";
    process.env.PRISM_SYNALUX_BASE_URL = "https://portal.synalux.example";
    process.env.PRISM_SYNALUX_API_KEY = "synalux_sk_test";
    mockGetEntitlements.mockResolvedValue(entitlement("standard", true, "legacy_cache"));

    await expect(freshGetStorage()).rejects.toThrow(/Could not verify.*entitlement/i);
    expect(synaluxInstances).toHaveLength(0);
    expect(sqliteInstances).toHaveLength(0);
    expect(supabaseInstances).toHaveLength(0);
  });

  it("honors explicit local storage without checking a paid Synalux entitlement", async () => {
    process.env.PRISM_STORAGE = "local";
    process.env.PRISM_SYNALUX_BASE_URL = "https://portal.synalux.example";
    process.env.PRISM_SYNALUX_API_KEY = "synalux_sk_test";

    const storage = await freshGetStorage();

    expect((storage as { tag?: string }).tag).toBe("sqlite");
    expect(mockGetEntitlements).not.toHaveBeenCalled();
    expect(synaluxInstances).toHaveLength(0);
  });

  it("honors explicit direct Supabase storage without checking Synalux entitlements", async () => {
    process.env.PRISM_STORAGE = "supabase";
    process.env.SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_KEY = "supabase-test-key";

    const storage = await freshGetStorage();

    expect((storage as { tag?: string }).tag).toBe("supabase");
    expect(mockGetEntitlements).not.toHaveBeenCalled();
    expect(supabaseInstances).toHaveLength(1);
  });

  it("PRISM_FORCE_LOCAL overrides auto even when Synalux credentials are present", async () => {
    process.env.PRISM_STORAGE = "auto";
    process.env.PRISM_FORCE_LOCAL = "true";
    process.env.PRISM_SYNALUX_BASE_URL = "https://portal.synalux.example";
    process.env.PRISM_SYNALUX_API_KEY = "synalux_sk_test";

    const storage = await freshGetStorage();

    expect((storage as { tag?: string }).tag).toBe("sqlite");
    expect(mockGetEntitlements).not.toHaveBeenCalled();
    expect(synaluxInstances).toHaveLength(0);
  });

  it("auto preserves the legacy direct Supabase backend when no Synalux credentials exist", async () => {
    process.env.PRISM_STORAGE = "auto";
    process.env.SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_KEY = "supabase-test-key";

    const storage = await freshGetStorage();

    expect((storage as { tag?: string }).tag).toBe("supabase");
    expect(mockGetEntitlements).not.toHaveBeenCalled();
    expect(supabaseInstances).toHaveLength(1);
    expect(sqliteInstances).toHaveLength(0);
  });

  it("falls back to local when neither env vars nor dashboard config have synalux credentials", async () => {
    process.env.PRISM_STORAGE = "auto";
    // mockSettings is empty — no synalux, no supabase

    const storage = await freshGetStorage();

    expect((storage as { tag?: string }).tag).toBe("sqlite");
    expect(synaluxInstances).toHaveLength(0);
  });

  it("rejects dashboard synalux URL that is not http(s)", async () => {
    process.env.PRISM_STORAGE = "auto";
    mockSettings.PRISM_SYNALUX_BASE_URL = "ftp://nope.example";
    mockSettings.PRISM_SYNALUX_API_KEY = "test-api-key";

    const storage = await freshGetStorage();

    expect((storage as { tag?: string }).tag).toBe("sqlite");
    expect(process.env.PRISM_SYNALUX_BASE_URL).toBeUndefined();
  });

  it("does not fall back to synalux when only the URL is set (missing API key)", async () => {
    process.env.PRISM_STORAGE = "auto";
    mockSettings.PRISM_SYNALUX_BASE_URL = "https://portal.synalux.example";
    // No PRISM_SYNALUX_API_KEY

    const storage = await freshGetStorage();

    expect((storage as { tag?: string }).tag).toBe("sqlite");
    expect(synaluxInstances).toHaveLength(0);
  });

  it("picks up synalux env vars injected after module load (no DB lookup)", async () => {
    // Pins the symmetric process.env probe in ensureSynaluxCredentials.
    // SYNALUX_CONFIGURED is captured at import time, so creds injected
    // later (e.g. by a wrapper script or test harness) must still be
    // visible without falling through to the DB.
    process.env.PRISM_STORAGE = "auto";
    process.env.PRISM_SYNALUX_BASE_URL = "https://portal.synalux.example";
    process.env.PRISM_SYNALUX_API_KEY = "synalux_sk_test";
    // Dashboard mockSettings is empty — the helper must not need it.

    const storage = await freshGetStorage();

    expect((storage as { tag?: string }).tag).toBe("synalux");
  });

  it("falls back to local when explicit synalux backend has no credentials anywhere", async () => {
    // Mirror of the supabase guardrail: explicit backend, no creds, must
    // fall back to local with the named-env-var error message (not crash).
    process.env.PRISM_STORAGE = "synalux";
    // No env vars, no dashboard creds.

    const storage = await freshGetStorage();

    expect((storage as { tag?: string }).tag).toBe("sqlite");
    expect(synaluxInstances).toHaveLength(0);
  });
});
