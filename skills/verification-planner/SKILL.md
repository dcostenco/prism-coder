---
name: Verification Planner
description: Mandates generation of `test_assertions.json` during planning. v7.2.0 enhanced with severity gates (warn/gate/abort), dependency chains, and Claw-as-Validator support.
---

# Verification Planner (v7.2.0)

You MUST use this skill when generating an `implementation_plan.md`. You are required to create a `test_assertions.json` file in the project root to guide the automated Verification Runner.

## 🚀 Workflow

1.  **Plan**: Alongside your MD plan, define assertions in `test_assertions.json`.
2.  **Define Layers**: Categorize tests into `data` (schema), `pipeline` (files/APIs), or `agent` (logic).
3.  **Set Severity**:
    - `warn`: Non-blocking logs.
    - `gate`: Blocks progression on failure.
    - `abort`: Stops the pipeline immediately (safety-critical).

## 🛠️ Assertion Types
- `sqlite_query`: Validate DB state.
- `http_status`: Verify API health.
- `file_exists` / `file_contains`: Check filesystem.
- `quickjs_eval`: Sandbox JS logic for complex checks.

## 🧠 Claw-as-Validator
If `PRISM_VERIFICATION_HARNESS_ENABLED=true`, delegate your JSON suite to the local **Claw agent** for adversarial review before execution to catch missing coverage or false positives.

## 🔗 References
- [EXAMPLES.json](references/EXAMPLES.md): Full JSON schema and multi-layer example.
- [CONFIG.md](references/CONFIG.md): Environment variables and severity guidelines.
