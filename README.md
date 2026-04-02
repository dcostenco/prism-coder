# 🧠 Prism MCP — The Mind Palace for AI Agents

[![npm version](https://img.shields.io/npm/v/prism-mcp-server?color=cb0000&label=npm)](https://www.npmjs.com/package/prism-mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-00ADD8?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyTDIgN2wxMCA1IDEwLTUtMTAtNXpNMiAxN2wxMCA1IDEwLTV2LTJMMTI0djJMMiA5djh6Ii8+PC9zdmc+)](https://registry.modelcontextprotocol.io)
[![Glama](https://img.shields.io/badge/Glama-listed-FF5601)](https://glama.ai/mcp/servers/dcostenco/prism-mcp)
[![Smithery](https://img.shields.io/badge/Smithery-listed-6B4FBB)](https://smithery.ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**Your AI agent forgets everything between sessions. Prism fixes that.**

One command. Persistent memory. Local-first by default. Optional cloud power-ups.

```bash
npx -y prism-mcp-server
```

Works with **Claude Desktop · Claude Code · Cursor · Windsurf · Cline · Gemini · Antigravity** — any MCP client.

## 📖 Table of Contents

- [Why Prism?](#why-prism)
- [Quick Start](#-quick-start)
- [The Magic Moment](#-the-magic-moment)
- [Setup Guides](#-setup-guides)
- [Universal Import](#-universal-import-bring-your-history)
- [What Makes Prism Different](#-what-makes-prism-different)
- [Use Cases](#-use-cases)
- [What's New](#-whats-new)
- [How Prism Compares](#-how-prism-compares)
- [Tool Reference](#-tool-reference)
- [Environment Variables](#environment-variables)
- [Architecture](#architecture)
- [Scientific Foundation](#-scientific-foundation)
- [Product Roadmap](#-product-roadmap)
- [Troubleshooting FAQ](#-troubleshooting-faq)

---

## Why Prism?

Every time you start a new conversation with an AI coding assistant, it starts from scratch. You re-explain your architecture, re-describe your decisions, re-list your TODOs. Hours of context — gone.

**Prism gives your agent a brain that persists.** Save what matters at the end of each session. Load it back instantly on the next one. Your agent remembers what it did, what it learned, and what's left to do.

> 📌 **Terminology:** Throughout this doc, **"Prism"** refers to the MCP server and storage engine. **"Mind Palace"** refers to the visual dashboard UI at `localhost:3000` — your window into the agent's brain. They work together; the dashboard is optional.

**Starting in v7.0**, Prism doesn't just *store* memories — it **ranks them like a human brain.** The ACT-R activation model (from cognitive science) means memories that were accessed recently and frequently surface first, while stale context fades naturally. Combine that with candidate-scoped spreading activation and you get retrieval quality that no flat vector search can match.

---

## 🚀 Quick Start


Add to your MCP client config (`claude_desktop_config.json`, `.cursor/mcp.json`, etc.):

```json
{
  "mcpServers": {
    "prism-mcp": {
      "command": "npx",
      "args": ["-y", "prism-mcp-server"]
    }
  }
}
```

> **Note on Windows/Restricted Shells:** If your MCP client complains that `npx` is not found, use the absolute path to your node binary (e.g. `C:\Program Files\nodejs\npx.cmd`) or install globally with caution.

**That's it.** Restart your client. All tools are available. The **Mind Palace Dashboard** (the visual UI for your agent's brain) starts automatically at `http://localhost:3000`. You don't need to keep a tab open — the dashboard runs in the background and the MCP tools work with or without it.

<details>
<summary>Port 3000 already in use? (Next.js / Vite / etc.)</summary>

Add `PRISM_DASHBOARD_PORT` to your MCP config env block:

```json
{
  "mcpServers": {
    "prism-mcp": {
      "command": "npx",
      "args": ["-y", "prism-mcp-server"],
      "env": { "PRISM_DASHBOARD_PORT": "3001" }
    }
  }
}
```

Then open `http://localhost:3001` instead.
</details>


### Capability Matrix

| Feature | Local (Offline) | Cloud (API Key) |
|:--------|:---:|:---:|
| Session memory & handoffs | ✅ | ✅ |
| Keyword search (FTS5) | ✅ | ✅ |
| Time travel & versioning | ✅ | ✅ |
| Mind Palace Dashboard | ✅ | ✅ |
| GDPR export (JSON/Markdown/Vault) | ✅ | ✅ |
| Semantic vector search | ❌ | ✅ `GOOGLE_API_KEY` |
| Morning Briefings | ❌ | ✅ `GOOGLE_API_KEY` |
| Auto-compaction | ❌ | ✅ `GOOGLE_API_KEY` |
| Web Scholar research | ❌ | ✅ [`BRAVE_API_KEY`](#environment-variables) + [`FIRECRAWL_API_KEY`](#environment-variables) (or `TAVILY_API_KEY`) |
| VLM image captioning | ❌ | ✅ Provider key |

> 🔑 The core Mind Palace works **100% offline** with zero API keys. Cloud keys unlock intelligence features. See [Environment Variables](#environment-variables).

---

## ✨ The Magic Moment

> **Session 1** (Monday evening):
> ```
> You: "Analyze this auth architecture and plan the OAuth migration."
> Agent: *deep analysis, decisions, TODO list*
> Agent: session_save_ledger → session_save_handoff ✅
> ```
>
> **Session 2** (Tuesday morning — new conversation, new context window):
> ```
> Agent: session_load_context → "Welcome back! Yesterday we decided to use PKCE
>        flow with refresh tokens. 3 TODOs remain: migrate the user table,
>        update the middleware, and write integration tests."
> You: "Pick up where we left off."
> ```
>
> **Your agent remembers everything.** No re-uploading files. No re-explaining decisions.

---

## 📖 Setup Guides

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "prism-mcp": {
      "command": "npx",
      "args": ["-y", "prism-mcp-server"]
    }
  }
}
```

</details>

<details>
<summary><strong>Cursor</strong></summary>

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "prism-mcp": {
      "command": "npx",
      "args": ["-y", "prism-mcp-server"]
    }
  }
}
```

</details>

<details>
<summary><strong>Windsurf</strong></summary>

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "prism-mcp": {
      "command": "npx",
      "args": ["-y", "prism-mcp-server"]
    }
  }
}
```

</details>

<details>
<summary><strong>VS Code + Continue / Cline</strong></summary>

Add to your Continue `config.json` or Cline MCP settings:

```json
{
  "mcpServers": {
    "prism-mcp": {
      "command": "npx",
      "args": ["-y", "prism-mcp-server"],
      "env": {
        "PRISM_STORAGE": "local",
        "BRAVE_API_KEY": "your-brave-api-key"
      }
    }
  }
}
```

</details>


<details>
<summary><strong>Claude Code — Lifecycle Autoload (.clauderules)</strong></summary>

Claude Code naturally picks up MCP tools by adding them to your workspace `.clauderules`. Simply add:

```markdown
Always start the conversation by calling `mcp__prism-mcp__session_load_context(project='my-project', level='deep')`.
When wrapping up, always call `mcp__prism-mcp__session_save_ledger` and `mcp__prism-mcp__session_save_handoff`.
```

> **Format Note:** Claude automatically wraps MCP tools with double underscores (`mcp__prism-mcp__...`), while most other clients use single underscores (`mcp_prism-mcp_...`). Prism's backend natively handles both formats seamlessly.

</details>

<details id="antigravity-auto-load">
<summary><strong>Gemini / Antigravity — Prompt Auto-Load</strong></summary>

See the [Gemini Setup Guide](docs/SETUP_GEMINI.md) for the proven three-layer prompt architecture to ensure reliable session auto-loading.

</details>

<details>
<summary><strong>Supabase Cloud Sync</strong></summary>

To sync memory across machines or teams:

```json
{
  "mcpServers": {
    "prism-mcp": {
      "command": "npx",
      "args": ["-y", "prism-mcp-server"],
      "env": {
        "PRISM_STORAGE": "supabase",
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_KEY": "your-supabase-anon-or-service-key"
      }
    }
  }
}
```

#### Schema Migrations

Prism auto-applies its schema on first connect — no manual step required. If you need to apply or re-apply migrations manually (e.g. for a fresh project or after a version bump), run the SQL files in `supabase/migrations/` in numbered order via the **Supabase SQL Editor** or the CLI:

```bash
# Via CLI (requires supabase CLI + project linked)
supabase db push

# Or apply a single migration via the Supabase dashboard SQL Editor
# Paste the contents of supabase/migrations/0NN_*.sql and click Run
```

> **Key migrations:**
> - `020_*` — Core schema (ledger, handoff, FTS, TTL, CRDT)
> - `033_memory_links.sql` — Associative Memory Graph (MemoryLinks) — required for `session_backfill_links`

> **Anon key vs. service role key:** The anon key works for personal use (Supabase RLS policies apply). Use the service role key for team deployments where multiple users share the same Supabase project — it bypasses RLS and allows Prism to manage all rows regardless of auth context. Never expose the service role key client-side.

</details>

<details>
<summary><strong>Clone & Build (Full Control)</strong></summary>

```bash
git clone https://github.com/dcostenco/prism-mcp.git
cd prism-mcp && npm install && npm run build
```

Then add to your MCP config:

```json
{
  "mcpServers": {
    "prism-mcp": {
      "command": "node",
      "args": ["/path/to/prism-mcp/dist/server.js"],
      "env": {
        "BRAVE_API_KEY": "your-key",
        "GOOGLE_API_KEY": "your-gemini-key"
      }
    }
  }
}
```

</details>

### Common Installation Pitfalls

> **❌ Don't use `npm install -g`:**
> Hardcoding the binary path (e.g. `/opt/homebrew/Cellar/node/23.x/bin/prism-mcp-server`) is tied to a specific Node.js version — when Node updates, the path silently breaks.
>
> **✅ Always use `npx` instead:**
> ```json
> {
>   "mcpServers": {
>     "prism-mcp": {
>       "command": "npx",
>       "args": ["-y", "prism-mcp-server"]
>     }
>   }
> }
> ```
> `npx` resolves the correct binary automatically, always fetches the latest version, and works identically on macOS, Linux, and Windows. Already installed globally? Run `npm uninstall -g prism-mcp-server` first.

> **❓ Seeing warnings about missing API keys on startup?**
> That's expected and not an error. `BRAVE_API_KEY` / `GOOGLE_API_KEY` warnings are informational only — core session memory works with zero keys. See [Environment Variables](#environment-variables) for what each key unlocks.

---

## 📥 Universal Import — Bring Your History

Switching to Prism? Don't leave months of AI session history behind. Prism can **ingest historical sessions from Claude Code, Gemini, and OpenAI** and give your Mind Palace an instant head start — no manual re-entry required.

Import via the **CLI** or directly from the Mind Palace Dashboard (**Import** tab → file picker + dry-run toggle).

### Supported Formats
* **Claude Code** (`.jsonl` logs) — Automatically handles streaming chunk deduplication and `requestId` normalization.
* **Gemini** (JSON history arrays) — Supports large-file streaming for 100MB+ exports.
* **OpenAI** (JSON chat completion history) — Normalizes disparate tool-call structures into the unified Ledger schema.

### How to Import

**Option 1 — CLI:**

```bash
# Ingest Claude Code history
npx -y prism-mcp-server universal-import --format claude --path ~/path/to/claude_log.jsonl --project my-project

# Dry run (verify mapping without saving)
npx -y prism-mcp-server universal-import --format gemini --path ./gemini_history.json --dry-run
```

**Option 2 — Dashboard:** Open `localhost:3000`, navigate to the **Import** tab, select the format and file, and click Import. Supports dry-run preview.

### Why It's Safe to Re-Run
* **OOM-Safe Streaming:** Processes massive log files line-by-line using `stream-json`.
* **Idempotent Dedup:** Content-hash prevents duplicate imports on re-run (`skipCount` reported).
* **Chronological Integrity:** Uses timestamp fallbacks and `requestId` sorting to preserve your memory timeline.
* **Smart Context Mapping:** Extracts `cwd`, `gitBranch`, and tool usage patterns into searchable metadata.

---

## ✨ What Makes Prism Different


### 🧠 Your Agent Learns From Mistakes
When you correct your agent, Prism tracks it. Corrections accumulate **importance** over time. High-importance lessons auto-surface as warnings in future sessions — and can even sync to your `.cursorrules` file for permanent enforcement. Your agent literally gets smarter the more you use it.

### 🕰️ Time Travel
Every save creates a versioned snapshot. Made a mistake? `memory_checkout` reverts your agent's memory to any previous state — like `git revert` for your agent's brain. Full version history with optimistic concurrency control.

### 🔮 Mind Palace Dashboard
A gorgeous glassmorphism UI at `localhost:3000` that lets you see exactly what your agent is thinking:

- **Current State & TODOs** — the exact context injected into the LLM's prompt
- **Interactive Knowledge Graph** — force-directed neural graph with click-to-filter, node renaming, and surgical keyword deletion
- **Deep Storage Manager** — preview and execute vector purge operations with dry-run safety
- **Session Ledger** — full audit trail of every decision your agent has made
- **Time Travel Timeline** — browse and revert any historical handoff version
- **Visual Memory Vault** — browse VLM-captioned screenshots and auto-captured HTML states
- **Hivemind Radar** — real-time active agent roster with role, task, and heartbeat
- **Morning Briefing** — AI-synthesized action plan after 4+ hours away
- **Brain Health** — memory integrity scan with one-click auto-repair

![Mind Palace Dashboard](docs/mind-palace-dashboard.png)

### 🧬 10× Memory Compression
Powered by a pure TypeScript port of Google's TurboQuant (inspired by Google's ICLR research), Prism compresses 768-dim embeddings from **3,072 bytes → ~400 bytes** — enabling decades of session history on a standard laptop. No native modules. No vector database required.

### 🐝 Multi-Agent Hivemind
Multiple agents (dev, QA, PM) can work on the same project with **role-isolated memory**. Agents discover each other automatically, share context in real-time via Telepathy sync, and see a team roster during context loading. → [Multi-agent setup example](examples/multi-agent-hivemind/)

### 🖼️ Visual Memory
Save UI screenshots, architecture diagrams, and bug states to a searchable vault. Images are auto-captioned by a VLM (Claude Vision / GPT-4V / Gemini) and become semantically searchable across sessions.

### 🔭 Full Observability
OpenTelemetry spans for every MCP tool call, LLM hop, and background worker. Route to Jaeger, Grafana, or any OTLP collector. Configure in the dashboard — zero code changes.

### 🌐 Autonomous Web Scholar
Prism researches while you sleep. A background pipeline searches the web, scrapes articles, synthesizes findings via LLM, and injects results directly into your semantic memory — fully searchable on your next session. Brave Search → Firecrawl scrape → LLM synthesis → Prism ledger. Task-aware, Hivemind-integrated, and zero-config when API keys are missing (falls back to Yahoo + Readability).

### 🔒 GDPR Compliant
Soft/hard delete (Art. 17), full export in JSON, Markdown, or Obsidian vault `.zip` (Art. 20), API key redaction, per-project TTL retention, and audit trail. Enterprise-ready out of the box.

---

## 🎯 Use Cases

**Long-running feature work** — Save state at end of day, restore full context next morning. No re-explaining.

**Multi-agent collaboration** — Dev, QA, and PM agents share real-time context without stepping on each other's memory.

**Consulting / multi-project** — Switch between client projects with progressive loading: `quick` (~50 tokens), `standard` (~200), or `deep` (~1000+).

**Visual debugging** — Save UI screenshots to searchable memory. Find that CSS bug from last week by description.

**Team onboarding** — New team member's agent loads the full project history instantly.

**Behavior enforcement** — Agent corrections auto-graduate into permanent `.cursorrules` / `.clauderules` rules.

**Offline / air-gapped** — Full SQLite local mode + Ollama LLM adapter. Zero internet dependency.

**Morning Briefings** — After 4+ hours away, Prism auto-synthesizes a 3-bullet action plan from your last sessions.

### Claude Code: Parallel Explore Agent Workflows

When you need to quickly map a large auth system, launch multiple `Explore` subagents in parallel and merge their findings:

```text
Run 3 Explore agents in parallel.
1) Map auth architecture
2) List auth API endpoints
3) Find auth test coverage gaps
Research only, no code changes.
Return a merged summary.
```

Then continue a specific thread with a follow-up message to the selected agent, such as deeper refresh-token edge-case analysis.

---

## 🆕 What's New

### v7.1.0 — Prism Task Router (Heuristic + ML Experience) ✅
> **Current stable release.** Multi-agent task routing with dynamic local vs host model delegation.

- 🚦 **Heuristic Routing Engine** — Deterministic `session_task_route` tool dynamically routes tasks to either the host cloud model or local agent (Claw) based on task description, file count, and scope. Evaluated over 5 core signals.
- 🤖 **Experience-Based ML Routing** — Cold-start protected ML layer leverages the historical performance (Win Rate) extracted by the `routerExperience` system to apply dynamic confidence boosts or penalties into the routing score.
- 🧪 **Live Testing Samples** — Demo script added in [`examples/router_real_life_test.ts`](examples/router_real_life_test.ts) for deterministic `computeRoute()` scenarios (simple vs complex tasks), with a note that experience-adjusted routing is applied in `session_task_route` handler path.
- 🖥️ **Dashboard Integration** — Added visual monitor and configuration toggles directly in `src/dashboard/ui.ts` under Node Editor settings.
- 🧩 **Tool Discoverability** — Fully integrates `session_task_route` into the external registry.

### v7.0.0 — ACT-R Activation Memory ✅
> **Previous stable release.** Memory retrieval now uses a scientifically-grounded cognitive model.

- 🧠 **ACT-R Base-Level Activation** — `B_i = ln(Σ t_j^(-d))` computes recency × frequency activation per memory. Recent, frequently-accessed memories surface first; cold memories fade to near-zero. Based on Anderson's *Adaptive Control of Thought—Rational* (ACM, 2025).
- 🔗 **Candidate-Scoped Spreading Activation** — `S_i = Σ(W × strength)` for links within the current search result set only. Prevents "God node" centrality from dominating rankings (Rule #5).
- 📐 **Parameterized Sigmoid Normalization** — Calibrated `σ(x) = 1/(1 + e^(-k(x - x₀)))` with midpoint at -2.0 maps the natural ACT-R activation range (-10 to +5) into discriminating (0, 1) scores.
- 🏗️ **Composite Retrieval Scoring** — `Score = 0.7 × similarity + 0.3 × σ(activation)` — similarity dominates, activation re-ranks. Fully configurable weights via `PRISM_ACTR_WEIGHT_*` env vars.
- ⚡ **AccessLogBuffer** — In-memory write buffer with 5-second batch flush prevents SQLite `SQLITE_BUSY` contention under parallel agent tool calls. Deduplicates within flush windows.
- 🗂️ **Access Log Infrastructure** — New `memory_access_log` table with `logAccess()`, `getAccessLog()`, `pruneAccessLog()` across both SQLite and Supabase backends. Creation seeds initial access (zero cold-start penalty).
- 🧹 **Background Access Log Pruning** — Scheduler automatically prunes access logs exceeding retention window (default: 90 days). Configurable via `PRISM_ACTR_ACCESS_LOG_RETENTION_DAYS`.
- 🧪 **49-Test ACT-R Suite** — Pure-function unit tests covering base-level activation, spreading activation, sigmoid normalization, composite scoring, AccessLogBuffer lifecycle, deduplication, chunking, and edge cases.
- 📊 **705 Tests** — 32 suites, all passing, zero regressions.

<details>
<summary><strong>🔬 Live Example: v6.5 vs v7.0 Retrieval Behavior</strong></summary>

Consider an agent searching for "OAuth migration" with 3 memories in the result set:

| Memory | Cosine Similarity | Last Accessed | Access Count (30d) |
|--------|:-:|:-:|:-:|
| A: "PKCE flow decision" | 0.82 | 2 hours ago | 12× |
| B: "OAuth library comparison" | 0.85 | 14 days ago | 2× |
| C: "Auth middleware refactor" | 0.81 | 30 minutes ago | 8× |

**v6.5 (pure similarity):** B > A > C — the stale library comparison wins because it has the highest cosine score, even though the agent hasn't looked at it in two weeks.

**v7.0 (ACT-R re-ranking):**

| Memory | Similarity (0.7×) | ACT-R σ(B+S) (0.3×) | **Composite** |
|--------|:-:|:-:|:-:|
| A | 0.574 | 0.3 × 0.94 = 0.282 | **0.856** |
| C | 0.567 | 0.3 × 0.91 = 0.273 | **0.840** |
| B | 0.595 | 0.3 × 0.12 = 0.036 | **0.631** |

**Result:** The actively-used PKCE decision (A) and the just-touched middleware (C) surface above the stale comparison (B). The agent gets the context it's *actually working with*, not just the closest embedding.

</details>

### v6.5.3 — Auth Hardening ✅
- 🔒 **Rate Limiting** — Login endpoint (`POST /api/auth/login`) protected by sliding-window rate limiter (5 attempts per 60s per IP). Resets on success.
- 🔒 **CORS Hardening** — Dynamic `Origin` echo with `Allow-Credentials` when auth enabled (replaces wildcard `*`).
- 🚪 **Logout Endpoint** — `POST /api/auth/logout` invalidates session server-side and clears client cookie.
- 🧪 **42-Test Auth Suite** — Unit + HTTP integration tests covering `safeCompare`, `generateToken`, `isAuthenticated`, `createRateLimiter`, login/logout lifecycle, rate limiting, and CORS.
- 🏗️ **Auth Module Extraction** — Decoupled auth logic from `server.ts` closures into testable `authUtils.ts`.

### v6.5.2 — SDM/HDC Test Hardening ✅
- 🧪 **37 New Edge-Case Tests** — Hardened the cognitive routing pipeline (HDC engine, PolicyGateway, StateMachine, SDM engine) with boundary condition tests. 571 → 608 total tests.

### v6.5.1 — Dashboard Project-Load Hotfix ✅
- 🩹 **Project Selector Recovery** — Fixed a startup path where the dashboard selector could stay stuck on "Loading projects..." when Supabase env vars were unresolved placeholders.
- 🔄 **Safe Backend Fallback** — If Supabase is requested but env is invalid/unresolved, Prism now auto-falls back to local SQLite so `/api/projects` and dashboard boot remain operational.

### v6.5 — HDC Cognitive Routing ✅

- 🧠 **Hyperdimensional Cognitive Routing** — New `session_cognitive_route` tool composes the agent's current state, role, and action into a single 768-dim binary hypervector via XOR binding, then resolves it to a semantic concept via Hamming distance. Three-outcome policy gateway: `direct` / `clarify` / `fallback`.
- 🎛️ **Per-Project Threshold Overrides** — Fallback and clarify thresholds are configurable per-project and persisted via the existing `getSetting`/`setSetting` contract (no new migrations).
- 🔬 **Explainability Mode** — When `explain: true`, responses include convergence steps, raw Hamming distance, and ambiguity flags for full auditability.
- 📊 **Cognitive Observability** — `graphMetrics.ts` tracks route distribution (direct/clarify/fallback), rolling confidence/distance averages, ambiguity rates, and null-concept counts. Warning heuristics for fallback > 30% and ambiguity > 40%.
- 🖥️ **Dashboard Integration** — Cognitive metrics card with route distribution bar, confidence gauges, and warning badges. On-demand "Cognitive Route" button in the Node Editor panel.
- 🔒 **Feature Gating** — Entire pipeline gated behind `PRISM_HDC_ENABLED` (default: `true`). Clean error + zero telemetry when disabled.

<details>
<summary><strong>v6.2 — The "Synthesize & Prune" Phase</strong></summary>

- 🕸️ **Edge Synthesis ("The Dream Procedure")** — Automated background linker discovers semantically similar but disconnected memory nodes via cosine similarity (≥ 0.7 threshold). Batch-limited to 50 sources × 3 neighbors. New `session_synthesize_edges` tool for on-demand graph enrichment.
- ✂️ **Graph Pruning (Soft-Prune)** — Configurable strength-based pruning soft-deletes weak links. Includes per-project cooldown, backpressure guards, and sweep budget controls. Enable with `PRISM_GRAPH_PRUNING_ENABLED=true`.
- 📊 **SLO Observability** — New `graphMetrics.ts` module tracks synthesis success rate, net new links, prune ratio, and sweep duration. Exposes `slo` and `warnings` fields at `GET /api/graph/metrics` for proactive health monitoring.
- 🗓️ **Temporal Decay Heatmaps** — UI overlay toggle where un-accessed nodes desaturate while Graduated nodes stay vibrant. Makes the Ebbinghaus curve visceral.
- 📝 **Active Recall ("Test Me")** — Node editor panel generates synthetic quizzes from semantic neighbors for knowledge activation.
- ⚡ **Supabase Weak-Link RPC (WS4.1)** — New `prism_summarize_weak_links` Postgres function (migration 036) aggregates pruning server-side, eliminating N+1 network roundtrips.
- 🔒 **Migration 035** — Tenant-safe graph writes + soft-delete hardening for MemoryLinks.

</details>

<details>
<summary><strong>v6.1 — Prism-Port, Cognitive Load & Semantic Search</strong></summary>

- 📦 **Prism-Port Vault Export** — `.zip` of interlinked Markdown files with YAML frontmatter, `[[Wikilinks]]`, and `Keywords/` backlink indices for Obsidian/Logseq.
- 🧠 **Smart Memory Merge UI** — Merge duplicate knowledge nodes from the Graph Editor.
- ✨ **Semantic Search Highlighting** — RegEx-powered match engine wraps exact keyword matches in `<mark>` tags.
- 📊 **Deep Purge Visualization** — "Memory Density" analytic for signal-to-noise ratio.
- 🛡️ **Context-Boosted Search** — Biases semantic queries by current project workspace.
- 🌐 **Tavily Web Scholar** — `@tavily/core` as alternative to Brave+Firecrawl.
- 🛡️ **Type Guard Hardening** — Full audit of all 11+ MCP tool argument guards.
- 🔄 **Dashboard Toggle Persistence** — Optimistic rollback on save failure.

</details>

<details>
<summary><strong>Earlier releases (v5.x and below)</strong></summary>

#### v5.5 — Architectural Hardening
- 🛡️ **Transactional Migrations** — SQLite DDL rebuilds are wrapped in explicit `BEGIN/COMMIT` blocks.
- 🛑 **Graceful Shutdown Registry** — `BackgroundTaskRegistry` uses a 5-second `Promise.race()` to await flushes.
- 🕰️ **Thundering Herd Prevention** — Maintenance scheduler migrated from `setInterval` to state-aware `setTimeout`.
- 🚀 **Zero-Thrashing SDM Scans** — `Int32Array` scratchpad allocations hoisted outside the hot decode loop.

#### v5.4 — Convergent Intelligence
- 🔄 **CRDT Handoff Merging** — Multi-agent saves no longer reject on version conflict. Custom OR-Map engine auto-merges concurrent edits.
- ⏰ **Background Purge Scheduler** — Fully automated storage maintenance TTL sweep, Ebbinghaus decay, auto-compaction.
- 🌐 **Autonomous Web Scholar** — Agent-driven research pipeline. Brave Search → Firecrawl scrape → LLM synthesis.
- **v5.3** — Hivemind Health Watchdog (state machine, loop detection, Telepathy alert injection)
- **v5.2** — Cognitive Memory (Ebbinghaus decay, context-weighted retrieval), Universal History Migration, Smart Consolidation
- **v5.1** — Knowledge Graph Editor, Deep Storage purge
- **v5.0** — TurboQuant 10× embedding compression, three-tier search architecture
- **v4.x** — OpenTelemetry, VLM multimodal memory, LLM adapters, Behavioral memory, Hivemind

</details>

> [Full CHANGELOG →](CHANGELOG.md) · [Architecture Deep Dive →](docs/ARCHITECTURE.md)

---

## ⚔️ How Prism Compares

Standard memory servers (like Mem0, Zep, or the baseline Anthropic MCP) act as passive filing cabinets — they wait for the LLM to search them. **Prism is an active cognitive architecture.** Designed specifically for the **Model Context Protocol (MCP)**, Prism doesn't just store vectors; it manages the LLM's context window autonomously.

### 📊 Feature-by-Feature Comparison

| Feature / Architecture | 🧠 Prism MCP | 🐘 Mem0 | ⚡ Zep | 🧪 Anthropic Base MCP |
| :--- | :--- | :--- | :--- | :--- |
| **Primary Interface** | **Native MCP** (Tools, Prompts, Resources) | REST API & Python/TS SDKs | REST API & Python/TS SDKs | Native MCP (Tools only) |
| **Storage Engine** | **BYO SQLite or Supabase** | Managed Cloud / VectorDBs | Managed Cloud / Postgres | Local SQLite only |
| **Context Assembly** | **Progressive (Quick/Std/Deep)** | Top-K Semantic Search | Top-K + Temporal Summaries | Basic Entity Search |
| **Memory Mechanics** | **ACT-R Activation (recency×freq), SDM, HDC** | Basic Vector + Entity | Fading Temporal Graph | None (Infinite growth) |
| **Multi-Agent Sync** | **CRDT (Add-Wins / LWW)** | Cloud locks | Postgres locks | ❌ None (Data races) |
| **Data Compression** | **TurboQuant (7x smaller vectors)** | ❌ Standard F32 Vectors | ❌ Standard Vectors | ❌ No Vectors |
| **Observability** | **OTel Traces + Built-in PWA UI** | Cloud Dashboard | Cloud Dashboard | ❌ None |
| **Maintenance** | **Autonomous Background Scheduler** | Manual/API driven | Automated (Cloud) | ❌ Manual |
| **Data Portability** | **Prism-Port (Obsidian/Logseq Vault)** | JSON Export | JSON Export | Raw `.db` file |
| **Cost Model** | **Free + BYOM (Ollama)** | Per-API-call pricing | Per-API-call pricing | Free (limited) |

### 🏆 Where Prism Crushes the Giants

#### 1. MCP-Native, Not an Adapted API
Mem0 and Zep are APIs that *can* be wrapped into an MCP server. Prism was built *for* MCP from day one. Instead of wasting tokens on "search" tool calls, Prism uses **MCP Prompts** (`/resume_session`) to inject context *before* the LLM thinks, and **MCP Resources** (`memory://project/handoff`) to attach live, subscribing context.

#### 2. Academic-Grade Cognitive Computer Science
The giants use standard RAG (Retrieval-Augmented Generation). Prism uses biological and academic models of memory: **ACT-R base-level activation** (`B_i = ln(Σ t_j^(-d))`) for recency–frequency re-ranking, **TurboQuant** for extreme vector compression, **Ebbinghaus curves** for importance decay, and **Sparse Distributed Memory (SDM)**. The result is retrieval quality that follows how human memory actually works — not just nearest-neighbor cosine distance. And all of it runs on a laptop without a Postgres/pgvector instance.

#### 3. True Multi-Agent Coordination (CRDTs)
If Cursor (Agent A) and Claude Desktop (Agent B) try to update a Mem0 or standard SQLite database at the exact same time, you get a race condition and data loss. Prism uses **Optimistic Concurrency Control (OCC) with CRDT OR-Maps** — mathematically guaranteeing that simultaneous agent edits merge safely. Enterprise-grade distributed systems on a local machine.

#### 4. The PKM "Prism-Port" Export
AI memory is a black box. Developers hate black boxes. Prism exports memory directly into an **Obsidian/Logseq-compatible Markdown Vault** with YAML frontmatter and `[[Wikilinks]]`. Neither Mem0 nor Zep do this.

#### 5. Self-Cleaning & Self-Optimizing
If you use a standard memory tool long enough, it clogs the LLM's context window with thousands of obsolete tokens. Prism runs an autonomous [Background Scheduler](src/backgroundScheduler.ts) that Ebbinghaus-decays older memories, auto-compacts session histories into dense summaries, and deep-purges high-precision vectors — saving ~90% of disk space automatically.

### 🤝 Where the Giants Currently Win (Honest Trade-offs)

1. **Framework Integrations:** Mem0 and Zep have pre-built integrations for LangChain, LlamaIndex, Flowise, AutoGen, CrewAI, etc. Prism requires the host application to support the MCP protocol.
2. **Managed Cloud Infrastructure:** The giants offer SaaS. Users pay $20/month and don't think about databases. Prism users must set up their own local SQLite or provision their own Supabase instance.
3. **Implicit Memory Extraction (NER):** Zep automatically extracts names, places, and facts from raw chat logs using NLP models. Prism relies on the LLM explicitly calling the `session_save_ledger` tool to structure its own memories.

> 💰 **Token Economics:** Progressive Context Loading (Quick ~50 tokens / Standard ~200 / Deep ~1000+) plus auto-compaction means you never blow your Claude/OpenAI token budget fetching 50 pages of raw chat history.
>
> 🔌 **BYOM (Bring Your Own Model):** While tools like Mem0 charge per API call, Prism's pluggable architecture lets you run `nomic-embed-text` locally via Ollama for **free vectors**, while using Claude or GPT for high-level reasoning. Zero vendor lock-in.

---

## 🔧 Tool Reference

Prism ships 30+ tools, but **90% of your workflow uses just three:**

> **🎯 The Big Three**
>
> | Tool | When | What it does |
> |------|------|--------------|
> | `session_load_context` | ▶️ Start of session | Loads your agent’s brain from last time |
> | `session_save_ledger` | ⏹️ End of session | Records what was accomplished |
> | `knowledge_search` | 🔍 Anytime | Finds past decisions, context, and learnings |
>
> *Everything else is a power-up. Start with these three and you’re 90% there.*

<details>
<summary><strong>Session Memory & Knowledge (12 tools)</strong></summary>

| Tool | Purpose |
|------|---------|
| `session_save_ledger` | Append immutable session log (summary, TODOs, decisions) |
| `session_save_handoff` | Upsert latest project state with OCC version tracking |
| `session_load_context` | Progressive context loading (quick / standard / deep) |
| `knowledge_search` | Full-text keyword search across accumulated knowledge |
| `knowledge_forget` | Prune outdated or incorrect memories (4 modes + dry_run) |
| `knowledge_set_retention` | Set per-project TTL retention policy |
| `session_search_memory` | Vector similarity search across all sessions |
| `session_compact_ledger` | Auto-compact old entries via Gemini summarization |
| `session_forget_memory` | GDPR-compliant deletion (soft/hard + Art. 17 reason) |
| `session_export_memory` | Full export (JSON, Markdown, or Obsidian vault `.zip` with `[[Wikilinks]]`) |
| `session_health_check` | Brain integrity scan + auto-repair (`fsck`) |
| `deep_storage_purge` | Reclaim ~90% vector storage (v5.1) |

</details>

<details>
<summary><strong>Behavioral Memory & Knowledge Graph (5 tools)</strong></summary>

| Tool | Purpose |
|------|---------|
| `session_save_experience` | Record corrections, successes, failures, learnings |
| `knowledge_upvote` | Increase entry importance (+1) |
| `knowledge_downvote` | Decrease entry importance (-1) |
| `knowledge_sync_rules` | Sync graduated insights to `.cursorrules` / `.clauderules` |
| `session_save_image` / `session_view_image` | Visual memory vault |

</details>

<details>
<summary><strong>Time Travel & History (2 tools)</strong></summary>

| Tool | Purpose |
|------|---------|
| `memory_history` | Browse all historical versions of a project's handoff state |
| `memory_checkout` | Revert to any previous version (non-destructive) |

</details>

<details>
<summary><strong>Search & Analysis (7 tools)</strong></summary>

| Tool | Purpose |
|------|---------|
| `brave_web_search` | Real-time internet search |
| `brave_local_search` | Location-based POI discovery |
| `brave_web_search_code_mode` | JS extraction over web search results |
| `brave_local_search_code_mode` | JS extraction over local search results |
| `code_mode_transform` | Universal post-processing with 8 built-in templates |
| `gemini_research_paper_analysis` | Academic paper analysis via Gemini |
| `brave_answers` | AI-grounded answers from Brave |

</details>

<details>
<summary><strong>Cognitive Architecture (1 tool)</strong></summary>

Requires `PRISM_HDC_ENABLED=true` (default).

| Tool | Purpose |
|------|---------|
| `session_cognitive_route` | HDC compositional state resolution with policy-gated routing |

</details>

<details>
<summary><strong>Multi-Agent Hivemind (3 tools)</strong></summary>

Requires `PRISM_ENABLE_HIVEMIND=true`.

| Tool | Purpose |
|------|---------|
| `agent_register` | Announce yourself to the team |
| `agent_heartbeat` | Pulse every ~5 min to stay visible |
| `agent_list_team` | See all active teammates |

</details>

<details>
<summary><strong>Task Routing (1 tool)</strong></summary>

Requires `PRISM_TASK_ROUTER_ENABLED=true` (or dashboard toggle).

| Tool | Purpose |
|------|---------|
| `session_task_route` | Scores task complexity and recommends host vs. local Claw delegation (`claw_run_task` when delegable; host fallback when executor/tooling is unavailable) |

</details>

---

## Environment Variables

> **🚦 TL;DR — Just want the best experience fast?** Set these three keys and you're done:
> ```
> GOOGLE_API_KEY=...      # Unlocks: semantic search, Morning Briefings, auto-compaction
> BRAVE_API_KEY=...       # Unlocks: Web Scholar research + Brave Answers
> FIRECRAWL_API_KEY=...   # Unlocks: Web Scholar deep scraping (or use TAVILY_API_KEY instead)
> ```
> **Zero keys = zero problem.** Core session memory, keyword search, time travel, and the full dashboard work 100% offline. Cloud keys are optional power-ups.

<details>
<summary><strong>Full variable reference</strong></summary>

| Variable | Required | Description |
|----------|----------|-------------|
| `BRAVE_API_KEY` | No | Brave Search Pro API key |
| `FIRECRAWL_API_KEY` | No | Firecrawl API key — required for Web Scholar (unless using Tavily) |
| `TAVILY_API_KEY` | No | Tavily Search API key — alternative to Brave+Firecrawl for Web Scholar |
| `PRISM_STORAGE` | No | `"local"` (default) or `"supabase"` — restart required |
| `PRISM_ENABLE_HIVEMIND` | No | `"true"` to enable multi-agent tools — restart required |
| `PRISM_INSTANCE` | No | Instance name for multi-server PID isolation |
| `GOOGLE_API_KEY` | No | Gemini — enables semantic search, Briefings, compaction |
| `BRAVE_ANSWERS_API_KEY` | No | Separate Brave Answers key |
| `SUPABASE_URL` | If cloud | Supabase project URL |
| `SUPABASE_KEY` | If cloud | Supabase anon/service key |
| `PRISM_USER_ID` | No | Multi-tenant user isolation (default: `"default"`) |
| `PRISM_AUTO_CAPTURE` | No | `"true"` to auto-snapshot dev server UI states (HTML/DOM) for visual memory |
| `PRISM_CAPTURE_PORTS` | No | Comma-separated ports (default: `3000,3001,5173,8080`) |
| `PRISM_DEBUG_LOGGING` | No | `"true"` for verbose logs |
| `PRISM_DASHBOARD_PORT` | No | Dashboard port (default: `3000`) |
| `PRISM_SCHEDULER_ENABLED` | No | `"false"` to disable background maintenance (default: enabled) |
| `PRISM_SCHEDULER_INTERVAL_MS` | No | Maintenance interval in ms (default: `43200000` = 12h) |
| `PRISM_SCHOLAR_ENABLED` | No | `"true"` to enable Web Scholar pipeline |
| `PRISM_SCHOLAR_INTERVAL_MS` | No | Scholar interval in ms (default: `0` = manual only) |
| `PRISM_SCHOLAR_TOPICS` | No | Comma-separated research topics (default: `"ai,agents"`) |
| `PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN` | No | Max articles per Scholar run (default: `3`) |
| `PRISM_TASK_ROUTER_ENABLED` | No | `"true"` to enable task-router tool registration |
| `PRISM_TASK_ROUTER_CONFIDENCE_THRESHOLD` | No | Min confidence required to delegate to Claw (default: `0.6`) |
| `PRISM_TASK_ROUTER_MAX_CLAW_COMPLEXITY` | No | Max complexity score delegable to Claw (default: `4`) |
| `PRISM_HDC_ENABLED` | No | `"true"` (default) to enable HDC cognitive routing pipeline |
| `PRISM_HDC_EXPLAINABILITY_ENABLED` | No | `"true"` (default) to include convergence/distance/ambiguity in cognitive route responses |
| `PRISM_ACTR_ENABLED` | No | `"true"` (default) to enable ACT-R activation re-ranking on semantic search |
| `PRISM_ACTR_DECAY` | No | ACT-R decay parameter `d` (default: `0.5`). Higher values = faster recency drop-off |
| `PRISM_ACTR_WEIGHT_SIMILARITY` | No | Composite score similarity weight (default: `0.7`) |
| `PRISM_ACTR_WEIGHT_ACTIVATION` | No | Composite score ACT-R activation weight (default: `0.3`) |
| `PRISM_ACTR_ACCESS_LOG_RETENTION_DAYS` | No | Days before access logs are pruned by background scheduler (default: `90`) |

</details>

---

## Architecture

Prism is a **stdio-based MCP server** that manages persistent agent memory. Here's how the pieces fit together:

```
┌──────────────────────────────────────────────────────────┐
│  MCP Client (Claude Desktop / Cursor / Antigravity)      │
│                    ↕ stdio (JSON-RPC)                    │
├──────────────────────────────────────────────────────────┤
│  Prism MCP Server                                        │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  30+ Tools   │  │  Lifecycle   │  │   Dashboard    │  │
│  │  (handlers)  │  │  (PID lock,  │  │  (HTTP :3000)  │  │
│  │              │  │   shutdown)  │  │                │  │
│  └──────┬───────┘  └──────────────┘  └────────────────┘  │
│         ↕                                                │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Storage Engine                                    │  │
│  │  Local: SQLite + FTS5 + TurboQuant vectors         │  │
│  │  Cloud: Supabase + pgvector                        │  │
│  └────────────────────────────────────────────────────┘  │
│         ↕                                                │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Background Workers                                │  │
│  │  • Scheduler (TTL, decay, compaction, purge)       │  │
│  │  • Web Scholar (Brave → Firecrawl → LLM → Ledger)  │  │
│  │  • Hivemind heartbeats & Telepathy broadcasts      │  │
│  │  • OpenTelemetry span export                       │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### Startup Sequence

1. **Acquire PID lock** — prevents duplicate instances per `PRISM_INSTANCE`
2. **Initialize config** — SQLite settings cache (`prism-config.db`)
3. **Register 30+ MCP tools** — session, knowledge, search, behavioral, hivemind
4. **Connect stdio transport** — MCP handshake with the client (~60ms total)
5. **Async post-connect** — storage warmup, dashboard launch, scheduler start (non-blocking)

### Storage Layers

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Session Ledger** | SQLite (append-only) | Immutable audit trail of all agent work |
| **Handoff State** | SQLite (upsert, versioned) | Live project context with OCC + CRDT merging |
| **Keyword Search** | FTS5 virtual tables | Zero-dependency full-text search |
| **Semantic Search** | TurboQuant compressed vectors | 10× compressed 768-dim embeddings, three-tier retrieval |
| **Cloud Sync** | Supabase + pgvector | Optional multi-device/team sync |

### Auto-Load Architecture

Each MCP client has its own mechanism for ensuring Prism context loads on session start. See the platform-specific [Setup Guides](#-setup-guides) above for detailed instructions:

- **Claude Code** — Lifecycle hooks (`SessionStart` / `Stop`)
- **Gemini / Antigravity** — Three-layer architecture (User Rules + AGENTS.md + Startup Skill)
- **Task Router Integration (v7.2 guidance)** — For client startup/skills, use defensive delegation flow: route only coding tasks, call `session_task_route` only when available, delegate to `claw` only when executor exists and task is non-destructive, and fallback to host if router/executor is unavailable.
- **Cursor / Windsurf / VS Code** — System prompt instructions

All platforms benefit from the **server-side fallback** (v5.2.1): if `session_load_context` hasn't been called within 10 seconds, Prism auto-pushes context via `sendLoggingMessage`.

---

## 🧬 Scientific Foundation

Prism is evolving from smart session logging toward a **cognitive memory architecture** — grounded in real research, not marketing.

| Phase | Feature | Inspired By | Status |
|-------|---------|-------------|--------|
| **v5.0** | TurboQuant 10× Compression — 4-bit quantized 768-dim vectors in <500 bytes | Vector quantization (product/residual PQ) | ✅ Shipped |
| **v5.0** | Three-Tier Search — native → TurboQuant → FTS5 keyword fallback | Cascaded retrieval architectures | ✅ Shipped |
| **v5.2** | Smart Consolidation — extract principles, not just summaries | Neuroscience sleep consolidation | ✅ Shipped |
| **v5.2** | Ebbinghaus Importance Decay — memories fade unless reinforced | Ebbinghaus forgetting curve | ✅ Shipped |
| **v5.2** | Context-Weighted Retrieval — current work biases what surfaces | Contextual memory in cognitive science | ✅ Shipped |
| **v5.4** | CRDT Handoff Merging — conflict-free multi-agent state via OR-Map engine | CRDTs (Shapiro et al., 2011) | ✅ Shipped |
| **v5.4** | Autonomous Web Scholar — background research pipeline with LLM synthesis | Autonomous research agents | ✅ Shipped |
| **v5.5** | SDM Decoder Foundation — pre-allocated typed-array hot loop, zero GC thrash | Kanerva's Sparse Distributed Memory (1988) | ✅ Shipped |
| **v5.5** | Architectural Hardening — transactional migrations, graceful shutdown, thundering herd prevention | Production reliability engineering | ✅ Shipped |
| **v6.1** | Intuitive Recall — proactive surface of relevant past decisions without explicit search; `session_intuitive_recall` tool | Predictive memory (cognitive science) | ✅ Shipped |
| **v6.5** | HDC Cognitive Routing — compositional state-machine with XOR binding, Hamming resolution, and policy-gated routing | Hyperdimensional Computing (Kanerva, Gayler) | ✅ Shipped |
| **v6.5** | Cognitive Observability — route distribution, confidence/distance tracking, ambiguity warnings | Production reliability engineering | ✅ Shipped |
| **v6.1** | Prism-Port Vault Export — Obsidian/Logseq `.zip` with YAML frontmatter & `[[Wikilinks]]` | Data sovereignty, PKM interop | ✅ Shipped |
| **v6.1** | Cognitive Load & Semantic Search — dynamic graph thinning, search highlights | Contextual working memory | ✅ Shipped |
| **v6.2** | Synthesize & Prune — automated edge synthesis, graph pruning, SLO observability | Implicit associative memory | ✅ Shipped |
| **v7.0** | ACT-R Base-Level Activation — `B_i = ln(Σ t_j^(-d))` recency×frequency re-ranking over similarity candidates | Anderson's ACT-R (Adaptive Control of Thought—Rational, ACM 2025) | ✅ Shipped |
| **v7.0** | Candidate-Scoped Spreading Activation — `S_i = Σ(W × strength)` bounded to search result set; prevents God-node dominance | Spreading activation networks (Collins & Loftus, 1975) | ✅ Shipped |
| **v7.0** | Composite Retrieval Scoring — `0.7 × similarity + 0.3 × σ(activation)`; configurable via `PRISM_ACTR_WEIGHT_*` | Hybrid cognitive-neural retrieval models | ✅ Shipped |
| **v7.0** | AccessLogBuffer — in-memory batch-write buffer with 5s flush; prevents SQLite `SQLITE_BUSY` under parallel agents | Production reliability engineering | ✅ Shipped |
| **v7.x** | Affect-Tagged Memory — sentiment shapes what gets recalled | Affect-modulated retrieval (neuroscience) | 🔭 Horizon |
| **v8+** | Zero-Search Retrieval — no index, no ANN, just ask the vector | Holographic Reduced Representations | 🔭 Horizon |

> Informed by LeCun's "Why AI Systems Don't Learn" (Dupoux, LeCun, Malik) and Kanerva's SDM.

---

## 📦 Product Roadmap

> **[Full ROADMAP.md →](ROADMAP.md)**

### v6.2: The "Synthesize & Prune" Phase ✅
Shipped in v6.2.0. Edge synthesis, graph pruning with SLO observability, temporal decay heatmaps, active recall prompt generation, and full dashboard metrics integration.

### v6.5: Cognitive Architecture ✅
Shipped. Full Superposed Memory (SDM) + Hyperdimensional Computing (HDC/VSA) cognitive routing pipeline. Compositional memory states via XOR binding, Hamming resolution, and policy-gated routing (direct / clarify / fallback). 705 tests passing.

### v7.1: Prism Task Router ✅
Shipped. Deterministic task routing (`session_task_route`) with optional experience-based confidence adjustment for host vs. local Claw delegation.

### v7.0: ACT-R Activation Memory ✅
Shipped. Scientifically-grounded retrieval re-ranking via ACT-R base-level activation (`B_i = ln(Σ t_j^(-d))`), candidate-scoped spreading activation, parameterized sigmoid normalization, composite scoring, and zero-cold-start access log infrastructure. 49 dedicated unit tests, 705 total passing.

### Future Tracks
- **v7.x: Affect-Tagged Memory** — Recall prioritization improves by weighting memories with affective/contextual valence, making surfaced context more behaviorally useful.
- **v8+: Zero-Search Retrieval** — Direct vector-addressed recall (“just ask the vector”) reduces retrieval indirection and moves Prism toward truly native associative memory.


## ❓ Troubleshooting FAQ

**Q: Why is the dashboard project selector stuck on "Loading projects..."?**
A: This usually means Supabase env values are unresolved placeholders (for example `${SUPABASE_URL}`) or invalid. As of v6.5.1 Prism auto-falls back to local SQLite, but you should still fix env values for cloud mode.

**Q: Why is semantic search quality weak or inconsistent?**
A: Check embedding provider configuration and key availability. Missing embedding credentials reduce semantic recall quality and can shift behavior toward keyword-heavy matches.

**Q: How do I delete a bad memory entry?**
A: Use `session_forget_memory` for targeted soft/hard deletion. For manual cleanup and merge workflows, use the dashboard graph editor.

**Q: How do I verify the install quickly?**
A: Run `npm run build && npm test`, then open the Mind Palace dashboard (`localhost:3000`) and confirm projects load plus Graph Health renders.


- **LLM-dependent features require an API key.** Semantic search, Morning Briefings, auto-compaction, and VLM captioning need a `GOOGLE_API_KEY` (Gemini) or equivalent provider key. Without one, Prism falls back to keyword-only search (FTS5).
- **Auto-load is model- and client-dependent.** Session auto-loading relies on both the LLM following system prompt instructions *and* the MCP client completing tool registration before the model's first turn. Prism provides platform-specific [Setup Guides](#-setup-guides) and a server-side fallback (v5.2.1) that auto-pushes context after 10 seconds.
- **MCP client race conditions.** Some MCP clients may not finish tool enumeration before the model generates its first response, causing transient `unknown_tool` errors. This is a client-side timing issue — Prism's server completes the MCP handshake in ~60ms. Workaround: the server-side auto-push fallback and the startup skill's retry logic.
- **No real-time sync without Supabase.** Local SQLite mode is single-machine only. Multi-device or team sync requires a Supabase backend.
- **Embedding quality varies by provider.** Gemini `text-embedding-004` and OpenAI `text-embedding-3-small` produce high-quality 768-dim vectors. Prism passes `dimensions: 768` via the Matryoshka API for OpenAI models (native output is 1536-dim; this truncation is lossless and outperforms ada-002 at full 1536 dims). Ollama embeddings (e.g., `nomic-embed-text`) are usable but may reduce retrieval accuracy.
- **Dashboard is HTTP-only.** The Mind Palace dashboard at `localhost:3000` does not support HTTPS. For remote access, use a reverse proxy (nginx/Caddy) or SSH tunnel. Basic auth is available via `PRISM_DASHBOARD_USER` / `PRISM_DASHBOARD_PASS`.
- **Long-lived clients can accumulate zombie processes.** MCP clients that run for extended periods (e.g., Claude CLI) may leave orphaned Prism server processes. The lifecycle manager detects true orphans (PPID=1) but allows coexistence for active parent processes. Use `PRISM_INSTANCE` to isolate instances across clients.
- **Migration is one-way.** Universal History Migration imports sessions *into* Prism but does not export back to Claude/Gemini/OpenAI formats. Use `session_export_memory` for portable JSON/Markdown export, or the `vault` format for Obsidian/Logseq-compatible `.zip` archives.
- **Export ceiling at 10,000 ledger entries.** The `session_export_memory` tool and the dashboard export button cap vault/JSON exports at 10,000 entries per project as an OOM guard. Projects exceeding this limit should use per-project exports and time-based filtering to stay within the ceiling. This limit does not affect search or context loading.
- **No Windows CI testing.** Prism is developed and tested on macOS/Linux. It should work on Windows via Node.js, but edge cases (file paths, PID locks) may surface.

---

## License

MIT

---

<sub>**Keywords:** MCP server, Model Context Protocol, Claude Desktop memory, persistent session memory, AI agent memory, local-first, SQLite MCP, Mind Palace, time travel, visual memory, VLM image captioning, OpenTelemetry, GDPR, agent telepathy, multi-agent sync, behavioral memory, cursorrules, Ollama MCP, Brave Search MCP, TurboQuant, progressive context loading, knowledge management, LangChain retriever, LangGraph agent</sub>
