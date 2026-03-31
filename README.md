# 🧠 Prism MCP — The Mind Palace for AI Agents

[![npm version](https://img.shields.io/npm/v/prism-mcp-server?color=cb0000&label=npm)](https://www.npmjs.com/package/prism-mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-00ADD8?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyTDIgN2wxMCA1IDEwLTUtMTAtNXpNMiAxN2wxMCA1IDEwLTV2LTJMMTI0djJMMiA5djh6Ii8+PC9zdmc+)](https://registry.modelcontextprotocol.io)
[![Glama](https://img.shields.io/badge/Glama-listed-FF5601)](https://glama.ai/mcp/servers/dcostenco/prism-mcp)
[![Smithery](https://img.shields.io/badge/Smithery-listed-6B4FBB)](https://smithery.ai/server/prism-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

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
- [What Makes Prism Different](#-what-makes-prism-different)
- [Use Cases](#-use-cases)
- [What's New](#-whats-new)
- [How Prism Compares](#-how-prism-compares)
- [Tool Reference](#-tool-reference)
- [Environment Variables](#environment-variables)
- [Architecture](#architecture)
- [Scientific Foundation](#-scientific-foundation)
- [Product Roadmap](#-product-roadmap)
- [Limitations](#limitations)

---

## Why Prism?

Every time you start a new conversation with an AI coding assistant, it starts from scratch. You re-explain your architecture, re-describe your decisions, re-list your TODOs. Hours of context — gone.

**Prism gives your agent a brain that persists.** Save what matters at the end of each session. Load it back instantly on the next one. Your agent remembers what it did, what it learned, and what's left to do.

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

**That's it.** Restart your client. All tools are available. Dashboard at `http://localhost:3000`. *(Note: The MCP server automatically starts this UI on port 3000 when connected. If you have a Next.js/React app running, port 3000 might already be in use.)*

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
| Web Scholar research | ❌ | ✅ `BRAVE_API_KEY` + `FIRECRAWL_API_KEY` (or `TAVILY_API_KEY`) |
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

### Migration

<details>
<summary><strong>Migrating Existing History (Claude, Gemini, OpenAI)</strong></summary>

Prism can ingest months of historical sessions from other tools to give your Mind Palace a massive head start. Import via the **CLI** or directly from the [Mind Palace Dashboard](#-mind-palace-dashboard) Import tab (file picker + manual path + dry-run toggle).

#### Supported Formats
* **Claude Code** (`.jsonl` logs) — Automatically handles streaming chunk deduplication and `requestId` normalization.
* **Gemini** (JSON history arrays) — Supports large-file streaming for 100MB+ exports.
* **OpenAI** (JSON chat completion history) — Normalizes disparate tool-call structures into the unified Ledger schema.

#### How to Run

**Option 1 — CLI:**

```bash
# Ingest Claude Code history
npx -y prism-mcp-server universal-import --format claude --path ~/path/to/claude_log.jsonl --project my-project

# Dry run (verify mapping without saving)
npx -y prism-mcp-server universal-import --format gemini --path ./gemini_history.json --dry-run
```

**Option 2 — Dashboard:** Open `localhost:3000`, navigate to the **Import** tab, select the format and file, and click Import. Supports dry-run preview. See the [dashboard screenshot](#-mind-palace-dashboard) above.

#### Key Features
* **OOM-Safe Streaming:** Processes massive log files line-by-line using `stream-json`.
* **Idempotent Dedup:** Content-hash prevents duplicate imports on re-run (`skipCount` reported).
* **Chronological Integrity:** Uses timestamp fallbacks and `requestId` sorting to ensure your memory timeline is accurate.
* **Smart Context Mapping:** Extracts `cwd`, `gitBranch`, and tool usage patterns into searchable metadata.

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
Multiple agents (dev, QA, PM) can work on the same project with **role-isolated memory**. Agents discover each other automatically, share context in real-time via Telepathy sync, and see a team roster during context loading.

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

---

## 🆕 What's New

### v6.1 — Prism-Port, Cognitive Load & Semantic Search ✅
> **Current stable release (v6.1.9).** Data sovereignty meets active memory intelligence.

- 📦 **Prism-Port Vault Export** — New `vault` format for `session_export_memory`. Generates a `.zip` of interlinked Markdown files with YAML frontmatter, `[[Wikilinks]]`, and auto-generated `Keywords/` backlink indices. Drop into Obsidian or Logseq for instant knowledge graph.
- 🏛️ **Dashboard Export Vault Button** — "🏛️ Export Vault" button in the Mind Palace UI exports the full Prism-Port vault ZIP directly from the browser. Both `/api/export` and `/api/export/vault` now use the unified `buildVaultDirectory` path — same rich format as the MCP tool.
- 🏥 **Dashboard Health Cleanup** — The "Fix Issues" button now repairs missing embeddings directly from the Mind Palace UI.
- 🧠 **Smart Memory Merge UI** — Dynamically merge duplicate knowledge nodes right from the Graph Editor. "Knowledge Gardening" made effortless.
- ✨ **Semantic Search Highlighting** — Native RegEx mapping that visually wraps the exact reason a vector result was retrieved during a search.
- 📊 **Deep Purge Visualization** — A zero-overhead "Memory Density" analytic providing instant signal-to-noise ratio visibility (Graduated ideas vs raw concepts).
- 🛡️ **Context-Boosted Search** — Biases semantic queries by intelligently interleaving your current project workspace.

#### v6.1.9 — Web Scholar Tavily Integration
- 🌐 **Tavily Core** — The Web Scholar now supports `@tavily/core` as an all-in-one search and extraction alternative to Brave+Firecrawl.
- 📦 **API Chunking Limits** — Advanced looping logic transparently works around `tavily.extract` 20-URL boundaries.
- 🛡️ **Network Resilience** — Handled promise rejections prevent data loss out-of-bounds due to chunk extraction or upstream network timeouts.

#### v6.1.8 — Type Guard Hardening (Production Safety)
- 🛡️ **Missing Guard Added** — `isSessionCompactLedgerArgs` was absent; an LLM passing `{threshold: "many"}` would reach the handler as a string. Added full validation for all four optional fields.
- ✅ **Array Field Validation** — `isSessionSaveLedgerArgs` now guards `todos`, `files_changed`, and `decisions` with `Array.isArray` checks — prevents a hallucinated `{todos: "string"}` from bypassing the type system.
- 🔖 **Enum Literal Guard** — `isSessionExportMemoryArgs` now rejects any `format` value outside `'json' | 'markdown' | 'vault'` at the boundary instead of propagating to the handler.
- 🔢 **Numeric Field Guards** — `isSessionIntuitiveRecallArgs` now validates `limit` and `threshold` as numbers, blocking string coercion (`{limit: "many"}`).
- 🧹 **Legacy Guard Migration** — `isMemoryHistoryArgs`, `isMemoryCheckoutArgs`, and `isSessionSaveImageArgs` migrated to the consistent `Record<string, unknown>` pattern; `isMemoryHistoryArgs` also gains a previously missing `limit` number check.

#### v6.1.7 — Dashboard Toggle Persistence
- 🔄 **Rollback on Save Failure** — `saveSetting()` now returns `Promise<boolean>`; UI toggles (Hivemind, Auto-Capture) roll back their optimistic state if the server request fails.
- 🚫 **Cache-Busting** — `loadSettings()` appends `?t=<timestamp>` to bypass stale browser/service-worker caches.
- 🔔 **HTTP Error Detection** — Explicit 4xx/5xx catching in `saveSetting()` surfaces failed saves as user-visible toast notifications.

#### v6.1.6 — Type Guard Audit (Round 1)
- 🛡️ **11 Type Guards Hardened** — Audited and refactored all MCP tool argument guards to include explicit `typeof` validation for optional fields, preventing LLM-hallucinated payloads from causing runtime type coercion errors.

#### v6.1.5 — SQLite Deep Storage TTL
- 🧪 **Comprehensive Edge-Case Test Suite** — 425 tests across 20 files covering CRDT merges, TurboQuant mathematical invariants, prototype pollution guards, and SQLite retention TTL boundary conditions.
- 🔒 **Prototype Pollution Guards** — CRDT merge pipeline hardened against `__proto__` / `constructor` injection via `Object.create(null)` scratchpads.
- 🗜️ **`maintenance_vacuum` Tool** — New tool to reclaim SQLite disk space after large purge operations.

#### v6.1.4 — Production Hardening
- 🔒 **Embedding Binary Strip** — Both `embedding` (raw float32) and `embedding_compressed` (TurboQuant binary blob) are now stripped from all export formats, preventing ~400 bytes of raw binary per entry from appearing in vault/JSON exports.
- 🔗 **Vault Wikilink Fix** — Keyword backlink paths now use vault-relative `Ledger/filename.md` instead of `../Ledger/filename.md` — ensuring correct internal link resolution in Obsidian and Logseq.
- 🖼️ **Visual Memory Key Fix** — Export correctly reads `filename` and `timestamp` (the keys written by `session_save_image`), resolving a mismatch that produced `"Unknown"` values in the vault visual memory index.
- 🛡️ **OOM Guard on Large Exports** — `getLedgerEntries` in the export handler now has a 10,000-entry ceiling with explicit `ORDER BY created_at ASC`, preventing unbounded heap allocation on high-volume projects.
- ⚡ **O(1) Filename Dedup** — Vault filename collision resolution upgraded from O(n²) loop to O(1) `Map<string, number>` counter. Important for projects with many same-day sessions.
- 🔧 **TurboQuant Guard** — `bits` parameter now validated to `[2, 6]` range at construction time, preventing accidental multi-second Lloyd-Max initialization at higher bit depths.

![Prism v6 Features](docs/v6_cognitive_load_dashboard.png)

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

## 🆚 How Prism Compares

| Capability | **Prism MCP** | [MCP Memory](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) | [Mem0](https://github.com/mem0ai/mem0) | [Mnemory](https://github.com/fpytloun/mnemory) | [Basic Memory](https://github.com/basicmachines-co/basic-memory) |
|:-----------|:---:|:---:|:---:|:---:|:---:|
| Zero-config (`npx` one-liner) | ✅ | ✅ | ❌ Docker | ✅ | ✅ |
| Time travel (version revert) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Behavioral memory (mistake learning) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Visual dashboard | ✅ | ❌ | ✅ Web | ❌ | ❌ |
| Multi-agent Hivemind | ✅ | ❌ | ❌ | ❌ | ❌ |
| CRDT conflict-free merging | ✅ | ❌ | ❌ | ❌ | ❌ |
| Autonomous research (Web Scholar) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Visual memory (VLM screenshots) | ✅ | ❌ | ❌ | ❌ | ❌ |
| 10× vector compression | ✅ | ❌ | ❌ (Qdrant) | ❌ | ❌ |
| Obsidian/Logseq vault export | ✅ | ❌ | ❌ | ❌ | ✅ |
| Token budgeting | ✅ | ❌ | ❌ | ❌ | ❌ |
| GDPR compliance (Art. 17 + 20) | ✅ | ❌ | ❌ | ❌ | ❌ |
| OpenTelemetry tracing | ✅ | ❌ | ❌ | ❌ | ❌ |
| IDE rules sync (`.cursorrules`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Air-gapped mode (Ollama) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Morning Briefings | ✅ | ❌ | ❌ | ❌ | ❌ |
| Auto-compaction | ✅ | ❌ | ❌ | ❌ | ❌ |

> **TL;DR:** Prism is the only MCP memory server with time travel, behavioral learning, autonomous research, CRDT multi-agent sync, and 10× compression — all from a single `npx` command.

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
<summary><strong>Multi-Agent Hivemind (3 tools)</strong></summary>

Requires `PRISM_ENABLE_HIVEMIND=true`.

| Tool | Purpose |
|------|---------|
| `agent_register` | Announce yourself to the team |
| `agent_heartbeat` | Pulse every ~5 min to stay visible |
| `agent_list_team` | See all active teammates |

</details>

---

## Environment Variables

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
| **v6.2+** | Full Superposed Memory (SDM) — O(1) key-value retrieval via Hamming correlation | Kanerva's SDM | 🔬 In Progress |
| **v6.1** | Prism-Port Vault Export — Obsidian/Logseq `.zip` with YAML frontmatter & `[[Wikilinks]]` | Data sovereignty, PKM interop | ✅ Shipped |
| **v6.1** | Cognitive Load & Semantic Search — dynamic graph thinning, search highlights | Contextual working memory | ✅ Shipped |
| **v6.2** | Synthesize & Prune — automated edge synthesis and visual decay | Implicit associative memory | 🔬 In Progress |
| **v7.x** | Affect-Tagged Memory — sentiment shapes what gets recalled | Affect-modulated retrieval (neuroscience) | 🔭 Horizon |
| **v8+** | Zero-Search Retrieval — no index, no ANN, just ask the vector | Holographic Reduced Representations | 🔭 Horizon |

> Informed by LeCun's "Why AI Systems Don't Learn" (Dupoux, LeCun, Malik) and Kanerva's SDM.

---

## 📦 Product Roadmap

> **[Full ROADMAP.md →](ROADMAP.md)**

### v6.2: The "Synthesize & Prune" Phase
The v6.1 series (through v6.1.8) shipped Prism-Port vault export, Intuitive Recall, full type guard hardening, and dashboard toggle persistence. The v6.2 phase aims to turn collected data into proactive intelligence, moving the dashboard from a passive storage viewer into an active, self-organizing Mind Palace.

1. 🕸️ **Automated Edge Synthesis (The "Dream" Procedure):** A background routine that runs on the graph payload to find semantically similar but disconnected nodes via Cosine Similarity. It highlights potential ghostly edges in the UI, empowering the system to autonomously suggest new mental models instead of waiting for the user to connect the dots manually.
2. 🗓️ **Temporal Decay Heatmaps (Visualizing the Ebbinghaus Curve):** A UI overlay toggle where un-accessed nodes dynamically desaturate or physically "fade" while Graduated nodes (Score >= 7) stay vibrant longer. This makes the "Deep Purge" decision-making visceral: if the graph looks gray, trigger a learning session or a cleanup.
3. 📝 **Active Recall Prompt Generation (Knowledge Activation):** A "Test Me" utility in the `nodeEditorPanel`. Using a node's semantic neighbors, the dashboard generates synthetic quizzes to ensure context retention, pushing the product away from pure "storage" into genuine "active learning" capabilities.

---

## Limitations

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
