import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {parse} from 'yaml';
const load=(file)=>parse(readFileSync(new URL(`../${file}`,import.meta.url),'utf8'));

test('phase 2 declarations expose five documented tools, a v2 subscription and matching release versions',()=>{
  const manifest=load('plugin.yaml');
  const tools=manifest.contributions.filter((c)=>c.type==='tool');
  assert.deepEqual(tools.map((c)=>c.name),['rsi.task','rsi.submit','rsi.executor','rsi.version','rsi.conclude']);
  for(const tool of tools){assert.equal(tool.action.method,tool.name);assert.equal(tool.inputSchema.type,'object');assert.ok(tool.description.length>150);}
  assert.equal(manifest.contributions.find((c)=>c.type==='message-subscription').presentation,'v2');
  for(const file of ['package.json','npm-shrinkwrap.json'])assert.equal(JSON.parse(readFileSync(new URL(`../${file}`,import.meta.url),'utf8')).version,manifest.version);
});

test('all new-objective openers bind currentThread and project choices; writes post both dialog fields',()=>{
  const pdl=load('console/pdl.yaml');
  assert.deepEqual(Object.keys(pdl.components).sort(),['css','js']);
  const walk=(value,visit)=>{if(!value||typeof value!=='object')return;visit(value);for(const child of Object.values(value))walk(child,visit);};
  let openers=0;
  for(const view of Object.values(pdl.views))walk(view,(node)=>{
    if(node.kind!=='rsiNewExp')return;
    openers++;assert.equal(node.thread,'$.currentThread.id');assert.equal(node.projects,'$.home.projects');
    assert.equal(view.sources.currentThread,'host:currentThread');
  });
  assert.ok(openers>=4);
  const dialog=pdl.views['dlg.rsiNewExp'];
  assert.equal(dialog.fields.find((f)=>f.arg==='project').options[0].v,'');
  assert.equal(dialog.okArgs.thread,'$.thread');
  assert.equal(dialog.fields.find((f)=>f.arg==='prepare').value,'codex');
  assert.equal(dialog.fields.find((f)=>f.arg==='evaluate').value,'cat-b5ddoo9l');
  assert.equal(pdl.requests.new.body.project,'@project');assert.equal(pdl.requests.new.body.thread,'@thread');
  assert.equal(pdl.requests.runCycle.body.op,'runCycle');assert.equal(pdl.requests.refresh.body.op,'refresh');
});
