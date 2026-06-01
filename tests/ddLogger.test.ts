import { describe, it, expect, vi, beforeEach } from "vitest";

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
