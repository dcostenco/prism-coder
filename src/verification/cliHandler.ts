import * as fs from 'fs/promises';
import { StorageBackend } from '../storage/interface.js';
import { computeRubricHash, VerificationHarness } from './schema.js';

/** H5 fix: Centralize the harness file path as a constant */
const DEFAULT_HARNESS_PATH = './verification_harness.json';

/** M11 fix: Extract CI environment detection into a reusable utility */
function isStrictVerificationEnv(): boolean {
  return (
    process.env.CI === 'true' ||
    process.env.CI === '1' ||
    process.env.GITHUB_ACTIONS === 'true' ||
    process.env.GITLAB_CI === 'true' ||
    process.env.PRISM_STRICT_VERIFICATION === 'true'
  );
}

export async function handleVerifyStatus(storage: StorageBackend, project: string, force: boolean = false, userId: string = 'default') {
  console.log(`\n🔍 Checking verification status for project: ${project}${force ? ' (FORCE BYPASS ENABLED)' : ''}...`);

  // 1. Get latest run
  const runs = await storage.listVerificationRuns(project, userId);
  const lastRun = runs[0];

  if (!lastRun) {
    console.log("⚠️  No previous verification runs found.");
    return;
  }

  // 2. Display Status
  const passText = lastRun.passed ? 'YES' : 'NO';
  const OVERRIDEN = lastRun.gate_override ? '[OVERRIDDEN] ' : '';
  console.log(`✅ Last Run: ${lastRun.run_at} | Passed: ${OVERRIDEN}${passText}`);
  console.log(`   Pass Rate: ${(lastRun.pass_rate * 100).toFixed(1)}% | Critical Failures: ${lastRun.critical_failures}`);
  console.log(`   Coverage Score: ${(lastRun.coverage_score * 100).toFixed(1)}% | Gate Action: ${lastRun.gate_action}`);

  // 3. Drift Detection
  // C5 fix: Separate readFile and JSON.parse error paths for accurate messages
  let harnessRaw: string;
  try {
    harnessRaw = await fs.readFile(DEFAULT_HARNESS_PATH, 'utf-8');
  } catch (e: any) {
    console.log("\nℹ️  No local verification_harness.json found to check against.");
    return;
  }

  let localHarness: VerificationHarness;
  try {
    localHarness = JSON.parse(harnessRaw);
  } catch (e: any) {
    console.error(`\n❌ Invalid JSON in ${DEFAULT_HARNESS_PATH}: ${(e as Error).message}`);
    return;
  }

  const localHash = computeRubricHash(localHarness.tests);

  if (localHash !== lastRun.rubric_hash) {
    if (force) {
      console.warn("\n🚨 [OVERRIDDEN] CONFIGURATION DRIFT DETECTED!");
      console.warn(`   Stored Rubric Hash: ${lastRun.rubric_hash.slice(0, 8)}...`);
      console.warn(`   Actual Rubric Hash: ${localHash.slice(0, 8)}...`);
      console.warn("   Bypassing drift block due to --force flag.");
    } else {
      const strictEnv = isStrictVerificationEnv();
      if (strictEnv) {
        console.error("\n🚫 [BLOCK] CONFIGURATION DRIFT DETECTED IN CI ENVIRONMENT!");
        console.error(`   Stored Rubric Hash: ${lastRun.rubric_hash.slice(0, 8)}...`);
        console.error(`   Actual Rubric Hash: ${localHash.slice(0, 8)}...`);
        console.error("   Action: Pipeline blocked. Run 'prism verify generate' before merging to update your harness.");
        process.exit(1);
      } else {
        console.error("\n🚨 CONFIGURATION DRIFT DETECTED!");
        console.error(`   Stored Rubric Hash: ${lastRun.rubric_hash.slice(0, 8)}...`);
        console.error(`   Actual Rubric Hash: ${localHash.slice(0, 8)}...`);
        console.error("   Warning: Active drift. Action: Run 'prism verify generate' to update your harness.");
      }
    }
  } else {
    console.log("\n✨ Harness is synchronized.");
  }
}

export async function handleGenerateHarness(storage: StorageBackend, project: string, force: boolean = false, userId: string = 'default') {
  console.log(`\n🛠  Generating/Refreshing harness for project: ${project}${force ? ' (FORCE ENABLED)' : ''}...`);

  // 1. Read local file
  let raw: string;
  try {
    raw = await fs.readFile(DEFAULT_HARNESS_PATH, 'utf-8');
  } catch (e) {
    console.error(`❌ Failed to read ${DEFAULT_HARNESS_PATH}. Does the file exist?`);
    return;
  }

  // C4 fix: Wrap JSON.parse in try/catch for user-friendly error messages
  let harnessData: any;
  try {
    harnessData = JSON.parse(raw);
  } catch (e: any) {
    console.error(`❌ Invalid JSON in ${DEFAULT_HARNESS_PATH}: ${(e as Error).message}`);
    return;
  }

  // H3 fix: If not --force, check if a harness already exists for this hash
  if (!force) {
    const existingHash = computeRubricHash(harnessData.tests);
    try {
      const existing = await storage.getVerificationHarness?.(existingHash, userId);
      if (existing) {
        console.warn(`\n⚠️  A harness with this rubric hash already exists (${existingHash.slice(0, 12)}...).`);
        console.warn("   Use --force to re-register anyway.");
        return;
      }
    } catch {
      // getVerificationHarness may not exist on all backends; proceed
    }
  }

  // 2. Add metadata
  const harness: VerificationHarness = {
    ...harnessData,
    project,
    created_at: new Date().toISOString(),
    rubric_hash: computeRubricHash(harnessData.tests)
  };

  // 3. Persist
  await storage.saveVerificationHarness(harness, userId);
  
  console.log(`✅ Success! Harness Registered.`);
  console.log(`   Hash: ${harness.rubric_hash.slice(0, 12)}...`);
  console.log(`   Tests: ${harness.tests.length} assertions.`);
}
