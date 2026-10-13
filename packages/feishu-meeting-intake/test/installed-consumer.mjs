import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import module from '@clowder-ai/feishu-meeting-intake';
import { validateManifest } from '@clowder-ai/plugin-contract';
const packageRoot=dirname(dirname(fileURLToPath(import.meta.resolve('@clowder-ai/feishu-meeting-intake'))));
const consumer=process.cwd();
for(const name of ['plugin-sdk','plugin-contract','feishu-meeting-intake'])assert.ok(!relative(consumer,fileURLToPath(import.meta.resolve('@clowder-ai/'+name))).startsWith('..'));
const manifest=JSON.parse(await readFile(join(packageRoot,'manifest.json'),'utf8'));
assert.equal(validateManifest(manifest).valid,true);
assert.equal(manifest.runtime.transport,'builtin');
assert.equal(manifest.signals,undefined);
assert.equal(typeof module.create,'function');
const data=await mkdtemp(join(tmpdir(),'meeting-installed-control-'));
try {
 const runner=JSON.parse(await readFile(join(packageRoot,'dist/lark-cli-runtime.json'),'utf8'));
 assert.equal(runner.version,'1.0.85');assert.equal(runner.platform,process.platform);assert.equal(runner.arch,process.arch);
 assert.equal((await stat(join(packageRoot,'dist/lark-cli'))).mode & 0o777,0o755,'installed declared runner must retain executable permissions');
 assert.equal(createHash('sha256').update(await readFile(join(packageRoot,'dist/lark-cli'))).digest('hex'),runner.binarySha256);
 assert.match(execFileSync(join(packageRoot,'dist/lark-cli'),['--version'],{env:{HOME:data},encoding:'utf8',timeout:10_000}),/1\.0\.85/);
 const active=await module.create(manifest).start({dataDirectory:data,config:{async get(){throw new Error('First start must not read provider settings');}},secrets:{async get(){throw new Error('First start must not read credentials');}},storage:{},tasks:{},threads:{},media:{},messaging:{},log(){}});
 const owner={kind:'owner-operation',userId:'owner',pluginInstanceId:'installed',operationKey:'account',actionId:'status',requestId:'status',signal:new AbortController().signal,async assertCurrent(){}};
 const status=await active.actions['meeting.status']({input:{}},undefined,owner);
 assert.deepEqual(status.data,{auth:'not_configured',collectionIntent:'disabled',live:'stopped'});
 await active.stop();
 await assert.rejects(()=>active.actions['meeting.status']({input:{}},undefined,owner),/stopped|revoked/);
 const require=createRequire(join(packageRoot,'package.json'));
 const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
 const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
 const client=new Client({name:'meeting-installed-test',version:'1.0.0'});
 try {
  await client.connect(new StdioClientTransport({command:process.execPath,args:[join(packageRoot,'dist/mcp-entrypoint.js')],env:{HOME:data,PATH:process.env.PATH??''},stderr:'pipe'}));
  const {tools}=await client.listTools();
  assert.deepEqual(tools.map(t=>t.name).sort(),['cat_cafe_meeting_records_list','cat_cafe_meeting_records_read'].sort());
  for(const tool of tools){assert.equal(tool.inputSchema.additionalProperties,false);assert.equal(Object.hasOwn(tool.inputSchema.properties??{},'userId'),false);assert.equal(Object.hasOwn(tool.inputSchema.properties??{},'threadId'),false);}
  const denied=await client.callTool({name:'cat_cafe_meeting_records_list',arguments:{}});
  assert.equal(denied.isError,true,'missing authenticated native credentials must fail closed');
 } finally {await client.close();}
 console.log('installed control-only module + actual strict MCP + stop: PASS');
} finally {await rm(data,{recursive:true,force:true});}
