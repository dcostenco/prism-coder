import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const scratch = process.env.FACTORY_SCRATCH ?? '/scratch';
await fs.mkdir(`${scratch}/state`, { recursive: true });
// Keep active SQLite files on the Linux filesystem. Cross-platform bind mounts
// and simultaneous macOS reads do not provide trustworthy WAL/locking evidence.
process.env.PRISM_CONFIG_PATH = '/home/node/.prism-mcp/prism-config.db';
const { initConfigStorage, setSetting } = await import('/app/dist/storage/configStorage.js');
await initConfigStorage();
await setSetting('openai_api_key', 'local-e2e-key');
await setSetting('openai_base_url', 'http://factory-model-proxy:11434/v1');
await setSetting('openai_model', process.env.OPENAI_MODEL ?? 'prism-coder:4b');
await setSetting('text_provider', 'openai');
const serverEnv = { ...process.env, OPENAI_API_KEY: 'local-e2e-key', PRISM_STORAGE: 'local', PRISM_FORCE_LOCAL: 'true', PRISM_CONFIG_PATH: process.env.PRISM_CONFIG_PATH, PRISM_DARK_FACTORY_POLL_MS: '2000', PRISM_TEXT_PROVIDER: 'openai', OPENAI_MODEL: 'prism-coder:4b' };
delete serverEnv.PRISM_DARK_FACTORY_ENABLED;
const client = new Client({ name: 'factory-e2e', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: 'node', args: ['/app/dist/server.js'],
  env: serverEnv,
});
const call = async (name, args) => client.callTool({ name, arguments: args });
const text = result => result?.content?.map(x => x.text ?? '').join('\n') ?? '';
const started = new Date().toISOString();
const beforeHash = crypto.createHash('sha256').update(await fs.readFile(`${scratch}/slug.cjs`)).digest('hex');
const beforeTestHash = crypto.createHash('sha256').update(await fs.readFile(`${scratch}/slug.test.cjs`)).digest('hex');
let pipelineId;
const toolNames = result => (result?.tools ?? []).map(tool => tool.name).sort();
const expectedTools = ['session_abort_pipeline', 'session_check_pipeline_status', 'session_start_pipeline'];
const disabledClient = new Client({ name: 'factory-e2e-disabled', version: '1.0.0' }, { capabilities: {} });
await disabledClient.connect(new StdioClientTransport({ command: 'node', args: ['/app/dist/server.js'], env: { ...serverEnv, PRISM_DARK_FACTORY_ENABLED: 'false' } }));
const disabledToolsResult = await disabledClient.listTools();
if (disabledToolsResult.isError || toolNames(disabledToolsResult).some(name => expectedTools.includes(name))) throw new Error('disabled startup exposed Factory tools');
await disabledClient.close();
try {
  await client.connect(transport);
  const enabledToolsResult = await client.listTools();
  if (enabledToolsResult.isError) throw new Error('enabled startup listTools returned an error');
  const enabledTools = toolNames(enabledToolsResult);
  if (!expectedTools.every(name => enabledTools.includes(name))) throw new Error(`enabled startup missing Factory tools: ${enabledTools.join(',')}`);
  const objective = 'Fix only slug.cjs. Its current code is module.exports = function filenameSlug(name) { return name.trim().toLowerCase().replace(" ", "-"); }; Replace each whitespace group in the input filename with one hyphen, trim surrounding whitespace, lowercase the filename and preserve its extension. Examples: Weekly Sales Report.pdf -> weekly-sales-report.pdf; " invoice   copy.txt " -> invoice-copy.txt; photo.JPG -> photo.jpg. Run node --test slug.test.cjs and finish only when all three cases pass. Do not edit slug.test.cjs or any other file.';
  const parseRoute = result => {
    if (result.isError) throw new Error(text(result));
    const raw = text(result).match(/<prism_factory_route>([\s\S]*?)<\/prism_factory_route>/)?.[1];
    if (!raw) throw new Error('MCP prompt routing did not return a Factory decision');
    return JSON.parse(raw);
  };
  const bootstrap = await call('session_bootstrap', { prompt: 'Hello' });
  if (bootstrap.isError || !text(bootstrap).includes('**Factory:** enabled')) throw new Error('First-turn startup did not report default-enabled Factory');
  const { createClient } = await import('@libsql/client');
  const db = createClient({ url: 'file:/home/node/.prism-mcp/data.db' });
  const beforeClinicalCount = Number((await db.execute('SELECT COUNT(*) AS count FROM dark_factory_pipelines')).rows[0].count);
  const clinicalPrompts = [
    'Draft a BCBA operational definition from the supplied notes.',
    'Create an ABA frequency data recording sheet.',
    'Write BIP antecedent strategies and an FCT teaching procedure.',
    'Summarize FBA A-B-C observations.',
    'Review BIP consequence strategies and crisis procedures.',
    'Write a BCBA DDA assessment summary.',
    'Calculate mastery percentage for ABA data.',
    'Fix a behavior support plan in plan.ts and run node --test plan.test.cjs.',
    'Create a functional communication training procedure in procedure.ts and verify it.',
    'Write a token economy protocol in protocol.ts and test it.',
    'Write an antecedent strategy in plan.ts and test it.',
    'Create a task analysis in steps.ts and run tests.',
    'Write a preference assessment in assess.ts and verify it.',
    'Fix sensory supports in supports.ts and run tests.',
  ];
  const clinicalRoutes = [];
  for (const prompt of clinicalPrompts) {
    const route = parseRoute(await call('session_route_prompt', { prompt, loaded: [], project: 'factory-e2e', working_directory: scratch }));
    if (route.target !== 'host' || route.recommended_tool !== null || !route.reason.includes('BCBA')) throw new Error('BCBA prompt incorrectly started coding Factory or missed the clinical boundary');
    clinicalRoutes.push({ prompt, route });
  }
  const afterClinicalCount = Number((await db.execute('SELECT COUNT(*) AS count FROM dark_factory_pipelines')).rows[0].count);
  db.close();
  if (afterClinicalCount !== beforeClinicalCount) throw new Error('BCBA routing created a hidden coding pipeline');
  const route = parseRoute(await call('session_route_prompt', { prompt: objective, loaded: [], project: 'factory-e2e', working_directory: scratch, files_involved: ['slug.cjs', 'slug.test.cjs'], test_command: 'node --test slug.test.cjs', allowed_write_paths: ['slug.cjs'] }));
  if (route.target !== 'factory' || route.recommended_tool !== 'session_start_pipeline') throw new Error(`Coding prompt was not automatically routed: ${JSON.stringify(route)}`);
  // The host consumes the read-only decision; pipeline creation is the separate side-effecting MCP call.
  const start = await call(route.recommended_tool, route.recommended_args);
  if (start.isError) throw new Error(text(start));
  const match = text(start).match(/Pipeline ID:\*\* `([^`]+)`/);
  if (!match) throw new Error(`pipeline start did not return an id: ${text(start).slice(0, 300)}`);
  pipelineId = match[1];
  if (process.env.FACTORY_E2E_MODE === 'routing') {
    const abort = await call('session_abort_pipeline', {pipeline_id:pipelineId,project:'factory-e2e'});
    if (abort.isError) throw new Error(text(abort));
    const beforeRestart = text(await call('session_check_pipeline_status',{pipeline_id:pipelineId,project:'factory-e2e'}));
    await client.close();
    const reopened = new Client({name:'factory-routing-restart',version:'1.0.0'},{capabilities:{}});
    await reopened.connect(new StdioClientTransport({command:'node',args:['/app/dist/server.js'],env:serverEnv}));
    const afterRestartResult=await reopened.callTool({name:'session_check_pipeline_status',arguments:{pipeline_id:pipelineId,project:'factory-e2e'}});
    const afterRestart=text(afterRestartResult);
    await reopened.close();
    const abortPersisted=!afterRestartResult.isError&&beforeRestart.includes('ABORTED')&&afterRestart.includes('ABORTED');
    await fs.writeFile(`${scratch}/factory-e2e-result.json`,JSON.stringify({started,finished:new Date().toISOString(),mode:'routing',boundary:'Real MCP route/start/abort/process restart, native Linux SQLite, no model-generation claim',pipelineId,route,clinicalRoutes,beforeClinicalCount,afterClinicalCount,disabledTools:toolNames(disabledToolsResult),enabledTools,beforeRestart,afterRestart,abortPersisted},null,2));
    if (!abortPersisted) process.exitCode=1;
  } else {
  let status = 'PENDING';
  const progress = [];
  for (let i = 0; i < 300; i++) {
    const result = await call('session_check_pipeline_status', { pipeline_id: pipelineId, project: 'factory-e2e' });
    const body = text(result);
    if (result.isError) throw new Error(`status tool error: ${body.slice(0, 300)}`);
    const found = body.match(/\*\*Pipeline Status: ([A-Z]+)\*\*/);
    if (!found) throw new Error(`unrecognized pipeline status: ${body.slice(0, 300)}`);
    if (found && ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'ABORTED'].includes(found[1])) status = found[1];
    progress.push({ at: new Date().toISOString(), status, body });
    if (['COMPLETED', 'FAILED', 'ABORTED'].includes(status)) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  const test = await import('node:child_process').then(({ execFile }) => new Promise(resolve => {
    execFile('node', ['--test', `${scratch}/slug.test.cjs`], { stdio: 'pipe', timeout: 120000 }, (error, stdout, stderr) => {
      resolve(error ? { passed: false, output: String(stdout || stderr || error).slice(0, 2000) } : { passed: true, output: stdout });
    });
  }));
  const file = await fs.readFile(`${scratch}/slug.cjs`, 'utf8');
  const afterHash = crypto.createHash('sha256').update(file).digest('hex');
  const testHash = crypto.createHash('sha256').update(await fs.readFile(`${scratch}/slug.test.cjs`)).digest('hex');
  const verificationDb = createClient({ url: 'file:/home/node/.prism-mcp/data.db' });
  const verificationRuns = (await verificationDb.execute({ sql: 'SELECT * FROM verification_runs WHERE conversation_id = ?', args: [`dark-factory-${pipelineId}`] })).rows;
  const verificationHarnesses = verificationRuns.length ? (await verificationDb.execute({ sql: 'SELECT * FROM verification_harnesses WHERE rubric_hash = ?', args: [verificationRuns[0].rubric_hash] })).rows : [];
  verificationDb.close();
  const verificationPersisted = verificationRuns.length >= 1 && verificationHarnesses.length === 1 && verificationHarnesses[0].project === 'factory-e2e' && verificationHarnesses[0].conversation_id === `dark-factory-${pipelineId}` && verificationRuns.every(run => run.passed === 1 && run.gate_action === 'continue' && run.project === 'factory-e2e' && run.rubric_hash === verificationHarnesses[0].rubric_hash && run.user_id === verificationHarnesses[0].user_id);
  await fs.writeFile(`${scratch}/verification-persistence.json`, JSON.stringify({ pipelineId, runs: verificationRuns, harness: verificationHarnesses }, null, 2));
  const abortStart = await call('session_start_pipeline', { project: 'factory-e2e-abort', objective: 'Abort this controlled lifecycle probe before execution.', working_directory: scratch, max_iterations: 1, model_override: process.env.OPENAI_MODEL ?? 'prism-coder:4b' });
  const abortId = text(abortStart).match(/Pipeline ID:\*\* `([^`]+)`/)?.[1];
  if (!abortId) throw new Error('abort probe did not return an id');
  const aborted = await call('session_abort_pipeline', { pipeline_id: abortId, project: 'factory-e2e-abort' });
  if (abortStart.isError || aborted.isError) throw new Error(text(abortStart) + text(aborted));
  await client.close();
  const reopened = new Client({ name: 'factory-e2e-reopen', version: '1.0.0' }, { capabilities: {} });
  await reopened.connect(new StdioClientTransport({ command: 'node', args: ['/app/dist/server.js'], env: serverEnv }));
  const reopenedStatus = text(await reopened.callTool({ name: 'session_check_pipeline_status', arguments: { pipeline_id: abortId, project: 'factory-e2e-abort' } }));
  const abortPersisted = reopenedStatus.includes('ABORTED');
  await reopened.close();
  await fs.writeFile(`${scratch}/factory-e2e-result.json`, JSON.stringify({ started, finished: new Date().toISOString(), pipelineId, status, progress, test, beforeHash, afterHash, beforeTestHash, testHash, disabledTools: toolNames(disabledToolsResult), enabledTools, clinicalRoutes, beforeClinicalCount, afterClinicalCount, route, serverVersion: client.getServerVersion(), abortId, abortPersisted, verificationPersisted }, null, 2));
  if (status !== 'COMPLETED' || !test.passed || beforeHash === afterHash || beforeTestHash !== testHash || !abortPersisted || !verificationPersisted) process.exitCode = 1;
  }
} catch (error) {
  await fs.writeFile(`${scratch}/factory-e2e-result.json`, JSON.stringify({ started, finished: new Date().toISOString(), pipelineId, error: String(error?.stack ?? error) }, null, 2));
  process.exitCode = 1;
} finally { await client.close().catch(() => {}); }
