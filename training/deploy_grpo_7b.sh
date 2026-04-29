#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Waiting for GRPO training (PID 23860) to finish..."
while kill -0 23860 2>/dev/null; do
    sleep 10
done
echo "GRPO training completed!"

echo "Exporting to GGUF..."
cd "$SCRIPT_DIR"
./export_gguf.sh

echo "Deploying to Ollama..."
GGUF_FILE="$SCRIPT_DIR/models/prism-coder-7b-Q4_K_M.gguf"
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
