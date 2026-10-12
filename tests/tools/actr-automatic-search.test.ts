import { beforeEach, describe, expect, it, vi } from "vitest";
const { storage, capture, enabled, hdc } = vi.hoisted(() => ({ storage: {
  searchMemory: vi.fn(), getAccessLog: vi.fn(), getLinksFrom: vi.fn(),
  getLedgerEntries:vi.fn(),reinforceLink:vi.fn(),
}, capture:vi.fn(), enabled:{value:true}, hdc:{value:false} }));
vi.mock("../../src/storage/index.js",()=>({ getStorage:async()=>storage }));
vi.mock("../../src/utils/llm/factory.js",()=>({ getLLMProvider:()=>({generateEmbedding:async()=>[0.1,0.2]}), getEmbeddingProvider:()=>({generateEmbedding:async()=>[0.1,0.2]}) }));
vi.mock("../../src/server.js",()=>({notifyResourceUpdate:vi.fn()}));
vi.mock("../../src/utils/actrEnablement.js",()=>({isActrEnabled:()=>enabled.value}));
vi.mock("../../src/config.js",async importOriginal=>({ ...await importOriginal<object>(), get PRISM_HDC_ENABLED(){return hdc.value;} }));
vi.mock("../../src/utils/cognitiveMemory.js",()=>({ computeEffectiveImportance:()=>0,recordMemoryAccess:capture }));
const IDS = { cold:"aabbccdd-0000-0000-0000-000000000001",warm:"aabbccdd-0000-0000-0000-000000000002" };
const QUERY = "memory ranking fixture";
const rows = () => [
  { id:IDS.cold,summary:"Cold candidate",similarity:0.91,importance:0,created_at:"2024-01-01" },
  { id:IDS.warm,summary:"Frequently recalled candidate",similarity:0.90,importance:0,created_at:"2024-01-01" },
];
describe("ACT-R runs automatically on the real search handler",()=>{
  beforeEach(()=>{
    vi.clearAllMocks(); enabled.value=true; hdc.value=false; storage.searchMemory.mockResolvedValue(rows()); storage.getLinksFrom.mockResolvedValue([]);
    storage.getAccessLog.mockResolvedValue(new Map([[IDS.warm,Array.from({length:5},()=>new Date(Date.now()-1000))]]));
  });
  const search = async (extra = {}) => (await import("../../src/tools/graphHandlers.js")).sessionSearchMemoryHandler({ query:QUERY,limit:1,similarity_threshold:0.5,enable_trace:true,...extra });
  it("reorders zero-importance memory by actual frequency without any upvote and logs only delivered IDs",async()=>{
    const result=await search(); expect(result.isError).toBe(false);
    expect(result.content[0].text.indexOf("Frequently recalled")).toBeGreaterThanOrEqual(0); expect(result.content[0].text).not.toContain("Cold candidate");
    expect(capture).toHaveBeenCalledWith([IDS.warm],expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(result.content.find(block=>block.text.startsWith('=== MEMORY TRACE'))?.text).toContain('"actr_enabled": true');
  });
  it("explicit disable preserves original retrieval ordering and does not fetch history",async()=>{
    enabled.value=false; const result=await search(); expect(result.content[0].text).toContain("Cold candidate"); expect(storage.getAccessLog).not.toHaveBeenCalled();
  });
  it("unavailable history degrades honestly instead of treating missing composite as relevance zero",async()=>{
    storage.getAccessLog.mockRejectedValue(new Error("history unavailable")); const result=await search();
    expect(result.content[0].text).toContain("Cold candidate"); expect(result.content.find(block=>block.text.startsWith('=== MEMORY TRACE'))?.text).toContain('"actr_enabled": false');
  });
  it("HDC checks the semantic gap rather than an inverted ACT-R order",async()=>{
    hdc.value=true; storage.searchMemory.mockResolvedValue(rows().map((row,i)=>({...row,similarity:i===0?0.99:0.86})));
    const result=await search({limit:2}); expect(result.content[0].text).toContain('Frequently recalled'); expect(result.content[0].text).not.toContain('Uncertainty Rejection');
  });
  it("records graph-connected memories that are actually returned",async()=>{
    const connected='aabbccdd-0000-0000-0000-000000000003';
    storage.getLinksFrom.mockResolvedValue([{target_id:connected,strength:0.8,link_type:'related_to'}]);
    storage.getLedgerEntries.mockResolvedValue([{id:connected,summary:'Graph-connected fixture'}]);storage.reinforceLink.mockResolvedValue(undefined);
    const result=await search(); expect(result.content[0].text).toContain('Graph-connected fixture');
    expect(capture).toHaveBeenCalledWith([connected],expect.stringMatching(/^[a-f0-9]{64}$/));
  });
});
