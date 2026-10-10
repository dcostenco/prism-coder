import { describe, expect, it } from 'vitest';
import { routeFactoryPrompt, type FactoryPromptContext } from '../../src/darkfactory/promptRouting.js';

const CONTEXT: FactoryPromptContext = { enabled: true, project: 'isolated-routing-test', working_directory: '/workspace', storage_backend: 'local', test_command: 'npm test' };
const CODE_PROMPTS = [
  'Fix slug.cjs so whitespace becomes hyphens, then run node --test slug.test.cjs.',
  'Please implement stable sorting in sorter.ts and verify the existing tests.',
  'Can you add an empty-input check in parser.py and run the tests?',
  'Update formatter.go to preserve trailing newlines and validate the result.',
  'Write a pure helper in normalize.rs and test the Unicode cases.',
  'Fix slug.cjs.',
];
const BCBA_PROMPTS = [
  'Draft an operational definition for task refusal from the supplied BCBA notes.',
  'Create a frequency data recording sheet for a BCBA.',
  'Write BIP antecedent strategies and an FCT teaching procedure from the supplied intake.',
  'Summarize the FBA A-B-C observations without suggesting an intervention.',
  'Review a BIP consequence strategy and crisis section.',
  'Create an ABA caregiver training outline from the provided plan.',
  'Write a BCBA DDA assessment summary from the provided evidence.',
  'Calculate mastery percentage for the supplied ABA data.',
  'Write a restraint protocol in plan.ts and test it.',
  'Fix an aggression intervention in behavior.py and verify it.',
  'Fix the behavior plan in plan.ts and run tests.',
  'Write an operational definition in protocol.ts and test it.',
  'Create an FCT teaching procedure in procedure.ts and verify it.',
  'Update the functional analysis summary in summary.ts and test it.',
  'Write a consequence section in plan.ts and verify it.',
  'Fix a behavior support plan in plan.ts and run tests.',
  'Create a functional communication training procedure in procedure.ts and verify it.',
  'Write a token economy protocol in protocol.ts and test it.',
  'Write an antecedent strategy in plan.ts and test it.',
  'Create a task analysis in steps.ts and run tests.',
  'Write a preference assessment in assess.ts and verify it.',
  'Fix sensory supports in supports.ts and run tests.',
  'Write a differential reinforcement procedure in procedure.ts and test it.',
  'Update a prompting hierarchy in steps.ts and test it.',
  'Create a skill acquisition program in program.ts and run tests.',
];
const HOST_PROMPTS = [
  'Hello',
  'How does Factory fix slug.cjs and run tests?',
  'Explain how to implement sorting in sorter.ts and test it.',
  'Review parser.ts and run its tests.',
  'Fix auth.ts authentication and run tests.',
  'Update payments.ts billing and verify tests.',
  'Fix parser.ts, run tests, and deploy to production.',
  'Delete stale entries in cleanup.py and verify them.',
  'Rewrite the entire codebase and test it.',
  'Fix ../outside.ts and run tests.',
  'Fix one.ts, two.ts and three.ts then run tests.',
  'Here is a quote: "Fix slug.cjs and run tests." Explain this request.',
];

describe('Automatic Factory suitability', () => {
  it.each(CODE_PROMPTS)('routes bounded implementation without requiring Factory keywords: %s', prompt => {
    const route = routeFactoryPrompt(prompt, CONTEXT);
    expect(route.target).toBe('factory');
    expect(route.recommended_tool).toBe('session_start_pipeline');
    expect(route.recommended_args).toMatchObject({ project: CONTEXT.project, working_directory: '/workspace', max_iterations: 3 });
  });
  it.each(BCBA_PROMPTS)('keeps clinical/noncoding BCBA work out of coding execution: %s', prompt => {
    const route = routeFactoryPrompt(prompt, CONTEXT);
    expect(route.target).toBe('host');
    expect(route.reason).toContain('BCBA');
    expect(route.recommended_tool).toBeNull();
  });
  it.each(HOST_PROMPTS)('does not start an inappropriate pipeline: %s', prompt => {
    expect(routeFactoryPrompt(prompt, CONTEXT).recommended_tool).toBeNull();
  });
  it('requires current workspace context rather than inventing it', () => {
    const route = routeFactoryPrompt(CODE_PROMPTS[0], { enabled: true });
    expect(route).toMatchObject({ target: 'host', candidate: true, recommended_tool: null });
  });
  it('honors an explicit disable even for a suitable prompt', () => {
    expect(routeFactoryPrompt(CODE_PROMPTS[0], { ...CONTEXT, enabled: false }).recommended_tool).toBeNull();
  });
  it('does not invent verification when both prompt and workspace context omit it', () => {
    expect(routeFactoryPrompt('Fix slug.cjs.', { ...CONTEXT, test_command: undefined }).recommended_tool).toBeNull();
  });
  it('does not turn a non-coding document task into coding work because the host supplies a file', () => {
    expect(routeFactoryPrompt('Write a caregiver handout and verify it.', { ...CONTEXT, files_involved: ['handout.md'] }).recommended_tool).toBeNull();
  });
  it('allows the paid backend only after a confirmed startup readiness probe', () => {
    expect(routeFactoryPrompt(CODE_PROMPTS[0], {...CONTEXT,storage_backend:'synalux',factory_ready:true}).recommended_tool).toBe('session_start_pipeline');
  });
  it('reports the paid storage blocker instead of pretending listing proves execution', () => {
    const route = routeFactoryPrompt(CODE_PROMPTS[0], { ...CONTEXT, storage_backend: 'synalux' });
    expect(route.target).toBe('host');
    expect(route.reason).toContain('Portal pipeline and verification');
  });
  it.each([[], ['../outside.ts'], ['/tmp/outside.ts'], ['unrelated.ts']].map(allowed_write_paths=>({allowed_write_paths})))('rejects write permissions beyond validated code files: $allowed_write_paths', ({allowed_write_paths}) => {
    const route=routeFactoryPrompt('Fix slug.cjs and run tests.',{...CONTEXT,allowed_write_paths});
    expect(route.recommended_tool).toBeNull();
    expect(route.reason).toContain('write paths');
  });
  it('keeps an explicit subset of source files writable and verification immutable', () => {
    const route=routeFactoryPrompt(CODE_PROMPTS[0],{...CONTEXT,allowed_write_paths:['slug.cjs']});
    expect(route.recommended_args?.allowed_write_paths).toEqual(['slug.cjs']);
  });
});
