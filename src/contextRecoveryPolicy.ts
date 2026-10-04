/**
 * Canonical context-recovery contract shared by every host instruction file.
 *
 * Startup is one `session_bootstrap` call. A later save can still be refused
 * with `context_not_loaded`, and the refusal names one remedy; the host block
 * must say the same thing instead of forbidding it. Keep this host-neutral: the
 * Claude Code, Gemini CLI and Codex blocks splice these lines unchanged, and
 * the server instructions, tool descriptions and refusal text state the same
 * rule in their own words (pinned by tests/startup-recovery-contract.test.ts).
 */
export const CONTEXT_RECOVERY_POLICY_LINES = [
  "## Prism context recovery",
  "Startup is the one turn-one `session_bootstrap` call. Prism can still refuse `session_save_ledger` or",
  "`session_save_handoff` with `context_not_loaded`: it has no record that this conversation loaded that project",
  "(after a restart, a long idle gap, or for a project startup did not load). That is a recovery step, not a second",
  "startup. Call `session_load_context` with the same `project` and the same `conversation_id` as the refused save",
  "(the refusal prints the exact call; discover the tool the same way if it is deferred), then retry the save once.",
  "Do not repeat `session_bootstrap` or print a startup display for it. If the reload or the retry fails, tell the",
  "user; a local note is a fallback after that, never a substitute for the reload.",
] as const;

export const CONTEXT_RECOVERY_POLICY_TEXT = CONTEXT_RECOVERY_POLICY_LINES.join(" ");
