# Prism Routing Benchmark — 100-Case Eval

Internal BFCL-style benchmark measuring tool-routing accuracy across Prism's 7 MCP tools.

**Not** the official Berkeley Function Calling Leaderboard. This eval covers Prism-specific routing only (7 tools, 13 categories, 100 randomly sampled prompts, seed=2026).

## Results — May 2026

> v25 system prompt · 3 × 100 cases (seeds 2026/2027/2028) · 5 models

| Model | Overall | Load ctx | Save | Srch mem | Handoff | Compact | Web srch | Know srch | AAC | Translate | Plain txt | No-tool | Info | Edge | Avg lat | Invented |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Sonnet 4** (cloud) | **99%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 83% | 3.2s | 0 |
| **14B local** | **100%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 83% | 9.0s | 0 |
| **32B local** ² | **100%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 92% | 100% | 100% | 100% | 100% | 100% | 3.6s | 0 |
| **Opus 4.7** (cloud) | **98%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 66% | 3.0s | 0 |
| **1.7B local** | **96%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 83% | 100% | 64% | 6.0s | 0 |

² 32B uses `nothink` template + surgical prompt disambiguation. See [`Modelfile.32b`](Modelfile.32b).

**Invented tools across all models: 0** — hard constraint in v25 system prompt holds for all model sizes.

## Category definitions

| Category | n | Description |
|---|---|---|
| Load ctx | 9 | `session_load_context` — load/fetch/resume context for project |
| Save | 11–13 | `session_save_ledger` — note/log/record/save progress |
| Srch mem | 9 | `session_search_memory` — what did we discuss / previously recorded |
| Handoff | 8 | `session_save_handoff` — pass to next agent / transition notes |
| Compact | 6 | `session_compact_ledger` — shrink/prune/archive the ledger |
| Web srch | 7 | `brave_web_search` — google X / look up current info |
| Know srch | 7 | `knowledge_search` — what do I know / stored notes |
| AAC | 12 | Plain text — AAC phrase suggestions (no tool) |
| Translate | 6 | Plain text — translation requests (no tool) |
| Plain txt | 8 | Plain text — static facts, code, math (no tool) |
| No-tool | 6 | Plain text — time/weather/personal needs (hallucination guard) |
| Info | 5 | Plain text — factual questions the model knows |
| Edge | 6 | Ambiguous multi-intent cases (hardest category) |

## Running the benchmark

```bash
# All models (requires Ollama running + ANTHROPIC_API_KEY)
python3 tests/benchmarks/prism-routing-100/benchmark.py

# Local models only
python3 tests/benchmarks/prism-routing-100/benchmark.py --models 1b7 14b 32b

# Single model, 50 cases
python3 tests/benchmarks/prism-routing-100/benchmark.py --models 14b --n 50

# Remote Ollama (iPad → Mac)
OLLAMA_HOST=http://192.168.1.10:11434 python3 tests/benchmarks/prism-routing-100/benchmark.py --models 1b7
```

**Requirements:** `pip install anthropic requests`

## Methodology

- **Pool:** 200 hand-labeled prompts across 13 categories
- **Sampling:** 100 cases drawn randomly (seed=2026) — no overlap between runs when seed changes
- **Scoring:** exact tool name match required; `None` expected for plain-text categories
- **Invented tool penalty:** any tool name not in the 7-tool schema counts as wrong + increments `invented` counter
- **Edge cases:** first matching routing rule wins (per v25 system prompt ordering)

## Files

- [`benchmark.py`](benchmark.py) — runner script (Ollama + Claude API)
- [`results_may2026.json`](results_may2026.json) — raw results from May 2026 eval run (32B at 97%, pre-fix)
- [`Modelfile.32b`](Modelfile.32b) — Ollama Modelfile for `prism-coder:32b` with `nothink` template fix
