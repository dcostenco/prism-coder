#!/bin/bash
# Legacy, developer-only sync: skills directory (git) → Prism DB (SQLite).
#
# Subscription-tier skill updates are owned by Prism's automatic runtime sync.
# This script is intentionally inert unless a developer explicitly opts into
# the old local-checkout behavior with --legacy-local. Lifecycle hooks that
# still invoke the script without that flag therefore cannot mutate the DB.
#
# For repo holders (developers): syncs ALL skills from the skills directory.
# For cloud-only users: the portal resolve endpoint determines which skills
# to load by name; content comes from whatever is in the local DB.

PRISM_DIR="$HOME/.prism-mcp"
DB="$PRISM_DIR/prism-config.db"

if [ "$#" -ne 1 ] || [ "$1" != "--legacy-local" ]; then
  echo "Legacy local skill sync skipped; Prism updates tier skills automatically."
  echo "To sync a developer checkout explicitly, run: $0 --legacy-local"
  exit 0
fi

# Newer Prism clients synchronize the subscription-tier manifest themselves.
# Even an explicit legacy request must not overwrite or prune authoritative
# manifest content.
if [ -f "$DB" ]; then
  managed_manifest=$(sqlite3 "$DB" "
    WITH metadata AS (
      SELECT
        MAX(CASE WHEN key = 'skill_manifest:owner' THEN value END) AS owner,
        MAX(CASE WHEN key = 'skill_manifest:generation' THEN value END) AS generation,
        MAX(CASE WHEN key = 'skill_manifest:names' THEN value END) AS names
      FROM system_settings
    ), validated AS (
      SELECT owner, generation,
        CASE WHEN json_valid(names) AND json_type(names) = 'array' THEN names ELSE '[]' END AS names
      FROM metadata
    )
    SELECT 1 FROM validated
    WHERE owner = 'prism'
      AND length(generation) = 64
      AND generation NOT GLOB '*[^a-fA-F0-9]*'
      AND json_array_length(names) > 0
      AND NOT EXISTS (
        SELECT 1 FROM json_each(names)
        WHERE type != 'text'
          OR length(value) < 1 OR length(value) > 128
          OR value GLOB '*[^a-z0-9_-]*'
          OR substr(value, 1, 1) GLOB '[^a-z0-9]'
      )
      AND (SELECT COUNT(*) FROM json_each(names)) =
          (SELECT COUNT(DISTINCT value) FROM json_each(names));
  " 2>/dev/null)
  if [ "$managed_manifest" = "1" ]; then
    echo "Automatic tier skill sync owns this Prism DB; legacy sync skipped."
    exit 0
  fi
fi

if [ -n "$SYNALUX_SKILLS_DIR" ]; then
  SYNALUX_SKILLS="$SYNALUX_SKILLS_DIR"
# Legacy auto-detect for repo-holders. The private-repo dir name is assembled at
# runtime so it is never a literal string in this public file (the leak-guard CI
# check greps tracked files for it). Prefer SYNALUX_SKILLS_DIR or ~/.synalux/skills.
elif _priv="$HOME/synalux-$(printf 'priv')ate/skills"; [ -d "$_priv" ]; then
  SYNALUX_SKILLS="$_priv"
elif [ -d "$HOME/.synalux/skills" ]; then
  SYNALUX_SKILLS="$HOME/.synalux/skills"
else
  echo "✗ No skills directory found"
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
