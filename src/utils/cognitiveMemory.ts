import { getStorage } from "../storage/index.js";
import { debugLog } from "./logger.js";

/**
 * Computes the effective importance of a memory using the Ebbinghaus Decay Formula.
 * Formula: Effective = Base * (0.95 ^ DaysSinceLastAccess)
 * 
 * @param baseImportance The raw importance score of the memory.
 * @param lastAccessedStr ISO string representing the last access time.
 * @param createdAtStr ISO string representing creation time (fallback).
 * @returns The decayed effective importance score, rounded to 2 decimal places.
 */
export function computeEffectiveImportance(
    baseImportance: number,
    lastAccessedStr: string | null | undefined,
    createdAtStr: string
): number {
    if (baseImportance <= 0) return baseImportance;

    const now = Date.now();
    
    // Fallback to creation date if it has never been accessed
    const referenceDateStr = lastAccessedStr || createdAtStr;
    const referenceTime = new Date(referenceDateStr).getTime();
    
    // Calculate difference in days (preventing negative time decay if clocks skew)
    const diffMs = Math.max(0, now - referenceTime);
    const daysSinceAccess = diffMs / (1000 * 60 * 60 * 24);
    
    // Apply 5% decay per day
    const effective = baseImportance * Math.pow(0.95, daysSinceAccess);
    
    // Round to 2 decimal places for clean UI output
    return Math.round(effective * 100) / 100;
}

/**
 * Fire-and-forget helper to update the last_accessed_at timestamp for retrieved memories.
 * 
 * @param ids Array of memory IDs that were just accessed
 */
export function updateLastAccessed(ids: string[]): void {
    if (!ids || ids.length === 0) return;
    
    const now = new Date().toISOString();
    
    // Fire and forget, don't block execution
    getStorage().then(storage => {
        if (typeof storage.updateLastAccessed === 'function') {
            storage.updateLastAccessed(ids).catch(error => {
                debugLog(`[CognitiveMemory] Failed to update last_accessed_at: ${error instanceof Error ? error.message : String(error)}`);
            });
        } else {
            // Fallback for older interface implementation
            Promise.allSettled(
                ids.map(id => storage.patchLedger(id, { last_accessed_at: now }))
            ).then(() => {
                debugLog(`[CognitiveMemory] Updated last_accessed_at for ${ids.length} memories.`);
            });
        }
    }).catch(error => {
        debugLog(`[CognitiveMemory] Failed to get storage backend for last_accessed_at update: ${error instanceof Error ? error.message : String(error)}`);
    });
}
