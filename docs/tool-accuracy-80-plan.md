# Prism-Coder Tool Accuracy: 33% → 80% Plan

## Current State

| Metric | Score |
|---|---|
| Overall accuracy | **33.3%** (5/15) |
| Tool-call (N=7) | **0.0%** ← critical |
| Retrieval (N=3) | **0.0%** ← critical |
| Reasoning (N=5) | **100.0%** ✅ |
| JSON validity | **100.0%** ✅ |

## Root Cause Analysis

### 1. Format Drift — `<search>` tags instead of `<tool_call>`
The model uses `<search>{...}</search>` tags from base Qwen's built-in tool-calling instinct. The GRPO training (only 15 prompts × 5 repeats = 75 examples) wasn't enough to override this deeply baked format.

### 2. Train/Serve System Prompt Mismatch
- **GRPO trains** with: `"You are Prism, an AI coding assistant with persistent memory. Use MCP tools when appropriate."`
- **Modelfile serves** with: Full 29-line prompt including tool list and `<tool_call>` format instructions
- The model never saw the format instructions during training

### 3. Tiny Training Set
- SFT: 2,854 train + 318 valid examples ← reasonable
- GRPO: **15 prompts × 5 repeats = 75 examples** ← far too small
- Synthetic chosen: Only 4 handcrafted gold responses out of 15
- DPO pairs generated: **20 total** ← minimal

### 4. Reward Function Blind Spot
`compute_reward()` only rewards `<tool_call>` and `<|im_start|>` formats. It doesn't **penalize** `<search>` tags — they score the same as "no tool call" (neutral), so the model learned that `<search>` is acceptable.

### 5. GGUF Export Lost Fine-Tune Signal
The adapter weights from SFT+GRPO may have been diluted during GGUF quantization from MLX → Ollama, especially with such a small training signal.

---

## Fix Plan (5 Phases)

### Phase 1: Immediate — Negative Reward for `<search>` Tags
**Impact: +10-15% accuracy | Effort: 30 min**

#### [MODIFY] [grpo_align.py](file:///Users/admin/prism/training/grpo_align.py)

Add explicit penalty in `compute_reward()` for wrong format tags:
```diff
+    # PENALTY: wrong format tags (base model instinct leak)
+    WRONG_TAGS = ['<search>', '<response>', '<result>', '<|im_start|>tool']
+    for tag in WRONG_TAGS:
+        if tag in response_text:
+            reward -= 3.0  # Strong negative signal
```

---

### Phase 2: System Prompt Alignment — Train What You Serve
**Impact: +15-20% accuracy | Effort: 1 hour**

#### [MODIFY] [grpo_align.py](file:///Users/admin/prism/training/grpo_align.py)

Replace the short system prompt in `generate_grpo_prompts()` and `main()` with the **exact Modelfile system prompt**:
```diff
-    sys_msg = "You are Prism, an AI coding assistant with persistent memory. Use MCP tools when appropriate."
+    sys_msg = """You are Prism, an AI coding assistant with persistent memory across sessions.
+You have access to MCP tools for session management, knowledge retrieval, and project context.
+When users ask about project history, decisions, stored context, or need to save work, use the appropriate tool.
+When users ask general coding questions, answer directly without using tools.
+
+Available MCP tools:
+- session_load_context: Load full project context (required: project, optional: level)
+- session_save: Save session summary with decisions/TODOs (required: project, summary)
+... [full tool list from Modelfile]
+
+Format tool calls as:
+<tool_call>
+{"name": "tool_name", "arguments": {"param": "value"}}
+</tool_call>"""
```

---

### Phase 3: 10× Training Data Expansion (15 → 150 prompts)
**Impact: +20-25% accuracy | Effort: 2-3 hours**

#### [MODIFY] [grpo_align.py](file:///Users/admin/prism/training/grpo_align.py)

Expand `generate_grpo_prompts()` from 15 → **150 prompts** across all 10 tools with diverse phrasing:

| Tool | Current | Target | Example New Prompts |
|---|---|---|---|
| `session_load_context` | 1 | 15 | "What's happening in project X?", "Give me the state of project X", "Resume work on X" |
| `session_save` | 1 | 15 | "Save this: ...", "Record that ...", "Log this work: ...", "Note: we decided ..." |
| `session_search` | 1 | 15 | "Find past work on ...", "When did we work on ...?", "Any history of ...?" |
| `knowledge_save` | 1 | 15 | "Remember: ...", "Store this fact: ...", "Note for future: ..." |
| `knowledge_search` | 1 | 15 | "What do we know about ...?", "Any knowledge on ...?" |
| `session_task_route` | 1 | 15 | "Should local handle ...?", "Route this task: ...", "Which agent for ...?" |
| Other tools | 5 | 30 | Diverse phrasing for list/delete/link/handoff |
| Reasoning (no tool) | 3 | 25 | General CS, coding, math, architecture questions |

#### [MODIFY] Synthetic chosen coverage
Expand `generate_synthetic_chosen()` from 4 → **all 10 tools** with gold-standard `<think>` + `<tool_call>` responses.

---

### Phase 4: Full GRPO Re-training (Ollama-Compatible)
**Impact: Consolidates Phases 1-3 | Effort: 4-8 hours compute**

#### [MODIFY] [grpo_align.py](file:///Users/admin/prism/training/grpo_align.py)

Update training hyperparameters:
```diff
-    parser.add_argument("--repeat", type=int, default=5)
-    parser.add_argument("--iters", type=int, default=300)
+    parser.add_argument("--repeat", type=int, default=3)   # Less repetition, more diversity
+    parser.add_argument("--iters", type=int, default=600)   # 2× iters for larger dataset
```

Execution:
```bash
# 1. Install MLX (required for fine-tuning)
pip3 install mlx mlx-lm

# 2. Run GRPO with synthetic injection
python3 training/grpo_align.py --synthetic --repeat 3 --iters 600

# 3. Fuse adapter into base model
python3 -m mlx_lm.fuse --model training/models/qwen-7b-mlx --adapter-path training/models/prism-grpo-lora --save-path training/models/prism-fused-v2

# 4. Convert to GGUF
python3 -m mlx_lm.convert --model training/models/prism-fused-v2 --quantize q4_K_M --output training/models/prism-fused-v2.gguf

# 5. Rebuild Ollama model
ollama create prism-coder:7b -f training/Modelfile
```

---

### Phase 5: Benchmark Verification
**Impact: Measurement | Effort: 5 min**

```bash
python3 /tmp/prism_benchmark_ollama.py
```

Target gates:

| Metric | Current | Target | Gate |
|---|---|---|---|
| Overall accuracy | 33.3% | **≥80%** | Must pass |
| Tool-call (N=7) | 0.0% | **≥70%** | Must pass |
| Retrieval (N=3) | 0.0% | **≥66%** | Must pass |
| Reasoning (N=5) | 100% | **≥80%** | No regression |
| JSON validity | 100% | **100%** | No regression |

---

## Quick Win Option (No Retraining)

If MLX fine-tuning isn't feasible right now, a **Modelfile-only fix** can recover significant accuracy:

#### [MODIFY] [Modelfile](file:///Users/admin/prism/training/Modelfile)

Add few-shot examples directly in the system prompt:
```diff
 Format tool calls as:
 <tool_call>
 {"name": "tool_name", "arguments": {"param": "value"}}
 </tool_call>
+
+IMPORTANT: Do NOT use <search>, <response>, or <result> tags. Only use <tool_call>.
+
+Examples:
+User: "Show me the context for my-project"
+<think>The user wants to load project context. I'll use session_load_context.</think>
+<tool_call>
+{"name": "session_load_context", "arguments": {"project": "my-project"}}
+</tool_call>
+
+User: "Save this: implemented auth middleware"
+<think>The user wants to record work. I'll use session_save.</think>
+<tool_call>
+{"name": "session_save", "arguments": {"project": "my-project", "summary": "implemented auth middleware"}}
+</tool_call>
+
+User: "What is REST?" → Answer directly, no tool needed.
```

> [!IMPORTANT]
> The quick-win Modelfile fix can be tested in **5 minutes** and may recover 20-30% accuracy before any retraining.

---

## Estimated Impact

| Phase | Effort | Accuracy Gain | Cumulative |
|---|---|---|---|
| Quick Win (Modelfile) | 5 min | +20-30% | ~55% |
| Phase 1 (Negative reward) | 30 min | +10-15% | ~65% |
| Phase 2 (Prompt alignment) | 1 hour | +5-10% | ~70% |
| Phase 3 (150 prompts) | 2-3 hours | +10-15% | ~80% |
| Phase 4 (Full retrain) | 4-8 hours | consolidates | **≥80%** |
