# Prism MCP — Roadmap

> Full project board: GitHub Projects (internal tracking)

---

## 🏆 Shipped

Prism has evolved from a simple SQLite session logger into a **Quantized, Multimodal, Multi-Agent, Self-Learning, Observable AI Operating System**.

### ✅ v6.5.1 — Dashboard Project-Load Hotfix

| Fix | Detail |
|-----|--------|
| 🩹 **Project Selector Bootstrap** | Fixed a startup failure where unresolved Supabase env placeholders (`${SUPABASE_URL}` / `${SUPABASE_KEY}`) could break `/api/projects` and leave the selector stuck on "Loading projects...". |
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

### ✅ v5.5.0 — Architectural Hardening

| Feature | Detail |
|---------|--------|
| 🛡️ **Transactional Migrations** | SQLite DDL rebuilds wrapped in explicit `BEGIN/COMMIT` blocks. A crash mid-migration can no longer corrupt schema or lose handoff state. |
| 🛑 **Graceful Shutdown Registry** | `BackgroundTaskRegistry` uses 5-second `Promise.race()` to await all in-flight flushes (embeddings, SDM writes, OTel spans) before process exit. No more orphaned I/O. |
| 🕰️ **Thundering Herd Prevention** | Maintenance scheduler migrated from `setInterval` to state-aware recursive `setTimeout`. Expensive routines can never stack. |
| 🚀 **Zero-Thrashing SDM Scans** | `Int32Array` scratchpad allocations hoisted outside hot decode loop. Eliminates V8 GC pressure on large memory banks. |
| 🧪 **374 Tests** | Zero regressions across 17 test suites. |

---

### ✅ v5.4.0 — Concurrency, Automation & Autonomous Research

| Feature | Detail |
|---------|--------|
| 🔄 **CRDT Handoff Merging** | Custom OR-Map engine replaces strict OCC rejection. Add-Wins OR-Set for arrays (`open_todos`), Last-Writer-Wins for scalars. 3-way merge via `getHandoffAtVersion()`. `disable_merge` bypass for strict mode. |
| ⏰ **Background Purge Scheduler** | Unified `setInterval` loop (default: 12h) runs TTL sweep, importance decay, auto-compaction, and deep storage purge. Dashboard status card. `PRISM_SCHEDULER_ENABLED` / `PRISM_SCHEDULER_INTERVAL_MS`. |
| 🌐 **Autonomous Web Scholar** | Brave Search → Firecrawl scrape → LLM synthesis → Prism ledger injection. Task-aware topic selection biases toward active Hivemind agent tasks. Reentrancy guard, 15K content cap, configurable schedule. |
| 🐝 **Scholar ↔ Hivemind** | Scholar registers as `scholar` role, emits pipeline-stage heartbeats, broadcasts Telepathy alerts on completion. Zero overhead when Hivemind is off. |
| 📖 **Architecture Docs** | 3 new sections in `docs/ARCHITECTURE.md` with mermaid diagrams covering Hivemind, Scheduler, and Scholar. |

---

### ✅ v5.3.0 — Hivemind Health Watchdog

| Feature | Detail |
|---------|--------|
| 🐝 **Hivemind Health Watchdog** | State-machine lifecycle (initializing → idle → monitoring → alerting → recovering). Detects stuck agents, scheduling loops, and resource exhaustion. |
| 🔁 **Loop Detection** | Identifies repeating agent behavior patterns and injects corrective Telepathy alerts before runaway cycles waste resources. |
| 📡 **Telepathy Alert Injection** | Watchdog findings broadcast as Telepathy events — all agents see health warnings without polling. |

---

### ✅ v5.2.0 — Cognitive Memory & Universal Migration

| Feature | Detail |
|---------|--------|
| 🧠 **Ebbinghaus Importance Decay** | `effective_importance = base × 0.95^days` at retrieval time. Frequently accessed memories stay prominent; neglected ones fade naturally. |
| 🎯 **Context-Weighted Retrieval** | `context_boost` parameter on `session_search_memory` prepends project context to query before embedding — biases results toward current work. |
| 🔄 **Universal History Migration** | Strategy Pattern adapters for Claude Code (JSONL), Gemini (StreamArray), OpenAI (JSON). `p-limit(5)` concurrency, content-hash dedup, `--dry-run`. |
| 🧹 **Smart Consolidation** | Enhanced compaction prompts extract recurring principles alongside summaries. |
| 🛡️ **SQL Injection Prevention** | 17-column allowlist on `patchLedger()` blocks column-name injection. |

---

### ✅ v5.1.0 — Knowledge Graph Editor & Deep Storage

| Feature | Detail |
|---------|--------|
| 🗑️ **Deep Storage Mode** | `prism_purge_embeddings` reclaims ~90% of vector storage by purging float32 vectors for entries with TurboQuant blobs. |
| 🕸️ **Knowledge Graph Editor** | Graph filtering (project, date range, importance) and interactive node editor panel to surgically rename/delete keywords. |

---

### ✅ v5.0.0 — Quantized Agentic Memory

| Feature | Detail |
|---------|--------|
| 🧮 **TurboQuant Math Core** | Pure TypeScript port of Google's TurboQuant (ICLR 2026) — Lloyd-Max codebook, QR rotation, QJL error correction. Zero dependencies. |
| 📦 **~7× Embedding Compression** | 768-dim embeddings shrink from 3,072 bytes to ~400 bytes (4-bit) via variable bit-packing. |
| 🔍 **Asymmetric Similarity** | Unbiased inner product estimator: query as float32 vs compressed blobs. No decompression needed. |
| 🗄️ **Three-Tier Search** | FTS5 → sqlite-vec float32 → TurboQuant JS fallback. Search works even without native vector extension. |
| 🛠️ **Backfill Handler** | `session_backfill_embeddings` repairs AND compresses existing entries in a single atomic update. |

---

### ✅ v4.6.0 — OpenTelemetry Observability

| Feature | Detail |
|---------|--------|
| 🔭 **MCP Root Span** | `mcp.call_tool` wraps every tool invocation. Context propagated via AsyncLocalStorage — no ref-passing. |
| 🎨 **TracingLLMProvider** | Decorator at the factory boundary. Zero changes to vendor adapters (Gemini/OpenAI/Anthropic). Instruments text, embedding, and VLM generation. |
| ⚙️ **Worker Spans** | `worker.vlm_caption` in `imageCaptioner.ts` correctly parents fire-and-forget async tasks to the root MCP span. |
| 🔒 **Shutdown Flush** | `shutdownTelemetry()` is step-0 in `lifecycle.ts` — flushes `BatchSpanProcessor` before DBs close on SIGTERM/disconnect. |
| 🖥️ **Dashboard UI** | 🔭 Observability tab: enable toggle, OTLP endpoint, service name, inline Jaeger docker quick-start, ASCII waterfall diagram. |
| ✅ **GDPR-safe** | Span attributes: char counts + sizes only. Never prompt content, embeddings, or base64 image data. |

**Trace waterfall:**
```
mcp.call_tool  [session_save_image, ~50 ms]
  └─ worker.vlm_caption          [~2–5 s, outlives parent ✓]
       └─ llm.generate_image_description  [~1–4 s]
       └─ llm.generate_embedding          [~200 ms]
```

---

### ✅ v4.5.1 — GDPR Export & Test Hardening

| Feature | Detail |
|---------|--------|
| 📦 **`session_export_memory`** | ZIP export of all project memory (JSON + Markdown). Satisfies GDPR Art. 20 Right to Portability. API keys redacted, embeddings stripped. |
| 🧪 **270 Tests** | Concurrent export safety, API-key redaction edge cases (incl. `db_password` non-redaction regression), MCP contract under concurrent load. |

---

### ✅ v4.5.0 — VLM Multimodal Memory

| Feature | Detail |
|---------|--------|
| 👁️ **Auto-Captioning Pipeline** | `session_save_image` → VLM → handoff visual_memory → ledger entry → inline embedding. Fire-and-forget, never blocks MCP response. |
| 🔍 **Free Semantic Search** | Captions stored as standard ledger entries — `session_search_memory` finds images by meaning with zero schema changes. |
| 🛡️ **Provider Size Guards** | Anthropic 5MB hard cap. Gemini/OpenAI 20MB soft cap. Pre-flight check before API call. |
| 🔄 **OCC Retry on Handoff** | Read-modify-write with 2-attempt OCC retry loop to survive concurrent handoff saves. |

---

### ✅ v4.4.0 — Pluggable LLM Adapters (BYOM)

| Feature | Detail |
|---------|--------|
| 🔌 **Provider Adapters** | OpenAI, Anthropic Claude, Gemini, Ollama (local). Split provider: text and embedding independently configurable. |
| 🛡️ **Air-Gapped Mode** | Zero cloud API keys — full local execution via `http://127.0.0.1:11434`. |
| 🔀 **Cost-Optimized** | Claude 3.5 Sonnet + `nomic-embed-text` (free, local) = best-in-class reasoning + free embeddings. |

---

### ✅ v4.3.0 — The Bridge: Knowledge Sync Rules

Active Behavioral Memory meets IDE context. Graduated insights (importance ≥ 7) auto-sync into `.cursorrules` / `.clauderules` via `knowledge_sync_rules` — idempotent sentinel-based file writing.

---

### ✅ v4.2.0 — Project Repo Registry

Dashboard UI maps projects to repo directories. `session_save_ledger` validates `files_changed` paths and warns on mismatch. Dynamic tool descriptions replace `PRISM_AUTOLOAD_PROJECTS` env var — dashboard is sole source of truth.

---

### ✅ v4.1.0 — Auto-Migration & Multi-Instance

Zero-config Supabase schema upgrades via `prism_apply_ddl` RPC on startup. `PRISM_INSTANCE` env var for side-by-side server instances without PID lock conflicts.

---

### ✅ v4.0.0 — Behavioral Memory

`session_save_experience` with event types, confidence scores, and importance decay. Auto-injects correction warnings into `session_load_context`. Dynamic role resolution from dashboard.

---

### ✅ v3.x — Memory Lifecycle & Agent Hivemind

v3.1: Data retention (TTL), auto-compaction, PKM export, analytics sparklines.  
v3.0: Role-scoped memory, agent registration/heartbeat, Telepathy (real-time cross-agent sync).

---

## 📊 The State of Prism (v6.5.1)

With v6.5.0 shipped, Prism is a **production-hardened, self-organizing, cognitively-routed AI Operating System**:

- **Cognitively-Routed** — HDC state machine composes agent context into binary hypervectors and resolves semantic concepts via Hamming distance. Policy gateway routes with configurable thresholds.
- **Self-Organizing** — Edge Synthesis + Graph Pruning form an autonomous cognitive loop: the graph grows connective tissue overnight and prunes dead weight on schedule.
- **Cognitive** — Ebbinghaus decay + context-boosted retrieval + Intuitive Recall + Active Recall quizzes = memory that knows what matters *right now*.
- **Observable** — SLO dashboard tracks synthesis success rate, net link growth, prune ratio, sweep latency, and cognitive route distribution. Warning badges fire proactively.
- **Zero Cold-Start** — Universal Migration imports years of Claude/Gemini/ChatGPT history on day one.
- **Scale** — TurboQuant 10× compression + Deep Storage Purge + SQLite VACUUM. Decades of session history on a laptop.
- **Safe** — Full type-guard matrix across all 30+ MCP tools. LLM-hallucinated payloads are rejected at the boundary.
- **Convergent** — CRDT OR-Map handoff merging. Multiple agents, zero conflicts.
- **Autonomous** — Web Scholar researches while you sleep. Task-aware, Hivemind-integrated.
- **Hardened** — Transactional migrations, graceful shutdown, thundering herd prevention, prototype pollution guards, tenant-safe graph writes.
- **Quality** — Interactive Knowledge Graph Editor + Behavioral Memory that learns from mistakes.
- **Reliability** — 566 passing tests across 30 suites.
- **Observability** — OpenTelemetry span waterfalls + SLO metrics + cognitive route telemetry for every tool call, LLM hop, background worker, and graph sweep.
- **Multimodal** — VLM auto-captioning turns screenshots into semantically searchable memory.
- **Security** — SQL injection prevention, path traversal guard, GDPR Art. 17+20 compliance.

---

## 🗺️ Next on the Horizon

### 📱 Mind Palace Mobile PWA — Supporting Track

**Problem:** The dashboard is desktop-only. Quick check-ins on mobile require a laptop.

**Solution:** Progressive Web App with responsive glassmorphism layout, offline-first IndexedDB cache, and push notifications for agent activity.

**Phases:**
1. Responsive CSS breakpoints for the existing dashboard
2. Service worker + offline cache for read-only access
3. Push notifications via Web Push API for Telepathy events

### 🔭 Future Cognitive Tracks

#### v7.x — Affect-Tagged Memory
- **Problem:** Pure semantic relevance misses urgency and emotional salience in real-world agent collaboration.
- **Benefit:** Recall prioritization improves by weighting memories with affective/contextual valence, making surfaced context more behaviorally useful.
- **Dependency:** Builds on v6.5 compositional memory states so affect can be attached and retrieved as first-class signal.

#### v8+ — Zero-Search Retrieval
- **Problem:** Index/ANN retrieval layers add latency, complexity, and operational overhead at very large memory scales.
- **Benefit:** Direct vector-addressed recall (“just ask the vector”) reduces retrieval indirection and moves Prism toward truly native associative memory.
- **Dependency:** Requires stable SDM/HDC primitives and production-grade retrieval calibration from v6.5/v7.x.

---

## 🧰 Infrastructure Backlog

| Feature | Notes |
|---------|-------|
| **Supabase `summarizeWeakLinks` N+1 Removal** | Migration 036 ships the RPC; remove the sequential REST fallback once 036 is confirmed deployed across all tenants |
| Supabase RPC Soft-Delete Filtering | Server-side GDPR filtering at the RPC layer |
| Prism CLI | Standalone CLI for backup, export, and health check without MCP |
| Plugin System | Third-party tool registration via MCP tool composition |
| **Supabase MemoryLinks** | Implement `MemoryLinks` (graph-based traversal) in Supabase to achieve full structural parity with SQLite backend |
| **SDM Counter Soft Decay** | Evaluate implementing chronological "Soft Decay" for SDM counters if plasticity loss (catastrophic saturation) is observed in long-running agents |
