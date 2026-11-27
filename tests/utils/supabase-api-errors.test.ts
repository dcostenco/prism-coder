import { afterEach, describe, expect, it, vi } from "vitest";
import { SupabaseHttpError, supabaseGet } from "../../src/utils/supabaseApi.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Supabase REST error metadata", () => {
  it("preserves a PostgREST code without weakening the existing error message", async () => {
    const body = JSON.stringify({
      code: "42703",
      details: null,
      hint: null,
      message: "column session_handoffs_history.workspace_id does not exist",
    });
    vi.stubEnv("SUPABASE_URL", "https://fixture.supabase.test");
    vi.stubEnv("SUPABASE_KEY", "fixture-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status: 400,
      statusText: "Bad Request",
      headers: { "content-type": "application/json" },
    })));

    const failure = await supabaseGet("session_handoffs_history", { workspace_id: "is.null" })
      .catch(error => error as unknown);

    expect(failure).toBeInstanceOf(SupabaseHttpError);
    expect(failure).toMatchObject({ status: 400, statusText: "Bad Request", code: "42703", body });
    expect((failure as Error).message).toContain("Supabase GET /rest/v1/session_handoffs_history failed: 400 Bad Request");
    expect((failure as Error).message).toContain(body);
  });
});
