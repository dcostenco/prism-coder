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
import type { PipelineSpec, DarkFactoryStep, IterationResult, ExecutionStepResult, ActionPayload, ContractPayload, EvaluationPayload } from './schema.js';
import { VALID_ACTION_TYPES } from './schema.js';
import { SafetyController } from './safetyController.js';
import { invokeClawAgent } from './clawInvocation.js';
import { PRISM_DARK_FACTORY_POLL_MS, PRISM_DARK_FACTORY_MAX_RUNTIME_MS, PRISM_USER_ID, PRISM_VERIFICATION_LAYERS, PRISM_VERIFICATION_DEFAULT_SEVERITY } from '../config.js';
import { debugLog } from '../utils/logger.js';
import path from 'path';
import fs from 'fs';
import * as crypto from 'crypto';
import { Gatekeeper } from '../verification/gatekeeper.js';
import { VerificationRunner } from '../verification/runner.js';
import { computeRubricHash, type ValidationResult, type VerificationConfig, type VerificationHarness } from '../verification/schema.js';
import { VerificationGateError } from '../errors.js';

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

// ─── EXECUTE Output Parsing ────────────────────────────────────

/**
 * Defensively parse raw LLM output into an ExecutionStepResult.
 *
 * The LLM is instructed to return pure JSON, but in practice may:
 *   - Wrap JSON in markdown code fences (```json ... ```)
 *   - Include preamble text before the JSON ("Here's my output:\n{...}")
 *   - Include trailing commentary after the JSON
 *
 * Extraction strategy (ordered from most to least precise):
 *   1. Try raw input as-is (pure JSON)
 *   2. Strip markdown code fences and try the inner content
 *   3. Extract first { ... last } and try as JSON (brace extraction)
 *   4. Give up — return parse error
 *
 * After successful JSON parse, validates shape:
 *   - Root must be an object with `actions` array
 *   - Each action must have a valid ActionType and non-empty targetPath
 *
 * Returns { parsed, error } — exactly one will be non-null.
 *
 * @internal Exported for unit testing only. Not part of the public API.
 */
function extractJsonFromLlmOutput(raw: string): { json: string | null; error: string | null } {
  if (!raw || typeof raw !== 'string' || raw.trim() === '') {
    return { json: null, error: 'JSON Parse Error: empty or non-string input' };
  }

  const cleaned = raw.trim();
  let jsonCandidate: string | null = null;

  if (cleaned.startsWith('{')) {
    jsonCandidate = cleaned;
  }
  if (!jsonCandidate) {
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      jsonCandidate = fenceMatch[1].trim();
    }
  }
  if (!jsonCandidate) {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonCandidate = cleaned.slice(firstBrace, lastBrace + 1);
    }
  }

  if (!jsonCandidate) {
    return { json: null, error: 'JSON Parse Error: no JSON object found in LLM output' };
  }
  return { json: jsonCandidate, error: null };
}

export function parseExecuteOutput(raw: string): { parsed: ExecutionStepResult | null; error: string | null } {
  const ext = extractJsonFromLlmOutput(raw);
  if (ext.error || !ext.json) return { parsed: null, error: ext.error };

  let parsed: unknown;
  try {
    parsed = JSON.parse(ext.json);
  } catch {
    return { parsed: null, error: 'JSON Parse Error: LLM output is not valid JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { parsed: null, error: 'Shape Error: output is not a JSON object' };
  }

  if (!Array.isArray((parsed as any).actions)) {
    return { parsed: null, error: 'Shape Error: output missing required "actions" array' };
  }

  const result = parsed as ExecutionStepResult;

  for (let i = 0; i < result.actions.length; i++) {
    const action = result.actions[i];
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      return { parsed: null, error: `Shape Error: actions[${i}] is not an object` };
    }
    if (!action.type || !VALID_ACTION_TYPES.includes(action.type as any)) {
      return { parsed: null, error: `Shape Error: actions[${i}].type "${action.type}" is not a valid ActionType` };
    }
    if (!action.targetPath || typeof action.targetPath !== 'string' || action.targetPath.trim() === '') {
      return { parsed: null, error: `Shape Error: actions[${i}].targetPath is empty or missing` };
    }
  }

  return { parsed: result, error: null };
}

export function parseContractOutput(raw: string): { parsed: ContractPayload | null; error: string | null } {
  const ext = extractJsonFromLlmOutput(raw);
  if (ext.error || !ext.json) return { parsed: null, error: ext.error };

  let parsed: unknown;
  try {
    parsed = JSON.parse(ext.json);
  } catch {
    return { parsed: null, error: 'JSON Parse Error: LLM output is not valid JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as any).criteria)) {
    return { parsed: null, error: 'Shape Error: output missing required "criteria" array' };
  }

  // Validate each criterion element has the required string fields
  for (let i = 0; i < (parsed as any).criteria.length; i++) {
    const c = (parsed as any).criteria[i];
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || typeof c.description !== 'string') {
      return { parsed: null, error: `Shape Error: criteria[${i}] must have string "id" and "description"` };
    }
  }

  return { parsed: parsed as ContractPayload, error: null };
}

export function parseEvaluationOutput(raw: string): { parsed: EvaluationPayload | null; error: string | null } {
  const ext = extractJsonFromLlmOutput(raw);
  if (ext.error || !ext.json) return { parsed: null, error: ext.error };

  let parsed: unknown;
  try {
    parsed = JSON.parse(ext.json);
  } catch {
    return { parsed: null, error: 'JSON Parse Error: LLM output is not valid JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || typeof (parsed as any).pass !== 'boolean') {
    return { parsed: null, error: 'Shape Error: output missing required "pass" boolean' };
  }

  const p = parsed as any;
  if (p.findings !== undefined) {
    if (!Array.isArray(p.findings)) {
      return { parsed: null, error: 'Shape Error: "findings" must be an array when present' };
    }
    // Fix #3: Each failing finding must supply an evidence object so the
    // Evaluator cannot submit bare severity claims without evidence pointers.
    for (let i = 0; i < p.findings.length; i++) {
      const f = p.findings[i];
      if (!f || typeof f !== 'object') {
        return { parsed: null, error: `Shape Error: findings[${i}] must be an object` };
      }
      if (f.pass_fail === false && (!f.evidence || typeof f.evidence !== 'object')) {
        return { parsed: null, error: `Shape Error: findings[${i}] is missing required "evidence" object for failure` };
      }
    }
  }

  return { parsed: parsed as EvaluationPayload, error: null };
}

// ─── Step Execution ────────────────────────────────────────────

/**
 * Execute a single step of the pipeline.
 * Returns an IterationResult with success/failure status.
 *
 * v7.3.1: EXECUTE steps are parsed as structured JSON. Malformed output
 * or out-of-scope actions cause immediate step failure (fail closed).
 * The `scopeViolation` field on the result signals the runner to
 * terminate the entire pipeline (not just the step).
 */
async function executeStep(
  pipeline: PipelineState,
  spec: PipelineSpec
): Promise<IterationResult & { scopeViolation?: string }> {
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

    // For non-JSON steps, return as-is (free-form text)
    if (step !== 'EXECUTE' && step !== 'PLAN_CONTRACT' && step !== 'EVALUATE') {
      return {
        iteration: pipeline.iteration,
        step,
        started_at: stepStart,
        completed_at: new Date().toISOString(),
        success,
        notes: resultText.slice(0, 2000),
      };
    }

    if (!success) {
      // LLM invocation itself failed (timeout, error, etc.)
      return {
        iteration: pipeline.iteration,
        step,
        started_at: stepStart,
        completed_at: new Date().toISOString(),
        success: false,
        notes: `LLM invocation failed: ${resultText.slice(0, 500)}`,
      };
    }

    // Parse appropriate JSON output depending on step
    if (step === 'PLAN_CONTRACT') {
      const { parsed, error: parseError } = parseContractOutput(resultText);
      if (parseError || !parsed) {
        debugLog(`[DarkFactory] PLAN_CONTRACT output parse failure: ${parseError}`);
        return {
          iteration: pipeline.iteration,
          step,
          started_at: stepStart,
          completed_at: new Date().toISOString(),
          success: false,
          notes: parseError || 'Unknown parse error',
        };
      }
      
      return {
        iteration: pipeline.iteration,
        step,
        started_at: stepStart,
        completed_at: new Date().toISOString(),
        success: true,
        notes: `Contract accepted with ${parsed.criteria.length} criteria.`,
        contractPayload: parsed, // Passthrough for runner to write to disk
      } as any;
    }
    
    if (step === 'EVALUATE') {
      const { parsed, error: parseError } = parseEvaluationOutput(resultText);
      if (parseError || !parsed) {
        debugLog(`[DarkFactory] EVALUATE output parse failure: ${parseError}`);
        return {
          iteration: pipeline.iteration,
          step,
          started_at: stepStart,
          completed_at: new Date().toISOString(),
          success: false,
          notes: parseError || 'Unknown parse error',
        };
      }
      
      // Fix #2: Serialize findings array into notes so the Generator's retry
      // prompt receives the full line-by-line critique, not just a summary string.
      const findingsText = parsed.findings && parsed.findings.length > 0
        ? '\nFindings:\n' + parsed.findings.map((f: any) =>
            `- [${f.severity}] Criterion ${f.criterion_id}: ${
              f.evidence?.description || 'Failed'
            } (${f.evidence?.file || 'unknown'}:${f.evidence?.line ?? '?'})`
          ).join('\n')
        : '';

      return {
        iteration: pipeline.iteration,
        step,
        started_at: stepStart,
        completed_at: new Date().toISOString(),
        success: parsed.pass,
        notes: (parsed.notes || `Evaluation complete: ${parsed.pass ? 'PASS' : 'FAIL'}`) + findingsText,
        evaluationPayload: parsed, // Passthrough for orchestrator logic
      } as any;
    }

    // EXECUTE
    const { parsed, error: parseError } = parseExecuteOutput(resultText);

    if (parseError || !parsed) {
      debugLog(`[DarkFactory] EXECUTE output parse failure: ${parseError}`);
      return {
        iteration: pipeline.iteration,
        step,
        started_at: stepStart,
        completed_at: new Date().toISOString(),
        success: false,
        notes: parseError || 'Unknown parse error',
      };
    }

    // Empty actions array is valid (LLM decided nothing needs doing)
    if (parsed.actions.length === 0) {
      return {
        iteration: pipeline.iteration,
        step,
        started_at: stepStart,
        completed_at: new Date().toISOString(),
        success: true,
        notes: parsed.notes || 'No actions taken',
      };
    }

    // Validate ALL actions are within scope BEFORE any execution
    const scopeError = SafetyController.validateActionsInScope(parsed.actions, spec);
    if (scopeError) {
      debugLog(`[DarkFactory] EXECUTE scope violation: ${scopeError}`);
      return {
        iteration: pipeline.iteration,
        step,
        started_at: stepStart,
        completed_at: new Date().toISOString(),
        success: false,
        notes: `Scope Violation: ${scopeError}`,
        scopeViolation: scopeError,
      };
    }

    // All actions validated — return success with structured notes
    return {
      iteration: pipeline.iteration,
      step,
      started_at: stepStart,
      completed_at: new Date().toISOString(),
      success: true,
      notes: parsed.notes || `Executed ${parsed.actions.length} action(s) successfully`,
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

    // Phase 2: Promote PENDING → RUNNING, then find a RUNNING pipeline to advance
    const storage = await getStorage();

    // Pick up PENDING pipelines and promote to RUNNING (queue → active)
    const pending = await storage.listPipelines(undefined, 'PENDING', PRISM_USER_ID);
    if (pending.length > 0) {
      // Promote oldest PENDING pipeline (FIFO)
      const toPromote = pending.sort(
        (a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
      )[0];
      debugLog(`[DarkFactory] Promoting PENDING pipeline ${toPromote.id} → RUNNING`);
      await storage.savePipeline({ ...toPromote, status: 'RUNNING' });
    }

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
          error: `Pipeline exceeded maximum runtime (${PRISM_DARK_FACTORY_MAX_RUNTIME_MS}ms). Aborted by safety controller.`,
        });
      } catch {
        // Status guard — already terminated
      }

      await emitExperienceEvent(pipeline, 'failure', 'Exceeded maximum runtime.');
      return;
    }

    // Safety check: runtime path-scope enforcement
    // Validates that the working directory exists and is a real path.
    // isPathWithinScope() is called later during actual file operations,
    // but we gate-check the workspace root here to fail fast.
    if (spec.workingDirectory) {
      const resolvedDir = path.resolve(spec.workingDirectory);
      if (!fs.existsSync(resolvedDir)) {
        debugLog(`[DarkFactory] Pipeline ${pipeline.id} working directory does not exist: ${spec.workingDirectory}`);
        try {
          await storage.savePipeline({
            ...pipeline,
            status: 'FAILED',
            error: `Working directory does not exist: ${spec.workingDirectory}`,
          });
        } catch { /* Status guard */ }
        await emitExperienceEvent(pipeline, 'failure', `Working directory not found: ${spec.workingDirectory}`);
        return;
      }

      // Verify path scope — prevents path traversal attacks where
      // a crafted spec.workingDirectory escapes the intended scope.
      if (!SafetyController.isPathWithinScope(resolvedDir, spec)) {
        debugLog(`[DarkFactory] Pipeline ${pipeline.id} working directory out of scope: ${spec.workingDirectory}`);
        try {
          await storage.savePipeline({
            ...pipeline,
            status: 'FAILED',
            error: `Working directory out of permitted scope: ${spec.workingDirectory}`,
          });
        } catch { /* Status guard */ }
        await emitExperienceEvent(pipeline, 'failure', `Path scope violation: ${spec.workingDirectory}`);
        return;
      }
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

    // v7.3.1: Scope violation in EXECUTE step → immediate pipeline termination
    if ('scopeViolation' in result && result.scopeViolation) {
      debugLog(`[DarkFactory] Pipeline ${pipeline.id} terminated: scope violation in EXECUTE step.`);

      try {
        await storage.savePipeline({
          ...pipeline,
          status: 'FAILED',
          error: `Scope violation during EXECUTE: ${result.scopeViolation}`,
        });
      } catch { /* Status guard */ }

      await emitExperienceEvent(pipeline, 'failure', `Scope violation: ${result.scopeViolation}`);
      return;
    }

    const currentStep = pipeline.current_step as DarkFactoryStep;

    // ── Phase 4: Verification Pipeline Orchestrator ──
    if (currentStep === 'VERIFY' && spec.workingDirectory) {
      const harnessPath = path.join(path.resolve(spec.workingDirectory), 'verification_harness.json');
      if (fs.existsSync(harnessPath)) {
        try {
          const rawHarness = fs.readFileSync(harnessPath, 'utf8');
          const harnessData = JSON.parse(rawHarness);

          // GAP-5 fix: Persist the harness so CLI drift detection works for DarkFactory runs
          const rubricHash = computeRubricHash(harnessData.tests);
          const harness: VerificationHarness = {
            ...harnessData,
            project: pipeline.project,
            conversation_id: `dark-factory-${pipeline.id}`,
            created_at: new Date().toISOString(),
            rubric_hash: rubricHash,
          };
          await storage.saveVerificationHarness(harness, pipeline.user_id);

          // GAP-2 fix: Build VerificationConfig from env vars so PRISM_VERIFICATION_LAYERS
          // and PRISM_VERIFICATION_DEFAULT_SEVERITY are respected in DarkFactory pipelines
          const vConfig: VerificationConfig = {
            enabled: true,
            layers: PRISM_VERIFICATION_LAYERS,
            default_severity: PRISM_VERIFICATION_DEFAULT_SEVERITY,
          };
          const verificationResult = await VerificationRunner.runSuite(rawHarness, {
            harness,
            layers: PRISM_VERIFICATION_LAYERS,
            config: vConfig,
          });
          
          const coverageScore = verificationResult.total > 0 ? (verificationResult.total - verificationResult.skipped_count) / verificationResult.total : 0;
          const executedCount = verificationResult.total - verificationResult.skipped_count;
          const passRate = executedCount > 0 ? verificationResult.passed_count / executedCount : 0;

          // GAP-4 fix: Use proper ValidationResult type instead of `any`
          const valResult: ValidationResult = {
            id: crypto.randomUUID(),
            rubric_hash: rubricHash,
            project: pipeline.project,
            conversation_id: `dark-factory-${pipeline.id}`,
            run_at: new Date().toISOString(),
            passed: passRate >= harnessData.min_pass_rate && verificationResult.severity_gate.action !== "abort",
            pass_rate: passRate,
            critical_failures: verificationResult.severity_gate.failed_assertions.length,
            coverage_score: coverageScore,
            result_json: JSON.stringify(verificationResult),
            gate_action: verificationResult.severity_gate.action,
            gate_override: false,
          };
          
          const { canContinue, validatedResult } = Gatekeeper.executeGate(valResult); 
          await storage.saveVerificationRun(validatedResult, pipeline.user_id);

          // GAP-3 fix: Emit verification experience event for ML routing feedback
          try {
            const confidenceScore = Math.round(passRate * 100);
            await storage.saveLedger({
              project: pipeline.project,
              conversation_id: `dark-factory-${pipeline.id}`,
              user_id: pipeline.user_id,
              event_type: 'validation_result',
              summary: `[VERIFY] ${verificationResult.passed_count}/${verificationResult.total} passed (gate: ${verificationResult.severity_gate.action})`,
              keywords: ['dark-factory', 'verification', pipeline.project],
              importance: verificationResult.severity_gate.action === 'abort' ? 2 : 0,
              confidence_score: confidenceScore,
            });
          } catch { /* experience events are advisory — never block execution */ }

          if (!canContinue) {
             result.success = false;
             result.notes = (result.notes ? result.notes + '\n\n' : '') + `[GATE BLOCKED] Pipeline verification runner failed the security gate.`;
          } else {
             result.success = result.success && validatedResult.passed;
          }
        } catch (err: any) {
          if (err instanceof VerificationGateError) {
            debugLog(`[DarkFactory] Pipeline ${pipeline.id} ABORTED by Verification Gate.`);
            try {
              await storage.savePipeline({
                ...pipeline,
                status: 'FAILED',
                error: `[GATE ABORT] ${err.message}`,
              });
            } catch { /* Status guard */ }
            await emitExperienceEvent(pipeline, 'failure', `[GATE ABORT] ${err.message}`);
            return;
          } else {
            console.error(`[DarkFactory] Verification harness crash: ${err.message}`);
            result.success = false;
            result.notes = `[GATE CRASH] Verification suite failed to execute: ${err.message}`;
          }
        }
      }
    }

    if (currentStep === 'PLAN_CONTRACT' && spec.workingDirectory && result.success && (result as any).contractPayload) {
      const contractPath = path.join(path.resolve(spec.workingDirectory), 'contract_rubric.json');
      try {
        fs.writeFileSync(contractPath, JSON.stringify((result as any).contractPayload, null, 2), 'utf8');
        debugLog(`[DarkFactory] contract_rubric.json written to ${contractPath}`);
      } catch (writeErr: any) {
        // Disk/permissions error — fail the pipeline immediately so it doesn't
        // loop on PLAN_CONTRACT forever (each tick would re-attempt the write).
        debugLog(`[DarkFactory] Failed to write contract_rubric.json: ${writeErr.message}`);
        try {
          await storage.savePipeline({
            ...pipeline,
            status: 'FAILED',
            error: `PLAN_CONTRACT failed: could not write contract_rubric.json — ${writeErr.message}`,
          });
        } catch { /* status guard */ }
        await emitExperienceEvent(pipeline, 'failure', `contract_rubric.json write failed: ${writeErr.message}`);
        return;
      }
    }

    if (currentStep === 'EVALUATE' && (result as any).evaluationPayload) {
      // Emit ML learning event for evaluation outcome.
      // Using 'learning' (valid LedgerEntry event type) rather than
      // a non-existent 'evaluation_result' to avoid runtime cast issues.
      try {
        await storage.saveLedger({
          project: pipeline.project,
          conversation_id: `dark-factory-${pipeline.id}`,
          user_id: pipeline.user_id,
          event_type: 'learning',
          summary: `[EVALUATE] ${result.success ? 'PASS' : 'FAIL'} on iter ${pipeline.iteration} rev ${pipeline.eval_revisions ?? 0}`,
          keywords: ['dark-factory', 'evaluation', pipeline.project],
          importance: result.success ? 3 : 1,
          confidence_score: result.success ? 90 : 50,
        });
      } catch { /* advisory — never block execution */ }
    }

    // ─── Determine plan_viable from evaluation payload ───
    // Default to false (conservative): a parse failure or missing payload means
    // we don't know if the plan is viable, so escalate to PLAN re-planning
    // rather than burning eval_revisions on more EXECUTE retries.
    let evalPlanViable = false;
    if (currentStep === 'EVALUATE' && (result as any).evaluationPayload) {
      // plan_viable defaults false if null/missing (same conservative principle)
      evalPlanViable = (result as any).evaluationPayload.plan_viable ?? false;
    }

    const nextStepInfo = SafetyController.getNextStep(
      pipeline,
      spec,
      result.success,
      evalPlanViable
    );

    if (nextStepInfo === null || currentStep === 'FINALIZE') {
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
      try {
        const updatedPayload = currentStep === 'PLAN_CONTRACT' && (result as any).contractPayload 
          ? (result as any).contractPayload 
          : pipeline.contract_payload;
        // Forward the most informative notes available:
        // EXECUTE notes = what the generator did
        // EVALUATE notes = what the evaluator found
        // Other steps: preserve existing notes
        const updatedNotes = (currentStep === 'EXECUTE' || currentStep === 'EVALUATE') && result.notes
          ? result.notes
          : pipeline.notes;

        await storage.savePipeline({
          ...pipeline,
          current_step: nextStepInfo.step,
          iteration: nextStepInfo.iteration,
          eval_revisions: nextStepInfo.eval_revisions,
          last_heartbeat: new Date().toISOString(),
          contract_payload: updatedPayload,
          notes: updatedNotes,
        });
      } catch (err) {
        // Kill switch detection
        if (err instanceof Error && err.message.includes('Cannot update pipeline')) {
          debugLog(`[DarkFactory] Kill switch activated for pipeline ${pipeline.id}: ${err.message}`);
          return;
        }
        throw err;
      }

      debugLog(`[DarkFactory] Pipeline ${pipeline.id} advanced: ${currentStep} → ${nextStepInfo.step} (iter ${nextStepInfo.iteration}, rev ${nextStepInfo.eval_revisions ?? 0})`);
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
