import {beforeEach,describe,expect,it,vi} from 'vitest';

const state=vi.hoisted(()=>({events:[] as string[],save:vi.fn(),authorize:vi.fn(),wake:vi.fn()}));
vi.mock('../../src/storage/index.js',()=>({getStorage:async()=>({factoryPollScope:'account-scope',savePipeline:state.save})}));
vi.mock('../../src/storage/configStorage.js',()=>({getSettingSync:()=>'',wakeFactoryPolling:state.wake}));
vi.mock('../../src/darkfactory/executionAuthority.js',()=>({registerPipelineAuthority:state.authorize}));
import {sessionStartPipelineHandler} from '../../src/tools/pipelineHandlers.js';

beforeEach(()=>{
 state.events=[];
 state.save.mockReset().mockImplementation(async p=>{state.events.push(`save:${p.status}`);});
 state.authorize.mockReset().mockImplementation(async()=>{state.events.push('authorize');});
 state.wake.mockReset().mockImplementation(async()=>{state.events.push('wake');});
});
describe('explicit Factory submission wakes idle discovery',()=>{
 it('reports an already-authorized submission as queued if its wake fails, preventing duplicate retries',async()=>{
  state.wake.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
  const error=vi.spyOn(console,'error').mockImplementation(()=>{});
  try {
   const result=await sessionStartPipelineHandler({project:'fixture',objective:'Preserve a queued submission',working_directory:process.cwd()});
   expect(result.isError).not.toBe(true);
   expect(result.content[0].text).toContain('do not resubmit');
   expect(state.events).toEqual(['save:PENDING','authorize']);
   expect(error).toHaveBeenCalledWith(expect.stringContaining('wake failed'));
  } finally {error.mockRestore();}
 });
 it('wakes only after persistence and local execution authorization succeed',async()=>{
  const result=await sessionStartPipelineHandler({project:'fixture',objective:'Test authorized queue pickup',working_directory:process.cwd()});
  expect(result.isError).not.toBe(true);
  expect(state.events).toEqual(['save:PENDING','authorize','wake']);
  expect(state.wake).toHaveBeenCalledWith('account-scope');
 });
 it('never wakes execution after local authorization fails',async()=>{
  state.authorize.mockRejectedValueOnce(new Error('receipt unavailable'));
  const result=await sessionStartPipelineHandler({project:'fixture',objective:'Test authorization boundary',working_directory:process.cwd()});
  expect(result.isError).toBe(true);
  expect(state.events).toEqual(['save:PENDING','save:ABORTED']);
  expect(state.wake).not.toHaveBeenCalled();
 });
});
