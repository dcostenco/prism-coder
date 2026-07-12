#!/bin/bash
# Sync skills → Prism DB
# Flow: skills directory (git) → this script → Prism DB (SQLite)
#
# For repo holders (developers): syncs ALL skills from the skills directory.
# For cloud-only users: the portal resolve endpoint determines which skills
# to load by name; content comes from whatever is in the local DB.

if [ -n "$SYNALUX_SKILLS_DIR" ]; then
  SYNALUX_SKILLS="$SYNALUX_SKILLS_DIR"
elif [ -d "$HOME/synalux-private/skills" ]; then
  SYNALUX_SKILLS="$HOME/synalux-private/skills"
elif [ -d "$HOME/.synalux/skills" ]; then
  SYNALUX_SKILLS="$HOME/.synalux/skills"
else
  echo "✗ No skills directory found"
  exit 1
fi

PRISM_DIR="$HOME/.prism-mcp"
DB="$PRISM_DIR/prism-config.db"

if [ ! -f "$DB" ]; then
  echo "✗ Prism DB not found at $DB"
  exit 1
fi

count=0
for skill_dir in "$SYNALUX_SKILLS"/*/; do
  skill_name=$(basename "$skill_dir")
  skill_file="$skill_dir/SKILL.md"
  if [ -f "$skill_file" ]; then
    content=$(cat "$skill_file")
    sqlite3 "$DB" "INSERT OR REPLACE INTO system_settings (key, value) VALUES ('skill:$skill_name', '$(echo "$content" | sed "s/'/''/g")');" 2>/dev/null
    if [ $? -eq 0 ]; then
      count=$((count + 1))
    fi
  fi
done

# Prune orphans
db_keys=$(sqlite3 "$DB" "SELECT key FROM system_settings WHERE key LIKE 'skill:%';" 2>/dev/null)
pruned=0
for key in $db_keys; do
  name="${key#skill:}"
  if [ ! -f "$SYNALUX_SKILLS/$name/SKILL.md" ]; then
    sqlite3 "$DB" "DELETE FROM system_settings WHERE key='$key';" 2>/dev/null
    pruned=$((pruned + 1))
  fi
done

echo "Synced $count skills to $DB${pruned:+ ($pruned orphans pruned)}"
