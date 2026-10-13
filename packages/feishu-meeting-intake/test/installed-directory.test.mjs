import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const root=fileURLToPath(new URL('../../../',import.meta.url));
function run(command,args,cwd,envOverrides={}){const env={...process.env,...envOverrides};delete env.NODE_PATH;delete env.NODE_OPTIONS;const result=spawnSync(command,args,{cwd,env,encoding:'utf8',timeout:120_000,maxBuffer:8*1024*1024});assert.equal(result.status,0,[command,...args,result.stdout,result.stderr].join('\n'));return result.stdout;}
async function fileBytes(directory){let bytes=0;for(const name of await readdir(directory)){const path=join(directory,name),stat=await lstat(path);if(stat.isDirectory())bytes+=await fileBytes(path);else{assert.ok(stat.isFile(),'archive has a non-regular member');bytes+=stat.size;}}return bytes;}
test('meeting archive installs its exact local SDK closure and runs its production module and MCP in an empty consumer',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'meeting-empty-consumer-')),packs=join(temp,'packs'),consumer=join(temp,'consumer');
 try {
  await mkdir(packs);await mkdir(consumer);const artifacts=[];
  for(const name of ['plugin-contract','plugin-sdk','feishu-meeting-intake']){
   run('pnpm',['--filter','@clowder-ai/'+name,'build'],root);
   // A frozen installation must pack offline even with a completely empty
   // registry metadata cache (the real pnpm 9 hoisted-deploy CI failure).
   const [pack]=JSON.parse(run(process.execPath,['scripts/pack-publish-artifact.mjs','packages/'+name,packs],root,
    {XDG_CACHE_HOME:join(temp,'cache'),npm_config_cache_dir:join(temp,'metadata'),npm_config_offline:'true'}));
   if(name==='feishu-meeting-intake'){
    assert.equal(pack.files.some(file=>file.path==='node_modules/@larksuite/cli/bin/lark-cli'),false,
     'postinstall-generated vendor runner must not duplicate the fixed dist/lark-cli');
    const budget=join(temp,'budget');await mkdir(budget);run('tar',['-xzf',join(packs,pack.filename),'-C',budget],temp);
    assert.ok(await fileBytes(budget)<=64*1024*1024,'meeting archive exceeds Host uncompressed budget');
   }
   artifacts.push(join(packs,pack.filename));console.log(JSON.stringify({name,sha1:pack.shasum,integrity:pack.integrity,members:pack.files.length}));
  }
  await writeFile(join(consumer,'package.json'),JSON.stringify({private:true,type:'module'}));
  run('npm',['install','--ignore-scripts','--no-audit','--no-fund','--package-lock=false',...artifacts],consumer);
  await cp(new URL('./installed-consumer.mjs',import.meta.url),join(consumer,'journey.mjs'));
  console.log(run(process.execPath,['journey.mjs'],consumer));
  if(process.env.F202_MEETING_ARTIFACT_DIR){await mkdir(process.env.F202_MEETING_ARTIFACT_DIR,{recursive:true});for(const artifact of artifacts)await cp(artifact,join(process.env.F202_MEETING_ARTIFACT_DIR,artifact.split('/').at(-1)));}
 } finally {await rm(temp,{recursive:true,force:true});}
});
