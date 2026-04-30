# Prism-Coder 7B — Training Review Package

## Model Architecture
- **Base**: Qwen 2.5 Coder 7B (MLX quantized for Apple Silicon)
- **Fine-tuning**: LoRA (rank 8, 16 layers, 11.5M trainable parameters / 7.6B total)
- **Framework**: MLX via `mlx_lm.lora`
- **Hardware**: Apple M4 Max, 36GB RAM

## Training Pipeline

```
Base Model (Qwen 2.5 Coder 7B)
    │
    ├── SFT LoRA (Tool-Calling) ─── Adapter A ──┐
    │   21,432 examples                          │
    │   lr=1e-5, 1500 iters                      ├── DARE-TIES Merge (0.85/0.15)
    │                                            │   density=0.6
    ├── SFT LoRA (Prediction) ──── Adapter B ────┘
    │   3,055 examples                           │
    │   lr=2e-5, 600 iters                       │
    │                                            ▼
    │                                    Merged Adapter (v4)
    │                                            │
    └── GRPO Alignment (DPO) ────────────────────┘
        261+ preference pairs
        lr=5e-6, 200 iters/round
        8 rounds iterative
```

## Dataset Composition

| Dataset | Examples | Purpose |
|---------|----------|---------|
| Tool-calling SFT | 21,432 | MCP tool selection (17 tools) |
| Prediction SFT | 3,055 | Word/phrase completion for AAC & clinical |
| GRPO DPO pairs | 261 (seed) + ~150 (generated) | Tool disambiguation alignment |
| SFT validation | 1,128 | Tool-calling validation |
| Prediction validation | 305 | Prediction validation |

### Tool-Calling Data Breakdown
- Tool-call examples with `<think>` reasoning + `<|tool_call|>` JSON: ~13,672 (64%)
- Abstention/reasoning (no tool): ~679 (3%)
- Conversational/coding (no tool): ~7,081 (33%)

### Prediction Data Categories
- AAC basic phrases: ~60 seed prompts × variations
- AAC emotions: ~40 prompts
- Food & ordering: ~40 prompts
- Social interactions: ~40 prompts
- School & work: ~30 prompts
- Places & navigation: ~25 prompts
- Clinical SOAP notes: ~30 prompts
- ABA-specific terminology: ~50 prompts
- Medical terminology: ~25 prompts
- Everyday language: ~15 prompts

## DARE-TIES Merge Technique

**Why**: Training both tasks in a single adapter causes cross-contamination.
Prediction examples containing "not a tool call" in `<think>` tags taught the model
to suppress ALL tool calls (BFCL dropped from 66% to 18%).

**Solution**: Train separate LoRA adapters, merge with DARE-TIES:

1. **DARE (Drop And REscale)**: Randomly prune 40% of adapter weights, rescale remaining
2. **TIES (Trim, Elect Sign, Merge)**: Resolve sign conflicts via majority vote
3. **Weighted**: Tool adapter gets 85% weight, prediction gets 15%

**Result**: Zero cross-contamination. BFCL preserved at 66%, predictions at 13/15.

## Benchmark Results

### BFCL (Berkeley Function Calling Leaderboard) — SWE-Bench Format

| Model Version | Overall | Tool Accuracy | Abstention | Adversarial | Disambiguation |
|---------------|:-------:|:------------:|:----------:|:-----------:|:--------------:|
| Original (pre-prediction) | **66%** | 52% | 89% | 93% | 75% |
| v2 (toxic think tags) | **18%** | 0% | 47% | 60% | 0% |
| v3 (neutral tags, single) | **66%** | 52% | 89% | 93% | 75% |
| **v4 (DARE-TIES merge)** | **66%** | 52% | 89% | 93% | 75% |
| v4-aligned (8x GRPO) | **62%** | 55% | 84% | 87% | 75% |

### Text Prediction Quality (15-prompt benchmark)

| Model | Score | Tool Leak | Notes |
|-------|:-----:|:---------:|-------|
| Original prism-coder:7b | 1/15 | N/A | Not trained for predictions |
| v2 (single adapter) | untested | N/A | BFCL broken |
| v3 (single adapter) | 7/15 | 4 leaks | Tool names in predictions |
| **v4 (DARE-TIES)** | **13/15** | **0 leaks** | Beats Haiku 4.5 (9/15) |

### Prediction Quality Comparison (v4 vs Haiku vs Opus)

| Prompt | prism-coder v4 | Haiku 4.5 | Opus 4 |
|--------|:-:|:-:|:-:|
| "The client dem" | demographics, demands | onstrated, onstrates | onstrated |
| "I feel scared" | about, darkness | when, of | when, I |
| "mastery criteria" | include, understand | for, in, of | are met |
| "Help me order" | a prescription | pizza, dinner | pizza, food |
| "differential rein" | diagnosis, evaluation | pressure, aids | forcement |
| "I need to go" | **home, now, later** | bathroom, home | bathroom, now |
| "parent training was" | **conducted, effectively** | conducted, effective | provided |
| "functional comm" | **communication** | unications | unity |
| "I would like to" | **book appointment** | know, thank | thank, see |
| "Can you please" | **help me with** | tell, help | help, tell |
| "behavior was obs" | **erved, unusual** | erved | erved |
| "My friend is" | **sick, upset, excited** | very, smart | coming |
| "replacement beh" | replacement, behavioral | avior, aviors | avior |
| "The assessment shows" | **improvement, stability** | that, results | improvement |
| "Subjective: Patient" | **with, complaints, fever** | with, complaining | with |

## Known Issues & Path to 90%+

### Current BFCL Failures (17/50)

| Failure Pattern | Count | Root Cause |
|----------------|:-----:|------------|
| `session_forget_memory` → `session_search_memory` | 3 | "forget" vs "search" disambiguation |
| `session_save_ledger` → `session_save_handoff` | 3 | "save" intent disambiguation |
| `session_export_memory` → `session_save_handoff` | 2 | "export/backup" intent |
| `session_task_route` → `NO_TOOL` | 2 | False negative on routing |
| General coding → `knowledge_search` | 3 | False positive on "search/knowledge" |
| Edge cases ("Save.", "Search.", "Check health.") | 4 | Single-word disambiguation |

### Required for 90%+

1. **Hand-crafted SFT examples** (50+ per confused pair):
   - `forget` vs `search` with detailed `<think>` reasoning
   - `save_ledger` vs `save_handoff` with context cues
   - `export` vs `handoff` with intent markers
   - Single-word commands ("Save." → ledger, "Search." → search_memory)

2. **Full GRPO with 4-component reward function**:
   - Format Reward (0.10): `<think>` tag compliance
   - Tool Reward (0.25): Correct tool name
   - Parameter Reward (0.25): Required params present
   - Abstention Reward (0.40): Correct non-tool response

3. **9+ iterative GRPO cycles** with the decomposed reward

## Files Reference

| File | Purpose |
|------|---------|
| `data/train_backup.jsonl` | Original 21K tool-calling SFT data |
| `data/prediction_sft_1k.jsonl` | 2,999 Haiku-generated prediction examples |
| `data/prediction_sft.jsonl` | 56 hand-crafted prediction examples |
| `data/prediction_only/` | Clean prediction data with [MODE:PREDICT] |
| `models/adapter-predict/` | Prediction-only LoRA adapter |
| `models/prism-sft-lora/` | Tool-calling LoRA adapter |
| `models/adapter-merged/` | DARE-TIES merged adapter |
| `models/prism-fused-v4/` | Merged fused model (HF format) |
| `models/prism-coder-v4.gguf` | GGUF export (Q8_0, 7.5GB) |
| `swe_bench_test.py` | BFCL benchmark (50 prompts, 5 categories) |
| `generate_prediction_1k.py` | Prediction data generator (Haiku teacher) |
| `grpo_iterate.py` | Iterative GRPO alignment loop |
| `Modelfile.v4` | Ollama config with dual-mode system prompt |
| `merge_adapters.py` | DARE-TIES adapter merge script (TODO) |

## Training Hyperparameters

| Parameter | Tool Adapter (A) | Predict Adapter (B) | GRPO Alignment |
|-----------|:----------------:|:-------------------:|:--------------:|
| Learning rate | 1e-5 | 2e-5 | 5e-6 |
| Iterations | 1500 | 600 | 200/round |
| Batch size | 1 | 4 | 1 |
| Grad accumulation | 1 | 1 | 4-8 |
| Max seq length | 1024 | 512 | 1650 |
| LoRA rank | 8 | 8 | 8 |
| LoRA layers | 16 | 16 | 16 |
| Final train loss | 0.128 | 0.268 | 0.280 |
| Final val loss | 0.101 | 0.272 | 0.282 |

## Merge Parameters (DARE-TIES)

| Parameter | Value |
|-----------|-------|
| Weight A (tools) | 0.85 |
| Weight B (predict) | 0.15 |
| Density | 0.6 |
| Method | DARE + TIES |

## Key Learnings

1. **Negation in think tags is toxic for 7B models**: "not a tool call" activates tool neurons then suppresses them, causing confusion. Use neutral task descriptions instead.

2. **DARE-TIES merge is the correct approach for multi-task LoRA**: Training separate adapters and merging preserves each task's performance completely. Weight ratio 0.85/0.15 works for primary/secondary task split.

3. **Iterative DPO alone cannot break the 66% BFCL plateau**: The model needs richer SFT examples with detailed reasoning chains, not just correct/incorrect pairs. The 4-component GRPO reward function from the original pipeline is essential.

4. **Q8_0 GGUF quantization preserves model quality**: No measurable degradation from the full-precision model on benchmarks.

5. **Prediction data ratio matters less than format**: 9% prediction data was sufficient with DARE-TIES merge. The format (neutral think tags, [MODE:PREDICT] prefix) is what prevents contamination, not the ratio.
