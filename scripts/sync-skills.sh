#!/bin/bash
# Sync skills → Prism DB
# Flow: skills directory (git) → this script → Prism DB (SQLite)
# No rsync needed — we read directly from the git-managed directory.
# Skills are pushed to Prism DB via /api/v1/admin/skills on deploy.

# Prefer SYNALUX_SKILLS_DIR env var; fall back to ~/.synalux/skills for compat
if [ -n "$SYNALUX_SKILLS_DIR" ]; then
  SYNALUX_SKILLS="$SYNALUX_SKILLS_DIR"
elif [ -d "$HOME/.synalux/skills" ]; then
  SYNALUX_SKILLS="$HOME/.synalux/skills"
else
  SYNALUX_SKILLS="$HOME/.synalux/skills"
fi
PRISM_DIR="$HOME/.prism-mcp"
DB="$PRISM_DIR/prism-config.db"

if [ ! -d "$SYNALUX_SKILLS" ]; then
  echo "✗ Skills directory not found at $SYNALUX_SKILLS"
  exit 1
fi

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
      echo "  ✓ $skill_name"
      count=$((count + 1))
    else
      echo "  ✗ $skill_name (failed)"
    fi
  fi
done

# Prune orphans — skills in DB but no longer on filesystem
db_keys=$(sqlite3 "$DB" "SELECT key FROM system_settings WHERE key LIKE 'skill:%';" 2>/dev/null)
pruned=0
for key in $db_keys; do
  name="${key#skill:}"
  if [ ! -f "$SYNALUX_SKILLS/$name/SKILL.md" ]; then
    sqlite3 "$DB" "DELETE FROM system_settings WHERE key='$key';" 2>/dev/null
    echo "  🗑 $name (orphan removed)"
    pruned=$((pruned + 1))
  fi
done

echo ""
echo "Synced $count skills to $DB${pruned:+ ($pruned orphans pruned)}"
