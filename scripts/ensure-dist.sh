#!/bin/bash
# Guarantee dist/server.js exists after a checkout or merge.
#
# Why this exists (2026-08-05): BOTH hosts launch the MCP server by absolute
# path into this working tree —
#
#   claude:  /usr/local/bin/node /Users/<you>/prism/dist/server.js
#   codex:   same, via [mcp_servers.prism-mcp] in ~/.codex/config.toml
#
# and dist/ is gitignored, so it exists only when built. An rm -rf dist, a
# failed build, or a branch checked out without built output therefore does
# not merely break a CLI: it stops Prism loading in EVERY session on this
# machine, for both hosts, until someone happens to rebuild.
#
# That failure is silent and confusing at the point of use — it surfaces as
# "the MCP server won't connect" or "the browser CLI is broken", far from the
# checkout that caused it. This rebuilds instead.
#
# Deliberately best-effort: a hook must never block a checkout or merge. If
# the build fails, say so and let the developer decide.
set -uo pipefail
cd "$(dirname "$0")/.."

[ -f dist/server.js ] && exit 0

echo "[ensure-dist] dist/server.js is missing — the Prism MCP server is launched"
echo "[ensure-dist] from this path, so both Claude Code and Codex would fail to"
echo "[ensure-dist] start Prism. Rebuilding…"

if npm run build >/tmp/prism-ensure-dist.log 2>&1; then
  echo "[ensure-dist] ✓ rebuilt dist/"
else
  echo "[ensure-dist] ✗ build FAILED — Prism will not load until this is fixed." >&2
  echo "[ensure-dist]   log: /tmp/prism-ensure-dist.log" >&2
  echo "[ensure-dist]   run: npm run build" >&2
fi
exit 0
