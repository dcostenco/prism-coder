/**
 * sessionContext.ts unit tests
 *
 * Covers: markContextLoaded, requireContextLoaded, noteInferenceForSession,
 * getSessionState, TTL eviction, and fail-closed behaviour for unknown sessions.
 *
 * The module uses in-process Map state. Each test imports a fresh module instance
 * via vi.resetModules() + dynamic re-import so tests are isolated without needing
 * an exported reset function.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import type { GateResult } from "../../session/sessionContext.js";
import { BOUNDARIES_VERSION } from "../../boundaries/boundaries.js";
import { SESSION_LOAD_CONTEXT_TOOL } from "../../tools/sessionMemoryDefinitions.js";

const receiptStore = vi.hoisted(() => {
  type Receipt = {
    conversationHash: string;
    projectHash: string;
    project: string;
    boundariesVersion: string;
    loadedAt: number;
    lastSeen: number;
  };
  const rows = new Map<string, Receipt>();
  return {
    rows,
    save: vi.fn(async (receipt: Receipt, expiresBefore: number) => {
      for (const [key, row] of rows) {
        if (row.lastSeen < expiresBefore) rows.delete(key);
      }
      rows.set(`${receipt.conversationHash}:${receipt.projectHash}`, receipt);
    }),
    get: vi.fn(async (conversationHash: string, projectHash: string) =>
      rows.get(`${conversationHash}:${projectHash}`) ?? null),
  };
});

vi.mock("../../storage/configStorage.js", () => ({
  saveSessionContextReceipt: receiptStore.save,
  getSessionContextReceipt: receiptStore.get,
}));

// Reset module registry before each test so the in-memory Map starts empty.
let markContextLoaded: (conversationId: string, project: string, version: string) => void;
let requireContextLoaded: (conversationId: string | undefined) => GateResult;
let registerContextLoaded: (conversationId: string, project: string, version: string) => Promise<void>;
let requireContextLoadedForProject: (
  conversationId: string | undefined,
  project: string,
) => Promise<GateResult>;
let noteInferenceForSession: (conversationId: string, info: { backend: string; usedCloud: boolean }) => void;
let getSessionState: (conversationId: string) => unknown;

beforeEach(async () => {
  receiptStore.rows.clear();
  receiptStore.save.mockClear();
  receiptStore.get.mockClear();
  vi.resetModules();
  const mod = await import("../../session/sessionContext.js");
  markContextLoaded = mod.markContextLoaded;
  requireContextLoaded = mod.requireContextLoaded;
  registerContextLoaded = (mod as any).registerContextLoaded;
  requireContextLoadedForProject = (mod as any).requireContextLoadedForProject;
  noteInferenceForSession = mod.noteInferenceForSession;
  getSessionState = mod.getSessionState;
});

describe("requireContextLoaded — fail-closed defaults", () => {
  it("blocks an unknown conversation (never seen)", () => {
    const result = requireContextLoaded("never-seen-id");
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
    if (result && result.blocked) expect(result.error).toContain("context_not_loaded");
  });

  it("allows (returns null) when conversation_id is undefined — gate is opt-in", () => {
    // Callers without a conversation_id (auto-push hosts, resource readers,
    // legacy clients) are not gated — they use the session-agnostic interface.
    const result = requireContextLoaded(undefined);
    expect(result).toBeNull();
  });

  it("blocks (hard) when conversation_id is empty string — empty string is not opt-in bypass", () => {
    // "" is not the same as undefined. An empty string means the caller explicitly
    // provided a conversation_id but it's invalid. The gate should block, not bypass.
    const result = requireContextLoaded("");
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
    if (result && result.blocked) expect(result.error).toContain("context_not_loaded");
  });

  it("blocks a session by unknown id even if noteInference was called for it", () => {
    // noteInferenceForSession no longer creates stubs, so an unregistered id
    // is still unknown to the gate.
    noteInferenceForSession("conv-telemetry-only", { backend: "local", usedCloud: false });
    const result = requireContextLoaded("conv-telemetry-only");
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });
});

describe("markContextLoaded → requireContextLoaded lifecycle", () => {
  it("returns null (pass) after markContextLoaded is called", () => {
    markContextLoaded("conv-abc", "project-x", BOUNDARIES_VERSION);
    expect(requireContextLoaded("conv-abc")).toBeNull();
  });

  it("records project and boundariesVersion on the session", () => {
    markContextLoaded("conv-meta", "my-project", "42");
    const state = getSessionState("conv-meta") as any;
    expect(state).not.toBeNull();
    expect(state.project).toBe("my-project");
    expect(state.boundariesVersion).toBe("42");
    expect(state.contextLoaded).toBe(true);
  });

  it("is idempotent — calling twice does not break state", () => {
    // Use the actual BOUNDARIES_VERSION so no drift warning fires.
    markContextLoaded("conv-idem", "proj", BOUNDARIES_VERSION);
    markContextLoaded("conv-idem", "proj-updated", BOUNDARIES_VERSION);
    const state = getSessionState("conv-idem") as any;
    expect(state.project).toBe("proj-updated");
    expect(state.boundariesVersion).toBe(BOUNDARIES_VERSION);
    expect(requireContextLoaded("conv-idem")).toBeNull();
  });

  it("isolates sessions — loading one does not unblock another", () => {
    markContextLoaded("conv-A", "proj", BOUNDARIES_VERSION);
    expect(requireContextLoaded("conv-A")).toBeNull();
    expect(requireContextLoaded("conv-B")).not.toBeNull();
  });
});

describe("durable project-scoped context recovery", () => {
  it("recovers a loaded project after process-local state is lost", async () => {
    await registerContextLoaded("private-conversation-id", "project-a", BOUNDARIES_VERSION);

    expect(receiptStore.save).toHaveBeenCalledTimes(1);
    const persisted = receiptStore.save.mock.calls[0][0];
    expect(persisted.conversationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted.projectHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(persisted)).not.toContain("private-conversation-id");

    vi.resetModules();
    const restarted = await import("../../session/sessionContext.js");
    const result = await (restarted as any).requireContextLoadedForProject(
      "private-conversation-id",
      "project-a",
    );

    expect(result).toBeNull();
    expect((restarted.getSessionState("private-conversation-id") as any)?.project).toBe("project-a");
  });

  it("does not let a valid conversation receipt authorize another project", async () => {
    await registerContextLoaded("conversation-a", "project-a", BOUNDARIES_VERSION);

    vi.resetModules();
    const restarted = await import("../../session/sessionContext.js");
    const result = await (restarted as any).requireContextLoadedForProject(
      "conversation-a",
      "project-b",
    );

    expect(result).toMatchObject({ blocked: true });
    if (result?.blocked) expect(result.error).toContain("context_not_loaded");
  });

  it("recovers each project loaded by a multi-project bootstrap", async () => {
    await registerContextLoaded("multi-project-conversation", "project-a", BOUNDARIES_VERSION);
    await registerContextLoaded("multi-project-conversation", "project-b", BOUNDARIES_VERSION);

    vi.resetModules();
    const restarted = await import("../../session/sessionContext.js");
    await expect((restarted as any).requireContextLoadedForProject(
      "multi-project-conversation",
      "project-a",
    )).resolves.toBeNull();
    await expect((restarted as any).requireContextLoadedForProject(
      "multi-project-conversation",
      "project-b",
    )).resolves.toBeNull();
  });

  it("fails closed on a project mismatch when durable storage is unavailable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await registerContextLoaded("conversation-a", "project-a", "old-boundaries");
    receiptStore.get.mockRejectedValueOnce(new Error("config DB unavailable"));

    const result = await requireContextLoadedForProject("conversation-a", "project-b");

    expect(result).toMatchObject({ blocked: true });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("lookup failed"));
    errorSpy.mockRestore();
  });

  it("keeps unknown conversation ids fail-closed", async () => {
    const result = await requireContextLoadedForProject("forged-conversation", "project-a");

    expect(result).toMatchObject({ blocked: true });
    expect(receiptStore.get).toHaveBeenCalledTimes(1);
  });

  it("rejects an expired durable receipt", async () => {
    await registerContextLoaded("expired-conversation", "project-a", BOUNDARIES_VERSION);
    const [key, receipt] = [...receiptStore.rows.entries()][0];
    receiptStore.rows.set(key, {
      ...receipt,
      loadedAt: Date.now() - (8 * 60 * 60 * 1000),
      lastSeen: Date.now() - (7 * 60 * 60 * 1000),
    });

    vi.resetModules();
    const restarted = await import("../../session/sessionContext.js");
    const result = await (restarted as any).requireContextLoadedForProject(
      "expired-conversation",
      "project-a",
    );

    expect(result).toMatchObject({ blocked: true });
    if (result?.blocked) expect(result.error).toContain("expired");
  });

  it("rejects a receipt whose stored project does not match its lookup scope", async () => {
    await registerContextLoaded("conversation-a", "project-a", BOUNDARIES_VERSION);
    const [key, receipt] = [...receiptStore.rows.entries()][0];
    receiptStore.rows.set(key, { ...receipt, project: "project-b" });

    vi.resetModules();
    const restarted = await import("../../session/sessionContext.js");
    const result = await (restarted as any).requireContextLoadedForProject(
      "conversation-a",
      "project-a",
    );

    expect(result).toMatchObject({ blocked: true });
  });

  it("preserves the session-agnostic opt-out when conversation_id is omitted", async () => {
    await expect(requireContextLoadedForProject(undefined, "project-a")).resolves.toBeNull();
    expect(receiptStore.get).not.toHaveBeenCalled();
  });
});

describe("noteInferenceForSession", () => {
  it("increments inferenceCalls on every call", () => {
    markContextLoaded("conv-inf", "proj", BOUNDARIES_VERSION);
    noteInferenceForSession("conv-inf", { backend: "local", usedCloud: false });
    noteInferenceForSession("conv-inf", { backend: "local", usedCloud: false });
    const state = getSessionState("conv-inf") as any;
    expect(state.inferenceCalls).toBe(2);
  });

  it("increments usedCloudCalls only for cloud calls", () => {
    markContextLoaded("conv-cloud", "proj", BOUNDARIES_VERSION);
    noteInferenceForSession("conv-cloud", { backend: "cloud", usedCloud: true });
    noteInferenceForSession("conv-cloud", { backend: "local", usedCloud: false });
    const state = getSessionState("conv-cloud") as any;
    expect(state.inferenceCalls).toBe(2);
    expect(state.usedCloudCalls).toBe(1);
  });

  it("does NOT create a ghost stub for an unregistered session — only updates existing sessions", () => {
    // noteInferenceForSession used to call getOrInit, creating stub entries
    // with contextLoaded=false for every conversation_id that infers.
    // Ghost stubs accumulate in the LRU and crowd out real sessions.
    // The fix: no-op when the session doesn't exist yet.
    noteInferenceForSession("conv-new-via-note", { backend: "local", usedCloud: false });
    expect(getSessionState("conv-new-via-note")).toBeNull();
  });
});

describe("getSessionState", () => {
  it("returns null for an unknown session", () => {
    expect(getSessionState("does-not-exist")).toBeNull();
  });

  it("returns the current state object for a known session", () => {
    markContextLoaded("conv-get", "proj", BOUNDARIES_VERSION);
    const state = getSessionState("conv-get") as any;
    expect(state).not.toBeNull();
    expect(state.contextLoaded).toBe(true);
  });
});

describe("lastSeen update", () => {
  it("updates lastSeen on every requireContextLoaded call", async () => {
    markContextLoaded("conv-ts", "proj", BOUNDARIES_VERSION);
    const before = (getSessionState("conv-ts") as any).lastSeen;
    // Advance time by mocking Date.now via vi.useFakeTimers
    vi.useFakeTimers();
    vi.advanceTimersByTime(5000);
    requireContextLoaded("conv-ts");
    const after = (getSessionState("conv-ts") as any).lastSeen;
    vi.useRealTimers();
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

describe("every refusal names the same recovery", () => {
  // Three refusal variants exist (nothing registered, project not registered,
  // idle past the TTL). They used to name two different calls and no retry, and
  // the managed host blocks forbade one of them. One constant now feeds all three.
  const REMEDY = [
    "To recover, call session_load_context with the same project and the same conversation_id you passed to this save",
    "then retry the save once",
    "You do not need to repeat session_bootstrap",
    "A recovery load is not a second startup",
    "If the retry is refused too, stop and tell the user",
  ];

  type Variant = "nothing registered" | "project not registered" | "idle past the TTL";

  async function refusals(conversationOf: Record<Variant, string>, project = "project-a"): Promise<Record<Variant, string>> {
    const errorOf = (result: GateResult): string => {
      expect(result).toMatchObject({ blocked: true });
      return result && result.blocked ? result.error : "";
    };

    // A conversation that registered a project and then sat idle for 7 h.
    await registerContextLoaded(conversationOf["idle past the TTL"], project, BOUNDARIES_VERSION);
    const [idleKey, idleRow] = [...receiptStore.rows.entries()][0];
    receiptStore.rows.set(idleKey, {
      ...idleRow,
      loadedAt: Date.now() - (8 * 60 * 60 * 1000),
      lastSeen: Date.now() - (7 * 60 * 60 * 1000),
    });

    // A restarted server: no in-memory state, only the stale receipt above.
    vi.resetModules();
    const gate = (await import("../../session/sessionContext.js")) as any;

    const idle = errorOf(await gate.requireContextLoadedForProject(conversationOf["idle past the TTL"], project));
    const nothingRegistered = errorOf(await gate.requireContextLoadedForProject(conversationOf["nothing registered"], project));
    await gate.registerContextLoaded(conversationOf["project not registered"], "project-a", BOUNDARIES_VERSION);
    const projectNotRegistered = errorOf(
      await gate.requireContextLoadedForProject(conversationOf["project not registered"], "project-b"),
    );

    return {
      "nothing registered": nothingRegistered,
      "project not registered": projectNotRegistered,
      "idle past the TTL": idle,
    };
  }

  const IDS: Record<Variant, string> = {
    "nothing registered": "never-loaded",
    "project not registered": "live-conversation",
    "idle past the TTL": "idle-conversation",
  };
  const PROJECT_OF: Record<Variant, string> = {
    "nothing registered": "project-a",
    "project not registered": "project-b",
    "idle past the TTL": "project-a",
  };

  // What each variant says is wrong, ahead of the shared remedy. The last two are the
  // established wording; the first is new (the bare generic text said nothing).
  const LEAD = {
    "nothing registered": "context_not_loaded: no context is registered for this conversation. To recover,",
    "project not registered": "context_not_loaded: the requested project was not loaded for this conversation. To recover,",
    "idle past the TTL": "context_not_loaded: session expired (6 h TTL). To recover,",
  } as const;

  it.each(["nothing registered", "project not registered", "idle past the TTL"] as const)(
    "%s: the refusal states the recovery, the retry, and that recovery is not a second startup",
    async (variant) => {
      const text = (await refusals(IDS))[variant];
      expect(text.startsWith(LEAD[variant]), `${variant} starts: ${text.slice(0, 120)}`).toBe(true);
      for (const part of REMEDY) expect(text, `${variant} lacks: ${part}`).toContain(part);
    },
  );

  it.each(["nothing registered", "project not registered", "idle past the TTL"] as const)(
    "%s: the refusal prints the literal call, built from the refused save's own arguments",
    async (variant) => {
      const text = (await refusals(IDS))[variant];
      const match = text.match(/ Exact call: session_load_context\((\{.*?\})\)\. \(Enforced/);
      expect(match, `no exact call in: ${text}`).not.toBeNull();
      expect(JSON.parse(match![1])).toEqual({
        project: PROJECT_OF[variant],
        conversation_id: IDS[variant],
        toolAction: "Reload context",
        toolSummary: "Recover from context_not_loaded",
      });
    },
  );

  it("keeps the established closing line on every refusal", async () => {
    for (const text of Object.values(await refusals(IDS))) {
      expect(text.endsWith("(Enforced server-side — applies to every host.)")).toBe(true);
    }
  });

  it("never asks the agent to repeat startup instead of recovering", async () => {
    for (const text of Object.values(await refusals(IDS))) {
      expect(text).not.toMatch(/Call session_bootstrap\(conversation_id\) or/);
      expect(text).toContain("it reloads only the dashboard Auto-Load projects and reprints the startup display");
    }
  });

  it("escapes what it echoes, never prints a clipped call, and prints no call without a project", async () => {
    // a hostile value that fits is echoed whole and JSON-escaped
    const hostile = 'p"q\n}); drop; ' + "x".repeat(100);
    const result = await requireContextLoadedForProject("conv-hostile", hostile);
    expect(result).toMatchObject({ blocked: true });
    const text = result && result.blocked ? result.error : "";
    const call = text.match(/ Exact call: session_load_context\((\{.*?\})\)\. \(Enforced/);
    expect(call, text).not.toBeNull();
    expect(JSON.parse(call![1]).project).toBe(hostile);
    expect(text).not.toContain("\n});");
    // a value too long to echo gets the remedy but no literal call: a clipped
    // value would register the wrong project and the retry would stay refused
    for (const [conv, project] of [["conv-long", "y".repeat(201)], ["c".repeat(201), "project-a"]]) {
      const long = await requireContextLoadedForProject(conv, project);
      const longText = long && long.blocked ? long.error : "";
      expect(longText).toContain("To recover, call session_load_context");
      expect(longText).not.toContain("Exact call:");
    }
    // a blank project is refused without a literal call (there is nothing to pass)
    const blank = await requireContextLoadedForProject("conv-blank", "  ");
    expect(blank && blank.blocked ? blank.error : "").not.toContain("Exact call:");
    // an empty conversation_id is refused too, with no literal call
    const noConv = await requireContextLoadedForProject("", "project-a");
    expect(noConv && noConv.blocked ? noConv.error : "").not.toContain("Exact call:");
  });

  it("guard: echoes a value at the limit whole, and executing that call unlocks the refused save", async () => {
    const project = "z".repeat(200);
    const refused = await requireContextLoadedForProject("conv-limit", project);
    const text = refused && refused.blocked ? refused.error : "";
    const call = JSON.parse(text.match(/ Exact call: session_load_context\((\{.*?\})\)\. \(Enforced/)![1]);
    expect(call.project).toBe(project);
    await registerContextLoaded(call.conversation_id, call.project, BOUNDARIES_VERSION);
    expect(await requireContextLoadedForProject("conv-limit", project)).toBeNull();
  });

  it("refuses an empty conversation_id with a reason the agent can act on", async () => {
    const result = await requireContextLoadedForProject("", "project-a");
    expect(result).toMatchObject({ blocked: true });
    const text = result && result.blocked ? result.error : "";
    expect(text).toMatch(/^context_not_loaded: conversation_id is empty/);
    expect(text).toContain("<prism_session />");
    // "the same conversation_id you passed" can never work when it was empty
    expect(text).not.toContain("the same conversation_id you passed");
  });

  it("names parameters the recovery tool really has, and the call it prints sets every required one", async () => {
    const schema = SESSION_LOAD_CONTEXT_TOOL.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["project", "conversation_id"]));
    const text = (await refusals(IDS))["nothing registered"];
    const call = JSON.parse(text.match(/ Exact call: session_load_context\((\{.*?\})\)\. \(Enforced/)![1]);
    for (const required of schema.required) expect(call, `missing required ${required}`).toHaveProperty(required);
  });

  it("leaves the gate's decisions alone: the same inputs pass or fail exactly as before", async () => {
    await expect(requireContextLoadedForProject(undefined, "project-a")).resolves.toBeNull();
    await registerContextLoaded("decided", "project-a", BOUNDARIES_VERSION);
    await expect(requireContextLoadedForProject("decided", "project-a")).resolves.toBeNull();
    await expect(requireContextLoadedForProject("decided", "project-b")).resolves.toMatchObject({ blocked: true });
    await expect(requireContextLoadedForProject("decided", "Project-A")).resolves.toMatchObject({ blocked: true });
    await expect(requireContextLoadedForProject("", "project-a")).resolves.toMatchObject({ blocked: true });
  });
});
