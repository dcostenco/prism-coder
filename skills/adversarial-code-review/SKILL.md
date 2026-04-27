---
name: adversarial-code-review
description: Generates adversarial review prompts for iterative BFCL pipeline hardening with cumulative fix tracking and repomix workflow
---

# Adversarial Code Review Skill

## Purpose
Systematically harden the Prism BFCL training and evaluation pipeline through iterative adversarial review rounds. Each round uses an external LLM reviewer to find bugs, which are verified against actual code before applying fixes.

## Critical Workflow Rules

### 1. ALWAYS Regenerate Repomix AFTER Fixes
The #1 cause of phantom bug reports is the reviewer analyzing stale code. **Never** send a pre-fix repomix.

```bash
# Generate AFTER applying all fixes for the current round
cd /Users/admin/prism
npx -y repomix \
  --include "training/generate_bfcl_training_data.py,training/generate_diverse_sft.py,training/bfcl_eval.py,training/benchmark.py,training/bfcl_grpo_align.py,training/config.py,training/continuous_learning.py,training/run_bfcl_pipeline.sh" \
  --compress \
  -o training/repomix-rNN.txt
```

### 2. ALWAYS Verify Before Applying
The external reviewer hallucinates already-fixed bugs ~60% of the time. Before applying any fix:
1. `view_file` the exact lines cited
2. Check if the bug exists or was already patched
3. Only apply fixes for **confirmed** bugs

### 3. Save Repomix + Prompt to `training/` Directory
Not `/tmp` — files must persist for audit trail.

---

## Prompt Template (R23+)

Update the round number and "Already-Fixed Bugs" section each round:

```markdown
# Adversarial Code Review — Round NN

## Context
You are a senior ML engineer performing an adversarial code review of a BFCL (Berkeley Function Calling Leaderboard) training and evaluation pipeline. The pipeline trains a model (Prism-Coder, Qwen 2.5 base) for structured tool-calling with Chain-of-Thought reasoning using custom XML-like tags (`<|synalux_think|>`, `<|synalux_answer|>`, `<|tool_call|>`).

## Objective
Find bugs that cause **silent data corruption, score deflation, training distribution drift, or evaluation integrity failures**. Focus on issues that would directly impact BFCL leaderboard rankings.

## Files Under Review
The attached repomix bundle contains:
- `generate_bfcl_training_data.py` — Primary BFCL training data generator (multi-turn, parallel calls, abstention)
- `generate_diverse_sft.py` — Diverse SFT generator (reasoning traps, self-correction, disambiguation)
- `bfcl_eval.py` — Evaluation harness (tool call parsing, strategy 1/2/3, scoring)
- `benchmark.py` — Benchmark runner (model inference, response evaluation, metrics)
- `bfcl_grpo_align.py` — GRPO/DPO alignment (preference pairs, rejected responses)
- `config.py` — Central configuration (system prompts, tool schemas, paths)
- `continuous_learning.py` — Continuous learning from corrections and upvotes
- `run_bfcl_pipeline.sh` — Orchestration script

## Already-Fixed Bugs (DO NOT re-report these)
[Insert cumulative fix list — see below]

## Review Instructions
1. Read every line of the attached codebase carefully.
2. Cross-reference data generation outputs against evaluation parser expectations.
3. Check tag consistency — every XML tag must have proper opening AND closing.
4. Verify regex correctness — handle edge cases (empty blocks, nested tags, multiline).
5. Check data distribution — no over/under-representation of categories.
6. Validate evaluation scoring — handle all response formats correctly.
7. Check for silent failures — try/except swallowing errors, fallbacks masking bugs.
8. Verify multi-turn integrity — valid message role sequences.

## Output Format
For each bug found, provide:
### N. [SEVERITY] Title
- **File:** filename
- **Line numbers:** approximate
- **Severity:** Critical / High / Medium / Low
- **Root cause:** detailed explanation
- **Proposed fix:** code snippet

Only report bugs with **concrete evidence** from the code.
```

---

## Cumulative Fix History (R7–R22)

### R7–R15: Foundation
- System prompt centralization into `config.py`
- Schema registry completeness
- Tool call tag consistency (`<|tool_call|>` / `</|tool_call|>`)

### R16: CoT in Abstention Examples
- **File:** `generate_bfcl_training_data.py`
- `ABSTENTION_RESPONSES` now include `<|synalux_think|>` blocks
- All abstention completions follow think-then-answer pattern

### R17: CoT Hallucination Bypass
- **File:** `bfcl_eval.py`
- `parse_all_tool_calls` strips `<|synalux_think|>` blocks before regex extraction
- `_repair_and_extract` operates on `clean_text` (CoT-stripped)

### R18: Strategy 2/3 CoT Bypass
- **File:** `bfcl_eval.py`
- All extraction strategies (1, 1b, 2, 3) operate on `clean_text`
- **File:** `generate_diverse_sft.py`
- Self-correction traces use correct closing tag `</|synalux_answer|>`

### R19: Unclosed Think Blocks + DPO CoT
- **Files:** `bfcl_eval.py`, `bfcl_grpo_align.py`
- `parse_all_tool_calls` and `_repair_and_extract` regex handles unclosed think blocks via `(?:</\|synalux_think\|>|$)` fallback
- DPO rejected pairs include mandatory `<|synalux_think|>` blocks
- CoT stripping regex hardened with `|$` fallbacks

### R20: Mode Collapse + Hallucination Injection + evaluate_response
- **File:** `generate_diverse_sft.py`
- All 85 `REASONING_PROMPTS` converted from bare strings to `(prompt, answer)` tuples with real technical answers across 9 categories (CS fundamentals, frameworks, ML, meta-questions, greetings, keyword traps, session FP, context manager FP, LSTM forget gate FP)
- `build_reasoning_completion(prompt, answer)` accepts and injects the answer directly
- **File:** `generate_bfcl_training_data.py`
- `TOOL_SWITCH_INTERRUPTIONS` filtered against active `tools` schema (prevents hallucination poisoning, falls back to verbal refusal)
- **File:** `benchmark.py`
- `evaluate_response` `think_match` and `pre_clean` regexes updated with unclosed tag fallback

### R21: Sequential Steps + Interruption Tags + Eval Guard + CL Fix
- **File:** `generate_bfcl_training_data.py`
  - Dependent multi-step scenarios (web_search→web_scrape) generate sequential multi-turn conversations with simulated tool responses between steps (not parallel blocks)
  - `INTERRUPTION_RESPONSES` wrapped in mandatory `<|synalux_think|>` + `<|synalux_answer|>` XML tags with reasoning blocks
- **File:** `bfcl_eval.py`
  - AST scoring: `isinstance(actual_args, dict)` guard prevents crash on hallucinated array arguments
- **File:** `continuous_learning.py`
  - Conditional correction wrapping — `<|tool_call|>` corrections injected natively without `<|synalux_answer|>` nesting

### R22: DPO Rejected Pairs CoT
- **File:** `generate_bfcl_training_data.py`
  - `generate_grpo_pairs` `rejected_response` now includes `<|synalux_think|>` block (prevents DPO from penalizing reasoning as shortcut)

---

## Pipeline Files Reference

| File | Role | Key Functions |
|------|------|---------------|
| `config.py` | Central config | System prompts, tool schemas, paths |
| `generate_bfcl_training_data.py` | Primary data gen | `generate_simple_examples`, `generate_multi_turn_examples`, `generate_v4_agentic_examples`, `generate_grpo_pairs` |
| `generate_diverse_sft.py` | Diverse SFT | `REASONING_PROMPTS`, `build_reasoning_completion`, self-correction, disambiguation |
| `bfcl_eval.py` | Eval harness | `parse_all_tool_calls`, `_repair_and_extract`, strategy 1/1b/2/3, AST scoring |
| `benchmark.py` | Benchmark runner | `evaluate_response`, model inference, metrics |
| `bfcl_grpo_align.py` | GRPO/DPO alignment | Preference pairs, rejected responses |
| `continuous_learning.py` | CL from corrections | Correction formatting, upvote handling |
| `run_bfcl_pipeline.sh` | Orchestration | Pipeline execution script |

---

## Common Reviewer Hallucination Patterns

After 22 rounds, these are the most common false positives from external reviewers:

1. **"REASONING_PROMPTS is still bare strings"** — Fixed in R20. All 85 are tuples.
2. **"build_reasoning_completion returns generic preamble"** — Fixed in R20. Accepts and injects answer.
3. **"AST guard unconditionally wipes actual_args"** — Fixed in R21. Guard IS conditional.
4. **"Parallel dependent steps"** — Fixed in R21. Now sequential multi-turn.
5. **Re-reporting any R16-R19 fixes** — CoT stripping, abstention tags, unclosed blocks, DPO CoT.

**Mitigation:** Always regenerate repomix AFTER fixes. Always verify claims against actual code before applying.
