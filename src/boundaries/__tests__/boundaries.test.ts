/**
 * boundaries.ts unit tests
 *
 * Verifies structural invariants of the operating boundaries export:
 * - BOUNDARIES_VERSION is present and non-empty
 * - BOUNDARIES_TEXT covers the five required sections
 * - Safety-critical concepts are mentioned (so a future edit doesn't silently
 *   remove them without also bumping the version and updating tests)
 */

import { describe, it, expect } from "vitest";
import { BOUNDARIES_VERSION, BOUNDARIES_TEXT } from "../../boundaries/boundaries.js";

describe("BOUNDARIES_VERSION", () => {
  it("is a non-empty string", () => {
    expect(typeof BOUNDARIES_VERSION).toBe("string");
    expect(BOUNDARIES_VERSION.length).toBeGreaterThan(0);
  });
});

describe("BOUNDARIES_TEXT structure", () => {
  it("is a non-empty string", () => {
    expect(typeof BOUNDARIES_TEXT).toBe("string");
    expect(BOUNDARIES_TEXT.length).toBeGreaterThan(100);
  });

  it("has no leading or trailing whitespace (trim() was applied)", () => {
    expect(BOUNDARIES_TEXT).toBe(BOUNDARIES_TEXT.trim());
  });

  it("contains a safety gates section", () => {
    expect(BOUNDARIES_TEXT).toMatch(/safety gates/i);
  });

  it("contains a BCBA clinical standards section", () => {
    expect(BOUNDARIES_TEXT).toMatch(/bcba/i);
  });

  it("contains a correctness gates section", () => {
    expect(BOUNDARIES_TEXT).toMatch(/correctness gates/i);
  });

  it("contains an inference routing section", () => {
    expect(BOUNDARIES_TEXT).toMatch(/inference routing/i);
  });

  it("contains a host note section", () => {
    expect(BOUNDARIES_TEXT).toMatch(/host note/i);
  });

  it("asserts that enforcement is server-side (not instruction-based)", () => {
    expect(BOUNDARIES_TEXT).toMatch(/server.*enforc|enforc.*server/i);
  });

  it("references the fail-closed rule for reserved + no-cloud", () => {
    expect(BOUNDARIES_TEXT).toMatch(/fail.?closed|refused/i);
  });

  it("states AAC access is never restricted as a consequence", () => {
    expect(BOUNDARIES_TEXT).toMatch(/AAC access is never restricted/i);
  });

  it("references restraint as a RESERVED category", () => {
    expect(BOUNDARIES_TEXT).toMatch(/restraint/i);
    expect(BOUNDARIES_TEXT).toMatch(/RESERVED/i);
  });

  it("mentions session_save_ledger and session_save_handoff in correctness section", () => {
    expect(BOUNDARIES_TEXT).toContain("session_save_ledger");
    expect(BOUNDARIES_TEXT).toContain("session_save_handoff");
  });
});
