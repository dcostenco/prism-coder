import { describe, it, expect } from 'vitest';
import { Gatekeeper } from '../../src/verification/gatekeeper.js';
import { ValidationResult } from '../../src/verification/schema.js';
import { VerificationGateError } from '../../src/errors.js';

describe('Verification - Gatekeeper', () => {

  const baseResult: ValidationResult = {
    id: 'test-id',
    rubric_hash: 'abc',
    project: 'test',
    conversation_id: 'test',
    run_at: new Date().toISOString(),
    passed: false,
    pass_rate: 0.5,
    critical_failures: 0,
    coverage_score: 1.0,
    result_json: '{}',
    gate_action: 'continue'
  };

  it('allows continue gate actions', () => {
    const result = { ...baseResult, gate_action: 'continue' as const };
    const { canContinue, validatedResult } = Gatekeeper.executeGate(result);
    expect(canContinue).toBe(true);
    expect(validatedResult.gate_action).toBe('continue');
  });

  it('returns false for block gate actions', () => {
    const result = { ...baseResult, gate_action: 'block' as const };
    const { canContinue, validatedResult } = Gatekeeper.executeGate(result);
    expect(canContinue).toBe(false);
    expect(validatedResult.gate_action).toBe('block');
  });

  it('throws for abort gate actions', () => {
    const result = { ...baseResult, gate_action: 'abort' as const };
    let caught: VerificationGateError | null = null;
    try {
      Gatekeeper.executeGate(result);
    } catch (e: any) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(VerificationGateError);
    // The error receives a shallow copy (validatedResult), not the original reference
    expect(caught?.result).toStrictEqual(result);
    expect(caught?.toJSON().project).toBe('test');
  });

  it('bypasses any action if forceBypass is true and updates the validated result', () => {
    const result = { ...baseResult, gate_action: 'abort' as const };
    const { canContinue, validatedResult } = Gatekeeper.executeGate(result, { forceBypass: true });

    expect(canContinue).toBe(true);
    // C2 fix: gate_override is set on the returned copy, not the original
    expect(validatedResult.gate_override).toBe(true);
    expect(validatedResult.override_reason).toBeDefined();
    // Original should NOT be mutated (shallow copy semantics)
    expect(result.gate_override).toBeUndefined();
  });
});
