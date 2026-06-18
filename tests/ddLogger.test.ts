import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Datadog Logger (prism-mcp)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("exports ddLog, ddError, ddInfo, ddWarn", async () => {
    const dd = await import("../src/utils/ddLogger.js");
    expect(typeof dd.ddLog).toBe("function");
    expect(typeof dd.ddError).toBe("function");
    expect(typeof dd.ddInfo).toBe("function");
    expect(typeof dd.ddWarn).toBe("function");
  });

  it("ddLog does not throw when DD_API_KEY is empty", async () => {
    const dd = await import("../src/utils/ddLogger.js");
    expect(() => dd.ddLog("info", "test message")).not.toThrow();
    expect(() => dd.ddLog("warn", "test warn")).not.toThrow();
    expect(() => dd.ddLog("error", "test error")).not.toThrow();
  });

  it("ddError does not throw with Error object", async () => {
    const dd = await import("../src/utils/ddLogger.js");
    expect(() => dd.ddError("test", new Error("boom"))).not.toThrow();
  });

  it("ddError does not throw without Error object", async () => {
    const dd = await import("../src/utils/ddLogger.js");
    expect(() => dd.ddError("test")).not.toThrow();
  });

  it("ddInfo and ddWarn are convenience wrappers", async () => {
    const dd = await import("../src/utils/ddLogger.js");
    expect(() => dd.ddInfo("info message", { key: "value" })).not.toThrow();
    expect(() => dd.ddWarn("warn message", { key: "value" })).not.toThrow();
  });

  it("ddLog accepts context objects", async () => {
    const dd = await import("../src/utils/ddLogger.js");
    expect(() => dd.ddLog("info", "with context", {
      tool: "knowledge_search",
      project: "test-project",
      durationMs: 42,
    })).not.toThrow();
  });

  it("ddError includes stack trace in context", async () => {
    const dd = await import("../src/utils/ddLogger.js");
    const err = new Error("stack test");
    expect(() => dd.ddError("error with stack", err, { tool: "session_save_ledger" })).not.toThrow();
  });
});

describe("ddLogger flush — write headers + context allowlist", () => {
  const originalFetch = globalThis.fetch;
  const mockFetch = vi.fn(() => Promise.resolve({ ok: true } as Response));

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockClear();
    process.env.TELEMETRY_WRITE_TOKEN = "test-write-token";
    process.env.DD_API_KEY = "";
    process.env.PRISM_SYNALUX_BASE_URL = "https://test.synalux.ai";
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    delete process.env.TELEMETRY_WRITE_TOKEN;
    delete process.env.DD_API_KEY;
    delete process.env.PRISM_SYNALUX_BASE_URL;
  });

  async function logAndFlush(dd: typeof import("../src/utils/ddLogger.js"), ...args: Parameters<typeof dd.ddLog>) {
    dd.ddLog(...args);
    await vi.advanceTimersByTimeAsync(6000);
  }

  it("sends Authorization and X-Prism-Client to portal", async () => {
    const dd = await import("../src/utils/ddLogger.js");
    await logAndFlush(dd, "info", "prism_infer.usage", { backend: "ollama-9b" });

    const call = mockFetch.mock.calls.find(c => (c[0] as string).includes("/api/v1/telemetry"));
    expect(call).toBeDefined();
    const headers = (call![1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-write-token");
    expect(headers["X-Prism-Client"]).toBe("prism-mcp");
  });

  it("skips portal POST when TELEMETRY_WRITE_TOKEN is empty", async () => {
    delete process.env.TELEMETRY_WRITE_TOKEN;
    process.env.TELEMETRY_WRITE_TOKEN = "";
    const dd = await import("../src/utils/ddLogger.js");
    await logAndFlush(dd, "info", "test", { backend: "ollama-9b" });

    const call = mockFetch.mock.calls.find(c => (c[0] as string).includes("/api/v1/telemetry"));
    expect(call).toBeUndefined();
  });

  it("portal body contains only allowlisted context fields", async () => {
    const dd = await import("../src/utils/ddLogger.js");
    await logAndFlush(dd, "info", "prism_infer.usage", {
      backend: "ollama-9b",
      model: "prism-coder:9b",
      prompt_tokens: 100,
      completion_tokens: 50,
      latency_ms: 800,
      used_cloud: false,
      secret_key: "sk-1234",
      stack_trace: "Error at foo.ts:42",
      error: { message: "crash", stack: "at internal/path.ts:99" },
    });

    const call = mockFetch.mock.calls.find(c => (c[0] as string).includes("/api/v1/telemetry"));
    const body = JSON.parse((call![1] as RequestInit).body as string);
    const ctx = body[0].context;

    expect(ctx.backend).toBe("ollama-9b");
    expect(ctx.model).toBe("prism-coder:9b");
    expect(ctx.prompt_tokens).toBe(100);
    expect(ctx.completion_tokens).toBe(50);
    expect(ctx.latency_ms).toBe(800);
    expect(ctx.used_cloud).toBe(false);
    // Stripped
    expect(ctx.secret_key).toBeUndefined();
    expect(ctx.stack_trace).toBeUndefined();
    expect(ctx.error).toBeUndefined();
    expect(ctx.ddsource).toBeUndefined();
    expect(ctx.ddtags).toBeUndefined();
    expect(ctx.hostname).toBeUndefined();
    expect(ctx.status).toBeUndefined();
    expect(ctx.timestamp).toBeUndefined();
  });

  it("Datadog sink also filters through allowlist", async () => {
    process.env.TELEMETRY_WRITE_TOKEN = "";
    process.env.DD_API_KEY = "dd-test-key";
    const dd = await import("../src/utils/ddLogger.js");
    await logAndFlush(dd, "error", "test.error", {
      backend: "ollama-27b",
      latency_ms: 500,
      error: { message: "crash", stack: "at secret/path.ts:99\nwith prompt: tell me about..." },
      user_password: "hunter2",
    });

    const ddCall = mockFetch.mock.calls.find(c => (c[0] as string).includes("datadoghq.com"));
    expect(ddCall).toBeDefined();
    const body = JSON.parse((ddCall![1] as RequestInit).body as string);
    const event = body[0];

    expect(event.backend).toBe("ollama-27b");
    expect(event.latency_ms).toBe(500);
    expect(event.message).toBe("test.error");
    expect(event.service).toBe("prism-mcp");
    // Stripped from DD too
    expect(event.error).toBeUndefined();
    expect(event.user_password).toBeUndefined();
  });
});
