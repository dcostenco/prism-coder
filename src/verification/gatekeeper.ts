import { ValidationResult } from "./schema.js";
import { VerificationGateError } from "../errors.js";

interface GatekeeperOptions {
  /** Should the gate forcefully pass despite critical failures? */
  forceBypass?: boolean;
}

export class Gatekeeper {
  /**
   * Reviews a ValidationResult and determines if execution is permitted to continue.
   * Throws `VerificationGateError` strictly on "abort" if bypass isn't provided.
   * 
   * @param result - The output of the VerificationRunner
   * @param options - Configuration including audit bypasses
   * @returns `true` if downstream pipeline execution is allowed
   */
  static executeGate(result: ValidationResult, options?: GatekeeperOptions): { canContinue: boolean, validatedResult: ValidationResult } {
    const isBypass = options?.forceBypass === true;
    const validatedResult = { ...result };

    if (isBypass) {
      console.warn(`\n⚠️  [OVERRIDDEN] Verification Gate bypassed via administrator override.`);
      // Enforce immutability and record audit trail context via environment variables
      validatedResult.gate_override = true;
      const actor = process.env.USER || process.env.USERNAME || 'unknown_user';
      validatedResult.override_reason = validatedResult.override_reason || `CLI --force bypass by ${actor}`;
      return { canContinue: true, validatedResult };
    }

    switch (validatedResult.gate_action) {
      case "continue":
        if (validatedResult.critical_failures > 0) {
          console.warn(`\n⚠️  [CONTINUE] Harness passed but ${validatedResult.critical_failures} critical assertion(s) failed.`);
        }
        return { canContinue: true, validatedResult };
        
      case "block":
        console.error(`\n🚫 [BLOCK] Harness blocked execution. ${(validatedResult.pass_rate * 100).toFixed(1)}% pass rate.`);
        return { canContinue: false, validatedResult };
        
      case "abort":
        console.error(`\n💥 [ABORT] Critical failures detected. Pipeline aborted.`);
        throw new VerificationGateError(
          `Pipeline blocked by verification harness. Gate action evaluated to ABORT. Pass rate: ${(validatedResult.pass_rate * 100).toFixed(1)}%`,
          validatedResult
        );
        
      default:
        console.error(`\n⚠️  [UNKNOWN ACTION] Invalid gate action type: ${validatedResult.gate_action}. Failsafe blocking.`);
        return { canContinue: false, validatedResult };
    }
  }
}
