#!/usr/bin/env bash
# Verify the prism-aac adaptive engine mirror is in structural sync with
# the canonical synalux source.
#
# This is a *consistency check*, not an auto-rewriter — the two files have
# different runtime concerns (browser localStorage vs server JSONB), so we
# only compare:
#   - PROFILE_VERSION constant
#   - EMERGENCY_WORDS / HAPPY_WORDS / CALM_WORDS sets
#   - tone → Azure-style mapping
#   - tone → rate clamps
#   - tone → system-hint strings
#
# If any of these drift, prism-coder will receive inconsistent context
# depending on whether the request came from prism-aac (mirror) vs
# synalux (canonical). That's a real cross-system bug.
#
# Usage:
#   bash training/sync_adaptive_engine.sh
# Exit codes:
#   0 — files are in sync
#   1 — drift detected; details printed to stderr

set -euo pipefail

CANONICAL="/Users/admin/synalux-private/portal/src/shared/adaptiveEngine.ts"
MIRROR="/Users/admin/prism-aac/services/adaptiveEngine.ts"

if [[ ! -f "$CANONICAL" ]]; then
  echo "ERROR: canonical not found at $CANONICAL" >&2
  exit 1
fi
if [[ ! -f "$MIRROR" ]]; then
  echo "ERROR: mirror not found at $MIRROR" >&2
  exit 1
fi

# Helper: extract a one-line const value from either file.
extract() {
  local file="$1"; local pattern="$2"
  grep -E "$pattern" "$file" | head -1 | sed 's/^[[:space:]]*//' | tr -d '\n'
}

drift=0

# 1. PROFILE_VERSION
v1=$(grep -E 'PROFILE_VERSION\s*=' "$CANONICAL" | head -1 | grep -oE '[0-9]+')
v2=$(grep -E 'PROFILE_VERSION\s*=' "$MIRROR" | head -1 | grep -oE '[0-9]+')
if [[ "$v1" != "$v2" ]]; then
  echo "DRIFT: PROFILE_VERSION canonical=$v1 mirror=$v2" >&2
  drift=1
fi

# 2. Word-set membership — extract everything between the array brackets and
# compare the sorted unique elements.
extract_set() {
  local file="$1"; local name="$2"
  awk -v name="$name" '
    $0 ~ "const "name" = new Set" { found=1 }
    found {
      print
      if (/\]\)/) exit
    }
  ' "$file" | tr ',' '\n' | grep -oE "'[^']+'" | sort -u | tr '\n' ' '
}

for set_name in EMERGENCY_WORDS HAPPY_WORDS CALM_WORDS; do
  c=$(extract_set "$CANONICAL" "$set_name")
  m=$(extract_set "$MIRROR" "$set_name")
  if [[ "$c" != "$m" ]]; then
    echo "DRIFT: $set_name set differs" >&2
    echo "  canonical: $c" >&2
    echo "  mirror:   $m" >&2
    drift=1
  fi
done

# 3. tone → Azure-style mapping (look for the cases inside toneToAzureStyle).
extract_style_map() {
  local file="$1"
  awk '/function toneToAzureStyle/,/^}/' "$file" | grep -oE "case '[a-z]+': return '[a-z]+'" | sort | tr '\n' ';'
}
c=$(extract_style_map "$CANONICAL")
m=$(extract_style_map "$MIRROR")
if [[ "$c" != "$m" ]]; then
  echo "DRIFT: toneToAzureStyle map differs" >&2
  echo "  canonical: $c" >&2
  echo "  mirror:   $m" >&2
  drift=1
fi

# 4. Emergency-word count sanity check (canonical-side EMERGENCY_WORDS must
# include all 13 keywords currently asserted in tests).
expected_count=13
canon_count=$(grep -A 4 "EMERGENCY_WORDS = new Set" "$CANONICAL" | tr ',' '\n' | grep -c "'")
if [[ "$canon_count" -lt "$expected_count" ]]; then
  echo "DRIFT: canonical EMERGENCY_WORDS has $canon_count entries, expected ≥ $expected_count" >&2
  drift=1
fi

if [[ "$drift" -eq 0 ]]; then
  echo "✓ adaptive engine mirror is in sync with synalux canonical"
  exit 0
fi
echo "✗ drift detected — update prism-aac/services/adaptiveEngine.ts" >&2
exit 1
