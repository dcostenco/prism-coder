# Prism Coder Architecture

> **v19.0.0** — Local-first cognitive memory engine for AI agents.
>
> Persistent sessions, semantic search, behavioral verification, PHI compliance,
> and an open-weight model fleet (2B–32B) for offline tool-routing.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [MCP Server](#2-mcp-server)
3. [Storage Engine](#3-storage-engine)
4. [Mind Palace Dashboard](#4-mind-palace-dashboard)
5. [LLM Provider Factory](#5-llm-provider-factory)
6. [Memory Lifecycle](#6-memory-lifecycle)
7. [MCP Tools Reference](#7-mcp-tools-reference)
8. [Background Services](#8-background-services)
9. [Security & Compliance](#9-security--compliance)
10. [Cognitive Systems](#10-cognitive-systems)
11. [Skill Architecture](#11-skill-architecture)
12. [CLI](#12-cli)
13. [Configuration Reference](#13-configuration-reference)
14. [Telemetry & Observability](#14-telemetry--observability)
15. [Universal History Import](#15-universal-history-import)
16. [Test Suite](#16-test-suite)

---

## 1. System Overview

Prism runs as an MCP server over stdio and exposes 40+ tools to any MCP client
(Claude Desktop, Claude Code, Cursor, Windsurf, etc.). Alongside the MCP server,
it launches a dashboard HTTP server and several background services.

```
┌──────────────────────────────────────────────────────────────────────┐
│                        MCP Client (Claude, Cursor, …)               │
│                           stdin / stdout (JSON-RPC)                  │
└────────────────────────────────┬─────────────────────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │      server.ts          │
                    │   MCP request router    │
                    │  (tools, prompts,       │
                    │   resources,            │
                    │   subscriptions)        │
                    └──┬──────┬──────┬──────┬─┘
                       │      │      │      │
          ┌────────────▼┐  ┌──▼───┐  │   ┌──▼──────────────┐
          │  40+ Tools  │  │ CLI  │  │   │  Dashboard HTTP  │
          │  (handlers) │  │      │  │   │  :3000 (default) │
          └──────┬──────┘  └──────┘  │   └────────┬────────┘
                 │                   │            │
          ┌──────▼───────────────────▼────────────▼───────┐
          │              Storage Abstraction               │
          │     getStorage() → SQLite / Supabase / Synalux │
          └───────────────────────────────────────────────┘
                                 │
           ┌─────────────────────┼─────────────────────┐
           │                     │                     │
     ┌─────▼─────┐     ┌────────▼──────┐    ┌────────▼────────┐
     │  SQLite    │     │   Supabase    │    │  Synalux Portal │
     │ (free /    │     │  (legacy      │    │ (paid tier,     │
     │  offline)  │     │   direct)     │    │  thin client)   │
     └───────────┘     └───────────────┘    └─────────────────┘
```

**Background services** launched at startup:

| Service | Cadence | Purpose |
|---------|---------|---------|
| Hivemind Watchdog | 60 s | Multi-agent health monitoring |
| Background Scheduler | 12 h | TTL sweep, compaction, deep purge |
| Web Scholar | Manual / configurable | Autonomous research pipeline |
| Dark Factory | On-demand | Autonomous pipeline execution |
| Dashboard | Always | HTTP UI + API on configurable port |

---

## 2. MCP Server

**Entry point:** `src/server.ts`

The server communicates over stdio using `StdioServerTransport` from `@modelcontextprotocol/sdk`.
It registers capabilities for tools, prompts, resources, and resource subscriptions.

### 2.1 Capabilities

| Capability | What it enables |
|------------|-----------------|
| Tools | 40+ callable tools (search, memory, verification, inference, …) |
| Prompts | `/resume_session` slash command in Claude Desktop |
| Resources | `memory://{project}/handoff` — attachable context via paperclip |
| Subscriptions | Live-refresh when handoff state changes |

### 2.2 Request Routing

`server.ts` handles:
- `CallToolRequest` → dispatches to the appropriate handler in `src/tools/`
- `ListToolsRequest` → returns all active tools (conditional on feature flags)
- `ListPrompts` / `GetPrompt` → resume-session prompt injection
- `ListResources` / `ReadResource` → project handoff state
- `Subscribe` / `Unsubscribe` → resource update notifications

### 2.3 Conditional Tool Registration

| Tool group | Count | Condition |
|-----------|-------|-----------|
| Search & analysis | 7 | Always |
| Session memory | 30+ | Always (works with all storage backends) |
| Hivemind agent registry | 3 | `PRISM_ENABLE_HIVEMIND=true` |
| Dark Factory pipeline | 3 | `PRISM_DARK_FACTORY_ENABLED=true` |
| Task router | 1 | `PRISM_TASK_ROUTER_ENABLED=true` |

**Key files:** `src/server.ts`, `src/tools/index.ts`, `src/tools/definitions.ts`

---

## 3. Storage Engine

Prism abstracts storage behind a `StorageBackend` interface (`src/storage/interface.ts`).
Three implementations exist, selected at startup via auto-resolution.

### 3.1 Backends

| Backend | File | Use case |
|---------|------|----------|
| **SQLite** | `src/storage/sqlite.ts` | Free tier, offline, HIPAA-safe. DB at `~/.prism-mcp/data.db` |
| **Supabase** | `src/storage/supabase.ts` | Legacy direct PostgreSQL via REST API |
| **Synalux** | `src/storage/synalux.ts` | Paid tier default. Thin HTTP client of synalux.ai portal |

### 3.2 Auto-Resolution

When `PRISM_STORAGE=auto` (default), the storage factory resolves in this order:

```
1. PRISM_FORCE_LOCAL=true          → SQLite (hard override)
2. Synalux credentials present     → Synalux portal
3. Supabase credentials present    → Supabase direct
4. else                            → SQLite
```

Credentials can come from environment variables OR from the dashboard config DB
(`prism-config.db`), so users can configure storage without touching env vars.

### 3.3 Config Storage

A separate `configStorage.ts` manages the `system_settings` table in a local SQLite DB
(`~/.prism-mcp/prism-config.db`). This stores dashboard settings, feature toggles,
API keys entered via the UI, and auto-load project lists. Settings are per-project
and accessible via `getSetting(key)` / `setSetting(key, value)`.

**Key files:** `src/storage/index.ts`, `src/storage/sqlite.ts`, `src/storage/supabase.ts`,
`src/storage/synalux.ts`, `src/storage/configStorage.ts`, `src/storage/interface.ts`

---

## 4. Mind Palace Dashboard

**Entry point:** `src/dashboard/server.ts`

A zero-dependency HTTP server (Node.js `http` module) serving a single-page dashboard UI.
Launches alongside the MCP server on a separate port.

### 4.1 Port Configuration

| Source | Value |
|--------|-------|
| Env var `PRISM_DASHBOARD_PORT` | Any valid port number |
| Default | `3000` |
| `.env.example` suggests | `3333` |

If the port is already in use (e.g., another Prism instance), the dashboard catches
`EADDRINUSE` and disables itself gracefully — the MCP server continues running.

### 4.2 Authentication

Three modes, configured via environment variables:

| Mode | Configuration | Notes |
|------|---------------|-------|
| **Disabled** (default) | No env vars set | Backward-compatible, suitable for localhost |
| **HTTP Basic Auth** | `PRISM_DASHBOARD_USER` + `PRISM_DASHBOARD_PASS` | Session cookie (24 h) after login. LAN/VPN only |
| **JWT / JWKS** | `PRISM_JWKS_URI` + optional `PRISM_JWT_AUDIENCE`, `PRISM_JWT_ISSUER` | Vendor-agnostic (Auth0, Cognito, Keycloak) |

Security details:
- Timing-safe credential comparison prevents timing attacks
- Rate-limited login endpoint (5 attempts per 60 seconds)
- Session tokens: random 64-char hex, in-memory (cleared on restart)
- JWKS audience + issuer enforced (defaults: `prism-mcp` / `https://synalux.ai`)

### 4.3 API Endpoints

| Path | Method | Purpose |
|------|--------|---------|
| `/` | GET | Dashboard HTML UI |
| `/api/projects` | GET | List all projects with handoff + intent data |
| `/api/project?name=X` | GET | Full project data (context, ledger, history, graph) |
| `/api/login` | POST | Session auth (rate-limited) |
| `/api/graph/*` | GET/POST | Knowledge graph CRUD (nodes, edges, cognitive route) |
| `/api/webhook/github` | POST | Knowledge ingestion webhook |
| `/api/settings` | GET/POST | Dashboard settings read/write |

### 4.4 Dashboard UI

The UI is a single HTML page rendered as a template literal from `src/dashboard/ui.ts`.
Dark glassmorphism theme with animated neural-network background. No build step,
no framework — pure CSS + vanilla JS.

**Sections:**

- **Project selector** — dropdown with auto-discovered projects
- **Session Ledger** — immutable session history with search and filter
- **Knowledge Graph** — force-directed `vis.js` graph of entities, keywords, categories
- **Node Editor** — click graph nodes to rename, delete, or inspect
- **Time Travel** — handoff version timeline with restore
- **Intent Health** — project goal tracking and completion
- **Hivemind Radar** — multi-agent health display (when enabled)
- **Background Scheduler** — maintenance status + Scholar run button
- **Settings** — AI providers, auto-load projects, feature toggles
- **Import** — universal history import (Claude, Gemini, OpenAI)

**Key files:** `src/dashboard/server.ts`, `src/dashboard/ui.ts`,
`src/dashboard/authUtils.ts`, `src/dashboard/graphRouter.ts`, `src/dashboard/intentHealth.ts`

---

## 5. LLM Provider Factory

**Entry point:** `src/utils/llm/factory.ts`

Prism uses a split-provider architecture: text generation and embeddings are routed
independently through a single `LLMProvider` interface.

### 5.1 Provider Matrix

| Setting | Options | Default |
|---------|---------|---------|
| `text_provider` | `gemini`, `openai`, `anthropic`, `none` | `gemini` |
| `embedding_provider` | `auto`, `gemini`, `openai`, `voyage`, `local` | `auto` |

When `embedding_provider=auto`:
- If text is `gemini` or `openai` → same provider for embeddings
- If text is `anthropic` → auto-fallback to `gemini` (Anthropic has no embedding API; `voyage` is the recommended pairing)

### 5.2 Adapters

| Adapter | File | Notes |
|---------|------|-------|
| `GeminiAdapter` | `adapters/gemini.ts` | Default text + embedding |
| `OpenAIAdapter` | `adapters/openai.ts` | GPT text + embeddings |
| `AnthropicAdapter` | `adapters/anthropic.ts` | Claude text only |
| `VoyageAdapter` | `adapters/voyage.ts` | Anthropic-recommended embeddings. 768-dim MRL |
| `LocalEmbeddingAdapter` | `adapters/local.ts` | `nomic-embed-text-v1.5` via `@huggingface/transformers` |
| `DisabledTextAdapter` | `adapters/disabledText.ts` | No-op stub for testing |
| `TracingLLMProvider` | `adapters/traced.ts` | OpenTelemetry tracing wrapper |

### 5.3 Local Model Fleet (Ollama)

For offline tool-routing via `prism_infer`:

| Tag | Base | Size | BFCL Accuracy | Tier gate |
|-----|------|------|---------------|-----------|
| `prism-coder:2b` | Qwen 3.5-4B Q3_K_M | 2.3 GB | 99.1% | Free (mobile) |
| `prism-coder:4b` | Qwen 3.5-4B Q4_K_M | 3.4 GB | 100% | Free |
| `prism-coder:14b` | — | 8.4 GB | 100% | Standard+ |
| `prism-coder:32b` | — | 16 GB | 100% | Advanced+ |

Prism auto-detects both namespaced (`dcostenco/prism-coder:14b`) and bare (`prism-coder:14b`)
Ollama tags.

### 5.4 Configuration Priority

1. Environment variables (`PRISM_TEXT_PROVIDER`, `PRISM_EMBEDDING_PROVIDER`)
2. Dashboard settings (`system_settings` table via `getSettingSync()`)
3. Hard defaults: `text=gemini`, `embedding=auto`

Provider is a process singleton — changes require MCP server restart.

**Key files:** `src/utils/llm/factory.ts`, `src/utils/llm/provider.ts`, `src/utils/llm/adapters/`

---

## 6. Memory Lifecycle

### 6.1 Ledgers vs. Handoffs

| Concept | Mutability | Purpose |
|---------|------------|---------|
| **Ledger** | Immutable append-only | Session audit trail — files changed, decisions, TODOs |
| **Handoff** | Mutable (latest-wins) | Live project state for the next session |

```
Agent Session ──save_ledger──▶ Ledger (immutable)
      │                            │
      │                    compaction (LLM summarization)
      │                            ▼
      │                     Archived / Compacted
      │
      ├──save_handoff──▶ Handoff (mutable) ──▶ Next Session
      │                      │
      │               auto-snapshot
      │                      ▼
      │               Time Travel History
```

### 6.2 Optimistic Concurrency Control

Multiple agents can update the same handoff. OCC prevents lost writes:
1. `session_load_context` returns an `expected_version` integer
2. `session_save_handoff` passes this version back
3. If another agent saved in between (version mismatch), the write is rejected
4. The agent re-reads, merges, and retries

### 6.3 Vector Storage — TurboQuant Compression

Embeddings use **TurboQuant** (Google ICLR 2026) for ~7× compression
(3 KB float32 → 400 bytes):

1. **Random QR Rotation + Lloyd-Max** — distributes coordinates for optimal scalar quantization
2. **QJL Residual Correction** — projects quantization error through a Gaussian matrix, stores sign bits

**Asymmetric search**: queries stay float32, targets stay compressed. QJL sign bits
correct for quantization error, achieving >95% retrieval accuracy at ~15% of the storage cost.

### 6.4 Search Fallback Chain

| Tier | Method | When used |
|------|--------|-----------|
| **Tier 1** | Native vector (`sqlite-vec` / `pgvector` DiskANN) | Hot data, O(log n) |
| **Tier 2** | JS TurboQuant asymmetric cosine | When native vectors are purged |
| **Tier 3** | FTS5 keyword search | When embeddings fail entirely |

### 6.5 Deep Storage Purge

| Age | State | Action |
|-----|-------|--------|
| < 7 days | Hot | Both float32 + TurboQuant retained |
| > 7 days | Cold | float32 purged (`embedding = NULL`), TurboQuant remains |

Reclaims ~90% of disk space. Guards against deleting entries that lack a compressed fallback.

### 6.6 Ebbinghaus Importance Decay

```
effective_importance = base_importance × 0.95^(days_since_last_access)
```

Computed at retrieval time — no cron jobs mutate the stored value. Memories that keep
surfacing in results stay important; neglected ones naturally fade.

**Key files:** `src/tools/ledgerHandlers.ts`, `src/tools/graphHandlers.ts`,
`src/storage/sqlite.ts`, `src/storage/supabase.ts`

---

## 7. MCP Tools Reference

### 7.1 Search & Analysis (always available)

| Tool | Purpose |
|------|---------|
| `brave_web_search` | Web search via Brave Search API |
| `brave_web_search_code_mode` | Web search + sandboxed JS post-processing |
| `brave_local_search` | Local business search |
| `brave_local_search_code_mode` | Local search + code-mode transform |
| `code_mode_transform` | Run sandboxed JS against any data payload |
| `brave_answers` | AI-grounded answers (separate API key) |
| `gemini_research_paper_analysis` | Academic paper analysis via Gemini |

### 7.2 Session Memory

| Group | Tools |
|-------|-------|
| **Core CRUD** | `session_save_ledger`, `session_save_handoff`, `session_load_context` |
| **Search** | `knowledge_search`, `session_search_memory`, `session_intuitive_recall`, `query_memory_natural` |
| **Knowledge management** | `knowledge_forget`, `knowledge_upvote`, `knowledge_downvote`, `knowledge_set_retention`, `knowledge_sync_rules`, `knowledge_ingest` |
| **Graph** | `session_synthesize_edges`, `extract_entities` |
| **Time travel** | `memory_history`, `memory_checkout` |
| **Cognitive** | `session_cognitive_route`, `session_task_route`, `session_detect_drift` |
| **Experiences** | `session_save_experience`, `session_save_image`, `session_view_image` |
| **Maintenance** | `session_compact_ledger`, `deep_storage_purge`, `maintenance_vacuum`, `session_health_check`, `session_backfill_embeddings`, `session_backfill_links` |
| **Admin** | `session_forget_memory`, `session_export_memory`, `backup_database`, `api_analytics`, `configure_notifications` |
| **Behavioral** | `verify_behavior` |
| **Onboarding** | `onboarding_wizard` |
| **Inference** | `prism_infer` |

### 7.3 Hivemind (`PRISM_ENABLE_HIVEMIND=true`)

| Tool | Purpose |
|------|---------|
| `agent_register` | Register agent identity and role |
| `agent_heartbeat` | Heartbeat with current task and status |
| `agent_list_team` | View all active teammates |

### 7.4 Dark Factory (`PRISM_DARK_FACTORY_ENABLED=true`)

| Tool | Purpose |
|------|---------|
| `SESSION_START_PIPELINE` | Launch autonomous pipeline |
| `SESSION_CHECK_PIPELINE_STATUS` | Check pipeline progress |
| `SESSION_ABORT_PIPELINE` | Cancel running pipeline |

---

## 8. Background Services

### 8.1 Hivemind Watchdog

**File:** `src/hivemindWatchdog.ts`

Health monitor for multi-agent setups. Runs on a 60 s loop (configurable).

| Status | Condition |
|--------|-----------|
| Active | Last heartbeat < `WATCHDOG_STALE_MIN` (default 5 min) |
| Stale | Last heartbeat > stale threshold |
| Frozen | Last heartbeat > `WATCHDOG_FROZEN_MIN` (default 15 min) |
| Looping | Same task repeated > `WATCHDOG_LOOP_THRESHOLD` (default 5) times |
| Offline | Last heartbeat > `WATCHDOG_OFFLINE_MIN` (default 30 min) — pruned |

**Telepathy** — when an anomaly is detected, `[🐝 SYSTEM ALERT]` messages are injected
into healthy agents' MCP responses via `drainAlerts()`, allowing them to take over
stalled tasks or escalate.

**Dashboard integration:** Hivemind Radar card shows role icons, health indicators,
live task display, and loop-count badges. Auto-refreshes every 15 s.

### 8.2 Background Scheduler

**File:** `src/backgroundScheduler.ts`

Automated maintenance on a configurable cadence (default 12 h). Tasks run sequentially,
each in its own try/catch:

1. **TTL Sweep** — hard-delete entries past retention policy
2. **Importance Decay** — Ebbinghaus curve on old behavioral entries
3. **Compaction** — LLM-powered summarization of old ledger entries
4. **Deep Purge** — NULL float32 embeddings where TurboQuant backup exists

Results are accumulated into a `SchedulerSweepResult` and served to the dashboard.

### 8.3 Web Scholar

**File:** `src/scholar/webScholar.ts`

Autonomous research pipeline:

```
Pick random topic → Brave Search → Firecrawl scrape
→ Trim to 15K chars → LLM synthesis → Save to ledger (importance: 7)
```

- Disabled by default (`PRISM_SCHOLAR_ENABLED=false`)
- Reentrancy-guarded (module-level lock)
- Gracefully disables if required API keys are missing
- Dashboard exposes a manual **🧠 Scholar (Run)** button

### 8.4 Dark Factory

**File:** `src/darkfactory/runner.ts`

Autonomous pipeline execution triggered by `SESSION_START_PIPELINE` tool call.
Gated behind `PRISM_DARK_FACTORY_ENABLED=true`.

---

## 9. Security & Compliance

### 9.1 PHI Guard (v17+)

Automatic Protected Health Information detection and redaction in the save pipeline.
Every `session_save_ledger` and `session_save_handoff` call passes through a
deterministic PHI scanner covering 18 HIPAA identifier categories.

- **Fail-closed**: detection errors block the save and log to stderr
- **Pre-LLM redaction**: `knowledge_ingest` redacts chunks before sending to cloud LLM
- **File path scrubbing**: paths containing client names are sanitized before portal POST

### 9.2 Dashboard Authentication

See [Section 4.2](#42-authentication). Supports disabled, Basic Auth, and JWT/JWKS modes.
JWKS audience + issuer enforcement prevents cross-service token confusion.

### 9.3 Request Limits

- Dashboard login: 5 attempts per 60 seconds
- Webhook + ingest endpoints: configurable request limits
- POST body: 10 MB max (`PRISM_MAX_REQUEST_BYTES`)

### 9.4 Local-First / HIPAA Mode

Set `PRISM_FORCE_LOCAL=true` to guarantee all memory operations stay on-device.
No network calls for storage, no cloud LLM for compaction. SQLite only.

### 9.5 Tier-Based Enforcement (v17+)

`prism_infer` gates model ceiling, max tokens, daily limits, and cloud fallback
by subscription plan:

| Plan | Model ceiling | Cloud fallback |
|------|---------------|----------------|
| Free | Up to 4B, local only | No |
| Standard | Up to 14B | No |
| Advanced | Up to 32B | Claude Sonnet fallback |

Flat-rate seat caps via `max_seats` per plan.

---

## 10. Cognitive Systems

### 10.1 HDC Cognitive Routing (v6.5+)

**Files:** `src/sdm/conceptDictionary.ts`, `src/sdm/stateMachine.ts`, `src/sdm/policyGateway.ts`

Hyperdimensional Computing for context-aware routing. Composes the agent's
state, role, and action into a 768-dim binary hypervector and resolves the nearest
semantic concept via Hamming distance.

| Route | Confidence | Action |
|-------|------------|--------|
| `direct` | High (above clarify threshold) | Proceed |
| `clarify` | Moderate | Request disambiguation |
| `fallback` | Low (below fallback threshold) | Default behavior |

Thresholds: `fallback=0.85`, `clarify=0.95` (overridable per-project).
Gated behind `PRISM_HDC_ENABLED` (default `false`).

### 10.2 HRR Drift Detection (v17+)

**File:** `src/tools/sessionDriftHandler.ts`

`session_detect_drift` uses Holographic Reduced Representations for temporal
trajectory encoding. Compares current session work against the stated goal.

| Score | Meaning | Action |
|-------|---------|--------|
| 0.0–0.3 | Healthy | Continue |
| 0.3–0.5 | Monitor | Consider compacting |
| 0.5–0.8 | Drifting | Compact recommended |
| 0.8–1.0 | Major drift | Compact immediately, reload context |

Three domains (BCBA / Coding / AAC) with domain-specific safety signals.

### 10.3 Behavioral Verification (v19+)

**File:** `src/tools/behavioralVerifierHandler.ts`

`verify_behavior` challenges the agent with a domain-specific scenario before
allowing edits to behavioral code. Thin client to the Synalux portal.

17 built-in domains: billing, auth, ordering, KDS, clinical, HR, and more.
Fail-closed when portal is unreachable.

### 10.4 ACT-R Activation (v7+)

Retrieval re-ranking based on the ACT-R cognitive architecture.
Composite similarity + activation model replaces simple Ebbinghaus decay.
Gated behind `PRISM_ACTR_ENABLED` (default `false`).

---

## 11. Skill Architecture (v15.1+)

Skills are `SKILL.md` documents injected into every `session_load_context` response.
They carry behavioral rules that shape agent behavior for the duration of the session.

### 11.1 Data Flow

```
Agent calls session_load_context()
           │
    ┌──────▼──────┐
    │  prism-mcp  │
    │  ledger     │
    │  handlers   │
    └──┬──────┬───┘
       │      │
  WHICH?    WHAT?
       │      │
  Synalux   Content source:
  portal     Synalux portal (paid)
  routing    → local SQLite fallback
  (all       → skip
   tiers)
       │      │
       └──────▼──────
         [📜 SKILL: name] blocks
         injected in response
```

### 11.2 Resolution Order

1. **Role skill** — if `role` param set (e.g. `"dev"`)
2. **Project skills** — from routing table (universal + project-specific)
3. **Context-triggered** — auto-loaded when skill name appears in recent context

### 11.3 Tier Behavior

| | Free tier | Paid tier |
|---|-----------|-----------|
| Routing (which skills) | Synalux portal | Same |
| Content (SKILL.md text) | Local SQLite (`sync-skills.sh`) | Synalux portal → local fallback |
| Offline | Yes | Yes (local fallback) |

### 11.4 Adding a Skill

1. Create `synalux-private/skills/<name>/SKILL.md`
2. Add to routing table in portal's `routing/route.ts`
3. Deploy portal — Prism picks up within 60 s (content cache TTL)
4. Free-tier / offline: run `bash scripts/sync-skills.sh`

---

## 12. CLI

**Entry point:** `src/cli.ts` — binary name: `prism`

The CLI provides access to Prism features outside MCP contexts (CI/CD, scripts, terminals).

### 12.1 Commands

| Command | Purpose |
|---------|---------|
| `prism load <project>` | Load session context (same output as `session_load_context` MCP tool) |
| `prism verify` | Show behavioral verification status |

### 12.2 `prism load` Options

| Flag | Default | Purpose |
|------|---------|---------|
| `-l, --level <level>` | `standard` | Context depth: `quick`, `standard`, `deep` |
| `-r, --role <role>` | — | Role scope for loading |
| `-s, --storage <backend>` | `auto` | Override storage: `local`, `supabase` |
| `--json` | — | Machine-readable JSON output |

The `--storage` flag prevents split-brain when CLI env differs from MCP server config.

### 12.3 Other Binaries

| Binary | Entry | Purpose |
|--------|-------|---------|
| `prism-coder` | `dist/server.js` | MCP server (alternative name) |
| `prism-mcp-server` | `dist/server.js` | MCP server (npm package name) |
| `prism-import` | `dist/utils/universalImporter.js` | Bulk history import |

---

## 13. Configuration Reference

### 13.1 Required Keys

| Variable | Purpose |
|----------|---------|
| `BRAVE_API_KEY` | Brave Search Pro — powers all search tools |

### 13.2 AI Providers (optional)

| Variable | Purpose |
|----------|---------|
| `GOOGLE_API_KEY` | Gemini LLM + embeddings + paper analysis |
| `VOYAGE_API_KEY` | Voyage AI embeddings (Anthropic-recommended) |
| `BRAVE_ANSWERS_API_KEY` | Brave Answers AI-grounded tool |
| `FIRECRAWL_API_KEY` | Web scraping for Scholar pipeline |
| `TAVILY_API_KEY` | Alternative search for Scholar (replaces Brave + Firecrawl) |

### 13.3 Storage

| Variable | Default | Purpose |
|----------|---------|---------|
| `PRISM_STORAGE` | `auto` | Backend: `auto`, `local`, `supabase`, `synalux` |
| `PRISM_FORCE_LOCAL` | `false` | Force SQLite (HIPAA mode) |
| `SUPABASE_URL` | — | Supabase project URL |
| `SUPABASE_KEY` | — | Supabase anon / service key |
| `PRISM_SYNALUX_BASE_URL` | — | Synalux portal API endpoint |
| `PRISM_SYNALUX_API_KEY` | — | Synalux portal auth key |
| `PRISM_USER_ID` | `default` | Multi-tenant scope ID |

### 13.4 Dashboard

| Variable | Default | Purpose |
|----------|---------|---------|
| `PRISM_DASHBOARD_PORT` | `3000` | HTTP server port |
| `PRISM_DASHBOARD_USER` | — | Basic auth username |
| `PRISM_DASHBOARD_PASS` | — | Basic auth password |
| `PRISM_JWKS_URI` | — | JWKS endpoint for JWT auth |
| `PRISM_JWT_AUDIENCE` | `prism-mcp` | JWT audience claim |
| `PRISM_JWT_ISSUER` | — | JWT issuer claim |
| `PRISM_SESSION_TTL_MS` | `86400000` | Session cookie lifetime (24 h) |
| `PRISM_MAX_REQUEST_BYTES` | `10485760` | Max POST body (10 MB) |

### 13.5 Background Services

| Variable | Default | Purpose |
|----------|---------|---------|
| `PRISM_SCHEDULER_ENABLED` | `true` | Enable maintenance scheduler |
| `PRISM_SCHEDULER_INTERVAL_MS` | `43200000` | Scheduler cadence (12 h) |
| `PRISM_SCHOLAR_ENABLED` | `false` | Enable Web Scholar pipeline |
| `PRISM_SCHOLAR_INTERVAL_MS` | `0` | Scholar cadence (0 = manual) |
| `PRISM_SCHOLAR_TOPICS` | `ai,agents` | Comma-separated research topics |
| `PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN` | `3` | Cost control |
| `PRISM_ENABLE_HIVEMIND` | `false` | Enable multi-agent tools |
| `PRISM_DARK_FACTORY_ENABLED` | `false` | Enable autonomous pipelines |

### 13.6 Hivemind Watchdog

| Variable | Default | Purpose |
|----------|---------|---------|
| `PRISM_WATCHDOG_INTERVAL_MS` | `60000` | Health check cadence (60 s) |
| `PRISM_WATCHDOG_STALE_MIN` | `5` | Minutes before stale |
| `PRISM_WATCHDOG_FROZEN_MIN` | `15` | Minutes before frozen |
| `PRISM_WATCHDOG_OFFLINE_MIN` | `30` | Minutes before pruned |
| `PRISM_WATCHDOG_LOOP_THRESHOLD` | `5` | Identical heartbeats before loop detection |

### 13.7 Cognitive Systems

| Variable | Default | Purpose |
|----------|---------|---------|
| `PRISM_HDC_ENABLED` | `false` | Enable HDC cognitive routing |
| `PRISM_HDC_EXPLAINABILITY_ENABLED` | `true` | Include explainability in HDC responses |
| `PRISM_HDC_POLICY_FALLBACK_THRESHOLD` | `0.85` | HDC fallback confidence |
| `PRISM_HDC_POLICY_CLARIFY_THRESHOLD` | `0.95` | HDC clarify confidence |
| `PRISM_ACTR_ENABLED` | `false` | Enable ACT-R activation re-ranking |
| `PRISM_TASK_ROUTER_ENABLED` | `false` | Enable local vs. cloud task routing |

### 13.8 Miscellaneous

| Variable | Default | Purpose |
|----------|---------|---------|
| `PRISM_DEBUG_LOGGING` | `false` | Verbose stderr output |
| `PRISM_AUTO_CAPTURE` | `false` | Auto-capture HTML snapshots on handoff save |
| `PRISM_CAPTURE_PORTS` | `3000,3001,5173,8080` | Ports to capture |
| `PRISM_LINK_DECAY_DAYS` | `30` | Graph link strength decay threshold |
| `PRISM_GRAPH_PRUNING_ENABLED` | `false` | Soft-prune weak graph links |
| `PRISM_GRAPH_PRUNE_MIN_STRENGTH` | `0.15` | Minimum link strength |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OpenTelemetry collector endpoint |
| `PRISM_LOCAL_LLM_MODEL` | — | Override Ollama model for `prism_infer` |

---

## 14. Telemetry & Observability

Prism implements OpenTelemetry (W3C) distributed tracing. When `OTEL_EXPORTER_OTLP_ENDPOINT`
is set, traces export to Jaeger, Zipkin, or Grafana Tempo.

**Context propagation**: background workers (VLM captioning, embedding generation)
attach to the parent `mcp.call_tool` span via `AsyncLocalStorage`, preserving trace
lineage across fire-and-forget promises.

**Graceful shutdown**: MCP stdio disconnection triggers `otel.shutdown()` to force-flush
the in-memory span queue before the process exits.

**Key files:** `src/observability/graphMetrics.ts`, `src/utils/llm/adapters/traced.ts`

---

## 15. Universal History Import

Prism can ingest years of session history from other AI tools:

| Source | Adapter | Notes |
|--------|---------|-------|
| Claude | `.jsonl` streaming logs | 30-min gap heuristic for conversation grouping |
| Gemini | JSON arrays | `stream-json` for OOM-safe processing of 100 MB+ exports |
| OpenAI | Chat completion history | Tool-call structure normalization |

**Deduplication**: SHA-256 hash of `(project + timestamp + content[:200])`.
**Concurrency**: `p-limit(5)` caps concurrent DB writes.

**Entry points:**
- CLI: `npx prism-mcp-server universal-import --format claude --path ./log.jsonl --project my-project`
- Dashboard: Import tab with file picker + dry-run toggle

**Key file:** `src/utils/universalImporter.ts`

---

## 16. Test Suite

2,676 tests across 89 files.

```bash
npm test                    # Full suite (vitest)
npm run test:watch          # Watch mode
npm run test:ci             # JUnit XML output for CI
npm run test:load           # Load tests only
npm run test:mcp            # Cross-MCP integration
```

---

*Prism Coder Architecture Guide — v19.0.0 — June 2026*
