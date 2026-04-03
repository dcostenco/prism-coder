import type { AssertionResult, SeverityGateResult, VerificationConfig, SeverityLevel } from "./schema.js";

// ─── v7.2.0: Severity Gate Enforcement ──────────────────────
// Separated from the runner for testability.
//
// Rules:
//  - "warn" failures  → logged, always continue
//  - "gate" failures  → block. Return "block" action with failed assertions list
//  - "abort" failures → immediate abort. Return "abort" action
//
// When PRISM_VERIFICATION_DEFAULT_SEVERITY is set, it overrides
// individual assertion severity levels (acts as a floor).

/**
 * Map severity string to numeric rank for comparison.
 * Higher = more severe.
 */
function severityRank(s: SeverityLevel): number {
  switch (s) {
    case "warn":  return 0;
    case "gate":  return 1;
    case "abort": return 2;
    default: {
      // M4 fix: Exhaustive check — future SeverityLevel additions will cause a compile error
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}

/**
 * Resolve the effective severity for an assertion, considering
 * the global default severity override (acts as a floor).
 */
export function resolveEffectiveSeverity(
  assertionSeverity: SeverityLevel,
  defaultSeverity: SeverityLevel
): SeverityLevel {
  const assertRank = severityRank(assertionSeverity);
  const defaultRank = severityRank(defaultSeverity);
  // Use whichever is more severe (floor behavior)
  return assertRank >= defaultRank ? assertionSeverity : defaultSeverity;
}

/**
 * Evaluate all assertion results against severity gates.
 *
 * Returns a SeverityGateResult indicating the overall action:
 *  - "continue" → all clear, or only "warn"-level failures
 *  - "block"    → at least one "gate"-level failure (no "abort")
 *  - "abort"    → at least one "abort"-level failure
 */
export function evaluateSeverityGates(
  results: AssertionResult[],
  config: VerificationConfig
): SeverityGateResult {
  const failures = results.filter(r => !r.passed && !r.skipped);

  if (failures.length === 0) {
    return {
      action: "continue",
      failed_assertions: [],
      summary: "All assertions passed."
    };
  }

  // Resolve effective severities and categorize failures
  const abortFailures: AssertionResult[] = [];
  const gateFailures: AssertionResult[] = [];
  const warnFailures: AssertionResult[] = [];

  for (const f of failures) {
    const effective = resolveEffectiveSeverity(f.severity, config.default_severity);
    switch (effective) {
      case "abort":
        abortFailures.push(f);
        break;
      case "gate":
        gateFailures.push(f);
        break;
      case "warn":
      default:
        warnFailures.push(f);
        break;
    }
  }

  // Abort takes precedence over gate
  if (abortFailures.length > 0) {
    const ids = abortFailures.map(a => a.id).join(", ");
    return {
      action: "abort",
      failed_assertions: [...abortFailures, ...gateFailures, ...warnFailures],
      summary: `ABORT: ${abortFailures.length} abort-level failure(s) [${ids}]. ` +
               `${gateFailures.length} gate, ${warnFailures.length} warn failures also present.`
    };
  }

  if (gateFailures.length > 0) {
    const ids = gateFailures.map(a => a.id).join(", ");
    return {
      action: "block",
      failed_assertions: [...gateFailures, ...warnFailures],
      summary: `BLOCKED: ${gateFailures.length} gate-level failure(s) [${ids}]. ` +
               `${warnFailures.length} warn-level failures also present.`
    };
  }

  // Only warn-level failures → continue
  return {
    action: "continue",
    failed_assertions: warnFailures,
    summary: `CONTINUE: ${warnFailures.length} warn-level failure(s) logged, no blocking issues.`
  };
}
