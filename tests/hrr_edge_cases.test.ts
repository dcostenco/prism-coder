import { describe, it, expect } from 'vitest';
import {
  circularConvolution,
  circularCorrelation,
  superimpose,
  generateRandomVector,
  cosineSimilarity,
} from '../src/utils/hrr';

describe('HRR Edge Case Testing', () => {
  it('should throw on non-power-of-2 dimensions (FFT constraint)', () => {
    const v1 = new Array(100).fill(0.1);
    const v2 = new Array(100).fill(0.2);
    expect(() => circularConvolution(v1, v2)).toThrow("FFT input length must be a power of 2");
  });

  it('should handle zero vectors gracefully', () => {
    const zero = new Array(1024).fill(0);
    const rand = generateRandomVector(1024);
    const result = circularConvolution(zero, rand);
    expect(result.every(val => val === 0)).toBe(true);
  });

  it('should handle superposition of an empty list', () => {
    const result = superimpose([]);
    expect(result.length).toBe(1024);
    expect(result.every(val => val === 0)).toBe(true);
  });

  it('should return 0 similarity for orthogonal random vectors', () => {
    const v1 = generateRandomVector(1024);
    const v2 = generateRandomVector(1024);
    const sim = cosineSimilarity(v1, v2);
    // In 1024 dims, two random vectors are roughly orthogonal
    expect(Math.abs(sim)).toBeLessThan(0.15);
  });

  it('should maintain perfect similarity for identical vectors', () => {
    const v1 = generateRandomVector(1024);
    expect(cosineSimilarity(v1, v1)).toBeCloseTo(1.0, 5);
  });

  it('should throw when superimposing mismatched dimensions', () => {
    const v1 = new Array(1024).fill(0.1);
    const v2 = new Array(512).fill(0.1);
    expect(() => superimpose([v1, v2])).toThrow("All vectors must have the same dimension");
  });
});
