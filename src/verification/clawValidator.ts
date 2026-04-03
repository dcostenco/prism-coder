/**
 * Claw-as-Validator (v7.2.0)
 *
 * Adversarial validation layer that delegates assertion generation
 * to the local Claw agent. When the host model produces a plan with
 * test_assertions.json, the clawValidator can:
 *
 *  1. Review the assertions for completeness (are all layers covered?)
 *  2. Generate adversarial counter-assertions to stress-test the plan
 *  3. Validate the test suite against the codebase before execution
 *
 * This creates a host ↔ Claw dialectic: the host plans and writes code,
 * Claw validates and challenges, creating a feedback loop that catches
 * issues before the automated verification runner executes.
 *
 * Prerequisites:
 *  - claw-code-agent MCP server must be available
 *  - PRISM_VERIFICATION_HARNESS_ENABLED=true
 */

import { createHash } from "crypto";
import { TestSuiteSchema, type TestSuite } from "./schema.js";

export interface ClawValidationRequest {
  /** The original test_assertions.json content */
  suite: TestSuite;
  /** Project context for the Claw agent */
  project: string;
  /** Files involved in the change being verified */
  files_changed: string[];
  /** Optional description of what the host agent did */
  change_summary?: string;
}

export interface ClawValidationResult {
  /** Whether the Claw agent accepted the test suite */
  accepted: boolean;
  /** Issues found by the Claw agent */
  issues: ClawIssue[];
  /** Additional assertions suggested by Claw */
  suggested_assertions: any[];
  /** Raw Claw agent output for debugging */
  raw_output: string;
}

export interface ClawIssue {
  severity: "info" | "warning" | "error";
  message: string;
  assertion_id?: string;
}

/**
 * Build the prompt for Claw validation.
 * The prompt instructs the Claw agent to analyze the test suite
 * and report any missing coverage, logical errors, or improvements.
 */
function buildValidationPrompt(request: ClawValidationRequest): string {
  const assertionSummary = request.suite.tests
    .map(t => `  - [${t.layer}/${t.severity}] ${t.id}: ${t.description}`)
    .join("\n");

  const filesContext = request.files_changed.length > 0
    ? `\nFiles changed:\n${request.files_changed.map(f => `  - ${f}`).join("\n")}`
    : "";

  return `You are a code review validator. Analyze the following test assertion suite for completeness, correctness, and coverage.

Project: ${request.project}
${request.change_summary ? `Change: ${request.change_summary}` : ""}
${filesContext}

Test Assertions:
${assertionSummary}

Full JSON:
${JSON.stringify(request.suite, null, 2)}

Tasks:
1. Check if all layers (data, agent, pipeline) have appropriate coverage
2. Identify any assertions that could produce false positives/negatives
3. Suggest any missing assertions that should be added
4. Flag any assertions with incorrect severity levels

Respond in JSON format:
{
  "accepted": true/false,
  "issues": [{"severity": "info|warning|error", "message": "...", "assertion_id": "optional"}],
  "suggested_assertions": []
}`;
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore parse errors — caller will continue searching
  }
  return null;
}

function extractCodeFenceBlocks(output: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;

  while (cursor < output.length) {
    const start = output.indexOf("```", cursor);
    if (start === -1) break;

    const end = output.indexOf("```", start + 3);
    if (end === -1) break;

    const block = output.slice(start + 3, end);
    const firstNewline = block.indexOf("\n");

    if (firstNewline === -1) {
      blocks.push(block.trim());
    } else {
      const body = block.slice(firstNewline + 1).trim();
      if (body.length > 0) blocks.push(body);
    }

    cursor = end + 3;
  }

  return blocks;
}

function extractBalancedAcceptedObject(output: string): Record<string, unknown> | null {
  const source = output.length > 200_000 ? output.slice(0, 200_000) : output;

  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "{") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let j = i; j < source.length; j++) {
      const ch = source[j];

      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === "{") {
        depth++;
        continue;
      }

      if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = source.slice(i, j + 1);
          const parsed = tryParseObject(candidate);
          if (parsed && Object.prototype.hasOwnProperty.call(parsed, "accepted")) {
            return parsed;
          }
          break;
        }

        if (depth < 0) break;
      }
    }
  }

  return null;
}

function parseClawJsonOutput(output: string): Record<string, unknown> | null {
  const direct = tryParseObject(output.trim());
  if (direct && Object.prototype.hasOwnProperty.call(direct, "accepted")) {
    return direct;
  }

  for (const block of extractCodeFenceBlocks(output)) {
    const parsed = tryParseObject(block);
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, "accepted")) {
      return parsed;
    }
  }

  return extractBalancedAcceptedObject(output);
}

function normalizeIssues(rawIssues: unknown): ClawIssue[] {
  if (!Array.isArray(rawIssues)) return [];

  return rawIssues
    .filter((issue): issue is Record<string, unknown> => Boolean(issue) && typeof issue === "object")
    .map((issue) => ({
      severity:
        issue.severity === "error" || issue.severity === "warning" || issue.severity === "info"
          ? issue.severity
          : "info",
      message:
        typeof issue.message === "string"
          ? issue.message
          : "Claw issue payload was not a valid object message.",
      assertion_id: typeof issue.assertion_id === "string" ? issue.assertion_id : undefined,
    }));
}

/**
 * Validate a test suite using the Claw agent.
 *
 * This is a non-blocking call — if the Claw agent is unavailable,
 * validation is skipped with a warning (fail-open for v7.2.0).
 */
export async function validateWithClaw(
  request: ClawValidationRequest,
  clawRunTask: (prompt: string, cwd: string) => Promise<{ output: string; session_id: string }>
): Promise<ClawValidationResult> {
  const prompt = buildValidationPrompt(request);

  try {
    const result = await clawRunTask(prompt, process.cwd());

    const parsed = parseClawJsonOutput(result.output);
    if (parsed) {
      return {
        accepted: typeof parsed.accepted === "boolean" ? parsed.accepted : true,
        issues: normalizeIssues(parsed.issues),
        suggested_assertions: Array.isArray(parsed.suggested_assertions) ? parsed.suggested_assertions : [],
        raw_output: result.output,
      };
    }

    return {
      accepted: true,
      issues: [{ severity: "info", message: "Claw response was unstructured; treating as accepted." }],
      suggested_assertions: [],
      raw_output: result.output,
    };
  } catch (e: any) {
    // Fail-open: Claw unavailable should not block verification
    console.error(`[ClawValidator] Claw agent unavailable: ${e.message}`);
    return {
      accepted: true,
      issues: [{ severity: "warning", message: `Claw agent unavailable: ${e.message}` }],
      suggested_assertions: [],
      raw_output: "",
    };
  }
}

/**
 * Merge Claw-suggested assertions into an existing test suite.
 * Re-validates the merged suite through the Zod schema.
 */
export function mergeSuggestedAssertions(
  suite: TestSuite,
  suggestions: any[]
): TestSuite | null {
  if (!suggestions || suggestions.length === 0) return suite;

  try {
    const merged = {
      tests: [
        ...suite.tests,
        ...suggestions.map((s: any) => ({
          ...s,
          id: s.id || `claw-suggestion-${createHash("sha256").update(JSON.stringify(s)).digest("hex").slice(0, 12)}`,
          severity: s.severity || "warn",
        })),
      ],
    };

    // Validate through schema — rejects malformed suggestions
    return TestSuiteSchema.parse(merged);
  } catch (e: any) {
    console.error(`[ClawValidator] Failed to merge suggestions: ${e.message}`);
    return null;
  }
}
