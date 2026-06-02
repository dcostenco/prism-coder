#!/bin/bash
# post-commit-repomix.sh — Auto-refresh repomix snapshot after git commit.
#
# Called by Claude Code PostToolUse hook on Bash(git commit*).
# Runs async (non-blocking). Reads stdin JSON but only needs the repo root.
#
# Portable: lives in synalux-private/scripts/hooks/ but works for ANY repo
# by detecting the repo root from the commit that just ran. Other repos
# symlink or copy this script; their .claude/settings.json references it.
#
# Output destination: <repo>/training/repomix-output.txt (prism)
#                     <repo>/repomix-output.txt (all others, per repomix.config.json)
#
# Exit 0 always (async hook — never block the agent).

set -e

# Read stdin (PostToolUse sends JSON with tool_input.command)
INPUT=$(cat 2>/dev/null || true)

# Extract the command that was run
CMD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)

# Only proceed if this was actually a git commit
case "$CMD" in
  *"git commit"*) ;;
  *) echo '{"continue":true,"suppressOutput":true}'; exit 0 ;;
esac

# Find the repo root from cwd (the commit just ran here)
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -z "$REPO_ROOT" ]; then
  echo '{"continue":true,"suppressOutput":true}'
  exit 0
fi

REPO_NAME=$(basename "$REPO_ROOT")

# Check if repomix is available
if ! command -v repomix &>/dev/null; then
  echo '{"continue":true,"suppressOutput":true}'
  exit 0
fi

# Determine output path based on repo
case "$REPO_NAME" in
  prism)
    OUTPUT_DIR="$REPO_ROOT/training"
    mkdir -p "$OUTPUT_DIR"
    OUTPUT="$OUTPUT_DIR/repomix-output.txt"
    ;;
  *)
    OUTPUT="$REPO_ROOT/repomix-output.txt"
    ;;
esac

# Run repomix in the background (fully async, don't block the agent)
(
  cd "$REPO_ROOT"
  if [ -f "repomix.config.json" ]; then
    repomix --output "$OUTPUT" 2>/dev/null
  else
    # Default config: skip node_modules, .git, dist, build, .next, data/, *.lock
    repomix --output "$OUTPUT" \
      --ignore "node_modules,*.lock,.git,dist,build,.next,data/,*.safetensors,*.gguf" \
      2>/dev/null
  fi
  # Timestamp marker so we can check freshness
  echo "# Refreshed: $(date -u +%Y-%m-%dT%H:%M:%SZ) after commit $(git rev-parse --short HEAD 2>/dev/null)" >> "$OUTPUT"
) &

echo '{"continue":true,"suppressOutput":true}'
exit 0
