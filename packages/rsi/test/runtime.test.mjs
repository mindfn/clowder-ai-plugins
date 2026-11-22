import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { copyFile, access, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import plugin from '../dist/index.js';
import { ownerKey, readState } from '../dist/backend.js';
import { retain } from '../dist/store.js';
import { quote } from '../dist/runs.js';

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const script = `
import {readFile,writeFile,mkdir,rm,appendFile} from 'node:fs/promises';
const [configFile,run,seed]=process.argv.slice(2);
const config=JSON.parse(await readFile(configFile,'utf8'));
const lock=process.cwd()+'/active-run';
await mkdir(lock);
try {
 await writeFile(run+'/pid',String(process.pid));
 if(config.logDir) await mkdir(run+'/rsi.log');
 await appendFile('starts',run+'\\n');
 if(config.slow) await new Promise(r=>setTimeout(r,30000));
 // Attempts are counted outside the run directory: a retry starts in an empty one.
 const counter=process.cwd()+'/attempts-'+run.split('/').slice(-2).join('-');
 const attempt=await readFile(counter,'utf8').then(Number,()=>0)+1;
 await writeFile(counter,String(attempt));
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
      // The Host refuses a value over 1 MiB (plugin-private-storage.ts).
      if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new TypeError('plugin storage value exceeds 1048576 bytes');
      if ((entries.get(key)?.revision ?? null) !== expected) return { applied: false };
      entries.set(key, { revision: ++revision, value: clone(value) }); return { applied: true };
    },
    async delete(key) { return { deleted: entries.delete(key) }; },
  };
  const host = { pluginInstanceId: 'rsi-live-test', storage, dataPath: join(project, 'plugin-data'),
    log(_level, message, fields) { assert.fail(`${message}: ${JSON.stringify(fields)}`); },
    threads: {
      async list({ before, limit } = {}) { const offset = before ? threads.findIndex((t) => t.id === before.id) + 1 : 0; return clone(threads.slice(offset, offset + (limit || 100))); },
      async get(id) { return clone(threads.find((t) => t.id === id) || null); },
      async create(input) {
        if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) throw new Error('invalid_member_thread_title');
        const thread = { ...input, id: `objective-thread-${threads.length}`, lastActiveAt: 99 }; threads.push(thread); return clone(thread);
      },
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
  const read = async () => (await readState(storage, ownerKey('owner')))?.value;
  // The suite runs at any hour: the night decides nothing by itself unless a test asks for it.
  const create = async (extra = {}) => {
    const before = new Set(Object.keys((await read())?.experiments || {}));
    const result = await http('POST', { op: 'new', project: '', thread: 'source', threadMode: 'new', statement: 'Improve a measured score', prepare: 'codex', evaluate: 'cat-b5ddoo9l',
      cats: [{ id: 'codex', name: '砚砚', model: 'gpt-5.6-sol', handle: '@codex', on: true }, { id: 'cat-b5ddoo9l', name: '小狸', model: 'k3.1', handle: '@kimi', on: true }], auto: 'none', ...extra });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.deepEqual(result.acts?.map((a) => a.act), ['thread', 'open'], JSON.stringify(result));
    const state = await read(), d = Object.values(state.experiments).find((d) => d.objective.projectPath === project && !before.has(d.objective.id));
    return { id: d.objective.id, thread: result.acts[0].args.id, result };
  };
  const tool = (method, input, catId, threadId, invocationId = `${catId}-turn`) => activation.actions[`rsi.${method}`](input,
    { catId, threadId, userId: 'owner', invocationId, assertCurrent: async () => {} });
  const commands = { preflight: 'test -f simulate.mjs', submit: `'${process.execPath}' simulate.mjs {config} {run} {seed}`, collect: '{run}/metrics.json' };
  // Members submit every step they are working on (first submissions and redos), then the user confirms what changed.
  async function prepare(objective, plan = { groups: [{ id: 'control', label: 'Control', vars: { delta: 0 }, control: true }, { id: 'change', label: 'Change', vars: { delta: 1 } }], seeds: [11, 23] }, options = {}) {
    for (let guard = 0; guard < 12; guard++) {
      const d = (await read()).experiments[objective.id];
      if (d.plan.every((p) => d.steps[p.k] && !d.steps[p.k].stale)) break;
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
  }
  async function initialize(objective, plan, options) {
    await prepare(objective, plan, options);
    assert.equal((await read()).experiments[objective.id].objective.state, 'ready');
  }
  t.after(async () => { await activation.stop(); await rm(project, { recursive: true, force: true }); });
  return { project, host, storage, sends, subscriptions, threads, http, read, create, tool, prepare, initialize, commands, start,
    activation: () => activation, onSend(fn) { sendHook = fn; } };
}

test('host projects, current-thread dialog selection, real threads and exact wakes preserve demo behavior', async (t) => {
  const f = await fixture(t);
  const home = await f.http('GET', undefined, { view: 'home' });
  assert.equal(home.projects[0].id, f.project); assert.equal(home.projects[0].name, basename(f.project)); assert.equal(home.projects[0].exp, true);
  assert.equal(home.projects.length, 7);
  const objective = await f.create();
  assert.deepEqual(objective.result.acts, [{ act: 'thread', args: { id: objective.thread } }, { act: 'open', args: { ref: 'plugin:official.rsi/rsi.panel' } }]);
  // A woken member gets a brief pointer to the registered `rsi` skill and native `rsi_task({})` tool (not hardcoded plugin_call boilerplate).
  assert.ok(f.sends.some((x) => x.wake && x.payload.elements[0].payload.text.includes('rsi skill') && x.payload.elements[0].payload.text.includes('rsi_task({})')));
  assert.equal(f.threads.at(-1).projectRef, f.project);
  assert.deepEqual(f.threads.at(-1).participants, ['codex', 'cat-b5ddoo9l']);
  assert.equal((await f.read()).experiments[objective.id].objective.projectPath, f.project);
  assert.equal(f.sends.length, 3);
  assert.deepEqual(f.sends.filter((s) => s.wake).map((s) => s.wake), [{catId:'cat-b5ddoo9l',exact:true},{catId:'codex',exact:true}]);
  assert.ok(f.sends.filter((s) => s.wake).every((s) => s.payload.elements[0].payload.text.includes('rsi_task')));
  assert.ok(f.subscriptions.some((s) => s.threadId === objective.thread && s.method === 'rsi.delivery'));
  assert.equal((await f.http('POST', { op: 'new', project: '', thread: 'missing', statement: 'x', prepare: 'a', evaluate: 'b' })).status, 400);
  assert.equal((await f.http('POST', { op: 'new', project: 'cartpole', projectPath: '/ignored-owner-input', statement: 'Demo', prepare: 'a', evaluate: 'b' })).status, 200);
  assert.equal(f.sends.length, 3); assert.equal(f.threads.length, 2);
});

const textOf = (send) => send.payload.elements[0].payload.text;
const creationCard = (f) => textOf(f.sends.find((s) => s.payload.elements.some((e) => e.kind === 'rich_block' && e.payload.title.startsWith('新评估项'))));
// The first word of a wake's last line: who it hands the work to.
const handedTo = (f) => f.sends.filter((s) => s.wake).map((s) => textOf(s).split('\n').at(-1).split(' ')[0]);

test('messages mention a member by its handle at a line start, like any routing message, never by @nickname', async (t) => {
  const f = await fixture(t); await f.create();
  const card = creationCard(f).split('\n');
  for (const line of ['@codex 负责准备', '@kimi 负责评估', '@codex 负责治理执行（按你选的方向出新版本）']) assert.ok(card.includes(line), card.join('\n'));
  assert.doesNotMatch(card.join('\n'), /@砚砚|@小狸/);
  assert.deepEqual(handedTo(f), ['@kimi', '@codex']);
});

test('a member without a handle is named without @; saving the members with the same roles fills the handles in', async (t) => {
  const f = await fixture(t), o = await f.create({ cats: [{ id: 'codex', name: '砚砚', model: 'gpt-5.6-sol', on: true }, { id: 'cat-b5ddoo9l', name: '小狸', model: 'k3.1', on: true }] });
  assert.ok(creationCard(f).split('\n').includes('砚砚 负责准备') && !creationCard(f).includes('@'), creationCard(f));
  assert.deepEqual(handedTo(f), ['小狸', '砚砚']);
  assert.ok((await f.read()).experiments[o.id].members.every((m) => !('handle' in m)));
  const sent = f.sends.length;
  assert.equal((await f.http('POST', { op: 'members', objective: o.id, prepare: 'codex', evaluate: 'cat-b5ddoo9l', iterate: 'codex',
    cats: [{ id: 'codex', name: '砚砚', model: 'gpt-5.6-sol', handle: '@codex', on: true }, { id: 'cat-b5ddoo9l', name: '小狸', model: 'k3.1', handle: '@kimi', on: true }] })).status, 200);
  assert.deepEqual((await f.read()).experiments[o.id].members.map((m) => [m.role, m.handle]), [['prepare', '@codex'], ['evaluate', '@kimi'], ['iterate', '@codex']]);
  // Nobody changed roles, so nothing is announced; the next step handed on mentions the handle.
  assert.equal(f.sends.length, sent);
  assert.equal((await f.http('POST', { op: 'initRetry', objective: o.id, k: 'goal', force: true })).status, 200);
  assert.equal(handedTo(f).at(-1), '@kimi');
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
  const conflictingThresholds = await f.tool('submit', {step:4, items:rules.steps[0].examples.map((x)=>({id:`own-${x.id}`,title:`Own ${x.title}`,value:'metric'})), metrics:{version:'E1',items:[{id:'score',name:'Score',how:'score',dir:'up',minDelta:1,margin:1}]}}, 'cat-b5ddoo9l', o.thread);
  assert.match(conflictingThresholds.error, /不能同时.*minDelta.*margin/);
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
    // A real objective's policy shows what its cycles use, not the demo template's.
    if (n===1) { assert.equal(page.policy.seeds,2); assert.deepEqual(page.policy.vars,[{name:'delta',values:['1']}]); assert.equal(page.policy.autoText.t,'rsi.exp.pol.manual'); }
    // While the evaluator works, the notice says whose conclusion the page waits for.
    assert.equal(page.next.k,'evaluating'); assert.equal(page.next.v,round.version); assert.ok(page.next.by);
    assert.ok(page.cycle.runs.every((r)=>typeof r.durationSeconds==='number'));
    assert.equal((await f.tool('conclude',{cycle:n,verdict:'tune',findings:['Measured improvement'],options:[{k:'lower',title:'Lower rate',why:'Try a smaller update',cites:task.evaluate.library.map((d)=>d.id)}]},'codex',o.thread)).status,403);
    assert.equal((await f.tool('conclude',{cycle:n,verdict:'tune',findings:['Measured improvement'],options:[{k:'lower',title:'Lower rate',why:'Try a smaller update',...(n===2?{kind:'variable'}:{}),cites:task.evaluate.library.map((d)=>d.id)}]},'cat-b5ddoo9l',o.thread)).ok,true);
    const concluded=await f.http('GET',undefined,{view:'exp',project:f.project,pick:`obj:${o.id}`});
    assert.equal(concluded.cycle.waiting,true); assert.equal(concluded.cycle.report.directions[0].id,'lower');
    // A direction is labelled only with the kind its member declared.
    assert.equal(concluded.cycle.report.directions[0].kind,n===2?'variable':undefined);
    assert.ok(f.sends.some((s)=>s.payload.elements.some((e)=>e.kind==='rich_block' && e.payload.kind==='card' && e.payload.title.includes(`第 ${n} 周期结论`))));
    if(n===3) break;
    assert.equal((await f.http('POST',{op:'expDecide',objective:o.id,n,pick:'direction',directionId:'lower'},{project:f.project})).status,200);
    if (n === 1) {
      assert.equal((await f.read()).experiments[o.id].candidate.cycle,1);
    } else {
      assert.ok((await f.http('POST',{op:'runCycle',objective:o.id})).error);
      // Until the version arrives, the notice says who prepares it and for which direction.
      const asked=await f.http('GET',undefined,{view:'exp',project:f.project,pick:`obj:${o.id}`});
      assert.equal(asked.next.k,'version'); assert.equal(asked.next.v,'Lower rate'); assert.ok(asked.next.by);
      const taskVersion=await f.tool('task',{},'codex',o.thread); assert.equal(taskVersion.version.title,'Lower rate');
      await writeFile(join(f.project, 'next-config.json'), JSON.stringify({delta:10}));
      assert.equal((await f.tool('version',{change:'Delta 10',config:'next-config.json'},'codex',o.thread)).version,'v3');
    }
  }
  const d=(await f.read()).experiments[o.id];
  assert.equal(d.rounds.length,3); assert.equal(d.versions.length,3);
  // A cycle belongs to the version it tests: cycles 1–2 try and confirm a variable on v1, cycle 3 tests v3 against v2.
  assert.deepEqual(d.rounds.map((r)=>r.version),['v1','v1','v3']);
  assert.equal(d.objective.currentVersion,'v2');
  assert.equal(d.rounds[1].confirmation.status,'confirmed');
  // The adoption names the interval in short numbers.
  const adopted=d.messages.find((m)=>m.body.includes('确认赢家，采用 v2'));
  assert.match(adopted.body,/确认赢家，采用 v2：\d+(\.\d{1,4})? ± (\d+(\.\d{1,4})?|无法估计)。/);
  assert.equal(d.rounds[1].runs.find((r)=>r.group==='change'&&r.seed===24).metrics.score,25);
  assert.equal(d.rounds[2].runs.find((r)=>r.group==='change'&&r.seed===26).metrics.score,36);
  assert.equal(d.rounds[2].runs.find((r)=>r.group==='control'&&r.seed===26).metrics.score,27);
  assert.equal((await readFile(join(f.project,'starts'),'utf8')).trim().split('\n').length,12);
});

test('non-zero submit retries once, invokes run-scoped cancel before retry, then persists failures and sends a failure card', async (t) => {
  const f=await fixture(t),o=await f.create({ repair: '0' });
  const cancelled=join(f.project,'retry-cancel.log');
  f.commands.cancel=`node -e "require('fs').appendFileSync(process.argv[1], process.argv[2] + '\\n')" "${cancelled}" {run}`;
  await f.initialize(o,{groups:[{id:'once',label:'Retry succeeds',vars:{fail:'once'}},{id:'always',label:'Fails twice',vars:{fail:'always'}}],seeds:[1,2]});
  await f.http('POST',{op:'runCycle',objective:o.id});
  const state=await until(f.read,(s)=>s.experiments[o.id].rounds[0]?.state==='evaluating');
  const runs=state.experiments[o.id].rounds[0].runs;
  assert.ok(runs.filter((r)=>r.group!=='control').every((r)=>r.retries===1));
  assert.ok(runs.filter((r)=>r.group==='control').every((r)=>r.retries===0));
  assert.ok(runs.filter((r)=>r.group==='once').every((r)=>r.state==='done'));
  assert.ok(runs.filter((r)=>r.group==='always').every((r)=>r.state==='failed'&&r.error.raw.includes('exited 7')));
  assert.equal((await readFile(cancelled,'utf8')).trim().split('\n').length,6);
  assert.equal(f.sends.filter((s)=>s.payload.elements[0].payload.text.includes('运行失败（已重试一次）')).length,2);
});

test('exit-0 preflight with multi-line NDJSON diagnostic stdout proceeds to submit instead of throwing JSON parse error', async (t) => {
  const f=await fixture(t),o=await f.create();
  f.commands.preflight=`node -e "console.log(JSON.stringify({npu:4,aicore:0})); console.log(JSON.stringify({npu:5,aicore:0}));"`;
  await f.initialize(o,{groups:[{id:'control',label:'Control',vars:{},control:true}],seeds:[5]});
  const run=(await execute(f,o)).runs[0];
  assert.equal(run.state,'done',JSON.stringify(run.error));
  assert.equal(run.error,null);
});

test('re-running Step 3 executor probe executes preflight in currentVersion worktree when currentVersion has a commit', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.project, '.gitignore'), 'runs/\nplugin-data/\nstarts\nactive-run/\n');
  git(f.project, 'init', '-b', 'main'); git(f.project, 'config', 'user.name', 'Fixture'); git(f.project, 'config', 'user.email', 'fixture@example.invalid');
  git(f.project, 'add', '.'); git(f.project, 'commit', '-m', 'Baseline fixture');
  const o = await f.create();
  await f.initialize(o, { groups: [{ id: 'control', label: 'Control', vars: {}, control: true }], seeds: [1] });
  const wt = join(f.project, '..', `probe-wt-${Date.now()}`);
  git(f.project, 'worktree', 'add', '-b', 'feat/probe-worktree-test', wt, 'HEAD');
  t.after(() => { try { git(f.project, 'worktree', 'remove', '--force', wt); } catch {} });
  await writeFile(join(wt, 'only-in-version.sh'), '#!/bin/sh\necho \'{"ok":true}\'\n');
  git(wt, 'add', 'only-in-version.sh'); git(wt, 'commit', '-m', 'add version-only preflight');
  const commit = git(wt, 'rev-parse', 'HEAD');
  await retain(f.storage, ownerKey('owner'), (state) => {
    const d = state.experiments[o.id];
    d.versions.push({ id: 'v2', commit, config: 'config.json', vars: {} });
    d.objective.currentVersion = 'v2';
  });
  await f.http('POST', { op: 'initStepRefresh', objective: o.id, k: 'run' }, { project: f.project });
  const by = (await f.read()).experiments[o.id].exec.run.by;
  await f.tool('task', {}, by, o.thread);
  const res = await f.tool('executor', { ...f.commands, preflight: 'sh only-in-version.sh' }, by, o.thread);
  assert.equal(res.state, 'probing', JSON.stringify(res));
  const after = await until(f.read, (s) => s.experiments[o.id].executor.state !== 'probing');
  assert.equal(after.experiments[o.id].executor.state, 'passed', JSON.stringify(after.experiments[o.id].executor.probe));
});

test('preflight failure skips cancel and verbose cancel on submit failure never evicts submit log', async (t) => {
  const f = await fixture(t), o1 = await f.create({ repair: '0' });
  const cancelled = join(f.project, 'pre-cancel.log');
  f.commands.cancel = `node -e "require('fs').appendFileSync(process.argv[1],'called\\n'); console.error('CANCEL_NOISE_'.repeat(300));" "${cancelled}"`;
  await f.initialize(o1, { groups: [{ id: 'control', label: 'Control', vars: {}, control: true }], seeds: [1] });
  await retain(f.storage, ownerKey('owner'), (state) => {
    state.experiments[o1.id].executor.commands.preflight = 'echo PREFLIGHT_BOOM_MARKER && exit 2';
  });
  const preRun = (await execute(f, o1)).runs[0];
  assert.equal(preRun.state, 'failed');
  assert.match(preRun.log, /PREFLIGHT_BOOM_MARKER/);
  await assert.rejects(access(cancelled));

  const o2 = await f.create({ repair: '0' });
  await f.initialize(o2, { groups: [{ id: 'control', label: 'Control', vars: {}, control: true }], seeds: [2] });
  await retain(f.storage, ownerKey('owner'), (state) => {
    state.experiments[o2.id].executor.commands.submit = 'echo SUBMIT_ROOT_CAUSE_MARKER && exit 9';
  });
  const subRun = (await execute(f, o2)).runs[0];
  assert.equal(subRun.state, 'failed');
  assert.match(subRun.log, /SUBMIT_ROOT_CAUSE_MARKER/);
  assert.match(subRun.log, /\[cancel\]/);
});

test('collect stdout larger than 16KB parses cleanly without truncating JSON', async (t) => {
  const f = await fixture(t), o = await f.create();
  f.commands.collect = `node -e "console.log(JSON.stringify({ pad: 'x'.repeat(24000), metrics: { score: 42 } }))"`;
  await f.initialize(o, { groups: [{ id: 'control', label: 'Control', vars: {}, control: true }], seeds: [7] });
  const run = (await execute(f, o)).runs[0];
  assert.equal(run.state, 'done', JSON.stringify(run.error));
  assert.equal(run.error, null);
  assert.equal(run.metrics.score, 42);
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
  // The page says the cycle was interrupted and does not resume on its own.
  assert.equal((await f.http('GET',undefined,{view:'exp',project:f.project,pick:`obj:${o.id}`})).next.k,'resuming');
  let d=(await f.read()).experiments[o.id];
  assert.equal(d.rounds[0].state,'interrupted'); assert.equal(d.rounds[0].runs[0].state,'failed'); assert.equal(d.rounds[0].runs[0].retryable,true);
  assert.equal(f.subscriptions.length,subscriptions+1);
  await retain(f.storage, ownerKey('owner'), (state) => { state.experiments[o.id].rounds[0].plan.groups[0].vars.slow = false; });
  assert.equal((await f.http('POST',{op:'runCycle',objective:o.id})).status,200);
  d=(await until(f.read,(s)=>s.experiments[o.id].rounds[0].state==='evaluating')).experiments[o.id];
  assert.equal(d.rounds.length,1);assert.equal(d.rounds[0].runs[0].state,'done');
});

test('a retried run starts in an empty run directory and keeps the earlier attempt beside it', async (t) => {
  const f = await fixture(t), o = await f.create();
  // Like a training script that refuses an existing output folder, failing its first attempt.
  Object.assign(f.commands, { submit: `mkdir {run}/adapter && { test -f retried || { touch retried; exit 3; }; } && printf '{"metrics":{"score":1}}' > {run}/metrics.json` });
  await f.initialize(o, { groups: [{ id: 'control', label: 'Control', vars: {}, control: true }], seeds: [5] });
  const run = (await execute(f, o)).runs[0];
  assert.equal(run.state, 'done', JSON.stringify(run.error)); assert.equal(run.retries, 1);
  await access(join(`${run.directory}.attempt-1`, 'adapter'));
  assert.match(run.log, /attempt-1/);
});

test('a submit that runs past its limit is stopped, invokes run-scoped cancel, and retried once as an environment failure', async (t) => {
  const f = await fixture(t), o = await f.create({ repair: '0' });
  const cancelled = join(f.project, 'cancel.log');
  Object.assign(f.commands, { submit: 'sleep 30', cancel: `node -e "require('fs').appendFileSync(process.argv[1], process.argv[2] + '\\n')" "${cancelled}" {run}`, timeout: 1 });
  await f.initialize(o, { groups: [{ id: 'control', label: 'Control', vars: {}, control: true }], seeds: [5] });
  const started = Date.now(), run = (await execute(f, o)).runs[0];
  assert.equal(run.state, 'failed'); assert.equal(run.attempts.length, 2);
  assert.match(run.error.raw, /超过 1 秒没结束/);
  assert.equal((await readFile(cancelled, 'utf8')).trim().split('\n').length, 2);
  assert.ok(Date.now() - started < 20000);
});

test('the schedule resumes an interrupted cycle once; interrupted again, it waits for 跑一轮', async (t) => {
  const f = await fixture(t), o = await f.create();
  await f.initialize(o, { groups: [{ id: 'control', label: 'Slow run', vars: { slow: true }, control: true }], seeds: [1] }, { window: '每晚 20:00–08:00' });
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 15, 22, 0).getTime() });
  const notice = async () => (await f.http('GET', undefined, { view: 'exp', project: f.project, pick: `obj:${o.id}` })).next.k;
  // The plugin stops and starts again while the run executes (a new attempt has a new process).
  let last = null;
  const interrupt = async () => {
    const running = await until(f.read, (s) => s.experiments[o.id].rounds[0]?.runs[0]?.state === 'running');
    const directory = running.experiments[o.id].rounds[0].runs[0].directory;
    last = await until(() => readFile(join(directory, 'pid'), 'utf8').then(Number, () => null), (p) => p !== null && p !== last, 'child process start');
    await f.activation().stop();
    await rm(join(f.project, 'active-run'), { recursive: true, force: true });
    f.start();
    return notice();
  };
  await f.http('POST', { op: 'runCycle', objective: o.id });
  assert.equal(await interrupt(), 'resuming');
  await f.activation().actions['rsi.tick']();
  const d = (await f.read()).experiments[o.id];
  assert.equal(d.rounds[0].state, 'running'); assert.equal(d.rounds[0].autoResumed, true);
  assert.equal(await interrupt(), 'interrupted');
  await f.activation().actions['rsi.tick']();
  assert.equal((await f.read()).experiments[o.id].rounds[0].state, 'interrupted');
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
  await retain(f.storage, ownerKey('owner'), (state) => {
    state.library[f.project].push({ id: `${o.id}-cycle-1`, kind: 'feedback', title: 'c1', objectives: [o.id], cycle: 1 }, { id: 'shared', kind: 'provided', title: 's', objectives: [o.id, 'other'] });
  });
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

// A change that loses leaves no winner to confirm, so the analysts are asked for directions.
const losing = { groups: [{ id: 'control', label: 'Control', vars: { delta: 0 }, control: true }, { id: 'change', label: 'Change', vars: { delta: -1 } }], seeds: [11, 23] };
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

test('a real objective has only the members chosen for it, with their names and models; a step rewritten after the start holds the next cycle until it is submitted again and confirmed', async (t) => {
  const f = await fixture(t), o = await f.create(); await f.initialize(o);
  // Governance execution was not chosen separately, so the preparer does it.
  assert.deepEqual((await f.read()).experiments[o.id].members, [{ role: 'prepare', name: '砚砚', model: 'gpt-5.6-sol', catId: 'codex', handle: '@codex' }, { role: 'evaluate', name: '小狸', model: 'k3.1', catId: 'cat-b5ddoo9l', handle: '@kimi' }, { role: 'iterate', name: '砚砚', model: 'gpt-5.6-sol', catId: 'codex', handle: '@codex' }]);
  await execute(f, o); await report(f, o); await decide(f, o);
  const item = (await f.read()).experiments[o.id].prep.find((p) => p.section === 'rules');
  assert.equal((await f.http('POST', { op: 'prep', objective: o.id, id: item.id, action: 'agent', note: 'Recalibrate the guard' }, { project: f.project })).status, 200);
  assert.match((await f.http('POST', { op: 'runCycle', objective: o.id })).error, /Preparation is being redone/);
  await f.prepare(o, undefined, { metrics: { version: 'E2', items: [{ id: 'score', name: 'Score', how: 'metrics.score', dir: 'up' }] } });
  assert.equal((await f.read()).experiments[o.id].metrics.version, 'E2');
  assert.equal((await execute(f, o)).n, 2);
});

test('the page wakes the evaluator again for a cycle that waits for its conclusion', async (t) => {
  const f = await fixture(t), o = await f.create(); await f.initialize(o);
  assert.equal((await f.http('POST', { op: 'evalAgain', objective: o.id })).status, 404);
  await execute(f, o);
  const asked = async () => f.sends.filter((s) => s.wake?.catId === 'cat-b5ddoo9l' && s.payload.elements[0].payload.text.includes('第 1 周期跑完')).length;
  await until(asked, (n) => n === 1, 'evaluation request');
  // Its turn ended without a conclusion: the notice offers 重新叫醒, which sends the same request again.
  assert.equal((await f.http('GET', undefined, { view: 'exp', project: f.project, pick: `obj:${o.id}` })).next.k, 'evaluating');
  assert.equal((await f.http('POST', { op: 'evalAgain', objective: o.id })).status, 200);
  await until(asked, (n) => n === 2, 'second evaluation request');
  await report(f, o);
});

test('analysts propose after the evaluator concludes; the conclusion card waits for them and says whether they agree', async (t) => {
  const f = await fixture(t), o = await f.create(); await f.initialize(o, losing);
  // An objective created before alpha.24 still holds demo placeholders (analysts without a member id); they never act.
  await retain(f.storage, ownerKey('owner'), (state) => {
    state.experiments[o.id].members.push({ role: 'analyze', name: '分析甲', model: 'claude-opus-5-5' });
  });
  const cats = [{ id: 'ana-1', name: '甲', model: 'm1' }, { id: 'ana-2', name: '乙', model: 'm2' }];
  for (const c of cats) assert.equal((await f.http('POST', { op: 'analystAdd', objective: o.id, catId: c.id, cats })).status, 200);
  assert.deepEqual((await f.read()).experiments[o.id].members.filter((m) => m.role === 'analyze' && m.catId).map((m) => [m.catId, m.name, m.model]), [['ana-1', '甲', 'm1'], ['ana-2', '乙', 'm2']]);
  const round = await execute(f, o);
  await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  // The evaluator judges the cycle; with analysts it may leave the directions to them.
  const concluded = await f.tool('conclude', { cycle: round.n, verdict: 'tune', findings: ['Measured against the control'] }, 'cat-b5ddoo9l', o.thread);
  assert.equal(concluded.ok, true, JSON.stringify(concluded)); assert.deepEqual(concluded.analysts, ['ana-1', 'ana-2']);
  const cards = () => f.sends.filter((s) => s.payload.elements.some((e) => e.kind === 'rich_block' && e.payload.title?.startsWith(`第 ${round.n} 周期结论`)));
  await until(async () => f.sends.filter((s) => ['ana-1', 'ana-2'].includes(s.wake?.catId)).length, (n) => n === 2, 'analyst wakes');
  assert.equal(cards().length, 0);
  const page = await f.http('GET', undefined, { view: 'exp', project: f.project, pick: `obj:${o.id}` });
  assert.equal(page.next.k, 'analyzing'); assert.equal(page.next.by, '甲、乙');
  assert.ok(page.members.every((m) => m.catId));
  // An analyst proposes on the turn it claimed with rsi.task.
  assert.equal((await f.tool('propose', { cycle: round.n, options: [{ k: 'x', title: 'X', why: 'y' }] }, 'ana-1', o.thread)).status, 403);
  const task = await f.tool('task', {}, 'ana-1', o.thread);
  assert.equal(task.analyze.cycle, round.n); assert.equal(task.analyze.report.verdict, 'tune'); assert.ok(task.analyze.comparison);
  assert.equal((await f.tool('propose', { cycle: round.n, options: [{ k: 'lr', title: 'Lower rate', why: 'Smaller steps', kind: 'variable', target: 'lr' }] }, 'ana-1', o.thread)).ok, true);
  assert.equal(cards().length, 0);
  await f.tool('task', {}, 'ana-2', o.thread);
  assert.equal((await f.tool('propose', { cycle: round.n, options: [{ k: 'lr', title: 'Lr 1e-5', why: 'Collapse risk', kind: 'variable', target: 'lr' }] }, 'ana-2', o.thread)).ok, true);
  // All proposed: one card with both signed directions, marked as agreeing.
  await until(async () => cards().length, (n) => n === 1, 'conclusion card');
  assert.match(JSON.stringify(cards()[0].payload), /意见一致/);
  const report = (await f.read()).experiments[o.id].rounds.at(-1).report;
  assert.deepEqual(report.directions.map((x) => [x.id, x.by, x.model]), [['lr', 'ana-1', 'm1'], ['lr-ana-2', 'ana-2', 'm2']]);
  assert.equal(report.agree, true);
  assert.equal((await f.http('GET', undefined, { view: 'exp', project: f.project, pick: `obj:${o.id}` })).next.k, 'decide');
  assert.equal((await f.http('POST', { op: 'expDecide', objective: o.id, n: round.n, pick: 'direction', directionId: 'lr-ana-2' }, { project: f.project })).status, 200);
});

test('analysts that change different things are marked for your judgment; one that does not propose in time is left out', async (t) => {
  const f = await fixture(t), o = await f.create(); await f.initialize(o, losing);
  const cats = [{ id: 'ana-1', name: '甲', model: 'm1' }, { id: 'ana-2', name: '乙', model: 'm2' }, { id: 'ana-3', name: '丙', model: 'm3' }];
  for (const c of cats) await f.http('POST', { op: 'analystAdd', objective: o.id, catId: c.id, cats });
  const round = await execute(f, o);
  await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  assert.equal((await f.tool('conclude', { cycle: round.n, verdict: 'tune', findings: 'Measured' }, 'cat-b5ddoo9l', o.thread)).ok, true);
  for (const [id, target] of [['ana-1', 'lr'], ['ana-2', 'steps']]) {
    await f.tool('task', {}, id, o.thread);
    assert.equal((await f.tool('propose', { cycle: round.n, options: [{ k: target, title: target, why: 'w', kind: 'variable', target }] }, id, o.thread)).ok, true);
  }
  // 丙 never proposes: after the time limit the schedule sends the conclusion without it.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 21 * 60_000 });
  await f.activation().actions['rsi.tick']();
  const r = (await f.read()).experiments[o.id].rounds.at(-1);
  assert.deepEqual(r.analysis.missing, ['ana-3']); assert.equal(r.report.agree, false);
  const card = f.sends.find((s) => s.payload.elements.some((e) => e.kind === 'rich_block' && e.payload.title?.startsWith(`第 ${round.n} 周期结论`)));
  assert.match(JSON.stringify(card.payload), /意见不一致/); assert.match(JSON.stringify(card.payload), /丙 没在时限内给方向/);
});

test('a chosen direction’s numeric prediction is checked when its version first runs against the control', async (t) => {
  const f = await fixture(t), o = await f.create();
  await f.initialize(o, { groups: [{ id: 'control', label: 'Control', vars: { delta: 0 }, control: true }], seeds: [11, 23] });
  const first = await execute(f, o);
  await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  // A prediction names a metric of the scale.
  assert.ok((await f.tool('conclude', { cycle: first.n, verdict: 'tune', findings: 'Baseline measured',
    options: [{ k: 'more', title: 'Raise delta', why: 'w', expect: { lo: 5, hi: 15, metric: 'nope' } }] }, 'cat-b5ddoo9l', o.thread)).error);
  // The evaluator predicts that raising delta adds 5 to 15 to the score.
  assert.equal((await f.tool('conclude', { cycle: first.n, verdict: 'tune', findings: 'Baseline measured',
    options: [{ k: 'more', title: 'Raise delta', why: 'The score follows delta', kind: 'variable', target: 'delta', expect: { lo: 5, hi: 15 } }] }, 'cat-b5ddoo9l', o.thread)).ok, true);
  let d = (await f.read()).experiments[o.id];
  assert.equal(d.rounds[0].report.directions[0].expect, 'score +5 ~ +15');
  assert.equal((await f.http('POST', { op: 'expDecide', objective: o.id, n: first.n, pick: 'direction', directionId: 'more' }, { project: f.project })).status, 200);
  await f.tool('task', {}, 'codex', o.thread);
  assert.equal((await f.tool('version', { change: 'Delta 10', config: { delta: 10 } }, 'codex', o.thread)).version, 'v2');
  assert.deepEqual((await f.read()).experiments[o.id].versions[1].prediction, { metric: 'score', lo: 5, hi: 15, by: 'cat-b5ddoo9l', text: 'Raise delta', expect: 'score +5 ~ +15', direction: 'more', cycle: 1 });
  // v2 against the control: the score rises by 10, inside the predicted range.
  const second = await execute(f, o);
  await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  assert.equal((await f.tool('conclude', { cycle: second.n, verdict: 'keep', findings: 'Delta helps',
    options: [{ k: 'confirm', title: 'Confirm', why: 'Won', cites: [`${o.id}-cycle-1`] }] }, 'cat-b5ddoo9l', o.thread)).ok, true);
  d = (await f.read()).experiments[o.id];
  assert.deepEqual(d.rounds[1].report.predictions.map((p) => [p.result, p.actual, p.expect]), [['hit', 'score +10', 'score +5 ~ +15']]);
  assert.equal(d.versions[1].prediction.checked.result, 'hit');
  const page = await f.http('GET', undefined, { view: 'exp', project: f.project, pick: `obj:${o.id}` });
  assert.deepEqual(page.hitRate, { hit: 1, all: 1 });
  assert.ok(page.trend.every((x) => String(x.value).length <= 7));
  assert.ok(f.sends.some((s) => JSON.stringify(s.payload).includes('预测核对')));
});

test('when only one analyst proposes in time, the card names the missing one and claims no agreement', async (t) => {
  const f = await fixture(t), o = await f.create(); await f.initialize(o, losing);
  const cats = [{ id: 'ana-1', name: '甲', model: 'm1' }, { id: 'ana-2', name: '乙', model: 'm2' }];
  for (const c of cats) await f.http('POST', { op: 'analystAdd', objective: o.id, catId: c.id, cats });
  const round = await execute(f, o);
  await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  await f.tool('conclude', { cycle: round.n, verdict: 'tune', findings: 'Measured' }, 'cat-b5ddoo9l', o.thread);
  await f.tool('task', {}, 'ana-1', o.thread);
  await f.tool('propose', { cycle: round.n, options: [{ k: 'lr', title: 'Lower rate', why: 'w', kind: 'variable', target: 'lr' }] }, 'ana-1', o.thread);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 21 * 60_000 });
  await f.activation().actions['rsi.tick']();
  const card = JSON.stringify(f.sends.find((s) => s.payload.elements.some((e) => e.kind === 'rich_block' && e.payload.title?.startsWith(`第 ${round.n} 周期结论`))).payload);
  assert.match(card, /乙 没在时限内给方向/); assert.doesNotMatch(card, /意见一致|意见不一致/);
});

test('a gain smaller than the main metric’s minimum valid improvement does not beat the control', async (t) => {
  for (const [dir, minDelta, wins] of [['up', 5, false], ['up', 0.5, true], ['down', 5, false], ['down', 1, true]]) {
    const f = await fixture(t), o = await f.create();
    // The change group scores one more (up) or one less (down) than the control (score = seed + delta).
    await f.initialize(o, { groups: [{ id: 'control', label: 'Control', vars: { delta: 0 }, control: true }, { id: 'change', label: 'Change', vars: { delta: dir === 'up' ? 1 : -1 } }], seeds: [11, 23] },
      { metrics: { version: 'E1', items: [{ id: 'score', name: 'Score', how: 'metrics.score', dir, minDelta }] } });
    const round = await execute(f, o);
    await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
    const result = await f.tool('conclude', { cycle: round.n, verdict: 'tune', findings: 'Measured', options: [{ k: 'next', title: 'Next', why: 'w' }] }, 'cat-b5ddoo9l', o.thread);
    assert.equal(result.comparison.groups.find((g) => g.group === 'change').beatsControl, wins, `${dir} minDelta ${minDelta}`);
    assert.equal(!!(await f.read()).experiments[o.id].candidate, wins);
  }
});

test('a main metric’s non-inferiority margin accepts only changes within the allowed loss', async (t) => {
  for (const [dir, delta, margin, passes] of [['up', -1, 1, true], ['up', -2, 1, false], ['down', 1, 1, true], ['down', 2, 1, false]]) {
    const f = await fixture(t), o = await f.create();
    await f.initialize(o, { groups: [{ id: 'control', label: 'Control', vars: { delta: 0 }, control: true }, { id: 'change', label: 'Change', vars: { delta } }], seeds: [11, 23] },
      { metrics: { version: 'E1', items: [{ id: 'score', name: 'Score', how: 'metrics.score', dir, margin }] } });
    const round = await execute(f, o);
    await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
    const result = await f.tool('conclude', { cycle: round.n, verdict: 'tune', findings: 'Measured', options: [{ k: 'next', title: 'Next', why: 'w' }] }, 'cat-b5ddoo9l', o.thread);
    assert.equal(result.comparison.groups.find((g) => g.group === 'change').beatsControl, passes, `${dir} delta ${delta} margin ${margin}`);
    assert.equal(!!(await f.read()).experiments[o.id].candidate, passes);
  }
});

test('an execution fix replaces the default without competing with it', async (t) => {
  const f = await fixture(t), o = await f.create();
  await f.initialize(o, { groups: [{ id: 'control', label: 'Control', vars: {}, control: true }], seeds: [11, 23] });
  // The default's configuration sets delta 2 (score = seed + delta).
  await retain(f.storage, ownerKey('owner'), (state) => { state.experiments[o.id].versions[0].config = { delta: 2 }; });
  const first = await execute(f, o);
  await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  await f.tool('conclude', { cycle: first.n, verdict: 'insufficient', findings: 'A retry failed',
    options: [{ k: 'retry-dir', title: 'Fix the retry directory', why: 'Retries reuse it', kind: 'execution' }] }, 'cat-b5ddoo9l', o.thread);
  assert.equal((await f.http('POST', { op: 'expDecide', objective: o.id, n: first.n, pick: 'direction', directionId: 'retry-dir' }, { project: f.project })).status, 200);
  await f.tool('task', {}, 'codex', o.thread);
  assert.equal((await f.tool('version', { change: 'Fix retries', config: {} }, 'codex', o.thread)).version, 'v2');
  const d = (await f.read()).experiments[o.id];
  assert.equal(d.objective.currentVersion, 'v2'); assert.equal(d.versions[1].direct, true);
  // The fix was submitted with an empty config; it keeps the default's.
  assert.deepEqual(d.versions[1].config, { delta: 2 });
  assert.deepEqual(d.upcoming.groups.map((g) => [g.id, g.version, g.control]), [['control', 'v2', true]]);
  // The next cycle runs the fix as the control.
  const second = await execute(f, o);
  assert.ok(second.runs.every((r) => r.metrics.score === r.seed + 2), JSON.stringify(second.runs.map((r) => [r.seed, r.metrics])));
  await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  const result = await f.tool('conclude', { cycle: second.n, verdict: 'keep', findings: 'Still runs',
    options: [{ k: 'next', title: 'Next', why: 'w', cites: [`${o.id}-cycle-1`] }] }, 'cat-b5ddoo9l', o.thread);
  assert.equal(result.stop, null, JSON.stringify(result.stop));
  assert.equal((await f.read()).experiments[o.id].objective.state, 'pending');
});

test('an analyst timeout sends the conclusion even while another objective is running', async (t) => {
  const f = await fixture(t), a = await f.create(); await f.initialize(a, losing);
  await f.http('POST', { op: 'analystAdd', objective: a.id, catId: 'ana-1', cats: [{ id: 'ana-1', name: '甲', model: 'm1' }] });
  const round = await execute(f, a);
  await f.tool('task', {}, 'cat-b5ddoo9l', a.thread);
  await f.tool('conclude', { cycle: round.n, verdict: 'tune', findings: 'Measured' }, 'cat-b5ddoo9l', a.thread);
  // A second objective in the project starts a slow run.
  const created = await f.http('POST', { op: 'new', project: '', thread: 'source', statement: 'Another', prepare: 'codex', evaluate: 'cat-b5ddoo9l', cats: [] });
  const b = { id: Object.values((await f.read()).experiments).find((d) => d.objective.projectPath === f.project && d.objective.id !== a.id).objective.id, thread: created.acts[0].args.id };
  await f.initialize(b, { groups: [{ id: 'control', label: 'Slow run', vars: { slow: true }, control: true }], seeds: [1] });
  await f.http('POST', { op: 'runCycle', objective: b.id });
  await until(f.read, (s) => s.experiments[b.id].rounds[0]?.runs[0]?.state === 'running');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 21 * 60_000 });
  await f.activation().actions['rsi.tick']();
  assert.deepEqual((await f.read()).experiments[a.id].rounds.at(-1).analysis.missing, ['ana-1']);
});

test('a prediction whose metric left the scale is recorded as unresolved and stays out of the hit rate', async (t) => {
  const f = await fixture(t), o = await f.create();
  await f.initialize(o, { groups: [{ id: 'control', label: 'Control', vars: { delta: 0 }, control: true }], seeds: [11, 23] });
  const first = await execute(f, o);
  await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  await f.tool('conclude', { cycle: first.n, verdict: 'tune', findings: 'Baseline measured',
    options: [{ k: 'more', title: 'Raise delta', why: 'w', kind: 'variable', target: 'delta', expect: { lo: 5, hi: 15 } }] }, 'cat-b5ddoo9l', o.thread);
  await f.http('POST', { op: 'expDecide', objective: o.id, n: first.n, pick: 'direction', directionId: 'more' }, { project: f.project });
  await f.tool('task', {}, 'codex', o.thread);
  await f.tool('version', { change: 'Delta 10', config: { delta: 10 } }, 'codex', o.thread);
  // The scale changes before the version runs: the predicted metric is no longer on it.
  await retain(f.storage, ownerKey('owner'), (state) => { state.experiments[o.id].versions[1].prediction.metric = 'retired'; });
  const second = await execute(f, o);
  await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  await f.tool('conclude', { cycle: second.n, verdict: 'keep', findings: 'Delta helps', options: [{ k: 'confirm', title: 'Confirm', why: 'Won', cites: [`${o.id}-cycle-1`] }] }, 'cat-b5ddoo9l', o.thread);
  const d = (await f.read()).experiments[o.id];
  assert.deepEqual(d.rounds[1].report.predictions.map((p) => [p.result, p.actual]), [['unresolved', '量尺里没有 retired']]);
  assert.equal(d.versions[1].prediction.checked.result, 'unresolved');
  assert.deepEqual((await f.http('GET', undefined, { view: 'exp', project: f.project, pick: `obj:${o.id}` })).hitRate, { hit: 0, all: 0 });
  assert.ok(f.sends.some((s) => JSON.stringify(s.payload).includes('无法核对')));
});

test('a run keeps the tail of its log in the state and the whole log in its directory', async (t) => {
  const f = await fixture(t), o = await f.create();
  Object.assign(f.commands, { submit: `head -c 20000 /dev/zero | tr '\\0' x; printf '{"metrics":{"score":1}}' > {run}/metrics.json` });
  await f.initialize(o, { groups: [{ id: 'control', label: 'Control', vars: {}, control: true }], seeds: [5] });
  const run = (await execute(f, o)).runs[0];
  assert.equal(run.state, 'done', JSON.stringify(run.error));
  assert.ok(run.log.length <= 2000, String(run.log.length));
  // The runner keeps the last 16,000 characters of each command; all of them are in the file.
  assert.ok((await readFile(join(run.directory, 'rsi.log'), 'utf8')).length >= 15000);
});

test('a state grown past the storage limit by earlier versions is compacted when the plugin starts', async (t) => {
  const f = await fixture(t), o = await f.create();
  await f.initialize(o, { groups: [{ id: 'control', label: 'Control', vars: {}, control: true }], seeds: [5] });
  await execute(f, o);
  const root = await f.storage.get(ownerKey('owner')), legacy = await f.read();
  const run = legacy.experiments[o.id].rounds[0].runs[0];
  Object.assign(run, { log: 'x'.repeat(50000), error: { kind: 'env', step: 'submit', raw: 'y'.repeat(50000) } });
  legacy.outbox.push({ id: 'old-message', kind: 'message', objective: o.id, sent: 1, message: { title: 't', body: 'z'.repeat(50000) } });
  await f.storage.compareAndSet(ownerKey('owner'), root.revision, legacy);
  await f.activation().stop();
  f.start();
  await f.http('GET', undefined, { view: 'exp', project: f.project, pick: `obj:${o.id}` });
  const after = await f.read(), compacted = after.experiments[o.id].rounds[0].runs[0];
  assert.ok(compacted.log.length <= 2000); assert.ok(compacted.error.raw.length < 2100);
  assert.ok(!after.outbox.some((e) => e.id === 'old-message'));
  // The demo data alone is about 240 KB; what remains of this objective is small again.
  assert.ok(JSON.stringify(after).length < 400000);
});

test('a conclusion stores its comparison once and its library note only the outcome; the page, the tools and the next cycle still read them', async (t) => {
  const f = await fixture(t), o = await f.create();
  // Each run writes more log than a closed cycle keeps.
  Object.assign(f.commands, { submit: `head -c 3000 /dev/zero | tr '\\0' x; ${f.commands.submit}` });
  await f.initialize(o);
  const ran = await execute(f, o);
  assert.ok(ran.runs.every((r) => r.log.length === 2000 && r.attempts[0].env.seed === r.seed));
  // The member's reply still has the cells.
  assert.equal((await report(f, o)).comparison.matrix.length, 2);
  const round = (await f.read()).experiments[o.id].rounds[0];
  assert.equal(round.report.compare.matrix, undefined); assert.equal(round.report.matrix.length, 2);
  assert.ok(round.runs.every((r) => r.log.length === 400 && r.attempts.every((a) => !a.env && !a.metrics && a.end >= a.start)));
  const page = await f.http('GET', undefined, { view: 'exp', project: f.project, pick: `obj:${o.id}` });
  assert.deepEqual([page.cycle.report.compare.comparable, page.cycle.report.compare.against], [true, 'control']);
  assert.deepEqual(page.cycle.compare.metrics[0].items.map((g) => [g.id, g.mean, g.delta]), [['control', '17', null], ['change', '18', '+1']]);
  assert.deepEqual(page.trend, [{ n: 1, version: 'v1', label: 'v1-1', value: 18 }]);
  // The next cycle's evaluator reads the note's outcome and cites it.
  await decide(f, o);
  await execute(f, o);
  const task = await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  assert.deepEqual(task.evaluate.library.map((doc) => doc.result), [{ verdict: 'tune', metric: 'score', means: { control: 17, change: 18 }, confirmation: { status: 'candidate', version: 'v1' } }]);
  assert.equal((await report(f, o, 'keep')).confirmation.status, 'confirmed');
});

test('a write still past the Host’s 1 MiB value after compaction is refused with its size: the page and the member are told and nothing is stored', async (t) => {
  const f = await fixture(t), o = await f.create();
  await f.initialize(o, { groups: [{ id: 'control', label: 'Control', vars: {}, control: true }], seeds: [5] });
  const round = await execute(f, o);
  const stored = async () => { const s = await f.storage.get(ownerKey('owner')); return { revision: s.revision, bytes: Buffer.byteLength(JSON.stringify(s.value)) }; };
  let before = await stored();
  const added = await f.http('POST', { op: 'docAdd', title: 'Too large', body: 'x'.repeat(1024 * 1024) }, { project: f.project });
  assert.equal(added.status, 507); assert.match(added.error, /^RSI 状态超过宿主 1 MiB 上限（\d+ 字节，上限 1048576 字节）/);
  assert.deepEqual(await stored(), before);
  // A single shard that still exceeds 1 MiB (e.g. a 1 MiB conclusion payload) is refused with 507, and the cycle stays evaluating.
  await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  before = await stored();
  const concluded = await f.tool('conclude', { cycle: round.n, verdict: 'baseline', findings: 'x'.repeat(1024 * 1024), options: [{ k: 'next', title: 'Next', why: 'w' }] }, 'cat-b5ddoo9l', o.thread);
  assert.equal(concluded.status, 507); assert.match(concluded.error, /^RSI 状态超过宿主 1 MiB 上限（\d+ 字节/);
  assert.deepEqual(await stored(), before); assert.equal((await f.read()).experiments[o.id].rounds[0].state, 'evaluating');
});

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
  await retain(f.storage, ownerKey('owner'), (state) => {
    const proposed = state.experiments[o.id];
    proposed.versions.push({id:'v2',parent:'v1',change:'Proposed config',config:{},commit:null,current:false,status:'proposed',at:Date.now()});
    proposed.upcoming.groups[0].version = 'v2';
  });
  await f.http('POST', { op: 'analystAdd', objective: o.id, catId: 'ana-1', cats: [{ id: 'ana-1', name: '甲', model: 'm1' }] });
  await execute(f, o); assert.equal((await report(f, o)).confirmation.status, 'candidate'); await decide(f, o);
  const round = await execute(f, o); assert.ok(round.plan.seeds.every((s) => s > 23));
  // The confirmation is over, so the analysts are asked again.
  const rejected = await report(f, o); assert.equal(rejected.confirmation.status, 'rejected'); assert.deepEqual(rejected.analysts, ['ana-1']);
  const d = (await f.read()).experiments[o.id]; assert.equal(d.objective.currentVersion, 'v1'); assert.equal(d.candidate, undefined);
  assert.equal(d.versions.find((v)=>v.id==='v2').status,'rejected');
});

test('placeholders are quoted for the shell that runs the command: sh, or cmd on Windows', () => {
  assert.equal(quote("it's here", false), `'it'"'"'s here'`);
  assert.equal(quote('C:\\runs\\a b', true), '"C:\\runs\\a b"');
  assert.equal(quote('say "hi"', true), '"say ""hi"""');
});

test('a run whose full log cannot be written still records its result', async (t) => {
  const f = await fixture(t), o = await f.create();
  // The project's command leaves a directory where the plugin writes the full log.
  await f.initialize(o, { groups: [{ id: 'control', label: 'Control', vars: { delta: 0, logDir: true }, control: true }], seeds: [11] });
  const logs = []; f.host.log = (level, message, fields) => logs.push([level, message, fields?.error]);
  const round = await execute(f, o);
  assert.deepEqual(round.runs.map((r) => [r.state, r.metrics.score]), [['done', 11]]);
  // The failure is reported, not swallowed.
  assert.deepEqual(logs.map(([level, message]) => [level, message]), [['error', 'RSI could not write the full run log']]); assert.match(logs[0][2], /EISDIR/);
});

test('governance execution is its own member: the version a decision asks for goes to them, not to the preparer', async (t) => {
  const f = await fixture(t), o = await f.create({ iterate: 'cat-iter', cats: [{ id: 'codex', name: '砚砚', model: 'gpt-5.6-sol' }, { id: 'cat-b5ddoo9l', name: '小狸', model: 'k3.1' }, { id: 'cat-iter', name: '金渐层', model: 'deepseek-v4-pro', handle: '@deepseek', on: true }] });
  await f.initialize(o, losing);
  const round = await execute(f, o); await report(f, o);
  assert.equal((await f.http('POST', { op: 'expDecide', objective: o.id, n: round.n, pick: 'direction', directionId: 'next' }, { project: f.project })).status, 200);
  await until(async () => f.sends.filter((s) => s.wake?.catId === 'cat-iter').length, (n) => n === 1, 'version wake');
  // The version is asked of the member by handle, to be made beside the user's working tree.
  const asked = textOf(f.sends.find((s) => s.wake?.catId === 'cat-iter')).split('\n').at(-1);
  assert.ok(asked.startsWith('@deepseek 按「') && asked.includes('在单独的 git worktree 里'), asked);
  assert.equal((await f.tool('task', {}, 'codex', o.thread)).status, 403);
  assert.ok((await f.tool('task', {}, 'cat-iter', o.thread)).version);
  assert.equal((await f.tool('version', { change: 'Next', config: {} }, 'cat-iter', o.thread)).version, 'v2');
  assert.deepEqual((await f.read()).experiments[o.id].members.filter((m) => m.role === 'iterate').map((m) => [m.catId, m.name]), [['cat-iter', '金渐层']]);
});

test('an objective from before governance execution had its own member keeps the preparer doing it', async (t) => {
  const f = await fixture(t), o = await f.create();
  // Like the objectives created before alpha.24, it still holds the template's placeholder members, an iterator without a cat among them.
  await retain(f.storage, ownerKey('owner'), (state) => {
    state.experiments[o.id].members = state.experiments[o.id].members.filter((m) => m.role !== 'iterate').concat({ role: 'iterate', name: '迭代成员', model: 'claude-opus-5-5' }, { role: 'metrics', name: '指标成员', model: 'gpt-5.6' });
    // A dialog draft from alpha.45–46 held bare ids.
    state.draft = { analysts: ['cat-old'] };
  });
  await f.activation().stop(); f.start();
  await until(f.read, (s) => s.experiments[o.id].members.every((m) => m.catId), 'placeholders removed');
  assert.deepEqual((await f.read()).experiments[o.id].members.map((m) => [m.role, m.catId]), [['prepare', 'codex'], ['evaluate', 'cat-b5ddoo9l'], ['iterate', 'codex']]);
  assert.equal((await f.read()).draft, undefined);
});

test('discussion members picked in the new-objective dialog are a draft until the objective exists: one per pick, × takes one out', async (t) => {
  const f = await fixture(t);
  const cats = [{ id: 'codex', name: '砚砚', model: 'gpt-5.6-sol' }, { id: 'cat-b5ddoo9l', name: '小狸', model: 'k3.1' }, { id: 'ana-1', name: '甲', model: 'm1' }, { id: 'ana-2', name: '乙', model: 'm2' }];
  for (const id of ['ana-1', 'ana-2']) assert.equal((await f.http('POST', { op: 'draftAnalyst', catId: id, cats })).status, 200);
  assert.equal((await f.http('POST', { op: 'draftAnalyst', catId: 'ana-2', on: false })).status, 200);
  assert.deepEqual((await f.read()).draft.analysts, [{ catId: 'ana-1', name: '甲', model: 'm1' }]);
  // The rows passed on creation fill in what the draft did not know yet.
  const o = await f.create({ cats: cats.map((c) => ({ ...c, handle: `@${c.id}`, on: true })) }), created = await f.read();
  assert.deepEqual(created.experiments[o.id].members.filter((m) => m.role === 'analyze').map((m) => [m.catId, m.name, m.model, m.handle]), [['ana-1', '甲', 'm1', '@ana-1']]);
  assert.equal(created.draft, undefined);
});

test('a winner waiting for confirmation asks the analysts for nothing: the next cycle is the confirmation', async (t) => {
  const f = await fixture(t), o = await f.create(); Object.assign(f.commands, pythonExecutor);
  await f.initialize(o, plan({ delta: 10, only_selection: true }));
  await retain(f.storage, ownerKey('owner'), (state) => {
    const proposed = state.experiments[o.id];
    proposed.versions.push({id:'v2',parent:'v1',change:'Proposed config',config:{},commit:null,current:false,status:'proposed',at:Date.now()});
    proposed.upcoming.groups[0].version = 'v2';
  });
  assert.equal((await f.http('POST', { op: 'analystAdd', objective: o.id, catId: 'ana-1', cats: [{ id: 'ana-1', name: '甲', model: 'm1' }] })).status, 200);
  const round = await execute(f, o), result = await report(f, o);
  assert.equal(result.confirmation.status, 'candidate'); assert.equal(result.analysts, undefined);
  const cards = () => f.sends.filter((s) => s.payload.elements.some((e) => e.kind === 'rich_block' && e.payload.title?.startsWith(`第 ${round.n} 周期结论`)));
  await until(async () => cards().length, (n) => n === 1, 'conclusion card');
  assert.equal(f.sends.filter((s) => s.wake?.catId === 'ana-1').length, 0);
  assert.match(JSON.stringify(cards()[0].payload), /今晚照旧/);
  const page = await f.http('GET', undefined, { view: 'exp', project: f.project, pick: `obj:${o.id}` });
  assert.equal(page.next.k, 'decide'); assert.equal(page.candidate, 'v2');
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
  const f = await fixture(t), o = await f.create({ repair: '0' }); Object.assign(f.commands, pythonExecutor, { failureField: 'failed' });
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

test('target adoption and the cycle budget stop new cycles after conclusions and deliver reasons', async (t) => {
  for (const condition of ['target', 'budget']) await t.test(condition, async (t) => {
    const f = await fixture(t), o = await f.create(condition === 'target' ? { target: 'Score ≥ 25' } : { rounds: '1' });
    Object.assign(f.commands, pythonExecutor);
    await f.initialize(o, condition === 'target' ? plan({ delta: 10 }) : { groups: [{ id: 'control', label: 'Control', vars: {}, control: true }], seeds: [11, 23] });
    const cycles = condition === 'target' ? 2 : 1;
    for (let n = 1; n <= cycles; n++) {
      await execute(f, o); const result = await report(f, o);
      if (n < cycles) { assert.equal(result.stop, null); await decide(f, o); }
    }
    const d = (await f.read()).experiments[o.id];
    assert.equal(d.objective.state, 'done');
    assert.equal(d.objective.stopReason.kind, condition === 'budget' ? 'maxCycles' : condition);
    assert.ok(f.sends.some((s) => s.payload.elements.some((e) => e.kind === 'rich_block' && e.payload.title === d.objective.stopReason.text)));
    // The last conclusion asks for no direction; its stop card comes after it.
    const titles = d.messages.map((m) => m.title), last = d.messages.find((m) => m.title.startsWith(`第 ${cycles} 周期结论`));
    assert.ok(!last.body.includes('在 RSI 页面选择方向'));
    assert.ok(titles.indexOf(last.title) < titles.indexOf(d.objective.stopReason.text));
    assert.ok((await f.http('POST', { op: 'runCycle', objective: o.id })).error);
    await f.activation().actions['rsi.tick']();
    assert.equal((await f.read()).experiments[o.id].rounds.length, cycles);
    if (condition !== 'target') return;
    // A finished objective continues when its stop conditions change: the notice opens them, and the next cycle can run.
    const page = await f.http('GET', undefined, { view: 'exp', project: f.project, pick: `obj:${o.id}` });
    assert.equal(page.next.k, 'done'); assert.ok(page.next.stop.endsWith('-stop'));
    assert.equal((await f.http('POST', { op: 'prep', objective: o.id, id: page.next.stop, action: 'edit' })).act, 'dialog');
    assert.equal((await f.http('POST', { op: 'stop', objective: o.id, target: 'Score ≥ 1000', rounds: '' })).status, 200);
    assert.equal((await f.read()).experiments[o.id].objective.state, 'running');
    assert.equal((await execute(f, o)).n, cycles + 1);
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

test('objectives sharing a run window take turns: the one whose last cycle started longest ago starts next', async (t) => {
  const f = await fixture(t), a = await f.create(), b = await f.create();
  for (const o of [a, b]) await f.initialize(o, plan({ delta: 1 }), { window: '每晚 20:00–08:00' });
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 15, 19, 59).getTime() });
  for (const o of [a, b]) assert.equal((await f.http('POST', { op: 'life', action: 'start', objective: o.id })).status, 200);
  const order = [];
  for (const minute of [1, 2, 3]) {
    const at = new Date(2026, 10, 15, 20, minute).getTime();
    t.mock.timers.setTime(at);
    await f.activation().actions['rsi.tick']();
    const s = await f.read(), started = [a, b].find((o) => s.experiments[o.id].rounds.some((r) => r.start === at));
    assert.ok(started, `a cycle starts at 20:0${minute}`);
    order.push(started === a ? 'a' : 'b');
    await until(f.read, (s) => s.experiments[started.id].rounds.find((r) => r.start === at).state === 'evaluating');
    await report(f, started); await decide(f, started);
  }
  assert.deepEqual(order, ['a', 'b', 'a']);
});

test('the runs of a cycle started later wait for those of one started earlier, whichever objective it belongs to', async (t) => {
  const f = await fixture(t), a = await f.create(), b = await f.create();
  for (const o of [a, b]) await f.initialize(o, plan({ delta: 1 }));
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 15, 12, 0).getTime() });
  assert.equal((await f.http('POST', { op: 'runCycle', objective: b.id })).status, 200);
  t.mock.timers.setTime(new Date(2026, 10, 15, 12, 1).getTime());
  assert.equal((await f.http('POST', { op: 'runCycle', objective: a.id })).status, 200);
  await until(f.read, (s) => [a, b].every((o) => s.experiments[o.id].rounds[0].state === 'evaluating'), 'both cycles ran');
  const starts = (await readFile(join(f.project, 'starts'), 'utf8')).trim().split('\n').map((run) => run.includes(b.id) ? 'b' : 'a');
  assert.deepEqual(starts, ['b', 'b', 'b', 'b', 'a', 'a', 'a', 'a']);
});

test('a conclusion nobody decides within 30 minutes of the run window goes on with its plan', async (t) => {
  const f = await fixture(t), o = await f.create(); await f.initialize(o, losing, { window: '每晚 20:00–08:00' });
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 15, 19, 59).getTime() });
  const tick = () => f.activation().actions['rsi.tick']();
  const at = (day, hour, minute = 0) => t.mock.timers.setTime(new Date(2026, 10, day, hour, minute).getTime());
  assert.equal((await f.http('POST', { op: 'life', action: 'start', objective: o.id })).status, 200);
  at(15, 20); await tick();
  await until(f.read, (s) => s.experiments[o.id].rounds[0]?.state === 'evaluating');
  await report(f, o);
  // Still within the wait: the conclusion waits for you.
  at(15, 20, 29); await tick();
  let d = (await f.read()).experiments[o.id];
  assert.equal(d.rounds[0].decision, null); assert.equal(d.objective.state, 'pending');
  // Past it: RSI decides to go on with the plan the conclusion set, and the next cycle starts.
  at(15, 20, 31); await tick();
  d = (await f.read()).experiments[o.id];
  assert.deepEqual([d.rounds[0].decision.pick, d.rounds[0].decision.by], ['same', 'RSI']);
  assert.equal(d.rounds.length, 2);
  assert.deepEqual(d.rounds[1].plan.groups.map((g) => g.id), d.rounds[0].plan.groups.map((g) => g.id));
  assert.ok(d.rounds[1].plan.seeds.every((s) => !d.rounds[0].plan.seeds.includes(s)));
  assert.ok(f.sends.some((s) => s.payload.elements.some((e) => e.kind === 'rich_block' && e.payload.title === '第 1 周期：没人回应，按当前计划继续')));
});

const night = new Date(2026, 10, 15, 22).getTime(), day = new Date(2026, 10, 15, 12).getTime();
// Concludes the latest cycle at the given time with these directions, each citing the earlier cycles.
async function concludeAt(t, f, o, time, options) {
  t.mock.timers.setTime(time);
  const task = await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
  const result = await f.tool('conclude', { cycle: task.evaluate.cycle, verdict: 'tune', findings: 'Measured',
    options: options.map((x) => ({ why: 'w', ...x, cites: task.evaluate.library.map((d) => d.id) })) }, 'cat-b5ddoo9l', o.thread);
  assert.equal(result.ok, true, JSON.stringify(result));
  return (await f.read()).experiments[o.id];
}

test('inside the run window the first direction of a kind the objective allows is adopted without a person; other kinds, and conclusions outside the window, wait', async (t) => {
  const f = await fixture(t), o = await f.create({ auto: 'default' }); await f.initialize(o, losing);
  t.mock.timers.enable({ apis: ['Date'], now: day });
  for (const [time, kind] of [[day, 'variable'], [night, 'code']]) {
    await execute(f, o);
    const d = await concludeAt(t, f, o, time, [{ k: 'lr', title: 'Lower rate', kind }]);
    assert.equal(d.rounds.at(-1).decision, null); assert.equal(d.versionRequest, undefined); assert.equal(d.objective.state, 'pending');
    await decide(f, o);
  }
  await execute(f, o);
  const d = await concludeAt(t, f, o, night, [{ k: 'lr', title: 'Lower rate', kind: 'variable', expect: { lo: 0, hi: 1 } }, { k: 'rewrite', title: 'Rewrite', kind: 'code' }]);
  assert.deepEqual([d.rounds[2].decision.pick, d.rounds[2].decision.directionId, d.rounds[2].decision.by], ['direction', 'lr', 'RSI']);
  // As if picked on the page: the version request carries the direction's prediction and wakes the governance member.
  assert.equal(d.versionRequest.title, 'Lower rate'); assert.equal(d.versionRequest.prediction.direction, 'lr');
  await until(async () => f.sends.some((s) => s.wake?.catId === 'codex' && s.payload.elements[0].payload.text.includes('按「Lower rate」出下一个版本')), Boolean, 'version wake');
  assert.ok(f.sends.some((s) => s.payload.elements.some((e) => e.kind === 'rich_block' && e.payload.title === '第 3 周期：夜里按规则采纳「Lower rate」')));
});

test('at night the analysts’ first direction is adopted only when they agree, the first analyst’s for them', async (t) => {
  const f = await fixture(t), o = await f.create(); await f.initialize(o, losing);
  // An objective created before the setting has none: the default applies.
  await retain(f.storage, ownerKey('owner'), (state) => { delete state.experiments[o.id].policy.auto; });
  const cats = [{ id: 'ana-1', name: '甲', model: 'm1' }, { id: 'ana-2', name: '乙', model: 'm2' }];
  for (const c of cats) await f.http('POST', { op: 'analystAdd', objective: o.id, catId: c.id, cats });
  t.mock.timers.enable({ apis: ['Date'], now: night });
  for (const [target, agree] of [['steps', false], ['lr', true]]) {
    const round = await execute(f, o);
    await f.tool('task', {}, 'cat-b5ddoo9l', o.thread);
    assert.equal((await f.tool('conclude', { cycle: round.n, verdict: 'tune', findings: 'Measured' }, 'cat-b5ddoo9l', o.thread)).ok, true);
    // 乙 proposes first; 甲, the first analyst, still speaks for them.
    for (const [id, x] of [['ana-2', target], ['ana-1', 'lr']]) {
      const task = await f.tool('task', {}, id, o.thread);
      assert.equal((await f.tool('propose', { cycle: round.n, options: [{ k: x, title: x, why: 'w', kind: 'variable', target: x, cites: task.analyze.library.map((d) => d.id) }] }, id, o.thread)).ok, true);
    }
    const r = (await f.read()).experiments[o.id].rounds.at(-1);
    assert.equal(r.report.agree, agree);
    if (agree) assert.deepEqual([r.decision.directionId, r.decision.by], ['lr-ana-1', 'RSI']);
    else { assert.equal(r.decision, null); await decide(f, o); }
  }
});

test('inside the run window a candidate is confirmed at once', async (t) => {
  const f = await fixture(t), o = await f.create({ auto: 'execution' }); await f.initialize(o);
  t.mock.timers.enable({ apis: ['Date'], now: night });
  await execute(f, o);
  const d = await concludeAt(t, f, o, night, [{ k: 'lr', title: 'Lower rate', kind: 'code' }]);
  assert.equal(d.candidate.cycle, 1);
  assert.deepEqual([d.rounds[0].decision.pick, d.rounds[0].decision.by, d.rounds[0].decision.note], ['same', 'RSI', '有候选：直接换新种子复验']);
  await f.activation().actions['rsi.tick']();
  const rounds = (await f.read()).experiments[o.id].rounds;
  assert.equal(rounds.length, 2); assert.ok(rounds[1].plan.groups.some((g) => g.confirm));
});

test('what the night may decide by itself is chosen at creation and changed later; 都等我定 adopts nothing', async (t) => {
  const f = await fixture(t);
  assert.match((await f.http('POST', { op: 'new', project: '', thread: 'source', statement: 'X', prepare: 'codex', evaluate: 'cat-b5ddoo9l', auto: 'code', cats: [] })).error, /夜里可以自己定的方向/);
  // Left empty, it is the default.
  const o = await f.create({ auto: '' });
  let d = (await f.read()).experiments[o.id], item = d.prep.find((p) => p.id.endsWith('-auto'));
  assert.deepEqual(d.policy.auto, ['execution', 'variable']); assert.equal(item.title, '夜里可以自己定的方向'); assert.match(item.value, /^执行修复和调变量/);
  assert.deepEqual((await f.http('POST', { op: 'prep', objective: o.id, id: item.id, action: 'edit' })).args, { kind: 'rsiAuto', objective: o.id, auto: 'default' });
  assert.equal((await f.http('POST', { op: 'auto', objective: o.id, auto: 'all' })).status, 400);
  assert.equal((await f.http('POST', { op: 'auto', objective: o.id, auto: 'none' })).status, 200);
  d = (await f.read()).experiments[o.id];
  assert.deepEqual(d.policy.auto, []); assert.match(d.prep.find((p) => p.id === item.id).value, /^都等你定/);
  assert.ok(d.messages.some((m) => m.title === '你改了夜里可以自己定的方向'));
  await f.initialize(o, losing);
  t.mock.timers.enable({ apis: ['Date'], now: night });
  await execute(f, o);
  assert.equal((await concludeAt(t, f, o, night, [{ k: 'lr', title: 'Lower rate', kind: 'variable' }])).rounds[0].decision, null);
});

// The project is broken until the marker file goes: a stand-in for the code a governance member fixes.
const breakable = (f) => Object.assign(f.commands, { submit: `test ! -f broken && ${f.commands.submit}`, analyze: 'echo "missing build: broken marker"' });
const failing = (f, o) => f.http('POST', { op: 'runCycle', objective: o.id }).then(() => until(f.read, (s) => ['repairing', 'evaluating'].includes(s.experiments[o.id].rounds.at(-1)?.state)));
const one = { groups: [{ id: 'control', label: 'Control', vars: {}, control: true }], seeds: [11] };

test('a cycle whose runs fail goes to the governance member, who fixes it, and the plan runs again on the fixed version', async (t) => {
  const f = await fixture(t), o = await f.create(); breakable(f);
  await f.initialize(o, losing);
  await writeFile(join(f.project, 'broken'), '');
  let d = (await failing(f, o)).experiments[o.id];
  assert.equal(d.rounds[0].state, 'repairing');
  const repair = textOf(await until(async () => f.sends.find((s) => s.wake?.catId === 'codex' && textOf(s).startsWith('第 1 周期运行失败，请修')), Boolean, 'repair wake'));
  assert.ok(repair.split('\n').at(-1).startsWith('@codex ') && repair.includes('在单独的 git worktree 里'), repair);
  const task = await f.tool('task', {}, 'codex', o.thread);
  assert.equal(task.version.repair.signature, 'missing build: broken marker');
  assert.equal(task.version.repair.failures[0].step, 'submit');
  await rm(join(f.project, 'broken'));
  assert.equal((await f.tool('version', { change: 'Fix the build', config: {} }, 'codex', o.thread)).version, 'v2');
  d = (await f.read()).experiments[o.id];
  assert.equal(d.rounds[0].state, 'repaired'); assert.equal(d.objective.currentVersion, 'v2'); assert.equal(d.repairs.length, 1);
  assert.deepEqual(d.upcoming.groups.map((g) => [g.id, g.version]), [['control', 'v2'], ['change', 'v2']]);
  const again = await execute(f, o);
  assert.ok(again.runs.every((r) => r.state === 'done' && !r.error));
  assert.ok(f.sends.some((s) => s.payload.elements.some((e) => e.kind === 'rich_block' && e.payload.title === '第 1 周期运行失败，交给 砚砚 修')));
});

test('the same failure three times in a row goes to the evaluator', async (t) => {
  const f = await fixture(t), o = await f.create(); breakable(f);
  await f.initialize(o, one);
  await writeFile(join(f.project, 'broken'), '');
  for (const n of [1, 2]) {
    assert.equal((await failing(f, o)).experiments[o.id].rounds.at(-1).state, 'repairing');
    await f.tool('task', {}, 'codex', o.thread);
    assert.equal((await f.tool('version', { change: `Attempt ${n}`, config: {} }, 'codex', o.thread)).version, `v${n + 1}`);
  }
  assert.equal((await failing(f, o)).experiments[o.id].rounds.at(-1).state, 'evaluating');
});

test('a repair the member cannot make, or does not make in time, goes to the evaluator', async (t) => {
  const f = await fixture(t), o = await f.create(); breakable(f);
  await f.initialize(o, one);
  await writeFile(join(f.project, 'broken'), '');
  await failing(f, o);
  await f.tool('task', {}, 'codex', o.thread);
  assert.equal((await f.tool('version', { cannot: 'Needs a driver upgrade' }, 'codex', o.thread)).evaluating, true);
  let d = (await f.read()).experiments[o.id];
  assert.equal(d.rounds[0].state, 'evaluating'); assert.equal(d.versionRequest, undefined);
  assert.ok(d.messages.some((m) => m.title === '第 1 周期的运行失败没有修好' && m.body.includes('Needs a driver upgrade')));
  await report(f, o, 'insufficient'); await decide(f, o);
  // The next failure waits for its repair; an hour later the schedule gives it to the evaluator.
  assert.equal((await failing(f, o)).experiments[o.id].rounds.at(-1).state, 'repairing');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 61 * 60_000 });
  await f.activation().actions['rsi.tick']();
  d = (await f.read()).experiments[o.id];
  // Run in the hour before 08:00, the same tick also sends the summary of the window that just closed.
  assert.equal(d.rounds.at(-1).state, 'evaluating'); assert.ok(d.messages.some((m) => m.body.includes('60 分钟内没修好')));
});

test('how many failures a night fixes by itself is set at creation and changed later; 0 leaves failures to the evaluator', async (t) => {
  const f = await fixture(t);
  assert.ok((await f.http('POST', { op: 'new', project: '', thread: 'source', statement: 'X', prepare: 'codex', evaluate: 'cat-b5ddoo9l', repair: 'many', cats: [] })).error);
  const o = await f.create({ repair: '1' }); breakable(f);
  let d = (await f.read()).experiments[o.id], item = d.prep.find((p) => p.id.endsWith('-repair'));
  assert.equal(d.policy.repair, 1); assert.match(item.value, /每晚最多 1 次/);
  assert.deepEqual((await f.http('POST', { op: 'prep', objective: o.id, id: item.id, action: 'edit' })).args, { kind: 'rsiRepair', objective: o.id, repair: '1' });
  await f.initialize(o, one);
  await writeFile(join(f.project, 'broken'), '');
  // The night's one repair is used...
  await failing(f, o); await f.tool('task', {}, 'codex', o.thread);
  await f.tool('version', { change: 'Attempt', config: {} }, 'codex', o.thread);
  // ...so the next failure goes to the evaluator.
  assert.equal((await failing(f, o)).experiments[o.id].rounds.at(-1).state, 'evaluating');
  assert.equal((await f.http('POST', { op: 'repair', objective: o.id, repair: '0' })).status, 200);
  d = (await f.read()).experiments[o.id];
  assert.equal(d.policy.repair, 0); assert.match(d.prep.find((p) => p.id.endsWith('-repair')).value, /^不自动修/);
});

test('the first tick after a run window closes sends one summary of it built from the records; a quiet night sends none', async (t) => {
  const f = await fixture(t), o = await f.create({ auto: 'default' }); breakable(f);
  await f.initialize(o, losing);
  await writeFile(join(f.project, 'broken'), '');
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 15, 19, 59).getTime() });
  const tick = () => f.activation().actions['rsi.tick']();
  const at = (day, hour, minute = 0) => t.mock.timers.setTime(new Date(2026, 10, day, hour, minute).getTime());
  const digests = () => f.sends.flatMap((s) => s.payload.elements).filter((e) => e.kind === 'rich_block' && e.payload.title.startsWith('夜间总结'));
  assert.equal((await f.http('POST', { op: 'life', action: 'start', objective: o.id })).status, 200);
  // Cycle 1 fails and v2 repairs it; cycle 2 reruns its plan and goes on by 照旧; cycle 3's variable is adopted by rule.
  at(15, 20); await tick();
  await until(f.read, (s) => s.experiments[o.id].rounds[0]?.state === 'repairing');
  await f.tool('task', {}, 'codex', o.thread); await rm(join(f.project, 'broken'));
  assert.equal((await f.tool('version', { change: 'Fix the build', config: {} }, 'codex', o.thread)).version, 'v2');
  await tick();
  await until(f.read, (s) => s.experiments[o.id].rounds[1]?.state === 'evaluating');
  await report(f, o);
  at(15, 20, 31); await tick();
  await until(f.read, (s) => s.experiments[o.id].rounds[2]?.state === 'evaluating');
  await concludeAt(t, f, o, night, [{ k: 'lr', title: 'Lower rate', kind: 'variable' }]);
  at(16, 7, 59); await tick(); assert.equal(digests().length, 0);
  at(16, 8, 1); await tick();
  assert.deepEqual(digests().map((e) => [e.payload.title, e.payload.bodyMarkdown]), [['夜间总结 · 11月15日', [
    '第 1 周期（v1）：已修复，由 v2 重跑\n第 2 周期（v2）：tune · Measured against this cycle’s control\n第 3 周期（v2）：tune · Measured',
    '夜里自己定的：照旧 1 次；按规则采纳「Lower rate」', 'v2 修了「missing build: broken marker」', '现在：等 砚砚 按「Lower rate」出版本'].join('\n\n')]]);
  at(16, 8, 4); await tick(); assert.equal(digests().length, 1);
  // The next night nothing starts, is decided or repaired.
  at(17, 8, 1); await tick(); assert.equal(digests().length, 1);
});

test('members can be changed after creation; work waiting for a role goes to its new member', async (t) => {
  const f = await fixture(t), o = await f.create(); await f.initialize(o, losing);
  const round = await execute(f, o);
  const cats = [{ id: 'codex', name: '砚砚', model: 'gpt-5.6-sol' }, { id: 'cat-b5ddoo9l', name: '小狸', model: 'k3.1' }, { id: 'cat-new', name: '新评估', model: 'm9' }];
  assert.equal((await f.http('POST', { op: 'members', objective: o.id, prepare: 'codex', evaluate: 'cat-new', iterate: 'codex', cats })).status, 200);
  assert.deepEqual((await f.read()).experiments[o.id].members.filter((m) => m.role === 'evaluate').map((m) => [m.catId, m.name, m.model]), [['cat-new', '新评估', 'm9']]);
  // The cycle waiting for its conclusion goes to the new evaluator; the old one has no turn.
  await until(async () => f.sends.filter((s) => s.wake?.catId === 'cat-new').length, (n) => n === 1, 'new evaluator wake');
  assert.equal((await f.tool('task', {}, 'cat-b5ddoo9l', o.thread)).status, 403);
  assert.equal((await f.tool('task', {}, 'cat-new', o.thread)).evaluate.cycle, round.n);
  const page = await f.http('GET', undefined, { view: 'exp', project: f.project, pick: `obj:${o.id}` });
  assert.deepEqual(page.memberIds, { prepare: 'codex', evaluate: 'cat-new', iterate: 'codex' });
  // Single-member roles are listed; discussion members are the chips of their own row; the policy row says what the night may decide.
  assert.deepEqual(page.roleMembers.map((m) => m.role), ['prepare', 'evaluate', 'iterate']); assert.deepEqual(page.discussion, []);
  assert.equal(page.policy.autoText.t, 'rsi.exp.pol.manual');
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

test('async jobs are polled at the registered interval; past the timeout a job is cancelled and retried once as an environment failure', async (t) => {
  const f = await fixture(t), o = await f.create({ repair: '0' });
  // The stuck group's job never leaves running.
  Object.assign(f.commands, asyncExecutor, { get: `grep -q stuck {config} && echo '{"state":"running"}' || ${asyncExecutor.get}`, cancel: 'echo {job} >> cancels', poll: 2, timeout: 2 });
  await f.initialize(o, { groups: [{ id: 'control', label: 'Control', vars: {}, control: true }, { id: 'stuck', label: 'Stuck', vars: { stuck: true } }], seeds: [11] });
  const [done, stuck] = (await execute(f, o)).runs;
  // Done at its second get, two seconds after the first.
  assert.equal(done.state, 'done'); assert.ok(done.end - done.start >= 2000, String(done.end - done.start));
  assert.equal(stuck.state, 'failed'); assert.equal(stuck.attempts.length, 2); assert.match(stuck.error.raw, /超过 2 秒没结束/);
  // Each attempt's job is cancelled once, the one that fails for good too.
  assert.deepEqual((await readFile(join(f.project, 'cancels'), 'utf8')).trim().split('\n'), ['job with spaces;literal', 'job with spaces;literal']);
});

test('a job that fails for good is cancelled once; its first failure is retried without', async (t) => {
  const f = await fixture(t), o = await f.create({ repair: '0' });
  Object.assign(f.commands, asyncExecutor, { get: `echo '{"state":"failed","reason":"node lost"}'`, cancel: 'echo {job} >> cancels' });
  await f.initialize(o, one);
  const run = (await execute(f, o)).runs[0];
  assert.equal(run.state, 'failed'); assert.equal(run.attempts.length, 2);
  assert.equal((await readFile(join(f.project, 'cancels'), 'utf8')).trim(), 'job with spaces;literal');
});

test('a cycle the schedule started stops at its window’s end and goes on the next night; one started from the page does not stop', async (t) => {
  const f = await fixture(t), o = await f.create();
  // A run counts its start, then sleeps as long as the project's nap file says.
  Object.assign(f.commands, { submit: `echo {seed} >> starts && sleep "$(cat nap)" && echo '{"score":1}' > {run}/metrics.json` });
  await writeFile(join(f.project, 'nap'), '30');
  await f.initialize(o, { groups: [{ id: 'control', label: 'Control', vars: {}, control: true }], seeds: [1, 2] }, { window: '每晚 20:00–08:00' });
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 15, 19, 59).getTime() });
  const tick = () => f.activation().actions['rsi.tick']();
  const at = (day, hour) => t.mock.timers.setTime(new Date(2026, 10, day, hour).getTime());
  const starts = () => readFile(join(f.project, 'starts'), 'utf8').then((s) => s.split('\n').length - 1, () => 0);
  assert.equal((await f.http('POST', { op: 'life', action: 'start', objective: o.id })).status, 200);
  at(15, 20); await tick();
  await until(starts, (n) => n === 1, 'first run');
  // At the window's end the running run is stopped and waits with the queued one, counting no retry or attempt.
  at(16, 8); await tick();
  let d = (await until(f.read, (s) => s.experiments[o.id].rounds[0].runs[0].state === 'queued', 'held run')).experiments[o.id];
  assert.equal(d.rounds[0].state, 'running');
  assert.deepEqual(d.rounds[0].runs.map((r) => [r.state, r.retries, r.attempts.length]), [['queued', 0, 0], ['queued', 0, 0]]);
  // The next night both run once the window opens.
  await writeFile(join(f.project, 'nap'), '0');
  at(16, 20); await tick();
  d = (await until(f.read, (s) => s.experiments[o.id].rounds[0].state === 'evaluating')).experiments[o.id];
  assert.ok(d.rounds[0].runs.every((r) => r.state === 'done' && r.attempts.length === 1 && r.start >= new Date(2026, 10, 16, 20).getTime()));
  assert.equal(await starts(), 3);
  // Started with 跑一轮 outside the window, a cycle's run goes on through the tick.
  await report(f, o); await decide(f, o);
  await writeFile(join(f.project, 'nap'), '1');
  at(17, 12);
  assert.equal((await f.http('POST', { op: 'runCycle', objective: o.id })).status, 200);
  await until(starts, (n) => n === 4, 'page run');
  await tick();
  d = (await until(f.read, (s) => s.experiments[o.id].rounds[1]?.state === 'evaluating')).experiments[o.id];
  assert.ok(d.rounds[1].runs.every((r) => r.state === 'done')); assert.equal(await starts(), 5);
});

test('collect gets the run’s start and the end of its submit in epoch seconds, to cut its part out of logs that accumulate across runs', async (t) => {
  const f = await fixture(t), o = await f.create();
  f.commands.collect = 'echo {start} {end} > {run}/span && cat {run}/metrics.json';
  await f.initialize(o, one);
  const run = (await execute(f, o)).runs[0];
  const [start, end] = (await readFile(join(run.directory, 'span'), 'utf8')).split(' ').map(Number);
  assert.equal(start, Math.floor(run.start / 1000)); assert.ok(start <= end && end <= run.end / 1000, `${start} ${end}`);
});

test('an environment failure during confirmation retains the candidate and asks no analyst', async (t) => {
  const f = await fixture(t), o = await f.create({ repair: '0' }); Object.assign(f.commands, pythonExecutor);
  await f.initialize(o, plan({ delta: 2 }));
  await f.http('POST', { op: 'analystAdd', objective: o.id, catId: 'ana-1', cats: [{ id: 'ana-1', name: '甲', model: 'm1' }] });
  await execute(f, o); await report(f, o); await decide(f, o);
  const source = await readFile(join(f.project, 'experiment.py'), 'utf8');
  await writeFile(join(f.project, 'experiment.py'), source.replace("if config.get('kill'):", "if int(seed) > 23 and config.get('delta'):\n    sys.exit(9)\nif config.get('kill'):"));
  await execute(f, o);
  const result = await report(f, o, 'insufficient');
  assert.equal(result.confirmation.status, 'insufficient'); assert.equal(result.stop, null);
  // The candidate stays and the next cycle confirms it again: no analyst is asked.
  assert.equal(result.analysts, undefined);
  let d = (await f.read()).experiments[o.id]; assert.ok(d.candidate); assert.equal(d.objective.currentVersion, 'v1');
  await writeFile(join(f.project, 'experiment.py'), source);
  await decide(f, o); const third = await execute(f, o); assert.ok(third.plan.seeds.every((s) => s > 25));
  const confirmed = await report(f, o); assert.equal(confirmed.confirmation.status, 'confirmed'); assert.deepEqual(confirmed.analysts, ['ana-1']);
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

test('a long statement creates a short clipped thread title and card title, and persisted overlong outbox titles self-heal on start', async (t) => {
  const f = await fixture(t);
  const statement = `在独立包内优化完整 200 条重排推理：\n${'守住精度与阈值硬闸门并压低开环尾延迟与提升有效吞吐量，'.repeat(12)}`;
  assert.ok(statement.length > 260);
  const o = await f.create({ statement });
  const created = f.threads.find((th) => th.id === o.thread);
  assert.ok(created && created.title.startsWith('RSI · ') && created.title.length <= 80 && !/[\r\n]/.test(created.title), created?.title);
  assert.equal((await f.read()).experiments[o.id].objective.goal.statement, statement);
  const goalCard = f.sends.flatMap((s) => s.payload.elements).find((el) => el.kind === 'rich_block' && el.payload.kind === 'card');
  assert.ok(goalCard && goalCard.payload.title.length <= 120, goalCard?.payload?.title);

  // Legacy alpha.62 outbox entry with an overlong title must self-heal on restart instead of failing flush().
  const legacyId = 'obj-legacy-overlong';
  await retain(f.storage, ownerKey('owner'), (state) => {
    state.experiments[legacyId] = clone(state.experiments[o.id]);
    state.experiments[legacyId].objective.id = legacyId;
    state.experiments[legacyId].objective.thread = null;
    const origSummary = state.objectives[f.project].find((x) => x.id === o.id);
    state.objectives[f.project].push({ ...clone(origSummary), id: legacyId });
    state.outbox.unshift({ id: 'legacy-create', kind: 'createThread', objective: legacyId, project: f.project, title: `RSI · ${statement}` });
  });
  await f.activation().stop();
  f.start();
  const healed = await until(f.read, (s) => Boolean(s.experiments[legacyId]?.objective.thread), 'legacy overlong thread creation');
  const healedThread = f.threads.find((th) => th.id === healed.experiments[legacyId].objective.thread);
  assert.ok(healedThread && healedThread.title.length <= 80, healedThread?.title);
});

test('new objective reuses the current thread by default, blocks duplicate binding on the same thread, falls back to a new thread on default/blank chats, and supports explicit new thread mode', async (t) => {
  const f = await fixture(t);
  // Default (omitted or threadMode: 'current'): reuses existing 'source' thread without calling threads.create.
  const reused = await f.create({ threadMode: 'current' });
  assert.equal(reused.thread, 'source');
  assert.equal(f.threads.length, 1);
  assert.equal((await f.read()).experiments[reused.id].objective.thread, 'source');
  assert.ok(f.subscriptions.some((s) => s.threadId === 'source' && s.method === 'rsi.delivery'));
  assert.ok(f.sends.some((s) => s.threadId === 'source' && s.wake?.catId === 'codex'));
  // Trying to bind a second objective to the same 'source' thread fails cleanly and instructs choosing new thread.
  const dup = await f.http('POST', { op: 'new', project: '', thread: 'source', threadMode: 'current', statement: 'Second objective', prepare: 'codex', evaluate: 'cat-b5ddoo9l', auto: 'none' });
  assert.equal(dup.status, 400);
  assert.match(dup.error, /已绑定其他评估项/);
  // Choosing threadMode: 'new' on the same 'source' thread creates a dedicated new thread cleanly.
  const dedicated = await f.create({ threadMode: 'new', statement: 'Dedicated thread objective' });
  assert.notEqual(dedicated.thread, 'source');
  assert.equal(f.threads.length, 2);
  // On a blank/default chat (no existing thread) with an explicit project, threadMode: 'current' falls back to creating a new thread.
  const fromBlank = await f.create({ project: f.project, thread: 'default', threadMode: 'current', statement: 'From blank chat' });
  assert.notEqual(fromBlank.thread, 'default');
  assert.notEqual(fromBlank.thread, 'source');
  assert.equal(f.threads.length, 3);
});
