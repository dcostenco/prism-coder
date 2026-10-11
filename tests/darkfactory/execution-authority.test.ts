import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pipeline = (id = "p-" + Math.random().toString(36).slice(2)) => ({ id, project: "fixture", user_id: "owner", started_at: "2026-10-10T00:00:00.000Z", spec: { objective: "bounded", maxIterations: 1 } });
let configPath: string;
const originalConfigPath = process.env.PRISM_CONFIG_PATH;
let mod: typeof import("../../src/storage/configStorage.js");

beforeEach(async () => {
  vi.resetModules();
  configPath = join(mkdtempSync(join(tmpdir(), "factory-authority-")), "config.db");
  process.env.PRISM_CONFIG_PATH = configPath;
  mod = await import("../../src/storage/configStorage.js");
  await mod.initConfigStorage();
});
afterEach(() => { mod.closeConfigStorage(); if(originalConfigPath===undefined)delete process.env.PRISM_CONFIG_PATH;else process.env.PRISM_CONFIG_PATH=originalConfigPath; });

describe("Factory execution authority", () => {
  it("requires an exact local receipt and survives module restart", async () => {
    const p = pipeline();
    expect(await mod.isFactoryAuthorized(p)).toBe(false);
    await mod.registerFactoryAuthority(p);
    expect(await mod.isFactoryAuthorized(p)).toBe(true);
    expect(await mod.isFactoryAuthorized({ ...p, started_at: "2026-10-10T00:00:00+00:00" })).toBe(true);
    expect(await mod.isFactoryAuthorized({ ...p, project: "foreign" })).toBe(false);
    await expect(mod.registerFactoryAuthority({ ...p, spec: { changed: true } })).rejects.toThrow(/fingerprint mismatch/);
    mod.closeConfigStorage();
    await mod.initConfigStorage();
    expect(await mod.isFactoryAuthorized(p)).toBe(true);
  });

  it("allows only one concurrent lease and rejects stale token operations", async () => {
    const p = pipeline(); await mod.registerFactoryAuthority(p);
    const [a, b] = await Promise.all([mod.claimFactoryLease(p), mod.claimFactoryLease(p)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const lease = a ?? b; expect(lease).toBeTruthy();
    expect(await lease!.renew()).toBe(true);
    expect(await lease!.isHeld()).toBe(true);
    await lease!.release();
    const next = await mod.claimFactoryLease(p); expect(next).toBeTruthy();
    expect(await lease!.renew()).toBe(false);
    expect(await lease!.isHeld()).toBe(false);
    await next!.release();
  });

  it("permits a fresh claim after expiry and preserves the receipt boundary", async () => {
    const p = pipeline(); await mod.registerFactoryAuthority(p);
    const old = await mod.claimFactoryLease(p, 1); expect(old).toBeTruthy();
    await new Promise(resolve => setTimeout(resolve, 5));
    const fresh = await mod.claimFactoryLease(p, 1000); expect(fresh).toBeTruthy();
    expect(fresh!.reclaimed).toBe(true);
    expect(await old!.renew()).toBe(false);
    expect(await mod.claimFactoryLease({ ...p, user_id: "foreign" })).toBe(null);
    await fresh!.release();
  });

  it("keeps recovery sticky after a failed lifecycle write and lease release", async () => {
    const p=pipeline();await mod.registerFactoryAuthority(p);
    const first=await mod.claimFactoryLease(p,1);await new Promise(r=>setTimeout(r,5));
    const takeover=await mod.claimFactoryLease(p,1000);expect(takeover!.reclaimed).toBe(true);
    await takeover!.release(); // The runner's FAILED write lost CAS; no acknowledgement.
    const retry=await mod.claimFactoryLease(p,1000);expect(retry!.reclaimed).toBe(true);
    await first!.acknowledgeRecovery(); // A stale token cannot clear the recovery fence.
    await retry!.release();
    const next=await mod.claimFactoryLease(p,1000);expect(next!.reclaimed).toBe(true);
    await next!.acknowledgeRecovery();await next!.release();
    const cleared=await mod.claimFactoryLease(p,1000);expect(cleared!.reclaimed).toBe(false);await cleared!.release();
  });

  it("does not authorize the same cloud job from a second machine's config", async () => {
    const p=pipeline();await mod.registerFactoryAuthority(p);mod.closeConfigStorage();
    process.env.PRISM_CONFIG_PATH=join(mkdtempSync(join(tmpdir(),'factory-other-host-')),'config.db');vi.resetModules();
    mod=await import('../../src/storage/configStorage.js');await mod.initConfigStorage();
    expect(await mod.isFactoryAuthorized(p)).toBe(false);expect(await mod.claimFactoryLease(p)).toBeNull();
  });
});
