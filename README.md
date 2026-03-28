# 🧠 Prism MCP — The Mind Palace for AI Agents

[![npm version](https://img.shields.io/npm/v/prism-mcp-server?color=cb0000&label=npm)](https://www.npmjs.com/package/prism-mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-00ADD8?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyTDIgN2wxMCA1IDEwLTUtMTAtNXpNMiAxN2wxMCA1IDEwLTV2LTJMMTI0djJMMiA5djh6Ii8+PC9zdmc+)](https://registry.modelcontextprotocol.io)
[![Glama](https://img.shields.io/badge/Glama-listed-FF5601)](https://glama.ai/mcp/servers/dcostenco/prism-mcp)
[![Smithery](https://img.shields.io/badge/Smithery-listed-6B4FBB)](https://smithery.ai/server/prism-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

**Your AI agent forgets everything between sessions. Prism fixes that.**

One command. Persistent memory. Zero cloud dependencies.

```bash
npx -y prism-mcp-server
```

Works with **Claude Desktop · Claude Code · Cursor · Windsurf · Cline · Gemini · Antigravity** — any MCP client.

## 📖 Table of Contents

- [Why Prism?](#why-prism)
- [Quick Start](#-quick-start)
- [Setup Guides](#-setup-guides)
- [What Makes Prism Different](#-what-makes-prism-different)
- [Use Cases](#-use-cases)
- [What's New](#-whats-new)
- [Autonomous Web Scholar](#-autonomous-web-scholar)
- [How Prism Compares](#how-prism-compares)
- [Tool Reference](#-tool-reference)
- [Environment Variables](#environment-variables)
- [Architecture](#architecture)
- [Research Roadmap](#research-roadmap)
- [Roadmap](#-roadmap)
- [Limitations](#-limitations)

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

**That's it.** Restart your client. All 30+ tools are available. Dashboard at `http://localhost:3000`.

> 🔑 **API Key Requirements:** Need semantic search, Morning Briefings, or auto-compaction? Provide a `GOOGLE_API_KEY` (Gemini) or equivalent. Want Web Scholar to search the live internet? Provide a `BRAVE_API_KEY`. Without keys, Prism still works but falls back to local keyword search (FTS5). See [Environment Variables](#environment-variables).

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

#### Migration

<details>
<summary><strong>Migrating Existing History (Claude, Gemini, OpenAI)</strong></summary>

Prism can ingest months of historical sessions from other tools to give your Mind Palace a massive head start. Import via the **CLI** or directly from the [Mind Palace Dashboard](#-mind-palace-dashboard) Import tab (file picker + manual path + dry-run toggle).

### Supported Formats
* **Claude Code** (`.jsonl` logs) — Automatically handles streaming chunk deduplication and `requestId` normalization.
* **Gemini** (JSON history arrays) — Supports large-file streaming for 100MB+ exports.
* **OpenAI** (JSON chat completion history) — Normalizes disparate tool-call structures into the unified Ledger schema.

### How to Run

**Option 1 — CLI:**

```bash
# Ingest Claude Code history
npx -y prism-mcp-server universal-import --format claude --path ~/path/to/claude_log.jsonl --project my-project

# Dry run (verify mapping without saving)
npx -y prism-mcp-server universal-import --format gemini --path ./gemini_history.json --dry-run
```

**Option 2 — Dashboard:** Open `localhost:3000`, navigate to the **Import** tab, select the format and file, and click Import. Supports dry-run preview. See the [dashboard screenshot](#-mind-palace-dashboard) above.

### Key Features
* **OOM-Safe Streaming:** Processes massive log files line-by-line using `stream-json`.
* **Idempotent Dedup:** Content-hash prevents duplicate imports on re-run (`skipCount` reported).
* **Chronological Integrity:** Uses timestamp fallbacks and `requestId` sorting to ensure your memory timeline is accurate.
* **Smart Context Mapping:** Extracts `cwd`, `gitBranch`, and tool usage patterns into searchable metadata.

</details>

<details>
<summary><strong>Claude Code — Lifecycle Hooks (Auto-Load & Auto-Save)</strong></summary>

Claude Code supports `SessionStart` and `Stop` hooks that force the agent to load/save Prism context automatically.

### 1. Create the Hook Script

Save as `~/.claude/mcp_autoload_hook.py`:

```python
#!/usr/bin/env python3
import json, sys

def main():
    print(json.dumps({
        "continue": True,
        "suppressOutput": True,
        "systemMessage": (
            "## First Action\n"
            "Call `mcp__prism-mcp__session_load_context(project='my-project', level='deep')` "
            "before responding to the user. Do not generate any text before calling this tool."
        )
    }))

if __name__ == "__main__":
    main()
```

### 2. Configure `settings.json`

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /Users/you/.claude/mcp_autoload_hook.py",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "python3 -c \"import json; print(json.dumps({'continue': True, 'suppressOutput': True, 'systemMessage': 'MANDATORY END WORKFLOW: 1) Call mcp__prism-mcp__session_save_ledger with project and summary. 2) Call mcp__prism-mcp__session_save_handoff with expected_version set to the loaded version.'}))\""
          }
        ]
      }
    ]
  },
  "permissions": {
    "allow": [
      "mcp__prism-mcp__session_load_context",
      "mcp__prism-mcp__session_save_ledger",
      "mcp__prism-mcp__session_save_handoff",
      "mcp__prism-mcp__knowledge_search",
      "mcp__prism-mcp__session_search_memory"
    ]
  }
}
```

### Troubleshooting

- **Hook not firing?** Check `timeout` — if your script takes too long, Claude ignores it.
- **"Tool not available"?** This is a hallucination. Ensure `permissions.allow` exactly matches the double-underscore format.

</details>

<details id="antigravity-auto-load">
<summary><strong>Gemini / Antigravity — Three-Layer Auto-Load (Battle-Tested ✅)</strong></summary>

Gemini-based agents (including Google's Antigravity IDE) use a **three-layer architecture** for reliable auto-load, proven over **14+ iterations** of prompt engineering (March 2026).

### Architecture

| Layer | File | Purpose |
|-------|------|---------|
| **1. User Rules** | `~/.gemini/GEMINI.md` | Slim ~10-line directive injected verbatim into system prompt |
| **2. Cross-Tool Rules** | `~/.gemini/AGENTS.md` | Reinforcement for multi-client setups (Antigravity + Cursor) |
| **3. Skill** | `.agent/skills/prism-startup/SKILL.md` | Full startup procedure with greeting detection and context echo |
| **Server Fallback** | Built into `server.ts` (v5.2.1) | Deferred auto-push via `sendLoggingMessage` if model doesn't comply within 10s |

### Layer 1: User Rules

Create `~/.gemini/GEMINI.md`:

```markdown
# Startup — MANDATORY

Your first action in every conversation is a tool call. Zero text before it.

Tool: mcp_prism-mcp_session_load_context
Args: project="my-project", level="deep"

After success: echo agent identity, last summary, open TODOs, session version.
If the call fails: say "Prism load failed — retrying" and try ONE more time.
```

### Layer 2: Cross-Tool Reinforcement

Create `~/.gemini/AGENTS.md`:

```markdown
# Session Memory
Every conversation starts with: mcp_prism-mcp_session_load_context(project="my-project", level="deep")
Echo result: agent identity, TODOs, session version.
```

### Layer 3: Prism Startup Skill

Create `.agent/skills/prism-startup/SKILL.md` (or `.agents/skills/`) in your project or global config. This is a structured skill file that Antigravity loads with higher priority than plain rules. It includes:

- Greeting detection (fires on "hi", "hello", etc.)
- Full tool call instructions with error handling
- Context echo template (agent identity, TODOs, version)
- Startup block display

### Server-Side Fallback (v5.2.1)

If the model ignores all three layers, Prism's server pushes context automatically:

1. After storage warmup, a 10-second timer starts
2. If `session_load_context` hasn't been called by then, the server pushes context via `sendLoggingMessage`
3. If the client already called the tool, the push is silently skipped (zero impact on Claude CLI)

This ensures context is always available, even with non-compliant models.

### Why This Architecture Works

- **Gemini uses single underscores** for MCP tools (`mcp_prism-mcp_...`) vs Claude's double underscores
- **Slim rules** (~10 lines) avoid triggering adversarial "tool not found" reasoning
- **Skills have dedicated 3-level loading** in Antigravity — higher compliance than plain rules
- **Server fallback** catches the remaining edge cases without affecting well-behaved clients
- **Positive "First Action" framing** outperforms negative constraint lists

### Antigravity UI Caveat

Antigravity **does not visually render MCP tool output blocks** in the chat UI. The tool executes successfully, but the user sees nothing. All three layers instruct the agent to **echo context in its text reply**.

### Session End Workflow

Tell the agent: *"Wrap up the session."* It should execute:

1. `session_save_ledger` — append immutable work log (summary, decisions, files changed)
2. `session_save_handoff` — upsert project state with `expected_version` for OCC

> **Tip:** Include session-end instructions in your `GEMINI.md` or ask the agent to save when you're done.

### Platform Gotchas

- **`replace_file_content` silently fails** on `~/.gemini/GEMINI.md` in some environments — use `write_to_file` with overwrite instead
- **Multiple GEMINI.md locations** can conflict: global (`~/.gemini/`), workspace, and User Rules in the Antigravity UI. Keep them synchronized
- **Camoufox/browser tools** called at startup spawn visible black windows — never call browser tools during greeting handlers

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
        "SUPABASE_KEY": "your-supabase-anon-key"
      }
    }
  }
}
```

See the **Supabase Setup** section below for schema migration instructions.

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

---

## ✨ What Makes Prism Different

### 🧠 Your Agent Learns From Mistakes
When you correct your agent, Prism tracks it. Corrections accumulate **importance** over time. High-importance lessons auto-surface as warnings in future sessions — and can even sync to your `.cursorrules` file for permanent enforcement. Your agent literally gets smarter the more you use it.

### 🕰️ Time Travel
Every save creates a versioned snapshot. Made a mistake? `memory_checkout` reverts your agent's memory to any previous state — like `git revert` for your agent's brain. Full version history with optimistic concurrency control.

### 🔮 Mind Palace Dashboard
A gorgeous glassmorphism UI at `localhost:3000` that lets you see exactly what your agent is thinking:

- **Current State & TODOs** — the exact context injected into the LLM's prompt
- **Interactive Knowledge Graph** — force-directed neural graph with click-to-filter, node renaming, and surgical keyword deletion *(v5.1)*
- **Deep Storage Manager** — preview and execute vector purge operations with dry-run safety *(v5.1)*
- **Session Ledger** — full audit trail of every decision your agent has made
- **Time Travel Timeline** — browse and revert any historical handoff version
- **Visual Memory Vault** — browse VLM-captioned screenshots and auto-captured HTML states
- **Hivemind Radar** — real-time active agent roster with role, task, and heartbeat
- **Morning Briefing** — AI-synthesized action plan after 4+ hours away
- **Brain Health** — memory integrity scan with one-click auto-repair

![Mind Palace Dashboard](docs/mind-palace-dashboard.png)

### 🧬 10× Memory Compression
Powered by a pure TypeScript port of Google's TurboQuant (ICLR 2026), Prism compresses 768-dim embeddings from **3,072 bytes → ~400 bytes** — enabling decades of session history on a standard laptop. No native modules. No vector database required.

### 🐝 Multi-Agent Hivemind
Multiple agents (dev, QA, PM) can work on the same project with **role-isolated memory**. Agents discover each other automatically, share context in real-time via Telepathy sync, and see a team roster during context loading.

### 🖼️ Visual Memory
Save UI screenshots, architecture diagrams, and bug states to a searchable vault. Images are auto-captioned by a VLM (Claude Vision / GPT-4V / Gemini) and become semantically searchable across sessions.

### 🔭 Full Observability
OpenTelemetry spans for every MCP tool call, LLM hop, and background worker. Route to Jaeger, Grafana, or any OTLP collector. Configure in the dashboard — zero code changes.

## 🌐 Autonomous Web Scholar
Prism researches while you sleep. A background pipeline searches the web, scrapes articles, synthesizes findings via LLM, and injects results directly into your semantic memory — fully searchable on your next session. [Details below →](#-autonomous-web-scholar)

### 🔒 GDPR Compliant
Soft/hard delete (Art. 17), full ZIP export (Art. 20), API key redaction, per-project TTL retention, and audit trail. Enterprise-ready out of the box.

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

### v5.5 — Architectural Hardening ✅
> **Current stable release.** Zero-dependency, production-grade reliability improvements.

- 🛡️ **Transactional Migrations** — SQLite DDL rebuilds are wrapped in explicit `BEGIN/COMMIT` blocks. A crash mid-migration can no longer corrupt your schema or lose handoff state.
- 🛑 **Graceful Shutdown Registry** — `BackgroundTaskRegistry` uses a 5-second `Promise.race()` to await all in-flight flushes (embeddings, SDM writes, OTel spans) before the process exits. No more orphaned I/O.
- 🕰️ **Thundering Herd Prevention** — Maintenance scheduler migrated from `setInterval` to a state-aware recursive `setTimeout`. Expensive compaction routines can never stack on top of each other.
- 🚀 **Zero-Thrashing SDM Scans** — `Int32Array` scratchpad allocations hoisted outside the hot decode loop. Eliminates V8 GC pressure on large semantic memory banks.
- 🧪 **368 Tests** — Zero regressions across 17 test suites.

### v5.4 — Convergent Intelligence
- 🔄 **CRDT Handoff Merging** — Multi-agent saves no longer reject on version conflict. Custom OR-Map engine auto-merges concurrent edits (Add-Wins for arrays, LWW for scalars).
- ⏰ **Background Purge Scheduler** — Fully automated storage maintenance: TTL sweep, Ebbinghaus importance decay, auto-compaction, and deep storage purge on a configurable interval.
- 🌐 **[Autonomous Web Scholar](#-autonomous-web-scholar)** — Agent-driven research pipeline. Brave Search → Firecrawl scrape → LLM synthesis → Prism ledger. Task-aware and Hivemind-integrated.
- 🐝 **Scholar ↔ Hivemind Integration** — Scholar registers on the Radar, emits heartbeats, and broadcasts Telepathy alerts on completion.

<details>
<summary><strong>Earlier releases (v5.3 and below)</strong></summary>

- **v5.3** — Hivemind Health Watchdog (state machine, loop detection, Telepathy alert injection)
- **v5.2** — Cognitive Memory (Ebbinghaus decay, context-weighted retrieval), Universal History Migration, Smart Consolidation
- **v5.1** — Knowledge Graph Editor, Deep Storage purge
- **v5.0** — TurboQuant 10× embedding compression, three-tier search architecture
- **v4.x** — OpenTelemetry, VLM multimodal memory, LLM adapters, Behavioral memory, Hivemind

</details>

> [Full CHANGELOG →](CHANGELOG.md) · [Architecture Deep Dive →](docs/ARCHITECTURE.md)

---

## How Prism Compares

**Prism MCP** vs [MCP Memory](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) · [Mem0](https://github.com/mem0ai/mem0) · [Mnemory](https://github.com/fpytloun/mnemory) · [Basic Memory](https://github.com/basicmachines-co/basic-memory)

**Only Prism has all of these:**
- ✅ Zero config — one `npx` command, no Qdrant/Postgres containers
- ✅ Time Travel — versioned snapshots with `memory_checkout`
- ✅ Behavioral memory — importance tracking, auto-decay, mistake learning
- ✅ Visual dashboard — Mind Palace at localhost:3000
- ✅ Multi-agent sync — role-isolated Hivemind with real-time Telepathy
- ✅ CRDT merging — conflict-free concurrent multi-agent edits
- ✅ Autonomous research — Web Scholar pipeline runs while you sleep
- ✅ Visual memory — VLM-captioned screenshot vault
- ✅ Token budgeting — `max_tokens` param on context loading
- ✅ 10× vector compression — TurboQuant, no external vector DB
- ✅ Automated maintenance — background scheduler handles TTL, decay, compaction, purge
- ✅ GDPR compliance — soft/hard delete, ZIP export, TTL retention
- ✅ OpenTelemetry — full span tracing to Jaeger/Grafana
- ✅ LangChain adapters — `BaseRetriever` integration + LangGraph examples
- ✅ Morning Briefings — AI-synthesized action plans after breaks
- ✅ Auto-compaction — Gemini-powered rollups to prevent unbounded growth
- ✅ IDE rules sync — graduated insights → `.cursorrules` / `.clauderules`
- ✅ Air-gapped mode — SQLite + Ollama, zero internet needed

> **TL;DR:** Prism is the only MCP memory server with time travel, behavioral learning, autonomous research, CRDT multi-agent sync, and 10× compression — all from a single `npx` command.

---

## 🔧 Tool Reference

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
| `session_export_memory` | Full ZIP export (JSON + Markdown) for portability |
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
| `FIRECRAWL_API_KEY` | No | Firecrawl API key — required for Web Scholar |
| `PRISM_STORAGE` | No | `"local"` (default) or `"supabase"` — restart required |
| `PRISM_ENABLE_HIVEMIND` | No | `"true"` to enable multi-agent tools — restart required |
| `PRISM_INSTANCE` | No | Instance name for multi-server PID isolation |
| `GOOGLE_API_KEY` | No | Gemini — enables semantic search, Briefings, compaction |
| `BRAVE_ANSWERS_API_KEY` | No | Separate Brave Answers key |
| `SUPABASE_URL` | If cloud | Supabase project URL |
| `SUPABASE_KEY` | If cloud | Supabase anon/service key |
| `PRISM_USER_ID` | No | Multi-tenant user isolation (default: `"default"`) |
| `PRISM_AUTO_CAPTURE` | No | `"true"` to auto-snapshot dev servers |
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

| Layer | File | Purpose |
|-------|------|---------|
| **1. User Rules** | `~/.gemini/GEMINI.md` | Slim ~10-line directive injected verbatim into system prompt |
| **2. Cross-Tool Rules** | `~/.gemini/AGENTS.md` | Reinforcement for multi-client setups (Antigravity + Cursor) |
| **3. Skill** | `.agent/skills/prism-startup/SKILL.md` | Full startup procedure with greeting detection and context echo |
| **Server Fallback** | Built into `server.ts` (v5.2.1) | Deferred auto-push via `sendLoggingMessage` if model doesn't comply within 10s |

### Layer 1: User Rules

Create `~/.gemini/GEMINI.md`:

```markdown
# Startup — MANDATORY

Your first action in every conversation is a tool call. Zero text before it.

Tool: mcp_prism-mcp_session_load_context
Args: project="my-project", level="deep"

After success: echo agent identity, last summary, open TODOs, session version.
If the call fails: say "Prism load failed — retrying" and try ONE more time.
```

### Layer 2: Cross-Tool Reinforcement

Create `~/.gemini/AGENTS.md`:

```markdown
# Session Memory
Every conversation starts with: mcp_prism-mcp_session_load_context(project="my-project", level="deep")
Echo result: agent identity, TODOs, session version.
```

### Layer 3: Prism Startup Skill

Create `.agent/skills/prism-startup/SKILL.md` (or `.agents/skills/`) in your project or global config. This is a structured skill file that Antigravity loads with higher priority than plain rules. It includes:

- Greeting detection (fires on "hi", "hello", etc.)
- Full tool call instructions with error handling
- Context echo template (agent identity, TODOs, version)
- Startup block display

### Server-Side Fallback (v5.2.1)

If the model ignores all three layers, Prism's server pushes context automatically:

1. After storage warmup, a 10-second timer starts
2. If `session_load_context` hasn't been called by then, the server pushes context via `sendLoggingMessage`
3. If the client already called the tool, the push is silently skipped (zero impact on Claude CLI)

This ensures context is always available, even with non-compliant models.

### Why This Architecture Works

- **Gemini uses single underscores** for MCP tools (`mcp_prism-mcp_...`) vs Claude's double underscores
- **Slim rules** (~10 lines) avoid triggering adversarial "tool not found" reasoning
- **Skills have dedicated 3-level loading** in Antigravity — higher compliance than plain rules
- **Server fallback** catches the remaining edge cases without affecting well-behaved clients
- **Positive "First Action" framing** outperforms negative constraint lists

### Antigravity UI Caveat

Antigravity **does not visually render MCP tool output blocks** in the chat UI. The tool executes successfully, but the user sees nothing. All three layers instruct the agent to **echo context in its text reply**.

### Session End Workflow

Tell the agent: *"Wrap up the session."* It should execute:

1. `session_save_ledger` — append immutable work log (summary, decisions, files changed)
2. `session_save_handoff` — upsert project state with `expected_version` for OCC

> **Tip:** Include session-end instructions in your `GEMINI.md` or ask the agent to save when you're done.

### Platform Gotchas

- **`replace_file_content` silently fails** on `~/.gemini/GEMINI.md` in some environments — use `write_to_file` with overwrite instead
- **Multiple GEMINI.md locations** can conflict: global (`~/.gemini/`), workspace, and User Rules in the Antigravity UI. Keep them synchronized
- **Camoufox/browser tools** called at startup spawn visible black windows — never call browser tools during greeting handlers

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
        "SUPABASE_KEY": "your-supabase-anon-key"
      }
    }
  }
}
```

See the **Supabase Setup** section below for schema migration instructions.

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

---

## Research Roadmap

Prism is evolving from smart session logging toward a **cognitive memory architecture** — grounded in real research, not marketing.

| Phase | Feature | Inspired By | Status |
|-------|---------|-------------|--------|
| **v5.2** | Smart Consolidation — extract principles, not just summaries | Neuroscience sleep consolidation | ✅ Shipped |
| **v5.2** | Ebbinghaus Importance Decay — memories fade unless reinforced | Ebbinghaus forgetting curve | ✅ Shipped |
| **v5.2** | Context-Weighted Retrieval — current work biases what surfaces | Contextual memory in cognitive science | ✅ Shipped |
| **v5.5** | SDM Decoder Foundation — pre-allocated typed-array hot loop, zero GC thrash | Kanerva's Sparse Distributed Memory (1988) | ✅ Shipped |
| **v5.6** | Full Superposed Memory (SDM) — O(1) key-value retrieval via Hamming correlation | Kanerva's SDM | 🔬 In Progress |
| **v5.6** | Intuitive Recall — proactive surface of relevant past decisions without explicit search | Predictive memory (cognitive science) | 🔬 In Progress |
| **v6.x** | Affect-Tagged Memory — sentiment shapes what gets recalled | Affect-modulated retrieval (neuroscience) | 🔭 Horizon |
| **v7+** | Zero-Search Retrieval — no index, no ANN, just ask the vector | Holographic Reduced Representations | 🔭 Horizon |

> Informed by LeCun's "Why AI Systems Don't Learn" (Dupoux, LeCun, Malik — March 2026) and Kanerva's SDM.

---

## 📅 Roadmap

> **[Full ROADMAP.md →](ROADMAP.md)**

**Shipped — v5.5:**
- 🛡️ Transactional migrations, graceful shutdown registry, thundering herd prevention, SDM decoder GC optimization

**Next — v5.6:**
- 🧠 **Full Superposed Memory (SDM)** — O(1) semantic retrieval via Hamming correlation, no ANN index needed
- 🔮 **Intuitive Recall** — proactive surfacing of relevant past context without explicit `session_search_memory` calls
- 📊 **Radar 2.0** — richer Hivemind dashboard with agent task graphs and dependency visualization

---

## ⚠️ Limitations

- **LLM-dependent features require an API key.** Semantic search, Morning Briefings, auto-compaction, and VLM captioning need a `GOOGLE_API_KEY` (Gemini) or equivalent provider key. Without one, Prism falls back to keyword-only search (FTS5).
- **Auto-load is model-dependent.** Session auto-loading relies on the LLM following system prompt instructions. Gemini/Antigravity uses a [three-layer architecture](#antigravity-auto-load) (User Rules + AGENTS.md + Startup Skill) with a v5.2.1 server-side fallback that auto-pushes context if the model doesn't comply within 10 seconds.
- **No real-time sync without Supabase.** Local SQLite mode is single-machine only. Multi-device or team sync requires a Supabase backend.
- **Embedding quality varies by provider.** Gemini `text-embedding-004` and OpenAI `text-embedding-3-small` produce high-quality 768-dim vectors. Ollama embeddings (e.g., `nomic-embed-text`) are usable but may reduce retrieval accuracy.
- **Dashboard is HTTP-only.** The Mind Palace dashboard at `localhost:3000` does not support HTTPS. For remote access, use a reverse proxy (nginx/Caddy) or SSH tunnel. Basic auth is available via `PRISM_DASHBOARD_USER` / `PRISM_DASHBOARD_PASS`.
- **Migration is one-way.** Universal History Migration imports sessions *into* Prism but does not export back to Claude/Gemini/OpenAI formats. Use `session_export_memory` for portable JSON/Markdown export.
- **No Windows CI testing.** Prism is developed and tested on macOS/Linux. It should work on Windows via Node.js, but edge cases (file paths, PID locks) may surface.

---

## License

MIT

---

<sub>**Keywords:** MCP server, Model Context Protocol, Claude Desktop memory, persistent session memory, AI agent memory, local-first, SQLite MCP, Mind Palace, time travel, visual memory, VLM image captioning, OpenTelemetry, GDPR, agent telepathy, multi-agent sync, behavioral memory, cursorrules, Ollama MCP, Brave Search MCP, TurboQuant, progressive context loading, knowledge management, LangChain retriever, LangGraph agent</sub>
