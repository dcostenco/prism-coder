/**
 * src/boundaries/boundaries.ts
 *
 * Safety declaration delivered in every session_load_context result.
 * Architecture/routing documentation lives in the MCP server description
 * (loaded once at connection, not per-call).
 *
 * The safety gates (Layer 1 classifier, cloud routing, fail-closed refusal)
 * are enforced in code — this text is defense-in-depth so cooperative hosts
 * avoid drafting reserved content that would be refused at the gate.
 *
 * Update BOUNDARIES_VERSION any time the text changes so session drift
 * detection can flag stale sessions.
 */

export const BOUNDARIES_VERSION = "2";

export const BOUNDARIES_TEXT = `
Safety boundaries are enforced in code — shown so hosts avoid wasted round-trips.

- **Crisis/self-harm** inputs are intercepted before reaching any model.
- **BCBA reserved categories** (restraint, seclusion, physical management, dosing) route to cloud or are refused. They are NEVER generated locally. If cloud is unavailable and the prompt is reserved, the request is refused — never downgraded to local.
- **Dangerous output** (restraint instructions, overdose methods, self-harm guidance) is blocked regardless of host.
- AAC access is never restricted as a consequence.
`.trim();
