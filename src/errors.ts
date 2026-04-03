import { ValidationResult } from "./verification/schema.js";

/**
 * Thrown when a verification harness gate action evaluates to "abort".
 * Indicates a strict security or operational policy failure that should halt
 * downstream execution immediately.
 */
export class VerificationGateError extends Error {
  public readonly result: ValidationResult;

  constructor(message: string, result: ValidationResult) {
    super(message);
    this.name = "VerificationGateError";
    this.result = result;

    // Maintain V8 stack trace natively
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, VerificationGateError);
    }
  }

  /**
   * Helper to dump the JSON representation of the failure block for logs.
   */
  public toJSON() {
    return {
      message: this.message,
      project: this.result.project,
      critical_failures: this.result.critical_failures,
      pass_rate: this.result.pass_rate,
      result_json: this.result.result_json,
    };
  }
}
