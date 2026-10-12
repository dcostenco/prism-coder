import { describe,expect,it } from 'vitest';
import { circularConvolution,circularCorrelation,cosineSimilarity,normalize } from '../../src/utils/hrr.js';
import { baseLevelActivation,compositeRetrievalScore } from '../../src/utils/actrActivation.js';
describe('HRR and ACT-R compatibility',()=>{
  it('keeps HRR associations unchanged while ACT-R independently ranks by retrieval history',()=>{
    const dimension=64;
    const role=Array.from({length:dimension},(_,i)=>i===0?1:0);
    const fact=normalize(Array.from({length:dimension},(_,i)=>Math.sin(i+1)));
    const bound=circularConvolution(role,fact);
    const recalled=circularCorrelation(bound,role);
    const before=[...recalled];
    const relevance=cosineSimilarity(fact,recalled);
    expect(relevance).toBeCloseTo(1,8);
    const now=new Date('2026-10-12T12:00:00Z');
    const cold=baseLevelActivation([new Date('2025-01-01')],now);
    const warm=baseLevelActivation(Array(5).fill(new Date(now.getTime()-1000)),now);
    expect(compositeRetrievalScore(relevance-0.01,warm)).toBeGreaterThan(compositeRetrievalScore(relevance,cold));
    expect(recalled).toEqual(before);expect(cosineSimilarity(fact,circularCorrelation(bound,role))).toBeCloseTo(relevance,8);
  });
});
