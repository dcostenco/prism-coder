/**
 * Hivemind Watchdog (v5.3) — Active Agent Health Monitoring
 *
 * Server-side health monitor for multi-agent coordination.
 * Runs every WATCHDOG_INTERVAL_MS when PRISM_ENABLE_HIVEMIND=true.
 *
 * State Transitions (per sweep):
 *   ACTIVE  → STALE    (no heartbeat for staleThresholdMin)
 *   STALE   → FROZEN   (no heartbeat for frozenThresholdMin)
 *   FROZEN  → [pruned] (no heartbeat for offlineThresholdMin)
 *   ACTIVE  → OVERDUE  (task_start + expected_duration exceeded)
 *   ACTIVE  → LOOPING  (loop_count >= loopThreshold, set by heartbeatAgent)
 *
 * Alerts are queued in-memory and drained by the tool dispatch
 * handler in server.ts, which APPENDS them to the tool response
 * content so the LLM actually reads the warning.
 *
 * Architecture:
 *   - Zero dependencies on MCP Server object (pure business logic)
 *   - Storage accessed via getStorage() singleton
 *   - Alerts are fire-and-forget in-memory Map (no persistence needed)
 *   - Sweep is non-blocking: errors are caught and logged, never crash
 */

import { getStorage } from "./storage/index.js";
import { PRISM_USER_ID } from "./config.js";
import type { AgentRegistryEntry, AgentHealthStatus } from "./storage/interface.js";

// ─── Configuration ───────────────────────────────────────────

export interface WatchdogConfig {
  /** Sweep interval in milliseconds (default: 60_000 = 1 min) */
  intervalMs: number;
  /** Minutes without heartbeat before ACTIVE → STALE (default: 5) */
  staleThresholdMin: number;
  /** Minutes without heartbeat before STALE → FROZEN (default: 15) */
  frozenThresholdMin: number;
  /** Minutes without heartbeat before FROZEN → [pruned] (default: 30) */
  offlineThresholdMin: number;
  /** Consecutive same-task heartbeats to trigger LOOPING (default: 5) */
  loopThreshold: number;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  intervalMs: 60_000,
  staleThresholdMin: 5,
  frozenThresholdMin: 15,
  offlineThresholdMin: 30,
  loopThreshold: 5,
};

// ─── Alert Queue ─────────────────────────────────────────────

export interface WatchdogAlert {
  project: string;
  role: string;
  agentName: string | null;
  status: string;
  message: string;
  detectedAt: string;
}

/**
 * Pending alerts — keyed by "project:role:status" to deduplicate.
 * Only one alert per agent per status is kept until drained.
 */
const pendingAlerts: Map<string, WatchdogAlert> = new Map();

/**
 * Drain all pending alerts for a project.
 * Called by server.ts in the CallToolRequestSchema handler
 * to inject warnings into the tool response content.
 *
 * Returns and clears all alerts for the given project.
 */
export function drainAlerts(project: string): WatchdogAlert[] {
  const alerts: WatchdogAlert[] = [];
  for (const [key, alert] of pendingAlerts.entries()) {
    if (alert.project === project) {
      alerts.push(alert);
      pendingAlerts.delete(key);
    }
  }
  return alerts;
}

/**
 * Get count of pending alerts (for testing/debugging).
 */
export function getPendingAlertCount(): number {
  return pendingAlerts.size;
}

// ─── Watchdog Lifecycle ──────────────────────────────────────

let watchdogInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the watchdog sweep interval.
 * Returns a cleanup function that stops the interval.
 *
 * @param config - Override defaults for testing or production tuning
 */
export function startWatchdog(config?: Partial<WatchdogConfig>): () => void {
  const cfg: WatchdogConfig = { ...DEFAULT_WATCHDOG_CONFIG, ...config };

  if (watchdogInterval) {
    clearInterval(watchdogInterval);
  }

  watchdogInterval = setInterval(() => {
    runWatchdogSweep(cfg).catch(err => {
      console.error(`[Watchdog] Sweep error (non-fatal): ${err}`);
    });
  }, cfg.intervalMs);

  // Run an immediate first sweep
  runWatchdogSweep(cfg).catch(err => {
    console.error(`[Watchdog] Initial sweep error (non-fatal): ${err}`);
  });

  console.error(`[Watchdog] 🐝 Started (interval=${cfg.intervalMs}ms, stale=${cfg.staleThresholdMin}m, frozen=${cfg.frozenThresholdMin}m)`);

  return () => {
    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
      console.error("[Watchdog] Stopped");
    }
  };
}

// ─── Core Sweep Logic ────────────────────────────────────────

/**
 * Single watchdog sweep — exported for testing.
 *
 * 1. Fetches ALL registered agents for the user
 * 2. Computes time since last heartbeat for each
 * 3. Applies state transition rules
 * 4. Checks OVERDUE (task_start + expected_duration exceeded)
 * 5. Queues alerts for state transitions
 * 6. Prunes OFFLINE agents (> offlineThresholdMin)
 */
export async function runWatchdogSweep(
  cfg: WatchdogConfig = DEFAULT_WATCHDOG_CONFIG
): Promise<void> {
  const storage = await getStorage();
  const agents = await storage.getAllAgents(PRISM_USER_ID);

  if (agents.length === 0) return;

  const now = Date.now();

  for (const agent of agents) {
    const heartbeatMs = agent.last_heartbeat
      ? new Date(agent.last_heartbeat).getTime()
      : 0;

    // Guard against NaN from malformed timestamps
    if (isNaN(heartbeatMs) || heartbeatMs === 0) continue;

    const minutesSinceHeartbeat = (now - heartbeatMs) / 60_000;
    const currentStatus = agent.status;

    // ── State Transition: Heartbeat-based ──────────────────

    let newStatus: AgentHealthStatus | null = null;

    if (minutesSinceHeartbeat >= cfg.offlineThresholdMin) {
      // OFFLINE → prune the agent
      try {
        await storage.deregisterAgent(agent.project, agent.user_id, agent.role);
        queueAlert(agent, "OFFLINE",
          `No heartbeat for ${Math.floor(minutesSinceHeartbeat)}m — auto-pruned from registry.`);
        console.error(
          `[Watchdog] ⚫ Agent "${agent.role}" on "${agent.project}" pruned (${Math.floor(minutesSinceHeartbeat)}m offline)`
        );
      } catch (err) {
        console.error(`[Watchdog] Prune failed for ${agent.project}/${agent.role}: ${err}`);
      }
      continue; // Agent removed, no further processing
    }

    if (minutesSinceHeartbeat >= cfg.frozenThresholdMin) {
      if (currentStatus !== "frozen") {
        newStatus = "frozen";
        queueAlert(agent, "FROZEN",
          `No heartbeat for ${Math.floor(minutesSinceHeartbeat)}m — agent appears unresponsive.`);
        console.error(
          `[Watchdog] 🔴 Agent "${agent.role}" on "${agent.project}" is FROZEN (${Math.floor(minutesSinceHeartbeat)}m without heartbeat)`
        );
      }
    } else if (minutesSinceHeartbeat >= cfg.staleThresholdMin) {
      if (currentStatus !== "stale" && currentStatus !== "frozen") {
        newStatus = "stale";
        queueAlert(agent, "STALE",
          `No heartbeat for ${Math.floor(minutesSinceHeartbeat)}m — may be experiencing issues.`);
        console.error(
          `[Watchdog] 🟡 Agent "${agent.role}" on "${agent.project}" is STALE (${Math.floor(minutesSinceHeartbeat)}m without heartbeat)`
        );
      }
    }

    // ── State Transition: OVERDUE detection ────────────────

    if (
      !newStatus && // Don't override heartbeat-based transitions
      currentStatus === "active" &&
      agent.task_start_time &&
      agent.expected_duration_minutes &&
      agent.expected_duration_minutes > 0
    ) {
      const taskStartMs = new Date(agent.task_start_time).getTime();
      if (!isNaN(taskStartMs)) {
        const taskElapsedMin = (now - taskStartMs) / 60_000;
        if (taskElapsedMin > agent.expected_duration_minutes) {
          newStatus = "overdue";
          queueAlert(agent, "OVERDUE",
            `Task "${truncate(agent.current_task || 'unknown', 50)}" running for ` +
            `${Math.floor(taskElapsedMin)}m (expected ${agent.expected_duration_minutes}m).`);
          console.error(
            `[Watchdog] ⏰ Agent "${agent.role}" on "${agent.project}" is OVERDUE ` +
            `(${Math.floor(taskElapsedMin)}m vs ${agent.expected_duration_minutes}m expected)`
          );
        }
      }
    }

    // ── State Transition: LOOPING confirmation ─────────────
    // Loop detection is primarily done in heartbeatAgent().
    // The watchdog just confirms and queues alerts for it.

    if (
      !newStatus &&
      agent.loop_count !== undefined &&
      agent.loop_count >= cfg.loopThreshold &&
      currentStatus !== "looping"
    ) {
      newStatus = "looping";
      queueAlert(agent, "LOOPING",
        `Same task repeated ${agent.loop_count} times — possible infinite loop.`);
      console.error(
        `[Watchdog] 🔄 Agent "${agent.role}" on "${agent.project}" detected LOOPING ` +
        `(task repeated ${agent.loop_count}x)`
      );
    }

    // ── Apply status update ────────────────────────────────

    if (newStatus && newStatus !== currentStatus) {
      try {
        await storage.updateAgentStatus(
          agent.project, agent.user_id, agent.role, newStatus
        );
      } catch (err) {
        console.error(`[Watchdog] Status update failed for ${agent.project}/${agent.role}: ${err}`);
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function queueAlert(
  agent: AgentRegistryEntry,
  status: string,
  message: string
): void {
  const key = `${agent.project}:${agent.role}:${status}`;
  // Only queue if not already pending (deduplication)
  if (!pendingAlerts.has(key)) {
    pendingAlerts.set(key, {
      project: agent.project,
      role: agent.role,
      agentName: agent.agent_name ?? null,
      status,
      message,
      detectedAt: new Date().toISOString(),
    });
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}
