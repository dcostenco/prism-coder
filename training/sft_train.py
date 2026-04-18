#!/usr/bin/env python3
"""
SFT LoRA fine-tuning on Prism reasoning traces using MLX.
Trains on session_save, session_search, knowledge_save, etc. patterns.
"""
import subprocess
import sys
import os

MODEL_PATH = "/Users/admin/prism/training/models/qwen-7b-mlx"
TRAIN_DATA = "/Users/admin/prism/training/data/sft_dataset.jsonl"
VALID_DATA = "/Users/admin/prism/training/data/sft_valid.jsonl"
OUTPUT_ADAPTER = "/Users/admin/prism/training/models/prism-sft-lora"

def main():
    if not os.path.exists(MODEL_PATH):
        print("ERROR: Base model not found. Run model download first.")
        sys.exit(1)

    if not os.path.exists(TRAIN_DATA):
        print("ERROR: Training data not found. Run extract_traces.py first.")
        sys.exit(1)

    print(f"Starting SFT LoRA training...")
    print(f"  Base model: {MODEL_PATH}")
    print(f"  Train data: {TRAIN_DATA} ({sum(1 for _ in open(TRAIN_DATA))} examples)")
    print(f"  Valid data: {VALID_DATA} ({sum(1 for _ in open(VALID_DATA))} examples)")
    print(f"  Output: {OUTPUT_ADAPTER}")
    print()

    cmd = [
        sys.executable, "-m", "mlx_lm.lora",
        "--model", MODEL_PATH,
        "--train",
        "--data", os.path.dirname(TRAIN_DATA),
        "--adapter-path", OUTPUT_ADAPTER,
        "--num-layers", "16",
        "--batch-size", "1",
        "--iters", "1000",
        "--val-batches", "2",
        "--learning-rate", "2e-5",
        "--steps-per-report", "50",
        "--steps-per-eval", "200",
        "--save-every", "200",
        "--max-seq-length", "1024",
    ]

    print(f"Command: {' '.join(cmd)}")
    print("=" * 60)

    result = subprocess.run(cmd, cwd="/Users/admin/prism/training")
    if result.returncode != 0:
        print(f"Training failed with exit code {result.returncode}")
        sys.exit(1)

    print("\n" + "=" * 60)
    print(f"SFT LoRA training complete!")
    print(f"Adapter saved to: {OUTPUT_ADAPTER}")


if __name__ == "__main__":
    main()
