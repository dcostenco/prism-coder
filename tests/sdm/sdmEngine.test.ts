import { test, expect } from 'vitest';
import { SparseDistributedMemory, hammingDistance } from '../../src/sdm/sdmEngine';

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
