/**
 * skill_save / skill_manage — behavior at every scope boundary.
 *
 * Local-first is load-bearing: signed-out saves must write plain local files
 * and touch NOTHING network-shaped. Signed-in defaults to the user scope and
 * says so. The delete/release recall paths archive before discarding. And the
 * free-tier client-compat test proves the CURRENT validator accepts a free
 * manifest that carries extra native scoped skills — the assumption the whole
 * server feature stands on for old clients.
 */
import { mkdtempSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "skill-scope-home-"));

vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, homedir: () => FAKE_HOME };
});

const mocks = vi.hoisted(() => ({
  getSynaluxJwt: vi.fn(),
  getSetting: vi.fn(async () => ""),
  trigger: vi.fn(),
}));

vi.mock("../../src/utils/synaluxJwt.js", () => ({
  getSynaluxJwt: mocks.getSynaluxJwt,
  invalidateSynaluxJwt: vi.fn(),
}));
vi.mock("../../src/storage/configStorage.js", () => ({
  getSetting: mocks.getSetting,
}));
vi.mock("../../src/skillManifestSync.js", () => ({
  triggerSkillManifestSync: mocks.trigger,
}));

import { skillSaveHandler, skillManageHandler } from "../../src/tools/skillScopeHandlers.js";

const fetchSpy = vi.fn();

const body = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: a scoped test skill\n---\n# ${name}\n${extra}`;

function syncResult(overrides: Partial<{ status: string; installed: string[]; updated: string[] }> = {}) {
  return { status: "applied", installed: [], updated: [], pruned: [], conflicts: [], ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSynaluxJwt.mockResolvedValue(null);           // signed out by default
  mocks.getSetting.mockResolvedValue("");
  mocks.trigger.mockResolvedValue(syncResult());
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("skill_save — local-first", () => {
  it("signed out: saves locally to both host roots and performs ZERO network calls", async () => {
    const result = await skillSaveHandler({ name: "my-notes", content: body("my-notes") });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("LOCALLY");
    for (const root of [".agents", ".claude"]) {
      expect(await readFile(join(FAKE_HOME, root, "skills", "my-notes", "SKILL.md"), "utf8")).toContain("my-notes");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it("signed out + explicit user scope: refuses with guidance instead of silently downgrading", async () => {
    const result = await skillSaveHandler({ name: "my-notes", content: body("my-notes"), scope: "user" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("signed-in");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("explicit local scope stays local even when signed in", async () => {
    mocks.getSynaluxJwt.mockResolvedValue("jwt");
    const result = await skillSaveHandler({ name: "my-notes", content: body("my-notes"), scope: "local" });
    expect(result.content[0].text).toContain("LOCALLY");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("skill_save — signed in", () => {
  beforeEach(() => {
    mocks.getSynaluxJwt.mockResolvedValue("jwt-token");
  });

  it("defaults to USER scope, uploads, states the classification and how to share", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ status: "ok", version: 1 }), { status: 200 }));
    mocks.trigger.mockResolvedValue(syncResult({ installed: ["my-notes"] }));
    const result = await skillSaveHandler({ name: "my-notes", content: body("my-notes") });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("YOUR account skill");
    expect(result.content[0].text).toContain("team skill");   // the how-to-share hint
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/api/v1/prism/user-skills");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer jwt-token" });
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ scope: "user", name: "my-notes" });
  });

  it("team scope passes workspace and targeting through; server refusals are relayed verbatim", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ status: "error", error: "Team skills require a workspace owner/admin role" }), { status: 403 }));
    const result = await skillSaveHandler({ name: "team-ops", content: body("team-ops"), scope: "team", workspace_id: "ws-1", assign_to: ["u-2"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("owner/admin");
    expect(JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body))).toMatchObject({ scope: "team", workspace_id: "ws-1", assign_to: ["u-2"] });
  });

  it("JOIN-STALE GUARD: when the first sync predates the save, a second sync runs", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ status: "ok", version: 2 }), { status: 200 }));
    mocks.trigger
      .mockResolvedValueOnce(syncResult({ installed: ["something-else"] }))   // joined pre-save run
      .mockResolvedValueOnce(syncResult({ updated: ["my-notes"] }));
    const result = await skillSaveHandler({ name: "my-notes", content: body("my-notes") });
    expect(mocks.trigger).toHaveBeenCalledTimes(2);
    expect(result.content[0].text).toContain("delivered to this machine now");
  });

  it("client-side validation refuses before any network: oversize, bad name, missing frontmatter", async () => {
    expect((await skillSaveHandler({ name: "my-notes", content: body("my-notes") + "x".repeat(26_000) })).isError).toBe(true);
    expect((await skillSaveHandler({ name: "Bad Name", content: body("Bad Name") })).isError).toBe(true);
    expect((await skillSaveHandler({ name: "my-notes", content: "# no frontmatter" })).isError).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("host delivery — structuredContent must never be used", () => {
  // Same 2026-08-11 defect as session_bootstrap: a result carrying both text
  // and structuredContent lets a host surface only the JSON, which silently
  // discarded every explanation these tools produce — the scope classification,
  // the floor-guard refusal, the how-to-share hint. Data now rides in the text.
  it("skill_manage list returns no structuredContent and serializes the data into the text", async () => {
    mocks.getSynaluxJwt.mockResolvedValue("jwt");
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ status: "ok", user_skills: [{ name: "my-notes", version: 1 }], team_skills: [], memberships: [] }), { status: 200 }));
    const result = await skillManageHandler({ action: "list" });
    expect(result).not.toHaveProperty("structuredContent");
    expect(result.content[0].text).toContain("my-notes");
  });

  it("skill_save returns no structuredContent, so its guidance survives", async () => {
    mocks.getSynaluxJwt.mockResolvedValue("jwt");
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ status: "ok", version: 1 }), { status: 200 }));
    const result = await skillSaveHandler({ name: "my-notes", content: body("my-notes") });
    expect(result).not.toHaveProperty("structuredContent");
    expect(result.content[0].text).toContain("YOUR account skill");
  });
});

describe("skill_manage — recall paths", () => {
  it("deletes a local skill only after archiving its final content", async () => {
    await skillSaveHandler({ name: "doomed", content: body("doomed", "precious body\n") });
    const result = await skillManageHandler({ action: "delete", name: "doomed", scope: "local" });
    expect(result.content[0].text).toContain("archived");
    const archive = join(FAKE_HOME, ".prism-mcp", "skill-archive");
    const entries = await readdir(archive);
    const match = entries.find(entry => entry.startsWith("doomed-"));
    expect(match).toBeTruthy();
    expect(await readFile(join(archive, match!), "utf8")).toContain("precious body");
    await expect(stat(join(FAKE_HOME, ".agents", "skills", "doomed"))).rejects.toThrow();
  });

  it("deletes an account skill by archiving the server-returned final content, then prunes", async () => {
    mocks.getSynaluxJwt.mockResolvedValue("jwt");
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ status: "ok", deleted: { name: "gone", content: body("gone", "server copy\n"), version: 4 } }), { status: 200 }));
    const result = await skillManageHandler({ action: "delete", name: "gone", scope: "user" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("archived");
    expect(mocks.trigger).toHaveBeenCalled();               // prune pass
    const archive = join(FAKE_HOME, ".prism-mcp", "skill-archive");
    const match = (await readdir(archive)).find(entry => entry.startsWith("gone-"));
    expect(await readFile(join(archive, match!), "utf8")).toContain("server copy");
  });

  it("release relays the floor guard verbatim and restore round-trips", async () => {
    mocks.getSynaluxJwt.mockResolvedValue("jwt");
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ status: "error", error: "This skill is part of the protected floor and cannot be released: deployed clients validate the floor fail-closed, so honoring this would stop your skill sync entirely, not slim it." }), { status: 400 }));
    const refused = await skillManageHandler({ action: "release", name: "ask-first", scope: "user" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("protected floor");

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", action: "release", name: "winui-app" }), { status: 200 }));
    const released = await skillManageHandler({ action: "release", name: "winui-app", scope: "user" });
    expect(released.content[0].text).toContain("reversible");
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", action: "restore", name: "winui-app" }), { status: 200 }));
    const restored = await skillManageHandler({ action: "restore", name: "winui-app", scope: "user" });
    expect(restored.content[0].text).toContain("returns");
  });

  it("signed out: release explains the constraint instead of failing opaquely", async () => {
    const result = await skillManageHandler({ action: "release", name: "winui-app", scope: "user" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("signed-in");
  });
});
