#!/bin/bash
# Export fine-tuned Prism model to GGUF for Ollama
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_PYTHON="$SCRIPT_DIR/venv/bin/python3"
MODEL_DIR="$SCRIPT_DIR/models"
MLX_MODEL="$MODEL_DIR/qwen-7b-mlx"
GRPO_ADAPTER="$MODEL_DIR/prism-grpo-lora"
SFT_ADAPTER="$MODEL_DIR/prism-sft-lora-v4-backup"
FUSED_MODEL="$MODEL_DIR/prism-fused"
GGUF_OUTPUT="$MODEL_DIR/prism-coder-7b-Q4_K_M.gguf"
LLAMA_CPP="${LLAMA_CPP_DIR:-$(dirname "$SCRIPT_DIR")/llama.cpp}"

echo "============================================"
echo "  Prism Model Export: MLX → GGUF → Ollama"
echo "============================================"

# Step 1: Determine best adapter
ADAPTER="$GRPO_ADAPTER"
if [ ! -d "$GRPO_ADAPTER" ] || [ ! -f "$GRPO_ADAPTER/adapters.safetensors" ]; then
    echo "GRPO adapter not found, using SFT adapter"
    ADAPTER="$SFT_ADAPTER"
fi

# Check if we already have a fused model from the training pipeline
PREFUSED=""
if [ -d "$GRPO_ADAPTER/fused_aligned" ] && [ -f "$GRPO_ADAPTER/fused_aligned/config.json" ]; then
    PREFUSED="$GRPO_ADAPTER/fused_aligned"
    echo "Found pre-fused model at $PREFUSED"
elif [ -d "$GRPO_ADAPTER/fused_hf" ] && [ -f "$GRPO_ADAPTER/fused_hf/config.json" ]; then
    PREFUSED="$GRPO_ADAPTER/fused_hf"
    echo "Found pre-fused model at $PREFUSED"
fi

# Step 2: Fuse if not already fused
if [ -n "$PREFUSED" ]; then
    echo ""
    echo "Step 1/3: Skipping fusion — using pre-fused model"
    FUSED_MODEL="$PREFUSED"
else
    if [ ! -d "$ADAPTER" ] || [ ! -f "$ADAPTER/adapters.safetensors" ]; then
        echo "ERROR: No adapter found at $ADAPTER"
        exit 1
    fi
    echo ""
    echo "Step 1/3: Fusing LoRA adapter into base model..."
    echo "Using adapter: $ADAPTER"
    "$VENV_PYTHON" -m mlx_lm.fuse \
        --model "$MLX_MODEL" \
        --adapter-path "$ADAPTER" \
        --save-path "$FUSED_MODEL" \
        --dequantize
    echo "Fused model saved to $FUSED_MODEL"
fi

echo "Model config:"
cat "$FUSED_MODEL/config.json" | head -5

# Step 3: Convert HF safetensors → GGUF using llama.cpp
echo ""
echo "Step 2/3: Converting to GGUF F16..."

F16_GGUF="$MODEL_DIR/prism-coder-7b-f16.gguf"

if [ -f "$LLAMA_CPP/convert_hf_to_gguf.py" ]; then
    python3 "$LLAMA_CPP/convert_hf_to_gguf.py" "$FUSED_MODEL" \
        --outfile "$F16_GGUF" \
        --outtype f16
elif command -v convert_hf_to_gguf &>/dev/null; then
    convert_hf_to_gguf "$FUSED_MODEL" --outfile "$F16_GGUF" --outtype f16
else
    echo "ERROR: llama.cpp convert_hf_to_gguf.py not found at $LLAMA_CPP"
    echo "Install: git clone https://github.com/ggml-org/llama.cpp $LLAMA_CPP"
    exit 1
fi

echo "F16 GGUF: $(du -h "$F16_GGUF" | cut -f1)"

# Step 4: Quantize F16 → Q4_K_M
echo ""
echo "Step 3/3: Quantizing F16 → Q4_K_M..."

QUANTIZE_BIN=""
if command -v llama-quantize &>/dev/null; then
    QUANTIZE_BIN="llama-quantize"
elif [ -f "$LLAMA_CPP/build/bin/llama-quantize" ]; then
    QUANTIZE_BIN="$LLAMA_CPP/build/bin/llama-quantize"
fi

if [ -n "$QUANTIZE_BIN" ]; then
    "$QUANTIZE_BIN" "$F16_GGUF" "$GGUF_OUTPUT" Q4_K_M
    echo "Quantized GGUF: $(du -h "$GGUF_OUTPUT" | cut -f1)"
    rm -f "$F16_GGUF"
else
    echo "WARNING: llama-quantize not found. Building llama.cpp..."
    cd "$LLAMA_CPP" && cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --target llama-quantize -j$(sysctl -n hw.ncpu)
    if [ -f "$LLAMA_CPP/build/bin/llama-quantize" ]; then
        "$LLAMA_CPP/build/bin/llama-quantize" "$F16_GGUF" "$GGUF_OUTPUT" Q4_K_M
        echo "Quantized GGUF: $(du -h "$GGUF_OUTPUT" | cut -f1)"
        rm -f "$F16_GGUF"
    else
        echo "WARNING: Build failed. Using F16 GGUF directly (larger but functional)"
        mv "$F16_GGUF" "$GGUF_OUTPUT"
    fi
    cd "$SCRIPT_DIR"
fi

# Register with Ollama
echo ""
echo "============================================"
echo "  Registering with Ollama"
echo "============================================"

MODELFILE_PATH="$SCRIPT_DIR/Modelfile"

if [ -f "$GGUF_OUTPUT" ]; then
    echo "Creating Ollama model from GGUF..."
    ollama create prism-coder:7b -f "$MODELFILE_PATH"
    echo ""
    echo "Done! Model registered: prism-coder:7b"
    echo "Run: ollama run prism-coder:7b"
else
    echo "ERROR: GGUF file not created at $GGUF_OUTPUT"
    exit 1
fi
