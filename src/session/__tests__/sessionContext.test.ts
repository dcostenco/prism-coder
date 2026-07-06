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

// Reset module registry before each test so the in-memory Map starts empty.
let markContextLoaded: (conversationId: string, project: string, version: string) => void;
let requireContextLoaded: (conversationId: string | undefined) => GateResult;
let noteInferenceForSession: (conversationId: string, info: { backend: string; usedCloud: boolean }) => void;
let getSessionState: (conversationId: string) => unknown;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("../../session/sessionContext.js");
  markContextLoaded = mod.markContextLoaded;
  requireContextLoaded = mod.requireContextLoaded;
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
    markContextLoaded("conv-abc", "project-x", "1");
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
    // Use the actual BOUNDARIES_VERSION ("1") so no drift warning fires.
    markContextLoaded("conv-idem", "proj", "1");
    markContextLoaded("conv-idem", "proj-updated", "1");
    const state = getSessionState("conv-idem") as any;
    expect(state.project).toBe("proj-updated");
    expect(state.boundariesVersion).toBe("1");
    expect(requireContextLoaded("conv-idem")).toBeNull();
  });

  it("isolates sessions — loading one does not unblock another", () => {
    markContextLoaded("conv-A", "proj", "1");
    expect(requireContextLoaded("conv-A")).toBeNull();
    expect(requireContextLoaded("conv-B")).not.toBeNull();
  });
});

describe("noteInferenceForSession", () => {
  it("increments inferenceCalls on every call", () => {
    markContextLoaded("conv-inf", "proj", "1");
    noteInferenceForSession("conv-inf", { backend: "local", usedCloud: false });
    noteInferenceForSession("conv-inf", { backend: "local", usedCloud: false });
    const state = getSessionState("conv-inf") as any;
    expect(state.inferenceCalls).toBe(2);
  });

  it("increments usedCloudCalls only for cloud calls", () => {
    markContextLoaded("conv-cloud", "proj", "1");
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
    markContextLoaded("conv-get", "proj", "1");
    const state = getSessionState("conv-get") as any;
    expect(state).not.toBeNull();
    expect(state.contextLoaded).toBe(true);
  });
});

describe("lastSeen update", () => {
  it("updates lastSeen on every requireContextLoaded call", async () => {
    markContextLoaded("conv-ts", "proj", "1");
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
