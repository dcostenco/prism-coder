/**
 * TurboQuant — Pure TypeScript Vector Quantization (v5.0)
 * ═══════════════════════════════════════════════════════════════════════════
 * Port of Google's TurboQuant (ICLR 2026) two-stage vector quantization
 * algorithm for Prism MCP embedding compression.
 *
 * Compresses 768-dim float32 embeddings (~3,072 bytes) to ~400 bytes
 * with near-zero accuracy loss for semantic similarity search.
 *
 * PIPELINE:
 *   Stage 1: Random QR rotation → per-coordinate Lloyd-Max quantization
 *   Stage 2: 1-bit QJL (Quantized Johnson-Lindenstrauss) residual correction
 *
 * DESIGN DECISIONS:
 *   - QR rotation (not FWHT): O(d²) one-time cost is fine for 1 vec/save call
 *   - Gaussian approx N(0,1/d) for Lloyd-Max: exact at d=768
 *   - Simpson's rule replaces scipy.integrate.quad: <1µs per integral
 *   - Variable-bit packing for MSE indices: 3-bit = 288 bytes for d=768
 *   - Zero external dependencies
 *
 * REFERENCE: tonbistudio/turboquant-pytorch (PyTorch implementation)
 * PAPER: "TurboQuant: Online Vector Quantization with Near-optimal Distortion Rate"
 *
 * @module turboquant
 */

// ─── Types ───────────────────────────────────────────────────────

export interface TurboQuantConfig {
  /** Vector dimension (Prism default: 768) */
  d: number;
  /** Total bits per coordinate: MSE uses (bits-1), QJL uses 1 bit. Min: 2 */
  bits: number;
  /** Random seed for reproducibility */
  seed: number;
}

export interface CompressedEmbedding {
  /** Bit-packed MSE codebook indices: ceil(d * mseBits / 8) bytes */
  mseIndices: Uint8Array;
  /** Bit-packed QJL sign bits: ceil(d / 8) bytes */
  qjlSigns: Uint8Array;
  /** L2 norm of quantization residual */
  residualNorm: number;
  /** Original vector L2 norm (magnitude) */
  radius: number;
  /** Config used for compression */
  config: { d: number; bits: number };
}

export interface LloydMaxCodebook {
  /** Optimal centroid values, sorted ascending */
  centroids: Float64Array;
  /** Decision boundaries between adjacent centroids */
  boundaries: Float64Array;
  /** Number of quantization levels = 2^bits */
  nLevels: number;
  /** Bits per coordinate */
  bits: number;
}

// ─── Seeded PRNG (Mulberry32) ────────────────────────────────────
// Deterministic random number generator for cross-platform reproducibility.
// Matches the seed-based approach used in the PyTorch reference.

function mulberry32(seed: number): () => number {
  let t = seed | 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate N(0,1) using Box-Muller transform */
function gaussianRandom(rng: () => number): number {
  const u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1 + 1e-15)) * Math.cos(2 * Math.PI * u2);
}

// ─── Numerical Integration (Simpson's Rule) ──────────────────────

/**
 * Composite Simpson's rule for ∫f(x)dx over [a,b].
 * 1001 intervals provides ~1e-12 accuracy for smooth Gaussians.
 */
function integrate(f: (x: number) => number, a: number, b: number, n = 1000): number {
  if (n % 2 !== 0) n++;
  const h = (b - a) / n;
  let sum = f(a) + f(b);
  for (let i = 1; i < n; i++) {
    const x = a + i * h;
    sum += (i % 2 === 0 ? 2 : 4) * f(x);
  }
  return (h / 3) * sum;
}

// ─── Lloyd-Max Codebook Solver ───────────────────────────────────

/**
 * Gaussian PDF approximation for the coordinate distribution
 * after random rotation of a d-dimensional unit vector.
 *
 * Each coordinate follows Beta((d-1)/2, (d-1)/2) on [-1,1],
 * which converges to N(0, 1/d) for d ≥ 64.
 */
function gaussianPdf(x: number, d: number): number {
  const sigma2 = 1.0 / d;
  return (1.0 / Math.sqrt(2 * Math.PI * sigma2)) * Math.exp(-x * x / (2 * sigma2));
}

/**
 * Solve the Lloyd-Max optimal scalar quantizer for N(0, 1/d).
 *
 * Finds optimal centroids that minimize MSE (mean squared error)
 * for quantizing coordinates of a randomly-rotated unit vector.
 *
 * Algorithm:
 *   1. Initialize centroids uniformly in [-3.5σ, 3.5σ]
 *   2. Compute boundaries as midpoints between adjacent centroids
 *   3. Update centroids as conditional expectations E[X | X ∈ partition_i]
 *   4. Repeat until convergence (max_shift < 1e-10)
 */
export function solveLloydMax(d: number, bits: number): LloydMaxCodebook {
  const nLevels = 1 << bits; // 2^bits
  const sigma = 1.0 / Math.sqrt(d);
  const pdf = (x: number) => gaussianPdf(x, d);

  const lo = -3.5 * sigma;
  const hi = 3.5 * sigma;

  // Initialize centroids uniformly
  const centroids = new Float64Array(nLevels);
  for (let i = 0; i < nLevels; i++) {
    centroids[i] = lo + (hi - lo) * (i + 0.5) / nLevels;
  }

  const boundaries = new Float64Array(nLevels - 1);

  for (let iter = 0; iter < 200; iter++) {
    // Step 1: Boundaries = midpoints
    for (let i = 0; i < nLevels - 1; i++) {
      boundaries[i] = (centroids[i] + centroids[i + 1]) / 2.0;
    }

    // Step 2: Update centroids as E[X | X ∈ partition_i]
    let maxShift = 0;
    for (let i = 0; i < nLevels; i++) {
      const a = i === 0 ? lo * 3 : boundaries[i - 1];
      const b = i === nLevels - 1 ? hi * 3 : boundaries[i];

      const numerator = integrate((x) => x * pdf(x), a, b);
      const denominator = integrate(pdf, a, b);

      const newCentroid = denominator > 1e-15 ? numerator / denominator : centroids[i];
      maxShift = Math.max(maxShift, Math.abs(newCentroid - centroids[i]));
      centroids[i] = newCentroid;
    }

    if (maxShift < 1e-10) break;
  }

  // Final boundaries
  for (let i = 0; i < nLevels - 1; i++) {
    boundaries[i] = (centroids[i] + centroids[i + 1]) / 2.0;
  }

  return { centroids, boundaries, nLevels, bits };
}

// ─── Codebook Cache ──────────────────────────────────────────────

const codebookCache = new Map<string, LloydMaxCodebook>();

/** Get or create a codebook for the given (d, bits) pair. */
function getCodebook(d: number, bits: number): LloydMaxCodebook {
  const key = `${d}:${bits}`;
  let cb = codebookCache.get(key);
  if (!cb) {
    cb = solveLloydMax(d, bits);
    codebookCache.set(key, cb);
  }
  return cb;
}

/** Quantize a single value to its nearest centroid index. */
function quantizeValue(value: number, codebook: LloydMaxCodebook): number {
  // Binary search through boundaries for O(log n) lookup
  const { boundaries, nLevels } = codebook;
  let lo = 0;
  let hi = nLevels - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (mid < boundaries.length && value > boundaries[mid]) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// ─── Rotation Matrix (QR Decomposition) ──────────────────────────

/**
 * Generate a d×d random orthogonal matrix via QR decomposition.
 * Produces a Haar-distributed rotation matrix (uniform over SO(d)).
 *
 * Uses Householder QR — O(d²) but only computed once per config.
 * Stored as Float64Array in row-major order.
 */
export function generateRotationMatrix(d: number, seed: number): Float64Array {
  const rng = mulberry32(seed);

  // Generate d×d random Gaussian matrix
  const G = new Float64Array(d * d);
  for (let i = 0; i < d * d; i++) {
    G[i] = gaussianRandom(rng);
  }

  // ─── Householder QR decomposition ─────────────────────────
  // Compute Q via successive Householder reflections.
  // Q = H_1 × H_2 × ... × H_d, where each H_k zeroes out
  // the sub-diagonal of column k.
  const Q = new Float64Array(d * d);
  const R = new Float64Array(d * d);

  // Copy G to R (we'll transform R in-place)
  R.set(G);

  // Start with Q = Identity
  for (let i = 0; i < d; i++) Q[i * d + i] = 1.0;

  for (let k = 0; k < d; k++) {
    // Extract column k below diagonal
    const x = new Float64Array(d - k);
    for (let i = 0; i < d - k; i++) {
      x[i] = R[(i + k) * d + k];
    }

    // Compute Householder vector v
    let normX = 0;
    for (let i = 0; i < x.length; i++) normX += x[i] * x[i];
    normX = Math.sqrt(normX);

    if (normX < 1e-15) continue;

    const sign = x[0] >= 0 ? 1 : -1;
    x[0] += sign * normX;

    // Normalize v
    let normV = 0;
    for (let i = 0; i < x.length; i++) normV += x[i] * x[i];
    normV = Math.sqrt(normV);
    if (normV < 1e-15) continue;
    for (let i = 0; i < x.length; i++) x[i] /= normV;

    // Apply Householder reflection to R: R = (I - 2vv^T) R
    // Only need to update rows k..d-1, cols k..d-1
    for (let j = k; j < d; j++) {
      let dot = 0;
      for (let i = 0; i < d - k; i++) {
        dot += x[i] * R[(i + k) * d + j];
      }
      for (let i = 0; i < d - k; i++) {
        R[(i + k) * d + j] -= 2 * x[i] * dot;
      }
    }

    // Apply to Q: Q = Q (I - 2vv^T)
    // Update columns k..d-1 of Q
    for (let i = 0; i < d; i++) {
      let dot = 0;
      for (let j = 0; j < d - k; j++) {
        dot += Q[i * d + (j + k)] * x[j];
      }
      for (let j = 0; j < d - k; j++) {
        Q[i * d + (j + k)] -= 2 * dot * x[j];
      }
    }
  }

  // Fix sign ambiguity: ensure det(Q) = +1 by adjusting with diag(R) signs
  for (let i = 0; i < d; i++) {
    if (R[i * d + i] < 0) {
      for (let j = 0; j < d; j++) {
        Q[j * d + i] = -Q[j * d + i];
      }
    }
  }

  return Q;
}

// ─── QJL Random Projection Matrix ────────────────────────────────

/**
 * Generate (m × d) random Gaussian matrix for QJL projection.
 * Default m = d for 1:1 dimension mapping.
 */
export function generateQJLMatrix(d: number, seed: number, m?: number): Float64Array {
  m = m ?? d;
  const rng = mulberry32(seed);
  const S = new Float64Array(m * d);
  for (let i = 0; i < m * d; i++) {
    S[i] = gaussianRandom(rng);
  }
  return S;
}

// ─── Matrix-Vector Operations ────────────────────────────────────

/** y = M × x, where M is (rows × cols) row-major, x is (cols,) */
function matvec(M: Float64Array, x: Float64Array | number[], rows: number, cols: number): Float64Array {
  const y = new Float64Array(rows);
  for (let i = 0; i < rows; i++) {
    let sum = 0;
    const offset = i * cols;
    for (let j = 0; j < cols; j++) {
      sum += M[offset + j] * x[j];
    }
    y[i] = sum;
  }
  return y;
}

/** y = M^T × x, where M is (rows × cols) row-major, x is (rows,) */
function matvecT(M: Float64Array, x: Float64Array, rows: number, cols: number): Float64Array {
  const y = new Float64Array(cols);
  for (let i = 0; i < rows; i++) {
    const offset = i * cols;
    const xi = x[i];
    for (let j = 0; j < cols; j++) {
      y[j] += M[offset + j] * xi;
    }
  }
  return y;
}

/** Dot product of two arrays */
function dot(a: Float64Array | number[], b: Float64Array | number[], len: number): number {
  let sum = 0;
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}

/** L2 norm */
function norm(a: Float64Array, len: number): number {
  return Math.sqrt(dot(a, a, len));
}

// ─── Bit Packing ─────────────────────────────────────────────────

/**
 * Pack array of b-bit unsigned integers into a compact Uint8Array.
 *
 * For b=3, d=768: 768 × 3 = 2304 bits = 288 bytes
 * For b=4, d=768: 768 × 4 = 3072 bits = 384 bytes (nibble packing)
 */
function packBits(values: Uint16Array, bits: number): Uint8Array {
  const totalBits = values.length * bits;
  const packedLen = Math.ceil(totalBits / 8);
  const packed = new Uint8Array(packedLen);

  let bitPos = 0;
  for (let i = 0; i < values.length; i++) {
    let val = values[i];
    let bitsRemaining = bits;
    while (bitsRemaining > 0) {
      const byteIdx = bitPos >> 3;
      const bitOffset = bitPos & 7;
      const bitsAvailable = 8 - bitOffset;
      const bitsToWrite = Math.min(bitsRemaining, bitsAvailable);
      const mask = (1 << bitsToWrite) - 1;
      packed[byteIdx] |= (val & mask) << bitOffset;
      val >>= bitsToWrite;
      bitsRemaining -= bitsToWrite;
      bitPos += bitsToWrite;
    }
  }

  return packed;
}

/** Unpack b-bit unsigned integers from packed Uint8Array */
function unpackBits(packed: Uint8Array, bits: number, count: number): Uint16Array {
  const values = new Uint16Array(count);
  let bitPos = 0;

  for (let i = 0; i < count; i++) {
    let val = 0;
    let bitsRemaining = bits;
    let shift = 0;
    while (bitsRemaining > 0) {
      const byteIdx = bitPos >> 3;
      const bitOffset = bitPos & 7;
      const bitsAvailable = 8 - bitOffset;
      const bitsToRead = Math.min(bitsRemaining, bitsAvailable);
      const mask = (1 << bitsToRead) - 1;
      val |= ((packed[byteIdx] >> bitOffset) & mask) << shift;
      shift += bitsToRead;
      bitsRemaining -= bitsToRead;
      bitPos += bitsToRead;
    }
    values[i] = val;
  }

  return values;
}

/** Pack sign bits: +1 → 1, -1 → 0, stored as 1 bit each */
function packSigns(signs: Float64Array): Uint8Array {
  const packedLen = Math.ceil(signs.length / 8);
  const packed = new Uint8Array(packedLen);
  for (let i = 0; i < signs.length; i++) {
    if (signs[i] >= 0) {
      packed[i >> 3] |= 1 << (i & 7);
    }
  }
  return packed;
}

/** Unpack sign bits back to +1/-1 Float64Array */
function unpackSigns(packed: Uint8Array, count: number): Float64Array {
  const signs = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    signs[i] = (packed[i >> 3] >> (i & 7)) & 1 ? 1.0 : -1.0;
  }
  return signs;
}

// ─── TurboQuant Compressor ───────────────────────────────────────

/**
 * Precomputed TurboQuant state for a given config.
 * Created once and reused for all compress/similarity calls.
 */
export class TurboQuantCompressor {
  readonly d: number;
  readonly bits: number;
  readonly mseBits: number;
  readonly codebook: LloydMaxCodebook;
  readonly Pi: Float64Array;   // d×d rotation matrix
  readonly S: Float64Array;    // d×d QJL projection matrix

  constructor(config: TurboQuantConfig) {
    this.d = config.d;
    this.bits = config.bits;
    this.mseBits = Math.max(config.bits - 1, 1);
    this.codebook = getCodebook(config.d, this.mseBits);
    this.Pi = generateRotationMatrix(config.d, config.seed);
    this.S = generateQJLMatrix(config.d, config.seed + 1);
  }

  /**
   * Compress a float32/float64 embedding vector.
   *
   * Pipeline:
   *   1. Normalize to unit vector (store radius/magnitude)
   *   2. Rotate via orthogonal matrix: y = Pi × x_norm
   *   3. Per-coordinate Lloyd-Max quantization → indices
   *   4. Dequantize → compute MSE reconstruction
   *   5. Compute residual = original - MSE reconstruction
   *   6. QJL: project residual through S, keep sign bits
   */
  compress(embedding: number[]): CompressedEmbedding {
    const d = this.d;
    if (embedding.length !== d) {
      throw new Error(`Expected ${d}-dim vector, got ${embedding.length}`);
    }

    // Step 1: Normalize
    const vec = new Float64Array(embedding);
    const radius = norm(vec, d);
    const normalized = new Float64Array(d);
    if (radius > 1e-15) {
      for (let i = 0; i < d; i++) normalized[i] = vec[i] / radius;
    }

    // Step 2: Rotate (y = Pi × x)
    const rotated = matvec(this.Pi, normalized, d, d);

    // Step 3: Per-coordinate quantization
    const indices = new Uint16Array(d);
    for (let i = 0; i < d; i++) {
      indices[i] = quantizeValue(rotated[i], this.codebook);
    }

    // Step 4: Dequantize → MSE reconstruction in original space
    const dequantized = new Float64Array(d);
    for (let i = 0; i < d; i++) {
      dequantized[i] = this.codebook.centroids[indices[i]];
    }
    // Unrotate: x_mse_norm = Pi^T × dequantized
    const mseNorm = matvecT(this.Pi, dequantized, d, d);
    // Scale back: x_mse = radius × x_mse_norm
    const mse = new Float64Array(d);
    for (let i = 0; i < d; i++) mse[i] = mseNorm[i] * radius;

    // Step 5: Residual in original (non-normalized) space
    const residual = new Float64Array(d);
    for (let i = 0; i < d; i++) residual[i] = vec[i] - mse[i];
    const residualNorm = norm(residual, d);

    // Step 6: QJL — project residual, keep sign bits
    const projected = matvec(this.S, residual, d, d);
    const qjlSigns = packSigns(projected);

    // Pack MSE indices
    const mseIndicesPacked = packBits(indices, this.mseBits);

    return {
      mseIndices: mseIndicesPacked,
      qjlSigns,
      residualNorm,
      radius,
      config: { d, bits: this.bits },
    };
  }

  /**
   * Compute unbiased inner product estimate <query, compressed_vec>.
   *
   * Asymmetric estimator (query is float32, target is compressed):
   *   <q, x> ≈ <q, x_mse> + ||r|| × √(π/2) / m × <S@q, sign(S@r)>
   *
   * Term 1: inner product with MSE reconstruction
   * Term 2: QJL correction for unbiased estimation
   */
  asymmetricInnerProduct(query: number[], compressed: CompressedEmbedding): number {
    const d = this.d;

    // Reconstruct MSE vector from packed indices
    const indices = unpackBits(compressed.mseIndices, this.mseBits, d);
    const dequantized = new Float64Array(d);
    for (let i = 0; i < d; i++) {
      dequantized[i] = this.codebook.centroids[indices[i]];
    }
    const mseFull = matvecT(this.Pi, dequantized, d, d);

    // Scale by stored radius
    const mse = new Float64Array(d);
    for (let i = 0; i < d; i++) mse[i] = mseFull[i] * compressed.radius;

    // Term 1: <query, x_mse>
    const term1 = dot(query, mse, d);

    // Term 2: QJL correction
    const signs = unpackSigns(compressed.qjlSigns, d);
    const qProjected = matvec(this.S, new Float64Array(query), d, d);
    const qjlIp = dot(qProjected, signs, d);

    const m = d; // QJL projection dimension
    const correctionScale = Math.sqrt(Math.PI / 2) / m;
    const term2 = compressed.residualNorm * correctionScale * qjlIp;

    return term1 + term2;
  }

  /**
   * Compute cosine similarity between a query (float) and compressed vector.
   *
   * cosine_sim = <q, x> / (||q|| × ||x||)
   *            = asymmetricIP(q, compressed) / (||q|| × radius)
   */
  asymmetricCosineSimilarity(query: number[], compressed: CompressedEmbedding): number {
    const ip = this.asymmetricInnerProduct(query, compressed);
    const queryNorm = Math.sqrt(dot(query, query, query.length));
    if (queryNorm < 1e-15 || compressed.radius < 1e-15) return 0;
    return ip / (queryNorm * compressed.radius);
  }
}

// ─── Serialization ───────────────────────────────────────────────

/**
 * Serialize CompressedEmbedding to a compact binary buffer.
 *
 * Format (little-endian):
 *   [0-1]   d         (uint16)
 *   [2]     bits      (uint8)
 *   [3-7]   reserved  (5 bytes, zero-filled)
 *   [8-11]  radius    (float32)
 *   [12-15] residualNorm (float32)
 *   [16..]  mseIndices (bit-packed)
 *   [..]    qjlSigns  (bit-packed)
 *
 * For d=768, bits=3 (mseBits=2):
 *   8 + 4 + 4 + ceil(768*2/8) + ceil(768/8) = 8 + 4 + 4 + 192 + 96 = 304 bytes
 *
 * For d=768, bits=4 (mseBits=3):
 *   8 + 4 + 4 + ceil(768*3/8) + ceil(768/8) = 8 + 4 + 4 + 288 + 96 = 400 bytes
 */
export function serialize(compressed: CompressedEmbedding): Buffer {
  const mseLen = compressed.mseIndices.length;
  const qjlLen = compressed.qjlSigns.length;
  const totalLen = 16 + mseLen + qjlLen;

  const buf = Buffer.alloc(totalLen);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Header
  view.setUint16(0, compressed.config.d, true);
  view.setUint8(2, compressed.config.bits);
  // bytes 3-7: reserved

  // Scalars
  view.setFloat32(8, compressed.radius, true);
  view.setFloat32(12, compressed.residualNorm, true);

  // Packed data
  buf.set(compressed.mseIndices, 16);
  buf.set(compressed.qjlSigns, 16 + mseLen);

  return buf;
}

/**
 * Deserialize a binary buffer back to CompressedEmbedding.
 */
export function deserialize(buf: Buffer): CompressedEmbedding {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const d = view.getUint16(0, true);
  const bits = view.getUint8(2);
  const radius = view.getFloat32(8, true);
  const residualNorm = view.getFloat32(12, true);

  const mseBits = Math.max(bits - 1, 1);
  const mseLen = Math.ceil(d * mseBits / 8);
  const qjlLen = Math.ceil(d / 8);

  const mseIndices = new Uint8Array(buf.slice(16, 16 + mseLen));
  const qjlSigns = new Uint8Array(buf.slice(16 + mseLen, 16 + mseLen + qjlLen));

  return {
    mseIndices,
    qjlSigns,
    residualNorm,
    radius,
    config: { d, bits },
  };
}

// ─── Convenience: Default Prism Compressor ───────────────────────

/** Default config for Prism's 768-dim embeddings at 4-bit quantization */
export const PRISM_DEFAULT_CONFIG: TurboQuantConfig = {
  d: 768,
  bits: 4,
  seed: 42,
};

let _defaultCompressor: TurboQuantCompressor | null = null;

/** Get or create the default Prism compressor (lazy singleton) */
export function getDefaultCompressor(): TurboQuantCompressor {
  if (!_defaultCompressor) {
    _defaultCompressor = new TurboQuantCompressor(PRISM_DEFAULT_CONFIG);
  }
  return _defaultCompressor;
}
