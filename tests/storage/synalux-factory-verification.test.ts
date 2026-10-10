import {afterEach,describe,expect,it,vi} from 'vitest';
import {SynaluxStorage} from '../../src/storage/synalux.js';
import {VerificationRunner} from '../../src/verification/runner.js';
import {computeRubricHash,type VerificationHarness,type ValidationResult} from '../../src/verification/schema.js';
const TESTS:VerificationHarness['tests']=[{id:'assertion-a',layer:'pipeline',description:'fixture',severity:'gate',assertion:{type:'file_exists',target:'source.ts',expected:true}}];
const HARNESS:VerificationHarness={project:'fixture',conversation_id:'fixture-conversation',created_at:'2026-10-10T00:00:00Z',rubric_hash:computeRubricHash(TESTS,1),min_pass_rate:1,tests:TESTS};
const RUN:ValidationResult={id:'run-fixture',rubric_hash:HARNESS.rubric_hash,project:HARNESS.project,conversation_id:HARNESS.conversation_id,run_at:HARNESS.created_at,passed:true,pass_rate:1,critical_failures:0,coverage_score:1,result_json:'{"passed":true}',gate_action:'continue'};
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
function client(response:unknown,status=200){vi.stubEnv('PRISM_SYNALUX_BASE_URL','https://portal.test');vi.stubEnv('PRISM_SYNALUX_API_KEY','synalux_sk_');vi.stubEnv('SUPABASE_URL','');vi.stubEnv('SUPABASE_KEY','');const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({status:'success',jwt:'fixture-jwt'}))).mockResolvedValueOnce(new Response(JSON.stringify(response),{status}));vi.stubGlobal('fetch',fetch);return {storage:new SynaluxStorage(),fetch};}
describe('verification persistence is Portal-only for paid accounts',()=>{
 it('saves harness and run without forwarding a caller owner',async()=>{
  const a=client({status:'success',harness:HARNESS});await a.storage.saveVerificationHarness(HARNESS,'spoof');expect(JSON.parse(a.fetch.mock.calls[1][1].body)).toEqual({action:'save_harness',harness:HARNESS});
  const b=client({status:'success',run:RUN});await b.storage.saveVerificationRun(RUN,'spoof');expect(JSON.parse(b.fetch.mock.calls[1][1].body)).toEqual({action:'save_run',run:RUN});expect(b.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer fixture-jwt');
 });
 it('reads canonical harness and run through their owner-scoped endpoint',async()=>{
  const a=client({status:'success',harness:HARNESS});const loaded=await a.storage.getVerificationHarness(HARNESS.rubric_hash,'spoof');expect(loaded).toEqual(HARNESS);expect(()=>VerificationRunner.verifyRubricHash(loaded!.tests,loaded!)).not.toThrow();
  const b=client({status:'success',run:RUN});expect(await b.storage.getVerificationRun(RUN.id,'spoof')).toEqual(RUN);
 });
 it('lists only the requested project and preserves genuine absence',async()=>{
  const a=client({status:'success',runs:[RUN]});expect(await a.storage.listVerificationRuns(RUN.project,'spoof')).toEqual([RUN]);
  const b=client({status:'success',run:null});expect(await b.storage.getVerificationRun(RUN.id,'owner')).toBeNull();
 });
 it('rejects mismatched identities and malformed records',async()=>{
  const a=client({status:'success',run:{...RUN,id:'other'}});await expect(a.storage.getVerificationRun(RUN.id,'owner')).rejects.toThrow(/Invalid/);
  const b=client({status:'success',runs:[{...RUN,project:'other'}]});await expect(b.storage.listVerificationRuns(RUN.project,'owner')).rejects.toThrow(/Invalid/);
  const c=client({status:'success',harness:{...HARNESS,tests:'bad'}});await expect(c.storage.getVerificationHarness(HARNESS.rubric_hash,'owner')).rejects.toThrow(/Invalid/);
 });
 it('reports canonical reused harness origin without mutating it',async()=>{const a=client({status:'success',reused:true,harness:{...HARNESS,project:'original-project',conversation_id:'original-conversation'}});await expect(a.storage.saveVerificationHarness(HARNESS,'owner')).resolves.toBeUndefined();});
 it('surfaces storage failure instead of acknowledging a phantom save',async()=>{const a=client({status:'error',error:'unavailable'},503);await expect(a.storage.saveVerificationHarness(HARNESS,'owner')).rejects.toThrow(/unavailable/);});
});
