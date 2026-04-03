import { PipelineState, PipelineStatus } from '../storage/interface.js';
import { PipelineSpec, DarkFactoryStep, ActionPayload, VALID_ACTION_TYPES, DEFAULT_MAX_REVISIONS } from './schema.js';
import { PRISM_DARK_FACTORY_MAX_RUNTIME_MS } from '../config.js';
import { debugLog } from '../utils/logger.js';
import path from 'path';

/**
 * Controller strictly enforcing safety and invariant checks across Factory Pipelines.
 *
 * Responsibilities:
 *   1. Iteration limit enforcement (prevents runaway LLM loops)
 *   2. Path scope validation (prevents filesystem escapes)
 *   3. Heartbeat lapse detection (finds zombie pipelines)
 *   4. State machine transition validation (prevents illegal status jumps)
 *   5. System prompt boundary generation (scope injection into LLM calls)
 *   6. Total wall-clock runtime enforcement
 */
export class SafetyController {
  
  /**
   * Defines how long a pipeline can go without a heartbeat before being considered "zombie".
   * Handled by the Dark Factory Runner watchdog.
   */
  public static readonly HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Legal state transitions for the pipeline state machine.
   * Any transition not listed here is rejected by validateTransition().
   */
  private static readonly LEGAL_TRANSITIONS: Record<PipelineStatus, PipelineStatus[]> = {
    'PENDING': ['RUNNING', 'ABORTED'],  // Queued → Runner promotes or user aborts
    'RUNNING': ['PAUSED', 'ABORTED', 'COMPLETED', 'FAILED'],
    'PAUSED':  ['RUNNING', 'ABORTED'],
    'ABORTED': [],  // Terminal — no exits
    'COMPLETED': [], // Terminal — no exits
    'FAILED':  ['RUNNING'],  // Allow retry from failed state
  };


  /**
   * Prevents runaway LLM invocation loops by enforcing the max iteration envelope.
   */
  static validateIterationLimit(iteration: number, spec: PipelineSpec): boolean {
    return iteration <= spec.maxIterations;
  }

  /**
   * Ensure a target path operates only within the explicitly restricted spec zone.
   * If workingDirectory is missing, the global app root is assumed.
   */
  static isPathWithinScope(targetPath: string, spec: PipelineSpec): boolean {
    if (!spec.workingDirectory) return true;
    
    // Resolve symlinks and protect against ../ escapes.
    const resolvedTarget = path.resolve(targetPath);
    const resolvedWorkspace = path.resolve(spec.workingDirectory);
    
    // Path Traversal Guard: A naive startsWith() check is vulnerable to
    // prefix collisions — e.g. /app/workspace-hacked passes startsWith('/app/workspace').
    // We require EITHER exact match OR the target starts with workspace + path separator.
    if (resolvedTarget !== resolvedWorkspace && !resolvedTarget.startsWith(resolvedWorkspace + path.sep)) {
      debugLog(`[Safety] Rejecting out-of-scope path resolution: ${targetPath}`);
      return false;
    }
    
    return true;
  }

  /**
   * Batch-validate an array of ActionPayload objects against the pipeline spec.
   *
   * Checks:
   *   1. Each action has a valid ActionType
   *   2. Each action's targetPath is non-empty
   *   3. Each action's targetPath resolves within workingDirectory (via isPathWithinScope)
   *
   * Returns the first violation message (string) if any action fails,
   * or null if all actions are valid and in-scope.
   *
   * Used by runner.ts after parsing EXECUTE step output — any non-null return
   * terminates the pipeline immediately (fail closed).
   */
  static validateActionsInScope(actions: ActionPayload[], spec: PipelineSpec): string | null {
    if (!Array.isArray(actions) || actions.length === 0) {
      return 'Actions array is empty or not an array';
    }

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];

      // Validate action type is in the restricted set
      if (!action.type || !VALID_ACTION_TYPES.includes(action.type)) {
        return `Action[${i}]: invalid type "${action.type}" (allowed: ${VALID_ACTION_TYPES.join(', ')})`;
      }

      // Validate targetPath is non-empty
      if (!action.targetPath || typeof action.targetPath !== 'string' || action.targetPath.trim() === '') {
        return `Action[${i}]: targetPath is empty or missing`;
      }

      // Resolve targetPath relative to workingDirectory for scope check
      const resolvedTarget = spec.workingDirectory
        ? path.resolve(spec.workingDirectory, action.targetPath)
        : path.resolve(action.targetPath);

      if (!SafetyController.isPathWithinScope(resolvedTarget, spec)) {
        return `Action[${i}]: path "${action.targetPath}" resolves outside permitted scope`;
      }
    }

    return null; // All actions valid and in-scope
  }

  /**
   * Determine whether a pipeline has timed out based on its recorded heartbeat.
   */
  static isHeartbeatLapsed(state: PipelineState, timeoutOverrideMs?: number): boolean {
    if (!state.last_heartbeat) {
      // Pipeline never heartbeat. Use started_at as fallback
      const diff = Date.now() - new Date(state.started_at).getTime();
      return diff > (timeoutOverrideMs || SafetyController.HEARTBEAT_TIMEOUT_MS);
    }
    const diff = Date.now() - new Date(state.last_heartbeat).getTime();
    return diff > (timeoutOverrideMs || SafetyController.HEARTBEAT_TIMEOUT_MS);
  }

  /**
   * Validate that a status transition is legal under the state machine.
   * Prevents impossible jumps (e.g., COMPLETED → RUNNING) that would
   * corrupt pipeline audit trails.
   */
  static validateTransition(from: PipelineStatus, to: PipelineStatus): boolean {
    const legal = SafetyController.LEGAL_TRANSITIONS[from];
    if (!legal) return false;
    return legal.includes(to);
  }

  /**
   * Return the list of legal target statuses for a given source status.
   * Used to build descriptive error messages in storage backends.
   */
  static getLegalTransitions(from: PipelineStatus): PipelineStatus[] {
    return SafetyController.LEGAL_TRANSITIONS[from] ?? [];
  }

  /**
   * Check whether the pipeline has exceeded its total wall-clock runtime.
   * Uses the configurable PRISM_DARK_FACTORY_MAX_RUNTIME_MS (default: 15 min).
   */
  static isRuntimeExceeded(state: PipelineState): boolean {
    const elapsed = Date.now() - new Date(state.started_at).getTime();
    return elapsed > PRISM_DARK_FACTORY_MAX_RUNTIME_MS;
  }

  /**
   * Generate a scoped system prompt that enforces operational boundaries
   * for all LLM calls within the pipeline. This is the "boundary injection"
   * that prevents the model from operating outside its mandate.
   *
   * Used by clawInvocation.ts instead of inline prompt construction.
   */
  static generateBoundaryPrompt(spec: PipelineSpec, state: PipelineState): string {
    let modeDescription = 'an autonomous code agent';
    if (state.current_step === 'PLAN_CONTRACT' || state.current_step === 'EVALUATE') {
      modeDescription = 'an ADVERSARIAL EVALUATOR enforcing strict quality constraints against a generated output';
    } else if (state.current_step === 'EXECUTE') {
      modeDescription = 'a GENERATOR executing code constrained by a strict rubric';
    }

    const lines: string[] = [
      `You are Prism Dark Factory, operating in the background as ${modeDescription}.`,
      `You are strictly limited to code actions within the defined scope.`,
      ``,
      `── Operational Boundaries ──`,
      `Pipeline ID: ${state.id}`,
      `Project: ${state.project}`,
      `Current Step: ${state.current_step}`,
      `Iteration: ${state.iteration} / ${spec.maxIterations}`,
      `Revision: ${state.eval_revisions ?? 0} / ${spec.maxRevisions ?? DEFAULT_MAX_REVISIONS}`,
      `Restricted Workspace: ${spec.workingDirectory || '(unrestricted)'}`,
    ];

    if (spec.contextFiles && spec.contextFiles.length > 0) {
      lines.push(`Context Files: ${spec.contextFiles.join(', ')}`);
    }

    lines.push(
      ``,
      `── Objective ──`,
      spec.objective,
      ``,
      `── Safety Rules ──`,
      `1. Do NOT modify files outside the Restricted Workspace.`,
      `2. Do NOT make network requests unless the objective explicitly requires it.`,
      `3. Do NOT execute destructive operations (rm -rf, DROP TABLE, etc.).`,
      `4. Respond ONLY with actions relevant to the current step.`,
      `5. If you cannot complete the step, explain why and stop.`,
    );

    return lines.join('\n');
  }

  static getNextStep(
    state: PipelineState,
    spec: PipelineSpec,
    stepPassed: boolean,
    planViable: boolean = true
  ): { step: DarkFactoryStep; iteration: number; eval_revisions?: number } | null {
    const currentStep = state.current_step as DarkFactoryStep;
    const iteration = state.iteration;
    const eval_revisions = state.eval_revisions ?? 0;

    switch (currentStep) {
      case 'INIT':
        return { step: 'PLAN', iteration, eval_revisions };
      
      case 'PLAN':
        return { step: 'PLAN_CONTRACT', iteration, eval_revisions };
        
      case 'PLAN_CONTRACT':
        return { step: 'EXECUTE', iteration, eval_revisions };
      
      case 'EXECUTE':
        return { step: 'EVALUATE', iteration, eval_revisions };
        
      case 'EVALUATE':
        if (stepPassed) {
          // Contract passed, move to VERIFY
          return { step: 'VERIFY', iteration, eval_revisions: 0 };
        }
        
        // Contract failed.
        if (planViable) {
          // Fall back to EXECUTE but increment revision counter
          const nextRevision = eval_revisions + 1;
          const maxRev = spec.maxRevisions ?? DEFAULT_MAX_REVISIONS;
          if (nextRevision >= maxRev) {
            // Exceeded max revisions — pipeline fails
            return null;
          }
          return { step: 'EXECUTE', iteration, eval_revisions: nextRevision };
        } else {
          // Fall back all the way to PLAN
          const nextIteration = iteration + 1;
          if (!SafetyController.validateIterationLimit(nextIteration, spec)) {
            return null;
          }
          return { step: 'PLAN', iteration: nextIteration, eval_revisions: 0 };
        }
      
      case 'VERIFY':
        if (stepPassed) {
          return { step: 'FINALIZE', iteration, eval_revisions };
        }
        // Verification failed — loop back to PLAN with incremented iteration
        const nextIterationVerify = iteration + 1;
        if (!SafetyController.validateIterationLimit(nextIterationVerify, spec)) {
          // Exceeded max iterations — force finalize with failure
          return null;
        }
        return { step: 'PLAN', iteration: nextIterationVerify, eval_revisions: 0 };
      
      case 'FINALIZE':
        return null; // Terminal step
      
      default:
        debugLog(`[Safety] Unknown step "${currentStep}" — forcing termination`);
        return null;
    }
  }
}
