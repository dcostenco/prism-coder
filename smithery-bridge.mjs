/**
 * Smithery Bridge — lightweight reverse proxy that:
 *   1. Serves /.well-known/mcp/server-card.json (static, for Smithery catalog)
 *   2. Serves /healthz
 *   3. Proxies everything else to supergateway (running on internal port 8001)
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PUBLIC_PORT = parseInt(process.env.PORT || '8000', 10);
const GATEWAY_PORT = 8001;
const HTTP_TOKEN = process.env.PRISM_MCP_HTTP_TOKEN || '';

// Constant-time token comparison — HMAC both sides with a per-process
// random key so timingSafeEqual never throws on length mismatch and
// leaks neither the token's contents nor its length.
const TOKEN_COMPARE_KEY = randomBytes(32);
function constantTimeEqual(a, b) {
  const da = createHmac('sha256', TOKEN_COMPARE_KEY).update(String(a)).digest();
  const db = createHmac('sha256', TOKEN_COMPARE_KEY).update(String(b)).digest();
  return timingSafeEqual(da, db);
}

// --- Server Card (static metadata for Smithery) ---
const serverCard = {
  serverInfo: {
    name: 'prism-mcp-server',
    version: '7.5.0',
    description:
      'The Mind Palace for AI Agents — persistent memory, ACT-R cognitive retrieval, Dark Factory autonomous pipelines, behavioral learning, multi-agent Hivemind, time travel, visual dashboard.',
  },
  authentication: { required: true, type: 'bearer' },
  tools: [
    { name: 'session_load_context', description: 'Load session context for a project using progressive context loading.' },
    { name: 'session_save_ledger', description: 'Save an immutable session log entry to the session ledger.' },
    { name: 'session_save_handoff', description: 'Upsert the latest project handoff state for the next session.' },
    { name: 'session_search_memory', description: 'Search session history semantically using vector embeddings.' },
    { name: 'knowledge_search', description: 'Search accumulated knowledge across all sessions by keywords or free text.' },
    { name: 'session_save_experience', description: 'Record typed experience events for behavioral pattern detection.' },
    { name: 'session_compact_ledger', description: 'Auto-compact old session entries into AI-generated summaries.' },
    { name: 'session_health_check', description: 'Run integrity checks on agent memory.' },
    { name: 'session_forget_memory', description: 'Forget a specific memory entry by ID (soft/hard delete).' },
    { name: 'session_export_memory', description: 'Export project memory to JSON, Markdown, or Obsidian vault.' },
    { name: 'session_task_route', description: 'Analyze a task and recommend host vs local agent routing.' },
    { name: 'session_cognitive_route', description: 'Resolve HDC compositional state into nearest semantic concept.' },
    { name: 'session_synthesize_edges', description: 'Discover semantic relationships between disconnected memory nodes.' },
    { name: 'session_start_pipeline', description: 'Start a Dark Factory autonomous pipeline.' },
    { name: 'brave_web_search', description: 'Web search using Brave Search API.' },
    { name: 'brave_answers', description: 'Direct AI answers grounded in Brave Search.' },
    { name: 'knowledge_forget', description: 'Selectively forget accumulated knowledge entries.' },
    { name: 'memory_history', description: 'View timeline of past memory states for a project.' },
    { name: 'memory_checkout', description: 'Time travel — restore project memory to a past version.' },
    { name: 'deep_storage_purge', description: 'Purge float32 vectors for entries with TurboQuant compressed blobs.' },
  ],
  resources: [],
  prompts: [],
};

const serverCardJSON = JSON.stringify(serverCard, null, 2);

// --- Start supergateway on internal port ---
// SECURITY NOTE: supergateway has no --host flag and ignores HOST env;
// it binds 0.0.0.0:GATEWAY_PORT. The proxy below enforces auth on all
// inbound requests. On Railway/Docker, only PUBLIC_PORT is routed
// externally — GATEWAY_PORT is container-internal. If deploying where
// 8001 is reachable from other hosts, add a firewall rule or use
// Railway private networking to restrict access.
const gateway = spawn(
  'npx', ['-y', 'supergateway',
    '--stdio', 'node dist/server.js',
    '--port', String(GATEWAY_PORT),
    '--healthEndpoint', '/healthz',
    '--cors'],
  { stdio: 'inherit', shell: true }
);

gateway.on('error', (err) => {
  console.error('supergateway failed to start:', err);
  process.exit(1);
});

// --- Public-facing proxy server ---
const server = http.createServer((req, res) => {
  // Static server card
  if (req.url === '/.well-known/mcp/server-card.json') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(serverCardJSON);
    return;
  }

  // Health check (fast local response)
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // --- Auth enforcement (all routes below require a valid bearer token) ---
  if (!HTTP_TOKEN) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Service unavailable: PRISM_MCP_HTTP_TOKEN not configured');
    return;
  }

  const authHeader = req.headers['authorization'] || '';
  if (!constantTimeEqual(authHeader, `Bearer ${HTTP_TOKEN}`)) {
    res.writeHead(401, {
      'Content-Type': 'text/plain',
      'WWW-Authenticate': 'Bearer',
    });
    res.end('Unauthorized');
    return;
  }

  // Proxy everything else to supergateway
  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: GATEWAY_PORT,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    }
  );

  proxyReq.on('error', (_err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Gateway starting...');
  });

  req.pipe(proxyReq, { end: true });
});

server.listen(PUBLIC_PORT, () => {
  console.log(`Smithery bridge listening on :${PUBLIC_PORT}, proxying to supergateway on :${GATEWAY_PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  gateway.kill('SIGTERM');
  server.close();
});
