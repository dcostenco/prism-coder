/**
 * projectResolver — the save-path gate that was measured DROPPING data.
 *
 * Incident 2026-08-13: session_save_ledger hard-rejected legitimate saves
 * with contradictory verdicts ("declared X but files indicate Y", then
 * "declared Y but files indicate Z" on identical input). Root cause on the
 * live machine's registry: an auto-created row whose repo_path was the HOME
 * DIRECTORY — every absolute path matches — plus five relative-path rows
 * ("Tests/UITests", "src/__tests__"). Auto-create wrote junk, the
 * validator treated junk as authoritative, and the hard-reject turned a
 * taxonomy heuristic into data loss — in a memory product.
 *
 * The contract these tests pin: the resolver NEVER refuses a write, and
 * auto-create can no longer register junk.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const settings: Record<string, string> = {};
vi.mock("../src/storage/configStorage.js", () => ({
  getAllSettings: vi.fn(async () => ({ ...settings })),
  setSetting: vi.fn(async (k: string, v: string) => { settings[k] = v; }),
}));

import { resolveProject } from "../src/utils/projectResolver.js";

beforeEach(() => { for (const k of Object.keys(settings)) delete settings[k]; });

describe("a memory product never refuses the write", () => {
  it("mismatch WARNS and saves under the DECLARED project — never ok:false", async () => {
    settings["repo_path:other-project"] = "/Users/dev/work/repo";
    const r = await resolveProject("my-project", ["/Users/dev/work/repo/src/a.ts"]);
    expect(r.ok).toBe(true);
    expect(r.project).toBe("my-project"); // the agent's declaration wins
    expect(r.warning).toMatch(/other-project/); // the heuristic advises
    expect(r.warning).toMatch(/my-project/);
  });

  it("a poisoned home-dir registry row cannot hijack saves into a rejection", async () => {
    // The live poison shape: one entry containing every absolute path.
    settings["repo_path:catch-all"] = "/Users/dev";
    const r = await resolveProject("prism-mcp", ["/Users/dev/prism/src/cli.ts"]);
    expect(r.ok).toBe(true);
    expect(r.project).toBe("prism-mcp");
  });

  it("agreement stays clean — no warning", async () => {
    settings["repo_path:prism-mcp"] = "/Users/dev/prism";
    const r = await resolveProject("prism-mcp", ["/Users/dev/prism/src/cli.ts"]);
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it("no files_changed → declared project accepted, nothing registered", async () => {
    const r = await resolveProject("anything", []);
    expect(r.ok).toBe(true);
    expect(Object.keys(settings)).toHaveLength(0);
  });
});

describe("auto-create hygiene — the junk that poisoned the live registry", () => {
  it("never registers a RELATIVE prefix (live junk shape: 'Tests/UITests')", async () => {
    await resolveProject("coach-app", ["Tests/UITests/a.swift", "Tests/UITests/b.swift"]);
    expect(settings["repo_path:coach-app"]).toBeUndefined();
  });

  it("never registers a 2-segment path (live junk shape: a home directory)", async () => {
    await resolveProject("broad", ["/Users/dev/x.txt", "/Users/dev/y.txt"]);
    expect(settings["repo_path:broad"]).toBeUndefined();
  });

  it("never registers an ANCESTOR of an existing entry — one broad row poisons every later save", async () => {
    settings["repo_path:existing"] = "/Users/dev/work/repo";
    await resolveProject("umbrella", ["/Users/dev/work/a.txt", "/Users/dev/work/b.txt"]);
    expect(settings["repo_path:umbrella"]).toBeUndefined();
  });

  it("still registers a legitimate absolute repo root", async () => {
    const r = await resolveProject("new-proj", [
      "/Users/dev/work/new-proj/src/a.ts",
      "/Users/dev/work/new-proj/src/b.ts",
    ]);
    expect(r.ok).toBe(true);
    expect(r.autoCreated).toBe(true);
    expect(settings["repo_path:new-proj"]).toBe("/Users/dev/work/new-proj/src");
  });
});

describe("derivation semantics preserved", () => {
  it("longest repo_path wins so nested repos resolve to the nested project", async () => {
    settings["repo_path:mono"] = "/Users/dev/mono";
    settings["repo_path:mono-sub"] = "/Users/dev/mono/packages/sub";
    const r = await resolveProject("mono-sub", ["/Users/dev/mono/packages/sub/x.ts"]);
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined(); // nested match agrees with declaration
  });
});
