"""
BFCL QLoRA Fine-Tuning Script (MLX Native)

Fine-tunes xLAM-2-32b-fc-r for BFCL V4 #1 ranking using MLX-LM's LoRA/QLoRA.
Optimized for Apple Silicon M5 Max 48GB.

Base model: Salesforce/xLAM-2-32b-fc-r
  - Pre-trained on verified agentic data (APIGen-MT, NeurIPS 2025)
  - 75.83% BFCL v3 out of the box
  - 32B Q4 → ~17GB model weight (27GB activation headroom on 48GB)

MLX-LM handles 4-bit quantized training natively on Apple Silicon —
no bitsandbytes or CUDA required.

Pipeline:
    1. Convert HF model to MLX format with 4-bit quantization
    2. LoRA fine-tune on BFCL training data
    3. Fuse LoRA adapters back into the model
    4. Export to GGUF for Ollama deployment

Usage:
    # Full pipeline (convert + train + fuse)
    python bfcl_qlora_finetune.py --model Salesforce/xLAM-2-32b-fc-r --data ./data/bfcl

    # Train only (if model already converted)
    python bfcl_qlora_finetune.py --mlx-model ./mlx_models/xLAM-2-32b-4bit --data ./data/bfcl --skip-convert

    # Fuse only (after training)
    python bfcl_qlora_finetune.py --mlx-model ./mlx_models/xLAM-2-32b-4bit --fuse-only --adapter-path ./output/bfcl-32b/adapters

Requirements:
    pip install mlx-lm
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def convert_model(hf_model: str, mlx_path: str, q_bits: int = 4):
    """Convert HuggingFace model to MLX format with quantization."""
    print(f"\n{'='*60}")
    print(f"Step 1: Converting {hf_model} to MLX ({q_bits}-bit)")
    print(f"{'='*60}")
    print(f"Output: {mlx_path}")
    print(f"This downloads the model and quantizes to {q_bits}-bit.")
    print(f"For 32B Q4: ~17GB download, ~17GB on disk after quantization.\n")

    cmd = [
        sys.executable, "-m", "mlx_lm", "convert",
        "--hf-path", hf_model,
        "--mlx-path", mlx_path,
        "-q",
        "--q-bits", str(q_bits),
        "--q-group-size", "64",
    ]
    print(f"Running: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)
    print(f"\n✅ Model converted to: {mlx_path}")


def prepare_training_data(data_dir: str):
    """Verify training data is in the correct MLX-LM chat format.
    
    MLX-LM expects JSONL files in data/ directory:
    - train.jsonl: training data
    - valid.jsonl: validation data (optional)
    - test.jsonl: test data (optional)
    
    Format: {"messages": [{"role": "system", "content": "..."}, ...]}
    """
    train_path = Path(data_dir) / "train.jsonl"
    valid_path = Path(data_dir) / "valid.jsonl"
    
    if not train_path.exists():
        print(f"❌ Training data not found: {train_path}")
        print(f"   Run: python generate_bfcl_training_data.py --output-dir {data_dir}")
        sys.exit(1)
    
    # Count examples
    with open(train_path) as f:
        train_count = sum(1 for _ in f)
    
    valid_count = 0
    if valid_path.exists():
        with open(valid_path) as f:
            valid_count = sum(1 for _ in f)
    
    print(f"\n📊 Training data: {train_count} examples")
    print(f"   Validation data: {valid_count} examples")
    
    # Verify format
    with open(train_path) as f:
        first = json.loads(f.readline())
    
    if "messages" not in first:
        print("❌ Training data format error: missing 'messages' key")
        print("   Expected: {\"messages\": [{\"role\": \"system\", \"content\": \"...\"}, ...]}")
        sys.exit(1)
    
    print("   Format: ✅ Chat JSONL (MLX-LM native)")
    return train_count


def train_lora(mlx_model: str, data_dir: str, adapter_path: str,
               iters: int = 1500, lora_rank: int = 64, 
               batch_size: int = 1, learning_rate: float = 1e-5,
               lora_layers: int = 24, grad_checkpoint: bool = True,
               neftune_alpha: float = 0.0):
    """Run MLX-LM LoRA fine-tuning.
    
    R5-7: NEFTune noise embedding support via --neftune-noise-alpha.
    If MLX-LM version doesn't support it, the flag is silently ignored.
    """
    print(f"\n{'='*60}")
    print(f"Step 2: LoRA Fine-Tuning")
    print(f"{'='*60}")
    print(f"Model: {mlx_model}")
    print(f"Data: {data_dir}")
    print(f"Adapter output: {adapter_path}")
    print(f"Config: rank={lora_rank}, iters={iters}, lr={learning_rate}")
    print(f"Batch size: {batch_size}, LoRA layers: {lora_layers}")
    print(f"Gradient checkpointing: {grad_checkpoint}")
    if neftune_alpha > 0:
        print(f"NEFTune alpha: {neftune_alpha}")
    print()

    # mlx_lm v0.31+ requires LoRA rank/scale via YAML config file
    config_path = os.path.join(os.path.dirname(adapter_path), "lora_config.yaml")
    os.makedirs(os.path.dirname(adapter_path), exist_ok=True)
    with open(config_path, "w") as f:
        f.write(f"lora_parameters:\n")
        f.write(f"  rank: {lora_rank}\n")
        f.write(f"  scale: {2.0 * lora_rank}\n")  # Standard alpha = 2*rank
        f.write(f"  dropout: 0.05\n")

    cmd = [
        sys.executable, "-m", "mlx_lm", "lora",
        "--model", mlx_model,
        "--train",
        "--data", data_dir,
        "--adapter-path", adapter_path,
        "--iters", str(iters),
        "--num-layers", str(lora_layers),
        "--batch-size", str(batch_size),
        "--learning-rate", str(learning_rate),
        "--save-every", "100",
        "--test-batches", "10",
        "--val-batches", "10",
        "--max-seq-length", "4096",  # 32B Q4: 16384 OOMs on 48GB — 4096 fits safely
        "--grad-accumulation-steps", "16",  # Effective batch = 1 × 16 = 16
        "--clear-cache-threshold", "0.5",  # Aggressively free Metal cache to prevent OOM
        "--mask-prompt",  # BalanceSFT: loss only on completion (tool_call JSON), not prompt
        "-c", config_path,
    ]
    
    if grad_checkpoint:
        cmd.append("--grad-checkpoint")
    
    # R5-7: NEFTune noise embedding — improves zero-shot generalization
    if neftune_alpha > 0:
        cmd.extend(["--neftune-noise-alpha", str(neftune_alpha)])
    
    print(f"Running: {' '.join(cmd)}\n")
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as e:
        # R5-7: Graceful fallback if MLX-LM doesn't support NEFTune flag
        stderr_text = (e.stderr or "").lower() if isinstance(e.stderr, str) else ""
        if neftune_alpha > 0 and ("unrecognized" in stderr_text or "neftune" in stderr_text):
            print(f"WARNING: MLX-LM does not support --neftune-noise-alpha. Retrying without it.")
            cmd = [c for c in cmd if c != "--neftune-noise-alpha" and c != str(neftune_alpha)]
            subprocess.run(cmd, check=True)
        else:
            raise
    print(f"\n✅ LoRA adapter saved to: {adapter_path}")


def fuse_adapter(mlx_model: str, adapter_path: str, output_path: str,
                 export_gguf: bool = True):
    """Fuse LoRA adapter back into the model."""
    print(f"\n{'='*60}")
    print(f"Step 3: Fusing LoRA Adapter")
    print(f"{'='*60}")
    print(f"Base model: {mlx_model}")
    print(f"Adapter: {adapter_path}")
    print(f"Output: {output_path}")

    cmd = [
        sys.executable, "-m", "mlx_lm", "fuse",
        "--model", mlx_model,
        "--adapter-path", adapter_path,
        "--save-path", output_path,
    ]
    
    if export_gguf:
        cmd.extend(["--export-gguf"])
    
    print(f"Running: {' '.join(cmd)}\n")
    subprocess.run(cmd, check=True)
    print(f"\n✅ Fused model saved to: {output_path}")
    
    if export_gguf:
        gguf_files = list(Path(output_path).glob("*.gguf"))
        if gguf_files:
            print(f"\n📦 GGUF file for Ollama: {gguf_files[0]}")
            print(f"\nTo deploy with Ollama:")
            print(f"  1. Create Modelfile:")
            print(f"     FROM {gguf_files[0]}")
            print(f"  2. ollama create prism-coder-32b-FC -f Modelfile")
            print(f"  3. ollama run prism-coder-32b-FC")



def main():
    parser = argparse.ArgumentParser(description="BFCL QLoRA Fine-Tuning (MLX Native)")
    
    # Model
    parser.add_argument("--model", type=str, default="Salesforce/xLAM-2-32b-fc-r",
                        help="HuggingFace model ID to convert")
    parser.add_argument("--mlx-model", type=str, default=None,
                        help="Path to already-converted MLX model (skips conversion)")
    
    # Data
    parser.add_argument("--data", type=str, required=True,
                        help="Directory containing train.jsonl / valid.jsonl")
    
    # Training
    parser.add_argument("--iters", type=int, default=1500,
                        help="Training iterations (default: 1500)")
    parser.add_argument("--lora-rank", type=int, default=64,
                        help="LoRA rank (default: 64)")
    parser.add_argument("--lora-layers", type=int, default=24,
                        help="Number of model layers to apply LoRA to (default: 24, 32B fits in 48GB)")
    parser.add_argument("--batch-size", type=int, default=1,
                        help="Batch size (default: 1, combined with grad-accum=16 for effective batch=16)")
    parser.add_argument("--lr", type=float, default=1e-5,
                        help="Learning rate (default: 1e-5)")
    
    # Workflow control
    parser.add_argument("--skip-convert", action="store_true",
                        help="Skip model conversion (use --mlx-model)")
    parser.add_argument("--skip-train", action="store_true",
                        help="Skip training (used with --fuse-only)")
    parser.add_argument("--fuse-only", action="store_true",
                        help="Only fuse adapter")
    parser.add_argument("--no-fuse", action="store_true",
                        help="Skip fusing after training")
    parser.add_argument("--no-gguf", action="store_true",
                        help="Don't export GGUF during fuse")
    
    # Paths
    parser.add_argument("--output-dir", type=str, default="./output/bfcl-32b",
                        help="Output directory")
    parser.add_argument("--adapter-path", type=str, default=None,
                        help="Explicit adapter path (default: {output-dir}/adapters)")
    parser.add_argument("--q-bits", type=int, default=4,
                        help="Quantization bits for conversion (default: 4)")
    
    args = parser.parse_args()
    
    print("=" * 60)
    print("🚀 BFCL QLoRA Fine-Tuning — MLX Native (Apple Silicon)")
    print("=" * 60)
    
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    adapter_path = args.adapter_path or str(output_dir / "adapters")
    
    # Determine MLX model path
    if args.mlx_model:
        mlx_model_path = args.mlx_model
    else:
        # Default: store converted models alongside training output
        model_name = args.model.replace("/", "-")
        mlx_model_path = str(output_dir / f"{model_name}-{args.q_bits}bit")
    
    # Step 1: Convert
    if not args.skip_convert and not args.fuse_only:
        if Path(mlx_model_path).exists():
            print(f"\n⏭️  MLX model already exists at {mlx_model_path}, skipping conversion")
        else:
            convert_model(args.model, mlx_model_path, q_bits=args.q_bits)
    
    # Step 2: Verify data
    if not args.fuse_only and not args.skip_train:
        prepare_training_data(args.data)
    
    # Step 3: Train
    if not args.fuse_only and not args.skip_train:
        train_lora(
            mlx_model=mlx_model_path,
            data_dir=args.data,
            adapter_path=adapter_path,
            iters=args.iters,
            lora_rank=args.lora_rank,
            batch_size=args.batch_size,
            learning_rate=args.lr,
            lora_layers=args.lora_layers,
        )
    
    # Step 4: Fuse
    if not args.no_fuse:
        fused_path = str(output_dir / "fused_model")
        fuse_adapter(
            mlx_model=mlx_model_path,
            adapter_path=adapter_path,
            output_path=fused_path,
            export_gguf=not args.no_gguf,
        )
    
    print(f"\n{'='*60}")
    print("✅ Pipeline complete!")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
