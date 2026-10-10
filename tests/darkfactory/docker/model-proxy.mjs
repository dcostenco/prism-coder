import http from 'node:http';
const upstream = 'http://host.docker.internal:11434';
http.createServer(async (req, res) => {
  if (!((req.method === 'GET' && req.url === '/v1/models') || (req.method === 'POST' && req.url === '/v1/chat/completions'))) { res.writeHead(404); return res.end(); }
  let size = 0; const chunks = []; for await (const chunk of req) { size += chunk.length; if (size > 65536) { res.writeHead(413); return res.end(); } chunks.push(chunk); }
  try {
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    if (req.method === 'POST' && (!body || JSON.parse(body).model !== 'prism-coder:4b')) { res.writeHead(400); return res.end(); }
    const response = await fetch(upstream + req.url, { method: req.method, headers: { 'content-type': req.headers['content-type'] ?? 'application/json' }, body, signal: AbortSignal.timeout(120000) });
    const responseBody = Buffer.from(await response.arrayBuffer());
    if (req.method === 'POST') {
      const request = JSON.parse(body);
      let result;
      try { result = JSON.parse(responseBody.toString('utf8')); } catch {}
      const message = result?.choices?.[0]?.message;
      process.stderr.write(JSON.stringify({ model: request.model, responseFormat: request.response_format, status: response.status, contentLength: message?.content?.length ?? 0, contentPreview: message?.content?.slice(0, 1000), toolCalls: message?.tool_calls?.length ?? 0, finishReason: result?.choices?.[0]?.finish_reason }) + '\n');
    }
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
    res.end(responseBody);
  } catch { res.writeHead(502); res.end(); }
}).listen(11434, '0.0.0.0');
