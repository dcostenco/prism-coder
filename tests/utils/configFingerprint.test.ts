import { describe, it, expect } from "vitest";
import { computeConfigFingerprint } from "../../src/utils/configFingerprint.js";

describe("computeConfigFingerprint", () => {
  it("is stable for the same inputs", () => {
    const env = { PRISM_USER_ID: "u1", PRISM_STORAGE: "local", SUPABASE_URL: "https://x" };
    expect(computeConfigFingerprint(env)).toBe(computeConfigFingerprint(env));
  });

  it("differs when PRISM_USER_ID differs", () => {
    const a = computeConfigFingerprint({ PRISM_USER_ID: "u1", PRISM_STORAGE: "local" });
    const b = computeConfigFingerprint({ PRISM_USER_ID: "u2", PRISM_STORAGE: "local" });
    expect(a).not.toBe(b);
  });

  it("differs when PRISM_STORAGE differs", () => {
    const a = computeConfigFingerprint({ PRISM_USER_ID: "u1", PRISM_STORAGE: "local" });
    const b = computeConfigFingerprint({ PRISM_USER_ID: "u1", PRISM_STORAGE: "supabase" });
    expect(a).not.toBe(b);
  });

  it("differs when SUPABASE_URL differs", () => {
    const a = computeConfigFingerprint({ SUPABASE_URL: "https://a" });
    const b = computeConfigFingerprint({ SUPABASE_URL: "https://b" });
    expect(a).not.toBe(b);
  });

  it("treats an unset variable the same as an empty string", () => {
    const a = computeConfigFingerprint({ PRISM_USER_ID: "" });
    const b = computeConfigFingerprint({});
    expect(a).toBe(b);
  });

  it("differs when PRISM_HDC_ENABLED differs", () => {
    const a = computeConfigFingerprint({ PRISM_HDC_ENABLED: "false" });
    const b = computeConfigFingerprint({ PRISM_HDC_ENABLED: "true" });
    expect(a).not.toBe(b);
  });

  it("differs when PRISM_ENABLE_HIVEMIND differs", () => {
    const a = computeConfigFingerprint({ PRISM_ENABLE_HIVEMIND: "false" });
    const b = computeConfigFingerprint({ PRISM_ENABLE_HIVEMIND: "true" });
    expect(a).not.toBe(b);
  });
});
