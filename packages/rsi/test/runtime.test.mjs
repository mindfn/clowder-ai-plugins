import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { copyFile, access, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
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
  const end = performance.now() + 60000;
  while (performance.now() < end) { const value = await read(); if (predicate(value)) return value; await delay(100); }
  assert.fail(`Timed out: ${description}`);
}

async function fixture(t) {
  const project = await mkdtemp(join(tmpdir(), 'rsi phase2-'));
  await writeFile(join(project, 'simulate.mjs'), script);
  for (const file of ['experiment.py', 'async-executor.sh']) await copyFile(new URL(`fixtures/${file}`, import.meta.url), join(project, file));
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
    assert.deepEqual(result.acts?.map((a) => a.act), ['thread', 'open'], JSON.stringify(result));
    const state = await read(), d = Object.values(state.experiments).find((d) => d.objective.projectPath === project);
    return { id: d.objective.id, thread: result.acts[0].args.id, result };
  };
  const tool = (method, input, catId, threadId, invocationId = `${catId}-turn`) => activation.actions[`rsi.${method}`](input,
    { catId, threadId, userId: 'owner', invocationId, assertCurrent: async () => {} });
  const commands = { preflight: 'test -f simulate.mjs', submit: `'${process.execPath}' simulate.mjs {config} {run} {seed}`, collect: '{run}/metrics.json' };
  async function initialize(objective, plan = { groups: [{ id: 'control', label: 'Control', vars: { delta: 0 }, control: true }, { id: 'change', label: 'Change', vars: { delta: 1 } }], seeds: [11, 23] }, options = {}) {
    for (let guard = 0; guard < 12; guard++) {
      const d = (await read()).experiments[objective.id];
      if (d.plan.every((p) => d.steps[p.k])) break;
      const [section, execution] = Object.entries(d.exec).find(([, e]) => e.state === 'started');
      const task = await tool('task', {}, execution.by, objective.thread);
      const step = task.steps.find((s) => s.section === section);
      assert.ok(step?.ask); assert.ok(step.items.every((i) => i.meaning && i.format && i.example));
      const result = await tool('submit', { step: step.step, items: (step.examples ? step.examples.map((x) => ({ id: `own-${x.id}`, title: `Own ${x.title}` })) : step.items.filter((i) => !i.userOwned)).map((i) => ({ id: i.id, title: i.title, value: `Observed ${i.title}` })),
        unknowns: '', next: '', ...(section === 'run' ? { window: options.window || '20:00–08:00' } : {}), ...(section === 'rules' ? { metrics: options.metrics || { version: 'E1', items: [{ id: 'score', name: 'Score', how: 'metrics.score', dir: 'up' }] } } : {}),
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
  assert.deepEqual(objective.result.acts, [{ act: 'thread', args: { id: objective.thread } }, { act: 'open', args: { ref: 'plugin:official.rsi/rsi.panel' } }]);
  // A woken member is told the RSI tools are reached through plugin_call, with the exact arguments.
  assert.ok(f.sends.some((x) => x.wake && x.payload.elements[0].payload.text.includes('plugin_call({ pluginId: "official.rsi", contributionId: "rsi.task", toolName: "rsi.task", arguments: {} })')));
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
  assert.deepEqual(scope.items, []); assert.ok(scope.itemsAreYours && scope.examples.length);
  { const r = await f.tool('submit',{step:2,items:scope.examples.map((x)=>({id:`own-${x.id}`,title:`Own ${x.title}`,value:'Scope'}))},'codex',o.thread); assert.equal(r.ok,true); }
  assert.ok((await f.read()).experiments[o.id].prep.filter((p)=>p.section==='scope').every((p)=>p.title.startsWith('Own ') && p.state==='submitted'));
  const rules = await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  assert.ok(rules.steps[0].deps.every((d)=>d.version===1 && d.items.length));
  const invalidGuard = await f.tool('submit', {step:4, items:rules.steps[0].examples.map((x)=>({id:`own-${x.id}`,title:`Own ${x.title}`,value:'metric'})), metrics:{version:'E1',items:[{id:'score',name:'Score',how:'score',dir:'up'},{id:'cost',name:'Cost',how:'cost',dir:'down',guard:true}]}}, 'cat-b5ddoo9l', o.thread);
  assert.match(invalidGuard.error, /finite threshold/);
  assert.equal((await f.read()).experiments[o.id].steps.rules, undefined);
  await f.http('POST',{op:'prep',objective:o.id,id:'cp-good',action:'edit',note:'',value:'New criterion'},{project:f.project});
  assert.equal((await f.tool('submit',{step:4,items:rules.steps[0].items.map((i)=>({id:i.id,value:'metric'}))},'cat-b5ddoo9l',o.thread)).status,409);
  const revised = await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  assert.notEqual(revised.steps[0].executionId, rules.steps[0].executionId);
  assert.equal(revised.steps[0].deps[0].version, 2);
});

test('three real cycles execute groups × seeds serially, render measured runs, conclude, decide and use new versions', async (t) => {
  const f = await fixture(t), o = await f.create(); await f.initialize(o);
  for (let n = 1; n <= 3; n++) {
    const started = await f.http('POST', { op: 'runCycle', objective: o.id }, {project:f.project});
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
    assert.equal((await f.tool('conclude',{cycle:n,verdict:'tune',findings:['Measured improvement'],options:[{k:'lower',title:'Lower rate',why:'Try a smaller update',cites:task.evaluate.library.map((d)=>d.id)}]},'codex',o.thread)).status,403);
    assert.equal((await f.tool('conclude',{cycle:n,verdict:'tune',findings:['Measured improvement'],options:[{k:'lower',title:'Lower rate',why:'Try a smaller update',cites:task.evaluate.library.map((d)=>d.id)}]},'cat-b5ddoo9l',o.thread)).ok,true);
    const concluded=await f.http('GET',undefined,{view:'exp',project:f.project,pick:`obj:${o.id}`});
    assert.equal(concluded.cycle.waiting,true); assert.equal(concluded.cycle.report.directions[0].id,'lower');
    assert.ok(f.sends.some((s)=>s.payload.elements.some((e)=>e.kind==='rich_block' && e.payload.kind==='card' && e.payload.title.includes(`第 ${n} 周期结论`))));
    if(n===3) break;
    assert.equal((await f.http('POST',{op:'expDecide',objective:o.id,n,pick:'direction',directionId:'lower'},{project:f.project})).status,200);
    if (n === 1) {
      assert.equal((await f.read()).experiments[o.id].candidate.cycle,1);
    } else {
      assert.ok((await f.http('POST',{op:'runCycle',objective:o.id})).error);
      const taskVersion=await f.tool('task',{},'codex',o.thread); assert.equal(taskVersion.version.title,'Lower rate');
      await writeFile(join(f.project, 'next-config.json'), JSON.stringify({delta:10}));
      assert.equal((await f.tool('version',{change:'Delta 10',config:'next-config.json'},'codex',o.thread)).version,'v3');
    }
  }
  const d=(await f.read()).experiments[o.id];
  assert.equal(d.rounds.length,3); assert.equal(d.versions.length,3);
  assert.equal(d.objective.currentVersion,'v2');
  assert.equal(d.rounds[1].confirmation.status,'confirmed');
  assert.equal(d.rounds[1].runs.find((r)=>r.group==='change'&&r.seed===24).metrics.score,25);
  assert.equal(d.rounds[2].runs.find((r)=>r.group==='change'&&r.seed===26).metrics.score,36);
  assert.equal(d.rounds[2].runs.find((r)=>r.group==='control'&&r.seed===26).metrics.score,27);
  assert.equal((await readFile(join(f.project,'starts'),'utf8')).trim().split('\n').length,12);
});

test('non-zero submit retries once, then persists failures and sends a failure card', async (t) => {
  const f=await fixture(t),o=await f.create();
  await f.initialize(o,{groups:[{id:'once',label:'Retry succeeds',vars:{fail:'once'}},{id:'always',label:'Fails twice',vars:{fail:'always'}}],seeds:[1,2]});
  await f.http('POST',{op:'runCycle',objective:o.id});
  const state=await until(f.read,(s)=>s.experiments[o.id].rounds[0]?.state==='evaluating');
  const runs=state.experiments[o.id].rounds[0].runs;
  assert.ok(runs.filter((r)=>r.group!=='control').every((r)=>r.retries===1));
  assert.ok(runs.filter((r)=>r.group==='control').every((r)=>r.retries===0));
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
  await f.initialize(o,{groups:[{id:'control',label:'Slow run',vars:{slow:true},control:true}],seeds:[1]});
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

test('a real objective whose stop target names a metric needs that metric in step 4', async (t) => {
  const f = await fixture(t), o = await f.create({ target: 'accuracy ≥ 0.45' });
  await assert.rejects(f.initialize(o), /指标「accuracy」不在量尺里/);
  const g = await fixture(t), p = await g.create({ target: 'accuracy ≥ 0.45' });
  await g.initialize(p, undefined, { window: '每晚 20:00–08:00', metrics: { version: 'E1', items: [{ id: 'accuracy', name: 'Accuracy', how: 'metrics.json 的 accuracy', dir: 'up', guard: false }] } });
  const s = await g.read(), objective = s.objectives[g.project].find((x) => x.id === p.id);
  assert.equal(objective.trigger, '20:00–08:00');
  assert.equal(s.groups[g.project].find((x) => x.forObjective === p.id).users, objective.name);
});

test('structured tool arguments passed as JSON text are read as the structures they describe', async (t) => {
  const f = await fixture(t), o = await f.create();
  const d = (await f.read()).experiments[o.id], [section, execution] = Object.entries(d.exec).find(([k, e]) => k === 'goal' && e.state === 'started');
  const task = await f.tool('task', {}, execution.by, o.thread), step = task.steps.find((s) => s.section === section);
  const items = step.items.filter((i) => !i.userOwned).map((i) => ({ id: i.id, value: 'drafted' }));
  const result = await f.tool('submit', { step: step.step, items: JSON.stringify(items), unknowns: '', next: '' }, execution.by, o.thread);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('a conclusion may name its cycle as text; a cycle that does not exist is reported as such', async (t) => {
  const f = await fixture(t), o = await f.create();
  Object.assign(f.commands, pythonExecutor);
  await f.initialize(o, { groups: [{ id: 'control', label: 'Control', vars: {}, control: true }], seeds: [11] });
  await execute(f, o);
  const task = await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  const missing = await f.tool('conclude', { cycle: '9', verdict: 'tune', findings: 'x', options: [{ k: 'a', title: 'A', why: 'w' }] }, 'cat-b5ddoo9l', o.thread);
  assert.equal(missing.status, 404); assert.match(missing.error, /not found/);
  const result = await f.tool('conclude', { cycle: String(task.evaluate.cycle), verdict: 'tune', findings: 'Measured',
    options: [{ k: 'next', title: 'Next', why: 'w', cites: task.evaluate.library.map((d) => d.id) }] }, 'cat-b5ddoo9l', o.thread);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('deleting an objective kills its run and removes its runs folder, data, pending messages and cycle notes; other objectives keep running', async (t) => {
  const f = await fixture(t), o = await f.create();
  await f.initialize(o, { groups: [{ id: 'control', label: 'Slow run', vars: { slow: true }, control: true }], seeds: [1] });
  await f.http('POST', { op: 'runCycle', objective: o.id });
  const running = await until(f.read, (s) => s.experiments[o.id].rounds[0]?.runs[0]?.state === 'running');
  const pid = await until(() => readFile(join(running.experiments[o.id].rounds[0].runs[0].directory, 'pid'), 'utf8').then(Number, () => null), (p) => p !== null, 'child process start');
  const stored = await f.storage.get(ownerKey('owner'));
  stored.value.library[f.project].push({ id: `${o.id}-cycle-1`, kind: 'feedback', title: 'c1', objectives: [o.id], cycle: 1 }, { id: 'shared', kind: 'provided', title: 's', objectives: [o.id, 'other'] });
  assert.ok((await f.storage.compareAndSet(ownerKey('owner'), stored.revision, stored.value)).applied);
  assert.equal((await f.http('POST', { op: 'delete', objective: o.id }, { project: f.project })).status, 200);
  await until(async () => { try { process.kill(pid, 0); return false; } catch { return true; } }, Boolean, 'run killed');
  const s = await f.read();
  assert.equal(s.experiments[o.id], undefined);
  assert.ok(!Object.values(s.objectives).flat().some((x) => x.id === o.id));
  assert.ok(!s.outbox.some((e) => e.objective === o.id));
  assert.ok(!(s.groups[f.project] || []).some((g) => g.forObjective === o.id));
  assert.deepEqual(s.library[f.project].filter((d) => [`${o.id}-cycle-1`, 'shared'].includes(d.id)).map((d) => [d.id, d.objectives]), [['shared', ['other']]]);
  await assert.rejects(access(join(f.project, 'runs', o.id)));
  assert.equal((await f.http('POST', { op: 'delete', objective: o.id }, { project: f.project })).status, 404);
  await rm(join(f.project, 'active-run'), { recursive: true, force: true });   // the killed run could not release the simulator's lock
  const next = await f.create();
  await f.initialize(next, { groups: [{ id: 'control', label: 'Control', vars: { delta: 0 }, control: true }], seeds: [1] });
  await f.http('POST', { op: 'runCycle', objective: next.id });
  await until(f.read, (s) => s.experiments[next.id].rounds[0]?.state === 'evaluating', 'the next objective runs');
});


test('preflight failure cannot complete step 3; retry probes again before accepting its submission', async (t) => {
  const f=await fixture(t),o=await f.create();
  let task=await f.tool('task',{},'codex',o.thread);
  const items=(step)=>(step.examples?step.examples.map((x)=>({id:`own-${x.id}`,title:`Own ${x.title}`})):step.items.filter((i)=>!i.userOwned)).map((i)=>({id:i.id,title:i.title,value:'Observed execution environment'}));
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
  assert.equal(d.rounds[0].runs.find((r)=>r.group==='mapped').metrics.score,10);assert.ok(d.rounds[0].runs.every((r)=>r.state==='done'));
});

const plan = (vars = {}) => ({ groups: [{ id: 'change', label: 'Measured change', vars }], seeds: [11, 23] });
const pythonExecutor = { preflight: `printf '%s\\n' '{"python":"fixture-python","driver":"fixture-driver"}'`, submit: 'python3 experiment.py {config} {run} {seed}', collect: '{run}/metrics.json' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function execute(f, o) {
  const result = await f.http('POST', { op: 'runCycle', objective: o.id });
  assert.equal(result.status, 200, JSON.stringify(result));
  return (await until(f.read, (s) => s.experiments[o.id].rounds.at(-1)?.state === 'evaluating')).experiments[o.id].rounds.at(-1);
}
async function report(f, o, verdict = 'tune') {
  const task = await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  assert.ok(task.evaluate, JSON.stringify(task));
  const result = await f.tool('conclude', { cycle: task.evaluate.cycle, verdict, findings: 'Measured against this cycle’s control',
    options: [{ k: 'next', title: 'Next measurement', why: 'Check the evidence', cites: task.evaluate.library.map((d) => d.id) }] }, 'cat-b5ddoo9l', o.thread);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
async function decide(f, o, pick = 'same') {
  const d = (await f.read()).experiments[o.id];
  const result = await f.http('POST', { op: 'expDecide', objective: o.id, n: d.rounds.at(-1).n, pick, directionId: 'next' }, { project: f.project });
  assert.equal(result.status, 200, JSON.stringify(result));
}

test('every plan includes the default control, exposes paired seeds, confirms once, and cites the cycle library', async (t) => {
  const f = await fixture(t), o = await f.create();
  Object.assign(f.commands, pythonExecutor);
  await f.initialize(o, plan({ delta: 2 }));
  const first = await execute(f, o);
  assert.equal(first.plan.groups[0].id, 'control');
  assert.equal(first.plan.groups[0].version, 'v1');
  assert.deepEqual(first.runs.filter((r) => r.group === 'control').map((r) => r.seed), [11, 23]);
  const task = await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  const measured = task.evaluate.comparison;
  assert.equal(measured.against, 'control'); assert.equal(measured.cycle, 1);
  assert.equal(measured.groups.find((g) => g.group === 'change').delta, 2);
  const cell = measured.matrix.find((m) => m.group === 'change');
  assert.equal(cell.mean, 19); assert.deepEqual(cell.seeds.map((s) => s.value), [13, 25]);
  assert.equal(cell.lo, cell.mean - cell.sd); assert.equal(cell.hi, cell.mean + cell.sd);
  let result = await report(f, o);
  assert.equal(result.confirmation.status, 'candidate');
  let d = (await f.read()).experiments[o.id];
  assert.equal(d.objective.currentVersion, 'v1');
  assert.ok(d.upcoming.groups.find((g) => g.confirm));
  assert.ok((await f.http('POST', { op: 'runCycle', objective: o.id })).error);
  await decide(f, o);
  const second = await execute(f, o);
  assert.ok(second.plan.seeds.every((s) => !first.plan.seeds.includes(s)));
  const secondTask = await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  assert.equal(secondTask.evaluate.library.length, 1);
  assert.equal(secondTask.evaluate.library[0].sources[0].cycle, 1);
  assert.ok((await f.tool('conclude', { cycle: 2, verdict: 'keep', findings: 'Measured', options: [{ k: 'next', title: 'Next', why: 'Needs citations' }] }, 'cat-b5ddoo9l', o.thread)).error);
  result = await report(f, o, 'keep');
  assert.equal(result.comparison.groups.find((g) => g.group === 'change').delta, 2);
  assert.equal(result.confirmation.status, 'confirmed');
  d = (await f.read()).experiments[o.id];
  assert.equal(d.objective.currentVersion, 'v2');
  assert.equal(d.versions.find((v) => v.current).interval.mean, 26.5);
  assert.ok(d.versions.find((v) => v.current).interval.spread > 0);
  assert.equal((await f.read()).library[f.project].length, 2);
  await decide(f, o);
  const third = await execute(f, o);
  assert.equal(third.plan.groups.length, 1);
  assert.equal(third.plan.groups[0].version, 'v2');
  assert.equal(third.runs[0].metrics.score, third.runs[0].seed + 2);
});

test('commit versions use reusable project worktrees and retire them after the last allowed cycle', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.project, '.gitignore'), 'runs/\nplugin-data/\nstarts\nactive-run/\n');
  git(f.project, 'init', '-b', 'main'); git(f.project, 'config', 'user.name', 'Fixture'); git(f.project, 'config', 'user.email', 'fixture@example.invalid');
  git(f.project, 'add', '.'); git(f.project, 'commit', '-m', 'Baseline fixture');
  const initial = git(f.project, 'rev-parse', 'HEAD'), o = await f.create({ rounds: '3' });
  await f.initialize(o, { groups: [{ id: 'control', label: 'Baseline', vars: {}, control: true }], seeds: [11, 23] });
  const first = await execute(f, o);
  assert.equal(first.runs[0].env.commit, initial);
  const controlCwd = first.runs[0].cwd;
  assert.ok(controlCwd.startsWith(f.host.dataPath));
  await report(f, o, 'baseline'); await decide(f, o, 'direction');
  await writeFile(join(f.project, 'simulate.mjs'), script.replace('(config.delta||0)', '(config.delta||0)+50'));
  await writeFile(join(f.project, 'version-config.json'), '{"delta":3}');
  git(f.project, 'add', '.'); git(f.project, 'commit', '-m', 'Changed fixture');
  const changed = git(f.project, 'rev-parse', 'HEAD');
  await f.tool('task', {}, 'codex', o.thread);
  assert.equal((await f.tool('version', { change: 'Code and config change', commit: changed, config: 'version-config.json' }, 'codex', o.thread)).version, 'v2');
  assert.equal((await f.read()).experiments[o.id].objective.currentVersion, 'v1');
  const second = await execute(f, o), control = second.runs.find((r) => r.group === 'control'), change = second.runs.find((r) => r.group === 'change');
  assert.equal(control.cwd, controlCwd); assert.notEqual(change.cwd, control.cwd);
  assert.equal(control.metrics.score, control.seed); assert.equal(change.metrics.score, change.seed + 53);
  assert.equal(control.env.commit, initial); assert.equal(change.env.commit, changed);
  assert.equal(git(change.cwd, 'rev-parse', 'HEAD'), changed); assert.equal(git(control.cwd, 'rev-parse', 'HEAD'), initial);
  assert.equal(git(f.project, 'rev-parse', 'HEAD'), changed);
  assert.match(change.env.configHash, /^[a-f0-9]{64}$/); assert.notEqual(change.env.configHash, control.env.configHash);
  assert.equal(change.env.seed, change.seed); assert.ok(change.env.hardware.os && change.env.hardware.arch && change.env.hardware.chip);
  await report(f, o); await decide(f, o);
  const third = await execute(f, o);
  assert.equal(third.runs.find((r) => r.group === 'change').cwd, change.cwd);
  const result = await report(f, o, 'keep');
  assert.equal(result.confirmation.status, 'confirmed'); assert.equal(result.stop.kind, 'maxCycles');
  await until(f.read, (s) => s.experiments[o.id].versions.every((v) => !v.worktree), 'retired worktrees');
  assert.equal(await access(controlCwd).then(() => true, () => false), false);
  assert.equal(await access(change.cwd).then(() => true, () => false), false);
  assert.ok(!git(f.project, 'worktree', 'list').includes('plugin-data'));
  assert.ok((await f.http('POST', { op: 'runCycle', objective: o.id })).error);
});

test('a selection that loses on fresh seeds stays rejected and never replaces the default', async (t) => {
  const f = await fixture(t), o = await f.create(); Object.assign(f.commands, pythonExecutor);
  await f.initialize(o, plan({ delta: 10, only_selection: true }));
  const saved = await f.storage.get(ownerKey('owner')), proposed = saved.value.experiments[o.id];
  proposed.versions.push({id:'v2',parent:'v1',change:'Proposed config',config:{},commit:null,current:false,status:'proposed',at:Date.now()});
  proposed.upcoming.groups[0].version = 'v2';
  assert.equal((await f.storage.compareAndSet(ownerKey('owner'),saved.revision,saved.value)).applied,true);
  await execute(f, o); assert.equal((await report(f, o)).confirmation.status, 'candidate'); await decide(f, o);
  const round = await execute(f, o); assert.ok(round.plan.seeds.every((s) => s > 23));
  assert.equal((await report(f, o)).confirmation.status, 'rejected');
  const d = (await f.read()).experiments[o.id]; assert.equal(d.objective.currentVersion, 'v1'); assert.equal(d.candidate, undefined);
  assert.equal(d.versions.find((v)=>v.id==='v2').status,'rejected');
});

test('threshold guardrails veto faster groups and conclusion inputs show each crossed seed', async (t) => {
  const f = await fixture(t), o = await f.create(); Object.assign(f.commands, pythonExecutor);
  await f.initialize(o, { groups: [{ id: 'unsafe', label: 'Higher score with violations', vars: { delta: 100, cost: 3, quality: 0 } },
    { id: 'safe', label: 'Small safe gain', vars: { delta: 1 } }], seeds: [11, 23] }, { metrics: { version: 'E1', items: [
    { id: 'score', name: 'Score', how: 'metrics.score', dir: 'up' },
    { id: 'cost', name: 'Cost', how: 'metrics.cost', dir: 'down', guard: true, threshold: 2 },
    { id: 'quality', name: 'Quality', how: 'metrics.quality', dir: 'up', guard: true, threshold: 1 },
  ] } });
  await execute(f, o);
  const task = await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  const unsafe = task.evaluate.comparison.groups.find((g) => g.group === 'unsafe');
  assert.equal(unsafe.mean, 117); assert.equal(unsafe.beatsControl, false); assert.equal(unsafe.eligible, false);
  assert.equal(unsafe.guardrails.filter((g) => !g.pass).length, 4);
  const result = await report(f, o); assert.equal(result.confirmation.group, 'safe');
});

test('non-zero and killed processes retry once without evidence; NaN and declared failures remain results', async (t) => {
  const f = await fixture(t), o = await f.create(); Object.assign(f.commands, pythonExecutor, { failureField: 'failed' });
  await f.initialize(o, { groups: [
    { id: 'exit', label: 'Non-zero', vars: { exit: true } }, { id: 'kill', label: 'Killed', vars: { kill: true } },
    { id: 'nan', label: 'NaN', vars: { nan: true } }, { id: 'real', label: 'Declared failure', vars: { failed: true, delta: 1000 } },
    { id: 'good', label: 'Still runs', vars: { delta: 1 } },
  ], seeds: [7] });
  const round = await execute(f, o);
  for (const group of ['exit', 'kill']) {
    const run = round.runs.find((r) => r.group === group);
    assert.equal(run.retries, 1); assert.equal(run.state, 'failed'); assert.equal(run.error.kind, 'env'); assert.equal(run.evidence, false);
    assert.equal(run.attempts.length, 2); assert.ok(run.attempts.every((a) => a.error.kind === 'env'));
  }
  for (const group of ['nan', 'real']) {
    const run = round.runs.find((r) => r.group === group);
    assert.equal(run.retries, 0); assert.equal(run.state, 'done'); assert.equal(run.error.kind, 'real'); assert.equal(run.evidence, true);
  }
  assert.equal(round.runs.find((r) => r.group === 'nan').metrics.score, 'NaN');
  const good = round.runs.find((r) => r.group === 'good'); assert.equal(good.state, 'done');
  assert.equal(good.env.python, 'fixture-python'); assert.equal(good.env.driver, 'fixture-driver'); assert.equal(good.env.data, 'sample-data-v1');
  const result = await report(f, o);
  assert.equal(result.comparison.matrix.find((m) => m.group === 'exit').n, 0);
  assert.equal(result.confirmation.group, 'good');
});

test('target adoption, cycle budget, and stall stop new cycles after conclusions and deliver reasons', async (t) => {
  for (const condition of ['target', 'budget', 'stall']) await t.test(condition, async (t) => {
    const f = await fixture(t), o = await f.create(condition === 'target' ? { target: 'Score ≥ 25' } : condition === 'budget' ? { rounds: '1' } : { stall: '2' });
    Object.assign(f.commands, pythonExecutor);
    await f.initialize(o, condition === 'target' ? plan({ delta: 10 }) : { groups: [{ id: 'control', label: 'Control', vars: {}, control: true }], seeds: [11, 23] });
    const cycles = condition === 'target' ? 2 : condition === 'budget' ? 1 : 3;
    for (let n = 1; n <= cycles; n++) {
      await execute(f, o); const result = await report(f, o);
      if (n < cycles) { assert.equal(result.stop, null); await decide(f, o); }
    }
    const d = (await f.read()).experiments[o.id];
    assert.equal(d.objective.state, condition === 'stall' ? 'paused' : 'done');
    assert.equal(d.objective.stopReason.kind, condition === 'budget' ? 'maxCycles' : condition);
    assert.ok(f.sends.some((s) => s.payload.elements.some((e) => e.kind === 'rich_block' && e.payload.title === d.objective.stopReason.text)));
    assert.ok((await f.http('POST', { op: 'runCycle', objective: o.id })).error);
    await f.activation().actions['rsi.tick']();
    assert.equal((await f.read()).experiments[o.id].rounds.length, cycles);
  });
});

test('schedule handler uses the confirmed local window, readiness, idle state and previous decisions with a fake clock', async (t) => {
  const f = await fixture(t), o = await f.create(); await f.initialize(o, plan({ delta: 1 }), { window: '每晚 20:00–08:00' });
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 15, 19, 59).getTime() });
  const tick = () => f.activation().actions['rsi.tick']();
  const at = (day, hour, minute = 0) => t.mock.timers.setTime(new Date(2026, 10, day, hour, minute).getTime());
  await tick(); assert.equal((await f.read()).experiments[o.id].rounds.length, 0);
  assert.equal((await f.http('POST', { op: 'life', action: 'start', objective: o.id })).status, 200);
  await tick(); assert.equal((await f.read()).experiments[o.id].rounds.length, 0);
  at(15, 20);
  await Promise.all([tick(), tick()]);
  assert.equal((await f.read()).experiments[o.id].rounds.length, 1);
  await until(f.read, (s) => s.experiments[o.id].rounds[0].state === 'evaluating');
  await tick(); assert.equal((await f.read()).experiments[o.id].rounds.length, 1);
  await report(f, o); await tick(); assert.equal((await f.read()).experiments[o.id].rounds.length, 1);
  await decide(f, o);
  await f.http('POST', { op: 'life', action: 'pause', objective: o.id });
  await tick(); assert.equal((await f.read()).experiments[o.id].rounds.length, 1);
  await f.http('POST', { op: 'life', action: 'resume', objective: o.id });
  at(16, 8); await tick(); assert.equal((await f.read()).experiments[o.id].rounds.length, 1);
  at(16, 0); await tick(); assert.equal((await f.read()).experiments[o.id].rounds.length, 2);
  await until(f.read, (s) => s.experiments[o.id].rounds[1].state === 'evaluating');
  await report(f, o); await decide(f, o); at(16, 19); await tick();
  assert.equal((await f.read()).experiments[o.id].rounds.length, 2);
});

const asyncExecutor = { preflight: 'test -f async-executor.sh', submit: 'sh async-executor.sh submit {config} {run} {seed}',
  get: 'sh async-executor.sh get {run} {job}', cancel: 'sh async-executor.sh cancel {run} {job}', collect: '{run}/metrics.json' };

test('async submit persists literal job ids, polls get to completion, then collects results', async (t) => {
  const f = await fixture(t), o = await f.create(); Object.assign(f.commands, asyncExecutor);
  await f.initialize(o, { groups: [{ id: 'control', label: 'Async control', vars: {}, control: true }], seeds: [11, 23] });
  const round = await execute(f, o);
  assert.ok(round.runs.every((r) => r.state === 'done' && r.metrics.score === r.seed && r.attempts[0].jobId === 'job with spaces;literal'));
  for (const run of round.runs) {
    assert.equal((await readFile(join(run.directory, 'polls'), 'utf8')).trim(), '2');
    assert.equal((await readFile(join(run.directory, 'submits'), 'utf8')).trim(), '1');
  }
});

test('stopping async polling calls optional cancel and preserves retryable interruption', async (t) => {
  const f = await fixture(t), o = await f.create(); Object.assign(f.commands, asyncExecutor);
  await f.initialize(o, { groups: [{ id: 'control', label: 'Async control', vars: {}, control: true }], seeds: [7] });
  await f.http('POST', { op: 'runCycle', objective: o.id });
  const state = await until(f.read, (s) => s.experiments[o.id].rounds[0]?.runs[0]?.jobId);
  const directory = state.experiments[o.id].rounds[0].runs[0].directory;
  await f.activation().stop();
  assert.equal((await readFile(join(directory, 'cancelled'), 'utf8')).trim(), 'job with spaces;literal');
  const d = (await f.read()).experiments[o.id]; assert.equal(d.rounds[0].state, 'interrupted'); assert.equal(d.rounds[0].runs[0].retryable, true);
});

test('async executors without cancel resume a persisted job after restart without resubmitting', async (t) => {
  const f = await fixture(t), o = await f.create(); Object.assign(f.commands, asyncExecutor); delete f.commands.cancel;
  await f.initialize(o, { groups: [{ id: 'control', label: 'Async control', vars: {}, control: true }], seeds: [7] });
  await f.http('POST', { op: 'runCycle', objective: o.id });
  await until(f.read, (s) => s.experiments[o.id].rounds[0]?.runs[0]?.jobId);
  await f.activation().stop(); f.start();
  await f.http('GET', undefined, { view: 'exp', project: f.project, pick: `obj:${o.id}` });
  const d = (await until(f.read, (s) => s.experiments[o.id].rounds[0].state === 'evaluating')).experiments[o.id];
  const run = d.rounds[0].runs[0]; assert.equal(run.state, 'done'); assert.equal(run.metrics.score, 7);
  assert.equal((await readFile(join(run.directory, 'submits'), 'utf8')).trim(), '1');
});

test('an environment failure during confirmation retains the candidate and does not count as a stall', async (t) => {
  const f = await fixture(t), o = await f.create({ stall: '1' }); Object.assign(f.commands, pythonExecutor);
  await f.initialize(o, plan({ delta: 2 }));
  await execute(f, o); await report(f, o); await decide(f, o);
  const source = await readFile(join(f.project, 'experiment.py'), 'utf8');
  await writeFile(join(f.project, 'experiment.py'), source.replace("if config.get('kill'):", "if int(seed) > 23 and config.get('delta'):\n    sys.exit(9)\nif config.get('kill'):"));
  await execute(f, o);
  const result = await report(f, o, 'insufficient');
  assert.equal(result.confirmation.status, 'insufficient'); assert.equal(result.stop, null);
  let d = (await f.read()).experiments[o.id]; assert.ok(d.candidate); assert.equal(d.objective.progress.stall, 0); assert.equal(d.objective.currentVersion, 'v1');
  await writeFile(join(f.project, 'experiment.py'), source);
  await decide(f, o); const third = await execute(f, o); assert.ok(third.plan.seeds.every((s) => s > 25));
  assert.equal((await report(f, o)).confirmation.status, 'confirmed');
  d = (await f.read()).experiments[o.id]; assert.equal(d.objective.currentVersion, 'v2');
});

test('a step that becomes the caller’s during its turn is handed over in the reply, not by a second wake; a turn that ends with it open wakes once', async (t) => {
  const f = await fixture(t), o = await f.create();
  const own = (step, value) => step.examples ? step.examples.map((x) => ({ id: `own-${x.id}`, title: `Own ${x.title}`, value })) : step.items.filter((i) => !i.userOwned).map((i) => ({ id: i.id, value }));
  const scope = (await f.tool('task', {}, 'codex', o.thread)).steps.find((s) => s.section === 'scope');
  assert.equal((await f.tool('submit', { step: scope.step, items: own(scope, 'Scope') }, 'codex', o.thread)).ok, true);
  const goalDispatch = f.sends.filter((s) => s.wake?.catId === 'cat-b5ddoo9l').at(-1);
  const goal = (await f.tool('task', {}, 'cat-b5ddoo9l', o.thread)).steps.find((s) => s.section === 'goal');
  const woken = f.sends.filter((s) => s.wake?.catId === 'cat-b5ddoo9l').length;
  const result = await f.tool('submit', { step: goal.step, items: own(goal, 'Goal') }, 'cat-b5ddoo9l', o.thread);
  assert.equal(result.ok, true); assert.match(result.next, /第 4 步/);
  assert.equal(f.sends.filter((s) => s.wake?.catId === 'cat-b5ddoo9l').length, woken);
  assert.ok(f.sends.at(-1).payload.elements[0].payload.text.includes('第 4 步'));
  for (const event of [{ state: 'started', replyTo: goalDispatch.messageId }, { state: 'settled', outcome: 'completed', chainDone: true }])
    await f.activation().deliver({ kind: 'execution_status', deliveryId: `turn-${event.state}`, threadId: o.thread, executionId: 'kimi-turn', ...event });
  await f.activation().deliver({ kind: 'execution_status', deliveryId: 'turn-settled-again', threadId: o.thread, executionId: 'kimi-turn', state: 'settled', outcome: 'completed', chainDone: true });
  assert.equal(f.sends.filter((s) => s.wake?.catId === 'cat-b5ddoo9l').length, woken + 1);
  assert.equal((await f.read()).experiments[o.id].exec.rules.state, 'started');
});
