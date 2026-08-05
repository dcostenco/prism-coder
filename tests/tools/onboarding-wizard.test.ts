/**
 * The wizard is the first tool a brand-new user touches (the first-run
 * greeting routes here). Before 2026-08-05 it was doubly broken: the schema
 * required `action` (so the documented bare call was the first error a new
 * user ever saw), and the handler read `{step, responses}` — fields the
 * validator never passed — so `next`/`status`/`skip` all silently rendered
 * step 1. These tests pin the advertised action contract to real behavior.
 */
import { describe, expect, it } from "vitest";
import { onboardingWizardHandler } from "../../src/tools/v12Handlers.js";

function parse(result: { content: Array<{ text?: string }>; isError?: boolean }) {
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0].text ?? "{}");
}

describe("onboarding_wizard action contract", () => {
  it("treats a bare call as start — the first-run front door must never error", async () => {
    const body = parse(await onboardingWizardHandler({}));
    expect(body.status).toBe("in_progress");
    expect(body.total_steps).toBe(8);
    expect(body.step).toBeTruthy();
  });

  it("start and explicit action:'start' agree", async () => {
    const bare = parse(await onboardingWizardHandler({}));
    const explicit = parse(await onboardingWizardHandler({ action: "start" }));
    expect(explicit.current_step).toBe(bare.current_step);
    expect(bare.step_index).toBe(0);
  });

  it("next advances past the supplied step_index instead of re-rendering step 1", async () => {
    const first = parse(await onboardingWizardHandler({ action: "start" }));
    const second = parse(await onboardingWizardHandler({ action: "next", step: first.step_index }));
    expect(second.status).toBe("in_progress");
    expect(second.step_index).toBeGreaterThan(first.step_index);
    expect(second.current_step).not.toBe(first.current_step);
  });

  it("status re-renders the supplied step_index without advancing", async () => {
    const first = parse(await onboardingWizardHandler({ action: "start" }));
    const advanced = parse(await onboardingWizardHandler({ action: "next", step: first.step_index }));
    const status = parse(await onboardingWizardHandler({ action: "status", step: advanced.step_index }));
    expect(status.current_step).toBe(advanced.current_step);
    expect(status.step_index).toBe(advanced.step_index);
  });

  it("skip completes the wizard", async () => {
    const body = parse(await onboardingWizardHandler({ action: "skip" }));
    expect(body.status).toBe("completed");
  });

  it("still rejects a malformed action or negative step", async () => {
    for (const args of [{ action: "bogus" }, { step: -1 }, { action: 42 }]) {
      const result = await onboardingWizardHandler(args as Record<string, unknown>);
      expect(result.isError).toBe(true);
    }
  });
});
