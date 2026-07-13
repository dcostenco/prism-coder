/**
 * boundaries.ts unit tests
 *
 * Verifies structural invariants of the safety declaration:
 * - BOUNDARIES_VERSION is present and non-empty
 * - BOUNDARIES_TEXT covers safety-critical concepts
 * - Architecture/routing docs moved to server instructions (not per-call)
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
  it("is a non-empty string under 500 chars (compressed from ~2000)", () => {
    expect(typeof BOUNDARIES_TEXT).toBe("string");
    expect(BOUNDARIES_TEXT.length).toBeGreaterThan(50);
    expect(BOUNDARIES_TEXT.length).toBeLessThan(600);
  });

  it("has no leading or trailing whitespace (trim() was applied)", () => {
    expect(BOUNDARIES_TEXT).toBe(BOUNDARIES_TEXT.trim());
  });

  it("references BCBA reserved categories", () => {
    expect(BOUNDARIES_TEXT).toMatch(/BCBA reserved/i);
  });

  it("references fail-closed refusal for reserved content", () => {
    expect(BOUNDARIES_TEXT).toMatch(/refused/i);
  });

  it("states AAC access is never restricted as a consequence", () => {
    expect(BOUNDARIES_TEXT).toMatch(/AAC access is never restricted/i);
  });

  it("references restraint as reserved", () => {
    expect(BOUNDARIES_TEXT).toMatch(/restraint/i);
  });

  it("references crisis/self-harm interception", () => {
    expect(BOUNDARIES_TEXT).toMatch(/crisis|self-harm/i);
  });

  it("does NOT contain architecture/routing docs (those moved to server instructions)", () => {
    expect(BOUNDARIES_TEXT).not.toContain("session_save_ledger");
    expect(BOUNDARIES_TEXT).not.toContain("inference routing");
    expect(BOUNDARIES_TEXT).not.toMatch(/host note/i);
  });
});
