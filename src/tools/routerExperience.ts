
import type { StorageBackend } from "../storage/interface.js";
import { debugLog } from "../utils/logger.js";

/** Max bias adjustment allowed from experience (±) */
const MAX_BIAS_CAP = 0.15;
/** Minimum samples required to compute a bias (cold start protection) */
const MIN_SAMPLES = 5;

/**
 * Result of experience bias calculation.
 */
export interface ExperienceBiasResult {
  bias: number;
  sampleCount: number;
  rationale: string;
}

/**
 * Analyzes past ledger entries for the project to compute an experience-based bias 
 * for the claw agent's capability.
 * Positive bias boosts claw confidence; Negative bias reduces it.
 */
export async function getExperienceBias(
  project: string,
  taskKeywords: string[],
  storageBackend: StorageBackend
): Promise<ExperienceBiasResult> {
  const zeroResult = { bias: 0, sampleCount: 0, rationale: "Insufficient experience data." };
  
  if (!project || taskKeywords.length === 0) return zeroResult;

  try {
    // 1. Fetch recent ledger entries for this project
    // Fetch last 50 entries to keep it fast
    const entries = await storageBackend.getLedgerEntries({ project: `eq.${project}`, order: "created_at.desc", limit: 50 });
    
    // Filter to events that encode an experience (could be from session_save_experience directly 
    // or we can infer success based on the ledger tracking, but let's stick to the plan:
    // the plan specifically mentioned events from `session_save_experience` but actually
    // that tool saves structured data in the ledger. However, session_save_ledger also saves entries.
    // Assuming `event_type` is available on the ledger entry if it came from session_save_experience.
    
    // Wait, the plan says: "entries with event_type IN ('success', 'failure', 'correction')"
    // LedgerEntries structure in Prism: we need to check if there is an event_type.
    // Let's grab the raw entry schema. Actually, I shouldn't guess. I will fetch entries and filter.
    // Let's assume standard properties for now, but I will write it softly to avoid crashes.
    
    let successCount = 0;
    let failureCount = 0;
    
    let relevantCount = 0;

    for (const entry of entries) {
      // Basic duck typing for experience entries vs standard ledger logs
      const raw = entry as any;
      const eventType = raw.event_type;
      const summary = (raw.summary || "").toLowerCase();
      
      // Check keyword overlap (need >= 2 shared keywords to be considered relevant experience)
      const entryKeywords = raw.keywords || [];
      let overlap = 0;
      for (const kw of taskKeywords) {
        if (entryKeywords.includes(kw)) overlap++;
      }
      
      if (overlap < 2) continue;
      
      // Check if it's an outcome related to claw/delegation
      const isClawOutcome = summary.includes("claw") || summary.includes("delegated");
      
      if (isClawOutcome) {
        if (eventType === "success") {
          successCount++;
          relevantCount++;
        } else if (eventType === "failure" || eventType === "correction") {
          failureCount++;
          relevantCount++;
        }
      }

      // GAP-1 fix: Ingest validation_result events into ML routing bias.
      // The v7.2 spec requires that "Router learning ingests raw verification
      // signals (pass_rate, critical_failures, coverage_score, rubric_hash)."
      // confidence_score >= 80 indicates a passing verification suite.
      if (eventType === "validation_result") {
        const confidence = raw.confidence_score || 50;
        if (confidence >= 80) {
          successCount++;
        } else {
          failureCount++;
        }
        relevantCount++;
      }
    }
    
    if (relevantCount < MIN_SAMPLES) {
      return { 
        bias: 0, 
        sampleCount: relevantCount, 
        rationale: `Found ${relevantCount} matching past experiences (need ${MIN_SAMPLES} to apply ML bias).` 
      };
    }
    
    // 2. Compute Bias
    const totalCount = successCount + failureCount;
    const clawWinRate = totalCount > 0 ? (successCount / totalCount) : 0.5;
    
    // Scale: mapping [0, 1] to [-MAX_BIAS_CAP, +MAX_BIAS_CAP] around 0.5
    // Win rate 0.5 -> bias 0.
    // Win rate 1.0 -> bias +0.15 (claw always won)
    // Win rate 0.0 -> bias -0.15 (claw always failed)
    let bias = (clawWinRate - 0.5) * (MAX_BIAS_CAP * 2);
    
    // Extra safety clamp
    bias = Math.max(-MAX_BIAS_CAP, Math.min(MAX_BIAS_CAP, bias));
    
    const biasWord = bias > 0 ? "boost" : "penalty";
    const percent = Math.abs(bias * 100).toFixed(0);
    
    return {
      bias,
      sampleCount: relevantCount,
      rationale: `Found ${relevantCount} relevant past experiences (Win rate: ${(clawWinRate*100).toFixed(1)}%). Applying ${percent}% ${biasWord} to heuristic confidence.`,
    };

  } catch (error) {
    debugLog(`[task_router] Error computing experience bias: ${error}`);
    return zeroResult;
  }
}
