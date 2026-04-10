# Changelog

All notable changes to this project will be documented in this file.

## [9.2.6] - 2026-04-09 — Windows CI Timeout Fix

### Fixed
- **Windows CI Flakiness** — CLI integration tests (`cli-integration.test.ts`) timed out on Windows + Node 22.x GitHub Actions runners. `npx tsx` cold-starts take 10-15s on Windows, exceeding Vitest's default 5s timeout. Added `{ timeout: 30_000 }` to the describe block. All 6 matrix combinations (ubuntu/macos/windows × Node 20/22) now pass reliably.

### Tests
- **Residual Norm Distribution & Long-Tail R@k Impact** (`tests/residual-distribution.test.ts`) — 6 new tests validating TurboQuant's QJL correction stability, directly backing the claim from [LongMemEval Issue #31](https://github.com/xiaowu0162/LongMemEval/issues/31) discussion with @m13v:
  - **ResidualNorm characterization** — CV=0.21 at d=128 (N=10K), CV=0.35 at d=768 (N=1K). P99/P50 ratio=2.57 confirms no extreme heavy tail.
  - **Long-tail R@k impact** — R@5=97% for BOTH low-residual (<P50) and high-residual (>P95) vectors. **Delta R@5 = 0.0 percentage points** — the key finding.
  - **Corpus scale stability** — R@5 degrades only 2pp from N=100 to N=2,000.
  - **QJL correction MAE** — Outlier MAE (P99) = 0.047, Inlier MAE (<P50) = 0.014. Ratio 3.3×, but absolute error bounded.
  - **Householder spread** — Max/min residualNorm ratio = 3.93 (bounded under 5.0).

### Engineering
- 1 file changed: `tests/residual-distribution.test.ts`

---

## [9.2.5] - 2026-04-09 — Reconciliation Credential Probe Fix

### Fixed
- **Reconciliation Not Firing** — The `supabaseReady` guard in `getStorage()` only resolved dashboard credentials (from `prism-config.db`) when `requestedBackend === "supabase"`. When backend was `"local"` (the entire point of reconciliation), credentials were never looked up, so `canReconcile` was always `false`. Added a second credential probe specifically for the local + reconciliation path.
- **Supabase Schema Mismatch** — The reconciliation `select` clause requested `key_context` column which doesn't exist in the Supabase `session_handoffs` table. Changed to `select: "*"` for schema-tolerant queries.

### Verified
- Live test: 9 handoffs + 43 ledger entries synced from Supabase → SQLite on first boot after fix.

### Engineering
- 2 files changed: `src/storage/index.ts`, `src/storage/reconcile.ts`
- 13/13 reconciliation tests passing

---

## [9.2.4] - 2026-04-09 — Cross-Backend Reconciliation

### Added
- **Automatic Supabase → SQLite Reconciliation** — New `src/storage/reconcile.ts` module implements two-layer sync that runs automatically during `getStorage()` initialization when the backend is local SQLite but Supabase credentials exist:
  - **Layer 1 (Handoffs):** Compares `updated_at` timestamps between Supabase and SQLite. Upserts newer remote handoffs into local SQLite.
  - **Layer 2 (Ledger):** For any project with a stale handoff, pulls the 20 most recent ledger entries from Supabase, deduplicating by ID against local entries.
- **13 New Tests** (`tests/storage/reconcile.test.ts`) — Syncing to empty local DB, skipping when local is newer, offline mode, ledger deduplication, malformed JSON resilience, multi-role project dedup, and Supabase timeout handling.

### Fixed
- **Race Condition** — Switched reconciliation from fire-and-forget to `await` in `getStorage()`, preventing `closeStorage()` from nulling the singleton mid-write.
- **Unbounded Queries** — Replaced full-table ledger scans with targeted ID-based lookups for deduplication.

### Performance
- **5s Timeout** — `withTimeout()` wrapper on all Supabase REST calls prevents startup freeze if Supabase is unreachable.
- **Safe JSON Parsing** — `safeParseArray()` prevents malformed Supabase JSON strings from aborting reconciliation.
- **Project Dedup** — `Set<string>` for project tracking avoids redundant network calls for multi-role projects.

### Design Decisions
- **Read-Only Sync** — Reconciliation only pulls from Supabase; it never writes to the cloud, preserving local-first integrity.
- **Targeted Ledger Sync** — Only the last 20 ledger entries per stale project are synced, keeping startup latency under 800ms even for large databases.

### Engineering
- 3 files changed: `src/storage/reconcile.ts` (new), `src/storage/index.ts`, `tests/storage/reconcile.test.ts` (new)
- 1049 tests across 48 suites, all passing

---

## [9.2.3] - 2026-04-09 — Code Review Hardening

### Performance
- **Split-Brain Check 10x Faster** — Replaced full `StorageBackend` construction (which ran migrations on every `session_load_context` call, adding 200-1000ms latency) with lightweight direct queries: `supabaseGet()` for Supabase REST, raw SQL via `@libsql/client` for SQLite. Check now completes in ~100ms.

### Fixed
- **Variable Shadowing** — `const storage` from CLI `--storage` option was shadowed by `const storage = await getStorage()` in JSON mode. Renamed inner variable to `storageBackend`.
- **Resource Leak** — SQLite alternate client in split-brain check was not closed if `execute()` threw. Added `try/finally` to guarantee `altClient.close()`.

### Engineering
- 1036 tests across 47 suites, all passing, zero regressions
- TypeScript: clean, zero errors
- 2 files changed: `src/cli.ts`, `src/tools/ledgerHandlers.ts`

---

## [9.2.2] - 2026-04-09 — Critical: Split-Brain Detection & Prevention

### ⚠️ Security / Data Integrity

- **Split-Brain Drift Detection** — `session_load_context` now detects when the active storage backend (e.g. SQLite) is out of sync with an alternate backend (e.g. Supabase). When both backends exist and have different versions, a `⚠️ SPLIT-BRAIN DETECTED` warning is injected prominently into the context response. This prevents agents from unknowingly acting on stale TODOs, outdated summaries, or completed tasks from a divergent backend.

### Added

- **`--storage` CLI Flag** — `prism load` now accepts `--storage <local|supabase>` to explicitly select which storage backend to read from. This is critical for environments where the CLI's shell environment inherits different `PRISM_STORAGE` settings than the MCP server config. Without this flag, `prism load` could silently read from Supabase while the MCP server writes to SQLite (or vice versa), returning stale state.

### Fixed

- **Session Loader Split-Brain** — `prism_session_loader.sh` now passes `--storage` flag (defaulting to `PRISM_STORAGE` env var, falling back to `local`) to prevent the CLI from reading the wrong backend when Supabase credentials are present but the MCP server is configured for local SQLite.

### Root Cause

When multiple MCP clients use different storage backends (e.g., Claude Desktop → Supabase, Antigravity → SQLite), the two backends operate as completely independent data silos with no sync mechanism. The `prism load` CLI inherited `PRISM_STORAGE` from the shell environment (defaulting to `supabase` when Supabase credentials exist), regardless of what the MCP server was configured to use. This caused the CLI to return state from the wrong backend — including stale TODOs that had already been completed in the real backend.

### Engineering
- TypeScript: clean, zero errors
- 3 files changed: `src/cli.ts`, `src/tools/ledgerHandlers.ts`, `README.md`
- Session loader script updated: `prism_session_loader.sh`

---



## [9.2.1] - 2026-04-09 — CLI Full Feature Parity

### Added
- **CLI Text Mode — Full MCP Parity** — `prism load` (text mode) now delegates to the real `sessionLoadContextHandler`, giving CLI-only users the same enriched output as MCP clients: morning briefings, reality drift detection, SDM intuitive recall, visual memory index, role-scoped skill injection, behavioral warnings, importance scores, recent validations, and agent identity block.
- **Agent Name in JSON Output** — `prism load --json` now includes `agent_name` from dashboard settings (`prism-config.db`) as a top-level field.
- **13 New CLI Tests** — Comprehensive vitest suite covering text mode handler delegation, JSON envelope structure, agent_name inclusion/exclusion, no-data edge cases, and feature parity verification.

### Fixed
- **Session Loader PATH Resolution** — `prism_session_loader.sh` now adds `/opt/homebrew/bin`, nvm, and volta paths to `PATH`, fixing the `node: command not found` error on macOS in non-interactive shells.

### Engineering
- TypeScript: clean, zero errors
- 3 files changed: `src/cli.ts`, `tests/tools/cli-load.test.ts` (new), `prism_session_loader.sh`
- Key architectural decision: CLI text mode delegates to the same handler function used by the MCP tool. No code duplication — future MCP enrichments automatically appear in CLI output.

---


## [9.1.1] - 2026-04-08 — Dashboard-First Credential Resolution

### Fixed
- **Dashboard Credentials Take Precedence** — `storage/index.ts` now reads `SUPABASE_URL` and `SUPABASE_KEY` from the dashboard config DB (`prism-config.db`) when environment variables are absent. Previously, starting the server without explicit env vars caused a hard fallback to local SQLite even when valid credentials were stored in the dashboard.
- **SyncBus Dashboard Fallback** — `sync/factory.ts` now checks dashboard config as a fallback for Supabase credentials, matching the storage layer behavior.
- **Supabase API Call-Time Credentials** — `utils/supabaseApi.ts` now reads `SUPABASE_URL`/`SUPABASE_KEY` from `process.env` at each request instead of capturing frozen values at module-import time. Dashboard-injected credentials are now visible to all downstream consumers.
- **Noisy Startup Warnings Silenced** — API key warnings (`BRAVE_API_KEY`, `GOOGLE_API_KEY`, `BRAVE_ANSWERS_API_KEY`) downgraded from `console.error` to debug-level logging. These fired on every server restart and were harmless (features degrade gracefully).

### Engineering
- TypeScript: clean, zero errors
- 4 files changed: `src/config.ts`, `src/storage/index.ts`, `src/sync/factory.ts`, `src/utils/supabaseApi.ts`

---

## [9.1.0] - 2026-04-08 — Task Router v2 & Local Agent Hardening

### Added
- **File-Type Complexity Signal** — New `fileTypeSignal` heuristic in the task router analyzes file extensions to bias routing decisions. Config/docs files (`.md`, `.json`, `.yml`, `.yaml`, `.toml`, `.cfg`, `.txt`, `.csv`, `.env`, `.ini`) bias toward local delegation; systems-programming files (`.cpp`, `.cc`, `.cxx`, `.c`, `.h`, `.hpp`, `.rs`, `.go`, `.java`, `.swift`, `.zig`) bias toward host. Common scripting/web langs (`.ts`, `.js`, `.py`) are intentionally neutral.
- **Claw Agent Streaming Buffer** — Local agent (`claw_agent_lite.py`) now uses a buffered stream parser to correctly handle `<think>` / `</think>` reasoning tags split across network chunks. Previously, partial tags would leak raw DeepSeek-R1 reasoning into stdout.
- **Claw Agent System Prompts** — Coding mode (`--code`) now injects a concise-output system prompt to prevent verbose explanations from the local model.
- **Claw Agent Memory Trimming** — REPL sessions now trim conversation history to the last 20 turns (preserving system prompt) to prevent unbounded memory growth during long sessions.
- **`--timeout` CLI Flag** — Configurable timeout for the local agent (default: 300s, up from 180s) to accommodate complex reasoning tasks on `deepseek-r1:32b`.

### Fixed
- **Multi-Step False Positives** — Removed bare `"1."`, `"2."`, `"3."` from `MULTI_STEP_MARKERS` — these matched version numbers (v1.2.3), decimal values, and IP addresses, inflating the multi-step detection signal and biasing tasks away from local delegation.
- **File-Type Double Counting** — Changed file classification from dual `if` to `if/else if`, preventing files from being counted as both simple and complex.
- **Claw Agent Error Output** — All error messages now go to `stderr` instead of `stdout`, keeping programmatic output clean for downstream tool consumption.
- **Claw Agent Unused Import** — Removed unused `import os`.

### Changed
- **Router Weight Distribution** — Updated from 5-signal to 6-signal routing: Keyword (0.35), File Count (0.15), File Type (0.10), Scope (0.20), Length (0.10), Multi-Step (0.10). Previous weights overallocated to file count (0.20) and scope (0.25).
- **Header Documentation** — Updated router header from v7.1.0/Qwen3 to v9.1.0/deepseek-r1+qwen2.5-coder, reflecting actual model names and weight table.
- **Claw Agent Ollama API** — Migrated from stateless `/api/generate` to stateful `/api/chat` for proper multi-turn conversation support.

### Engineering
- 1023 tests across 46 suites, all passing, zero regressions
- TypeScript: clean, zero errors
- 2 files changed: `src/tools/taskRouterHandler.ts`, `claw_agent_lite.py`

---

## [9.0.5] - 2026-04-07 — JWKS Auth Security Hardening

### Security
- **JWT Audience & Issuer Validation** — `jwtVerify()` now accepts `PRISM_JWT_AUDIENCE` and `PRISM_JWT_ISSUER` environment variables to validate `aud` and `iss` claims. Prevents cross-service token confusion attacks where a valid JWT from an unrelated service could authenticate against the dashboard.
- **Clock Tolerance** — Added 30-second clock skew tolerance to JWT verification, preventing false rejections from minor time drift between servers.
- **JWT Failure Logging** — Verification failures now emit structured error codes (`ERR_JWT_EXPIRED`, `ERR_JWT_CLAIM_VALIDATION_FAILED`, `ERR_JWS_INVALID`) to stderr. Previously silenced — essential for debugging in multi-agent deployments.
- **Server Card Fix** — `authentication.required` in the Smithery manifest (`/.well-known/mcp/server-card.json`) now reflects actual auth state instead of hardcoded `false`.

### Added
- **`PrismAuthenticatedRequest` Interface** — Typed `req.agent_id` mutation replaces `(req as any)`. Downstream handlers can now safely read agent identity for audit logging.
- **11 JWKS Unit Tests** — Full coverage for the Bearer JWT path using `jose`'s `generateKeyPair` + `SignJWT` (zero network, local key pairs):
  - Valid JWT accepted
  - Expired JWT rejected
  - Wrong audience rejected / correct audience accepted
  - Wrong issuer rejected / correct issuer accepted
  - JWKS cache null → fallthrough to cookie/basic
  - Invalid Bearer token string rejected
  - `agent_id` extracted from `payload.agent_id` (priority) and `payload.sub` (fallback)
- **JWKS Testing Hooks** — `_resetJWKS()` and `_getJWKSCache()` exports for test injection.
- **`.env.example` Documentation** — Added `PRISM_JWKS_URI`, `PRISM_JWT_AUDIENCE`, `PRISM_JWT_ISSUER` with usage examples.

### Changed
- **Startup Logging** — Distinguishes JWKS vs Basic Auth modes separately. Warns when no `PRISM_JWT_AUDIENCE` is configured (any valid JWT from the JWKS endpoint will be accepted).
- **JSDoc** — Updated `isAuthenticated` documentation to reflect the full 4-step auth priority chain: Auth disabled → Bearer JWT → Session cookie → Basic Auth.

## [7.8.2] - 2026-04-04

### Fixed
- **Docker / CI Build Failures** — Fixed an overly broad `.gitignore` rule that caused `src/memory/spreadingActivation.ts` to be excluded from version control, resulting in `TS2307` compiler errors during clean builds (like on Glama or Smithery).

## [7.8.0] - 2026-04-04 — Cognitive Architecture

> **The biggest leap forward yet.** Prism moves beyond flat vector search into a true cognitive architecture inspired by human brain mechanics. Your agents don't just remember; they learn.

### Added
- **Episodic → Semantic Consolidation (Hebbian Learning)** — Compaction no longer blindly summarizes text. Prism now extracts *principles* from raw event logs and writes them to a dedicated `semantic_knowledge` table with `confidence` scores that increase every time a pattern is observed. True Hebbian learning: neurons that fire together wire together.
- **Multi-Hop Causal Reasoning** — Compaction extracts causal links (`caused_by`, `led_to`) and persists them as `memory_links` graph edges. At retrieval time, ACT-R spreading activation propagates through these edges with damped fan effect (`1 / ln(fan + e)`), lateral inhibition, and configurable hop depth. Your agent follows trains of thought, not just keyword matches.
- **Uncertainty-Aware Rejection Gate** — Dual-signal safety layer (similarity floor + gap distance) that tells the LLM "I searched my memory, and I confidently do not know the answer" instead of feeding it garbage context. Agents that know their own boundaries don't hallucinate.
- **Dynamic Fast Weight Decay** — Semantic rollup nodes (`is_rollup`) decay 50% slower than episodic entries (`ageModifier = 0.5`), creating Long-Term Context anchors. The agent forgets raw chatter but permanently remembers core personality, project rules, and architectural decisions.
- **LoCoMo Benchmark Harness** — New standalone integration suite (`tests/benchmarks/locomo.ts`) deterministically benchmarks Long-Context Memory retrieval against multi-hop compaction structures via local `MockLLM` frameworks.

### Fixed
- **Schema Alignment (P0)** — Corrected `semantic_knowledge` DDL to match DML: renamed `rule` → `description`, added `instances`, `related_entities`, and `updated_at` columns. Added migration stubs.
- **Search SQL (P1)** — Updated Tier-1 (sqlite-vec) and Tier-2 (TurboQuant) search queries to include `is_rollup`, `importance`, and `last_accessed_at` for ACT-R decay consumption.
- **userId Threading (P2)** — Threaded `userId` through the entire `upsertSemanticKnowledge` stack (Interface → SQLite → Supabase Stub → Compaction Handler) to satisfy `NOT NULL` constraints.
- **Spreading Activation Performance (P1)** — Eliminated N+1 SQL round-trips by deriving fan-out counts locally from edge results. Added `LIMIT 200` to prevent memory pressure on high-degree nodes.
- **Keyword Rejection Gate Isolation** — Properly scoped uncertainty rejection strictly for vector-mapped threshold logic, bypassing FTS5 keyword (BM25) paths to prevent silent search failures.

## [7.7.1] - 2026-04-04

### Added
- **Smithery Registry Manifest** — Implemented an unauthenticated `/.well-known/mcp/server-card.json` endpoint to seamlessly expose MCP capabilities to cloud registries (like Smithery.ai) bypassing "chicken-and-egg" startup timeout blocks.
  - Manifest is hosted independently and ahead of the Dashboard Auth Gate to guarantee 100% public discovery while protecting active sessions.
  - Generates a static index via `getAllPossibleTools()` ensuring maximum visibility (exposing Hivemind and Dark Factory tools dynamically) without requiring local environment variable injection.
  - Includes extended boolean configuration schemas for `prismEnableHivemind`, `prismDarkFactoryEnabled`, and `prismTaskRouterEnabled` allowing instant configuration directly via Smithery UI.

## [7.7.0] - 2026-04-04

### Added
- **SSE Transport Mode** — Full native support for Server-Sent Events network connections (`SSEServerTransport`). Prism is now a cloud-ready, network-accessible MCP server capable of running on Render, Smithery, or any remote host.
  - Dynamically provisions unique `createServer()` instances per connection mapping them via a persistent `activeSSETransports` register.
  - Exposes `GET /sse` for stream initialization and `POST /messages` for JSON-RPC message delivery.
  - Strictly inherits Dashboard UI credentials via shared HTTP auth. Unauthenticated connections elegantly decline with `401 Unauthorized` JSON.

### Security
- **Auth Guard Integrity** — Enhanced the basic HTTP auth gate to explicitly catch MCP SSE endpoints alongside `/api/` returning clean JSON errors. Eliminates parsing crashes in remote MCP clients where unexpected HTML documents cause breaks.
- **Fail-Closed Network Guarding** — Wrapped SSE initialization handshake in `try/catch` and cleanup block. Protects the main NodeJS server loop against unhandled promise rejections triggering crashes on flaky client network connections.
- **Cors Hardening** — Pre-flight `OPTIONS` calls for `Access-Control-Allow-Headers` now comprehensively include `Authorization` allowing browsers to relay Dashboard Credentials seamlessly.

## [7.6.0] - 2026-04-04

### Added
- **Voyage AI Embedding Provider** — Introduced native `VoyageAdapter` as a pluggable embedding provider alongside OpenAI and Gemini. 
  - Allows semantic vector embedding using Voyage AI models inside the Mind Palace architecture.
  - Exposes config via `VOYAGE_API_KEY` mapped directly into the LLM adapter factory.
  - Added dedicated unit tests guaranteeing semantic fidelity.

## [7.5.0] - 2026-04-04

### Added
- **Intent Health Dashboard** — Per-project 0–100 health scoring in the Mind Palace, powered by a 3-signal algorithm: staleness decay (50pts, linear over `intent_health_stale_threshold_days`), TODO overload (30pts, tiered at 4/7+ thresholds), and decision presence (20pts). Renders as a gauge card with actionable signals per project.
- **`intent_health_stale_threshold_days` System Setting** — Configurable via Dashboard UI (default: 30 days). Controls when a project is considered fully stale.
- **14 Intent Health Tests** — Exhaustive coverage: fresh/stale/empty contexts, NaN timestamps, NaN thresholds, custom thresholds, TODO boundaries, multi-session decisions, score ceiling, signal severity matrix, clock skew, and signal shape validation.

### Changed
- **`computeIntentHealth` NaN Guard** — Extended `staleThresholdDays <= 0` guard to `!Number.isFinite(staleThresholdDays) || staleThresholdDays <= 0`. Catches `NaN`, `Infinity`, and negative values (previously `NaN <= 0` evaluated to `false` in JS, bypassing the guard).
- **Defensive Score Clamp** — `Math.min(100, Math.round(...))` ceiling on total score prevents future regressions from exceeding the 0–100 gauge range.

### Fixed
- **10 XSS Injection Vectors Patched** — Comprehensive `escapeHtml()` sweep across all dashboard innerHTML paths:
  - Pipeline `objective` (stored user input via `session_start_pipeline`)
  - Pipeline `project` name in factory tab
  - Pipeline `current_step` name in factory tab
  - Pipeline `error` message in factory tab
  - Factory catch handler `err.message`
  - Ledger `decisions` array members (`.join(', ')` → `.map(escapeHtml).join(', ')`)
  - Project `<option>` text in selector dropdowns
  - History timeline `h.version` badge
  - Health card `data.score` (typeof number guard)
  - CSS selector injection in `fetchNextHealth` (querySelector → safe array iteration)
- **Division-by-zero** — `staleThresholdDays=0` no longer produces `Infinity` score cascade.

## [7.4.0] - 2026-04-03

### Added
- **Adversarial Evaluation Framework** — `PLAN_CONTRACT` and `EVALUATE` steps added to the Dark Factory pipeline, implementing a native generator/evaluator sprint architecture with isolated contexts and pre-committed scoring contracts.
  - `PLAN_CONTRACT` — Before any code changes, generator and evaluator agree on a machine-parseable rubric (`ContractPayload`: criteria with `id` + `description` fields). Contract is written to `contract_rubric.json` in the working directory.
  - `EVALUATE` — After `EXECUTE`, an isolated adversarial evaluator scores the output against the contract. Structured findings include `severity`, `criterion_id`, `pass_fail`, and evidence pointers (`file`, `line`, `description`).
  - Pipeline state machine: `PLAN → PLAN_CONTRACT → EXECUTE → EVALUATE → VERIFY → FINALIZE`
- **`DEFAULT_MAX_REVISIONS` constant** — Replaces magic number `3` across `schema.ts` and `safetyController.ts`. Configurable via `spec.maxRevisions`.
- **78 new adversarial unit tests** (`tests/darkfactory/adversarial-eval.test.ts`) covering all parser branches, transition logic, deadlock/oscillation scenarios, conservative-default behavior, and context-bleed guards.

### Changed
- **`EvaluationPayload.findings[].evidence.line`** — Type corrected from `string` to `number` (1-indexed line number). `EVALUATE_SCHEMA` LLM prompt updated to match.
- **`PipelineState.contract_payload`** — Type narrowed from `any` to `PipelineContractPayload | null` for end-to-end type safety.
- **`evalPlanViable` conservative default** — When `EVALUATE` step output cannot be parsed (malformed LLM response), `planViable` now defaults to `false` (escalate to PLAN re-plan) instead of `true` (burn EXECUTE revisions). Prevents looping on systematically broken LLM output.
- **EVALUATE notes persisted** — `result.notes` from the `EVALUATE` step is now forwarded to `pipeline.notes` alongside `EXECUTE` notes. Previously, evaluator findings were discarded from the persistent pipeline record.
- **Generator Feedback Loop** — The Evaluator's critique (`EvaluationPayload.findings`) is now correctly serialized and injected directly into the `EXECUTE` prompt during revision loops (`eval_revisions > 0`). The Generator is no longer blind to why it failed — it receives the full line-by-line evidence (criterion, severity, file, line) from the previous evaluation.
- **TurboQuant warm-up** — Moved to `setImmediate` in `server.ts` to prevent event loop blocking during the MCP stdio handshake.

### Fixed
- **`parseContractOutput` per-criterion validation** — Each criterion element is now validated to have string `id` and `description` fields. Primitive elements (e.g. `[42, "bad"]`) are rejected with a position-keyed error message.
- **`parseEvaluationOutput` findings array guard** — `findings` field is now validated to be an array when present. Non-array values (e.g. `"findings": "none"`) are rejected at the parser boundary.
- **Strict Evidence Validation** — `parseEvaluationOutput` now enforces deep element-level validation on the `findings` array. Evaluator findings with `pass_fail: false` that are missing an `evidence` object (file and line pointers) are strictly rejected. Prevents LLM hallucination of unsupported severity claims with no evidence anchor.
- **`contract_rubric.json` write isolation** — `fs.writeFileSync` is now wrapped in try/catch. Disk/permission errors immediately mark the pipeline `FAILED` instead of leaving it stuck in `RUNNING` indefinitely.
- **Dead `STEP_ORDER` array removed** — Unused constant in `safetyController.ts` replaced by the authoritative `switch` statement.
- **`'evaluation_result' as any`** — Invalid event type replaced with the correct `'learning'` literal for the experience ledger call.
- **SQLite backfill migration** — `ALTER TABLE DEFAULT` only applies to new inserts; existing rows now explicitly have `eval_revisions = 0` set via a `WHERE eval_revisions IS NULL` backfill `UPDATE`.
- **Supabase `listPipelines` parity** — `contract_payload` was missing JSON deserialization in `listPipelines`. Fixed to match the behavior of `getPipeline`.

### Storage Schema (v7.4.0 migration)
- New columns on `dark_factory_pipelines`: `eval_revisions INTEGER DEFAULT 0`, `contract_payload TEXT`, `notes TEXT`
- Supabase: same columns via `prism_apply_ddl` RPC
- SQLite backfill: `UPDATE ... SET eval_revisions = 0 WHERE eval_revisions IS NULL`

### Engineering
- 978 tests across 44 suites (78 new adversarial evaluation tests), all passing, zero regressions
- TypeScript: clean, zero errors
- 10 files changed, +1027 / -73

---

## [7.0.0] - 2026-04-01

### Added
- **ACT-R Activation Memory** — Scientifically-grounded memory retrieval based on Anderson's ACT-R cognitive architecture. Base-level activation `B_i = ln(Σ t_j^{-d})` replaces flat similarity search with recency × frequency scoring that mirrors human cognitive decay. Memories accessed recently and frequently surface first; stale context fades naturally.
- **Candidate-Scoped Spreading Activation** — Activation spreads only within the current search result set, preventing "God node" centrality bias where highly-connected nodes dominate every query regardless of relevance.
- **Composite Scoring** — `0.7 × similarity + 0.3 × σ(activation)` blends semantic relevance with cognitive activation. Sigmoid normalization keeps activation in `[0,1]` regardless of access pattern. Weights configurable via `PRISM_ACTR_WEIGHT_SIMILARITY` / `PRISM_ACTR_WEIGHT_ACTIVATION`.
- **Verification Operator Contract & JSON Modes** — `verify status` and `verify generate` now fully support `--json` output modes providing strict schema adherence (`schema_version: 1`). Integrations guarantees deterministic exit codes (`0` for passing/warning/bypassed, `1` for blocked drift).
- **AccessLogBuffer** — In-memory batch-write buffer with 5-second flush window resolves `SQLITE_BUSY` contention during parallel multi-agent tool calls. Registered with `BackgroundTaskRegistry` for graceful shutdown — no orphaned writes on `SIGTERM`.
- **Zero Cold-Start** — Memory creation now seeds an initial access log entry. New memories are immediately rankable without a warm-up period.
- **Supabase Migration 037** — `actr_access_log` table + RPC functions for access log writes and activation computation. Full feature parity with SQLite backend.
- **5 New Environment Variables** — `PRISM_ACTR_ENABLED` (default: `true`), `PRISM_ACTR_DECAY` (default: `0.5`), `PRISM_ACTR_WEIGHT_SIMILARITY` (default: `0.7`), `PRISM_ACTR_WEIGHT_ACTIVATION` (default: `0.3`), `PRISM_ACTR_ACCESS_LOG_RETENTION_DAYS` (default: `90`).

### Changed
- **Cognitive Memory Pipeline** — `cognitiveMemory.ts` refactored to integrate ACT-R activation scoring into the retrieval pipeline. When `PRISM_ACTR_ENABLED=true`, search results are re-ranked with composite scores; when disabled, falls back to pure similarity.
- **Tracing Integration** — OpenTelemetry spans added for ACT-R activation computation, access log writes, and buffer flushes.

### Documentation
- **README Overhaul** — Added "Mind Palace" terminology definition, promoted Universal Import to top-level section, added Quick Start port-conflict collapsible, added "Recommended Minimal Setup" TL;DR for environment variables, updated dashboard screenshot to v7.0.0, added dashboard-runs-in-background reassurance.
- **ROADMAP** — v7.0.0 entry with full ACT-R feature table. "State of Prism" updated to v7.0.0. Future tracks bumped to v8.x/v9+.

### Architecture
- New file: `src/utils/actrActivation.ts` — 250 lines. ACT-R base-level activation, sigmoid normalization, composite scoring.
- New file: `src/utils/accessLogBuffer.ts` — 199 lines. In-memory batch-write buffer with 5s flush, `BackgroundTaskRegistry` integration.
- New migration: `supabase/migrations/037_actr_access_log_parity.sql` — 121 lines. Access log table, RPC functions, retention cleanup.
- Extended: `src/storage/sqlite.ts` — Access log table creation, write/query methods, retention sweep.
- Extended: `src/storage/supabase.ts` — Access log RPC calls, activation computation.
- Extended: `src/tools/graphHandlers.ts` — ACT-R activation integration in search handler.
- Extended: `src/utils/cognitiveMemory.ts` — Composite scoring pipeline with ACT-R re-ranking.
- Extended: `src/utils/tracing.ts` — ACT-R span instrumentation.

### Engineering
- 705 tests across 32 suites (49 new ACT-R tests), all passing, zero regressions
- New file: `tests/utils/actr-activation.test.ts` — 695 lines covering activation math, buffer flush, cold-start seeding, SQLite/Supabase parity, decay parameter edge cases
- TypeScript strict mode: zero errors

---

## [6.5.3] - 2026-04-01

### Added
- **Dashboard Auth Test Suite** — 42 new tests (`tests/dashboard/auth.test.ts`) covering the entire auth system: `safeCompare` timing-safety, `generateToken` entropy, `isAuthenticated` cookie/Basic Auth flows, `createRateLimiter` sliding window, and full HTTP integration tests for login, logout, auth gate, rate limiting, and CORS.
- **Rate Limiting** — `POST /api/auth/login` is now protected by a sliding-window rate limiter (5 attempts per 60 seconds per IP). Resets on successful login. Stale entries are auto-pruned to prevent memory leaks.
- **Logout Endpoint** — `POST /api/auth/logout` invalidates the session token server-side (deletes from `activeSessions` map) and clears the client cookie via `Max-Age=0`.
- **Auth Utilities Module** — Extracted `safeCompare`, `generateToken`, `isAuthenticated`, and `createRateLimiter` from `server.ts` closures into `src/dashboard/authUtils.ts` for testability and reuse.

### Security
- **CORS Hardening** — When `AUTH_ENABLED`, `Access-Control-Allow-Origin` is now set dynamically to the request's `Origin` header (not wildcard `*`), and `Access-Control-Allow-Credentials: true` is sent. Wildcard `*` is only used when auth is disabled.
- **Cryptographic Token Generation** — `generateToken()` now uses `crypto.randomBytes(32).toString("hex")` instead of `Math.random()` for session tokens.
- **Colon-Safe Password Parsing** — Basic Auth credential extraction now uses `indexOf(":")` instead of `split(":")` to correctly handle passwords containing colon characters.

### Engineering
- 42 new auth tests (unit + HTTP integration), zero regressions in existing 14 dashboard API tests
- New file: `src/dashboard/authUtils.ts` — extracted pure functions with injectable `AuthConfig`
- New file: `tests/dashboard/auth.test.ts` — 5 describe blocks, 42 test cases

---

## [6.5.2] - 2026-04-01

### Engineering
- **SDM/HDC Edge-Case Test Hardening** — 37 new tests (571 → 608 total) covering critical boundary conditions across the cognitive routing pipeline:
  - **HDC Engine** — Bind length mismatch rejection, empty bundle handling, single-vector identity, XOR self-inverse property, permute empty/single-word edge cases, density preservation invariant.
  - **PolicyGateway** — All 4 constructor rejection paths, exact-at-threshold boundary routing (0.85 → CLARIFY, 0.95 → AUTO_ROUTE), null-concept override behavior.
  - **StateMachine** — Constructor/transition dimension guards, defensive cloning, `injectStateForTesting` guard, initial-state immutability.
  - **SDM Engine** — Hamming identity/complement properties, reverse mode cross-talk isolation, write/read dimension guards, k=0 boundary, `importState` guard, `exportState` → `importState` lossless roundtrip.

---

## [6.5.1] - 2026-04-01

### Fixed
- **Dashboard Project Selector Bootstrap Failure** — Resolved a startup failure where `/api/projects` returned errors and the selector remained stuck on "Loading projects..." when `SUPABASE_URL`/`SUPABASE_KEY` were unresolved template placeholders (e.g. `${SUPABASE_URL}`).
- **Storage Backend Fallback Safety** — Added runtime guardrails to automatically fall back to local SQLite storage when Supabase is requested but env configuration is invalid/unresolved, preventing dashboard hard-failure in mixed/local setups.

### Changed
- **Config Sanitization** — Added Supabase env sanitization and URL validation to ignore unresolved placeholder strings and invalid non-http(s) values.

### Release Process
- Delivered as a **single pull request** post-publish hardening pass to keep code + docs + release notes aligned in one review artifact.

---

## [6.5.0] - 2026-04-01

### Added
- **HDC Cognitive Routing** — New `session_cognitive_route` MCP tool composes an agent's current state, role, and action into a single 768-dim binary hypervector via XOR binding, resolves it to a semantic concept via Hamming distance, and routes through a three-outcome policy gateway (`direct` / `clarify` / `fallback`). Powered by `ConceptDictionary`, `HdcStateMachine`, and `PolicyGateway` in `src/sdm/`.
- **Per-Project Threshold Overrides** — Fallback and clarify thresholds are configurable per-project via tool arguments and persisted via `getSetting()`/`setSetting()`. **Phase 2 storage-parity scope note:** No new storage migrations are required — the existing `prism_settings` key-value table already abstracts SQLite/Supabase parity. Threshold values are stored as decimal strings (e.g., `"0.45"`) and parsed back to `Number` on read.
- **Explainability Mode** — When `explain: true`, responses include `convergence_steps`, raw `distance`, and `ambiguity` flag. Controlled by `PRISM_HDC_EXPLAINABILITY_ENABLED` (default: `true`).
- **Cognitive Observability** — `recordCognitiveRoute()` in `graphMetrics.ts` tracks 14 cognitive metrics: total routes, route distribution (direct/clarify/fallback), rolling confidence/distance averages, ambiguity count, null-concept count, and last-route timestamp. Warning heuristics fire when `fallback_rate > 30%` or `ambiguous_resolution_rate > 40%`.
- **Dashboard Cognitive Card** — Route distribution bar, confidence/distance gauges, and warning badges in the Mind Palace metrics panel (ES5-safe). On-demand "Cognitive Route" button in the Node Editor panel.
- **Dashboard API Endpoint** — `GET /api/graph/cognitive-route` in `graphRouter.ts` exposes the handler for dashboard consumption with query parameter parsing (project, state, role, action, thresholds, explain).

### Architecture
- New tool: `session_cognitive_route` — `src/tools/graphHandlers.ts` (`sessionCognitiveRouteHandler`)
- New API route: `GET /api/graph/cognitive-route` — `src/dashboard/graphRouter.ts`
- Extended: `src/observability/graphMetrics.ts` — `CognitiveMetrics` interface, `recordCognitiveRoute()`, cognitive warning heuristics
- Extended: `src/dashboard/ui.ts` — Cognitive metrics card, cognitive route button (ES5-safe)
- Config: `PRISM_HDC_ENABLED` (default: `true`), `PRISM_HDC_EXPLAINABILITY_ENABLED` (default: `true`)

### Fixed
- **Dashboard `triggerTestMe` Regression** — Restored `async function triggerTestMe()` declaration that was stripped during v6.5 code insertion. Removed duplicate `cognitiveRouteBtn` DOM block (duplicate IDs). Restored `testMeContainer` div in panel flow.

### Engineering
- 566 tests across 30 suites (all passing, zero regressions)
- 42 new tests: 26 handler integration tests (`tests/tools/cognitiveRoute.test.ts`) + 16 dashboard API tests (`tests/dashboard/cognitiveRoute.test.ts`)
- TypeScript strict mode: zero errors

---


## [6.2.1] - 2026-04-01

### Fixed
- **Dashboard ES5 Compatibility** — Refactored all inline `<script>` code in the Mind Palace dashboard to strict ES5 syntax. Replaced `const`/`let`, arrow functions, optional chaining (`?.`), and template literals with ES5 equivalents (`var`, `function` expressions, manual null checks, string concatenation). Fixes `SyntaxError: Unexpected identifier 'block'` that prevented the dashboard from initializing in certain browser environments.
- **Compatibility Rule Enforcement** — Added a mandatory ES5-only compatibility comment block at the top of the inline `<script>` tag to prevent future regressions.

### Engineering
- 510 tests across 28 suites (all passing)
- TypeScript strict mode: zero errors

---

## [6.2.0] - 2026-03-31

### Added
- **Edge Synthesis ("The Dream Procedure")** — Automated background linker (`session_synthesize_edges`) discovers semantically similar but disconnected memory nodes via cosine similarity (threshold ≥ 0.7). Batch-limited to 50 sources × 3 neighbors per sweep to prevent runaway graph growth.
- **Graph Pruning (Soft-Prune)** — Configurable strength-based pruning (`PRISM_GRAPH_PRUNING_ENABLED`) soft-deletes weak links below a configurable minimum strength. Includes per-project cooldown, backpressure guards, and sweep budget controls.
- **SLO Observability Layer** — `graphMetrics.ts` module tracks synthesis success rate, net new links, prune ratio, and sweep duration. Exposes `slo` and `warnings` fields for proactive health monitoring.
- **Dashboard Metrics Integration** — New SLO cards, warning badges, and pruning skip breakdown (backpressure / cooldown / budget) in the Mind Palace dashboard at `/api/graph/metrics`.
- **Temporal Decay Heatmaps** — UI overlay toggle where un-accessed nodes desaturate while Graduated nodes stay vibrant. Graph router extraction + decay view toggle.
- **Active Recall Prompt Generation** — "Test Me" utility in the node editor panel generates synthetic quizzes from semantic neighbors for knowledge activation.
- **Supabase Weak-Link RPC (WS4.1)** — New `prism_summarize_weak_links` Postgres function (migration 036) aggregates pruning server-side in one RPC call, eliminating N+1 network roundtrips. TypeScript fast-path with automatic fallback.
- **Migration 035** — Tenant-safe graph writes + soft-delete hardening for MemoryLinks.

### Fixed
- **Scheduler `projects_processed` Semantics** — Now tracks all attempted projects, not just successes, for accurate SLO derivation.
- **Router Integration Test** — Added `GET /api/graph/metrics` integration test to validate the full metrics pipeline.
- **Export Test Mock Staleness** — Added missing `PRISM_GRAPH_PRUNE*` config exports to `sessionExportMemory.test.ts` mock (transitive import fix).
- **Dashboard `const` in Switch** — Fixed `const` declaration in switch-case scope (`pruneSkipParts`) that caused strict-mode errors in some browsers.

### Architecture
- New module: `src/observability/graphMetrics.ts` — in-memory metrics with SLO derivation and warning heuristics.
- New migration: `supabase/migrations/036_prune_summary_rpc.sql` — server-side aggregate RPC.
- Extended: `src/backgroundScheduler.ts` — synthesis telemetry, pruning telemetry, sweep duration recording.
- Extended: `src/dashboard/graphRouter.ts` — `GET /api/graph/metrics` endpoint.
- Extended: `src/dashboard/ui.ts` — SLO cards, warning badges, pruning breakdown.

### Engineering
- 510 tests across 28 suites (all passing)
- TypeScript strict mode: zero errors

---

## [6.1.9] - 2026-03-31

### Added
- **Tavily Support** — Added `@tavily/core` integration as a robust alternative to Brave + Firecrawl for the Web Scholar pipeline. Supports `performTavilySearch` and `performTavilyExtract`.

### Fixed
- **Tavily Chunking & Error Handling** — Implemented URL array chunking (batches of 20 URLs) for `performTavilyExtract` to bypass API limits and prevent data loss.
- **Upstream Network Resilience** — `performTavilySearch` is wrapped in a `try...catch` block to cleanly return empty arrays on API failure/timeout, avoiding unhandled promise rejections.

---

## [6.1.8] - 2026-03-30

### Fixed
- **Missing Type Guard** — Added `isSessionCompactLedgerArgs` for `SESSION_COMPACT_LEDGER_TOOL`. The tool existed with no corresponding guard; an LLM hallucinating `{threshold: "many"}` would reach the handler unchecked.
- **Array Field Validation** — `isSessionSaveLedgerArgs` now validates `todos`, `files_changed`, and `decisions` with `Array.isArray`, preventing string coercion into array-typed fields.
- **Enum Literal Guard** — `isSessionExportMemoryArgs` now rejects `format` values outside the literal union `'json' | 'markdown' | 'vault'` at the MCP boundary.
- **Numeric Guards** — `isSessionIntuitiveRecallArgs` now validates `limit` and `threshold` as `typeof number`, blocking `{limit: "many"}` style coercion.
- **Legacy Guard Migration** — `isMemoryHistoryArgs`, `isMemoryCheckoutArgs`, `isSessionSaveImageArgs` migrated to the uniform `Record<string, unknown>` pattern. `isMemoryHistoryArgs` also gains a missing `limit` number check.

---

## [6.1.7] - 2026-03-30

### Fixed
- **Toggle Persistence** — `saveSetting()` now returns `Promise<boolean>` and UI toggles (Hivemind, Auto-Capture) roll back their optimistic state on server failure.
- **Cache-Busting** — `loadSettings()` appends `?t=<timestamp>` to bypass stale browser/service-worker caches.
- **HTTP Error Propagation** — Explicit 4xx/5xx detection in `saveSetting()` surfaces toast notifications to the user on failed saves.

---

## [6.1.6] - 2026-03-30

### Fixed
- **Type Guard Hardening (Round 1)** — Audited and refactored 11 MCP tool argument type guards to include explicit `typeof` validation for all optional fields. Prevents LLM-hallucinated payloads from causing runtime type coercion errors in handlers.

---

## [6.1.5] - 2026-03-30

### Added
- **`maintenance_vacuum` Tool** — New MCP tool to run `VACUUM` on the local SQLite database after large purge operations, reclaiming page allocations that SQLite retains until explicitly vacuumed.

### Fixed
- **Prototype Pollution Guards** — CRDT merge pipeline hardened against `__proto__` / `constructor` injection via `Object.create(null)` scratchpads.

### Tests
- **425-test Edge-Case Suite** — Added comprehensive tests across 20 files covering CRDT merges, TurboQuant mathematical invariants, prototype pollution guards, and SQLite retention TTL boundary conditions.

---

## [6.1.0] - 2026-03-30

### Added
- **Smart Memory Merge UI (Knowledge Gardening)**: Integrated a dynamic dropdown directly into the graph's `nodeEditorPanel`. Users can now instantly merge duplicate or fragmented keywords directly from the UI without backend refactoring.
- **Deep Purge Visualization (Memory Density)**: Added an intuitive "Memory Density" analytical stat within the `schedulerCard`. This zero-overhead metric visualizes the ratio of standard insights versus highly-reinforced (Graduated) ideas, rendering immediate feedback on the project's learning efficiency.
- **Semantic Search Highlighting**: Re-engineered the payload rendering for vector results to utilize a RegEx-powered match engine. Found context fragments dynamically wrap exact keyword matches in a vibrant `<mark>` tag, instantly explaining *why* a vector was pulled.

---

## [6.0.0] - 2026-03-29

### Added
- **Context-Boosted Vector Search**: Intelligent API param `context_boost` biases semantic queries by organically injecting current handoff state/working context into the embedding model alongside user queries.
- **AbortController Concurrency Safety**: Hardened the UI `performSearch` loop to elegantly cancel in-flight API requests during rapid debounce typing.

---

## [5.4.0] - 2026-03-28
- **CRDT Handoff Merging**: Replaced strict OCC rejection with automatic conflict-free multi-agent state merging. When two agents save concurrently, Prism now auto-merges instead of rejecting.
  - Custom OR-Map engine (`crdtMerge.ts`): Add-Wins OR-Set for arrays (`open_todos`), Last-Writer-Wins for scalars (`last_summary`, `key_context`).
  - 3-way merge with `getHandoffAtVersion()` base retrieval from SQLite and Supabase.
  - `disable_merge` bypass parameter for strict OCC when needed.
  - `totalCrdtMerges` tracked in health stats and dashboard.
- **Background Purge Scheduler**: Unified automated maintenance system that replaces all manual storage management.
  - Single `setInterval` loop (default: 12 hours, configurable via `PRISM_SCHEDULER_INTERVAL_MS`).
  - 4 maintenance tasks: TTL sweep, Ebbinghaus importance decay, auto-compaction, deep storage purge.
  - Dashboard status card with last sweep timestamp, duration, and per-task results.
  - `PRISM_SCHEDULER_ENABLED` env var (default: `true`).
- **Autonomous Web Scholar**: Agent-driven background research pipeline.
  - Brave Search → Firecrawl scrape → LLM synthesis → Prism ledger injection.
  - Task-aware topic selection: biases research toward active Hivemind agent tasks.
  - Reentrancy guard prevents concurrent pipeline runs.
  - 15K character content cap per scraped article for cost control.
  - Configurable: `PRISM_SCHOLAR_ENABLED`, `PRISM_SCHOLAR_INTERVAL_MS`, `PRISM_SCHOLAR_TOPICS`, `PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN`.
- **Scholar ↔ Hivemind Integration**: Scholar registers as `scholar` role agent with lifecycle heartbeats at each pipeline stage. Telepathy broadcast fires on completion to notify active agents. Task-aware topic selection biases research toward topics matching active agent tasks.
- **Updated Architecture Documentation**: 3 new sections in `docs/ARCHITECTURE.md` covering Agent Hivemind, Background Scheduler, and Web Scholar with mermaid diagrams.

### Architecture
- New module: `src/scholar/webScholar.ts` — 281 lines, full pipeline with Hivemind integration.
- New module: `src/crdtMerge.ts` — OR-Map engine with 3-way merge algorithm.
- Extended: `src/backgroundScheduler.ts` — unified maintenance + Scholar scheduling.
- Storage interface: `getHandoffAtVersion()` for CRDT base retrieval.

### Engineering
- 362 tests across 16 suites (10 new Scholar tests)
- Clean TypeScript build, zero errors
- Backward compatible: all new features are opt-in via env vars

---

## [5.3.0] - 2026-03-28

### Added
- **Hivemind Health Watchdog**: Server-side active monitoring system for multi-agent coordination. Transforms the Hivemind from a passive registry into a self-healing orchestrator.
  - **State Machine**: Agents transition through `ACTIVE → STALE (5m) → FROZEN (15m) → OFFLINE (30m, auto-pruned)` based on heartbeat freshness.
  - **OVERDUE Detection**: Agents can declare `expected_duration_minutes` on heartbeat. If the task exceeds this ETA, the Watchdog flags the agent as OVERDUE.
  - **Loop Detection**: DJB2 hash of `current_task` is computed on every heartbeat. If the same task repeats ≥5 times consecutively, the agent is flagged as LOOPING. Detection runs inline in the heartbeat hot path (~0.01ms overhead).
  - **Telepathy (Alert Injection)**: Watchdog alerts are appended **directly to `result.content[]`** of tool responses, bypassing MCP's `sendLoggingMessage` limitation where LLMs don't read debug logs. This guarantees the LLM reads the alert in its reasoning loop.
  - **Configurable Thresholds**: All thresholds configurable via env vars (`PRISM_WATCHDOG_INTERVAL_MS`, `PRISM_WATCHDOG_STALE_MIN`, `PRISM_WATCHDOG_FROZEN_MIN`, `PRISM_WATCHDOG_OFFLINE_MIN`, `PRISM_WATCHDOG_LOOP_THRESHOLD`).
- **`expected_duration_minutes` parameter**: New optional parameter on `agent_heartbeat` tool for task ETA declarations.
- **Health-State Dashboard**: Hivemind Radar now shows color-coded health indicators (🟢/🟡/🔴/⏰/🔄), loop count badges, and auto-refreshes every 15 seconds.
- **`getAllAgents()` / `updateAgentStatus()`**: New storage backend methods for cross-project agent sweeps and whitelist-guarded status transitions.
- **Supabase Migration 032**: `task_start_time`, `expected_duration_minutes`, `task_hash`, `loop_count` columns + user_id index.

### Architecture
- New module: `src/hivemindWatchdog.ts` — 270 lines of pure business logic, zero MCP Server dependency, fully testable in isolation.
- Alert queue: In-memory `Map<string, WatchdogAlert>` with dedup key `project:role:status` — fire-and-forget, no persistence needed.
- Dual-mode alerting: Direct content injection (primary, for LLMs) + `sendLoggingMessage` (secondary, for operators).
- Graceful degradation: All sweep errors are caught and logged, never crash the server. `PRISM_ENABLE_HIVEMIND` gate prevents any CPU overhead for single-agent users.

### Engineering
- 10 files changed, ~600 lines added
- Clean TypeScript build, zero errors
- Backward compatible: all new columns have defaults, watchdog is no-op without `PRISM_ENABLE_HIVEMIND=true`

---

## [5.2.0] - 2026-03-27

### Added
- **Cognitive Memory — Ebbinghaus Importance Decay**: Entries now have `last_accessed_at` tracking. At retrieval time, `effective_importance = base × 0.95^days` computes a time-decayed relevance score. Frequently accessed memories stay prominent; neglected ones fade naturally.
- **Context-Weighted Retrieval** (`context_boost` parameter): When enabled on `session_search_memory`, the active project's branch, keywords, and context are prepended to the search query before embedding generation — naturally biasing the vector toward contextually relevant results.
- **Smart Consolidation**: Enhanced the `session_compact_ledger` prompt to extract recurring principles and patterns alongside summaries, producing richer rollup entries.
- **Universal History Migration**: Modular migration utility using the Strategy Pattern. Ingest historical sessions from Claude Code (JSONL streaming), Gemini (OOM-safe StreamArray), and OpenAI/ChatGPT (JSON) into the Mind Palace.
  - **Conversation Grouping**: Turns are grouped into logical conversations using a 30-minute time-gap heuristic. A 100MB file with 200 conversations → 200 summary entries (not 50,000 raw turns).
  - **Idempotent Deduplication**: Each conversation gets a deterministic ID. Re-running the same import is a no-op.
  - **Dashboard Import UI**: File picker (📂 Browse) + manual path input, auto-format detection, real-time result display.
  - Features `p-limit(5)` concurrency control and `--dry-run` support.

### Security
- **SQL Injection Prevention**: Added 17-column allowlist to `patchLedger()` in SQLite storage. Dynamic column interpolation now rejects any column not in the allowlist.

### Fixed
- **Supabase DDL v31**: Added missing `last_accessed_at` column migration for Supabase users. Without this, the Ebbinghaus decay logic would have thrown a column-not-found error.
- **context_boost guard**: Now logs a warning and continues gracefully when `context_boost=true` is passed without a `project` parameter, instead of silently failing.
- **Redundant getStorage() call**: Removed duplicate storage initialization in the Ebbinghaus decay block.
- **README dead link**: Fixed `#supabase-setup` anchor (inside `<details>` blocks, GitHub doesn't generate anchors).

### Engineering
- 9 new migration tests (adapter parsing, conversation grouping, dedup, tool keyword preservation)
- 352 tests across 15 suites
- 17 files changed, +1,016 lines

---

## [5.1.0] - 2026-03-27
### Added
- **Deep Storage Mode**: New `deep_storage_purge` tool to reclaim ~90% of vector storage by dropping float32 vectors for entries with TurboQuant compressed blobs.
- **Knowledge Graph Editor**: Transformed the Mind Palace Neural Graph into an interactive editor with dynamic filtering, node renaming, and surgical keyword deletion.
### Fixed
- **Auto-Load Reliability**: Hardened auto-load prompt instructions and added hook scripts for Claude Code / Antigravity to ensure memory is loaded on the first turn (bypassing model CoT hallucinations).
### Engineering
- 303/303 automated tests passing across 13 suites.

## 🚀 v5.0.0 — The TurboQuant Update (2026-03-26)

**Quantized Agentic Memory is here.**

### ✨ Features

- **10× Storage Reduction:** Integrated Google's TurboQuant algorithm (ICLR 2026) to compress 768-dim embeddings from 3,072 bytes to ~400 bytes. Zero external dependencies — pure TypeScript math core with Householder QR, Lloyd-Max scalar quantization, and QJL residual correction.
- **Two-Tier Search:** Introduced a JS-land asymmetric similarity search fallback (`asymmetricCosineSimilarity`), ensuring semantic search works even without native DB vector extensions (`sqlite-vec` / `pgvector`).
- **Atomic Backfill:** Optimized background workers to repair and compress embeddings in a single atomic database update (`patchLedger`), reducing lock contention for multi-agent Hivemind use cases.
- **Supabase Parity:** Full support for quantized blobs in the cloud backend (migration v29 + `saveLedger` insert).

### 🏗️ Architecture

- New file: `src/utils/turboquant.ts` — 665 lines, zero-dependency math core
- Storage schema: `embedding_compressed` (TEXT/base64), `embedding_format` (turbo3/turbo4/float32), `embedding_turbo_radius` (REAL)
- SQLite migration v5.0 (3 idempotent ALTER TABLE)
- Supabase migration v29 via `prism_apply_ddl` RPC

### 📊 Benchmarks

| Metric | Value |
|--------|-------|
| Compression ratio (d=768, 4-bit) | **~7.7:1** (400 bytes vs 3,072) |
| Compression ratio (d=768, 3-bit) | **~10.1:1** (304 bytes vs 3,072) |
| Similarity correlation (4-bit) | >0.85 |
| Top-1 retrieval accuracy (N=100) | >90% |
| Tests | 295/295 pass |

### 📚 Documentation

- Published RFC-001: Quantized Agentic Memory (`docs/rfcs/001-turboquant-integration.md`)

---

## v4.6.1 — Stability (2026-03-25)

- Fixed auto-load reliability for `session_load_context` tool
- Dashboard project dropdown freeze resolved

## v4.6.0 — Observable AI (2026-03-25)

- OpenTelemetry distributed tracing integration
- Visual Language Model (VLM) image captioning
- Mind Palace dashboard improvements

## v4.3.0 — IDE Rules Sync (2026-03-25)

- `knowledge_sync_rules` tool: graduated insights → `.cursorrules` / `.clauderules`
- Sentinel-based idempotent file writing

## v4.0.0 — Behavioral Memory (2026-03-24)

- Active Behavioral Memory with experience events
- Importance scoring and graduated insights
- Pluggable LLM providers (OpenAI, Anthropic, Gemini, Ollama)

## v3.0.0 — Hivemind (2026-03-23)

- Multi-agent role-based scoping
- Team roster injection on context load

## v2.0.0 — Time Travel (2026-03-22)

- Version-controlled handoff snapshots
- `memory_history` + `memory_checkout` tools
- Visual memory (image save/view)

## v1.0.0 — Foundation (2026-03-20)

- Session ledger with keyword extraction
- Handoff state persistence
- SQLite + Supabase dual backends
- Semantic search via pgvector / sqlite-vec
- GDPR export and surgical deletion
