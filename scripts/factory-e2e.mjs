#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, cpSync, existsSync, chmodSync, readFileSync, writeFileSync, readdirSync, openSync, closeSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const scratch = resolve(process.env.FACTORY_E2E_OUTPUT ?? resolve(root, '..', 'prism-factory-e2e-runs', randomUUID()));
mkdirSync(scratch, { recursive: true });
mkdirSync(resolve(scratch, 'state'), { recursive: true });
// Scratch holds only generated fixtures and a non-secret local test key.
// Docker's non-root uid differs from the macOS owner of bind-mounted files.
chmodSync(scratch, 0o777);
chmodSync(resolve(scratch, 'state'), 0o777);
const fixture = resolve(process.env.FACTORY_FIXTURE_DIR ?? resolve(root, 'examples/factory-filename-fix'));
for (const file of ['slug.cjs', 'slug.test.cjs']) {
  if (!existsSync(resolve(fixture, file))) throw new Error(`missing fixture: ${file}`);
  cpSync(resolve(fixture, file), resolve(scratch, file));
  chmodSync(resolve(scratch, file), file === 'slug.cjs' ? 0o666 : 0o444);
}
writeFileSync(resolve(scratch, 'verification_harness.json'), JSON.stringify({min_pass_rate:1,tests:[{id:'fixture-file-exists',layer:'pipeline',description:'The implementation file exists after execution.',severity:'gate',assertion:{type:'file_exists',target:'/scratch/slug.cjs',expected:true}}]}));
chmodSync(resolve(scratch,'verification_harness.json'),0o444);
const tag = `prism-factory-e2e:${process.pid}`;
const proxyTag = `prism-factory-model-proxy:${process.pid}`;
const network = `prism-factory-e2e-net-${process.pid}`;
const dockerDir = resolve(root, 'tests/darkfactory/docker');
const runnerName = `factory-runner-${process.pid}`;
const mode = process.env.FACTORY_E2E_MODE ?? 'execution';
if (!['execution', 'routing'].includes(mode)) throw new Error('FACTORY_E2E_MODE must be execution or routing');
const hashes = {};
function hashTree(folder) {
  for (const item of readdirSync(resolve(root, folder), { withFileTypes: true })) {
    const name = `${folder}/${item.name}`;
    if (item.isDirectory()) hashTree(name);
    else if (item.isFile()) hashes[name] = createHash('sha256').update(readFileSync(resolve(root, name))).digest('hex');
  }
}
for (const folder of ['src', 'dist', 'tests/darkfactory/docker', 'examples/factory-filename-fix']) hashTree(folder);
writeFileSync(resolve(scratch, 'build-manifest.json'), JSON.stringify({ observedAt: new Date().toISOString(), gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), uncommittedCandidate: true, hashes }, null, 2));
try {
execFileSync('docker', ['build', '--tag', proxyTag, '--file', resolve(dockerDir, 'Proxy.Dockerfile'), root], { stdio: 'inherit', timeout: 300000 });
execFileSync('docker', ['network', 'create', '--internal', network], { stdio: 'ignore' });
execFileSync('docker', ['run', '--detach', '--rm', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--memory', '512m', '--network', 'bridge', '--name', `factory-proxy-${process.pid}`, proxyTag], { stdio: 'ignore', timeout: 120000 });
execFileSync('docker', ['network', 'connect', '--alias', 'factory-model-proxy', network, `factory-proxy-${process.pid}`], { stdio: 'ignore' });
execFileSync('docker', ['build', '--tag', tag, '--file', resolve(dockerDir, 'Dockerfile'), root], { stdio: 'inherit', timeout: 900000 });
  execFileSync('docker', ['run', '--rm', '--name', runnerName, '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--memory', '1g', '--network', network, '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--tmpfs', '/home/node/.prism-mcp:rw,uid=1000,gid=1000,size=64m', '--volume', `${scratch}:/scratch:rw`, '--volume', `${scratch}/slug.test.cjs:/scratch/slug.test.cjs:ro`, '--volume', `${scratch}/verification_harness.json:/scratch/verification_harness.json:ro`, '--env', 'FACTORY_SCRATCH=/scratch', '--env', `FACTORY_E2E_MODE=${mode}`, tag], { stdio: 'inherit', timeout: 720000 });
} finally {
  const logFd = openSync(resolve(scratch, 'model-response-boundary.log'), 'w');
  try { execFileSync('docker', ['logs', `factory-proxy-${process.pid}`], { stdio: ['ignore', logFd, logFd] }); } catch {} finally { closeSync(logFd); }
  for (const args of [['rm','-f',runnerName], ['rm','-f',`factory-proxy-${process.pid}`], ['network','rm',network], ['rmi',tag], ['rmi',proxyTag]]) { try { execFileSync('docker', args, { stdio: 'ignore' }); } catch {} }
}
