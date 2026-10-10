import { describe, expect, it } from "vitest";
import { DARK_FACTORY_TOOL_NAMES, buildDarkFactoryEnablementState, resolveDarkFactoryEnabled } from "../../src/darkfactory/enablement.js";

describe("Dark Factory startup enablement", () => {
  it("keeps the three Factory tools as one visibility contract", () => {
    expect(DARK_FACTORY_TOOL_NAMES).toEqual([
      "session_start_pipeline",
      "session_check_pipeline_status",
      "session_abort_pipeline",
    ]);
  });
  it("reports saved, active, override, and pending restart independently", () => {
    expect(buildDarkFactoryEnablementState(false, true, undefined)).toEqual({ saved: false, active: true, envOverride: null, pendingRestart: true });
    expect(buildDarkFactoryEnablementState(false, true, "true")).toEqual({ saved: false, active: true, envOverride: true, pendingRestart: false });
    expect(buildDarkFactoryEnablementState(true, false, "false")).toEqual({ saved: true, active: false, envOverride: false, pendingRestart: false });
  });
  it.each([
    [undefined, undefined, true],
    [undefined, "true", true],
    [undefined, "false", false],
    ["true", "false", true],
    ["false", "true", false],
    ["invalid", "false", false],
    ["invalid", undefined, true],
    [undefined, "invalid", true],
  ])("resolves env=%s saved=%s to %s", (env, saved, expected) => {
    expect(resolveDarkFactoryEnabled(env, saved)).toBe(expected);
  });
});
