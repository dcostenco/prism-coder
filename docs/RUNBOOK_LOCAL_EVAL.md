# Local Eval Runbook

The single most important rule when iterating on Prism Coder models locally: **make your local eval match Ollama's eval within ±3 points before you trust local numbers**. We had a 17-point divergence (70% MLX vs 87% Ollama for the same base model) that almost led to wasted cloud-GPU money on "regressions" that were actually harness bugs.

## The thinking-mode trap (root cause of the 17-pt gap)

Qwen3 chat templates default to **thinking mode ON**. When `apply_chat_template()` is called without `enable_thinking=False`, the template emits an OPEN `<think>` tag and expects the model to fill in reasoning. That reasoning consumes hundreds of tokens before the model can emit the `<|tool_call|>` block — and with `max_tokens=160` (our eval default), the model never gets that far.

Symptoms in evals: tool-call categories collapse to 0–30% while plain-text categories still look fine.

Ollama bakes the nothink template into Modelfiles (`<think>\n\n</think>` pre-closed). MLX-LM does not — you have to opt in.

## Required harness settings for MLX direct eval

```python
prompt_text = tokenizer.apply_chat_template(
    messages,
    tokenize=False,
    add_generation_prompt=True,
    enable_thinking=False,           # ← REQUIRED for Qwen3 + QwQ
)
out = generate(model, tokenizer, prompt=prompt_text, max_tokens=160, verbose=False)
```

Pin: `tests/eval/test_mlx_vs_ollama_parity.py`. CI catches if a future Qwen tokenizer version silently changes the default.

## Parity scoring baseline (May 14 2026, Qwen3-14B base)

| Category | Ollama (87%) | MLX with thinking=False (89%) | Δ |
|---|---|---|---|
| Overall | 87% | 89% | +2 |
| edge | 60% | 83% | +23¹ |
| hand | 62% | 62% | 0 |
| save | 100% | 100% | 0 |
| smem | 100% | 100% | 0 |
| pred | 62% | 75% | +13¹ |
| know | 43% | 57% | +14¹ |

¹ MLX scores HIGHER on a few categories because Ollama hits 60s read-timeouts on some long-running 14B prompts. MLX has no such timeout, so it scores the model fairly.

**Rule of thumb**: if MLX overall differs from Ollama overall by >3 points (in either direction), STOP and investigate before doing more training.

## Local research workflow

1. **Baseline first**: Run `python3 eval_100case_mlx.py --model mlx_model_qwen3_<size> --seed 2027` against base. Note score per category.
2. **Small smoke train**: Train 5-10 iters with your candidate recipe. Re-eval. If overall regresses >5 points, kill it — recipe is bad.
3. **Full train only after smoke passes**: keep iteration counts low (50-100) for light-touch polish recipes. More than that risks mode collapse on small tool-routing models.
4. **BFCL gate at midpoint**: Run `bfcl_gate_mlx.py` at iter 25/50/100. If score drops below 90% on the 16-case gate, abort.
5. **Convert + retest in Ollama**: After fuse+GGUF+import, run `benchmark.py --models <your-tag> --seed 2027`. Verify MLX↔Ollama parity holds (within ±3 of the MLX score from step 4).

## When to use which eval

| Eval | Cases | Time | When to use |
|---|---|---|---|
| `bfcl_gate_mlx.py` | 16 | 30s on M4 Max | Sanity check during training (every 25 iters) — cheap pass/fail |
| `eval_100case_mlx.py` | 100 | ~5 min | Local research; pre-Ollama comparison; per-category diagnosis |
| `benchmark.py --models <tag>` | 100 | ~10–15 min | Final apples-to-apples vs published baselines (must match what shipped) |

## Common pitfalls

- **Loading two models simultaneously** (MLX 14B + Ollama 14B) on a 48GB Mac → Metal OOM. Stop one before the other (`ollama stop <model>`).
- **Forgetting to restore `benchmark.py`** after pointing it at a local tag — commits noise to the eval-script. Use `cp benchmark.py /tmp/benchmark.py.orig` first.
- **Comparing different seeds** between two runs and assuming the gap is a real regression. Always pin seed 2027 for like-for-like.
- **Trusting single runs** over 1% — model variance + scoring quantization (each case is ±1pt) make sub-1% claims meaningless. Always state mean ± std.
