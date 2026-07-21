# IDE & Client Setup

> How to connect Prism Coder to every supported MCP client.
>
> Prism runs as an MCP server over stdio. Any client that speaks the
> [Model Context Protocol](https://modelcontextprotocol.io) can use it.

---

## Table of Contents

1. [Quick Start (all clients)](#1-quick-start)
2. [Claude Desktop](#2-claude-desktop)
3. [Claude Code (CLI)](#3-claude-code-cli)
4. [Cursor](#4-cursor)
5. [Windsurf](#5-windsurf)
6. [VS Code (Cline / Continue / Copilot MCP)](#6-vs-code)
7. [JetBrains IDEs](#7-jetbrains-ides)
8. [Custom / Headless](#8-custom--headless)
9. [Dashboard Access](#9-dashboard-access)
10. [Environment Variables](#10-environment-variables)
11. [Local Model Setup (Ollama)](#11-local-model-setup-ollama)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Quick Start

Install Prism and let the CLI register its installed server path with your MCP hosts:

```bash
npm install --global prism-mcp-server
prism connect             # auto-detect installed hosts
prism connect --dry-run   # preview without writing
```

The command supports Claude Code, Claude Desktop (macOS/Windows/Linux), Cursor,
Gemini CLI, and Codex. Use
`prism connect --all` to target all five or `prism connect --host <name>` to
target one. Existing `prism` and `prism-mcp` entries are never overwritten.
`--refresh` updates only entries previously created by Prism; custom entries
stay untouched. The host-specific sections below retain the equivalent manual
configuration.
Close the target MCP hosts before a non-dry-run registration so they cannot
edit their configuration concurrently.

### One local-first agent workflow

Every managed registration carries the same server-owned policy: route bounded,
verifiable delegation through `session_task_route` and `prism_infer` before
using host-native/background agents. `prism_infer` can load project memory at
the dashboard's quick, standard, or deep depth. The router forwards a
complexity hint but never chooses a model; `prism_infer` centrally selects
2B/4B/9B/27B using context fit, installed models, live RAM, entitlements, and
explicit overrides. A failed, refused, or degraded local result returns
control to the current host thread; routine fan-out and nested agents are
forbidden.

Codex receives a hard `multi_agent=false` setting plus bounded Terra/low
fallback values. Gemini CLI receives `experimental.enableAgents=false`.
Claude Code's last-resort subagent model is set to Sonnet. Cursor and Claude
Desktop do not expose a supported global subagent-policy file, so their policy
is delivered through MCP initialize instructions. This is one workflow
contract with the strongest enforcement each host supports.

### Configure the real first-turn greeting

Open the Prism dashboard and set these values before reconnecting hosts:

1. **Settings → Agent Identity → Agent Name** — the developer display name.
2. **Settings → Agent Identity → Default Role** — the role shown with the name;
   it falls back to `global` when unset.
3. **Settings → Context Depth** — `quick`, `standard`, or `deep`.
4. **Settings → Boot Settings → Auto-Load Projects** — the projects whose
   handoff and ledger state belong in the greeting.

Then close the hosts and run:

```bash
prism connect --all --refresh
```

`prism connect` synchronizes the authoritative Synalux subscription-tier skill
manifest before it updates the native host instructions. On the first user turn
(including `hi`), the host calls `session_bootstrap({})` exactly once. The tool
returns one ready-to-display block with Agent Identity, depth-scoped project
state, Session Version, and a Prism System Ready status built from the actual
provisioned manifest. It does not use host lifecycle hooks.

Claude, Gemini, Cursor, Codex, and other third-party models still control their
final chat rendering, so verbatim relay is best-effort there. A Prism-owned
surface can render the block deterministically. To inspect the exact canonical
output independently of a host, run:

```bash
prism bootstrap
```

### Codex

Run `prism connect --host codex` to add Prism to Codex's shared
`~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). Prism preserves the
existing TOML byte-for-byte and appends only a marked block that it can safely
refresh later. If `CODEX_HOME` is set, that directory must already exist.
After registration and skill synchronization succeed, Prism also installs or
refreshes its ownership-marked, hook-free startup block in
`$CODEX_HOME/AGENTS.md` (falling back to `~/.codex/AGENTS.md`). User content,
symlink targets, permissions, and newline style are preserved; ambiguous
ownership markers or concurrent edits fail loud.
Codex CLI, the IDE extension, and the ChatGPT desktop app share
this configuration. Restart the active client after connecting, then run
`codex mcp list` to verify the registration. See the
[official Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp) for the
underlying configuration contract.

The free tier needs **no account, no API key, and no cloud**. Memory is stored in a local
SQLite database at `~/.prism-mcp/data.db`. A dashboard launches automatically at
`http://localhost:3000` (configurable via `PRISM_DASHBOARD_PORT`).

---

## 2. Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS),
`%APPDATA%\Claude\claude_desktop_config.json` (Windows), or
`${XDG_CONFIG_HOME:-~/.config}/Claude/claude_desktop_config.json` (Linux):

```json
{
  "mcpServers": {
    "prism": {
      "command": "npx",
      "args": ["-y", "prism-mcp-server"]
    }
  }
}
```

Restart Claude Desktop. You should see the Prism tools in the tool picker (hammer icon).

Claude Desktop does not expose a supported global filesystem instruction file.
Its unattended hook-free startup request therefore comes from the Prism MCP
server instructions and `session_bootstrap` tool metadata. Context loading is
deterministic, but the visible verbatim relay remains controlled by Claude
Desktop.

### With environment variables

```json
{
  "mcpServers": {
    "prism": {
      "command": "npx",
      "args": ["-y", "prism-mcp-server"],
      "env": {
        "BRAVE_API_KEY": "BSA...",
        "GOOGLE_API_KEY": "AIza...",
        "PRISM_DASHBOARD_PORT": "3333"
      }
    }
  }
}
```

### With cloud storage (paid tier)

```json
{
  "mcpServers": {
    "prism": {
      "command": "npx",
      "args": ["-y", "prism-mcp-server"],
      "env": {
        "PRISM_SYNALUX_API_KEY": "synalux_sk_...",
        "PRISM_SYNALUX_BASE_URL": "https://synalux.ai"
      }
    }
  }
}
```

### Multi-user (shared machine)

Set `PRISM_USER_ID` to isolate each user's memory:

```json
{
  "mcpServers": {
    "prism": {
      "command": "npx",
      "args": ["-y", "prism-mcp-server"],
      "env": {
        "PRISM_USER_ID": "alice"
      }
    }
  }
}
```

### MCP features available in Claude Desktop

| Feature | How to access |
|---------|---------------|
| Tools | Hammer icon → search "prism" or "session" |
| `/resume_session` prompt | Slash-command menu |
| `memory://project/handoff` resource | Paperclip → attach resource |
| Resource subscriptions | Automatic — handoff updates push to attached resources |

---

## 3. Claude Code (CLI)

The recommended setup is:

```bash
prism connect --host claude-code
```

After registration and native skill synchronization succeed, Prism installs
its marked first-turn startup block in Claude Code's canonical global
instruction file, `~/.claude/CLAUDE.md`. An older Prism-managed block in
`~/CLAUDE.md` is then removed without changing any unrelated instructions.
Prism leaves the old block in place if canonical installation fails.

Claude Code's model still owns the final assistant message. The managed block
and MCP metadata require the complete startup display, but hook-free MCP cannot
force a third-party host to relay tool output verbatim. Registration and
context loading are deterministic; the visible verbatim greeting is
best-effort unless a host lifecycle integration or Prism-owned surface is used.

For a user-wide registration, add the server with Claude Code's CLI:

```bash
claude mcp add --transport stdio --scope user prism -- npx -y prism-mcp-server
```

The equivalent user configuration is stored under `mcpServers` in
`~/.claude.json`. For a shared project registration, use `.mcp.json` in the
project root instead:

```json
{
  "mcpServers": {
    "prism": {
      "command": "npx",
      "args": ["-y", "prism-mcp-server"],
      "env": {
        "PRISM_DASHBOARD_PORT": "3333"
      }
    }
  }
}
```

Or add it to the current project with the default local scope:

```bash
claude mcp add prism -- npx -y prism-mcp-server
```

Claude Code will detect and use Prism tools automatically. Use `ToolSearch` to find
specific tools by name (e.g., `select:mcp__prism__session_bootstrap`).

---

## 4. Cursor

Open **Settings → MCP Servers** (or edit `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "prism": {
      "command": "npx",
      "args": ["-y", "prism-mcp-server"],
      "env": {
        "PRISM_DASHBOARD_PORT": "3333"
      }
    }
  }
}
```

Restart Cursor. Prism tools appear in the Composer tool list.

During `prism connect`, the synchronized manifest is materialized in the shared
`~/.agents/skills` root and mirrored into Cursor's native `~/.cursor/skills`
root. An exact symlink between those roots is supported. Prism preserves
user-owned or locally modified conflicts and fails loud instead of overwriting
them.

---

## 5. Windsurf

Open **Settings → MCP** and add:

```json
{
  "mcpServers": {
    "prism": {
      "command": "npx",
      "args": ["-y", "prism-mcp-server"]
    }
  }
}
```

Or edit the Windsurf MCP config file directly (location depends on OS).

---

## 6. VS Code

### With Cline extension

Edit `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "prism": {
      "command": "npx",
      "args": ["-y", "prism-mcp-server"],
      "env": {
        "PRISM_DASHBOARD_PORT": "3333"
      }
    }
  }
}
```

### With Continue extension

Edit `~/.continue/config.json` and add to the `mcpServers` array:

```json
{
  "mcpServers": [
    {
      "name": "prism",
      "command": "npx",
      "args": ["-y", "prism-mcp-server"]
    }
  ]
}
```

### With GitHub Copilot (MCP support)

If using Copilot with MCP tool support, add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "prism": {
      "command": "npx",
      "args": ["-y", "prism-mcp-server"]
    }
  }
}
```

### Synalux VS Code Extension

A standalone extension with built-in Prism integration:

```bash
code --install-extension synalux-ai.synalux
```

Includes AI chat (`@synalux`), voice input, SOAP note generator, and team collaboration.
Routes through local Ollama by default; cloud on paid tiers.

---

## 7. JetBrains IDEs

JetBrains IDEs with MCP support (IntelliJ, WebStorm, PyCharm, etc.):

Edit `.idea/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "prism": {
      "command": "npx",
      "args": ["-y", "prism-mcp-server"]
    }
  }
}
```

Or configure via **Settings → Tools → MCP Servers**.

---

## 8. Custom / Headless

### Direct stdio

Run the server directly and pipe JSON-RPC over stdin/stdout:

```bash
npx prism-mcp-server
```

### Programmatic (Node.js)

```javascript
import { spawn } from 'child_process';
const proc = spawn('npx', ['-y', 'prism-mcp-server'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, PRISM_DASHBOARD_PORT: '3333' }
});
// Send JSON-RPC messages to proc.stdin, read from proc.stdout
```

### CLI (no MCP client needed)

```bash
prism bootstrap               # canonical first-turn greeting and context
prism load <project>          # load session context
prism load <project> --json   # machine-readable output
prism verify                  # behavioral verification status
```

Install globally: `npm install -g prism-mcp-server`

---

## 9. Dashboard Access

The Mind Palace dashboard launches automatically alongside the MCP server.

| Setting | Default | Notes |
|---------|---------|-------|
| Port | `3000` | Override with `PRISM_DASHBOARD_PORT` |
| URL | `http://localhost:3000` | |
| Auth | Disabled | See below for auth options |

Open `http://localhost:3000` (or your configured port) in a browser.

The startup display reads Agent Name, Default Role, Context Depth, and Auto-Load
Projects from this dashboard. Do not hardcode a project or depth in host rules;
use `session_bootstrap({})` (or `prism bootstrap`) so dashboard changes apply to
every connected agent on its next conversation.

### Securing the dashboard

**Basic Auth** — add to your MCP config env:

```json
"env": {
  "PRISM_DASHBOARD_USER": "admin",
  "PRISM_DASHBOARD_PASS": "your-password"
}
```

**JWT / JWKS** — for SSO (Auth0, Cognito, Keycloak):

```json
"env": {
  "PRISM_JWKS_URI": "https://your-tenant.auth0.com/.well-known/jwks.json",
  "PRISM_JWT_AUDIENCE": "prism-dashboard",
  "PRISM_JWT_ISSUER": "https://your-tenant.auth0.com/"
}
```

### Port conflicts

If port 3000 is busy (e.g., a dev server), the dashboard disables itself gracefully —
the MCP server keeps running. Set a different port:

```json
"env": { "PRISM_DASHBOARD_PORT": "3333" }
```

---

## 10. Environment Variables

### Minimal (free, fully local)

No env vars needed. Everything runs on-device with local SQLite.

### Recommended (free + search)

```json
"env": {
  "BRAVE_API_KEY": "BSA...",
  "PRISM_DASHBOARD_PORT": "3333"
}
```

### Full (paid tier)

```json
"env": {
  "PRISM_SYNALUX_API_KEY": "synalux_sk_...",
  "PRISM_SYNALUX_BASE_URL": "https://synalux.ai",
  "PRISM_DASHBOARD_PORT": "3333"
}
```

### All variables

See the full reference in [ARCHITECTURE.md — Configuration Reference](ARCHITECTURE.md#13-configuration-reference).

---

## 11. Local Model Setup (Ollama)

Prism ships open-weight models for offline tool-routing. Install [Ollama](https://ollama.com),
then pull whichever fits your hardware:

```bash
ollama pull dcostenco/prism-coder:2b     # 2.3 GB — mobile / lightweight (99.1% accuracy)
ollama pull dcostenco/prism-coder:4b     # 3.4 GB — balanced (100% accuracy)
ollama pull dcostenco/prism-coder:14b    # 8.4 GB — Mac default (100% accuracy)
ollama pull dcostenco/prism-coder:32b    # 16 GB  — complex tasks (100% accuracy)
```

Prism auto-detects running Ollama models. No configuration needed — `prism_infer`
picks the best available model automatically.

### Remote Ollama (e.g., another machine on LAN)

```bash
# On the Ollama host:
OLLAMA_HOST=0.0.0.0 ollama serve

# In your MCP config:
"env": {
  "LOCAL_LLM_URL": "http://192.168.1.100:11434"
}
```

---

## 12. Troubleshooting

### "Tools not showing up"

1. Restart your MCP client after config changes
2. Check the config JSON syntax — a trailing comma breaks parsing
3. Verify `npx -y prism-mcp-server` runs without errors in a terminal
4. Check for port conflicts if dashboard is needed

### "Dashboard not loading"

1. Check `PRISM_DASHBOARD_PORT` isn't in use: `lsof -i :3000`
2. Try a different port: `"PRISM_DASHBOARD_PORT": "3333"`
3. Check stderr output for `EADDRINUSE` messages

### "Permission denied on npx"

On some systems, `npx` needs explicit path. Use the full path:

```json
{
  "command": "/usr/local/bin/npx",
  "args": ["-y", "prism-mcp-server"]
}
```

Or install globally and use the binary directly:

```bash
npm install -g prism-mcp-server
```

Then in config:

```json
{
  "command": "prism-mcp-server"
}
```

### "Storage errors"

- Default storage is local SQLite at `~/.prism-mcp/data.db` — no config needed
- If using Supabase/Synalux and getting errors, set `PRISM_FORCE_LOCAL=true` to verify
  it's a storage issue vs. something else
- Enable debug logging: `"PRISM_DEBUG_LOGGING": "true"`

### "Multiple Prism instances"

Each MCP client spawns its own server process. The dashboard port can only be used by
one instance. Set different `PRISM_DASHBOARD_PORT` values per client, or accept that
only the first instance gets a dashboard (the MCP server itself works fine without it).

### Logs

Prism logs to stderr (stdout is reserved for MCP JSON-RPC). Enable verbose logging:

```json
"env": { "PRISM_DEBUG_LOGGING": "true" }
```

---

*Prism Coder IDE Setup Guide — v19.0.0 — June 2026*
