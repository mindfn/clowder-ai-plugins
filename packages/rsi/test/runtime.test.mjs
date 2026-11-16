import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import plugin from '../dist/index.js';
import { ownerKey } from '../dist/backend.js';

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const script = `
import {readFile,writeFile,mkdir,rm,appendFile} from 'node:fs/promises';
const [configFile,run,seed]=process.argv.slice(2);
const config=JSON.parse(await readFile(configFile,'utf8'));
const lock=process.cwd()+'/active-run';
await mkdir(lock);
try {
 await writeFile(run+'/pid',String(process.pid));
 await appendFile('starts',run+'\\n');
 if(config.slow) await new Promise(r=>setTimeout(r,30000));
 const attempt=await readFile(run+'/attempt','utf8').then(Number,()=>0)+1;
 await writeFile(run+'/attempt',String(attempt));
 if(config.fail==='always'||config.fail==='once'&&attempt===1) {process.exitCode=7;}
 else await writeFile(run+'/metrics.json',JSON.stringify({metrics:{score:Number(seed)+(config.delta||0)}}));
} finally {await rm(lock,{recursive:true,force:true});}
`;

async function until(read, predicate, description = 'state transition') {
  const end = Date.now() + 6000;
  while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await delay(10); }
  assert.fail(`Timed out: ${description}`);
}

async function fixture(t) {
  const project = await mkdtemp(join(tmpdir(), 'rsi phase2-'));
  await writeFile(join(project, 'simulate.mjs'), script);
  const entries = new Map(), threads = [{ id: 'source', projectRef: project, lastActiveAt: 100 }], sends = [], subscriptions = [];
  let revision = 0, activation, sendHook;
  const storage = {
    async list() { return clone(Object.fromEntries(entries)); },
    async get(key) { return clone(entries.get(key)); },
    async compareAndSet(key, expected, value) {
      if ((entries.get(key)?.revision ?? null) !== expected) return { applied: false };
      entries.set(key, { revision: ++revision, value: clone(value) }); return { applied: true };
    },
  };
  const host = { pluginInstanceId: 'rsi-live-test', storage, dataPath: join(project, 'plugin-data'),
    log(_level, message, fields) { assert.fail(`${message}: ${JSON.stringify(fields)}`); },
    threads: {
      async list({ before, limit } = {}) { const offset = before ? threads.findIndex((t) => t.id === before.id) + 1 : 0; return clone(threads.slice(offset, offset + (limit || 100))); },
      async get(id) { return clone(threads.find((t) => t.id === id) || null); },
      async create(input) { const thread = { ...input, id: `objective-thread-${threads.length}`, lastActiveAt: 99 }; threads.push(thread); return clone(thread); },
    },
    messaging: {
      async subscribe(input) { subscriptions.push(input); },
      async send(input) {
        let sent = sends.find((s) => s.idempotencyKey === input.idempotencyKey);
        if (!sent) { sent = { ...input, messageId: `message-${sends.length}` }; sends.push(sent); if (sendHook) await sendHook(sent); }
        return { messageId: sent.messageId };
      },
    },
  };
  const start = () => activation = plugin.create().start(host);
  start();
  const owner = { kind: 'owner-http-request', pluginInstanceId: host.pluginInstanceId, userId: 'owner', assertCurrent: async () => {} };
  const http = async (method, body, query) => {
    const response = await activation.actions[method === 'GET' ? 'rsi.view' : 'rsi.act']({ request: { method, body, query } }, undefined,
      { ...owner, operation: method === 'GET' ? 'read' : 'write' });
    return { status: response.status, ...JSON.parse(response.body) };
  };
  const read = async () => (await storage.get(ownerKey('owner')))?.value;
  const create = async (extra = {}) => {
    const result = await http('POST', { op: 'new', project: '', thread: 'source', statement: 'Improve a measured score', prepare: 'codex', evaluate: 'cat-b5ddoo9l', ...extra });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.act, 'thread', JSON.stringify(result));
    const state = await read(), d = Object.values(state.experiments).find((d) => d.objective.projectPath === project);
    return { id: d.objective.id, thread: result.args.id, result };
  };
  const tool = (method, input, catId, threadId, invocationId = `${catId}-turn`) => activation.actions[`rsi.${method}`](input,
    { catId, threadId, userId: 'owner', invocationId, assertCurrent: async () => {} });
  const commands = { preflight: 'test -f simulate.mjs', submit: `'${process.execPath}' simulate.mjs {config} {run} {seed}`, collect: '{run}/metrics.json' };
  async function initialize(objective, plan = { groups: [{ id: 'control', label: 'Control', vars: { delta: 0 }, control: true }, { id: 'change', label: 'Change', vars: { delta: 1 } }], seeds: [11, 23] }) {
    for (let guard = 0; guard < 12; guard++) {
      const d = (await read()).experiments[objective.id];
      if (d.plan.every((p) => d.steps[p.k])) break;
      const [section, execution] = Object.entries(d.exec).find(([, e]) => e.state === 'started');
      const task = await tool('task', {}, execution.by, objective.thread);
      const step = task.steps.find((s) => s.section === section);
      assert.ok(step?.ask); assert.ok(step.items.every((i) => i.meaning && i.format && i.example));
      const result = await tool('submit', { step: step.step, items: step.items.filter((i) => !i.userOwned).map((i) => ({ id: i.id, value: `Observed ${i.title}` })),
        unknowns: '', next: '', ...(section === 'rules' ? { metrics: { version: 'E1', items: [{ id: 'score', name: 'Score', how: 'metrics.score', dir: 'up' }] } } : {}),
        ...(section === 'design' ? { upcoming: plan } : {}) }, execution.by, objective.thread);
      assert.equal(result.ok, true, JSON.stringify(result));
      if (section === 'run') {
        assert.equal(result.state, 'awaiting-preflight');
        assert.equal((await tool('executor', commands, execution.by, objective.thread)).state, 'probing');
        await until(read, (s) => s.experiments[objective.id].steps.run, 'preflight and pending submission');
      }
    }
    let d = (await read()).experiments[objective.id];
    assert.ok(d.plan.every((p) => d.steps[p.k]));
    for (const item of d.prep.filter((p) => p.neededFrom === 'human' && p.state !== 'confirmed')) {
      assert.equal((await http('POST', { op: 'prep', objective: objective.id, id: item.id, action: 'confirm' }, { project })).status, 200);
    }
    d = (await read()).experiments[objective.id];
    assert.equal(d.objective.state, 'ready');
  }
  t.after(async () => { await activation.stop(); await rm(project, { recursive: true, force: true }); });
  return { project, host, storage, sends, subscriptions, threads, http, read, create, tool, initialize, commands, start,
    activation: () => activation, onSend(fn) { sendHook = fn; } };
}

test('host projects, current-thread dialog selection, real threads and exact wakes preserve demo behavior', async (t) => {
  const f = await fixture(t);
  const home = await f.http('GET', undefined, { view: 'home' });
  assert.equal(home.projects[0].id, f.project); assert.equal(home.projects[0].name, basename(f.project)); assert.equal(home.projects[0].exp, true);
  assert.equal(home.projects.length, 7);
  const objective = await f.create();
  assert.equal(objective.result.act, 'thread');
  assert.equal(f.threads.at(-1).projectRef, f.project);
  assert.deepEqual(f.threads.at(-1).participants, ['codex', 'cat-b5ddoo9l']);
  assert.equal((await f.read()).experiments[objective.id].objective.projectPath, f.project);
  assert.equal(f.sends.length, 3);
  assert.deepEqual(f.sends.filter((s) => s.wake).map((s) => s.wake), [{catId:'cat-b5ddoo9l',exact:true},{catId:'codex',exact:true}]);
  assert.ok(f.sends.filter((s) => s.wake).every((s) => s.payload.elements[0].payload.text.includes('rsi.task')));
  assert.ok(f.subscriptions.some((s) => s.threadId === objective.thread && s.method === 'rsi.delivery'));
  assert.equal((await f.http('POST', { op: 'new', project: '', thread: 'missing', statement: 'x', prepare: 'a', evaluate: 'b' })).status, 400);
  assert.equal((await f.http('POST', { op: 'new', project: 'cartpole', projectPath: '/ignored-owner-input', statement: 'Demo', prepare: 'a', evaluate: 'b' })).status, 200);
  assert.equal(f.sends.length, 3); assert.equal(f.threads.length, 2);
});

test('tools enforce caller, dependencies, complete input and owner CAS without delivering rejected writes', async (t) => {
  const f = await fixture(t), o = await f.create();
  assert.equal((await f.tool('task', {}, 'outsider', o.thread)).status, 403);
  assert.equal((await f.tool('task', {}, 'codex', 'wrong-thread')).status, 404);
  assert.ok((await f.tool('submit', {step:2,items:[]}, 'codex', o.thread)).error);
  const task = await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  const items = task.steps[0].items.filter((i) => !i.userOwned).map((i) => ({id:i.id,value:'Observed'}));
  assert.ok((await f.tool('submit', {step:1,items:items.slice(1)}, 'cat-b5ddoo9l', o.thread)).error);
  const cas = f.storage.compareAndSet, before = await f.read(), sent = f.sends.length;
  f.storage.compareAndSet = async () => ({applied:false});
  assert.equal((await f.tool('submit', {step:1,items}, 'cat-b5ddoo9l', o.thread)).status, 409);
  assert.deepEqual(await f.read(), before); assert.equal(f.sends.length, sent);
  f.storage.compareAndSet = cas;
  assert.equal((await f.tool('submit', {step:1,items}, 'cat-b5ddoo9l', o.thread)).ok, true);
  const prepare = await f.tool('task', {}, 'codex', o.thread);
  const scope = prepare.steps[0];
  assert.equal((await f.tool('submit',{step:2,items:scope.items.filter((i)=>!i.userOwned).map((i)=>({id:i.id,value:'Scope'}))},'codex',o.thread)).ok,true);
  const rules = await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  assert.ok(rules.steps[0].deps.every((d)=>d.version===1 && d.items.length));
  await f.http('POST',{op:'prep',objective:o.id,id:'cp-good',action:'edit',note:'',value:'New criterion'},{project:f.project});
  assert.equal((await f.tool('submit',{step:4,items:rules.steps[0].items.map((i)=>({id:i.id,value:'metric'}))},'cat-b5ddoo9l',o.thread)).status,409);
  const revised = await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  assert.notEqual(revised.steps[0].executionId, rules.steps[0].executionId);
  assert.equal(revised.steps[0].deps[0].version, 2);
});

test('three real cycles execute groups × seeds serially, render measured runs, conclude, decide and use new versions', async (t) => {
  const f = await fixture(t), o = await f.create(); await f.initialize(o);
  for (let n = 1; n <= 3; n++) {
    const started = await f.http('POST', { op: n === 1 ? 'life' : 'runCycle', action: 'start', objective: o.id }, {project:f.project});
    assert.equal(started.status, 200, JSON.stringify(started));
    assert.ok((await f.http('POST',{op:'runCycle',objective:o.id})).error);
    const state = await until(f.read, (s) => s.experiments[o.id].rounds.at(-1)?.state === 'evaluating');
    const round = state.experiments[o.id].rounds.at(-1);
    assert.equal(round.n, n); assert.equal(round.runs.length, 4);
    assert.ok(round.runs.every((r) => r.state === 'done' && r.retries === 0));
    const ordered = [...round.runs].sort((a,b) => a.start - b.start);
    for (let i=1;i<ordered.length;i++) assert.ok(ordered[i].start >= ordered[i-1].end);
    const task = await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
    assert.equal(task.evaluate.runs.length, 4); assert.equal(task.projectPath, f.project);
    assert.ok(f.sends.some((s)=>s.wake?.catId==='cat-b5ddoo9l' && s.payload.elements[0].payload.text.includes(`第 ${n} 周期跑完`)));
    const page = await f.http('GET',undefined,{view:'exp',project:f.project,pick:`obj:${o.id}`});
    assert.equal(page.cycle.runs.length,4); assert.equal(page.cycle.runs[0].metricRows[0].k,'Score');
    assert.ok(page.cycle.runs.every((r)=>typeof r.durationSeconds==='number'));
    assert.equal((await f.tool('conclude',{cycle:n,verdict:'tune',findings:['Measured improvement'],options:[{k:'lower',title:'Lower rate',why:'Try a smaller update'}]},'codex',o.thread)).status,403);
    assert.equal((await f.tool('conclude',{cycle:n,verdict:'tune',findings:['Measured improvement'],options:[{k:'lower',title:'Lower rate',why:'Try a smaller update'}]},'cat-b5ddoo9l',o.thread)).ok,true);
    const concluded=await f.http('GET',undefined,{view:'exp',project:f.project,pick:`obj:${o.id}`});
    assert.equal(concluded.cycle.waiting,true); assert.equal(concluded.cycle.report.directions[0].id,'lower');
    assert.ok(f.sends.some((s)=>s.payload.elements.some((e)=>e.kind==='rich_block' && e.payload.kind==='card' && e.payload.title.includes(`第 ${n} 周期结论`))));
    if(n===3) break;
    assert.equal((await f.http('POST',{op:'expDecide',objective:o.id,n,pick:'direction',directionId:'lower'},{project:f.project})).status,200);
    assert.ok((await f.http('POST',{op:'runCycle',objective:o.id})).error);
    const taskVersion=await f.tool('task',{},'codex',o.thread); assert.equal(taskVersion.version.title,'Lower rate');
    if (n === 2) await writeFile(join(f.project, 'next-config.json'), JSON.stringify({delta: n*5}));
    assert.equal((await f.tool('version',{change:`Delta ${n}`,commit:'abc1234',config:n===2?'next-config.json':{delta:n*5}},'codex',o.thread)).version,`v${n+1}`);
  }
  const d=(await f.read()).experiments[o.id];
  assert.equal(d.rounds.length,3); assert.equal(d.versions.length,3);
  assert.equal(d.rounds[1].runs.find((r)=>r.group==='change'&&r.seed===11).metrics.score,16);
  assert.equal(d.rounds[2].runs.find((r)=>r.group==='change'&&r.seed===11).metrics.score,21);
  assert.equal(d.rounds[2].runs.find((r)=>r.group==='control'&&r.seed===11).metrics.score,16);
  assert.equal((await readFile(join(f.project,'starts'),'utf8')).trim().split('\n').length,12);
});

test('non-zero submit retries once, then persists failures and sends a failure card', async (t) => {
  const f=await fixture(t),o=await f.create();
  await f.initialize(o,{groups:[{id:'once',label:'Retry succeeds',vars:{fail:'once'}},{id:'always',label:'Fails twice',vars:{fail:'always'}}],seeds:[1,2]});
  await f.http('POST',{op:'runCycle',objective:o.id});
  const state=await until(f.read,(s)=>s.experiments[o.id].rounds[0]?.state==='evaluating');
  const runs=state.experiments[o.id].rounds[0].runs;
  assert.ok(runs.every((r)=>r.retries===1));
  assert.ok(runs.filter((r)=>r.group==='once').every((r)=>r.state==='done'));
  assert.ok(runs.filter((r)=>r.group==='always').every((r)=>r.state==='failed'&&r.error.raw.includes('exited 7')));
  assert.equal(f.sends.filter((s)=>s.payload.elements[0].payload.text.includes('运行失败（已重试一次）')).length,2);
});

test('execution lifecycle uses v2 replyTo, tolerates send acknowledgement races and rejects late old-step events', async (t) => {
  const f=await fixture(t);
  f.onSend(async (s)=>{
    if(s.wake?.catId!=='codex')return;
    for(const event of [{state:'started',replyTo:s.messageId},{state:'settled',outcome:'cancelled',chainDone:true}])
      assert.deepEqual(await f.activation().deliver({kind:'execution_status',deliveryId:`delivery-${event.state}`,threadId:s.threadId,executionId:'lifecycle-scope',...event}),{deliveryId:`delivery-${event.state}`});
  });
  const o=await f.create();
  assert.equal((await f.read()).experiments[o.id].exec.scope.state,'cancelled');
  f.onSend(undefined);
  const old=(await f.read()).experiments[o.id].exec.scope.id;
  await f.http('POST',{op:'initRetry',objective:o.id,k:'scope'},{project:f.project});
  assert.notEqual((await f.read()).experiments[o.id].exec.scope.id,old);
  await f.activation().deliver({kind:'execution_status',state:'settled',outcome:'failed',chainDone:true,executionId:'lifecycle-scope',deliveryId:'old',threadId:o.thread});
  assert.equal((await f.read()).experiments[o.id].exec.scope.state,'started');
  const dispatch=f.sends.filter((s)=>s.wake?.catId==='codex').at(-1);
  await f.activation().deliver({kind:'execution_status',state:'started',replyTo:dispatch.messageId,executionId:'new-exec',deliveryId:'new-start',threadId:o.thread});
  await f.activation().deliver({kind:'execution_status',state:'settled',outcome:'failed',chainDone:true,executionId:'new-exec',deliveryId:'new-fail',threadId:o.thread});
  assert.equal((await f.read()).experiments[o.id].exec.scope.state,'failed');
});

test('stop kills the owned process and restart restores subscriptions with failed-retryable interrupted runs', async (t) => {
  const f=await fixture(t),o=await f.create();
  await f.initialize(o,{groups:[{id:'slow',label:'Slow run',vars:{slow:true}}],seeds:[1]});
  await f.http('POST',{op:'runCycle',objective:o.id});
  const running=await until(f.read,(s)=>s.experiments[o.id].rounds[0]?.runs[0]?.state==='running');
  const directory=running.experiments[o.id].rounds[0].runs[0].directory;
  const pid=await until(()=>readFile(join(directory,'pid'),'utf8').then(Number,()=>null),(p)=>p!==null,'child process start');
  await f.activation().stop();
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  await rm(join(f.project,'active-run'),{recursive:true,force:true});
  const subscriptions=f.subscriptions.length;
  f.start();
  await f.http('GET',undefined,{view:'exp',project:f.project,pick:`obj:${o.id}`});
  let d=(await f.read()).experiments[o.id];
  assert.equal(d.rounds[0].state,'interrupted'); assert.equal(d.rounds[0].runs[0].state,'failed'); assert.equal(d.rounds[0].runs[0].retryable,true);
  assert.equal(f.subscriptions.length,subscriptions+1);
  const stored=await f.storage.get(ownerKey('owner'));
  stored.value.experiments[o.id].rounds[0].plan.groups[0].vars.slow=false;
  await f.storage.compareAndSet(ownerKey('owner'),stored.revision,stored.value);
  assert.equal((await f.http('POST',{op:'runCycle',objective:o.id})).status,200);
  d=(await until(f.read,(s)=>s.experiments[o.id].rounds[0].state==='evaluating')).experiments[o.id];
  assert.equal(d.rounds.length,1);assert.equal(d.rounds[0].runs[0].state,'done');
});


test('preflight failure cannot complete step 3; retry probes again before accepting its submission', async (t) => {
  const f=await fixture(t),o=await f.create();
  let task=await f.tool('task',{},'codex',o.thread);
  const items=(step)=>step.items.filter((i)=>!i.userOwned).map((i)=>({id:i.id,value:'Observed execution environment'}));
  assert.equal((await f.tool('submit',{step:2,items:items(task.steps[0])},'codex',o.thread)).ok,true);
  task=await f.tool('task',{},'codex',o.thread);
  assert.equal(task.steps[0].step,3);
  assert.equal((await f.tool('executor',{...f.commands,preflight:'exit 8'},'codex',o.thread)).state,'probing');
  await until(f.read,(s)=>s.experiments[o.id].exec.run.state==='failed');
  let d=(await f.read()).experiments[o.id];
  assert.equal(d.executor.state,'failed');assert.equal(d.steps.run,undefined);
  assert.equal((await f.http('POST',{op:'initRetry',objective:o.id,k:'run'},{project:f.project})).status,200);
  task=await f.tool('task',{},'codex',o.thread);
  assert.equal((await f.tool('executor',f.commands,'codex',o.thread)).state,'probing');
  await until(f.read,(s)=>s.experiments[o.id].executor.state==='passed');
  assert.equal((await f.read()).experiments[o.id].steps.run,undefined);
  assert.equal((await f.tool('submit',{step:3,items:items(task.steps[0])},'codex',o.thread)).ok,true);
  assert.ok((await f.read()).experiments[o.id].steps.run);
});

test('collect commands and explicit nested result mappings read actual metrics', async (t) => {
  const f=await fixture(t),o=await f.create();
  f.commands.collect='cat {run}/metrics.json';
  f.commands.resultMap=[{metric:'score',field:'metrics.score'}];
  await f.initialize(o,{groups:[{id:'mapped',label:'Mapped output',vars:{delta:3}}],seeds:[7]});
  await f.http('POST',{op:'runCycle',objective:o.id});
  const d=(await until(f.read,(s)=>s.experiments[o.id].rounds[0]?.state==='evaluating')).experiments[o.id];
  assert.equal(d.rounds[0].runs[0].metrics.score,10);assert.equal(d.rounds[0].runs[0].state,'done');
});
