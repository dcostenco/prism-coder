/**
 * Graph Metrics — In-Memory Observability for Step 3B/4 Flows
 *
 * ═══════════════════════════════════════════════════════════════════
 * PURPOSE:
 *   Lightweight, zero-dependency metrics collection for graph synthesis
 *   and test-me flows. All state is in-memory (resets on restart).
 *
 * DESIGN:
 *   - Singleton counters + timestamps for synthesis and test-me
 *   - Bounded ring buffer (100 entries) for duration p50 approximation
 *   - Warning flags computed on snapshot (not continuously)
 *   - Structured JSON log emission via debugLog channel
 *   - resetGraphMetricsForTests() for test isolation
 *
 * METRICS MODEL:
 *   A) Synthesis: runs, failures, links created, candidates, below-threshold, duration
 *   B) Test-Me: requests, success, no_api_key, generation_failed, bad_request, duration
 *   C) Warning flags: quality drift, provider issues, failure rate
 * ═══════════════════════════════════════════════════════════════════
 */

import { debugLog } from "../utils/logger.js";

// ─── Ring Buffer for Duration Percentiles ────────────────────────

const RING_BUFFER_SIZE = 100;

class DurationBuffer {
  private buffer: number[] = [];
  private cursor = 0;
  private full = false;

  push(ms: number): void {
    if (this.buffer.length < RING_BUFFER_SIZE) {
      this.buffer.push(ms);
    } else {
      this.buffer[this.cursor] = ms;
      this.full = true;
    }
    this.cursor = (this.cursor + 1) % RING_BUFFER_SIZE;
  }

  getP50(): number | null {
    if (this.buffer.length === 0) return null;
    const sorted = [...this.buffer].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
      : sorted[mid];
  }

  getCount(): number {
    return this.full ? RING_BUFFER_SIZE : this.buffer.length;
  }

  reset(): void {
    this.buffer = [];
    this.cursor = 0;
    this.full = false;
  }
}

// ─── Metrics State ───────────────────────────────────────────────

interface SynthesisMetrics {
  runs_total: number;
  runs_failed: number;
  links_created_total: number;
  candidates_evaluated_total: number;
  below_threshold_total: number;
  skipped_links_total: number;
  last_run_at: string | null;
  last_status: "ok" | "error" | null;
  last_links_created: number;
  last_entries_scanned: number;
  duration_buffer: DurationBuffer;
}

interface TestMeMetrics {
  requests_total: number;
  success_total: number;
  no_api_key_total: number;
  generation_failed_total: number;
  bad_request_total: number;
  last_run_at: string | null;
  last_status: "success" | "no_api_key" | "generation_failed" | "bad_request" | "error" | null;
  duration_buffer: DurationBuffer;
}

interface SchedulerSynthesisMetrics {
  projects_processed_last: number;
  projects_succeeded_last: number;
  projects_failed_last: number;
  retries_last: number;
  links_created_last: number;
  duration_ms_last: number;
  skipped_backpressure_last: number;
  skipped_cooldown_last: number;
  skipped_budget_last: number;
  skipped_backoff_last: number;
  last_sweep_at: string | null;
}

interface WarningFlags {
  synthesis_quality_warning: boolean;
  testme_provider_warning: boolean;
  synthesis_failure_warning: boolean;
}

// ─── Singleton State ─────────────────────────────────────────────

let synthesis: SynthesisMetrics = createFreshSynthesisMetrics();
let testMe: TestMeMetrics = createFreshTestMeMetrics();
let schedulerSynthesis: SchedulerSynthesisMetrics = createFreshSchedulerMetrics();

function createFreshSynthesisMetrics(): SynthesisMetrics {
  return {
    runs_total: 0,
    runs_failed: 0,
    links_created_total: 0,
    candidates_evaluated_total: 0,
    below_threshold_total: 0,
    skipped_links_total: 0,
    last_run_at: null,
    last_status: null,
    last_links_created: 0,
    last_entries_scanned: 0,
    duration_buffer: new DurationBuffer(),
  };
}

function createFreshTestMeMetrics(): TestMeMetrics {
  return {
    requests_total: 0,
    success_total: 0,
    no_api_key_total: 0,
    generation_failed_total: 0,
    bad_request_total: 0,
    last_run_at: null,
    last_status: null,
    duration_buffer: new DurationBuffer(),
  };
}

function createFreshSchedulerMetrics(): SchedulerSynthesisMetrics {
  return {
    projects_processed_last: 0,
    projects_succeeded_last: 0,
    projects_failed_last: 0,
    retries_last: 0,
    links_created_last: 0,
    duration_ms_last: 0,
    skipped_backpressure_last: 0,
    skipped_cooldown_last: 0,
    skipped_budget_last: 0,
    skipped_backoff_last: 0,
    last_sweep_at: null,
  };
}

// ─── Structured Log Emission ─────────────────────────────────────

function emitGraphEvent(event: Record<string, unknown>): void {
  try {
    debugLog(JSON.stringify(event));
  } catch {
    // Non-critical — don't let logging failures break flows
  }
}

// ─── Recording Functions ─────────────────────────────────────────

export interface SynthesisRunData {
  project: string;
  status: "ok" | "error";
  duration_ms: number;
  entries_scanned?: number;
  candidates?: number;
  below_threshold?: number;
  new_links?: number;
  skipped_links?: number;
  error?: string;
}

export function recordSynthesisRun(data: SynthesisRunData): void {
  const now = new Date().toISOString();
  synthesis.runs_total++;
  synthesis.last_run_at = now;
  synthesis.last_status = data.status;
  synthesis.duration_buffer.push(data.duration_ms);

  if (data.status === "error") {
    synthesis.runs_failed++;
  } else {
    synthesis.links_created_total += data.new_links || 0;
    synthesis.candidates_evaluated_total += data.candidates || 0;
    synthesis.below_threshold_total += data.below_threshold || 0;
    synthesis.skipped_links_total += data.skipped_links || 0;
    synthesis.last_links_created = data.new_links || 0;
    synthesis.last_entries_scanned = data.entries_scanned || 0;
  }

  emitGraphEvent({
    event: "graph_synthesis_run",
    project: data.project,
    status: data.status,
    duration_ms: data.duration_ms,
    entries_scanned: data.entries_scanned ?? 0,
    candidates: data.candidates ?? 0,
    below_threshold: data.below_threshold ?? 0,
    new_links: data.new_links ?? 0,
    ...(data.error ? { error: data.error } : {}),
  });
}

export interface TestMeRequestData {
  project: string;
  node_id: string;
  status: "success" | "no_api_key" | "generation_failed" | "bad_request" | "error";
  duration_ms: number;
}

export function recordTestMeRequest(data: TestMeRequestData): void {
  const now = new Date().toISOString();
  testMe.requests_total++;
  testMe.last_run_at = now;
  testMe.last_status = data.status;
  testMe.duration_buffer.push(data.duration_ms);

  switch (data.status) {
    case "success":
      testMe.success_total++;
      break;
    case "no_api_key":
      testMe.no_api_key_total++;
      break;
    case "generation_failed":
      testMe.generation_failed_total++;
      break;
    case "bad_request":
      testMe.bad_request_total++;
      break;
    // "error" increments only requests_total (catch-all)
  }

  emitGraphEvent({
    event: "graph_testme_request",
    project: data.project,
    node_id: data.node_id,
    status: data.status,
    duration_ms: data.duration_ms,
  });
}

export interface SchedulerSynthesisData {
  projects_processed: number;
  projects_succeeded: number;
  projects_failed: number;
  retries: number;
  links_created: number;
  duration_ms: number;
  skipped_backpressure: number;
  skipped_cooldown: number;
  skipped_budget: number;
  skipped_backoff: number;
}

export function recordSchedulerSynthesis(data: SchedulerSynthesisData): void {
  const now = new Date().toISOString();
  schedulerSynthesis.projects_processed_last = data.projects_processed;
  schedulerSynthesis.projects_succeeded_last = data.projects_succeeded;
  schedulerSynthesis.projects_failed_last = data.projects_failed;
  schedulerSynthesis.retries_last = data.retries;
  schedulerSynthesis.links_created_last = data.links_created;
  schedulerSynthesis.duration_ms_last = data.duration_ms;
  schedulerSynthesis.skipped_backpressure_last = data.skipped_backpressure;
  schedulerSynthesis.skipped_cooldown_last = data.skipped_cooldown;
  schedulerSynthesis.skipped_budget_last = data.skipped_budget;
  schedulerSynthesis.skipped_backoff_last = data.skipped_backoff;
  schedulerSynthesis.last_sweep_at = now;

  emitGraphEvent({
    event: "graph_scheduler_synthesis",
    projects_processed: data.projects_processed,
    projects_succeeded: data.projects_succeeded,
    projects_failed: data.projects_failed,
    retries: data.retries,
    links_created: data.links_created,
    duration_ms: data.duration_ms,
    skipped_backpressure: data.skipped_backpressure,
    skipped_cooldown: data.skipped_cooldown,
    skipped_budget: data.skipped_budget,
    skipped_backoff: data.skipped_backoff,
  });
}

// ─── Warning Flag Computation ────────────────────────────────────

function computeWarningFlags(): WarningFlags {
  // Quality warning: >85% of candidates are below threshold (min 50 candidates)
  const synthesis_quality_warning =
    synthesis.candidates_evaluated_total >= 50 &&
    synthesis.below_threshold_total / synthesis.candidates_evaluated_total > 0.85;

  // Provider warning: test-me has been called but never succeeded
  const testme_provider_warning =
    testMe.no_api_key_total > 0 && testMe.success_total === 0;

  // Failure rate warning: >20% of synthesis runs failed (min 5 runs)
  const synthesis_failure_warning =
    synthesis.runs_total >= 5 &&
    synthesis.runs_failed / synthesis.runs_total > 0.2;

  return {
    synthesis_quality_warning,
    testme_provider_warning,
    synthesis_failure_warning,
  };
}

// ─── Snapshot ────────────────────────────────────────────────────

export interface GraphMetricsSnapshot {
  synthesis: {
    runs_total: number;
    runs_failed: number;
    links_created_total: number;
    candidates_evaluated_total: number;
    below_threshold_total: number;
    skipped_links_total: number;
    last_run_at: string | null;
    last_status: string | null;
    last_links_created: number;
    last_entries_scanned: number;
    duration_p50_ms: number | null;
  };
  testMe: {
    requests_total: number;
    success_total: number;
    no_api_key_total: number;
    generation_failed_total: number;
    bad_request_total: number;
    last_run_at: string | null;
    last_status: string | null;
    duration_p50_ms: number | null;
  };
  scheduler: {
    projects_processed_last: number;
    projects_succeeded_last: number;
    projects_failed_last: number;
    retries_last: number;
    links_created_last: number;
    duration_ms_last: number;
    skipped_backpressure_last: number;
    skipped_cooldown_last: number;
    skipped_budget_last: number;
    skipped_backoff_last: number;
    last_sweep_at: string | null;
  };
  warnings: WarningFlags;
}

export function getGraphMetricsSnapshot(): GraphMetricsSnapshot {
  return {
    synthesis: {
      runs_total: synthesis.runs_total,
      runs_failed: synthesis.runs_failed,
      links_created_total: synthesis.links_created_total,
      candidates_evaluated_total: synthesis.candidates_evaluated_total,
      below_threshold_total: synthesis.below_threshold_total,
      skipped_links_total: synthesis.skipped_links_total,
      last_run_at: synthesis.last_run_at,
      last_status: synthesis.last_status,
      last_links_created: synthesis.last_links_created,
      last_entries_scanned: synthesis.last_entries_scanned,
      duration_p50_ms: synthesis.duration_buffer.getP50(),
    },
    testMe: {
      requests_total: testMe.requests_total,
      success_total: testMe.success_total,
      no_api_key_total: testMe.no_api_key_total,
      generation_failed_total: testMe.generation_failed_total,
      bad_request_total: testMe.bad_request_total,
      last_run_at: testMe.last_run_at,
      last_status: testMe.last_status,
      duration_p50_ms: testMe.duration_buffer.getP50(),
    },
    scheduler: {
      projects_processed_last: schedulerSynthesis.projects_processed_last,
      projects_succeeded_last: schedulerSynthesis.projects_succeeded_last,
      projects_failed_last: schedulerSynthesis.projects_failed_last,
      retries_last: schedulerSynthesis.retries_last,
      links_created_last: schedulerSynthesis.links_created_last,
      duration_ms_last: schedulerSynthesis.duration_ms_last,
      skipped_backpressure_last: schedulerSynthesis.skipped_backpressure_last,
      skipped_cooldown_last: schedulerSynthesis.skipped_cooldown_last,
      skipped_budget_last: schedulerSynthesis.skipped_budget_last,
      skipped_backoff_last: schedulerSynthesis.skipped_backoff_last,
      last_sweep_at: schedulerSynthesis.last_sweep_at,
    },
    warnings: computeWarningFlags(),
  };
}

// ─── Test Helper ─────────────────────────────────────────────────

export function resetGraphMetricsForTests(): void {
  synthesis = createFreshSynthesisMetrics();
  testMe = createFreshTestMeMetrics();
  schedulerSynthesis = createFreshSchedulerMetrics();
}
