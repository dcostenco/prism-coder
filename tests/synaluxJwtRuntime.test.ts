import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  PRISM_SYNALUX_BASE_URL: "",
  PRISM_SYNALUX_API_KEY: "",
}));

import {
  _resetSynaluxJwtForTest,
  getSynaluxJwt,
} from "../src/utils/synaluxJwt.js";

beforeEach(() => {
  _resetSynaluxJwtForTest();
  delete process.env.PRISM_SYNALUX_BASE_URL;
  delete process.env.PRISM_SYNALUX_API_KEY;
  vi.restoreAllMocks();
});

afterEach(() => {
  delete process.env.PRISM_SYNALUX_BASE_URL;
  delete process.env.PRISM_SYNALUX_API_KEY;
});

describe("Synalux JWT runtime credentials", () => {
  it("recognizes credentials injected after config module initialization", async () => {
    process.env.PRISM_SYNALUX_BASE_URL = "https://runtime.synalux.test";
    process.env.PRISM_SYNALUX_API_KEY = "synalux_sk_runtime";
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ jwt: "runtime-jwt", expires_in: 900 }), { status: 200 }),
    );

    await expect(getSynaluxJwt()).resolves.toBe("runtime-jwt");
    expect(request).toHaveBeenCalledWith(
      "https://runtime.synalux.test/api/v1/auth/jwt",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer synalux_sk_runtime" }),
      }),
    );
  });

  it("does not attempt an exchange without credentials", async () => {
    const request = vi.spyOn(globalThis, "fetch");

    await expect(getSynaluxJwt()).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});
