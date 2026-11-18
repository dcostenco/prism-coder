#!/usr/bin/env node
// Exercise an image prompt through three real host CLIs and the built Prism server.
// The replay supplies a synthetic tool inventory. Both routes must come back from Prism.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify } from 'smol-toml';

const root = resolve(import.meta.dirname, '..');
const candidate = join(root, 'dist', 'server.js');
const serverName = 'prismfixture';
const tool = 'session_route_prompt';
const geminiTool = `mcp_${serverName}_${tool}`;
const claudeTool = `mcp__${serverName}__${tool}`;
const dummyClaudeKey = 'unused-loopback-test-key';
const runId = randomUUID();
const hosts = process.argv.slice(2);
const selected = hosts.length ? hosts : ['codex', 'gemini', 'claude'];
assert(selected.every(host => ['codex', 'gemini', 'claude'].includes(host)), 'Usage: node scripts/image-host-e2e.mjs [codex|gemini|claude]');
assert.equal(new Set(selected).size, selected.length, 'Each selected host must run once');
const build = createHash('sha256').update(await readFile(candidate)).digest('hex');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const scratch = await mkdtemp(join(tmpdir(), 'prism-image-host-'));
console.log(`Run ${runId} at ${revision}; evidence in ${scratch}`);

function routesFromToolResult(text, expectedImageRoute) {
  assert.equal(typeof text, 'string', 'Expected a text tool result');
  const match = text.match(/<prism_factory_route>([^<]+)<\/prism_factory_route>/);
  assert(match, 'Prism tool result has no factory route');
  const route = JSON.parse(match[1]);
  assert.equal(route.target, 'host');
  assert.equal(route.candidate, false);
  assert.equal(route.recommended_tool, null);
  const image = text.match(/<prism_image_route>([^<]+)<\/prism_image_route>/);
  assert(image, 'Prism tool result has no image-generation route');
  const imageRoute = JSON.parse(image[1]);
  assert.deepEqual(imageRoute, expectedImageRoute);
  return { route, imageRoute };
}

function codexItem(tools, args, callId) {
  for (const entry of tools) {
    if (entry.type === 'function' && entry.name === `mcp__${serverName}__${tool}`) {
      return { type: 'function_call', name: entry.name, call_id: callId, arguments: JSON.stringify(args) };
    }
    if (entry.type === 'namespace' && entry.name === `mcp__${serverName}`
        && entry.tools?.some(member => member.name === tool)) {
      return { type: 'function_call', namespace: entry.name, name: tool, call_id: callId, arguments: JSON.stringify(args) };
    }
  }
  throw new Error(`Codex did not advertise the candidate routing tool. Offered ${tools.map(entry => entry.name ?? entry.type).join(', ')}`);
}

function sendClaudeMessage(res, request, block, number) {
  const stopReason = block.type === 'tool_use' ? 'tool_use' : 'end_turn';
  const message = {
    type: 'message', id: `msg_fixture_${number}`, model: request.model, role: 'assistant', content: [block],
    stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  };
  if (!request.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(message));
    return;
  }
  const isTool = block.type === 'tool_use';
  const events = [
    { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: isTool ? { ...block, input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: isTool ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

function claudeResultText(block) {
  assert(!block.is_error, 'Claude received an error from the candidate MCP tool');
  if (typeof block.content === 'string') return block.content;
  assert(Array.isArray(block.content), 'Claude returned a tool result without content');
  return block.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
}

function claudeFixtureBlock(request, args, expectedImageRoute, callId, number) {
  assert.equal(request.model, expectedImageRoute.reported_host_model);
  if (number === 1) {
    assert(JSON.stringify(request.messages).includes(args.prompt), 'Claude omitted the run-specific prompt');
    assert(request.tools?.some(entry => entry.name === claudeTool), 'Claude did not advertise the candidate routing tool');
    return { type: 'tool_use', id: callId, name: claudeTool, input: args };
  }
  assert.equal(number, 2, 'Unexpected extra Claude model turn');
  const results = request.messages.filter(message => message.role === 'user' && Array.isArray(message.content))
    .flatMap(message => message.content).filter(part => part.type === 'tool_result' && part.tool_use_id === callId);
  assert.equal(results.length, 1, 'Claude did not deliver the correlated MCP tool result to the Messages fixture');
  routesFromToolResult(claudeResultText(results[0]), expectedImageRoute);
  return { type: 'text', text: 'Fixture finished.' };
}

async function listenFixture(args, host, expectedImageRoute) {
  const callId = (host === 'claude' ? 'toolu_' : 'call_') + runId;
  let requests = 0;
  let failure;
  const server = createServer(async (req, res) => {
    // A rejecting proxy and local API origin for optional background requests.
    const endpoint = host === 'claude' ? '/v1/messages' : '/v1/responses';
    if (req.method !== 'POST' || req.url.split('?')[0] !== endpoint) {
      res.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString());
      requests++;
      if (host === 'claude') {
        assert.equal(req.headers.host, `127.0.0.1:${server.address().port}`);
        assert.equal(req.headers['x-api-key'], dummyClaudeKey);
        assert.equal(req.headers.authorization, undefined);
        sendClaudeMessage(res, request, claudeFixtureBlock(request, args, expectedImageRoute, callId, requests), requests);
        return;
      }
      let item;
      if (requests === 1) {
        assert(JSON.stringify(request.input).includes(args.prompt), 'Codex omitted the run-specific prompt');
        item = codexItem(request.tools, args, callId);
      } else {
        assert.equal(requests, 2, 'Unexpected extra Codex model turn');
        const result = request.input.find(input => input.type === 'function_call_output' && input.call_id === callId);
        assert(result, 'Codex did not return the actual MCP call output to the fixture');
        const output = JSON.stringify(result.output);
        assert(output.includes('<prism_factory_route>'), 'Codex discarded the Factory route');
        assert(output.includes('<prism_image_route>'), 'Codex discarded the image-generation route');
        item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture finished.' }] };
      }
      item.id = `item_${requests}`;
      item.status = 'completed';
      const response = { id: `resp_${requests}`, object: 'response', created_at: 1, model: request.model, status: 'completed', output: [item] };
      const events = [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response },
      ];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(events.map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join(''));
    } catch (error) {
      failure = error;
      res.writeHead(400).end(error.message);
    }
  });
  server.on('connect', (_request, socket) => socket.destroy());
  await new Promise((done, reject) => server.once('error', reject).listen(0, '127.0.0.1', done));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    error: () => failure,
    check() { if (failure) throw failure; assert.equal(requests, 2); },
  };
}

async function runCli(host, argv, cwd, env, logs) {
  const child = spawn(host, argv, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '', expired = false;
  function stop() {
    if (!child.pid) return;
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  const timer = setTimeout(() => { expired = true; stop(); }, 45_000);
  child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { err += chunk; });
  try {
    const code = await new Promise((done, reject) => child.once('error', reject).once('close', done));
    await Promise.all([writeFile(join(logs, 'events.jsonl'), out), writeFile(join(logs, 'stderr.log'), err)]);
    assert(!expired, `${host} timed out; see ${logs}`);
    assert.equal(code, 0, `${host} exited with ${code}: ${err.slice(-1600)}`);
    return out.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } finally {
    clearTimeout(timer);
    stop();
  }
}

async function exercise(host) {
  const home = join(scratch, host);
  const work = join(home, 'workspace');
  await mkdir(work, { recursive: true });
  const prompt = `Generate an image of a blue ceramic cup on a white table. Fixture ${runId} for ${host}.`;
  const hostModel = { codex: 'fixture', gemini: 'gemini-3.1-pro-preview', claude: 'claude-sonnet-4-6' }[host];
  const imageTool = { codex: 'image_gen', gemini: 'mcp_nanobanana_generate_image', claude: 'mcp__nanobanana__generate_image' }[host];
  const capabilities = { available_tools: [imageTool], host_model: hostModel };
  const args = { prompt, loaded: [], image_generation: capabilities };
  const expectedImageRoute = { target: 'host', host, reported_host_model: hostModel, tool: imageTool, image_model: null };
  const fixture = await listenFixture(args, host, expectedImageRoute);
  const local = fixture.url;
  const prismEnv = {
    HOME: home, USERPROFILE: home, PRISM_STORAGE: 'local', PRISM_FORCE_LOCAL: 'true',
    PRISM_SKILL_SYNC_DISABLED: 'true', PRISM_DISABLE_HOOK_AUTOINSTALL: '1', PRISM_NO_STARTUP_REFRESH: '1',
    PRISM_NO_UPDATE_CHECK: '1', PRISM_SYNALUX_BASE_URL: local, PRISM_LOCAL_LLM_URL: local, PRISM_DASHBOARD_PORT: '0',
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: local, HTTPS_PROXY: local, ALL_PROXY: local, NO_PROXY: '127.0.0.1,localhost',
  };
  const env = { ...prismEnv, PATH: process.env.PATH, LANG: 'en_US.UTF-8', CI: '1', NO_COLOR: '1' };
  const mcp = { command: process.execPath, args: [candidate], env: prismEnv };
  try {
    let events, routes, eventId;
    if (host === 'codex') {
      env.CODEX_HOME = join(home, '.codex');
      await mkdir(env.CODEX_HOME);
      await writeFile(join(env.CODEX_HOME, 'config.toml'), stringify({
        model: hostModel, model_provider: 'fixture', check_for_update_on_startup: false, cli_auth_credentials_store: 'file',
        model_providers: { fixture: { name: 'Local test fixture', base_url: `${local}/v1`, wire_api: 'responses', request_max_retries: 0, stream_max_retries: 0 } },
        mcp_servers: { [serverName]: { ...mcp, required: true, enabled_tools: [tool] } },
      }));
      try {
        events = await runCli(host, ['exec', '--ephemeral', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', work, prompt], work, env, home);
      } catch (error) {
        if (fixture.error()) throw new Error(`${error.message}\nResponses fixture: ${fixture.error().message}`, { cause: error });
        throw error;
      }
      fixture.check();
      const calls = events.filter(e => e.type === 'item.completed' && e.item?.type === 'mcp_tool_call').map(e => e.item);
      assert.equal(calls.length, 1, 'Expected exactly one completed Codex MCP call');
      const [call] = calls;
      assert.equal(call.server, serverName);
      assert.equal(call.tool, tool);
      assert.equal(call.status, 'completed');
      assert.deepEqual(call.arguments, args);
      assert(!call.error && !call.result?.isError);
      routes = routesFromToolResult(call.result?.content?.find(part => part.type === 'text')?.text, expectedImageRoute);
      eventId = call.id;
    } else if (host === 'claude') {
      env.CLAUDE_CONFIG_DIR = join(home, '.claude');
      await mkdir(env.CLAUDE_CONFIG_DIR);
      env.ANTHROPIC_BASE_URL = local;
      env.ANTHROPIC_API_KEY = dummyClaudeKey;
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
      env.ENABLE_TOOL_SEARCH = 'false';
      const config = join(home, 'mcp.json');
      await writeFile(config, JSON.stringify({ mcpServers: { [serverName]: mcp } }));
      try {
        events = await runCli(host, [
          '--bare', '--print', '--verbose', '--output-format', 'stream-json', '--no-session-persistence',
          '--strict-mcp-config', '--mcp-config', config, '--setting-sources', '', '--tools', '', '--disable-slash-commands',
          '--model', hostModel, '--permission-mode', 'dontAsk', '--allowedTools', claudeTool, '--system-prompt', 'Respond to the test fixture.', prompt,
        ], work, env, home);
      } catch (error) {
        if (fixture.error()) throw new Error(`${error.message}\nMessages fixture: ${fixture.error().message}`, { cause: error });
        throw error;
      }
      fixture.check();
      const init = events.find(event => event.type === 'system' && event.subtype === 'init');
      assert.deepEqual(init?.mcp_servers?.map(({ name, status }) => ({ name, status })),
        [{ name: serverName, status: 'connected' }], 'Claude must connect exclusively to the candidate Prism server');
      assert.equal(init.model, hostModel);
      const blocks = role => events.filter(event => event.type === role && Array.isArray(event.message?.content))
        .flatMap(event => event.message.content);
      const calls = blocks('assistant').filter(part => part.type === 'tool_use');
      assert.equal(calls.length, 1, 'Expected exactly one Claude tool call');
      assert.equal(calls[0].name, claudeTool);
      assert.deepEqual(calls[0].input, args);
      eventId = calls[0].id;
      assert.equal(eventId, `toolu_${runId}`);
      const results = blocks('user').filter(part => part.type === 'tool_result' && part.tool_use_id === eventId);
      assert.equal(results.length, 1, 'Claude transcript omitted the correlated tool result');
      routes = routesFromToolResult(claudeResultText(results[0]), expectedImageRoute);
      const end = events.find(event => event.type === 'result');
      assert.equal(end?.subtype, 'success');
      assert.equal(end.is_error, false);
    } else {
      env.GEMINI_CLI_HOME = home;
      env.GEMINI_TELEMETRY_ENABLED = 'false';
      env.GEMINI_FORCE_FILE_STORAGE = 'true';
      env.GOOGLE_GEMINI_BASE_URL = local;
      // The CLI validates the selected auth mode before installing its fake generator.
      env.GEMINI_API_KEY = 'unused-local-fixture';
      const settings = join(home, '.gemini');
      await mkdir(settings);
      // Missing system files represent empty system settings to Gemini.
      env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = join(home, 'system-defaults.json');
      env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = join(home, 'system-settings.json');
      await writeFile(join(settings, 'trustedFolders.json'), JSON.stringify({ [await realpath(work)]: 'TRUST_FOLDER' }), { mode: 0o600, flag: 'wx' });
      await writeFile(join(settings, 'settings.json'), JSON.stringify({
        general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
        privacy: { usageStatisticsEnabled: false },
        security: { auth: { selectedType: 'gemini-api-key' }, folderTrust: { enabled: true } },
        mcpServers: { [serverName]: { ...mcp, includeTools: [tool] } },
      }));
      const replay = join(home, 'replay.jsonl');
      const stream = part => ({ method: 'generateContentStream', response: [{ candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP' }] }] });
      await writeFile(replay, [stream({ functionCall: { name: geminiTool, args } }), stream({ text: 'Fixture finished.' })].map(row => JSON.stringify(row)).join('\n'));
      // An explicit model keeps Gemini's classifier from consuming a replay response.
      events = await runCli(host, ['--model', hostModel, '-p', prompt, '-o', 'stream-json', '--fake-responses', replay, '-e', 'none', '--allowed-mcp-server-names', serverName], work, env, home);
      const calls = events.filter(e => e.type === 'tool_use');
      assert.equal(calls.length, 1, 'Expected exactly one Gemini tool call');
      assert.equal(calls[0].tool_name, geminiTool);
      assert.deepEqual(calls[0].parameters, args);
      eventId = calls[0].tool_id;
      const results = events.filter(e => e.type === 'tool_result' && e.tool_id === eventId);
      assert.equal(results.length, 1);
      assert.equal(results[0].status, 'success', JSON.stringify(results[0].error));
      routes = routesFromToolResult(results[0].output, expectedImageRoute);
    }
    assert(eventId);
    console.log(JSON.stringify({ host, runId, revision, serverSha256: build, tool, eventId, capabilitySource: 'synthetic fixture', ...routes }));
  } finally {
    fixture.server.closeAllConnections();
    await new Promise(done => fixture.server.close(done));
  }
}

for (const host of selected) await exercise(host);
