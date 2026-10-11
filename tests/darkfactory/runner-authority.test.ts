import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {PipelineState} from '../../src/storage/interface.js';

const state=vi.hoisted(()=>({backend:null as any,invoke:vi.fn()}));
vi.mock('../../src/storage/index.js',()=>({getStorage:async()=>state.backend}));
vi.mock('../../src/darkfactory/clawInvocation.js',()=>({invokeClawAgent:state.invoke}));
let runner:typeof import('../../src/darkfactory/runner.js');
let authority:typeof import('../../src/darkfactory/executionAuthority.js');
let config:typeof import('../../src/storage/configStorage.js');
let folder:string;
const originalConfig=process.env.PRISM_CONFIG_PATH;
const originalPoll=process.env.PRISM_DARK_FACTORY_POLL_MS;
function pipeline(status:'PENDING'|'RUNNING',directory:string):PipelineState {
 const now=new Date().toISOString();
 return {id:randomUUID(),project:'runner-authority-test',user_id:'default',status,current_step:'INIT',iteration:0,spec:JSON.stringify({objective:'Verify host execution authority',workingDirectory:directory,maxIterations:1}),started_at:now,updated_at:now,last_heartbeat:now,error:null};
}
beforeEach(async()=>{
 vi.resetModules();folder=mkdtempSync(join(tmpdir(),'factory-runner-authority-'));
 process.env.PRISM_CONFIG_PATH=join(folder,'config.db');process.env.PRISM_DARK_FACTORY_POLL_MS='20';
 const rows=new Map<string,PipelineState>();
 state.backend={rows,listPipelines:vi.fn(async(_project:any,status:string)=>[...rows.values()].filter(p=>p.status===status).map(p=>({...p}))),getPipeline:vi.fn(async(id:string)=>rows.has(id)?{...rows.get(id)}:null),savePipeline:vi.fn(async(p:PipelineState)=>{rows.set(p.id,{...p});}),saveLedger:vi.fn(async()=>{})};
 state.invoke.mockReset();state.invoke.mockResolvedValue({success:true,resultText:'Controlled test plan'});
 config=await import('../../src/storage/configStorage.js');await config.initConfigStorage();
 authority=await import('../../src/darkfactory/executionAuthority.js');runner=await import('../../src/darkfactory/runner.js');
});
afterEach(async()=>{runner?.stopDarkFactoryRunner();await new Promise(r=>setTimeout(r,50));config?.closeConfigStorage();
 if(originalConfig===undefined)delete process.env.PRISM_CONFIG_PATH;else process.env.PRISM_CONFIG_PATH=originalConfig;
 if(originalPoll===undefined)delete process.env.PRISM_DARK_FACTORY_POLL_MS;else process.env.PRISM_DARK_FACTORY_POLL_MS=originalPoll;
});
describe('Factory runner respects local execution authority',()=>{
 it.each(['existing','absent'])('does not promote or fail a foreign pending job with an %s path',async kind=>{
  const foreign=pipeline('PENDING',kind==='existing'?folder:join(folder,'other-machine-only'));
  state.backend.rows.set(foreign.id,foreign);await runner.startDarkFactoryRunner();
  await vi.waitFor(()=>expect(state.backend.listPipelines.mock.calls.length).toBeGreaterThan(3));
  expect(state.backend.rows.get(foreign.id).status).toBe('PENDING');expect(state.backend.savePipeline).not.toHaveBeenCalled();expect(state.invoke).not.toHaveBeenCalled();
 });
 it('does not fail a foreign running job during startup recovery or zombie sweep',async()=>{
  const foreign=pipeline('RUNNING',folder);foreign.last_heartbeat=new Date(Date.now()-600000).toISOString();
  state.backend.rows.set(foreign.id,foreign);await runner.startDarkFactoryRunner();
  await vi.waitFor(()=>expect(state.backend.listPipelines.mock.calls.length).toBeGreaterThan(3));
  expect(state.backend.rows.get(foreign.id).status).toBe('RUNNING');expect(state.backend.savePipeline).not.toHaveBeenCalled();expect(state.invoke).not.toHaveBeenCalled();
 });
 it('preserves another live instance holding the owned job lease',async()=>{
  const owned=pipeline('RUNNING',folder);state.backend.rows.set(owned.id,owned);await authority.registerPipelineAuthority(owned);
  const other=await authority.claimPipelineLease(owned);expect(other).not.toBeNull();
  try {await runner.startDarkFactoryRunner();await vi.waitFor(()=>expect(state.backend.listPipelines.mock.calls.length).toBeGreaterThan(3));
   expect(state.backend.savePipeline).not.toHaveBeenCalled();expect(state.invoke).not.toHaveBeenCalled();
  }finally{await other!.release();}
 });
 it('advances an authorized pending job and releases the lease for its next step',async()=>{
  const owned=pipeline('PENDING',folder);state.backend.rows.set(owned.id,owned);await authority.registerPipelineAuthority(owned);
  state.backend.savePipeline.mockImplementation(async(p:PipelineState)=>{state.backend.rows.set(p.id,{...p});if(p.current_step==='PLAN')runner.stopDarkFactoryRunner();});
  await runner.startDarkFactoryRunner();await vi.waitFor(()=>expect(state.backend.rows.get(owned.id).current_step).toBe('PLAN'));
  runner.stopDarkFactoryRunner();await new Promise(r=>setTimeout(r,30));
  expect(state.invoke).toHaveBeenCalled();const next=await authority.claimPipelineLease(state.backend.rows.get(owned.id));expect(next).not.toBeNull();expect(next!.reclaimed).toBe(false);await next!.release();
 });
 it('does not replay a reclaimed step when a delayed heartbeat makes recovery lose CAS',async()=>{
  const owned=pipeline('RUNNING',folder);state.backend.rows.set(owned.id,owned);await authority.registerPipelineAuthority(owned);
  const expired=await config.claimFactoryLease(owned,1);await new Promise(r=>setTimeout(r,5));expect(expired).not.toBeNull();
  let conflicts=0;
  state.backend.savePipeline.mockImplementation(async(p:PipelineState)=>{
   if(p.status==='FAILED'&&conflicts++===0){state.backend.rows.set(p.id,{...owned,updated_at:new Date(Date.now()+1).toISOString(),last_heartbeat:new Date().toISOString()});throw new Error('changed concurrently: delayed heartbeat');}
   state.backend.rows.set(p.id,{...p});
  });
  await runner.startDarkFactoryRunner();
  await vi.waitFor(()=>expect(state.backend.rows.get(owned.id).status).toBe('FAILED'));
  expect(conflicts).toBeGreaterThan(1);expect(state.invoke).not.toHaveBeenCalled();
 });
 it('clears recovery after safely promoting a reclaimed pending job',async()=>{
  const owned=pipeline('PENDING',folder);state.backend.rows.set(owned.id,owned);await authority.registerPipelineAuthority(owned);
  const abandoned=await config.claimFactoryLease(owned,1);expect(abandoned).not.toBeNull();await new Promise(r=>setTimeout(r,5));
  state.backend.savePipeline.mockImplementation(async(p:PipelineState)=>{state.backend.rows.set(p.id,{...p});if(p.current_step==='PLAN')runner.stopDarkFactoryRunner();});
  await runner.startDarkFactoryRunner();await vi.waitFor(()=>expect(state.backend.rows.get(owned.id).current_step).toBe('PLAN'));
  await new Promise(r=>setTimeout(r,30));
  expect(state.backend.rows.get(owned.id).status).toBe('RUNNING');
  const next=await authority.claimPipelineLease(state.backend.rows.get(owned.id));expect(next).not.toBeNull();expect(next!.reclaimed).toBe(false);await next!.release();
 });
});
