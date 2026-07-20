/**
 * src/boundaries/boundaries.ts
 *
 * Safety declaration text and version tracking.
 *
 * DELIVERY DECISION (R18, explicit):
 * The safety text is delivered via the MCP server `instructions` field
 * (loaded once at connection). It is NOT injected per-call into
 * session_load_context — the per-call banner was removed in R15/R16
 * because the enforcement is in code (Layer 1 classifier + keyword
 * backstop + fail-closed refusal), not in the banner text.
 *
 * Some MCP clients don't surface `instructions` to the model. This is
 * accepted: the code gates catch everything regardless. The text is
 * defense-in-depth for cooperative hosts, not the enforcement mechanism.
 *
 * BOUNDARIES_VERSION is still used by markContextLoaded for session
 * drift detection — bump it when the safety contract changes.
 */

export const BOUNDARIES_VERSION = "4";

export const BOUNDARIES_TEXT = `
Safety boundaries are enforced in code — shown so hosts avoid wasted round-trips.

- **Crisis/self-harm** inputs are intercepted before reaching any model.
- **BCBA reserved categories** (restraint, seclusion, physical management, dosing): Layer 1 classifies; RESERVED/UNCERTAIN escalate to cloud or are refused. A keyword backstop covers classifier failure; oversize prompts get a full-text keyword scan + excerpt classification.
- **Dangerous output** (restraint instructions, overdose methods, self-harm guidance) is blocked regardless of host.
- AAC access is never restricted as a consequence.
`.trim();
