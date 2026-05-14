# 🧠 Prism Coder

🌐 **Read in your language:** 🇬🇧 English · [🇪🇸 Español](README_es.md) · [🇫🇷 Français](README_fr.md) · [🇵🇹 Português](README_pt.md) · [🇷🇴 Română](README_ro.md) · [🇺🇦 Українська](README_uk.md) · [🇷🇺 Русский](README_ru.md) · [🇩🇪 Deutsch](README_de.md) · [🇯🇵 日本語](README_ja.md) · [🇰🇷 한국어](README_ko.md) · [🇨🇳 中文](README_zh.md) · [🇸🇦 العربية](README_ar.md)

**Persistent memory + tool-calling intelligence for AI agents.** *(formerly Prism MCP)*

A Model Context Protocol server that gives Claude, Cursor, and other AI tools a Mind Palace — long-term memory that survives across sessions, with semantic search, cognitive routing, a visual dashboard, and the `prism-coder:1b7-v19-q8` / `prism-coder:14b` LLM fleet for offline tool-calling.

[![npm](https://img.shields.io/npm/v/prism-mcp-server?color=cb0000&label=npm%20%E2%80%94%20prism-mcp-server)](https://www.npmjs.com/package/prism-mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-00ADD8)](https://github.com/modelcontextprotocol/servers)
[![Smithery](https://img.shields.io/badge/Smithery-listed-6B4FBB)](https://smithery.ai/server/@dcostenco/prism-mcp)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](../../LICENSE)

> **Renamed in v14.0.0:** the project is now **Prism Coder** to cover both the Mind Palace memory server *and* the `prism-coder:1b7-v19-q8` / `prism-coder:14b` LLM fleet on HuggingFace + Ollama. The npm package stays `prism-mcp-server` so existing install URLs and `mcp.json` entries keep working — the `prism-coder` binary has been the canonical entry point since v12.

---

## What Prism Coder does

### 💾 Your AI remembers across sessions
Every conversation feeds the Mind Palace. Next session, your AI agent loads the right context automatically — no re-explaining.

### 🔍 Semantic search over your history
Ask "what did I decide about the auth flow last month?" and get the answer with citations. Vector search + keyword + graph traversal.

### 🧬 Cognitive routing
Different memory types live in different stores: episodic (what happened), semantic (what's true), procedural (how to do X). The router picks where to store and where to retrieve.

### 🔄 Proactive session drift detection *(new in v15)*
Your AI agent can now detect when it has drifted from your original goals — mid-session, automatically — and self-correct before you notice the problem.

Three direct Prism calls:
1. **`session_save_ledger`** — snapshot current state
2. **`session_cognitive_route`** — compare current work against original goals, returns `on_track / minor_drift / major_drift`
3. **`session_compact_ledger`** — if drifted, compress and reload only what matters

When major drift is detected, the alert routes to the **Synalux portal** so it's visible across sessions and devices — not just in the current conversation.

**Real example it caught:** A training session promised BFCL ≥90% for three AI models. The agent spent 3 hours debugging audio bugs instead. The drift check surfaced: "Training goal unmet. Layer3 corpus missing from all training sets. 0 BFCL scores measured." The session immediately re-aligned.

No scripts. No cron. No hooks. Three tool calls, Prism handles the rest.

### 🛡 Local-first — security + speed
Free tier runs entirely on your machine — SQLite, local embedding model, no API keys, no cloud. Paid tier adds cloud sync via Synalux portal.

**Why local models matter:**

| | Cloud LLM | Local `prism-coder` |
|--|---|---|
| Tool-call latency | 200ms–3s | **~0.5s (1.7B) / ~3s (14B)** |
| API key required | Yes | **No** |
| Data sent externally | Every prompt | **Nothing** |
| Works offline | ❌ | ✅ |
| Cost at scale | $0.002–0.06/call | **$0** |
| HIPAA | Requires BAA | **On-prem = no BAA** |

Install in one command — no config, no keys, no vendor agreements:
```bash
ollama pull dcostenco/prism-coder:1b7   # 2.2 GB · ~0.5s · any machine
ollama pull dcostenco/prism-coder:14b   # 9.3 GB · ~3s   · Mac M2+
ollama pull dcostenco/prism-coder:32b   # 19 GB  · ~8s   · Mac M2 Ultra+
```
Routing accuracy — [100-case Prism eval](../../tests/benchmarks/prism-routing-100/README.md), v25 system prompt, **May 14 2026 against currently-published Hub tags (mean of 3 seeds: 2027/2028/2029)**:

| Model | Mean ± Std | Avg latency | Invented tools (3-run total) |
|---|---|---|---|
| Sonnet 4 (cloud) | **99%** | 3.2s | 0 |
| Opus 4.7 (cloud) | **98%** | 3.0s | 0 |
| prism-coder:32b (local) | **93.7% ± 0.6%** | 2.3s | 0 |
| prism-coder:14b (local) | **87.0% ± 0.0%** | 6.8s | 0 |
| prism-coder:1b7 (local) | **84.0% ± 0.0%** | 1.6s | 6 |

> 3 runs at seeds 2027/2028/2029 show essentially zero variance — these numbers are stable, not noise. Prior published claims (May 13: 100/100/96) reflect a different benchmark configuration. Internal quality gate: ≥ 90% before production promotion — only 32B currently clears. 14B's biggest hole is `know_srch=43%` + `handoff=60%`; 32B's is `aac=79%` + `irrel=67%`; 1.7B is at small-model precision ceiling.

### ⚡ Zero-search retrieval
Holographic Reduced Representations (HRR) for instant similarity lookups without an index. ~5ms over 100K memories.

### 🌐 Multi-agent Hivemind
Multiple AI agents share the same Mind Palace. Each agent has a role (dev / qa / pm / etc.) and sees scoped context. Heartbeat + roster for coordination.

---

## Get started

```bash
# Install globally
npm install -g prism-mcp-server

# Or use npx (no install)
npx prism-mcp-server
```

Add to Claude Desktop / Cursor config:

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

That's it. Open Claude / Cursor and your AI now has memory.

More setup details in [`docs/SETUP_GEMINI.md`](../SETUP_GEMINI.md).

---

## How AI agents use it

| Tool | What it does |
|---|---|
| `session_load_context` | Recover prior session's state on boot |
| `session_save_ledger` | Append immutable session log entry |
| `session_save_handoff` | Save live state for the next session |
| `knowledge_search` | Semantic + keyword search over all memories |
| `query_memory_natural` | Natural-language Q&A over your Mind Palace |
| `extract_entities` | Pull people / projects / decisions from text |
| `session_synthesize_edges` | Auto-link related memories into a graph |

(35+ tools total — full TypeScript signatures in `src/tools/`. Architecture overview in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md).)

<details>
<summary>🔄 How Prism handles context compaction and context loss</summary>

The LLM context window is treated as ephemeral scratch space. All durable state lives in Prism's persistent store (SQLite / Supabase). Context compaction is a non-event.

**Boot protocol** — every session (including post-compaction) begins with a mandatory `session_load_context` call, enforced via `CLAUDE.md`. The agent is fully oriented before writing a single byte of response.

**Two persistent stores:**
- `session_save_ledger` — immutable append-only work log (decisions, files changed, summaries)
- `session_save_handoff` — versioned live-state snapshot (current task, TODOs, open context)

**Ledger compaction** (`session_compact_ledger`) — when a project exceeds a threshold (default: 50 entries), Prism summarizes old entries via LLM into a rollup row, soft-archives originals, and links them via `spawned_from` graph edges. Runs on a 12-hour background scheduler.

→ Full details: [`docs/COMPACTION.md`](../COMPACTION.md)

</details>

---

## Models

Prism Coder inference cascades through fine-tuned models first, with Claude as a quality-gate fallback. Models route through the Synalux router (authentication + subscription required). Cascade: RunPod → Ollama local → Claude fallback.

| Model | Ollama tag | Where | Tier | Latency |
|---|---|---|---|---|
| **Qwen3-1.7B** | `prism-coder:1b7-v19-q8` (published) | On-device (Mac/local) · iOS via local network | Free | ~50ms |
| **Qwen3-14B** | `prism-coder:14b` (published v19) | RunPod A100 via Synalux | Standard+ | ~200ms |
| **QwQ-32B** | `prism-coder:32b` (published v19) | RunPod A100 80GB via Synalux | Pro/Enterprise | ~3–5s |

Models use the Synalux SFT corpus (AAC + Prism MCP tool taxonomy + clinical workflows). **Internal quality gate: ≥ 90% on the Prism 100-case eval before production promotion.**

> **Training note (May 14 2026)**: A v25-max retrain pass on a 40K-row composite corpus REGRESSED both 1.7B and 14B on the BFCL gate test (1.7B 100%→93.8%, 14B 100%→81.2%) because the corpus over-weighted tool-use density, causing the model to invoke tools for prompts like "write a Python function" that should be plain text. Reverted to v19 published adapters. Base Qwen3 models are strong tool-routers out of the box; future fine-tuning will use much sparser corpora focused on Synalux-specific tool names + AAC plain-text style.

**Routing accuracy — [Prism 100-case eval](../../tests/benchmarks/prism-routing-100/README.md) (May 14 2026, mean across 3 seeds 2027/2028/2029):**

| Model | Overall | Load ctx | Save | Srch mem | Handoff | Compact | Web srch | Know srch | AAC | Translate | Pred | Irrel | Info | Edge | Avg lat | Inv |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Sonnet 4** (cloud) | **99%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 83% | 3.2s | 0 |
| **Opus 4.7** (cloud) | **98%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 66% | 3.0s | 0 |
| **prism-coder:32b** ¹ | **93.7%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 79% | 83% | 100% | 67% | 100% | 82% | 2.3s | 0 |
| **prism-coder:14b** | **87.0%** | 100% | 100% | 100% | 60% | 100% | 100% | 43% | 100% | 100% | 62% | 100% | 80% | 65% | 6.8s | 0 |
| **prism-coder:1b7** | **84.0%** | 100% | 76% | 78% | 74% | 100% | 100% | 71% | 91% | 100% | 88% | 83% | 60% | 65% | 1.6s | 6 |

> ¹ 32B uses `nothink` template + surgical prompt disambiguation (know/smem/pred boundary). Without fixes: 98% (nothink only) or 97% (base). See [`tests/benchmarks/prism-routing-100/Modelfile.32b`](../../tests/benchmarks/prism-routing-100/Modelfile.32b). See [`tests/benchmarks/prism-routing-100/Modelfile.32b`](../../tests/benchmarks/prism-routing-100/Modelfile.32b).
>
> These are **not** Berkeley BFCL V4 leaderboard scores. The Prism eval covers 3 × 100 randomly sampled prompts across 13 categories (7 MCP tools, hallucination guards, AAC/translation plain-text). Full methodology and runner script: [`tests/benchmarks/prism-routing-100/`](../../tests/benchmarks/prism-routing-100/).

**iOS deployment:** On-device inference via **llama.cpp Swift SPM** (`ggerganov/llama.cpp`). Model: `prism-aac-1b7-q4km.gguf` (1.0 GB, ~1.6 GB RAM at runtime). CoreML is not viable — coremltools does not support Qwen3 attention ops. Integration: `LLMEngine.swift` → `prismNativeBridge.askAI()` → `window.prismNativeAIResult()` token stream. Fallback: Mac Ollama over local WiFi (`OLLAMA_HOST=0.0.0.0`).

## Self-hosted / Local AI (Enterprise)

Run the full Prism model stack on your own hardware — zero cloud, zero latency, full data sovereignty.

**Requirements:** Mac M2 Pro+ (48GB recommended) or Linux with NVIDIA GPU · [Ollama](https://ollama.com)

```bash
# Fast tier — 2.2 GB (Mac M1+, iPhone via WiFi)
ollama pull dcostenco/prism-coder:1b7

# Standard tier — 9.3 GB (Mac M2 Pro+ or RTX 3090+)
ollama pull dcostenco/prism-coder:14b

# Enterprise/reasoning — 19 GB (Mac M2 Ultra+ or A100)
ollama pull dcostenco/prism-coder:32b
```

Set `LOCAL_LLM_URL=http://localhost:11434` in your portal config. Routing is automatic:
- Fast queries → **1.7B** (~0.5s) · Standard → **14B** (~3s) · Complex/enterprise → **32B** (~8s) · Cloud fallback if Ollama unreachable

iOS/mobile on same WiFi: `OLLAMA_HOST=0.0.0.0 ollama serve` on the Mac, then point `LOCAL_LLM_URL` at the Mac's IP.
Routing accuracy (Prism 100-case eval, May 14 2026 rerun): **32B = 93% · 14B = 87% · 1.7B = 86%**. Zero invented tool names on 32B/14B; 1 on 1.7B. Only 32B currently clears the 90% gate; 14B/1.7B retrain plan in `## Models` section. → [Full results](../../tests/benchmarks/prism-routing-100/README.md)

---

## Plans

| | Free | Standard $19/mo | Pro $49/mo | Enterprise $99/mo |
|---|---|---|---|---|
| Qwen3-1.7B on-device | ✅ unlimited | ✅ | ✅ | ✅ |
| Qwen2.5-Coder-14B cloud | — | ✅ 200 req/day | ✅ 2K req/day | ✅ unlimited |
| QwQ-32B reasoning | — | — | ✅ | ✅ priority |
| Qwen2.5-30B-A3B MoE | — | — | — | ✅ |
| Custom fine-tuning | — | — | — | ✅ |
| HIPAA BAA | — | — | — | ✅ |

[Subscribe →](https://synalux.ai/pricing)

---

## What you can build with it

- **Persistent coding assistant** that remembers your codebase, your decisions, your team's conventions
- **Research agent** that builds knowledge over time — Auto-Scholar pipeline ingests papers / docs and synthesizes
- **Clinical scribe** that retains patient context across visits (HIPAA-compliant cloud + local)
- **Customer support agent** that learns from every ticket
- **Writing assistant** that knows your voice, your prior drafts, and what you've already published

---

## Companions

### Synalux — VS Code Extension

Memory-augmented AI inside VS Code, backed by Prism. 20 multimodal tools, multi-agent orchestration, 12-language support. Works offline (Ollama) or cloud (OpenRouter). HIPAA-compliant healthcare workflows.

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/synalux-ai.synalux?label=VS%20Marketplace&color=007ACC)](https://marketplace.visualstudio.com/items?itemName=synalux-ai.synalux)

```bash
# Install from terminal
code --install-extension synalux-ai.synalux
```

Or open VS Code → Extensions (⇧⌘X) → search **"Synalux"** → Install.

### PrismAAC

AAC communication app for non-speaking users. Powered by Prism's spreading-activation phrase ranking + on-device 7B model. macOS / iOS / Android via web. → [github.com/dcostenco/prism-aac](https://github.com/dcostenco/prism-aac)

---

## 🆕 Prism as Foundation (v14.0.0)

As of v14.0.0, Prism's algorithm exports are a **stable public contract** under SemVer. External systems can port `actrActivation.ts` (ACT-R cognitive decay), `spreadingActivation.ts` (the 0.7 similarity + 0.3 activation hybrid score), `routerExperience.ts` (experience bias with `MIN_SAMPLES=5` cold-start gate), `compactionHandler.ts` (the 25KB prompt-budget cap), and `graphMetrics.ts` (warning ratios) with citations and pin a Prism version.

### Reference consumers

| Consumer | What it uses from Prism |
|---|---|
| [Audit hooks framework](https://github.com/dcostenco/prism-coder/blob/main/docs/WOW_FEATURES.md#7-the-recipe-combining-all-of-the-above) | ACT-R decay (`d=0.25` lesson rate), spreading activation hybrid score (0.7/0.3), experience bias (`MIN_SAMPLES=5`, `MAX_BIAS_CAP=0.15`), graph-metrics warning ratios (0.20 / 0.30 / 0.40), compaction's 25KB prompt-budget. **327 tests pin every constant** — CI catches divergence automatically. |
| [PrismAAC](https://github.com/dcostenco/prism-aac) | Spreading-activation phrase ranking (recency × frequency × per-user history). Caregiver corrections auto-harvest into the personalization corpus via the audit-hooks postflight harvester. The on-device 7B model + this algorithm stack is what makes PrismAAC defensible. |
| Synalux portal | Tier-aware model routing using experience bias on prior outcomes per fingerprint. HIPAA-compliant clinical scribe with on-device-first privacy guarantees. |

## Production Infrastructure (v16)

### Architecture

```
  CLIENTS
  ┌─────────────────────┐  ┌─────────────────────────────┐
  │  prism-aac (iOS/web)│  │  Claude Code · Cursor · IDE │
  │  Vercel             │  │  MCP config → Railway URL   │
  └──────────┬──────────┘  └─────────────┬───────────────┘
             │ inference                  │ memory
             ▼                            ▼
  ┌──────────────────────┐  ┌─────────────────────────────┐
  │  SYNALUX ROUTER      │  │  prism-mcp SERVER           │
  │  Vercel              │  │                             │
  │                      │  │  Primary   — Railway        │
  │  • JWT auth          │  │  Standby   — Fly.io         │
  │  • complexity route  │  │  Fallback  — Supabase REST  │
  │  • tier enforcement  │  │                             │
  │  • proxy to RunPod   │  │  auto-failover chain        │
  └──────────┬───────────┘  └─────────────┬───────────────┘
             │                            │
             ▼                            ▼
  ┌───────────────────────────┐  ┌─────────────────────────────┐
  │  RUNPOD SERVERLESS        │  │  SUPABASE                   │
  │                           │  │  session ledgers            │
  │  Qwen2.5-Coder-14B ~200ms│  │  knowledge graph            │
  │  Qwen2.5-30B-A3B   ~500ms│  │  handoffs & todos           │
  │  QwQ-32B            ~3-5s │  │                             │
  │                           │  │  source of truth            │
  └─────────────┬─────────────┘  └─────────────────────────────┘
                │
                ▼
  ┌───────────────────────────┐
  │  ON-DEVICE                │
  │  Qwen3-1.7B Q4_K_M       │
  │  iOS CoreML / Android     │
  │  ~50ms · offline          │
  └───────────────────────────┘
```

## Synalux Inference Router — Architecture (v16)

All Prism AAC model inference is protected behind Synalux as a mandatory router. Models are **never accessible directly** — all traffic goes through Synalux for auth, billing, and rate limiting.

```
┌─────────────────────────────────────────────────────────────┐
│                      CLIENT LAYER                           │
│  prism-aac (iOS/web)         │   Synalux Portal             │
└──────────────┬──────────────────────────────────────────────┘
               │ POST /api/v1/prism-aac/inference
               │ Authorization: Bearer <user-JWT>
               ▼
┌─────────────────────────────────────────────────────────────┐
│                   SYNALUX ROUTER                            │
│  1. Verify JWT (no anonymous access)                        │
│  2. Check subscription tier                                 │
│  3. Enforce rate limit (50–2000 req/day by plan)            │
│  4. Route to model tier by complexity                       │
│  5. Proxy → RunPod with SECRET key (never sent to client)   │
│  6. Log → aac_inference_log (billing audit trail)           │
└──────────┬─────────────────────────────────────┬────────────┘
           │ tier=fast                            │ tier=reason
           ▼                                      ▼
  ┌─────────────────────────┐      ┌───────────────────────┐
  │  Qwen2.5-Coder-14B     │      │  QwQ-32B              │
  │  RunPod A100 40G        │      │  RunPod A100 80G      │
  │  ~200ms                 │      │  ~3–5s (reasoning)    │
  │  standard/pro           │      │  pro/enterprise only  │
  └─────────────────────────┘      └───────────────────────┘
           │                                      │
           └────────────────┬─────────────────────┘
                            ▼
               HuggingFace dcostenco/prism-coder-* (private)
               RunPod pulls at pod start with server-side token

On-device (free, zero latency, offline):
  Qwen3-1.7B GGUF Q4_K_M → iOS CoreML / Android ONNX
```

| Plan | Cloud model | Daily limit | On-device |
|---|---|---|---|
| Free | — | unlimited local | Qwen3-1.7B |
| Standard $19/mo | Qwen2.5-Coder-14B | 200 req | + cloud |
| Pro $49/mo | QwQ-32B | 2,000 req | + reasoning |
| Enterprise $99/mo | QwQ-32B priority | unlimited | full stack |

See [`docs/WOW_FEATURES.md`](../WOW_FEATURES.md) for the algorithm catalogue. Release notes in [`docs/releases/v14.0.0-prism-as-foundation.md`](../releases/v14.0.0-prism-as-foundation.md).

---

<details>
<summary>📚 Architecture, cognitive systems, and full feature catalog</summary>

**Detailed docs in this repo:**
- [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) — system architecture, memory routing, HRR
- [`docs/COMPACTION.md`](../COMPACTION.md) — how Prism handles LLM context compaction and ledger compaction
- [`docs/SETUP_GEMINI.md`](../SETUP_GEMINI.md) — Gemini configuration
- [`docs/self-improving-agent.md`](../self-improving-agent.md) — adversarial eval / anti-sycophancy
- [`docs/rfcs/`](../rfcs/) — design RFCs
- [`docs/releases/`](../releases/) — per-version release notes
- [`CHANGELOG.md`](../../CHANGELOG.md) — version history (v12.5 Unified Billing, v11.6 Hivemind, v11.5.1 Auto-Scholar, etc.)
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — contributor guide

**The original 1933-line README is preserved in git history.** To browse the prior version (full feature catalog, Cognitive Architecture v7.8, Autonomous Cognitive OS v9.0, HRR Zero-Search, Adversarial Evaluation walkthroughs, Universal Import patterns, competitive analysis vs LangMem/MemGPT/Letta/Zep, v12.5 Unified Billing details, v11.6 Hivemind, v11.5.1 Auto-Scholar): `git show HEAD~1:README.md`.

</details>

---

## License

[AGPL-3.0](../../LICENSE) — Open source. Same license as Prism AAC. Commercial use via Synalux subscription for hosted/managed deployment.
