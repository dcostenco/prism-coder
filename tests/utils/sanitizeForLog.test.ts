import { describe, it, expect } from "vitest";
import { sanitizeForLog } from "../../src/utils/logger.js";

describe("sanitizeForLog", () => {
  it("passes plain ASCII through", () => {
    expect(sanitizeForLog("hello world")).toBe("hello world");
  });

  it("preserves tabs", () => {
    expect(sanitizeForLog("a\tb")).toBe("a\tb");
  });

  it("preserves UTF-8 multibyte characters", () => {
    expect(sanitizeForLog("café 日本語 emoji 🎉")).toBe("café 日本語 emoji 🎉");
  });

  it("replaces newlines with visible marker", () => {
    expect(sanitizeForLog("line1\nline2")).toBe("line1 ⏎ line2");
    expect(sanitizeForLog("line1\r\nline2")).toBe("line1 ⏎ line2");
  });

  it("strips C0 control characters (NUL, SOH, BEL, etc.)", () => {
    expect(sanitizeForLog("a\x00b\x01c\x07d")).toBe("abcd");
  });

  it("strips DEL (0x7F)", () => {
    expect(sanitizeForLog("a\x7Fb")).toBe("ab");
  });

  it("strips C1 control characters (0x80-0x9F)", () => {
    expect(sanitizeForLog("a\x80b\x8Dc\x9Fd")).toBe("abcd");
  });

  it("strips 8-bit CSI (U+009B) — terminal escape via C1", () => {
    expect(sanitizeForLog("\x9B31mred\x9B0m")).toBe("31mred0m");
  });

  it("defangs ANSI CSI escape sequences (ESC stripped by C0 pass)", () => {
    const input = "\x1B[31mred text\x1B[0m";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("\x1B");
    expect(result).toContain("red text");
  });

  it("defangs OSC terminal title hijack (ESC stripped by C0 pass)", () => {
    const input = "\x1B]2;pwned\x07rest";
    const result = sanitizeForLog(input);
    expect(result).not.toContain("\x1B");
    expect(result).not.toContain("\x07");
    expect(result).toContain("rest");
  });

  it("prevents log line forgery via injected newlines", () => {
    const malicious = "normal log\n[ADMIN] Authorized access granted";
    const result = sanitizeForLog(malicious);
    expect(result).not.toContain("\n");
    expect(result).toContain("⏎");
  });
});
