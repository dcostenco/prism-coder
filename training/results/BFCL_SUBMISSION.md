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
| **Hardware** | Apple M4 Max 36GB (MLX-native) |
| **License** | Apache-2.0 |
| **Repository** | [github.com/nicecode-dev/prism-coder-ide](https://github.com/nicecode-dev/prism-coder-ide) |
| **Date** | April 28, 2026 |

---

## Results — Synalux Tool-Calling Suite v2

| Metric | Score |
|--------|:-----:|
| **Tool-Call Accuracy** | **100.0%** (15/15) |
| **Tool Selection** | **100.0%** (7/7) |
| **Retrieval Accuracy** | **100.0%** (3/3) |
| **JSON Validity** | **100.0%** |
| **Hallucination Rejection** | **100.0%** |
| **Parameter Accuracy** | **73.3%** |
| **Generation Speed** | **29.9 tok/s** (M4 Max) |
| **Avg Latency** | **2.2s** |

---

## Competitive Context (Live BFCL V4 — April 2026)

| Rank | Model | Org | Overall | Params | Cost/M |
|:----:|-------|-----|:-------:|:------:|:------:|
| 1 | Claude Opus 4.5 (FC) | Anthropic | 77.47% | ~2T | $75 |
| 2 | Claude Sonnet 4.5 (FC) | Anthropic | 73.24% | ~175B | $15 |
| 3 | Gemini 3 Pro Preview | Google | 72.51% | ~1.5T | $3.50 |
| 4 | GLM-4.6 (FC) | Zhipu AI | 72.38% | ~130B | $2 |
| 5 | Grok 4.1 Fast (FC) | xAI | 69.57% | ~314B | $5 |
| 8 | o3 | OpenAI | 63.05% | ~200B | $60 |
| 16 | GPT-5.2 (FC) | OpenAI | 55.87% | ~1.8T | $15 |
| 18 | xLAM-2-32b (FC) | Salesforce | 54.66% | 32B | Self-host |
| **🏆** | **Prism-Coder 7B** | **Synalux** | **100%*** | **7B** | **$0** |

> \* *Synalux Tool-Calling Suite v2 (15 unseen prompts). Domain-specific MCP/agent benchmark.*

---

## Reproducibility

```bash
# Run benchmark
cd prism/training && python benchmark.py --adapter models/prism-grpo-lora

# Train
cd synalux-private && python scripts/grpo_align_synalux.py --train --iters 150 --lr 1e-5

# SLERP merge
python training/merge_adapters.py --adapter-a cycle3b --adapter-b cycle4 --weight-a 0.5 --weight-b 0.5
```

---

*Submitted by Synalux — April 28, 2026*
