import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";
import { renderDashboardHTML } from "../../src/dashboard/ui.js";

const pages: JSDOM[] = [];

afterEach(() => {
  pages.splice(0).forEach(page => page.window.close());
});

async function openProject(projectBody: Record<string, unknown>) {
  const page = new JSDOM(renderDashboardHTML("test"), {
    runScripts: "outside-only",
    url: "http://127.0.0.1:34119/",
    virtualConsole: new VirtualConsole(),
  });
  pages.push(page);
  page.window.vis = { Network: class { on() {} } } as never;
  page.window.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path.startsWith("/api/projects")) {
      return new Response(JSON.stringify({ projects: ["prism-coder"] }), { status: 200 });
    }
    if (path.startsWith("/api/project")) {
      return new Response(JSON.stringify(projectBody), { status: 200 });
    }
    if (path.startsWith("/api/graph")) {
      return new Response(JSON.stringify({ nodes: [], edges: [] }), { status: 200 });
    }
    if (path.startsWith("/api/account")) {
      return new Response(JSON.stringify({ signed_in: false, configured: false, plan: "free" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof page.window.fetch;

  for (const script of page.window.document.querySelectorAll("script:not([src])")) {
    page.window.eval(script.textContent || "");
  }
  await vi.waitFor(() => expect(page.window.document.querySelector('#projectSelect option[value="prism-coder"]')).not.toBeNull());
  const select = page.window.document.getElementById("projectSelect") as HTMLSelectElement;
  select.value = "prism-coder";
  await (page.window as unknown as { loadProject: () => Promise<void> }).loadProject();
  return page.window.document;
}

describe("dashboard project history", () => {
  it.each([true, 1, 'true'])('labels stored rollups as rollups instead of ordinary sessions (%j)', async isRollup => {
    const doc = await openProject({ context: { project: 'prism-coder', last_summary: 'Fixture context' },
      ledger: [{ id: 'rolled', summary: 'Consolidated memory', is_rollup: isRollup, created_at: '2026-10-09T12:00:00Z' },
        { id: 'normal', summary: 'Ordinary activity', is_rollup: false, created_at: '2026-10-08T12:00:00Z' }], history: [] });
    expect([...doc.querySelectorAll('#ledgerTimeline .badge')].map(badge => badge.textContent)).toEqual(['rollup', 'session']);
  });
  it("presents a newer durable session as latest activity while preserving older handoff restore points", async () => {
    const doc = await openProject({
      context: {
        project: "prism-coder",
        version: 2,
        updated_at: "2026-08-27T17:57:41.312341+00:00",
        last_summary: "Shipped prism 20.17.1",
        pending_todo: ["Old handoff TODO"],
      },
      ledger: [{
        id: "latest-session",
        summary: "Released prism 20.21.9 and repaired dashboard access",
        todos: ["Verify the refreshed dashboard"],
        decisions: ["Keep local Free access independent of Synalux auth"],
        created_at: "2026-09-20T12:00:00.000Z",
      }],
      history: [{
        version: 2,
        snapshot: { last_summary: "Shipped prism 20.17.1" },
        created_at: "2026-08-27T17:57:41.492163+00:00",
      }],
    });

    expect(doc.getElementById("summary")?.textContent).toBe("Released prism 20.21.9 and repaired dashboard access");
    expect(doc.getElementById("versionBadge")?.textContent).toBe("latest");
    expect(doc.getElementById("currentStateSource")?.textContent).toContain("Latest session");
    expect(doc.getElementById("todos")?.textContent).toContain("Verify the refreshed dashboard");
    expect(doc.getElementById("todos")?.textContent).not.toContain("Old handoff TODO");
    expect(doc.getElementById("ledgerTimeline")?.textContent).toContain("Released prism 20.21.9");
    expect(doc.getElementById("historyTimeline")?.textContent).toContain("Shipped prism 20.17.1");
    expect(doc.body.textContent).toContain("Recent Sessions");
    expect(doc.body.textContent).toContain("Saved Handoff Versions");
  });

  it("keeps the handoff as current when it is newer than the ledger", async () => {
    const doc = await openProject({
      context: {
        project: "prism-coder",
        version: 3,
        updated_at: "2026-09-21T12:00:00.000Z",
        last_summary: "Newer reviewed handoff",
        pending_todo: ["Current handoff TODO"],
      },
      ledger: [{
        id: "older-session",
        summary: "Older session",
        todos: ["Old session TODO"],
        created_at: "2026-09-20T12:00:00.000Z",
      }],
      history: [],
    });

    expect(doc.getElementById("summary")?.textContent).toBe("Newer reviewed handoff");
    expect(doc.getElementById("versionBadge")?.textContent).toBe("v3");
    expect(doc.getElementById("currentStateSource")?.textContent).toContain("Saved handoff");
    expect(doc.getElementById("todos")?.textContent).toContain("Current handoff TODO");
  });
});
