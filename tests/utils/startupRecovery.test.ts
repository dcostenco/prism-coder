import { describe, expect, it } from "vitest";
import { isRecoverableStartupStorageError } from "../../src/utils/startupRecovery.js";

const TRANSIENT_STORAGE_ERRORS = [
  "[SynaluxStorage] /api/v1/prism/memory failed: Rate limit exceeded",
  "[Prism Storage] Could not verify the Synalux cloud-memory entitlement",
  "Network error calling https://synalux.ai/api/v1/prism/memory",
  "fetch failed",
  "Request timed out",
] as const;

const NON_TRANSIENT_STARTUP_ERRORS = [
  "Invalid arguments for session_bootstrap",
  "Unexpected context formatter failure",
  "session_bootstrap returned no display content",
  "[SynaluxStorage] /api/v1/prism/memory failed: Forbidden",
  "[SynaluxStorage] /api/v1/prism/memory failed: HTTP 403",
  "[SynaluxStorage] /api/v1/prism/memory failed: Invalid project",
] as const;

describe("startup storage recovery classification", () => {
  it.each(TRANSIENT_STORAGE_ERRORS)("allows local last-good startup for transient storage failure: %s", (message) => {
    expect(isRecoverableStartupStorageError(new Error(message))).toBe(true);
  });

  it.each(NON_TRANSIENT_STARTUP_ERRORS)("keeps programmer and validation failures loud: %s", (message) => {
    expect(isRecoverableStartupStorageError(new Error(message))).toBe(false);
  });
});
