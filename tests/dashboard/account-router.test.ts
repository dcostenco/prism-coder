import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectDashboardAccount,
  loadDashboardAccount,
  openDashboardBilling,
  signOutDashboardAccount,
  type AccountRouterDeps,
} from "../../src/dashboard/accountRouter.js";
import { _resetSynaluxCredentialStateForTest, setSynaluxSignedOut } from "../../src/utils/synaluxCredentialState.js";

const ORIGINAL_KEY = process.env.PRISM_SYNALUX_API_KEY;
const ORIGIN = "https://synalux.ai";
const TOKEN = ["synalux", "sk", "account-router-fixture"].join("_");

function account(plan = "free") {
  return {
    signed_in: true,
    name: "Dashboard User",
    role_key: "BCBA",
    plan,
    subscription_plan: plan === "free" ? null : plan,
    plan_source: "stripe",
    billing_status: plan === "free" ? "free" : "active",
    trial_ends_at: null,
    billing: { action: plan === "free" ? "upgrade" : "manage", url: plan === "free" ? `${ORIGIN}/pricing#prism-plans` : null },
  };
}

function harness(initial: Record<string, string> = {}) {
  const settings = new Map(Object.entries(initial));
  const fetcher = vi.fn<typeof fetch>();
  const getJwt = vi.fn().mockResolvedValue("eyJ.fixture.jwt");
  const invalidateJwt = vi.fn();
  const invalidateEntitlements = vi.fn();
  const closeStorage = vi.fn(async () => {});
  const setSetting = vi.fn(async (key: string, value: string) => { settings.set(key, value); });
  const deps: AccountRouterDeps = {
    fetcher,
    getSetting: vi.fn(async (key: string, fallback = "") => settings.get(key) ?? fallback),
    setSetting,
    getJwt,
    invalidateJwt,
    invalidateEntitlements,
    closeStorage,
    resolvePortalBaseUrl: vi.fn(() => ORIGIN),
    usablePortalKey: vi.fn(() => settings.get("PRISM_SYNALUX_API_KEY") || process.env.PRISM_SYNALUX_API_KEY),
  };
  return { settings, fetcher, getJwt, invalidateJwt, invalidateEntitlements, closeStorage, setSetting, deps };
}

describe("dashboard account service", () => {
  beforeEach(() => {
    _resetSynaluxCredentialStateForTest();
    delete process.env.PRISM_SYNALUX_API_KEY;
  });

  afterEach(() => {
    _resetSynaluxCredentialStateForTest();
    if (ORIGINAL_KEY === undefined) delete process.env.PRISM_SYNALUX_API_KEY;
    else process.env.PRISM_SYNALUX_API_KEY = ORIGINAL_KEY;
    vi.restoreAllMocks();
  });

  it("shows a real Free signed-out state with sign-in and pricing URLs", async () => {
    const h = harness();
    const result = await loadDashboardAccount(h.deps);
    expect(result).toMatchObject({
      signed_in: false,
      configured: false,
      plan: "free",
      auth_url: `${ORIGIN}/auth?source=prism`,
      billing: { action: "upgrade", url: `${ORIGIN}/pricing#prism-plans` },
    });
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it.each(["free", "standard", "advanced", "enterprise"])("loads the authenticated %s plan", async plan => {
    const h = harness({ PRISM_SYNALUX_API_KEY: TOKEN });
    h.fetcher.mockResolvedValue(new Response(JSON.stringify(account(plan)), { status: 200 }));
    const result = await loadDashboardAccount(h.deps);
    expect(result).toMatchObject({ signed_in: true, name: "Dashboard User", role_key: "BCBA", plan });
    expect(h.fetcher).toHaveBeenCalledWith(`${ORIGIN}/api/v1/prism/account`, expect.objectContaining({ method: "GET" }));
  });

  it("does not silently render Free when a configured account cannot be verified", async () => {
    const h = harness({ PRISM_SYNALUX_API_KEY: TOKEN });
    h.fetcher.mockResolvedValue(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }));
    await expect(loadDashboardAccount(h.deps)).rejects.toThrow("HTTP 503");
  });

  it("preserves a valid trial state and normalizes its end date", async () => {
    const h = harness({ PRISM_SYNALUX_API_KEY: TOKEN });
    h.fetcher.mockResolvedValue(new Response(JSON.stringify({
      ...account("standard"),
      billing_status: "trialing",
      trial_ends_at: "2026-10-04T12:00:00-04:00",
    }), { status: 200 }));

    await expect(loadDashboardAccount(h.deps)).resolves.toMatchObject({
      plan: "standard",
      billing_status: "trialing",
      trial_ends_at: "2026-10-04T16:00:00.000Z",
    });
  });

  it("preserves a verified paid plan separately while entitlement sync is pending", async () => {
    const h = harness({ PRISM_SYNALUX_API_KEY: TOKEN });
    h.fetcher.mockResolvedValue(new Response(JSON.stringify({
      ...account("free"),
      subscription_plan: "standard",
      billing_status: "sync_pending",
      trial_ends_at: "2026-10-04T12:00:00-04:00",
      billing: { action: "manage", url: null },
    }), { status: 200 }));

    await expect(loadDashboardAccount(h.deps)).resolves.toMatchObject({
      plan: "free",
      subscription_plan: "standard",
      billing_status: "sync_pending",
      trial_ends_at: "2026-10-04T16:00:00.000Z",
    });
  });

  it("does not trust an unknown billing state or malformed trial deadline", async () => {
    const h = harness({ PRISM_SYNALUX_API_KEY: TOKEN });
    h.fetcher.mockResolvedValue(new Response(JSON.stringify({
      ...account("advanced"),
      billing_status: "attacker-controlled",
      trial_ends_at: "not-a-date",
    }), { status: 200 }));

    await expect(loadDashboardAccount(h.deps)).resolves.toMatchObject({
      billing_status: "unknown",
      trial_ends_at: null,
    });
  });

  it("does not trust an unknown subscription plan", async () => {
    const h = harness({ PRISM_SYNALUX_API_KEY: TOKEN });
    h.fetcher.mockResolvedValue(new Response(JSON.stringify({
      ...account("free"),
      subscription_plan: "attacker-controlled",
      billing_status: "sync_pending",
    }), { status: 200 }));

    await expect(loadDashboardAccount(h.deps)).resolves.toMatchObject({
      plan: "free",
      subscription_plan: null,
      billing_status: "unknown",
    });
  });

  it("exchanges a one-time Prism code, stores the credential, and loads the account", async () => {
    const h = harness();
    h.fetcher.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/v1/auth/code-exchange")) {
        expect(JSON.parse(String(init?.body))).toEqual({ code: "synalux_code_fixture", client: "prism" });
        return new Response(JSON.stringify({ api_token: TOKEN }), { status: 200 });
      }
      return new Response(JSON.stringify(account("standard")), { status: 200 });
    });

    const result = await connectDashboardAccount("synalux_code_fixture", h.deps);
    expect(result.plan).toBe("standard");
    expect(h.settings.get("PRISM_SYNALUX_API_KEY")).toBe(TOKEN);
    expect(h.settings.get("PRISM_SYNALUX_SIGNED_OUT")).toBe("false");
    expect(h.invalidateJwt).toHaveBeenCalled();
    expect(h.invalidateEntitlements).toHaveBeenCalled();
    expect(h.closeStorage).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("rejects malformed one-time codes without contacting Portal", async () => {
    const h = harness();
    await expect(connectDashboardAccount("not-a-code", h.deps)).rejects.toThrow("valid one-time");
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("revokes a newly issued token if local credential persistence fails", async () => {
    const h = harness();
    h.setSetting.mockImplementation(async (key: string, value: string) => {
      if (key === "PRISM_SYNALUX_API_KEY" && value === TOKEN) throw new Error("disk full");
      h.settings.set(key, value);
    });
    h.fetcher.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/api/v1/auth/code-exchange")) {
        return new Response(JSON.stringify({ api_token: TOKEN }), { status: 200 });
      }
      expect(init?.method).toBe("DELETE");
      return new Response(JSON.stringify({ revoked: true }), { status: 200 });
    });
    await expect(connectDashboardAccount("synalux_code_fixture", h.deps)).rejects.toThrow("Could not save");
    expect(h.fetcher).toHaveBeenCalledWith(`${ORIGIN}/api/v1/prism/account`, expect.objectContaining({ method: "DELETE" }));
    expect(h.settings.get("PRISM_SYNALUX_SIGNED_OUT")).toBe("true");
  });

  it("opens public pricing while signed out", async () => {
    const h = harness();
    await expect(openDashboardBilling(h.deps)).resolves.toEqual({ url: `${ORIGIN}/pricing#prism-plans`, action: "upgrade" });
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("returns a validated Stripe Billing Portal URL for a signed-in user", async () => {
    const h = harness({ PRISM_SYNALUX_API_KEY: TOKEN });
    h.fetcher.mockResolvedValue(new Response(JSON.stringify({ url: "https://billing.stripe.com/p/session", action: "manage" }), { status: 200 }));
    await expect(openDashboardBilling(h.deps)).resolves.toEqual({ url: "https://billing.stripe.com/p/session", action: "manage" });
  });

  it("rejects an attacker-controlled billing redirect", async () => {
    const h = harness({ PRISM_SYNALUX_API_KEY: TOKEN });
    h.fetcher.mockResolvedValue(new Response(JSON.stringify({ url: "https://attacker.example/collect", action: "manage" }), { status: 200 }));
    await expect(openDashboardBilling(h.deps)).rejects.toThrow("unsafe billing URL");
  });

  it("rejects an account retry response that arrives after sign-out", async () => {
    const h = harness({ PRISM_SYNALUX_API_KEY: TOKEN });
    h.getJwt.mockResolvedValueOnce("jwt-stale").mockResolvedValueOnce("jwt-fresh");
    let resolveRetry!: (response: Response) => void;
    h.fetcher
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockReturnValueOnce(new Promise<Response>((resolve) => { resolveRetry = resolve; }));

    const loading = loadDashboardAccount(h.deps);
    await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(2));
    setSynaluxSignedOut(true);
    resolveRetry(new Response(JSON.stringify(account("standard")), { status: 200 }));

    await expect(loading).rejects.toThrow(/signed out/);
  });

  it("rejects a billing retry response that arrives after sign-out", async () => {
    const h = harness({ PRISM_SYNALUX_API_KEY: TOKEN });
    h.getJwt.mockResolvedValueOnce("jwt-stale").mockResolvedValueOnce("jwt-fresh");
    let resolveRetry!: (response: Response) => void;
    h.fetcher
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockReturnValueOnce(new Promise<Response>((resolve) => { resolveRetry = resolve; }));

    const billing = openDashboardBilling(h.deps);
    await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(2));
    setSynaluxSignedOut(true);
    resolveRetry(new Response(JSON.stringify({ url: "https://billing.stripe.com/p/session", action: "manage" }), { status: 200 }));

    await expect(billing).rejects.toThrow(/signed out/);
  });

  it("revokes the current token and persists sign-out before clearing the stored key", async () => {
    const h = harness({ PRISM_SYNALUX_API_KEY: TOKEN });
    process.env.PRISM_SYNALUX_API_KEY = TOKEN;
    h.fetcher.mockResolvedValue(new Response(JSON.stringify({ revoked: true }), { status: 200 }));
    await expect(signOutDashboardAccount(h.deps)).resolves.toEqual({ signed_out: true, revoked: true });
    expect(h.settings.get("PRISM_SYNALUX_SIGNED_OUT")).toBe("true");
    expect(h.settings.get("PRISM_SYNALUX_API_KEY")).toBe("");
    expect(process.env.PRISM_SYNALUX_API_KEY).toBeUndefined();
    expect(h.closeStorage).toHaveBeenCalledOnce();
    expect(h.setSetting.mock.calls.slice(-2)).toEqual([
      ["PRISM_SYNALUX_SIGNED_OUT", "true"],
      ["PRISM_SYNALUX_API_KEY", ""],
    ]);
  });

  it("signs out locally and reports unconfirmed revocation when Portal is offline", async () => {
    const h = harness({ PRISM_SYNALUX_API_KEY: TOKEN });
    h.fetcher.mockRejectedValue(new Error("offline"));
    await expect(signOutDashboardAccount(h.deps)).resolves.toEqual({ signed_out: true, revoked: false });
    expect(h.settings.get("PRISM_SYNALUX_SIGNED_OUT")).toBe("true");
    expect(h.settings.get("PRISM_SYNALUX_API_KEY")).toBe("");
  });

  it("keeps a signed-out account signed out after restart even if a host env still contains the old key", async () => {
    const h = harness({ PRISM_SYNALUX_SIGNED_OUT: "true", PRISM_SYNALUX_API_KEY: TOKEN });
    process.env.PRISM_SYNALUX_API_KEY = TOKEN;
    const result = await loadDashboardAccount(h.deps);
    expect(result.signed_in).toBe(false);
    expect(result.plan).toBe("free");
    expect(process.env.PRISM_SYNALUX_API_KEY).toBeUndefined();
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("serializes account mutations so a later sign-out wins an older connect", async () => {
    const h = harness({ PRISM_SYNALUX_API_KEY: TOKEN });
    let resolveExchange!: (response: Response) => void;
    const exchange = new Promise<Response>((resolve) => { resolveExchange = resolve; });
    h.fetcher.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/v1/auth/code-exchange")) return exchange;
      if (init?.method === "DELETE") return new Response(JSON.stringify({ revoked: true }), { status: 200 });
      return new Response(JSON.stringify(account("standard")), { status: 200 });
    });

    const connect = connectDashboardAccount("synalux_code_fixture", h.deps);
    await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(1));
    const signOut = signOutDashboardAccount(h.deps);
    resolveExchange(new Response(JSON.stringify({ api_token: TOKEN }), { status: 200 }));

    await expect(connect).resolves.toMatchObject({ plan: "standard" });
    await expect(signOut).resolves.toEqual({ signed_out: true, revoked: true });
    expect(h.settings.get("PRISM_SYNALUX_SIGNED_OUT")).toBe("true");
    expect(h.settings.get("PRISM_SYNALUX_API_KEY")).toBe("");
    expect(process.env.PRISM_SYNALUX_API_KEY).toBeUndefined();
  });
});
