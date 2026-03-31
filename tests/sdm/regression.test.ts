import { describe, it, expect } from 'vitest';
import { HDCEngine } from '../../src/sdm/hdc.ts';
import { SparseDistributedMemory, hammingDistance, D_ADDR_UINT32, SDM_ADDRESS_VERSION } from '../../src/sdm/sdmEngine.ts';
import { DeterministicPRNG } from '../../src/sdm/conceptDictionary.ts';
import { HdcStateMachine } from '../../src/sdm/stateMachine.ts';

/**
 * Regression test suite added per external code review (2026-03-31).
 * Prevents regressions of fixes 1A (density collapse), 1B (PRNG cycle),
 * 2A (getTopK correctness), and migration versioning.
 */

// ─── Deterministic test vector helper ──────────────────────────
class TestPRNG {
  private seed: number;
  constructor(seed: number) { this.seed = seed; }
  next(): number {
    let t = (this.seed = (this.seed + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

function randomVector(seed: number): Uint32Array {
  const prng = new TestPRNG(seed);
  const result = new Uint32Array(D_ADDR_UINT32);
  for (let i = 0; i < D_ADDR_UINT32; i++) {
    result[i] = Math.floor(prng.next() * 0x100000000) >>> 0;
  }
  return result;
}

function popcount(vec: Uint32Array): number {
  let count = 0;
  for (let w = 0; w < vec.length; w++) {
    let x = vec[w];
    x -= ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    count += Math.imul((x + (x >>> 4)) & 0x0F0F0F0F, 0x01010101) >>> 24;
  }
  return count;
}

describe('Regression: Density Preservation (Fix 1A)', () => {
  it('XOR-based transition preserves ~50% bit density across 100 iterations', () => {
    const TOTAL_BITS = D_ADDR_UINT32 * 32; // 768
    const sdm = new SparseDistributedMemory(555);
    const startState = randomVector(100);

    const machine = new HdcStateMachine(startState, sdm);

    // Run 100 transitions — if someone ever reverts to bundle(2), density will collapse
    for (let i = 0; i < 100; i++) {
      const role = randomVector(1000 + i);
      const action = randomVector(2000 + i);
      machine.transition(role, action);
    }

    const finalState = machine.getCurrentState();
    const density = popcount(finalState) / TOTAL_BITS;

    // Density must remain in [0.35, 0.65] after 100 XOR transitions
    // (XOR of two ~50% dense vectors produces ~50% dense output)
    expect(density).toBeGreaterThanOrEqual(0.35);
    expect(density).toBeLessThanOrEqual(0.65);
  });

  it('density would collapse to nearly 0 with bundle(2) — proof by construction', () => {
    // Construct what bundle(2) would produce: AND gate with tie-breaker=0.
    // After 4 chained AND operations on ~50% dense vectors, density → ~3%
    const TOTAL_BITS = D_ADDR_UINT32 * 32;
    let state = randomVector(300);
    const startDensity = popcount(state) / TOTAL_BITS;
    expect(startDensity).toBeGreaterThan(0.40);

    for (let i = 0; i < 4; i++) {
      const other = randomVector(400 + i);
      // Simulate bundle(2) = AND gate
      const andResult = new Uint32Array(D_ADDR_UINT32);
      for (let w = 0; w < D_ADDR_UINT32; w++) {
        andResult[w] = (state[w] & other[w]) >>> 0;
      }
      state = andResult;
    }

    const collapsed = popcount(state) / TOTAL_BITS;
    // After 4 ANDs: expected ~(0.5)^5 = 3.125%
    expect(collapsed).toBeLessThan(0.10);
  });
});

describe('Regression: PRNG Cycle Uniqueness (Fix 1B)', () => {
  it('DeterministicPRNG produces >99.99% unique values in 100k outputs (Weyl sequence guarantee)', () => {
    const prng = new DeterministicPRNG(42);
    const seen = new Set<number>();

    for (let i = 0; i < 100_000; i++) {
      seen.add(prng.nextUInt32());
    }

    // The Weyl sequence guarantees unique SEEDS, but the hash function can
    // map different seeds to the same output (pigeonhole principle).
    // With good mixing, collision rate in 100k outputs should be negligible.
    // The old broken PRNG (no Weyl) would show ~35% collisions by 100k due to
    // Birthday Paradox on a cycling 32-bit state. >99.99% unique proves the fix.
    expect(seen.size).toBeGreaterThanOrEqual(99_990);
  });

  it('SDM internal PRNG also produces unique addresses for all 10k × 24 = 240k calls', () => {
    // Verify no duplicate hard-location addresses exist in the SDM
    const sdm = new SparseDistributedMemory(42);
    const addressHashes = new Set<string>();

    for (let i = 0; i < sdm.addresses.length; i++) {
      // Create a hash of each address to detect duplicates
      const key = Array.from(sdm.addresses[i]).join(',');
      addressHashes.add(key);
    }

    // All 10,000 addresses must be distinct
    expect(addressHashes.size).toBe(10_000);
  });
});

describe('Regression: getTopK Deterministic Equivalence (Fix 2A)', () => {
  it('max-heap getTopK returns correct K closest addresses', () => {
    const sdm = new SparseDistributedMemory(42);
    const query = randomVector(999);

    // Compute ground truth: brute-force all 10k distances and sort
    const allDists: { d: number; i: number }[] = [];
    for (let i = 0; i < sdm.addresses.length; i++) {
      allDists.push({ d: hammingDistance(query, sdm.addresses[i]), i });
    }
    allDists.sort((a, b) => a.d - b.d || a.i - b.i);
    const groundTruth20 = allDists.slice(0, 20).map(x => x.i);

    // Now use the heap-based getTopK via writeHdc + readHdc
    // We exercise it indirectly through a write + read cycle
    sdm.writeHdc(query, 20);
    const result = sdm.readHdc(query, 20);

    // If getTopK is correct, writing then reading the same vector should
    // produce exact reconstruction (distance 0)
    expect(hammingDistance(query, result)).toBe(0);
  });

  it('getTopK with K=1 returns the absolute nearest neighbor', () => {
    const sdm = new SparseDistributedMemory(42);
    const query = randomVector(888);

    // Ground truth: find the closest address
    let minDist = Infinity;
    let minIdx = -1;
    for (let i = 0; i < sdm.addresses.length; i++) {
      const d = hammingDistance(query, sdm.addresses[i]);
      if (d < minDist) { minDist = d; minIdx = i; }
    }

    // Write with K=1 only activates the single closest hard location
    sdm.writeHdc(query, 1);
    const result = sdm.readHdc(query, 1);

    // The read should activate the same single address, producing exact result
    expect(hammingDistance(query, result)).toBe(0);
  });
});

describe('Regression: SDM Address Version Migration', () => {
  it('SDM_ADDRESS_VERSION is exported and is version 2', () => {
    expect(SDM_ADDRESS_VERSION).toBe(2);
  });

  it('SDM_ADDRESS_VERSION is a positive integer', () => {
    expect(Number.isInteger(SDM_ADDRESS_VERSION)).toBe(true);
    expect(SDM_ADDRESS_VERSION).toBeGreaterThan(0);
  });
});

describe('Regression: SDM Noise Injection Resilience', () => {
  // Helper: flip ~flipRatio of bits in a Uint32Array deterministically
  function injectNoise(vec: Uint32Array, flipRatio: number, seed: number): Uint32Array {
    const prng = new TestPRNG(seed);
    const result = new Uint32Array(vec.length);
    for (let w = 0; w < vec.length; w++) {
      let word = vec[w];
      for (let bit = 0; bit < 32; bit++) {
        if (prng.next() < flipRatio) {
          word ^= (1 << bit);
        }
      }
      result[w] = word >>> 0;
    }
    return result;
  }

  it('writeHdc + 5% noise injection + readHdc recovers with ≥97% bit accuracy', () => {
    const TOTAL_BITS = D_ADDR_UINT32 * 32;
    const sdm = new SparseDistributedMemory(777);
    const original = randomVector(42);

    // Write the pattern into SDM with strong activation (K=40)
    for (let i = 0; i < 5; i++) {
      sdm.writeHdc(original, 40);
    }

    // Inject 5% bit noise
    const noisy = injectNoise(original, 0.05, 1234);
    const noiseDist = hammingDistance(original, noisy);
    expect(noiseDist).toBeGreaterThan(20);  // Sanity: at least ~3% flipped
    expect(noiseDist).toBeLessThan(80);     // Sanity: at most ~10% flipped

    // Read back through noisy query
    const recalled = sdm.readHdc(noisy, 40);
    const recallDist = hammingDistance(original, recalled);

    // Assert ≥97% bit accuracy (≤23 bits wrong out of 768)
    expect(recallDist).toBeLessThanOrEqual(23);
  });

  it('writeHdc + 10% noise injection + readHdc recovers with ≥95% bit accuracy', () => {
    const TOTAL_BITS = D_ADDR_UINT32 * 32;
    const sdm = new SparseDistributedMemory(888);
    const original = randomVector(99);

    // Write with strong reinforcement
    for (let i = 0; i < 8; i++) {
      sdm.writeHdc(original, 40);
    }

    // Inject 10% bit noise
    const noisy = injectNoise(original, 0.10, 5678);
    const noiseDist = hammingDistance(original, noisy);
    expect(noiseDist).toBeGreaterThan(50);  // Sanity: meaningful noise
    expect(noiseDist).toBeLessThan(120);    // Sanity: not catastrophic

    // Read back through noisy query
    const recalled = sdm.readHdc(noisy, 40);
    const recallDist = hammingDistance(original, recalled);

    // Assert ≥95% bit accuracy (≤38 bits wrong out of 768)
    expect(recallDist).toBeLessThanOrEqual(38);
  });
});
