/**
 * Task Router Handler (v9.1.0)
 *
 * Pure, deterministic heuristic-based routing engine that analyzes a coding
 * task description and recommends whether it should be handled by the host
 * cloud model or delegated to the local claw-code-agent (deepseek-r1 / qwen2.5-coder).
 *
 * No database queries in the pure route. No API calls. Fully testable.
 * Experience-based ML bias (v7.2.0+) is applied post-hoc in the handler.
 *
 * Heuristic Signals:
 *   1. Keyword analysis        (weight: 0.35)
 *   2. File count               (weight: 0.15)
 *   3. File type / extension    (weight: 0.10)
 *   4. estimated_scope enum     (weight: 0.20)
 *   5. Task length proxy        (weight: 0.10)
 *   6. Multi-step detection     (weight: 0.10)
 */

import {
  type SessionTaskRouteArgs,
  isSessionTaskRouteArgs,
} from "./sessionMemoryDefinitions.js";

import { getStorage } from "../storage/index.js";
import { getExperienceBias } from "./routerExperience.js";
import { toKeywordArray } from "../utils/keywordExtractor.js";

import {
  PRISM_TASK_ROUTER_CONFIDENCE_THRESHOLD,
  PRISM_TASK_ROUTER_MAX_CLAW_COMPLEXITY,
} from "../config.js";

// ─── Types ───────────────────────────────────────────────────

export interface TaskRouteResult {
  target: "claw" | "host";
  confidence: number;
  complexity_score: number;
  rationale: string;
  recommended_tool: string | null;
  experience?: {
    bias: number;
    sample_count: number;
    rationale: string;
  };
  _rawComposite?: number;
}

// ─── Keyword Lists ───────────────────────────────────────────

/** Keywords that suggest the task is simple enough for the local agent. */
const CLAW_KEYWORDS = [
  "create file", "add file", "new file", "scaffold",
  "boilerplate", "template", "stub", "skeleton",
  "rename", "move file", "copy file",
  "add test", "write test", "unit test", "add a test",
  "add import", "add export", "add dependency",
  "fix typo", "fix spelling", "fix formatting", "fix lint",
  "add comment", "add docstring", "add jsdoc",
  "simple", "straightforward", "trivial", "quick",
  "update version", "bump version",
  "add field", "add column", "add property",
  "remove unused", "delete unused", "clean up",
];

/** Keywords that suggest the task requires the host model's reasoning. */
const HOST_KEYWORDS = [
  "architect", "architecture", "redesign", "design system",
  "debug complex", "investigate", "root cause", "diagnose",
  "security audit", "vulnerability", "penetration",
  "refactor entire", "restructure", "rewrite",
  "multi-step", "multi-phase", "orchestrate",
  "optimize performance", "performance audit",
  "migration strategy", "data migration",
  "api design", "schema design", "database design",
  "code review", "review the", "analyze the",
  "explain how", "explain why", "understand",
  "complex logic", "algorithm", "concurrent", "race condition",
  "integrate multiple", "cross-cutting",
  "plan", "strategy", "roadmap",
];

/** Conjunctions and sequential markers that indicate multi-step tasks. */
const MULTI_STEP_MARKERS = [
  "and then", "after that", "once done", "next step",
  "first,", "second,", "third,", "finally,",
  "step 1", "step 2", "step 3",
  "then update", "then modify", "then create",
  "followed by", "subsequently",
  // Note: removed bare "1.", "2.", "3." — too many false positives
  // on version numbers (v1.2.3), decimals, and IP addresses.
];

// ─── Heuristic Engine ────────────────────────────────────────

/**
 * Count how many keywords from a list appear in the text (case-insensitive).
 * Returns the count, not a boolean — more matches = stronger signal.
 */
function countKeywordHits(text: string, keywords: readonly string[]): number {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) hits++;
  }
  return hits;
}

/**
 * Compute a claw-affinity score from keyword analysis.
 * Returns a value between -1.0 (strongly host) and +1.0 (strongly claw).
 */
function keywordSignal(description: string): number {
  const clawHits = countKeywordHits(description, CLAW_KEYWORDS);
  const hostHits = countKeywordHits(description, HOST_KEYWORDS);
  const total = clawHits + hostHits;
  if (total === 0) return 0; // No signal — neutral
  // Normalized difference: positive = claw, negative = host
  return (clawHits - hostHits) / total;
}

/**
 * Compute a claw-affinity score from file count.
 * ≤2 files → strongly claw (+1.0)
 * 3 files → moderate claw (+0.5)
 * 4-5 files → neutral (0.0)
 * >5 files → host-favoring (-1.0)
 */
function fileCountSignal(files: string[] | undefined): number {
  if (!files || files.length === 0) return 0; // No signal
  const count = files.length;
  if (count <= 2) return 1.0;
  if (count === 3) return 0.5;
  if (count <= 5) return 0.0;
  return -1.0;
}

/**
 * Compute a claw-affinity score from file extentions.
 * Simple configs/docs -> claw (+0.5)
 * Complex low-level languages -> host (-0.5)
 */
function fileTypeSignal(files: string[] | undefined): number {
  if (!files || files.length === 0) return 0;
  
  let simple = 0;
  let complex = 0;
  
  for (const f of files) {
    if (f.match(/\.(md|json|yml|yaml|txt|csv|env|ini|toml|cfg)$/i)) simple++;
    else if (f.match(/\.(cpp|cc|cxx|c|h|hpp|rs|go|java|swift|zig)$/i)) complex++;
    // .ts, .js, .py, .rb, .sh, .css, .html — common scripting/web langs stay neutral (0)
  }
  
  if (simple > 0 && complex === 0) return 0.5;
  if (complex > 0 && simple === 0) return -0.5;
  if (complex > 0 && simple > 0) return -0.2; // Complex outweighs simple
  return 0;
}

/**
 * Compute a claw-affinity score from scope.
 * minor_edit → strongly claw (+1.0)
 * bug_fix → moderate claw (+0.4) — some bugs are complex
 * new_feature → moderate host (-0.3)
 * refactor → strongly host (-0.8)
 */
function scopeSignal(scope: SessionTaskRouteArgs["estimated_scope"]): number {
  switch (scope) {
    case "minor_edit": return 1.0;
    case "bug_fix": return 0.4;
    case "new_feature": return -0.3;
    case "refactor": return -0.8;
    default: return 0; // No scope provided — neutral
  }
}

/**
 * Compute a claw-affinity score from task description length.
 * Short (< 100 chars) → strongly claw (+1.0)
 * Short-medium (< 200 chars) → claw (+0.5)
 * Medium (200-500 chars) → neutral (0.0)
 * Long (500-1500 chars) → host-favoring (-0.5)
 * Very long (> 1500 chars) → strongly host (-1.0) due to context complexity
 */
function lengthSignal(description: string): number {
  const len = description.length;
  if (len < 100) return 1.0;
  if (len < 200) return 0.5;
  if (len <= 500) return 0.0;
  if (len <= 1500) return -0.5;
  return -1.0;
}

/**
 * Detect multi-step task patterns.
 * Returns -1.0 (host-favoring) if multiple step markers detected,
 * 0.0 otherwise.
 */
function multiStepSignal(description: string): number {
  const hits = countKeywordHits(description, MULTI_STEP_MARKERS);
  if (hits >= 2) return -1.0; // Strong multi-step signal
  if (hits === 1) return -0.4; // Weak multi-step signal
  return 0.0;
}

// ─── Weights ─────────────────────────────────────────────────

const WEIGHTS = {
  keyword: 0.35,
  fileCount: 0.15,
  fileType: 0.10,
  scope: 0.20,
  length: 0.10,
  multiStep: 0.10,
} as const;

// ─── Router Core ─────────────────────────────────────────────

/**
 * Compute the routing recommendation. Pure function.
 */
export function computeRoute(args: SessionTaskRouteArgs): TaskRouteResult {
  const { task_description, files_involved, estimated_scope } = args;

  // ── Cold-start / edge case: insufficient input ──
  if (!task_description || task_description.trim().length < 10) {
    return {
      target: "host",
      confidence: 0.5,
      complexity_score: 5,
      rationale: "Insufficient information for confident routing. Defaulting to host model.",
      recommended_tool: null,
    };
  }

  // ── Compute individual signals ──
  const kw = keywordSignal(task_description);
  const fc = fileCountSignal(files_involved);
  const ft = fileTypeSignal(files_involved);
  const sc = scopeSignal(estimated_scope);
  const ln = lengthSignal(task_description);
  const ms = multiStepSignal(task_description);

  // ── Weighted composite score: [-1.0, +1.0] ──
  // Positive = claw-favoring, Negative = host-favoring
  const composite =
    kw * WEIGHTS.keyword +
    fc * WEIGHTS.fileCount +
    ft * WEIGHTS.fileType +
    sc * WEIGHTS.scope +
    ln * WEIGHTS.length +
    ms * WEIGHTS.multiStep;

  // ── Map composite to complexity score (1-10) ──
  // composite +1.0 → complexity 1 (trivial)
  // composite -1.0 → complexity 10 (very complex)
  const complexityRaw = Math.round(5.5 - composite * 4.5);
  const complexity_score = Math.max(1, Math.min(10, complexityRaw));

  // ── Determine target ──
  const isClaw = composite > 0 && complexity_score <= PRISM_TASK_ROUTER_MAX_CLAW_COMPLEXITY;

  // ── Confidence: distance from the decision boundary ──
  // Higher absolute composite → higher confidence
  const confidence = Math.min(0.99, Math.round((0.5 + Math.abs(composite) * 0.5) * 100) / 100);

  // ── Apply confidence threshold ──
  // If confidence is too low, default to host (safer)
  const target: "claw" | "host" =
    isClaw && confidence >= PRISM_TASK_ROUTER_CONFIDENCE_THRESHOLD ? "claw" : "host";

  // ── Build rationale ──
  const signals: string[] = [];
  if (kw !== 0) signals.push(`keyword analysis ${kw > 0 ? "favors claw" : "favors host"} (${kw.toFixed(2)})`);
  if (fc !== 0) signals.push(`file count signal: ${fc.toFixed(1)}`);
  if (ft !== 0) signals.push(`file type signal: ${ft.toFixed(1)}`);
  if (sc !== 0) signals.push(`scope "${estimated_scope}" signal: ${sc.toFixed(1)}`);
  if (ms !== 0) signals.push(`multi-step detected (${ms.toFixed(1)})`);
  if (ln !== 0) signals.push(`length signal: ${ln.toFixed(1)}`);

  const rationale = target === "claw"
    ? `Task is delegable to the local agent. Signals: ${signals.join("; ") || "neutral"}.`
    : `Task should remain with the host model. Signals: ${signals.join("; ") || "neutral"}.`;

  return {
    target,
    confidence,
    complexity_score,
    rationale,
    recommended_tool: target === "claw" ? "claw_run_task" : null,
    _rawComposite: composite,
  };
}

// ─── MCP Handler ─────────────────────────────────────────────

/**
 * MCP tool handler for session_task_route.
 * Validates args, runs the heuristic engine, returns structured JSON.
 */
export async function sessionTaskRouteHandler(
  args: unknown
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  if (!isSessionTaskRouteArgs(args)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "Invalid arguments. Required: task_description (string). Optional: files_involved (string[]), estimated_scope (minor_edit|new_feature|refactor|bug_fix), project (string).",
          }),
        },
      ],
      isError: true,
    };
  }

  const result = computeRoute(args);

  // v7.2.0: Experience-based bias adjustment
  if (args.project) {
    try {
      const storage = await getStorage();
      const taskKeywords = toKeywordArray(args.task_description);
      const exp = await getExperienceBias(args.project, taskKeywords, storage);

      if (exp.sampleCount >= 5) {
        // Adjust confidence: positive bias → boost claw confidence, negative → reduce
        const adjustedComposite = Math.max(-1.0, Math.min(1.0, (result._rawComposite || 0) + exp.bias));
        
        // Recalculate target and complexity if bias flipped the composite sign
        const complexityRaw = Math.round(5.5 - adjustedComposite * 4.5);
        const complexity_score = Math.max(1, Math.min(10, complexityRaw));
        const isClaw = adjustedComposite > 0 && complexity_score <= PRISM_TASK_ROUTER_MAX_CLAW_COMPLEXITY;
        const confidence = Math.min(0.99, Math.round((0.5 + Math.abs(adjustedComposite) * 0.5) * 100) / 100);
        const target = isClaw && confidence >= PRISM_TASK_ROUTER_CONFIDENCE_THRESHOLD ? "claw" : "host";

        result.target = target;
        result.confidence = confidence;
        result.complexity_score = complexity_score;
        result.recommended_tool = target === "claw" ? "claw_run_task" : null;
        
        result.experience = {
          bias: exp.bias,
          sample_count: exp.sampleCount,
          rationale: exp.rationale,
        };
      }
    } catch (err) {
      // Non-fatal: experience lookup failure should never block routing
      // Note: intentionally throwing away the error to keep the original raw heuristic result.
    }
  }

  // Remove the private field from the final output
  delete result._rawComposite;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}
