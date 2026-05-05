/**
 * Vercel AI SDK 5 + Prism MCP — chat route
 *
 * Each turn:
 *   1. Load the project's working memory from Prism (last summary,
 *      open TODOs, recent decisions) — injected as the system prompt.
 *   2. Stream the LLM response back to the client.
 *   3. After the stream finishes, save a one-line ledger entry so
 *      future turns can recall it.
 *
 * The Prism MCP server runs as a child process (see lib/prism-client.ts).
 * No HTTP, no auth — pure stdio MCP. Memory persists in the same SQLite
 * file the prism-coder CLI uses, so dashboard + IDE see the same state.
 */
import { openai } from '@ai-sdk/openai';
import { streamText, convertToModelMessages, type UIMessage } from 'ai';
import { loadProjectContext, saveTurnToLedger } from '@/lib/prism-client';

export const maxDuration = 60;

const PROJECT = process.env.PRISM_PROJECT || 'vercel-ai-sdk-demo';

export async function POST(req: Request) {
  const { messages, conversationId } = (await req.json()) as {
    messages: UIMessage[];
    conversationId?: string;
  };

  // 1. Memory recall — runs before model call so the LLM gets the
  //    project's working state as context. Best-effort: a Prism blip
  //    degrades to context-free chat, never a 500 to the user.
  let memoryContext = '';
  try {
    memoryContext = await loadProjectContext(PROJECT);
  } catch (err) {
    console.warn('[prism] load_context failed, continuing stateless:', err);
  }

  const systemPrompt = memoryContext
    ? `You have access to persistent project memory from Prism MCP.\n\n${memoryContext}\n\nUse this context when relevant.`
    : 'You are a helpful assistant.';

  const result = streamText({
    model: openai('gpt-4o-mini'),
    system: systemPrompt,
    messages: convertToModelMessages(messages),
    // 2. Persist a tiny ledger entry once the stream completes. onFinish
    //    runs after the body is fully streamed so it doesn't add to
    //    client-perceived latency.
    onFinish: async ({ text }) => {
      // Find the last user turn for the Q half of the summary. UIMessage
      // parts can contain text + tool calls — we just want the text.
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const lastUserText = lastUser?.parts
        ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join(' ') ?? '';
      const summary = lastUserText
        ? `Q: ${lastUserText.slice(0, 120)} | A: ${text.slice(0, 200)}`
        : text.slice(0, 200);
      try {
        await saveTurnToLedger({
          project: PROJECT,
          conversationId: conversationId ?? `web-${Date.now()}`,
          summary,
        });
      } catch (err) {
        console.warn('[prism] save_ledger failed:', err);
      }
    },
  });

  return result.toUIMessageStreamResponse();
}
