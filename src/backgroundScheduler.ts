/**
 * Background Purge Scheduler (v5.4) — Unified Maintenance Automation
 *
 * Automates all storage maintenance tasks that were previously manual-only:
 *   1. TTL Sweep     — expireByTTL() for all projects with configured TTL
 *   2. Importance Decay — decayImportance() across all projects
 *   3. Compaction    — auto-compact projects exceeding entry threshold
 *   4. Deep Purge    — purge float32 embeddings for old compressed entries
 *
 * Architecture:
 *   - Single `setInterval` loop (default: 12 hours)
 *   - Independent from Hivemind Watchdog (60s loop) — different cadence, different concerns
 *   - Non-blocking: all errors caught and logged, sweep never crashes the server
 *   - Configurable via env vars: PRISM_SCHEDULER_ENABLED, PRISM_SCHEDULER_INTERVAL_MS
 *
 * Each sweep runs tasks sequentially (not parallel) to avoid overloading
 * storage backends during maintenance windows.
 */

import { getStorage } from "./storage/index.js";
import { PRISM_USER_ID, PRISM_SCHOLAR_ENABLED, PRISM_SCHOLAR_INTERVAL_MS } from "./config.js";
import { debugLog } from "./utils/logger.js";
import { runWebScholar } from "./scholar/webScholar.js";
import { getAllActiveSdmProjects, getSdmEngine } from "./sdm/sdmEngine.js";

// ─── Configuration ───────────────────────────────────────────

export interface SchedulerConfig {
  /** Sweep interval in milliseconds (default: 43_200_000 = 12 hours) */
  intervalMs: number;
  /** Run TTL expiry sweep for projects with configured policies (default: true) */
  enableTTLSweep: boolean;
  /** Run importance decay for behavioral memory entries (default: true) */
  enableDecay: boolean;
  /** Auto-compact projects exceeding compaction threshold (default: true) */
  enableCompaction: boolean;
  /** Purge float32 embeddings for old entries with compressed blobs (default: true) */
  enableDeepPurge: boolean;
  /** Auto-flush SDM matrices to disk (default: true) */
  enableSdmFlush: boolean;
  /** Minimum age in days for deep purge eligibility (default: 30) */
  purgeOlderThanDays: number;
  /** Minimum entries before compaction triggers (default: 50) */
  compactionThreshold: number;
  /** Number of recent entries to keep intact during compaction (default: 10) */
  compactionKeepRecent: number;
  /** Days before importance decay applies to behavioral entries (default: 30) */
  decayDays: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  intervalMs: 43_200_000,       // 12 hours
  enableTTLSweep: true,
  enableDecay: true,
  enableCompaction: true,
  enableDeepPurge: true,
  enableSdmFlush: true,
  purgeOlderThanDays: 30,
  compactionThreshold: 50,
  compactionKeepRecent: 10,
  decayDays: 30,
};

// ─── Scheduler State ─────────────────────────────────────────

let schedulerInterval: ReturnType<typeof setTimeout> | null = null;

/** Tracks the last completed sweep for dashboard status */
let lastSweepResult: SchedulerSweepResult | null = null;

/** When the scheduler was started */
let schedulerStartedAt: string | null = null;

export interface SchedulerSweepResult {
  /** ISO timestamp of sweep start */
  startedAt: string;
  /** ISO timestamp of sweep completion */
  completedAt: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Results per task */
  tasks: {
    ttlSweep: { ran: boolean; projectsSwept: number; totalExpired: number; error?: string };
    importanceDecay: { ran: boolean; projectsDecayed: number; error?: string };
    compaction: { ran: boolean; projectsCompacted: number; error?: string };
    deepPurge: { ran: boolean; purged: number; reclaimedBytes: number; error?: string };
    sdmFlush: { ran: boolean; projectsFlushed: number; error?: string };
  };
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Start the background scheduler.
 * Returns a cleanup function that stops the interval.
 *
 * @param config - Override defaults for testing or production tuning
 */
export function startScheduler(config?: Partial<SchedulerConfig>): () => void {
  const cfg: SchedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG, ...config };

  if (schedulerInterval) {
    clearTimeout(schedulerInterval);
  }

  schedulerStartedAt = new Date().toISOString();

  const runLoop = () => {
    runSchedulerSweep(cfg)
      .catch(err => {
        console.error(`[Scheduler] Sweep error (non-fatal): ${err}`);
      })
      .finally(() => {
        schedulerInterval = setTimeout(runLoop, cfg.intervalMs);
      });
  };

  // Run an immediate first sweep (after a short delay to let storage fully warm up)
  schedulerInterval = setTimeout(runLoop, 5_000);

  const enabledTasks = [
    cfg.enableTTLSweep && "TTL",
    cfg.enableDecay && "Decay",
    cfg.enableCompaction && "Compaction",
    cfg.enableDeepPurge && "DeepPurge",
    cfg.enableSdmFlush && "SdmFlush",
  ].filter(Boolean).join(", ");

  console.error(
    `[Scheduler] ⏰ Started (interval=${formatDuration(cfg.intervalMs)}, tasks=[${enabledTasks}])`
  );

  return () => {
    if (schedulerInterval) {
      clearTimeout(schedulerInterval);
      schedulerInterval = null;
      console.error("[Scheduler] Stopped");
    }
  };
}

/**
 * Get scheduler status for the dashboard.
 */
export function getSchedulerStatus(): {
  running: boolean;
  startedAt: string | null;
  intervalMs: number;
  lastSweep: SchedulerSweepResult | null;
  scholarRunning: boolean;
  scholarIntervalMs: number;
} {
  return {
    running: schedulerInterval !== null,
    startedAt: schedulerStartedAt,
    intervalMs: DEFAULT_SCHEDULER_CONFIG.intervalMs,
    lastSweep: lastSweepResult,
    scholarRunning: scholarInterval !== null,
    scholarIntervalMs: PRISM_SCHOLAR_INTERVAL_MS,
  };
}

// ─── Scholar State ───────────────────────────────────────────
let scholarInterval: ReturnType<typeof setTimeout> | null = null;

export function startScholarScheduler(): () => void {
  if (scholarInterval) {
    clearTimeout(scholarInterval);
  }

  if (!PRISM_SCHOLAR_ENABLED || PRISM_SCHOLAR_INTERVAL_MS <= 0) {
    debugLog("[WebScholar] 🕒 Scheduler disabled (PRISM_SCHOLAR_ENABLED=false or PRISM_SCHOLAR_INTERVAL_MS=0)");
    return () => {};
  }

  const runLoop = () => {
    runWebScholar()
      .catch(err => {
        console.error(`[WebScholar] Sweep error: ${err}`);
      })
      .finally(() => {
        scholarInterval = setTimeout(runLoop, PRISM_SCHOLAR_INTERVAL_MS);
      });
  };

  // Initial trigger after 30s to avoid thundering herd on boot
  scholarInterval = setTimeout(runLoop, 30_000);

  console.error(
    `[WebScholar] ⏰ Started (interval=${formatDuration(PRISM_SCHOLAR_INTERVAL_MS)})`
  );

  return () => {
    if (scholarInterval) {
      clearTimeout(scholarInterval);
      scholarInterval = null;
      console.error("[WebScholar] Stopped");
    }
  };
}

// ─── Core Sweep Logic ────────────────────────────────────────

/**
 * Single scheduler sweep — orchestrates all maintenance tasks.
 * Exported for testing.
 *
 * Execution order:
 *   1. TTL Sweep     — lightweight SQL UPDATEs (fast)
 *   2. Importance Decay — lightweight SQL UPDATEs (fast)
 *   3. Compaction    — LLM-powered summarization (slow, expensive)
 *   4. Deep Purge    — SQL UPDATEs to NULL embeddings (moderate)
 */
export async function runSchedulerSweep(
  cfg: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG
): Promise<SchedulerSweepResult> {
  const sweepStart = Date.now();
  const startedAt = new Date().toISOString();

  const result: SchedulerSweepResult = {
    startedAt,
    completedAt: "",
    durationMs: 0,
    tasks: {
      ttlSweep: { ran: false, projectsSwept: 0, totalExpired: 0 },
      importanceDecay: { ran: false, projectsDecayed: 0 },
      compaction: { ran: false, projectsCompacted: 0 },
      deepPurge: { ran: false, purged: 0, reclaimedBytes: 0 },
      sdmFlush: { ran: false, projectsFlushed: 0 },
    },
  };

  debugLog("[Scheduler] 🔄 Sweep starting...");

  const storage = await getStorage();

  // ── Task 1: TTL Sweep ──────────────────────────────────────
  if (cfg.enableTTLSweep) {
    try {
      result.tasks.ttlSweep.ran = true;
      const projects = await storage.listProjects();
      const settings = await storage.getAllSettings();

      for (const project of projects) {
        const ttlKey = `ttl:${project}`;
        const ttlValue = settings[ttlKey];
        if (!ttlValue) continue;

        const ttlDays = parseInt(ttlValue, 10);
        if (isNaN(ttlDays) || ttlDays <= 0) continue;

        try {
          const { expired } = await storage.expireByTTL(project, ttlDays, PRISM_USER_ID);
          result.tasks.ttlSweep.projectsSwept++;
          result.tasks.ttlSweep.totalExpired += expired;
          if (expired > 0) {
            debugLog(`[Scheduler] TTL: expired ${expired} entries for "${project}" (>${ttlDays}d)`);
          }
        } catch (err) {
          debugLog(`[Scheduler] TTL sweep failed for "${project}": ${err}`);
        }
      }
    } catch (err) {
      result.tasks.ttlSweep.error = err instanceof Error ? err.message : String(err);
      console.error(`[Scheduler] TTL sweep error: ${err}`);
    }
  }

  // ── Task 2: Importance Decay ───────────────────────────────
  if (cfg.enableDecay) {
    try {
      result.tasks.importanceDecay.ran = true;
      const projects = await storage.listProjects();

      for (const project of projects) {
        try {
          await storage.decayImportance(project, PRISM_USER_ID, cfg.decayDays);
          result.tasks.importanceDecay.projectsDecayed++;
        } catch (err) {
          debugLog(`[Scheduler] Decay failed for "${project}": ${err}`);
        }
      }
    } catch (err) {
      result.tasks.importanceDecay.error = err instanceof Error ? err.message : String(err);
      console.error(`[Scheduler] Importance decay error: ${err}`);
    }
  }

  // ── Task 3: Compaction ─────────────────────────────────────
  // NOTE: Compaction uses LLM summarization which is expensive.
  // We only trigger the candidate detection here — actual compaction
  // is deferred to avoid blocking the sweep with long LLM calls.
  // Instead, we log which projects need compaction for dashboard visibility.
  if (cfg.enableCompaction) {
    try {
      result.tasks.compaction.ran = true;
      const candidates = await storage.getCompactionCandidates(
        cfg.compactionThreshold, cfg.compactionKeepRecent, PRISM_USER_ID
      );

      if (candidates.length > 0) {
        // Import compaction handler dynamically to avoid circular deps
        const { compactLedgerHandler } = await import("./tools/compactionHandler.js");

        for (const candidate of candidates) {
          try {
            debugLog(
              `[Scheduler] Compacting "${candidate.project}": ` +
              `${candidate.total_entries} entries (${candidate.to_compact} to compact)`
            );
            await compactLedgerHandler({
              project: candidate.project,
              threshold: cfg.compactionThreshold,
              keep_recent: cfg.compactionKeepRecent,
              dry_run: false,
            });
            result.tasks.compaction.projectsCompacted++;
          } catch (err) {
            debugLog(`[Scheduler] Compaction failed for "${candidate.project}": ${err}`);
          }
        }
      }
    } catch (err) {
      result.tasks.compaction.error = err instanceof Error ? err.message : String(err);
      console.error(`[Scheduler] Compaction error: ${err}`);
    }
  }

  // ── Task 4: Deep Purge ─────────────────────────────────────
  if (cfg.enableDeepPurge) {
    try {
      result.tasks.deepPurge.ran = true;
      const purgeResult = await storage.purgeHighPrecisionEmbeddings({
        olderThanDays: cfg.purgeOlderThanDays,
        dryRun: false,
        userId: PRISM_USER_ID,
      });
      result.tasks.deepPurge.purged = purgeResult.purged;
      result.tasks.deepPurge.reclaimedBytes = purgeResult.reclaimedBytes;

      if (purgeResult.purged > 0) {
        debugLog(
          `[Scheduler] Deep purge: freed ${formatBytes(purgeResult.reclaimedBytes)} ` +
          `(${purgeResult.purged} entries purged)`
        );
      }
    } catch (err) {
      result.tasks.deepPurge.error = err instanceof Error ? err.message : String(err);
      console.error(`[Scheduler] Deep purge error: ${err}`);
    }
  }

  // ── Task 5: SDM Flush ──────────────────────────────────────
  if (cfg.enableSdmFlush) {
    try {
      result.tasks.sdmFlush.ran = true;
      const activeProjects = getAllActiveSdmProjects();

      for (const project of activeProjects) {
        try {
          const sdm = getSdmEngine(project);
          const state = sdm.exportState();
          await storage.saveSdmState(project, state);
          result.tasks.sdmFlush.projectsFlushed++;
        } catch (err) {
          debugLog(`[Scheduler] SDM flush failed for "${project}": ${err}`);
        }
      }

      if (result.tasks.sdmFlush.projectsFlushed > 0) {
        debugLog(
          `[Scheduler] SDM flush: saved matrices for ${result.tasks.sdmFlush.projectsFlushed} projects`
        );
      }
    } catch (err) {
      result.tasks.sdmFlush.error = err instanceof Error ? err.message : String(err);
      console.error(`[Scheduler] SDM flush error: ${err}`);
    }
  }

  // ── Finalize ───────────────────────────────────────────────
  result.completedAt = new Date().toISOString();
  result.durationMs = Date.now() - sweepStart;
  lastSweepResult = result;

  // Build summary line
  const parts: string[] = [];
  if (result.tasks.ttlSweep.ran && result.tasks.ttlSweep.totalExpired > 0) {
    parts.push(`TTL:${result.tasks.ttlSweep.totalExpired} expired`);
  }
  if (result.tasks.importanceDecay.ran) {
    parts.push(`Decay:${result.tasks.importanceDecay.projectsDecayed} projects`);
  }
  if (result.tasks.compaction.ran && result.tasks.compaction.projectsCompacted > 0) {
    parts.push(`Compact:${result.tasks.compaction.projectsCompacted} projects`);
  }
  if (result.tasks.deepPurge.ran && result.tasks.deepPurge.purged > 0) {
    parts.push(`Purge:${result.tasks.deepPurge.purged} entries (${formatBytes(result.tasks.deepPurge.reclaimedBytes)})`);
  }
  if (result.tasks.sdmFlush.ran && result.tasks.sdmFlush.projectsFlushed > 0) {
    parts.push(`SDM:${result.tasks.sdmFlush.projectsFlushed} projects`);
  }

  const summaryLine = parts.length > 0
    ? parts.join(" | ")
    : "no maintenance actions needed";

  debugLog(`[Scheduler] ✅ Sweep completed in ${result.durationMs}ms — ${summaryLine}`);

  return result;
}

// ─── Helpers ─────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${ms}ms`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1_048_576).toFixed(1)}MB`;
}
