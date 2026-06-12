# 🧠 Prism Coder

**Persistent memory and reliable tool-routing for AI agents.** *(formerly Prism MCP)*

Prism Coder is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude, Cursor, and other AI tools long-term memory that survives across sessions — semantic search, cognitive routing, and a visual dashboard. It ships alongside the open-weight `prism-coder` model fleet (1.7B–32B) for fast, offline tool-routing when you don't want a cloud round-trip.

It runs **fully local and free** on SQLite + Ollama with no API keys. A paid subscription adds cloud sync, higher model tiers, and team features through the Synalux portal.

[![npm](https://img.shields.io/npm/v/prism-mcp-server?color=cb0000&label=npm)](https://www.npmjs.com/package/prism-mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-00ADD8)](https://github.com/modelcontextprotocol/servers)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](../../LICENSE)
[![Models on HuggingFace](https://img.shields.io/badge/🤗-prism--coder-yellow)](https://huggingface.co/dcostenco)

> **Renamed in v14:** the project is now **Prism Coder** to cover both the memory server and the model fleet. The npm package stays `prism-mcp-server`, so existing install URLs and `mcp.json` entries keep working.

---

## Quickstart

The free tier needs no account, no API key, and no cloud. Add the server to your MCP client:

```json
{
  "mcpServers": {
    "prism": {
      "command": "npx",
      "args": ["-y", "prism-mcp-server"]
    }
  }
}
```

Open Claude Desktop or Cursor and your agent now has memory backed by a local SQLite database (`~/.prism-mcp/data.db`).

**Optional — local model fleet** for offline tool-routing. Pull whichever fits your hardware:

```bash
ollama pull dcostenco/prism-coder:1b7   # 1.1 GB · any device, always fits
ollama pull dcostenco/prism-coder:8b    # 4.7 GB · iPhone/iPad 8 GB+, Mac M1+
ollama pull dcostenco/prism-coder:14b   # 8.4 GB · Mac 24 GB+, iPad Pro 16 GB  (default router)
ollama pull dcostenco/prism-coder:32b   # 16 GB  · Mac M2 Ultra+  (complex tasks)
```

Prism detects both the namespaced (`dcostenco/prism-coder:14b`) and bare (`prism-coder:14b`) Ollama tags automatically.

---

## What it does

**Memory that survives across sessions.** Every conversation feeds a persistent store. The next session loads the right context automatically — no re-explaining.

**Semantic + keyword + graph search.** Ask "what did I decide about the auth flow last month?" and get an answer with citations, combining vector similarity, full-text search, and graph traversal.

**Cognitive routing.** Episodic (what happened), semantic (what's true), and procedural (how to do X) memories live in separate stores; a router decides where to write and where to read.

**Session drift detection.** Long agent sessions can wander from their original goal. `session_detect_drift` compares current work against the stated goal and returns `on_track / minor_drift / major_drift` so the agent can self-correct.

**Local tool-routing models.** The `prism-coder` fleet is fine-tuned to pick the right MCP tool quickly and offline, so agents don't burn a cloud call just to decide where to store a note.

---

## Local-first and privacy

The free tier runs entirely on your machine. Paid tiers add cloud sync through the Synalux portal, which is what enables cross-device memory and team sharing.

| | Local tier (free) | Cloud tier (paid) |
|---|---|---|
| Memory storage | Local SQLite | Synalux portal (Supabase-backed) |
| Inference | Local Ollama models | Local models + cloud fallback |
| API keys required | None | Synalux subscription key |
| Web search / scrape | Not included | Routed through the Synalux portal (provider keys stay server-side). Search tools appear as `brave_web_search` in the MCP surface but are proxied through the portal for auth and billing. |
| What leaves your machine | Nothing | Memory text + file paths + search queries, sent to the portal over TLS (PHI-redacted before transit) |
| Works offline | Yes | Local features yes; sync/cloud no |

**Handling sensitive data.** Memory text fields (summaries, decisions, handoff context, file paths) pass through a PHI-redaction step (SSN/DOB/MRN/phone/email and common clinical identifiers) before any cloud write. Knowledge ingestion chunks are also redacted before being sent to the LLM for Q&A synthesis. For regulated workloads, run the **local tier** to keep data on-device, or use an **Enterprise** plan, which is the tier that includes a HIPAA Business Associate Agreement. Prism does not claim blanket HIPAA compliance on the free or individual tiers — the on-device path is the air-gapped option.

---

## Models

The `prism-coder` fleet are specialists fine-tuned from Qwen3 for MCP tool-routing. They are **not** general-purpose chat models — they route reliably and run offline; Claude and other frontier models remain better at reasoning, coding, and open-domain work. The intended pattern is local routing with an optional cloud fallback for hard cases.

| Model | Ollama tag | Size (GGUF Q4_K_M) | Role | Tier |
|---|---|---|---|---|
| prism-coder:1.7b | `prism-coder:1b7` | 1.1 GB | Always-fits fallback / on-device | Free |
| prism-coder:8b | `prism-coder:8b` | 4.7 GB | Mobile / balanced | Free |
| prism-coder:14b | `prism-coder:14b` | 8.4 GB | Default router | Standard+ |
| prism-coder:32b | `prism-coder:32b` | 16 GB | Complex tasks (MoE) | Advanced+ |

Weights: [huggingface.co/dcostenco](https://huggingface.co/dcostenco) (public GGUF). Latency depends on model size and hardware — see [Benchmarks](#benchmarks) to measure it on your own machine rather than trusting a printed number.

### Cascade

```
query → prism-coder:14b (local router)
          → grounding verifier (local, for evidence-backed claims)
          → prism-coder:32b (complex tasks, on demand)
          → cloud fallback (paid tiers, for max quality)
```

---

## Benchmarks

**Reproduce every number yourself.** All evals are open-source and self-contained:

```bash
git clone https://github.com/dcostenco/prism-coder && cd prism-coder
pip install anthropic requests
python3 tests/benchmarks/prism-routing-100/benchmark.py --models 1b7 8b 14b 32b
```

**Routing eval (102 cases, 12 categories, 3-seed mean).** On this narrow tool-routing task the fine-tuned models are near-perfect across all sizes. Be honest with yourself about what that means: the eval is **near-saturated** for this taxonomy — it measures whether the right one of a small set of MCP tools is selected, not general capability. The useful takeaway is **offline routing reliability at zero cost**, not that a 1.1 GB model rivals a frontier model in general.

| Model | Routing accuracy | Notes |
|---|---|---|
| prism-coder:1.7b / 8b / 14b / 32b | ~100% | Near-saturated on this 102-case taxonomy |
| Claude (frontier, same eval) | ~98% | Stronger everywhere outside this narrow task |

**Memory uplift (LoCoMo-Plus, self-published).** A separate long-context dialogue benchmark ([dcostenco/Locomo-Plus](https://github.com/dcostenco/Locomo-Plus)) measures how much structured memory helps a base model retain multi-day context. Results show large gains when a model is paired with Prism memory versus running raw. Note this benchmark is authored, run, and LLM-judged by this project — treat it as a reproducible demonstration, not an independent third-party result, and run it yourself with the commands in that repo.

---

## Why Prism Coder

### vs AI coding assistants

These tables are the maintainer's assessment as of June 2026. Verify claims that matter to you — products change fast.

| Feature | Prism Coder | GitHub Copilot | Cursor | Windsurf | Amazon Q | Devin |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Local inference (open-weight) | ✅ 1.7B–32B | ❌ | ❌ | ❌ | ❌ | ❌ |
| Works fully offline | ✅ (free tier) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Persistent cross-session memory | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Session drift detection | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| L3 grounding verifier | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| MCP server (tools + memory) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Web IDE | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| VS Code extension | ✅ | ✅ | N/A (is VS Code) | N/A | ✅ | ❌ |
| Flat-rate team pricing | ✅ | ❌ (per-seat) | ❌ (per-seat) | ❌ | ❌ | ❌ |
| HIPAA BAA available | ✅ (Enterprise) | ❌ | ❌ | ❌ | ❌ | ❌ |

### vs local AI / memory tools

| Feature | Prism Coder | Ollama | LM Studio | Mem0 | Zep |
|---|:---:|:---:|:---:|:---:|:---:|
| Local inference cascade | ✅ | ✅ | ✅ | ❌ | ❌ |
| Cloud fallback | ✅ | ❌ | ❌ | ❌ | ❌ |
| Persistent cross-session memory | ✅ | ❌ | ❌ | ✅ | ✅ |
| Knowledge ingestion (MCP + webhook) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Cognitive routing (3-store) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Session drift detection | ✅ | ❌ | ❌ | ❌ | ❌ |
| Native MCP server | ✅ | ❌ | ❌ | ❌ | ❌ |
| Web IDE + VS Code extension | ✅ | ❌ | ❌ | ❌ | ❌ |

### Pricing — flat-rate, not per-seat

| | **Prism Coder** | GitHub Copilot | Cursor | Amazon Q |
|---|:---:|:---:|:---:|:---:|
| **Individual** | **$19/mo** | $10/mo | $20/mo | $19/mo |
| **Team (5 devs)** | **$49/mo flat** | $95/mo | $200/mo | $95/mo |
| **Enterprise (25 devs)** | **$99/mo flat** | $195/mo | $1,000/mo | Custom |

---

## Plans

All on-device models are free to run locally via Ollama on every tier. A subscription gates **cloud** features, higher model ceilings, and increased limits. Local model ceilings are advisory — on-device models run on your Ollama regardless of plan; the ceiling gates cloud inference and `prism_infer` routing.

| | **Free** | **Standard** $19/mo | **Advanced** $49/mo | **Enterprise** $99/mo |
|---|---|---|---|---|
| Seats | 1 | 1 | up to 5 | up to 25 |
| Local model ceiling | up to 4b | up to 14b | up to 32b | up to 32b |
| Daily cloud inference | — | 200 | 2,000 | 100,000 |
| Cloud Coder (Web IDE) | — | 100/day | 1,000/day | 100,000/day |
| Cloud search | — | 50/day | 500/day | 100,000/day |
| Max output tokens | 512 | 1,024 | 2,048 | 4,096 |
| Cloud fallback | — | Claude Sonnet 4 | Claude Sonnet 4 | Priority + Sonnet 4 |
| Grounding verifier | — | ✅ | ✅ | ✅ |
| Memory sync (cloud) | — | ✅ | ✅ | ✅ |
| Knowledge / session memory | limited | unlimited | unlimited | unlimited |
| Analytics dashboard | — | ✅ | ✅ | ✅ |
| HIPAA BAA | — | — | — | ✅ |

14-day free trial on paid plans. [Pricing →](https://synalux.ai/pricing) · 25+ seats: [contact sales](https://synalux.ai/support)

---

## How agents use it

Prism exposes 40+ MCP tools. The core memory loop:

| Tool | What it does |
|---|---|
| `session_load_context` | Recover the prior session's state on boot |
| `session_save_ledger` | Append an immutable session log entry |
| `session_save_handoff` | Save live state for the next session |
| `knowledge_search` | Semantic + keyword search over all memories |
| `query_memory_natural` | Natural-language Q&A over the memory store |
| `session_detect_drift` | Detect when a session has drifted from its goal |
| `knowledge_ingest` | Teach Prism a codebase or document |

Full TypeScript signatures live in [`src/tools/`](../../src/tools/); architecture in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md).

<details>
<summary>How Prism survives context compaction</summary>

The LLM context window is treated as ephemeral scratch space; durable state lives in the persistent store (SQLite locally, the portal in the cloud). Every session begins with a mandatory `session_load_context` call, so the agent is oriented before it writes a response. When a project exceeds a threshold (default 50 entries), `session_compact_ledger` summarizes old entries into a rollup, soft-archives the originals, and links them in the graph. → [`docs/COMPACTION.md`](../COMPACTION.md)
</details>

---

## CLI

```bash
prism load <project>      # load session context
prism save                # save ledger + handoff
prism search <query>      # search code across repos (exact / regex / symbol / semantic)
prism review <files...>   # AI code review — security, performance, style
prism scan <files...>     # security scan — secrets, licenses, Dockerfile
prism push                # push local SQLite to the cloud backend
prism register-models     # alias dcostenco/prism-coder:* → prism-coder:*
```

---

## Self-hosting (Enterprise)

Run the full model stack on your own hardware — no cloud, full data sovereignty.

**Requirements:** Mac M2 Pro+ (48 GB recommended) or Linux + NVIDIA GPU, plus [Ollama](https://ollama.com).

```bash
ollama pull dcostenco/prism-coder:14b      # default router
export LOCAL_LLM_URL=http://localhost:11434
```

Routing is automatic: `14b → 32b → cloud fallback` on desktop/server, `14b → 8b → 1.7b` on mobile/offline. For iOS or another machine on the same network, run `OLLAMA_HOST=0.0.0.0 ollama serve` and point `LOCAL_LLM_URL` at the host's IP.

---

## Configuration reference

| Variable | Purpose | Default |
|---|---|---|
| `PRISM_STORAGE` | `local` / `synalux` / `supabase` / `auto` | `auto` |
| `PRISM_SYNALUX_API_KEY` | Paid-tier portal key (`synalux_sk_…`) | — (local if unset) |
| `LOCAL_LLM_URL` | Ollama endpoint | `http://localhost:11434` |
| `PRISM_FORCE_LOCAL` | Force local SQLite regardless of credentials | `false` |

With no variables set, Prism runs fully local. Set `PRISM_SYNALUX_API_KEY` (and leave `PRISM_STORAGE=auto`) to use the cloud backend.

---

## Companions

### Web IDE — Prism Coder

A browser-based IDE at [synalux.ai/coder](https://synalux.ai/coder). Import any GitHub repo and get:

- **Monaco editor** with multi-tab, split view, syntax highlighting, and VS Code keybindings
- **In-browser Node.js** via WebContainer (your code runs in the browser sandbox, not on a server)
- **Integrated terminal** — WebContainer shell in-browser; optional server PTY via WebSocket when connected to a dev server
- **AI chat** powered by prism-coder models (local or cloud depending on plan)
- **Source control** — commit, branch, push/pull, stash, blame, tag management
- **Live Share** — real-time collaborative editing with session links
- **Node.js debugger** via Chrome DevTools Protocol
- **Tasks runner** (VS Code `tasks.json` compatible), **Problems panel** (Monaco diagnostics)
- **12-language i18n** — full UI localization

Standard+ plans get cloud AI and higher rate limits. Free tier works with local Ollama. Code execution uses the in-browser WebContainer by default; Live Share and the optional PTY terminal connect to external servers when explicitly enabled.

### VS Code Extension — Synalux

Memory-augmented AI inside VS Code with clinical practice management features. Install from the marketplace:

```bash
code --install-extension synalux-ai.synalux
```

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/synalux-ai.synalux?label=VS%20Marketplace&color=007ACC)](https://marketplace.visualstudio.com/items?itemName=synalux-ai.synalux)

**AI features:** Chat participant (`@synalux`), multi-agent pipeline, voice input with conversation mode, model switching (local Ollama / cloud / Gemini), 10 AI personality tones.

**Clinical features (BCBA / healthcare):** SOAP note generator, role-based access, document signing, patient board. Voice recording with AES-256-GCM encryption (consent-gated, off by default, plaintext deleted after encryption).

**Collaboration:** Team chat, direct messages, enterprise video calls (LiveKit), customer board, visual builder, DevContainers, Auth & Database panel.

**Privacy note:** The extension routes AI requests through the `BackendRouter` — local Ollama by default for free tier, cloud for paid (user-configurable via `preferLocal`). Clinical features (SOAP notes, voice) route through the same backend. `preferLocal=true` tries local first but can still fall back to cloud if the local model is unavailable. For regulated workloads where PHI must never leave the machine, use the free tier (no cloud key) or an Enterprise plan with BAA that covers cloud-bound data. Licensed under [BSL-1.1](https://marketplace.visualstudio.com/items?itemName=synalux-ai.synalux).

### Prism AAC

Communication app for non-speaking users, powered by the on-device prism-coder fleet for phrase prediction. macOS / iOS / web.

→ [github.com/dcostenco/prism-aac](https://github.com/dcostenco/prism-aac)

---

## Testing

```bash
npm test                 # full suite (vitest)
npm test -- --coverage   # coverage report
```

Coverage spans HRR retrieval, knowledge ingestion, the inference cascade and grounding verifier, compaction, the model picker, and storage round-trips.

---

## Migration: local → cloud

To move free-tier history into the paid portal:

```bash
node scripts/migrate-local-to-portal.mjs --dry-run        # preview, no network
PRISM_SYNALUX_API_KEY=synalux_sk_... \
  node scripts/migrate-local-to-portal.mjs                # push ledger + handoffs
```

It reads `~/.prism-mcp/data.db` and POSTs entries to the portal. Ledger entries are append-only and de-duped server-side; handoffs use last-write-wins per project. Re-running on the same DB is safe. This is a one-shot migration, not a sync daemon — after it, set `PRISM_STORAGE=synalux` (or leave it on `auto`).

---

## License

| Product | License |
|---|---|
| **prism-mcp-server** (this repo) | [AGPL-3.0](../../LICENSE) |
| **VS Code extension** (synalux-ai.synalux) | BSL-1.1 |
| **Web IDE** (synalux.ai/coder) | Synalux Terms of Service |
| **Prism AAC** | AGPL-3.0 |

The AGPL-3.0 license covers the MCP server and its source code. The VS Code extension and Web IDE are separate products with their own licenses. Commercial hosted/managed deployment of the MCP server is available via the Synalux subscription.
