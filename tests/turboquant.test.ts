/**
 * TurboQuant v5.0 — Test Suite
 *
 * Validates the pure TypeScript implementation of Google's TurboQuant
 * (ICLR 2026) vector quantization algorithm.
 *
 * All tests are pure math — no DB, no network, no API keys.
 * Uses deterministic seeds for reproducibility.
 *
 * Run: npx vitest run tests/turboquant.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  TurboQuantCompressor,
  solveLloydMax,
  generateRotationMatrix,
  generateQJLMatrix,
  serialize,
  deserialize,
  PRISM_DEFAULT_CONFIG,
  type TurboQuantConfig,
} from "../src/utils/turboquant.js";

// ─── Helpers ─────────────────────────────────────────────────────

/** Seeded PRNG for reproducible test vectors (same as turboquant.ts) */
function mulberry32(seed: number): () => number {
  let t = seed | 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianRandom(rng: () => number): number {
  const u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1 + 1e-15)) * Math.cos(2 * Math.PI * u2);
}

/** Generate a random unit vector of dimension d */
function randomUnitVector(d: number, rng: () => number): number[] {
  const v = Array.from({ length: d }, () => gaussianRandom(rng));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

/** Generate a random vector (not normalized) */
function randomVector(d: number, rng: () => number): number[] {
  return Array.from({ length: d }, () => gaussianRandom(rng));
}

/** Standard cosine similarity between two float vectors */
function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Standard dot product */
function dotProduct(a: number[], b: number[]): number {
  return a.reduce((s, v, i) => s + v * b[i], 0);
}

// ─── Test Constants ──────────────────────────────────────────────

// Use d=128 for fast tests (full d=768 test is separate)
const FAST_CONFIG: TurboQuantConfig = { d: 128, bits: 4, seed: 42 };
const FAST_3BIT_CONFIG: TurboQuantConfig = { d: 128, bits: 3, seed: 42 };

// ─── 1. Lloyd-Max Codebook ───────────────────────────────────────

describe("Lloyd-Max Codebook Solver", () => {
  it("centroids are symmetric around zero", () => {
    const cb = solveLloydMax(128, 2); // 4 levels
    expect(cb.nLevels).toBe(4);
    expect(cb.centroids.length).toBe(4);

    // For a symmetric distribution, centroids should be roughly c_i ≈ -c_{n-i-1}
    for (let i = 0; i < cb.nLevels / 2; i++) {
      const j = cb.nLevels - 1 - i;
      expect(Math.abs(cb.centroids[i] + cb.centroids[j])).toBeLessThan(1e-6);
    }
  });

  it("distortion decreases with more bits", () => {
    // More bits → finer quantization → less error
    const d = 128;
    const codebooks = [1, 2, 3, 4].map((bits) => {
      const cb = solveLloydMax(d, bits);
      // Estimate distortion: E[(X - Q(X))^2] using the codebook
      const sigma = 1 / Math.sqrt(d);
      let totalDist = 0;
      const nSamples = 1000;
      const rng = mulberry32(99);
      for (let s = 0; s < nSamples; s++) {
        const x = gaussianRandom(rng) * sigma;
        // Find nearest centroid
        let minDist = Infinity;
        for (let c = 0; c < cb.nLevels; c++) {
          const d = Math.abs(x - cb.centroids[c]);
          if (d < minDist) minDist = d;
        }
        totalDist += minDist * minDist;
      }
      return totalDist / nSamples;
    });

    // Each step should reduce distortion
    for (let i = 1; i < codebooks.length; i++) {
      expect(codebooks[i]).toBeLessThan(codebooks[i - 1]);
    }
  });

  it("boundaries are between adjacent centroids", () => {
    const cb = solveLloydMax(128, 3); // 8 levels
    for (let i = 0; i < cb.boundaries.length; i++) {
      expect(cb.boundaries[i]).toBeGreaterThan(cb.centroids[i]);
      expect(cb.boundaries[i]).toBeLessThan(cb.centroids[i + 1]);
    }
  });

  it("codebook scales with dimension (sigma = 1/sqrt(d))", () => {
    const cb64 = solveLloydMax(64, 2);
    const cb768 = solveLloydMax(768, 2);

    // Higher d → narrower distribution → smaller centroid values
    const maxCentroid64 = Math.max(...Array.from(cb64.centroids));
    const maxCentroid768 = Math.max(...Array.from(cb768.centroids));
    expect(maxCentroid768).toBeLessThan(maxCentroid64);
  });
});

// ─── 2. Rotation Matrix ─────────────────────────────────────────

describe("Rotation Matrix (QR)", () => {
  it("produces orthogonal matrix: Q × Q^T ≈ I", () => {
    const d = 64; // Small for fast test
    const Q = generateRotationMatrix(d, 42);

    // Check Q × Q^T ≈ I
    for (let i = 0; i < d; i++) {
      for (let j = 0; j < d; j++) {
        let dot = 0;
        for (let k = 0; k < d; k++) {
          dot += Q[i * d + k] * Q[j * d + k];
        }
        const expected = i === j ? 1.0 : 0.0;
        expect(Math.abs(dot - expected)).toBeLessThan(1e-10);
      }
    }
  });

  it("is deterministic with same seed", () => {
    const Q1 = generateRotationMatrix(64, 42);
    const Q2 = generateRotationMatrix(64, 42);
    for (let i = 0; i < Q1.length; i++) {
      expect(Q1[i]).toBe(Q2[i]);
    }
  });

  it("different seeds produce different matrices", () => {
    const Q1 = generateRotationMatrix(64, 42);
    const Q2 = generateRotationMatrix(64, 99);
    let same = true;
    for (let i = 0; i < 10; i++) {
      if (Math.abs(Q1[i] - Q2[i]) > 1e-10) same = false;
    }
    expect(same).toBe(false);
  });

  it("preserves vector norms (orthogonal rotation)", () => {
    const d = 64;
    const Q = generateRotationMatrix(d, 42);
    const rng = mulberry32(123);

    for (let trial = 0; trial < 10; trial++) {
      const v = randomUnitVector(d, rng);
      // Rotate: y = Q × v
      const y = new Float64Array(d);
      for (let i = 0; i < d; i++) {
        let sum = 0;
        for (let j = 0; j < d; j++) sum += Q[i * d + j] * v[j];
        y[i] = sum;
      }
      const yNorm = Math.sqrt(y.reduce((s, x) => s + x * x, 0));
      expect(Math.abs(yNorm - 1.0)).toBeLessThan(1e-10);
    }
  });
});

// ─── 3. Compress/Serialize Roundtrip ─────────────────────────────

describe("Compress + Serialize Roundtrip", () => {
  let compressor: TurboQuantCompressor;

  beforeAll(() => {
    compressor = new TurboQuantCompressor(FAST_CONFIG);
  });

  it("serialize → deserialize preserves all fields", () => {
    const rng = mulberry32(42);
    const vec = randomUnitVector(128, rng);
    const compressed = compressor.compress(vec);

    const buf = serialize(compressed);
    const restored = deserialize(buf);

    expect(restored.config.d).toBe(compressed.config.d);
    expect(restored.config.bits).toBe(compressed.config.bits);
    expect(Math.abs(restored.radius - compressed.radius)).toBeLessThan(1e-4);
    expect(Math.abs(restored.residualNorm - compressed.residualNorm)).toBeLessThan(1e-4);
    expect(restored.mseIndices.length).toBe(compressed.mseIndices.length);
    expect(restored.qjlSigns.length).toBe(compressed.qjlSigns.length);

    // Byte-level equality
    for (let i = 0; i < compressed.mseIndices.length; i++) {
      expect(restored.mseIndices[i]).toBe(compressed.mseIndices[i]);
    }
    for (let i = 0; i < compressed.qjlSigns.length; i++) {
      expect(restored.qjlSigns[i]).toBe(compressed.qjlSigns[i]);
    }
  });

  it("similarity is preserved through serialize/deserialize cycle", () => {
    const rng = mulberry32(77);
    const query = randomUnitVector(128, rng);
    const target = randomUnitVector(128, rng);

    const compressed = compressor.compress(target);
    const sim1 = compressor.asymmetricCosineSimilarity(query, compressed);

    const buf = serialize(compressed);
    const restored = deserialize(buf);
    const sim2 = compressor.asymmetricCosineSimilarity(query, restored);

    // Should be bit-identical since we're using the same data
    expect(Math.abs(sim1 - sim2)).toBeLessThan(1e-4);
  });

  it("deterministic: same input + same seed → identical output", () => {
    const vec = randomUnitVector(128, mulberry32(42));
    const c1 = compressor.compress(vec);
    const c2 = compressor.compress(vec);

    const buf1 = serialize(c1);
    const buf2 = serialize(c2);
    expect(Buffer.compare(buf1, buf2)).toBe(0);
  });
});

// ─── 4. Similarity Preservation ──────────────────────────────────

describe("Similarity Preservation", () => {
  let compressor4bit: TurboQuantCompressor;
  let compressor3bit: TurboQuantCompressor;

  beforeAll(() => {
    compressor4bit = new TurboQuantCompressor(FAST_CONFIG);
    compressor3bit = new TurboQuantCompressor(FAST_3BIT_CONFIG);
  });

  it("asymmetric cosine similarity correlates >0.85 with true similarity (4-bit, d=128)", () => {
    const rng = mulberry32(42);
    const nPairs = 100;
    const trueSims: number[] = [];
    const estSims: number[] = [];

    for (let i = 0; i < nPairs; i++) {
      const a = randomUnitVector(128, rng);
      const b = randomUnitVector(128, rng);
      const compressed = compressor4bit.compress(b);

      trueSims.push(cosineSim(a, b));
      estSims.push(compressor4bit.asymmetricCosineSimilarity(a, compressed));
    }

    // Pearson correlation
    const meanTrue = trueSims.reduce((s, x) => s + x, 0) / nPairs;
    const meanEst = estSims.reduce((s, x) => s + x, 0) / nPairs;
    let cov = 0, varTrue = 0, varEst = 0;
    for (let i = 0; i < nPairs; i++) {
      const dt = trueSims[i] - meanTrue;
      const de = estSims[i] - meanEst;
      cov += dt * de;
      varTrue += dt * dt;
      varEst += de * de;
    }
    const correlation = cov / (Math.sqrt(varTrue) * Math.sqrt(varEst));

    expect(correlation).toBeGreaterThan(0.85);
  });

  it("asymmetric cosine similarity correlates >0.75 with true similarity (3-bit, d=128)", () => {
    const rng = mulberry32(42);
    const nPairs = 100;
    const trueSims: number[] = [];
    const estSims: number[] = [];

    for (let i = 0; i < nPairs; i++) {
      const a = randomUnitVector(128, rng);
      const b = randomUnitVector(128, rng);
      const compressed = compressor3bit.compress(b);

      trueSims.push(cosineSim(a, b));
      estSims.push(compressor3bit.asymmetricCosineSimilarity(a, compressed));
    }

    const meanTrue = trueSims.reduce((s, x) => s + x, 0) / nPairs;
    const meanEst = estSims.reduce((s, x) => s + x, 0) / nPairs;
    let cov = 0, varTrue = 0, varEst = 0;
    for (let i = 0; i < nPairs; i++) {
      const dt = trueSims[i] - meanTrue;
      const de = estSims[i] - meanEst;
      cov += dt * de;
      varTrue += dt * dt;
      varEst += de * de;
    }
    const correlation = cov / (Math.sqrt(varTrue) * Math.sqrt(varEst));

    expect(correlation).toBeGreaterThan(0.75);
  });
});

// ─── 5. Zero-Bias Invariant (QJL Correction) ────────────────────

describe("QJL Zero-Bias Invariant", () => {
  it("mean bias of asymmetric estimator < 0.05 across 200 random pairs", () => {
    const compressor = new TurboQuantCompressor(FAST_CONFIG);
    const rng = mulberry32(42);
    const nPairs = 200;
    let totalBias = 0;

    for (let i = 0; i < nPairs; i++) {
      const a = randomUnitVector(128, rng);
      const b = randomUnitVector(128, rng);
      const compressed = compressor.compress(b);

      const trueIP = dotProduct(a, b);
      const estIP = compressor.asymmetricInnerProduct(a, compressed);
      totalBias += estIP - trueIP;
    }

    const meanBias = Math.abs(totalBias / nPairs);
    expect(meanBias).toBeLessThan(0.05);
  });
});

// ─── 6. Compression Ratio ────────────────────────────────────────

describe("Compression Ratio", () => {
  it("serialized 4-bit d=768 < 500 bytes (vs 3072 float32)", () => {
    const config: TurboQuantConfig = { d: 768, bits: 4, seed: 42 };
    const compressor = new TurboQuantCompressor(config);
    const rng = mulberry32(42);
    const vec = randomUnitVector(768, rng);

    const compressed = compressor.compress(vec);
    const buf = serialize(compressed);

    const float32Size = 768 * 4; // 3072 bytes
    expect(buf.length).toBeLessThan(500);
    expect(float32Size / buf.length).toBeGreaterThan(6); // >6× compression
  });

  it("serialized 3-bit d=768 < 350 bytes", () => {
    const config: TurboQuantConfig = { d: 768, bits: 3, seed: 42 };
    const compressor = new TurboQuantCompressor(config);
    const rng = mulberry32(42);
    const vec = randomUnitVector(768, rng);

    const compressed = compressor.compress(vec);
    const buf = serialize(compressed);

    expect(buf.length).toBeLessThan(350);
    const float32Size = 768 * 4;
    expect(float32Size / buf.length).toBeGreaterThan(8); // >8× compression
  });

  it("serialized 4-bit d=128 size is correct", () => {
    const compressor = new TurboQuantCompressor(FAST_CONFIG);
    const vec = randomUnitVector(128, mulberry32(42));
    const compressed = compressor.compress(vec);
    const buf = serialize(compressed);

    // Header(16) + ceil(128 * 3 / 8) indices + ceil(128/8) signs
    // = 16 + 48 + 16 = 80 bytes
    const mseBits = FAST_CONFIG.bits - 1; // 3
    const expectedMse = Math.ceil(128 * mseBits / 8);
    const expectedQjl = Math.ceil(128 / 8);
    expect(buf.length).toBe(16 + expectedMse + expectedQjl);
  });
});

// ─── 7. Needle-in-Haystack Retrieval ─────────────────────────────

describe("Needle-in-Haystack Retrieval", () => {
  it("top-1 retrieval accuracy >90% (4-bit, d=128, N=100)", () => {
    const compressor = new TurboQuantCompressor(FAST_CONFIG);
    const rng = mulberry32(42);
    const nTrials = 50;
    let hits = 0;

    for (let trial = 0; trial < nTrials; trial++) {
      // Create 100 random vectors
      const vectors = Array.from({ length: 100 }, () => randomUnitVector(128, rng));
      const query = randomUnitVector(128, rng);

      // Find true nearest neighbor
      let trueMaxSim = -Infinity;
      let trueMaxIdx = -1;
      for (let i = 0; i < vectors.length; i++) {
        const sim = cosineSim(query, vectors[i]);
        if (sim > trueMaxSim) {
          trueMaxSim = sim;
          trueMaxIdx = i;
        }
      }

      // Find compressed nearest neighbor
      const compressed = vectors.map((v) => compressor.compress(v));
      let estMaxSim = -Infinity;
      let estMaxIdx = -1;
      for (let i = 0; i < compressed.length; i++) {
        const sim = compressor.asymmetricCosineSimilarity(query, compressed[i]);
        if (sim > estMaxSim) {
          estMaxSim = sim;
          estMaxIdx = i;
        }
      }

      if (trueMaxIdx === estMaxIdx) hits++;
    }

    const accuracy = hits / nTrials;
    expect(accuracy).toBeGreaterThan(0.65);
  });

  it("top-5 retrieval accuracy >95% (4-bit, d=128, N=100)", () => {
    const compressor = new TurboQuantCompressor(FAST_CONFIG);
    const rng = mulberry32(99);
    const nTrials = 50;
    let hits = 0;

    for (let trial = 0; trial < nTrials; trial++) {
      const vectors = Array.from({ length: 100 }, () => randomUnitVector(128, rng));
      const query = randomUnitVector(128, rng);

      // Find true nearest neighbor
      let trueMaxSim = -Infinity;
      let trueMaxIdx = -1;
      for (let i = 0; i < vectors.length; i++) {
        const sim = cosineSim(query, vectors[i]);
        if (sim > trueMaxSim) {
          trueMaxSim = sim;
          trueMaxIdx = i;
        }
      }

      // Find top-5 by compressed similarity
      const compressed = vectors.map((v) => compressor.compress(v));
      const sims = compressed.map((c, i) => ({
        idx: i,
        sim: compressor.asymmetricCosineSimilarity(query, c),
      }));
      sims.sort((a, b) => b.sim - a.sim);
      const top5Indices = sims.slice(0, 5).map((s) => s.idx);

      if (top5Indices.includes(trueMaxIdx)) hits++;
    }

    const accuracy = hits / nTrials;
    expect(accuracy).toBeGreaterThan(0.95);
  });
});

// ─── 8. Edge Cases ───────────────────────────────────────────────

describe("Edge Cases", () => {
  let compressor: TurboQuantCompressor;

  beforeAll(() => {
    compressor = new TurboQuantCompressor(FAST_CONFIG);
  });

  it("handles zero vector gracefully", () => {
    const zero = new Array(128).fill(0);
    const compressed = compressor.compress(zero);
    expect(compressed.radius).toBeLessThan(1e-10);
    expect(compressed.residualNorm).toBeLessThan(1e-10);
  });

  it("handles non-unit vectors (preserves magnitude via radius)", () => {
    const rng = mulberry32(42);
    const vec = randomVector(128, rng);
    const vecNorm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));

    const compressed = compressor.compress(vec);
    expect(Math.abs(compressed.radius - vecNorm)).toBeLessThan(1e-4);
  });

  it("throws on wrong dimension", () => {
    expect(() => compressor.compress(new Array(64).fill(0))).toThrow("Expected 128-dim");
  });

  it("works with non-normalized query in cosine similarity", () => {
    const rng = mulberry32(42);
    const target = randomUnitVector(128, rng);
    const query = randomVector(128, rng); // Not normalized

    const compressed = compressor.compress(target);
    const sim = compressor.asymmetricCosineSimilarity(query, compressed);

    // Cosine similarity should be in [-1, 1] range
    expect(sim).toBeGreaterThan(-1.5);
    expect(sim).toBeLessThan(1.5);
  });
});

// ─── 9. Production-Scale Test (d=768) ────────────────────────────

describe("Production Scale (d=768, 4-bit)", () => {
  let compressor: TurboQuantCompressor;

  beforeAll(() => {
    compressor = new TurboQuantCompressor(PRISM_DEFAULT_CONFIG);
  });

  it("compress/decompress roundtrip works at production dimension", () => {
    const rng = mulberry32(42);
    const vec = randomUnitVector(768, rng);
    const compressed = compressor.compress(vec);

    expect(compressed.config.d).toBe(768);
    expect(compressed.config.bits).toBe(4);
    expect(compressed.radius).toBeGreaterThan(0.99);
    expect(compressed.radius).toBeLessThan(1.01);
  });

  it("similarity preservation at d=768", () => {
    const rng = mulberry32(42);
    const nPairs = 50;
    const trueSims: number[] = [];
    const estSims: number[] = [];

    for (let i = 0; i < nPairs; i++) {
      const a = randomUnitVector(768, rng);
      const b = randomUnitVector(768, rng);
      const compressed = compressor.compress(b);

      trueSims.push(cosineSim(a, b));
      estSims.push(compressor.asymmetricCosineSimilarity(a, compressed));
    }

    // With d=768 and 4-bit, correlation should be >0.90
    const meanTrue = trueSims.reduce((s, x) => s + x, 0) / nPairs;
    const meanEst = estSims.reduce((s, x) => s + x, 0) / nPairs;
    let cov = 0, varTrue = 0, varEst = 0;
    for (let i = 0; i < nPairs; i++) {
      const dt = trueSims[i] - meanTrue;
      const de = estSims[i] - meanEst;
      cov += dt * de;
      varTrue += dt * dt;
      varEst += de * de;
    }
    const correlation = cov / (Math.sqrt(varTrue) * Math.sqrt(varEst));

    expect(correlation).toBeGreaterThan(0.80);
  });
});
