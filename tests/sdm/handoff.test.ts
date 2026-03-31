import { describe, it, expect } from 'vitest';
import { HDCEngine } from '../../src/sdm/hdc.ts';
import { SparseDistributedMemory, hammingDistance } from '../../src/sdm/sdmEngine.ts';

// Deterministic PRNG for tests to avoid stochastic flakiness in CI over time
class TestPRNG {
  private seed: number;
  constructor(seed: number) { this.seed = seed; }
  next(): number {
    let t = this.seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

const prng = new TestPRNG(12345);

// Helper to generate a deterministic pseudo-random 768-bit vector
function randomVector(): Uint32Array {
  const result = new Uint32Array(24);
  for (let i = 0; i < 24; i++) {
     result[i] = Math.floor(prng.next() * 0x100000000) >>> 0;
  }
  return result;
}

// Helper to randomly corrupt bits based on a probability ratio deterministically
function fuzzVector(vec: Uint32Array, flipRatio: number): Uint32Array {
  const result = new Uint32Array(vec.length);
  for (let w = 0; w < vec.length; w++) {
    let word = vec[w];
    for (let bitIdx = 0; bitIdx < 32; bitIdx++) {
      if (prng.next() < flipRatio) {
         word ^= (1 << bitIdx); // flip the bit
      }
    }
    result[w] = word >>> 0;
  }
  return result;
}

describe('SDM-HDC Neuro-Symbolic Handoff Lifecycle', () => {

  it('should store and read back an uncorrupted HDC composition exactly', () => {
    const sdm = new SparseDistributedMemory(101); // deterministic seed
    const roleA = randomVector();
    const actionB = randomVector();
    
    // HDC Logic: Bind them into a cognitive state
    const state = HDCEngine.bind(roleA, actionB);

    // SDM Storage: Write the binary vector natively
    sdm.writeHdc(state, 20); // K=20 activation radius
    
    // SDM Retrieval
    const retrieved = sdm.readHdc(state, 20);
    
    // Assuming identical queries with K=20 against a blank matrix 
    // it should perfectly threshold back to the original bit signs.
    const dist = hammingDistance(state, retrieved);
    expect(dist).toBe(0);
  });

  it('should enforce hard clipping on long-term counters to preserve associative plasticity', () => {
    const sdm = new SparseDistributedMemory(202);
    const target = randomVector();

    // Repeated identical writes to simulate massive reinforcement
    for (let i = 0; i < 100; i++) {
        sdm.writeHdc(target, 20);
    }
    
    // Validate bounds clip across all 10,000 HDC locations
    let exceedsBounds = false;
    for (let i = 0; i < sdm.counters.length; i++) {
        for (let j = 0; j < sdm.counters[i].length; j++) {
            const val = sdm.counters[i][j];
            if (val > 20 || val < -20) {
                exceedsBounds = true;
                break;
            }
        }
    }
    
    expect(exceedsBounds).toBe(false);
  });

  it('should clean up fuzzy thoughts securely and within low latency bounds', () => {
    const sdm = new SparseDistributedMemory(303);
    const numMemoriesToStore = 10;
    const memories: Uint32Array[] = [];

    // Load noise / alternative thoughts into the brain
    for (let i = 0; i < numMemoriesToStore; i++) {
        const mem = randomVector();
        memories.push(mem);
        sdm.writeHdc(mem, 100);
    }

    // Pick a memory to fuzz
    const targetState = memories[0];
    
    // Run the fuzzy trial 10 times to get statistical averages
    let totalBits = 0;
    let correctBits = 0;

    const t0 = performance.now();
    for (let trial = 0; trial < 10; trial++) {
      // Intentionally introduce ~15% noise (flip 15% of the 768 bits)
      const corruptedState = fuzzVector(targetState, 0.15);
      
      // Perform noisy retrieval via Euclidean lookup natively via HDC routes
      const recoveredState = sdm.readHdc(corruptedState, 100);
      
      const dist = hammingDistance(targetState, recoveredState);
      const accurateBits = 768 - dist;
      
      totalBits += 768;
      correctBits += accurateBits;
    }
    const t1 = performance.now();

    const accuracyRate = correctBits / totalBits;
    const avgLatencyMs = (t1 - t0) / 10;
    
    // Log secondary metrics for visibility
    console.log(`Fuzz Cleanup Accuracy: ${(accuracyRate * 100).toFixed(2)}%`);
    console.log(`Avg HDC Engine Handover Latency: ${avgLatencyMs.toFixed(2)}ms`);
    
    // Primary invariant: Accuracy > 99.0%
    expect(accuracyRate).toBeGreaterThanOrEqual(0.990);
    
    // Primary invariant: Latency < 100ms
    expect(avgLatencyMs).toBeLessThan(100);
  });
});
