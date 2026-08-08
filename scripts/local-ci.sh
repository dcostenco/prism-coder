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


# ── npm ci parity, on linux ─────────────────────────────────────────────────
# CI installs with `npm ci`, which fails hard when package.json and the
# lockfile disagree. Running it on macOS is NOT equivalent: @emnapi/core and
# @emnapi/runtime are platform-specific optional deps — unused here, REQUIRED
# on linux — so any lockfile regenerated on macOS prunes them, `npm ci
# --dry-run` still passes locally, and every linux and macOS CI leg then fails
# with "Missing: @emnapi/runtime from lock file". That cost three attempts on
# 2026-08-08. Docker is the only way to check it from this machine.
# Skips (does not fail) when Docker is unavailable, so the script still works
# without it — but prints loudly, because a skipped guard is not a passed one.
npm_ci_linux() {
  if ! docker info >/dev/null 2>&1; then
    printf '\033[33m  SKIPPED — Docker not running; lockfile/linux parity UNVERIFIED\033[0m\n'
    return 0
  fi
  docker run --rm -v "$PWD":/w -w /w node:22-slim sh -c 'npm ci --dry-run' >/dev/null 2>&1
}

step "npm ci parity (linux)"     npm_ci_linux
step "Audit Dependencies"        npm audit --audit-level=high
step "Private repo leak guard"   leak_guard
step "Build TypeScript"          npm run build
step "Raw-inference chokepoint"  node scripts/no-raw-inference.mjs
step "Run Unit Tests"            npx vitest run --exclude tests/verification/cli-integration.test.ts
step "Process-Level CLI Tests"   npx vitest run tests/verification/cli-integration.test.ts

printf '\n\033[1m── local CI summary ──\033[0m\n'
if [ ${#FAILED[@]} -eq 0 ]; then
  printf '\033[32mALL LOCAL STEPS PASSED\033[0m (windows legs still unverifiable on macOS)\n'
  exit 0
fi
printf '\033[31mFAILED: %s\033[0m\n' "${FAILED[*]}"
exit 1
