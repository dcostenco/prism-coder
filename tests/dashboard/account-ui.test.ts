import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";
import { renderDashboardHTML, renderDashboardLocalOpenHTML } from "../../src/dashboard/ui.js";

const pages: JSDOM[] = [];

afterEach(() => {
  pages.splice(0).forEach(page => page.window.close());
  vi.restoreAllMocks();
});

type AccountFixture = {
  signed_in: boolean;
  configured: boolean;
  name: string | null;
  role_key: string | null;
  plan: string;
  subscription_plan?: string | null;
  plan_source?: string;
  billing_status?: string;
  trial_ends_at?: string | null;
  billing: { action: string; url: string | null };
  auth_url: string;
};

function fixture(plan = "free", overrides: Partial<AccountFixture> = {}): AccountFixture {
  return {
    signed_in: true,
    configured: true,
    name: "Dmitri Costenco",
    role_key: "BCBA",
    plan,
    subscription_plan: plan === "free" ? null : plan,
    plan_source: "stripe",
    billing_status: plan === "free" ? "free" : "active",
    trial_ends_at: null,
    billing: { action: plan === "free" ? "upgrade" : "manage", url: plan === "free" ? "https://synalux.ai/pricing#prism-plans" : null },
    auth_url: "https://synalux.ai/auth?source=prism",
    ...overrides,
  };
}

async function openDashboard(account: AccountFixture | { error: string }, accountStatus = 200) {
  const page = new JSDOM(renderDashboardHTML("test"), {
    runScripts: "outside-only",
    url: "http://127.0.0.1:34119/",
    virtualConsole: new VirtualConsole(),
  });
  pages.push(page);
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const popup = { location: { href: "about:blank" }, close: vi.fn() };
  page.window.open = vi.fn(() => popup as unknown as Window);
  page.window.vis = { Network: class { on() {} } } as never;
  page.window.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, init });
    if (path.startsWith("/api/account/connect") && init?.method === "POST") {
      return new Response(JSON.stringify(fixture("standard")), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path.startsWith("/api/account/billing") && init?.method === "POST") {
      return new Response(JSON.stringify({ url: "https://billing.stripe.com/p/session", action: "manage" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path.startsWith("/api/account/signout") && init?.method === "POST") {
      return new Response(JSON.stringify({ signed_out: true, revoked: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path.startsWith("/api/account")) {
      return new Response(JSON.stringify(account), { status: accountStatus, headers: { "content-type": "application/json" } });
    }
    if (path.startsWith("/api/projects")) return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    if (path.startsWith("/api/settings")) return new Response(JSON.stringify({ settings: {} }), { status: 200 });
    if (path.startsWith("/api/graph")) return new Response(JSON.stringify({ nodes: [], edges: [] }), { status: 200 });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof page.window.fetch;

  for (const script of page.window.document.querySelectorAll("script:not([src])")) {
    page.window.eval(script.textContent || "");
  }
  await vi.waitFor(() => expect(page.window.document.getElementById("identityChip")?.style.display).toBe("flex"));
  return { page, doc: page.window.document, calls, popup };
}

describe("dashboard Account & Subscription UX", () => {
  it("explains local browser access without presenting account redemption as a Free requirement", () => {
    const html = renderDashboardLocalOpenHTML();
    expect(html).toContain("Local dashboard access");
    expect(html).toContain("Open the current Prism dashboard");
    expect(html).toContain("prism dashboard");
    expect(html).toContain("account and plan remain unchanged");
    expect(html).not.toContain("Local Prism Free");
    expect(html).not.toContain("synalux_code_");
  });

  it("makes Account the first settings view while preserving every specialist view", async () => {
    const { page, doc } = await openDashboard(fixture("free"));
    expect(doc.getElementById("stab-account")?.classList.contains("active")).toBe(true);
    expect(doc.getElementById("spanel-account")?.classList.contains("active")).toBe(true);
    expect(["settings", "skills", "providers", "observability"].every(tab => Boolean(doc.getElementById(`stab-${tab}`)))).toBe(true);
    expect(["project", "search", "factory", "vm", "marketplace", "compliance"].every(tab => Boolean(doc.getElementById(`mtab-${tab}`)))).toBe(true);
    expect(page.window.getComputedStyle(doc.querySelector(".main-tabs") as Element).overflowX).toBe("auto");
  });

  it("shows an active signed-out Free state with optional account linking and plan discovery", async () => {
    const { page, doc } = await openDashboard(fixture("free", {
      signed_in: false,
      configured: false,
      name: null,
      role_key: null,
    }));
    expect(doc.getElementById("identityChip")?.textContent).toContain("Free");
    expect(doc.getElementById("accountPanel")?.textContent).toContain("Prism Free");
    expect(doc.getElementById("accountPanel")?.textContent).toContain("No sign-in or redemption is required");
    expect(doc.getElementById("accountPanel")?.textContent).toContain("Link Synalux account");
    expect(doc.getElementById("accountPanel")?.textContent).toContain("View plans");
    expect(doc.getElementById("accountPanel")?.textContent).toContain("Already have a Synalux account-link code? (optional)");
    expect(doc.getElementById("accountCodeInput")).not.toBeNull();
    const details = doc.getElementById("accountConnectDetails") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    (page.window as unknown as { startAccountSignIn: () => void }).startAccountSignIn();
    expect(details.open).toBe(true);
    expect(page.window.open).toHaveBeenCalledWith("https://synalux.ai/auth?source=prism", "_blank", "noopener,noreferrer");
  });

  it("shows the authenticated user, role, Free plan, upgrade action, and sign out", async () => {
    const { doc } = await openDashboard(fixture("free"));
    expect(doc.getElementById("identityChip")?.textContent).toContain("Dmitri Costenco");
    expect(doc.getElementById("identityChip")?.textContent).toContain("Free");
    const accountText = doc.getElementById("accountPanel")?.textContent || "";
    expect(accountText).toContain("Dmitri Costenco");
    expect(accountText).toContain("BCBA");
    expect(accountText).toContain("Start 14-day trial");
    expect(accountText).toContain("Sign out");
  });

  it.each(["standard", "advanced", "enterprise"])("renders the authenticated %s plan and subscription management", async plan => {
    const { doc } = await openDashboard(fixture(plan));
    const text = doc.getElementById("accountPanel")?.textContent || "";
    expect(text).toContain(plan[0].toUpperCase() + plan.slice(1));
    expect(text).toContain("Dmitri Costenco");
    expect(text).toContain("Manage subscription");
    expect(doc.querySelector(`.plan-step.current strong`)?.textContent?.toLowerCase()).toBe(plan);
  });

  it("shows the paid tier, exact trial deadline, consequence, and payment action", async () => {
    const { doc } = await openDashboard(fixture("standard", {
      billing_status: "trialing",
      trial_ends_at: "2026-10-04T16:00:00.000Z",
    }));
    const chip = doc.getElementById("identityChip")?.textContent || "";
    const text = doc.getElementById("accountPanel")?.textContent || "";
    expect(chip).toContain("Standard trial");
    expect(text).toContain("Trial active");
    expect(text).toContain("Standard trial is active through");
    expect(text).toContain("2026");
    expect(text).toContain("otherwise it cancels automatically");
    expect(text).toContain("Add payment details");
  });

  it.each(["past_due", "unpaid", "incomplete", "paused"])("makes %s billing state actionable", async billingStatus => {
    const { doc } = await openDashboard(fixture("advanced", { billing_status: billingStatus }));
    expect(doc.getElementById("identityChip")?.textContent).toContain("Advanced payment due");
    expect(doc.querySelector("#identityChip .plan-mini.attention")).not.toBeNull();
    const text = doc.getElementById("accountPanel")?.textContent || "";
    expect(text).toContain("Payment needs attention");
    expect(text).toContain("Update payment details");
  });

  it("keeps billing recovery clear when Stripe plan lookup is temporarily unavailable", async () => {
    const { doc } = await openDashboard(fixture("free", {
      subscription_plan: "standard",
      billing_status: "unpaid",
      billing: { action: "manage", url: null },
    }));
    expect(doc.getElementById("identityChip")?.textContent).toContain("Payment due");
    const text = doc.getElementById("accountPanel")?.textContent || "";
    expect(text).toContain("Your Standard plan needs billing attention");
    expect(text).toContain("Update payment details");
    expect(text).not.toContain("Your Free plan needs billing attention");
  });

  it("shows a recovered subscription as pending without claiming paid entitlement", async () => {
    const { doc } = await openDashboard(fixture("free", {
      subscription_plan: "standard",
      billing_status: "sync_pending",
      billing: { action: "manage", url: null },
    }));
    expect(doc.getElementById("identityChip")?.textContent).toContain("Standard syncing");
    expect(doc.querySelector("#identityChip .plan-mini.attention")).not.toBeNull();
    const text = doc.getElementById("accountPanel")?.textContent || "";
    expect(text).toContain("Access update pending");
    expect(text).toContain("Stripe confirms your Standard subscription");
    expect(text).toContain("current access remains Free");
    expect(text).toContain("Manage subscription");
    expect(text).not.toContain("Paid");
  });

  it("labels an unverified subscription without claiming the account is paid or trialing", async () => {
    const { doc } = await openDashboard(fixture("standard", {
      billing_status: "unknown",
      billing: { action: "manage", url: null },
    }));
    expect(doc.getElementById("identityChip")?.textContent).toContain("Standard status unavailable");
    const text = doc.getElementById("accountPanel")?.textContent || "";
    expect(text).toContain("Billing status unavailable");
    expect(text).toContain("could not verify the current trial or payment status");
    expect(text).toContain("Manage subscription");
    expect(text).not.toContain("Trial active");
    expect(text).not.toContain("Paid");
  });

  it("distinguishes a managed paid plan from Stripe self-service", async () => {
    const { doc } = await openDashboard(fixture("enterprise", {
      plan_source: "managed",
      billing: { action: "included", url: "https://synalux.ai/pricing" },
    }));
    const text = doc.getElementById("accountPanel")?.textContent || "";
    expect(text).toContain("Managed");
    expect(text).toContain("View plans");
    expect(text).not.toContain("Manage subscription");
  });

  it("shows an account error instead of falsely presenting a configured user as Free", async () => {
    const { doc } = await openDashboard({ error: "Unable to verify current subscription" }, 502);
    expect(doc.getElementById("identityChip")?.textContent).toContain("Account");
    const text = doc.getElementById("accountPanel")?.textContent || "";
    expect(text).toContain("Account temporarily unavailable");
    expect(text).toContain("Unable to verify current subscription");
    expect(text).not.toContain("Prism Free");
  });

  it("connects the pasted one-time code without exposing a credential in the DOM", async () => {
    const { page, doc, calls } = await openDashboard(fixture("free", {
      signed_in: false, configured: false, name: null, role_key: null,
    }));
    const input = doc.getElementById("accountCodeInput") as HTMLInputElement;
    input.value = "synalux_code_fixture";
    await (page.window as unknown as { connectAccount: () => Promise<void> }).connectAccount();
    expect(calls.some(call => call.path === "/api/account/connect" && JSON.parse(String(call.init?.body)).code === "synalux_code_fixture")).toBe(true);
    expect(doc.getElementById("accountPanel")?.textContent).toContain("Standard");
    expect(doc.documentElement.innerHTML).not.toContain("synalux_sk_");
  });

  it("opens the server-validated Stripe Billing Portal URL", async () => {
    const { page, popup, calls } = await openDashboard(fixture("standard"));
    await (page.window as unknown as { openAccountBilling: () => Promise<void> }).openAccountBilling();
    expect(calls.some(call => call.path === "/api/account/billing" && call.init?.method === "POST")).toBe(true);
    expect(popup.location.href).toBe("https://billing.stripe.com/p/session");
  });
});
