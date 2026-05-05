# Prism MCP × Vercel AI SDK

A minimal Next.js + Vercel AI SDK chat app that uses **Prism MCP** as its memory backend.
Each turn loads project memory before the LLM call and saves a one-line ledger entry after.

Targets **Vercel AI SDK v5** (`ai@^5`, `@ai-sdk/react@^2`). For the older v4 surface
(`useChat` from `'ai/react'`, `toDataStreamResponse`), see git history before this directory's first commit.

## What you get

- Next.js 15 App Router + Vercel AI SDK 5 streaming chat (`app/api/chat/route.ts`)
- A 70-line MCP client wrapper for Prism (`lib/prism-client.ts`) — only `session_load_context` and `session_save_ledger`, no extra ceremony
- A 60-line `useChat` UI page (`app/page.tsx`) using the v5 `sendMessage` + `DefaultChatTransport` API

That's it. ~150 lines of glue. Drop into your own AI SDK app to make any chat session memory-aware.

## Quick start (5 commands)

```bash
cd examples/vercel-ai-sdk-prism
cp .env.example .env.local        # add your OPENAI_API_KEY
npm install
npm run dev
# → open http://localhost:3000
```

The Prism MCP server is auto-spawned via `npx -y prism-mcp-server` (see `lib/prism-client.ts`). No separate process to manage.

## How it works

```
  ┌──────────────────────────────────────┐
  │  Browser — useChat() (app/page.tsx)  │
  └──────────────────────────────────────┘
                  │  POST /api/chat
                  ▼
  ┌──────────────────────────────────────┐
  │  app/api/chat/route.ts               │
  │  ┌────────────────────────────────┐  │
  │  │ 1. loadProjectContext(project) │  │  ← Prism MCP
  │  │    via session_load_context    │  │
  │  └────────────────────────────────┘  │
  │  ┌────────────────────────────────┐  │
  │  │ 2. streamText(openai(...))     │  │  ← Vercel AI SDK
  │  │    system = memory + base      │  │
  │  └────────────────────────────────┘  │
  │  ┌────────────────────────────────┐  │
  │  │ 3. onFinish:                   │  │
  │  │    saveTurnToLedger(...)       │  │  ← Prism MCP
  │  └────────────────────────────────┘  │
  └──────────────────────────────────────┘
```

**Recall before, persist after.** Memory load happens before the model call so the LLM
sees the project's recent decisions, open TODOs, and last summary as part of its system
prompt. Save happens in `onFinish` so it doesn't add latency to the streamed response.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `OPENAI_API_KEY` | _(required)_ | Used by `@ai-sdk/openai`. Swap providers by editing one line in `route.ts`. |
| `PRISM_PROJECT` | `vercel-ai-sdk-demo` | Namespace for Prism memory. Different deployments can share a namespace to share memory. |

## Swap the model provider

The route uses `openai('gpt-4o-mini')`. To switch to Anthropic Claude:

```bash
npm install @ai-sdk/anthropic
```

```ts
// app/api/chat/route.ts
import { anthropic } from '@ai-sdk/anthropic';
// ...
const result = streamText({
  model: anthropic('claude-sonnet-4-6'),
  system: systemPrompt,
  messages: convertToModelMessages(messages),
  onFinish: ...,
});
```

Same pattern works for `@ai-sdk/google`, `@ai-sdk/mistral`, etc.

## Use a local Prism checkout

By default `lib/prism-client.ts` runs `npx -y prism-mcp-server` (the published bin). To
develop against the local repo:

```ts
// lib/prism-client.ts — change StdioClientTransport args
const transport = new StdioClientTransport({
  command: 'node',
  args: ['../../dist/server.js'],   // or wherever your built server lives
});
```

Then `npm run build` in the prism root before each iteration.

## Beyond this example

Once you're comfortable with `load_context` + `save_ledger`, the full Prism MCP API
adds search, knowledge graph, image memory, multi-agent registry, and more:

- `session_search_memory` — semantic search across all memories
- `session_save_handoff` — preserve "what's next" between sessions
- `knowledge_search` — graph-based retrieval over decisions and rules
- `session_save_image` — visual memory (screenshots, diagrams)
- `agent_register` / `agent_heartbeat` — multi-agent coordination

See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for the full picture.

## See also

- [`examples/langgraph-ts/`](../langgraph-ts/) — same idea, but the agent loop is LangGraph
- [`examples/langgraph-agent/`](../langgraph-agent/) — Python LangGraph version
- [`examples/multi-agent-hivemind/`](../multi-agent-hivemind/) — multiple agents sharing memory via the registry
