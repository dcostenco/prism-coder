#!/bin/bash
# Sync ~/.agent/skills/ into Prism MCP's settings database
# so they're available via hivemind and auto-loaded on session_load_context

PRISM_DIR="$HOME/.prism-mcp"
DB="$PRISM_DIR/prism-config.db"
SKILLS_DIR="$HOME/.agent/skills"

if [ ! -f "$DB" ]; then
  echo "Prism DB not found at $DB"
  exit 1
fi

count=0
for skill_dir in "$SKILLS_DIR"/*/; do
  skill_name=$(basename "$skill_dir")
  skill_file="$skill_dir/SKILL.md"
  if [ -f "$skill_file" ]; then
    content=$(cat "$skill_file")
    # Upsert into settings table
    sqlite3 "$DB" "INSERT OR REPLACE INTO system_settings (key, value) VALUES ('skill:$skill_name', '$(echo "$content" | sed "s/'/''/g")');" 2>/dev/null
    if [ $? -eq 0 ]; then
      echo "  ✓ $skill_name"
      count=$((count + 1))
    else
      echo "  ✗ $skill_name (failed)"
    fi
  fi
done

echo ""
echo "Synced $count skills to $DB"
echo "Verify: sqlite3 $DB \"SELECT key FROM settings WHERE key LIKE 'skill:%'\""
