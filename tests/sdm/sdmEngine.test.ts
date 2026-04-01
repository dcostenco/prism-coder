import { test, expect, describe, it } from 'vitest';
import { SparseDistributedMemory, hammingDistance, D_ADDR_UINT32 } from '../../src/sdm/sdmEngine';

test('Hamming distance popcount logic', () => {
  const a = new Uint32Array([0b11110000_10101010_11001100_00110011]);
  const b = new Uint32Array([0b00001111_10101010_11001100_00110011]);
  // Top 8 bits differ, next 24 bits are identical
  expect(hammingDistance(a, b)).toBe(8);
  
  const c = new Uint32Array([0xFFFFFFFF, 0x00000000]);
  const d = new Uint32Array([0x00000000, 0xFFFFFFFF]);
  // 32 + 32 bits differ
  expect(hammingDistance(c, d)).toBe(64);
});

test('SDM Engine writes and denoises simple vector', () => {
  const sdm = new SparseDistributedMemory(42);
  
  // Create a completely random normalized 768-D float vector
  const original = new Float32Array(768);
  let len = 0;
  for (let i = 0; i < 768; i++) {
    original[i] = Math.random() - 0.5;
    len += original[i] * original[i];
  }
  len = Math.sqrt(len);
  for (let i = 0; i < 768; i++) {
    original[i] /= len;
  }
  
  // Write to SDM
  sdm.write(original);
  
  // Read using pure logic
  // The recall should have positive cosine similarity to the original
  const recall = sdm.read(original);
  
  let dot = 0;
  for (let i = 0; i < 768; i++) {
    dot += original[i] * recall[i];
  }
  
  // Since it's the only vector in memory, it should be > 0.95
  expect(dot).toBeGreaterThan(0.9);
});

// ═══════════════════════════════════════════════════════════════════
// EDGE CASES: hammingDistance boundaries, mode guards, dimension guards
// ═══════════════════════════════════════════════════════════════════

describe('SDM Engine — Edge Cases & Error Guards', () => {

  // ── hammingDistance: identical vectors ─────────────────────────
  it('hammingDistance of identical vectors is 0', () => {
    /**
     * WHY: XOR of identical words = 0, so popcount = 0.
     * This is the identity property of Hamming distance.
     */
    const v = new Uint32Array([0xDEADBEEF, 0xCAFEBABE, 0x12345678]);
    expect(hammingDistance(v, v)).toBe(0);
  });

  // ── hammingDistance: zero vectors ──────────────────────────────
  it('hammingDistance of two zero vectors is 0', () => {
    const z = new Uint32Array(D_ADDR_UINT32); // all zeros
    expect(hammingDistance(z, z)).toBe(0);
  });

  // ── hammingDistance: complementary vectors ─────────────────────
  it('hammingDistance of complementary vectors equals total bit count', () => {
    /**
     * WHY: If every bit differs, XOR = all 1s, popcount = width * 32.
     * For 3 words: 96 bits total.
     */
    const a = new Uint32Array([0x00000000, 0x00000000, 0x00000000]);
    const b = new Uint32Array([0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF]);
    expect(hammingDistance(a, b)).toBe(96);
  });

  // ── Mode cross-talk: hdc → semantic ───────────────────────────
  it('mode cross-talk: HDC-first then semantic call throws', () => {
    /**
     * WHY: sdmEngine.ts line 268-273 locks the mode on first use.
     * Once locked to 'hdc', semantic operations must be rejected.
     * The existing test covers semantic→hdc; this covers hdc→semantic.
     */
    const sdm = new SparseDistributedMemory(999);
    const hdcVec = new Uint32Array(D_ADDR_UINT32);
    sdm.writeHdc(hdcVec); // locks to 'hdc'

    const floatVec = new Float32Array(768);
    expect(() => sdm.write(floatVec)).toThrow(/cross-talk violation/i);
    expect(() => sdm.read(floatVec)).toThrow(/cross-talk violation/i);
  });

  // ── writeHdc dimension guard ──────────────────────────────────
  it('writeHdc rejects wrong-sized vectors', () => {
    /**
     * WHY: sdmEngine.ts line 131 guards hdcVector.length !== D_ADDR_UINT32.
     * A wrong-size write would misalign counter updates and corrupt memory.
     */
    const sdm = new SparseDistributedMemory(111);
    const wrongSize = new Uint32Array(5);
    expect(() => sdm.writeHdc(wrongSize)).toThrow(/Invalid vector length/i);
  });

  // ── readHdc dimension guard ───────────────────────────────────
  it('readHdc rejects wrong-sized query vectors', () => {
    const sdm = new SparseDistributedMemory(222);
    const validVec = new Uint32Array(D_ADDR_UINT32);
    sdm.writeHdc(validVec); // lock mode to hdc

    const wrongQuery = new Uint32Array(1);
    expect(() => sdm.readHdc(wrongQuery)).toThrow(/Invalid query vector length/i);
  });

  // ── getTopK boundary: k=0 ─────────────────────────────────────
  it('getTopK with k=0 throws (minimum boundary)', () => {
    /**
     * WHY: sdmEngine.ts line 191 enforces 1 <= k <= SDM_M.
     * k=0 is meaningless (zero activated locations = no memory access).
     */
    const sdm = new SparseDistributedMemory(333);
    const vec = new Uint32Array(D_ADDR_UINT32);
    expect(() => sdm.writeHdc(vec, 0)).toThrow(/Invalid K radius boundary/i);
  });

  // ── importState size guard ────────────────────────────────────
  it('importState rejects wrong-sized Float32Array', () => {
    /**
     * WHY: sdmEngine.ts line 293 guards state.length !== M * d.
     * A wrong-size import would misalign counter rows and corrupt
     * every subsequent read/write.
     */
    const sdm = new SparseDistributedMemory(444);
    const wrongSize = new Float32Array(100);
    expect(() => sdm.importState(wrongSize)).toThrow(/Invalid SDM state size/i);
  });

  // ── exportState roundtrip ─────────────────────────────────────
  it('exportState → importState preserves counter values', () => {
    /**
     * WHY: Ensures the serialization/deserialization cycle is lossless.
     * A broken roundtrip would silently lose all learned associations
     * when persisting SDM state to disk.
     */
    const sdm1 = new SparseDistributedMemory(555);
    const pattern = new Uint32Array(D_ADDR_UINT32);
    pattern[0] = 0xDEADBEEF;
    sdm1.writeHdc(pattern, 20);

    const exported = sdm1.exportState();

    const sdm2 = new SparseDistributedMemory(555); // same seed = same addresses
    sdm2.importState(exported);

    // Reading should produce the same result from both instances
    const recall1 = sdm1.readHdc(pattern, 20);
    const recall2 = sdm2.readHdc(pattern, 20);
    expect(hammingDistance(recall1, recall2)).toBe(0);
  });
});

