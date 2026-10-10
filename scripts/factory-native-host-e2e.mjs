#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,cpSync,chmodSync,openSync,closeSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {configureCodexNativeStartup} from '../dist/connect.js';
const root=resolve(import.meta.dirname,'..');
const scratch=resolve(root,'..','prism-factory-native-runs',randomUUID());mkdirSync(scratch,{recursive:true});chmodSync(scratch,0o777);
for(const file of ['slug.cjs','slug.test.cjs']){cpSync(resolve(root,'examples/factory-filename-fix',file),resolve(scratch,file));chmodSync(resolve(scratch,file),file==='slug.cjs'?0o666:0o444);}
const managed=resolve(scratch,'managed-instructions');mkdirSync(managed);configureCodexNativeStartup(managed);cpSync(resolve(managed,'.codex/AGENTS.md'),resolve(scratch,'AGENTS.md'));
const name=`factory-native-${process.pid}`,image=`prism-factory-native:${process.pid}`,proxyImage=`prism-factory-native-proxy:${process.pid}`,network=`factory-native-net-${process.pid}`,proxy=`factory-native-proxy-${process.pid}`;
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');const beforeHash=hash(resolve(scratch,'slug.cjs')),testHash=hash(resolve(scratch,'slug.test.cjs'));
const prompt='Fix slug.cjs so every whitespace group becomes one hyphen, trim surrounding whitespace, lowercase the filename and preserve its extension. Change only slug.cjs. Run node --test slug.test.cjs and finish when all three cases pass.';
const started=new Date().toISOString();
const hashes={};
function hashTree(folder){for(const entry of readdirSync(resolve(root,folder),{withFileTypes:true})){const file=`${folder}/${entry.name}`;if(entry.isDirectory())hashTree(file);else if(entry.isFile())hashes[file]=hash(resolve(root,file));}}
for(const folder of ['src','dist','tests/darkfactory/docker','examples/factory-filename-fix'])hashTree(folder);
writeFileSync(resolve(scratch,'build-manifest.json'),JSON.stringify({started,gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),uncommittedCandidate:true,hashes},null,2));
const hostModel=process.env.FACTORY_NATIVE_HOST_MODEL;if(!hostModel)throw new Error('Set FACTORY_NATIVE_HOST_MODEL to a model advertised by the installed Codex client');
try{
 execFileSync('docker',['build','-t',image,'-f',resolve(root,'tests/darkfactory/docker/Dockerfile'),root],{stdio:'inherit',timeout:300000});
 execFileSync('docker',['build','-t',proxyImage,'-f',resolve(root,'tests/darkfactory/docker/Proxy.Dockerfile'),root],{stdio:'inherit',timeout:300000});
 execFileSync('docker',['network','create','--internal',network],{stdio:'ignore'});
 execFileSync('docker',['run','-d','--rm','--name',proxy,'--read-only','--user','1000:1000','--cap-drop','ALL','--memory','512m','--network','bridge',proxyImage],{stdio:'ignore'});
 execFileSync('docker',['network','connect','--alias','factory-model-proxy',network,proxy],{stdio:'ignore'});
 const args=['run','-d','--rm','--name',name,'--read-only','--user','1000:1000','--cap-drop','ALL','--memory','1g','--network',network,'--tmpfs','/tmp:rw,noexec,nosuid,size=64m','--tmpfs','/home/node/.prism-mcp:rw,uid=1000,gid=1000,size=64m','-v',`${scratch}:${scratch}:rw`,'-v',`${scratch}/slug.test.cjs:${scratch}/slug.test.cjs:ro`];
 for(const value of ['PRISM_STORAGE=local','PRISM_FORCE_LOCAL=true','PRISM_CONFIG_PATH=/home/node/.prism-mcp/prism-config.db','PRISM_TEXT_PROVIDER=openai','OPENAI_MODEL=prism-coder:4b','OPENAI_API_KEY=local-e2e-key','PRISM_DARK_FACTORY_POLL_MS=2000'])args.push('-e',value);
 args.push('--entrypoint','sleep',image,'600');execFileSync('docker',args,{stdio:'ignore'});
 const setup=`const c=await import('/app/dist/storage/configStorage.js');await c.initConfigStorage();for(const [k,v] of Object.entries(${JSON.stringify({openai_api_key:'local-e2e-key',openai_base_url:'http://factory-model-proxy:11434/v1',openai_model:'prism-coder:4b',text_provider:'openai',autoload_projects:'factory-native-host','repo_path:factory-native-host':scratch})}))await c.setSetting(k,v);`;
 execFileSync('docker',['exec',name,'node','--input-type=module','-e',setup],{stdio:'ignore'});
 const out=openSync(resolve(scratch,'native-host.jsonl'),'w'),err=openSync(resolve(scratch,'native-host.stderr'),'w');
 let exitStatus=0;
 try{execFileSync('codex',['exec','-m',hostModel,'--ephemeral','--skip-git-repo-check','--approve-for-me','--json','-C',scratch,'-c',`mcp_servers={prism-mcp={required=true,startup_timeout_sec=30,tools={session_bootstrap={approval_mode="approve"},session_route_prompt={approval_mode="approve"},session_start_pipeline={approval_mode="approve"},session_check_pipeline_status={approval_mode="approve"}},command="docker",args=${JSON.stringify(['exec','-i',name,'node','/app/dist/server.js'])}}}`,prompt],{stdio:['ignore',out,err],timeout:480000});}catch(error){exitStatus=error.status??1;}finally{closeSync(out);closeSync(err);}
 const events=readFileSync(resolve(scratch,'native-host.jsonl'),'utf8').split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);
 const calls=events.filter(event=>event.type==='item.completed'&&event.item?.type==='mcp_tool_call').map(event=>event.item);
 const starts=calls.filter(call=>call.tool==='session_start_pipeline');const boots=calls.filter(call=>call.tool==='session_bootstrap');
 let output='',testPassed=false;try{output=execFileSync('node',['--test',resolve(scratch,'slug.test.cjs')],{encoding:'utf8',timeout:120000});testPassed=true;}catch(error){output=String(error.stdout||error.stderr||error);}
 const afterHash=hash(resolve(scratch,'slug.cjs'));const terminal=calls.some(call=>JSON.stringify(call.result).includes('Pipeline Status: COMPLETED'));
 const manifestDrift=Object.keys(hashes).filter(file=>hashes[file]!==hash(resolve(root,file)));
 const passed=exitStatus===0&&boots.length===1&&starts.length===1&&terminal&&testPassed&&beforeHash!==afterHash&&testHash===hash(resolve(scratch,'slug.test.cjs'))&&manifestDrift.length===0;
 writeFileSync(resolve(scratch,'native-host-result.json'),JSON.stringify({started,finished:new Date().toISOString(),hostModel,boundary:'Real Codex CLI consumes candidate-generated native instructions and real candidate MCP; disposable fixture trusts only bootstrap, route, start and status tools; no global host config changes',prompt,exitStatus,bootstrapCalls:boots.length,startCalls:starts.length,tools:calls.map(call=>call.tool),terminal,testPassed,output,beforeHash,afterHash,testImmutable:testHash===hash(resolve(scratch,'slug.test.cjs')),manifestDrift,passed},null,2));
 console.log(JSON.stringify({scratch,passed,bootstrapCalls:boots.length,startCalls:starts.length,terminal,testPassed}));if(!passed)process.exitCode=1;
}finally{
 const fd=openSync(resolve(scratch,'model-response-boundary.log'),'w');try{execFileSync('docker',['logs',proxy],{stdio:['ignore',fd,fd]});}catch{}finally{closeSync(fd);}
 for(const args of [['rm','-f',name],['rm','-f',proxy],['network','rm',network],['rmi',image],['rmi',proxyImage]])try{execFileSync('docker',args,{stdio:'ignore'});}catch{}
}
