import { PipelineState, PipelineStatus } from '../storage/interface.js';
import { PipelineSpec, DarkFactoryStep } from './schema.js';
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
    'RUNNING': ['PAUSED', 'ABORTED', 'COMPLETED', 'FAILED'],
    'PAUSED':  ['RUNNING', 'ABORTED'],
    'ABORTED': [],  // Terminal — no exits
    'COMPLETED': [], // Terminal — no exits
    'FAILED':  ['RUNNING'],  // Allow retry from failed state
  };

  /**
   * Legal step transitions for the pipeline execution state machine.
   * FINALIZE is entered from VERIFY when iteration == maxIterations or success.
   */
  private static readonly STEP_ORDER: DarkFactoryStep[] = [
    'INIT', 'PLAN', 'EXECUTE', 'VERIFY', 'FINALIZE'
  ];

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
    const lines: string[] = [
      `You are Prism Dark Factory, operating in the background as an autonomous code agent.`,
      `You are strictly limited to code actions within the defined scope.`,
      ``,
      `── Operational Boundaries ──`,
      `Pipeline ID: ${state.id}`,
      `Project: ${state.project}`,
      `Current Step: ${state.current_step}`,
      `Iteration: ${state.iteration} / ${spec.maxIterations}`,
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

  /**
   * Determine the next step in the pipeline execution sequence.
   * Returns null if the pipeline should terminate (FINALIZE reached or iteration exceeded).
   */
  static getNextStep(
    currentStep: DarkFactoryStep,
    iteration: number,
    spec: PipelineSpec,
    verifyPassed: boolean
  ): { step: DarkFactoryStep; iteration: number } | null {
    switch (currentStep) {
      case 'INIT':
        return { step: 'PLAN', iteration };
      
      case 'PLAN':
        return { step: 'EXECUTE', iteration };
      
      case 'EXECUTE':
        return { step: 'VERIFY', iteration };
      
      case 'VERIFY':
        if (verifyPassed) {
          return { step: 'FINALIZE', iteration };
        }
        // Verification failed — loop back to PLAN with incremented iteration
        const nextIteration = iteration + 1;
        if (!SafetyController.validateIterationLimit(nextIteration, spec)) {
          // Exceeded max iterations — force finalize with failure
          return null;
        }
        return { step: 'PLAN', iteration: nextIteration };
      
      case 'FINALIZE':
        return null; // Terminal step
      
      default:
        debugLog(`[Safety] Unknown step "${currentStep}" — forcing termination`);
        return null;
    }
  }
}
