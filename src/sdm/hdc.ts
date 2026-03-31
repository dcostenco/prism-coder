export class HDCEngine {
  /**
   * BIND (Multiplication): Associates two concepts together.
   * Uses bitwise XOR over Uint32Arrays to create an orthogonal vector.
   */
  static bind(vecA: Uint32Array, vecB: Uint32Array): Uint32Array {
    if (vecA.length !== vecB.length) {
      throw new Error("Vector lengths must match for HDC binding.");
    }
    const result = new Uint32Array(vecA.length);
    for (let i = 0; i < vecA.length; i++) {
      result[i] = (vecA[i] ^ vecB[i]) >>> 0;
    }
    return result;
  }

  /**
   * UNBIND: Extracting a concept.
   * In binary HDC, unbinding and binding are identical operations (XOR).
   */
  static unbind(boundVec: Uint32Array, knownVec: Uint32Array): Uint32Array {
    return this.bind(boundVec, knownVec);
  }

  /**
   * BUNDLE (Addition): Combines a set of vectors using Majority Vote.
   * Ideal for grouping short lists (3-7 concepts). Uses a deterministic
   * tie-breaker (inherits from vectors[0]) if an even number of vectors
   * results in a tie, preserving ~50% bit density.
   */
  static bundle(vectors: Uint32Array[]): Uint32Array {
    if (!vectors.length) throw new Error("Must provide at least one vector to bundle.");
    
    const numVecs = vectors.length;
    const wordLength = vectors[0].length;
    const result = new Uint32Array(wordLength);

    for (let wordIdx = 0; wordIdx < wordLength; wordIdx++) {
      let resultWord = 0;
      for (let bitIdx = 0; bitIdx < 32; bitIdx++) {
        let count = 0;
        const mask = 1 << bitIdx;
        for (let v = 0; v < numVecs; v++) {
          if ((vectors[v][wordIdx] & mask) !== 0) count++;
        }
        
        if (count > numVecs / 2) {
          resultWord |= mask;
        } else if (count === numVecs / 2) {
          // Tie-breaker: use bit from the first vector to prevent density collapse
          if ((vectors[0][wordIdx] & mask) !== 0) {
            resultWord |= mask;
          }
        }
      }
      result[wordIdx] = resultWord >>> 0; // ensure unsigned
    }
    return result;
  }

  /**
   * PERMUTE: Circular shift left by 1 bit across the entire array.
   * Useful for sequence encoding (e.g., A -> B) ensuring non-commutative relationships.
   */
  static permute(vec: Uint32Array): Uint32Array {
    const result = new Uint32Array(vec.length);
    if (vec.length === 0) return result;
    
    // Circular shift left: 
    // vec[i] is shifted left by 1. The MSB of vec[i+1] moves into the LSB of vec[i].
    // The MSB of vec[0] wraps around to the LSB of vec[vec.length - 1].
    
    const wrapBit = (vec[0] >>> 31) & 1;
    
    for (let i = 0; i < vec.length - 1; i++) {
        const nextMsb = (vec[i + 1] >>> 31) & 1;
        result[i] = ((vec[i] << 1) | nextMsb) >>> 0;
    }
    result[vec.length - 1] = ((vec[vec.length - 1] << 1) | wrapBit) >>> 0;
    
    return result;
  }
}
