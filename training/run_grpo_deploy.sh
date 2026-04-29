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
./venv/bin/python3 -m mlx_lm fuse \
  --model models/prism-fused \
  --adapter-path models/prism-grpo-lora/adapters \
  --save-path models/prism-grpo-lora/fused_aligned

echo "Exporting to GGUF..."
./export_gguf.sh

echo "Deploying to Ollama..."
GGUF_FILE="/Users/admin/prism/training/models/prism-coder-7b-Q4_K_M.gguf"
if [ -f "$GGUF_FILE" ]; then
    cat > Modelfile << OLLAMA_EOF
FROM $GGUF_FILE
PARAMETER temperature 0.6
PARAMETER num_ctx 32768
PARAMETER stop <|im_end|>
OLLAMA_EOF
    ollama create prism-coder:7b -f Modelfile
    ollama cp prism-coder:7b dcostenco/prism-coder-7b
    echo "Deployed to Ollama successfully!"
else
    echo "Failed to find GGUF file!"
    exit 1
fi

echo "All Done!"