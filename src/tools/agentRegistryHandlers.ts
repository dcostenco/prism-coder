/**
 * Agent Registry Handlers (v3.0 — Agent Hivemind)
 *
 * Handler implementations for the 3 agent registry MCP tools.
 * These are only called when PRISM_ENABLE_HIVEMIND=true.
 */

import { getStorage } from "../storage/index.js";
import { PRISM_USER_ID } from "../config.js";
import { getRoleIcon } from "./agentRegistryDefinitions.js";
import { getSetting } from "../storage/configStorage.js";

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Escape markdown metacharacters in user-controlled strings.
 *
 * Fields like `current_task`, `agent_name`, and `status` are user-provided
 * and may contain characters (* _ ` [ etc.) that would corrupt the markdown
 * formatting of agent_list_team output. We escape the most common ones to
 * keep the display predictable without being overly aggressive.
 *
 * This is a display-integrity fix, not a security fix — MCP response text
 * is rendered in the LLM's context where injection risk is low, but broken
 * formatting reduces readability and can misguide the model.
 */
function escapeMd(str: string | null | undefined): string {
  if (!str) return "";
  return str
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    // HTML angle-bracket escaping: prevents raw tags (e.g. <script> in agent
    // names) from bleeding into LLM context as markup.
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Returns a human-readable "time ago" string for a heartbeat timestamp.
 *
 * Clamped to prevent negative or NaN outputs due to:
 *   - Clock skew between agents (heartbeat appears in the future)
 *   - Malformed ISO strings that produce NaN from Date.parse()
 * Fallback returns "just now" to avoid exposing confusing negative values.
 */
function getTimeAgo(isoString: string): string {
  const parsed = new Date(isoString).getTime();
  if (isNaN(parsed)) return "unknown time";            // malformed timestamp
  const diffMs = Date.now() - parsed;
  const mins = Math.max(0, Math.floor(diffMs / 60000)); // clamp at 0 (no "future")
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

// ─── Type Guards ─────────────────────────────────────────────

function isAgentRegisterArgs(args: Record<string, unknown>): args is {
  project: string;
  role?: string;
  agent_name?: string;
  current_task?: string;
} {
  return typeof args.project === "string";
}

function isAgentHeartbeatArgs(args: Record<string, unknown>): args is {
  project: string;
  role?: string;
  current_task?: string;
  expected_duration_minutes?: number;
} {
  return typeof args.project === "string";
}

function isAgentListTeamArgs(args: Record<string, unknown>): args is {
  project: string;
} {
  return typeof args.project === "string";
}

// ─── Handlers ────────────────────────────────────────────────

export async function agentRegisterHandler(args: Record<string, unknown>) {
  if (!isAgentRegisterArgs(args)) {
    return {
      content: [{ type: "text" as const, text: "Missing required: project" }],
      isError: true,
    };
  }

  // Fall back to dashboard-configured identity if not passed explicitly
  const effectiveRole = (args.role as string) || await getSetting("default_role", "global");
  const effectiveName = (args.agent_name as string) || await getSetting("agent_name", "") || null;

  const storage = await getStorage();

  // Register the agent. We don't use the return value here — the storage
  // layer handles upsert internally and there are no caller-visible fields
  // (e.g. server-assigned IDs) that we need to surface in the response.
  await storage.registerAgent({
    project: args.project,
    user_id: PRISM_USER_ID,
    role: effectiveRole,
    agent_name: effectiveName,
    status: "active",
    current_task: (args.current_task as string) || null,
  });

  const icon = getRoleIcon(effectiveRole);
  return {
    content: [{
      type: "text" as const,
      text:
        `${icon} **Agent Registered**\n\n` +
        `- **Project:** ${escapeMd(args.project as string)}\n` +
        `- **Role:** ${escapeMd(effectiveRole)}\n` +
        (effectiveName ? `- **Name:** ${escapeMd(effectiveName)}\n` : "") +
        (args.current_task ? `- **Task:** ${escapeMd(args.current_task as string)}\n` : "") +
        `\nOther agents will see you when they call \`agent_list_team\` or \`session_load_context\`.`,
    }],
  };
}

export async function agentHeartbeatHandler(args: Record<string, unknown>) {
  if (!isAgentHeartbeatArgs(args)) {
    return {
      content: [{ type: "text" as const, text: "Missing required: project" }],
      isError: true,
    };
  }

  const effectiveRole = (args.role as string) || await getSetting("default_role", "global");

  const storage = await getStorage();
  await storage.heartbeatAgent(
    args.project,
    PRISM_USER_ID,
    effectiveRole,
    args.current_task as string | undefined,
    args.expected_duration_minutes as number | undefined
  );

  return {
    content: [{
      type: "text" as const,
      text: `💓 Heartbeat updated for **${escapeMd(effectiveRole)}** on \`${escapeMd(args.project as string)}\`.` +
        (args.current_task ? ` Task: ${escapeMd(args.current_task as string)}` : "") +
        (args.expected_duration_minutes ? ` (ETA: ${args.expected_duration_minutes}m)` : ""),
    }],
  };
}

export async function agentListTeamHandler(args: Record<string, unknown>) {
  if (!isAgentListTeamArgs(args)) {
    return {
      content: [{ type: "text" as const, text: "Missing required: project" }],
      isError: true,
    };
  }

  const storage = await getStorage();
  const team = await storage.listTeam(args.project, PRISM_USER_ID);

  if (team.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: `No active agents on \`${escapeMd(args.project as string)}\`. Use \`agent_register\` to join the team.`,
      }],
    };
  }

  // v5.3: Health-state indicator mapping
  const statusIndicators: Record<string, string> = {
    active: "🟢 Active",
    idle: "💤 Idle",
    shutdown: "⚫ Offline",
    stale: "🟡 Stale",
    frozen: "🔴 Frozen",
    overdue: "⏰ Overdue",
    looping: "🔄 Looping",
  };

  const lines = team.map(agent => {
    const icon = getRoleIcon(agent.role);
    const ago = agent.last_heartbeat
      ? getTimeAgo(agent.last_heartbeat)
      : "unknown";
    const healthIndicator = statusIndicators[agent.status] || `❓ ${agent.status}`;
    // escapeMd() applied to all user-controlled fields to prevent
    // markdown metacharacters in task descriptions from corrupting output
    return (
      `${icon} **${escapeMd(agent.role)}**` +
      (agent.agent_name ? ` (${escapeMd(agent.agent_name)})` : "") +
      ` — ${healthIndicator}` +
      (agent.current_task ? ` | Task: ${escapeMd(agent.current_task)}` : "") +
      (agent.loop_count && agent.loop_count >= 3 ? ` | 🔄 Loop: ${agent.loop_count}x` : "") +
      ` | Last seen: ${ago}`
    );
  });

  // Count agents by health state for summary
  const healthyCt = team.filter(a => a.status === "active" || a.status === "idle").length;
  const warnCt = team.filter(a => ["stale", "overdue", "looping", "frozen"].includes(a.status)).length;

  return {
    content: [{
      type: "text" as const,
      text:
        `## 🐝 Hivemind Team — \`${escapeMd(args.project as string)}\`\n\n` +
        lines.join("\n") +
        `\n\n_${team.length} agent(s) | ${healthyCt} healthy` +
        (warnCt > 0 ? ` | ⚠️ ${warnCt} need attention` : "") +
        `_\n_Watchdog monitoring active: health checked every 60s._`,
    }],
  };
}
