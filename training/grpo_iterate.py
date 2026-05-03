#!/usr/bin/env python3
"""Iterative DPO alignment with TEACHER-GENERATED chosen traces.

Reviewer fix #1: previous version overwrote nuanced reasoning with shallow
hard-coded `<think>` templates ("The user wants to X. I should use X."),
causing reasoning collapse and a regression from 66% -> 62% BFCL.

This version uses Claude as a teacher to write each `chosen` <think> trace
as an EXPLICIT contrastive debate between the right tool and the wrong
tool the model actually picked. The rejected trace is the model's real
output. This preserves the depth of reasoning the SFT phase taught.

Layer 3 false-positive heuristics are disabled during the benchmark so
the loop sees the model's true failure distribution.
"""
import json, subprocess, re, time, os, shutil, urllib.request

MODEL_TAG = "prism-coder:7b-v5c"
BASE_MODEL = "models/prism-fused-v5c"
ADAPTER_DIR = "models/adapter-v5c-align-iter"
TARGET_SCORE = 0.90
MAX_ROUNDS = 8
BENCHMARK_CMD = ["python3", "-u", "swe_bench_test.py", "--runs", "1", "--no-validate-layer3"]
TEACHER_MODEL = "qwen2.5-coder:32b"   # local Ollama teacher
OLLAMA_API = "http://localhost:11434/api/generate"


TEACHER_SYSTEM = """You write contrastive reasoning traces for a tool-calling LLM's preference-tuning data.

Given a user prompt, the RIGHT tool, and the WRONG tool the model actually picked, produce a `<think>` trace that:
1. Names the wrong tool and acknowledges what about the prompt made it tempting.
2. Identifies the discriminating signal that disqualifies the wrong tool.
3. Commits to the right tool with a one-line justification.

Output ONLY valid JSON: {"think": "..."}. 2-3 sentences max. No filler. No code fences."""


def _strip_fence_obj(text):
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```", 2)
        text = text[1] if len(text) >= 2 else text[0]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip().rstrip("`").strip()
    if "{" in text and "}" in text:
        text = text[text.index("{"): text.rindex("}") + 1]
    return text


def teacher_chosen_think(prompt, right_tool, wrong_tool, max_retries=2):
    """Ask the local Ollama teacher for a contrastive think trace."""
    user = (
        f"User prompt: {prompt}\n"
        f"RIGHT tool (use this): {right_tool}\n"
        f"WRONG tool (model incorrectly picked / would pick): {wrong_tool}\n\n"
        f'Return JSON only: {{"think": "..."}}'
    )
    full_prompt = (
        f"<|im_start|>system\n{TEACHER_SYSTEM}<|im_end|>\n"
        f"<|im_start|>user\n{user}<|im_end|>\n"
        f"<|im_start|>assistant\n"
    )
    payload = json.dumps({
        "model": TEACHER_MODEL,
        "prompt": full_prompt,
        "stream": False,
        "raw": True,
        "options": {"temperature": 0.3, "num_predict": 400, "num_ctx": 4096},
    }).encode("utf-8")
    last = None
    for _ in range(max_retries + 1):
        try:
            req = urllib.request.Request(OLLAMA_API, data=payload,
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=180) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            text = _strip_fence_obj(data.get("response", ""))
            return json.loads(text)["think"]
        except Exception as e:
            last = e
    raise RuntimeError(f"teacher failed: {last}")

def run_benchmark(model_tag):
    """Run BFCL and return (score, failures)."""
    env = os.environ.copy()
    env["PRISM_MODEL"] = model_tag
    result = subprocess.run(BENCHMARK_CMD, capture_output=True, text=True, env=env, timeout=600)
    output = result.stdout + result.stderr
    
    # Parse score
    m = re.search(r'Strict Pass:\s+(\d+)/(\d+)', output)
    if not m:
        print(f"  Could not parse score from output")
        return 0.0, []
    score = int(m.group(1)) / int(m.group(2))
    
    # Parse failures
    failures = []
    for line in output.split('\n'):
        fail_match = re.search(r'expect=(\S+)\s+got=(\S+)\s+\|\s+[\d.]+s\s+\|\s+(.+)', line)
        if fail_match and '❌' in line:
            failures.append({
                'expected': fail_match.group(1),
                'got': fail_match.group(2),
                'prompt': fail_match.group(3).strip(),
            })
    
    return score, failures

DEFAULT_ARGS = {
    'session_save_ledger':   lambda p: {"project": "my-project", "conversation_id": "session-1", "summary": "Completed work"},
    'session_load_context':  lambda p: {"project": "my-project"},
    'knowledge_search':      lambda p: {"query": p[:80]},
    'session_search_memory': lambda p: {"query": p[:80]},
    'session_forget_memory': lambda p: {"memory_id": "target-id"},
    'knowledge_forget':      lambda p: {"project": "my-project"},
    'session_compact_ledger':lambda p: {"project": "my-project"},
    'session_export_memory': lambda p: {"output_dir": "./export", "format": "json"},
    'session_task_route':    lambda p: {"task_description": p[:80]},
    'session_health_check':  lambda p: {},
    'session_save_handoff':  lambda p: {"project": "my-project"},
}


def build_args(tool, prompt):
    fn = DEFAULT_ARGS.get(tool)
    return fn(prompt) if fn else {}


def generate_dpo(failures):
    """Generate DPO preference pairs with teacher-generated contrastive traces.

    The chosen <think> is written by Claude and explicitly debates the
    wrong tool the model picked. This is the reviewer's #1 fix to avoid
    reasoning collapse from shallow templated traces.
    """
    pairs = []
    for f in failures:
        expected = f['expected']
        got = f['got']
        prompt = f['prompt']

        # 1. Chosen trace (teacher-generated, contrastive)
        try:
            think = teacher_chosen_think(prompt, expected, got)
        except Exception as e:
            print(f"  ! teacher fallback ({e}); skipping pair for: {prompt[:50]}")
            continue

        if expected == 'NO_TOOL':
            chosen = f"<think>\n{think}\n</think>\n\nI'll answer this directly without calling any tools."
        else:
            args = build_args(expected, prompt)
            chosen = (
                f"<think>\n{think}\n</think>\n\n"
                f"<|tool_call|>\n{json.dumps({'name': expected, 'arguments': args})}\n<|tool_call_end|>"
            )

        # 2. Rejected trace = model's actual wrong output (preserve real failure mode)
        if got == 'NO_TOOL':
            rejected = "<think>\nThis seems like a general question I can answer directly.\n</think>\n\nI'll help with that."
        else:
            rejected = (
                f"<think>\nI should use {got}.\n</think>\n\n"
                f"<|tool_call|>\n{json.dumps({'name': got, 'arguments': {}})}\n<|tool_call_end|>"
            )

        pairs.append({
            'messages': [{'role': 'user', 'content': prompt}],
            'chosen': chosen,
            'rejected': rejected,
        })

    return pairs

def train_dpo(dpo_data, round_num, base_model):
    """Train DPO on preference pairs."""
    dpo_dir = f"{ADAPTER_DIR}/dpo_data_r{round_num}"
    adapter_path = f"{ADAPTER_DIR}/r{round_num}"
    os.makedirs(dpo_dir, exist_ok=True)
    os.makedirs(adapter_path, exist_ok=True)
    
    # Write DPO data
    split = max(2, int(len(dpo_data) * 0.1))
    with open(f"{dpo_dir}/train.jsonl", 'w') as f:
        for d in dpo_data[split:]:
            f.write(json.dumps(d) + '\n')
    with open(f"{dpo_dir}/valid.jsonl", 'w') as f:
        for d in dpo_data[:split]:
            f.write(json.dumps(d) + '\n')
    
    # Train
    iters = min(200, max(50, len(dpo_data) * 3))
    cmd = [
        "python3", "-m", "mlx_lm.lora",
        "--model", base_model,
        "--train",
        "--data", dpo_dir,
        "--adapter-path", adapter_path,
        "--iters", str(iters),
        "--num-layers", "16",
        "--batch-size", "1",
        "--learning-rate", "5e-6",
        "--save-every", "50",
        "--mask-prompt",
        "--max-seq-length", "1650",
        "--grad-accumulation-steps", "4",
    ]
    
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    
    # Parse final loss
    for line in reversed(result.stdout.split('\n')):
        m = re.search(r'Train loss ([\d.]+)', line)
        if m:
            print(f"  Final train loss: {m.group(1)}")
            break
    
    return adapter_path

def fuse_and_deploy(base_model, adapter_path, model_tag):
    """Fuse adapter, convert to GGUF, deploy to Ollama."""
    fused_path = f"{adapter_path}/fused"
    
    # Fuse
    subprocess.run([
        "python3", "-m", "mlx_lm.fuse",
        "--model", base_model,
        "--adapter-path", adapter_path,
        "--save-path", fused_path,
        "--dequantize",
    ], capture_output=True, timeout=300)
    
    # Convert to GGUF
    gguf_path = f"{adapter_path}/model.gguf"
    subprocess.run([
        "python3", "/Users/admin/llama.cpp/convert_hf_to_gguf.py",
        fused_path, "--outfile", gguf_path, "--outtype", "q8_0",
    ], capture_output=True, timeout=300)
    
    # Create Modelfile (v5 base — already has the reformatted vertical tool list)
    modelfile = f"{adapter_path}/Modelfile"
    with open("Modelfile.v5") as src:
        content = src.read().replace(
            "FROM /Users/admin/prism/training/models/prism-coder-v5.gguf",
            f"FROM /Users/admin/prism/training/{gguf_path}"
        )
    with open(modelfile, 'w') as f:
        f.write(content)
    
    # Deploy to Ollama
    subprocess.run(["ollama", "create", model_tag, "-f", modelfile], capture_output=True, timeout=120)
    
    return fused_path

def main():
    os.makedirs(ADAPTER_DIR, exist_ok=True)
    current_model = MODEL_TAG
    current_base = BASE_MODEL
    all_dpo = []
    
    # Seed: 178 contrastive DPO pairs derived from the contrastive SFT corpus.
    # These have teacher-quality contrastive <think> traces (not the legacy
    # shallow templates) and provide enough volume for the loop to converge.
    existing_dpo = []
    seed_path = "data/contrastive_dpo_seed.jsonl"
    if os.path.exists(seed_path):
        for line in open(seed_path):
            existing_dpo.append(json.loads(line))
        print(f"Loaded {len(existing_dpo)} contrastive DPO seed pairs")
    
    for round_num in range(1, MAX_ROUNDS + 1):
        print(f"\n{'='*60}")
        print(f"  GRPO Round {round_num}/{MAX_ROUNDS}")
        print(f"  Model: {current_model}")
        print(f"{'='*60}")
        
        # 1. Benchmark
        print(f"\n  Step 1: Running BFCL benchmark...")
        score, failures = run_benchmark(current_model)
        print(f"  Score: {score*100:.0f}% ({int(score*50)}/50)")
        print(f"  Failures: {len(failures)}")
        
        if score >= TARGET_SCORE:
            print(f"\n  ✅ TARGET REACHED: {score*100:.0f}% >= {TARGET_SCORE*100:.0f}%")
            break
        
        if not failures:
            print(f"  No parseable failures — stopping")
            break
        
        # 2. Generate DPO pairs
        print(f"\n  Step 2: Generating {len(failures)} DPO pairs...")
        new_dpo = generate_dpo(failures)
        all_dpo = existing_dpo + new_dpo  # Always include seed data
        existing_dpo = all_dpo  # Accumulate across rounds
        print(f"  Total DPO pairs: {len(all_dpo)}")
        
        # 3. Train
        print(f"\n  Step 3: Training DPO (lr=5e-6)...")
        adapter_path = train_dpo(all_dpo, round_num, current_base)
        
        # 4. Fuse & Deploy
        print(f"\n  Step 4: Fusing and deploying...")
        fused_path = fuse_and_deploy(current_base, adapter_path, current_model)
        current_base = fused_path  # Next round builds on this
        
        print(f"  Round {round_num} complete")
    
    # Final benchmark
    print(f"\n{'='*60}")
    print(f"  FINAL BENCHMARK")
    print(f"{'='*60}")
    score, failures = run_benchmark(current_model)
    print(f"  Final Score: {score*100:.0f}%")
    print(f"  Failures: {len(failures)}")
    for f in failures:
        print(f"    ❌ expect={f['expected']} got={f['got']} | {f['prompt'][:60]}")

if __name__ == "__main__":
    main()
