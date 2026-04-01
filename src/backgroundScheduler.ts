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
import {
  PRISM_USER_ID,
  PRISM_SCHOLAR_ENABLED,
  PRISM_SCHOLAR_INTERVAL_MS,
  PRISM_GRAPH_PRUNING_ENABLED,
  PRISM_GRAPH_PRUNE_MIN_STRENGTH,
  PRISM_GRAPH_PRUNE_PROJECT_COOLDOWN_MS,
  PRISM_GRAPH_PRUNE_SWEEP_BUDGET_MS,
  PRISM_GRAPH_PRUNE_MAX_PROJECTS_PER_SWEEP,
  PRISM_ACTR_ENABLED,
  PRISM_ACTR_ACCESS_LOG_RETENTION_DAYS,
} from "./config.js";
import { debugLog } from "./utils/logger.js";
import { runWebScholar } from "./scholar/webScholar.js";
import { getAllActiveSdmProjects, getSdmEngine } from "./sdm/sdmEngine.js";
import { supabasePatch, supabaseDelete, supabaseRpc } from "./utils/supabaseApi.js";

// ─── Distributed Lock Helpers (v6.2) ─────────────────────────────────────────
//
// These helpers provide backend-aware distributed locking for the scheduler.
//
//   SQLite path: uses the existing configStorage key (local file lock).
//     - Correct for single-node Claude Desktop deployments.
//     - Each process is the only writer to its own db file.
//
//   Supabase path: uses the `scheduler_locks` table (v32 migration).
//     - Enables multi-node Hivemind deployments (multiple Prism instances
//       sharing one Supabase project) to elect a single sweep leader.
//     - Atomic INSERT ... ON CONFLICT DO UPDATE WHERE expires_at < NOW()
//       is the standard Postgres advisory-lock-without-advisory-locks pattern.
//     - 1-minute TTL on expires_at ensures zombie-lock auto-recovery if a
//       node crashes without releasing.

const DISTRIBUTED_LOCK_KEY    = "scheduler_main" as const;
const DISTRIBUTED_LOCK_TTL_MS = 60_000;  // 1 minute — zombie-lock horizon
const HEARTBEAT_INTERVAL_MS   = 30_000;  // 30 seconds

// Fix: process.pid is often 1 in Docker/K8s. Generate a cryptographically
// unique instance ID on startup to prevent lock collisions and accidental
// steal/release across containerized replicas.
const INSTANCE_ID = `prism_${process.pid}_${Math.random().toString(36).substring(2, 9)}`;

/** Try to acquire the distributed scheduler lock for Supabase backend.
 *  Returns true if acquired, false if another active node holds it. */
async function acquireSupabaseLock(pid: string): Promise<boolean> {
  try {
    const result = await supabaseRpc("prism_acquire_lock", {
      p_key: DISTRIBUTED_LOCK_KEY,
      p_pid: pid,
      p_ttl_ms: DISTRIBUTED_LOCK_TTL_MS
    });
    return result === true;
  } catch (err) {
    debugLog(`[Scheduler] Supabase lock acquire failed (non-fatal, will skip sweep): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Extend the Supabase lock expiry (heartbeat). */
async function heartbeatSupabaseLock(pid: string): Promise<void> {
  const expiresAt = new Date(Date.now() + DISTRIBUTED_LOCK_TTL_MS).toISOString();
  try {
    await supabasePatch(
      "scheduler_locks",
      { expires_at: expiresAt },
      { key: `eq.${DISTRIBUTED_LOCK_KEY}`, pid: `eq.${pid}` }
    );
  } catch (err) {
    debugLog(`[Scheduler] Supabase lock heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Release the Supabase lock. */
async function releaseSupabaseLock(pid: string): Promise<void> {
  try {
    await supabaseDelete(
      "scheduler_locks",
      { key: `eq.${DISTRIBUTED_LOCK_KEY}`, pid: `eq.${pid}` }
    );
  } catch (err) {
    debugLog(`[Scheduler] Supabase lock release failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

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
  /** Auto-synthesize graph edges in background (default: true) */
  enableEdgeSynthesis: boolean;
  /** Minimum age in days for deep purge eligibility (default: 30) */
  purgeOlderThanDays: number;
  /** Minimum entries before compaction triggers (default: 50) */
  compactionThreshold: number;
  /** Number of recent entries to keep intact during compaction (default: 10) */
  compactionKeepRecent: number;
  /** Days before importance decay applies to behavioral entries (default: 30) */
  decayDays: number;
  /** Per-project synthesis cooldown in milliseconds (default: 10 minutes) */
  edgeSynthesisCooldownMs: number;
  /** Max wall-clock budget for synthesis task per sweep (default: 60 seconds) */
  edgeSynthesisBudgetMs: number;
  /** Max retries after first synthesis failure (default: 1) */
  edgeSynthesisMaxRetries: number;
  /** Backoff duration after terminal synthesis failure (default: 30 minutes) */
  edgeSynthesisBackoffMs: number;
  /** Enable soft-prune summary sweep (default: false, opt-in via env) */
  enableGraphPruning: boolean;
  /** Minimum link strength threshold for soft-prune accounting (default: 0.15) */
  graphPruneMinStrength: number;
  /** Per-project prune cooldown in milliseconds (default: 10 minutes) */
  graphPruneProjectCooldownMs: number;
  /** Max wall-clock budget for prune task per sweep (default: 30 seconds) */
  graphPruneSweepBudgetMs: number;
  /** Max projects to evaluate in prune task per sweep (default: 25) */
  graphPruneMaxProjectsPerSweep: number;
  /** Prune stale ACT-R access log entries (default: true when ACT-R is enabled) */
  enableAccessLogPrune: boolean;
  /** Days of access log history to retain (default: PRISM_ACTR_ACCESS_LOG_RETENTION_DAYS) */
  accessLogRetentionDays: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  intervalMs: 43_200_000,       // 12 hours
  enableTTLSweep: true,
  enableDecay: true,
  enableCompaction: true,
  enableDeepPurge: true,
  enableSdmFlush: true,
  enableEdgeSynthesis: true,
  purgeOlderThanDays: 30,
  compactionThreshold: 50,
  compactionKeepRecent: 10,
  decayDays: 30,
  edgeSynthesisCooldownMs: 10 * 60_000,
  edgeSynthesisBudgetMs: 60_000,
  edgeSynthesisMaxRetries: 1,
  edgeSynthesisBackoffMs: 30 * 60_000,
  enableGraphPruning: PRISM_GRAPH_PRUNING_ENABLED,
  graphPruneMinStrength: PRISM_GRAPH_PRUNE_MIN_STRENGTH,
  graphPruneProjectCooldownMs: PRISM_GRAPH_PRUNE_PROJECT_COOLDOWN_MS,
  graphPruneSweepBudgetMs: PRISM_GRAPH_PRUNE_SWEEP_BUDGET_MS,
  graphPruneMaxProjectsPerSweep: PRISM_GRAPH_PRUNE_MAX_PROJECTS_PER_SWEEP,
  enableAccessLogPrune: PRISM_ACTR_ENABLED,
  accessLogRetentionDays: PRISM_ACTR_ACCESS_LOG_RETENTION_DAYS,
};

// ─── Scheduler State ─────────────────────────────────────────

let schedulerInterval: ReturnType<typeof setTimeout> | null = null;

/** Tracks the last completed sweep for dashboard status */
let lastSweepResult: SchedulerSweepResult | null = null;

/** When the scheduler was started */
let schedulerStartedAt: string | null = null;

/** Backpressure: tracks projects currently undergoing edge synthesis */
const runningSynthesis = new Set<string>();

/** Per-project last successful synthesis timestamp (ms since epoch) */
const lastSynthesisAt = new Map<string, number>();

/** Per-project synthesis backoff-until timestamp (ms since epoch) */
const synthesisBackoffUntil = new Map<string, number>();

/** Per-project last prune summary timestamp (ms since epoch) */
const lastPruneAt = new Map<string, number>();

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
    linkDecay: { ran: boolean; linksDecayed: number; error?: string };
    edgeSynthesis: {
      ran: boolean;
      projectsAttempted: number;
      projectsSynthesized: number;
      projectsFailed: number;
      retries: number;
      skippedBackpressure: number;
      skippedCooldown: number;
      skippedBudget: number;
      skippedBackoff: number;
      newLinks: number;
      error?: string;
    };
    graphPruning: {
      ran: boolean;
      projectsConsidered: number;
      projectsPruned: number;
      linksScanned: number;
      linksSoftPruned: number;
      skippedBackpressure: number;
      skippedCooldown: number;
      skippedBudget: number;
      durationMs: number;
      minStrength: number;
      error?: string;
    };
    accessLogPrune: { ran: boolean; deleted: number; error?: string };
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
        console.error(`[Scheduler] Sweep error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
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
    cfg.enableEdgeSynthesis && "EdgeSynthesis",
    cfg.enableGraphPruning && "GraphPruning",
    cfg.enableAccessLogPrune && "AccessLogPrune",
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
        console.error(`[WebScholar] Sweep error: ${err instanceof Error ? err.message : String(err)}`);
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
      linkDecay: { ran: false, linksDecayed: 0 },
      edgeSynthesis: {
        ran: false,
        projectsAttempted: 0,
        projectsSynthesized: 0,
        projectsFailed: 0,
        retries: 0,
        skippedBackpressure: 0,
        skippedCooldown: 0,
        skippedBudget: 0,
        skippedBackoff: 0,
        newLinks: 0,
      },
      graphPruning: {
        ran: false,
        projectsConsidered: 0,
        projectsPruned: 0,
        linksScanned: 0,
        linksSoftPruned: 0,
        skippedBackpressure: 0,
        skippedCooldown: 0,
        skippedBudget: 0,
        durationMs: 0,
        minStrength: cfg.graphPruneMinStrength,
      },
      accessLogPrune: { ran: false, deleted: 0 },
    },
  };

  debugLog("[Scheduler] 🔄 Sweep starting...");

  const storage = await getStorage();

  // ─── Backend-Aware Distributed Lock (v6.2) ───────────────────────────────
  //
  //   SQLite: configStorage key in local JSON file (single-node, fast)
  //   Supabase: scheduler_locks table (multi-node Hivemind safety)
  //
  const processId = INSTANCE_ID;
  const isSupabase = process.env.PRISM_STORAGE_BACKEND === "supabase";
  let heartbeatInterval: ReturnType<typeof setInterval>;

  if (isSupabase) {
    // Supabase path: distributed lock via scheduler_locks table
    const acquired = await acquireSupabaseLock(processId);
    if (!acquired) {
      debugLog(`[Scheduler] Distributed lock held by another node. Skipping sweep.`);
      return result;
    }
    debugLog(`[Scheduler] Distributed lock acquired (pid: ${processId})`);

    // Heartbeat: renew every 30s so lock survives long compaction sweeps
    heartbeatInterval = setInterval(() => {
      heartbeatSupabaseLock(processId);
    }, HEARTBEAT_INTERVAL_MS);
  } else {
    // SQLite path: existing local configStorage lock (unchanged behavior)
    const lockKey = "scheduler_lock";
    const now = Date.now();
    const lockVal = await storage.getSetting(lockKey);

    if (lockVal) {
      try {
        const lockData = JSON.parse(lockVal);
        if (lockData.owner_id !== processId && now - lockData.locked_at < 1000 * 60 * 10) {
          debugLog(`[Scheduler] Sweep locked by another instance (${lockData.owner_id}). Skipping.`);
          return result;
        }
      } catch {
        // Ignored parsing error — override stale lock
      }
    }

    await storage.setSetting(lockKey, JSON.stringify({ locked_at: Date.now(), owner_id: processId }));

    // Heartbeat: renew every 5 minutes (local file is cheap)
    heartbeatInterval = setInterval(() => {
      storage.setSetting(lockKey, JSON.stringify({ locked_at: Date.now(), owner_id: processId }))
        .catch((e) => debugLog(`[Scheduler] Heartbeat set failed: ${e instanceof Error ? e.message : String(e)}`));
    }, 1000 * 60 * 5);
  }

  try {
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
          debugLog(`[Scheduler] TTL sweep failed for "${project}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      result.tasks.ttlSweep.error = err instanceof Error ? err.message : String(err);
      console.error(`[Scheduler] TTL sweep error: ${err instanceof Error ? err.message : String(err)}`);
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
          debugLog(`[Scheduler] Decay failed for "${project}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      result.tasks.importanceDecay.error = err instanceof Error ? err.message : String(err);
      console.error(`[Scheduler] Importance decay error: ${err instanceof Error ? err.message : String(err)}`);
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
            debugLog(`[Scheduler] Compaction failed for "${candidate.project}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } catch (err) {
      result.tasks.compaction.error = err instanceof Error ? err.message : String(err);
      console.error(`[Scheduler] Compaction error: ${err instanceof Error ? err.message : String(err)}`);
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
      console.error(`[Scheduler] Deep purge error: ${err instanceof Error ? err.message : String(err)}`);
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
          debugLog(`[Scheduler] SDM flush failed for "${project}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (result.tasks.sdmFlush.projectsFlushed > 0) {
        debugLog(
          `[Scheduler] SDM flush: saved matrices for ${result.tasks.sdmFlush.projectsFlushed} projects`
        );
      }
    } catch (err) {
      result.tasks.sdmFlush.error = err instanceof Error ? err.message : String(err);
      console.error(`[Scheduler] SDM flush error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Task 6: Link Decay (v6.0 Phase 3) ──────────────────────
  // Reduce strength of stale graph edges by -0.1 per sweep.
  // Uses PRISM_LINK_DECAY_DAYS from config (default: 30).
  try {
    const { PRISM_LINK_DECAY_DAYS } = await import("./config.js");
    if (PRISM_LINK_DECAY_DAYS > 0) {
      result.tasks.linkDecay.ran = true;
      const decayed = await storage.decayLinks(PRISM_LINK_DECAY_DAYS);
      result.tasks.linkDecay.linksDecayed = decayed;
      if (decayed > 0) {
        debugLog(`[Scheduler] Link decay: weakened ${decayed} stale links (>${PRISM_LINK_DECAY_DAYS}d)`);
      }
    }
  } catch (err) {
    result.tasks.linkDecay.error = err instanceof Error ? err.message : String(err);
    debugLog(`[Scheduler] Link decay error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Task 7: Edge Synthesis ──────────────────────────────────
  if (cfg.enableEdgeSynthesis) {
    const synthTaskStart = Date.now();
    try {
      result.tasks.edgeSynthesis.ran = true;
      const projects = await storage.listProjects();

      // Dynamic import to avoid circular dependencies
      const { synthesizeEdgesCore } = await import("./tools/graphHandlers.js");

      for (const project of projects) {
        const now = Date.now();

        if (runningSynthesis.has(project)) {
          debugLog(`[Scheduler] Skipping edge synthesis for "${project}" — already running`);
          result.tasks.edgeSynthesis.skippedBackpressure++;
          continue;
        }

        const backoffUntil = synthesisBackoffUntil.get(project);
        if (typeof backoffUntil === "number" && now < backoffUntil) {
          result.tasks.edgeSynthesis.skippedBackoff++;
          continue;
        }

        const lastRun = lastSynthesisAt.get(project);
        if (typeof lastRun === "number" && now - lastRun < cfg.edgeSynthesisCooldownMs) {
          result.tasks.edgeSynthesis.skippedCooldown++;
          continue;
        }

        if (now - synthTaskStart >= cfg.edgeSynthesisBudgetMs) {
          result.tasks.edgeSynthesis.skippedBudget++;
          continue;
        }

        result.tasks.edgeSynthesis.projectsAttempted++;

        try {
          runningSynthesis.add(project);

          for (let attempt = 0; attempt <= cfg.edgeSynthesisMaxRetries; attempt++) {
            try {
              if (attempt > 0) {
                result.tasks.edgeSynthesis.retries++;
                debugLog(`[Scheduler] Retrying edge synthesis for "${project}" (attempt ${attempt + 1})`);
              } else {
                debugLog(`[Scheduler] Synthesizing edges for "${project}"...`);
              }

              const synthRes = await synthesizeEdgesCore({
                project,
                similarity_threshold: 0.7,
                max_entries: 50,
                max_neighbors_per_entry: 3,
                randomize_selection: true,
              });

              if (synthRes && synthRes.success) {
                result.tasks.edgeSynthesis.projectsSynthesized++;
                result.tasks.edgeSynthesis.newLinks += synthRes.newLinks;
                lastSynthesisAt.set(project, Date.now());
                synthesisBackoffUntil.delete(project);
                if (synthRes.newLinks > 0) {
                  debugLog(`[Scheduler] Edge Synthesis: created ${synthRes.newLinks} links for "${project}"`);
                }
                break;
              }

              throw new Error("Synthesis returned unsuccessful result");
            } catch (err) {
              const isLast = attempt >= cfg.edgeSynthesisMaxRetries;
              if (isLast) {
                result.tasks.edgeSynthesis.projectsFailed++;
                synthesisBackoffUntil.set(project, Date.now() + cfg.edgeSynthesisBackoffMs);
                debugLog(`[Scheduler] Edge Synthesis failed for "${project}": ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }

        } finally {
          runningSynthesis.delete(project);
        }
      }
    } catch (err) {
      result.tasks.edgeSynthesis.error = err instanceof Error ? err.message : String(err);
      console.error(`[Scheduler] Edge Synthesis error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Emit scheduler-level synthesis telemetry
    try {
      const { recordSchedulerSynthesis } = await import("./observability/graphMetrics.js");
      recordSchedulerSynthesis({
        projects_processed: result.tasks.edgeSynthesis.projectsAttempted,
        projects_succeeded: result.tasks.edgeSynthesis.projectsSynthesized,
        projects_failed: result.tasks.edgeSynthesis.projectsFailed,
        retries: result.tasks.edgeSynthesis.retries,
        links_created: result.tasks.edgeSynthesis.newLinks,
        duration_ms: Date.now() - synthTaskStart,
        skipped_backpressure: result.tasks.edgeSynthesis.skippedBackpressure,
        skipped_cooldown: result.tasks.edgeSynthesis.skippedCooldown,
        skipped_budget: result.tasks.edgeSynthesis.skippedBudget,
        skipped_backoff: result.tasks.edgeSynthesis.skippedBackoff,
      });
    } catch {
      // Non-critical — don't let metrics failure break the scheduler
    }

  }

  // ── Task 8: Graph Soft-Prune Summary (WS3) ─────────────────
  if (cfg.enableGraphPruning) {
    const pruneTaskStart = Date.now();
    try {
      result.tasks.graphPruning.ran = true;
      const projects = await storage.listProjects();
      const maxProjects = Math.max(1, cfg.graphPruneMaxProjectsPerSweep);

      for (const project of projects) {
        const now = Date.now();

        if (result.tasks.graphPruning.projectsConsidered >= maxProjects) {
          break;
        }

        if (runningSynthesis.has(project)) {
          result.tasks.graphPruning.skippedBackpressure++;
          continue;
        }

        const lastPrune = lastPruneAt.get(project);
        if (typeof lastPrune === "number" && now - lastPrune < cfg.graphPruneProjectCooldownMs) {
          result.tasks.graphPruning.skippedCooldown++;
          continue;
        }

        if (now - pruneTaskStart >= cfg.graphPruneSweepBudgetMs) {
          result.tasks.graphPruning.skippedBudget++;
          continue;
        }

        result.tasks.graphPruning.projectsConsidered++;

        try {
          const summary = await storage.summarizeWeakLinks(
            project,
            PRISM_USER_ID,
            cfg.graphPruneMinStrength,
            25,
            25,
          );

          result.tasks.graphPruning.linksScanned += summary.links_scanned;
          result.tasks.graphPruning.linksSoftPruned += summary.links_soft_pruned;
          if (summary.links_soft_pruned > 0) {
            result.tasks.graphPruning.projectsPruned++;
          }

          lastPruneAt.set(project, Date.now());
        } catch (err) {
          debugLog(`[Scheduler] Graph pruning summary failed for "${project}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      result.tasks.graphPruning.error = err instanceof Error ? err.message : String(err);
      console.error(`[Scheduler] Graph pruning summary error: ${err instanceof Error ? err.message : String(err)}`);
    }

    result.tasks.graphPruning.durationMs = Date.now() - pruneTaskStart;

    try {
      const { recordPruningRun } = await import("./observability/graphMetrics.js");
      recordPruningRun({
        projects_considered: result.tasks.graphPruning.projectsConsidered,
        projects_pruned: result.tasks.graphPruning.projectsPruned,
        links_scanned: result.tasks.graphPruning.linksScanned,
        links_soft_pruned: result.tasks.graphPruning.linksSoftPruned,
        min_strength: cfg.graphPruneMinStrength,
        duration_ms: result.tasks.graphPruning.durationMs,
        skipped_backpressure: result.tasks.graphPruning.skippedBackpressure,
        skipped_cooldown: result.tasks.graphPruning.skippedCooldown,
        skipped_budget: result.tasks.graphPruning.skippedBudget,
      });
    } catch {
      // Non-critical — don't let metrics failure break the scheduler
    }
  }

  // ── Task 9: ACT-R Access Log Prune (v7.0) ──────────────────
  // Removes stale rows from memory_access_log older than the
  // configured retention window (default: 90 days). Prevents
  // unbounded table growth from the ACT-R frequency tracking.
  if (cfg.enableAccessLogPrune) {
    try {
      result.tasks.accessLogPrune.ran = true;
      const deleted = await storage.pruneAccessLog(cfg.accessLogRetentionDays);
      result.tasks.accessLogPrune.deleted = deleted;
      if (deleted > 0) {
        debugLog(`[Scheduler] Access log prune: deleted ${deleted} stale entries (>${cfg.accessLogRetentionDays}d)`);
      }
    } catch (err) {
      result.tasks.accessLogPrune.error = err instanceof Error ? err.message : String(err);
      debugLog(`[Scheduler] Access log prune error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  } finally {
    clearInterval(heartbeatInterval!);
    // Release Supabase distributed lock explicitly so the next sweep
    // on any node can start immediately (vs. waiting for expires_at).
    if (isSupabase) {
      await releaseSupabaseLock(processId);
      debugLog(`[Scheduler] Distributed lock released (pid: ${processId})`);
    }
  }

  // ── Finalize ───────────────────────────────────────────────
  result.completedAt = new Date().toISOString();
  result.durationMs = Date.now() - sweepStart;
  lastSweepResult = result;

  // WS4: Record total sweep duration into graph metrics for SLO exposure
  try {
    const { recordSweepDuration } = await import("./observability/graphMetrics.js");
    recordSweepDuration(result.durationMs);
  } catch {
    // Non-critical — don't let metrics recording break the scheduler
  }

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
  if (result.tasks.linkDecay.ran && result.tasks.linkDecay.linksDecayed > 0) {
    parts.push(`LinkDecay:${result.tasks.linkDecay.linksDecayed} links`);
  }
  if (result.tasks.edgeSynthesis.ran && result.tasks.edgeSynthesis.projectsSynthesized > 0) {
    parts.push(`Synthesis:${result.tasks.edgeSynthesis.newLinks} links in ${result.tasks.edgeSynthesis.projectsSynthesized} projects`);
  }
  if (result.tasks.accessLogPrune.ran && result.tasks.accessLogPrune.deleted > 0) {
    parts.push(`AccessLog:${result.tasks.accessLogPrune.deleted} stale entries pruned`);
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
