/**
 * Canonical local-first orchestration contract shared by every MCP host.
 *
 * Keep this policy host-neutral. Claude Code, Gemini CLI, and Codex also get
 * the same text in their native instruction files; Cursor and Claude Desktop
 * receive it through the MCP initialize instructions and tool metadata.
 */
export const LOCAL_FIRST_POLICY_LINES = [
  "## Prism local-first orchestration",
  "For bounded, verifiable delegated work, use Prism's local worker before any host-native or background subagent.",
  "When session_task_route is available, call it first. If it returns target `claw`, call `prism_infer` with the",
  "recommended arguments, `cloud_fallback: false`, and the `project` and `conversation_id` from this session when known.",
  "Prism loads that project's dashboard-configured quick, standard, or deep memory and selects a RAM-safe local model.",
  "Never create host-native or background subagents for routine work, never fan out, and never nest agents.",
  "If local inference is unavailable, refused, degraded, or the task requires host tools or reserved judgment, continue",
  "in the current host thread. A host-native subagent is a last resort: at most one, no nesting, using the configured",
  "economy model. The current host remains responsible for verifying local output before using it.",
] as const;

export const LOCAL_FIRST_POLICY_ID = "local-first";
export const LOCAL_FIRST_POLICY_TEXT = LOCAL_FIRST_POLICY_LINES.join(" ");
