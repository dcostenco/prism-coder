# 🧠 Prism Coder

🌐 **Read in your language:** 🇬🇧 English · [🇪🇸 Español](README_es.md) · [🇫🇷 Français](README_fr.md) · [🇵🇹 Português](README_pt.md) · [🇷🇴 Română](README_ro.md) · [🇺🇦 Українська](README_uk.md) · [🇷🇺 Русский](README_ru.md) · [🇩🇪 Deutsch](README_de.md) · [🇯🇵 日本語](README_ja.md) · [🇰🇷 한국어](README_ko.md) · [🇨🇳 中文](README_zh.md) · [🇸🇦 العربية](README_ar.md)

**Persistent memory + tool-calling intelligence for AI agents.** *(formerly Prism MCP)*

A Model Context Protocol server that gives Claude, Cursor, and other AI tools a Mind Palace — long-term memory that survives across sessions, with semantic search, cognitive routing, a visual dashboard, and the `prism-coder:1b7` / `prism-coder:8b` / `prism-coder:14b` / `prism-coder:32b` LLM fleet for offline tool-calling.

[![npm](https://img.shields.io/npm/v/prism-mcp-server?color=cb0000&label=npm%20%E2%80%94%20prism-mcp-server)](https://www.npmjs.com/package/prism-mcp-server)
[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/synalux-ai.synalux?label=VS%20Code&color=007ACC)](https://marketplace.visualstudio.com/items?itemName=synalux-ai.synalux)
[![Website](https://img.shields.io/badge/website-synalux.ai%2Fprism--mcp-6B4FBB)](https://synalux.ai/prism-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-00ADD8)](https://github.com/modelcontextprotocol/servers)
[![Smithery](https://img.shields.io/badge/Smithery-listed-6B4FBB)](https://smithery.ai/server/@dcostenco/prism-mcp)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](../../LICENSE)

> **Renamed in v14.0.0:** the project is now **Prism Coder** to cover both the Mind Palace memory server *and* the `prism-coder:1b7` / `prism-coder:8b` / `prism-coder:14b` / `prism-coder:32b` LLM fleet on HuggingFace + Ollama. The npm package stays `prism-mcp-server` so existing install URLs and `mcp.json` entries keep working — the `prism-coder` binary has been the canonical entry point since v12.

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
| Tool-call latency | 200ms–3s | **~1.6s (1.7B) / ~1.1s (14B)** |
| API key required | Yes | **No** |
| Data sent externally | Every prompt | **Nothing** |
| Works offline | ❌ | ✅ |
| Cost at scale | $0.002–0.06/call | **$0** |
| HIPAA | Requires BAA | **On-prem = no BAA** |

Install in one command — no config, no keys, no vendor agreements:
```bash
ollama pull dcostenco/prism-coder:1b7   # 2.2 GB · ~1.6s · any machine
ollama pull dcostenco/prism-coder:8b    # 4.7 GB · ~0.8s · Mac M1+ / iPhone 8GB
ollama pull dcostenco/prism-coder:14b   # 8.4 GB · ~1.1s · Mac M2+ / iPad Pro 16GB
ollama pull dcostenco/prism-coder:32b   # 16 GB  · ~0.8s · Mac M2 Ultra+ (30B-A3B MoE)
```

Prism MCP detects both the namespaced (`dcostenco/prism-coder:14b`) and bare (`prism-coder:14b`) Ollama tag forms automatically — nothing else to configure. If you want the bare tags as aliases for direct `ollama run prism-coder:14b` use, run:

```bash
prism register-models           # aliases */prism-coder:* → prism-coder:* via `ollama cp`
prism register-models --dry-run # preview what would be aliased
```

### Cascade architecture

Two cascades operate independently depending on the deployment context:

**Desktop / server cascade** (quality-first, used in Prism MCP + Synalux portal):
```
prism-coder:14b ─── correct? ──YES──▶  serve  (99% of traffic, ~1.1s)
  │ NO
prism-coder:32b ─── correct? ──YES──▶  serve  (~1% of traffic, ~0.8s)
  │ NO
Claude Opus 4.7 ──────────────────────▶  serve  (0% in practice, cloud)
```

**Mobile / offline cascade** (availability-first, used in Prism AAC iOS):
```
prism-coder:14b (~1.1s) — iPad Pro 16GB  →  prism-coder:8b (~0.8s) — iPhone/iPad 8GB
  →  prism-coder:1.7b (~1.6s) — any device, always fits
```

**Code generation cascade** (used in Prism Coder IDE + Agent Mode):
```
prism-ide:14b ─── quality OK? ──YES──▶  serve  (~1.1s, 22/22 TypeScript eval)
  │ NO (complex / multi-file)
prism-ide:32b ─── quality OK? ──YES──▶  serve  (~0.8s MoE, deep reasoning)
  │ NO
Claude Sonnet 4 ──────────────────────▶  serve  (cloud fallback)
```

The routing cascade validates each response against the 6 known tool names and escalates on empty, truncated, or hallucinated tool calls. The code generation cascade escalates on incomplete or syntactically invalid output.

**Routing accuracy** ([102-case Prism eval](../../tests/benchmarks/prism-routing-100/README.md), v36/v7 system prompt, 3-seed mean, May 2026):

| Model | Accuracy | Cost/req | Latency | Runs on | AAC | Edge cases |
|---|---|---|---|---|---|---|
| Claude Sonnet 4 | **99%** | ~$0.01 | 3.2s | Cloud | 100% | 83% |
| **prism-coder:32b** v7 | **100.0%** | **$0** | 0.8s | Mac 24GB+ (MoE) | **100%** | **100%** |
| **prism-coder:8b** v36 | **100.0%** | **$0** | **0.8s** | iPhone/iPad 8GB | **100%** | **100%** |
| **prism-coder:14b** v36 | **100.0%** | **$0** | **1.1s** | Mac 24GB+ / iPad Pro 16GB | **100%** | **100%** |
| Claude Opus 4.7 | **98.3%** | ~$0.05 | 3.0s | Cloud | 100% | 83% |
| **prism-coder:1.7b** v42 | **100.0%** | **$0** | 1.6s | Any device | **100%** | **100%** |
| **14B→32B cascade** | **100.0%** | **~$0** | ~1.1s¹ | Mac 24GB+ | **100%** | **100%** |

¹ ~99% of requests served by 14B at 1.1s; 32B for the ~1% 14B misses.

**Why this matters for a life-critical AAC app**: a child in a hospital without WiFi, a nonverbal adult on an airplane, or a family on a budget gets Claude-grade routing accuracy with zero cloud dependency — and the AAC path (expressing pain, asking for help) routes correctly **100% of the time across all tiers and all seeds tested**.

**What it does NOT mean**: these scores measure routing precision on a narrow 6-tool taxonomy, not general intelligence. Claude outperforms these models on everything outside this task. The value is **offline reliability at zero cost**, not replacing Claude.

> **The prompt engineering breakthrough**: Q4_K_M quantized models confuse semantically similar tool names when routing rules use plain keyword lists. Two structural fixes eliminated all confusion: (1) replacing `-> plain text` with `-> respond directly (no tool)`, and (2) adding category labels (`CONVERSATION RECALL:` / `SAVED KNOWLEDGE:`) as semantic anchors stronger than keyword matching. Combined effect: 14B went from 87% → 100% on the 102-case Prism eval (v36/v7 system prompt, 3-seed mean).

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

Prism Coder inference cascades through fine-tuned models first, with Claude as a quality-gate fallback. Models route through the Synalux router (authentication + subscription required). Cascade: Cloud (OpenRouter) → Ollama local → Claude fallback.

| Model | Ollama tag | Where | Tier | Latency |
|---|---|---|---|---|
| **prism-coder:1.7b** | `prism-coder:1b7` (v42) | On-device (Mac/local) · iOS via llama.cpp | Free | ~1.6s |
| **prism-coder:8b** | `prism-coder:8b` (v36) | On-device iPhone/iPad 8GB+ · local Mac | Free | ~0.8s |
| **prism-coder:14b** | `prism-coder:14b` (v36) | On-device Mac 24GB+ · iPad Pro · Cloud A100 | Standard+ | ~1.1s |
| **prism-coder:32b** | `prism-coder:32b` (v7 MoE) | Cloud (OpenRouter) A100 80GB via Synalux | Pro/Enterprise | ~0.8s |

Models use the Synalux SFT corpus (AAC + Prism MCP tool taxonomy + clinical workflows). **Internal quality gate: ≥ 90% on the Prism 102-case eval before production promotion.**

> **Training note**: Base Qwen3 models are strong tool-routers out of the box. Heavy fine-tuning regresses tool-vs-plain-text decisions; light-touch polish recipes (small corpus, balanced tool/plain-text split) are the published path. Production adapter selection and retrain methodology are managed in the Synalux portal.

**Per-category breakdown — [Prism 102-case eval](../../tests/benchmarks/prism-routing-100/README.md) (3-seed mean, v36/v7 system prompt, May 2026):**

| Model | Overall | Load ctx | Save | Srch mem | Handoff | Compact | Know srch | AAC | Translate | No-tool | Info | Edge | Avg lat | Inv |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **prism-coder:32b** v7 | **100.0%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | **100%** | 0.8s | 0 |
| **prism-coder:8b** v36 | **100.0%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | **100%** | 0.8s | 0 |
| **prism-coder:14b** v36 | **100.0%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | **100%** | 1.1s | 0 |
| **Claude Opus 4.7** | **98.3%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 83% | 3.0s | 0 |
| **prism-coder:1.7b** v42 | **100.0%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | **100%** | 1.6s | 0 |

> **Methodology**: 102-case pool across 12 categories. Scores are 3-seed mean (seeds 2027/2028/2029, zero variance across all seeds). All fine-tuned models use the Qwen3 nothink template with keyword-trigger routing prompts and `-> respond directly (no tool)` for the no-tool class. Full runner: [`tests/benchmarks/prism-routing-100/benchmark.py`](../../tests/benchmarks/prism-routing-100/benchmark.py) · Cascade runner: [`tests/benchmarks/cascade-14b-32b-opus/cascade_eval.py`](../../tests/benchmarks/cascade-14b-32b-opus/cascade_eval.py).
>
> **These are NOT general-purpose LLM benchmarks.** This eval measures routing precision on 6 specific MCP tools. The prism-coder models are specialists trained on this exact task — they match or exceed Claude on routing while Claude dominates on general reasoning, coding, and open-domain QA. The value is **offline reliability at zero cost**, not replacing cloud AI.

**iOS deployment:** On-device inference via **llama.cpp Swift SPM**. Auto-selects by device RAM: 14B on iPad Pro 16GB (100% routing), 8B on iPhone/iPad 8GB (100%, OOM fallback to 1.7B at 100%). CoreML not viable — coremltools doesn't support Qwen3 attention ops. Integration: `LLMEngine.swift` → `prismNativeBridge.askAI()` → token stream. WiFi fallback: Mac Ollama (`OLLAMA_HOST=0.0.0.0`).

### Benchmarks — run them yourself

All benchmarks are open-source. Reproduce every number in this README:

```bash
git clone https://github.com/dcostenco/prism-coder
cd prism-coder
pip install anthropic requests

# Per-model solo eval (102 cases, 3 seeds)
python3 tests/benchmarks/prism-routing-100/benchmark.py --models 14b 8b 32b 1b7 opus

# Cascade eval — 14B → 32B → Opus (Claude Opus as etalon)
export ANTHROPIC_API_KEY=sk-ant-...
ollama pull dcostenco/prism-coder:14b dcostenco/prism-coder:32b
python3 tests/benchmarks/cascade-14b-32b-opus/cascade_eval.py
```

**Not a general function-calling benchmark.** This measures routing precision on 6 specific MCP tools. We don't claim to beat Claude on general capabilities. We match or exceed Claude on the ONE task that matters for offline AAC: correct tool routing, every time, under 2 seconds, with zero cloud.

| Benchmark | Source | What it measures |
|---|---|---|
| Per-model BFCL | [`tests/benchmarks/prism-routing-100/`](../../tests/benchmarks/prism-routing-100/) | Solo accuracy per model, 12 categories |
| Cascade vs Opus | [`tests/benchmarks/cascade-14b-32b-opus/`](../../tests/benchmarks/cascade-14b-32b-opus/) | Tier distribution, Opus engagement rate, cascade accuracy |

### Models on HuggingFace

| Model | HuggingFace | Solo BFCL | Cascade role | Size |
|---|---|---|---|---|
| prism-coder:32b | [dcostenco/prism-coder-32b](https://huggingface.co/dcostenco/prism-coder-32b) | **100.0%** routing (v7 MoE) | Tier 2 (catches ~1% 14B misses) | 16 GB |
| prism-coder:8b | [dcostenco/prism-coder-8b](https://huggingface.co/dcostenco/prism-coder-8b) | **100.0%** routing (v36) | Mobile tier | 4.7 GB |
| prism-coder:14b | [dcostenco/prism-coder-14b](https://huggingface.co/dcostenco/prism-coder-14b) | **100.0%** routing (v36) | Tier 1 (serves ~99% of traffic) | 8.4 GB |
| prism-coder:1.7b | [dcostenco/prism-coder-1.7b](https://huggingface.co/dcostenco/prism-coder-1.7b) | **100.0%** routing (v42) | On-device / always-fits fallback | 1.1 GB |
| prism-ide:14b | [dcostenco/prism-ide](https://huggingface.co/dcostenco/prism-ide) | **22/22** TypeScript eval (v1) | Code generation tier 1 (~1.1s) | 8.4 GB |
| prism-ide:32b | [dcostenco/prism-ide](https://huggingface.co/dcostenco/prism-ide) | Complex code + multi-file (v3) | Code generation tier 2 (~0.8s MoE) | 16 GB |

## Self-hosted / Local AI (Enterprise)

Run the full Prism model stack on your own hardware — zero cloud, zero latency, full data sovereignty.

**Requirements:** Mac M2 Pro+ (48GB recommended) or Linux with NVIDIA GPU · [Ollama](https://ollama.com)

```bash
# On-device tier — 1.1 GB (any machine, iPhone) — 100% routing
ollama pull dcostenco/prism-coder:1b7

# Mobile tier — 4.7 GB (iPhone/iPad 8GB, Mac M1+) — 100% routing
ollama pull dcostenco/prism-coder:8b

# Standard tier — 8.4 GB (Mac 24GB+, iPad Pro 16GB) — 100% routing
ollama pull dcostenco/prism-coder:14b

# Reasoning tier — 16 GB (Mac M2 Ultra+, 30B-A3B MoE) — 100% routing
ollama pull dcostenco/prism-coder:32b
```

Set `LOCAL_LLM_URL=http://localhost:11434` in your portal config. Routing is automatic:

**Desktop/server**: 14B → 32B → Claude Opus fallback · **Mobile/offline**: 14B → 8B → 1.7B

iOS/mobile on same WiFi: `OLLAMA_HOST=0.0.0.0 ollama serve` on the Mac, then point `LOCAL_LLM_URL` at the Mac's IP.  
Routing accuracy (May 2026, v36/v7 system prompt, 3-seed mean): 32B v7 = **100.0%** · 8B v36 = **100.0%** · 14B v36 = **100.0%** · 1.7B v42 = **100.0%**  
Cascade (14B→32B): **100.0%** · Opus solo: 98.3% · Opus engaged: **0% of requests** → [Full results](../../tests/benchmarks/cascade-14b-32b-opus/README.md)

---

## Plans

| Plan | Cloud model | Daily limit | On-device |
|---|---|---|---|
| **Free** | — | unlimited local | prism-coder:1.7b (100%) + 8b (100%) + 14b (100%) |
| **Standard $19/mo** | Claude Sonnet 4 | 200 req | + cloud fallback |
| **Pro $49/mo** | prism-coder:32b | 2,000 req | + reasoning tier |
| **Enterprise $99/mo** | prism-coder:32b priority | unlimited | + HIPAA BAA + custom fine-tuning |

All on-device models are **free for every tier** — no subscription needed for local inference. Offline translation (1,261 phrases × 20 languages) included in all plans.

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

### 🌐 Website & Docs

**[synalux.ai/prism-mcp](https://synalux.ai/prism-mcp)** — full documentation, dashboard, subscription plans, and model downloads.

### 💻 Web IDE — Synalux Coder

Use Prism Coder directly in your browser — no install required. Local-first IDE with the prism-coder agent built in. Connects to GitHub repos, Synalux Mail, Drive, and Source for cross-product workflows.

**[synalux.ai/coder](https://synalux.ai/coder)** · also reachable at **[synalux.ai/prism-ide](https://synalux.ai/prism-ide)**

| Feature | Detail |
|---|---|
| Agent | prism-coder:7b offline · Claude Sonnet 4 (Standard+) · Claude Opus 4 (Enterprise) |
| Integrations | GitHub repos, Synalux Mail, Drive, Source — same OAuth, no separate accounts |
| Compliance | Audit log on every turn · PHI redaction · air-gapped offline mode (HIPAA) |

### 🧩 VS Code Extension — Synalux

Memory-augmented AI inside VS Code, powered by Prism. 20 multimodal tools, multi-agent orchestration, 12-language support. Works offline (Ollama) or cloud (OpenRouter). HIPAA-compliant healthcare workflows.

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/synalux-ai.synalux?label=VS%20Marketplace&color=007ACC)](https://marketplace.visualstudio.com/items?itemName=synalux-ai.synalux)

```bash
# Install from terminal
code --install-extension synalux-ai.synalux
```

Or open VS Code → Extensions (⇧⌘X) → search **"Synalux"** → Install.

### 📦 npm / npx

```bash
# Run without installing (always latest version)
npx prism-mcp-server

# Or install globally
npm install -g prism-mcp-server
prism load my-project
```

Package: [`prism-mcp-server` on npm](https://www.npmjs.com/package/prism-mcp-server)

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

## Testing

```bash
npm test                           # 1,815 test cases across 71 files (vitest)
npm test -- --coverage             # coverage report
python3 tests/benchmarks/prism-routing-100/benchmark.py --models 1b7 14b 32b
```

**Pinned in CI** — 327 tests enforce every constant: ACT-R decay `d=0.25`, spreading-activation hybrid score `0.7/0.3`, experience bias `MIN_SAMPLES=5` / `MAX_BIAS_CAP=0.15`, graph-metrics warning ratios `0.20 / 0.30 / 0.40`, compaction's 25KB prompt-budget. CI catches divergence automatically.

**Coverage areas**:
- HRR (Holographic Reduced Representations) edge cases + performance
- Encrypted sync corruption recovery
- BCBA skill integration
- Deep storage tier
- Dashboard rendering
- Routing benchmarks (102-case Prism eval) — see `tests/benchmarks/prism-routing-100/`

## Migration

### Local SQLite → Synalux portal

If you've been running Prism on the free tier and want to move historical session data into the paid-tier portal, use the migration script:

```bash
# dry run first — prints what would be migrated, hits no network
node scripts/migrate-local-to-portal.mjs --dry-run

# real run — pushes ledger + handoff entries through POST /api/v1/prism/memory
PRISM_SYNALUX_API_KEY=synalux_sk_... \
  node scripts/migrate-local-to-portal.mjs

# scope to one project
node scripts/migrate-local-to-portal.mjs --project=my-project

# include scholar entries (excluded by default — usually large + low-value)
node scripts/migrate-local-to-portal.mjs --include-scholar
```

**What it does**: reads `~/.prism-mcp/data.db` via `@libsql/client` (already a runtime dep — no extra install), exchanges the refresh token for a JWT (cached + auto-refreshed before expiry), and POSTs each ledger entry and handoff to the portal. Failures are logged with the source row id; successes are counted at the end.

**Credentials**: `PRISM_SYNALUX_API_KEY` from env. If unset, the script also checks `~/prism/.env` for `PRISM_SYNALUX_API_KEY=...` as a convenience for dev workflows.

**Idempotency**: handoffs are written with the portal's CRDT merge (last-write-wins per project+role); ledger entries are append-only and de-duped server-side by `(project, conversation_id, summary)`. Re-running on the same DB is safe.

**One-shot only**: this script is a migration tool, not a sync daemon. Once you've moved, set `PRISM_STORAGE=synalux` (or leave it on `auto` and let the resolver pick synalux when credentials are present) and the MCP server writes directly to the portal going forward.

## Production Infrastructure

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
  │  • JWT auth          │  │  Primary   — Railway        │
  │  • tier enforcement  │  │  Standby   — Fly.io         │
  │  • complexity route  │  │  Fallback  — Supabase REST  │
  │  • proxy to cloud    │  │  auto-failover chain        │
  └──────────┬───────────┘  └─────────────┬───────────────┘
             │                            │
             ▼                            ▼
  ┌──────────────────────────────┐  ┌─────────────────────────────┐
  │  OPENROUTER / LOCAL          │  │  SUPABASE                   │
  │                              │  │  session ledgers            │
  │  Cloud: Claude Sonnet 4      │  │  knowledge graph            │
  │  Routing: prism-coder        │  │  handoffs & todos           │
  │   :32b(100%) :14b(100%)      │  │                             │
  │   :8b(100%)  :1b7(100%)      │  │  source of truth            │
  │  Code:    prism-ide          │  │                             │
  │   :14b · :32b                │  │                             │
  └──────────────────────────────┘  └─────────────────────────────┘
```

### Service Routing

**LLM Backends**

| Surface | Primary | Fallback | Local |
|---|---|---|---|
| AI Chat (free) | Gemini 2.5 Flash (direct API) | Claude Haiku 3.5 | prism-coder:14b via Ollama |
| AI Chat (paid) | Claude Sonnet 4 (OpenRouter) | Claude Haiku 3.5 | prism-coder:14b via Ollama |
| Prism Coder (tool-calling) | Claude Haiku 3.5 (OpenRouter) | — | prism-coder:14b via Ollama |
| Prism AAC | Local prism-coder:14b | Gemini 2.5 Flash / Claude | prism-coder:8b / :1b7 |

**Web Search**

| Surface | Primary | Fallback |
|---|---|---|
| AI Chat `@search` | Firecrawl | — |
| Prism MCP agents (cloud) | Firecrawl | — |
| Prism MCP server (local) | Firecrawl (via MCP tools) | — |
| Clinical research | PubMed + ERIC + Semantic Scholar | DuckDuckGo |

**TTS (Text-to-Speech)**

| Tier | Engine | Offline |
|---|---|---|
| 1 | Inworld TTS-2 (cloud) | — |
| 1.5 | Kokoro-82M neural (WASM) | en/es/fr/pt/ja/zh |
| 2 | OS Web Speech API | all |
| 3 | WASM espeak-ng | all |

**Other Services**

| Service | Provider | Purpose |
|---|---|---|
| Payments | Stripe | Subscriptions, checkout |
| Email | Resend | Transactional (invites, shares) |
| Video | LiveKit | Telehealth, case conferences |
| SMS | Twilio | Emergency alerts, caregiver notifications |
| Translation | Offline dictionary (1,261 × 20 langs) | AAC, Watch |

## Synalux Inference Router

All Prism AAC model inference is protected behind Synalux as a mandatory router. Models are **never accessible directly** — all traffic goes through Synalux for auth, billing, and rate limiting.

```
┌──────────────────────────────────────────────────────────┐
│  CLIENT LAYER                                            │
│  prism-aac (iOS/web)         │   Synalux Portal          │
└──────────────┬───────────────────────────────────────────┘
               │ POST /api/v1/prism-aac/inference
               │ Authorization: Bearer <user-JWT>
               ▼
┌──────────────────────────────────────────────────────────┐
│  SYNALUX ROUTER                                          │
│  1. Verify JWT (no anonymous access)                     │
│  2. Check subscription tier                              │
│  3. Enforce rate limit (per-tier daily cap)               │
│  4. Route to model tier by complexity                    │
│  5. Proxy → OpenRouter / Gemini (key never exposed)      │
│  6. Log → aac_inference_log (audit trail)                │
└──────────┬───────────────────────────────┬───────────────┘
           │                               │
           ▼                               ▼
  ┌────────────────────┐      ┌──────────────────────┐
  │  LOCAL (Ollama)    │      │  CLOUD (OpenRouter)  │
  │  prism-coder:14b   │      │  Claude Sonnet 4     │
  │  prism-coder:8b    │      │  Claude Haiku 3.5    │
  │  prism-coder:1b7   │      │  Gemini 2.5 Flash    │
  │  free, offline     │      │  paid tiers          │
  └────────────────────┘      └──────────────────────┘

On-device (free, offline):
  prism-coder:1b7 GGUF Q4_K_M (1.1 GB) → any Apple device
  prism-coder:8b  GGUF Q4_K_M (4.7 GB) → iPhone/iPad 8 GB+
  prism-coder:14b GGUF Q4_K_M (8.4 GB) → Mac/iPad Pro 16 GB+

HuggingFace: dcostenco/prism-coder-{14b,8b,32b,1.7b} (public GGUF weights)
```

| Plan | Cloud model | Daily limit | On-device |
|---|---|---|---|
| **Free** | — | unlimited local | prism-coder:1.7b (100%) + 8b (100%) + 14b (100%) |
| **Standard $19/mo** | Claude Sonnet 4 | 200 req | + cloud fallback |
| **Pro $49/mo** | prism-coder:32b | 2,000 req | + reasoning tier |
| **Enterprise $99/mo** | prism-coder:32b priority | unlimited | + HIPAA BAA + custom fine-tuning |

All on-device models are **free for every tier** — no subscription needed for local inference. Offline translation (1,261 phrases × 20 languages) included in all plans.

[Subscribe →](https://synalux.ai/pricing)

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
