/**
 * Dark Factory Background Runner (v7.3)
 *
 * Non-blocking background loop that:
 *   1. On startup: marks stale RUNNING pipelines as FAILED ("Unexpected Server Termination")
 *   2. On each tick: picks up RUNNING pipelines and advances their step
 *   3. Executes the PLAN → EXECUTE → VERIFY → iterate cycle
 *   4. Pulses heartbeat during LLM execution
 *   5. Sweeps for zombie pipelines (lapsed heartbeats)
 *   6. Emits experience events on completion/failure
 *
 * CRITICAL: This module MUST NOT block the MCP event loop.
 *   - Uses setInterval (not while-true) to yield between ticks
 *   - All errors are caught — crashes never propagate to the MCP server
 *   - Only ONE pipeline step executes per tick (sequential, not parallel)
 *
 * CRITICAL: All logging MUST use console.error() (stderr).
 *   Using console.log() (stdout) will corrupt the MCP JSON-RPC stream.
 */

import { getStorage } from '../storage/index.js';
import type { PipelineState, PipelineStatus } from '../storage/interface.js';
import type { PipelineSpec, DarkFactoryStep, IterationResult } from './schema.js';
import { SafetyController } from './safetyController.js';
import { invokeClawAgent } from './clawInvocation.js';
import { PRISM_DARK_FACTORY_POLL_MS, PRISM_USER_ID } from '../config.js';
import { debugLog } from '../utils/logger.js';

/** Interval handle for graceful shutdown */
let runnerInterval: ReturnType<typeof setInterval> | null = null;

/** Tracks whether the runner is currently processing a tick (prevents overlap) */
let tickInProgress = false;

// ─── Startup Initialization ──────────────────────────────────

/**
 * Called once during server startup after storage is warm.
 * Marks any stale RUNNING pipelines as FAILED — they were orphaned
 * by a previous server crash or OOM event.
 */
async function recoverStalePipelines(): Promise<void> {
  try {
    const storage = await getStorage();
    const runningPipelines = await storage.listPipelines(undefined, 'RUNNING', PRISM_USER_ID);

    if (runningPipelines.length === 0) {
      debugLog('[DarkFactory] No stale pipelines found on startup.');
      return;
    }

    debugLog(`[DarkFactory] Found ${runningPipelines.length} stale RUNNING pipeline(s) — marking as FAILED.`);

    for (const pipeline of runningPipelines) {
      try {
        await storage.savePipeline({
          ...pipeline,
          status: 'FAILED',
          error: 'Unexpected Server Termination: pipeline was RUNNING when server restarted.',
          current_step: pipeline.current_step,
        });
        debugLog(`[DarkFactory] Pipeline ${pipeline.id} marked FAILED (was RUNNING on restart).`);
      } catch (err) {
        // Status guard may fire if pipeline was already ABORTED/COMPLETED
        // by a concurrent process — safe to ignore.
        console.error(`[DarkFactory] Failed to recover pipeline ${pipeline.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    console.error(`[DarkFactory] Startup recovery failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Heartbeat ─────────────────────────────────────────────────

/**
 * Pulse the heartbeat timestamp for a running pipeline.
 * Called periodically during LLM execution to prove liveness.
 * This is intentionally cheap — just a timestamp update.
 */
async function pulseHeartbeat(pipelineId: string, userId: string): Promise<void> {
  try {
    const storage = await getStorage();
    const pipeline = await storage.getPipeline(pipelineId, userId);
    if (!pipeline || pipeline.status !== 'RUNNING') return;

    await storage.savePipeline({
      ...pipeline,
      last_heartbeat: new Date().toISOString(),
    });
  } catch {
    // Heartbeat failures are non-fatal — the zombie sweep will catch it
  }
}

/**
 * Creates a heartbeat interval that pulses every 15 seconds during execution.
 * Returns a cleanup function to stop the interval.
 */
function startHeartbeatInterval(pipelineId: string, userId: string): () => void {
  const interval = setInterval(() => {
    pulseHeartbeat(pipelineId, userId).catch(() => {});
  }, 15_000);

  return () => clearInterval(interval);
}

// ─── Zombie Sweep ─────────────────────────────────────────────

/**
 * Find RUNNING pipelines whose heartbeat has lapsed and mark them FAILED.
 * This catches pipelines where the LLM call silently hung or the runner
 * crashed mid-execution without updating status.
 */
async function sweepZombies(): Promise<void> {
  try {
    const storage = await getStorage();
    const running = await storage.listPipelines(undefined, 'RUNNING', PRISM_USER_ID);

    for (const pipeline of running) {
      if (SafetyController.isHeartbeatLapsed(pipeline)) {
        debugLog(`[DarkFactory] Zombie detected: pipeline ${pipeline.id} heartbeat lapsed.`);

        try {
          await storage.savePipeline({
            ...pipeline,
            status: 'FAILED',
            error: `Zombie pipeline: no heartbeat for ${SafetyController.HEARTBEAT_TIMEOUT_MS / 1000}s.`,
          });
        } catch {
          // Status guard may fire — pipeline was already terminated
        }

        // Emit failure experience event
        await emitExperienceEvent(pipeline, 'failure', 'Pipeline zombie-swept due to heartbeat lapse.');
      }
    }
  } catch (err) {
    console.error(`[DarkFactory] Zombie sweep failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Experience Event Emission ─────────────────────────────────

/**
 * Emit a structured experience event to the session ledger.
 * This feeds the ML routing system (v7.2) so future pipelines benefit
 * from past success/failure patterns.
 */
async function emitExperienceEvent(
  pipeline: PipelineState,
  eventType: 'success' | 'failure',
  outcome: string
): Promise<void> {
  try {
    const storage = await getStorage();
    const spec: PipelineSpec = JSON.parse(pipeline.spec);

    const summary = `[${eventType.toUpperCase()}] Dark Factory pipeline ${pipeline.id} → ${spec.objective.slice(0, 100)} → ${outcome.slice(0, 200)}`;

    // Use saveLedger directly (same pattern as sessionSaveExperienceHandler)
    await storage.saveLedger({
      project: pipeline.project,
      conversation_id: `dark-factory-${pipeline.id}`,
      user_id: pipeline.user_id,
      event_type: eventType,
      summary,
      decisions: [
        `Context: Dark Factory autonomous pipeline`,
        `Action: ${spec.objective.slice(0, 200)}`,
        `Outcome: ${outcome.slice(0, 200)}`,
        `Iterations: ${pipeline.iteration}`,
        `Final Step: ${pipeline.current_step}`,
      ],
      keywords: ['dark-factory', 'autonomous', eventType, pipeline.project],
      importance: eventType === 'failure' ? 1 : 0,
    });

    debugLog(`[DarkFactory] Experience event emitted: ${eventType} for pipeline ${pipeline.id}`);
  } catch (err) {
    // Experience events are advisory — never block execution
    console.error(`[DarkFactory] Experience event failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Step Execution ────────────────────────────────────────────

/**
 * Execute a single step of the pipeline.
 * Returns an IterationResult with success/failure status.
 */
async function executeStep(
  pipeline: PipelineState,
  spec: PipelineSpec
): Promise<IterationResult> {
  const stepStart = new Date().toISOString();
  const step = pipeline.current_step as DarkFactoryStep;

  debugLog(`[DarkFactory] Executing step=${step} iter=${pipeline.iteration} pipeline=${pipeline.id}`);

  // Start heartbeat pulse during LLM execution
  const stopHeartbeat = startHeartbeatInterval(pipeline.id, pipeline.user_id);

  try {
    // All steps use the Claw invocation wrapper which applies:
    // - SafetyController boundary prompt
    // - BYOM model override
    // - Timeout enforcement
    const { success, resultText } = await invokeClawAgent(spec, pipeline);

    return {
      iteration: pipeline.iteration,
      step,
      started_at: stepStart,
      completed_at: new Date().toISOString(),
      success,
      notes: resultText.slice(0, 2000), // Cap notes to prevent DB bloat
    };
  } finally {
    stopHeartbeat();
  }
}

// ─── Main Tick ─────────────────────────────────────────────────

/**
 * A single tick of the runner loop. Picks up one RUNNING pipeline
 * and advances it by one step.
 *
 * Design: Sequential execution (one pipeline per tick) to prevent
 * resource starvation. The poll interval (default 30s) determines throughput.
 */
async function runnerTick(): Promise<void> {
  // Guard: prevent overlapping ticks if a previous LLM call runs long
  if (tickInProgress) {
    debugLog('[DarkFactory] Tick skipped — previous tick still in progress.');
    return;
  }

  tickInProgress = true;

  try {
    // Phase 1: Zombie sweep (cheap — just DB reads)
    await sweepZombies();

    // Phase 2: Find a RUNNING pipeline to advance
    const storage = await getStorage();
    const running = await storage.listPipelines(undefined, 'RUNNING', PRISM_USER_ID);

    if (running.length === 0) {
      return; // Nothing to do
    }

    // Pick the oldest updated pipeline (FIFO fairness)
    const pipeline = running.sort(
      (a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
    )[0];

    // Poison Pill Guard: Parse spec with localized error handling.
    // If a pipeline has corrupt/invalid JSON in its spec column,
    // we MUST mark it FAILED immediately. Otherwise the runner will
    // re-fetch the same broken pipeline every tick (infinite loop).
    let spec: PipelineSpec;
    try {
      spec = JSON.parse(pipeline.spec);
    } catch (parseErr) {
      debugLog(`[DarkFactory] Pipeline ${pipeline.id} has invalid spec JSON — marking FAILED.`);
      try {
        await storage.savePipeline({
          ...pipeline,
          status: 'FAILED',
          error: `Invalid spec JSON: ${parseErr instanceof Error ? parseErr.message : 'parse error'}`,
        });
      } catch {
        // Status guard — already terminated
      }
      return;
    }

    // Safety check: wall-clock runtime exceeded?
    if (SafetyController.isRuntimeExceeded(pipeline)) {
      debugLog(`[DarkFactory] Pipeline ${pipeline.id} exceeded max runtime — aborting.`);

      try {
        await storage.savePipeline({
          ...pipeline,
          status: 'FAILED',
          error: `Pipeline exceeded maximum runtime (${PRISM_DARK_FACTORY_POLL_MS}ms). Aborted by safety controller.`,
        });
      } catch {
        // Status guard — already terminated
      }

      await emitExperienceEvent(pipeline, 'failure', 'Exceeded maximum runtime.');
      return;
    }

    // Safety check: iteration limit exceeded?
    if (!SafetyController.validateIterationLimit(pipeline.iteration, spec)) {
      debugLog(`[DarkFactory] Pipeline ${pipeline.id} exceeded iteration limit — aborting.`);

      try {
        await storage.savePipeline({
          ...pipeline,
          status: 'FAILED',
          error: `Pipeline exceeded max iterations (${spec.maxIterations}). Aborted by safety controller.`,
        });
      } catch {
        // Status guard
      }

      await emitExperienceEvent(pipeline, 'failure', `Exceeded max iterations (${spec.maxIterations}).`);
      return;
    }

    // Execute the current step
    const result = await executeStep(pipeline, spec);

    // Determine next step based on result
    const currentStep = pipeline.current_step as DarkFactoryStep;
    const nextStep = SafetyController.getNextStep(
      currentStep,
      pipeline.iteration,
      spec,
      result.success // For VERIFY step: success means tests passed
    );

    if (nextStep === null || currentStep === 'FINALIZE') {
      // Pipeline complete — determine final status
      const finalStatus: PipelineStatus = result.success ? 'COMPLETED' : 'FAILED';
      const finalError = result.success ? null : `Pipeline ended at step=${currentStep}: ${result.notes?.slice(0, 500)}`;

      try {
        await storage.savePipeline({
          ...pipeline,
          status: finalStatus,
          current_step: 'FINALIZE',
          error: finalError,
          last_heartbeat: new Date().toISOString(),
        });
      } catch (err) {
        // Kill switch: if savePipeline throws "Cannot update pipeline... already ABORTED",
        // someone externally killed this pipeline. Respect the kill.
        if (err instanceof Error && err.message.includes('Cannot update pipeline')) {
          debugLog(`[DarkFactory] Kill switch activated for pipeline ${pipeline.id}: ${err.message}`);
          return;
        }
        throw err;
      }

      await emitExperienceEvent(
        { ...pipeline, status: finalStatus, current_step: 'FINALIZE' },
        result.success ? 'success' : 'failure',
        result.success
          ? `Pipeline completed successfully after ${pipeline.iteration} iteration(s).`
          : `Pipeline failed at step=${currentStep}: ${result.notes?.slice(0, 200)}`
      );

      debugLog(`[DarkFactory] Pipeline ${pipeline.id} finished: ${finalStatus}`);
    } else {
      // Advance to next step
      try {
        await storage.savePipeline({
          ...pipeline,
          current_step: nextStep.step,
          iteration: nextStep.iteration,
          last_heartbeat: new Date().toISOString(),
        });
      } catch (err) {
        // Kill switch detection
        if (err instanceof Error && err.message.includes('Cannot update pipeline')) {
          debugLog(`[DarkFactory] Kill switch activated for pipeline ${pipeline.id}: ${err.message}`);
          return;
        }
        throw err;
      }

      debugLog(`[DarkFactory] Pipeline ${pipeline.id} advanced: ${currentStep} → ${nextStep.step} (iter ${nextStep.iteration})`);
    }
  } catch (err) {
    // Top-level catch: NEVER let runner errors crash the MCP server
    console.error(`[DarkFactory] Runner tick error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    tickInProgress = false;
  }
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Start the Dark Factory background runner.
 * Called once during server startup, after storage is warm.
 *
 * This function:
 *   1. Recovers stale pipelines from a previous crash
 *   2. Starts the continuous poll loop (non-blocking setInterval)
 *
 * The runner is designed to be invisible to the MCP client.
 * It never blocks tool calls or resource requests.
 */
export async function startDarkFactoryRunner(): Promise<void> {
  debugLog(`[DarkFactory] Starting background runner (poll interval: ${PRISM_DARK_FACTORY_POLL_MS}ms)`);

  // Phase 1: Recover any stale pipelines from previous crash
  await recoverStalePipelines();

  // Phase 2: Start the continuous poll loop
  // setInterval ensures we yield to the event loop between ticks
  runnerInterval = setInterval(() => {
    runnerTick().catch(err => {
      console.error(`[DarkFactory] Unhandled tick error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, PRISM_DARK_FACTORY_POLL_MS);

  // Prevent the interval from keeping the process alive if MCP client disconnects
  if (runnerInterval && typeof runnerInterval.unref === 'function') {
    runnerInterval.unref();
  }

  debugLog('[DarkFactory] Background runner started.');
}

/**
 * Stop the Dark Factory background runner.
 * Called during graceful shutdown.
 */
export function stopDarkFactoryRunner(): void {
  if (runnerInterval) {
    clearInterval(runnerInterval);
    runnerInterval = null;
    debugLog('[DarkFactory] Background runner stopped.');
  }
}
