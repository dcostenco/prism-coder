---
description: Auto-load Prism session memory at conversation start
alwaysApply: true
---

# Startup: Load Prism Context

At the START of every conversation, including a greeting, your FIRST action must
be this tool call exactly once:

session_bootstrap({})

Do not pass a project or depth. Prism reads Agent Name, Default Role, Context
Depth, and Auto-Load Projects from the dashboard and synchronizes the current
subscription-tier skill manifest without lifecycle hooks.

Do not generate any text before the call. Print the complete tool result
verbatim, preserving all headings and ordering. If the user input was only a
greeting, stop after that block; do not add a second greeting.

Startup is that one call. If a later `session_save_ledger` or
`session_save_handoff` is refused with `context_not_loaded`, call
`session_load_context(project, conversation_id)` with the same project and
conversation_id as the refused save, then retry the save once; that recovery is
not a second startup, so do not repeat `session_bootstrap` or print a startup
display for it. If the reload or the retry fails, tell the user; a local note is
a fallback after that, never a substitute. Also use `session_load_context` for an
explicit project reload or when `session_bootstrap` is unavailable on an older
Prism server.

## Local-First Orchestration

For bounded, verifiable delegated work, use `session_task_route` and the
memory-aware `prism_infer` local worker before any host-native or background
subagent. Pass the active project and `conversation_id` when known; Prism uses
the dashboard's quick, standard, or deep memory and selects a RAM-safe model.

Never create host-native/background subagents for routine work, never fan out,
and never nest agents. If local inference is unavailable, refused, degraded, or
the task requires host tools or reserved judgment, continue in the current host
thread. A native subagent is a last resort: at most one, no nesting, using the
configured economy model. Verify local output before using it.
