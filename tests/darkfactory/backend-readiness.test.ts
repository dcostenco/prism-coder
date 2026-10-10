import {describe,expect,it,vi} from 'vitest';
const {getStorage}=vi.hoisted(()=>({getStorage:vi.fn()}));
vi.mock('../../src/storage/index.js',()=>({getStorage,activeStorageBackend:'local'}));
import {factoryBackendReadiness} from '../../src/darkfactory/backendReadiness.js';
import {routeFactoryPrompt} from '../../src/darkfactory/promptRouting.js';
const CONTEXT={enabled:true,project:'fixture',working_directory:'/workspace',test_command:'npm test'};
describe('Factory backend startup readiness',()=>{
 it('does not trust the default local label while paid prewarm is pending',async()=>{let finish!:(value:any)=>void;getStorage.mockReturnValueOnce(new Promise(resolve=>finish=resolve));const pending=factoryBackendReadiness();finish({isFactoryReady:()=>false});const state=await pending;expect(state).toEqual({storage_backend:'synalux',factory_ready:false});expect(routeFactoryPrompt('Fix source.ts and run tests.',{...CONTEXT,...state}).recommended_tool).toBeNull();});
 it('allows a resolved ready paid instance',async()=>{getStorage.mockResolvedValueOnce({isFactoryReady:()=>true});expect((await factoryBackendReadiness()).factory_ready).toBe(true);});
 it('reports unavailable initialization instead of selecting an imaginary local backend',async()=>{getStorage.mockRejectedValueOnce(new Error('unavailable'));const state=await factoryBackendReadiness();expect(state).toEqual({storage_backend:'unavailable',factory_ready:false});expect(routeFactoryPrompt('Fix source.ts and run tests.',{...CONTEXT,...state}).recommended_tool).toBeNull();});
});
