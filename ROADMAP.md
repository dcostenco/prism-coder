# Prism MCP — Roadmap

> Full release history: [`CHANGELOG.md`](CHANGELOG.md) · Issue tracking: [GitHub Issues](https://github.com/dcostenco/prism-mcp/issues)

---
## 🏆 Shipped

Prism has evolved from a simple SQLite session logger into a **Quantized, Multimodal, Multi-Agent, Self-Learning, Observable AI Operating System**.

### ✅ v8.0.0 — Synapse Engine 🧠

> **Problem:** Static memory retrieval ignores structural salience and causal relationships, limiting multi-hop reasoning.
> **Solution:** A pure, storage-agnostic spreading activation engine (Synapse) implements ACT-R inspired energy propagation through the graph, unblocking deep causal retrieval.

| Feature | Detail |
|---------|--------|
| ⚡ **Storage-Agnostic Core** | Pure functional implementation (`synapseEngine.ts`) decoupled from SQL. Relies on a `LinkFetcher` callback, paving the way for distributed graph databases. |
| 🎛️ **Dampened Fan Effect** | Hub dampening logic applying `1 / ln(degree + e)` penalty prevents densely connected hub nodes from overriding specific, high-signal conversational pathways. |
| ⚖️ **Asymmetric Propagation** | Forward edges transfer 100% activation; backward edges transfer 50%, preserving causal directionality while allowing inference backtracking. |
| 🔄 **Cyclic Loop Prevention** | Hardened visited-edge energy tracking aborts redundant traversals preventing explosive recursive combinations. |
| 📊 **Sigmoid Normalization** | Smoothly normalizes raw activation scores into structural scores ensuring semantic similarity base isn't overwhelmed by graph clustering. |
| 📡 **Observability Telemetry** | Full runtime telemetry (`SynapseRuntimeMetrics`) integrated into the observability pipeline and exposed via `/api/graph/metrics`. |

---
### ✅ v7.8.0 — Agentic Cognition Pipeline 🧠

> **Problem:** Compacting memory nodes blindly merged text, sacrificing structured reasoning and resulting in slow, un-indexed re-reads that couldn't construct causal relationships. Keyword engines were improperly gated by semantic thresholds, causing silent failures.
> **Solution:** A fundamental upgrade implementing Hebbian-style semantic consolidation into a dual-memory system. Explicit separation of Semantic Rules vs. Episodic Events, accompanied by deterministic ACT-R decay adjustments for structured roll-ups.

| Feature | Detail |
|---------|--------|
| 🧬 **Semantic Knowledge Consolidation** | `summarizeEntries` now strictly outputs JSON containing generalized `principles`, extracting implicit lessons across chunked sessions into explicit `semantic_knowledge` rules. |
| 🔗 **Causality Graph Edges** | Extracts JSON `causal_links` and natively persists `memory_links` mapping consequences and correlations (e.g. `caused_by`, `led_to`) between chunked memory nodes. |
| 🛡️ **Threshold Bug Patch** | Refactored MCP uncertainty rejection logic, isolating 0-1 fallback thresholds purely within vector-driven pathways (pgvector/sqlite-vec), keeping keyword (BM25) search operations safely ungated. |
| ⏳ **Fast Weight Decay Modifier** | Applied a `0.5` decay reduction penalty strictly to `is_rollup` instances within standard `PRISM_ACTR_DECAY` loops, ensuring structurally compacted "long-term" nodes outlive short-term chatter naturally. |
| 🔭 **LoCoMo Integration Harness** | Added `tests/benchmarks/locomo.ts`, utilizing a local `MockLLM` instance. Perfect for robust millisecond CI/CD validations verifying cross-temporal chunk connectivity on large Haystacks. |

---
### ✅ v7.7.0 — Cloud-Native SSE Transport 🌐

> **Problem:** Prism was previously bound to local runtime using stdio for MCP rendering, entirely barring multi-user accessibility or cloud deployments like Render.
> **Solution:** A seamless Server-Sent Events integration (`/sse`) running alongside the Mind Palace HTTP server, fully transforming it into a network-accessible cloud engine.

| Feature | Detail |
|---------|--------|
| ⚡ **SSE MCP Integration** | Spawns individual instances of `createServer()` resolving dedicated `sessionId` channels through a map to provide non-colliding HTTP streams across multiple clients simultaneously. |
| 🛡️ **Robust Access Auth Gate** | Strictly overrides unauthenticated MCP endpoints with `401 Unauthorized` responses in JSON, preventing crash-inducing HTML document injection and protecting the core database. |
| 📉 **Network Resilience** | Handles faulty TCP connections or stalled handshakes by wrapping `mcpServer.connect(transport)` with a clean try/catch cleanup process. |

---
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

## 📊 The State of Prism (v8.0.3)

With v8.0.3 shipped, Prism is a **production-hardened, fail-closed, adversarially-evaluated autonomous AI Operating System** — the first MCP server that runs your agents *without letting them touch the filesystem unsupervised*, *without letting them grade their own homework*, and *with real-time visibility into project health*:

- **Synapse Engine (GraphRAG)** — Pure, storage-agnostic multi-hop graph propagation with symmetric fan-dampening (forward + backward), asymmetric bidirectional flow, cyclic loop prevention, and sigmoid normalization. Nodes discovered via graph traversal tagged `[🌐 Synapse]`. Full SQLite + Supabase parity.
- **Cloud-Native RPC** — Server-Sent Events integration unlocks complete deployment portability across Smithery, Render, or any remote host over standard HTTP ports.
- **Health-Aware** — Intent Health Dashboard scores every project 0–100 across staleness, TODO load, and decision quality. Silent drift becomes an actionable signal before it becomes a crisis.
- **Comprehensively Sanitized** — 10 XSS injection vectors patched across all dashboard rendering paths (factory, ledger, health, history, error handlers). Every user-facing string now passes through `escapeHtml()`.
- **Anti-Sycophancy by Design** — The Adversarial Evaluation (PLAN_CONTRACT → EVALUATE) pipeline separates generator and evaluator into isolated roles with pre-committed rubrics. The evaluator cannot approve without evidence; the generator cannot skip the contract.
- **Fail-Closed by Default** — Dark Factory 3-gate pipeline (Parse → Type → Scope) means the LLM never writes a byte to disk directly. Every action validated before any side effect.
- **Conservatively Fail-Safe** — Parse failures default `plan_viable=false` — escalating to full PLAN re-planning instead of burning revision budget on broken LLM output.
- **Autonomously Verified** — Verification Harness generates spec-freeze contracts before execution, hash-locks them, and gates finalization against immutable outcomes.
- **Intelligently Routed** — Heuristic + ML Task Router delegates cloud vs. local in under 2ms, cold-start safe, experience-corrected per project.
- **Scientifically-Grounded** — ACT-R activation model (`B_i = ln(Σ t_j^{-d})`) ranks memories by recency × frequency. Synapse Engine propagates energy through causal graphs.
- **Cognitively-Routed** — HDC binary hypervectors + Hamming distance concept resolution + policy gateway. Three-outcome routing: `direct / clarify / fallback`.
- **Self-Organizing** — Edge Synthesis + Graph Pruning form an autonomous cognitive loop: the graph grows connective tissue overnight and prunes dead weight on schedule.
- **Observable** — SLO dashboard: synthesis success rate, net link growth, prune ratio, sweep latency, cognitive route distribution, pipeline gate pass/fail, Synapse telemetry.
- **Diagnostically Rich** — `verify status --json` emits `diff_counts` + `changed_keys` per layer. JSON contract is CI-enforced and schema-versioned.
- **Zero Cold-Start** — Universal Migration imports years of Claude/Gemini/ChatGPT history on day one. New memories are access-seeded immediately.
- **Air-Gapped Capable** — OllamaAdapter enables fully local, zero-cost embeddings via `nomic-embed-text` (768-dim native). No API key, no network, no cost. Auto-detected when `OLLAMA_HOST` is set.
- **Scale** — TurboQuant 10× compression + Deep Storage Purge + SQLite VACUUM. Decades of session history on a laptop.
- **Safe** — Full type-guard matrix across all 30+ MCP tools. Path traversal, poison pill payloads, null-byte injection — all blocked at the gate layer before any execution.
- **Convergent** — CRDT OR-Map handoff merging. Multiple agents, zero conflicts.
- **Autonomous** — Web Scholar researches while you sleep. Dark Factory executes while you sleep. Task Router delegates while you sleep. Adversarial Evaluator keeps the output honest.
- **Reliable** — 1052 passing tests across 48 suites. ES5 lint guard on all dashboard inline scripts. JSON contract CI enforcement on all CLI output schemas.
- **Multimodal** — VLM auto-captioning turns screenshots into semantically searchable memory.
- **Security** — SQL injection prevention, LIKE wildcard escaping, path traversal guard, tenant-scoped operations, Poison Pill defense, GDPR Art. 17+20 compliance.

---
## 🗺️ Next on the Horizon

### v8.x — Cognitive Refinement Track

#### v8.1 — Multi-Graph Causal Layer `[Next]`
- **Problem:** Synapse Engine currently traverses all edge types uniformly. "Why did X happen?" queries need intent-aware edge routing.
- **Solution:** Intent-aware retrieval routing (MAGMA) traversing LLM-inferred causal `because` edge-type layer on top of the existing Synapse propagation.
- **Scope:** New `edge_type` filter on `LinkFetcher`, query-time intent classifier, causal edge extraction during compaction.

#### v8.2 — Uncertainty-Aware Rejection `[Planned]`
- **Problem:** Agents hallucinate context when the retrieved memory trace is too weak.
- **Solution:** A meta-cognitive "Feeling of Knowing" (FOK) gate using spreading activation energy thresholds to safely reject queries with "insufficient evidence".
- **Scope:** `MIN_EVIDENCE_THRESHOLD` config, FOK score in Synapse telemetry, `CLARIFY` route integration with HDC policy gateway.

#### v8.3 — Episodic → Semantic Consolidation `[Planned]`
- **Problem:** Granular session ledgers accumulate and clutter context, failing to form abstractions over time.
- **Solution:** Guided by Complementary Learning Systems (CLS) theory, automatic abstraction of multi-session episodic logs into robust semantic concepts while decaying the originals.
- **Scope:** `consolidateEpisodicMemory()` scheduler task, semantic rule extraction, graduated importance scoring, ACT-R decay linkage.

---

### v9.0 — Autonomous Cognitive OS `[Architecture Phase]`

> **Thesis:** With v8.0 (Synapse Engine) shipped, Prism has solved **Retrieval** (GraphRAG + ACT-R) and **Execution Safety** (Dark Factory). The remaining bottleneck is no longer *how* memory is stored or retrieved, but **when and why the agent interacts with it.** v9.0 transitions Prism from a brilliant memory tool into the operating system that *drives* the agents.

#### 🔮 9.1 — Predictive Push Memory (Streaming Context) `[Design]`

> **From reactive polling to real-time memory HUD.**

**Problem:** Prism is currently **pull-based**. The agent must explicitly call `session_load_context` or `session_search_memory`. If the LLM's context window shifts and it forgets to search, it hallucinates.

**Solution:** **Push-based Predictive Memory** via MCP Subscribable Resources.

| Component | Detail |
|-----------|--------|
| **Subscribable Resource** | Expose `memory://project/telemetry/active_context` as an MCP resource. Clients subscribe; Prism pushes updates via `notifications/resources/updated`. |
| **Active File Watcher** | Lightweight background process extracts AST/keywords from the currently active file in the IDE (Cursor/Claude Desktop). |
| **Background Synapse Sweep** | Extracted keywords seed the Synapse Engine in the background, pre-computing graph-traversed context relevant to the current function. |
| **Context HUD** | The agent never has to *ask* for memory. The exact, graph-traversed context relevant to what they are currently staring at is just *there*, updating in real-time. |

**Implementation Notes:**
- MCP `resources/subscribe` + `notifications/resources/updated` is the transport mechanism
- Debounce AST extraction (500ms) to avoid thrashing on rapid file switches
- Cache Synapse results per file hash to avoid redundant propagation
- Budget: ~50ms latency target for the push cycle

---

#### 💰 9.2 — Memory-as-an-Economy (Token-Economic RL) `[Design]`

> **Force agents to learn compression through physics, not prompts.**

**Problem:** Agents have "infinite" memory budgets. They dump 500 words of logs via `session_save_ledger`. Even with auto-compaction, the system relies on the LLM being a "good citizen."

**Solution:** **Cognitive Budget** — a strict token economy with reinforcement feedback.

| Component | Detail |
|-----------|--------|
| **Token Budget** | Each agent session starts with a fixed cognitive budget (e.g., 2000 tokens). Every `session_save_ledger` call costs budget proportional to token count. |
| **Reward Signal** | When a saved memory is successfully retrieved and *actually helps* solve a task (measured by Dark Factory `EVALUATE` passes or positive experience events), the agent earns budget back. |
| **Entropy/Surprisal Gate** | On `session_save_ledger`, Prism calculates an information-theoretic surprisal score. Boilerplate ("I updated the CSS") is rejected or penalized. Novel, high-signal heuristics pass freely. |
| **Emergent Compression** | The system's physics force the LLM to naturally save highly dense, high-signal rules — because that's the only way to survive the budget. No prompt engineering required. |

**Implementation Notes:**
- `CognitiveBudget` class tracking balance per session, with configurable initial allocation
- Surprisal score via TF-IDF against the project's existing corpus (cheap, no LLM call)
- Budget earned back = `importance_score × retrieval_utility_score` when memories are accessed
- Budget exhaustion triggers a `WARNING` in the MCP response, not a hard block (graceful degradation)

---

#### 🎭 9.3 — Affect-Tagged Memory (Valence & Emotional Routing) `[Research]`

> **Give agents a "gut feeling" about bad code paths.**

**Problem:** Vector math measures *semantic similarity*, not *sentiment*. If an agent searches for "Authentication Architecture," the DB returns two approaches without knowing that Approach A caused a 3-day production outage while Approach B was smooth.

**Solution:** **Affective Cognitive Routing** — sentiment-tagged memory with valence-aware retrieval.

| Component | Detail |
|-----------|--------|
| **Valence Column** | Expand `session_ledger` and `semantic_knowledge` with a `valence` field (`-1.0` to `+1.0`). |
| **Automatic Tagging** | Failures, test breakages, and `correction` experience events → negative valence. Pipeline passes, `success` events → positive valence. Derived from existing experience event types — no new LLM calls. |
| **Valence Energy Propagation** | Synapse Engine propagates "Valence Energy" alongside activation energy. Negative valence accumulates through causal chains. |
| **HDC Policy Intercept** | When an agent proposes a direction strongly correlated with negative-valence memories, the HDC Policy Gateway forces a `CLARIFY` route: *"Warning: This architectural path is highly correlated with historical friction."* |

**Implementation Notes:**
- Valence derived deterministically from `event_type`: `success` → `+0.8`, `failure` → `-0.8`, `correction` → `-0.6`, `learning` → `+0.4`
- Synapse propagation: `valenceFlow = flow × sourceValence` (energy-weighted valence transfer)
- HDC integration: composite retrieval score includes `0.1 × avg_valence` as a third signal alongside similarity and activation
- Storage: single `REAL` column, nullable (legacy rows default to neutral `0.0`)

---

#### 🌿 9.4 — Counterfactual Memory Branches (Git for Cognition) `[Research]`

> **Monte Carlo Tree Search for AI agents — try 3 approaches, merge the winner, vaporize the rest.**

**Problem:** When Dark Factory runs an autonomous pipeline, it mutates the main memory trunk. A 2-hour rabbit hole of bad code poisons the context database. Time Travel (`memory_checkout`) can undo handoff, but *ledger entries* remain.

**Solution:** **Isolated Ephemeral Sandboxes** — branch, experiment, merge or discard.

| Component | Detail |
|-----------|--------|
| **Branch Creation** | When a Dark Factory sprint starts, Prism clones the current CRDT state into an ephemeral `branch_id`. |
| **Isolated Execution** | The agent writes logs, searches, and synthesizes edges *entirely within the branch*. Main memory is untouched. |
| **Merge on Success** | If the Adversarial Evaluator `PASS`es, the branch memory merges back into `main`. |
| **Discard on Failure** | If `ABORT`ed, the branch is destroyed. The memory of the "failed experiment" is rolled up into a single Semantic Rule ("Do not try X because Y"), and the noisy episodic logs are deleted. |
| **Parallel MCTS** | Spawn 3 Dark Factory pipelines simultaneously on 3 different approaches, each in isolated memory branches. The first to pass the test suite merges. The others are vaporized. |

**Implementation Notes:**
- `branch_id` column on `session_ledger` (nullable, `NULL` = main trunk)
- Branch creation: `INSERT INTO ... SELECT ... WHERE branch_id IS NULL` (snapshot copy)
- Merge: `UPDATE session_ledger SET branch_id = NULL WHERE branch_id = ?` (promote to main)
- Discard: `DELETE FROM session_ledger WHERE branch_id = ?` + single semantic rule insertion
- CRDT state cloned via `exportState()` → `importState()` with branch-scoped key
- Dark Factory integration: `pipeline.branch_id` links the pipeline to its memory sandbox

---

### v10.0 — The Convergence `[Vision]`

> Prism v8.0 is a perfect **System 1** (fast, associative, structural memory).
> v9.0 builds **System 2** (slow, deliberate, economic, and counterfactual reasoning).
> v10.0 is the convergence — where the agent *is* the operating system.

| Track | System 1 (v8.0) | System 2 (v9.0) | Convergence (v10.0) |
|-------|-----------------|-----------------|---------------------|
| **Retrieval** | GraphRAG + ACT-R | Predictive Push | Anticipatory pre-fetch |
| **Storage** | Flat ledger + compaction | Token-Economic RL | Self-curating memory |
| **Routing** | HDC + Hamming | Affective Valence | Emotion-aware cognition |
| **Execution** | Dark Factory (linear) | Counterfactual Branches | Parallel MCTS exploration |
| **Identity** | Reactive tool | Autonomous OS | Cognitive substrate |

---

### 📱 Mind Palace Mobile PWA `[Backlog]`
**Problem:** The dashboard is desktop-only. Quick check-ins on mobile require a laptop.
**Solution:** Progressive Web App with responsive glassmorphism layout, offline-first IndexedDB cache, and push notifications for agent activity.
**Phases:**
1. Responsive CSS breakpoints for the existing dashboard
2. Service worker + offline cache for read-only access
3. Push notifications via Web Push API for Telepathy events

---
## 🧰 Infrastructure Backlog

> 🤝 **Want to contribute?** These items are great entry points for new contributors. Most are self-contained and don't require deep knowledge of the cognitive pipeline. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for guidelines.

| Feature | Status | Notes |
|---------|--------|-------|
| ✅ **Ollama Local Embeddings** | **Shipped (v7.8.8)** | `OllamaAdapter` + `nomic-embed-text` (768-dim native). Auto-detected via `OLLAMA_HOST` env var. Zero-cost, air-gapped capable. |
| **Supabase `summarizeWeakLinks` N+1 Removal** | Backlog | Migration 036 ships the RPC; remove the sequential REST fallback once 036 is confirmed deployed across all tenants |
| Supabase RPC Soft-Delete Filtering | Backlog | Server-side GDPR filtering at the RPC layer |
| Prism CLI | Backlog | Standalone CLI for backup, export, and health check without MCP |
| Plugin System | Backlog | Third-party tool registration via MCP tool composition |
| **Supabase MemoryLinks** | Backlog | Implement `MemoryLinks` (graph-based traversal) in Supabase to achieve full structural parity with SQLite backend |
| **Safe Rollback Primitive (`session_rollback_state`)** | Backlog | Standardize rollback with snapshot/worktree restoration for autonomous loops; avoid destructive reset-first behavior and require explicit promotion policies |