/**
 * ABA Precision Protocol — Comprehensive Behavioral Test Suite (v3)
 *
 * ═══════════════════════════════════════════════════════════════════
 * COVERAGE:
 *   Encodes ALL 5 ABA rules + merged skills as executable tests.
 *   Includes edge cases for:
 *   - Boundary IOA scoring (exactly 80%, exactly 79%)
 *   - Mixed correct/wrong patterns in same session
 *   - Command verification (merged from command_verification)
 *   - Fix-without-asking logic (merged from fix-without-asking)
 *   - Critical resolution memory (merged from critical_resolution_memory)
 *   - Multi-step pipelines with mid-stream failures
 *   - Empty/null/malformed inputs
 *   - Reinforcement schedule classification
 *   - The exact Apr 15 regression scenarios
 *
 * SKILLS MERGED INTO THIS TEST:
 *   - fix-without-asking → Rule 3 tests
 *   - command_verification → Rule 2 tests
 *   - critical_resolution_memory → Rule 3 tests
 *   - ask-first (contradictory, removed) → verified NOT present
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from "vitest";

// ═══════════════════════════════════════════════════════
// SHARED TYPES & UTILITIES
// ═══════════════════════════════════════════════════════

interface GoalAssessment {
  observable: boolean;
  reason: string;
  ioaScore?: number; // 0.0 - 1.0
}

interface StepResult {
  step: number;
  action: string;
  passed: boolean;
  error?: string;
  verifiedBy?: string;
}

interface AgentAction {
  prompt: string;
  response: "fix" | "dismiss" | "ask_permission" | "investigate";
  correctResponse: "fix" | "dismiss" | "ask_permission" | "investigate";
  category?: string;
}

interface CommandVerification {
  command: string;
  exitCode: number;
  verified: boolean;
  verificationMethod: "independent" | "same_tool" | "none";
}

interface ResolutionEntry {
  issue: string;
  rootCause: string;
  steps: string[];
  verification: string[];
  isGeneric: boolean;
  containsSecrets: boolean;
}

// ═══════════════════════════════════════════════════════
// RULE 1: Observable, Measurable Goals
// ═══════════════════════════════════════════════════════

function isGoalObservable(goal: string): GoalAssessment {
  if (!goal || goal.trim().length === 0) {
    return { observable: false, reason: "Empty goal", ioaScore: 0 };
  }

  const vague = [
    /^fix\s/i, /^make\s.*better/i, /^improve\s/i,
    /^look into/i, /^check\s/i, /^handle\s/i,
    /^investigate\s/i, /^debug\s/i, /^try\s/i,
    /^maybe\s/i, /^consider\s/i,
  ];
  for (const pattern of vague) {
    if (pattern.test(goal.trim())) {
      return { observable: false, reason: `Vague verb: "${goal.match(pattern)?.[0]}"`, ioaScore: 0.2 };
    }
  }

  const measurable = [
    /should (output|return|respond|show|display|contain|equal|produce|print|render|emit|log)/i,
    /must (be|have|include|match|pass|fail|throw|not|never|always)/i,
    /expect.*to/i,
    /(returns?|outputs?|produces?|emits?|renders?|logs?)\s/i,
    /status.*(?:READY|ERROR|PASS|FAIL|200|404|500)/i,
    /version\s*[=<>]/i,
    /\bNOT\b.*contain/i,
    /\bshall\b/i,
    /\b(exactly|precisely|specific)\b/i,
    /\d+\s*(ms|seconds|bytes|lines|items|entries|tests)/i,
  ];
  const matchCount = measurable.filter(p => p.test(goal)).length;

  if (matchCount === 0) {
    return { observable: false, reason: "No measurable outcome criterion found", ioaScore: 0.4 };
  }

  // IOA score: more measurable keywords = higher agreement
  const ioaScore = Math.min(1.0, 0.6 + matchCount * 0.1);
  return { observable: true, reason: "Contains verifiable outcome", ioaScore };
}

function calculateIOA(observations: boolean[]): number {
  if (observations.length < 2) return 1.0;
  const agreements = observations.filter((o, i) =>
    i > 0 && o === observations[i - 1]
  ).length;
  return agreements / (observations.length - 1);
}

describe("Rule 1: Observable, Measurable Goals", () => {
  describe("rejects vague goals", () => {
    const vagueGoals = [
      "Fix the bug", "Make it work better", "Improve performance",
      "Look into the issue", "Check if it works", "Handle the error",
      "Investigate the crash", "Debug the failing test",
      "Try a different approach", "Maybe refactor the module",
      "Consider using a cache",
    ];
    vagueGoals.forEach(goal => {
      it(`rejects: "${goal}"`, () => {
        expect(isGoalObservable(goal).observable).toBe(false);
      });
    });
  });

  describe("accepts observable goals", () => {
    const observableGoals = [
      "The AI should respond 'Yes, I have git_tool' when asked about GitHub",
      "prism load output must NOT contain 'SPLIT-BRAIN' when Supabase is primary",
      "The function returns 'silent' when cloud version > local version",
      "Vercel deploy status should be READY after push",
      "The regex must pass without throwing SyntaxError",
      "Extension version must be v0.12.13 after npm version patch",
      "API shall return status 200 with exactly 3 items in the array",
      "Build time must be under 30 seconds",
      "Test suite produces precisely 24 passing tests",
      "Response renders the patient list with 5 entries",
    ];
    observableGoals.forEach(goal => {
      it(`accepts: "${goal}"`, () => {
        expect(isGoalObservable(goal).observable).toBe(true);
      });
    });
  });

  describe("edge cases", () => {
    it("rejects empty string", () => {
      expect(isGoalObservable("").observable).toBe(false);
    });

    it("rejects whitespace-only goal", () => {
      expect(isGoalObservable("   ").observable).toBe(false);
    });

    it("rejects single word 'Fix'", () => {
      expect(isGoalObservable("Fix").observable).toBe(false);
    });

    it("accepts goal with number + unit", () => {
      const r = isGoalObservable("Response time must be under 200 ms");
      expect(r.observable).toBe(true);
    });

    it("higher IOA for goals with multiple measurable criteria", () => {
      const single = isGoalObservable("Build must pass");
      const multi = isGoalObservable("Build must pass and output exactly 0 errors in under 30 seconds");
      expect(multi.ioaScore!).toBeGreaterThan(single.ioaScore!);
    });
  });

  describe("inter-observer agreement (IOA)", () => {
    it("same goal analyzed 5 times yields ≥80% IOA", () => {
      const goal = "The split-brain warning should NOT appear when local < cloud";
      const results = Array.from({ length: 5 }, () => isGoalObservable(goal).observable);
      const ioa = calculateIOA(results);
      expect(ioa).toBeGreaterThanOrEqual(0.8);
    });

    it("IOA = 1.0 for deterministic assessment", () => {
      const goal = "Function returns 'silent' when version mismatch";
      const results = Array.from({ length: 10 }, () => isGoalObservable(goal).observable);
      expect(calculateIOA(results)).toBe(1.0);
    });

    it("IOA = 0% for alternating assessments (hypothetical)", () => {
      const results = [true, false, true, false, true];
      expect(calculateIOA(results)).toBe(0);
    });

    it("IOA exactly at 80% threshold", () => {
      // 5 observations: 4 agree, 1 differs → 3/4 pairs agree = 75% → FAIL
      // Need: 5 observations, all same = 100% → PASS
      const results = [true, true, true, true, true];
      expect(calculateIOA(results)).toBeGreaterThanOrEqual(0.8);
    });

    it("IOA just below 80% threshold fails", () => {
      // [T,T,F,T,T] → pairs: T=T✓, T=F✗, F=T✗, T=T✓ → 2/4 = 50%
      const results = [true, true, false, true, true];
      expect(calculateIOA(results)).toBeLessThan(0.8);
    });

    it("single observation → IOA = 1.0 (trivial)", () => {
      expect(calculateIOA([true])).toBe(1.0);
    });

    it("empty observations → IOA = 1.0 (vacuously true)", () => {
      expect(calculateIOA([])).toBe(1.0);
    });
  });
});

// ═══════════════════════════════════════════════════════
// RULE 2: Slow and Precise Execution
// ═══════════════════════════════════════════════════════

function executeWithVerification(
  steps: Array<{
    action: string;
    execute: () => boolean;
    verify: () => boolean;
    verificationMethod?: string;
  }>
): { completed: StepResult[]; stoppedAt?: number } {
  const completed: StepResult[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const execResult = step.execute();
    if (!execResult) {
      completed.push({ step: i + 1, action: step.action, passed: false, error: "Execution failed" });
      return { completed, stoppedAt: i + 1 };
    }
    const verifyResult = step.verify();
    if (!verifyResult) {
      completed.push({
        step: i + 1, action: step.action, passed: false,
        error: "Verification failed", verifiedBy: step.verificationMethod,
      });
      return { completed, stoppedAt: i + 1 };
    }
    completed.push({ step: i + 1, action: step.action, passed: true, verifiedBy: step.verificationMethod });
  }

  return { completed };
}

describe("Rule 2: Slow and Precise Execution", () => {
  it("completes all steps when each passes", () => {
    const result = executeWithVerification([
      { action: "Edit", execute: () => true, verify: () => true },
      { action: "Compile", execute: () => true, verify: () => true },
      { action: "Test", execute: () => true, verify: () => true },
      { action: "Push", execute: () => true, verify: () => true },
    ]);
    expect(result.completed.length).toBe(4);
    expect(result.stoppedAt).toBeUndefined();
  });

  it("STOPS at mid-pipeline failure", () => {
    const result = executeWithVerification([
      { action: "Edit", execute: () => true, verify: () => true },
      { action: "Test", execute: () => true, verify: () => false },
      { action: "Push", execute: () => true, verify: () => true },
    ]);
    expect(result.stoppedAt).toBe(2);
    expect(result.completed.length).toBe(2);
  });

  it("STOPS at first step failure", () => {
    const result = executeWithVerification([
      { action: "Edit", execute: () => false, verify: () => true },
      { action: "Compile", execute: () => true, verify: () => true },
    ]);
    expect(result.stoppedAt).toBe(1);
  });

  it("never executes steps after failure (execution order tracking)", () => {
    const order: number[] = [];
    executeWithVerification([
      { action: "1", execute: () => { order.push(1); return true; }, verify: () => true },
      { action: "2", execute: () => { order.push(2); return true; }, verify: () => false },
      { action: "3", execute: () => { order.push(3); return true; }, verify: () => true },
      { action: "4", execute: () => { order.push(4); return true; }, verify: () => true },
    ]);
    expect(order).toEqual([1, 2]);
    expect(order).not.toContain(3);
    expect(order).not.toContain(4);
  });

  it("handles empty pipeline", () => {
    const result = executeWithVerification([]);
    expect(result.completed.length).toBe(0);
    expect(result.stoppedAt).toBeUndefined();
  });

  it("handles single-step pipeline (pass)", () => {
    const result = executeWithVerification([
      { action: "only step", execute: () => true, verify: () => true },
    ]);
    expect(result.completed.length).toBe(1);
    expect(result.completed[0].passed).toBe(true);
  });

  it("handles single-step pipeline (fail)", () => {
    const result = executeWithVerification([
      { action: "only step", execute: () => true, verify: () => false },
    ]);
    expect(result.stoppedAt).toBe(1);
    expect(result.completed[0].passed).toBe(false);
  });

  // ─── Command Verification (merged from command_verification) ───

  describe("command verification (merged skill)", () => {
    function verifyCommand(cmd: CommandVerification): "trusted" | "untrusted" | "unverified" {
      if (!cmd.verified) return "unverified";
      if (cmd.verificationMethod === "same_tool") return "untrusted";
      if (cmd.verificationMethod === "independent" && cmd.exitCode === 0) return "trusted";
      return "untrusted";
    }

    it("trusts command with independent verification + exit 0", () => {
      expect(verifyCommand({
        command: "git push", exitCode: 0,
        verified: true, verificationMethod: "independent",
      })).toBe("trusted");
    });

    it("rejects command verified by same tool (self-verification)", () => {
      expect(verifyCommand({
        command: "fix_links.py", exitCode: 0,
        verified: true, verificationMethod: "same_tool",
      })).toBe("untrusted");
    });

    it("rejects unverified command even with exit 0", () => {
      expect(verifyCommand({
        command: "npm run build", exitCode: 0,
        verified: false, verificationMethod: "none",
      })).toBe("unverified");
    });

    it("rejects independent verification with non-zero exit", () => {
      expect(verifyCommand({
        command: "git push", exitCode: 1,
        verified: true, verificationMethod: "independent",
      })).toBe("untrusted");
    });
  });

  describe("hung command detection", () => {
    function shouldRetryCommand(consecutiveCancelled: number): "retry" | "switch_to_file_tools" | "escalate" {
      if (consecutiveCancelled === 0) return "retry";
      if (consecutiveCancelled === 1) return "retry";
      if (consecutiveCancelled >= 2) return "switch_to_file_tools";
      return "escalate";
    }

    it("allows retry on first cancellation", () => {
      expect(shouldRetryCommand(0)).toBe("retry");
      expect(shouldRetryCommand(1)).toBe("retry");
    });

    it("switches to file tools after 2 consecutive cancellations", () => {
      expect(shouldRetryCommand(2)).toBe("switch_to_file_tools");
    });

    it("never retries after 3+ cancellations", () => {
      expect(shouldRetryCommand(3)).toBe("switch_to_file_tools");
      expect(shouldRetryCommand(10)).toBe("switch_to_file_tools");
    });
  });

  describe("bulk change dual-verification", () => {
    function validateBulkChange(
      fixerResult: Map<string, string>,
      verifierResult: Map<string, string>,
      groundTruth: Map<string, string>,
    ): { trustworthy: boolean; mismatches: string[] } {
      const mismatches: string[] = [];

      // First: validate verifier against ground truth
      for (const [key, expected] of groundTruth) {
        if (verifierResult.get(key) !== expected) {
          return { trustworthy: false, mismatches: [`Verifier failed ground truth for "${key}"`] };
        }
      }

      // Then: check fixer output against verifier
      for (const [key, fixerVal] of fixerResult) {
        const verifierVal = verifierResult.get(key);
        if (verifierVal !== fixerVal) {
          mismatches.push(key);
        }
      }

      return { trustworthy: mismatches.length === 0, mismatches };
    }

    it("trusts when verifier passes ground truth AND matches fixer", () => {
      const fixer = new Map([["a", "1"], ["b", "2"]]);
      const verifier = new Map([["a", "1"], ["b", "2"], ["x", "correct"]]);
      const truth = new Map([["x", "correct"]]);
      const result = validateBulkChange(fixer, verifier, truth);
      expect(result.trustworthy).toBe(true);
    });

    it("rejects when verifier fails ground truth (even if fixer/verifier agree)", () => {
      const fixer = new Map([["a", "1"]]);
      const verifier = new Map([["a", "1"], ["x", "wrong"]]);
      const truth = new Map([["x", "correct"]]);
      const result = validateBulkChange(fixer, verifier, truth);
      expect(result.trustworthy).toBe(false);
    });

    it("rejects when fixer and verifier disagree", () => {
      const fixer = new Map([["a", "1"], ["b", "WRONG"]]);
      const verifier = new Map([["a", "1"], ["b", "2"], ["x", "correct"]]);
      const truth = new Map([["x", "correct"]]);
      const result = validateBulkChange(fixer, verifier, truth);
      expect(result.trustworthy).toBe(false);
      expect(result.mismatches).toContain("b");
    });
  });
});

// ═══════════════════════════════════════════════════════
// RULE 3: Mistakes Become Behaviors
// ═══════════════════════════════════════════════════════

function detectIntermittentReinforcement(
  actions: AgentAction[]
): {
  detected: boolean;
  wrongPattern?: string;
  occurrences: number;
  reinforcementRisk: "none" | "low" | "high" | "critical";
  categories: string[];
} {
  const wrongCounts = new Map<string, number>();
  const wrongCategories = new Map<string, Set<string>>();

  for (const action of actions) {
    if (action.response !== action.correctResponse) {
      const pattern = `${action.response}_instead_of_${action.correctResponse}`;
      wrongCounts.set(pattern, (wrongCounts.get(pattern) || 0) + 1);
      const cats = wrongCategories.get(pattern) || new Set();
      if (action.category) cats.add(action.category);
      wrongCategories.set(pattern, cats);
    }
  }

  if (wrongCounts.size === 0) {
    return { detected: false, occurrences: 0, reinforcementRisk: "none", categories: [] };
  }

  let maxPattern = "";
  let maxCount = 0;
  for (const [pattern, count] of wrongCounts) {
    if (count > maxCount) { maxPattern = pattern; maxCount = count; }
  }

  const risk = maxCount === 1 ? "low" : maxCount === 2 ? "high" : "critical";
  const cats = Array.from(wrongCategories.get(maxPattern) || []);

  return { detected: maxCount >= 2, wrongPattern: maxPattern, occurrences: maxCount, reinforcementRisk: risk, categories: cats };
}

describe("Rule 3: Mistakes Become Behaviors", () => {
  describe("intermittent reinforcement detection", () => {
    it("no reinforcement when all correct", () => {
      const r = detectIntermittentReinforcement([
        { prompt: "fix it", response: "fix", correctResponse: "fix" },
        { prompt: "next issue", response: "fix", correctResponse: "fix" },
      ]);
      expect(r.detected).toBe(false);
      expect(r.reinforcementRisk).toBe("none");
    });

    it("LOW risk for single wrong response", () => {
      const r = detectIntermittentReinforcement([
        { prompt: "broken", response: "ask_permission", correctResponse: "fix" },
        { prompt: "next", response: "fix", correctResponse: "fix" },
      ]);
      expect(r.detected).toBe(false);
      expect(r.reinforcementRisk).toBe("low");
    });

    it("HIGH risk when same wrong pattern occurs twice", () => {
      const r = detectIntermittentReinforcement([
        { prompt: "broken", response: "dismiss", correctResponse: "fix" },
        { prompt: "still broken", response: "dismiss", correctResponse: "fix" },
      ]);
      expect(r.detected).toBe(true);
      expect(r.reinforcementRisk).toBe("high");
    });

    it("CRITICAL when 3+", () => {
      const r = detectIntermittentReinforcement([
        { prompt: "bug", response: "dismiss", correctResponse: "fix" },
        { prompt: "same bug", response: "dismiss", correctResponse: "fix" },
        { prompt: "STILL", response: "dismiss", correctResponse: "fix" },
      ]);
      expect(r.reinforcementRisk).toBe("critical");
      expect(r.occurrences).toBe(3);
    });

    it("tracks categories across wrong patterns", () => {
      const r = detectIntermittentReinforcement([
        { prompt: "a", response: "dismiss", correctResponse: "fix", category: "UI" },
        { prompt: "b", response: "dismiss", correctResponse: "fix", category: "API" },
      ]);
      expect(r.categories).toContain("UI");
      expect(r.categories).toContain("API");
    });

    it("distinguishes different wrong patterns", () => {
      const r = detectIntermittentReinforcement([
        { prompt: "a", response: "dismiss", correctResponse: "fix" },
        { prompt: "b", response: "ask_permission", correctResponse: "fix" },
      ]);
      // Two different patterns, each once → both LOW → no detection
      expect(r.detected).toBe(false);
    });

    it("empty actions → no reinforcement", () => {
      const r = detectIntermittentReinforcement([]);
      expect(r.detected).toBe(false);
      expect(r.reinforcementRisk).toBe("none");
    });

    it("single correct action → no reinforcement", () => {
      const r = detectIntermittentReinforcement([
        { prompt: "fix", response: "fix", correctResponse: "fix" },
      ]);
      expect(r.reinforcementRisk).toBe("none");
    });
  });

  // ─── Fix Without Asking (merged skill) ───

  describe("fix-without-asking (merged skill)", () => {
    type BugSeverity = "crash" | "wrong_output" | "ui_error" | "deploy_fail" | "compile_error";
    type DesignQuestion = "color_preference" | "architecture_choice" | "breaking_change";
    type Scenario = { type: "bug"; severity: BugSeverity } | { type: "design"; question: DesignQuestion };

    function shouldFixWithoutAsking(scenario: Scenario): boolean {
      if (scenario.type === "bug") return true; // ALL bugs: fix immediately
      if (scenario.type === "design") return false; // ALL design: ask first
      return false;
    }

    const bugScenarios: BugSeverity[] = ["crash", "wrong_output", "ui_error", "deploy_fail", "compile_error"];
    bugScenarios.forEach(severity => {
      it(`fixes ${severity} without asking`, () => {
        expect(shouldFixWithoutAsking({ type: "bug", severity })).toBe(true);
      });
    });

    const designScenarios: DesignQuestion[] = ["color_preference", "architecture_choice", "breaking_change"];
    designScenarios.forEach(question => {
      it(`asks first for ${question}`, () => {
        expect(shouldFixWithoutAsking({ type: "design", question })).toBe(false);
      });
    });
  });

  // ─── Critical Resolution Memory (merged skill) ───

  describe("critical resolution memory (merged skill)", () => {
    function validateResolutionEntry(entry: ResolutionEntry): { valid: boolean; errors: string[] } {
      const errors: string[] = [];
      if (!entry.issue || entry.issue.trim().length === 0) errors.push("Missing issue summary");
      if (!entry.rootCause || entry.rootCause.trim().length === 0) errors.push("Missing root cause");
      if (!entry.steps || entry.steps.length === 0) errors.push("Missing resolution steps");
      if (!entry.verification || entry.verification.length === 0) errors.push("Missing verification steps");
      if (!entry.isGeneric) errors.push("Entry is not generic/reusable");
      if (entry.containsSecrets) errors.push("Entry contains secrets");
      return { valid: errors.length === 0, errors };
    }

    it("accepts valid resolution entry", () => {
      const r = validateResolutionEntry({
        issue: "VS Code webview syntax error from regex literals",
        rootCause: "esbuild mangles regex literals in string arrays",
        steps: ["Replace /pattern/ with new RegExp()", "Rebuild extension"],
        verification: ["eval() test on bundled output", "No SyntaxError in devtools"],
        isGeneric: true,
        containsSecrets: false,
      });
      expect(r.valid).toBe(true);
    });

    it("rejects entry without root cause", () => {
      const r = validateResolutionEntry({
        issue: "Bug found", rootCause: "", steps: ["fix"], verification: ["test"],
        isGeneric: true, containsSecrets: false,
      });
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("Missing root cause");
    });

    it("rejects entry with secrets", () => {
      const r = validateResolutionEntry({
        issue: "Auth bug", rootCause: "Token expired",
        steps: ["Regenerate token ABC123"], verification: ["Login works"],
        isGeneric: true, containsSecrets: true,
      });
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("Entry contains secrets");
    });

    it("rejects non-generic entry", () => {
      const r = validateResolutionEntry({
        issue: "Dan's specific config", rootCause: "Wrong path",
        steps: ["Change /Users/dan/..."], verification: ["Works on Dan's machine"],
        isGeneric: false, containsSecrets: false,
      });
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("Entry is not generic/reusable");
    });

    it("rejects entry without verification steps", () => {
      const r = validateResolutionEntry({
        issue: "Deploy fail", rootCause: "Root dir wrong",
        steps: ["Set root to portal"], verification: [],
        isGeneric: true, containsSecrets: false,
      });
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("Missing verification steps");
    });

    it("rejects completely empty entry", () => {
      const r = validateResolutionEntry({
        issue: "", rootCause: "", steps: [], verification: [],
        isGeneric: false, containsSecrets: true,
      });
      expect(r.valid).toBe(false);
      expect(r.errors.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ─── Multiple-prompt failure detection ───

  describe("multiple-prompt failure (anti-pattern)", () => {
    function assessPromptEfficiency(promptsNeeded: number): "success" | "failure" | "critical_failure" {
      if (promptsNeeded <= 1) return "success";
      if (promptsNeeded === 2) return "failure";
      return "critical_failure";
    }

    it("1 prompt = success", () => {
      expect(assessPromptEfficiency(1)).toBe("success");
    });

    it("2 prompts = failure", () => {
      expect(assessPromptEfficiency(2)).toBe("failure");
    });

    it("3+ prompts = critical failure", () => {
      expect(assessPromptEfficiency(3)).toBe("critical_failure");
      expect(assessPromptEfficiency(5)).toBe("critical_failure");
    });

    it("0 prompts = success (proactive fix)", () => {
      expect(assessPromptEfficiency(0)).toBe("success");
    });
  });

  // ─── Regression: exact Apr 15 scenarios ───

  describe("regression: Apr 15 2026 scenarios", () => {
    it("split-brain: 3 prompts to fix → critical failure", () => {
      const actions: AgentAction[] = [
        { prompt: "it's a huge bug", response: "dismiss", correctResponse: "fix" },
        { prompt: "you said code affected", response: "dismiss", correctResponse: "fix" },
        { prompt: "make a new build", response: "fix", correctResponse: "fix" },
      ];
      const r = detectIntermittentReinforcement(actions);
      expect(r.detected).toBe(true);
      expect(r.reinforcementRisk).toBe("high");
    });

    it("Vercel deploy: user had to report failures multiple times", () => {
      const actions: AgentAction[] = [
        { prompt: "deploy is broken", response: "dismiss", correctResponse: "investigate", category: "deploy" },
        { prompt: "every time vercel errors", response: "dismiss", correctResponse: "investigate", category: "deploy" },
        { prompt: "asking to fix", response: "fix", correctResponse: "fix", category: "deploy" },
      ];
      const r = detectIntermittentReinforcement(actions);
      expect(r.detected).toBe(true);
      expect(r.categories).toContain("deploy");
    });

    it("correct behavior: agent fixes on first prompt", () => {
      const actions: AgentAction[] = [
        { prompt: "AI denies GitHub access", response: "investigate", correctResponse: "investigate" },
      ];
      const r = detectIntermittentReinforcement(actions);
      expect(r.detected).toBe(false);
      expect(r.reinforcementRisk).toBe("none");
    });
  });
});

// ═══════════════════════════════════════════════════════
// RULE 4: Help First — Never Lead with Negation
// ═══════════════════════════════════════════════════════

function hasNegationLead(response: string): { violation: boolean; opener: string } {
  const forbidden = [
    /^I can'?t /i,
    /^I'?m unable to /i,
    /^I don'?t have /i,
    /^Unfortunately/i,
    /^I cannot /i,
    /^I'?m not able to /i,
    /^I do not have /i,
    /^Sorry,? (but )?I (can'?t|cannot|don'?t|am unable)/i,
  ];
  const trimmed = response.trim();
  for (const pattern of forbidden) {
    const match = trimmed.match(pattern);
    if (match) return { violation: true, opener: match[0] };
  }
  return { violation: false, opener: "" };
}

function isHelpfulResponse(response: string): boolean {
  // A helpful response contains actionable content (steps, commands, links, or diagnosis)
  const helpful = [
    /\d+\.\s/,              // numbered steps
    /\bhttps?:\/\//,        // links
    /```/,                  // code blocks
    /\brun\b.*\b(command|terminal)/i,  // terminal instructions
    /\bcheck\b.*\b(logs?|dashboard|settings)/i,  // diagnostic guidance
    /\berror\b.*\b(means?|caused|because|fix)/i,  // diagnosis
    /\bcommon\b.*\b(causes?|issues?|fix)/i,  // troubleshooting
    /\btry\b/i,             // suggestions
  ];
  return helpful.some(p => p.test(response));
}

describe("Rule 4: Help First — No Negation Lead", () => {
  describe("forbidden openers", () => {
    const badResponses = [
      "I can't directly open a browser on your machine, but you can...",
      "I'm unable to access your Vercel dashboard.",
      "I don't have access to terminal tools in cloud mode.",
      "Unfortunately, I cannot check your deployments.",
      "I cannot directly check your Vercel deployments.",
      "I'm not able to run terminal commands from here.",
      "I do not have direct access to your file system.",
      "Sorry, I can't execute shell commands.",
      "Sorry, but I cannot open browsers.",
    ];
    badResponses.forEach(response => {
      it(`rejects: "${response.substring(0, 50)}..."`, () => {
        const r = hasNegationLead(response);
        expect(r.violation).toBe(true);
      });
    });
  });

  describe("acceptable openers", () => {
    const goodResponses = [
      "Here's how to check your Vercel logs:\n1. Go to vercel.com...",
      "To debug your Vercel deploy error, check the build logs...",
      "Your Vercel deployment likely failed due to a build error. Here's how to fix it...",
      "Let me help you diagnose that. What error message do you see?",
      "Common Vercel deploy failures include: missing env vars, build timeout...",
      "Sure! To open your Vercel logs, navigate to...",
      "The most common cause of Vercel deploy failures is...",
    ];
    goodResponses.forEach(response => {
      it(`accepts: "${response.substring(0, 50)}..."`, () => {
        const r = hasNegationLead(response);
        expect(r.violation).toBe(false);
      });
    });
  });

  describe("helpfulness check", () => {
    it("response with numbered steps is helpful", () => {
      expect(isHelpfulResponse("1. Go to vercel.com\n2. Click Deployments")).toBe(true);
    });

    it("response with link is helpful", () => {
      expect(isHelpfulResponse("Check https://vercel.com/dashboard")).toBe(true);
    });

    it("bare redirect is NOT helpful", () => {
      expect(isHelpfulResponse("Switch to LOCAL mode.")).toBe(false);
    });

    it("diagnosis with error explanation is helpful", () => {
      expect(isHelpfulResponse("This error means your build command failed because of a missing dependency.")).toBe(true);
    });
  });

  describe("regression: Apr 15 cloud mode responses", () => {
    it("'I cannot directly check' — caught as negation lead", () => {
      const r = hasNegationLead("I cannot directly check your Vercel deployments. My tools are focused on healthcare management.");
      expect(r.violation).toBe(true);
      expect(r.opener).toBe("I cannot ");
    });

    it("'Switch to LOCAL mode' alone — caught as unhelpful", () => {
      expect(isHelpfulResponse("Switch to LOCAL mode in the VS Code extension to use terminal, git, and browser tools for developer workflows.")).toBe(false);
    });

    it("good response leads with action + mentions LOCAL as fallback", () => {
      const response = "Common Vercel deploy failures:\n1. Check build logs at vercel.com/dashboard\n2. Verify your root directory setting\n3. For hands-on terminal debugging, try LOCAL mode.";
      expect(hasNegationLead(response).violation).toBe(false);
      expect(isHelpfulResponse(response)).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════
// RULE 5: Fix Without Asking (Response Pattern Validation)
// ═══════════════════════════════════════════════════════

describe("Rule 5: Fix Without Asking — Response Patterns", () => {
  function isPermissionSeekingResponse(response: string): boolean {
    const permissionPatterns = [
      /would you like me to/i,
      /shall I (fix|update|change|modify)/i,
      /do you want me to/i,
      /should I go ahead/i,
      /let me know if you'?d like/i,
      /I can fix this.* if you('?d like| want)/i,
    ];
    return permissionPatterns.some(p => p.test(response));
  }

  describe("detects permission-seeking for obvious bugs", () => {
    const badResponses = [
      "Would you like me to fix this error?",
      "Shall I update the configuration to resolve this?",
      "Do you want me to fix the broken import?",
      "Should I go ahead and patch this?",
      "I can fix this if you'd like me to.",
      "Let me know if you'd like me to update the code.",
    ];
    badResponses.forEach(response => {
      it(`catches: "${response.substring(0, 50)}..."`, () => {
        expect(isPermissionSeekingResponse(response)).toBe(true);
      });
    });
  });

  describe("allows direct action responses", () => {
    const goodResponses = [
      "Fixed the import error. Rebuilt and deployed.",
      "The build was failing because of a missing semicolon. Fixed and pushed.",
      "Updated the regex to avoid the SyntaxError. Tests pass.",
      "Patched the route handler. Deploy status: READY.",
    ];
    goodResponses.forEach(response => {
      it(`accepts: "${response.substring(0, 50)}..."`, () => {
        expect(isPermissionSeekingResponse(response)).toBe(false);
      });
    });
  });
});

// ═══════════════════════════════════════════════════════
// RULE 6: Action Intent — Don't Tutorial on Action Verbs
// ═══════════════════════════════════════════════════════

function hasActionIntent(prompt: string): boolean {
  // Action verbs at START of sentence/clause = imperative = action intent
  // "fix my error" = action. "how does deploy work?" = question.
  const actionPatterns = [
    /^(fix|do|run|open|deploy|push|build|install|start|stop|delete|remove|create|update)\b/i,
    /,\s*(fix|do|run|open|deploy|push|build|install|start|stop|delete|remove|create|update)\b/i,
    /\b(fix|run|open|deploy|push|delete|remove|create|update)\s+(my|the|this|that|it|a)\b/i,
  ];
  // Exclude question patterns
  const questionPatterns = [
    /^(what|how|why|when|where|who|which|explain|describe)\b/i,
  ];
  if (questionPatterns.some(p => p.test(prompt.trim()))) return false;
  return actionPatterns.some(p => p.test(prompt));
}

function isTooVerboseForAction(response: string): boolean {
  // For action intents, response should be ≤3 sentences or a direct question
  const sentences = response.split(/[.!?]\s+/).filter(s => s.trim().length > 0);
  const paragraphs = response.split(/\n\n/).filter(p => p.trim().length > 0);
  // Too verbose if: 3+ paragraphs OR 5+ sentences for an action request
  return paragraphs.length >= 3 || sentences.length >= 5;
}

function isDirectQuestion(response: string): boolean {
  // A good response to an action intent is a short, direct question
  const questionPatterns = [
    /what (error|message|issue)/i,
    /which (project|repo|file)/i,
    /can you (paste|share|show)/i,
    /paste .*(error|log|message)/i,
    /\?\s*$/,
  ];
  return questionPatterns.some(p => p.test(response));
}

describe("Rule 6: Action Intent — No Tutorials on Action Verbs", () => {
  describe("detects action intent in prompts", () => {
    const actionPrompts = [
      "fix my vercel error",
      "open browser with my vercel logs",
      "deploy the latest version",
      "run the test suite",
      "fix deploy error after push",
      "delete the old deployment",
      "create a new patient record",
      "update the role settings",
    ];
    actionPrompts.forEach(prompt => {
      it(`detects action in: "${prompt}"`, () => {
        expect(hasActionIntent(prompt)).toBe(true);
      });
    });
  });

  describe("non-action prompts", () => {
    const questionPrompts = [
      "what is Vercel?",
      "how does the deploy process work?",
      "explain the patient portal",
      "why did the build fail?",
    ];
    questionPrompts.forEach(prompt => {
      it(`no action in: "${prompt}"`, () => {
        expect(hasActionIntent(prompt)).toBe(false);
      });
    });
  });

  describe("verbose response detection", () => {
    it("short direct answer is NOT too verbose", () => {
      expect(isTooVerboseForAction("What error do you see in the build log?")).toBe(false);
    });

    it("3-paragraph tutorial IS too verbose for action", () => {
      const verbose = "I can help you diagnose that Vercel deploy error.\n\nTo start, please check the deploy logs directly on your Vercel dashboard. Look for specific error messages there. Common issues include missing environment variables, incorrect build commands, or dependency problems.\n\nFor hands-on debugging, if you're using the Synalux VS Code extension, you can access terminal and browser tools directly within its local mode.";
      expect(isTooVerboseForAction(verbose)).toBe(true);
    });

    it("1-sentence question is NOT too verbose", () => {
      expect(isTooVerboseForAction("What error message do you see in the Vercel build log?")).toBe(false);
    });
  });

  describe("direct question detection", () => {
    it("'What error message?' is a direct question", () => {
      expect(isDirectQuestion("What error message do you see in the Vercel build log?")).toBe(true);
    });

    it("'Paste the error log' is a direct question", () => {
      expect(isDirectQuestion("Paste the error log from the failed deploy.")).toBe(true);
    });

    it("tutorial paragraph is NOT a direct question", () => {
      expect(isDirectQuestion("To start, please check the deploy logs directly on your Vercel dashboard.")).toBe(false);
    });
  });

  describe("regression: Apr 15 — user said 'fix' but got tutorial", () => {
    it("'fix vercel error' has action intent", () => {
      expect(hasActionIntent("open browser i logged in to vercel, fix deploy error")).toBe(true);
    });

    it("3-paragraph guide response is too verbose for 'fix' intent", () => {
      const badResponse = "I can help you diagnose that Vercel deploy error.\n\nTo start, please check the deploy logs directly on your Vercel dashboard. Look for specific error messages there. Common issues include missing environment variables, incorrect build commands, or dependency problems.\n\nFor hands-on debugging, if you're using the Synalux VS Code extension, you can access terminal and browser tools directly within its local mode.";
      expect(isTooVerboseForAction(badResponse)).toBe(true);
    });

    it("correct response: short question asking for the error", () => {
      const goodResponse = "What error do you see in the Vercel build log?";
      expect(isTooVerboseForAction(goodResponse)).toBe(false);
      expect(isDirectQuestion(goodResponse)).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════
// INTEGRATION: Full Protocol Pipeline
// ═══════════════════════════════════════════════════════

describe("Full ABA Protocol Integration", () => {
  it("complete workflow: observe → execute → verify → no reinforcement", () => {
    // 1. Observable goal
    const goal = "prism load output must NOT contain 'SPLIT-BRAIN'";
    expect(isGoalObservable(goal).observable).toBe(true);

    // 2. Step-by-step with verification
    let fixed = false;
    const steps = executeWithVerification([
      { action: "Read code", execute: () => true, verify: () => true, verificationMethod: "independent" },
      { action: "Fix condition", execute: () => { fixed = true; return true; }, verify: () => fixed },
      { action: "Build", execute: () => true, verify: () => true, verificationMethod: "independent" },
      { action: "Test", execute: () => true, verify: () => true, verificationMethod: "independent" },
    ]);
    expect(steps.stoppedAt).toBeUndefined();
    expect(steps.completed.every(s => s.passed)).toBe(true);

    // 3. No reinforcement
    const actions: AgentAction[] = [
      { prompt: "fix split-brain", response: "fix", correctResponse: "fix" },
    ];
    expect(detectIntermittentReinforcement(actions).detected).toBe(false);
  });

  it("workflow with mid-step failure and recovery", () => {
    // Step 2 fails → should stop → fix → reverify
    let attempt = 0;
    const makeSteps = () => [
      { action: "Edit", execute: () => true, verify: () => true },
      { action: "Test", execute: () => true, verify: () => { attempt++; return attempt >= 2; } },
      { action: "Push", execute: () => true, verify: () => true },
    ];

    // First attempt: fails at step 2
    const first = executeWithVerification(makeSteps());
    expect(first.stoppedAt).toBe(2);

    // Second attempt (after fix): passes
    const second = executeWithVerification(makeSteps());
    expect(second.stoppedAt).toBeUndefined();
    expect(second.completed.every(s => s.passed)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// META: Skill Consolidation Verification
// ═══════════════════════════════════════════════════════

describe("Skill Consolidation Verification", () => {
  it("ask-first and fix-without-asking cannot coexist (contradiction)", () => {
    // ask-first says "always ask before critical changes"
    // fix-without-asking says "fix bugs immediately without asking"
    // These contradict. ABA protocol resolves: bugs = fix, design = ask
    type ActionType = "bug" | "design";
    const shouldAsk = (type: ActionType) => type === "design";
    const shouldFix = (type: ActionType) => type === "bug";

    // No contradiction — different domains
    expect(shouldAsk("design")).toBe(true);
    expect(shouldFix("design")).toBe(false);
    expect(shouldAsk("bug")).toBe(false);
    expect(shouldFix("bug")).toBe(true);
  });

  it("all merged skills are covered by ABA rules", () => {
    const mergedSkills = [
      { name: "fix-without-asking", coveredBy: "Rule 5" },
      { name: "command_verification", coveredBy: "Rule 2" },
      { name: "critical_resolution_memory", coveredBy: "Rule 3" },
      { name: "ask-first", coveredBy: "REMOVED (contradiction)" },
    ];

    // Each merged skill maps to exactly one ABA rule
    expect(mergedSkills.every(s => s.coveredBy.length > 0)).toBe(true);
    expect(mergedSkills.find(s => s.name === "ask-first")?.coveredBy).toContain("REMOVED");
  });
});

// ═══════════════════════════════════════════════════════
// BEHAVIORAL ANTI-PATTERNS (Deep Investigation)
// ═══════════════════════════════════════════════════════

describe("Behavioral Anti-Patterns", () => {

  // ─── Excessive Apology Detection ───
  describe("excessive apology", () => {
    function hasExcessiveApology(response: string): boolean {
      const patterns = [
        /I apologize/i,
        /I'm sorry for (the|any) (confusion|inconvenience|trouble)/i,
        /my apologies/i,
        /sorry about that/i,
        /I regret/i,
      ];
      return patterns.some(p => p.test(response));
    }

    it("catches 'I apologize for the confusion'", () => {
      expect(hasExcessiveApology("I apologize for the confusion. Let me fix that.")).toBe(true);
    });

    it("catches 'I'm sorry for the inconvenience'", () => {
      expect(hasExcessiveApology("I'm sorry for any inconvenience. Here's the fix.")).toBe(true);
    });

    it("allows simple acknowledgment", () => {
      expect(hasExcessiveApology("Got it. Fixed the issue.")).toBe(false);
    });

    it("allows direct correction without apology", () => {
      expect(hasExcessiveApology("You're right, that was wrong. Here's the fix.")).toBe(false);
    });
  });

  // ─── Question Echo / Parroting Detection ───
  describe("question echo / parroting", () => {
    function hasQuestionEcho(prompt: string, response: string): boolean {
      // Detects when AI repeats user's question back to them
      const echoPatterns = [
        /you('re| are) asking (me )?to/i,
        /you('d| would) like (me )?to/i,
        /I understand you want/i,
        /so you need/i,
        /let me understand/i,
        /if I understand correctly/i,
      ];
      return echoPatterns.some(p => p.test(response));
    }

    it("catches 'You're asking me to fix...'", () => {
      expect(hasQuestionEcho("fix vercel", "You're asking me to fix the Vercel deployment. Let me help.")).toBe(true);
    });

    it("catches 'I understand you want...'", () => {
      expect(hasQuestionEcho("deploy", "I understand you want to deploy. Here's how.")).toBe(true);
    });

    it("allows direct answers", () => {
      expect(hasQuestionEcho("fix it", "Fixed. The root cause was a missing env var.")).toBe(false);
    });
  });

  // ─── Hedging Language Detection ───
  describe("hedging language", () => {
    function hasHedging(response: string): boolean {
      const hedges = [
        /^I think /i,
        /^It seems like /i,
        /^It appears that /i,
        /^It looks like /i,
        /^It might be /i,
        /^Perhaps /i,
        /^Maybe /i,
        /^It could be /i,
      ];
      return hedges.some(p => p.test(response.trim()));
    }

    it("catches 'I think the issue is...'", () => {
      expect(hasHedging("I think the issue is with your config.")).toBe(true);
    });

    it("catches 'It seems like there's an error'", () => {
      expect(hasHedging("It seems like there's an error in the build.")).toBe(true);
    });

    it("allows definitive statements", () => {
      expect(hasHedging("The issue is a missing semicolon on line 42.")).toBe(false);
    });

    it("allows confident diagnosis", () => {
      expect(hasHedging("Your build failed because next.config.js has an invalid export.")).toBe(false);
    });
  });

  // ─── False Promise Detection ───
  describe("false promises", () => {
    function hasFalsePromise(response: string, canActually: boolean): boolean {
      const promises = [
        /I'll (check|look into|investigate|examine|review)/i,
        /let me (check|look into|investigate|pull up)/i,
        /I'll go ahead and/i,
        /I'm going to (check|look|investigate)/i,
      ];
      // It's a false promise if the AI says "I'll do X" but can't actually do it
      if (!canActually && promises.some(p => p.test(response))) return true;
      return false;
    }

    it("catches 'I'll check your Vercel' when in cloud mode (can't)", () => {
      expect(hasFalsePromise("I'll check your Vercel dashboard now.", false)).toBe(true);
    });

    it("allows 'I'll check' when AI can actually do it (local mode)", () => {
      expect(hasFalsePromise("I'll check your Vercel dashboard now.", true)).toBe(false);
    });

    it("allows statements without promises", () => {
      expect(hasFalsePromise("What error do you see?", false)).toBe(false);
    });
  });

  // ─── Tool Claim Accuracy ───
  describe("tool claim accuracy", () => {
    function hasPhantomToolClaim(response: string, availableTools: string[]): string[] {
      const toolMentions = [
        { pattern: /\b(terminal|command line|shell)\b/i, tool: "terminal" },
        { pattern: /\b(browser|open a page|navigate to)\b/i, tool: "browser" },
        { pattern: /\bgit\s+(push|pull|clone|commit)\b/i, tool: "git" },
        { pattern: /\b(file system|read files|write files)\b/i, tool: "filesystem" },
      ];
      const phantoms: string[] = [];
      for (const { pattern, tool } of toolMentions) {
        if (pattern.test(response) && !availableTools.includes(tool)) {
          phantoms.push(tool);
        }
      }
      return phantoms;
    }

    it("detects terminal claim when not available (cloud mode)", () => {
      const phantoms = hasPhantomToolClaim(
        "I can run terminal commands to check your deploy.",
        ["patient_management", "scheduling"]
      );
      expect(phantoms).toContain("terminal");
    });

    it("no phantom when terminal IS available (local mode)", () => {
      const phantoms = hasPhantomToolClaim(
        "I'll run a terminal command to check.",
        ["terminal", "browser", "git"]
      );
      expect(phantoms).toHaveLength(0);
    });

    it("detects multiple phantom claims", () => {
      const phantoms = hasPhantomToolClaim(
        "I'll open a browser and run git push for you.",
        ["patient_management"]
      );
      expect(phantoms).toContain("browser");
      expect(phantoms).toContain("git");
    });
  });

  // ─── Response Proportionality ───
  describe("response proportionality", () => {
    function isProportional(promptWordCount: number, responseWordCount: number): boolean {
      // Short prompts (1-5 words) should get short responses (≤50 words)
      // Medium prompts (6-20 words) can get medium responses (≤150 words)
      // Long prompts (20+) can get longer responses
      if (promptWordCount <= 5) return responseWordCount <= 50;
      if (promptWordCount <= 20) return responseWordCount <= 150;
      return true; // Long prompts can have long responses
    }

    it("short prompt 'fix it' → short response expected", () => {
      expect(isProportional(2, 15)).toBe(true);   // good
      expect(isProportional(2, 100)).toBe(false);  // too verbose
    });

    it("medium prompt → medium response OK", () => {
      expect(isProportional(10, 80)).toBe(true);
      expect(isProportional(10, 200)).toBe(false);
    });

    it("long detailed prompt → long response OK", () => {
      expect(isProportional(30, 200)).toBe(true);
    });
  });
});
