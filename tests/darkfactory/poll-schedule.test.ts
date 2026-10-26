import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

let config: typeof import('../../src/storage/configStorage.js');
let configPath: string;
const originalPath = process.env.PRISM_CONFIG_PATH;
const baseMs = 30_000;
const start = 1_800_000_000_000;

beforeEach(async () => {
  vi.resetModules();
  configPath = join(mkdtempSync(join(tmpdir(), 'factory-poll-')), 'config.db');
  process.env.PRISM_CONFIG_PATH = configPath;
  config = await import('../../src/storage/configStorage.js');
  await config.initConfigStorage();
});
afterEach(() => {
  config.closeConfigStorage();
  if (originalPath === undefined) delete process.env.PRISM_CONFIG_PATH;
  else process.env.PRISM_CONFIG_PATH = originalPath;
});

describe('shared Factory discovery schedule', () => {
  it('admits only one simultaneous scanner and isolates account scopes', async () => {
    const claims = await Promise.all(Array.from({length: 11}, () => config.claimFactoryPoll('account-a', baseMs, start)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await config.claimFactoryPoll('account-b', baseMs, start)).not.toBeNull();
  });

  it('backs off an empty queue to five minutes and persists across restart', async () => {
    let now = start;
    for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      const lease = await config.claimFactoryPoll('idle', baseMs, now);
      expect(lease).not.toBeNull();
      await lease!.finish('idle', now);
      config.closeConfigStorage();
      await config.initConfigStorage();
      expect(await config.claimFactoryPoll('idle', baseMs, now + delay - 1)).toBeNull();
      now += delay;
    }
    expect(await config.claimFactoryPoll('idle', baseMs, now)).not.toBeNull();
  });

  it('resets idle backoff when authorized work exists', async () => {
    const first = await config.claimFactoryPoll('busy', baseMs, start);
    await first!.finish('idle', start);
    const busy = await config.claimFactoryPoll('busy', baseMs, start + baseMs);
    await busy!.finish('busy', start + baseMs);
    expect(await config.claimFactoryPoll('busy', baseMs, start + baseMs * 2 - 1)).toBeNull();
    expect(await config.claimFactoryPoll('busy', baseMs, start + baseMs * 2)).not.toBeNull();
  });

  it.each(['busy','failed','idle'] as const)('does not let scan latency skip the next %s polling tick', async outcome => {
    const lease = await config.claimFactoryPoll(`latency-${outcome}`, baseMs, start);
    await lease!.finish(outcome, start + 1_000);
    expect(await config.claimFactoryPoll(`latency-${outcome}`, baseMs, start + baseMs)).not.toBeNull();
  });

  it('retries a failed scan at the base cadence rather than recording more idle time', async () => {
    const idle = await config.claimFactoryPoll('failure', baseMs, start);
    await idle!.finish('idle', start);
    const failed = await config.claimFactoryPoll('failure', baseMs, start + baseMs);
    await failed!.finish('failed', start + baseMs);
    expect(await config.claimFactoryPoll('failure', baseMs, start + baseMs * 2 - 1)).not.toBeNull();
  });

  it('admits an early interval tick after a failed scan', async () => {
    const lease=await config.claimFactoryPoll('jitter-failed',baseMs,start);
    await lease!.finish('failed',start+1_000);
    expect(await config.claimFactoryPoll('jitter-failed',baseMs,start+baseMs-1)).not.toBeNull();
  });

  it('shares discovery snapshots with followers and preserves the last hint on scan failure',async()=>{
    const now=Date.now();
    const candidates=[{id:'fixture',project:'test',user_id:'test-owner',status:'PENDING',current_step:'INIT',iteration:0,
      spec:'{}',started_at:new Date(now).toISOString(),updated_at:new Date(now).toISOString(),last_heartbeat:null,error:null}] as import('../../src/storage/interface.js').PipelineState[];
    const first=await config.claimFactoryPoll('snapshot',baseMs,now);
    await first!.finish('busy',now,candidates);
    expect((await config.readFactoryPollSnapshot('snapshot')).candidates).toEqual(candidates);
    const next=await config.claimFactoryPoll('snapshot',baseMs,now+baseMs);
    await next!.finish('failed',now+baseMs+1);
    expect((await config.readFactoryPollSnapshot('snapshot')).candidates).toEqual(candidates);
    const empty=await config.claimFactoryPoll('snapshot',baseMs,now+baseMs+2);
    await empty!.finish('idle',now+baseMs+3);
    expect((await config.readFactoryPollSnapshot('snapshot')).candidates).toEqual([]);
  });

  it('wakes idle discovery without stealing a live scan or losing an in-flight wake', async () => {
    const first = await config.claimFactoryPoll('wake', baseMs, start);
    await first!.finish('idle', start);
    await config.wakeFactoryPolling('wake');
    const scanning = await config.claimFactoryPoll('wake', baseMs, start + 1);
    expect(scanning).not.toBeNull();
    await config.wakeFactoryPolling('wake');
    expect(await config.claimFactoryPoll('wake', baseMs, start + 2)).toBeNull();
    await scanning!.finish('idle', start + 3);
    expect(await config.claimFactoryPoll('wake', baseMs, start + 4)).not.toBeNull();
  });

  it('recovers a crashed scanner and fences stale completion and renewal', async () => {
    const old = await config.claimFactoryPoll('crash', baseMs, start);
    const now = start + config.DEFAULT_FACTORY_LEASE_MS;
    const replacement = await config.claimFactoryPoll('crash', baseMs, now);
    expect(replacement).not.toBeNull();
    expect(await old!.renew(now)).toBe(false);
    await old!.finish('idle', now);
    expect(await config.claimFactoryPoll('crash', baseMs, now + 1)).toBeNull();
    expect(await replacement!.renew(now + 1)).toBe(true);
    await replacement!.finish('idle', now + 2);
    expect(await config.claimFactoryPoll('crash', baseMs, now + 2 + baseMs)).not.toBeNull();
  });

  it('does not shorten an explicitly slower polling cadence', async () => {
    const slow = config.MAX_FACTORY_IDLE_POLL_MS * 2;
    const lease = await config.claimFactoryPoll('slow', slow, start);
    await lease!.finish('idle', start);
    expect(await config.claimFactoryPoll('slow', slow, start + slow - 1)).toBeNull();
  });

  it('elects one scanner across actual Node processes sharing the config database', async () => {
    const source = pathToFileURL(join(process.cwd(), 'src/storage/configStorage.ts')).href;
    const script = `const m=await import(${JSON.stringify(source)});const lease=await m.claimFactoryPoll('processes',30000);console.log(JSON.stringify({claimed:!!lease}));m.closeConfigStorage();`;
    const invoke = promisify(execFile);
    const children = await Promise.all(Array.from({length: 3}, () => invoke(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script], {cwd: process.cwd(), env: {...process.env, PRISM_CONFIG_PATH: configPath}})));
    expect(children.map(c => JSON.parse(c.stdout.trim()).claimed).filter(Boolean)).toHaveLength(1);
  });
});
