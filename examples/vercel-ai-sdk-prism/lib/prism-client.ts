/**
 * Minimal Prism MCP client — Vercel AI SDK example
 *
 * Wraps just the two tools this example needs: load_context (read
 * memory before a chat turn) and save_ledger (persist the turn after
 * the model responds). Same MCP stdio pattern as examples/langgraph-ts —
 * see prism-client.ts there for a fuller wrapper.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let cached: Promise<Client> | null = null;

/**
 * Spawn the Prism MCP server as a child process and return a connected
 * Client. Cached as a module-level singleton so we don't fork a new
 * server per request — Vercel route handlers re-enter on every chat
 * turn and we don't want N children racing on the same SQLite file.
 */
export function getPrismClient(): Promise<Client> {
  if (cached) return cached;

  cached = (async () => {
    // npx prism-coder = the published MCP server bin from package.json.
    // For local dev against a checkout, swap to:
    //   command: 'node', args: ['../../dist/server.js']
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', 'prism-mcp-server'],
    });
    const client = new Client(
      { name: 'vercel-ai-sdk-prism-example', version: '0.1.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    return client;
  })();

  return cached;
}

export async function loadProjectContext(project: string): Promise<string> {
  const client = await getPrismClient();
  const result = await client.callTool({
    name: 'session_load_context',
    arguments: { project, level: 'standard' },
  });
  // MCP returns content as an array of text/image parts. We join the
  // text parts — tools.search results, summaries, open TODOs are all
  // already text-formatted by the server.
  const parts = (result.content as Array<{ type: string; text?: string }>) ?? [];
  return parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text!)
    .join('\n');
}

export interface SaveLedgerInput {
  project: string;
  conversationId: string;
  summary: string;
  decisions?: string[];
  todos?: string[];
}

export async function saveTurnToLedger(input: SaveLedgerInput): Promise<void> {
  const client = await getPrismClient();
  await client.callTool({
    name: 'session_save_ledger',
    arguments: {
      project: input.project,
      conversation_id: input.conversationId,
      summary: input.summary,
      decisions: input.decisions ?? [],
      todos: input.todos ?? [],
    },
  });
}
