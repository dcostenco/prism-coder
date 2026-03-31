import { TurboQuantCompressor, CompressedEmbedding, PRISM_DEFAULT_CONFIG, getDefaultCompressor } from '../utils/turboquant.js';

// M = 10,000 hard locations per project
const SDM_M = 10000;
// D_addr = 768 bits (binary QJL string length), represented as 24 Uint32s
export const D_ADDR_UINT32 = PRISM_DEFAULT_CONFIG.d / 32; 

// Bump this whenever the PRNG algorithm changes, to invalidate stale persisted state.
export const SDM_ADDRESS_VERSION = 2;

// The hard threshold boundary applied to counters during HDC writes
// to retain memory plasticity over long periods.
const COUNTER_CLIP = 20;

// Deterministic PRNG with Weyl sequence for full 2^32 period.
// The golden ratio increment (0x6D2B79F5) guarantees the seed visits every
// 32-bit value exactly once before repeating, preventing Birthday Paradox
// cycle collisions that would duplicate hard-location addresses.
class PRNG {
  private seed: number;
  constructor(seed: number) {
    this.seed = seed;
  }
  nextUInt32(): number {
    // Weyl sequence: monotonic increment through full 2^32 space
    // The `| 0` forces 32-bit signed integer wrapping, preventing
    // JS float precision loss past Number.MAX_SAFE_INTEGER.
    let t = (this.seed = (this.seed + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  }
}

/**
 * Fast Hamming Distance over Uint32 arrays
 */
export function hammingDistance(a: Uint32Array, b: Uint32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    let xor = a[i] ^ b[i];
    // 32-bit popcount trick
    xor -= ((xor >>> 1) & 0x55555555);
    xor = (xor & 0x33333333) + ((xor >>> 2) & 0x33333333);
    xor = (xor + (xor >>> 4)) & 0x0F0F0F0F;
    sum += Math.imul(xor, 0x01010101) >>> 24;
  }
  return sum;
}

export class SparseDistributedMemory {
  // Guard flag to prevent cross-talk between standard embedding logic and pure HDC logic
  private _mode: 'uninitialized' | 'semantic' | 'hdc' = 'uninitialized';

  // Hard Locations: Addresses (M x 24 uint32)
  public readonly addresses: Uint32Array[];
  // Hard Locations: Counters (M x 768 float32)
  public readonly counters: Float32Array[];
  
  constructor(seed: number = 42) {
    this.addresses = new Array(SDM_M);
    this.counters = new Array(SDM_M);
    
    const prng = new PRNG(seed);
    for (let i = 0; i < SDM_M; i++) {
      const addr = new Uint32Array(D_ADDR_UINT32);
      for (let j = 0; j < D_ADDR_UINT32; j++) {
        addr[j] = prng.nextUInt32();
      }
      this.addresses[i] = addr;
      this.counters[i] = new Float32Array(PRISM_DEFAULT_CONFIG.d);
    }
  }

  /** Convert TurboQuant QJL bytes into Uint32Array for fast bit math */
  private blobToAddress(blob: CompressedEmbedding): Uint32Array {
    const qjl = blob.qjlSigns; // Uint8Array of length 96 (768 bits)
    const view = new DataView(qjl.buffer, qjl.byteOffset, qjl.byteLength);
    const addr = new Uint32Array(D_ADDR_UINT32);
    for (let i = 0; i < D_ADDR_UINT32; i++) {
       // Needs little endian to match bit alignment expectations safely
       addr[i] = view.getUint32(i * 4, true); 
    }
    return addr;
  }

  /**
   * Write a dense vector into the memory by routing it to activated counters
   */
  public write(vector: Float32Array, k: number = 20) {
    this.assertMode('semantic');
    const compressor = getDefaultCompressor();
    const blob = compressor.compress(Array.from(vector));
    const address = this.blobToAddress(blob);

    const activated = this.getTopK(address, k);
    for (const idx of activated) {
      const c = this.counters[idx];
      for (let j = 0; j < PRISM_DEFAULT_CONFIG.d; j++) {
        c[j] += vector[j];
      }
    }
  }

  public read(queryVector: Float32Array, k: number = 20): Float32Array {
    this.assertMode('semantic');
    const compressor = getDefaultCompressor();
    const blob = compressor.compress(Array.from(queryVector));
    const address = this.blobToAddress(blob);

    const result = new Float32Array(PRISM_DEFAULT_CONFIG.d);
    const activated = this.getTopK(address, k);
    
    for (const idx of activated) {
      const c = this.counters[idx];
      for (let j = 0; j < PRISM_DEFAULT_CONFIG.d; j++) {
        result[j] += c[j];
      }
    }
    
    return this.l2Normalize(result);
  }

  /**
   * Write an HDC binary vector directly into memory (skips TurboQuant logic).
   * Maps 1 bits to +1 and 0 bits to -1, summing them into the addressed counters.
   * Applies hard clipping per counter entry ensuring bounded dynamics.
   */
  public writeHdc(hdcVector: Uint32Array, k: number = 20) {
    this.assertMode('hdc');
    if (hdcVector.length !== D_ADDR_UINT32) {
      throw new Error(`[HDC] Invalid vector length: expected ${D_ADDR_UINT32}, got ${hdcVector.length}`);
    }
    const activated = this.getTopK(hdcVector, k);
    
    for (const idx of activated) {
      const c = this.counters[idx];
      let floatIdx = 0;
      for (let w = 0; w < D_ADDR_UINT32; w++) {
        const word = hdcVector[w];
        for (let bitIdx = 0; bitIdx < 32; bitIdx++) {
          const bitVal = (word & (1 << bitIdx)) !== 0 ? 1 : -1;
          const newVal = c[floatIdx] + bitVal;
          // Apply strict bounds clipping to retain plasticity
          c[floatIdx] = Math.max(-COUNTER_CLIP, Math.min(COUNTER_CLIP, newVal));
          floatIdx++;
        }
      }
    }
  }

  /**
   * Retrieve an HDC binary vector associatively via noise cleanup thresholding.
   * Sums the raw counters natively within the activation radius and thresholds 
   * the values directly to 0 or 1, skipping expensive L2 normalization entirely.
   */
  public readHdc(queryVector: Uint32Array, k: number = 20): Uint32Array {
    this.assertMode('hdc');
    if (queryVector.length !== D_ADDR_UINT32) {
      throw new Error(`[HDC] Invalid query vector length: expected ${D_ADDR_UINT32}, got ${queryVector.length}`);
    }
    const activated = this.getTopK(queryVector, k);
    
    const accum = new Float32Array(PRISM_DEFAULT_CONFIG.d);
    for (const idx of activated) {
      const c = this.counters[idx];
      for (let j = 0; j < PRISM_DEFAULT_CONFIG.d; j++) {
        accum[j] += c[j];
      }
    }
    
    const result = new Uint32Array(D_ADDR_UINT32);
    let floatIdx = 0;
    for (let w = 0; w < D_ADDR_UINT32; w++) {
      let word = 0;
      for (let bitIdx = 0; bitIdx < 32; bitIdx++) {
        if (accum[floatIdx] > 0) {
          word |= (1 << bitIdx);
        } else if (accum[floatIdx] === 0) {
          // Deterministic tie-breaker for read summation:
          // Defaulting to 0 on exact zero sums aligns mathematically with HDC implementation ties
        }
        floatIdx++;
      }
      result[w] = word >>> 0;
    }
    return result;
  }

  private getTopK(address: Uint32Array, k: number): number[] {
    if (k <= 0 || k > SDM_M) {
      throw new Error(`[SDM] Invalid K radius boundary: expected 1 <= k <= ${SDM_M}, got ${k}`);
    }

    // Bounded max-heap of size K: avoids allocating 10,000 objects and O(M log M) sort.
    // Instead uses O(M log K) with a pre-allocated parallel Int32Array pair.
    // heap[i] = distance, heapIdx[i] = address index. Max-heap so we can eject the farthest.
    const heap = new Int32Array(k);
    const heapIdx = new Int32Array(k);
    let heapSize = 0;

    const swap = (a: number, b: number) => {
      let t = heap[a]; heap[a] = heap[b]; heap[b] = t;
      t = heapIdx[a]; heapIdx[a] = heapIdx[b]; heapIdx[b] = t;
    };

    const siftUp = (i: number) => {
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heap[i] > heap[parent]) { swap(i, parent); i = parent; }
        else break;
      }
    };

    const siftDown = (i: number) => {
      while (true) {
        let largest = i;
        const l = 2 * i + 1, r = 2 * i + 2;
        if (l < heapSize && heap[l] > heap[largest]) largest = l;
        if (r < heapSize && heap[r] > heap[largest]) largest = r;
        if (largest !== i) { swap(i, largest); i = largest; }
        else break;
      }
    };

    for (let i = 0; i < SDM_M; i++) {
      const d = hammingDistance(address, this.addresses[i]);
      if (heapSize < k) {
        heap[heapSize] = d;
        heapIdx[heapSize] = i;
        heapSize++;
        siftUp(heapSize - 1);
      } else if (d < heap[0]) {
        // Replace root (farthest) with this closer address
        heap[0] = d;
        heapIdx[0] = i;
        siftDown(0);
      }
    }

    // Extract sorted result (closest first) for deterministic ordering
    const result = new Array(heapSize);
    const sortBuf: {d: number, i: number}[] = new Array(heapSize);
    for (let j = 0; j < heapSize; j++) {
      sortBuf[j] = { d: heap[j], i: heapIdx[j] };
    }
    // O(K log K) sort on the tiny K-sized slice — deterministic tie-break on index
    sortBuf.sort((a, b) => a.d - b.d || a.i - b.i);
    for (let j = 0; j < heapSize; j++) {
      result[j] = sortBuf[j].i;
    }
    return result;
  }

  private l2Normalize(vec: Float32Array): Float32Array {
    let sum = 0;
    for (let i = 0; i < vec.length; i++) {
      sum += vec[i] * vec[i];
    }
    if (sum === 0) return vec;
    const mag = Math.sqrt(sum);
    for (let i = 0; i < vec.length; i++) {
      vec[i] /= mag;
    }
    return vec;
  }

  private assertMode(req: 'semantic' | 'hdc') {
    if (this._mode === 'uninitialized') {
      this._mode = req;
    } else if (this._mode !== req) {
      throw new Error(`[SDM] Engine mode cross-talk violation. Instance locked to ${this._mode} memory, but received ${req} operation.`);
    }
  }

  /**
   * Export the entire 10k x 768 counter matrix as a single 1D Float32Array
   * for binary serialization to SQLite BLOB.
   */
  public exportState(): Float32Array {
    const state = new Float32Array(SDM_M * PRISM_DEFAULT_CONFIG.d);
    for (let i = 0; i < SDM_M; i++) {
      state.set(this.counters[i], i * PRISM_DEFAULT_CONFIG.d);
    }
    return state;
  }

  /**
   * Import a previously serialized 1D Float32Array matrix back into
   * the 2D counters array.
   */
  public importState(state: Float32Array) {
    if (state.length !== SDM_M * PRISM_DEFAULT_CONFIG.d) {
      throw new Error(`Invalid SDM state size: expected ${SDM_M * PRISM_DEFAULT_CONFIG.d}, got ${state.length}`);
    }
    for (let i = 0; i < SDM_M; i++) {
      // Subarray creates a fast view over the underlying buffer
      this.counters[i] = state.subarray(i * PRISM_DEFAULT_CONFIG.d, (i + 1) * PRISM_DEFAULT_CONFIG.d);
    }
  }
}

// Global Singleton per Project in memory — with LRU eviction
const _sdmInstances = new Map<string, SparseDistributedMemory>();
const MAX_SDM_INSTANCES = 50;

export function getSdmEngine(projectId: string): SparseDistributedMemory {
  // Touch: move to end of insertion order (LRU refresh)
  const existing = _sdmInstances.get(projectId);
  if (existing) {
    _sdmInstances.delete(projectId);
    _sdmInstances.set(projectId, existing);
    return existing;
  }

  // Evict oldest if at capacity
  if (_sdmInstances.size >= MAX_SDM_INSTANCES) {
    const oldestKey = _sdmInstances.keys().next().value;
    if (oldestKey !== undefined) {
      _sdmInstances.delete(oldestKey);
    }
  }

  const instance = new SparseDistributedMemory();
  _sdmInstances.set(projectId, instance);
  return instance;
}

export function getAllActiveSdmProjects(): string[] {
  return Array.from(_sdmInstances.keys());
}
