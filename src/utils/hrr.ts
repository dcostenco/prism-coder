/**
 * Holographic Reduced Representations (HRR) Utility
 * ================================================
 *
 * Implements Vector Symbolic Architecture (VSA) operations for Zero-Search Retrieval.
 * Based on Tony Plate's HRR (1995).
 *
 * This utility allows binding structured facts (e.g., Role: Patient) into a single
 * high-dimensional vector (default 1024) and retrieving them via mathematical unbinding,
 * without an external search index.
 *
 * @dimension 1024 (chosen for high capacity)
 */

import { PRISM_HRR_DIMENSION } from "../config.js";

export const HRR_DIMENSION = PRISM_HRR_DIMENSION;

interface Complex {
  re: number;
  im: number;
}

function multiplyComplex(a: Complex, b: Complex): Complex {
  return {
    re: a.re * b.re - a.im * b.im,
    im: a.re * b.im + a.im * b.re
  };
}

/**
 * Simple Iterative FFT Implementation
 */
function fft(input: number[]): Complex[] {
  const n = input.length;
  if (n === 0) return [];
  if (n === 1) return [{ re: input[0], im: 0 }];
  
  // Pad to power of 2 if necessary, but we assume 1024
  if ((n & (n - 1)) !== 0) {
    throw new Error("FFT input length must be a power of 2");
  }

  const output = new Array(n);
  const halfN = n / 2;
  const even = new Array(halfN);
  const odd = new Array(halfN);

  for (let i = 0; i < halfN; i++) {
    even[i] = input[2 * i];
    odd[i] = input[2 * i + 1];
  }

  const evenFFT = fft(even);
  const oddFFT = fft(odd);

  for (let k = 0; k < halfN; k++) {
    const angle = -2 * Math.PI * k / n;
    const twiddle = { re: Math.cos(angle), im: Math.sin(angle) };
    const t = multiplyComplex(twiddle, oddFFT[k]);
    output[k] = { re: evenFFT[k].re + t.re, im: evenFFT[k].im + t.im };
    output[k + halfN] = { re: evenFFT[k].re - t.re, im: evenFFT[k].im - t.im };
  }
  return output;
}

function fftComplex(input: Complex[]): Complex[] {
  const n = input.length;
  if (n === 0) return [];
  if (n === 1) return [input[0]];

  const output = new Array(n);
  const halfN = n / 2;
  const even = new Array(halfN);
  const odd = new Array(halfN);

  for (let i = 0; i < halfN; i++) {
    even[i] = input[2 * i];
    odd[i] = input[2 * i + 1];
  }

  const evenFFT = fftComplex(even);
  const oddFFT = fftComplex(odd);

  for (let k = 0; k < halfN; k++) {
    const angle = -2 * Math.PI * k / n;
    const twiddle = { re: Math.cos(angle), im: Math.sin(angle) };
    const t = multiplyComplex(twiddle, oddFFT[k]);
    output[k] = { re: evenFFT[k].re + t.re, im: evenFFT[k].im + t.im };
    output[k + halfN] = { re: evenFFT[k].re - t.re, im: evenFFT[k].im - t.im };
  }
  return output;
}

/**
 * Inverse FFT
 */
function ifft(input: Complex[]): Complex[] {
  const n = input.length;
  if (n === 0) return [];
  // Conjugate input
  const conj = input.map(c => ({ re: c.re, im: -c.im }));
  // Forward FFT
  const res = fftComplex(conj);
  // Conjugate again and scale
  return res.map(c => ({ re: c.re / n, im: -c.im / n }));
}

/**
 * FFT-based Circular Convolution O(n log n)
 * Uses the Property: FFT(a * b) = FFT(a) .* FFT(b)
 */
export function circularConvolution(a: number[], b: number[]): number[] {
  if (a.length !== b.length || a.length === 0) {
    throw new Error("Vectors must be of same non-zero length");
  }
  const fa = fft(a);
  const fb = fft(b);
  const fc = fa.map((val, i) => multiplyComplex(val, fb[i]));
  return ifft(fc).map(c => c.re);
}

/**
 * Naive Circular Convolution O(n^2) - For benchmark comparison
 */
export function naiveCircularConvolution(a: number[], b: number[]): number[] {
  const n = a.length;
  const result = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      result[(i + j) % n] += a[i] * b[j];
    }
  }
  return result;
}


/**
 * FFT-based Circular Correlation O(n log n)
 * Uses the Property: FFT(a # b) = FFT(a) .* conj(FFT(b))
 */
export function circularCorrelation(c: number[], a: number[]): number[] {
  if (c.length !== a.length || c.length === 0) {
    throw new Error("Vectors must be of same non-zero length");
  }
  const fc = fft(c);
  const fa = fft(a);
  const fr = fc.map((val, i) => multiplyComplex(val, { re: fa[i].re, im: -fa[i].im }));
  return ifft(fr).map(r => r.re);
}

/**
 * Superposition (+)
 * Adds multiple vectors together into a single "hologram" memory trace.
 *
 * @param vectors - Array of vectors to superimpose
 * @returns number[] - Normalized sum vector
 */
export function superimpose(vectors: number[][]): number[] {
  if (vectors.length === 0) return new Array(HRR_DIMENSION).fill(0);
  const n = vectors[0].length;
  const result = new Array(n).fill(0);

  for (const v of vectors) {
    if (v.length !== n) throw new Error("All vectors must have the same dimension");
    for (let i = 0; i < n; i++) {
      result[i] += v[i];
    }
  }

  return normalize(result);
}

/**
 * L2 Normalization
 */
export function normalize(v: number[]): number[] {
  const mag = Math.sqrt(v.reduce((sum, val) => sum + val * val, 0));
  if (mag === 0) return v;
  return v.map((val) => val / mag);
}

/**
 * Cosine Similarity
 * Used for "clean-up memory" (SDM) to find the closest known vector to a noisy result.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Generate a random Gaussian vector (standard for HRR)
 */
export function generateRandomVector(dim: number = HRR_DIMENSION): number[] {
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) {
    // Box-Muller transform for normal distribution
    const u1 = Math.random();
    const u2 = Math.random();
    v[i] = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }
  return normalize(v);
}
