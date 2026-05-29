#!/bin/bash
# Prism Knowledge Ingestion — One-line Setup
#
# Usage:
#   curl -sSL https://synalux.ai/install-hooks | bash
#   — or —
#   bash setup.sh
#
# What this does:
#   1. Copies hook scripts to ~/.prism/hooks/
#   2. Sets up git global hooks path (optional)
#   3. Validates API keys
#
# After setup, every git commit in any repo automatically indexes
# your code into the Prism knowledge graph.

set -euo pipefail

HOOKS_DIR="$HOME/.prism/hooks"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🧠 Prism Knowledge Ingestion Setup"
echo "==================================="
echo ""

# Step 1: Create hooks directory
mkdir -p "$HOOKS_DIR"
echo "✓ Created $HOOKS_DIR"

# Step 2: Copy scripts
cp "$SCRIPT_DIR/gen_qa.py" "$HOOKS_DIR/"
cp "$SCRIPT_DIR/ingest.mjs" "$HOOKS_DIR/"
cp "$SCRIPT_DIR/post-commit" "$HOOKS_DIR/"
chmod +x "$HOOKS_DIR/post-commit"
echo "✓ Installed hook scripts"

# Step 3: Check dependencies
MISSING=""
command -v python3 >/dev/null 2>&1 || MISSING="$MISSING python3"
command -v node >/dev/null 2>&1 || MISSING="$MISSING node"
python3 -c "import anthropic" 2>/dev/null || MISSING="$MISSING anthropic(pip)"

if [ -n "$MISSING" ]; then
    echo ""
    echo "⚠ Missing dependencies:$MISSING"
    echo "  pip install anthropic   # for Q&A generation"
    echo ""
fi

# Step 4: Check API keys
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ ! -f "$HOME/.anthropic_key" ]; then
    echo "⚠ ANTHROPIC_API_KEY not set and ~/.anthropic_key not found"
    echo "  Required for Q&A generation (Claude Haiku)"
    echo ""
fi

if [ -z "${SYNALUX_API_KEY:-}" ]; then
    if [ -f "$HOME/prism/.env" ] && grep -q "PRISM_SYNALUX_API_KEY" "$HOME/prism/.env"; then
        echo "✓ Synalux API key found in ~/prism/.env"
    else
        echo "⚠ SYNALUX_API_KEY not set"
        echo "  Required for remote knowledge graph ingestion"
        echo "  Get yours at: https://synalux.ai → Settings → API Keys"
        echo ""
    fi
else
    echo "✓ Synalux API key found"
fi

# Step 5: Offer global git hooks
echo ""
read -p "Set up global git hooks? (every repo auto-indexes) [y/N] " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    git config --global core.hooksPath "$HOOKS_DIR"
    echo "✓ Global hooks enabled: git config --global core.hooksPath $HOOKS_DIR"
    echo "  Every repo now auto-indexes on commit"
else
    echo "  To add to a specific repo:"
    echo "  ln -sf $HOOKS_DIR/post-commit /path/to/repo/.git/hooks/post-commit"
fi

echo ""
echo "✓ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Commit code in any connected repo"
echo "  2. Check knowledge: knowledge_search(query='your query', project='repo-name')"
echo ""
echo "Docs: https://synalux.ai/docs/knowledge-ingestion"
