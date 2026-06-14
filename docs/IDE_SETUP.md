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

Every client needs the same thing: tell it to run `npx -y prism-mcp-server` over stdio.

The free tier needs **no account, no API key, and no cloud**. Memory is stored in a local
SQLite database at `~/.prism-mcp/data.db`. A dashboard launches automatically at
`http://localhost:3000` (configurable via `PRISM_DASHBOARD_PORT`).

---

## 2. Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

Add to `.claude/settings.json` in your project root (or `~/.claude/settings.json` for global):

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

Or add it with the CLI:

```bash
claude mcp add prism -- npx -y prism-mcp-server
```

Claude Code will detect and use Prism tools automatically. Use `ToolSearch` to find
specific tools by name (e.g., `select:mcp__prism__session_load_context`).

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
