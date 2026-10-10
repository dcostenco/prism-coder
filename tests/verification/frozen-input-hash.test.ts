import {describe,expect,it} from 'vitest';
import {VerificationRunner} from '../../src/verification/runner.js';
import {computeRubricHash,type TestAssertion,type VerificationHarness} from '../../src/verification/schema.js';
const TESTS:TestAssertion[]=[{id:'fixture',layer:'pipeline',description:'Existing file',severity:'gate',assertion:{type:'file_exists',target:import.meta.filename,expected:true}}];
const HARNESS:VerificationHarness={project:'hash-fixture',conversation_id:'hash-fixture',created_at:'2026-10-10T00:00:00Z',rubric_hash:computeRubricHash(TESTS,1),min_pass_rate:1,tests:TESTS};
const OPTIONS={harness:HARNESS,config:{enabled:true,layers:['pipeline'],default_severity:'warn' as const}};
describe('frozen input hash is independent of execution normalization',()=>{
 it('runs valid frozen assertions even when schema parsing changes object key order',async()=>{const result=await VerificationRunner.runSuite(JSON.stringify(HARNESS),OPTIONS);expect(result.passed).toBe(true);expect(result.assertion_results[0].id).toBe('fixture');});
 it('still aborts when a submitted assertion changes after the frozen hash was made',async()=>{const changed={...HARNESS,tests:[{...TESTS[0],assertion:{...TESTS[0].assertion,expected:false}}]};const result=await VerificationRunner.runSuite(JSON.stringify(changed),OPTIONS);expect(result.passed).toBe(false);expect(result.severity_gate.action).toBe('abort');expect(result.assertion_results[0].error).toContain('hash mismatch');});
});
