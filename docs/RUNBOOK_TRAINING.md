# Training Runbook

Pinned recipes and known-bad patterns from this session's burn. Read this BEFORE launching any training run.

## Quick decision tree

```
Want to improve a published tier (1.7B / 14B / 32B)?
├── Is the gap in 1-2 specific categories? (e.g. know_srch 43%, handoff 60%)
│   → Use v26-polish recipe — small targeted corpus, light touch
│
├── Is the model already at the gate (>90%)?
│   → STOP. Re-running the eval 3× is more valuable than retraining.
│     Variance + benchmark size makes "98% vs 99%" meaningless.
│
└── Is the model below 80% on the gate?
    → Investigate base model match first (see lineage check below).
      If base is right, then larger corpus may help — but pin the
      regression-class recipe (v25-max) as a known-bad and avoid it.
```

## Known-GOOD recipe — v26-polish (14B 87% → 90%, +3 pts)

```yaml
# tests/configs/recipe_v26_polish.yaml
base:              "Qwen/Qwen3-14B"     # MUST match BASE_MODEL_LINEAGE
corpus_rows:       576                   # 56% plain-text guards + 44% tool exemplars
iters:             50                    # small enough to avoid mode collapse
learning_rate:     1e-6                  # tiny — barely moves loss
batch_size:        1
grad_accum:        1
lora_rank:         8                     # minimal
lora_alpha:        16
target_modules:    [q_proj, k_proj, v_proj, o_proj]   # QKVO only, no MLP
max_seq:           2048
hardware:          "Mac M4 Max (MLX)"
wall_time:         "~5 min"
```

Hit rates: `know_srch 43% → 71% (+28)`, `handoff 60% → 88% (+28)`, no regression on the 100% categories. The light touch is the point — heavier touches regress.

## Known-BAD recipe — v25-max (caused 14B 100% → 81% on BFCL gate)

```yaml
# DO NOT USE. PINNED FOR REGRESSION DETECTION ONLY.
base:              "Qwen/Qwen3-14B"
corpus_rows:       40000                 # ❌ 70x too many — tool-density too high
iters:             300                   # ❌ 6x too many — over-fits to tool format
learning_rate:     3e-6                  # 3x v26-polish
lora_rank:         32                    # 4x v26-polish capacity
lora_alpha:        64
target_modules:    [q_proj, k_proj, v_proj, o_proj, gate_proj, up_proj, down_proj]
```

**Failure mode**: tool-call mode collapse. Model invokes a tool for prompts like *"Write a Python function"* (should be plain text). On the 16-case BFCL gate, base = 100%, this recipe = 81%.

**Lesson**: tool-routing models are easy to break. Less is more. If you must use larger r/iters, **rebalance the corpus to >60% plain-text** to keep the tool-vs-plain-text decision boundary stable.

## Base model lineage — ALWAYS check before training

This session burned **$11 on cloud B200** before catching that a new 32B LoRA was being trained from `Qwen/Qwen3-32B` when the published v19 was trained from `Qwen/QwQ-32B`. The resulting adapter produced coherent text but **couldn't emit tool calls at all** because system prompt + corpus were authored against QwQ-32B's behavior.

**Always run before training**:

```bash
pytest tests/training/test_base_model_lineage.py
```

Or manually:

```bash
# What does the prior published adapter use as its base?
cat training/models/prism-coder-<tier>-v19-final/adapter_config.json | jq .base_model_name_or_path

# What is my new training script set to?
grep -E "MODEL_ID|base_model" my_train_script.py
```

**Canonical lineages (May 2026)**:

| Tier | Published base |
|---|---|
| 1.7B | `Qwen/Qwen3-1.7B` (system-prompt-only, no LoRA fine-tune) |
| 14B  | `Qwen/Qwen3-14B` |
| 32B  | `Qwen/QwQ-32B` ⚠️ NOT Qwen3-32B |

## The training-day checklist

Before kicking off cloud training:

- [ ] **Script preflight**: `pytest tests/training/test_training_script_preflight.py -k <your-script>` passes (catches 4-bit base, wrong lineage, bad corpus, high iters — all at $0 before any GPU allocation)
- [ ] **Lineage**: `pytest tests/lineage/test_base_model_lineage.py` passes
- [ ] **Recipe is on the GOOD list above** OR you've explicitly justified the deviation
- [ ] **Corpus composition check**: print bucket percentages; tool-call rows ≤ 50%
- [ ] **Smoke train locally first**: 5 iters on the Mac (any tier ≤14B). If train_loss explodes or evaluation outputs are garbage, abort before launching cloud
- [ ] **Pre-flight cost estimate**: `python3 tools/cost_estimator.py --hours X --gpu BB` shows expected spend. User confirms if >$15
- [ ] **BFCL gate at iter 25 OR midway**: cancel run if score drops below 90% on the 16-case gate
- [ ] **Convert + retest via Ollama**: NEVER ship a model where Ollama and MLX scores diverge >5 points
- [ ] **Conversion pipeline check**: `pytest tests/conversion/test_gguf_conversion_pipeline.py` passes (catches 4-bit dequant slow GGUFs and TTFT regressions)

## The publishing-day checklist

After training succeeds:

- [ ] Lineage check still passes (new adapter directory inspected)
- [ ] `pytest tests/eval/test_mlx_vs_ollama_parity.py` passes (no harness regression)
- [ ] `pytest tests/conversion/test_gguf_conversion_pipeline.py` passes (no 4-bit dequant slow GGUFs, TTFT within gate)
- [ ] Eval 3 seeds on the new model, mean ± std written into the model card
- [ ] Per-category breakdown surfaced — call out categories that regressed AND categories that gained
- [ ] No "100%" claim in the model card — see [`RUNBOOK_LOCAL_EVAL.md`](./RUNBOOK_LOCAL_EVAL.md) for why this is structurally suspect
- [ ] HF Hub model card updated; old aliases retired
