/**
 * src/boundaries/boundaries.ts
 *
 * Operating boundaries delivered in every session_load_context result.
 *
 * These boundaries are enforced server-side in code (prism_infer safety
 * gates, requireContextLoaded). This text is belt-and-suspenders for a
 * cooperative host — it cannot be removed to bypass enforcement.
 *
 * Update BOUNDARIES_VERSION any time the text changes so session drift
 * detection can flag stale sessions.
 */

export const BOUNDARIES_VERSION = "1";

export const BOUNDARIES_TEXT = `
## OPERATING BOUNDARIES — server-enforced, shown for transparency

### 1. Safety gates (unconditional — run before and after every model call)
- Crisis/self-harm inputs are intercepted before reaching any model.
- BCBA reserved categories (restraint, seclusion, physical management, dosing) route
  to cloud or refuse; they NEVER generate locally. Fail-closed: if cloud is unavailable
  and the prompt is reserved, the request is refused — never downgraded to local.
- Dangerous output (restraint instructions, overdose methods, self-harm guidance)
  is blocked regardless of which host requested it.

### 2. BCBA clinical standards
- Apply ABA principles grounded in the current BACB Ethics Code and Task List (5th Ed).
- Use evidence-based interventions: FCT, DRA, DRO, NCR, antecedent modifications.
- Least restrictive, dignity-preserving, trauma-informed procedures always.
- AAC access is never restricted as a consequence.
- Physical management / restraint / seclusion are RESERVED — cloud only, with audit.

### 3. Correctness gates (project-scoped write tools)
- session_save_ledger and session_save_handoff require a loaded project context
  (conversation_id that called session_load_context successfully).
- This prevents a non-Claude host from writing state it hasn't confirmed.

### 4. Inference routing
- Local inference (Ollama) runs ONLY for OBVIOUS_NOT_RESERVED prompts (Layer 1 verdict).
- RESERVED / UNCERTAIN / classifier errors escalate to cloud. Never downgrade reserved
  prompts to local — that is exactly what Layer 1 flagged.
- Cloud must never be reached directly by a host; all cloud inference routes through
  the Synalux portal for billing, tier-gating, and HIPAA audit.

### 5. Host note
These boundaries are enforced by the server. They apply identically whether the host
is Claude Code, Gemini, an autonomous script, or a cron job. A host that does not read
this text still cannot bypass the enforcement — it is in code, not instructions.
`.trim();
