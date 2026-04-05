import type { Client } from "@libsql/client";
import type { SpreadingActivationOptions, SemanticSearchResult } from "../storage/interface.js";
import { debugLog } from "../utils/logger.js";

/**
 * Apply ACT-R inspired Spreading Activation, Lateral Inhibition, and Fan Effect.
 * It traverses the `memory_links` table over T iterations starting from the given anchors.
 */
export async function applySpreadingActivation(
  db: Client,
  anchors: SemanticSearchResult[],
  options: SpreadingActivationOptions,
  userId: string
): Promise<SemanticSearchResult[]> {
  if (!options.enabled || anchors.length === 0) return anchors;

  const T = options.iterations ?? 3;
  const S = options.spreadFactor ?? 0.8;
  const softM = 20; // Soft lateral inhibition during propagation
  const finalM = options.lateralInhibition ?? 7; // Final hard lateral inhibition

  // State: current activation score for nodes.
  let activeNodes = new Map<string, number>();
  
  for (const anchor of anchors) {
    activeNodes.set(anchor.id, anchor.similarity || 1.0);
  }

  for (let t = 0; t < T; t++) {
    const nextNodes = new Map<string, number>();
    
    // Preserve existing activation: a_i^(t+1) = a_i^(t) + incoming
    for (const [id, score] of activeNodes.entries()) {
      nextNodes.set(id, score);
    }

    const currentIds = Array.from(activeNodes.keys());
    if (currentIds.length === 0) break;

    const placeholders = currentIds.map(() => '?').join(',');
    
    // Fetch edges connected to active nodes with LIMIT to prevent explosion on hub nodes.
    const edgeQuery = `
      SELECT source_id, target_id, strength
      FROM memory_links 
      WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})
      LIMIT 200
    `;
    const edgeArgs = [...currentIds, ...currentIds];
    const edgeRes = await db.execute({ sql: edgeQuery, args: edgeArgs });
    
    // Compute out-degree (Fan Effect) directly from fetched edge rows
    // instead of a separate SQL round-trip — halves query count per iteration.
    const fanMap = new Map<string, number>();
    for (const row of edgeRes.rows) {
      const src = row.source_id as string;
      if (activeNodes.has(src)) {
        fanMap.set(src, (fanMap.get(src) || 0) + 1);
      }
    }

    for (const row of edgeRes.rows) {
      const source = row.source_id as string;
      const target = row.target_id as string;
      const strength = Number(row.strength);

      // Forward flow: Source is active, flows to Target
      if (activeNodes.has(source)) {
         const fan = fanMap.get(source) || 1;
         // Dampened fan effect: instead of strict 1/fan, we use 1 / ln(fan + e)
         const dampedFan = Math.log(fan + Math.E); 
         const flow = S * (strength * activeNodes.get(source)! / dampedFan);
         
         nextNodes.set(target, (nextNodes.get(target) || 0) + flow);
      }
      
      // Backward flow: Target is active, flows backward to Source with a heavier penalty
      if (activeNodes.has(target)) {
         const flow = (S * 0.5) * (strength * activeNodes.get(target)!);
         nextNodes.set(source, (nextNodes.get(source) || 0) + flow);
      }
    }

    // Soft lateral inhibition: Keep only top softM candidates to prevent explosion
    const sorted = Array.from(nextNodes.entries()).sort((a, b) => b[1] - a[1]);
    activeNodes = new Map(sorted.slice(0, softM));
  }

  // Final evaluation
  const finalIds = Array.from(activeNodes.keys()).slice(0, finalM);
  
  const anchorMap = new Map<string, SemanticSearchResult>();
  for (const a of anchors) anchorMap.set(a.id, a);

  const finalResults: SemanticSearchResult[] = [];
  
  const missingIds = finalIds.filter(id => !anchorMap.has(id));
  if (missingIds.length > 0) {
    const placeholders = missingIds.map(() => '?').join(',');
    const missingQuery = `
      SELECT id, project, summary, session_date, decisions, files_changed
      FROM session_ledger
      WHERE id IN (${placeholders}) AND deleted_at IS NULL AND user_id = ?
    `;
    const missingRes = await db.execute({ sql: missingQuery, args: [...missingIds, userId] });
    
    for (const row of missingRes.rows) {
      anchorMap.set(row.id as string, {
        id: row.id as string,
        project: row.project as string,
        summary: row.summary as string,
        session_date: row.session_date as string | undefined,
        decisions: row.decisions && typeof row.decisions === 'string' ? JSON.parse(row.decisions) : undefined,
        files_changed: row.files_changed && typeof row.files_changed === 'string' ? JSON.parse(row.files_changed) : undefined,
        similarity: 0.0 // Base similarity is 0 since it wasn't matched originally
      });
    }
  }

  // Compute Hybrid Score and return M nodes
  for (const id of finalIds) {
    if (anchorMap.has(id)) {
      const node = anchorMap.get(id)!;
      const activationScore = activeNodes.get(id) || 0;
      node.activationScore = activationScore;
      
      // Hybrid blend: 70% original match relevance, 30% activation structural energy
      node.hybridScore = (node.similarity * 0.7) + (activationScore * 0.3); 
      
      finalResults.push(node);
    }
  }
  
  // Sort descending by Hybrid Score
  return finalResults.sort((a, b) => (b.hybridScore || 0) - (a.hybridScore || 0));
}
