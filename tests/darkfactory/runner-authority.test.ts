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
 it('advances discovered owned work when publishing the discovery result fails',async()=>{
  state.backend.factoryPollScope='publish-failure';
  const job=pipeline('PENDING',folder);state.backend.rows.set(job.id,job);await authority.registerPipelineAuthority(job);
  const claim=config.claimFactoryPoll;
  const scan=vi.spyOn(config,'claimFactoryPoll').mockImplementation(async(...args)=>{
   const lease=await claim(...args);if(!lease)return null;
   return {...lease,finish:async()=>{runner.stopDarkFactoryRunner();throw new Error('SQLITE_BUSY publishing discovery');}};
  });
  const error=vi.spyOn(console,'error').mockImplementation(()=>{});
  try {
   await runner.startDarkFactoryRunner();
   await vi.waitFor(()=>expect(state.backend.rows.get(job.id).current_step).toBe('PLAN'),{timeout:200,interval:5});
   expect(state.invoke).toHaveBeenCalledTimes(1);
   expect(state.backend.getPipeline).toHaveBeenCalledWith(job.id,job.user_id);
   expect(error).toHaveBeenCalledWith(expect.stringContaining('SQLITE_BUSY publishing discovery'));
  }finally{scan.mockRestore();error.mockRestore();}
 });
 it.each(['owned','foreign','terminal'])('uses preserved hints after a failed scan without bypassing %s work validation',async kind=>{
  state.backend.factoryPollScope='failed-scan-hint';
  const job=pipeline('PENDING',folder);
  state.backend.rows.set(job.id,kind==='terminal'?{...job,status:'FAILED'}:job);
  if(kind!=='foreign')await authority.registerPipelineAuthority(job);
  const scan=await config.claimFactoryPoll('failed-scan-hint',1);
  await scan!.finish('busy',Date.now(),[job]);
  state.backend.listPipelines.mockRejectedValue(new Error('Factory pipelines unavailable'));
  state.backend.savePipeline.mockImplementation(async(p:PipelineState)=>{state.backend.rows.set(p.id,{...p});if(p.current_step==='PLAN')runner.stopDarkFactoryRunner();});
  const error=vi.spyOn(console,'error').mockImplementation(()=>{});
  try {
   await runner.startDarkFactoryRunner();
   if(kind==='owned'){
    await vi.waitFor(()=>expect(state.backend.rows.get(job.id).current_step).toBe('PLAN'),{timeout:200,interval:5});
    expect(state.invoke).toHaveBeenCalledTimes(1);
    expect(state.backend.getPipeline).toHaveBeenCalledWith(job.id,job.user_id);
   }else{
    await new Promise(r=>setTimeout(r,60));
    expect(state.invoke).not.toHaveBeenCalled();expect(state.backend.savePipeline).not.toHaveBeenCalled();
   }
   expect(state.backend.listPipelines).toHaveBeenCalled();
   expect(error).toHaveBeenCalledWith(expect.stringContaining('Factory pipelines unavailable'));
  }finally{error.mockRestore();}
 });
 it('executes an authorized shared hint even when the discovery clock is not due',async()=>{
  state.backend.factoryPollScope='cached-active';
  const job=pipeline('PENDING',folder);state.backend.rows.set(job.id,job);await authority.registerPipelineAuthority(job);
  const scan=await config.claimFactoryPoll('cached-active',1000);
  await scan!.finish('busy',Date.now(),[job]);
  state.backend.savePipeline.mockImplementation(async(p:PipelineState)=>{state.backend.rows.set(p.id,{...p});if(p.current_step==='PLAN')runner.stopDarkFactoryRunner();});
  await runner.startDarkFactoryRunner();
  await vi.waitFor(()=>expect(state.backend.rows.get(job.id).current_step).toBe('PLAN'),{timeout:200,interval:5});
  expect(state.backend.listPipelines).not.toHaveBeenCalled();
 });
 it('does not treat a shared discovery hint as authority to execute foreign work',async()=>{
  state.backend.factoryPollScope='cached-foreign';
  const foreign=pipeline('PENDING',folder);state.backend.rows.set(foreign.id,foreign);
  const scan=await config.claimFactoryPoll('cached-foreign',1000);
  await scan!.finish('busy',Date.now(),[foreign]);
  await runner.startDarkFactoryRunner();await new Promise(r=>setTimeout(r,60));
  expect(state.invoke).not.toHaveBeenCalled();expect(state.backend.savePipeline).not.toHaveBeenCalled();
  expect(state.backend.getPipeline).not.toHaveBeenCalled();
 });
 it('skips a terminal shared hint and advances the next owned job in the same tick',async()=>{
  state.backend.factoryPollScope='cached-terminal';
  const stale=pipeline('PENDING',folder),queued=pipeline('PENDING',folder);
  for(const job of [stale,queued])await authority.registerPipelineAuthority(job);
  state.backend.rows.set(stale.id,{...stale,status:'FAILED'});state.backend.rows.set(queued.id,queued);
  const scan=await config.claimFactoryPoll('cached-terminal',1000);
  await scan!.finish('busy',Date.now(),[stale,queued]);
  state.backend.savePipeline.mockImplementation(async(p:PipelineState)=>{state.backend.rows.set(p.id,{...p});if(p.id===queued.id&&p.current_step==='PLAN')runner.stopDarkFactoryRunner();});
  await runner.startDarkFactoryRunner();
  await vi.waitFor(()=>expect(state.backend.rows.get(queued.id).current_step).toBe('PLAN'),{timeout:200,interval:5});
  expect(state.invoke).toHaveBeenCalledTimes(1);expect(state.backend.listPipelines).not.toHaveBeenCalled();
 });
 it('lets two host windows advance separate owned jobs from one shared discovery scan',async()=>{
  state.backend.factoryPollScope='shared-active';
  for(const job of [pipeline('PENDING',folder),pipeline('PENDING',folder)]){
   state.backend.rows.set(job.id,job);await authority.registerPipelineAuthority(job);
  }
  const firstRunner=runner;
  vi.resetModules();
  const secondConfig=await import('../../src/storage/configStorage.js');await secondConfig.initConfigStorage();
  const secondRunner=await import('../../src/darkfactory/runner.js');
  let scansSettled=0;
  const claimFirst=config.claimFactoryPoll,claimSecond=secondConfig.claimFactoryPoll;
  const firstSpy=vi.spyOn(config,'claimFactoryPoll').mockImplementation(async(...args)=>{const result=await claimFirst(...args);scansSettled++;return result;});
  const secondSpy=vi.spyOn(secondConfig,'claimFactoryPoll').mockImplementation(async(...args)=>{const result=await claimSecond(...args);scansSettled++;return result;});
  let releaseDiscovery!:()=>void;
  const discovery=new Promise<void>(resolve=>{releaseDiscovery=resolve;});
  state.backend.listPipelines.mockImplementation(async(_project:any,status:string)=>{
   await discovery;return [...state.backend.rows.values()].filter((p:PipelineState)=>p.status===status).map((p:PipelineState)=>({...p}));
  });
  let release!:()=>void;
  const executing=new Promise<void>(resolve=>{release=resolve;});
  state.invoke.mockImplementation(async()=>{await executing;return {success:true,resultText:'Controlled concurrent plan'};});
  try {
   await Promise.all([firstRunner.startDarkFactoryRunner(),secondRunner.startDarkFactoryRunner()]);
   // Force both processes to contend while discovery is still in flight.
   await vi.waitFor(()=>expect(scansSettled).toBe(2),{timeout:500,interval:5});releaseDiscovery();
   await vi.waitFor(()=>expect(state.invoke).toHaveBeenCalledTimes(2),{timeout:300,interval:5});
   expect(state.backend.listPipelines).toHaveBeenCalledTimes(2);
  }finally{
   firstRunner.stopDarkFactoryRunner();secondRunner.stopDarkFactoryRunner();releaseDiscovery();release();
   await new Promise(r=>setTimeout(r,60));secondConfig.closeConfigStorage();
   firstSpy.mockRestore();secondSpy.mockRestore();
  }
 });
 it('advances the next owned job in the same scan that retires an older zombie',async()=>{
  state.backend.factoryPollScope='zombie-account';
  const zombie=pipeline('RUNNING',folder);
  zombie.updated_at=zombie.last_heartbeat=new Date(Date.now()-600000).toISOString();
  const queued=pipeline('PENDING',folder);
  for(const job of [zombie,queued]){state.backend.rows.set(job.id,job);await authority.registerPipelineAuthority(job);}
  state.backend.savePipeline.mockImplementation(async(p:PipelineState)=>{state.backend.rows.set(p.id,{...p});if(p.id===queued.id&&p.current_step==='PLAN')runner.stopDarkFactoryRunner();});
  await runner.startDarkFactoryRunner();
  await vi.waitFor(()=>expect(state.backend.rows.get(queued.id).current_step).toBe('PLAN'));
  expect(state.backend.rows.get(zombie.id).status).toBe('FAILED');
  expect(state.backend.listPipelines).toHaveBeenCalledTimes(2);
 });
 it('retries failed discovery at the base cadence instead of certifying an idle queue',async()=>{
  state.backend.factoryPollScope='error-account';
  state.backend.listPipelines.mockRejectedValue(new Error('Factory pipelines unavailable'));
  const error=vi.spyOn(console,'error').mockImplementation(()=>{});
  try {
   await runner.startDarkFactoryRunner();
   await vi.waitFor(()=>expect(state.backend.listPipelines.mock.calls.length).toBeGreaterThanOrEqual(8),{timeout:280,interval:5});
   expect(error).toHaveBeenCalledWith(expect.stringContaining('Factory pipelines unavailable'));
  } finally {error.mockRestore();}
 });
 it('shares remote discovery and backs off empty scans instead of polling on every tick',async()=>{
  state.backend.factoryPollScope='remote-account';
  await runner.startDarkFactoryRunner();
  expect(state.backend.listPipelines).not.toHaveBeenCalled();
  await new Promise(r=>setTimeout(r,250));
  // With 20ms ticks the old runner issues over 30 reads. A shared idle scan
  // issues only two reads at each exponentially spaced discovery time.
  expect(state.backend.listPipelines.mock.calls.length).toBeGreaterThanOrEqual(4);
  expect(state.backend.listPipelines.mock.calls.length).toBeLessThanOrEqual(10);
 });
 it('picks up a newly submitted owned job promptly after an idle-backoff wake',async()=>{
  state.backend.factoryPollScope='wake-account';
  await runner.startDarkFactoryRunner();
  await vi.waitFor(()=>expect(state.backend.listPipelines.mock.calls.length).toBeGreaterThanOrEqual(8),{interval:5});
  const owned=pipeline('PENDING',folder);state.backend.rows.set(owned.id,owned);
  await authority.registerPipelineAuthority(owned);
  state.backend.savePipeline.mockImplementation(async(p:PipelineState)=>{state.backend.rows.set(p.id,{...p});if(p.current_step==='PLAN')runner.stopDarkFactoryRunner();});
  await config.wakeFactoryPolling('wake-account');
  await vi.waitFor(()=>expect(state.backend.rows.get(owned.id).current_step).toBe('PLAN'),{timeout:100,interval:5});
  expect(state.invoke).toHaveBeenCalled();
 });
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
