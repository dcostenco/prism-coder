# Verification Operator Contract

Prism explicitly guarantees the structural stability of the JSON outputs emitted by the CLI Verification tools. This document serves as the formal compatibility contract for integrations relying on standard text streams and process exit codes.

## Integration Invocation

Always use the `--json` flag to explicitly opt-in to the operator contract mode:

```bash
prism verify status --json
prism verify generate --json
```

## Schema Versioning Guarantees

The JSON contract utilizes the `schema_version` property to denote the stability of the emitted payload.

- **`schema_version: 1`**: Current production structure for v7.X releases.
- **Additive Changes**: Any new telemetry properties or descriptive fields added to the root or sub-objects will retain `schema_version: 1`. JSON parsers must ignore unknown fields rather than strictly halting.
- **Breaking Changes**: Any renames, deletions, or structural modifications to required keys will result in a version bump (`schema_version: 2`). This protects downstream orchestration from silent breakages.

## Command Shapes

### 1. `prism verify status --json`

Returns `VerifyStatusResult`.

**JSON Fields**:
- `schema_version: 1` (integer) [REQUIRED]
- `project`: string [REQUIRED]
- `no_runs`: boolean [REQUIRED]
- `synchronized`: boolean [REQUIRED]
- `exit_code`: integer [REQUIRED]
- `harness_missing`: boolean [REQUIRED]
- `last_run`: Optional object
  - `id`: string
  - `passed`: boolean
  - `pass_rate`: number
  - `critical_failures`: integer
  - `run_at`: string
  - `gate_override`: boolean or number
  - `override_reason`: string or null
- `drift`: Optional object
  - `stored_hash`: string
  - `local_hash`: string
  - `strict_env`: boolean
  - `policy`: string ("warn" | "blocked" | "bypassed")
  - `diff`: Optional object (Added in Phase 2 diagnostics)
    - `added`: Array of TestAssertion objects (local id not matched in stored)
    - `removed`: Array of TestAssertion objects (stored id not matched in local)
    - `modified`: Array of TestAssertion objects (id matched, payload changed)
    *Note: Diff arrays are guaranteed to be sorted by `id`.*

### Diff Semantics
Rename heuristics are intentionally deferred. v1 diff semantics are strict-by-id to guarantee predictable behavior for CI consumers without ambiguous false-positives. A renamed test is represented deterministically as one `removed` test and one `added` test.

### 2. `prism verify generate --json`

Returns `GenerateHarnessResult`.

**JSON Fields**:
- `schema_version: 1` (integer) [REQUIRED]
- `project`: string [REQUIRED]
- `success`: boolean [REQUIRED]
- `exit_code`: integer [REQUIRED]
- `already_exists`: boolean [REQUIRED]
- `test_count`: integer
- `rubric_hash`: string

## Exit Code Semantics & Strict-Policy Behavior

Standard Unix exit codes apply when `--json` mode is active, strictly mapping to the `exit_code` emitted in the JSON payload:

- `0`: Validation complete successfully or drift fell into a permitted policy group.
  - **WARN Policy**: (e.g. Local developer environment) Drift is detected but the developer retains agency. Output contains `policy: "warn", exit_code: 0`.
  - **BYPASSED Policy**: (e.g. CI running with `--force`) Drift is explicitly forgiven. Output contains `policy: "bypassed", exit_code: 0`.
- `1`: Validation obstructed or critical drift prevented continuation.
  - **BLOCKED Policy**: (e.g. Continuous Integration) `drift.strict_env=true`, meaning the codebase was mutated without matching updates to the verification criteria. Output contains `policy: "blocked", exit_code: 1`. The `npx` child process will formally end with `process.exitCode = 1`.

## Downstream Implementation Recommendations

1. **Strict Type Generation**: Consider generating interfaces or structs directly from this Markdown documentation. 
2. **Child Process Wrapping**: Prefer `child_process.exec` (Node) or `subprocess.run` (Python). Monitor standard streams via standard parsing, ensuring `stderr` is not conflated with JSON boundaries if debugging statements arise.
