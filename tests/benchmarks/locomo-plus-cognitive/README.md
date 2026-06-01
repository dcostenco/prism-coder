# LoCoMo-Plus Cognitive Memory Benchmark

401-sample cognitive dialogue memory evaluation from the [LoCoMo-Plus](https://github.com/dcostenco/Locomo-Plus) benchmark (ARR 2026).

Each sample contains a ~65K-char multi-day conversation with an embedded memory "cue" placed days before a "trigger" query. The model must demonstrate awareness of the earlier cue when responding to the trigger.

## Results (2026-06-01)

Judge: `gemini-2.5-flash` (temperature=0.0, scoring: correct=1, wrong=0)

| Configuration | Score | Accuracy |
|---|---|---|
| Gemini-2.5-flash (Baseline) | 278/401 | 69.33% |
| Prism-MCP (Gemini-2.5-flash + Memory) | 361/401 | 90.02% |
| Gemini-3.1-pro-preview (Baseline) | 272/401 | 67.83% |
| Prism-MCP (Gemini-3.1-pro + Memory) | 382/401 | 95.26% |
| Gemini-3.5-flash (Baseline) | 237/401 | 59.10% |
| Prism-MCP (Gemini-3.5-flash + Memory) | 388/401 | 96.76% |
| Claude Sonnet 4.6 (Baseline) | 290/401 | 72.32% |

## Reproduce

```bash
git clone https://github.com/dcostenco/Locomo-Plus /tmp/Locomo-Plus
cd /tmp/Locomo-Plus

# Baseline (Gemini)
export GOOGLE_API_KEY="..."
python3 evaluation_framework/task_eval/evaluate_qa.py \
  --data-file data/unified_cognitive_only.json \
  --out-file output/baseline_pred.json \
  --model gemini-3.5-flash --backend call_gemini --concurrency 5

# Baseline (Claude)
export ANTHROPIC_API_KEY="..."
python3 evaluation_framework/task_eval/evaluate_qa.py \
  --data-file data/unified_cognitive_only.json \
  --out-file output/claude_pred.json \
  --model claude-sonnet-4-6 --backend call_claude --concurrency 3

# Judge
python3 evaluation_framework/task_eval/llm_as_judge.py \
  --input-file output/claude_pred.json \
  --out-file output/claude_judged.json \
  --model gemini-2.5-flash --backend call_gemini --concurrency 5
```
