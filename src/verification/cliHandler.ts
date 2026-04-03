import * as fs from 'fs/promises';
import { StorageBackend } from '../storage/interface.js';
import { computeRubricHash, VerificationHarness } from './schema.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** H5 fix: Centralize the harness file path as a constant */
const DEFAULT_HARNESS_PATH = './verification_harness.json';

// ─── Typed result shapes ──────────────────────────────────────────────────────

/**
 * Canonical result shape for `verify status`.
 * Decouples decision logic from console rendering so behavior is testable
 * and output is consistent across local/CI flows.
 */
export interface VerifyStatusResult {
  schema_version: 1;
  project: string;
  /** No runs recorded yet */
  no_runs: boolean;
  /** Last run fields (present when no_runs=false) */
  last_run?: {
    run_at: string;
    passed: boolean;
    pass_rate: number;
    critical_failures: number;
    coverage_score: number;
    gate_action: string;
    gate_override: boolean;
    override_reason?: string;
  };
  /** Harness file could not be read (path doesn't exist) */
  harness_missing: boolean;
  /** Harness file exists but contains invalid JSON */
  harness_invalid_json: boolean;
  /** true = local harness matches stored rubric_hash */
  synchronized: boolean | null;
  /** Drift detail (present when synchronized=false) */
  drift?: {
    stored_hash: string;
    local_hash: string;
    /** Policy outcome: 'blocked' | 'warn' | 'bypassed' */
    policy: 'blocked' | 'warn' | 'bypassed';
    strict_env: boolean;
  };
  /** Stable action string for operators / CI integrations */
  recommended_action: string | null;
  /** Intended process exit code */
  exit_code: 0 | 1;
}

/**
 * Canonical result shape for `verify generate`.
 */
export interface GenerateHarnessResult {
  schema_version: 1;
  project: string;
  success: boolean;
  /** Already registered with same hash and --force not set */
  already_exists: boolean;
  /** File missing */
  file_missing: boolean;
  /** File contains invalid JSON */
  invalid_json: boolean;
  rubric_hash?: string;
  test_count?: number;
  /** Intended process exit code */
  exit_code: 0 | 1;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** M11 fix: Extract CI environment detection into a reusable utility */
export function isStrictVerificationEnv(): boolean {
  return (
    process.env.CI === 'true' ||
    process.env.CI === '1' ||
    process.env.GITHUB_ACTIONS === 'true' ||
    process.env.GITLAB_CI === 'true' ||
    process.env.PRISM_STRICT_VERIFICATION === 'true'
  );
}

// ─── Renderers ────────────────────────────────────────────────────────────────

/** Render a VerifyStatusResult as human-readable console output */
function renderVerifyStatus(result: VerifyStatusResult, jsonMode: boolean): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  console.log(`\n🔍 Checking verification status for project: ${result.project}...`);

  if (result.no_runs) {
    console.log('⚠️  No previous verification runs found.');
    return;
  }

  const r = result.last_run!;
  const overrideBadge = r.gate_override
    ? `[OVERRIDDEN${r.override_reason ? `: ${r.override_reason}` : ''}] `
    : '';
  const passText = r.passed ? 'YES' : 'NO';
  console.log(`✅ Last Run: ${r.run_at} | Passed: ${overrideBadge}${passText}`);
  console.log(`   Pass Rate: ${(r.pass_rate * 100).toFixed(1)}% | Critical Failures: ${r.critical_failures}`);
  console.log(`   Coverage Score: ${(r.coverage_score * 100).toFixed(1)}% | Gate Action: ${r.gate_action}`);

  if (result.harness_missing) {
    console.log('\nℹ️  No local verification_harness.json found to check against.');
    return;
  }

  if (result.harness_invalid_json) {
    console.error(`\n❌ Invalid JSON in ${DEFAULT_HARNESS_PATH}.`);
    return;
  }

  if (result.synchronized) {
    console.log('\n✨ Harness is synchronized.');
    return;
  }

  // Drift output — phrasing differs only by policy outcome, not unrelated wording
  const d = result.drift!;
  const hashLine = `   Stored Hash: ${d.stored_hash.slice(0, 8)}...  Local Hash: ${d.local_hash.slice(0, 8)}...`;

  if (d.policy === 'bypassed') {
    console.warn('\n🚨 [BYPASSED] Configuration drift detected.');
    console.warn(hashLine);
    console.warn(`   Drift block bypassed via --force. Recommended: run 'prism verify generate' to realign.`);
  } else if (d.policy === 'blocked') {
    console.error('\n🚫 [BLOCKED] Configuration drift detected — CI environment enforces strict policy.');
    console.error(hashLine);
    console.error(`   Action: run 'prism verify generate' before merging to update your harness.`);
  } else {
    // 'warn' — local dev
    console.warn('\n⚠️  [DRIFT] Configuration drift detected.');
    console.warn(hashLine);
    console.warn(`   Recommended: run 'prism verify generate' to update your harness.`);
  }
}

/** Render a GenerateHarnessResult as human-readable console output */
function renderGenerateHarness(result: GenerateHarnessResult, jsonMode: boolean): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  console.log(`\n🛠  Generating/Refreshing harness for project: ${result.project}...`);

  if (result.file_missing) {
    console.error(`❌ Failed to read ${DEFAULT_HARNESS_PATH}. Does the file exist?`);
    return;
  }
  if (result.invalid_json) {
    console.error(`❌ Invalid JSON in ${DEFAULT_HARNESS_PATH}.`);
    return;
  }
  if (result.already_exists) {
    console.warn(`\n⚠️  A harness with rubric hash ${result.rubric_hash?.slice(0, 12)}... already exists.`);
    console.warn('   Use --force to re-register anyway.');
    return;
  }
  if (result.success) {
    console.log('✅ Harness registered successfully.');
    console.log(`   Hash: ${result.rubric_hash?.slice(0, 12)}...`);
    console.log(`   Tests: ${result.test_count} assertions.`);
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * Core logic for `verify status`.
 * Returns a typed VerifyStatusResult — callers decide how to render/exit.
 */
export async function computeVerifyStatus(
  storage: StorageBackend,
  project: string,
  force: boolean = false,
  userId: string = 'default',
): Promise<VerifyStatusResult> {
  const base: VerifyStatusResult = {
    schema_version: 1,
    project,
    no_runs: false,
    harness_missing: false,
    harness_invalid_json: false,
    synchronized: null,
    recommended_action: null,
    exit_code: 0,
  };

  // 1. Get latest run
  const runs = await storage.listVerificationRuns(project, userId);
  const lastRun = runs[0];

  if (!lastRun) {
    return { ...base, no_runs: true, recommended_action: 'run prism verify generate' };
  }

  base.last_run = {
    run_at: lastRun.run_at,
    passed: lastRun.passed,
    pass_rate: lastRun.pass_rate,
    critical_failures: lastRun.critical_failures,
    coverage_score: lastRun.coverage_score,
    gate_action: lastRun.gate_action,
    gate_override: lastRun.gate_override ?? false,
    override_reason: lastRun.override_reason,
  };

  // 2. Drift detection — C5 fix: separate readFile and JSON.parse error paths
  let harnessRaw: string;
  try {
    harnessRaw = await fs.readFile(DEFAULT_HARNESS_PATH, 'utf-8');
  } catch {
    return { ...base, harness_missing: true };
  }

  let localHarness: VerificationHarness;
  try {
    localHarness = JSON.parse(harnessRaw);
  } catch {
    return { ...base, harness_invalid_json: true, exit_code: 1 };
  }

  const localHash = computeRubricHash(localHarness.tests);
  const storedHash = lastRun.rubric_hash;

  if (localHash === storedHash) {
    return { ...base, synchronized: true };
  }

  // Drift detected
  const strictEnv = isStrictVerificationEnv();
  const driftBase = { stored_hash: storedHash, local_hash: localHash, strict_env: strictEnv };
  const action = "run 'prism verify generate' to update your harness";

  if (force) {
    return {
      ...base,
      synchronized: false,
      drift: { ...driftBase, policy: 'bypassed' },
      recommended_action: action,
      exit_code: 0,
    };
  }

  if (strictEnv) {
    return {
      ...base,
      synchronized: false,
      drift: { ...driftBase, policy: 'blocked' },
      recommended_action: action,
      exit_code: 1,
    };
  }

  return {
    ...base,
    synchronized: false,
    drift: { ...driftBase, policy: 'warn' },
    recommended_action: action,
    exit_code: 0,
  };
}

/**
 * CLI entry-point for `verify status`.
 * Computes the result, renders it (human or JSON), then sets process.exitCode.
 */
export async function handleVerifyStatus(
  storage: StorageBackend,
  project: string,
  force: boolean = false,
  userId: string = 'default',
  jsonMode: boolean = false,
): Promise<void> {
  const result = await computeVerifyStatus(storage, project, force, userId);
  renderVerifyStatus(result, jsonMode);
  // Use process.exitCode rather than process.exit() for cleaner test teardown
  if (result.exit_code !== 0) {
    process.exitCode = result.exit_code;
  }
}

/**
 * Core logic for `verify generate`.
 * Returns a typed GenerateHarnessResult.
 */
export async function computeGenerateHarness(
  storage: StorageBackend,
  project: string,
  force: boolean = false,
  userId: string = 'default',
): Promise<GenerateHarnessResult> {
  const base: GenerateHarnessResult = {
    schema_version: 1,
    project,
    success: false,
    already_exists: false,
    file_missing: false,
    invalid_json: false,
    exit_code: 0,
  };

  let raw: string;
  try {
    raw = await fs.readFile(DEFAULT_HARNESS_PATH, 'utf-8');
  } catch {
    return { ...base, file_missing: true, exit_code: 1 };
  }

  let harnessData: any;
  try {
    harnessData = JSON.parse(raw);
  } catch {
    return { ...base, invalid_json: true, exit_code: 1 };
  }

  const rubric_hash = computeRubricHash(harnessData.tests);

  // H3 fix: If not --force, check if a harness already exists for this hash
  if (!force) {
    try {
      const existing = await storage.getVerificationHarness?.(rubric_hash, userId);
      if (existing) {
        return { ...base, already_exists: true, rubric_hash, exit_code: 0 };
      }
    } catch {
      // getVerificationHarness may not exist on all backends; proceed
    }
  }

  const harness: VerificationHarness = {
    ...harnessData,
    project,
    created_at: new Date().toISOString(),
    rubric_hash,
  };

  await storage.saveVerificationHarness(harness, userId);

  return {
    ...base,
    success: true,
    rubric_hash,
    test_count: harness.tests.length,
    exit_code: 0,
  };
}

/**
 * CLI entry-point for `verify generate`.
 */
export async function handleGenerateHarness(
  storage: StorageBackend,
  project: string,
  force: boolean = false,
  userId: string = 'default',
  jsonMode: boolean = false,
): Promise<void> {
  const result = await computeGenerateHarness(storage, project, force, userId);
  renderGenerateHarness(result, jsonMode);
  if (result.exit_code !== 0) {
    process.exitCode = result.exit_code;
  }
}
