---
name: prism-startup
description: "Activate on the first user turn of every conversation, including greetings. Load Prism context using the user's configured project and quick, standard, or deep depth, then greet the developer by their configured agent name and show the matching recent-session context."
---

# Prism Startup

Use this skill once, on the first user turn of a conversation. A greeting such
as "hi", "hello", or "ready?" is still a first user turn and must activate it.
Do not run it again after startup context has already been shown in the same
conversation.

Portable native-skill activation starts when the host processes the first user
turn. It cannot display anything before the developer sends that first input.
That first-turn behavior is the cross-host contract.

## Provisioning contract

This skill ships with the `prism` plugin, alongside the Prism MCP server
registration. The `prism connect` CLI installs the same protected skill for
hosts configured that way; when both are present, the re-entry rule above keeps
startup to a single display. Startup must not modify a host's lifecycle
configuration. The skill remains available on every subscription tier, and it is
intentionally absent from session skill routing so loading context cannot inject
this startup procedure recursively.

## First action: bootstrap context

Before greeting the developer or answering their task:

1. If `session_bootstrap` is available, call it with no arguments. Do not guess
   a project, role, developer name, or context depth.
2. If `session_bootstrap` is unavailable but `session_load_context` is
   available, call `session_load_context` for the current project and omit the
   `level` argument. Use the repository or workspace name as the project; use
   `prism-mcp` only when no project can be derived.
3. If MCP tools are unavailable but the `prism` CLI is available, run
   `prism load <project> --json` and omit `--level`.
4. If the first attempt fails, correct the parameters and retry once. If the
   retry and fallback both fail, display exactly:
   `⚠️ *Session context is temporarily unavailable.*`

The level must be omitted in every startup path. Prism resolves the current
dashboard setting instead of allowing this static skill to override it.

## Context-depth contract

Render only the data returned for the resolved depth:

- `quick`: greet with the configured name and show the compact current state,
  including open TODOs or keywords when present. Do not claim session summaries
  were absent; quick intentionally does not fetch them.
- `standard`: also show the last summary and up to five recent sessions.
- `deep`: also show the complete returned session history, up to fifty entries,
  including the extra decisions, TODOs, and changed-file detail supplied by
  Prism.

Do not make a second load call to expand the selected depth. An empty field is
different from a field intentionally omitted at the selected depth.

## Greeting and context output

If `session_bootstrap` returns a ready-to-display greeting/context block, print
the complete bootstrap result verbatim as the entire first-turn startup
display, before any task answer. Do not summarize, paraphrase, rename headings,
reformat, or omit any returned section. Preserve its order and line content.

If no ready-to-display block is returned, render the structured fallback result
in this order:

1. `Hi, <agent_name>.` using the configured `agent_name`. If it is empty, use
   `Hi.` without inventing a name.
2. `**Last session:** <last_summary>` when the selected depth returned it.
3. `**Open TODOs:**` followed by the returned TODOs, when present.
4. `**Recent sessions:**` for standard results or `**Session history:**` for
   deep results, preserving the returned order.

When the first user input is only a greeting, stop after the verbatim startup
display. If only the structured fallback was available, stop after that
structured startup display. Do not add another greeting, question,
acknowledgement, or other prose. When the first input contains a task, continue
directly into that task after the startup display.

## Foundational skill verification

Context loading may return entitled `[📜 SKILL: <name>]` blocks. Use only the
skills explicitly reported as provisioned or returned in those blocks. Never
guess a package name, request a missing package, or treat a package from an old
session as currently entitled. Paid behavioral and engineering packages are
delivered by the authenticated manifest; the public startup path relies on the
compact safety and evidence contract in the MCP server instructions.

For bug reports or screenshots, run a real diagnostic before explaining the
cause. Never report "done", "fixed", or "working" without observable
verification.
