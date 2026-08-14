/**
 * Update-available notice — the missing trigger for self-update.
 *
 * 20.11.x shipped self-update *capability* (`prism connect` converges) with no
 * *trigger*: nothing on any machine runs connect by itself, so releases only
 * reached machines whose operator happened to re-run it. The notice closes
 * that: every session's first turn states when a newer release exists.
 *
 * Contract pinned here (design review 2026-08-14):
 *  - the prompt-critical path NEVER touches the npm registry: the notice
 *    renders from a persisted cache; refresh happens asynchronously and is
 *    kicked from server startup, not from the bootstrap call
 *  - 24-hour cache TTL; strict semver validation; offline silence
 *  - checkout registrations are told `prism connect --refresh` (plain
 *    `connect` leaves a checkout registration untouched)
 */
import { describe, it, expect, vi } from "vitest";
import { getUpdateNotice, refreshUpdateCache, UPDATE_CHECK_KEY } from "../src/updateNotice.js";

function makeStore(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    store,
    getSetting: vi.fn(async (k: string, fallback: string) => store[k] ?? fallback),
    setSetting: vi.fn(async (k: string, v: string) => { store[k] = v; }),
  };
}

const NOW = 1_700_000_000_000;

describe("getUpdateNotice — cache-only, never the network", () => {
  it("shows the notice when the cached latest is newer", async () => {
    const s = makeStore({
      [UPDATE_CHECK_KEY]: JSON.stringify({ checked_at: NOW - 1000, latest: "20.12.0" }),
    });
    const notice = await getUpdateNotice({
      currentVersion: "20.11.1",
      getSetting: s.getSetting,
      now: () => NOW,
    });
    expect(notice).toContain("20.12.0");
    expect(notice).toContain("20.11.1");
    expect(notice).toContain("prism connect");
    expect(notice).not.toContain("--refresh");
  });

  it("tells checkout registrations to run connect --refresh", async () => {
    const s = makeStore({
      [UPDATE_CHECK_KEY]: JSON.stringify({ checked_at: NOW - 1000, latest: "20.12.0" }),
    });
    const notice = await getUpdateNotice({
      currentVersion: "20.11.1",
      getSetting: s.getSetting,
      now: () => NOW,
      runningFrom: "/Users/dev/prism/dist/server.js", // no node_modules → checkout
    });
    expect(notice).toContain("prism connect --refresh");
  });

  it("is silent when current or ahead of the cached latest", async () => {
    const s = makeStore({
      [UPDATE_CHECK_KEY]: JSON.stringify({ checked_at: NOW - 1000, latest: "20.11.1" }),
    });
    expect(await getUpdateNotice({ currentVersion: "20.11.1", getSetting: s.getSetting, now: () => NOW })).toBe("");
    expect(await getUpdateNotice({ currentVersion: "20.12.0", getSetting: s.getSetting, now: () => NOW })).toBe("");
  });

  it("is silent with no cache, an expired cache, corrupt JSON, or a non-semver value", async () => {
    const empty = makeStore();
    expect(await getUpdateNotice({ currentVersion: "20.11.1", getSetting: empty.getSetting, now: () => NOW })).toBe("");

    const expired = makeStore({
      [UPDATE_CHECK_KEY]: JSON.stringify({ checked_at: NOW - 25 * 60 * 60 * 1000, latest: "20.12.0" }),
    });
    expect(await getUpdateNotice({ currentVersion: "20.11.1", getSetting: expired.getSetting, now: () => NOW })).toBe("");

    const corrupt = makeStore({ [UPDATE_CHECK_KEY]: "not-json{" });
    expect(await getUpdateNotice({ currentVersion: "20.11.1", getSetting: corrupt.getSetting, now: () => NOW })).toBe("");

    const evil = makeStore({
      [UPDATE_CHECK_KEY]: JSON.stringify({ checked_at: NOW - 1000, latest: "20.12.0-**bold**injection" }),
    });
    expect(await getUpdateNotice({ currentVersion: "20.11.1", getSetting: evil.getSetting, now: () => NOW })).toBe("");
  });

  it("renders nothing when the caller's own version is unknown", async () => {
    const s = makeStore({
      [UPDATE_CHECK_KEY]: JSON.stringify({ checked_at: NOW - 1000, latest: "20.12.0" }),
    });
    expect(await getUpdateNotice({ currentVersion: "", getSetting: s.getSetting, now: () => NOW })).toBe("");
    expect(await getUpdateNotice({ currentVersion: "0.0.0-dev", getSetting: s.getSetting, now: () => NOW })).toBe("");
  });

  it("respects PRISM_NO_UPDATE_CHECK=1", async () => {
    const s = makeStore({
      [UPDATE_CHECK_KEY]: JSON.stringify({ checked_at: NOW - 1000, latest: "99.0.0" }),
    });
    const notice = await getUpdateNotice({
      currentVersion: "20.11.1",
      getSetting: s.getSetting,
      now: () => NOW,
      env: { PRISM_NO_UPDATE_CHECK: "1" },
    });
    expect(notice).toBe("");
  });
});

describe("refreshUpdateCache — the async half, kicked at server startup", () => {
  it("fetches and persists when the cache is stale", async () => {
    const s = makeStore();
    const fetchLatest = vi.fn(async () => "20.12.0");
    await refreshUpdateCache({
      getSetting: s.getSetting, setSetting: s.setSetting,
      fetchLatest, now: () => NOW,
    });
    expect(fetchLatest).toHaveBeenCalledOnce();
    expect(JSON.parse(s.store[UPDATE_CHECK_KEY])).toEqual({ checked_at: NOW, latest: "20.12.0" });
  });

  it("does NOT fetch while the cache is fresh — one registry ping per TTL, not per session", async () => {
    const s = makeStore({
      [UPDATE_CHECK_KEY]: JSON.stringify({ checked_at: NOW - 60_000, latest: "20.11.1" }),
    });
    const fetchLatest = vi.fn(async () => "20.12.0");
    await refreshUpdateCache({
      getSetting: s.getSetting, setSetting: s.setSetting,
      fetchLatest, now: () => NOW,
    });
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it("offline = silent: a fetch failure writes nothing and never throws", async () => {
    const s = makeStore();
    await expect(refreshUpdateCache({
      getSetting: s.getSetting, setSetting: s.setSetting,
      fetchLatest: async () => { throw new Error("ENOTFOUND registry.npmjs.org"); },
      now: () => NOW,
    })).resolves.toBeUndefined();
    expect(s.store[UPDATE_CHECK_KEY]).toBeUndefined();
  });

  it("rejects a non-semver registry answer instead of caching it", async () => {
    const s = makeStore();
    await refreshUpdateCache({
      getSetting: s.getSetting, setSetting: s.setSetting,
      fetchLatest: async () => "banana",
      now: () => NOW,
    });
    expect(s.store[UPDATE_CHECK_KEY]).toBeUndefined();
  });

  it("respects PRISM_NO_UPDATE_CHECK=1 — no fetch at all", async () => {
    const s = makeStore();
    const fetchLatest = vi.fn(async () => "20.12.0");
    await refreshUpdateCache({
      getSetting: s.getSetting, setSetting: s.setSetting,
      fetchLatest, now: () => NOW,
      env: { PRISM_NO_UPDATE_CHECK: "1" },
    });
    expect(fetchLatest).not.toHaveBeenCalled();
  });
});
