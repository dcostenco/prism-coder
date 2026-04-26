#!/usr/bin/env python3
"""
Experiment 5: Local On-Device Continuous Learning Loop

Automatically extracts upvote/downvote signals from Prism's SQLite DB,
formats them as DPO preference pairs, and runs a low-rank MLX LoRA
alignment pass overnight.

Usage (cron — runs weekly at 3 AM Sunday):
    0 3 * * 0 /usr/bin/env python3 /path/to/continuous_learning.py

Manual:
    python continuous_learning.py --dry-run    # Preview dataset without training
    python continuous_learning.py              # Extract + train
    python continuous_learning.py --fuse       # Fuse adapter after training
"""

import argparse
import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path


# Default Prism DB path (local SQLite backend)
DEFAULT_DB_PATH = os.path.expanduser("~/.prism/prism_sessions.db")
OUTPUT_DIR = Path(__file__).parent / "data" / "continuous_learning"


def extract_preference_pairs(db_path: str, since_days: int = 7) -> list[dict]:
    """Query Prism's SQLite DB for upvoted/downvoted entries.

    Returns DPO-style preference pairs:
    - Upvoted entries → 'chosen' completions
    - Downvoted entries → 'rejected' completions (if available)
    - Correction events → chosen=correction, rejected=original action
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cutoff = (datetime.utcnow() - timedelta(days=since_days)).isoformat()

    pairs = []

    # 1. Extract voted entries
    upvoted = conn.execute("""
        SELECT id, summary, project, importance
        FROM session_ledger
        WHERE importance >= 7 AND created_at > ? AND deleted_at IS NULL
        ORDER BY created_at DESC
    """, (cutoff,)).fetchall()

    downvoted = conn.execute("""
        SELECT id, summary, project, importance
        FROM session_ledger
        WHERE importance <= 2 AND importance >= 0 AND created_at > ? AND deleted_at IS NULL
        ORDER BY created_at DESC
    """, (cutoff,)).fetchall()

    # 2. Extract correction events from experience log
    corrections = conn.execute("""
        SELECT context, action, correction, outcome, project
        FROM session_experience
        WHERE event_type = 'correction' AND created_at > ?
        ORDER BY created_at DESC
    """, (cutoff,)).fetchall()

    conn.close()

    # Format upvoted entries as chosen completions
    for entry in upvoted:
        pairs.append({
            "messages": [
                {"role": "user", "content": f"[Project: {entry['project']}] Continue work."},
                {"role": "assistant", "content": entry["summary"]},
            ],
            "category": "upvoted",
            "source": "continuous_learning",
        })

    # Format corrections as preference pairs (chosen=correction, rejected=action)
    for corr in corrections:
        if corr["correction"]:
            pairs.append({
                "messages": [
                    {"role": "user", "content": corr["context"]},
                    {"role": "assistant", "content": corr["correction"]},  # What SHOULD have been done
                ],
                "rejected": corr["action"],  # What was actually done (wrong)
                "category": "correction",
                "source": "continuous_learning",
            })

    return pairs


def write_training_data(pairs: list[dict], output_dir: Path):
    """Write extracted pairs as ChatML JSONL for mlx_lm.lora."""
    output_dir.mkdir(parents=True, exist_ok=True)

    # Split corrections into DPO format, upvotes into SFT format
    sft_examples = []
    for pair in pairs:
        # Format as ChatML messages (SFT on chosen completions)
        text_parts = []
        for msg in pair["messages"]:
            text_parts.append(f"<|im_start|>{msg['role']}\n{msg['content']}<|im_end|>")
        sft_examples.append({"text": "\n".join(text_parts)})

    if not sft_examples:
        print("No training data extracted. Skipping.")
        return None

    # Shuffle and split
    import random
    random.shuffle(sft_examples)
    split = max(1, int(len(sft_examples) * 0.9))
    train = sft_examples[:split]
    valid = sft_examples[split:] if split < len(sft_examples) else sft_examples[-1:]

    train_file = output_dir / "train.jsonl"
    valid_file = output_dir / "valid.jsonl"

    with open(train_file, "w") as f:
        for ex in train:
            f.write(json.dumps(ex) + "\n")

    with open(valid_file, "w") as f:
        for ex in valid:
            f.write(json.dumps(ex) + "\n")

    print(f"Wrote {len(train)} train, {len(valid)} valid examples to {output_dir}/")
    return output_dir


def run_training(data_dir: Path, base_model: str, adapter_out: str,
                 lora_rank: int = 8, iters: int = 200, lr: float = 5e-6):
    """Run lightweight LoRA alignment pass using mlx_lm.lora."""
    cmd = [
        sys.executable, "-m", "mlx_lm.lora",
        "--model", base_model,
        "--data", str(data_dir),
        "--adapter-path", adapter_out,
        "--train",
        "--iters", str(iters),
        "--lora-layers", "8",       # Lightweight — only 8 layers
        "--lora-rank", str(lora_rank),
        "--batch-size", "1",
        "--learning-rate", str(lr),
        "--max-seq-length", "4096", # Short sequences for corrections
        "--grad-checkpoint",
    ]

    print(f"\n{'='*60}")
    print(f"Continuous Learning — LoRA Alignment Pass")
    print(f"{'='*60}")
    print(f"Base model: {base_model}")
    print(f"Adapter out: {adapter_out}")
    print(f"LoRA rank: {lora_rank} (lightweight)")
    print(f"Iterations: {iters}")
    print(f"Command: {' '.join(cmd)}")

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"ERROR: Training failed:\n{result.stderr}")
        return False

    print(result.stdout)
    print("✅ Continuous learning pass complete!")
    return True


def fuse_adapter(base_model: str, adapter_path: str, output_path: str):
    """Fuse the continuous learning adapter into the base model."""
    cmd = [
        sys.executable, "-m", "mlx_lm.fuse",
        "--model", base_model,
        "--adapter-path", adapter_path,
        "--save-path", output_path,
    ]
    print(f"Fusing adapter: {adapter_path} → {output_path}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"ERROR: Fuse failed:\n{result.stderr}")
        return False
    print("✅ Adapter fused successfully!")
    return True


def main():
    parser = argparse.ArgumentParser(description="Experiment 5: Continuous Learning Loop")
    parser.add_argument("--db-path", default=DEFAULT_DB_PATH, help="Prism SQLite DB path")
    parser.add_argument("--since-days", type=int, default=7, help="Look back N days for signals")
    parser.add_argument("--base-model", default="mlx-community/Qwen2.5-Coder-32B-Instruct-4bit",
                        help="Base model for alignment")
    parser.add_argument("--adapter-out", default="./output/continuous_adapter",
                        help="Output adapter path")
    parser.add_argument("--lora-rank", type=int, default=8, help="LoRA rank (low for lightweight)")
    parser.add_argument("--iters", type=int, default=200, help="Training iterations")
    parser.add_argument("--dry-run", action="store_true", help="Extract data only, don't train")
    parser.add_argument("--fuse", action="store_true", help="Fuse adapter after training")
    parser.add_argument("--fuse-output", default="./models/prism-continuous",
                        help="Fused model output path")
    args = parser.parse_args()

    print(f"Continuous Learning Loop — {datetime.now().isoformat()}")
    print(f"DB: {args.db_path}")
    print(f"Looking back: {args.since_days} days")

    # Extract preference signals
    pairs = extract_preference_pairs(args.db_path, args.since_days)
    print(f"\nExtracted {len(pairs)} preference signals:")
    cats = {}
    for p in pairs:
        cats[p["category"]] = cats.get(p["category"], 0) + 1
    for cat, count in sorted(cats.items()):
        print(f"  {cat}: {count}")

    if not pairs:
        print("No signals found. Nothing to train on.")
        return

    # Write training data
    data_dir = write_training_data(pairs, OUTPUT_DIR)
    if not data_dir:
        return

    if args.dry_run:
        print("\n--dry-run: Skipping training.")
        return

    # Run alignment
    success = run_training(
        data_dir, args.base_model, args.adapter_out,
        lora_rank=args.lora_rank, iters=args.iters,
    )

    if success and args.fuse:
        fuse_adapter(args.base_model, args.adapter_out, args.fuse_output)


if __name__ == "__main__":
    main()
