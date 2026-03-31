import { getStorage } from "../storage/index.js";
import { getDefaultCompressor, deserialize, CompressedEmbedding } from "../utils/turboquant.js";
import { debugLog } from "../utils/logger.js";

export interface SdmRecallMatch {
  id: string;
  summary: string;
  distance: number; // Hamming distance
  similarity: number; // Normalized (1 - distance / bits)
}

/**
 * Perform a fast JS-space Hamming distance scan across TurboQuant compressed embeddings.
 * Used exclusively for decoding SDM superposed target vectors back into ledger entries.
 *
 * PLATFORM CONSTRAINT: Both sdmEngine.ts (DataView LE) and this decoder (TypedArray views)
 * assume Little-Endian host byte order. This is universal on Node.js/V8 (x86, ARM, WASM)
 * but would produce incorrect results on hypothetical Big-Endian V8 targets.
 */
export async function decodeSdmVector(
  project: string,
  targetVector: Float32Array,
  matchCount: number = 5,
  similarityThreshold: number = 0.55
): Promise<SdmRecallMatch[]> {
  const t0 = performance.now();
  const storage = await getStorage();
  
  // 1. Fetch all compressed embeddings for the active project
  const embeddings = await storage.getAllProjectEmbeddings(project);
  if (embeddings.length === 0) {
    debugLog(`[SdmDecoder] No embeddings found for project ${project}`);
    return [];
  }

  // 2. Compress the target Float32Array into a 96-byte Uint8Array using TurboQuant
  const compressor = getDefaultCompressor();
  // compressor.compress takes number[] — copy via for-loop to avoid Array.from GC pressure
  const queryArray: number[] = new Array(targetVector.length);
  for (let i = 0; i < targetVector.length; i++) queryArray[i] = targetVector[i];
  const compressedTarget = compressor.compress(queryArray);
  const targetQjl = compressedTarget.qjlSigns;

  // Ensure byte length aligns with 32-bit words for fast XOR
  // We copy the target Uint8Array into a perfectly aligned Int32Array buffer
  const wordCount = targetQjl.length / 4;
  const targetWords = new Int32Array(wordCount);
  new Uint8Array(targetWords.buffer).set(targetQjl);

  // 3. Scan all DB embeddings and compute Hamming distance on QJL signs
  const matches: SdmRecallMatch[] = [];
  
  // Pre-allocate scratchpad Int32Array to avoid GC pressure during decoding sweeps
  const dbWords = new Int32Array(wordCount);
  const dbBytes = new Uint8Array(dbWords.buffer);
  
  for (const entry of embeddings) {
    try {
      const dbBuf = Buffer.from(entry.embedding_compressed.replace(/^v1\./, ""), "base64");
      const compressedDb = deserialize(dbBuf);
      const dbQjl = compressedDb.qjlSigns;

      if (dbQjl.length !== targetQjl.length) continue;
      
      // Zero-allocation copy into the scratchpad
      dbBytes.set(dbQjl);

      let hammingDistance = 0;

      for (let i = 0; i < wordCount; i++) {
        // Bitwise XOR to find mismatched bits
        let xor = targetWords[i] ^ dbWords[i];
        
        // Brian Kernighan's algorithm or V8 Math.clz32 trick isn't natively popcnt,
        // but simple bitwise popcount is fast enough in V8:
        xor = xor - ((xor >>> 1) & 0x55555555);
        xor = (xor & 0x33333333) + ((xor >>> 2) & 0x33333333);
        hammingDistance += Math.imul((xor + (xor >>> 4)) & 0x0F0F0F0F, 0x01010101) >>> 24;
      }

      // Convert distance to standard similarity score (1.0 = exact match)
      const totalBits = targetQjl.byteLength * 8;
      const similarity = 1 - (hammingDistance / totalBits);

      if (similarity >= similarityThreshold) {
        matches.push({
          id: entry.id,
          summary: entry.summary,
          distance: hammingDistance,
          similarity
        });
      }
    } catch (err) {
      // Ignore malformed embeddings
      continue;
    }
  }

  // 4. Sort by highest similarity
  matches.sort((a, b) => b.similarity - a.similarity);
  const topMatches = matches.slice(0, matchCount);

  const t1 = performance.now();
  debugLog(`[SdmDecoder] Decoded target vector against ${embeddings.length} entries in ${(t1 - t0).toFixed(2)}ms`);

  return topMatches;
}
