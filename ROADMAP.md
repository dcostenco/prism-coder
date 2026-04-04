# Prism MCP — Roadmap

> Full release history: [`CHANGELOG.md`](CHANGELOG.md) · Issue tracking: [GitHub Issues](../../issues)

---
## 🏆 Shipped

Prism has evolved from a simple SQLite session logger into a **Quantized, Multimodal, Multi-Agent, Self-Learning, Observable AI Operating System**.

### ✅ v7.5.0 — Intent Health Dashboard + Security Hardening 🩺

> **Problem:** Projects silently drift into staleness when agents stop working on them. The dashboard had no way to surface this — and had accumulated 10 unescaped innerHTML injection points across factory, ledger, and health rendering.
> **Solution:** A real-time 3-signal health scoring algorithm + comprehensive XSS hardening sweep across the entire dashboard.

| Feature | Detail |
|---------|--------|
| 🩺 **Intent Health Scoring** | Per-project 0–100 health score computed from 3 weighted signals: staleness decay (50pts, linear over configurable threshold), TODO overload (30pts, tiered by count), and decision presence (20pts). Rendered as a gauge card with actionable signals per project. |
| 🛡️ **10 XSS Vectors Patched** | Comprehensive innerHTML sanitization sweep: project name dropdowns, pipeline objectives, ledger decisions, error messages, version badges, factory catch handler, and health card score. All user-facing strings now pass through `escapeHtml()`. |
| 🧮 **Algorithm Hardening** | `Number.isFinite()` guard catches NaN thresholds that bypass `<= 0` checks. `Math.min(100, ...)` defensive clamp prevents future scoring regressions. Division-by-zero protection on `staleThresholdDays`. |
| ⚙️ **Configurable Threshold** | `intent_health_stale_threshold_days` system setting (default: 30 days) editable from the Dashboard UI. |
| 🧪 **14 Tests** | Exhaustive coverage: fresh/stale/empty contexts, NaN timestamps, NaN thresholds, custom thresholds, TODO boundaries, multi-session decisions, score ceiling, signal severity matrix, clock skew, and signal shape validation. |

---
### ✅ v7.4.0 — Adversarial Evaluation (Anti-Sycophancy) ⚔️

> **Problem:** In autonomous coding loops, self-evaluation is structurally biased — the same reasoning policy that generates code under-detects its own deep defects.
> **Solution:** Native generator/evaluator sprint architecture with isolated contexts, pre-committed scoring contracts, and evidence-bound review gates before promotion.

| Feature | Detail |
|---------|--------|
| 🧭 **`PLAN_CONTRACT` Step** | Before any code execution, the generator commits to a machine-parseable rubric (`ContractPayload`). Each criterion has a string `id` and `description`. Contract is written to `contract_rubric.json` and locked before any code changes. |
| ⚔️ **`EVALUATE` Step** | After `EXECUTE`, an isolated adversarial evaluator scores the output against the contract. Findings include `severity`, `criterion_id`, `pass_fail`, and evidence pointers (`file`, `line {number}`, `description`). |
| 🔁 **Intelligent Revision Flow** | Fail + `plan_viable=true` → EXECUTE retry (burns `eval_revisions` and injects the Evaluator's detailed findings into the Generator's prompt — the Generator is never flying blind). Fail + `plan_viable=false` → full PLAN re-plan (resets revisions, increments iteration). Pass → VERIFY. |
| 🔒 **Conservative Parse Failure Handling** | Malformed LLM output defaults `plan_viable=false` — escalates to PLAN instead of burning revision budget on a broken response format. |
| 📐 **Per-Criterion Shape Validation** | `parseContractOutput` rejects criteria missing `id`/`description` fields or containing primitives. `parseEvaluationOutput` strictly validates the `findings` array, immediately rejecting any LLM claims that fail to provide a structured `evidence` pointer (file/line/description). |
| 🛡️ **Disk-Error Pipeline Guard** | `contract_rubric.json` write failures now immediately mark the pipeline `FAILED` — prevents infinite loops on disk/permission errors. |
| 🗄️ **Storage Parity** | New `eval_revisions`, `contract_payload`, `notes` columns on `dark_factory_pipelines` (SQLite + Supabase). SQLite backfill migration included for existing rows. |
| 🧠 **Experience Ledger Integration** | Evaluation outcomes emitted as `learning` events — feeds the ML routing feedback loop. |
| 🧪 **978 Tests** | 44 suites (78 new adversarial evaluation tests covering all parser branches, transition logic, deadlock/oscillation scenarios). TypeScript: clean. |

---
### ✅ v7.3.3 — Dashboard Stability Hotfix

| Fix | Detail |
|-----|--------|
| 🐛 **`abortPipeline` SyntaxError** | A lone `\'` escape in the template literal was consumed as a JS escape sequence, producing `''` (bare quotes, no backslash) in the served HTML. The browser's parser saw two adjacent string literals → `SyntaxError: Unexpected string` → the entire inline IIFE silently failed → project dropdown frozen at "Loading..." forever. Fixed via `data-id` attribute pattern, eliminating multi-layer escaping entirely. |
| 🛡️ **ES5 Lint Guard** | `scripts/lint-dashboard-es5.cjs` (exposed as `npm run lint:dashboard`) scans the inline `<script>` block for ES6+ syntax and the lone-backslash quote-escape trap at CI/pre-commit time. |

---
### ✅ v7.3.2 — Verification Diagnostics v2

| Feature | Detail |
|---------|--------|
| 📊 **`diff_counts` + `changed_keys`** | `verify status --json` now emits per-layer `diff_counts` (assertions checked/passed/failed/warned) and `changed_keys` (keys that changed vs baseline). Additive, non-breaking — `schema_version: 1`. |
| 📃 **JSON Compatibility Contract** | Formal schema contract (`docs/verification-json-contract.md`) enforced by a process-level integration test — any breaking JSON change fails CI before shipping. |
| 🔀 **CLI Compute/Render Separation** | `computeVerificationStatus()` and `renderVerificationStatus()` are now separate — `--json` bypasses the renderer entirely, guaranteeing clean machine output. |

---
### ✅ v7.3.1 — Dark Factory: Fail-Closed Execution Engine 🏭

> **The LLM never touches the filesystem directly. Every action passes through three gates before any side effect occurs.**

| Feature | Detail |
|---------|--------|
| 🔒 **Gate 1 — Adversarial Parser** | 3-strategy cascading extractor (direct JSON → fenced code → prose stripping) handles the full spectrum of real-world LLM output. |
| 🔒 **Gate 2 — Type Validation** | Every action validated against the `ActionType` enum. Hallucinated or coerced action types rejected before any filesystem call. |
| 🔒 **Gate 3 — Scope Validation** | Every `targetPath` resolved against `workingDirectory`. Path traversal (`../`), absolute paths, null bytes, unicode normalization attacks, sibling-prefix bypass — all blocked. Scope violation terminates the **entire pipeline**, preventing partial writes. |
| ☠️ **Poison Pill Defense** | Malicious payloads (root-targeting `DELETE_FILE`, multi-MB content bombing) caught at Gate 2/Gate 3 before execution. |
| 📊 **Factory Dashboard Tab** | Real-time pipeline visualization: status, gate indicators, iteration count, elapsed time, emergency kill switch. |
| 🧪 **67 Adversarial Tests** | Full surface coverage: parse strategies, type coercion, path traversal vectors, null bytes, unicode normalization, 100-action stress payloads, 100KB content strings, 500-segment deep paths. |

---
### ✅ v7.3.0 — Dark Factory: Foundation 🏭

| Feature | Detail |
|---------|--------|
| 🗄️ **Pipeline Storage Layer** | `pipelines` table (SQLite + Supabase parity) with full lifecycle tracking: `PENDING → RUNNING → COMPLETED/FAILED/ABORTED`, iteration count, working directory, tenant isolation. |
| 🔄 **Background Pipeline Runner** | Chains `plan → execute → verify → iterate` without blocking MCP RPC threads. Hard limits: `PRISM_DARK_FACTORY_MAX_ITERATIONS` (default: `10`), `PRISM_DARK_FACTORY_TIMEOUT_MINUTES` (default: `30`). |
| 🤝 **Native Claw Delegation** | `ClawInvocation` routes generation-heavy tasks (scaffolding, testing, linting) to the local model. Host triggers and immediately acks; orchestration runs concurrently in the background. |

---
### ✅ v7.2.0 — Verification Harness (Front-Loaded Testing) 🔭

| Feature | Detail |
|---------|--------|
| 🔐 **Spec-Freeze Contract** | `verification_harness.json` is generated and hash-locked (`rubric_hash`) *before* execution. Criteria cannot drift mid-sprint. |
| 🔬 **Multi-Layer Verification** | Assertions across **Data Accuracy**, **Agent Behavior**, and **Pipeline Integrity** — independently configurable, machine-parseable. |
| 🚦 **Finalization Gate Policies** | `warn` / `gate` / `abort` — autonomous pipelines cannot finalize when blocking criteria fail. |
| 📊 **`validation_result` Experience Event** | Per-layer pass/fail outcomes feed directly into the v7.1.0 ML routing feedback loop. |
| ⌨️ **CLI Commands** | `verify generate` · `verify status` — both with `--json` for machine-readable CI output. Exit `0` for pass/warn/bypassed; `1` for blocked drift. |

---
### ✅ v7.1.0 — Prism Task Router (Heuristic + ML Experience) 🚦

| Feature | Detail |
|---------|--------|
| 🚦 **Heuristic Routing Engine** | Deterministic `session_task_route` tool dynamically routes tasks to either the host cloud model or local agent (Claw) based on task description, file count, and scope. Evaluated over 5 core signals. |
| 🤖 **Experience-Based ML Routing** | Cold-start protected ML layer leverages historical performance (Win Rate) extracted by the `routerExperience` system to apply dynamic confidence boosts or penalties to the routing score. |
| 🖥️ **Dashboard Integration** | Added controls in `src/dashboard/ui.ts` under Node Editor settings to visually monitor and toggle Prism Task Router configuration. |
| 🧩 **Tool Discoverability** | Fully integrates `session_task_route` into the external registry through `createSandboxServer`, ensuring scanners can enumerate task delegating capabilities robustly. |
| 🧪 **Test Coverage** | Comprehensive suite spanning 33 tests across `task-router.test.ts` and `router-experience.test.ts`, verifying cold starts, structural biases, and signal weighting. |

---
### ✅ v7.0.0 — ACT-R Cognitive Activation Memory

| Feature | Detail |
|---------|--------|
| 🧠 **ACT-R Activation Model** | Scientifically-grounded memory retrieval based on Anderson's ACT-R cognitive architecture. Base-level activation `B_i = ln(Σ t_j^{-d})` replaces flat similarity search with recency × frequency scoring that mirrors human memory decay. |
| 🔗 **Candidate-Scoped Spreading Activation** | Activation spreads only within the current search result set — prevents "God node" centrality bias where highly-connected nodes dominate every query. |
| 📊 **Composite Scoring** | `0.7 × similarity + 0.3 × σ(activation)` blends semantic relevance with cognitive activation. Sigmoid normalization keeps activation in `[0,1]` regardless of access pattern. |
| 🔄 **AccessLogBuffer** | In-memory batch-write buffer with 5-second flush window resolves `SQLITE_BUSY` contention during parallel multi-agent tool calls. Graceful shutdown via `BackgroundTaskRegistry`. |
| 🚀 **Zero Cold-Start** | Memory creation seeds an initial access log entry — new memories are immediately rankable, no warm-up period needed. |
| 🗄️ **Supabase Parity** | Migration 037 (`actr_access_log`) + Supabase SQL functions for access log writes and activation computation. Full feature parity with SQLite backend. |
| ⚙️ **Full Configurability** | 5 new env vars: `PRISM_ACTR_ENABLED`, `PRISM_ACTR_DECAY`, `PRISM_ACTR_WEIGHT_SIMILARITY`, `PRISM_ACTR_WEIGHT_ACTIVATION`, `PRISM_ACTR_ACCESS_LOG_RETENTION_DAYS`. |
| 📖 **Documentation Overhaul** | README refreshed with Mind Palace terminology, Universal Import top-level section, Quick Start port-conflict collapsible, TL;DR env var guide, and live v7.0.0 dashboard screenshot. |
| 🧪 **705 Tests** | 32 suites (49 new ACT-R tests across activation math, access log buffer, SQLite/Supabase parity). Zero regressions. |

---
### ✅ v6.5.1 — Dashboard Project-Load Hotfix

| Fix | Detail |
|-----|--------|
| 🩹 **Project Selector Bootstrap** | Fixed a startup failure where unresolved Supabase env placeholders (`$` / `$`) could break `/api/projects` and leave the selector stuck on "Loading projects...". |
| 🔄 **Backend Fallback Safety** | Added guardrails to auto-fallback to local SQLite when Supabase backend is requested but env config is invalid/unresolved. |

---
### ✅ v6.5.0 — HDC Cognitive Routing

| Feature | Detail |
|---------|--------|
| 🧠 **HDC Cognitive Routing** | New `session_cognitive_route` tool composes agent state, role, and action into a 768-dim binary hypervector via XOR binding, resolves to nearest concept via Hamming distance, and routes through a three-outcome policy gateway (`direct` / `clarify` / `fallback`). |
| 🎛️ **Per-Project Threshold Overrides** | Fallback and clarify thresholds are configurable per-project and persisted via the existing `getSetting`/`setSetting` contract. No new storage migrations required (**Phase 2 storage-parity scope note**: `getSetting()`/`setSetting()` already abstracts SQLite/Supabase parity for threshold overrides as decimal-string key-value pairs). |
| 🔬 **Explainability Mode** | When `explain: true`, responses include convergence steps, raw Hamming distance, and ambiguity flags. Controlled by `PRISM_HDC_EXPLAINABILITY_ENABLED` (default: `true`). |
| 📊 **Cognitive Observability** | `recordCognitiveRoute()` in `graphMetrics.ts` tracks route distribution, rolling confidence/distance averages, ambiguity rates, and null-concept counts. Warning heuristics: fallback rate > 30%, ambiguity rate > 40%. |
| 🖥️ **Dashboard Cognitive Card** | Route distribution bar, confidence/distance gauges, and warning badges in the Mind Palace metrics panel. On-demand "Cognitive Route" button in the Node Editor panel. |
| 🔒 **Feature Gating** | Entire v6.5 pipeline gated behind `PRISM_HDC_ENABLED` (default: `true`). Clean error + zero telemetry when disabled. |
| 🧪 **566 Tests** | 30 suites (42 new tests: 26 handler integration + 16 dashboard API). TypeScript strict mode, zero errors, zero regressions. |

---
### ✅ v6.2.0 — Autonomous Cognitive Loop ("Synthesize & Prune")

| Feature | Detail |
|---------|--------|
| 🧬 **Edge Synthesis ("The Dream Procedure")** | Automated background linker (`session_synthesize_edges`) discovers semantically similar but disconnected memory nodes via cosine similarity (threshold ≥ 0.7). Batch-limited to 50 sources × 3 neighbors per sweep to prevent runaway graph growth. |
| ✂️ **Graph Pruning (Soft-Prune)** | Configurable strength-based pruning (`PRISM_GRAPH_PRUNING_ENABLED`) soft-deletes weak links below a configurable minimum strength. Per-project cooldown, backpressure guards, and sweep budget controls. |
| 📊 **SLO Observability Layer** | `graphMetrics.ts` tracks synthesis success rate, net new links, prune ratio, and sweep duration. Exposes `slo` and `warnings` fields for proactive health monitoring. |
| 🖥️ **Dashboard Metrics Integration** | SLO cards, warning badges, and pruning skip breakdown (backpressure / cooldown / budget) in the Mind Palace dashboard at `/api/graph/metrics`. |
| 🌡️ **Temporal Decay Heatmaps** | UI overlay toggle where un-accessed nodes desaturate while Graduated nodes stay vibrant. Graph router extraction + decay view toggle. |
| 🧪 **Active Recall Prompt Generation** | "Test Me" utility in the node editor panel generates synthetic quizzes from semantic neighbors for knowledge activation. |
| ⚡ **Supabase Weak-Link RPC (WS4.1)** | `prism_summarize_weak_links` Postgres function (migration 036) aggregates pruning server-side in one RPC call, eliminating N+1 network roundtrips. TypeScript fast-path with automatic fallback. |
| 🔐 **Migration 035** | Tenant-safe graph writes + soft-delete hardening for MemoryLinks. |
| 🔧 **Scheduler Telemetry Fix** | `projects_processed` now tracks all attempted projects, not just successes, for accurate SLO derivation. |
| 🧪 **510 Tests** | 28 suites, TypeScript strict mode, zero errors. |

---
### ✅ v6.1.5–v6.1.8 — Production Hardening Series

| Version | Feature | Detail |
|---------|---------|--------|
| v6.1.5 | 🗜️ **`maintenance_vacuum` Tool** | New MCP tool to run SQLite `VACUUM` after large purge operations — reclaims page allocations that SQLite retains until explicitly vacuumed. |
| v6.1.5 | 🔒 **Prototype Pollution Guards** | CRDT merge pipeline hardened against `__proto__` / `constructor` injection via `Object.create(null)` scratchpads. |
| v6.1.5 | 🧪 **425-Test Suite** | Edge-case suite across 20 files: CRDT merges, TurboQuant math invariants, prototype pollution, SQLite TTL boundary conditions. |
| v6.1.6 | 🛡️ **11 Type Guards Hardened (Round 1)** | All MCP tool argument guards audited; explicit `typeof` validation added for every optional field. Prevents LLM-hallucinated payloads from bypassing type safety. |
| v6.1.7 | 🔄 **Toggle Rollback on Failure** | `saveSetting()` returns `Promise<boolean>`; Hivemind and Auto-Capture toggles roll back optimistic UI state on server error. |
| v6.1.7 | 🚫 **Settings Cache-Busting** | `loadSettings()` appends `?t=<timestamp>` to bypass stale browser/service-worker caches. |
| v6.1.8 | 🛡️ **Missing Guard: `isSessionCompactLedgerArgs`** | `SESSION_COMPACT_LEDGER_TOOL` existed with no type guard — added with full optional field validation. |
| v6.1.8 | ✅ **Array Field Validation** | `isSessionSaveLedgerArgs` now guards `todos`, `files_changed`, `decisions` with `Array.isArray`. |
| v6.1.8 | 🔖 **Enum Literal Guard** | `isSessionExportMemoryArgs` rejects unknown `format` values at the MCP boundary. |
| v6.1.8 | 🔢 **Numeric Guards** | `isSessionIntuitiveRecallArgs` validates `limit` and `threshold` as numbers. |

---
### ✅ v6.1.0 — Prism-Port, Security Hardening & Dashboard Healing

| Feature | Detail |
|---------|--------|
| 📦 **Prism-Port Vault Export** | New `vault` format for `session_export_memory` — generates a `.zip` of interlinked Markdown files with YAML frontmatter (`date`, `type`, `project`, `importance`, `tags`, `summary`), `[[Wikilinks]]`, and auto-generated `Keywords/` backlink indices. Drop into Obsidian or Logseq for instant knowledge graph. Zero new dependencies (`fflate` already present). |
| 🏥 **Dashboard Health Cleanup** | `POST /api/health/cleanup` now dynamically imports `backfillEmbeddingsHandler` to repair missing embeddings directly from the Mind Palace UI — no MCP tool call required. Paginated with `MAX_ITERATIONS=100` safety cap. |
| 🔒 **Path Traversal Fix** | `/api/import-upload` now sanitizes filenames via `path.basename()` to prevent directory traversal attacks from malicious payloads. |
| 🔧 **Dangling Catch Fix** | Fixed mismatched braces in the Scholar Trigger / Search API section of the dashboard server that could prevent compilation. |
| 📡 **Search API 503 Handling** | `/api/search` now returns `503 Service Unavailable` with a clear message when the LLM provider is not configured, instead of a generic 500 error. |
| 🪟 **Windows Port Cleanup** | `killPortHolder` now uses `netstat`/`taskkill` on Windows instead of Unix-only `lsof`/`kill`. |
| 🧹 **readBody Buffer Optimization** | Shared `readBody()` helper now uses `Buffer[]` array + `Buffer.concat()` instead of string concatenation, preventing GC thrash on large imports (ChatGPT history files). All 4 inline body-read duplicates replaced. |
| 🛡️ **Vault Exporter Bug Fixes** | Fixed filename collision (counter suffix dedup), `escapeYaml` (backslashes, newlines, control chars), `slugify` empty-result fallback, and Markdown table pipe escaping. |
| 📋 **Export Schema Version** | Bumped export payload `version` from `"4.5"` to `"6.1"` to match the release. |
| 📖 **README Overhaul** | Added Magic Moment demo, Capability Matrix, competitor comparison grid, Big Three callout box. Renamed "Research Roadmap" → "Scientific Foundation" and "Roadmap" → "Product Roadmap". |

---

<details>
<summary><strong>📜 Earlier releases (v5.5 → v3.0) — click to expand</strong></summary>

> For full details on every release, see [`CHANGELOG.md`](CHANGELOG.md).

| Version | Codename | Highlights |
|---------|----------|------------|
| **v5.5.0** | Architectural Hardening | Transactional migrations, graceful shutdown registry, thundering herd prevention, zero-thrashing SDM scans. 374 tests. |
| **v5.4.0** | Concurrency & Autonomous Research | CRDT OR-Map handoff merging, background purge scheduler, autonomous Web Scholar, Scholar ↔ Hivemind integration. |
| **v5.3.0** | Verification Watchdog | Active pipeline orchestrator, declarative/sandboxed test assertions, `validation_result` logging, and programmatic gating. |
| **v5.2.0** | Cognitive Memory & Universal Migration | Ebbinghaus importance decay, context-weighted retrieval, Universal History Migration (Claude/Gemini/ChatGPT), SQL injection prevention. |
| **v5.1.0** | Knowledge Graph Editor & Deep Storage | Deep storage purge (~90% vector savings), interactive graph editor with filtering and node surgery. |
| **v5.0.0** | Quantized Agentic Memory | TurboQuant ~7× embedding compression, three-tier search (FTS5 → sqlite-vec → JS fallback), atomic backfill. |
| **v4.6.0** | OpenTelemetry Observability | MCP root spans, `TracingLLMProvider` decorator, GDPR-safe attributes, Jaeger dashboard. |
| **v4.5.x** | VLM Multimodal Memory & GDPR Export | Auto-captioning pipeline, semantic image search, GDPR Art. 20 export, concurrent safety tests. |
| **v4.4.0** | Pluggable LLM Adapters (BYOM) | OpenAI/Anthropic/Gemini/Ollama providers, air-gapped mode, split text+embedding config. |
| **v4.0–4.3** | Behavioral Memory & IDE Sync | Experience events, importance scoring, knowledge → `.cursorrules` sync, project repo registry. |
| **v3.x** | Memory Lifecycle & Agent Hivemind | Data retention (TTL), auto-compaction, role-scoped memory, Telepathy real-time sync. |

</details>

## 📊 The State of Prism (v7.5.0)

With v7.5.0 shipped, Prism is a **production-hardened, fail-closed, adversarially-evaluated autonomous AI Operating System** — the first MCP server that runs your agents *without letting them touch the filesystem unsupervised*, *without letting them grade their own homework*, and *with real-time visibility into project health*:

- **Health-Aware** — Intent Health Dashboard scores every project 0–100 across staleness, TODO load, and decision quality. Silent drift becomes an actionable signal before it becomes a crisis.
- **Comprehensively Sanitized** — 10 XSS injection vectors patched across all dashboard rendering paths (factory, ledger, health, history, error handlers). Every user-facing string now passes through `escapeHtml()`.
- **Anti-Sycophancy by Design** — The Adversarial Evaluation (PLAN_CONTRACT → EVALUATE) pipeline separates generator and evaluator into isolated roles with pre-committed rubrics. The evaluator cannot approve without evidence; the generator cannot skip the contract.
- **Fail-Closed by Default** — Dark Factory 3-gate pipeline (Parse → Type → Scope) means the LLM never writes a byte to disk directly. Every action validated before any side effect.
- **Conservatively Fail-Safe** — Parse failures default `plan_viable=false` — escalating to full PLAN re-planning instead of burning revision budget on broken LLM output.
- **Autonomously Verified** — Verification Harness generates spec-freeze contracts before execution, hash-locks them, and gates finalization against immutable outcomes.
- **Intelligently Routed** — Heuristic + ML Task Router delegates cloud vs. local in under 2ms, cold-start safe, experience-corrected per project.
- **Scientifically-Grounded** — ACT-R activation model (`B_i = ln(Σ t_j^{-d})`) ranks memories by recency × frequency. Candidate-scoped spreading activation prevents centrality bias.
- **Cognitively-Routed** — HDC binary hypervectors + Hamming distance concept resolution + policy gateway. Three-outcome routing: `direct / clarify / fallback`.
- **Self-Organizing** — Edge Synthesis + Graph Pruning form an autonomous cognitive loop: the graph grows connective tissue overnight and prunes dead weight on schedule.
- **Observable** — SLO dashboard: synthesis success rate, net link growth, prune ratio, sweep latency, cognitive route distribution, pipeline gate pass/fail. Warning badges fire proactively.
- **Diagnostically Rich** — `verify status --json` emits `diff_counts` + `changed_keys` per layer. JSON contract is CI-enforced and schema-versioned.
- **Zero Cold-Start** — Universal Migration imports years of Claude/Gemini/ChatGPT history on day one. New memories are access-seeded immediately.
- **Scale** — TurboQuant 10× compression + Deep Storage Purge + SQLite VACUUM. Decades of session history on a laptop.
- **Safe** — Full type-guard matrix across all 30+ MCP tools. Path traversal, poison pill payloads, null-byte injection — all blocked at the gate layer before any execution.
- **Convergent** — CRDT OR-Map handoff merging. Multiple agents, zero conflicts.
- **Autonomous** — Web Scholar researches while you sleep. Dark Factory executes while you sleep. Task Router delegates while you sleep. Adversarial Evaluator keeps the output honest.
- **Reliable** — 978 passing tests. ES5 lint guard on all dashboard inline scripts. JSON contract CI enforcement on all CLI output schemas.
- **Multimodal** — VLM auto-captioning turns screenshots into semantically searchable memory.
- **Security** — SQL injection prevention, path traversal guard, Poison Pill defense, GDPR Art. 17+20 compliance.

---
## 🗺️ Next on the Horizon

### 📱 Mind Palace Mobile PWA `[Backlog]`
**Problem:** The dashboard is desktop-only. Quick check-ins on mobile require a laptop.
**Solution:** Progressive Web App with responsive glassmorphism layout, offline-first IndexedDB cache, and push notifications for agent activity.
**Phases:**
1. Responsive CSS breakpoints for the existing dashboard
2. Service worker + offline cache for read-only access
3. Push notifications via Web Push API for Telepathy events

### 🔭 Future Cognitive Tracks

#### v8.x — Affect-Tagged Memory `[Researching]`
- **Problem:** Pure semantic relevance misses urgency and emotional salience in real-world agent collaboration.
- **Benefit:** Recall prioritization improves by weighting memories with affective/contextual valence, making surfaced context more behaviorally useful.
- **Dependency:** Builds on v7.0 ACT-R activation and v6.5 compositional memory states so affect can be attached and retrieved as first-class signal.

#### v9+ — Zero-Search Retrieval `[Exploring]`
- **Problem:** Index/ANN retrieval layers add latency, complexity, and operational overhead at very large memory scales.
- **Benefit:** Direct vector-addressed recall (“just ask the vector”) reduces retrieval indirection and moves Prism toward truly native associative memory.
- **Dependency:** Requires stable SDM/HDC primitives, ACT-R activation calibration, and production-grade retrieval from v7.x/v8.x.

---
## 🧰 Infrastructure Backlog

> 🤝 **Want to contribute?** These items are great entry points for new contributors. Most are self-contained and don't require deep knowledge of the cognitive pipeline. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for guidelines.

| Feature | Notes |
|---------|-------|
| **Supabase `summarizeWeakLinks` N+1 Removal** | Migration 036 ships the RPC; remove the sequential REST fallback once 036 is confirmed deployed across all tenants |
| Supabase RPC Soft-Delete Filtering | Server-side GDPR filtering at the RPC layer |
| Prism CLI | Standalone CLI for backup, export, and health check without MCP |
| Plugin System | Third-party tool registration via MCP tool composition |
| **Supabase MemoryLinks** | Implement `MemoryLinks` (graph-based traversal) in Supabase to achieve full structural parity with SQLite backend |
| **Safe Rollback Primitive (`session_rollback_state`)** | Standardize rollback with snapshot/worktree restoration for autonomous loops; avoid destructive reset-first behavior and require explicit promotion policies |