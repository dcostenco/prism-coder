#!/bin/bash
# Sync synalux-private/skills → ~/.agent/skills → Prism DB
# synalux-private is the single source of truth for all skills.

SYNALUX_SKILLS="$HOME/synalux-private/skills"
PRISM_DIR="$HOME/.prism-mcp"
DB="$PRISM_DIR/prism-config.db"
SKILLS_DIR="$HOME/.agent/skills"

# Step 1: synalux → local (single source of truth)
if [ -d "$SYNALUX_SKILLS" ]; then
  rsync -a --delete "$SYNALUX_SKILLS/" "$SKILLS_DIR/"
  echo "✓ Synced synalux-private/skills → ~/.agent/skills"
else
  echo "⚠ synalux-private/skills not found, using local skills as-is"
fi

# Step 2: local → Prism DB
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
