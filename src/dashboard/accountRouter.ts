import type * as http from "node:http";
import { invalidateEntitlements } from "../utils/entitlements.js";
import { getSynaluxJwt, invalidateSynaluxJwt } from "../utils/synaluxJwt.js";
import { resolvePortalBaseUrl, usablePortalKey } from "../utils/synaluxSearch.js";
import { isSynaluxSignedOut, setSynaluxSignedOut } from "../utils/synaluxCredentialState.js";
import { upgradeInsecureCloudUrl } from "../utils/secureUrl.js";

const DEFAULT_PORTAL_URL = "https://synalux.ai";
const MAX_BODY_BYTES = 16 * 1024;
const VALID_PLANS = new Set(["free", "standard", "advanced", "enterprise"]);
const VALID_BILLING_STATUSES = new Set([
  "free", "trialing", "active", "past_due", "unpaid", "canceled",
  "incomplete", "incomplete_expired", "paused", "managed", "unknown", "sync_pending",
]);
const VALID_PAID_PLANS = new Set(["standard", "advanced", "enterprise"]);
let accountMutationQueue: Promise<void> = Promise.resolve();

async function serializeAccountMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = accountMutationQueue;
  let release!: () => void;
  accountMutationQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
  }
}

type Fetcher = typeof fetch;
type GetSetting = typeof import("../storage/configStorage.js").getSetting;
type SetSetting = typeof import("../storage/configStorage.js").setSetting;

export interface DashboardAccount {
  signed_in: boolean;
  configured: boolean;
  name: string | null;
  role_key: string | null;
  plan: "free" | "standard" | "advanced" | "enterprise";
  subscription_plan?: "standard" | "advanced" | "enterprise" | null;
  plan_source?: "stripe" | "managed";
  billing_status?: "free" | "trialing" | "active" | "past_due" | "unpaid" | "canceled" | "incomplete" | "incomplete_expired" | "paused" | "managed" | "unknown" | "sync_pending";
  trial_ends_at?: string | null;
  billing: { action: "upgrade" | "manage" | "included"; url: string | null };
  auth_url: string;
}

export interface AccountRouterDeps {
  fetcher: Fetcher;
  getSetting: GetSetting;
  setSetting: SetSetting;
  getJwt: typeof getSynaluxJwt;
  invalidateJwt: typeof invalidateSynaluxJwt;
  invalidateEntitlements: typeof invalidateEntitlements;
  closeStorage: () => Promise<void>;
  resolvePortalBaseUrl: typeof resolvePortalBaseUrl;
  usablePortalKey: typeof usablePortalKey;
}

const defaultDeps: AccountRouterDeps = {
  fetcher: fetch,
  getSetting: async (key, defaultValue) => (await import("../storage/configStorage.js")).getSetting(key, defaultValue),
  setSetting: async (key, value) => (await import("../storage/configStorage.js")).setSetting(key, value),
  getJwt: getSynaluxJwt,
  invalidateJwt: invalidateSynaluxJwt,
  invalidateEntitlements,
  closeStorage: async () => (await import("../storage/index.js")).closeStorage(),
  resolvePortalBaseUrl,
  usablePortalKey,
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "private, no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function safePortalOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const upgraded = upgradeInsecureCloudUrl(raw.trim());
    const parsed = new URL(upgraded);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname))) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

async function portalOrigin(deps: AccountRouterDeps): Promise<string> {
  return safePortalOrigin(deps.resolvePortalBaseUrl())
    ?? safePortalOrigin(await deps.getSetting("PRISM_SYNALUX_BASE_URL", ""))
    ?? safePortalOrigin(await deps.getSetting("SYNALUX_BASE_URL", ""))
    ?? DEFAULT_PORTAL_URL;
}

async function applyStoredSignOut(deps: AccountRouterDeps): Promise<boolean> {
  const signedOut = (await deps.getSetting("PRISM_SYNALUX_SIGNED_OUT", "")) === "true";
  setSynaluxSignedOut(signedOut);
  if (signedOut) delete process.env.PRISM_SYNALUX_API_KEY;
  return signedOut;
}

function authUrl(origin: string): string {
  return `${origin}/auth?source=prism`;
}

function signedOutAccount(origin: string): DashboardAccount {
  return {
    signed_in: false,
    configured: false,
    name: null,
    role_key: null,
    plan: "free",
    subscription_plan: null,
    billing_status: "free",
    trial_ends_at: null,
    billing: { action: "upgrade", url: `${origin}/pricing#prism-plans` },
    auth_url: authUrl(origin),
  };
}

function normalizeAccount(value: unknown, origin: string): DashboardAccount {
  if (!value || typeof value !== "object") throw new Error("Portal returned an invalid account response");
  const raw = value as Record<string, unknown>;
  const plan = typeof raw.plan === "string" && VALID_PLANS.has(raw.plan) ? raw.plan : "free";
  const billingRaw = raw.billing && typeof raw.billing === "object"
    ? raw.billing as Record<string, unknown>
    : {};
  const action = billingRaw.action === "manage" || billingRaw.action === "included"
    ? billingRaw.action
    : "upgrade";
  const url = typeof billingRaw.url === "string" && isAllowedBillingUrl(billingRaw.url, origin)
    ? billingRaw.url
    : null;
  const rawBillingStatus = typeof raw.billing_status === "string" && VALID_BILLING_STATUSES.has(raw.billing_status)
    ? raw.billing_status as DashboardAccount["billing_status"]
    : plan === "free" ? "free" : "unknown";
  const subscriptionPlan = typeof raw.subscription_plan === "string" && VALID_PAID_PLANS.has(raw.subscription_plan)
    ? raw.subscription_plan as DashboardAccount["subscription_plan"]
    : null;
  const billingStatus = rawBillingStatus === "sync_pending" && subscriptionPlan === null
    ? "unknown"
    : rawBillingStatus;
  const trialEndsAt = typeof raw.trial_ends_at === "string" && Number.isFinite(Date.parse(raw.trial_ends_at))
    ? new Date(raw.trial_ends_at).toISOString()
    : null;
  return {
    signed_in: raw.signed_in === true,
    configured: true,
    name: typeof raw.name === "string" ? raw.name.slice(0, 160) : null,
    role_key: typeof raw.role_key === "string" ? raw.role_key.slice(0, 80) : null,
    plan: plan as DashboardAccount["plan"],
    subscription_plan: subscriptionPlan,
    plan_source: raw.plan_source === "managed" ? "managed" : "stripe",
    billing_status: billingStatus,
    trial_ends_at: billingStatus === "trialing" || billingStatus === "sync_pending" ? trialEndsAt : null,
    billing: { action, url },
    auth_url: authUrl(origin),
  };
}

function isAllowedBillingUrl(raw: string, origin: string): boolean {
  try {
    const url = new URL(raw);
    return url.origin === origin
      || (url.protocol === "https:" && url.hostname === "billing.stripe.com");
  } catch {
    return false;
  }
}

async function accountWithJwt(deps: AccountRouterDeps, origin: string): Promise<DashboardAccount> {
  let jwt = await deps.getJwt();
  if (!jwt || isSynaluxSignedOut()) throw new Error("Synalux sign-in expired. Sign in again.");

  const send = (token: string) => deps.fetcher(`${origin}/api/v1/prism/account`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, "X-Prism-Client": "prism-dashboard" },
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });

  let response = await send(jwt);
  if (isSynaluxSignedOut()) throw new Error("Synalux account is signed out");
  if (response.status === 401) {
    deps.invalidateJwt();
    jwt = await deps.getJwt();
    if (!jwt) throw new Error("Synalux sign-in expired. Sign in again.");
    response = await send(jwt);
    if (isSynaluxSignedOut()) throw new Error("Synalux account is signed out");
  }
  if (!response.ok) throw new Error(`Unable to load Synalux account (HTTP ${response.status})`);
  const data = await response.json();
  if (isSynaluxSignedOut()) throw new Error("Synalux account is signed out");
  return normalizeAccount(data, origin);
}

export async function loadDashboardAccount(overrides: Partial<AccountRouterDeps> = {}): Promise<DashboardAccount> {
  const deps = { ...defaultDeps, ...overrides };
  const origin = await portalOrigin(deps);
  if (await applyStoredSignOut(deps)) return signedOutAccount(origin);
  if (!deps.usablePortalKey()) return signedOutAccount(origin);
  return accountWithJwt(deps, origin);
}

async function revokeRawToken(deps: AccountRouterDeps, origin: string, token: string): Promise<boolean> {
  try {
    const response = await deps.fetcher(`${origin}/api/v1/prism/account`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "X-Prism-Client": "prism-dashboard" },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    return response.ok || response.status === 401;
  } catch {
    return false;
  }
}

export async function connectDashboardAccount(code: unknown, overrides: Partial<AccountRouterDeps> = {}): Promise<DashboardAccount> {
  return serializeAccountMutation(async () => {
  const deps = { ...defaultDeps, ...overrides };
  if (typeof code !== "string" || !code.startsWith("synalux_code_") || code.length > 256) {
    throw new Error("Enter a valid one-time Prism sign-in code");
  }
  const origin = await portalOrigin(deps);
  const response = await deps.fetcher(`${origin}/api/v1/auth/code-exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Prism-Client": "prism-dashboard" },
    body: JSON.stringify({ code, client: "prism" }),
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Prism sign-in failed");
  const token = typeof data.api_token === "string" ? data.api_token : "";
  if (!token.startsWith("synalux_sk_") || token.length > 512) {
    throw new Error("Portal returned an invalid Prism credential");
  }

  try {
    await deps.setSetting("PRISM_SYNALUX_BASE_URL", origin);
    await deps.setSetting("PRISM_SYNALUX_API_KEY", token);
    await deps.setSetting("PRISM_SYNALUX_SIGNED_OUT", "false");
  } catch (error) {
    await revokeRawToken(deps, origin, token);
    await deps.setSetting("PRISM_SYNALUX_SIGNED_OUT", "true").catch(() => {});
    await deps.setSetting("PRISM_SYNALUX_API_KEY", "").catch(() => {});
    throw new Error(`Could not save Prism sign-in: ${error instanceof Error ? error.message : String(error)}`);
  }

  setSynaluxSignedOut(false);
  process.env.PRISM_SYNALUX_BASE_URL = origin;
  process.env.PRISM_SYNALUX_API_KEY = token;
  deps.invalidateJwt();
  deps.invalidateEntitlements();
  await deps.closeStorage();
  return accountWithJwt(deps, origin);
  });
}

export async function openDashboardBilling(overrides: Partial<AccountRouterDeps> = {}): Promise<{ url: string; action: string }> {
  const deps = { ...defaultDeps, ...overrides };
  const origin = await portalOrigin(deps);
  if (await applyStoredSignOut(deps) || !deps.usablePortalKey()) {
    return { url: `${origin}/pricing#prism-plans`, action: "upgrade" };
  }
  let jwt = await deps.getJwt();
  if (!jwt || isSynaluxSignedOut()) throw new Error("Synalux sign-in expired. Sign in again.");
  const send = (token: string) => deps.fetcher(`${origin}/api/v1/prism/account`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Prism-Client": "prism-dashboard" },
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  let response = await send(jwt);
  if (isSynaluxSignedOut()) throw new Error("Synalux account is signed out");
  if (response.status === 401) {
    deps.invalidateJwt();
    jwt = await deps.getJwt();
    if (!jwt) throw new Error("Synalux sign-in expired. Sign in again.");
    response = await send(jwt);
    if (isSynaluxSignedOut()) throw new Error("Synalux account is signed out");
  }
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (isSynaluxSignedOut()) throw new Error("Synalux account is signed out");
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `Billing unavailable (HTTP ${response.status})`);
  if (typeof data.url !== "string" || !isAllowedBillingUrl(data.url, origin)) {
    throw new Error("Portal returned an unsafe billing URL");
  }
  return { url: data.url, action: typeof data.action === "string" ? data.action : "manage" };
}

export async function signOutDashboardAccount(overrides: Partial<AccountRouterDeps> = {}): Promise<{ signed_out: true; revoked: boolean }> {
  return serializeAccountMutation(async () => {
  const deps = { ...defaultDeps, ...overrides };
  const origin = await portalOrigin(deps);
  const token = deps.usablePortalKey() ?? (await deps.getSetting("PRISM_SYNALUX_API_KEY", "")).trim();

  // Cut off every local credential path before waiting on the network. The
  // storage singleton captures its refresh token at construction, so clearing
  // only process.env would leave an already-created backend signed in.
  setSynaluxSignedOut(true);
  delete process.env.PRISM_SYNALUX_API_KEY;
  deps.invalidateJwt();
  deps.invalidateEntitlements();
  await deps.setSetting("PRISM_SYNALUX_SIGNED_OUT", "true");
  await deps.setSetting("PRISM_SYNALUX_API_KEY", "");
  await deps.closeStorage();

  const revoked = token ? await revokeRawToken(deps, origin, token) : true;
  return { signed_out: true, revoked };
  });
}

export async function handleAccountRoutes(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (url.pathname === "/api/account" && req.method === "GET") {
    try {
      json(res, 200, await loadDashboardAccount());
    } catch (error) {
      json(res, 502, { error: error instanceof Error ? error.message : "Unable to load account" });
    }
    return true;
  }
  if (url.pathname === "/api/account/connect" && req.method === "POST") {
    try {
      const body = await readJson(req);
      json(res, 200, await connectDashboardAccount(body.code));
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : "Prism sign-in failed" });
    }
    return true;
  }
  if (url.pathname === "/api/account/billing" && req.method === "POST") {
    try {
      json(res, 200, await openDashboardBilling());
    } catch (error) {
      json(res, 502, { error: error instanceof Error ? error.message : "Billing unavailable" });
    }
    return true;
  }
  if (url.pathname === "/api/account/signout" && req.method === "POST") {
    try {
      const result = await signOutDashboardAccount();
      json(res, result.revoked ? 200 : 502, {
        ...result,
        ...(result.revoked ? {} : { warning: "Signed out locally, but remote token revocation could not be confirmed" }),
      });
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : "Sign-out failed" });
    }
    return true;
  }
  return false;
}
