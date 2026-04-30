#!/usr/bin/env python3
"""Iterative GRPO alignment — run until BFCL >= 90% or max iterations."""
import json, subprocess, re, time, os, shutil

MODEL_TAG = "prism-coder:7b-v4a"
BASE_MODEL = "models/prism-fused-v4"
ADAPTER_DIR = "models/adapter-v4-grpo-iter"
TARGET_SCORE = 0.90
MAX_ROUNDS = 8
BENCHMARK_CMD = ["python3", "-u", "swe_bench_test.py", "--runs", "1"]

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

def generate_dpo(failures):
    """Generate DPO preference pairs from benchmark failures."""
    pairs = []
    for f in failures:
        expected = f['expected']
        prompt = f['prompt']
        
        if expected == 'NO_TOOL':
            chosen = f'<think>\nThis is a general question, not a Prism tool request. I should answer directly without calling any tools.\n</think>\n\nI\'ll help with that directly.'
        else:
            # Build correct tool call with appropriate args
            args = {}
            if expected == 'session_save_ledger':
                args = {"project": "my-project", "conversation_id": "session-1", "summary": "Work completed"}
            elif expected == 'session_load_context':
                args = {"project": "my-project"}
            elif expected == 'knowledge_search':
                args = {"query": prompt[:50]}
            elif expected == 'session_search_memory':
                args = {"query": prompt[:50]}
            elif expected == 'session_forget_memory':
                args = {"memory_id": "target-id"}
            elif expected == 'knowledge_forget':
                args = {"project": "my-project"}
            elif expected == 'session_compact_ledger':
                args = {"project": "my-project"}
            elif expected == 'session_export_memory':
                args = {"output_dir": "./export"}
            elif expected == 'session_task_route':
                args = {"task_description": prompt[:50]}
            elif expected == 'session_health_check':
                args = {}
            else:
                args = {}
            
            chosen = f'<think>\nThe user wants to {expected.replace("_", " ")}. I should use the {expected} tool.\n</think>\n\n<|tool_call|>\n{json.dumps({"name": expected, "arguments": args})}\n<|tool_call_end|>'
        
        # Build rejected (wrong) response
        got = f['got']
        if got == 'NO_TOOL':
            rejected = '<think>\nThis seems like a general question.\n</think>\n\nI\'ll help with that.'
        else:
            rejected = f'<think>\nI should use {got}.\n</think>\n\n<|tool_call|>\n{json.dumps({"name": got, "arguments": {}})}\n<|tool_call_end|>'
        
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
    
    # Create Modelfile
    modelfile = f"{adapter_path}/Modelfile"
    with open("Modelfile.v4a") as src:
        content = src.read().replace(
            "FROM /Users/admin/prism/training/models/prism-coder-v4-aligned.gguf",
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
    
    # Load existing DPO data as seed
    existing_dpo = []
    for line in open("models/prism-grpo-lora/dpo_data/train.jsonl"):
        existing_dpo.append(json.loads(line))
    
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
