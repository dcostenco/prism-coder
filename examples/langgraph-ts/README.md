# Prism MCP — TypeScript LangGraph Agent Example

> A reference implementation showing how to use Prism MCP as the memory backend for a LangGraph agent in TypeScript.

## Overview

This example demonstrates:
1. **MCP Client** — Connect to the Prism MCP server via stdio transport
2. **Memory Retriever** — Custom LangGraph node that searches Prism's semantic memory
3. **Agent Loop** — A LangGraph agent that uses Prism for session persistence

## Prerequisites

```bash
npm install @langchain/core @langchain/langgraph @modelcontextprotocol/sdk
```

## Architecture

```
┌─────────────────────────────────────┐
│  LangGraph Agent (TypeScript)       │
│                                     │
│  ┌──────────┐   ┌────────────────┐  │
│  │ Research  │──▶│ Save to Prism  │  │
│  │ Node      │   │ (ledger save)  │  │
│  └──────────┘   └────────────────┘  │
│       │                              │
│       ▼                              │
│  ┌──────────────────┐               │
│  │ Memory Retriever  │              │
│  │ (search Prism)    │              │
│  └──────────────────┘               │
│       │                              │
│       ▼ MCP stdio                    │
├─────────────────────────────────────┤
│  Prism MCP Server (Node.js)         │
│  session_search_memory              │
│  session_save_ledger                │
│  knowledge_search                   │
└─────────────────────────────────────┘
```

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Run the agent (Prism MCP server must be running)
npx tsx agent.ts
```

## Files

| File | Purpose |
|------|---------|
| `agent.ts` | LangGraph agent with Prism memory nodes |
| `prism-client.ts` | MCP client wrapper for Prism tools |
| `retriever.ts` | LangGraph-compatible memory retriever node |

## Integration Patterns

### Pattern 1: Memory-Augmented Research Agent

The agent searches Prism memory before doing external research, avoiding redundant work:

```typescript
import { PrismMemoryRetriever } from "./retriever";

const retriever = new PrismMemoryRetriever(client, "my-project");
const existing = await retriever.search("auth flow implementation");

if (existing.length > 0) {
  console.log("Found in memory:", existing[0].summary);
} else {
  // Do external research...
}
```

### Pattern 2: Session Persistence

Save research findings back to Prism at the end of each agent run:

```typescript
await client.callTool("session_save_ledger", {
  project: "my-project",
  summary: "Researched OAuth2 PKCE flow for SPA authentication",
  decisions: ["Use PKCE instead of implicit grant"],
  files_changed: ["src/auth/oauth.ts"]
});
```

### Pattern 3: Self-Improving Loop

Record corrections as behavioral events:

```typescript
await client.callTool("session_save_experience", {
  project: "my-project",
  event_type: "correction",
  context: "Building auth module",
  action: "Used localStorage for tokens",
  outcome: "XSS vulnerability",
  correction: "Always use httpOnly cookies for auth tokens"
});
```

## See Also

- [Python LangGraph Example](../langgraph-agent/) — Full Python implementation
- [Vercel AI SDK Example](../vercel-ai-sdk-prism/) — Streaming chat + Prism memory in a Next.js App Router app
- [Architecture Guide](../../docs/ARCHITECTURE.md) — How Prism's memory system works
- [Self-Improving Agent Guide](../../docs/self-improving-agent.md) — Building agents that learn
