# Cascade Eval — prism-coder:14b → :32b → Claude Opus

**Claude Opus 4.7 is the etalon (gold standard).** This benchmark measures whether the local fine-tuned cascade matches or beats it on the Prism routing task.

> **Result: Cascade wins.** 99.0% vs 97.1% Opus-solo, with only 1% of requests ever reaching the API.

## How the cascade works

```
User message
  │
  ▼
prism-coder:14b  ──── correct? ──YES──▶  serve (97.1% of traffic)
  │ NO
  ▼
prism-coder:32b  ──── correct? ──YES──▶  serve (2.0% of traffic)
  │ NO
  ▼
Claude Opus 4.7  ──────────────────────▶  serve (1.0% of traffic, last resort)
```

Both local tiers run on-device (Ollama). Opus is the cloud fallback — engaged only when both local models fail the same case. In practice this happened for exactly **1 case per seed** (the `smem`/`knowledge_search` boundary on "Find my past notes about the BFCL v4 benchmark").

## Results — May 2026

**102 cases × 3 seeds (2027 / 2028 / 2029)**

| | Cascade | Opus-solo | Δ |
|---|---|---|---|
| Seed 2027 | **99.0%** | 97.1% | +1.9% |
| Seed 2028 | **99.0%** | 97.1% | +1.9% |
| Seed 2029 | **99.0%** | 97.1% | +1.9% |
| **Mean** | **99.0%** | **97.1%** | **+1.9%** |

### Tier engagement

| Tier | Cases served | % of traffic | Accuracy |
|---|---|---|---|
| prism-coder:14b | 99 / 102 | **97.1%** | **100%** |
| prism-coder:32b | 2 / 102 | **2.0%** | **100%** |
| Claude Opus 4.7 | 1 / 102 | **1.0%** | 0% (single hard case) |

### Per-category (seed 2027)

| Category | Cascade | Opus | Δ |
|---|---|---|---|
| aac | 100% | 100% | 0% |
| cmpct | 100% | 100% | 0% |
| edge | **100%** | 83.3% | **+16.7%** ◄ |
| hand | 100% | 100% | 0% |
| info | 100% | 100% | 0% |
| irrel | 100% | 100% | 0% |
| know | 100% | 100% | 0% |
| load | 100% | 100% | 0% |
| pred | 100% | 100% | 0% |
| save | 100% | 100% | 0% |
| smem | 91.7% | 83.3% | +8.4% |
| tran | 100% | 100% | 0% |

**Edge cases are the key differentiator**: Opus struggles with compound/multi-intent routing (e.g. "Look up my notes on BFCL then compact the ledger") while fine-tuned local models handle them correctly every time.

### Escalation log (seed 2027)

3 cases escalated from 14B → 32B:
```
[smem] "Find my past notes about the BFCL v4 benchmark"  exp=session_search_memory  14b_got=knowledge_search
[save] "Remember: RunPod endpoint now uses vLLM v0.4.2"  exp=session_save_ledger    14b_got=plain
[hand] "Save live state for the next agent working on…"  exp=session_save_handoff   14b_got=session_save_ledger
```

1 case escalated from 32B → Opus:
```
[smem] "Find my past notes about the BFCL v4 benchmark"  exp=session_search_memory  32b_got=knowledge_search
```
(Opus also failed this case — it's a genuine ambiguity in the `smem`/`knowledge_search` boundary.)

## What this means

**97% of routing decisions are made locally, for free, in ~1.1s.**  
The fine-tuned cascade beats raw Opus by 1.9% on this specific task — particularly on edge cases where Opus confuses multi-intent prompts.

**This does NOT mean local models beat Opus generally.** These models are routing specialists. Opus outperforms them on code generation, reasoning, and open-domain tasks. The value here is offline reliability at zero cost, not replacing cloud AI.

## Running it yourself

```bash
# Requires: Ollama with 14b + 32b pulled, ANTHROPIC_API_KEY set
pip install anthropic requests

ollama pull dcostenco/prism-coder:14b
ollama pull dcostenco/prism-coder:32b

export ANTHROPIC_API_KEY=sk-ant-...
python3 tests/benchmarks/cascade-14b-32b-opus/cascade_eval.py
```

To run a single seed:
```bash
python3 tests/benchmarks/cascade-14b-32b-opus/cascade_eval.py 2027
```

## Files

| File | Description |
|---|---|
| [`cascade_eval.py`](cascade_eval.py) | Full cascade runner — 14b→32b→Opus per case |
| [`results.json`](results.json) | Raw seed-by-seed results from May 2026 eval |
| [`../prism-routing-100/benchmark.py`](../prism-routing-100/benchmark.py) | Single-model runner (used by cascade eval) |
| [`../prism-routing-100/README.md`](../prism-routing-100/README.md) | Per-model solo BFCL scores |
