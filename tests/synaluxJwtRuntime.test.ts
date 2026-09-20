import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSettings = vi.hoisted(() => new Map<string, string>());
const testSynaluxKey = (suffix: string) => ["synalux", "sk", suffix].join("_");

vi.mock("../src/config.js", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  PRISM_SYNALUX_BASE_URL: "",
  PRISM_SYNALUX_API_KEY: "",
}));

vi.mock("../src/storage/configStorage.js", () => ({
  getSetting: vi.fn(async (key: string, fallback = "") => mockSettings.get(key) ?? fallback),
}));

import {
  _resetSynaluxJwtForTest,
  getSynaluxJwt,
  invalidateSynaluxJwt,
} from "../src/utils/synaluxJwt.js";
import {
  _resetSynaluxCredentialStateForTest,
  setSynaluxSignedOut,
} from "../src/utils/synaluxCredentialState.js";

beforeEach(() => {
  _resetSynaluxJwtForTest();
  _resetSynaluxCredentialStateForTest();
  delete process.env.PRISM_SYNALUX_BASE_URL;
  delete process.env.PRISM_SYNALUX_API_KEY;
  mockSettings.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  _resetSynaluxCredentialStateForTest();
  delete process.env.PRISM_SYNALUX_BASE_URL;
  delete process.env.PRISM_SYNALUX_API_KEY;
});

describe("Synalux JWT runtime credentials", () => {
  it("recognizes credentials injected after config module initialization", async () => {
    process.env.PRISM_SYNALUX_BASE_URL = "https://runtime.synalux.test";
    process.env.PRISM_SYNALUX_API_KEY = "synalux_sk_runtime";
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ jwt: "runtime-jwt", expires_in: 900 }), { status: 200 }),
    );

    await expect(getSynaluxJwt()).resolves.toBe("runtime-jwt");
    expect(request).toHaveBeenCalledWith(
      "https://runtime.synalux.test/api/v1/auth/jwt",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer synalux_sk_runtime" }),
      }),
    );
  });

  it("does not attempt an exchange without credentials", async () => {
    const request = vi.spyOn(globalThis, "fetch");

    await expect(getSynaluxJwt()).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not revive a signed-out account from a stale host credential", async () => {
    process.env.PRISM_SYNALUX_BASE_URL = "https://runtime.synalux.test";
    process.env.PRISM_SYNALUX_API_KEY = ["synalux", "sk", "stale_host"].join("_");
    setSynaluxSignedOut(true);
    const request = vi.spyOn(globalThis, "fetch");

    await expect(getSynaluxJwt()).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("discards an exchange that finishes after sign-out invalidates its generation", async () => {
    process.env.PRISM_SYNALUX_BASE_URL = "https://runtime.synalux.test";
    process.env.PRISM_SYNALUX_API_KEY = ["synalux", "sk", "runtime"].join("_");
    let resolveExchange!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>((resolve) => {
      resolveExchange = resolve;
    }));

    const exchange = getSynaluxJwt();
    setSynaluxSignedOut(true);
    invalidateSynaluxJwt();
    resolveExchange(new Response(JSON.stringify({ jwt: "jwt-after-signout", expires_in: 900 }), { status: 200 }));

    await expect(exchange).resolves.toBeNull();
  });

  it("recovers a revoked launcher key from the newer persisted account key", async () => {
    process.env.PRISM_SYNALUX_BASE_URL = "https://runtime.synalux.test";
    process.env.PRISM_SYNALUX_API_KEY = testSynaluxKey("revoked_launcher");
    mockSettings.set("PRISM_SYNALUX_SIGNED_OUT", "false");
    mockSettings.set("PRISM_SYNALUX_BASE_URL", "https://runtime.synalux.test");
    mockSettings.set("PRISM_SYNALUX_API_KEY", testSynaluxKey("persisted_account"));
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jwt: "persisted-jwt", expires_in: 900 }), { status: 200 }));

    await expect(getSynaluxJwt()).resolves.toBe("persisted-jwt");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://runtime.synalux.test/api/v1/auth/jwt",
      "https://runtime.synalux.test/api/v1/auth/jwt",
    ]);
    expect(request.mock.calls.map(([, init]) => (init?.headers as Record<string, string>).Authorization)).toEqual([
      `Bearer ${testSynaluxKey("revoked_launcher")}`,
      `Bearer ${testSynaluxKey("persisted_account")}`,
    ]);
    expect(process.env.PRISM_SYNALUX_BASE_URL).toBe("https://runtime.synalux.test");
    expect(process.env.PRISM_SYNALUX_API_KEY).toBe(testSynaluxKey("persisted_account"));
  });

  it("keeps a valid explicit launcher key authoritative over a different persisted key", async () => {
    process.env.PRISM_SYNALUX_BASE_URL = "https://runtime.synalux.test";
    process.env.PRISM_SYNALUX_API_KEY = testSynaluxKey("valid_launcher");
    mockSettings.set("PRISM_SYNALUX_SIGNED_OUT", "false");
    mockSettings.set("PRISM_SYNALUX_BASE_URL", "https://runtime.synalux.test");
    mockSettings.set("PRISM_SYNALUX_API_KEY", testSynaluxKey("persisted_account"));
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ jwt: "launcher-jwt", expires_in: 900 }), { status: 200 }),
    );

    await expect(getSynaluxJwt()).resolves.toBe("launcher-jwt");
    expect(request).toHaveBeenCalledTimes(1);
    expect(process.env.PRISM_SYNALUX_API_KEY).toBe(testSynaluxKey("valid_launcher"));
  });

  it("does not reuse a team JWT after the linked account switches to personal", async () => {
    process.env.PRISM_SYNALUX_BASE_URL = "https://runtime.synalux.test";
    process.env.PRISM_SYNALUX_API_KEY = testSynaluxKey("team_account");
    mockSettings.set("PRISM_SYNALUX_SIGNED_OUT", "false");
    mockSettings.set("PRISM_SYNALUX_BASE_URL", "https://runtime.synalux.test");
    mockSettings.set("PRISM_SYNALUX_API_KEY", testSynaluxKey("personal_account"));
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jwt: "team-workspace-jwt", expires_in: 900 }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jwt: "personal-workspace-jwt", expires_in: 900 }), { status: 200 }),
      );

    await expect(getSynaluxJwt()).resolves.toBe("team-workspace-jwt");

    // Dashboard account linking updates the process credential and invalidates
    // the shared JWT cache before any account or project request is retried.
    process.env.PRISM_SYNALUX_API_KEY = testSynaluxKey("personal_account");
    invalidateSynaluxJwt();

    await expect(getSynaluxJwt()).resolves.toBe("personal-workspace-jwt");
    expect(request.mock.calls.map(([, init]) =>
      (init?.headers as Record<string, string>).Authorization,
    )).toEqual([
      `Bearer ${testSynaluxKey("team_account")}`,
      `Bearer ${testSynaluxKey("personal_account")}`,
    ]);
  });

  it.each([
    ["server failure", () => Promise.resolve(new Response("{}", { status: 500 }))],
    ["network failure", () => Promise.reject(new Error("offline"))],
  ])("does not switch credentials after a %s", async (_label, response) => {
    process.env.PRISM_SYNALUX_BASE_URL = "https://runtime.synalux.test";
    process.env.PRISM_SYNALUX_API_KEY = testSynaluxKey("launcher");
    mockSettings.set("PRISM_SYNALUX_SIGNED_OUT", "false");
    mockSettings.set("PRISM_SYNALUX_BASE_URL", "https://runtime.synalux.test");
    mockSettings.set("PRISM_SYNALUX_API_KEY", testSynaluxKey("persisted_account"));
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(response);

    await expect(getSynaluxJwt()).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(process.env.PRISM_SYNALUX_API_KEY).toBe(testSynaluxKey("launcher"));
  });

  it("does not retry when persisted sign-out wins during the rejected exchange", async () => {
    process.env.PRISM_SYNALUX_BASE_URL = "https://runtime.synalux.test";
    process.env.PRISM_SYNALUX_API_KEY = testSynaluxKey("revoked_launcher");
    mockSettings.set("PRISM_SYNALUX_SIGNED_OUT", "false");
    mockSettings.set("PRISM_SYNALUX_BASE_URL", "https://runtime.synalux.test");
    mockSettings.set("PRISM_SYNALUX_API_KEY", testSynaluxKey("persisted_account"));
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      mockSettings.set("PRISM_SYNALUX_SIGNED_OUT", "true");
      return new Response("{}", { status: 401 });
    });

    await expect(getSynaluxJwt()).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(process.env.PRISM_SYNALUX_API_KEY).toBe(testSynaluxKey("revoked_launcher"));
  });

  it("never sends the persisted account key to an unsafe saved portal URL", async () => {
    process.env.PRISM_SYNALUX_BASE_URL = "https://runtime.synalux.test";
    process.env.PRISM_SYNALUX_API_KEY = testSynaluxKey("revoked_launcher");
    mockSettings.set("PRISM_SYNALUX_SIGNED_OUT", "false");
    mockSettings.set("PRISM_SYNALUX_BASE_URL", "http://remote-host.invalid");
    mockSettings.set("PRISM_SYNALUX_API_KEY", testSynaluxKey("persisted_account"));
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));

    await expect(getSynaluxJwt()).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect((request.mock.calls[0][1]?.headers as Record<string, string>).Authorization)
      .toBe(`Bearer ${testSynaluxKey("revoked_launcher")}`);
  });

  it("fails closed instead of recovering an account key across portal origins", async () => {
    process.env.PRISM_SYNALUX_BASE_URL = "https://launcher.synalux.test";
    process.env.PRISM_SYNALUX_API_KEY = testSynaluxKey("revoked_launcher");
    mockSettings.set("PRISM_SYNALUX_SIGNED_OUT", "false");
    mockSettings.set("PRISM_SYNALUX_BASE_URL", "https://different.synalux.test");
    mockSettings.set("PRISM_SYNALUX_API_KEY", testSynaluxKey("persisted_account"));
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));

    await expect(getSynaluxJwt()).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect((request.mock.calls[0][1]?.headers as Record<string, string>).Authorization)
      .toBe(`Bearer ${testSynaluxKey("revoked_launcher")}`);
  });

  it("does not publish a persisted key that changed while its retry was in flight", async () => {
    process.env.PRISM_SYNALUX_BASE_URL = "https://runtime.synalux.test";
    process.env.PRISM_SYNALUX_API_KEY = testSynaluxKey("revoked_launcher");
    mockSettings.set("PRISM_SYNALUX_SIGNED_OUT", "false");
    mockSettings.set("PRISM_SYNALUX_BASE_URL", "https://runtime.synalux.test");
    mockSettings.set("PRISM_SYNALUX_API_KEY", testSynaluxKey("persisted_account_b"));
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockImplementationOnce(async () => {
        mockSettings.set("PRISM_SYNALUX_API_KEY", testSynaluxKey("newer_account_c"));
        return new Response(JSON.stringify({ jwt: "superseded-jwt", expires_in: 900 }), { status: 200 });
      });

    await expect(getSynaluxJwt()).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    expect(process.env.PRISM_SYNALUX_API_KEY).toBe(testSynaluxKey("revoked_launcher"));
  });

  it("shares one stale-key attempt and one recovery attempt across concurrent callers", async () => {
    process.env.PRISM_SYNALUX_BASE_URL = "https://runtime.synalux.test";
    process.env.PRISM_SYNALUX_API_KEY = testSynaluxKey("revoked_launcher");
    mockSettings.set("PRISM_SYNALUX_SIGNED_OUT", "false");
    mockSettings.set("PRISM_SYNALUX_BASE_URL", "https://runtime.synalux.test");
    mockSettings.set("PRISM_SYNALUX_API_KEY", testSynaluxKey("persisted_account"));
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jwt: "persisted-jwt", expires_in: 900 }), { status: 200 }));

    await expect(Promise.all([getSynaluxJwt(), getSynaluxJwt(), getSynaluxJwt()])).resolves.toEqual([
      "persisted-jwt",
      "persisted-jwt",
      "persisted-jwt",
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
