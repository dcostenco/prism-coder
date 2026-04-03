import * as fs from "fs";
import { getQuickJS } from "quickjs-emscripten";
import {
  TestSuiteSchema,
  TestAssertion,
  type AssertionResult,
  type LayerResult,
  type VerificationResult,
  type VerificationConfig,
  type SeverityLevel,
  type VerificationHarness,
  computeRubricHash,
} from "./schema.js";
import { evaluateSeverityGates, resolveEffectiveSeverity } from "./severityPolicy.js";

// ─── Utilities ──────────────────────────────────────────────

/** Deeply match objects (expected ⊆ actual) */
function deepMatch(actual: any, expected: any): boolean {
  if (typeof expected !== 'object' || expected === null) {
    return actual === expected;
  }
  // H1 fix: Guard against null/undefined/primitive actual before iterating
  if (typeof actual !== 'object' || actual === null) {
    return false;
  }
  for (const key of Object.keys(expected)) {
    if (typeof actual[key] === 'object') {
      if (!deepMatch(actual[key], expected[key])) return false;
    } else if (actual[key] !== expected[key]) {
      return false;
    }
  }
  return true;
}

/** Race a promise against a timeout */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Assertion timed out after ${ms}ms`)), ms)
    ),
  ]);
}

/** Sleep utility for retry backoff */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const PRIVATE_IPV4_CIDRS: Array<[number, number]> = [
  [ipToInt("10.0.0.0"), ipToInt("10.255.255.255")],
  [ipToInt("127.0.0.0"), ipToInt("127.255.255.255")],
  [ipToInt("169.254.0.0"), ipToInt("169.254.255.255")],
  [ipToInt("172.16.0.0"), ipToInt("172.31.255.255")],
  [ipToInt("192.168.0.0"), ipToInt("192.168.255.255")],
  [ipToInt("100.64.0.0"), ipToInt("100.127.255.255")],
  [ipToInt("0.0.0.0"), ipToInt("0.255.255.255")],
  [ipToInt("224.0.0.0"), ipToInt("255.255.255.255")],
];

function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isPrivateIpv4(hostname: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;
  const value = ipToInt(hostname);
  return PRIVATE_IPV4_CIDRS.some(([start, end]) => value >= start && value <= end);
}

function isDisallowedIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") || // fc00::/7
    normalized.startsWith("fd") || // fc00::/7
    normalized.startsWith("fe8") || // fe80::/10
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized === "::" ||
    normalized === "0:0:0:0:0:0:0:0"
  );
}

function validateHttpTarget(target: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return { ok: false, reason: `Invalid URL: ${target}` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `Unsupported protocol: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return { ok: false, reason: `Blocked host: ${hostname}` };
  }

  // Block decimal/hex IP obfuscation (e.g. http://2852039166/ → 169.254.169.254)
  if (/^0x[0-9a-fA-F]+$/.test(hostname) || /^\d+$/.test(hostname)) {
    return { ok: false, reason: `Blocked obfuscated IP: ${hostname}` };
  }

  if (isPrivateIpv4(hostname) || isDisallowedIpv6(hostname)) {
    return { ok: false, reason: `Blocked internal IP: ${hostname}` };
  }

  return { ok: true };
}

interface PreparedAssertion {
  test: TestAssertion;
  skipped?: AssertionResult;
  dependencyReason?: string;
  dependents: string[];
}

interface ExecutionOutcome {
  passed: boolean;
  skipped: boolean;
}

function skipResult(test: TestAssertion, reason: string): AssertionResult {
  return {
    id: test.id,
    layer: test.layer,
    description: test.description,
    severity: test.severity,
    passed: false,
    skipped: true,
    skip_reason: reason,
    duration_ms: 0,
    retries_used: 0,
  };
}

function prepareAssertions(
  tests: TestAssertion[],
  filterLayers: string[],
  minSeverity: SeverityLevel | undefined,
  config: VerificationConfig
): {
  preparedById: Map<string, PreparedAssertion>;
  orderedIds: string[];
  precomputed: Map<string, AssertionResult>;
} {
  const preparedById = new Map<string, PreparedAssertion>();
  const orderedIds: string[] = [];
  const precomputed = new Map<string, AssertionResult>();

  for (let index = 0; index < tests.length; index++) {
    const test = tests[index];
    orderedIds.push(test.id);

    if (preparedById.has(test.id)) {
      precomputed.set(test.id, skipResult(test, `Duplicate assertion id "${test.id}"`));
      continue;
    }

    let skipped: AssertionResult | undefined;

    if (!filterLayers.includes(test.layer)) {
      skipped = skipResult(test, `Layer "${test.layer}" not in active layers [${filterLayers.join(", ")}]`);
    }

    if (!skipped && minSeverity) {
      const effective = resolveEffectiveSeverity(test.severity, config.default_severity);
      const severityOrder = { warn: 0, gate: 1, abort: 2 };
      if (severityOrder[effective] < severityOrder[minSeverity]) {
        skipped = skipResult(test, `Severity "${effective}" below minimum "${minSeverity}"`);
      }
    }

    const prepared: PreparedAssertion = {
      test,
      skipped,
      dependents: [],
    };

    preparedById.set(test.id, prepared);
    if (skipped) precomputed.set(test.id, skipped);
  }

  for (const prepared of preparedById.values()) {
    const dep = prepared.test.depends_on;
    if (!dep) continue;

    const depAssertion = preparedById.get(dep);
    if (!depAssertion) {
      const depReason = `Dependency "${dep}" not found`;
      prepared.dependencyReason = depReason;
      precomputed.set(prepared.test.id, skipResult(prepared.test, depReason));
      continue;
    }

    depAssertion.dependents.push(prepared.test.id);
  }

  const indegree = new Map<string, number>();
  for (const [id, prepared] of preparedById.entries()) {
    indegree.set(id, prepared.test.depends_on && !prepared.dependencyReason ? 1 : 0);
  }

  const queue: string[] = [];
  for (const [id, count] of indegree.entries()) {
    if (count === 0) queue.push(id);
  }

  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;

    const prepared = preparedById.get(id);
    if (!prepared) continue;

    for (const dependentId of prepared.dependents) {
      const next = (indegree.get(dependentId) || 0) - 1;
      indegree.set(dependentId, next);
      if (next === 0) queue.push(dependentId);
    }
  }

  if (visited < preparedById.size) {
    for (const [id, count] of indegree.entries()) {
      if (count > 0) {
        const prepared = preparedById.get(id);
        if (!prepared) continue;
        if (!precomputed.has(id)) {
          precomputed.set(id, skipResult(prepared.test, `Cyclic dependency involving "${id}"`));
        }
      }
    }
  }

  return { preparedById, orderedIds, precomputed };
}

// ─── Default config when none provided ──────────────────────
const DEFAULT_CONFIG: VerificationConfig = {
  enabled: true,
  layers: ["data", "agent", "pipeline"],
  default_severity: "warn",
};

// ─── Run Options ────────────────────────────────────────────
export interface RunSuiteOptions {
  /** Only run assertions in these layers */
  layers?: string[];
  /** Minimum severity to run (skip assertions below this) */
  minSeverity?: SeverityLevel;
  /** Global config for severity gate evaluation */
  config?: VerificationConfig;
  /** Optional verification harness to validate the rubric hash against */
  harness?: VerificationHarness;
}

// ─── v7.2.0: Enhanced Verification Runner ───────────────────

export class VerificationRunner {

  /**
   * Validates that the provided tests match the expected rubric hash from the harness.
   * Throws an error if the hash does not match, ensuring test integrity.
   */
  static verifyRubricHash(tests: TestAssertion[], harness: VerificationHarness): void {
    const computed = computeRubricHash(tests);
    if (computed !== harness.rubric_hash) {
      throw new Error(`Rubric hash mismatch. Expected ${harness.rubric_hash}, but computeRubricHash returned ${computed}. The tests have been modified since the harness was created.`);
    }
  }

  /**
   * v7.2.0 enhanced suite runner.
   *
   * - Layer/severity filtering
   * - Per-assertion timeout
   * - Retry logic for transient failures
   * - Dependency chain resolution
   * - Structured VerificationResult with per-layer breakdown
   * - Rubric hash validation if a harness is provided
   */
  static async runSuite(
    jsonContent: string,
    options?: RunSuiteOptions
  ): Promise<VerificationResult> {
    const startTime = Date.now();
    const config = options?.config ?? DEFAULT_CONFIG;
    const filterLayers = options?.layers ?? config.layers;
    const minSeverity = options?.minSeverity;
    const harness = options?.harness;

    let assertionResults: AssertionResult[] = [];

    try {
      const parsed = JSON.parse(jsonContent);
      const suite = TestSuiteSchema.parse(parsed);

      if (harness) {
        VerificationRunner.verifyRubricHash(suite.tests, harness);
      }

      const { preparedById, orderedIds, precomputed } = prepareAssertions(
        suite.tests,
        filterLayers,
        minSeverity,
        config
      );

      const outcomes = new Map<string, ExecutionOutcome>();
      const resultById = new Map<string, AssertionResult>(precomputed);

      for (const [id] of preparedById.entries()) {
        if (precomputed.has(id)) {
          outcomes.set(id, { passed: false, skipped: true });
        }
      }

      const pending = new Map(preparedById);
      for (const id of precomputed.keys()) {
        pending.delete(id);
      }
      while (pending.size > 0) {
        const ready: PreparedAssertion[] = [];

        for (const prepared of pending.values()) {
          if (prepared.test.depends_on && !outcomes.has(prepared.test.depends_on)) {
            continue;
          }
          ready.push(prepared);
        }

        if (ready.length === 0) {
          // Safety guard — remaining assertions are unresolved; skip them.
          for (const prepared of pending.values()) {
            const unresolved = skipResult(prepared.test, `Unresolved dependency state for "${prepared.test.id}"`);
            resultById.set(prepared.test.id, unresolved);
            outcomes.set(prepared.test.id, { passed: false, skipped: true });
          }
          pending.clear();
          break;
        }

        await Promise.all(
          ready.map(async (prepared) => {
            pending.delete(prepared.test.id);

            if (prepared.skipped) {
              resultById.set(prepared.test.id, prepared.skipped);
              outcomes.set(prepared.test.id, { passed: false, skipped: true });
              return;
            }

            if (prepared.dependencyReason) {
              const skipped = skipResult(prepared.test, prepared.dependencyReason);
              resultById.set(prepared.test.id, skipped);
              outcomes.set(prepared.test.id, { passed: false, skipped: true });
              return;
            }

            if (prepared.test.depends_on) {
              const depOutcome = outcomes.get(prepared.test.depends_on);
              if (!depOutcome || !depOutcome.passed) {
                const depStatus = depOutcome?.skipped ? "skipped" : "failed";
                const skipped = skipResult(
                  prepared.test,
                  `Dependency "${prepared.test.depends_on}" ${depStatus}`
                );
                resultById.set(prepared.test.id, skipped);
                outcomes.set(prepared.test.id, { passed: false, skipped: true });
                return;
              }
            }

            const assertionStart = Date.now();
            const maxRetries = prepared.test.retry_count ?? 0;
            let lastError = "";
            let retriesUsed = 0;
            let passed = false;

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
              if (attempt > 0) {
                retriesUsed++;
                await sleep(Math.min(1000 * attempt, 3000));
              }

              try {
                const runPromise = this.runAssertion(prepared.test);
                const result = prepared.test.timeout_ms
                  ? await withTimeout(runPromise, prepared.test.timeout_ms)
                  : await runPromise;

                if (result.passed) {
                  passed = true;
                  break;
                } else {
                  lastError = result.error || "Assertion returned false";
                }
              } catch (e: any) {
                lastError = e.message || String(e);
              }
            }

            const result: AssertionResult = {
              id: prepared.test.id,
              layer: prepared.test.layer,
              description: prepared.test.description,
              severity: prepared.test.severity,
              passed,
              error: passed ? undefined : lastError,
              duration_ms: Date.now() - assertionStart,
              retries_used: retriesUsed,
              skipped: false,
            };

            resultById.set(prepared.test.id, result);
            outcomes.set(prepared.test.id, { passed, skipped: false });
          })
        );
      }

      assertionResults = orderedIds
        .map((id) => resultById.get(id))
        .filter((result): result is AssertionResult => Boolean(result));
    } catch (e: any) {
      // Parse error — return a single synthetic failure
      assertionResults = [{
        id: "__parse_error__",
        layer: "pipeline",
        description: "Test suite specification parse",
        severity: "abort",
        passed: false,
        error: `Specification Parse Error: ${e.message}`,
        duration_ms: Date.now() - startTime,
        retries_used: 0,
        skipped: false,
      }];
    }

    // ── Build per-layer breakdown ──
    const byLayer: Record<string, LayerResult> = {};
    for (const ar of assertionResults) {
      if (!byLayer[ar.layer]) {
        byLayer[ar.layer] = { passed: 0, failed: 0, skipped: 0, total: 0, assertions: [] };
      }
      const lr = byLayer[ar.layer];
      lr.total++;
      if (ar.skipped) lr.skipped++;
      else if (ar.passed) lr.passed++;
      else lr.failed++;
      lr.assertions.push(ar);
    }

    // ── Evaluate severity gates ──
    const severityGate = evaluateSeverityGates(assertionResults, config);
    const passedCount = assertionResults.filter(a => a.passed).length;
    const failedCount = assertionResults.filter(a => !a.passed && !a.skipped).length;
    const skippedCount = assertionResults.filter(a => a.skipped).length;

    return {
      passed: failedCount === 0,
      total: assertionResults.length,
      passed_count: passedCount,
      failed_count: failedCount,
      skipped_count: skippedCount,
      by_layer: byLayer,
      duration_ms: Date.now() - startTime,
      severity_gate: severityGate,
      assertion_results: assertionResults,
    };
  }

  // ── Legacy API (backward compat with v5.3 callers) ────────
  static async runSuiteLegacy(jsonContent: string): Promise<{ passed: boolean; failures: string[] }> {
    const result = await this.runSuite(jsonContent);
    return {
      passed: result.passed,
      failures: result.assertion_results
        .filter(a => !a.passed && !a.skipped)
        .map(a => `[${a.layer}] ${a.description} failed: ${a.error}`),
    };
  }

  static async runAssertion(test: TestAssertion): Promise<{ passed: boolean; error?: string }> {
    const a = test.assertion;
    switch (a.type) {
      case "file_exists": {
        const exists = fs.existsSync(a.target);
        return exists === a.expected
          ? { passed: true }
          : { passed: false, error: `Expected file_exists=${a.expected} for ${a.target}` };
      }

      case "file_contains": {
        if (!fs.existsSync(a.target)) {
          return { passed: false, error: `File not found: ${a.target}` };
        }
        const content = fs.readFileSync(a.target, "utf8");
        const contains = content.includes(a.expected);
        return contains
          ? { passed: true }
          : { passed: false, error: `File ${a.target} did not contain expected string` };
      }

      case "http_status": {
        try {
          const targetCheck = validateHttpTarget(a.target);
          if (!targetCheck.ok) {
            return { passed: false, error: `HTTP target blocked: ${targetCheck.reason}` };
          }

          const res = await fetch(a.target);
          return res.status === a.expected
            ? { passed: true }
            : { passed: false, error: `Expected status ${a.expected}, got ${res.status} for ${a.target}` };
        } catch (e: any) {
          return { passed: false, error: `HTTP fetch failed: ${e.message}` };
        }
      }

      case "sqlite_query": {
        try {
          const { execFileSync } = await import("child_process");
          const dbFile = process.env.DATABASE_URL?.replace("file:", "") || ".prism-mcp/local.db";
          if (!fs.existsSync(dbFile)) return { passed: false, error: `DB file not found: ${dbFile}` };

          // v7.2.0 FIX: Use execFileSync with -readonly flag for cross-platform read-only.
          // The URI ?mode=ro approach requires SQLITE_USE_URI=1 at compile time,
          // which isn't guaranteed on all distributions. -readonly is a native CLI flag.
          const rawResult = execFileSync("sqlite3", ["-readonly", dbFile, a.target, "--json"], {
            encoding: "utf8",
            timeout: 10_000, // 10s hard limit for any SQL query
          });
          const rows = rawResult.trim() ? JSON.parse(rawResult) : [];

          return deepMatch(rows, a.expected)
            ? { passed: true }
            : { passed: false, error: `SQL expected ${JSON.stringify(a.expected)}, got ${JSON.stringify(rows)}` };
        } catch (e: any) {
             return { passed: false, error: `SQL execution failed: ${e.message}` };
        }
      }

      case "quickjs_eval": {
         return await this.runQuickJs(a.code, a.inputs || {});
      }

      default:
        return { passed: false, error: `Unknown assertion type` };
    }
  }

  /**
   * Execute JavaScript safely in WebAssembly sandbox via quickjs-emscripten
   */
  private static async runQuickJs(code: string, inputs: Record<string, any>): Promise<{ passed: boolean; error?: string }> {
    const QuickJS = await getQuickJS();
    const vm = QuickJS.newContext();

    try {
      vm.runtime.setMemoryLimit(10 * 1024 * 1024);
      vm.runtime.setMaxStackSize(512 * 1024);

      let ops = 0;
      vm.runtime.setInterruptHandler(() => {
        ops++;
        return ops > 10000;
      });

      // C3 fix: Use vm.newString() + vm.setProp() to safely pass JSON
      // into the VM without any string escaping. This prevents injection
      // attacks from crafted input values containing quotes or backslashes.
      const inputsJson = JSON.stringify(inputs);
      const inputsJsonHandle = vm.newString(inputsJson);
      vm.setProp(vm.global, "__inputsJson", inputsJsonHandle);
      inputsJsonHandle.dispose();

      const parseResult = vm.evalCode(`JSON.parse(__inputsJson)`);
      if (parseResult.error) {
        const err = vm.dump(parseResult.error);
        parseResult.error.dispose();
        return { passed: false, error: `QuickJS Input Parse Error: ${err}` };
      }
      if (parseResult.value) {
        vm.setProp(vm.global, "inputs", parseResult.value || vm.undefined);
        parseResult.value.dispose();
      }

      const wrappedCode = `(function() { ${code} })()`;
      const result = vm.evalCode(wrappedCode);

      if (result.error) {
        const errorString = vm.dump(result.error);
        result.error.dispose();
        return { passed: false, error: `QuickJS Error: ${errorString}` };
      }

      const value = result.value ? vm.dump(result.value) : undefined;
      if (result.value) result.value.dispose();

      if (typeof value !== "boolean") {
        return { passed: false, error: `QuickJS evaluation returned ${typeof value}, expected boolean` };
      }

      return value
        ? { passed: true }
        : { passed: false, error: `Sandbox evaluation returned false` };

    } catch (e: any) {
      return { passed: false, error: `Sandbox crashed: ${e.message}` };
    } finally {
      vm.dispose();
    }
  }
}
