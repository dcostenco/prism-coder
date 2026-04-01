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

// ═══════════════════════════════════════════════════════════════════
// EDGE CASES: Error guards & boundary conditions
// ═══════════════════════════════════════════════════════════════════

describe('HDC Engine — Edge Cases & Error Guards', () => {

  // ── BIND error guard ──────────────────────────────────────────
  it('bind() throws on mismatched vector lengths', () => {
    /**
     * WHY: hdc.ts line 7-9 guards against length mismatch.
     * XOR over different-length arrays would silently produce
     * truncated garbage. This test locks the guard.
     */
    const short = new Uint32Array([0xDEADBEEF]);
    const long  = new Uint32Array([0xDEADBEEF, 0xCAFEBABE]);

    expect(() => HDCEngine.bind(short, long)).toThrow(/lengths must match/i);
    expect(() => HDCEngine.bind(long, short)).toThrow(/lengths must match/i);
  });

  // ── BUNDLE error guard ────────────────────────────────────────
  it('bundle() throws on empty vector array', () => {
    /**
     * WHY: hdc.ts line 32 guards vectors.length === 0.
     * Bundling zero concepts is mathematically undefined.
     */
    expect(() => HDCEngine.bundle([])).toThrow(/at least one vector/i);
  });

  // ── BUNDLE identity: single vector ────────────────────────────
  it('bundle() with a single vector returns an identical copy', () => {
    /**
     * WHY: Majority vote of 1 vector = that vector itself.
     * This is the identity property of the bundle operation.
     * If broken, single-concept encoding would silently corrupt.
     */
    const original = new Uint32Array([0xABCD1234, 0x56789ABC]);
    const bundled  = HDCEngine.bundle([original]);

    expect(bundled).toEqual(original);
    // Must be a new allocation, not the same reference
    expect(bundled).not.toBe(original);
  });

  // ── BIND identity: zero vector ────────────────────────────────
  it('bind() with zero vectors produces zero (XOR identity)', () => {
    /**
     * WHY: XOR(0, 0) = 0 for every bit position.
     * This confirms the algebraic identity of the bind operation.
     */
    const zero = new Uint32Array([0, 0, 0]);
    const result = HDCEngine.bind(zero, zero);
    expect(result).toEqual(new Uint32Array([0, 0, 0]));
  });

  // ── BIND self-inverse ─────────────────────────────────────────
  it('bind(A, A) produces zero vector (XOR self-inverse)', () => {
    /**
     * WHY: In binary HDC, binding a concept with itself produces
     * the identity element (all zeros). This is a critical algebraic
     * property: A ⊕ A = 0. If broken, unbinding logic would fail.
     */
    const vecA = new Uint32Array([0xDEADBEEF, 0xCAFEBABE]);
    const result = HDCEngine.bind(vecA, vecA);
    expect(result).toEqual(new Uint32Array([0, 0]));
  });

  // ── PERMUTE empty array ───────────────────────────────────────
  it('permute() on empty array returns empty array', () => {
    /**
     * WHY: hdc.ts line 67 short-circuits for vec.length === 0.
     * This degenerate case must not crash or produce undefined.
     */
    const empty = new Uint32Array(0);
    const result = HDCEngine.permute(empty);
    expect(result.length).toBe(0);
  });

  // ── PERMUTE single word: LSB propagation ──────────────────────
  it('permute() single word: LSB=1 shifts to bit 1, MSB wraps to LSB', () => {
    /**
     * WHY: With a single Uint32, the MSB wraps to the LSB of the
     * *same* word. This tests the wrap-around within a single element.
     */
    const vec = new Uint32Array([0b1]); // only LSB set
    const p = HDCEngine.permute(vec);
    // LSB shifts left to bit 1
    expect(p[0]).toBe(0b10 >>> 0);

    // Now test MSB wraparound
    const vec2 = new Uint32Array([0x80000000 >>> 0]); // only MSB set
    const p2 = HDCEngine.permute(vec2);
    // MSB wraps to LSB (circular shift left by 1 on single word)
    expect(p2[0]).toBe(1 >>> 0);
  });

  // ── PERMUTE is not identity ───────────────────────────────────
  it('permute() produces a different vector (non-identity shift)', () => {
    /**
     * WHY: Permutation encodes sequence order in HDC.
     * If it were ever a no-op, A→B and B→A would be indistinguishable.
     * This uses a mixed-bit pattern that must change under left shift.
     */
    const vec = new Uint32Array([0xA5A5A5A5 >>> 0, 0x5A5A5A5A >>> 0]);
    const permuted = HDCEngine.permute(vec);
    // At least one word must differ from the original
    const differs = permuted[0] !== vec[0] || permuted[1] !== vec[1];
    expect(differs).toBe(true);
  });

  // ── BUNDLE preserves bit density for 5-vector majority ────────
  it('bundle() of 5 random-ish vectors preserves ~50% density', () => {
    /**
     * WHY: The majority-vote bundle on balanced inputs must
     * produce output with ~50% 1-density. Density collapse
     * (towards 0 or 100%) would destroy the information capacity.
     */
    const vectors = [
      new Uint32Array([0xAAAAAAAA >>> 0]),
      new Uint32Array([0x55555555 >>> 0]),
      new Uint32Array([0xF0F0F0F0 >>> 0]),
      new Uint32Array([0x0F0F0F0F >>> 0]),
      new Uint32Array([0xFF00FF00 >>> 0]),
    ];
    const bundled = HDCEngine.bundle(vectors);

    // Count bits set
    let x = bundled[0];
    x -= ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    const ones = Math.imul((x + (x >>> 4)) & 0x0F0F0F0F, 0x01010101) >>> 24;

    // 32-bit word: expect roughly 16 ± 8 bits set (50% ± 25%)
    expect(ones).toBeGreaterThanOrEqual(8);
    expect(ones).toBeLessThanOrEqual(24);
  });
});
