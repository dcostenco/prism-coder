#!/bin/bash
# =============================================================================
# BFCL V4 #1 Master Training Pipeline (MLX Native)
# =============================================================================
# Base: Salesforce/xLAM-2-32b-fc-r (75.83% BFCL v3 out of the box)
# Target: >80% BFCL V4 (beat Claude Opus 4.5 at 77.47%)
# Hardware: M5 Max 48GB — 32B Q4 uses ~17GB, leaving 27GB for activations
#
# Pipeline:
#   Phase 0:  Data generation (BFCL V4 + Diverse SFT + UX experiments)
#   Phase 1a: Convert model to MLX 4-bit
#   Phase 1b: SFT fine-tune on verified trajectories
#   Phase 2:  RS-SFT alignment (chosen-only rejection sampling)
#   Phase 3:  SLERP model souping (merge SFT + alignment adapters)
#   Phase 4:  Deploy to Ollama
#   Phase 5:  BFCL V4 evaluation
#
# Usage:
#   ./run_bfcl_pipeline.sh                 # Full pipeline
#   ./run_bfcl_pipeline.sh --skip-convert  # Resume after model download
#   ./run_bfcl_pipeline.sh --eval-only     # Run evaluation only
#   ./run_bfcl_pipeline.sh --force-regen   # Regenerate training data
#
# Prerequisites:
#   pip install mlx-lm bfcl evalscope scikit-learn
# =============================================================================

set -euo pipefail

TRAINING_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$TRAINING_DIR/data/bfcl"
AUX_DATA_DIR="$TRAINING_DIR/data/aux_sft"
# R15-fix: Export so config.py and Python scripts use the same path
export PRISM_AUX_DATA_DIR="$AUX_DATA_DIR"
OUTPUT_DIR="$TRAINING_DIR/output/bfcl-32b"
BFCL_DIR="${PRISM_BFCL_DIR:-$HOME/gorilla-bfcl/berkeley-function-call-leaderboard}"

# Model configuration — xLAM-2-32b-fc-r
HF_MODEL="Salesforce/xLAM-2-32b-fc-r"
BFCL_MODEL="prism-coder-32b-FC"
MLX_MODEL="$OUTPUT_DIR/Salesforce-xLAM-2-32b-fc-r-4bit"

# Training watchdog
WATCHDOG="$TRAINING_DIR/training_watchdog.py"

# Parse arguments
SKIP_CONVERT=false
EVAL_ONLY=false
FORCE_REGEN=false
for arg in "$@"; do
    case $arg in
        --skip-convert) SKIP_CONVERT=true ;;
        --eval-only) EVAL_ONLY=true ;;
        --force-regen) FORCE_REGEN=true ;;
    esac
done

echo "=============================================="
echo "🏆 BFCL V4 #1 Pipeline — xLAM-2-32b-fc-r"
echo "=============================================="
echo "Training dir: $TRAINING_DIR"
echo "Output dir:   $OUTPUT_DIR"
echo "HF Model:     $HF_MODEL"
echo "Target:       >80% BFCL V4 (beat Claude Opus 4.5)"
echo ""

# Detect hardware
TOTAL_MEM_GB=$(sysctl -n hw.memsize 2>/dev/null | awk '{printf "%.0f", $1/1073741824}')
echo "System memory: ${TOTAL_MEM_GB} GB"
echo "Model size:    ~17 GB (32B Q4)"
echo "Activation headroom: ~$((TOTAL_MEM_GB - 17 - 3)) GB"
echo ""

if [ "$TOTAL_MEM_GB" -lt 36 ]; then
    echo "ERROR: 32B model requires at least 36GB (17GB model + 16GB activations + 3GB OS)."
    echo "   Detected: ${TOTAL_MEM_GB}GB"
    exit 1
fi

mkdir -p "$OUTPUT_DIR"

# Jump to eval if requested
if [ "$EVAL_ONLY" = true ]; then
    echo "Jumping to evaluation..."
fi

if [ "$EVAL_ONLY" != true ]; then

# =============================================================================
# Phase 0: Generate all training data
# =============================================================================
echo ""
echo "Phase 0: Generating training data"
echo "--------------------------------------"
cd "$TRAINING_DIR"
mkdir -p "$DATA_DIR"
mkdir -p "$AUX_DATA_DIR"

# Phase 0a: BFCL V4 training data
if [ -f "$DATA_DIR/train.jsonl" ] && [ "$FORCE_REGEN" != true ]; then
    EXISTING_COUNT=$(wc -l < "$DATA_DIR/train.jsonl")
    echo "BFCL data exists: $EXISTING_COUNT examples (use --force-regen to regenerate)"
else
    echo "Building tool schema registry (includes V4 Agentic tools)..."
    python build_tool_schema.py
    
    echo "Generating HyDE embeddings for RAG-aligned training..."
    python semantic_rag.py hyde || echo "⚠️ HyDE generation failed — training will use API-grouped pools only"
    
    echo "Generating BFCL V4 training data (with R5 optimizations)..."
    python generate_bfcl_training_data.py \
        --output-dir "$DATA_DIR" \
        --bfcl-dir "$BFCL_DIR" \
        --irrelevance-count 1000 \
        --multiturn-count 1600 \
        --miss-func-count 600 \
        --grpo-count 800 \
        --smcot-count 300 \
        --optional-restraint-count 500 \
        --dry-run-count 200 \
        --distractor-count 400 \
        --evol-instruct-count 500
fi

# Phase 0b: Diverse SFT data (experiments 1-4 included)
if [ -f "$AUX_DATA_DIR/train.jsonl" ] && [ "$FORCE_REGEN" != true ]; then
    AUX_COUNT=$(wc -l < "$AUX_DATA_DIR/train.jsonl")
    echo "Diverse SFT data exists: $AUX_COUNT examples"
else
    echo "Generating diverse SFT + UX experiment data..."
    python generate_diverse_sft.py
fi

# Phase 0c: Toolname SFT data
TOOLNAME_DIR="$TRAINING_DIR/data/toolname_sft"
if [ -f "$TOOLNAME_DIR/train.jsonl" ] && [ "$FORCE_REGEN" != true ]; then
    TN_COUNT=$(wc -l < "$TOOLNAME_DIR/train.jsonl")
    echo "Toolname SFT data exists: $TN_COUNT examples"
else
    echo "Generating toolname SFT data..."
    python generate_sft_toolnames.py
fi

# Phase 0d: Merge all training data into combined dataset
# CRITICAL: Do NOT silently drop aux data — fail loudly if files missing
echo "Merging all training data..."
COMBINED_DIR="$TRAINING_DIR/data/combined"
mkdir -p "$COMBINED_DIR"

# Validate required data files exist
MERGE_FILES="$DATA_DIR/train.jsonl"
for AUX_FILE in "$AUX_DATA_DIR/train.jsonl" "$TOOLNAME_DIR/train.jsonl"; do
    if [ -f "$AUX_FILE" ]; then
        MERGE_FILES="$MERGE_FILES $AUX_FILE"
    else
        echo "WARNING: Missing $AUX_FILE — coding anchors may be incomplete!"
    fi
done
cat $MERGE_FILES > "$COMBINED_DIR/train.jsonl"

MERGE_VALID="$DATA_DIR/valid.jsonl"
for AUX_FILE in "$AUX_DATA_DIR/valid.jsonl" "$TOOLNAME_DIR/valid.jsonl"; do
    if [ -f "$AUX_FILE" ]; then
        MERGE_VALID="$MERGE_VALID $AUX_FILE"
    fi
done
cat $MERGE_VALID > "$COMBINED_DIR/valid.jsonl"

TOTAL_TRAIN=$(wc -l < "$COMBINED_DIR/train.jsonl")
TOTAL_VALID=$(wc -l < "$COMBINED_DIR/valid.jsonl")
echo "Combined dataset: $TOTAL_TRAIN train, $TOTAL_VALID valid examples"

# =============================================================================
# Phase 1a: Convert model to MLX (4-bit quantization)
# =============================================================================
echo ""
echo "Phase 1a: Convert xLAM-2-32b-fc-r to MLX 4-bit"
echo "--------------------------------------"

if [ "$SKIP_CONVERT" = true ] || [ -d "$MLX_MODEL" ]; then
    echo "MLX model exists or --skip-convert set. Skipping."
else
    python bfcl_qlora_finetune.py \
        --model "$HF_MODEL" \
        --data "$COMBINED_DIR" \
        --output-dir "$OUTPUT_DIR" \
        --skip-train --no-fuse
fi

# =============================================================================
# Phase 1b: QLoRA SFT Fine-Tune
# =============================================================================
echo ""
echo "Phase 1b: QLoRA SFT Fine-Tuning (32B)"
echo "--------------------------------------"
echo "Config: rank=64, iters=1500, lr=1e-5, batch=1, grad-accum=16, layers=24, seq=16384"
echo "Estimated: ~8-10 hours on M5 Max 48GB"

SFT_ADAPTER="$OUTPUT_DIR/sft_adapter"
SFT_FUSED="$OUTPUT_DIR/fused_model"

if [ -d "$SFT_FUSED" ]; then
    echo "SFT fused model already exists. Skipping."
else
    # Start watchdog in background
    if [ -f "$WATCHDOG" ]; then
        python "$WATCHDOG" &
        WATCHDOG_PID=$!
        echo "Watchdog started (PID: $WATCHDOG_PID)"
    fi

    python bfcl_qlora_finetune.py \
        --mlx-model "$MLX_MODEL" \
        --data "$COMBINED_DIR" \
        --output-dir "$OUTPUT_DIR" \
        --iters 1500 \
        --lora-rank 64 \
        --lora-layers 24 \
        --lr 1e-5 \
        --batch-size 1 \
        --skip-convert

    # Stop watchdog
    if [ -n "${WATCHDOG_PID:-}" ]; then
        kill "$WATCHDOG_PID" 2>/dev/null || true
    fi
fi

# =============================================================================
# Phase 2: RS-SFT Alignment (Chosen-Only Rejection Sampling)
# =============================================================================
echo ""
echo "Phase 2: RS-SFT Alignment"
echo "--------------------------------------"
echo "Config: rank=64, iters=800, lr=5e-6, layers=16, seq=8192, batch=1"
echo "Estimated: ~4 hours"

GRPO_DIR="$OUTPUT_DIR/grpo"
GRPO_ADAPTER="$GRPO_DIR/adapters"  # R27-fix: matches bfcl_grpo_align.py output_dir / "adapters"
GRPO_FUSED="$GRPO_DIR/fused_aligned"

if [ -d "$SFT_FUSED" ]; then
    if [ -d "$GRPO_FUSED" ]; then
        echo "RS-SFT model already exists. Skipping."
    else
        # Start watchdog
        if [ -f "$WATCHDOG" ]; then
            python "$WATCHDOG" &
            WATCHDOG_PID=$!
        fi

        # R13-fix: Explicitly pass --lora-layers 24 to match SFT
        python bfcl_grpo_align.py \
            --model "$SFT_FUSED" \
            --data "$DATA_DIR" \
            --output-dir "$GRPO_DIR" \
            --iters 800 \
            --lora-rank 64 \
            --lora-layers 24 \
            --lr 5e-6

        if [ -n "${WATCHDOG_PID:-}" ]; then
            kill "$WATCHDOG_PID" 2>/dev/null || true
        fi
    fi
else
    echo "WARNING: SFT model not found at $SFT_FUSED - run Phase 1 first"
fi

# =============================================================================
# Phase 3: SLERP Model Souping (Merge SFT + Alignment Adapters)
# =============================================================================
echo ""
echo "Phase 3: SLERP Model Souping"
echo "--------------------------------------"

SOUPED_MODEL="$OUTPUT_DIR/souped_model"

if [ -d "$SOUPED_MODEL" ]; then
    echo "Souped model already exists. Skipping."
elif [ -d "$SFT_FUSED" ] && [ -d "$GRPO_FUSED" ]; then
    echo "Applying GRPO alignment adapter onto SFT-fused model..."
    # R26-fix: GRPO adapter is a delta relative to $SFT_FUSED — apply directly, no SLERP.
    # SLERP with SFT_FUSED as base would double-apply SFT weights (1.7x SFT + 0.3x GRPO).
    python merge_adapters.py \
        --base-model "$SFT_FUSED" \
        --align-adapter "$GRPO_ADAPTER" \
        --output "$SOUPED_MODEL"
else
    echo "WARNING: Need both SFT and RS-SFT models for souping."
    echo "  Using best available model instead."
    if [ -d "$GRPO_FUSED" ]; then
        SOUPED_MODEL="$GRPO_FUSED"
    elif [ -d "$SFT_FUSED" ]; then
        SOUPED_MODEL="$SFT_FUSED"
    fi
fi

# =============================================================================
# Phase 4: Deploy to Ollama
# =============================================================================
echo ""
echo "Phase 4: Deploy to Ollama"
echo "--------------------------------------"

FINAL_DIR="$SOUPED_MODEL"
[ ! -d "$FINAL_DIR" ] && FINAL_DIR="$GRPO_FUSED"
[ ! -d "$FINAL_DIR" ] && FINAL_DIR="$SFT_FUSED"

if [ -d "$FINAL_DIR" ]; then
    # Convert to GGUF if needed
    GGUF_FILE=$(find "$FINAL_DIR" -name "*.gguf" 2>/dev/null | head -1)
    if [ -z "$GGUF_FILE" ] && [ -f "$TRAINING_DIR/export_gguf.sh" ]; then
        echo "Converting to GGUF..."
        bash "$TRAINING_DIR/export_gguf.sh" "$FINAL_DIR" "$OUTPUT_DIR/${BFCL_MODEL}.gguf"
        GGUF_FILE="$OUTPUT_DIR/${BFCL_MODEL}.gguf"
    fi

    if [ -n "$GGUF_FILE" ]; then
        echo "Found GGUF: $GGUF_FILE"

        MODELFILE="$OUTPUT_DIR/Modelfile"
        cat > "$MODELFILE" << OLLAMA_EOF
FROM $GGUF_FILE
PARAMETER temperature 0.6
PARAMETER num_ctx 32768
PARAMETER stop <|im_end|>
OLLAMA_EOF

        echo "Creating Ollama model: $BFCL_MODEL"
        ollama create "$BFCL_MODEL" -f "$MODELFILE"
        echo "✅ Deployed as $BFCL_MODEL"
    else
        echo "No GGUF file found. Manual conversion needed."
    fi
else
    echo "No fused model found. Run Phases 1-3 first."
fi

fi  # end of EVAL_ONLY check

# =============================================================================
# Phase 5: BFCL V4 Evaluation
# =============================================================================
echo ""
echo "Phase 5: BFCL V4 Evaluation"
echo "--------------------------------------"

echo "Running evaluation on all V4 categories..."
echo "  Model: $BFCL_MODEL"
echo "  Categories: Agentic(40%), Multi-Turn(30%), Live(10%), Non-Live(10%), Hallucination(10%)"
echo ""

cd "$BFCL_DIR"

echo "Generating responses..."
bfcl generate --model "$BFCL_MODEL" --test-category all --num-threads 1 --backend vllm 2>&1 | tee "$OUTPUT_DIR/eval_generate.log"

echo ""
echo "Evaluating..."
bfcl evaluate --model "$BFCL_MODEL" --test-category all 2>&1 | tee "$OUTPUT_DIR/eval_results.log"

echo ""
echo "Results saved to: $OUTPUT_DIR/eval_results.log"

echo ""
echo "=============================================="
echo "🏆 Pipeline complete!"
echo "=============================================="
echo ""
echo "Summary:"
echo "  Base Model:    $HF_MODEL"
echo "  MLX Model:     $MLX_MODEL"
echo "  SFT Fused:     $SFT_FUSED"
echo "  RS-SFT Aligned: $GRPO_FUSED"
echo "  SLERP Souped:  $SOUPED_MODEL"
echo "  Eval Log:      $OUTPUT_DIR/eval_results.log"
echo ""
echo "BFCL V4 Scoring: Agentic×40% + Multi-Turn×30% + Live×10% + Non-Live×10% + Hallucination×10%"
