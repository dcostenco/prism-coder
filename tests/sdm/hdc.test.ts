import { describe, it, expect } from 'vitest';
import { HDCEngine } from '../../src/sdm/hdc.ts';

describe('Hyperdimensional Computing (HDC) Engine', () => {
  it('should successfully BIND and UNBIND via XOR rounding', () => {
    const vecA = new Uint32Array([0b1100, 0xFF00FF00]);
    const vecB = new Uint32Array([0b1010, 0x00FF00FF]);
    
    const bound = HDCEngine.bind(vecA, vecB);
    
    // Check bind bitwise correctness
    expect(bound[0]).toBe((0b1100 ^ 0b1010) >>> 0); // 0b0110
    expect(bound[1]).toBe((0xFF00FF00 ^ 0x00FF00FF) >>> 0); // 0xFFFFFFFF
    
    // Unbind B to retrieve A
    const retrievedA = HDCEngine.unbind(bound, vecB);
    expect(retrievedA).toEqual(vecA);
    
    // Unbind A to retrieve B
    const retrievedB = HDCEngine.unbind(bound, vecA);
    expect(retrievedB).toEqual(vecB);
  });

  it('should properly BUNDLE (Majority Vote) with odd arrays', () => {
    const vecA = new Uint32Array([0b1110]);
    const vecB = new Uint32Array([0b1101]);
    const vecC = new Uint32Array([0b1011]);
    
    // Position 0: 0, 1, 1 -> majority 1
    // Position 1: 1, 0, 1 -> majority 1
    // Position 2: 1, 1, 0 -> majority 1
    // Position 3: 1, 1, 1 -> majority 1
    const bundled = HDCEngine.bundle([vecA, vecB, vecC]);
    expect(bundled[0]).toBe(0b1111 >>> 0);
  });

  it('should deterministically handle BUNDLE tie-breakers for even arrays (inherits from vectors[0])', () => {
    const vecA = new Uint32Array([0b1010]);
    const vecB = new Uint32Array([0b1100]);
    
    // Pos 0: 0, 0 => 0
    // Pos 1: 1, 0 => tie → vectors[0] bit 1 = 1, so 1
    // Pos 2: 0, 1 => tie → vectors[0] bit 2 = 0, so 0
    // Pos 3: 1, 1 => 1
    // Expected result: 0b1010
    const bundled = HDCEngine.bundle([vecA, vecB]);
    expect(bundled[0]).toBe(0b1010 >>> 0);
  });

  it('should correctly PERMUTE (circular left shift) bit sequences across Uint32 indices', () => {
    // We will shift the array left by 1.
    // MSB of vec[0] will map to LSB of vec[1].
    // 0x80000000 has ONLY the MSB set.
    const vec = new Uint32Array([
      0x80000000 >>> 0, // MSB is 1, all else 0
      0x80000000 >>> 0  // MSB is 1, all else 0
    ]);
    
    const permuted = HDCEngine.permute(vec);
    
    // Explanation:
    // vec[0] << 1 gives 0. However, vec[1]'s MSB rolls into vec[0]'s LSB:
    expect(permuted[0]).toBe(1 >>> 0);
    
    // vec[1] << 1 gives 0. The old vec[0]'s MSB rolls over into vec[1]'s LSB.
    expect(permuted[1]).toBe(1 >>> 0);
  });
  
  it('should correctly PERMUTE a continuous bit boundary', () => {
    const vec = new Uint32Array([0xFFFFFFFF >>> 0]);
    const permuted = HDCEngine.permute(vec);
    
    // Shifting 32 1s left by 1 gives 31 1s and the MSB rolls to the back.
    // Output remains all 1s.
    expect(permuted[0]).toBe(0xFFFFFFFF >>> 0);
  });
});
