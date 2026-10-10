import {afterEach,describe,expect,it,vi} from 'vitest';
import {SynaluxStorage} from '../../src/storage/synalux.js';
import type {PipelineState} from '../../src/storage/interface.js';
const BASE='https://portal.test';
const ROW:PipelineState={id:'factory-write-fixture',project:'factory-write',user_id:'local-placeholder',status:'PENDING',current_step:'INIT',iteration:0,started_at:'2026-10-10T00:00:00.000Z',updated_at:'2026-10-10T00:00:00.000Z',spec:'{"objective":"fixture","maxIterations":3}',error:null,last_heartbeat:null};
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
function client(pipeline:unknown,status=200){
 vi.stubEnv('PRISM_SYNALUX_BASE_URL',BASE);vi.stubEnv('PRISM_SYNALUX_API_KEY','synalux_sk_');vi.stubEnv('SUPABASE_URL','');vi.stubEnv('SUPABASE_KEY','');
 const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({status:'success',jwt:'fixture-jwt',expires_in:900}))).mockResolvedValueOnce(new Response(JSON.stringify({status:'success',pipeline}),{status}));vi.stubGlobal('fetch',fetch);return {storage:new SynaluxStorage(),fetch};
}
const persisted=(patch:Partial<PipelineState>={})=>({...ROW,user_id:'authenticated-owner',updated_at:'2026-10-10T00:00:00.001Z',...patch});
describe('paid Factory save/get use authenticated Portal, never inherited database transport',()=>{
 it('creates without trusting caller owner and adopts canonical owner/version only after success',async()=>{
  const {storage,fetch}=client(persisted());const state={...ROW};await storage.savePipeline(state);
  expect(state.user_id).toBe('authenticated-owner');expect(state.updated_at).toBe(persisted().updated_at);
  expect(fetch.mock.calls[1][0]).toBe(BASE+'/api/v1/prism/factory/pipeline');
  const request=fetch.mock.calls[1][1];expect(request.headers.Authorization).toBe('Bearer fixture-jwt');const body=JSON.parse(request.body);
  expect(body.operation).toBe('create');expect(body.pipeline).not.toHaveProperty('user_id');expect(body).not.toHaveProperty('expected_updated_at');
 });
 it('updates with the caller persisted version and accepts RUNNING step progress',async()=>{
  const state={...persisted(),status:'RUNNING' as const,current_step:'PLAN'};const {storage,fetch}=client({...state,updated_at:'2026-10-10T00:00:00.002Z'});await storage.savePipeline(state);
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({operation:'update',expected_updated_at:'2026-10-10T00:00:00.001Z'});expect(state.updated_at).toBe('2026-10-10T00:00:00.002Z');
 });
 it('reads the exact ID without forwarding an owner supplied by the caller',async()=>{
  const {storage,fetch}=client(persisted());expect(await storage.getPipeline(ROW.id,'spoofed-owner')).toEqual(persisted());const url=new URL(fetch.mock.calls[1][0]);expect([...url.searchParams]).toEqual([['id',ROW.id]]);
 });
 it('preserves a genuine not-found response',async()=>{const {storage}=client(null);expect(await storage.getPipeline(ROW.id,'owner')).toBeNull();});
 it.each([null,persisted({id:'wrong'}),persisted({project:'wrong'}),persisted({status:'COMPLETED'}),persisted({spec:'{}'}),persisted({updated_at:ROW.updated_at})])('rejects mismatched save response without changing caller state: %j',async pipeline=>{
  const {storage}=client(pipeline);const state={...ROW};await expect(storage.savePipeline(state)).rejects.toThrow(/Invalid Factory/);expect(state).toEqual(ROW);
 });
 it.each([409,503])('propagates conflict/unavailability %s without pretending persistence',async status=>{const {storage}=client(null,status);const state={...ROW};await expect(storage.savePipeline(state)).rejects.toThrow();expect(state).toEqual(ROW);});
 it.each([true,false,'true'])('startup caches only exact verified readiness %s',async ready=>{const a=client(null);a.fetch.mockReset().mockResolvedValueOnce(new Response(JSON.stringify({status:'success',jwt:'fixture-jwt'}))).mockResolvedValueOnce(new Response(JSON.stringify({status:'success',execution_ready:ready})));await a.storage.initialize();expect(a.storage.isFactoryReady()).toBe(ready===true);expect(JSON.parse(a.fetch.mock.calls[1][1].body)).toEqual({action:'capabilities'});await a.storage.close();expect(a.storage.isFactoryReady()).toBe(false);});
 it('keeps paid Factory unavailable when its endpoint or migration probe fails',async()=>{const a=client(null,503);await a.storage.initialize();expect(a.storage.isFactoryReady()).toBe(false);});
 it('rejects a detail response for another pipeline',async()=>{const {storage}=client(persisted({id:'another'}));await expect(storage.getPipeline(ROW.id,'owner')).rejects.toThrow(/Invalid Factory/);});
});
