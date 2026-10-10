import {getStorage,activeStorageBackend} from '../storage/index.js';
/** Resolve the instance before reading its capability: prewarm may still be pending. */
export async function factoryBackendReadiness(): Promise<{storage_backend:string;factory_ready:boolean}> {
 try {
  const storage=await getStorage() as {isFactoryReady?:()=>boolean};
  const paid=typeof storage.isFactoryReady==='function';
  return {storage_backend:paid?'synalux':activeStorageBackend,factory_ready:paid?storage.isFactoryReady!():true};
 } catch { return {storage_backend:'unavailable',factory_ready:false}; }
}
