/**
 * Hivemind Watchdog (v7.2) — Active Agent Health Monitoring
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
import {
  PRISM_USER_ID,
  PRISM_VERIFICATION_HARNESS_ENABLED,
  PRISM_VERIFICATION_LAYERS,
  PRISM_VERIFICATION_DEFAULT_SEVERITY
} from "./config.js";
import type { AgentRegistryEntry, AgentHealthStatus } from "./storage/interface.js";
import * as fs from "fs";
import * as path from "path";
import { VerificationRunner } from "./verification/runner.js";
import type { VerificationConfig } from "./verification/schema.js";
import { TestSuiteSchema } from "./verification/schema.js";
import { validateWithClaw } from "./verification/clawValidator.js";
import { sessionSaveExperienceHandler } from "./tools/ledgerHandlers.js";

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
 * Deduplicates concurrent verification jobs per agent.
 * Key format: project:user_id:role
 */
const inFlightVerifications: Map<string, Promise<void>> = new Map();

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
function _unused_getPendingAlertCount(): number {
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
      console.error(`[Watchdog] Sweep error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    });
  }, cfg.intervalMs);

  // Run an immediate first sweep
  runWatchdogSweep(cfg).catch(err => {
    console.error(`[Watchdog] Initial sweep error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
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
      // OFFLINE → prune the agent and clean up assertion files
      cleanupAssertionFiles(agent);
      try {
        await storage.deregisterAgent(agent.project, agent.user_id, agent.role);
        queueAlert(agent, "OFFLINE",
          `No heartbeat for ${Math.floor(minutesSinceHeartbeat)}m — auto-pruned from registry.`);
        console.error(
          `[Watchdog] ⚫ Agent "${agent.role}" on "${agent.project}" pruned (${Math.floor(minutesSinceHeartbeat)}m offline)`
        );
      } catch (err) {
        console.error(`[Watchdog] Prune failed for ${agent.project}/${agent.role}: ${err instanceof Error ? err.message : String(err)}`);
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

    // ── State Transition: Verification Phase (v7.2.0 Enhanced) ──
    // ARCHITECTURE: Verification is fire-and-forget. The sweep transitions the agent
    // to 'verifying' synchronously and spawns a detached async closure. This prevents
    // long-running Claw/Runner calls (10-70s) from blocking heartbeat checks for
    // other agents.
    
    if (!newStatus && (currentStatus === "active" || currentStatus === "failed_validation")) {
      // v7.2.0 FIX: Scope assertion file per project+role to prevent multi-agent collision
      const scopedFile = path.join(
        ".prism-mcp",
        `test_assertions_${agent.project}_${agent.role}.json`
      );
      // Also check the legacy global path for backward compat
      const legacyFile = "test_assertions.json";
      const activeFile = fs.existsSync(scopedFile) ? scopedFile
        : fs.existsSync(legacyFile) ? legacyFile
        : null;

      if (activeFile) {
        const flightKey = `${agent.project}:${agent.user_id}:${agent.role}`;

        // Skip if a verification is already in-flight for this agent
        if (!inFlightVerifications.has(flightKey)) {
          // Set verifying state synchronously (non-blocking for the sweep)
          console.error(`[Watchdog] 🔬 Verifying agent "${agent.role}" on "${agent.project}"`);
          newStatus = "verifying" as AgentHealthStatus;

          // Capture values for the async closure
          const capturedAgent = { ...agent };
          const capturedFile = activeFile;
          const capturedFailCount = agent.loop_count || 0;

          // Spawn detached verification — does NOT block the sweep
          const verificationJob = (async () => {
            try {
              const assertionsContent = fs.readFileSync(capturedFile, "utf8");
              const innerStorage = await getStorage();

              // v7.2.0: Build verification config from env vars
              const vConfig: VerificationConfig = {
                enabled: PRISM_VERIFICATION_HARNESS_ENABLED,
                layers: PRISM_VERIFICATION_LAYERS,
                default_severity: PRISM_VERIFICATION_DEFAULT_SEVERITY,
              };

              // v7.2.0: Claw-as-Validator adversarial pre-check (fail-open)
              if (PRISM_VERIFICATION_HARNESS_ENABLED) {
                try {
                  const suite = TestSuiteSchema.parse(JSON.parse(assertionsContent));
                  const clawResult = await validateWithClaw(
                    {
                      suite,
                      project: capturedAgent.project,
                      files_changed: [],
                      change_summary: `Automated verification for ${capturedAgent.role}`,
                    },
                    async (prompt: string, cwd: string) => {
                      // @ts-ignore: Optional runtime dependency; handled by .catch()
                      const mod = await import("./tools/clawHandlers.js").catch(() => null);
                      if (!mod?.clawRunTaskHandler) throw new Error("claw-agent not available");
                      return mod.clawRunTaskHandler({ prompt, cwd });
                    }
                  );
                  if (!clawResult.accepted) {
                    console.error(`[Watchdog] ⚠️ Claw validator flagged ${clawResult.issues.length} issues`);
                  }
                } catch (clawErr) {
                  console.error(`[Watchdog] Claw validator skipped: ${clawErr instanceof Error ? clawErr.message : String(clawErr)}`);
                }
              }

              // v7.2.0: Use enhanced runner with layer filtering
              const result = await VerificationRunner.runSuite(
                assertionsContent,
                PRISM_VERIFICATION_HARNESS_ENABLED
                  ? { layers: PRISM_VERIFICATION_LAYERS, config: vConfig }
                  : undefined
              );

              let resolvedStatus: AgentHealthStatus;
              let resolvedLoopCount = capturedFailCount;

              if (!result.passed) {
                // Emit structured experience event
                try {
                  await sessionSaveExperienceHandler({
                    project: capturedAgent.project,
                    event_type: "validation_result",
                    context: `Verification run for ${capturedAgent.role}`,
                    action: "automated_verification",
                    outcome: `${result.failed_count}/${result.total} failed — gate: ${result.severity_gate.action}`,
                    role: capturedAgent.role,
                    confidence_score: Math.round((result.passed_count / Math.max(result.total, 1)) * 100)
                  });
                } catch (err) {
                  console.error(`[Watchdog] Error saving failure experience: ${err}`);
                }

                // Severity gate enforcement
                if (PRISM_VERIFICATION_HARNESS_ENABLED && result.severity_gate.action === "abort") {
                  resolvedStatus = "failed_validation";
                  resolvedLoopCount = capturedFailCount + 1;
                  queueAlert(capturedAgent, "FAILED_VALIDATION",
                    `[ABORT] ${result.severity_gate.summary}`);
                  console.error(`[Watchdog] 🛑 ABORT gate triggered for "${capturedAgent.role}" — ${result.severity_gate.summary}`);
                } else if (PRISM_VERIFICATION_HARNESS_ENABLED && result.severity_gate.action === "block") {
                  resolvedStatus = "failed_validation";
                  resolvedLoopCount = capturedFailCount + 1;
                  queueAlert(capturedAgent, "FAILED_VALIDATION",
                    `[BLOCKED] ${result.severity_gate.summary}`);
                  console.error(`[Watchdog] 🚫 Gate BLOCKED for "${capturedAgent.role}" — ${result.severity_gate.summary}`);
                } else if (capturedFailCount >= 3) {
                  resolvedStatus = "looping";
                  // FIX: Clean up orphaned assertion file on LOOPING
                  cleanupAssertionFiles(capturedAgent);
                  queueAlert(capturedAgent, "LOOPING", `Validation failed ${capturedFailCount} times. Bailing out.`);
                } else {
                  resolvedStatus = "failed_validation";
                  resolvedLoopCount = capturedFailCount + 1;
                  const failSummary = result.assertion_results
                    .filter(a => !a.passed && !a.skipped)
                    .map(a => `[${a.layer}] ${a.description}: ${a.error}`)
                    .join(" | ");
                  queueAlert(capturedAgent, "FAILED_VALIDATION", `[Verification Failed] ${failSummary}`);
                }
              } else {
                // Passed! Clean up assertion file
                cleanupAssertionFiles(capturedAgent);
                resolvedStatus = "active";
                resolvedLoopCount = 0;
                queueAlert(capturedAgent, "SUCCESS", "All test assertions passed successfully.");
                console.error(`[Watchdog] ✅ Verification PASSED for "${capturedAgent.role}" on "${capturedAgent.project}"`);

                try {
                  await sessionSaveExperienceHandler({
                    project: capturedAgent.project,
                    event_type: "validation_result",
                    context: `Verification run for ${capturedAgent.role}`,
                    action: "automated_verification",
                    outcome: `Passed all ${result.total} assertions (${result.duration_ms}ms)`,
                    role: capturedAgent.role,
                    confidence_score: 100
                  });
                } catch (err) {
                  console.error(`[Watchdog] Error saving success experience: ${err}`);
                }
              }

              // Persist final status
              try {
                await innerStorage.updateAgentStatus(
                  capturedAgent.project, capturedAgent.user_id, capturedAgent.role, resolvedStatus,
                  { loop_count: resolvedLoopCount }
                );
              } catch (err) {
                console.error(`[Watchdog] Failed to update status after verification: ${err}`);
              }
            } catch (e: any) {
              // Verification script error — mark as failed_validation
              try {
                const innerStorage = await getStorage();
                await innerStorage.updateAgentStatus(
                  capturedAgent.project, capturedAgent.user_id, capturedAgent.role, "failed_validation",
                  { loop_count: capturedFailCount + 1 }
                );
              } catch { /* best-effort */ }
              queueAlert(capturedAgent, "FAILED_VALIDATION", `[Verification Script Error] ${e.message}`);
            } finally {
              inFlightVerifications.delete(flightKey);
            }
          })();

          inFlightVerifications.set(flightKey, verificationJob);
        }
      }
    } else if (!newStatus && currentStatus === "verifying") {
      // Agent is already verifying — don't re-trigger, just skip
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
      // FIX: Clean up orphaned assertion files on LOOPING
      cleanupAssertionFiles(agent);
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
          agent.project, agent.user_id, agent.role, newStatus,
          { loop_count: agent.loop_count }
        );
      } catch (err) {
        console.error(`[Watchdog] Status update failed for ${agent.project}/${agent.role}: ${err instanceof Error ? err.message : String(err)}`);
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

/**
 * Clean up assertion files for an agent (scoped + legacy).
 * Prevents orphaned files from triggering phantom verifications on restart.
 */
function cleanupAssertionFiles(agent: AgentRegistryEntry): void {
  const scopedFile = path.join(
    ".prism-mcp",
    `test_assertions_${agent.project}_${agent.role}.json`
  );
  const legacyFile = "test_assertions.json";

  for (const filePath of [scopedFile, legacyFile]) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.error(`[Watchdog] 🧹 Cleaned up assertion file: ${filePath}`);
      }
    } catch (err) {
      console.error(`[Watchdog] Failed to clean up ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
