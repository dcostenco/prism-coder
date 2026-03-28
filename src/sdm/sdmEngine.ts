import { TurboQuantCompressor, CompressedEmbedding, PRISM_DEFAULT_CONFIG, getDefaultCompressor } from '../utils/turboquant.js';

// M = 10,000 hard locations per project
const SDM_M = 10000;
// D_addr = 768 bits (binary QJL string length), represented as 24 Uint32s
const D_ADDR_UINT32 = PRISM_DEFAULT_CONFIG.d / 32; 

// The L1 radius threshold for "activation" (how many bits can differ)
// For 768 bits, picking a threshold like 300 gives us sparse activation
const ACTIVATION_RADIUS = 300; 

// We use PRNG seeded deterministically to generate the initial hard location addresses
// This ensures that restarts produce the exact same Kanerva address space
class PRNG {
  private seed: number;
  constructor(seed: number) {
    this.seed = seed;
  }
  nextUInt32(): number {
    this.seed = Math.imul(this.seed ^ (this.seed >>> 15), 1 | this.seed);
    this.seed ^= this.seed + Math.imul(this.seed ^ (this.seed >>> 7), 61 | this.seed);
    const v = ((this.seed ^ (this.seed >>> 14)) >>> 0);
    return v;
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

  private getTopK(address: Uint32Array, k: number): number[] {
    // Array of (dist, index)
    const dists: {d: number, i: number}[] = new Array(SDM_M);
    for (let i = 0; i < SDM_M; i++) {
      dists[i] = { d: hammingDistance(address, this.addresses[i]), i };
    }
    // Partial sort to find top K
    dists.sort((a, b) => a.d - b.d);
    const result = new Array(k);
    for (let i = 0; i < k; i++) {
        result[i] = dists[i].i;
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

// Global Singleton per Project in memory
const _sdmInstances = new Map<string, SparseDistributedMemory>();

export function getSdmEngine(projectId: string): SparseDistributedMemory {
  if (!_sdmInstances.has(projectId)) {
    _sdmInstances.set(projectId, new SparseDistributedMemory());
  }
  return _sdmInstances.get(projectId)!;
}

export function getAllActiveSdmProjects(): string[] {
  return Array.from(_sdmInstances.keys());
}
