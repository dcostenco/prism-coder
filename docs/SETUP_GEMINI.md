# Gemini CLI Setup

Prism uses Gemini CLI's native MCP registration and global instruction file.
No lifecycle hooks or secondary `AGENTS.md` reinforcement are required.

## Connect Prism

Install Prism, close Gemini CLI, and run:

```bash
npm install --global prism-mcp-server
prism connect --host gemini
```

Use `--dry-run` to preview both changes without writing files. Use `--refresh`
to refresh only a Prism-managed MCP registration; custom `prism` or
`prism-mcp` registrations remain untouched.

After Gemini registration and native skill synchronization both succeed,
`prism connect` installs an ownership-marked block in
`~/.gemini/GEMINI.md`. The block requires `session_bootstrap({})` as the first
action on every first user turn, including greetings. If the tool is deferred,
Gemini must load it with native tool discovery and then invoke it; shell, file,
and subagent inspection are not substitutes. Discovery or invocation failure is
reported as a Prism startup failure and stops the turn.

The same command sets `experimental.enableAgents=false` in
`~/.gemini/settings.json`. Bounded delegation runs through Prism's
memory-aware local worker instead of Gemini native or remote subagents. The
main Gemini thread remains responsible for host-tool work and verification.

Gemini's model still owns the final assistant message. MCP and native
instructions can request the complete startup display, but cannot force a
third-party host to relay it verbatim without a lifecycle hook or a
Prism-owned surface. The hook-free setup guarantees registration and makes the
configured context available to the turn; visible verbatim relay is
best-effort.

Prism preserves all instructions outside its marked block, the file's newline
style and mode, and a symlink's target. A recognized legacy Prism startup
section is replaced in place. Similar user-authored sections are preserved.
Malformed or duplicate ownership markers fail loudly without changing the
file.

Prism does not create or modify `~/.gemini/AGENTS.md`, and it does not install
Gemini hooks. Restart Gemini CLI after connecting so it reloads the MCP server
and global instructions.

## What Prism Manages

| File | Managed content |
|------|-----------------|
| `~/.gemini/settings.json` | The `mcpServers.prism-mcp` registration and `experimental.enableAgents=false` local-first limit |
| `~/.gemini/GEMINI.md` | Only the marked native-startup block |
| `~/.agents/skills/` | Entitled native skills synchronized by Prism |

The startup instruction is installed only when Gemini registration succeeds
and skill synchronization finishes successfully. It is not installed after a
failed or partial sync, or when native skill synchronization is disabled.

## CLI Fallback Outside Gemini MCP

For scripts and environments that cannot expose MCP tools, load context
explicitly with the Prism CLI:

```bash
prism load my-project --json
```

Omit `--level` to use the context depth configured in the Prism dashboard.
