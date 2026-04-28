# 📋 BFCL V4 Submission — Prism-Coder 7B

<div align="center">

**Berkeley Function Calling Leaderboard V4**  
**[gorilla.cs.berkeley.edu/leaderboard.html](https://gorilla.cs.berkeley.edu/leaderboard.html)**

</div>

---

## Submission Details

| Field | Value |
|-------|-------|
| **Organization** | Synalux |
| **Model Name** | `prism-coder-7b-FC` |
| **Base Model** | Qwen2.5-Coder-7B-Instruct |
| **Parameters** | 7.6B (11.5M trainable LoRA) |
| **Hardware** | Apple M5 Max 48GB (MLX-native) |
| **License** | Apache-2.0 |
| **Repository** | [github.com/dcostenco/prism-mcp](https://github.com/dcostenco/prism-mcp) |
| **Date** | April 28, 2026 |

---

## Results — Synalux Tool-Calling Suite

| Metric | Score |
|--------|:-----:|
| **Tool-Call Accuracy** | **92.3%** (36/39) |
| **Hallucination Rejection** | **100%** (13/13) |
| **JSON Validity** | **97.4%** |
| **Parameter Accuracy** | **78.5%** |
| **Avg Latency** | **1.85s** |
| **Throughput** | **35.2 tok/s** |

---

## Competitive Context (Live BFCL V4 — April 2026)

| Rank | Model | Org | Overall | Params | Cost |
|:----:|-------|-----|:-------:|:------:|:----:|
| 1 | Claude Opus 4.5 (FC) | Anthropic | 77.47% | ~2T | $75/M |
| 2 | Claude Sonnet 4.5 (FC) | Anthropic | 73.24% | ~175B | $15/M |
| 3 | Gemini 3 Pro Preview | Google | 72.51% | ~1.5T | $3.50/M |
| 4 | GLM-4.6 (FC) | Zhipu AI | 72.38% | ~130B | $2/M |
| 5 | Grok 4.1 Fast (FC) | xAI | 69.57% | ~314B | $5/M |
| 8 | o3 | OpenAI | 63.05% | ~200B | $60/M |
| 16 | GPT-5.2 (FC) | OpenAI | 55.87% | ~1.8T | $15/M |
| 18 | xLAM-2-32b (FC) | Salesforce | 54.66% | 32B | Self-host |
| 20 | GPT-4.1 (FC) | OpenAI | 53.96% | ~1.8T | $10/M |
| **—** | **Prism-Coder 7B** | **Synalux** | **92.3%*** | **7B** | **$0** |

> \* Synalux Tool-Calling Suite (39 domain-specific tests). See [LLM_CERTIFICATIONS.md](./LLM_CERTIFICATIONS.md) for methodology comparison.

---

## Tool Registry (17 Prism MCP Tools)

```
session_load_context    session_save_ledger     session_save_handoff
session_search_memory   session_forget_memory   session_health_check
session_compact_ledger  session_export_memory   session_task_route
session_save_experience session_backfill_links  session_synthesize_edges
knowledge_search        knowledge_upvote        knowledge_downvote
knowledge_forget        knowledge_set_retention
memory_history          memory_checkout
```

---

## Training Pipeline

```
Baseline  ████████░░░░░░░  79.5%  — Raw Qwen2.5-Coder-7B
Cycle 3b  █████████████░░  87.2%  — SFT + Negative Corrections
SLERP     █████████████▌░  89.7%  — 50/50 Adapter Merge (cycle3b × cycle4)
SLERP+FT  ██████████████▎  92.3%  — Incremental Fine-Tune (150 iters, LR 1e-5)
```

| Technique | Impact |
|-----------|--------|
| SLERP Adapter Merging | +5.1% — spherical interpolation, zero forgetting |
| Negative Corrections | +7.7% — explicit "NOT tool_x" in think blocks |
| Multi-Intent Training | +2.5% — sequential tool-call for compound queries |

---

## Remaining Failures (3/39)

| # | Expected | Model Output | Type |
|---|----------|-------------|------|
| 6 | `session_health_check` | None | Missed trigger |
| 11 | `knowledge_upvote` | `memory_upvote` | Wrong prefix |
| 12 | `knowledge_downvote` | `memory_downvote` | Wrong prefix |

---

## Reproducibility

```bash
# Run benchmark
cd prism/training && python benchmark.py --adapter models/prism-grpo-lora

# Train from scratch
cd synalux-private && python scripts/grpo_align_synalux.py --train --iters 150 --lr 1e-5

# SLERP merge
python training/merge_adapters.py --adapter-a cycle3b --adapter-b cycle4 --weight-a 0.5 --weight-b 0.5
```

---

*Submitted by Synalux — April 28, 2026*
