# Multi-Agent Hivemind Example

Run two AI agents (Dev + QA) on the same project with role-isolated memory and real-time coordination.

## How It Works

```
┌─────────────────┐     ┌─────────────────┐
│  Agent A (Dev)  │     │  Agent B (QA)   │
│  Claude Code    │     │  Cursor          │
└────────┬────────┘     └────────┬────────┘
         │ stdio                  │ stdio
         ▼                        ▼
┌─────────────────────────────────────────┐
│          Prism MCP Server               │
│                                         │
│  ┌───────────┐  ┌───────────────────┐   │
│  │ Hivemind  │  │ Shared Storage    │   │
│  │ Registry  │  │ (SQLite/Supabase) │   │
│  └───────────┘  └───────────────────┘   │
│                                         │
│  Telepathy: broadcast on save/complete  │
│  Watchdog: stale→frozen→offline pruning │
└─────────────────────────────────────────┘
```

## Setup

### Agent A — Developer (Claude Code)

**`.claude/mcp.json`** or **`claude_desktop_config.json`**:

```json
{
  "mcpServers": {
    "prism-mcp": {
      "command": "npx",
      "args": ["-y", "prism-mcp-server"],
      "env": {
        "PRISM_ENABLE_HIVEMIND": "true",
        "PRISM_INSTANCE": "dev-agent"
      }
    }
  }
}
```

**`.clauderules`** (or system prompt):

```markdown
You are the **Dev** agent on the `my-project` team.

On session start:
1. Call `session_load_context(project='my-project', level='deep', role='dev')`
2. Call `agent_register(project='my-project', role='dev', capabilities='["coding","architecture","debugging"]')`

Every ~5 minutes during active work:
- Call `agent_heartbeat(project='my-project', role='dev', current_task='<what you are doing>')`

On session end:
- Call `session_save_ledger(project='my-project', role='dev', ...)`
- Call `session_save_handoff(project='my-project', role='dev', ...)`
```

### Agent B — QA Engineer (Cursor)

**`.cursor/mcp.json`**:

```json
{
  "mcpServers": {
    "prism-mcp": {
      "command": "npx",
      "args": ["-y", "prism-mcp-server"],
      "env": {
        "PRISM_ENABLE_HIVEMIND": "true",
        "PRISM_INSTANCE": "qa-agent"
      }
    }
  }
}
```

**System prompt** (Cursor rules):

```markdown
You are the **QA** agent on the `my-project` team.

On session start:
1. Call `session_load_context(project='my-project', level='standard', role='qa')`
2. Call `agent_register(project='my-project', role='qa', capabilities='["testing","review","validation"]')`

Every ~5 minutes:
- Call `agent_heartbeat(project='my-project', role='qa', current_task='<what you are doing>')`

On session end:
- Call `session_save_ledger(project='my-project', role='qa', ...)`
- Call `session_save_handoff(project='my-project', role='qa', ...)`
```

## Key Configuration

| Variable | Purpose |
|---|---|
| `PRISM_ENABLE_HIVEMIND` | **Required.** Enables agent registration, heartbeat, and team roster tools. |
| `PRISM_INSTANCE` | **Recommended.** Unique name per agent instance to prevent PID lock conflicts when running multiple agents on the same machine. |
| `role` parameter | Passed to `session_load_context`, `session_save_ledger`, `session_save_handoff`, and `agent_register`. Scopes memory by role so Dev and QA don't overwrite each other's handoff state. |

## What Happens at Runtime

1. **Registration** — Each agent calls `agent_register` on startup. The Hivemind registry tracks all active agents per project.

2. **Team Awareness** — When Agent A calls `session_load_context`, it receives the active team roster:
   ```
   🐝 Active Team: dev (you), qa (writing integration tests)
   ```

3. **Telepathy Broadcasts** — When Agent B saves a ledger entry, a Telepathy notification is injected into Agent A's next tool response:
   ```
   📡 Telepathy from qa: "Found 3 failing edge cases in the auth module"
   ```

4. **Watchdog Monitoring** — If Agent B stops sending heartbeats:
   - After 5 min → marked `STALE`
   - After 15 min → marked `FROZEN`
   - After 30 min → auto-pruned `OFFLINE`

5. **CRDT Merging** — If both agents save handoff state simultaneously, Prism's CRDT OR-Map engine auto-merges (add-wins for arrays like `open_todos`, last-writer-wins for scalars like `last_summary`).

## Dashboard View

Open `http://localhost:3000` to see the **Hivemind Radar** panel:
- Active agent roster with roles, tasks, and heartbeat timestamps
- Color-coded health indicators: 🟢 Active, 🟡 Stale, 🔴 Frozen, ⏰ Overdue, 🔄 Looping
- Loop detection badges (if an agent repeats the same task 5+ times)

## Cloud Sync (Optional)

For agents on different machines, add Supabase to both configs:

```json
{
  "env": {
    "PRISM_STORAGE": "supabase",
    "SUPABASE_URL": "https://your-project.supabase.co",
    "SUPABASE_KEY": "your-service-role-key",
    "PRISM_ENABLE_HIVEMIND": "true",
    "PRISM_INSTANCE": "dev-agent"
  }
}
```

Both agents share the same Supabase project. Role-scoped memory + CRDT merging ensures conflict-free coordination across machines.
