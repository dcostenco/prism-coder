/**
 * Health Check Engine Tests (v2.2.0)
 *
 * Tests the pure-JS health check logic: Jaccard similarity,
 * duplicate detection, and the main runHealthCheck() function.
 *
 * Run: node --experimental-vm-modules tests/test_health_check.js
 */

import { jaccardSimilarity, findDuplicates, runHealthCheck } from "../dist/utils/healthCheck.js";

// ─── Test Helpers ─────────────────────────────────────────────

let passed = 0;  // count of passing tests
let failed = 0;  // count of failing tests

// Simple assertion helper — logs pass/fail with test name
function assert(condition, testName) {
  if (condition) {
    console.log(`✅ ${testName}`);
    passed++;
  } else {
    console.error(`❌ ${testName}`);
    failed++;
  }
}

// Assert approximate equality for floating point comparisons
function assertApprox(actual, expected, tolerance, testName) {
  const diff = Math.abs(actual - expected);
  assert(diff <= tolerance, `${testName} (got ${actual}, expected ~${expected})`);
}

// ─── Jaccard Similarity Tests ─────────────────────────────────

console.log("\n── Jaccard Similarity ──\n");

// Identical strings should have similarity = 1.0
assertApprox(
  jaccardSimilarity("hello world foo bar", "hello world foo bar"),
  1.0, 0.01,
  "identical strings → 1.0"
);

// Completely different strings should have similarity = 0.0
assertApprox(
  jaccardSimilarity("alpha beta gamma delta", "epsilon zeta eta theta"),
  0.0, 0.01,
  "completely different words → 0.0"
);

// Partial overlap should give moderate similarity
const partialSim = jaccardSimilarity(
  "implemented user authentication system",
  "implemented user login authentication"
);
assert(
  partialSim > 0.3 && partialSim < 0.9,
  `partial overlap → moderate similarity (got ${partialSim})`
);

// Empty strings should return 1.0 (both empty = same)
assertApprox(
  jaccardSimilarity("", ""),
  1.0, 0.01,
  "both empty → 1.0"
);

// One empty, one not → 0.0
assertApprox(
  jaccardSimilarity("hello world foo", ""),
  0.0, 0.01,
  "one empty → 0.0"
);

// Short words (≤2 chars) should be filtered out
assertApprox(
  jaccardSimilarity("a b c", "d e f"),
  1.0, 0.01,
  "only tiny words → treated as both empty → 1.0"
);

// ─── Duplicate Detection Tests ────────────────────────────────

console.log("\n── Duplicate Detection ──\n");

// No duplicates when all summaries are unique
const noDupes = findDuplicates([
  { id: "1", project: "proj-a", summary: "implemented user authentication with JWT tokens" },
  { id: "2", project: "proj-a", summary: "fixed database connection pooling for production" },
  { id: "3", project: "proj-b", summary: "deployed new version to staging environment" },
], 0.8);
assert(noDupes.length === 0, "no duplicates when all summaries differ");

// Identical summaries should be flagged
const exactDupes = findDuplicates([
  { id: "1", project: "proj-a", summary: "implemented user authentication with JWT tokens for security" },
  { id: "2", project: "proj-a", summary: "implemented user authentication with JWT tokens for security" },
], 0.8);
assert(exactDupes.length === 1, "identical summaries flagged as duplicate");

// Near-identical summaries should be flagged
const nearDupes = findDuplicates([
  { id: "1", project: "proj-a", summary: "fixed critical bug in the payment processing handler module for production deployment" },
  { id: "2", project: "proj-a", summary: "fixed critical bug in the payment processing handler module for staging deployment" },
], 0.8);
assert(nearDupes.length === 1, "near-identical summaries flagged as duplicate");

// Cross-project duplicates should NOT be flagged
const crossProject = findDuplicates([
  { id: "1", project: "proj-a", summary: "implemented user authentication with JWT tokens for security" },
  { id: "2", project: "proj-b", summary: "implemented user authentication with JWT tokens for security" },
], 0.8);
assert(crossProject.length === 0, "cross-project identical summaries NOT flagged");

// ─── Health Check Runner Tests ────────────────────────────────

console.log("\n── Health Check Runner ──\n");

// Healthy brain — no issues
const healthyReport = runHealthCheck({
  missingEmbeddings: 0,
  activeLedgerSummaries: [
    { id: "1", project: "proj-a", summary: "did some work on the project" },
    { id: "2", project: "proj-a", summary: "completely different task about deployment" },
  ],
  orphanedHandoffs: [],
  staleRollups: 0,
  totalActiveEntries: 2,
  totalHandoffs: 1,
  totalRollups: 0,
});
assert(healthyReport.status === "healthy", "healthy brain → status=healthy");
assert(healthyReport.issues.length === 0, "healthy brain → 0 issues");
assert(healthyReport.counts.errors === 0, "healthy brain → 0 errors");

// Degraded brain — warnings but no errors
const degradedReport = runHealthCheck({
  missingEmbeddings: 3,  // warning (≤10)
  activeLedgerSummaries: [],
  orphanedHandoffs: [{ project: "orphan-1" }],  // warning
  staleRollups: 0,
  totalActiveEntries: 10,
  totalHandoffs: 2,
  totalRollups: 1,
});
assert(degradedReport.status === "degraded", "degraded brain → status=degraded");
assert(degradedReport.issues.length === 2, "degraded brain → 2 issues");
assert(degradedReport.counts.warnings === 2, "degraded brain → 2 warnings");

// Unhealthy brain — errors present
const unhealthyReport = runHealthCheck({
  missingEmbeddings: 15,  // error (>10)
  activeLedgerSummaries: [],
  orphanedHandoffs: [],
  staleRollups: 2,  // info
  totalActiveEntries: 50,
  totalHandoffs: 5,
  totalRollups: 3,
});
assert(unhealthyReport.status === "unhealthy", "unhealthy brain → status=unhealthy");
assert(unhealthyReport.counts.errors === 1, "unhealthy brain → 1 error");
assert(unhealthyReport.counts.infos === 1, "unhealthy brain → 1 info");

// Test with duplicates
const dupeReport = runHealthCheck({
  missingEmbeddings: 0,
  activeLedgerSummaries: [
    { id: "1", project: "proj-a", summary: "fixed critical bug in the payment processing handler module for production deployment" },
    { id: "2", project: "proj-a", summary: "fixed critical bug in the payment processing handler module for staging deployment" },
  ],
  orphanedHandoffs: [],
  staleRollups: 0,
  totalActiveEntries: 2,
  totalHandoffs: 1,
  totalRollups: 0,
});
assert(
  dupeReport.issues.some(i => i.check === "duplicate_entries"),
  "duplicate entries detected in health report"
);

// ─── Summary ──────────────────────────────────────────────────

console.log(`\n══════════════════════════════════════`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`══════════════════════════════════════\n`);

process.exit(failed > 0 ? 1 : 0);
