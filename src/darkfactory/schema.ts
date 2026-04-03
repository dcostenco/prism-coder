export type DarkFactoryStep = 'INIT' | 'PLAN' | 'PLAN_CONTRACT' | 'EXECUTE' | 'EVALUATE' | 'VERIFY' | 'FINALIZE';

/**
 * Defines the parameters for a Dark Factory run
 */
export interface PipelineSpec {
  /** The core objective for the autonomous pipeline to accomplish */
  objective: string;
  
  /** Maximum number of PLAN->EXECUTE->VERIFY loop iterations */
  maxIterations: number;

  /** Maximum number of EXECUTE <-> EVALUATE internal revisions per execution. Default: DEFAULT_MAX_REVISIONS. */
  maxRevisions?: number;
  
  /** The context directory where files are allowed to be modified */
  workingDirectory?: string;
  
  /** Optional files to strictly scope context */
  contextFiles?: string[];
  
  /** Optional model override to use for reasoning inside the factory (e.g. qwen3) */
  modelOverride?: string;
}

/**
 * Represents the log/result of a single iteration loop
 */
export interface IterationResult {
  iteration: number;
  step: DarkFactoryStep;
  started_at: string;
  completed_at: string;
  success: boolean;
  notes?: string;
}

// ─── v7.3.1: Structured Action Contract ────────────────────────

/**
 * Restricted set of side-effecting operations allowed in EXECUTE steps.
 * Anything not in this union is rejected at parse-time — fail closed.
 */
export type ActionType = 'READ_FILE' | 'WRITE_FILE' | 'PATCH_FILE' | 'RUN_TEST';

/** All valid action type strings for runtime validation */
export const VALID_ACTION_TYPES: readonly ActionType[] = [
  'READ_FILE', 'WRITE_FILE', 'PATCH_FILE', 'RUN_TEST'
] as const;

/**
 * The machine-validated payload for a single EXECUTE action.
 *
 * Every action MUST have a `type` and `targetPath`. The remaining
 * fields are action-specific:
 *   - WRITE_FILE:  requires `content`
 *   - PATCH_FILE:  requires `patch`
 *   - RUN_TEST:    requires `command`
 *   - READ_FILE:   targetPath only
 */
export interface ActionPayload {
  type: ActionType;
  targetPath: string;
  content?: string;
  patch?: string;
  command?: string;
}

/**
 * The expected shape of ALL EXECUTE step LLM output.
 *
 * The runner parses the raw LLM text as JSON, then validates this shape.
 * If parsing fails OR actions contains out-of-scope paths, the pipeline
 * is terminated — fail closed, never fail open.
 */
export interface ExecutionStepResult {
  actions: ActionPayload[];
  notes?: string;
}

/**
 * The pre-negotiated scoring rubric agreed upon by Generator and Evaluator
 * during the PLAN_CONTRACT phase.
 */
export interface ContractPayload {
  criteria: Array<{
    id: string;
    description: string;
  }>;
}

/** Default max adversarial revisions per EXECUTE phase (used when spec.maxRevisions is unset). */
export const DEFAULT_MAX_REVISIONS = 3;

/**
 * Output from the EVALUATE adversarial critique step.
 */
export interface EvaluationPayload {
  pass: boolean;
  plan_viable: boolean;
  notes?: string;
  findings: Array<{
    severity: 'critical' | 'warning' | 'info';
    criterion_id: string;
    pass_fail: boolean;
    evidence: {
      file: string;
      /** Line number (1-indexed) where the finding was observed. */
      line: number;
      description: string;
    };
  }>;
}
