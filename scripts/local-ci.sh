#!/bin/bash
# Run the CLI Integration workflow's steps locally, in order, with the same
# commands CI uses. Catches everything the macOS/ubuntu legs would catch
# without burning a remote round-trip per iteration.
#
# NOT a substitute for the windows legs: filesystem handle semantics
# (EBUSY on unlink of an open file) cannot be reproduced on macOS, because
# POSIX permits unlinking a file that still has an open descriptor.
set -uo pipefail
cd "$(dirname "$0")/.."

FAILED=()
step() {
  local name="$1"; shift
  printf '\n\033[1m▶ %s\033[0m\n' "$name"
  if "$@"; then
    printf '\033[32m  ✓ %s\033[0m\n' "$name"
  else
    printf '\033[31m  ✗ %s\033[0m\n' "$name"
    FAILED+=("$name")
  fi
}

leak_guard() {
  local TERMS=(
    "synalux""-private"
    "dcostencos""-projects"
    "bcba""-private"
    "/Users/""admin"
  )
  local failed=0
  for TERM in "${TERMS[@]}"; do
    local HITS
    HITS=$(git ls-files | xargs grep -ln "$TERM" 2>/dev/null \
      | grep -v "package-lock.json" | grep -v ".github/workflows/ci.yml" \
      | grep -v "scripts/local-ci.sh" || true)
    if [ -n "$HITS" ]; then
      echo "ERROR: private identifier '$TERM' leaked in tracked files:"
      echo "$HITS"
      failed=1
    fi
  done
  return $failed
}

step "Audit Dependencies"        npm audit --audit-level=high
step "Private repo leak guard"   leak_guard
step "Build TypeScript"          npm run build
step "Run Unit Tests"            npx vitest run --exclude tests/verification/cli-integration.test.ts
step "Process-Level CLI Tests"   npx vitest run tests/verification/cli-integration.test.ts

printf '\n\033[1m── local CI summary ──\033[0m\n'
if [ ${#FAILED[@]} -eq 0 ]; then
  printf '\033[32mALL LOCAL STEPS PASSED\033[0m (windows legs still unverifiable on macOS)\n'
  exit 0
fi
printf '\033[31mFAILED: %s\033[0m\n' "${FAILED[*]}"
exit 1
