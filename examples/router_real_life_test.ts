/**
 * Prism Task Router — Real-Life Evaluation Sandbox
 *
 * Deterministic route demo using computeRoute().
 * This reflects the pure heuristic engine only.
 *
 * Run:
 *   npx tsx examples/router_real_life_test.ts
 */

import { computeRoute } from "../src/tools/taskRouterHandler.js";
import type { SessionTaskRouteArgs } from "../src/tools/sessionMemoryDefinitions.js";

const scenarios: Array<{ label: string; task: SessionTaskRouteArgs }> = [
  {
    label: "A: trivial scaffold",
    task: {
      task_description:
        "Scaffold a new React component for the login button. Simple boilerplate.",
      files_involved: ["src/components/LoginButton.tsx"],
      estimated_scope: "minor_edit",
      project: "demo-web",
    },
  },
  {
    label: "B: moderate bug fix",
    task: {
      task_description:
        "Investigate why the user profile avatar is not loading and fix it. Add a unit test.",
      files_involved: ["src/components/Avatar.tsx", "tests/Avatar.test.tsx"],
      estimated_scope: "bug_fix",
      project: "demo-web",
    },
  },
  {
    label: "C: architectural change",
    task: {
      task_description:
        "Redesign authentication middleware for OAuth2, coordinate database migration, and apply security audit feedback. First update DB, then API.",
      files_involved: [
        "src/auth.ts",
        "src/db.ts",
        "src/api.ts",
        "package.json",
        "prisma/schema.prisma",
      ],
      estimated_scope: "refactor",
      project: "demo-api",
    },
  },
  {
    label: "D: vague request",
    task: {
      task_description: "Refactor the thing.",
      project: "demo-api",
    },
  },
];

function printScenario(label: string, task: SessionTaskRouteArgs) {
  const result = computeRoute(task);

  console.log(`\n=== Scenario ${label} ===`);
  console.log(`prompt: ${task.task_description}`);
  console.log(`scope: ${task.estimated_scope ?? "unset"}`);
  console.log(`files: ${task.files_involved?.length ?? 0}`);

  console.log(`target: ${result.target}`);
  console.log(`complexity_score: ${result.complexity_score}/10`);
  console.log(`confidence: ${(result.confidence * 100).toFixed(0)}%`);
  console.log(`recommended_tool: ${result.recommended_tool ?? "null"}`);
  console.log(`rationale: ${result.rationale}`);

  const signals = result.rationale
    .split("Signals:")
    .at(1)
    ?.replace(/\.$/, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  if (signals?.length) {
    console.log("signal breakdown:");
    for (const s of signals) console.log(`- ${s}`);
  }
}

console.log("Prism Task Router deterministic demo");
console.log("===================================");

for (const { label, task } of scenarios) {
  printScenario(label, task);
}

console.log("\nNote:");
console.log(
  "This script demonstrates computeRoute() only (deterministic heuristic engine)."
);
console.log(
  "Experience-adjusted routing is applied in sessionTaskRouteHandler/session_task_route."
);
