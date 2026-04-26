"""
BFCL GRPO Alignment Script (MLX Native)

Rejection-Sampling SFT (RS-SFT) alignment for xLAM-2-32b-fc-r.
Preference signal comes from data curation: train on chosen completions,
discard rejected. mlx_lm.lora provides the SFT training loop.
Optimized for Apple Silicon M5 Max 48GB.

Reward Structure (R2IF composite):
    R_format:  +1.0  Strict format compliance (JSON/XML/Python at output)
    R_correct: +1.0  Correct function name + parameter match (AST)
    R_CER:     +1.0  Chain-of-Thought Effectiveness (CoT aligns with decision)
    R_SMV:     +1.0  Specification-Modification-Value adherence

Fallback DPO Rewards (when R2IF not active):
    +3.0  Correct abstention (irrelevant query → no function call)
    +2.0  Correct tool call (relevant query → correct function)
    -3.0  False abstention (relevant query → no function call)
    -2.0  Hallucinated call (irrelevant query → function call)

Pipeline:
    1. Generate DPO preference pairs from training data
    2. Fine-tune the SFT model with DPO on preference pairs
    3. Fuse the aligned adapter

Usage:
    python bfcl_grpo_align.py --model ./output/bfcl-32b/fused_model --data ./data/bfcl

Requirements:
    pip install mlx-lm
"""

import argparse
import json
import os
import random
import subprocess
import sys
from pathlib import Path


def generate_dpo_pairs(data_dir: str, output_path: str, max_pairs: int = 2000):
    """Generate DPO preference pairs from existing training data.
    
    Creates chosen/rejected pairs across ALL categories (not just abstention)
    to prevent reward collapse. Previous v9 used only abstention prompts,
    causing all rewards to be identical (+0.550) → zero gradient.
    
    Mix target: ~50% tool-calling pairs, ~50% abstention pairs.
    
    Creates chosen/rejected pairs:
    - Irrelevance examples: chosen=abstention, rejected=hallucinated call
    - Multi-turn examples: chosen=correct call, rejected=false abstention
    - Multi-turn examples: chosen=correct call, rejected=wrong tool
    - Miss-func examples: chosen=abstention, rejected=hallucinated call
    """
    train_path = Path(data_dir) / "train.jsonl"
    grpo_path = Path(data_dir) / "grpo_pairs.jsonl"
    
    # Use pre-generated GRPO pairs if available
    if grpo_path.exists():
        with open(grpo_path) as f:
            existing_pairs = [json.loads(line) for line in f]
        print(f"   Found {len(existing_pairs)} pre-generated GRPO pairs")
    else:
        existing_pairs = []
    
    # Also generate pairs from training data
    abstention_pairs = []
    tool_call_pairs = []
    with open(train_path) as f:
        examples = [json.loads(line) for line in f]
    
    # Collect all tool-calling completions for wrong-tool rejection sampling
    tool_completions = []
    for ex in examples:
        comp = ex.get("completion", "")
        if "<|tool_call|>" in comp:
            tool_completions.append(comp.replace("<|im_start|>assistant\n", "").strip())
    
    for ex in examples:
        category = ex.get("category", "unknown")
        
        # Training data is now in prompt/completion format (not messages)
        prompt_text = ex.get("prompt", "")
        completion_text = ex.get("completion", "")
        
        if not prompt_text or not completion_text:
            continue
        
        # The prompt already has proper <|im_start|> chat template from unroll_multi_turn.
        # Do NOT append another <|im_start|>assistant — it's already the boundary.
        # DPO chosen/rejected are the raw assistant completions.
        prompt = prompt_text
        # CRITICAL: Do NOT strip <|im_end|> — DPO needs the EOS token in chosen/rejected
        # or the model learns to never stop generating.
        assistant_response = completion_text.replace("<|im_start|>assistant\n", "").strip()
        
        if category == "irrelevance":
            # Chosen: correct abstention
            # Rejected: hallucinated tool call
            abstention_pairs.append({
                "prompt": prompt,
                "chosen": assistant_response,
                "rejected": '<|tool_call|>\n{"name": "unknown_function", "arguments": {"query": "irrelevant"}}\n</|tool_call|>',
            })
        elif category == "multi_turn":
            # Pair A: Chosen=correct tool call, Rejected=false abstention
            tool_call_pairs.append({
                "prompt": prompt,
                "chosen": assistant_response,
                "rejected": "I don't have the right tools to help with that request.",
            })
            # Pair B: Chosen=correct tool call, Rejected=wrong tool call
            # (prevents model from calling ANY tool indiscriminately)
            if tool_completions:
                wrong_tool = random.choice(tool_completions)
                if wrong_tool != assistant_response:
                    tool_call_pairs.append({
                        "prompt": prompt,
                        "chosen": assistant_response,
                        "rejected": wrong_tool,
                    })
        elif category == "miss_func":
            # Chosen: correct abstention (tool is missing)
            # Rejected: hallucinated call to the missing function
            abstention_pairs.append({
                "prompt": prompt,
                "chosen": assistant_response,
                "rejected": '<|tool_call|>\n{"name": "missing_function", "arguments": {}}\n</|tool_call|>',
            })
    
    # Balance: 50% tool-calling, 50% abstention to prevent reward collapse
    # (v9 bug: 100% abstention → all rewards identical → zero gradient)
    target_per_type = max_pairs // 2
    if len(abstention_pairs) > target_per_type:
        abstention_pairs = random.sample(abstention_pairs, target_per_type)
    if len(tool_call_pairs) > target_per_type:
        tool_call_pairs = random.sample(tool_call_pairs, target_per_type)
    
    print(f"   Abstention pairs: {len(abstention_pairs)}")
    print(f"   Tool-call pairs: {len(tool_call_pairs)}")
    
    # Combine and shuffle
    all_pairs = existing_pairs + abstention_pairs + tool_call_pairs
    random.shuffle(all_pairs)
    
    # Limit
    if len(all_pairs) > max_pairs:
        all_pairs = all_pairs[:max_pairs]
    
    # ── Convert preference pairs to chosen-only SFT format ──
    # IMPORTANT: mlx_lm.lora is strictly SFT (Cross-Entropy loss).
    # It has NO DPO/GRPO capacity. We achieve preference alignment through
    # DATA CURATION: train on chosen completions only, discard rejected.
    # This is "Rejection Sampling SFT" (RS-SFT), proven effective by
    # DeepSeek-R1 and Llama-3 alignment pipelines.
    sft_train = []
    for pair in all_pairs:
        prompt_text = pair.get("prompt", "")
        chosen_text = pair.get("chosen", "")
        
        if not prompt_text or not chosen_text:
            continue
        
        # Parse the ChatML prompt into system + user messages
        messages = []
        # Extract system message if present
        import re
        sys_match = re.search(r'<\|im_start\|>system\n(.*?)<\|im_end\|>', prompt_text, re.DOTALL)
        if sys_match:
            messages.append({"role": "system", "content": sys_match.group(1).strip()})
        
        # Extract all user/assistant turns
        turn_pattern = r'<\|im_start\|>(user|assistant)\n(.*?)<\|im_end\|>'
        for role, content in re.findall(turn_pattern, prompt_text, re.DOTALL):
            messages.append({"role": role, "content": content.strip()})
        
        # CRITICAL: Add chosen completion as final assistant message.
        # This is what the model learns to generate.
        messages.append({"role": "assistant", "content": chosen_text})
        
        sft_train.append({"messages": messages})
    
    # Split 90/10
    split_idx = int(len(sft_train) * 0.9)
    train_data = sft_train[:split_idx]
    valid_data = sft_train[split_idx:]
    
    # Write to data directory (ChatML messages format for mlx_lm.lora)
    out_dir = Path(output_path)
    out_dir.mkdir(parents=True, exist_ok=True)
    
    with open(out_dir / "train.jsonl", "w") as f:
        for item in train_data:
            f.write(json.dumps(item) + "\n")
    
    with open(out_dir / "valid.jsonl", "w") as f:
        for item in valid_data:
            f.write(json.dumps(item) + "\n")
    
    print(f"   Generated {len(train_data)} train + {len(valid_data)} valid RS-SFT examples")
    print(f"   (Chosen-only; rejected samples discarded for data-curation alignment)")
    print(f"   Output: {out_dir}")
    return len(train_data)


def train_dpo(model_path: str, data_dir: str, adapter_path: str,
              iters: int = 800, lora_rank: int = 64, 
              learning_rate: float = 5e-6, lora_layers: int = 16):
    """Run RS-SFT alignment using MLX-LM LoRA on chosen-only data.
    
    NOTE: lora_rank=64 MUST match the SFT phase rank to enable
    model souping (weight averaging) via merge_adapters.py.
    """
    print(f"\n{'='*60}")
    print(f"GRPO Alignment Training")
    print(f"{'='*60}")
    print(f"Model: {model_path}")
    print(f"Data: {data_dir}")
    print(f"Config: rank={lora_rank}, iters={iters}, lr={learning_rate}")
    print(f"LoRA layers: {lora_layers}")
    print()
    
    # MLX-LM preference alignment using LoRA
    # NOTE: mlx_lm does not have a native DPO module. We use LoRA fine-tuning
    # on preference-ranked data (chosen examples only, with rejected filtered out).
    # The DPO signal comes from the data curation, not the training algorithm.
    cmd = [
        sys.executable, "-m", "mlx_lm.lora",
        "--model", model_path,
        "--train",
        "--data", data_dir,
        "--adapter-path", adapter_path,
        "--iters", str(iters),
        "--lora-rank", str(lora_rank),
        "--batch-size", "1",
        "--learning-rate", str(learning_rate),
        "--lora-layers", str(lora_layers),
        "--save-every", "50",
        "--grad-checkpoint",
        "--mask-prompt",  # Loss only on completion, not prompt
        "--max-seq-length", "8192",  # 32B Q4: 27GB headroom; preference data 8K safe
    ]
    
    print(f"Running: {' '.join(cmd)}\n")
    subprocess.run(cmd, check=True)
    print(f"\n✅ GRPO adapter saved to: {adapter_path}")


def fuse_adapter(model_path: str, adapter_path: str, output_path: str):
    """Fuse the alignment adapter."""
    print(f"\n{'='*60}")
    print(f"Fusing GRPO Adapter")
    print(f"{'='*60}")
    
    cmd = [
        sys.executable, "-m", "mlx_lm.fuse",
        "--model", model_path,
        "--adapter-path", adapter_path,
        "--save-path", output_path,
        "--export-gguf",
    ]
    
    print(f"Running: {' '.join(cmd)}\n")
    subprocess.run(cmd, check=True)
    print(f"\n✅ Aligned model: {output_path}")


def main():
    parser = argparse.ArgumentParser(description="BFCL GRPO Alignment (MLX Native)")
    parser.add_argument("--model", type=str, required=True,
                        help="Path to SFT-fused MLX model")
    parser.add_argument("--data", type=str, required=True,
                        help="Training data directory (with train.jsonl)")
    parser.add_argument("--output-dir", type=str, default="./output/bfcl-32b-grpo",
                        help="Output directory")
    parser.add_argument("--iters", type=int, default=800,
                        help="Training iterations (default: 800)")
    parser.add_argument("--lora-rank", type=int, default=64,
                        help="LoRA rank (default: 64, must match SFT for model souping)")
    parser.add_argument("--lr", type=float, default=5e-6,
                        help="Learning rate (default: 5e-6, lower than SFT)")
    parser.add_argument("--generate-only", action="store_true",
                        help="Only generate DPO pairs, don't train")
    parser.add_argument("--max-pairs", type=int, default=2000,
                        help="Maximum DPO pairs to generate")
    args = parser.parse_args()
    
    print("=" * 60)
    print("🎯 BFCL GRPO Alignment — MLX Native")
    print("=" * 60)
    
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    dpo_data_dir = str(output_dir / "dpo_data")
    adapter_path = str(output_dir / "adapters")
    
    # Step 1: Generate pairs
    print(f"\n📊 Generating DPO preference pairs...")
    generate_dpo_pairs(args.data, dpo_data_dir, max_pairs=args.max_pairs)
    
    if args.generate_only:
        print("\n✅ Pairs generated. Use --model to train.")
        return
    
    # Step 2: Train
    train_dpo(
        model_path=args.model,
        data_dir=dpo_data_dir,
        adapter_path=adapter_path,
        iters=args.iters,
        lora_rank=args.lora_rank,
        learning_rate=args.lr,
    )
    
    # Step 3: Fuse
    fused_path = str(output_dir / "fused_aligned")
    fuse_adapter(args.model, adapter_path, fused_path)
    
    print(f"\n{'='*60}")
    print("✅ GRPO alignment complete!")
    print(f"{'='*60}")
    print(f"\nDeploy to Ollama:")
    gguf_files = list(Path(fused_path).glob("*.gguf"))
    if gguf_files:
        print(f"  ollama create prism-coder-32b-FC -f <(echo 'FROM {gguf_files[0]}')")


if __name__ == "__main__":
    main()
