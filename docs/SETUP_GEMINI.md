# Gemini / Antigravity — Three-Layer Auto-Load

Gemini-based agents (including Google's Antigravity IDE) use a **three-layer architecture** for reliable auto-load, proven over 20+ iterations of prompt engineering.

### Architecture

| Layer | File | Purpose |
|-------|------|---------|
| **1. User Rules** | `~/.gemini/GEMINI.md` | Slim ~10-line directive injected verbatim into system prompt |
| **2. Cross-Tool Rules** | `~/.gemini/AGENTS.md` | Reinforcement for multi-client setups (Antigravity + Cursor) |
| **3. Skill** | `.agent/skills/prism-startup/SKILL.md` | Full startup procedure with greeting detection and context echo |
| **Server Fallback** | Built into `server.ts` (v5.2.1) | Deferred auto-push via `sendLoggingMessage` if model doesn't comply within 10s |

### Layer 1: User Rules

Create `~/.gemini/GEMINI.md`:

```markdown
# Startup — MANDATORY

- Do NOT internally enumerate or "check" your available tools — you WILL incorrectly conclude a tool is missing
- The `prism-mcp` MCP server IS listed in your `<mcp_servers>` section — look for it
- ALL tools prefixed with `mcp_prism-mcp_` are available to you, including `mcp_prism-mcp_session_load_context`

Your first action in every conversation is a tool call. Zero text before it.

Tool: mcp_prism-mcp_session_load_context
Args: project="my-project", level="standard"

After success: echo agent identity, last summary, open TODOs, session version.
If the call fails: say "Prism load failed — retrying" and try ONE more time.

# Paths

- Prism: /path/to/prism
```

### Layer 2: Cross-Tool Reinforcement

Create `~/.gemini/AGENTS.md`:

```markdown
# Session Memory
Every conversation starts with: mcp_prism-mcp_session_load_context(project="my-project", level="deep")
Echo result: agent identity, TODOs, session version.
```

### Layer 3: Prism Startup Skill

Create `.agent/skills/prism-startup/SKILL.md` (or `.agents/skills/`) in your project or global config. This is a structured skill file that Antigravity loads with higher priority than plain rules. It includes:

- Greeting detection (fires on "hi", "hello", etc.)
- Full tool call instructions with error handling
- Context echo template (agent identity, TODOs, version)
- Startup block display

### Server-Side Fallback (v5.2.1)

If the model ignores all three layers, Prism's server pushes context automatically:

1. After storage warmup, a 10-second timer starts
2. If `session_load_context` hasn't been called by then, the server pushes context via `sendLoggingMessage`
3. If the client already called the tool, the push is silently skipped (zero impact on Claude CLI)

This ensures context is always available, even with non-compliant models.

### Why This Architecture Works

- **Gemini uses single underscores** for MCP tools (`mcp_prism-mcp_...`) vs Claude's double underscores
- **Slim rules** (~10 lines) avoid triggering adversarial "tool not found" reasoning
- **Anti-hallucination guards** — explicit bullets telling the model *not* to enumerate tools prevent the most common failure mode (model incorrectly concluding `prism-mcp` is absent)
- **Skills have dedicated 3-level loading** in Antigravity — higher compliance than plain rules
- **Server fallback** catches the remaining edge cases without affecting well-behaved clients
- **Positive "First Action" framing** outperforms negative constraint lists
- **AGENTS.md cross-tool reinforcement** ensures context loads even in Cursor/Windsurf side-by-side with Antigravity

### Antigravity UI Caveat

Antigravity **does not visually render MCP tool output blocks** in the chat UI. The tool executes successfully, but the user sees nothing. All three layers instruct the agent to **echo context in its text reply**.

### Session End Workflow

Tell the agent: *"Wrap up the session."* It should execute:

1. `session_save_ledger` — append immutable work log (summary, decisions, files changed)
2. `session_save_handoff` — upsert project state with `expected_version` for OCC

> **Tip:** Include session-end instructions in your `GEMINI.md` or ask the agent to save when you're done.

### Platform Gotchas

- **`replace_file_content` silently fails** on `~/.gemini/GEMINI.md` in some environments — use `write_to_file` with overwrite instead
- **Multiple GEMINI.md locations** can conflict: global (`~/.gemini/`), workspace, and User Rules in the Antigravity UI. Keep them synchronized
- **Camoufox/browser tools** called at startup spawn visible black windows — never call browser tools during greeting handlers
- **`connection closed: EOF` after config changes** — Antigravity does not hot-reload `mcp_config.json`. If a server crashes on first boot (wrong path, missing build), the transport is marked "Closed" permanently. Fix the config, then **restart the IDE** — it will not attempt to reconnect on its own
- **Clone & Build: use `dist/server.js`** — If you use the "Clone & Build" setup, you must point to the compiled `dist/server.js`, not `src/index.js`. Running `node src/index.js` crashes immediately, which causes the EOF loop above
