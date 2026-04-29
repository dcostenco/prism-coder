#!/bin/bash
set -e

cd /Users/admin/prism/training

echo "Starting MLX LORA training with matched SFT shapes (Rank 8, Layers 16, Seq 1024)..."
./venv/bin/python3 -m mlx_lm lora \
  --model models/prism-fused \
  --train \
  --data models/prism-grpo-lora/dpo_data \
  --adapter-path models/prism-grpo-lora/adapters \
  --iters 200 \
  --num-layers 16 \
  --batch-size 1 \
  --learning-rate 5e-06 \
  --save-every 50 \
  --grad-checkpoint \
  --mask-prompt \
  --max-seq-length 1650 \
  --grad-accumulation-steps 8 \
  --clear-cache-threshold 0.5 \
  -c models/prism-grpo-lora/lora_config.yaml

echo "GRPO training completed!"

echo "Fusing adapter..."
./venv/bin/python3 -m mlx_lm.fuse \
  --model models/qwen-7b-mlx \
  --adapter-path models/prism-grpo-lora/adapters \
  --save-path models/prism-grpo-lora/fused_aligned \
  --dequantize

echo "Exporting to GGUF and deploying to Ollama..."
./export_gguf.sh

echo "All Done!"