# Prism Routing Benchmark — 100-Case Eval

Internal BFCL-style benchmark measuring tool-routing accuracy across Prism's 7 MCP tools.

**Not** the official Berkeley Function Calling Leaderboard. This eval covers Prism-specific routing only (7 tools, 13 categories, 100 randomly sampled prompts, seed=2026).

## Results — May 2026

> v25 system prompt · 3 × 102 cases (seeds 2027/2028/2029) · 3-seed mean

| Model | Overall | Load ctx | Save | Srch mem | Handoff | Compact | Know srch | AAC | Translate | No-tool | Info | Edge | Avg lat | Invented |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **prism-coder:32b** v33 | **99.0%** | 100% | 100% | 92% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 2.5s | 0 |
| **prism-coder:8b** v35 | **98.0%** | 100% | 100% | 83% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 0.8s | 0 |
| **prism-coder:14b** v33 | **97.1%** | 100% | 100% | 92% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 1.1s | 0 |
| **Claude Opus 4.7** | **97.1%** | 100% | 100% | 83% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 83% | 3.0s | 0 |
| **prism-coder:1.7b** v41 | **96.1%** | 89% | 100% | 100% | 100% | 83% | 100% | 100% | 100% | 90% | 100% | 83% | 1.6s | 0 |

**Invented tools across all models: 0** — hard constraint in system prompt holds for all model sizes.

### 14B → 32B cascade eval

→ **[Full cascade eval with Opus as etalon](../cascade-14b-32b-opus/README.md)**

| | Cascade (14b→32b→Opus) | Opus-solo |
|---|---|---|
| Mean (3 seeds) | **99.0%** | 97.1% |
| % traffic served locally | **99%** | 0% |
| Opus engagement rate | **1%** | 100% |

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
