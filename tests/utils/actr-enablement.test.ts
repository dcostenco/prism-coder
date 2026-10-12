import { beforeEach, describe, expect, it, vi } from "vitest";
const { settings } = vi.hoisted(() => ({ settings: { value: undefined as string | undefined } }));
vi.mock("../../src/storage/configStorage.js", () => ({ getSettingSync: (_: string, fallback: string) => settings.value ?? fallback }));
describe("automatic ACT-R enablement", () => {
  beforeEach(() => { vi.resetModules(); settings.value = undefined; delete process.env.PRISM_ACTR_ENABLED; });
  it("enables ranking automatically without dashboard or environment setup", async () => {
    const state = await import("../../src/utils/actrEnablement.js");
    expect(state.isActrEnabled()).toBe(true); expect(state.actrEnablementState()).toEqual({ saved:true,active:true,envOverride:null,pendingRestart:false });
  });
  it("preserves a saved opt-out across startup and freezes it until restart", async () => {
    settings.value = "false"; const state = await import("../../src/utils/actrEnablement.js");
    expect(state.initializeActrEnabled()).toBe(false); settings.value = "true";
    expect(state.isActrEnabled()).toBe(false); expect(state.actrEnablementState().pendingRestart).toBe(true);
    expect(state.initializeActrEnabled()).toBe(true);
  });
  it.each(["true","false"])("honors explicit %s environment precedence", async env => {
    process.env.PRISM_ACTR_ENABLED = env; settings.value = env === "true" ? "false" : "true";
    const state = await import("../../src/utils/actrEnablement.js"); expect(state.isActrEnabled()).toBe(env === "true"); expect(state.actrEnablementState().pendingRestart).toBe(false);
    delete process.env.PRISM_ACTR_ENABLED;
  });
});
