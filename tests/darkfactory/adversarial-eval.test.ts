import { describe, it, expect } from 'vitest';
import { SafetyController } from '../../src/darkfactory/safetyController.js';
import { parseContractOutput, parseEvaluationOutput } from '../../src/darkfactory/runner.js';
import type { PipelineSpec } from '../../src/darkfactory/schema.js';
import { DEFAULT_MAX_REVISIONS } from '../../src/darkfactory/schema.js';

// ─────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────

const baseSpec: PipelineSpec = {
  objective: 'Fix all failing tests',
  maxIterations: 5,
  maxRevisions: 3,
};

const makeState = (step: string, iteration = 1, eval_revisions = 0) =>
  ({ current_step: step, iteration, eval_revisions }) as any;

// ─────────────────────────────────────────────────────────────────
// SafetyController.getNextStep — full EVALUATE branch coverage
// ─────────────────────────────────────────────────────────────────

describe('SafetyController.getNextStep — EVALUATE transitions', () => {
  it('EVALUATE pass → VERIFY (resets eval_revisions to 0)', () => {
    const next = SafetyController.getNextStep(makeState('EVALUATE', 1, 2), baseSpec, true, true);
    expect(next?.step).toBe('VERIFY');
    expect(next?.iteration).toBe(1);
    expect(next?.eval_revisions).toBe(0);
  });

  it('EVALUATE fail + planViable → EXECUTE (increments eval_revisions)', () => {
    const next = SafetyController.getNextStep(makeState('EVALUATE', 1, 0), baseSpec, false, true);
    expect(next?.step).toBe('EXECUTE');
    expect(next?.eval_revisions).toBe(1);
    expect(next?.iteration).toBe(1); // iteration unchanged
  });

  it('EVALUATE fail + planViable → EXECUTE (second revision)', () => {
    const next = SafetyController.getNextStep(makeState('EVALUATE', 1, 1), baseSpec, false, true);
    expect(next?.step).toBe('EXECUTE');
    expect(next?.eval_revisions).toBe(2);
  });

  it('EVALUATE fail + planViable + maxRevisions reached → null (pipeline fails)', () => {
    // eval_revisions=2, maxRevisions=3, nextRevision would be 3 >= 3
    const next = SafetyController.getNextStep(makeState('EVALUATE', 1, 2), baseSpec, false, true);
    expect(next).toBeNull();
  });

  it('EVALUATE fail + !planViable → PLAN (increments iteration, resets revisions)', () => {
    const next = SafetyController.getNextStep(makeState('EVALUATE', 1, 2), baseSpec, false, false);
    expect(next?.step).toBe('PLAN');
    expect(next?.iteration).toBe(2);
    expect(next?.eval_revisions).toBe(0);
  });

  it('EVALUATE fail + !planViable + iteration limit → null (pipeline fails)', () => {
    // iteration=5, maxIterations=5 → nextIteration=6 > 5
    const next = SafetyController.getNextStep(makeState('EVALUATE', 5, 0), baseSpec, false, false);
    expect(next).toBeNull();
  });

  it('EVALUATE pass resets eval_revisions even when they were non-zero', () => {
    const next = SafetyController.getNextStep(makeState('EVALUATE', 3, 2), baseSpec, true);
    expect(next?.eval_revisions).toBe(0);
    expect(next?.step).toBe('VERIFY');
  });
});

describe('SafetyController.getNextStep — other steps', () => {
  it('INIT → PLAN', () => {
    expect(SafetyController.getNextStep(makeState('INIT'), baseSpec, true)?.step).toBe('PLAN');
  });

  it('PLAN → PLAN_CONTRACT', () => {
    expect(SafetyController.getNextStep(makeState('PLAN'), baseSpec, true)?.step).toBe('PLAN_CONTRACT');
  });

  it('PLAN_CONTRACT → EXECUTE', () => {
    expect(SafetyController.getNextStep(makeState('PLAN_CONTRACT'), baseSpec, true)?.step).toBe('EXECUTE');
  });

  it('EXECUTE → EVALUATE', () => {
    expect(SafetyController.getNextStep(makeState('EXECUTE'), baseSpec, true)?.step).toBe('EVALUATE');
  });

  it('VERIFY pass → FINALIZE', () => {
    expect(SafetyController.getNextStep(makeState('VERIFY'), baseSpec, true)?.step).toBe('FINALIZE');
  });

  it('VERIFY fail → PLAN (increments iteration)', () => {
    const next = SafetyController.getNextStep(makeState('VERIFY', 1), baseSpec, false);
    expect(next?.step).toBe('PLAN');
    expect(next?.iteration).toBe(2);
    expect(next?.eval_revisions).toBe(0);
  });

  it('VERIFY fail at max iteration → null', () => {
    const next = SafetyController.getNextStep(makeState('VERIFY', 5), baseSpec, false);
    expect(next).toBeNull();
  });

  it('FINALIZE → null (terminal)', () => {
    expect(SafetyController.getNextStep(makeState('FINALIZE'), baseSpec, true)).toBeNull();
  });

  it('Unknown step → null (safety fallback)', () => {
    expect(SafetyController.getNextStep(makeState('UNKNOWN_STEP'), baseSpec, true)).toBeNull();
  });
});

describe('SafetyController.getNextStep — DEFAULT_MAX_REVISIONS constant', () => {
  it('DEFAULT_MAX_REVISIONS is 3', () => {
    expect(DEFAULT_MAX_REVISIONS).toBe(3);
  });

  it('spec without maxRevisions uses DEFAULT_MAX_REVISIONS', () => {
    const noRevSpec: PipelineSpec = { objective: 'test', maxIterations: 3 };
    // eval_revisions=2, next would be 3 >= DEFAULT_MAX_REVISIONS(3) → null
    const next = SafetyController.getNextStep(makeState('EVALUATE', 1, 2), noRevSpec, false, true);
    expect(next).toBeNull();
  });

  it('spec with maxRevisions=5 allows more retries', () => {
    const spec5: PipelineSpec = { objective: 'test', maxIterations: 5, maxRevisions: 5 };
    const next = SafetyController.getNextStep(makeState('EVALUATE', 1, 3), spec5, false, true);
    expect(next?.step).toBe('EXECUTE');
    expect(next?.eval_revisions).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────
// SafetyController.generateBoundaryPrompt — eval context
// ─────────────────────────────────────────────────────────────────

describe('SafetyController.generateBoundaryPrompt — role injection', () => {
  it('EXECUTE step injects GENERATOR role', () => {
    const prompt = SafetyController.generateBoundaryPrompt(baseSpec, makeState('EXECUTE'));
    expect(prompt).toContain('GENERATOR');
    expect(prompt).not.toContain('EVALUATOR');
  });

  it('EVALUATE step injects ADVERSARIAL EVALUATOR role', () => {
    const prompt = SafetyController.generateBoundaryPrompt(baseSpec, makeState('EVALUATE'));
    expect(prompt).toContain('ADVERSARIAL EVALUATOR');
    expect(prompt).not.toContain('GENERATOR');
  });

  it('PLAN_CONTRACT injects ADVERSARIAL EVALUATOR role', () => {
    const prompt = SafetyController.generateBoundaryPrompt(baseSpec, makeState('PLAN_CONTRACT'));
    expect(prompt).toContain('ADVERSARIAL EVALUATOR');
  });

  it('PLAN step uses generic agent description', () => {
    const prompt = SafetyController.generateBoundaryPrompt(baseSpec, makeState('PLAN'));
    expect(prompt).toContain('autonomous code agent');
  });

  it('Revision counter appears in prompt', () => {
    const prompt = SafetyController.generateBoundaryPrompt(baseSpec, makeState('EVALUATE', 1, 2));
    expect(prompt).toContain('Revision: 2 / 3');
  });
});

// ─────────────────────────────────────────────────────────────────
// parseContractOutput
// ─────────────────────────────────────────────────────────────────

describe('parseContractOutput', () => {
  it('parses valid ContractPayload JSON', () => {
    const { parsed, error } = parseContractOutput(JSON.stringify({
      criteria: [
        { id: 'c1', description: 'All types must check clean' },
        { id: 'c2', description: 'All tests must pass' },
      ]
    }));
    expect(error).toBeNull();
    expect(parsed!.criteria).toHaveLength(2);
    expect(parsed!.criteria[0].id).toBe('c1');
  });

  it('parses ContractPayload wrapped in markdown fences', () => {
    const raw = '```json\n' + JSON.stringify({ criteria: [{ id: 'x', description: 'Test' }] }) + '\n```';
    const { parsed, error } = parseContractOutput(raw);
    expect(error).toBeNull();
    expect(parsed!.criteria[0].id).toBe('x');
  });

  it('parses ContractPayload with brace extraction (preamble text)', () => {
    const raw = 'Here is the contract:\n' + JSON.stringify({ criteria: [{ id: 'y', description: 'ok' }] });
    const { parsed, error } = parseContractOutput(raw);
    expect(error).toBeNull();
    expect(parsed!.criteria[0].id).toBe('y');
  });

  it('rejects empty input', () => {
    const { error, parsed } = parseContractOutput('');
    expect(error).toContain('empty');
    expect(parsed).toBeNull();
  });

  it('rejects non-JSON input', () => {
    const { error, parsed } = parseContractOutput('not json at all');
    expect(error).not.toBeNull();
    expect(parsed).toBeNull();
  });

  it('rejects object missing criteria array', () => {
    const { error, parsed } = parseContractOutput(JSON.stringify({ pass: true }));
    expect(error).toContain('criteria');
    expect(parsed).toBeNull();
  });

  it('rejects criteria as non-array', () => {
    const { error, parsed } = parseContractOutput(JSON.stringify({ criteria: 'string' }));
    expect(error).toContain('criteria');
    expect(parsed).toBeNull();
  });

  it('parses empty criteria array (valid but unusual)', () => {
    const { parsed, error } = parseContractOutput(JSON.stringify({ criteria: [] }));
    expect(error).toBeNull();
    expect(parsed!.criteria).toHaveLength(0);
  });

  // Per-element shape validation (fix #4)
  it('rejects criterion element missing id field', () => {
    const { error, parsed } = parseContractOutput(JSON.stringify({
      criteria: [{ description: 'no id here' }]
    }));
    expect(error).toContain('id');
    expect(parsed).toBeNull();
  });

  it('rejects criterion element missing description field', () => {
    const { error, parsed } = parseContractOutput(JSON.stringify({
      criteria: [{ id: 'c1' }] // missing description
    }));
    expect(error).toContain('description');
    expect(parsed).toBeNull();
  });

  it('rejects criterion element that is a primitive (not object)', () => {
    const { error, parsed } = parseContractOutput(JSON.stringify({ criteria: [42, 'bad'] }));
    expect(error).toContain('criteria[0]');
    expect(parsed).toBeNull();
  });

  it('rejects criterion where id is a number, not string', () => {
    const { error, parsed } = parseContractOutput(JSON.stringify({
      criteria: [{ id: 1, description: 'should be string id' }]
    }));
    expect(error).toContain('id');
    expect(parsed).toBeNull();
  });

  it('validates second criterion element too (not just first)', () => {
    const { error, parsed } = parseContractOutput(JSON.stringify({
      criteria: [
        { id: 'c1', description: 'valid' },
        { id: 42, description: 'invalid id type' }, // invalid second element
      ]
    }));
    expect(error).toContain('criteria[1]');
    expect(parsed).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// parseEvaluationOutput
// ─────────────────────────────────────────────────────────────────

describe('parseEvaluationOutput', () => {
  const validPayload = {
    pass: false,
    plan_viable: true,
    notes: 'Criterion c1 failed: function not exported',
    findings: [
      {
        severity: 'critical',
        criterion_id: 'c1',
        pass_fail: false,
        evidence: { file: 'src/utils.ts', line: 42, description: 'Export missing' },
      },
    ],
  };

  it('parses valid EvaluationPayload', () => {
    const { parsed, error } = parseEvaluationOutput(JSON.stringify(validPayload));
    expect(error).toBeNull();
    expect(parsed!.pass).toBe(false);
    expect(parsed!.plan_viable).toBe(true);
    expect(parsed!.findings).toHaveLength(1);
    expect(parsed!.findings[0].evidence.line).toBe(42);
  });

  it('parses passing evaluation', () => {
    const { parsed, error } = parseEvaluationOutput(JSON.stringify({ ...validPayload, pass: true }));
    expect(error).toBeNull();
    expect(parsed!.pass).toBe(true);
  });

  it('parses EvaluationPayload wrapped in markdown fences', () => {
    const raw = '```json\n' + JSON.stringify(validPayload) + '\n```';
    const { parsed, error } = parseEvaluationOutput(raw);
    expect(error).toBeNull();
    expect(parsed!.pass).toBe(false);
  });

  it('parses with brace extraction (preamble text)', () => {
    const raw = 'My analysis:\n' + JSON.stringify(validPayload);
    const { parsed, error } = parseEvaluationOutput(raw);
    expect(error).toBeNull();
    expect(parsed!.pass).toBe(false);
  });

  it('rejects empty input', () => {
    const { error, parsed } = parseEvaluationOutput('');
    expect(error).toContain('empty');
    expect(parsed).toBeNull();
  });

  it('rejects non-JSON', () => {
    const { error, parsed } = parseEvaluationOutput('not json');
    expect(error).not.toBeNull();
    expect(parsed).toBeNull();
  });

  it('rejects object missing pass field', () => {
    const { error, parsed } = parseEvaluationOutput(JSON.stringify({ findings: [] }));
    expect(error).toContain('pass');
    expect(parsed).toBeNull();
  });

  it('rejects pass as non-boolean (string)', () => {
    const { error, parsed } = parseEvaluationOutput(JSON.stringify({ pass: 'yes', findings: [] }));
    expect(error).toContain('pass');
    expect(parsed).toBeNull();
  });

  it('rejects pass as non-boolean (number)', () => {
    const { error, parsed } = parseEvaluationOutput(JSON.stringify({ pass: 1, findings: [] }));
    expect(error).not.toBeNull();
    expect(parsed).toBeNull();
  });

  it('parses evaluation with empty findings array', () => {
    const { parsed, error } = parseEvaluationOutput(JSON.stringify({ pass: true, plan_viable: true, findings: [] }));
    expect(error).toBeNull();
    expect(parsed!.findings).toHaveLength(0);
  });

  // findings array guard (fix #3)
  it('rejects findings as a string (not array)', () => {
    const { error, parsed } = parseEvaluationOutput(JSON.stringify({ pass: false, findings: 'none' }));
    expect(error).toContain('findings');
    expect(parsed).toBeNull();
  });

  it('rejects findings as an object (not array)', () => {
    const { error, parsed } = parseEvaluationOutput(JSON.stringify({ pass: false, findings: { count: 0 } }));
    expect(error).toContain('findings');
    expect(parsed).toBeNull();
  });

  it('accepts pass:true with no findings key at all (optional)', () => {
    const { parsed, error } = parseEvaluationOutput(JSON.stringify({ pass: true, plan_viable: true }));
    expect(error).toBeNull();
    expect(parsed!.pass).toBe(true);
  });

  // Fix #3: Per-element evidence validation
  it('rejects failing finding missing evidence object', () => {
    const input = JSON.stringify({
      pass: false,
      plan_viable: true,
      findings: [{ severity: 'critical', criterion_id: 'c1', pass_fail: false }], // missing evidence
    });
    const { error, parsed } = parseEvaluationOutput(input);
    expect(error).toContain('missing required "evidence" object');
    expect(parsed).toBeNull();
  });

  it('rejects finding that is a primitive (not an object)', () => {
    const input = JSON.stringify({
      pass: false,
      plan_viable: true,
      findings: ['critical issue here'], // primitive element
    });
    const { error, parsed } = parseEvaluationOutput(input);
    expect(error).toContain('must be an object');
    expect(parsed).toBeNull();
  });

  it('accepts passing finding (pass_fail:true) with no evidence block', () => {
    // Pass_fail=true findings need no evidence — only failures require evidence
    const input = JSON.stringify({
      pass: true,
      plan_viable: true,
      findings: [{ severity: 'info', criterion_id: 'c1', pass_fail: true }],
    });
    const { error, parsed } = parseEvaluationOutput(input);
    expect(error).toBeNull();
    expect(parsed!.pass).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// Fix #2: Findings serialized into notes for Generator retry prompt
// ─────────────────────────────────────────────────────────────────

describe('parseEvaluationOutput — notes serialization', () => {
  it('serializes findings into notes when called by runner (integration check on parser shape)', () => {
    // The parser itself returns the payload; the runner does the serialization.
    // This test confirms the parser accepts the full payload that runner needs to format.
    const payload = {
      pass: false,
      plan_viable: true,
      notes: 'Overall fail',
      findings: [
        {
          severity: 'critical',
          criterion_id: 'c1',
          pass_fail: false,
          evidence: { file: 'src/foo.ts', line: 42, description: 'Missing null check' },
        },
        {
          severity: 'warning',
          criterion_id: 'c2',
          pass_fail: false,
          evidence: { file: 'src/bar.ts', line: 7, description: 'Unhandled error path' },
        },
      ],
    };
    const { parsed, error } = parseEvaluationOutput(JSON.stringify(payload));
    expect(error).toBeNull();
    expect(parsed).not.toBeNull();
    // Both findings have evidence — parser must accept them
    expect(parsed!.findings).toHaveLength(2);
    // Spot-check the evidence shape the runner will format
    expect((parsed!.findings![0].evidence as any).line).toBe(42);
    expect((parsed!.findings![1].evidence as any).file).toBe('src/bar.ts');
  });
});

// ─────────────────────────────────────────────────────────────────
// Deadlock / Adversarial Scenario Tests
// ─────────────────────────────────────────────────────────────────

describe('Adversarial Evaluation — scenario tests', () => {

  it('Deadlock: evaluator always fails with planViable=true → MaxRevisions → null', () => {
    let state = makeState('EVALUATE', 1, 0);

    let next = SafetyController.getNextStep(state, baseSpec, false, true);
    expect(next?.step).toBe('EXECUTE'); expect(next?.eval_revisions).toBe(1);

    state.eval_revisions = 1;
    next = SafetyController.getNextStep(state, baseSpec, false, true);
    expect(next?.step).toBe('EXECUTE'); expect(next?.eval_revisions).toBe(2);

    state.eval_revisions = 2;
    next = SafetyController.getNextStep(state, baseSpec, false, true);
    expect(next).toBeNull(); // Pipeline must fail
  });

  it('Oscillation guard: !planViable fallback eventually hits iteration limit → null', () => {
    const tightSpec: PipelineSpec = { objective: 'test', maxIterations: 2, maxRevisions: 2 };

    let next = SafetyController.getNextStep(makeState('EVALUATE', 2, 0), tightSpec, false, false);
    expect(next).toBeNull(); // iteration 3 > maxIterations 2
  });

  it('Happy path: pass → VERIFY → FINALIZE', () => {
    const verify = SafetyController.getNextStep(makeState('EVALUATE', 1, 1), baseSpec, true);
    expect(verify?.step).toBe('VERIFY');
    expect(verify?.eval_revisions).toBe(0);

    const finalize = SafetyController.getNextStep(makeState('VERIFY', 1, 0), baseSpec, true);
    expect(finalize?.step).toBe('FINALIZE');
  });

  it('Context Bleed: EXECUTE and EVALUATE prompts use distinct role descriptions', () => {
    const execPrompt = SafetyController.generateBoundaryPrompt(baseSpec, makeState('EXECUTE'));
    const evalPrompt = SafetyController.generateBoundaryPrompt(baseSpec, makeState('EVALUATE'));
    expect(execPrompt).toContain('GENERATOR');
    expect(evalPrompt).toContain('EVALUATOR');
    // Neither should contaminate the other
    expect(execPrompt).not.toContain('ADVERSARIAL EVALUATOR');
    expect(evalPrompt).not.toContain('GENERATOR executing');
  });
});

// ─────────────────────────────────────────────────────────────────
// evalPlanViable conservative default — fix #1
// Verifies that getNextStep(planViable=false) escalates to PLAN, not EXECUTE
// ─────────────────────────────────────────────────────────────────

describe('evalPlanViable conservative default (fix #1)', () => {
  it('planViable=false → PLAN re-plan (escalation, not revision burn)', () => {
    // This simulates what the runner does when parseEvaluationOutput returns no evaluationPayload:
    // evalPlanViable defaults false → getNextStep gets false → goes to PLAN branch
    const next = SafetyController.getNextStep(makeState('EVALUATE', 1, 0), baseSpec, false, false);
    expect(next?.step).toBe('PLAN');
    expect(next?.iteration).toBe(2);
    expect(next?.eval_revisions).toBe(0);
    // Crucially: did NOT go to EXECUTE (would have been revision burn)
  });

  it('planViable=true (explicit) still goes to EXECUTE (revision retry)', () => {
    const next = SafetyController.getNextStep(makeState('EVALUATE', 1, 0), baseSpec, false, true);
    expect(next?.step).toBe('EXECUTE');
    expect(next?.eval_revisions).toBe(1);
  });

  it('parse failure + conservative default: does not burn revisions on LLM format errors', () => {
    // Scenario: EVALUATE step output is malformed → no evaluationPayload →
    // evalPlanViable defaults false → next = PLAN with iter+1
    // If evalPlanViable had defaulted true, this would have gone to EXECUTE (wrong)
    const state = makeState('EVALUATE', 1, 1); // already at 1 revision
    const next = SafetyController.getNextStep(state, baseSpec, false, false); // false = conservative default
    expect(next?.step).toBe('PLAN');
    expect(next?.iteration).toBe(2);
    expect(next?.eval_revisions).toBe(0); // revisions reset on PLAN escalation
  });

  it('conservative default does not interfere when evaluation PASSES', () => {
    // Even with conservative default behavior, a passing evaluation always goes to VERIFY
    const next = SafetyController.getNextStep(makeState('EVALUATE', 1, 0), baseSpec, true, false);
    expect(next?.step).toBe('VERIFY');
    expect(next?.eval_revisions).toBe(0);
  });
});
