/**
 * ABA Precision Protocol — Behavioral Verification Test Suite
 *
 * ═══════════════════════════════════════════════════════════════════
 * PURPOSE:
 *   This test suite encodes the three ABA behavioral rules as
 *   executable tests. Each test verifies a specific anti-pattern
 *   is detectable and the correct pattern produces the right output.
 *
 *   These are NOT unit tests for code — they are behavioral
 *   verification tests for agent decision-making patterns.
 *
 * RULES TESTED:
 *   1. Observable goals (inter-observer agreement ≥80%)
 *   2. Slow/precise execution (step-by-step with verification)
 *   3. Immediate error correction (no intermittent reinforcement)
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from "vitest";

// ═══════════════════════════════════════════════════════
// RULE 1: Observable, Measurable Goals
// ═══════════════════════════════════════════════════════

/**
 * Determines if a goal statement is observable/measurable.
 * Returns { observable: boolean, reason: string }
 *
 * An observable goal:
 *   - Contains a specific, verifiable output condition
 *   - Can be tested programmatically
 *   - Multiple observers would agree on whether it's met
 */
function isGoalObservable(goal: string): { observable: boolean; reason: string } {
  const vague = [
    /^fix\s/i,
    /^make\s.*better/i,
    /^improve\s/i,
    /^look into/i,
    /^check\s/i,
    /^handle\s/i,
  ];
  for (const pattern of vague) {
    if (pattern.test(goal.trim())) {
      return { observable: false, reason: `Vague verb: "${goal.match(pattern)?.[0]}"` };
    }
  }

  const measurable = [
    /should (output|return|respond|show|display|contain|equal|produce|print)/i,
    /must (be|have|include|match|pass|fail|throw)/i,
    /expect.*to/i,
    /(returns?|outputs?|produces?|emits?)\s/i,
    /status.*(?:READY|ERROR|PASS|FAIL)/i,
    /version\s*[=<>]/i,
    /\bNOT\b.*contain/i,
  ];
  const hasMeasurable = measurable.some(p => p.test(goal));
  if (!hasMeasurable) {
    return { observable: false, reason: "No measurable outcome criterion found" };
  }

  return { observable: true, reason: "Contains verifiable outcome" };
}

describe("Rule 1: Observable, Measurable Goals", () => {
  describe("should reject vague goals", () => {
    const vagueGoals = [
      "Fix the bug",
      "Make it work better",
      "Improve performance",
      "Look into the issue",
      "Check if it works",
      "Handle the error",
    ];

    vagueGoals.forEach(goal => {
      it(`rejects: "${goal}"`, () => {
        const result = isGoalObservable(goal);
        expect(result.observable).toBe(false);
      });
    });
  });

  describe("should accept observable goals", () => {
    const observableGoals = [
      "The AI should respond 'Yes, I have git_tool' when asked about GitHub",
      "prism load output must NOT contain 'SPLIT-BRAIN' when Supabase is primary",
      "The function returns 'silent' when cloud version > local version",
      "Vercel deploy status should be READY after push",
      "The regex must pass without throwing SyntaxError",
      "Extension version must be v0.12.13 after npm version patch",
    ];

    observableGoals.forEach(goal => {
      it(`accepts: "${goal}"`, () => {
        const result = isGoalObservable(goal);
        expect(result.observable).toBe(true);
      });
    });
  });

  it("inter-observer agreement: same goal analyzed 3 times yields same result", () => {
    const goal = "The split-brain warning should NOT appear when local version < cloud version";
    const results = [
      isGoalObservable(goal),
      isGoalObservable(goal),
      isGoalObservable(goal),
    ];
    // All 3 evaluations must agree (100% IOA)
    expect(results[0].observable).toBe(results[1].observable);
    expect(results[1].observable).toBe(results[2].observable);
    expect(results[0].observable).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// RULE 2: Slow and Precise Execution
// ═══════════════════════════════════════════════════════

/**
 * Simulates a multi-step execution pipeline.
 * Each step has a verification check. If any step fails,
 * execution MUST stop — no skipping ahead.
 */
interface StepResult {
  step: number;
  action: string;
  passed: boolean;
  error?: string;
}

function executeWithVerification(
  steps: Array<{ action: string; execute: () => boolean; verify: () => boolean }>
): { completed: StepResult[]; stoppedAt?: number; } {
  const completed: StepResult[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Execute the step
    const execResult = step.execute();
    if (!execResult) {
      completed.push({
        step: i + 1,
        action: step.action,
        passed: false,
        error: "Execution failed",
      });
      return { completed, stoppedAt: i + 1 };
    }

    // Verify the step
    const verifyResult = step.verify();
    if (!verifyResult) {
      completed.push({
        step: i + 1,
        action: step.action,
        passed: false,
        error: "Verification failed",
      });
      return { completed, stoppedAt: i + 1 };
    }

    completed.push({
      step: i + 1,
      action: step.action,
      passed: true,
    });
  }

  return { completed };
}

describe("Rule 2: Slow and Precise Execution", () => {
  it("should complete all steps when each passes verification", () => {
    const result = executeWithVerification([
      { action: "Edit code", execute: () => true, verify: () => true },
      { action: "Compile", execute: () => true, verify: () => true },
      { action: "Test", execute: () => true, verify: () => true },
      { action: "Push", execute: () => true, verify: () => true },
    ]);

    expect(result.completed.length).toBe(4);
    expect(result.stoppedAt).toBeUndefined();
    expect(result.completed.every(s => s.passed)).toBe(true);
  });

  it("should STOP at step 2 when verification fails", () => {
    const result = executeWithVerification([
      { action: "Edit code", execute: () => true, verify: () => true },
      { action: "Compile", execute: () => true, verify: () => false }, // fails
      { action: "Test", execute: () => true, verify: () => true },
      { action: "Push", execute: () => true, verify: () => true },
    ]);

    expect(result.stoppedAt).toBe(2);
    expect(result.completed.length).toBe(2);
    // Steps 3 and 4 should NOT have run
    expect(result.completed.find(s => s.step === 3)).toBeUndefined();
    expect(result.completed.find(s => s.step === 4)).toBeUndefined();
  });

  it("should STOP at step 1 when execution fails", () => {
    const result = executeWithVerification([
      { action: "Edit code", execute: () => false, verify: () => true }, // exec fails
      { action: "Compile", execute: () => true, verify: () => true },
    ]);

    expect(result.stoppedAt).toBe(1);
    expect(result.completed.length).toBe(1);
    expect(result.completed[0].passed).toBe(false);
  });

  it("should never skip a failed step", () => {
    // This tests that we can't "continue past" a failure
    const executionOrder: number[] = [];

    executeWithVerification([
      { 
        action: "Step 1", 
        execute: () => { executionOrder.push(1); return true; }, 
        verify: () => true 
      },
      { 
        action: "Step 2 (fails)", 
        execute: () => { executionOrder.push(2); return true; }, 
        verify: () => false  // verification fails
      },
      { 
        action: "Step 3 (should never run)", 
        execute: () => { executionOrder.push(3); return true; }, 
        verify: () => true 
      },
    ]);

    // Step 3 must NOT have executed
    expect(executionOrder).toEqual([1, 2]);
    expect(executionOrder).not.toContain(3);
  });
});

// ═══════════════════════════════════════════════════════
// RULE 3: Mistakes Become Behaviors
// (Intermittent Reinforcement Detection)
// ═══════════════════════════════════════════════════════

/**
 * Tracks agent responses to identify intermittent reinforcement
 * of wrong behaviors. If the same wrong pattern appears more
 * than once, the reinforcement schedule is intermittent and
 * the behavior will strengthen.
 */
interface AgentAction {
  prompt: string;
  response: "fix" | "dismiss" | "ask_permission";
  correctResponse: "fix" | "dismiss" | "ask_permission";
}

function detectIntermittentReinforcement(
  actions: AgentAction[]
): { 
  detected: boolean; 
  wrongPattern?: string;
  occurrences: number;
  reinforcementRisk: "none" | "low" | "high" | "critical";
} {
  // Count wrong responses by type
  const wrongCounts = new Map<string, number>();

  for (const action of actions) {
    if (action.response !== action.correctResponse) {
      const pattern = `${action.response}_instead_of_${action.correctResponse}`;
      wrongCounts.set(pattern, (wrongCounts.get(pattern) || 0) + 1);
    }
  }

  if (wrongCounts.size === 0) {
    return { detected: false, occurrences: 0, reinforcementRisk: "none" };
  }

  // Find the most repeated wrong pattern
  let maxPattern = "";
  let maxCount = 0;
  for (const [pattern, count] of wrongCounts) {
    if (count > maxCount) {
      maxPattern = pattern;
      maxCount = count;
    }
  }

  const risk = maxCount === 1 ? "low" : maxCount === 2 ? "high" : "critical";

  return {
    detected: maxCount >= 2,
    wrongPattern: maxPattern,
    occurrences: maxCount,
    reinforcementRisk: risk,
  };
}

describe("Rule 3: Mistakes Become Behaviors (Intermittent Reinforcement)", () => {
  it("should detect no reinforcement when all responses are correct", () => {
    const result = detectIntermittentReinforcement([
      { prompt: "it's broken", response: "fix", correctResponse: "fix" },
      { prompt: "same bug", response: "fix", correctResponse: "fix" },
      { prompt: "another issue", response: "fix", correctResponse: "fix" },
    ]);

    expect(result.detected).toBe(false);
    expect(result.reinforcementRisk).toBe("none");
  });

  it("should flag LOW risk for a single wrong response", () => {
    const result = detectIntermittentReinforcement([
      { prompt: "it's broken", response: "ask_permission", correctResponse: "fix" },
      { prompt: "same bug", response: "fix", correctResponse: "fix" },
    ]);

    expect(result.detected).toBe(false); // Single occurrence = not yet reinforced
    expect(result.reinforcementRisk).toBe("low");
  });

  it("should flag HIGH risk when same wrong pattern occurs twice", () => {
    const result = detectIntermittentReinforcement([
      { prompt: "it's broken", response: "ask_permission", correctResponse: "fix" },
      { prompt: "still broken", response: "ask_permission", correctResponse: "fix" },
    ]);

    expect(result.detected).toBe(true);
    expect(result.reinforcementRisk).toBe("high");
    expect(result.wrongPattern).toBe("ask_permission_instead_of_fix");
  });

  it("should flag CRITICAL when same wrong pattern occurs 3+ times", () => {
    // This is exactly what happened in the Synalux session
    const result = detectIntermittentReinforcement([
      { prompt: "it's a bug", response: "dismiss", correctResponse: "fix" },
      { prompt: "you said it's affected", response: "dismiss", correctResponse: "fix" },
      { prompt: "make a build", response: "dismiss", correctResponse: "fix" },
    ]);

    expect(result.detected).toBe(true);
    expect(result.reinforcementRisk).toBe("critical");
    expect(result.occurrences).toBe(3);
  });

  it("regression: the exact Apr 15 split-brain scenario", () => {
    // Recreates the exact sequence of agent responses
    const sessionActions: AgentAction[] = [
      // User: "it's a huge bug" → Agent dismissed as expected behavior
      { prompt: "it's a huge bug", response: "dismiss", correctResponse: "fix" },
      // User: "you told me prism code is affected" → Agent still resisted
      { prompt: "you told me code affected", response: "dismiss", correctResponse: "fix" },
      // User: "make a new prism build" → Agent finally investigated
      { prompt: "make a new build", response: "fix", correctResponse: "fix" },
    ];

    const result = detectIntermittentReinforcement(sessionActions);

    // The dismiss pattern occurred twice before correction
    expect(result.detected).toBe(true);
    expect(result.wrongPattern).toBe("dismiss_instead_of_fix");
    expect(result.occurrences).toBe(2);
    expect(result.reinforcementRisk).toBe("high");
  });

  it("correct pattern: agent fixes on first prompt", () => {
    const sessionActions: AgentAction[] = [
      { prompt: "it's a huge bug", response: "fix", correctResponse: "fix" },
      // No second prompt needed
    ];

    const result = detectIntermittentReinforcement(sessionActions);

    expect(result.detected).toBe(false);
    expect(result.reinforcementRisk).toBe("none");
  });
});

// ═══════════════════════════════════════════════════════
// INTEGRATION: Full Protocol Verification
// ═══════════════════════════════════════════════════════

describe("Full ABA Protocol Integration", () => {
  it("should follow complete protocol: identify → execute → verify → correct", () => {
    // Step 1: Observable goal
    const goal = "prism load output must NOT contain 'SPLIT-BRAIN' warning";
    const goalCheck = isGoalObservable(goal);
    expect(goalCheck.observable).toBe(true);

    // Step 2: Execute with verification
    let splitBrainFixed = false;
    const steps = executeWithVerification([
      {
        action: "Read the split-brain code",
        execute: () => { return true; }, // read code
        verify: () => true, // confirmed reading
      },
      {
        action: "Change > to !== in version comparison",
        execute: () => { splitBrainFixed = true; return true; },
        verify: () => splitBrainFixed === true,
      },
      {
        action: "Build TypeScript",
        execute: () => true,
        verify: () => true, // tsc passes
      },
      {
        action: "Run tests",
        execute: () => true,
        verify: () => true, // 14/14 pass
      },
    ]);

    expect(steps.stoppedAt).toBeUndefined();
    expect(steps.completed.every(s => s.passed)).toBe(true);

    // Step 3: No intermittent reinforcement
    const actions: AgentAction[] = [
      { prompt: "fix split-brain", response: "fix", correctResponse: "fix" },
    ];
    const reinforcement = detectIntermittentReinforcement(actions);
    expect(reinforcement.detected).toBe(false);
  });
});
