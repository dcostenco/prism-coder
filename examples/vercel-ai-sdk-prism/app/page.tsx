'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useState } from 'react';

/**
 * Minimal chat UI — no styling library, just inline styles, so the
 * example boots with zero extra deps. The interesting part is the
 * server route at app/api/chat/route.ts which loads Prism memory
 * before each turn and saves a ledger entry after.
 */
export default function Page() {
  const [input, setInput] = useState('');
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });
  const isLoading = status === 'streaming' || status === 'submitted';

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    sendMessage({ text: trimmed });
    setInput('');
  }

  return (
    <main style={{ maxWidth: 720, margin: '40px auto', padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, marginBottom: 4 }}>Prism MCP × Vercel AI SDK</h1>
        <p style={{ color: '#666', fontSize: 14, margin: 0 }}>
          Each turn loads project memory from <code>session_load_context</code> and persists
          via <code>session_save_ledger</code> after the stream finishes.
        </p>
      </header>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
        {messages.length === 0 && (
          <p style={{ color: '#999', fontStyle: 'italic' }}>
            Try asking: &ldquo;What did we work on yesterday?&rdquo; — if Prism has
            history for project <code>vercel-ai-sdk-demo</code>, the assistant will recall it.
          </p>
        )}
        {messages.map((m) => {
          const text = m.parts
            ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
            .join('') ?? '';
          return (
            <div
              key={m.id}
              style={{
                padding: 12,
                borderRadius: 8,
                background: m.role === 'user' ? '#f0f0f0' : '#e8f4ff',
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '85%',
              }}
            >
              <strong style={{ fontSize: 12, color: '#666' }}>
                {m.role === 'user' ? 'You' : 'Assistant'}
              </strong>
              <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{text}</div>
            </div>
          );
        })}
      </section>

      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask anything…"
          style={{
            flex: 1, padding: 12, border: '1px solid #ddd', borderRadius: 8, fontSize: 16,
          }}
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          style={{
            padding: '12px 20px', border: 0, borderRadius: 8, fontSize: 16,
            background: '#0070f3', color: 'white', cursor: 'pointer',
            opacity: isLoading || !input.trim() ? 0.5 : 1,
          }}
        >
          {isLoading ? 'Thinking…' : 'Send'}
        </button>
      </form>
    </main>
  );
}
