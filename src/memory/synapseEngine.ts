/**
 * Synapse — Spreading Activation Engine (v8.0)
 *
 * ═══════════════════════════════════════════════════════════════════
 * PURPOSE:
 *   Multi-hop energy propagation through the memory_links graph.
 *   Replaces both the old SQL-coupled spreadingActivation.ts AND the
 *   shallow 1-hop candidateScopedSpreadingActivation() from v7.0.
 *
 * PAPER BASIS:
 *   ACT-R spreading activation (Anderson, 2004) extended with:
 *   - Dampened fan effect: 1/ln(degree + e)
 *   - Asymmetric bidirectional flow (forward 100%, backward 50%)
 *   - Lateral inhibition (soft cap per iteration, hard cap on output)
 *   - Visited-edge tracking to prevent cyclic energy amplification
 *
 * DESIGN:
 *   All functions are PURE — zero I/O, zero imports from storage or SQL.
 *   Link data is fetched via a LinkFetcher callback injected by the caller
 *   (SqliteStorage, SupabaseStorage, or test mock).
 *   NOTE: debugLog (stderr diagnostic) is the sole side effect — it only
 *   fires when PRISM_DEBUG_LOGGING=true and does not affect correctness.
 *
 * PERFORMANCE:
 *   Bounded by O(T × softCap) where T=iterations (default 3) and
 *   softCap=20. Worst case: 3 × 20 node expansions = 60 link fetches.
 *   Typical latency: 5-15ms on SQLite.
 *
 * FILES THAT IMPORT THIS:
 *   - src/storage/sqlite.ts (search methods)
 *   - src/tools/graphHandlers.ts (ACT-R re-ranking pipeline)
 * ═══════════════════════════════════════════════════════════════════
 */

import { debugLog } from "../utils/logger.js";

// ─── Types ────────────────────────────────────────────────────

/**
 * A single edge in the memory_links graph.
 */
export interface LinkEdge {
  source_id: string;
  target_id: string;
  strength: number;
}

/**
 * Async callback to batch-fetch links for a set of node IDs.
 * Returns ALL links where source_id OR target_id is in the given set.
 * No global LIMIT — the engine controls explosion via soft caps.
 *
 * Implementations:
 *   SQLite:   SELECT source_id, target_id, strength FROM memory_links
 *             WHERE source_id IN (?) OR target_id IN (?)
 *   Supabase: .from('memory_links').select('*').or(...)
 *   Tests:    Return static arrays
 */
export type LinkFetcher = (nodeIds: string[]) => Promise<LinkEdge[]>;

/**
 * Engine configuration. All fields have safe defaults.
 */
export interface SynapseConfig {
  /** T — propagation depth. 0 = return anchors unchanged. Default: 3 */
  iterations: number;
  /** S — energy attenuation per hop. Must be < 1.0 for convergence. Default: 0.8 */
  spreadFactor: number;
  /** M — hard cap on final output. Default: 7 */
  lateralInhibition: number;
  /** Soft limit on active nodes per iteration. Prevents combinatorial explosion. Default: 20 */
  softCap: number;
}

/**
 * Per-node result from the Synapse engine.
 */
export interface SynapseResult {
  /** Memory entry UUID */
  id: string;
  /** Total accumulated activation energy after all iterations */
  activationEnergy: number;
  /** Minimum hop distance from any anchor node */
  hopsFromAnchor: number;
  /** true if this node was NOT in the original anchor set (discovered via graph traversal) */
  isDiscovered: boolean;
}

/**
 * Telemetry data emitted after each Synapse run for observability.
 */
export interface SynapseTelemetry {
  /** Total nodes in final output */
  nodesReturned: number;
  /** Nodes that were discovered (not in original anchors) */
  nodesDiscovered: number;
  /** Maximum activation energy in the result set */
  maxActivationEnergy: number;
  /** Average activation energy across all results */
  avgActivationEnergy: number;
  /** Number of link-fetch iterations performed */
  iterationsPerformed: number;
  /** Total edges traversed across all iterations */
  edgesTraversed: number;
  /** Execution time in milliseconds */
  durationMs: number;
}

// ─── Default Configuration ────────────────────────────────────

export const DEFAULT_SYNAPSE_CONFIG: SynapseConfig = {
  iterations: 3,
  spreadFactor: 0.8,
  lateralInhibition: 7,
  softCap: 20,
};

// ─── Sigmoid Normalization ────────────────────────────────────

/**
 * Squash activation energy into [0, 1] using a parameterized sigmoid.
 *
 * This prevents raw activation energy from overpowering the similarity
 * component in the hybrid score. Without normalization, a node with
 * 10 inbound paths could accumulate energy > 5.0, making the 0.3 weight
 * mathematically dominate the 0.7 similarity weight.
 *
 * Calibration:
 *   midpoint = 0.5 — an activation of 0.5 maps to sigmoid output 0.5
 *   steepness = 2.0 — moderate discrimination
 *
 * @param energy - Raw accumulated activation energy
 * @returns Normalized energy in (0, 1)
 */
export function normalizeActivationEnergy(energy: number): number {
  if (!Number.isFinite(energy)) {
    return energy > 0 ? 1.0 : 0.0;
  }
  const midpoint = 0.5;
  const steepness = 2.0;
  const exponent = -steepness * (energy - midpoint);
  if (exponent > 500) return 0;
  if (exponent < -500) return 1;
  return 1 / (1 + Math.exp(exponent));
}

// ─── Core Engine ──────────────────────────────────────────────

/**
 * Propagate activation energy through the memory_links graph.
 *
 * Algorithm:
 *   1. Initialize active nodes with anchor similarity scores
 *   2. For each iteration:
 *      a. Fetch ALL links connected to active nodes (via LinkFetcher)
 *      b. Compute per-source fan effect: 1 / ln(out-degree + e)
 *      c. Forward flow: source → target at S × strength × sourceEnergy / dampedFan
 *      d. Backward flow: target → source at (S × 0.5) × strength × targetEnergy
 *      e. Track visited edges to prevent cyclic re-traversal
 *      f. Soft lateral inhibition: keep top-softCap nodes
 *   3. Final lateral inhibition: return top-M nodes
 *
 * @param anchors - Map of entry ID → initial activation (typically similarity score)
 * @param linkFetcher - Async callback to batch-fetch links
 * @param config - Engine configuration (uses defaults if omitted)
 * @returns Array of SynapseResult sorted by activationEnergy descending
 */
export async function propagateActivation(
  anchors: Map<string, number>,
  linkFetcher: LinkFetcher,
  config: Partial<SynapseConfig> = {},
): Promise<{ results: SynapseResult[]; telemetry: SynapseTelemetry }> {
  const startMs = performance.now();
  const cfg: SynapseConfig = { ...DEFAULT_SYNAPSE_CONFIG, ...config };

  // Validate: spreadFactor must be < 1.0 for convergence guarantee
  if (cfg.spreadFactor >= 1.0) {
    debugLog(`[synapse] WARNING: spreadFactor=${cfg.spreadFactor} >= 1.0, clamping to 0.99`);
    cfg.spreadFactor = 0.99;
  }
  // Clamp minimums to prevent silent result drops
  if (cfg.lateralInhibition < 1) cfg.lateralInhibition = 1;
  if (cfg.softCap < 1) cfg.softCap = 1;

  // State: current activation energy per node
  let activeNodes = new Map<string, number>();
  // Track minimum hop distance from any anchor
  const hopDistance = new Map<string, number>();
  // Track visited edges to prevent cyclic re-traversal
  const visitedEdges = new Set<string>();
  // Total edges traversed for telemetry
  let totalEdgesTraversed = 0;

  // Initialize with anchor scores
  for (const [id, score] of anchors) {
    activeNodes.set(id, score);
    hopDistance.set(id, 0);
  }

  // Short-circuit: no iterations = return anchors as-is
  if (cfg.iterations <= 0 || anchors.size === 0) {
    const results = buildResults(activeNodes, anchors, hopDistance, cfg.lateralInhibition);
    return {
      results,
      telemetry: buildTelemetry(results, anchors, 0, 0, startMs),
    };
  }

  // ─── Propagation Loop ────────────────────────────────────
  for (let t = 0; t < cfg.iterations; t++) {
    const currentIds = Array.from(activeNodes.keys());
    if (currentIds.length === 0) break;

    // Fetch ALL links connected to currently active nodes
    // No global LIMIT — engine controls explosion via softCap
    let edges: LinkEdge[];
    try {
      edges = await linkFetcher(currentIds);
    } catch (err) {
      debugLog(`[synapse] Link fetch failed at iteration ${t} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      break;
    }

    totalEdgesTraversed += edges.length;

    // Compute out-degree per active source node (for forward fan effect)
    const outDegree = new Map<string, number>();
    for (const edge of edges) {
      if (activeNodes.has(edge.source_id)) {
        outDegree.set(edge.source_id, (outDegree.get(edge.source_id) || 0) + 1);
      }
    }

    // Compute in-degree per active target node (for backward fan effect)
    const inDegree = new Map<string, number>();
    for (const edge of edges) {
      if (activeNodes.has(edge.target_id)) {
        inDegree.set(edge.target_id, (inDegree.get(edge.target_id) || 0) + 1);
      }
    }

    // Next-iteration activation: starts with current values (activation persists)
    const nextNodes = new Map<string, number>(activeNodes);

    for (const edge of edges) {
      const edgeKey = `${edge.source_id}->${edge.target_id}`;
      const strength = Number.isFinite(edge.strength) ? Math.max(0, Math.min(1, edge.strength)) : 0;

      // ── Forward flow: source is active, flows to target ──
      if (activeNodes.has(edge.source_id) && !visitedEdges.has(edgeKey)) {
        visitedEdges.add(edgeKey);
        const sourceEnergy = activeNodes.get(edge.source_id)!;
        const degree = outDegree.get(edge.source_id) || 1;
        // Dampened fan effect: prevents hub nodes from broadcasting equally
        const dampedFan = Math.log(degree + Math.E);
        const flow = cfg.spreadFactor * (strength * sourceEnergy / dampedFan);

        nextNodes.set(edge.target_id, (nextNodes.get(edge.target_id) || 0) + flow);

        // Track hop distance (minimum)
        const sourceHops = hopDistance.get(edge.source_id) ?? 0;
        const currentTargetHops = hopDistance.get(edge.target_id);
        if (currentTargetHops === undefined || sourceHops + 1 < currentTargetHops) {
          hopDistance.set(edge.target_id, sourceHops + 1);
        }
      }

      // ── Backward flow: target is active, flows backward to source at 50% ──
      const reverseEdgeKey = `${edge.target_id}->${edge.source_id}`;
      if (activeNodes.has(edge.target_id) && !visitedEdges.has(reverseEdgeKey)) {
        visitedEdges.add(reverseEdgeKey);
        const targetEnergy = activeNodes.get(edge.target_id)!;
        // Dampened fan effect for backward flow: prevents hub nodes with many
        // inbound edges from blasting energy to all sources equally.
        const inDegreeCount = inDegree.get(edge.target_id) || 1;
        const dampedFanBack = Math.log(inDegreeCount + Math.E);
        const flow = (cfg.spreadFactor * 0.5) * (strength * targetEnergy / dampedFanBack);

        nextNodes.set(edge.source_id, (nextNodes.get(edge.source_id) || 0) + flow);

        // Track hop distance for backward discoveries
        const targetHops = hopDistance.get(edge.target_id) ?? 0;
        const currentSourceHops = hopDistance.get(edge.source_id);
        if (currentSourceHops === undefined || targetHops + 1 < currentSourceHops) {
          hopDistance.set(edge.source_id, targetHops + 1);
        }
      }
    }

    // Soft lateral inhibition: keep only top-softCap nodes to prevent explosion
    const sorted = Array.from(nextNodes.entries()).sort((a, b) => b[1] - a[1]);
    activeNodes = new Map(sorted.slice(0, cfg.softCap));
  }

  // ─── Final Output ────────────────────────────────────────
  const results = buildResults(activeNodes, anchors, hopDistance, cfg.lateralInhibition);

  return {
    results,
    telemetry: buildTelemetry(results, anchors, cfg.iterations, totalEdgesTraversed, startMs),
  };
}


// ─── Helpers ──────────────────────────────────────────────────

function buildResults(
  activeNodes: Map<string, number>,
  anchors: Map<string, number>,
  hopDistance: Map<string, number>,
  lateralInhibition: number,
): SynapseResult[] {
  // Sort by activation energy descending, then apply hard lateral inhibition
  const sorted = Array.from(activeNodes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, lateralInhibition);

  return sorted.map(([id, energy]) => ({
    id,
    activationEnergy: energy,
    hopsFromAnchor: hopDistance.get(id) ?? 0,
    isDiscovered: !anchors.has(id),
  }));
}

function buildTelemetry(
  results: SynapseResult[],
  anchors: Map<string, number>,
  iterations: number,
  edgesTraversed: number,
  startMs: number,
): SynapseTelemetry {
  const energies = results.map(r => r.activationEnergy);
  const discovered = results.filter(r => !anchors.has(r.id)).length;

  return {
    nodesReturned: results.length,
    nodesDiscovered: discovered,
    maxActivationEnergy: energies.length > 0 ? Math.max(...energies) : 0,
    avgActivationEnergy: energies.length > 0
      ? energies.reduce((a, b) => a + b, 0) / energies.length
      : 0,
    iterationsPerformed: iterations,
    edgesTraversed,
    durationMs: Math.round(performance.now() - startMs),
  };
}
