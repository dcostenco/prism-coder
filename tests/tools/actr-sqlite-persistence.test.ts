import { afterAll,describe,expect,it,vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../../src/storage/sqlite.js';
const { holder,queryVector }=vi.hoisted(()=>({holder:{storage:null as any},queryVector:Array.from({length:768},(_,i)=>i===0?1:0)}));
vi.mock('../../src/storage/index.js',()=>({getStorage:async()=>holder.storage}));
vi.mock('../../src/server.js',()=>({notifyResourceUpdate:vi.fn()}));
vi.mock('../../src/utils/llm/factory.js',()=>({getEmbeddingProvider:()=>({generateEmbedding:async()=>queryVector}),getLLMProvider:vi.fn()}));
const directory=mkdtempSync(join(tmpdir(),'prism-actr-persistence-'));
const storage=new SqliteStorage();holder.storage=storage;
afterAll(async()=>{await storage.close();});
describe('automatic ACT-R with actual durable SQLite memory',()=>{
  it('uses persisted repeated accesses to reorder memories without changing their zero importance',async()=>{
    await storage.initialize(true,join(directory,'memory.db'));
    const {PRISM_USER_ID}=await import('../../src/config.js');
    const saved=[];
    for(const [summary,similarity] of [['Cold persisted candidate',0.91],['Warm persisted candidate',0.90]] as const){
      const rows:any=await storage.saveLedger({project:'actr-persistence-fixture',conversation_id:'fixture',user_id:PRISM_USER_ID,summary,importance:0});
      const embedding=Array.from({length:queryVector.length},(_,i)=>i===0?similarity:i===1?Math.sqrt(1-similarity*similarity):0);
      const id=rows[0].id;await storage.patchLedger(id,{embedding:JSON.stringify(embedding)});saved.push(id);
    }
    await (storage as any).accessLogBuffer.flush();
    for(let count=0;count<5;count++){storage.logAccess(saved[1],'abcd');await (storage as any).accessLogBuffer.flush();}
    const logs=await storage.getAccessLog(saved);expect(logs.get(saved[1])!.length).toBeGreaterThan(logs.get(saved[0])!.length);
    const result=await (await import('../../src/tools/graphHandlers.js')).sessionSearchMemoryHandler({query:'persistent memory fixture',project:'actr-persistence-fixture',limit:1,similarity_threshold:0.5});
    expect(result.isError).toBe(false);expect(result.content[0].text).toContain('Warm persisted candidate');
    const rows=await storage.getLedgerEntries({ids:saved,user_id:'eq.'+PRISM_USER_ID,select:'id,importance'});
    expect(rows.map(row=>row.importance)).toEqual([0,0]);
  },15000);
});
