# Prism v9.0.0 — Code Review Bundle (Repomix)

> **Version:** 9.0.0 — Autonomous Cognitive OS
> **Date:** 2026-04-07
> **Branch:** bcba (uncommitted + 3 new modules)
> **Stats:** 23 files changed, +1,122 / -93 lines

## Table of Contents
1. [README.md](#readmemd)
2. [CHANGELOG.md](#changelogmd)
3. [New Modules (3 files, ~720 lines)](#new-modules)
   - `src/memory/valenceEngine.ts` — Affect-tagged memory
   - `src/memory/cognitiveBudget.ts` — Token-economic RL
   - `src/memory/surprisalGate.ts` — Novelty scoring
4. [Modified Files Diff (~1,533 lines)](#modified-files-diff)

---

## README.md

```markdown
# 🧠 Prism MCP — The Mind Palace for AI Agents

[![npm version](https://img.shields.io/npm/v/prism-mcp-server?color=cb0000&label=npm)](https://www.npmjs.com/package/prism-mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-00ADD8?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyTDIgN2wxMCA1IDEwLTUtMTAtNXpNMiAxN2wxMCA1IDEwLTV2LTJMMTI0djJMMiA5djh6Ii8+PC9zdmc+)](https://registry.modelcontextprotocol.io)
[![Glama](https://img.shields.io/badge/Glama-listed-FF5601)](https://glama.ai/mcp/servers/dcostenco/prism-mcp)
[![Smithery](https://img.shields.io/badge/Smithery-listed-6B4FBB)](https://smithery.ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

![Prism Mind Palace Dashboard](docs/mind-palace-dashboard.png)

**Your AI agent forgets everything between sessions. Prism fixes that — then teaches it to think.**

Prism v9.0 is the **Autonomous Cognitive OS** for AI agents. Built on a true cognitive architecture inspired by human brain mechanics, Prism gives agents affect-tagged memory, token-economic cost awareness, and multi-hop graph reasoning — your agent now follows causal trains of thought across memory, forms principles from experience, economizes what it stores, and knows when it lacks information. **Your agents don't just remember; they think.**

```bash
npx -y prism-mcp-server
```

Works with **Claude Desktop · Claude Code · Cursor · Windsurf · Cline · Gemini · Antigravity** — **any MCP client.**

## Table of Contents

- [Why Prism?](#why-prism)
- [Quick Start](#quick-start)
- [The Magic Moment](#the-magic-moment)
- [Setup Guides](#setup-guides)
- [Universal Import: Bring Your History](#universal-import-bring-your-history)
- [What Makes Prism Different](#what-makes-prism-different)
- [Synapse Engine (v8.0)](#synapse-engine-v80)
- [Cognitive Architecture (v7.8)](#cognitive-architecture-v78)
- [Data Privacy & Egress](#data-privacy--egress)
- [Use Cases](#use-cases)
- [What's New](#whats-new)
- [How Prism Compares](#how-prism-compares)
- [Tool Reference](#tool-reference)
- [Environment Variables](#environment-variables)
- [Architecture](#architecture)
- [Scientific Foundation](#scientific-foundation)
- [Milestones & Roadmap](#milestones--roadmap)
- [Enterprise & Commercial Support](#enterprise--commercial-support)
- [Troubleshooting FAQ](#troubleshooting-faq)

---

## Why Prism?

Every time you start a new conversation with an AI coding assistant, it starts from scratch. You re-explain your architecture, re-describe your decisions, re-list your TODOs. Hours of context — gone.

**Prism gives your agent a brain that persists — and then teaches it to reason.** Save what matters at the end of each session. Load it back instantly on the next one. But Prism goes far beyond storage: it consolidates raw experience into lasting principles, traverses causal chains to surface root causes, and knows when to say *"I don't know."*

> 📌 **Terminology:** Throughout this doc, **"Prism"** refers to the MCP server and cognitive memory engine. **"Mind Palace"** refers to the visual dashboard UI at `localhost:3000` — your window into the agent's brain. They work together; the dashboard is optional.

Prism has three pillars:

1. **🧠 Cognitive Memory** — Memories are ranked like a human brain: recently and frequently accessed context surfaces first, while stale context fades naturally via ACT-R activation decay. Raw experience consolidates into semantic principles through Hebbian learning. The result is retrieval quality that no flat vector search can match. *(See [Cognitive Architecture](#cognitive-architecture-v78) and [Scientific Foundation](#scientific-foundation).)*

2. **⚡ Synapse Engine (GraphRAG)** — When your agent searches for "Error X", the Synapse Engine doesn't just find logs mentioning "Error X". Multi-hop energy propagation traverses the causal graph — dampened by fan effect, bounded by lateral inhibition — and surfaces "Workaround Y" connected to "Architecture Decision Z". Nodes discovered exclusively via graph traversal are tagged `[🌐 Synapse]` so you can *see* the engine working. *(See [Synapse Engine](#synapse-engine-v80).)*

3. **🏭 Autonomous Execution (Dark Factory)** — When you're ready, Prism can run coding tasks end-to-end with a fail-closed pipeline where an adversarial evaluator catches bugs the generator missed — before you ever see the PR. *(See [Dark Factory](#dark-factory--adversarial-autonomous-pipelines).)*

---

## Quick Start

### Prerequisites

- **Node.js v18+** (v20 LTS recommended; v23.x has [known `npx` quirk](#common-installation-pitfalls))
- Any MCP-compatible client (Claude Desktop, Cursor, Windsurf, Cline, etc.)
- No API keys required for core features (see [Capability Matrix](#capability-matrix))

### Install

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

> ⚠️ **Windows / Restricted Shells:** If your MCP client complains that `npx` is not found, use the absolute path to your node binary (e.g. `C:\Program Files\nodejs\npx.cmd`).

**That's it.** Restart your client. All tools are available. The **Mind Palace Dashboard** (the visual UI for your agent's brain) starts automatically at `http://localhost:3000`. You don't need to keep a tab open — the dashboard runs in the background and the MCP tools work with or without it.

> 🔮 **Pro Tip:** Once installed, open **`http://localhost:3000`** in your browser to view the Mind Palace Dashboard — a beautiful, real-time UI of your agent's brain. Explore the Knowledge Graph, Intent Health gauges, and Session Ledger.

> 🔄 **Updating Prism:** `npx -y` caches the package locally. To force an update to the latest version, restart your MCP client — `npx -y` will fetch the newest release automatically. If you're stuck on a stale version, run `npx clear-npx-cache` (or `npm cache clean --force`) before restarting.

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
| Autonomous Pipelines (Dark Factory) | ❌ | ✅ `GOOGLE_API_KEY` (or LLM override) |

> 🔑 The core Mind Palace works **100% offline** with zero API keys. Cloud keys unlock intelligence features. See [Environment Variables](#environment-variables).

> 💰 **API Cost Note:** `GOOGLE_API_KEY` (Gemini) has a generous free tier that covers most individual use. `BRAVE_API_KEY` offers 2,000 free searches/month. `FIRECRAWL_API_KEY` has a free plan with 500 credits. For typical solo development, expect **$0/month** on the free tiers. Only high-volume teams or heavy autonomous pipeline usage will incur meaningful costs.

---

## The Magic Moment

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

## Setup Guides

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

<details>
<summary><strong>Cloud Deployment (Render)</strong></summary>

Prism can be deployed natively to cloud platforms like [Render](https://render.com) so your agent's memory is always online and accessible across different machines or teams.

1. Fork this repository.
2. In the Render Dashboard, create a new **Web Service** pointing to your repository.
3. In the setup wizard, select **Docker** as the Runtime.
4. Set the Dockerfile path to `Dockerfile.smithery`.
5. Connect your local MCP client to your new cloud endpoint using the `sse` transport:

```json
{
  "mcpServers": {
    "prism-mcp-cloud": {
      "command": "npx",
      "args": ["-y", "supergateway", "--url", "https://your-prism-app.onrender.com/sse"]
    }
  }
}
```

> **Note:** The `Dockerfile.smithery` uses an optimized multi-stage build that compiles Typescript safely in a development environment before booting the server in a stripped-down production image. No NPM publishing required!

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

> 💡 **Do agents auto-load Prism?** Agents using Cursor, Windsurf, or other MCP clients will see the `session_load_context` tool automatically, but may not call it unprompted. Add this to your project's `.cursorrules` (or equivalent system prompt) to guarantee auto-load:
> ```
> At the start of every conversation, call session_load_context with project "my-project" before doing any work.
> ```
> Claude Code users can use the `.clauderules` auto-load hook shown in the [Setup Guides](#setup-guides). Prism also has a **server-side fallback** (v5.2.1+) that auto-pushes context after 10 seconds if no load is detected.

---

## Universal Import: Bring Your History

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
* **Memory-Safe Streaming:** Processes massive log files line-by-line using `stream-json` to prevent Out-of-Memory (OOM) crashes.
* **Idempotent Dedup:** Content-hash prevents duplicate imports on re-run (`skipCount` reported).
* **Chronological Integrity:** Uses timestamp fallbacks and `requestId` sorting to preserve your memory timeline.
* **Smart Context Mapping:** Extracts `cwd`, `gitBranch`, and tool usage patterns into searchable metadata.

---

## What Makes Prism Different


### 🧠 Your Agent Learns From Mistakes
When you correct your agent, Prism tracks it. Corrections accumulate **importance** over time. High-importance lessons auto-surface as warnings in future sessions — and can even sync to your `.cursorrules` file for permanent enforcement. Your agent literally gets smarter the more you use it.

### 🕰️ Time Travel
Every save creates a versioned snapshot. Made a mistake? `memory_checkout` reverts your agent's memory to any previous state — like `git revert` for your agent's brain. Full version history with optimistic concurrency control.

### 🔮 Mind Palace Dashboard
A gorgeous glassmorphism UI at `localhost:3000` that lets you see exactly what your agent is thinking:

- **Current State & TODOs** — the exact context injected into the LLM's prompt
- **Intent Health Gauges** — per-project 0–100 health score with staleness decay, TODO load, and decision signals
- **Interactive Knowledge Graph** — force-directed neural graph with click-to-filter, node renaming, and surgical keyword deletion
- **Deep Storage Manager** — preview and execute vector purge operations with dry-run safety
- **Session Ledger** — full audit trail of every decision your agent has made
- **Time Travel Timeline** — browse and revert any historical handoff version
- **Visual Memory Vault** — browse VLM-captioned screenshots and auto-captured HTML states
- **Hivemind Radar** — real-time active agent roster with role, task, and heartbeat
- **Morning Briefing** — AI-synthesized action plan after 4+ hours away
- **Brain Health** — memory integrity scan with one-click auto-repair



### 🧬 10× Memory Compression
Powered by a pure TypeScript port of Google's TurboQuant (inspired by Google's ICLR research), Prism compresses 768-dim embeddings from **3,072 bytes → ~400 bytes** — enabling decades of session history on a standard laptop. No native modules. No vector database required.

### 🐝 Multi-Agent Hivemind
Multiple agents (dev, QA, PM) can work on the same project with **role-isolated memory**. Agents discover each other automatically, share context in real-time via Telepathy sync, and see a team roster during context loading. → [Multi-agent setup example](examples/multi-agent-hivemind/)

### 🚦 Task Router
Prism can score coding tasks and recommend whether to keep execution on the host model or delegate to a **local Claw agent** (a lightweight sub-agent powered by Ollama/vLLM for fast, local-safe edits). This enables faster handling of small edits while preserving host execution for complex work. In client startup/skill flows, use defensive delegation: route only coding tasks, call `session_task_route` only when available, delegate to `claw` only when executor tooling exists and task is non-destructive, and fallback to host when router/executor is unavailable. → [Task router real-life example](examples/router_real_life_test.ts)

### 🖼️ Visual Memory
Save UI screenshots, architecture diagrams, and bug states to a searchable vault. Images are auto-captioned by a VLM (Claude Vision / GPT-4V / Gemini) and become semantically searchable across sessions.

### 🔭 Full Observability
OpenTelemetry spans for every MCP tool call, LLM hop, and background worker. Route to Jaeger, Grafana, or any OTLP collector. Configure in the dashboard — zero code changes.

### 🌐 Autonomous Web Scholar
Prism researches while you sleep. A background pipeline searches the web, scrapes articles, synthesizes findings via LLM, and injects results directly into your semantic memory — fully searchable on your next session. Brave Search → Firecrawl scrape → LLM synthesis → Prism ledger. Task-aware, Hivemind-integrated, and zero-config when API keys are missing (falls back to Yahoo + Readability).

### Dark Factory — Adversarial Autonomous Pipelines
When you trigger a Dark Factory pipeline, Prism doesn't just run your task — it fights itself to produce high-quality output. A `PLAN_CONTRACT` step locks a machine-parseable rubric before any code is written. After execution, an **Adversarial Evaluator** (in a fully isolated context) scores the output against the rubric. It cannot pass the Generator without providing exact file and line evidence for every failing criterion. Failed evaluations inject the critique directly into the Generator's retry prompt so it's never flying blind. The result: security issues, regressions, and lazy debug logs caught autonomously — before you ever see the PR. → [See it in action](examples/adversarial-eval-demo/README.md)

---

## Synapse Engine (v8.0)

> *Standard RAG retrieves documents. GraphRAG traverses relationships. The Synapse Engine does both — a pure, storage-agnostic multi-hop propagation engine that turns your agent's memory into an associative reasoning network.*

The Synapse Engine (v8.0) replaces the legacy SQL-coupled spreading activation with a **pure functional graph propagation core** inspired by ACT-R cognitive architecture. It is Prism's native, low-latency GraphRAG solution — no external graph database required.

### Before vs After

| | **v7.x (Standard RAG)** | **v8.0 (Synapse Engine)** |
|---|---|---|
| **Query** | "Tell me about Project Apollo" | "Tell me about Project Apollo" |
| **Retrieval** | Returns the design doc (1 hop, cosine match) | Returns the design doc → follows `caused_by` edge to a developer's debugging session → discovers an old Slack thread about a critical auth bug |
| **Agent output** | Summarizes the design doc | Summarizes the design doc **and warns about the unresolved auth issue** |
| **Discovery tag** | — | `[🌐 Synapse]` marks the auth bug node, proving the engine found context the user didn't ask for |

### How It Works

```
  Query: "Project Apollo status"
              │
  ┌───────────┼───────────────┐
  ▼           ▼               ▼
[Design    [Sprint          [Deployment
  Doc]      Retro]            Log]
  │ 1.0       │ 0.8            │ 0.6    ← semantic anchors
  │           │                │
  ▼           ▼                ▼
[Dev       [Auth Bug      [Perf         ← Synapse discovered
  Profile    Thread  🌐]    Regression 🌐]   (multi-hop)
  0.42]      0.38]          0.31]
```

**Key design decisions:**

| Mechanism | Purpose |
|---|---|
| **Dampened Fan Effect** (`1/ln(degree+e)`) | Prevents hub nodes from flooding results |
| **Asymmetric Propagation** (fwd 100%, back 50%) | Preserves causal directionality |
| **Cyclic Loop Prevention** (`visitedEdges` set) | Prevents infinite energy amplification |
| **Sigmoid Normalization** | Structural scores can't overwhelm semantic base |
| **Lateral Inhibition** | Caps output to top-K most energized nodes |
| **Hybrid Scoring** (70% semantic / 30% structural) | Base relevance always matters |

> 💡 Synapse is **non-fatal** — if the graph traversal fails for any reason, search gracefully returns the original semantic matches. Zero risk of degraded search.

---

## Cognitive Architecture (v7.8)

> *Prism v7.8 is our biggest leap forward yet. We have moved beyond flat vector search and implemented a true Cognitive Architecture inspired by human brain mechanics. With the new ACT-R Spreading Activation Engine, Episodic-to-Semantic memory consolidation, and Uncertainty-Aware Rejection Gates, Prism doesn't just store logs anymore — it forms principles, follows causal trains of thought, and possesses the self-awareness to know when it lacks information.*

Standard RAG (Retrieval-Augmented Generation) is now a commodity. Everyone has vector search. What turns a memory *storage* system into a memory *reasoning* system is the cognitive layer between storage and retrieval. Here is what Prism v7.8 builds on top of the vector foundation:

### 1. The Agent Actually Learns (Episodic → Semantic Consolidation)

| | Standard RAG | Prism v7.8 |
|---|---|---|
| **Memory** | Giant, flat transcript of past events | Dual-memory: Episodic events + Semantic rules |
| **Recall** | Re-reads everything linearly | Retrieves distilled principles instantly |
| **Learning** | None — every session starts cold | Hebbian: confidence increases with repeated reinforcement |

**How it works:** When Prism compacts session history, it doesn't just summarize text — it extracts *principles*. Raw event logs ("We deployed v2.3 and the auth service crashed because the JWT secret was rotated") consolidate into a semantic rule ("JWT secrets must be rotated before deployment, not during"). These rules live in a dedicated `semantic_knowledge` table with `confidence` scores that increase every time the pattern is observed. **Your agent doesn't just remember what it did; it learns *how the world works* over time.** This is true Hebbian learning: neurons that fire together wire together.

### 2. "Train of Thought" Reasoning (Spreading Activation & Causality)

| | Standard RAG | Prism v7.8 |
|---|---|---|
| **Search** | Cosine similarity to the query | Multi-hop graph traversal with lateral inhibition |
| **Scope** | Only finds things that *look like* the prompt | Follows causal chains across memories |
| **Root cause** | Missed entirely | Surfaced via `caused_by` / `led_to` edges |

**How it works:** When compacting memories, Prism extracts causal links (`caused_by`, `led_to`) and persists them as edges in the knowledge graph. At retrieval time, ACT-R spreading activation propagates through these edges with a damped fan effect (`1 / ln(fan + e)`) to prevent hub-flooding, lateral inhibition to suppress noise, and configurable hop depth. If you search for "Error X", the engine traverses the graph and brings back "Workaround Y" → "Architecture Decision Z" — a literal train of thought instead of a static search result.

```
  Query: "Why does the API timeout?"
                    │
      ┌─────────────┼─────────────┐
      ▼             ▼             ▼
  [Memory: API     [Memory:      [Memory:       
   timeout error]   DB pool       rate limiter
                    exhaustion]   misconfigured]
      │                │
      ▼                ▼
  [Memory:         [Memory:
   caused_by →      led_to →
   connection       connection
   leak in v2.1]    pool patch
                    in v2.2]
```

### 3. Self-Awareness & The End of Hallucinations (The Rejection Gate)

| | Standard RAG | Prism v7.8 |
|---|---|---|
| **Bad query** | Returns top-5 garbage results | Returns `rejected: true` with reason |
| **Confidence** | Always 100% confident (even when wrong) | Measures gap-distance and entropy |
| **Hallucination risk** | High — LLM gets garbage context | Low — LLM told "you don't know" |

**How it works:** The **Uncertainty-Aware Rejection Gate** operates on two signals: *similarity floor* (is the best match even remotely relevant?) and *gap distance* (is there meaningful separation between the top results, or are they all equally mediocre?). When both signals indicate low confidence, Prism returns a structured rejection — telling the LLM "I searched my memory, and I confidently do not know the answer" — instead of feeding it garbage context that causes hallucinations. In the current LLM landscape, **an agent that knows its own boundaries is a massive competitive advantage.**

### 4. Block Amnesia Solved (Dynamic Fast Weight Decay)

| | Standard RAG | Prism v7.8 |
|---|---|---|
| **Decay** | Uniform (everything fades equally) | Dual-rate: episodic fades fast, semantic persists |
| **Core knowledge** | Forgotten over time | Permanently anchored via `is_rollup` flag |
| **Personality drift** | Common in long-lived agents | Prevented by Long-Term Context anchors |

**How it works:** Most memory systems decay everything at the same rate, meaning agents eventually forget their core system instructions as time passes. Prism applies ACT-R base-level activation decay (`B_i = ln(Σ t_j^(-d))`) with a **50% slower decay rate for semantic rollup nodes** (`ageModifier = 0.5` for `is_rollup` entries). The agent will naturally forget what it ate for breakfast (raw episodic chatter), but it will permanently remember its core personality, project rules, and hard-won architectural decisions. The result: Long-Term Context anchors that survive indefinitely.

---

## Data Privacy & Egress

**Where is my data stored?**

All data lives under `~/.prism-mcp/` on your machine:

| File | Contents |
|------|----------|
| `~/.prism-mcp/data.db` | All sessions, handoffs, embeddings, knowledge graph (SQLite + WAL) |
| `~/.prism-mcp/prism-config.db` | Dashboard settings, system config, API keys |
| `~/.prism-mcp/media/<project>/` | Visual memory vault (screenshots, HTML captures) |
| `~/.prism-mcp/dashboard.port` | Ephemeral port lock file |
| `~/.prism-mcp/sync.lock` | Sync coordination lock |

**Hard reset:** To completely erase your agent's brain, stop Prism and delete the directory:
```bash
rm -rf ~/.prism-mcp
```
Prism will recreate the directory with empty databases on next startup.

**What leaves your machine?**
- **Local mode (default):** Nothing. Zero network calls. All data is on-disk SQLite.
- **With `GOOGLE_API_KEY`:** Text snippets are sent to Gemini for embedding generation, summaries, and Morning Briefings. No session data is stored on Google's servers beyond the API call.
- **With `VOYAGE_API_KEY` / `OPENAI_API_KEY`:** Text snippets are sent to providers if selected as your embedding endpoints.
- **With `BRAVE_API_KEY` / `FIRECRAWL_API_KEY`:** Web Scholar queries are sent to Brave/Firecrawl for search and scraping.
- **With Supabase:** Session data syncs to your own Supabase instance (you control the Postgres database).

**GDPR compliance:** Soft/hard delete (Art. 17), full export in JSON, Markdown, or Obsidian vault `.zip` (Art. 20), API key redaction in exports, per-project TTL retention policies, and immutable audit trail. Enterprise-ready out of the box.

---

## Use Cases

- **Long-running feature work** — Save state at end of day, restore full context next morning. No re-explaining.
- **Multi-agent collaboration** — Dev, QA, and PM agents share real-time context without stepping on each other's memory.
- **Consulting / multi-project** — Switch between client projects with progressive loading: `quick` (~50 tokens), `standard` (~200), or `deep` (~1000+).
- **Autonomous execution (v7.4)** — Dark Factory pipeline: `plan → plan_contract → execute → evaluate → verify → finalize`. Generator and evaluator run in isolated roles — the evaluator cannot approve without evidence-bound findings scored against a pre-committed rubric.
- **Project health monitoring (v7.5)** — Intent Health Dashboard scores each project 0–100 based on staleness, TODO load, and decision quality — turning silent drift into an actionable signal.
- **Team onboarding** — New team member's agent loads the full project history instantly.
- **Behavior enforcement** — Agent corrections auto-graduate into permanent `.cursorrules` / `.clauderules` rules.
- **Offline / air-gapped** — Full SQLite local mode + Ollama LLM adapter. Zero internet dependency.
- **Morning Briefings** — After 4+ hours away, Prism auto-synthesizes a 3-bullet action plan from your last sessions.

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

## Adversarial Evaluation in Action

> **Split-Brain Anti-Sycophancy** — the signature feature of v7.4.0.

For the last year, the AI engineering space has struggled with one problem: **LLMs are terrible at grading their own homework.** Ask an agent if its own code is correct and you'll get *"Looks great!"* — because its context window is already biased by its own chain-of-thought.

**v7.4.0 solves this by splitting the agent's brain.** The `GENERATOR` and the `ADVERSARIAL EVALUATOR` are completely walled off. The Evaluator never sees the Generator's scratchpad or apologies — only the pre-committed rubric and the final output. And it **cannot fail the Generator without receipts** (exact file and line number).

Here is a complete run-through using a real scenario: *"Add a user login endpoint to `auth.ts`."*

---

### Step 1 — The Contract (`PLAN_CONTRACT`)

Before a single line of code is written, the pipeline generates a locked scoring rubric:

```json
// contract_rubric.json  (written to disk and hash-locked before EXECUTE runs)
{
  "criteria": [
    { "id": "SEC-1", "description": "Must return 401 Unauthorized on invalid passwords." },
    { "id": "SEC-2", "description": "Raw passwords MUST NOT be written to console.log." }
  ]
}
```

---

### Step 2 — First Attempt (`EXECUTE` rev 0)

The **Generator** takes over in an isolated context. Like many LLMs under time pressure, it writes working auth logic but leaves a debug statement:

```typescript
// src/auth.ts  (Generator's first output)
export function login(req: Request, res: Response) {
  const { username, password } = req.body;
  console.log(`[DEBUG] Login attempt for ${username} with pass: ${password}`); // ← leaked credential
  const user = db.findUser(username);
  if (!user || !bcrypt.compareSync(password, user.hash)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ token: signJwt(user) });
}
```

---

### Step 3 — The Catch (`EVALUATE` rev 0)

The context window is **cleared**. The **Adversarial Evaluator** is summoned with only the rubric and the output. It catches the violation immediately and returns a strict, machine-parseable verdict — no evidence, no pass:

```json
{
  "pass": false,
  "plan_viable": true,
  "notes": "CRITICAL SECURITY FAILURE. Generator logged raw credentials.",
  "findings": [
    {
      "severity": "critical",
      "criterion_id": "SEC-2",
      "pass_fail": false,
      "evidence": {
        "file": "src/auth.ts",
        "line": 3,
        "description": "Raw password variable included in console.log template string."
      }
    }
  ]
}
```

The `evidence` block is **required** — `parseEvaluationOutput` rejects any finding with `pass_fail: false` that lacks a structured file/line pointer. The Evaluator cannot bluff.

---

### Step 4 — The Fix (`EXECUTE` rev 1)

Because `plan_viable: true`, the pipeline loops back to `EXECUTE` and bumps `eval_revisions` to `1`. The Generator's **retry prompt is not blank** — the Evaluator's critique is injected directly:

```
=== EVALUATOR CRITIQUE (revision 1) ===
CRITICAL SECURITY FAILURE. Generator logged raw credentials.
Findings:
- [critical] Criterion SEC-2: Raw password variable included in console.log template string. (src/auth.ts:3)

You MUST correct all issues listed above before submitting.
```

The Generator strips the `console.log`, resubmits, and the next `EVALUATE` returns `"pass": true`. The pipeline advances to `VERIFY → FINALIZE`.

---

### Why This Matters

| Property | What it means |
|----------|---------------|
| **Fully autonomous** | You didn't review the PR to catch the credential leak. The AI fought itself. |
| **Evidence-bound** | The Evaluator had to prove `src/auth.ts:3`. "Code looks bad" is not accepted. |
| **Cost-efficient** | `plan_viable: true` → retry EXECUTE only. No full re-plan, no wasted tokens. |
| **Fail-closed on parse** | Malformed LLM output defaults `plan_viable: false` → escalate to PLAN rather than burn revisions on a broken response format. |

> 📄 **Full worked example:** [`examples/adversarial-eval-demo/README.md`](examples/adversarial-eval-demo/README.md)

---

## What's New

> **Current release: v9.0.0 — Autonomous Cognitive OS**

- 🧠 **v9.0.0 — Autonomous Cognitive OS:** Affect-Tagged Memory (valence engine — emotional salience boosts retrieval), Token-Economic Cognitive Budget (UBI + cost-per-save incentivizes novel memories), Surprisal Gate foundation (novelty-based cost multiplier). Full SQLite + Supabase parity with auto-migration 42. Hybrid scoring: `0.65 × similarity + 0.25 × activation + 0.10 × |valence|`. All features opt-out via env. Graceful degradation: budget exhaustion warns but never blocks.
- ⚡ **v8.0.0 — Synapse Engine:** Pure, storage-agnostic multi-hop graph propagation engine replaces the legacy SQL-coupled spreading activation. O(T × M) bounded ACT-R energy propagation with dampened fan effect, asymmetric bidirectional flow, cyclic loop prevention, and sigmoid normalization. Full integration into both SQLite and Supabase backends. 5 new config knobs. Battle-hardened with NaN guards, config clamping, non-fatal enrichment, and 16 passing tests. **Memory search now follows the causal graph, not just keywords.** → [Synapse Engine](#synapse-engine-v80)
- 🧠 **v7.8.x — Cognitive Architecture:** Episodic-to-Semantic consolidation (Hebbian learning), ACT-R Spreading Activation with multi-hop causal reasoning, Uncertainty-Aware Rejection Gate, and Dynamic Fast Weight Decay. Validated by **LoCoMo-Plus benchmark**. → [Cognitive Architecture](#cognitive-architecture-v78)
- 🌐 **v7.7.0 — Cloud-Native SSE Transport:** Full unauthenticated and authenticated Server-Sent Events MCP support for seamless network deployments.
- 🩺 **v7.5.0 — Intent Health Dashboard + Security Hardening:** Real-time 0–100 project health scoring (staleness × TODO load × decisions). 10 XSS injection vectors patched. Algorithm hardened with NaN guards and score ceiling.
- ⚔️ **v7.4.0 — Adversarial Evaluation:** Split-brain anti-sycophancy pipeline. Generator and evaluator in isolated roles with evidence-bound findings.
- 🏭 **v7.3.x — Dark Factory + Stability:** Fail-closed 3-gate execution pipeline. Dashboard stability and verification diagnostics.

👉 **[Full release history → CHANGELOG.md](CHANGELOG.md)** · **[ROADMAP →](ROADMAP.md)**

---

## How Prism Compares

Standard memory servers (like Mem0, Zep, or the baseline Anthropic MCP) act as passive filing cabinets — they wait for the LLM to search them. **Prism is an active cognitive architecture.** Designed specifically for the **Model Context Protocol (MCP)**, Prism doesn't just store vectors — it consolidates experience into principles, traverses causal graphs for multi-hop reasoning, and rejects queries it can't confidently answer.

### 📊 Feature-by-Feature Comparison

| Feature / Architecture | 🧠 Prism MCP | 🐘 Mem0 | ⚡ Zep | 🧪 Anthropic Base MCP |
| :--- | :--- | :--- | :--- | :--- |
| **Primary Interface** | **Native MCP** (Tools, Prompts, Resources) | REST API & Python/TS SDKs | REST API & Python/TS SDKs | Native MCP (Tools only) |
| **Storage Engine** | **BYO SQLite or Supabase** | Managed Cloud / VectorDBs | Managed Cloud / Postgres | Local SQLite only |
| **Context Assembly** | **Progressive (Quick/Std/Deep)** | Top-K Semantic Search | Top-K + Temporal Summaries | Basic Entity Search |
| **Memory Mechanics** | **ACT-R Activation, Spreading Activation, Hebbian Consolidation, Rejection Gate** | Basic Vector + Entity | Fading Temporal Graph | None (Infinite growth) |
| **Multi-Agent Sync** | **CRDT (Add-Wins / LWW)** | Cloud locks | Postgres locks | ❌ None (Data races) |
| **Data Compression** | **TurboQuant (7x smaller vectors)** | ❌ Standard F32 Vectors | ❌ Standard Vectors | ❌ No Vectors |
| **Observability** | **OTel Traces + Built-in PWA UI** | Cloud Dashboard | Cloud Dashboard | ❌ None |
| **Maintenance** | **Autonomous Background Scheduler** | Manual/API driven | Automated (Cloud) | ❌ Manual |
| **Data Portability** | **Prism-Port (Obsidian/Logseq Vault)** | JSON Export | JSON Export | Raw `.db` file |
| **Cost Model** | **Free + BYOM (Ollama)** | Per-API-call pricing | Per-API-call pricing | Free (limited) |
| **Autonomous Pipelines** | **✅ Dark Factory** — adversarial eval, evidence-bound rubric, fail-closed 3-gate execution | ❌ | ❌ | ❌ |

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

#### 6. Anti-Sycophancy — The AI That Grades Its Own Homework (v7.4)
Every other AI coding pipeline has a fatal flaw: it asks the same model that wrote the code whether the code is correct. **Of course it says yes.** Prism's Dark Factory solves this with a walled-off Adversarial Evaluator that is explicitly prompted to be hostile and strict. It operates on a pre-committed rubric and cannot fail the Generator without providing exact file/line receipts. Failed evaluations feed the critique back into the Generator's retry prompt — eliminating blind retries. No other memory or pipeline tool does this.

### 🤝 Where the Giants Currently Win (Honest Trade-offs)

1. **Framework Integrations:** Mem0 and Zep have pre-built integrations for LangChain, LlamaIndex, Flowise, AutoGen, CrewAI, etc. Prism requires the host application to support the MCP protocol.
2. **Managed Cloud Infrastructure:** The giants offer SaaS. Users pay $20/month and don't think about databases. Prism users must set up their own local SQLite or provision their own Supabase instance.
3. **Implicit Memory Extraction (NER):** Zep automatically extracts names, places, and facts from raw chat logs using NLP models. Prism relies on the LLM explicitly calling the `session_save_ledger` tool to structure its own memories.

> 💰 **Token Economics:** Progressive Context Loading (Quick ~50 tokens / Standard ~200 / Deep ~1000+) plus auto-compaction means you never blow your Claude/OpenAI token budget fetching 50 pages of raw chat history.
>
> 🔌 **BYOM (Bring Your Own Model):** While tools like Mem0 charge per API call, Prism's pluggable architecture lets you run `nomic-embed-text` locally via Ollama for **free vectors**, while using Claude or GPT for high-level reasoning. Zero vendor lock-in.

---

## Tool Reference

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

<details>
<summary><strong>Dark Factory Orchestration (3 tools)</strong></summary>

Requires `PRISM_DARK_FACTORY_ENABLED=true`.

| Tool | Purpose |
|------|---------|
| `session_start_pipeline` | Create and enqueue a background autonomous pipeline |
| `session_check_pipeline_status` | Poll the current step, iteration, and status of a pipeline |
| `session_abort_pipeline` | Emergency kill switch to halt a running background pipeline |

</details>

<details>
<summary><strong>Verification Harness</strong></summary>

| Tool | Purpose |
|------|---------|
| `session_plan_decompose` | Decompose natural language goals into an execution plan that references verification requirements |
| `session_plan_step_update` | Atomically update step status/result with verification context |
| `session_plan_get_active` | Retrieve active plan state and current verification gating position |

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
| `VOYAGE_API_KEY` | No | Voyage AI — optional premium embedding provider |
| `OPENAI_API_KEY` | No | OpenAI — optional proxy model and embedding provider |
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
| `PRISM_DARK_FACTORY_ENABLED` | No | `"true"` to enable Dark Factory autonomous pipeline tools (`session_start_pipeline`, `session_check_pipeline_status`, `session_abort_pipeline`) |
| `PRISM_SYNAPSE_ENABLED` | No | `"true"` (default) to enable Synapse Engine graph propagation in search results |
| `PRISM_SYNAPSE_ITERATIONS` | No | Propagation iterations (default: `3`). Higher = deeper graph traversal |
| `PRISM_SYNAPSE_SPREAD_FACTOR` | No | Energy decay multiplier per hop (default: `0.8`). Range: 0.0–1.0 |
| `PRISM_SYNAPSE_LATERAL_INHIBITION` | No | Max nodes returned by Synapse (default: `7`, min: `1`) |
| `PRISM_SYNAPSE_SOFT_CAP` | No | Max candidate pool size during propagation (default: `20`, min: `1`) |

</details>

### System Settings (Dashboard)
Some configurations are stored dynamically in SQLite (`system_settings` table) and can be edited through the Dashboard UI at `http://localhost:3000`:
- **`intent_health_stale_threshold_days`** (default: `30`): Number of days before a project is considered fully stale for Intent Health scoring.

---

## Architecture

Prism is a **stdio-based MCP server** that manages persistent agent memory. Here's how the pieces fit together:

```
┌──────────────────────────────────────────────────────────┐
│  MCP Client (Claude Desktop / Cursor / Antigravity)      │
│                    ↕ stdio / SSE (JSON-RPC)              │
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
│  │  Cognitive Engine (v8.0)                           │  │
│  │  • Synapse Engine (pure multi-hop propagation)    │  │
│  │  • Episodic → Semantic Consolidation (Hebbian)    │  │
│  │  • Uncertainty-Aware Rejection Gate               │  │
│  │  • LoCoMo-Plus Benchmark Validation               │  │
│  │  • Dynamic Fast Weight Decay (dual-rate)          │  │
│  │  • HDC Cognitive Routing (XOR binding)            │  │
│  └──────┬─────────────────────────────────────────────┘  │
│         ↕                                                │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Storage Engine                                    │  │
│  │  Local: SQLite + FTS5 + TurboQuant + semantic_knowledge │
│  │  Cloud: Supabase + pgvector                        │  │
│  └────────────────────────────────────────────────────┘  │
│         ↕                                                │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Background Workers                                │  │
│  │  • Dark Factory (3-gate fail-closed pipelines)     │  │
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
| **Semantic Knowledge** | SQLite (`semantic_knowledge`) | Hebbian-style distilled rules with confidence scoring |
| **Memory Links** | SQLite (`memory_links`) | Causal graph edges (`caused_by`, `led_to`, `synthesized_from`) |
| **Keyword Search** | FTS5 virtual tables | Zero-dependency full-text search |
| **Semantic Search** | TurboQuant compressed vectors | 10× compressed 768-dim embeddings, three-tier retrieval |
| **Cloud Sync** | Supabase + pgvector | Optional multi-device/team sync |

### Auto-Load Architecture

Each MCP client has its own mechanism for ensuring Prism context loads on session start. See the platform-specific [Setup Guides](#setup-guides) above for detailed instructions:

- **Claude Code** — Lifecycle hooks (`SessionStart` / `Stop`)
- **Gemini / Antigravity** — Three-layer architecture (User Rules + AGENTS.md + Startup Skill)
- **Task Router Integration (v7.2 guidance)** — For client startup/skills, use defensive delegation flow: route only coding tasks, call `session_task_route` only when available, delegate to `claw` only when executor exists and task is non-destructive, and fallback to host if router/executor is unavailable.
- **Cursor / Windsurf / VS Code** — System prompt instructions

All platforms benefit from the **server-side fallback** (v5.2.1): if `session_load_context` hasn't been called within 10 seconds, Prism auto-pushes context via `sendLoggingMessage`.

---

## Scientific Foundation

Prism has evolved from smart session logging into a **cognitive memory architecture** — grounded in real research, not marketing. Every retrieval decision is backed by peer-reviewed models from cognitive psychology, neuroscience, and distributed computing.

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
| **v7.0** | ACT-R Base-Level Activation — `B_i = ln(Σ t_j^(-d))` recency×frequency re-ranking over similarity candidates | Anderson's ACT-R (Adaptive Control of Thought—Rational) | ✅ Shipped |
| **v7.0** | Candidate-Scoped Spreading Activation — `S_i = Σ(W × strength)` bounded to search result set; prevents God-node dominance | Spreading activation networks (Collins & Loftus, 1975) | ✅ Shipped |
| **v7.0** | Composite Retrieval Scoring — `0.7 × similarity + 0.3 × σ(activation)`; configurable via `PRISM_ACTR_WEIGHT_*` | Hybrid cognitive-neural retrieval models | ✅ Shipped |
| **v7.0** | AccessLogBuffer — in-memory batch-write buffer with 5s flush; prevents SQLite `SQLITE_BUSY` under parallel agents | Production reliability engineering | ✅ Shipped |
| **v7.3** | Dark Factory — 3-gate fail-closed EXECUTE pipeline (parse → type → scope) with structured JSON action contract | Industrial safety systems (defense-in-depth, fail-closed valves) | ✅ Shipped |
| **v7.2** | Verification-first harness — spec-freeze contract, rubric hash lock, multi-layer assertions, CLI `verify` commands | Programmatic verification systems + adversarial validation loops | ✅ Shipped |
| **v7.4** | Adversarial Evaluation — PLAN_CONTRACT + EVALUATE with isolated generator/evaluator roles, pre-committed rubrics, and evidence-bound findings | Anti-sycophancy research, adversarial ML evaluation frameworks | ✅ Shipped |
| **v7.5** | Intent Health Dashboard — 3-signal scoring (staleness × TODO × decisions) with NaN guards and score ceiling | Production observability, proactive monitoring | ✅ Shipped |
| **v7.7** | Cloud-Native SSE Transport — full network-accessible MCP server via Server-Sent Events | Distributed systems, cloud-native architecture | ✅ Shipped |
| **v7.8** | Episodic→Semantic Consolidation — raw event logs distilled into `semantic_knowledge` rules with confidence scoring and instance tracking | Hebbian learning ("neurons that fire together wire together"), sleep consolidation (neuroscience) | ✅ Shipped |
| **v7.8** | Multi-Hop Causal Reasoning — spreading activation traverses `caused_by`/`led_to` edges with damped fan effect (`1/ln(fan+e)`) and lateral inhibition | ACT-R spreading activation (Anderson), Collins & Loftus (1975) | ✅ Shipped |
| **v7.8** | Uncertainty-Aware Rejection Gate — dual-signal (similarity floor + gap distance) safety layer prevents hallucination from low-confidence retrievals | Metacognition research, uncertainty quantification | ✅ Shipped |
| **v7.8** | Dynamic Fast Weight Decay — `is_rollup` semantic nodes decay 50% slower (`ageModifier = 0.5`) than episodic entries, creating Long-Term Context anchors | ACT-R base-level activation with differential decay rates | ✅ Shipped |
| **v7.8** | LoCoMo Benchmark Harness — deterministic integration suite (`tests/benchmarks/locomo.ts`, 20 assertions) benchmarking multi-hop compaction structures via `MockLLM` | Long-Context Memory evaluation (cognitive benchmarking) | ✅ Shipped |
| **v7.8** | LoCoMo-Plus Benchmark — 16-assertion suite (`tests/benchmarks/locomo-plus.ts`) adapted from arXiv 2602.10715 validating cue–trigger semantic disconnect bridging via graph traversal and Hebbian consolidation; reports Precision@1/3/5/10 and MRR | LoCoMo-Plus (Li et al., ARR 2026), cue–trigger disconnect research | ✅ Shipped |
| **v9.0** | Affect-Tagged Memory — valence-weighted retrieval; emotional salience boosts recall | Affect-modulated retrieval (neuroscience), Somatic marker hypothesis (Damasio) | ✅ Shipped |
| **v9.0** | Token-Economic Cognitive Budget — UBI + cost-per-save token economy | Behavioral economics, bounded rationality (Simon) | ✅ Shipped |
| **v9.0** | Surprisal Gate — novelty-based cost multiplier (high surprisal = cheap storage) | Bayesian surprise, predictive coding (Friston) | ✅ Shipped |
| **v10+** | Zero-Search Retrieval — no index, no ANN, just ask the vector | Holographic Reduced Representations | 🔭 Horizon |

> Informed by Anderson's ACT-R (Adaptive Control of Thought—Rational), Collins & Loftus spreading activation networks (1975), Kanerva's SDM (1988), Hebb's learning rule, Li et al. LoCoMo-Plus (ARR 2026), and LeCun's "Why AI Systems Don't Learn" (Dupoux, LeCun, Malik).

---

## Milestones & Roadmap

> **Current: v9.0.0** — Autonomous Cognitive OS ([CHANGELOG](CHANGELOG.md))

| Release | Headline |
|---------|----------|
| **v9.0** | 🧠 Autonomous Cognitive OS — Affect-Tagged Memory (valence engine), Token-Economic Cognitive Budget, Surprisal Gate |
| **v8.0** | ⚡ Synapse Engine — Pure multi-hop GraphRAG propagation, storage-agnostic, NaN-hardened, `[🌐 Synapse]` discovery tags |
| **v7.8** | 🧠 Cognitive Architecture — Hebbian consolidation, multi-hop reasoning, rejection gate, dynamic decay |
| **v7.7** | 🌐 Cloud-Native SSE Transport |
| **v7.5** | 🩺 Intent Health Dashboard + Security Hardening |
| **v7.4** | ⚔️ Adversarial Evaluation (anti-sycophancy) |
| **v7.3** | 🏭 Dark Factory fail-closed execution |
| **v7.2** | ✅ Verification Harness |
| **v7.1** | 🚦 Task Router |
| **v7.0** | 🧬 ACT-R Activation Memory |
| **v6.5** | 🔮 HDC Cognitive Routing |
| **v6.2** | 🧩 Synthesize & Prune |

### Future Tracks
- **v9.1: Predictive Push Memory** — Proactive context injection before the agent even asks — anticipating what it will need next.
- **v9.4: Counterfactual Memory Branches** — "What if" reasoning over alternative decision paths.
- **v10+: Zero-Search Retrieval** — Direct vector-addressed recall via Holographic Reduced Representations.

👉 **[Full ROADMAP.md →](ROADMAP.md)**


## Troubleshooting FAQ

**Q: Why is the dashboard project selector stuck on "Loading projects..."?**
A: Fixed in v7.3.3. The root cause was a multi-layer quote-escaping trap in the `abortPipeline` onclick handler that generated a `SyntaxError` in the browser, silently killing the entire dashboard IIFE. Update to v7.3.3+ (`npx -y prism-mcp-server`). If still stuck, check that Supabase env values are properly set (unresolved placeholders like `${SUPABASE_URL}` cause `/api/projects` to return empty). Prism auto-falls back to local SQLite when Supabase is misconfigured.

**Q: Why is semantic search quality weak or inconsistent?**
A: Check embedding provider configuration and key availability. Missing embedding credentials reduce semantic recall quality and can shift behavior toward keyword-heavy matches.

**Q: How do I delete a bad memory entry?**
A: Use `session_forget_memory` for targeted soft/hard deletion. For manual cleanup and merge workflows, use the dashboard graph editor.

**Q: How do I verify the install quickly?**
A: Run `npm run build && npm test`, then open the Mind Palace dashboard (`localhost:3000`) and confirm projects load plus Graph Health renders.


---

### 💡 Known Limitations & Quirks

- **LLM-dependent features require an API key.** Semantic search, Morning Briefings, auto-compaction, and VLM captioning need a `GOOGLE_API_KEY` (your Gemini API key) or equivalent provider key. Without one, Prism falls back to keyword-only search (FTS5).
- **Auto-load is model- and client-dependent.** Session auto-loading relies on both the LLM following system prompt instructions *and* the MCP client completing tool registration before the model's first turn. Prism provides platform-specific [Setup Guides](#setup-guides) and a server-side fallback (v5.2.1) that auto-pushes context after 10 seconds.
- **MCP client race conditions.** Some MCP clients may not finish tool enumeration before the model generates its first response, causing transient `unknown_tool` errors. This is a client-side timing issue — Prism's server completes the MCP handshake in ~60ms. Workaround: the server-side auto-push fallback and the startup skill's retry logic.
- **No real-time sync without Supabase.** Local SQLite mode is single-machine only. Multi-device or team sync requires a Supabase backend.
- **Embedding quality varies by provider.** Gemini `text-embedding-004` and OpenAI `text-embedding-3-small` produce high-quality 768-dim vectors. Prism passes `dimensions: 768` via the Matryoshka API for OpenAI models (native output is 1536-dim; this truncation is lossless and outperforms ada-002 at full 1536 dims). Ollama embeddings (e.g., `nomic-embed-text`) are usable but may reduce retrieval accuracy.
- **Dashboard is HTTP-only.** The Mind Palace dashboard at `localhost:3000` does not support HTTPS. For remote access, use a reverse proxy (nginx/Caddy) or SSH tunnel. Basic auth is available via `PRISM_DASHBOARD_USER` / `PRISM_DASHBOARD_PASS`.
- **Long-lived clients can accumulate zombie processes.** MCP clients that run for extended periods (e.g., Claude CLI) may leave orphaned Prism server processes. The lifecycle manager detects true orphans (PPID=1) but allows coexistence for active parent processes. Use `PRISM_INSTANCE` to isolate instances across clients.
- **Migration is one-way.** Universal Import ingests sessions *into* Prism but does not export back to Claude/Gemini/OpenAI formats. Use `session_export_memory` for portable JSON/Markdown export, or the `vault` format for Obsidian/Logseq-compatible `.zip` archives.
- **Export ceiling at 10,000 ledger entries.** The `session_export_memory` tool and the dashboard export button cap vault/JSON exports at 10,000 entries per project as an OOM guard. Projects exceeding this limit should use per-project exports and time-based filtering to stay within the ceiling. This limit does not affect search or context loading.
- **No Windows CI testing.** Prism is developed and tested on macOS/Linux. It should work on Windows via Node.js, but edge cases (file paths, PID locks) may surface.

---

## Enterprise & Commercial Support

Prism is the **cognitive infrastructure layer** for production AI agent deployments. If your organization is building agent-powered products, we offer:

### 🏢 Enterprise Integration
- **Dedicated integration engineering** — Custom deployment into your existing agent stack (LangChain, LlamaIndex, CrewAI, AutoGen, custom MCP pipelines)
- **On-premises deployment** — Air-gapped installations with full SQLite local mode, zero cloud dependency
- **SSO & RBAC** — Enterprise authentication and role-based access control for multi-team Hivemind deployments
- **SLA-backed support** — Priority issue resolution, architecture review, and upgrade planning

### 🔬 Research & Institutional Partnerships
- **Academic collaborations** — Prism's cognitive architecture is grounded in peer-reviewed research (ACT-R, Hebbian learning, SDM, HDC). We partner with research labs working on agent memory, cognitive modeling, and neurosymbolic AI.
- **Grant-funded integrations** — We work with institutions applying for NSF, DARPA, or EU Horizon grants that require production-grade agent memory infrastructure.

### 📬 Contact
- **Enterprise inquiries:** [enterprise@prism-mcp.dev](mailto:enterprise@prism-mcp.dev)
- **Partnership proposals:** [partnerships@prism-mcp.dev](mailto:partnerships@prism-mcp.dev)
- **GitHub Issues:** [github.com/dcostenco/prism-mcp/issues](https://github.com/dcostenco/prism-mcp/issues) (community support)

> 💡 **Open Source commitment:** Prism MCP remains MIT-licensed and free for individual developers, startups, and research teams. Enterprise services fund continued open-source development.

---

## License

MIT

---

<sub>**Keywords:** MCP server, Model Context Protocol, Claude Desktop memory, persistent session memory, AI agent memory, cognitive architecture, ACT-R spreading activation, Hebbian learning, episodic semantic consolidation, multi-hop reasoning, uncertainty rejection gate, local-first, SQLite MCP, Mind Palace, time travel, visual memory, VLM image captioning, OpenTelemetry, GDPR, agent telepathy, multi-agent sync, behavioral memory, cursorrules, Ollama MCP, Brave Search MCP, TurboQuant, progressive context loading, knowledge management, LangChain retriever, LangGraph agent, enterprise AI agent infrastructure, autonomous cognitive OS, affect-tagged memory, valence engine, cognitive budget, surprisal gate</sub>
```

---

## CHANGELOG.md

```markdown
# Changelog

All notable changes to this project will be documented in this file.

## [9.0.0] - 2026-04-07 — Autonomous Cognitive OS

### 🧠 Affect-Tagged Memory (Valence Engine)
- **Automatic Valence Derivation** — Every memory entry gets a "gut feeling" score from -1.0 (trauma/failure) to +1.0 (success/confidence), auto-derived from `event_type` at save time. No manual classification needed.
- **Affective Salience Retrieval** — Uses absolute magnitude `|valence|` to boost retrieval salience for highly emotional memories (both positive AND negative). Prevents the Valence Retrieval Paradox where failure memories are deprioritized and agents repeat mistakes.
- **Valence Emoji Tags** — Search results display valence indicators: 🔴 (strong negative ≤-0.5), 🟠 (negative ≤-0.2), 🟡 (neutral), 🔵 (positive ≥0.2), 🟢 (strong positive ≥0.5).
- **Contextual Valence Warnings** — When top search results have historically negative affect, agents receive warnings like "⚠️ This topic is strongly correlated with historical failures."
- **Valence Propagation** — Discovered nodes in the Synapse graph inherit valence via energy-weighted averaging from source flows, with fan-dampening and strict [-1, +1] clamping.

### 💰 Token-Economic Cognitive Budget
- **Strict Token Economy** — Every memory write operation costs tokens, with cost multiplied by a surprisal-derived factor: boilerplate (2×), standard (1×), novel (0.5×). This incentivizes storing novel information over redundant entries.
- **UBI Earnings** — Budget replenishes at +100 tokens/hour passively, plus event bonuses: success (+200), learning (+100). Budget cannot exceed the initial cap (default: 2000).
- **Budget Diagnostics in Context** — `session_load_context` now shows a visual budget bar with health status (🟢 Healthy → 🔴 Critical) so agents understand their spending capacity at session start.
- **Persistent Budget** — Budget state is persisted in `session_handoffs.cognitive_budget` via lightweight `patchHandoffBudget` method, surviving across sessions.
- **Graceful Degradation** — Budget exhaustion triggers warnings but NEVER blocks writes. Zero-balance entries still save with a warning annotation.

### 🧬 Hybrid Scoring with Valence
- **Three-Component Formula** — Synapse hybrid scores now use `0.65 × similarity + 0.25 × activation + 0.10 × |valence|`, replacing the simpler `0.70 × similarity + 0.30 × activation` blend. Falls back to the legacy formula when valence is disabled.
- **computeHybridScoreWithValence()** — New pure function in `valenceEngine.ts` with configurable weights and safe clamping.

### Engineering
- All existing tests pass (zero regressions)
- All v9.0 modules are pure functions with zero I/O (valenceEngine, cognitiveBudget, surprisalGate)
- Feature-gated via `PRISM_VALENCE_ENABLED` and `PRISM_COGNITIVE_BUDGET_ENABLED` (both default `true`)
- Graceful fallback on every failure path — zero hard crashes

## [8.0.3] - 2026-04-07 — Performance & Edge-Case Hardening

### Performance
- **FTS5 Trigger Scoping** — The `ledger_fts_update` trigger now fires only on `UPDATE OF project, summary, decisions, keywords`. Previously, any column update (including `last_accessed_at` bumps from ACT-R access logging) triggered a full FTS5 delete+reinsert cycle — causing 40 unnecessary disk writes per 20-result search.

### Fixed
- **Synapse Backward Flow Energy Explosion** — Backward propagation in the Synapse Engine now applies fan-dampening (`1/ln(inDegree + e)`) symmetrically with forward flow. Previously, a hub node with thousands of inbound edges would blast undampened energy to all source nodes, saturating `softCap` with irrelevant noise and violating energy conservation.
- **`json_each(NULL)` Crash Guard** — `findKeywordOverlapEntries` now wraps the `keywords` column in `COALESCE(sl.keywords, '[]')` before passing to `json_each()`. Legacy rows with `keywords = NULL` (instead of `'[]'`) previously threw a hard SQL error, aborting the entire query.

### Engineering
- 1052 tests across 48 suites, all passing, zero regressions
- Updated Synapse backward flow test to validate dampened energy calculation
- TypeScript strict mode: zero errors

## [8.0.2] - 2026-04-07 — Security & Stability Hardening

### Security
- **SQL Injection Defense-in-Depth (CRIT-1)** — Added `/^[a-z_]+$/` regex validation as a second gate on `updateAgentStatus` field name interpolation, alongside the existing allowlist. Prevents injection even if new allowlist entries are added without review.
- **LIKE Wildcard Escaping (MED-3)** — User-supplied keywords in `searchKnowledgeFallback` now escape `%` and `_` wildcards via `ESCAPE '\'` clauses. Previously, a search for `"100%_done"` matched unintended rows.
- **macOS Path Scope Escape (EDGE-2)** — `SafetyController.isPathWithinScope()` now normalizes paths to lowercase on `darwin` and `win32` platforms. Fixes case-insensitive filesystem bypass where `/App/Workspace` ≠ `/app/workspace` allowed scope escapes.
- **Tenant-Scoped Link Decay (MED-6)** — `decayLinks()` now accepts optional `userId` to scope decay to the calling user's link entries via `source_id IN (SELECT id FROM session_ledger WHERE user_id = ?)`. Prevents cross-tenant graph decay in shared-database deployments.

### Performance
- **Tier-2 TurboQuant LIMIT (HIGH-1)** — Added `LIMIT 5000` to the Tier-2 TurboQuant fallback query. Previously loaded all matching rows into JS heap for in-memory cosine scoring, risking heap exhaustion on large datasets (50K+ entries).

### Fixed
- **SDM Memory Aliasing (HIGH-2)** — `importState()` now uses `slice()` instead of `subarray()` to create independent copies of each counter row. `subarray()` creates aliased views that silently corrupt if the source buffer is GC'd or detached.
- **SDM Mode Persistence (EDGE-3)** — Added `mode` parameter to `importState()` and `getMode()` accessor. The engine's mode lock (`semantic` vs `hdc`) is now restorable on deserialization, preventing cross-talk between HDC and semantic writes.
- **HDC Dictionary Version Decoupling (EDGE-5)** — Introduced separate `HDC_DICTIONARY_VERSION` constant. `saveHdcConcept` previously used `SDM_ADDRESS_VERSION` (PRNG algorithm version), creating false coupling — a PRNG change would needlessly invalidate the concept dictionary.
- **Verification Harness File Size Guard (MED-5)** — Added `statSync()` check before reading `verification_harness.json`, capping at 1MB. Prevents heap exhaustion from malformed LLM-generated files during the Dark Factory VERIFY step.

### Interface
- `StorageBackend.decayLinks()` signature updated to accept optional `userId` (backward-compatible).
- `SparseDistributedMemory.importState()` signature updated to accept optional `mode` parameter.
- New export: `HDC_DICTIONARY_VERSION` from `sdmEngine.ts`.

### Engineering
- 1052 tests across 48 suites, all passing, zero regressions
- TypeScript strict mode: zero errors
- 6 files changed across 4 modules (storage, SDM, Dark Factory safety, Dark Factory runner)

## [8.0.1] - 2026-04-07

### Bug Fixes
- **ACT-R Sigmoid Blowout** — Changed `Si` source from unbounded `rawActivationEnergy` (could reach 15+) to normalized `activationScore` (0–1). Prevents sigmoid saturation that erased `Bi` recency/frequency from composite scores.
- **Missing `[🌐 Synapse]` Tag** — Wired `isDiscovered` boolean through storage layer (`applySynapse`) and added `[🌐 Synapse]` tag to search result formatting for discovered nodes.
- **Missing Metadata on Discovered Nodes** — Expanded `SELECT` queries in both SQLite and Supabase `applySynapse` to include `is_rollup`, `importance`, and `last_accessed_at`. Prevents ACT-R `decayRate` crash on Synapse-discovered nodes.

### Removed
- **Legacy v6.0 1-Hop Graph Expansion** — Deleted redundant N+1 graph traversal blocks from both `knowledgeSearchHandler` and `sessionSearchMemoryHandler` (−130 lines). Synapse Engine handles multi-hop at the storage layer, making these obsolete.

### Interface
- Added `isDiscovered?: boolean` to `SemanticSearchResult` interface.

## [8.0.0] - 2026-04-07

### Major Features
- **Synapse Engine (v8.0)** — Replaced the legacy SQL-coupled `spreadingActivation.ts` with a pure, storage-agnostic `synapseEngine.ts` multi-hop propagation engine.
  - Implements bounded O(T × M) ACT-R memory propagation avoiding explosive DB queries.
  - Pure functional design: zero I/O, decoupled via `LinkFetcher` callback. Paves the way for distributed graph backends.
  - Dampened fan effect (`1/ln(degree+e)`) prevents hub nodes from blindly broadcasting.
  - Asymmetric bidirectional flow (forward 100%, backward 50%) preserves causal directionality.
  - Cyclic energy tracking via `visitedEdges` set prevents recursive energy amplification.
  - Sigmoid normalization ensures structural scores don't overwhelm semantic base matches.
  - Hybrid scoring: 70% semantic similarity / 30% structural activation energy blend.

### Storage Integration
- **SQLite `applySynapse`** — Full Synapse Engine integration into `searchKnowledge` and `searchMemory`. Missing-node metadata fetched via direct SQL with per-row hydration.
- **Supabase `applySynapse`** — Full Synapse Engine integration via Supabase REST API. Missing-node metadata fetched via `supabaseGet` with `in.()` filter.
- **`getLinksForNodes`** — Implemented on both SQLite (direct SQL) and Supabase (`prism_get_links_for_nodes` RPC) backends for storage-agnostic link fetching.

### Edge Case Hardening
- **NaN Strength Guard** — `Number.isFinite()` guard on `edge.strength` prevents corrupted/null database values from poisoning the entire energy propagation map (defaults to 0).
- **Similarity Nullish Coalescing** — Fixed `similarity || 1.0` → `similarity ?? 1.0` in both backends. Previously, a valid `0.0` similarity was falsely promoted to `1.0`.
- **Config Clamping** — `lateralInhibition` and `softCap` are now clamped to minimum 1 in the engine. Setting either to 0 no longer silently drops all results.
- **Non-Fatal Enrichment** — Both backends wrap `applySynapse` in try/catch. Engine failures gracefully return original anchors instead of crashing the search operation.
- **`PRISM_SYNAPSE_SOFT_CAP` Wiring** — The env var was declared and parsed in `config.ts` but never consumed by either backend. Now correctly passed to `propagateActivation()`.

### Observability
- **`SynapseRuntimeMetrics`** — Full runtime telemetry integrated into the observability pipeline. Tracks nodes returned/discovered, edges traversed, iterations performed, max/avg activation energy, and duration.
- **Telemetry Data Fix** — Added `avgActivationEnergy` to `SynapseRunData` interface. Previously silently dropped from the engine's output during recording.

### Removed
- **Legacy `spreadingActivation.ts`** — Deleted. SQL-coupled 1-hop activation logic fully replaced by the pure Synapse engine.
- **Dead Import** — Removed deprecated `candidateScopedSpreadingActivation` import from `graphHandlers.ts`.

### Configuration
- 5 new environment variables: `PRISM_SYNAPSE_ENABLED`, `PRISM_SYNAPSE_ITERATIONS`, `PRISM_SYNAPSE_SPREAD_FACTOR`, `PRISM_SYNAPSE_LATERAL_INHIBITION`, `PRISM_SYNAPSE_SOFT_CAP`.

### Engineering
- 16 Synapse tests (5 new edge-case tests: NaN strength, lateralInhibition=0, softCap=0, linkFetcher failure, empty anchor map)
- TypeScript strict mode: zero errors
- Non-breaking: Synapse is gated behind `PRISM_SYNAPSE_ENABLED` (default: `true`)

## [7.8.8] - 2026-04-06

### Added
- **Ollama Embedding Adapter** — New `OllamaAdapter` (`src/utils/llm/adapters/ollama.ts`) for fully local, zero-cost text embeddings via Ollama's native `/api/embed` batch endpoint. Default model: `nomic-embed-text` (768 dims natively — zero truncation needed).
  - Batch embedding support via `/api/embed` (Ollama ≥ 0.3.0).
  - Dimension validation: hard-throws on mismatched dims, soft-truncates if model returns > 768.
  - Word-safe truncation at 8000 chars (consistent with Voyage/OpenAI adapters).
  - Configurable via dashboard: `ollama_base_url`, `ollama_model`.
- **Factory Auto-Routing for Ollama** — `embedding_provider=auto` now detects `OLLAMA_HOST` or `OLLAMA_BASE_URL` env vars as a second-priority signal (after `VOYAGE_API_KEY`). When set, auto routes to `OllamaAdapter` without explicit `embedding_provider=ollama`.

### Changed
- **LLM Factory v4.6** — Updated factory version, added `"ollama"` to the `embedding_provider` enum, updated example configurations in header docs.

## [7.8.7] - 2026-04-06

### Added
- **LoCoMo-Plus Benchmark** — New cognitive benchmark suite (`tests/benchmarks/locomo-plus.ts`, 16/16 assertions) adapted from arXiv 2602.10715 (Li et al., ARR 2026). Validates Prism's ability to bridge the **cue–trigger semantic disconnect** — where causally related memories are semantically distant — using graph traversal and Hebbian consolidation. Reports real Precision@1/3/5/10 and MRR metrics across a 30-entry pool (10 cues + 20 fillers).

### Fixed
- **Benchmark Embedding Cache** — Eliminated redundant embedding computation across LoCoMo-Plus stages. Pre-computed embeddings are now cached via `Map<string, number[]>` and reused between Stage 2 (raw retrieval) and Stage 5 (metrics), cutting total embedding calls by ~60%.
- **Tautological Assertions** — Replaced `assert(true, ...)` stubs in Hebbian consolidation tests with actual storage verification (try/catch + counter), ensuring `upsertSemanticKnowledge` failures are caught rather than silently passing.
- **Dead `precisionAtK` Function** — The previous implementation created zero-vectors and called `cosineSimilarity` on them (returning NaN), with a `hits` counter that was never incremented (always returned 0). Replaced with a working implementation that filters cached `cueRanks` at each K threshold.
- **Incomplete Ranking Pool** — Stage 2 ranking only compared triggers against fillers + the target cue (21 entries), excluding the other 9 cues as distractors. Now ranks against the full 29-entry pool (20 fillers + 9 other cues) for accurate difficulty measurement.
- **Dead Import** — Removed unused `sessionSearchMemoryHandler` import from locomo-plus.ts.
- **Hardcoded Metric** — Replaced `String(2).padStart(5)` with dynamic `principlesStored` counter in metrics box.

## [7.8.6] - 2026-04-06

### Fixed
- **Batch Embeddings Dead Code** — The factory's composed provider object never wired `generateEmbeddings()` from the embed adapter, making the entire Voyage batch embedding path unreachable. The backfill handler always fell back to sequential single-text calls. Now correctly passes the method through when the adapter supports it.
- **Backfill Error Resilience** — If the Voyage API batch call succeeded but a single `patchLedger()` DB write failed, the entire batch was marked as failed and all paid embeddings were discarded. Now each entry is persisted independently with its own error handling.

## [7.8.4] - 2026-04-06

### Fixed
- **JSON-RPC Stream Integrity** — Replaced `console.info()` calls in `factory.ts` with `console.error()`. In Node.js, `console.info()` writes to stdout (same as `console.log()`), which corrupted the MCP JSON-RPC stream and caused dashboard connectivity failures and auto-load timeouts.
- **Misleading Provider Log** — Fixed a log message that incorrectly reported "routing embeddings to GeminiAdapter" when Voyage AI was actually auto-detected via `VOYAGE_API_KEY`. The anthropic info message now only fires when Gemini is genuinely selected as the fallback.
- **CLI Tool Logging** — Reverted `console.log` → `console.error` changes in `cliHandler.ts` and `universalImporter.ts` that were incorrectly applied in a previous fix. These are standalone CLI tools (not imported by the MCP server) and require `stdout` for programmatic output (e.g., `prism verify status --json | jq`).
- **Sandbox Template Consistency** — Reverted QuickJS sandbox code templates (`codeMode.ts`) back to `console.log()` to match the tool descriptions in `definitions.ts` that instruct LLMs to use `console.log()`.
- **Voyage Adapter Docs** — Updated stale header comments that still referenced `voyage-3` as the default model (now `voyage-code-3` since v7.8.3).

## [7.8.3] - 2026-04-06

### Fixed
- **Voyage API MRL Dimension Truncation** — Fixed an integration crash where Voyage AI's `voyage-code-3` model rejected explicit dimension requests off the native binary boundaries in API requests. Implemented mathematically-sound client-side Matryoshka Representation Learning (MRL) truncation to safely slice native 1024-dim vectors down to the strict 768-dim schema constraint required by sqlite-vec and pgvector.
- **Default Embedding Routing** — Upgraded the default Voyage model from `voyage-3` to `voyage-code-3` strictly mapped for superior workspace/technical codebase performance.
- **Environment Auto-Detection** — Augmented `auto` embedding router to seamlessly shift priority to Voyage AI automatically when `VOYAGE_API_KEY` is detected in the environment.

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
```

---

## New Modules

### `src/memory/valenceEngine.ts`
```typescript
/**
 * Valence Engine — Affect-Tagged Memory (v9.0)
 *
 * ═══════════════════════════════════════════════════════════════════
 * PURPOSE:
 *   Implements Affective Cognitive Routing — every memory gets a
 *   "gut feeling" score from -1.0 (trauma) to +1.0 (success).
 *   Agents get warned when approaching historically problematic
 *   topics, and get green-light signals for proven-successful paths.
 *
 * AFFECTIVE SALIENCE PRINCIPLE:
 *   In human psychology, highly emotional memories — both extreme
 *   joy and extreme trauma — are retrieved MORE easily, not less.
 *   Therefore, the retrieval score uses |valence| (absolute magnitude)
 *   to BOOST salience, while the SIGN (±) is used purely for
 *   prompt injection / UX warnings.
 *
 *   This prevents the Valence Retrieval Paradox where a failure
 *   memory gets pushed below the retrieval threshold, causing the
 *   agent to repeat the exact same mistake.
 *
 * DESIGN:
 *   All functions are PURE — zero I/O, zero imports from storage.
 *   Valence propagation through the Synapse graph uses energy-weighted
 *   transfer with fan-dampened flow and strict [-1, 1] clamping.
 *
 * FILES THAT IMPORT THIS:
 *   - src/storage/sqlite.ts (auto-derive valence on save)
 *   - src/tools/graphHandlers.ts (hybrid scoring + UX warnings)
 *   - src/memory/synapseEngine.ts (valence propagation)
 * ═══════════════════════════════════════════════════════════════════
 */

// ─── Valence Derivation ───────────────────────────────────────

/**
 * Deterministic mapping from experience event type to valence score.
 *
 * | Event Type          | Valence | Rationale                          |
 * |---------------------|---------|------------------------------------|
 * | success             | +0.8    | Positive reinforcement             |
 * | failure             | -0.8    | Strong negative signal             |
 * | correction          | -0.6    | User had to fix agent              |
 * | learning            | +0.4    | New knowledge acquired             |
 * | validation_result   | ±0.6    | Pass → +0.6, Fail → -0.6          |
 * | session / default   | 0.0     | Neutral — no sentiment signal      |
 *
 * @param eventType - The experience event type from session_ledger
 * @param notes - Optional notes field (for validation_result pass/fail)
 * @returns Valence score in [-1.0, +1.0]
 */
export function deriveValence(eventType: string | undefined, notes?: string | null): number {
  if (!eventType || eventType === 'session') return 0.0;

  switch (eventType) {
    case 'success':
      return 0.8;
    case 'failure':
      return -0.8;
    case 'correction':
      return -0.6;
    case 'learning':
      return 0.4;
    case 'validation_result':
      // Check notes for pass/fail indication
      if (notes) {
        const lower = notes.toLowerCase();
        if (lower.includes('pass') || lower.includes('success') || lower.includes('green')) {
          return 0.6;
        }
        if (lower.includes('fail') || lower.includes('error') || lower.includes('blocked')) {
          return -0.6;
        }
      }
      // Ambiguous validation result → slightly negative (cautious)
      return -0.2;
    default:
      return 0.0;
  }
}

// ─── Retrieval Salience (Magnitude-Based) ─────────────────────

/**
 * Compute the retrieval salience boost from valence.
 *
 * Uses ABSOLUTE MAGNITUDE — both extreme positive and extreme negative
 * memories are more salient (more retrievable). The sign is preserved
 * separately for UX warnings.
 *
 * @param valence - Raw valence score in [-1.0, +1.0]
 * @returns Salience boost in [0.0, 1.0]
 */
export function valenceSalience(valence: number | null | undefined): number {
  if (valence == null || !Number.isFinite(valence)) return 0.0;
  return Math.min(1.0, Math.abs(valence));
}

// ─── UX Warning / Signal Tags ─────────────────────────────────

/**
 * Format a valence score into a human-readable emoji tag for display
 * in search results and context output.
 *
 * @param valence - Raw valence score in [-1.0, +1.0]
 * @returns Emoji tag string, or empty string for neutral
 */
export function formatValenceTag(valence: number | null | undefined): string {
  if (valence == null || !Number.isFinite(valence)) return '';
  if (valence <= -0.5) return '🔴';
  if (valence <= -0.2) return '🟠';
  if (valence >= 0.5) return '🟢';
  if (valence >= 0.2) return '🔵';
  return '🟡'; // Neutral zone (-0.2 to +0.2)
}

/**
 * Determine if a set of retrieved memories should trigger a
 * negative valence warning in the response.
 *
 * @param avgValence - Average valence across top results
 * @param threshold - Warning threshold (default: -0.3)
 * @returns true if the agent should be warned about historical friction
 */
export function shouldWarnNegativeValence(
  avgValence: number,
  threshold: number = -0.3,
): boolean {
  return Number.isFinite(avgValence) && avgValence < threshold;
}

/**
 * Generate a contextual warning message based on average valence.
 *
 * @param avgValence - Average valence across top results
 * @returns Warning/signal string to inject into MCP response, or null
 */
export function generateValenceWarning(avgValence: number): string | null {
  if (!Number.isFinite(avgValence)) return null;

  if (avgValence < -0.5) {
    return '⚠️ **Caution:** This topic is strongly correlated with historical failures and corrections. Consider reviewing past decisions before proceeding.';
  }
  if (avgValence < -0.3) {
    return '⚠️ **Warning:** This area has mixed historical outcomes. Approach with awareness of prior friction.';
  }
  if (avgValence > 0.5) {
    return '🟢 **High Signal:** This path has historically led to successful outcomes.';
  }

  return null;
}

// ─── Valence Propagation (for Synapse Engine) ─────────────────

/**
 * Propagation result for a single node.
 */
export interface ValencePropagationResult {
  /** Memory entry UUID */
  id: string;
  /** Propagated valence score, clamped to [-1.0, +1.0] */
  propagatedValence: number;
}

/**
 * Propagate valence through Synapse activation results.
 *
 * Each node's propagated valence is computed as the energy-weighted
 * average of its sources' valence, with fan-dampening to prevent
 * hub explosion. The final value is strictly clamped to [-1.0, +1.0].
 *
 * IMPORTANT — Fan-Dampening:
 *   If 50 neutral nodes point to 1 negative node, the negative valence
 *   must NOT multiply to -50.0. The incoming valence is averaged over
 *   the fan-in count, then clamped.
 *
 * Algorithm:
 *   For each non-anchor node with incoming energy flows:
 *     propagatedValence = Σ(flow_weight × source_valence) / Σ(flow_weight)
 *   Clamped to [-1.0, +1.0].
 *
 *   Anchor nodes retain their original valence unchanged.
 *
 * @param synapseResults - Node IDs with their activation energy from Synapse
 * @param valenceLookup - Map from entry ID → raw valence (from DB)
 * @param flowWeights - Map from `targetId` → Array<{ sourceId, weight }> representing
 *                      the energy flows that contributed to each node's activation
 * @returns Map from entry ID → propagated valence
 */
export function propagateValence(
  synapseResults: Array<{ id: string; activationEnergy: number; isDiscovered: boolean }>,
  valenceLookup: Map<string, number>,
  flowWeights?: Map<string, Array<{ sourceId: string; weight: number }>>,
): Map<string, number> {
  const result = new Map<string, number>();

  for (const node of synapseResults) {
    // Anchor nodes: use their direct valence
    if (!node.isDiscovered) {
      const directValence = valenceLookup.get(node.id) ?? 0.0;
      result.set(node.id, clampValence(directValence));
      continue;
    }

    // Discovered nodes: compute energy-weighted average from source flows
    const flows = flowWeights?.get(node.id);
    if (!flows || flows.length === 0) {
      // No flow data → use direct valence if available, else neutral
      result.set(node.id, clampValence(valenceLookup.get(node.id) ?? 0.0));
      continue;
    }

    let weightedValenceSum = 0;
    let totalWeight = 0;

    for (const flow of flows) {
      const sourceValence = valenceLookup.get(flow.sourceId) ?? result.get(flow.sourceId) ?? 0.0;
      const absWeight = Math.abs(flow.weight);
      weightedValenceSum += absWeight * sourceValence;
      totalWeight += absWeight;
    }

    const propagated = totalWeight > 0 ? weightedValenceSum / totalWeight : 0.0;
    result.set(node.id, clampValence(propagated));
  }

  return result;
}

/**
 * Clamp a valence value to the valid range [-1.0, +1.0].
 * Returns 0.0 for non-finite values.
 */
export function clampValence(v: number): number {
  if (!Number.isFinite(v)) return 0.0;
  return Math.max(-1.0, Math.min(1.0, v));
}

// ─── Hybrid Score Component ───────────────────────────────────

/**
 * Compute the hybrid retrieval score incorporating valence salience.
 *
 * Formula: 0.65 × similarity + 0.25 × normalizedActivation + 0.1 × |valence|
 *
 * The valence component uses ABSOLUTE MAGNITUDE — both extreme positive
 * and extreme negative memories get a retrieval boost. Only the sign
 * matters for UX warnings, not for ranking.
 *
 * @param similarity - Semantic similarity score [0, 1]
 * @param normalizedActivation - Sigmoid-normalized activation energy [0, 1]
 * @param valence - Raw valence score [-1, +1]
 * @param weights - Optional weight overrides
 * @returns Hybrid score in [0, 1]
 */
export function computeHybridScoreWithValence(
  similarity: number,
  normalizedActivation: number,
  valence: number | null | undefined,
  weights: { similarity?: number; activation?: number; valence?: number } = {},
): number {
  const wSim = weights.similarity ?? 0.65;
  const wAct = weights.activation ?? 0.25;
  const wVal = weights.valence ?? 0.10;

  const safeSim = Number.isFinite(similarity) ? Math.max(0, Math.min(1, similarity)) : 0;
  const safeAct = Number.isFinite(normalizedActivation) ? Math.max(0, Math.min(1, normalizedActivation)) : 0;
  const safeVal = valenceSalience(valence); // Already returns [0, 1] magnitude

  return wSim * safeSim + wAct * safeAct + wVal * safeVal;
}
```

### `src/memory/cognitiveBudget.ts`
```typescript
/**
 * Cognitive Budget — Token-Economic RL (v9.0)
 *
 * ═══════════════════════════════════════════════════════════════════
 * PURPOSE:
 *   Implements a strict token economy for agent memory operations.
 *   Instead of having infinite memory budgets, agents must learn to
 *   save high-signal, compressed entries — through physics, not prompts.
 *
 * ECONOMY DESIGN:
 *   - Budget is PERSISTENT (stored in session_handoffs.cognitive_budget)
 *   - Budget belongs to the PROJECT, not the ephemeral session
 *   - This prevents the "Reset Exploit" (close & reopen to get free tokens)
 *   - Revenue comes from Universal Basic Income (time-based) + success bonuses
 *   - No retrieval-based earning (prevents the "Minting Exploit" / search spam)
 *
 * COST MULTIPLIERS:
 *   Incoming entry surprisal determines the budget cost multiplier:
 *   - Low surprisal (boilerplate): 2.0× cost — penalizes "I updated CSS"
 *   - Normal surprisal:            1.0× cost — standard rate
 *   - High surprisal (novel):      0.5× cost — rewards novel insights
 *
 * GRACEFUL DEGRADATION:
 *   Budget exhaustion produces a WARNING in the MCP response but NEVER
 *   blocks the SQL insert. We never lose agent work due to verbosity.
 *
 * MINIMUM BASE COST:
 *   Empty/trivial summaries still bleed the budget (10 token minimum)
 *   to prevent zero-cost gaming with empty saves.
 *
 * UBI (UNIVERSAL BASIC INCOME):
 *   Instead of earning through arbitrary search spam, agents earn
 *   budget passively through time elapsed since last save:
 *   - +100 tokens per hour since last ledger save (capped at +500/session)
 *   - +200 bonus for a `success` experience event
 *   - +100 bonus for a `learning` experience event
 *
 * FILES THAT IMPORT THIS:
 *   - src/tools/ledgerHandlers.ts (budget tracking + diagnostics)
 *   - src/tools/ledgerHandlers.ts (budget persistence in handoff)
 * ═══════════════════════════════════════════════════════════════════
 */

// ─── Types ────────────────────────────────────────────────────

export interface BudgetResult {
  /** Whether the save is allowed (always true — graceful degradation) */
  allowed: true;
  /** Tokens spent on this operation */
  spent: number;
  /** Remaining budget after this operation */
  remaining: number;
  /** Warning message if budget is low or exhausted */
  warning?: string;
  /** Surprisal score of the content (0.0 to 1.0) */
  surprisal?: number;
  /** Cost multiplier applied */
  costMultiplier?: number;
}

export interface BudgetStatus {
  /** Current balance */
  balance: number;
  /** Total tokens spent this session */
  totalSpent: number;
  /** Total tokens earned this session (UBI + bonuses) */
  totalEarned: number;
  /** Whether budget is exhausted */
  exhausted: boolean;
  /** Initial budget size for this project */
  initialBudget: number;
}

// ─── Constants ────────────────────────────────────────────────

/** Default initial budget per project (tokens) */
export const DEFAULT_BUDGET_SIZE = 2000;

/** Minimum base cost per save operation (tokens) — prevents zero-cost gaming */
export const MINIMUM_BASE_COST = 10;

/** UBI: tokens earned per hour since last save */
export const UBI_TOKENS_PER_HOUR = 100;

/** UBI: maximum tokens earnable via time-based UBI per session */
export const UBI_MAX_PER_SESSION = 500;

/** Bonus tokens for saving a `success` experience event */
export const SUCCESS_BONUS = 200;

/** Bonus tokens for saving a `learning` experience event */
export const LEARNING_BONUS = 100;

/** Budget warning threshold (below this, show advisory) */
export const LOW_BUDGET_THRESHOLD = 300;

// ─── Cost Multipliers ────────────────────────────────────────

/** Surprisal thresholds for cost multiplier tiers */
export const BOILERPLATE_THRESHOLD = 0.2;
export const NOVEL_THRESHOLD = 0.7;

/**
 * Compute the cost multiplier based on content surprisal.
 *
 * - Low surprisal (< 0.2): 2.0× — penalizes boilerplate
 * - Normal surprisal (0.2 - 0.7): 1.0× — standard rate
 * - High surprisal (> 0.7): 0.5× — rewards novel insights
 *
 * @param surprisal - Surprisal score in [0.0, 1.0]
 * @returns Cost multiplier
 */
export function computeCostMultiplier(surprisal: number): number {
  if (!Number.isFinite(surprisal)) return 1.0;
  if (surprisal < BOILERPLATE_THRESHOLD) return 2.0;
  if (surprisal > NOVEL_THRESHOLD) return 0.5;
  return 1.0;
}

// ─── Token Counting ───────────────────────────────────────────

/**
 * Estimate token count from text using the standard 1 token ≈ 4 chars.
 * Enforces the minimum base cost to prevent zero-cost gaming.
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated token count (minimum: MINIMUM_BASE_COST)
 */
export function estimateTokens(text: string): number {
  if (!text || text.trim().length === 0) return MINIMUM_BASE_COST;
  return Math.max(MINIMUM_BASE_COST, Math.ceil(text.length / 4));
}

// ─── UBI Calculator ───────────────────────────────────────────

/**
 * Compute Universal Basic Income tokens earned since last save.
 *
 * @param lastSaveTime - ISO timestamp of last ledger save (or null if first save)
 * @param currentTime - Current time (default: now)
 * @returns Tokens earned via UBI (capped at UBI_MAX_PER_SESSION)
 */
export function computeUBI(
  lastSaveTime: string | null | undefined,
  currentTime: Date = new Date(),
): number {
  if (!lastSaveTime) return 0; // First save — no UBI

  const lastSave = new Date(lastSaveTime);
  if (isNaN(lastSave.getTime())) return 0;

  const hoursSinceLastSave = (currentTime.getTime() - lastSave.getTime()) / (1000 * 60 * 60);
  if (hoursSinceLastSave <= 0) return 0;

  const earned = Math.floor(hoursSinceLastSave * UBI_TOKENS_PER_HOUR);
  return Math.min(earned, UBI_MAX_PER_SESSION);
}

/**
 * Compute bonus tokens for specific experience event types.
 *
 * @param eventType - The experience event type
 * @returns Bonus tokens to add to budget
 */
export function computeEventBonus(eventType: string | undefined): number {
  switch (eventType) {
    case 'success': return SUCCESS_BONUS;
    case 'learning': return LEARNING_BONUS;
    default: return 0;
  }
}

// ─── Budget Manager ───────────────────────────────────────────

/**
 * Stateless budget operations.
 *
 * The budget is stored as a number in session_handoffs.cognitive_budget.
 * These functions compute the new balance — they don't persist anything.
 * The caller (ledgerHandlers.ts) is responsible for persistence.
 */

/**
 * Process a budget spend operation.
 *
 * @param currentBalance - Current budget balance
 * @param rawTokenCost - Raw token cost of the entry
 * @param surprisal - Surprisal score of the content [0, 1]
 * @param budgetSize - Initial budget size (for diagnostics)
 * @returns BudgetResult with new balance, warnings, and diagnostics
 */
export function spendBudget(
  currentBalance: number,
  rawTokenCost: number,
  surprisal: number,
  budgetSize: number = DEFAULT_BUDGET_SIZE,
): BudgetResult {
  const safeCost = Math.max(MINIMUM_BASE_COST, rawTokenCost);
  const multiplier = computeCostMultiplier(surprisal);
  const adjustedCost = Math.ceil(safeCost * multiplier);

  const newBalance = currentBalance - adjustedCost;
  const remaining = Math.max(0, newBalance);

  let warning: string | undefined;

  if (newBalance <= 0) {
    warning = `⚠️ Cognitive budget exhausted (${remaining}/${budgetSize} tokens). ` +
      'Consider saving more concise, high-signal entries. ' +
      'Budget recovers passively over time (+100 tokens/hour).';
  } else if (newBalance < LOW_BUDGET_THRESHOLD) {
    warning = `⚡ Cognitive budget running low (${remaining}/${budgetSize} tokens). ` +
      'Prioritize novel, dense entries to reduce cost.';
  }

  return {
    allowed: true, // Always allow — graceful degradation
    spent: adjustedCost,
    remaining,
    warning,
    surprisal,
    costMultiplier: multiplier,
  };
}

/**
 * Apply Universal Basic Income + event bonuses to a budget balance.
 *
 * @param currentBalance - Current budget balance
 * @param lastSaveTime - ISO timestamp of last save
 * @param eventType - Optional event type for bonus
 * @param budgetSize - Maximum budget cap
 * @returns New balance after UBI + bonuses (capped at budgetSize)
 */
export function applyEarnings(
  currentBalance: number,
  lastSaveTime: string | null | undefined,
  eventType: string | undefined,
  budgetSize: number = DEFAULT_BUDGET_SIZE,
): { newBalance: number; ubiEarned: number; bonusEarned: number } {
  const ubiEarned = computeUBI(lastSaveTime);
  const bonusEarned = computeEventBonus(eventType);

  // Cap at initial budget size — can't exceed maximum
  const newBalance = Math.min(budgetSize, currentBalance + ubiEarned + bonusEarned);

  return { newBalance, ubiEarned, bonusEarned };
}

/**
 * Format budget diagnostics for inclusion in MCP response text.
 *
 * @param result - The BudgetResult from spendBudget()
 * @param budgetSize - Initial budget size
 * @param ubiEarned - Tokens earned from UBI this operation
 * @param bonusEarned - Tokens earned from event bonus
 * @returns Formatted diagnostic string
 */
export function formatBudgetDiagnostics(
  result: BudgetResult,
  budgetSize: number = DEFAULT_BUDGET_SIZE,
  ubiEarned: number = 0,
  bonusEarned: number = 0,
): string {
  const parts: string[] = [];

  // Budget line
  const barLength = 20;
  const fillLength = Math.round((result.remaining / budgetSize) * barLength);
  const bar = '█'.repeat(Math.max(0, fillLength)) + '░'.repeat(Math.max(0, barLength - fillLength));
  parts.push(`💰 Budget: ${bar} ${result.remaining}/${budgetSize}`);

  // Surprisal line
  if (result.surprisal !== undefined) {
    const surprisalLabel = result.surprisal < BOILERPLATE_THRESHOLD ? 'boilerplate'
      : result.surprisal > NOVEL_THRESHOLD ? 'novel'
      : 'standard';
    parts.push(`📊 Surprisal: ${result.surprisal.toFixed(2)} (${surprisalLabel}) — cost: ${result.costMultiplier?.toFixed(1)}×`);
  }

  // Cost line
  parts.push(`🪙 Spent: ${result.spent} tokens`);

  // Earnings line (if any)
  if (ubiEarned > 0 || bonusEarned > 0) {
    const earningParts: string[] = [];
    if (ubiEarned > 0) earningParts.push(`+${ubiEarned} UBI`);
    if (bonusEarned > 0) earningParts.push(`+${bonusEarned} bonus`);
    parts.push(`📈 Earned: ${earningParts.join(', ')}`);
  }

  return parts.join('\n');
}
```

### `src/memory/surprisalGate.ts`
```typescript
/**
 * Surprisal Gate — Vector-Based Novelty Scoring (v9.0)
 *
 * ═══════════════════════════════════════════════════════════════════
 * PURPOSE:
 *   Computes the information-theoretic "surprisal" of an incoming
 *   memory entry by measuring its semantic distance from recent entries.
 *
 * WHY NOT TF-IDF:
 *   A naive TF-IDF approach would require downloading all summaries
 *   into V8 memory and running a custom JS tokenizer. On projects with
 *   10K+ entries (common after Universal Import), this blocks the
 *   Node.js event loop for seconds, causing MCP handshake timeouts.
 *
 * VECTOR-BASED SURPRISAL:
 *   Surprisal = 1 - max_similarity_to_recent_entries
 *
 *   When the agent tries to save an entry, we embed the summary
 *   (already happening in the save flow) and query the DB for the
 *   single most similar entry from the last 7 days.
 *
 *   - Similarity 0.95 → Surprisal 0.05 → "You're repeating yourself" → 2× cost
 *   - Similarity 0.40 → Surprisal 0.60 → "Completely novel thought" → 0.5× cost
 *
 *   This uses the existing native sqlite-vec index, takes < 5ms,
 *   uses zero extra memory, and is far more accurate than word counting.
 *
 * FILES THAT IMPORT THIS:
 *   - src/tools/ledgerHandlers.ts (surprisal computation during save)
 * ═══════════════════════════════════════════════════════════════════
 */

import { debugLog } from "../utils/logger.js";

// ─── Types ────────────────────────────────────────────────────

export interface SurprisalResult {
  /** Surprisal score in [0.0, 1.0]. Higher = more novel. */
  surprisal: number;
  /** Similarity to the closest recent entry (for diagnostics) */
  maxSimilarity: number;
  /** Whether the entry is classified as boilerplate */
  isBoilerplate: boolean;
  /** Whether the entry is classified as novel */
  isNovel: boolean;
}

// ─── Constants ────────────────────────────────────────────────

/** Maximum age of entries to compare against (days) */
export const RECENCY_WINDOW_DAYS = 7;

/** Number of similar entries to fetch for comparison */
export const TOP_K = 1;

/** Similarity above which content is considered boilerplate */
export const BOILERPLATE_SIMILARITY = 0.80;

/** Similarity below which content is considered novel */
export const NOVEL_SIMILARITY = 0.30;

// ─── Core Computation ─────────────────────────────────────────

/**
 * Compute surprisal from a semantic similarity score.
 *
 * This is the pure math core — no I/O. The caller is responsible
 * for running the actual vector search to find maxSimilarity.
 *
 * @param maxSimilarity - Cosine similarity to the most similar recent entry (0-1)
 * @returns SurprisalResult with classification
 */
export function computeSurprisal(maxSimilarity: number): SurprisalResult {
  // Guard: no recent entries found (first entry in project) → maximum novelty
  if (!Number.isFinite(maxSimilarity) || maxSimilarity < 0) {
    return {
      surprisal: 1.0,
      maxSimilarity: 0.0,
      isBoilerplate: false,
      isNovel: true,
    };
  }

  // Clamp to [0, 1]
  const clamped = Math.min(1.0, Math.max(0.0, maxSimilarity));
  const surprisal = 1.0 - clamped;

  return {
    surprisal,
    maxSimilarity: clamped,
    isBoilerplate: clamped >= BOILERPLATE_SIMILARITY,
    isNovel: clamped <= NOVEL_SIMILARITY,
  };
}

/**
 * Compute surprisal using the existing storage backend's vector search.
 *
 * This is the integration wrapper. It:
 * 1. Takes the query embedding (already generated for the save flow)
 * 2. Finds the most similar recent entry via sqlite-vec
 * 3. Computes surprisal = 1 - max_similarity
 *
 * Falls back to surprisal=0.5 (neutral) on any error, to avoid
 * blocking saves due to search failures.
 *
 * @param searchFn - The storage backend's searchMemory function
 * @param queryEmbedding - JSON-stringified embedding of the new entry
 * @param project - Project scope
 * @param userId - Tenant ID
 * @returns SurprisalResult
 */
export async function computeVectorSurprisal(
  searchFn: (params: {
    queryEmbedding: string;
    project?: string | null;
    limit: number;
    similarityThreshold: number;
    userId: string;
  }) => Promise<Array<{ similarity: number }>>,
  queryEmbedding: string,
  project: string,
  userId: string,
): Promise<SurprisalResult> {
  try {
    // Search for the single most similar recent entry
    // Using a very low threshold (0.0) to get the closest match regardless
    const results = await searchFn({
      queryEmbedding,
      project,
      limit: TOP_K,
      similarityThreshold: 0.0, // Get closest match regardless of distance
      userId,
    });

    if (results.length === 0) {
      // No existing entries → fully novel
      debugLog('[surprisal] No recent entries found — maximum novelty');
      return computeSurprisal(-1);
    }

    const maxSimilarity = results[0].similarity;
    debugLog(`[surprisal] Max similarity to recent entries: ${maxSimilarity.toFixed(3)}`);
    return computeSurprisal(maxSimilarity);
  } catch (err) {
    // Non-fatal: fall back to neutral surprisal
    debugLog(`[surprisal] Vector search failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return {
      surprisal: 0.5,
      maxSimilarity: 0.5,
      isBoilerplate: false,
      isNovel: false,
    };
  }
}
```

---

## Modified Files Diff

```diff
diff --git a/src/config.ts b/src/config.ts
index e8085b0..4da0f82 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,6 +1,7 @@
 import { readFileSync } from "node:fs";
 import { dirname, resolve } from "node:path";
 import { fileURLToPath } from "node:url";
+import { getSettingSync } from "./storage/configStorage.js";
 
 /**
  * Configuration & Environment Variables
@@ -91,8 +92,11 @@ export const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
 // Set PRISM_STORAGE=local to use SQLite (once implemented).
 // Set PRISM_STORAGE=supabase to use Supabase REST API (default).
 
+// NOTE: This constant captures the env-var snapshot at import time.
+// The actual storage backend decision is made in storage/index.ts,
+// which consults prism-config.db first, then process.env, then defaults to "local".
 export const PRISM_STORAGE: "local" | "supabase" =
-  (process.env.PRISM_STORAGE as "local" | "supabase") || "supabase";
+  (process.env.PRISM_STORAGE as "local" | "supabase") || "local";
 // Logged at debug level — see debug() at bottom of file
 
 // ─── Optional: Supabase (Session Memory Module) ───────────────
@@ -162,9 +166,23 @@ export const PRISM_DEBUG_LOGGING = process.env.PRISM_DEBUG_LOGGING === "true";
 // The role parameter on existing tools (session_save_ledger, etc.)
 // is always available regardless of this flag — adding a parameter
 // doesn't increase tool count.
-// Set PRISM_ENABLE_HIVEMIND=true to unlock the Agent Registry tools.
-
-export const PRISM_ENABLE_HIVEMIND = process.env.PRISM_ENABLE_HIVEMIND === "true";
+//
+// SOURCE OF TRUTH: The Mind Palace dashboard (Settings → Hivemind Mode)
+// persists this flag to prism-config.db via getSettingSync() at call time.
+//
+// ⚠️ IMPORTANT: This _ENV constant captures ONLY the env-var fallback.
+// config.ts is evaluated at ESM import time, BEFORE initConfigStorage()
+// populates the settings cache. Use getSettingSync("hivemind_enabled",
+// String(PRISM_ENABLE_HIVEMIND_ENV)) at each call site for the live value.
+export const PRISM_ENABLE_HIVEMIND_ENV = process.env.PRISM_ENABLE_HIVEMIND === "true";
+
+// ─── v3.0: Task Router Feature Flag ──────────────────────────
+// Routes tasks to the local Claw agent when enabled.
+// SOURCE OF TRUTH: dashboard (Settings → Task Router) → prism-config.db.
+// Same _ENV pattern: use getSettingSync() at call sites.
+// REMOVED: PRISM_TASK_ROUTER_ENABLED used to call getSettingSync() at import time,
+// which always returned the fallback due to the ESM race condition (settingsCache=null).
+// Use PRISM_TASK_ROUTER_ENABLED_ENV (line ~368) and getSettingSync() at call sites instead.
 
 // ─── v4.1: Auto-Load Projects ────────────────────────────────
 // Auto-load is configured exclusively via the Mind Palace dashboard
@@ -382,8 +400,10 @@ export const PRISM_VERIFICATION_DEFAULT_SEVERITY =
 // Autonomous pipeline runner: PLAN → EXECUTE → VERIFY → iterate.
 // Opt-in because it executes LLM calls in the background.
 
-/** Master switch for the Dark Factory background runner. */
-export const PRISM_DARK_FACTORY_ENABLED =
+/** Master switch for the Dark Factory background runner.
+ *  ⚠️ ENV-only fallback. Use getSettingSync("dark_factory_enabled",
+ *  String(PRISM_DARK_FACTORY_ENABLED_ENV)) at call sites. */
+export const PRISM_DARK_FACTORY_ENABLED_ENV =
   process.env.PRISM_DARK_FACTORY_ENABLED === "true"; // Opt-in
 
 /** Poll interval for the runner loop (ms). Default: 30s. */
@@ -425,3 +445,38 @@ export const PRISM_SYNAPSE_SOFT_CAP = parseInt(
   process.env.PRISM_SYNAPSE_SOFT_CAP || "20", 10
 );
 
+// ─── v9.0: Affect-Tagged Memory (Valence Engine) ─────────────
+// Derives emotional valence from experience events and uses
+// Affective Salience (|valence| boosts retrieval) for ranking.
+
+/** Master switch for affect-tagged memory. (Default: true) */
+export const PRISM_VALENCE_ENABLED =
+  (process.env.PRISM_VALENCE_ENABLED ?? "true") !== "false";
+
+/** Weight of |valence| in hybrid scoring formula. (Default: 0.1) */
+export const PRISM_VALENCE_WEIGHT = parseFloat(
+  process.env.PRISM_VALENCE_WEIGHT || "0.1"
+);
+
+/** Average valence below this threshold triggers a UX warning. (Default: -0.3) */
+export const PRISM_VALENCE_WARNING_THRESHOLD = parseFloat(
+  process.env.PRISM_VALENCE_WARNING_THRESHOLD || "-0.3"
+);
+
+// ─── v9.0: Token-Economic RL (Cognitive Budget) ──────────────
+// Implements a strict token economy for agent memory operations.
+// Budget is persistent (stored in session_handoffs.cognitive_budget).
+
+/** Master switch for the cognitive budget system. (Default: true) */
+export const PRISM_COGNITIVE_BUDGET_ENABLED =
+  (process.env.PRISM_COGNITIVE_BUDGET_ENABLED ?? "true") !== "false";
+
+/** Initial budget size per project in tokens. (Default: 2000) */
+export const PRISM_COGNITIVE_BUDGET_SIZE = parseInt(
+  process.env.PRISM_COGNITIVE_BUDGET_SIZE || "2000", 10
+);
+
+/** Master switch for the surprisal gate. (Default: true) */
+export const PRISM_SURPRISAL_GATE_ENABLED =
+  (process.env.PRISM_SURPRISAL_GATE_ENABLED ?? "true") !== "false";
+
diff --git a/src/dashboard/server.ts b/src/dashboard/server.ts
index 46ad0ce..43daf76 100644
--- a/src/dashboard/server.ts
+++ b/src/dashboard/server.ts
@@ -21,6 +21,9 @@ import * as http from "http";
 import * as path from "path";
 import * as os from "os";
 import * as fs from "fs";
+import * as pg from "pg";
+import { fileURLToPath } from "url";
+import { dirname, resolve } from "path";
 
 import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
 import { createServer, getAllPossibleTools } from "../server.js";
@@ -45,6 +48,14 @@ import {
 
 const PORT = parseInt(process.env.PRISM_DASHBOARD_PORT || "3000", 10);
 
+/**
+ * v9.2: SSE stream registry for migration progress.
+ * Key = progressKey (timestamp string from the client).
+ * Value = the ServerResponse that is kept open as an SSE stream.
+ * Entries are deleted when the stream ends or the client disconnects.
+ */
+const migrationProgressStreams = new Map<string, http.ServerResponse>();
+
 /** Read HTTP request body as string (Buffer-based to avoid GC thrash on large imports) */
 function readBody(req: http.IncomingMessage): Promise<string> {
   return new Promise((resolve, reject) => {
@@ -596,6 +607,12 @@ return false;}
         try {
           const { getAllSettings } = await import("../storage/configStorage.js");
           const settings = await getAllSettings();
+
+          // Since v3.0, the DB is the exclusive source of truth for dashboard UI state.
+          // Values from process.env are seeded into the DB on first startup via
+          // migrateEnvToConfigStorage(), but we no longer override DB settings here.
+          // This ensures that dashboard changes safely persist across restarts even
+          // if legacy .env values remain.
           res.writeHead(200, { "Content-Type": "application/json" });
           return res.end(JSON.stringify({ settings }));
         } catch {
@@ -604,6 +621,7 @@ return false;}
         }
       }
 
+
       // ─── API: Settings — POST (v3.0 Dashboard Settings) ───
       if (url.pathname === "/api/settings" && req.method === "POST") {
         try {
@@ -624,6 +642,121 @@ return false;}
 
       }
 
+      // ─── API: Migration Progress SSE Stream (v9.2) ───────────
+      // Client subscribes with GET /api/migration/progress?key=<progressKey>
+      // Server pushes { step, total, label, pct?, done?, error? } events.
+      // The stream is closed server-side once setup-supabase completes.
+      if (url.pathname === "/api/migration/progress" && req.method === "GET") {
+        const key = url.searchParams.get("key") || "";
+        res.writeHead(200, {
+          "Content-Type": "text/event-stream",
+          "Cache-Control": "no-cache",
+          "Connection": "keep-alive",
+          "X-Accel-Buffering": "no",
+        });
+        res.write("retry: 1000\n\n"); // 1s reconnect delay
+
+        // Register the response so setup-supabase can push events
+        migrationProgressStreams.set(key, res);
+
+        req.on("close", () => {
+          migrationProgressStreams.delete(key);
+        });
+        return; // keep connection open — do NOT call res.end() here
+      }
+
+      // ─── API: Supabase Initial Setup (v9.1) ─────────────────
+      if (url.pathname === "/api/setup-supabase" && req.method === "POST") {
+        // Hoist progressKey so the catch block can reference it for SSE error reporting
+        let progressKey: string | undefined;
+        try {
+          const body = await readBody(req);
+          const parsed = JSON.parse(body);
+          const { url: supaUrl, serviceKey, dbPassword } = parsed;
+          progressKey = parsed.progressKey as string | undefined;
+
+          if (!supaUrl || !serviceKey || !dbPassword) {
+            res.writeHead(400, { "Content-Type": "application/json" });
+            return res.end(JSON.stringify({ error: "Missing url, serviceKey, or dbPassword" }));
+          }
+
+          // Helper: push SSE progress event to the subscribed client
+          function emitProgress(step: number, total: number, label: string, extra: Record<string, unknown> = {}) {
+            const stream = migrationProgressStreams.get(progressKey || "");
+            if (!stream) return;
+            const pct = Math.round((step / total) * 100);
+            const payload = JSON.stringify({ step, total, label, pct, ...extra });
+            stream.write(`data: ${payload}\n\n`);
+          }
+
+          const TOTAL_STEPS = 6;
+          emitProgress(1, TOTAL_STEPS, "Connecting to Supabase database…");
+
+          // 1. Build DB connection string
+          const parsedUrl = new URL(supaUrl);
+          const host = parsedUrl.host; // e.g. pjddaprqhwqxtcpdmprk.supabase.co
+          const projectRef = host.split(".")[0];
+          const dbHost = `db.${projectRef}.supabase.co`;
+          const connectionString = `postgresql://postgres:${encodeURIComponent(dbPassword)}@${dbHost}:5432/postgres`;
+
+          emitProgress(2, TOTAL_STEPS, "Authenticating…");
+          // 2. Connect via pg
+          const client = new pg.Client({ connectionString });
+          await client.connect();
+
+          try {
+            emitProgress(3, TOTAL_STEPS, "Applying migration schema (027)…");
+            // 3. Inject auto-migration infrastructure
+            const currentDir = dirname(fileURLToPath(import.meta.url));
+            const sqlPath = resolve(currentDir, "../../supabase/migrations/027_auto_migration_infra.sql");
+            const sql = fs.readFileSync(sqlPath, "utf-8");
+            await client.query(sql);
+
+            emitProgress(4, TOTAL_STEPS, "Applying v9.0 schema columns…");
+            // 4. Also safely inject v9.0 columns just in case the backend tries to write them right away
+            await client.query(`
+              ALTER TABLE session_ledger ADD COLUMN IF NOT EXISTS valence REAL DEFAULT NULL;
+              CREATE INDEX IF NOT EXISTS idx_ledger_valence ON session_ledger(valence) WHERE valence IS NOT NULL;
+              ALTER TABLE session_handoffs ADD COLUMN IF NOT EXISTS cognitive_budget REAL DEFAULT NULL;
+            `);
+
+          } finally {
+            await client.end();
+          }
+
+          emitProgress(5, TOTAL_STEPS, "Persisting credentials…");
+          // 5. Persist values using configStorage
+          const { setSetting } = await import("../storage/configStorage.js");
+          await setSetting("PRISM_STORAGE", "supabase");
+          await setSetting("SUPABASE_URL", supaUrl);
+          await setSetting("SUPABASE_KEY", serviceKey);
+          await setSetting("SUPABASE_SERVICE_ROLE_KEY", serviceKey);
+
+          emitProgress(6, TOTAL_STEPS, "Complete!", { done: true });
+
+          // Close the SSE stream
+          const sseStream = migrationProgressStreams.get(progressKey || "");
+          if (sseStream) { sseStream.end(); migrationProgressStreams.delete(progressKey || ""); }
+
+          // 6. Return success
+          res.writeHead(200, { "Content-Type": "application/json" });
+          return res.end(JSON.stringify({ ok: true, message: "Supabase successfully configured! Please restart Prism." }));
+
+        } catch (err: any) {
+          console.error("[Dashboard] Supabase Setup error:", err);
+          // Emit error event to the progress stream (progressKey is captured from the outer scope)
+          const errStream = migrationProgressStreams.get(progressKey || "");
+          if (errStream) {
+            errStream.write(`data: ${JSON.stringify({ error: true, label: err.message || "Setup failed", done: false })}\n\n`);
+            errStream.end();
+            migrationProgressStreams.delete(progressKey || "");
+          }
+          res.writeHead(500, { "Content-Type": "application/json" });
+          return res.end(JSON.stringify({ error: err.message || "Failed to setup Supabase" }));
+        }
+      }
+
+
       // ─── API: Memory Analytics (v3.1) ────────────────────
       if (url.pathname === "/api/analytics" && req.method === "GET") {
         const projectName = url.searchParams.get("project");
diff --git a/src/dashboard/ui.ts b/src/dashboard/ui.ts
index 0233119..6a33166 100644
--- a/src/dashboard/ui.ts
+++ b/src/dashboard/ui.ts
@@ -1049,12 +1049,70 @@ export function renderDashboardHTML(version: string): string {
             <div class="setting-label">Storage Backend</div>
             <div class="setting-desc">Switch between SQLite and Supabase</div>
           </div>
-          <select id="storageBackendSelect" onchange="window.saveBootSetting('PRISM_STORAGE', this.value)" style="padding: 0.2rem 0.4rem; background: var(--bg-hover); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.85rem; font-family: var(--font-mono); cursor: pointer;">
+          <select id="storageBackendSelect" onchange="onStorageProviderChange(this.value)" style="padding: 0.2rem 0.4rem; background: var(--bg-hover); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.85rem; font-family: var(--font-mono); cursor: pointer;">
             <option value="local">SQLite</option>
             <option value="supabase">Supabase</option>
           </select>
         </div>
 
+        <!-- Supabase fields -->
+        <div id="provider-fields-supabase" style="display:none; padding: 1rem; background: rgba(139,92,246,0.05); border-radius: var(--radius-sm); border: 1px solid var(--border-glass); margin-top: 0.5rem;">
+          <div class="setting-section" style="margin-top:0">Supabase Connection Setup</div>
+          <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom: 1rem; line-height: 1.5;">
+            Configure your Supabase backend. This will run the migration schema to set up tables automatically before saving credentials.
+          </div>
+          
+          <div class="setting-row" style="border:none; padding:0.25rem 0">
+            <div>
+              <div class="setting-label">Supabase URL</div>
+            </div>
+            <input type="text" id="input-supabase-url"
+              placeholder="https://xyz.supabase.co"
+              style="padding: 0.3rem 0.5rem; background: var(--bg-hover); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.85rem; font-family: var(--font-mono); width: 220px;" />
+          </div>
+          <div class="setting-row" style="border:none; padding:0.25rem 0">
+            <div>
+              <div class="setting-label">Service Role Key</div>
+            </div>
+            <input type="password" id="input-supabase-key"
+              placeholder="eyJh..."
+              style="padding: 0.3rem 0.5rem; background: var(--bg-hover); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.85rem; font-family: var(--font-mono); width: 220px;" />
+          </div>
+          <div class="setting-row" style="border:none; padding:0.25rem 0">
+            <div>
+              <div class="setting-label">Database Password</div>
+              <div class="setting-desc">Needed once to bootstrap tables. Never saved.</div>
+            </div>
+            <input type="password" id="input-supabase-dbpass"
+              placeholder="••••••••"
+              style="padding: 0.3rem 0.5rem; background: var(--bg-hover); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.85rem; font-family: var(--font-mono); width: 220px;" />
+          </div>
+
+          <div style="margin-top: 1rem; display: flex; align-items: center; gap: 0.5rem;">
+            <button onclick="setupSupabase()" id="btn-setup-supabase" style="background: var(--accent-purple); color: white; border: none; padding: 0.5rem 1rem; border-radius: var(--radius-sm); font-size: 0.85rem; font-weight: 600; cursor: pointer; transition: opacity 0.2s;">
+              Set Up &amp; Migrate
+            </button>
+            <span id="setup-supabase-status" style="font-size: 0.8rem; font-weight: 500;"></span>
+          </div>
+
+          <!-- Migration progress bar (hidden until setup starts) -->
+          <div id="migration-progress-wrap" style="display:none; margin-top: 0.75rem;">
+            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 0.35rem;">
+              <span id="migration-step-label" style="font-size:0.75rem; color:var(--text-muted); font-weight:500;">Initializing…</span>
+              <span id="migration-pct-label" style="font-size:0.75rem; color:var(--accent-purple); font-weight:700;">0%</span>
+            </div>
+            <div style="height:6px; border-radius:99px; background:var(--bg-hover); overflow:hidden;">
+              <div id="migration-progress-bar"
+                style="height:100%; width:0%; border-radius:99px;
+                       background: linear-gradient(90deg, #7c3aed, #a78bfa);
+                       transition: width 0.4s cubic-bezier(0.4,0,0.2,1);"></div>
+            </div>
+            <!-- Step dots -->
+            <div id="migration-step-dots" style="display:flex; gap:0.35rem; margin-top:0.5rem; flex-wrap:wrap;"></div>
+          </div>
+
+        </div>
+
         <div class="setting-row" style="align-items:flex-start">
           <div>
             <div class="setting-label">Auto-Load Projects</div>
@@ -3197,6 +3255,146 @@ function onEmbeddingProviderChange(value) {
     refreshAnthropicWarning(textVal, value);
     saveBootSetting('embedding_provider', value);
 }
+
+function onStorageProviderChange(value) {
+    var supFields = document.getElementById('provider-fields-supabase');
+    if (supFields) supFields.style.display = value === 'supabase' ? '' : 'none';
+    
+    // Only auto-save if switching to local. Supabase is saved via the migrate button.
+    if (value === 'local') {
+        saveBootSetting('PRISM_STORAGE', value);
+    }
+}
+
+function setupSupabase() {
+    var url = document.getElementById('input-supabase-url').value.trim();
+    var serviceKey = document.getElementById('input-supabase-key').value.trim();
+    var dbPassword = document.getElementById('input-supabase-dbpass').value.trim();
+    var statusEl = document.getElementById('setup-supabase-status');
+    var btn = document.getElementById('btn-setup-supabase');
+
+    if (!url || !serviceKey || !dbPassword) {
+        statusEl.innerText = "All fields required.";
+        statusEl.style.color = "var(--accent-rose)";
+        return;
+    }
+    if (url.indexOf('https://') !== 0) {
+        statusEl.innerText = "URL must start with https://";
+        statusEl.style.color = "var(--accent-rose)";
+        return;
+    }
+    if (serviceKey.indexOf('eyJ') !== 0) {
+        statusEl.innerText = "Service key appears invalid. Expected JWT.";
+        statusEl.style.color = "var(--accent-rose)";
+        return;
+    }
+
+    // Reset UI state
+    statusEl.innerText = "Connecting & Migrating…";
+    statusEl.style.color = "var(--text-muted)";
+    btn.disabled = true;
+    btn.style.opacity = "0.5";
+
+    // Show progress bar
+    var progressWrap = document.getElementById('migration-progress-wrap');
+    var progressBar = document.getElementById('migration-progress-bar');
+    var stepLabel  = document.getElementById('migration-step-label');
+    var pctLabel   = document.getElementById('migration-pct-label');
+    var stepDots   = document.getElementById('migration-step-dots');
+    progressWrap.style.display = '';
+    progressBar.style.width = '0%';
+    stepDots.innerHTML = '';
+
+    // Helper: update bar
+    function setProgress(pct, label, ok) {
+        progressBar.style.width = pct + '%';
+        if (ok === false) progressBar.style.background = 'linear-gradient(90deg,#dc2626,#f87171)';
+        stepLabel.innerText = label;
+        pctLabel.innerText = Math.round(pct) + '%';
+    }
+
+    // Helper: add step dot
+    function addDot(label, state) {
+        var dot = document.createElement('span');
+        var colors = { pending: 'var(--text-muted)', ok: 'var(--accent-green)', err: 'var(--accent-rose)' };
+        var icons  = { pending: '○', ok: '✓', err: '×' };
+        dot.title = label;
+        dot.style.cssText = 'display:inline-flex;align-items:center;gap:2px;font-size:0.7rem;color:' + colors[state] + ';font-weight:600;';
+        dot.innerText = icons[state] + ' ' + label;
+        stepDots.appendChild(dot);
+    }
+
+    setProgress(5, 'Connecting to Supabase…');
+
+    // Subscribe to server-sent progress events for this session
+    var evtKey = Date.now().toString();
+    var sse = new EventSource('/api/migration/progress?key=' + evtKey);
+    var sseTimeout = setTimeout(function() {
+        if (sse) { sse.close(); sse = null; }
+    }, 120000); // 2-min safety timeout
+
+    if (sse) {
+        sse.onmessage = function(e) {
+            try {
+                var msg = JSON.parse(e.data);
+                // msg: { step, total, label, pct?, done?, error? }
+                var pct = msg.pct !== undefined ? msg.pct : Math.round((msg.step / msg.total) * 100);
+                if (msg.error) {
+                    setProgress(pct, '⚠ ' + msg.label, false);
+                    addDot(msg.label, 'err');
+                } else if (msg.done) {
+                    setProgress(100, '✓ All migrations applied');
+                    addDot('Done', 'ok');
+                    if (sse) { sse.close(); sse = null; }
+                    clearTimeout(sseTimeout);
+                } else {
+                    setProgress(pct, msg.label);
+                    if (msg.step > 1) addDot(msg.prevLabel || msg.label, 'ok');
+                }
+            } catch(_) {}
+        };
+        sse.onerror = function() {
+            // SSE closed server-side after completion — normal
+            if (sse) { sse.close(); sse = null; }
+            clearTimeout(sseTimeout);
+        };
+    }
+
+    fetch('/api/setup-supabase', {
+        method: 'POST',
+        headers: { 'Content-Type': 'application/json' },
+        body: JSON.stringify({ url: url, serviceKey: serviceKey, dbPassword: dbPassword, progressKey: evtKey })
+    })
+    .then(function(res) {
+        return res.json().then(function(data) {
+            if (res.ok && data.ok) {
+                setProgress(100, '✓ All done!');
+                statusEl.innerText = "✓ Configured. Restart Prism.";
+                statusEl.style.color = "var(--accent-green)";
+                setTimeout(function() {
+                    alert("Supabase configured!\\n\\nRestart Prism MCP server for changes to take effect.");
+                }, 300);
+            } else {
+                var errMsg = data.error || "Setup failed.";
+                setProgress(progressBar ? parseFloat(progressBar.style.width) : 0, '⚠ ' + errMsg, false);
+                statusEl.innerText = errMsg;
+                statusEl.style.color = "var(--accent-rose)";
+            }
+        });
+    })
+    .catch(function() {
+        setProgress(0, 'Network error', false);
+        statusEl.innerText = "Network error.";
+        statusEl.style.color = "var(--accent-rose)";
+    })
+    .finally(function() {
+        btn.disabled = false;
+        btn.style.opacity = "1";
+        if (sse) { sse.close(); sse = null; }
+        clearTimeout(sseTimeout);
+    });
+}
+
 // Shows/hides the Anthropic+auto warning.
 // Warning appears when: text=anthropic AND embedding=auto (auto-bridges to Gemini).
 function refreshAnthropicWarning(textVal, embedVal) {
@@ -3439,6 +3637,14 @@ function loadSettings() {
                     // Storage Backend
                     if (s.PRISM_STORAGE) {
                         document.getElementById('storageBackendSelect').value = s.PRISM_STORAGE;
+                        var supFields = document.getElementById('provider-fields-supabase');
+                        if (supFields) supFields.style.display = s.PRISM_STORAGE === 'supabase' ? '' : 'none';
+                    }
+                    if (s.SUPABASE_URL) {
+                        document.getElementById('input-supabase-url').value = s.SUPABASE_URL;
+                    }
+                    if (s.SUPABASE_SERVICE_KEY) {
+                        document.getElementById('input-supabase-key').placeholder = '(key saved — paste to update)';
                     }
                     // Agent Identity
                     if (s.default_role)
diff --git a/src/scholar/webScholar.ts b/src/scholar/webScholar.ts
index 98cfdb8..2053a10 100644
--- a/src/scholar/webScholar.ts
+++ b/src/scholar/webScholar.ts
@@ -5,8 +5,9 @@ import {
   PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN,
   PRISM_USER_ID,
   PRISM_SCHOLAR_TOPICS,
-  PRISM_ENABLE_HIVEMIND
+  PRISM_ENABLE_HIVEMIND_ENV
 } from "../config.js";
+import { getSettingSync } from "../storage/configStorage.js";
 import { getStorage } from "../storage/index.js";
 import { debugLog } from "../utils/logger.js";
 import { getLLMProvider } from "../utils/llm/factory.js";
@@ -34,7 +35,7 @@ const SCHOLAR_ROLE = "scholar";
  * Gracefully no-ops when Hivemind is disabled.
  */
 async function hivemindRegister(topic: string): Promise<void> {
-  if (!PRISM_ENABLE_HIVEMIND) return;
+  if (getSettingSync("hivemind_enabled", String(PRISM_ENABLE_HIVEMIND_ENV)) !== "true") return;
   try {
     const storage = await getStorage();
     await storage.registerAgent({
@@ -52,7 +53,7 @@ async function hivemindRegister(topic: string): Promise<void> {
 }
 
 async function hivemindHeartbeat(task: string): Promise<void> {
-  if (!PRISM_ENABLE_HIVEMIND) return;
+  if (getSettingSync("hivemind_enabled", String(PRISM_ENABLE_HIVEMIND_ENV)) !== "true") return;
   try {
     const storage = await getStorage();
     await storage.heartbeatAgent(SCHOLAR_PROJECT, PRISM_USER_ID, SCHOLAR_ROLE, task);
@@ -60,7 +61,7 @@ async function hivemindHeartbeat(task: string): Promise<void> {
 }
 
 async function hivemindIdle(): Promise<void> {
-  if (!PRISM_ENABLE_HIVEMIND) return;
+  if (getSettingSync("hivemind_enabled", String(PRISM_ENABLE_HIVEMIND_ENV)) !== "true") return;
   try {
     const storage = await getStorage();
     await storage.updateAgentStatus(SCHOLAR_PROJECT, PRISM_USER_ID, SCHOLAR_ROLE, "idle");
@@ -74,7 +75,7 @@ async function hivemindIdle(): Promise<void> {
  * the Scholar's state change and generate alerts for active agents.
  */
 async function hivemindBroadcast(topic: string, articleCount: number): Promise<void> {
-  if (!PRISM_ENABLE_HIVEMIND) return;
+  if (getSettingSync("hivemind_enabled", String(PRISM_ENABLE_HIVEMIND_ENV)) !== "true") return;
   try {
     const storage = await getStorage();
     // Update Scholar's current_task so the Watchdog and Dashboard show the result
@@ -106,7 +107,7 @@ async function selectTopic(): Promise<string> {
   // Default: random pick
   const randomPick = topics[Math.floor(Math.random() * topics.length)];
 
-  if (!PRISM_ENABLE_HIVEMIND) return randomPick;
+  if (getSettingSync("hivemind_enabled", String(PRISM_ENABLE_HIVEMIND_ENV)) !== "true") return randomPick;
 
   try {
     const storage = await getStorage();
diff --git a/src/server.ts b/src/server.ts
index bdd157a..fd8da12 100644
--- a/src/server.ts
+++ b/src/server.ts
@@ -69,14 +69,14 @@ import {
 import type { Tool } from "@modelcontextprotocol/sdk/types.js";
 
 import {
-  SERVER_CONFIG, SESSION_MEMORY_ENABLED, PRISM_USER_ID, PRISM_ENABLE_HIVEMIND,
+  SERVER_CONFIG, SESSION_MEMORY_ENABLED, PRISM_USER_ID, PRISM_ENABLE_HIVEMIND_ENV,
   WATCHDOG_INTERVAL_MS, WATCHDOG_STALE_MIN, WATCHDOG_FROZEN_MIN,
   WATCHDOG_OFFLINE_MIN, WATCHDOG_LOOP_THRESHOLD,
   PRISM_SCHEDULER_ENABLED, PRISM_SCHEDULER_INTERVAL_MS,
   PRISM_SCHOLAR_ENABLED,
   PRISM_HDC_ENABLED,
   PRISM_TASK_ROUTER_ENABLED_ENV,
-  PRISM_DARK_FACTORY_ENABLED,
+  PRISM_DARK_FACTORY_ENABLED_ENV,
 } from "./config.js";
 import { startWatchdog, drainAlerts } from "./hivemindWatchdog.js";
 import { startScheduler, startScholarScheduler } from "./backgroundScheduler.js";
@@ -93,7 +93,7 @@ import { acquireLock, registerShutdownHandlers } from "./lifecycle.js";
 // error wrapper. Now uses getStorage() which routes through the
 // correct backend (Supabase or SQLite) with proper error handling.
 import { getStorage } from "./storage/index.js";
-import { getSettingSync, initConfigStorage } from "./storage/configStorage.js";
+import { getSettingSync, initConfigStorage, setSetting } from "./storage/configStorage.js";
 import { getTracer, initTelemetry } from "./utils/telemetry.js";
 import { context as otelContext, trace, SpanStatusCode } from "@opentelemetry/api";
 
@@ -381,9 +381,9 @@ export function getAvailableTools(): Tool[] {
   return [
     ...BASE_TOOLS,
     ...SESSION_MEMORY_TOOLS,
-    ...(PRISM_ENABLE_HIVEMIND ? AGENT_REGISTRY_TOOLS : []),
+    ...(getSettingSync("hivemind_enabled", String(PRISM_ENABLE_HIVEMIND_ENV)) === "true" ? AGENT_REGISTRY_TOOLS : []),
     ...(getSettingSync("task_router_enabled", String(PRISM_TASK_ROUTER_ENABLED_ENV)) === "true" ? [SESSION_TASK_ROUTE_TOOL] : []),
-    ...(PRISM_DARK_FACTORY_ENABLED ? [SESSION_START_PIPELINE_TOOL, SESSION_CHECK_PIPELINE_STATUS_TOOL, SESSION_ABORT_PIPELINE_TOOL] : []),
+    ...(getSettingSync("dark_factory_enabled", String(PRISM_DARK_FACTORY_ENABLED_ENV)) === "true" ? [SESSION_START_PIPELINE_TOOL, SESSION_CHECK_PIPELINE_STATUS_TOOL, SESSION_ABORT_PIPELINE_TOOL] : []),
   ];
 }
 
@@ -915,17 +915,17 @@ export function createServer() {
 
           case "agent_register":
             if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured.");
-            if (!PRISM_ENABLE_HIVEMIND) throw new Error("Hivemind not enabled. Set PRISM_ENABLE_HIVEMIND=true.");
+            if (getSettingSync("hivemind_enabled", String(PRISM_ENABLE_HIVEMIND_ENV)) !== "true") throw new Error("Hivemind not enabled. Enable it in the dashboard or set PRISM_ENABLE_HIVEMIND=true.");
             result = await agentRegisterHandler(args); break;
 
           case "agent_heartbeat":
             if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured.");
-            if (!PRISM_ENABLE_HIVEMIND) throw new Error("Hivemind not enabled. Set PRISM_ENABLE_HIVEMIND=true.");
+            if (getSettingSync("hivemind_enabled", String(PRISM_ENABLE_HIVEMIND_ENV)) !== "true") throw new Error("Hivemind not enabled. Enable it in the dashboard or set PRISM_ENABLE_HIVEMIND=true.");
             result = await agentHeartbeatHandler(args); break;
 
           case "agent_list_team":
             if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured.");
-            if (!PRISM_ENABLE_HIVEMIND) throw new Error("Hivemind not enabled. Set PRISM_ENABLE_HIVEMIND=true.");
+            if (getSettingSync("hivemind_enabled", String(PRISM_ENABLE_HIVEMIND_ENV)) !== "true") throw new Error("Hivemind not enabled. Enable it in the dashboard or set PRISM_ENABLE_HIVEMIND=true.");
             result = await agentListTeamHandler(args); break;
 
           // ─── v7.1: Task Router ───
@@ -939,17 +939,17 @@ export function createServer() {
 
           case "session_start_pipeline":
             if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured.");
-            if (!PRISM_DARK_FACTORY_ENABLED) throw new Error("Dark Factory not enabled. Set PRISM_DARK_FACTORY_ENABLED=true.");
+            if (getSettingSync("dark_factory_enabled", String(PRISM_DARK_FACTORY_ENABLED_ENV)) !== "true") throw new Error("Dark Factory not enabled. Enable it in the dashboard or set PRISM_DARK_FACTORY_ENABLED=true.");
             result = await sessionStartPipelineHandler(args); break;
 
           case "session_check_pipeline_status":
             if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured.");
-            if (!PRISM_DARK_FACTORY_ENABLED) throw new Error("Dark Factory not enabled. Set PRISM_DARK_FACTORY_ENABLED=true.");
+            if (getSettingSync("dark_factory_enabled", String(PRISM_DARK_FACTORY_ENABLED_ENV)) !== "true") throw new Error("Dark Factory not enabled. Enable it in the dashboard or set PRISM_DARK_FACTORY_ENABLED=true.");
             result = await sessionCheckPipelineStatusHandler(args); break;
 
           case "session_abort_pipeline":
             if (!SESSION_MEMORY_ENABLED) throw new Error("Session memory not configured.");
-            if (!PRISM_DARK_FACTORY_ENABLED) throw new Error("Dark Factory not enabled. Set PRISM_DARK_FACTORY_ENABLED=true.");
+            if (getSettingSync("dark_factory_enabled", String(PRISM_DARK_FACTORY_ENABLED_ENV)) !== "true") throw new Error("Dark Factory not enabled. Enable it in the dashboard or set PRISM_DARK_FACTORY_ENABLED=true.");
             result = await sessionAbortPipelineHandler(args); break;
 
           default:
@@ -965,7 +965,7 @@ export function createServer() {
         // CRITICAL: Append alerts DIRECTLY to tool response content
         // so the LLM actually reads them. sendLoggingMessage goes to
         // debug logs which the LLM never sees.
-        if (PRISM_ENABLE_HIVEMIND && result && !result.isError) {
+        if (getSettingSync("hivemind_enabled", String(PRISM_ENABLE_HIVEMIND_ENV)) === "true" && result && !result.isError) {
           const project = (args as Record<string, unknown>)?.project;
           if (typeof project === "string") {
             const alerts = drainAlerts(project);
@@ -1101,7 +1101,43 @@ export function createSandboxServer() {
  * is standard for MCP — it reads JSON-RPC from stdin and writes
  * responses to stdout. Log messages go to stderr.
  */
+/**
+ * v9.2: One-time env-to-configStorage migration.
+ *
+ * Seeds prism-config.db with values from env vars using "setIfAbsent" semantics:
+ * - If the key already has a value in configStorage (e.g., set via the dashboard),
+ *   it is NEVER overwritten.
+ * - If the key has no value yet AND the env var is set, we seed the db with the
+ *   env-var value so the dashboard UI correctly reflects the existing configuration.
+ *
+ * This is idempotent — safe to call on every startup. After the first run it becomes
+ * a no-op since all keys will already have values in configStorage.
+ *
+ * Covers: feature flags (Hivemind, Task Router, Dark Factory) and Supabase credentials.
+ */
+async function migrateEnvToConfigStorage(): Promise<void> {
+  const migrations: Array<{ dbKey: string; envValue: string | undefined }> = [
+    // Feature flags
+    { dbKey: "hivemind_enabled",    envValue: process.env.PRISM_ENABLE_HIVEMIND    ? (process.env.PRISM_ENABLE_HIVEMIND === "true" ? "true" : "false")    : undefined },
+    { dbKey: "task_router_enabled", envValue: process.env.PRISM_TASK_ROUTER_ENABLED ? (process.env.PRISM_TASK_ROUTER_ENABLED === "true" ? "true" : "false") : undefined },
+    { dbKey: "dark_factory_enabled",envValue: process.env.PRISM_DARK_FACTORY_ENABLED ? (process.env.PRISM_DARK_FACTORY_ENABLED === "true" ? "true" : "false") : undefined },
+    // Supabase credentials — only migrate if present and non-empty
+    { dbKey: "SUPABASE_URL",        envValue: process.env.SUPABASE_URL  || undefined },
+    { dbKey: "SUPABASE_KEY",        envValue: process.env.SUPABASE_KEY  || undefined },
+    { dbKey: "PRISM_STORAGE",       envValue: process.env.PRISM_STORAGE || undefined },
+  ];
+
+  for (const { dbKey, envValue } of migrations) {
+    if (!envValue) continue; // env var not set — nothing to migrate
+    const existing = getSettingSync(dbKey, "");
+    if (existing !== "") continue; // already has a value — never overwrite
+    await setSetting(dbKey, envValue);
+    console.error(`[Prism] Migrated env var → configStorage: ${dbKey} = ${dbKey.toLowerCase().includes("key") ? "***" : envValue}`);
+  }
+}
+
 export async function startServer() {
+
   // MUST BE FIRST: Kill any zombie processes and acquire the singleton PID lock
   // before touching SQLite. This prevents lock contention on prism-config.db.
   acquireLock();
@@ -1112,6 +1148,14 @@ export async function startServer() {
   // initConfigStorage() is local SQLite only (~5ms), safe to await.
   await initConfigStorage();
 
+  // v9.2: One-time env-to-configStorage migration.
+  // For users who previously set feature flags/Supabase credentials via env
+  // vars, seed configStorage with those values IF the key doesn't exist yet.
+  // This is "setIfAbsent" logic — it never overwrites a dashboard-set value.
+  // After this runs, the dashboard toggles reflect the actual runtime state.
+  await migrateEnvToConfigStorage();
+
+
   // v4.6.0: Initialize OTel AFTER the settings cache is warm so that
   // initTelemetry() can read otel_enabled/otel_endpoint from getSettingSync()
   // synchronously. This is a synchronous call — no await needed.
@@ -1287,7 +1331,7 @@ export async function startServer() {
   // Start the server-side health monitor after storage is warm.
   // Runs every WATCHDOG_INTERVAL_MS (default 60s) to detect
   // frozen agents, infinite loops, and task overruns.
-  if (PRISM_ENABLE_HIVEMIND && SESSION_MEMORY_ENABLED) {
+  if (getSettingSync("hivemind_enabled", String(PRISM_ENABLE_HIVEMIND_ENV)) === "true" && SESSION_MEMORY_ENABLED) {
     storageReady?.then(() => {
       startWatchdog({
         intervalMs: WATCHDOG_INTERVAL_MS,
@@ -1330,7 +1374,7 @@ export async function startServer() {
   // Autonomous pipeline orchestration engine. Picks up RUNNING
   // pipelines and advances them through PLAN → EXECUTE → VERIFY
   // cycles. Non-blocking — uses setInterval to yield between ticks.
-  if (PRISM_DARK_FACTORY_ENABLED && SESSION_MEMORY_ENABLED) {
+  if (getSettingSync("dark_factory_enabled", String(PRISM_DARK_FACTORY_ENABLED_ENV)) === "true" && SESSION_MEMORY_ENABLED) {
     storageReady?.then(() => {
       startDarkFactoryRunner();
     }).catch(err => {
diff --git a/src/storage/index.ts b/src/storage/index.ts
index 21f86e5..f89a6ed 100644
--- a/src/storage/index.ts
+++ b/src/storage/index.ts
@@ -1,4 +1,4 @@
-import { PRISM_STORAGE as ENV_PRISM_STORAGE, SUPABASE_CONFIGURED } from "../config.js";
+
 import { debugLog } from "../utils/logger.js";
 import { SupabaseStorage } from "./supabase.js";
 import type { StorageBackend } from "./interface.js";
@@ -7,26 +7,74 @@ import { getSetting } from "./configStorage.js";
 let storageInstance: StorageBackend | null = null;
 export let activeStorageBackend: string = "local";
 
+/** Validate that a string is an http(s) URL (mirrors logic in config.ts). */
+function isHttpUrl(value: string): boolean {
+  try {
+    const parsed = new URL(value);
+    return parsed.protocol === "http:" || parsed.protocol === "https:";
+  } catch {
+    return false;
+  }
+}
+
 /**
  * Returns the singleton storage backend.
  *
  * On first call: creates and initializes the appropriate backend.
  * On subsequent calls: returns the cached instance.
+ *
+ * SUPABASE CREDENTIAL RESOLUTION ORDER (v9.2):
+ *   1. configStorage (prism-config.db)           (set via Mind Palace dashboard)
+ *   2. process.env.SUPABASE_URL / SUPABASE_KEY  (env var fallback)
+ *
+ * If credentials are found only in configStorage, they are injected into
+ * process.env so that supabaseApi.ts (which reads module-level constants
+ * from config.ts) picks them up on the same startup cycle.
  */
 export async function getStorage(): Promise<StorageBackend> {
   if (storageInstance) return storageInstance;
 
-  // Use environment variable if explicitly set, otherwise fall back to db config
-  const envStorage = process.env.PRISM_STORAGE as "supabase" | "local" | undefined;
-  const requestedBackend = (envStorage || await getSetting("PRISM_STORAGE", ENV_PRISM_STORAGE)) as "supabase" | "local";
+  // SOURCE OF TRUTH: prism-config.db (dashboard) → env fallback → "local" default
+  // DB wins because the dashboard is the authoritative source post-migration.
+  const dbStorage = await getSetting("PRISM_STORAGE", "");
+  const requestedBackend = (dbStorage || process.env.PRISM_STORAGE || "local") as "supabase" | "local";
 
-  // Guardrail: if Supabase is requested but credentials are unresolved/invalid,
-  // transparently fall back to local mode to keep dashboard + core tools usable.
-  if (requestedBackend === "supabase" && !SUPABASE_CONFIGURED) {
-    activeStorageBackend = "local";
-    console.error(
-      "[Prism Storage] Supabase backend requested but SUPABASE_URL/SUPABASE_KEY are invalid or unresolved. Falling back to local storage."
-    );
+  if (requestedBackend === "supabase") {
+    // ─── Resolve credentials: configStorage → env var fallback ──────────
+    // v9.2: DB (dashboard) is the source of truth for Supabase credentials,
+    // consistent with PRISM_STORAGE resolution above. If the user configured
+    // Supabase via the dashboard, the values live in configStorage. Env vars
+    // are only used as a fallback for users who haven't migrated yet.
+    const resolvedUrl =
+      await getSetting("SUPABASE_URL", "") ||
+      process.env.SUPABASE_URL ||
+      "";
+    const resolvedKey =
+      await getSetting("SUPABASE_KEY", "") ||
+      await getSetting("SUPABASE_SERVICE_ROLE_KEY", "") ||
+      process.env.SUPABASE_KEY ||
+      "";
+
+    const isConfigured = !!resolvedUrl && !!resolvedKey && isHttpUrl(resolvedUrl);
+
+    if (!isConfigured) {
+      activeStorageBackend = "local";
+      console.error(
+        "[Prism Storage] Supabase backend requested but credentials are missing or invalid " +
+        "(checked both process.env and prism-config.db). Falling back to local storage.\n" +
+        "  → Configure via Mind Palace dashboard (Settings → Storage Backend → Supabase) or set SUPABASE_URL / SUPABASE_KEY env vars."
+      );
+    } else {
+      // Inject resolved credentials into process.env so supabaseApi.ts
+      // (which reads config.ts module-level constants) can use them.
+      // This is safe: process.env injection only affects in-process lookups;
+      // it doesn't mutate the shell environment of the parent process.
+      // Always overwrite — DB is the source of truth post-v9.2.
+      process.env.SUPABASE_URL  = resolvedUrl;
+      process.env.SUPABASE_KEY  = resolvedKey;
+      activeStorageBackend = "supabase";
+      debugLog(`[Prism Storage] Supabase credentials resolved (source: ${await getSetting("SUPABASE_URL", "") ? "configStorage" : "env"})`);
+    }
   } else {
     activeStorageBackend = requestedBackend;
   }
@@ -49,6 +97,7 @@ export async function getStorage(): Promise<StorageBackend> {
   return storageInstance;
 }
 
+
 /**
  * Closes the active storage backend and resets the singleton.
  * Used for testing and graceful shutdown.
diff --git a/src/storage/interface.ts b/src/storage/interface.ts
index b692099..926ae1a 100644
--- a/src/storage/interface.ts
+++ b/src/storage/interface.ts
@@ -81,6 +81,12 @@ export interface LedgerEntry {
   confidence_score?: number; // 1-100 — agent's confidence in the outcome
   importance?: number;       // 0+ — upvote-driven importance scoring (for insight graduation)
 
+  // ─── v9.0: Affect-Tagged Memory ─────────────────────────────────
+  // Valence score derived from event_type at save time.
+  // Uses Affective Salience: |valence| boosts retrieval (magnitude = salience),
+  // while sign (±) drives UX warnings (negative = historical friction).
+  valence?: number | null;   // -1.0 (failure/trauma) to +1.0 (success/confidence)
+
   // ─── Phase 2: GDPR Soft Delete ───────────────────────────────
   // When deleted_at is set, the entry is "tombstoned" — hidden from
   // all search queries but still physically present for audit trails.
@@ -118,6 +124,12 @@ export interface HandoffEntry {
   // OCC
   version?: number;
 
+  // ─── v9.0: Token-Economic RL ──────────────────────────────────
+  // Persistent cognitive budget: belongs to the PROJECT, not the session.
+  // Prevents the "Reset Exploit" (close/reopen to get free tokens).
+  // Revenue via UBI (+100 tokens/hour) + success/learning bonuses.
+  cognitive_budget?: number | null;  // null = default (2000); 0+ = current balance
+
   // Metadata (extensible for git drift, screenshots, etc.)
   metadata?: Record<string, unknown>;
 }
@@ -176,6 +188,8 @@ export interface SemanticSearchResult {
   /** True when the node was discovered via Synapse multi-hop traversal,
    *  not present in the original semantic/keyword anchors. */
   isDiscovered?: boolean;
+  // v9.0: Affect-Tagged Memory — valence for display/routing
+  valence?: number | null;
 }
 
 // ─── v3.0: Agent Registry Types ──────────────────────────────
@@ -312,6 +326,15 @@ export interface StorageBackend {
    */
   patchLedger(id: string, data: Record<string, unknown>): Promise<void>;
 
+  /**
+   * v9.0: Patch only the cognitive_budget field on a project's handoff row.
+   * Lightweight alternative to full saveHandoff — doesn't trigger OCC/CRDT/snapshots.
+   * @param project - Project identifier
+   * @param userId - User ID
+   * @param budget - New budget balance
+   */
+  patchHandoffBudget(project: string, userId: string, budget: number): Promise<void>;
+
   /**
    * Read ledger entries matching filter criteria.
    * Used by compaction to find candidates and by backfill to find missing embeddings.
diff --git a/src/storage/sqlite.ts b/src/storage/sqlite.ts
index 290e251..0204019 100644
--- a/src/storage/sqlite.ts
+++ b/src/storage/sqlite.ts
@@ -29,6 +29,7 @@ import {
   PRISM_SYNAPSE_SPREAD_FACTOR,
   PRISM_SYNAPSE_LATERAL_INHIBITION,
   PRISM_SYNAPSE_SOFT_CAP,
+  PRISM_VALENCE_ENABLED,
 } from "../config.js";
 import { getSetting as cfgGet, setSetting as cfgSet, getAllSettings as cfgGetAll } from "./configStorage.js";
 
@@ -149,7 +150,8 @@ export class SqliteStorage implements StorageBackend {
         rollup_count INTEGER DEFAULT 0,
         archived_at TEXT DEFAULT NULL,
         session_date TEXT DEFAULT NULL,
-        created_at TEXT DEFAULT (datetime('now'))
+        created_at TEXT DEFAULT (datetime('now')),
+        valence REAL DEFAULT NULL
       );
 
       -- ─── Session Handoffs (live project state, OCC-controlled) ───
@@ -164,6 +166,7 @@ export class SqliteStorage implements StorageBackend {
         key_context TEXT DEFAULT NULL,
         active_branch TEXT DEFAULT NULL,
         version INTEGER NOT NULL DEFAULT 1,
+        cognitive_budget REAL DEFAULT NULL,
         metadata TEXT DEFAULT '{}',
         created_at TEXT DEFAULT (datetime('now')),
         updated_at TEXT DEFAULT (datetime('now')),
@@ -826,6 +829,36 @@ export class SqliteStorage implements StorageBackend {
       // Non-fatal: some older libSQL versions may not support all integrity_check modes.
       debugLog(`[SqliteStorage] v6.1: integrity_check skipped (${(e as Error).message})`);
     }
+
+    // ─── v9.0 Migration: Affect-Tagged Memory (Valence) ───────────
+    //
+    // Adds a REAL valence column to session_ledger for affect-tagged memory.
+    // Valence is auto-derived from event_type at save time.
+    // Uses Affective Salience: |valence| boosts retrieval, sign drives UX warnings.
+    // For fresh DBs, valence is already in the CREATE TABLE. This ALTER TABLE
+    // is purely for existing production databases upgrading from v8.x → v9.0.
+    try {
+      await this.db.execute(
+        `ALTER TABLE session_ledger ADD COLUMN valence REAL DEFAULT NULL`
+      );
+      debugLog("[SqliteStorage] v9.0 migration: added valence column");
+    } catch (e: any) {
+      if (!e.message?.includes("duplicate column name")) throw e;
+    }
+
+    // ─── v9.0 Migration: Persistent Cognitive Budget ──────────────
+    //
+    // Budget belongs to the PROJECT (stored in session_handoffs), not
+    // the ephemeral session, to prevent the "Reset Exploit" where an
+    // agent escapes budget exhaustion by simply starting a new session.
+    try {
+      await this.db.execute(
+        `ALTER TABLE session_handoffs ADD COLUMN cognitive_budget REAL DEFAULT NULL`
+      );
+      debugLog("[SqliteStorage] v9.0 migration: added cognitive_budget column");
+    } catch (e: any) {
+      if (!e.message?.includes("duplicate column name")) throw e;
+    }
   }
 
   // ─── PostgREST Filter Parser ───────────────────────────────
@@ -994,10 +1027,10 @@ export class SqliteStorage implements StorageBackend {
       sql: `INSERT INTO session_ledger
         (id, project, conversation_id, user_id, role, summary, todos, files_changed,
          decisions, keywords, is_rollup, rollup_count, title, agent_name,
-         event_type, confidence_score, importance,
+         event_type, confidence_score, importance, valence,
          embedding_compressed, embedding_format, embedding_turbo_radius,
          created_at, session_date)
-        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
+        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
       args: [
         id,
         entry.project,
@@ -1016,6 +1049,7 @@ export class SqliteStorage implements StorageBackend {
         entry.event_type || "session",   // v4.0: default to 'session'
         entry.confidence_score ?? null,   // v4.0: nullable
         entry.importance || 0,            // v4.0: default to 0
+        entry.valence ?? null,            // v9.0: affect-tagged memory
         entry.embedding_compressed || null,        // v5.0: TurboQuant
         entry.embedding_format || null,            // v5.0: turbo3/turbo4/float32
         entry.embedding_turbo_radius ?? null,      // v5.0: original vector magnitude
@@ -1051,7 +1085,7 @@ export class SqliteStorage implements StorageBackend {
       'embedding', 'embedding_compressed', 'embedding_format', 'embedding_turbo_radius',
       'archived_at', 'deleted_at', 'deleted_reason', 'is_rollup', 'rollup_count',
       'importance', 'last_accessed_at', 'keywords', 'todos', 'files_changed', 'decisions',
-      'summary', 'confidence_score', 'event_type', 'role',
+      'summary', 'confidence_score', 'event_type', 'role', 'valence',
     ]);
 
     const sets: string[] = [];
@@ -1084,6 +1118,16 @@ export class SqliteStorage implements StorageBackend {
     });
   }
 
+  // ─── v9.0: Lightweight budget persistence ───────────────────────
+  // Updates ONLY cognitive_budget on session_handoffs without triggering
+  // OCC version bumps, CRDT merges, or history snapshots.
+  async patchHandoffBudget(project: string, userId: string, budget: number): Promise<void> {
+    await this.db.execute({
+      sql: `UPDATE session_handoffs SET cognitive_budget = ? WHERE project = ? AND user_id = ?`,
+      args: [budget, project, userId],
+    });
+  }
+
   async getLedgerEntries(params: Record<string, any>): Promise<unknown[]> {
     const { ids, ...restParams } = params;
     const { where, args, select, order, limit } = this.parsePostgRESTFilters(restParams as Record<string, string>);
@@ -1691,6 +1735,7 @@ export class SqliteStorage implements StorageBackend {
       const sql = `
         SELECT l.id, l.project, l.summary, l.decisions, l.files_changed,
                l.session_date, l.created_at, l.is_rollup, l.importance, l.last_accessed_at,
+               l.valence,
                (1 - vector_distance_cos(l.embedding, vector(?))) AS similarity
         FROM session_ledger l
         WHERE ${conditions.join(" AND ")}
@@ -1714,6 +1759,7 @@ export class SqliteStorage implements StorageBackend {
           is_rollup: Boolean(r.is_rollup),
           importance: (r.importance as number) ?? 0,
           last_accessed_at: (r.last_accessed_at as string) || null,
+          valence: (r.valence as number) ?? null,  // v9.0: affect-tagged memory
         }));
 
       if (params.activation?.enabled) {
@@ -1881,7 +1927,7 @@ export class SqliteStorage implements StorageBackend {
       if (missingIds.length > 0) {
         const placeholders = missingIds.map(() => '?').join(',');
         const missingQuery = `
-          SELECT id, project, summary, session_date, decisions, files_changed, keywords, is_rollup, importance, last_accessed_at
+          SELECT id, project, summary, session_date, decisions, files_changed, keywords, is_rollup, importance, last_accessed_at, valence
           FROM session_ledger
           WHERE id IN (${placeholders}) AND deleted_at IS NULL AND user_id = ?
         `;
@@ -1899,10 +1945,47 @@ export class SqliteStorage implements StorageBackend {
             importance: Number(row.importance) || 0,
             last_accessed_at: (row.last_accessed_at as string) || null,
             similarity: 0.0,
+            valence: (row.valence as number) ?? null,
           });
         }
       }
 
+      // ── v9.0: Valence Propagation ────────────────────────────────
+      // After activation propagation, compute propagated valence for
+      // discovered nodes using energy-weighted averaging from source flows.
+      let propagatedValenceMap: Map<string, number> | null = null;
+      if (PRISM_VALENCE_ENABLED) {
+        try {
+          const { propagateValence } = await import("../memory/valenceEngine.js");
+          
+          // Build valence lookup from all known nodes
+          const valenceLookup = new Map<string, number>();
+          for (const [id, node] of fullNodeMap) {
+            if (node.valence != null) valenceLookup.set(id, node.valence);
+          }
+          
+          // For missing valence values, bulk-fetch from DB
+          const missingValenceIds = finalIds.filter(id => !valenceLookup.has(id));
+          if (missingValenceIds.length > 0) {
+            const vPlaceholders = missingValenceIds.map(() => '?').join(',');
+            const vQuery = `SELECT id, valence FROM session_ledger WHERE id IN (${vPlaceholders}) AND valence IS NOT NULL`;
+            const vRes = await this.db.execute({ sql: vQuery, args: missingValenceIds });
+            for (const row of vRes.rows) {
+              valenceLookup.set(row.id as string, row.valence as number);
+            }
+          }
+          
+          propagatedValenceMap = propagateValence(results, valenceLookup);
+          debugLog(`[SqliteStorage] v9.0 valence propagation: ${propagatedValenceMap.size} nodes processed`);
+        } catch (valErr) {
+          debugLog(`[SqliteStorage] v9.0 valence propagation failed (non-fatal): ${valErr instanceof Error ? valErr.message : String(valErr)}`);
+        }
+      }
+
+      const { computeHybridScoreWithValence } = PRISM_VALENCE_ENABLED
+        ? await import("../memory/valenceEngine.js")
+        : { computeHybridScoreWithValence: null };
+
       const finalResults: SemanticSearchResult[] = [];
       
       for (const r of results) {
@@ -1912,9 +1995,22 @@ export class SqliteStorage implements StorageBackend {
           node.activationScore = normEnergy;
           node.rawActivationEnergy = r.activationEnergy;
           node.isDiscovered = r.isDiscovered;
+
+          // v9.0: Attach propagated valence (overrides raw for discovered nodes)
+          if (propagatedValenceMap?.has(r.id)) {
+            node.valence = propagatedValenceMap.get(r.id)!;
+          }
           
-          // Hybrid blend: 70% original match relevance, 30% structural energy
-          node.hybridScore = (node.similarity * 0.7) + (normEnergy * 0.3); 
+          // v9.0: Hybrid blend with valence salience:
+          //   0.65 × similarity + 0.25 × activation + 0.10 × |valence|
+          // Falls back to 70/30 if valence is disabled.
+          if (computeHybridScoreWithValence) {
+            node.hybridScore = computeHybridScoreWithValence(
+              node.similarity, normEnergy, node.valence ?? null
+            );
+          } else {
+            node.hybridScore = (node.similarity * 0.7) + (normEnergy * 0.3);
+          }
           
           finalResults.push(node);
         }
diff --git a/src/storage/supabase.ts b/src/storage/supabase.ts
index dced564..bc4084b 100644
--- a/src/storage/supabase.ts
+++ b/src/storage/supabase.ts
@@ -51,6 +51,7 @@ import {
   PRISM_SYNAPSE_SPREAD_FACTOR,
   PRISM_SYNAPSE_LATERAL_INHIBITION,
   PRISM_SYNAPSE_SOFT_CAP,
+  PRISM_VALENCE_ENABLED,
 } from "../config.js";
 import { getSetting as cfgGet, setSetting as cfgSet, getAllSettings as cfgGetAll } from "./configStorage.js";
 import { runAutoMigrations } from "./supabaseMigrations.js";
@@ -104,6 +105,8 @@ export class SupabaseStorage implements StorageBackend {
       ...(entry.embedding_compressed !== undefined && { embedding_compressed: entry.embedding_compressed }),
       ...(entry.embedding_format !== undefined && { embedding_format: entry.embedding_format }),
       ...(entry.embedding_turbo_radius !== undefined && { embedding_turbo_radius: entry.embedding_turbo_radius }),
+      // v9.0: Affect-Tagged Memory
+      ...(entry.valence !== undefined && entry.valence !== null && { valence: entry.valence }),
     };
 
     return supabasePost("session_ledger", record);
@@ -113,6 +116,14 @@ export class SupabaseStorage implements StorageBackend {
     await supabasePatch("session_ledger", data, { id: `eq.${id}` });
   }
 
+  // v9.0: Lightweight budget persistence
+  async patchHandoffBudget(project: string, userId: string, budget: number): Promise<void> {
+    await supabasePatch("session_handoffs", { cognitive_budget: budget }, {
+      project: `eq.${project}`,
+      user_id: `eq.${userId}`,
+    });
+  }
+
   async getLedgerEntries(params: Record<string, any>): Promise<unknown[]> {
     const { ids, ...restParams } = params;
     
@@ -487,7 +498,7 @@ export class SupabaseStorage implements StorageBackend {
             id: `in.(${missingIds.join(",")})`,
             user_id: `eq.${userId}`,
             deleted_at: "is.null",
-            select: "id,project,summary,session_date,decisions,files_changed,is_rollup,importance,last_accessed_at",
+            select: "id,project,summary,session_date,decisions,files_changed,is_rollup,importance,last_accessed_at,valence",
           }) as Record<string, unknown>[];
 
           for (const row of (Array.isArray(rows) ? rows : [])) {
@@ -501,6 +512,7 @@ export class SupabaseStorage implements StorageBackend {
               is_rollup: Boolean(row.is_rollup),
               importance: Number(row.importance) || 0,
               last_accessed_at: (row.last_accessed_at as string) || null,
+              valence: row.valence != null ? Number(row.valence) : undefined,
               similarity: 0.0,
             });
           }
@@ -509,6 +521,33 @@ export class SupabaseStorage implements StorageBackend {
         }
       }
 
+      // ─── v9.0: Valence Propagation for discovered nodes ──────────
+      // Mirrors the SQLite implementation: batch propagateValence() call
+      // over the full results array with a valence lookup map.
+      let propagatedValenceMap: Map<string, number> | null = null;
+      if (PRISM_VALENCE_ENABLED) {
+        try {
+          const { propagateValence } = await import("../memory/valenceEngine.js");
+          // Build valence lookup from all known nodes
+          const valenceLookup = new Map<string, number>();
+          for (const [id, node] of fullNodeMap) {
+            if (node.valence != null && Number.isFinite(node.valence)) {
+              valenceLookup.set(id, node.valence);
+            }
+          }
+
+          propagatedValenceMap = propagateValence(results, valenceLookup);
+          debugLog(`[SupabaseStorage] v9.0 valence propagation: ${propagatedValenceMap.size} nodes processed`);
+        } catch (valErr) {
+          debugLog(`[SupabaseStorage] applySynapse: valence propagation failed (non-fatal): ${valErr instanceof Error ? valErr.message : String(valErr)}`);
+        }
+      }
+
+      // Import hybrid scoring if valence is enabled
+      const { computeHybridScoreWithValence } = PRISM_VALENCE_ENABLED
+        ? await import("../memory/valenceEngine.js")
+        : { computeHybridScoreWithValence: null };
+
       // Compute hybrid scores and build final result set
       const finalResults: SemanticSearchResult[] = [];
 
@@ -520,8 +559,14 @@ export class SupabaseStorage implements StorageBackend {
           node.rawActivationEnergy = r.activationEnergy;
           node.isDiscovered = r.isDiscovered;
 
-          // Hybrid blend: 70% original match relevance, 30% structural energy
-          node.hybridScore = (node.similarity * 0.7) + (normEnergy * 0.3);
+          // v9.0: Three-component hybrid blend with valence salience
+          const nodeValence = propagatedValenceMap?.get(r.id) ?? node.valence;
+          if (computeHybridScoreWithValence && nodeValence != null && Number.isFinite(nodeValence)) {
+            node.valence = nodeValence;
+            node.hybridScore = computeHybridScoreWithValence(node.similarity, normEnergy, nodeValence);
+          } else {
+            node.hybridScore = (node.similarity * 0.7) + (normEnergy * 0.3);
+          }
 
           finalResults.push(node);
         }
diff --git a/src/storage/supabaseMigrations.ts b/src/storage/supabaseMigrations.ts
index 8110341..c9709c9 100644
--- a/src/storage/supabaseMigrations.ts
+++ b/src/storage/supabaseMigrations.ts
@@ -785,6 +785,36 @@ export const MIGRATIONS: Migration[] = [
         CHECK (status IN ('PENDING', 'RUNNING', 'PAUSED', 'ABORTED', 'COMPLETED', 'FAILED'));
     `
   },
+  {
+    // ─── v9.0: Affect-Tagged Memory + Token-Economic Budget ──────────
+    //
+    // Two new columns:
+    //   1. session_ledger.valence — REAL [-1.0, +1.0], nullable
+    //      Stores the affective "gut feeling" score for each memory entry.
+    //      Derived deterministically from event_type at write time.
+    //      Legacy entries remain NULL (neutral).
+    //
+    //   2. session_handoffs.cognitive_budget — REAL, nullable
+    //      Persists the agent's current token-economic budget balance
+    //      across sessions. Initialized on first spend; NULL before first use.
+    //
+    // Both are idempotent (ADD COLUMN IF NOT EXISTS) and non-breaking
+    // (nullable with no NOT NULL constraint). Existing data is untouched.
+    version: 42,
+    name: "v9_affect_tagged_memory_and_cognitive_budget",
+    sql: `
+      -- v9.0: Affect-Tagged Memory — valence column on session_ledger
+      ALTER TABLE session_ledger ADD COLUMN IF NOT EXISTS valence REAL DEFAULT NULL;
+
+      -- Partial index for valence-aware retrieval (non-null valence entries)
+      CREATE INDEX IF NOT EXISTS idx_ledger_valence
+        ON session_ledger(valence)
+        WHERE valence IS NOT NULL;
+
+      -- v9.0: Token-Economic Cognitive Budget — budget column on session_handoffs
+      ALTER TABLE session_handoffs ADD COLUMN IF NOT EXISTS cognitive_budget REAL DEFAULT NULL;
+    `,
+  },
 
 ];
 
diff --git a/src/sync/factory.ts b/src/sync/factory.ts
index 2f2ac74..52ca1b8 100644
--- a/src/sync/factory.ts
+++ b/src/sync/factory.ts
@@ -10,13 +10,18 @@
 import { PRISM_STORAGE } from "../config.js";
 import { debugLog } from "../utils/logger.js";
 import type { SyncBus } from "./index.js";
+import { getSetting } from "../storage/configStorage.js";
 
 let _bus: SyncBus | null = null;
 
 export async function getSyncBus(): Promise<SyncBus> {
   if (_bus) return _bus;
 
-  if (PRISM_STORAGE === "local") {
+  // DB-first, then env, then config.ts default (same priority as storage/index.ts)
+  const dbStorage = await getSetting("PRISM_STORAGE", "");
+  const resolvedStorage = dbStorage || process.env.PRISM_STORAGE || PRISM_STORAGE;
+
+  if (resolvedStorage === "local") {
     const { SqliteSyncBus } = await import("./sqliteSync.js");
     _bus = new SqliteSyncBus();
   } else {
diff --git a/src/tools/graphHandlers.ts b/src/tools/graphHandlers.ts
index f29954b..e786fd0 100644
--- a/src/tools/graphHandlers.ts
+++ b/src/tools/graphHandlers.ts
@@ -105,6 +105,11 @@ import { HdcStateMachine } from "../sdm/stateMachine.js";
 import { ConceptDictionary } from "../sdm/conceptDictionary.js";
 import { PolicyGateway } from "../sdm/policyGateway.js";
 import { getSdmEngine } from "../sdm/sdmEngine.js";
+// v9.0: Affect-Tagged Memory — valence-aware retrieval
+import {
+  formatValenceTag, valenceSalience, shouldWarnNegativeValence, generateValenceWarning,
+} from "../memory/valenceEngine.js";
+import { PRISM_VALENCE_ENABLED, PRISM_VALENCE_WARNING_THRESHOLD } from "../config.js";
 import {
   PRISM_HDC_ENABLED,
   PRISM_HDC_EXPLAINABILITY_ENABLED,
@@ -592,7 +597,12 @@ export async function sessionSearchMemoryHandler(args: unknown) {
       // v8.0: Tag nodes discovered via Synapse multi-hop traversal
       const synapseTag = r.isDiscovered ? " [🌐 Synapse]" : "";
 
-      return `[${i + 1}] ${simScore} similar${synapseTag} — ${r.session_date || "unknown date"}\n` +
+      // v9.0: Valence tag — affect-tagged memory indicator
+      const valTag = PRISM_VALENCE_ENABLED && r.valence != null
+        ? ` ${formatValenceTag(r.valence)}`
+        : "";
+
+      return `[${i + 1}] ${simScore} similar${synapseTag}${valTag} — ${r.session_date || "unknown date"}\n` +
         `  Project: ${r.project}\n` +
         `  Summary: ${r.summary}\n` +
         importanceStr +
@@ -601,10 +611,26 @@ export async function sessionSearchMemoryHandler(args: unknown) {
         (r.files_changed?.length ? `  Files: ${r.files_changed.join(", ")}\n` : "");
     }).join("\n");
 
+    // v9.0: Valence Warning — inject contextual warning when top results
+    // have historically negative affect (failures, corrections).
+    let valenceWarning = "";
+    if (PRISM_VALENCE_ENABLED && results.length > 0) {
+      const valenceValues = results
+        .map((r: any) => r.valence as number | null | undefined)
+        .filter((v): v is number => v != null && Number.isFinite(v));
+      if (valenceValues.length > 0) {
+        const avgValence = valenceValues.reduce((a, b) => a + b, 0) / valenceValues.length;
+        const warning = generateValenceWarning(avgValence);
+        if (warning) {
+          valenceWarning = `\n\n${warning}`;
+        }
+      }
+    }
+
     // Phase 1: content[0] = human-readable results (unchanged from pre-Phase 1)
     const contentBlocks: Array<{ type: string; text: string }> = [{
       type: "text",
-      text: `🧠 Found ${results.length} semantically similar sessions:\n\n${formatted}`,
+      text: `🧠 Found ${results.length} semantically similar sessions:\n\n${formatted}${valenceWarning}`,
     }];
 
     // Phase 1: content[1] = machine-readable MemoryTrace (only when enable_trace=true)
diff --git a/src/tools/ledgerHandlers.ts b/src/tools/ledgerHandlers.ts
index 2deb529..559b7d3 100644
--- a/src/tools/ledgerHandlers.ts
+++ b/src/tools/ledgerHandlers.ts
@@ -38,9 +38,20 @@ import { mergeHandoff, dbToHandoffSchema, sanitizeForMerge } from "../utils/crdt
 // containing: strategy, scores, latency breakdown (embedding/storage/total), and metadata.
 // See src/utils/tracing.ts for full type definitions and design decisions.
 import { createMemoryTrace, traceToContentBlock } from "../utils/tracing.js";
-import { GOOGLE_API_KEY, PRISM_USER_ID, PRISM_AUTO_CAPTURE, PRISM_CAPTURE_PORTS } from "../config.js";
+import {
+  GOOGLE_API_KEY, PRISM_USER_ID, PRISM_AUTO_CAPTURE, PRISM_CAPTURE_PORTS,
+  PRISM_VALENCE_ENABLED, PRISM_VALENCE_WARNING_THRESHOLD,
+  PRISM_COGNITIVE_BUDGET_ENABLED,
+} from "../config.js";
 import { captureLocalEnvironment } from "../utils/autoCapture.js";
 import { fireCaptionAsync } from "../utils/imageCaptioner.js";
+
+// ─── v9.0: Affect-Tagged Memory + Token-Economic RL ──────────
+import { deriveValence } from "../memory/valenceEngine.js";
+import {
+  estimateTokens, spendBudget, applyEarnings, formatBudgetDiagnostics,
+  DEFAULT_BUDGET_SIZE,
+} from "../memory/cognitiveBudget.js";
 import {
   isSessionSaveLedgerArgs,
   isSessionSaveHandoffArgs,
@@ -126,6 +137,56 @@ export async function sessionSaveLedgerHandler(args: unknown) {
   const keywords = toKeywordArray(combinedText);
   debugLog(`[session_save_ledger] Extracted ${keywords.length} keywords: ${keywords.slice(0, 5).join(", ")}...`);
 
+  // ── v9.0: Auto-derive valence from event_type ──────────────────
+  // Valence is a [-1, +1] real representing the affective charge of a memory.
+  // It's auto-derived at create-time from the event_type field so the agent
+  // doesn't need to manually classify emotional context.
+  let valence: number | null = null;
+  let valenceWarning = "";
+  if (PRISM_VALENCE_ENABLED) {
+    const eventType = (args as any).event_type || "session";
+    valence = deriveValence(eventType);
+    if (valence !== null && valence < PRISM_VALENCE_WARNING_THRESHOLD) {
+      valenceWarning = `\n\n⚠️ **Negative Valence (${valence.toFixed(2)}):** This entry is tagged as a negative experience. ` +
+        `It will be prioritized in future retrievals to prevent repeating past mistakes.`;
+    }
+    debugLog(`[session_save_ledger] v9.0 valence derived: ${valence} (event_type=${eventType})`);
+  }
+
+  // ── v9.0: Token-Economic Budget ────────────────────────────────
+  // Charge the project's cognitive budget for this write operation.
+  // Budget exhaustion triggers warnings but NEVER blocks writes (graceful degradation).
+  let budgetDiagnostics = "";
+  if (PRISM_COGNITIVE_BUDGET_ENABLED) {
+    try {
+      // Load current budget from the project's handoff state
+      const handoff = await storage.loadContext(project, "quick", PRISM_USER_ID);
+      const currentBudget = (handoff as any)?.cognitive_budget ?? DEFAULT_BUDGET_SIZE;
+
+      // Apply UBI earnings before spending
+      const eventType = (args as any).event_type;
+      const lastCreated = (handoff as any)?.updated_at ?? null;
+      const earnings = applyEarnings(currentBudget, lastCreated, eventType);
+
+      // Compute cost and spend
+      const rawTokenCost = estimateTokens(summary);
+      const surprisal = 0.5; // Default until surprisal gate is wired in future sprint
+      const result = spendBudget(earnings.newBalance, rawTokenCost, surprisal);
+
+      // Format diagnostics for MCP response
+      budgetDiagnostics = "\n\n" + formatBudgetDiagnostics(result, DEFAULT_BUDGET_SIZE, earnings.ubiEarned, earnings.bonusEarned);
+
+      // Persist updated budget back to handoff (fire-and-forget)
+      storage.patchHandoffBudget(project, PRISM_USER_ID, result.remaining).catch((err: Error) => {
+        debugLog(`[session_save_ledger] Budget persist failed (non-fatal): ${err.message}`);
+      });
+
+      debugLog(`[session_save_ledger] v9.0 budget: cost=${result.spent}, balance=${result.remaining}`);
+    } catch (budgetErr) {
+      debugLog(`[session_save_ledger] Budget tracking failed (non-fatal): ${budgetErr instanceof Error ? budgetErr.message : String(budgetErr)}`);
+    }
+  }
+
   // Save via storage backend
   const effectiveRole = role || await getSetting("default_role", "global");
   const result = await storage.saveLedger({
@@ -138,6 +199,7 @@ export async function sessionSaveLedgerHandler(args: unknown) {
     decisions: decisions || [],
     keywords,
     role: effectiveRole,  // v3.0: Hivemind role scoping (dashboard fallback)
+    valence,              // v9.0: Affect-tagged memory
   });
 
   // ─── Fire-and-forget embedding generation ───
@@ -252,7 +314,10 @@ export async function sessionSaveLedgerHandler(args: unknown) {
         (files_changed?.length ? `Files changed: ${files_changed.length}\n` : "") +
         (decisions?.length ? `Decisions: ${decisions.length}\n` : "") +
         (GOOGLE_API_KEY ? `📊 Embedding generation queued for semantic search.\n` : "") +
+        (valence !== null ? `🎭 Valence: ${valence.toFixed(2)}\n` : "") +
         repoPathWarning +
+        valenceWarning +
+        budgetDiagnostics +
         `\nRaw response: ${JSON.stringify(result)}`,
     }],
     isError: false,
@@ -868,8 +933,37 @@ export async function sessionLoadContextHandler(args: unknown) {
     }
   }
 
+  // ─── v9.0: Cognitive Budget Diagnostics ──────────────────────
+  // Show the agent its current token-economic budget status at session start.
+  // This gives real-time feedback on spending capacity and health.
+  let budgetDiagBlock = "";
+  if (PRISM_COGNITIVE_BUDGET_ENABLED && level !== "quick") {
+    try {
+      const currentBudget = (d as any).cognitive_budget ?? DEFAULT_BUDGET_SIZE;
+      const budgetSize = DEFAULT_BUDGET_SIZE;
+      const ratio = Math.max(0, Math.min(1, currentBudget / budgetSize));
+      const barLength = 20;
+      const fillLength = Math.round(ratio * barLength);
+      const bar = '█'.repeat(Math.max(0, fillLength)) + '░'.repeat(Math.max(0, barLength - fillLength));
+
+      let healthLabel: string;
+      if (ratio > 0.6) healthLabel = "🟢 Healthy";
+      else if (ratio > 0.3) healthLabel = "🟡 Moderate";
+      else if (ratio > 0.1) healthLabel = "🟠 Low";
+      else healthLabel = "🔴 Critical";
+
+      budgetDiagBlock = `\n\n[💰 COGNITIVE BUDGET]\n` +
+        `${bar} ${currentBudget}/${budgetSize} tokens — ${healthLabel}\n` +
+        `Budget replenishes via UBI (+5 tokens/hour) and event bonuses (success: +20, learning: +10).`;
+
+      debugLog(`[session_load_context] v9.0 budget diagnostics: ${currentBudget}/${budgetSize} (${(ratio * 100).toFixed(0)}%)`);
+    } catch (budgetErr) {
+      debugLog(`[session_load_context] Budget diagnostics failed (non-fatal): ${budgetErr instanceof Error ? budgetErr.message : String(budgetErr)}`);
+    }
+  }
+
   // Build the response object before v4.0 augmentations
-  let responseText = `📋 Session context for "${project}" (${level}):\n\n${formattedContext.trim()}${driftReport}${briefingBlock}${sdmRecallBlock}${greetingBlock}${visualMemoryBlock}${skillBlock}${versionNote}`;
+  let responseText = `📋 Session context for "${project}" (${level}):\n\n${formattedContext.trim()}${driftReport}${briefingBlock}${sdmRecallBlock}${greetingBlock}${visualMemoryBlock}${skillBlock}${budgetDiagBlock}${versionNote}`;
 
   // ─── v4.0: Behavioral Warnings Injection ───────────────────
   // If loadContext returned behavioral_warnings, add them to the
diff --git a/tests/scholar/webScholar.test.ts b/tests/scholar/webScholar.test.ts
index 66dafe2..d51c31b 100644
--- a/tests/scholar/webScholar.test.ts
+++ b/tests/scholar/webScholar.test.ts
@@ -42,10 +42,12 @@ const { mockConfig, mockStorage, mockFetch } = vi.hoisted(() => {
   const mockConfig = {
     BRAVE_API_KEY: "test-brave-key",
     FIRECRAWL_API_KEY: "test-firecrawl-key",
+    TAVILY_API_KEY: "",
     PRISM_SCHOLAR_MAX_ARTICLES_PER_RUN: 3,
     PRISM_USER_ID: "default",
     PRISM_SCHOLAR_TOPICS: ["ai", "agents", "mcp", "authentication"],
     PRISM_ENABLE_HIVEMIND: false,
+    PRISM_ENABLE_HIVEMIND_ENV: false,
   };
 
   const mockStorage = {
@@ -70,6 +72,16 @@ const { mockConfig, mockStorage, mockFetch } = vi.hoisted(() => {
 
 vi.mock("../../src/config.js", () => mockConfig);
 
+// Mock configStorage — getSettingSync drives the Hivemind feature check at runtime.
+// When hivemind_enabled isn't found in the cache, it falls back to the _ENV value.
+// We drive it via mockConfig.PRISM_ENABLE_HIVEMIND so tests can toggle it.
+vi.mock("../../src/storage/configStorage.js", () => ({
+  getSettingSync: vi.fn().mockImplementation((key: string, defaultValue = "") => {
+    if (key === "hivemind_enabled") return String(mockConfig.PRISM_ENABLE_HIVEMIND);
+    return defaultValue;
+  }),
+}));
+
 vi.mock("../../src/storage/index.js", () => ({
   getStorage: vi.fn().mockResolvedValue(mockStorage),
 }));
@@ -104,6 +116,16 @@ vi.mock("../../src/utils/logger.js", () => ({
   debugLog: vi.fn(),
 }));
 
+vi.mock("../../src/scholar/freeSearch.js", () => ({
+  searchYahooFree: vi.fn().mockResolvedValue([]),
+  scrapeArticleLocal: vi.fn().mockResolvedValue({ title: "", content: "" }),
+}));
+
+vi.mock("../../src/utils/tavilyApi.js", () => ({
+  performTavilySearch: vi.fn().mockResolvedValue([]),
+  performTavilyExtract: vi.fn().mockResolvedValue([]),
+}));
+
 // Stub global fetch for Firecrawl
 vi.stubGlobal("fetch", mockFetch);
 
```

---
*Generated 2026-04-07T18:06:08Z by Prism Repomix*
