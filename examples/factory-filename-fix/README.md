# Factory example: repair report filenames

A report exporter turns `Weekly Sales Report.pdf` into
`weekly-sales report.pdf`. Only the first space is replaced, so the exported
filename still contains whitespace.

The sample starts with two failing cases and one passing case:

```sh
node --test slug.test.cjs
```

Give Factory this objective in an isolated copy of this directory:

> Fix slug.cjs so each whitespace group becomes one hyphen, leading and trailing
> whitespace is removed, and the filename is lowercase. Preserve the extension.
> Change only slug.cjs. Run node --test slug.test.cjs. Finish only when all three
> cases pass. Do not change the test file.

With the Factory MCP tools enabled, the host starts the task using
`session_route_prompt` with the objective and current workspace context. It
consumes the returned recommendation and calls `session_start_pipeline` with:

```json
{
  "project": "filename-repair-example",
  "objective": "Fix slug.cjs so whitespace groups become hyphens, trim whitespace and lowercase. Preserve the extension. Run node --test slug.test.cjs.",
  "working_directory": "/scratch",
  "context_files": ["slug.cjs", "slug.test.cjs"],
  "test_command": "node --test slug.test.cjs",
  "allowed_write_paths": ["slug.cjs"],
  "max_iterations": 3
}
```

`/scratch` is the Docker harness workspace; use the actual absolute path of
your isolated example copy for a local run. The background runner then plans, defines its rubric,
executes, evaluates, verifies, and finalizes or reports failure.

Factory is enabled by default. Disable it using the dashboard preference or
`PRISM_DARK_FACTORY_ENABLED=false`, then restart the MCP host. A configured model and
working pipeline storage are also required. The E2E harness uses an isolated
container because file actions and verification commands actually execute;
commands use no shell. Run `npm run build` followed by
`node scripts/factory-e2e.mjs` from the repository root. This requires Docker
and the real local `prism-coder:4b` model reachable through the harness proxy.
To check routing and lifecycle without model-generation variability, run
`FACTORY_E2E_MODE=routing node scripts/factory-e2e.mjs`. That mode uses real
MCP calls to route, start, abort, and reopen the pipeline. Active SQLite files
stay on Docker's native Linux filesystem; do not inspect live SQLite files
through macOS bind mounts. Restart proof covers MCP processes within one
container, not container replacement or production deployment.
It also checks fourteen BCBA prompts create no pipelines, including clinical
requests disguised with code filenames, default-on
and explicit-disable tool visibility, abort persistence, source changes, and
three independent tests whose file is mounted read-only.

Automatic execution depends on the host following the MCP recommendation.
`prism connect` generates instructions for Codex, Claude, and Gemini to route
bounded implementation requests before ordinary delegation. For the actual
Codex CLI test, build first, then run:

```sh
FACTORY_NATIVE_HOST_MODEL=<a model advertised by your Codex client> node scripts/factory-native-host-e2e.mjs
```

This uses your existing Codex authentication and a disposable Docker workspace.
Only that invocation trusts the bootstrap, route, start, and status MCP tools;
it leaves global host configuration unchanged. The test requires exactly one
bootstrap and start, Factory COMPLETED, unchanged independent tests, and three
passing cases. Host recovery after a failed pipeline does not satisfy it.
Artifacts include the exact source/build hashes, MCP calls, and model responses.

Paid accounts use authenticated Portal pipeline and verification APIs. Until
those APIs and their database migration are deployed, the capability probe
keeps automatic execution with the host. These local examples do not prove
paid production execution or activation in every native client.
