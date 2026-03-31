import { StorageBackend } from '../storage/interface.js';
import { D_ADDR_UINT32, hammingDistance } from './sdmEngine.js';

export class DeterministicPRNG {
  private seed: number;
  constructor(seed: number) { this.seed = seed; }
  nextUInt32(): number {
    // Weyl sequence: golden ratio increment guarantees full 2^32 period.
    // `| 0` forces 32-bit signed wrapping to prevent JS float precision loss.
    let t = (this.seed = (this.seed + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  }
}

export function stringToSeed(str: string, globalSeed: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h ^ globalSeed) >>> 0;
}

export class ConceptDictionary {
  private storage: StorageBackend;
  private readonly globalSeed = 42;

  constructor(storage: StorageBackend) {
    this.storage = storage;
  }

  /**
   * Retrieves an orthogonal HDC vector for the specified concept.
   * Generation is deterministic based on the concept string.
   */
  async getConcept(concept: string): Promise<Uint32Array> {
    const existing = await this.storage.getHdcConcept(concept);
    if (existing !== null) {
      if (existing.length !== D_ADDR_UINT32) {
        throw new Error(`[ConceptDictionary] Retrieved vector length mismatch for ${concept}. Expected ${D_ADDR_UINT32}, got ${existing.length}`);
      }
      return existing;
    }

    const prng = new DeterministicPRNG(stringToSeed(concept, this.globalSeed));
    const newVector = new Uint32Array(D_ADDR_UINT32);
    for (let i = 0; i < D_ADDR_UINT32; i++) {
        newVector[i] = prng.nextUInt32();
    }

    await this.storage.saveHdcConcept(concept, newVector);
    return newVector;
  }

  async nearestConcept(
    query: Uint32Array,
    opts?: {
      maxDistance?: number;
      maxResults?: number;
      minMargin?: number;
    }
  ): Promise<{
    winner: { concept: string; distance: number; confidence: number } | null;
    candidates: Array<{ concept: string; distance: number; confidence: number }>;
    ambiguous: boolean;
  }> {
    const maxDistance = opts?.maxDistance ?? 160;
    const maxResults = opts?.maxResults ?? 3;
    const minMargin = opts?.minMargin ?? 12;

    const allConcepts = await this.storage.getAllHdcConcepts();
    const TOTAL_BITS = D_ADDR_UINT32 * 32;

    // We need hammingDistance from sdmEngine
    // Note: It's cleaner to import hammingDistance at the top of the file
    // Assumes hammingDistance is exported in sdmEngine.ts. We will add the import.
    
    // Sort concepts by distance
    const scored = allConcepts.map(c => {
      const diff = hammingDistance(query, c.vector);
      return {
        concept: c.concept,
        distance: diff,
        confidence: 1 - diff / TOTAL_BITS
      };
    });

    scored.sort((a, b) => a.distance - b.distance);
    const candidates = scored.slice(0, maxResults);

    if (candidates.length === 0 || candidates[0].distance > maxDistance) {
      return { winner: null, candidates, ambiguous: false };
    }

    if (candidates.length > 1) {
      const margin = candidates[1].distance - candidates[0].distance;
      if (margin < minMargin) {
        return { winner: null, candidates, ambiguous: true };
      }
    }

    return { winner: candidates[0], candidates, ambiguous: false };
  }
}
