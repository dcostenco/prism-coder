# Adversarial ML Code Review — Round 5 (R5 Optimizations)

You are an adversarial ML code reviewer. Below is the **full codebase** (via repomix) for a function-calling fine-tuning pipeline targeting #1 on BFCL V4 (Berkeley Function Calling Leaderboard).

## Context

**Hardware**: Apple Silicon M5 Max 48GB (MLX-native)  
**Base Model**: xLAM-2-32b-fc-r (Salesforce)  
**Framework**: mlx-lm QLoRA  
**Pipeline**: SFT → RS-SFT → SLERP Souping → Ollama Deploy → BFCL Eval

## What Changed in Round 5

Seven advanced optimizations were implemented:

| ID | Optimization | File(s) Changed | Target |
|----|-------------|-----------------|--------|
| R5-1 | SM-CoT (Schema-Mapping Chain-of-Thought) | `config.py`, `generate_bfcl_training_data.py` | AST accuracy, miss_param |
| R5-2 | Optional Parameter Restraint | `generate_bfcl_training_data.py` | Hallucination (10% weight) |
| R5-3 | Constrained Decoding + JSON Repair | `bfcl_eval.py` | Exec/Live (10% weight) |
| R5-4 | Tool RAG (Top-5 Injection) | `semantic_rag.py` | Latency + accuracy |
| R5-5 | KV Cache / Prefix Caching | `config.py`, `bfcl_eval.py` | TTFT latency |
| R5-6 | Dry-Run Safety Training | `config.py`, `generate_bfcl_training_data.py`, `reallife_test.py` | Production safety |
| R5-7 | NEFTune Noise Embedding | `bfcl_qlora_finetune.py` | Zero-shot generalization |

## Previous Fixes Already Verified (Rounds 1-4)

- ✅ ChatML format compliance
- ✅ re.findall parallel extraction
- ✅ BalanceSFT removal (no unrolling)
- ✅ Self-correction traces upsampled (540 examples, ~5% mass)
- ✅ Coding anchors scaled to 1200 (15-20% ratio)
- ✅ Router PCA(16) + 240 synthetic seeds
- ✅ System prompt → single config.py import
- ✅ bfcl_eval_mode flag for conditional clarification
- ✅ State block injection for training-inference parity
- ✅ V4 agentic schemas (web_search, memory_kv, memory_vector)

## Review Checklist

Score each area PASS/FAIL with justification:

### 1. SM-CoT Correctness
- Does `build_smcot_think()` correctly iterate all schema properties?
- Does it handle tools with zero optional params?
- Does the training data actually use SM-CoT format (not conversational)?
- Is the SM-CoT format consistent between training and inference-time prompts?

### 2. Optional Parameter Restraint
- For tools with 3+ optional params, does the training JSON STRICTLY omit unmentioned optionals?
- Does the SM-CoT explicitly mark each optional as "Not specified → OMIT"?
- Are the expansive query templates truly expansive (not just restating required params)?
- Is the 500-example count sufficient to influence model behavior (~5-7% of dataset)?

### 3. Constrained Decoding
- Does `_repair_and_extract()` correctly handle trailing commas, string booleans, missing braces?
- Does the regex `r'"(\d+)"'` overzealously convert strings that should remain strings (e.g., zip codes "10001")?
- Is the repair strategy safe or could it produce semantically wrong JSON?

### 4. Tool RAG
- Does `retrieve_top_k()` actually perform cosine similarity correctly?
- Is the embedding text (`name: description. Parameters: param_list`) rich enough for discrimination?
- What happens if the correct tool is not in the top-5? Is there a fallback to the full registry?
- Is there a cold-start problem (no embeddings file on first run)?

### 5. KV Cache
- Are the Ollama config constants (`keep_alive`, `num_ctx`) actually consumed by the eval harness?
- Does `num_ctx: 16384` exceed what the model was trained with?

### 6. Dry-Run Safety
- For destructive tools, does the training data ALWAYS include `dry_run: true`?
- Is the `DESTRUCTIVE_TOOLS` set complete? Are there other destructive Prism MCP tools missing?
- Does the SM-CoT correctly flag the destructive action with the ⚠️ marker?
- In `session_forget_memory`, `hard_delete: True` is trained WITHOUT `dry_run` — is this intentional? (It doesn't have a dry_run param in the real schema)

### 7. NEFTune
- Is the `--neftune-noise-alpha` flag correctly passed to `mlx_lm.lora`?
- Does the fallback (`CalledProcessError` catch) actually work? `subprocess.CalledProcessError` doesn't contain "neftune" in its message — the error would be "unrecognized arguments".
- Is alpha=5.0 appropriate for a 32B model? Research suggests 5-10 for 7B, lower for larger models.

### 8. Data Balance (Critical)
- With 3 new generators (SM-CoT 300 + Optional Restraint 500 + Dry-Run 200 = 1000), what's the new total dataset size?
- Does adding 1000 new examples break the existing 15-20% coding anchor ratio?
- Is there risk of SM-CoT format overfitting (model outputs structured format even when not needed)?

### 9. Import/Dependency Graph
- Does `generate_bfcl_training_data.py` correctly import `build_smcot_think`, `build_dryrun_smcot_think`, and all token constants from `config.py`?
- Does `bfcl_eval.py` correctly lazy-import config constants inside `call_ollama()`?
- Does `semantic_rag.py` correctly handle missing dependencies (`config.py` import in `build_rag_system_prompt()`)?

### 10. Synalux-Prism Boundary
- Run: `grep -rn 'synalux-private\|synalux-portal\|bcba-private\|You are Synalux' *.py *.sh`
- Expected: 0 results

## Severity Guide

- **CRITICAL**: Will cause wrong BFCL scores, training failure, or data corruption
- **HIGH**: Will degrade model quality or leak private information
- **MEDIUM**: Suboptimal but functional
- **LOW**: Style/documentation issues

Provide a summary table with fix IDs (R5-1a, R5-1b, etc.) for each finding.
