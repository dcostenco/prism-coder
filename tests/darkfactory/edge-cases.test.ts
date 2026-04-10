/**
 * Dark Factory v7.3.1 — Edge Case Tests
 *
 * Stress tests for the two critical validation layers:
 *   1. parseExecuteOutput() — JSON extraction from adversarial LLM output
 *   2. SafetyController.validateActionsInScope() — path scope under adversarial input
 *
 * These tests simulate real-world LLM behavior (code fences, prose preamble,
 * trailing commentary) and adversarial payloads (null bytes, path traversal
 * variants, type coercion attacks).
 */

import { describe, it, expect } from 'vitest';
import { parseExecuteOutput } from '../../src/darkfactory/runner.js';
import { SafetyController } from '../../src/darkfactory/safetyController.js';
import type { PipelineSpec, ActionPayload } from '../../src/darkfactory/schema.js';

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function makeSpec(workingDirectory?: string): PipelineSpec {
  return { objective: 'test', maxIterations: 5, workingDirectory };
}

function validJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    actions: [{ type: 'WRITE_FILE', targetPath: 'src/index.ts', content: 'hello' }],
    ...overrides,
  });
}

// ═══════════════════════════════════════════════════════════════════
// parseExecuteOutput() — Edge Cases
// ═══════════════════════════════════════════════════════════════════

describe('parseExecuteOutput — input boundary edge cases', () => {

  it('should reject empty string', () => {
    const { error } = parseExecuteOutput('');
    expect(error).toContain('empty');
  });

  it('should reject whitespace-only string', () => {
    const { error } = parseExecuteOutput('   \n\t  \n  ');
    expect(error).toContain('empty');
  });

  it('should reject null input', () => {
    const { error } = parseExecuteOutput(null as any);
    expect(error).toContain('empty');
  });

  it('should reject undefined input', () => {
    const { error } = parseExecuteOutput(undefined as any);
    expect(error).toContain('empty');
  });

  it('should reject number input', () => {
    const { error } = parseExecuteOutput(42 as any);
    expect(error).toContain('empty');
  });
});

describe('parseExecuteOutput — JSON extraction strategies', () => {

  it('should parse pure JSON (Strategy 1: raw input)', () => {
    const input = validJson();
    const { parsed, error } = parseExecuteOutput(input);
    expect(error).toBeNull();
    expect(parsed!.actions).toHaveLength(1);
    expect(parsed!.actions[0].type).toBe('WRITE_FILE');
  });

  it('should parse JSON wrapped in ```json fences (Strategy 2)', () => {
    const input = '```json\n' + validJson() + '\n```';
    const { parsed, error } = parseExecuteOutput(input);
    expect(error).toBeNull();
    expect(parsed!.actions).toHaveLength(1);
  });

  it('should parse JSON wrapped in ``` fences without language tag (Strategy 2)', () => {
    const input = '```\n' + validJson() + '\n```';
    const { parsed, error } = parseExecuteOutput(input);
    expect(error).toBeNull();
    expect(parsed!.actions).toHaveLength(1);
  });

  it('should parse JSON with prose before code fences (Strategy 2)', () => {
    const input = 'Here is my structured output:\n\n```json\n' + validJson() + '\n```\n\nDone!';
    const { parsed, error } = parseExecuteOutput(input);
    expect(error).toBeNull();
    expect(parsed!.actions).toHaveLength(1);
  });

  it('should extract JSON from prose with no fences (Strategy 3: brace extraction)', () => {
    const input = 'Here is my output:\n' + validJson() + '\n\nI hope that helps!';
    const { parsed, error } = parseExecuteOutput(input);
    expect(error).toBeNull();
    expect(parsed!.actions).toHaveLength(1);
  });

  it('should handle JSON with leading whitespace before opening brace', () => {
    const input = '\n\n  ' + validJson();
    const { parsed, error } = parseExecuteOutput(input);
    // After trim, starts with { → Strategy 1
    expect(error).toBeNull();
    expect(parsed!.actions).toHaveLength(1);
  });

  it('should fail when no JSON object is present at all', () => {
    const input = 'I cannot complete this task. The files do not exist.';
    const { error } = parseExecuteOutput(input);
    expect(error).toContain('no JSON object found');
  });
});

describe('parseExecuteOutput — JSON parse failures', () => {

  it('should fail on JSON with trailing comma', () => {
    const input = '{"actions": [{"type": "WRITE_FILE", "targetPath": "f.ts",},]}';
    const { error } = parseExecuteOutput(input);
    expect(error).toContain('not valid JSON');
  });

  it('should fail on single-quoted JSON', () => {
    const input = "{'actions': [{'type': 'WRITE_FILE', 'targetPath': 'f.ts'}]}";
    const { error } = parseExecuteOutput(input);
    expect(error).toContain('not valid JSON');
  });

  it('should fail on truncated JSON', () => {
    const input = '{"actions": [{"type": "WRITE_FILE", "targetPa';
    const { error } = parseExecuteOutput(input);
    expect(error).toContain('not valid JSON');
  });

  it('should fail on JavaScript-style (not JSON)', () => {
    const input = '{ actions: [{ type: "WRITE_FILE", targetPath: "f.ts" }] }';
    const { error } = parseExecuteOutput(input);
    expect(error).toContain('not valid JSON');
  });
});

describe('parseExecuteOutput — shape validation edge cases', () => {

  it('should reject JSON root type "null"', () => {
    const { error } = parseExecuteOutput('null');
    // null starts with 'n', not '{', falls through to Strategy 3, no braces found
    expect(error).not.toBeNull();
  });

  it('should reject JSON root type array', () => {
    const { error } = parseExecuteOutput('[{"type":"WRITE_FILE","targetPath":"f.ts"}]');
    // Starts with '[', not '{', falls through to Strategy 3 which won't find { before }
    // Actually Strategy 3 might find braces inside... let's check
    // '[{"type":...' → firstBrace=1, lastBrace=end → extracts the inner object which is incomplete
    expect(error).not.toBeNull();
  });

  it('should reject JSON number root', () => {
    const { error } = parseExecuteOutput('42');
    expect(error).not.toBeNull();
  });

  it('should reject JSON string root', () => {
    const { error } = parseExecuteOutput('"hello"');
    expect(error).not.toBeNull();
  });

  it('should reject object without actions key', () => {
    const { error } = parseExecuteOutput('{"notes": "hello", "result": "ok"}');
    expect(error).toContain('missing required "actions" array');
  });

  it('should reject actions as null', () => {
    const { error } = parseExecuteOutput('{"actions": null}');
    expect(error).toContain('missing required "actions" array');
  });

  it('should reject actions as string', () => {
    const { error } = parseExecuteOutput('{"actions": "not-an-array"}');
    expect(error).toContain('missing required "actions" array');
  });

  it('should reject actions as number', () => {
    const { error } = parseExecuteOutput('{"actions": 42}');
    expect(error).toContain('missing required "actions" array');
  });

  it('should reject actions as object', () => {
    const { error } = parseExecuteOutput('{"actions": {"type":"WRITE_FILE"}}');
    expect(error).toContain('missing required "actions" array');
  });

  it('should accept valid JSON with extra top-level fields (lenient)', () => {
    const input = JSON.stringify({
      actions: [{ type: 'READ_FILE', targetPath: 'f.ts' }],
      notes: 'done',
      extra_field: true,
      metadata: { foo: 'bar' },
    });
    const { parsed, error } = parseExecuteOutput(input);
    expect(error).toBeNull();
    expect(parsed!.actions).toHaveLength(1);
  });

  it('should accept actions with extra fields per action (lenient)', () => {
    const input = JSON.stringify({
      actions: [{
        type: 'WRITE_FILE',
        targetPath: 'f.ts',
        content: 'hello',
        reasoning: 'because we need it',  // extra field
        confidence: 0.95,                  // extra field
      }],
    });
    const { parsed, error } = parseExecuteOutput(input);
    expect(error).toBeNull();
    expect(parsed!.actions).toHaveLength(1);
  });
});

describe('parseExecuteOutput — action item edge cases', () => {

  it('should reject null action in array', () => {
    const input = JSON.stringify({ actions: [null] });
    const { error } = parseExecuteOutput(input);
    expect(error).toContain('actions[0] is not an object');
  });

  it('should reject undefined-equivalent (number) action in array', () => {
    const input = JSON.stringify({ actions: [123] });
    const { error } = parseExecuteOutput(input);
    expect(error).toContain('actions[0] is not an object');
  });

  it('should reject string action in array', () => {
    const input = JSON.stringify({ actions: ['WRITE_FILE src/index.ts'] });
    const { error } = parseExecuteOutput(input);
    expect(error).toContain('actions[0] is not an object');
  });

  it('should reject boolean action in array', () => {
    const input = JSON.stringify({ actions: [true] });
    const { error } = parseExecuteOutput(input);
    expect(error).toContain('actions[0] is not an object');
  });

  it('should reject array action in array (nested array)', () => {
    const input = JSON.stringify({ actions: [['WRITE_FILE', 'f.ts']] });
    const { error } = parseExecuteOutput(input);
    expect(error).toContain('actions[0] is not an object');
  });

  it('should reject action with type as number', () => {
    const input = JSON.stringify({ actions: [{ type: 1, targetPath: 'f.ts' }] });
    const { error } = parseExecuteOutput(input);
    expect(error).toContain('not a valid ActionType');
  });

  it('should reject action with type as boolean', () => {
    const input = JSON.stringify({ actions: [{ type: true, targetPath: 'f.ts' }] });
    const { error } = parseExecuteOutput(input);
    expect(error).toContain('not a valid ActionType');
  });

  it('should reject action with type as null', () => {
    const input = JSON.stringify({ actions: [{ type: null, targetPath: 'f.ts' }] });
    const { error } = parseExecuteOutput(input);
    expect(error).toContain('not a valid ActionType');
  });

  it('should reject action with case-mismatch type', () => {
    const input = JSON.stringify({ actions: [{ type: 'write_file', targetPath: 'f.ts' }] });
    const { error } = parseExecuteOutput(input);
    expect(error).toContain('not a valid ActionType');
  });

  it('should reject action with targetPath as number', () => {
    const input = JSON.stringify({ actions: [{ type: 'WRITE_FILE', targetPath: 42 }] });
    const { error } = parseExecuteOutput(input);
    expect(error).toContain('targetPath is empty or missing');
  });

  it('should reject action with targetPath as boolean', () => {
    const input = JSON.stringify({ actions: [{ type: 'WRITE_FILE', targetPath: false }] });
    const { error } = parseExecuteOutput(input);
    expect(error).toContain('targetPath is empty or missing');
  });

  it('should reject action with targetPath as null', () => {
    const input = JSON.stringify({ actions: [{ type: 'WRITE_FILE', targetPath: null }] });
    const { error } = parseExecuteOutput(input);
    expect(error).toContain('targetPath is empty or missing');
  });

  it('should accept valid empty actions array', () => {
    const input = JSON.stringify({ actions: [] });
    const { parsed, error } = parseExecuteOutput(input);
    expect(error).toBeNull();
    expect(parsed!.actions).toHaveLength(0);
  });

  it('should reject at second invalid action in mixed array', () => {
    const input = JSON.stringify({
      actions: [
        { type: 'WRITE_FILE', targetPath: 'valid.ts', content: 'ok' },
        { type: 'EXEC_SHELL', targetPath: 'cmd' },
      ]
    });
    const { error } = parseExecuteOutput(input);
    expect(error).toContain('actions[1]');
    expect(error).toContain('not a valid ActionType');
  });
});

describe('parseExecuteOutput — large / stress inputs', () => {

  it('should handle a large number of valid actions', () => {
    const actions = Array.from({ length: 100 }, (_, i) => ({
      type: 'WRITE_FILE',
      targetPath: `src/file_${i}.ts`,
      content: `// file ${i}`,
    }));
    const input = JSON.stringify({ actions });
    const { parsed, error } = parseExecuteOutput(input);
    expect(error).toBeNull();
    expect(parsed!.actions).toHaveLength(100);
  });

  it('should handle very long content strings in actions', () => {
    const longContent = 'x'.repeat(100_000);
    const input = JSON.stringify({
      actions: [{ type: 'WRITE_FILE', targetPath: 'big.ts', content: longContent }],
    });
    const { parsed, error } = parseExecuteOutput(input);
    expect(error).toBeNull();
    expect(parsed!.actions[0].content).toHaveLength(100_000);
  });
});

// ═══════════════════════════════════════════════════════════════════
// SafetyController.validateActionsInScope() — Path Edge Cases
// ═══════════════════════════════════════════════════════════════════

describe('validateActionsInScope — path resolution edge cases', () => {

  it('should accept "." (current directory = workspace root)', () => {
    const spec = makeSpec('/app/workspace');
    const actions: ActionPayload[] = [{ type: 'READ_FILE', targetPath: '.' }];
    // "." resolved relative to /app/workspace = /app/workspace
    expect(SafetyController.validateActionsInScope(actions, spec)).toBeNull();
  });

  it('should reject ".." (parent of workspace)', () => {
    const spec = makeSpec('/app/workspace');
    const actions: ActionPayload[] = [{ type: 'READ_FILE', targetPath: '..' }];
    const result = SafetyController.validateActionsInScope(actions, spec);
    expect(result).toContain('resolves outside permitted scope');
  });

  it('should accept absolute path within workspace', () => {
    const spec = makeSpec('/app/workspace');
    const actions: ActionPayload[] = [{ type: 'READ_FILE', targetPath: '/app/workspace/src/file.ts' }];
    expect(SafetyController.validateActionsInScope(actions, spec)).toBeNull();
  });

  it('should reject absolute path outside workspace', () => {
    const spec = makeSpec('/app/workspace');
    const actions: ActionPayload[] = [{ type: 'READ_FILE', targetPath: '/tmp/evil.ts' }];
    const result = SafetyController.validateActionsInScope(actions, spec);
    expect(result).toContain('resolves outside permitted scope');
  });

  it('should accept path with double slashes (normalizes)', () => {
    const spec = makeSpec('/app/workspace');
    const actions: ActionPayload[] = [{ type: 'READ_FILE', targetPath: 'src//deep///file.ts' }];
    expect(SafetyController.validateActionsInScope(actions, spec)).toBeNull();
  });

  it('should accept a deeply nested path', () => {
    const spec = makeSpec('/app/workspace');
    const deepPath = 'a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p.ts';
    const actions: ActionPayload[] = [{ type: 'READ_FILE', targetPath: deepPath }];
    expect(SafetyController.validateActionsInScope(actions, spec)).toBeNull();
  });

  it('should reject path that goes up and then into sibling', () => {
    const spec = makeSpec('/app/workspace');
    const actions: ActionPayload[] = [{ type: 'WRITE_FILE', targetPath: '../sibling/evil.ts', content: 'x' }];
    const result = SafetyController.validateActionsInScope(actions, spec);
    expect(result).toContain('resolves outside permitted scope');
  });

  it('should reject path that goes up multiple levels', () => {
    const spec = makeSpec('/app/workspace');
    const actions: ActionPayload[] = [{ type: 'WRITE_FILE', targetPath: '../../../../etc/passwd', content: 'x' }];
    const result = SafetyController.validateActionsInScope(actions, spec);
    expect(result).toContain('resolves outside permitted scope');
  });

  it('should reject path that uses intermediate ../ to escape', () => {
    const spec = makeSpec('/app/workspace');
    // src/../../outside → /app/outside (escapes workspace)
    const actions: ActionPayload[] = [{ type: 'READ_FILE', targetPath: 'src/../../outside.ts' }];
    const result = SafetyController.validateActionsInScope(actions, spec);
    expect(result).toContain('resolves outside permitted scope');
  });

  it('should handle workspace path with trailing slash', () => {
    // path.resolve normalizes trailing slash, should still work
    const spec = makeSpec('/app/workspace/');
    const actions: ActionPayload[] = [{ type: 'READ_FILE', targetPath: 'file.ts' }];
    expect(SafetyController.validateActionsInScope(actions, spec)).toBeNull();
  });
});

describe('validateActionsInScope — type coercion edge cases', () => {

  it('should reject action type as lowercase variant', () => {
    const spec = makeSpec('/app/workspace');
    const actions = [{ type: 'read_file' as any, targetPath: 'f.ts' }];
    const result = SafetyController.validateActionsInScope(actions, spec);
    expect(result).toContain('invalid type');
  });

  it('should reject action type as mixed case', () => {
    const spec = makeSpec('/app/workspace');
    const actions = [{ type: 'Write_File' as any, targetPath: 'f.ts' }];
    const result = SafetyController.validateActionsInScope(actions, spec);
    expect(result).toContain('invalid type');
  });

  it('should reject action type with trailing space', () => {
    const spec = makeSpec('/app/workspace');
    const actions = [{ type: 'WRITE_FILE ' as any, targetPath: 'f.ts' }];
    const result = SafetyController.validateActionsInScope(actions, spec);
    expect(result).toContain('invalid type');
  });

  it('should reject dangerous action types that look similar', () => {
    const spec = makeSpec('/app/workspace');
    const dangerousTypes = ['EXEC_SHELL', 'DELETE_FILE', 'CHMOD', 'SYMLINK', 'NETWORK_REQUEST', 'RUN_COMMAND'];
    for (const type of dangerousTypes) {
      const actions = [{ type: type as any, targetPath: 'f.ts' }];
      const result = SafetyController.validateActionsInScope(actions, spec);
      expect(result).toContain('invalid type');
    }
  });
});

describe('validateActionsInScope — adversarial targetPath values', () => {

  it('should reject path with null bytes (injection attempt)', () => {
    const spec = makeSpec('/app/workspace');
    const actions: ActionPayload[] = [{ type: 'READ_FILE', targetPath: 'src/\0evil.ts' }];
    // Null bytes are a C-string truncation attack vector — always rejected.
    const result = SafetyController.validateActionsInScope(actions, spec);
    expect(result).not.toBeNull();
    expect(result).toContain('null byte');
  });

  it('should reject path with only spaces', () => {
    const spec = makeSpec('/app/workspace');
    const actions: ActionPayload[] = [{ type: 'READ_FILE', targetPath: '   ' }];
    const result = SafetyController.validateActionsInScope(actions, spec);
    expect(result).toContain('targetPath is empty or missing');
  });

  it('should handle path with unicode characters', () => {
    const spec = makeSpec('/app/workspace');
    const actions: ActionPayload[] = [{ type: 'READ_FILE', targetPath: 'src/日本語/файл.ts' }];
    // Unicode paths within workspace should be accepted
    expect(SafetyController.validateActionsInScope(actions, spec)).toBeNull();
  });

  it('should handle very long path without crashing', () => {
    const spec = makeSpec('/app/workspace');
    const longPath = 'a/'.repeat(500) + 'file.ts';
    const actions: ActionPayload[] = [{ type: 'READ_FILE', targetPath: longPath }];
    expect(() => SafetyController.validateActionsInScope(actions, spec)).not.toThrow();
  });

  it('should handle path with dot segments that cancel out', () => {
    const spec = makeSpec('/app/workspace');
    // Goes into src, up one (back to workspace), into lib → /app/workspace/lib/file.ts
    const actions: ActionPayload[] = [{ type: 'READ_FILE', targetPath: 'src/../lib/file.ts' }];
    expect(SafetyController.validateActionsInScope(actions, spec)).toBeNull();
  });

  it('should reject path that is exactly the parent directory', () => {
    const spec = makeSpec('/app/workspace');
    const actions: ActionPayload[] = [{ type: 'READ_FILE', targetPath: '/app' }];
    const result = SafetyController.validateActionsInScope(actions, spec);
    expect(result).toContain('resolves outside permitted scope');
  });

  it('should handle path with embedded newline without crashing', () => {
    const spec = makeSpec('/app/workspace');
    const actions: ActionPayload[] = [{ type: 'READ_FILE', targetPath: 'src/file\n../../etc/passwd' }];
    expect(() => SafetyController.validateActionsInScope(actions, spec)).not.toThrow();
  });
});

describe('validateActionsInScope — unrestricted mode (no workingDirectory)', () => {

  it('should accept any absolute path when unrestricted', () => {
    const spec = makeSpec(undefined);
    const actions: ActionPayload[] = [{ type: 'READ_FILE', targetPath: '/etc/hosts' }];
    expect(SafetyController.validateActionsInScope(actions, spec)).toBeNull();
  });

  it('should still validate action types when unrestricted', () => {
    const spec = makeSpec(undefined);
    const actions = [{ type: 'EXEC_SHELL' as any, targetPath: '/bin/bash' }];
    const result = SafetyController.validateActionsInScope(actions, spec);
    expect(result).toContain('invalid type');
  });

  it('should still reject empty targetPath when unrestricted', () => {
    const spec = makeSpec(undefined);
    const actions: ActionPayload[] = [{ type: 'READ_FILE', targetPath: '' }];
    const result = SafetyController.validateActionsInScope(actions, spec);
    expect(result).toContain('targetPath is empty or missing');
  });
});
