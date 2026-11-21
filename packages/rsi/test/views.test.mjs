import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { act } from '../dist/actions.js';
import { conclude, finishAnalysis, propose } from '../dist/cycles.js';
import { createFixtures } from '../dist/fixtures.js';
import { rsiExpNew } from '../dist/init.js';
import { viewModel } from '../dist/views.js';
import { fixture, now } from './helpers.mjs';

const views = ['home', 'objective', 'exp', 'record', 'policy', 'todo', 'newExp', 'caps', 'cards', 'library', 'doc'];

test('every VM returns a JSON 200 for cartpole-rl and pd-ttft, including an empty project', async () => {
  const f = fixture();
  await f.seed();
  for (const project of ['cartpole', 'pd-infer']) for (const view of views) {
    const response = await f.view({ project, view });
    assert.equal(response.status, 200, `${project}/${view}`);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.deepEqual((await f.view()).payload.pick, { k: 'none' });
  assert.equal((await f.view()).payload.hasObjectives, false);
  const id = await f.newObjective();
  for (const view of views) assert.equal((await f.view({ project: 'cartpole', pick: `obj:${id}`, view })).status, 200, view);
});

test('VM fields match responses captured by executing the original mock.js and app.js in node:vm', () => {
  const reference = JSON.parse(readFileSync(new URL('./fixtures/prototype-views.json', import.meta.url), 'utf8'));
  for (const entry of reference.cases) {
    const fixture = createFixtures(reference.now), state = fixture.state;
    if (entry.script) {
      state.experiments['cp-converge'] = fixture.templates['cp-converge'];
      state.objectives.cartpole.push({ id: 'cp-converge', name: '训练更快、更稳地收敛', parent: null, state: 'pending', mode: 'exp', trigger: '18:00–08:00', running: { o: 'v2' }, cycle: null, prediction: null, locked: 0 });
    }
    const actual = JSON.parse(JSON.stringify(viewModel(state, entry.view, entry.query)));
    // The plugin may add fields for its own page (choices tagged with the conversation); the prototype's fields must match.
    const like = (a, e) => Array.isArray(e) ? (Array.isArray(a) && a.length === e.length ? a.map((x, i) => like(x, e[i])) : a)
      : e && typeof e === 'object' && a && typeof a === 'object' && !Array.isArray(a) ? Object.fromEntries(Object.keys(e).map((k) => [k, like(a[k], e[k])])) : a;
    for (const [path, expected] of Object.entries(entry.fields)) {
      const value = path.split('.').reduce((at, key) => at?.[key], actual);
      assert.deepEqual(like(value, expected), expected, `${entry.view} ${JSON.stringify(entry.query)} ${path}`);
    }
  }
});

test('the page follows the current conversation unless something was chosen in it; a choice made in another conversation no longer applies', async () => {
  const f = fixture(); await f.seed();
  const home = async (q) => (await f.view(q)).payload;
  // An objective's conversation opens that objective.
  const at = await home({ thread: 't-rsi-pd' });
  assert.deepEqual([at.projectId, at.pick.id, at.picked], ['pd-infer', 'pd-ttft', true]);
  // Choices carry the conversation they were made in.
  assert.equal(at.listKey, 'list#@t-rsi-pd');
  assert.equal(at.projectChoice, 'pd-infer#@t-rsi-pd');
  assert.ok(at.nodes[''].every((n) => n.pickKey.endsWith('#@t-rsi-pd')));
  assert.ok(at.navs.every((n) => n.pickKey === n.k + '#@t-rsi-pd'));
  // In that conversation a choice applies (the library, still in the objective's project), and the list stays the list ...
  const lib = await home({ thread: 't-rsi-pd', pick: 'library#@t-rsi-pd' });
  assert.deepEqual([lib.projectId, lib.pick.k, lib.picked], ['pd-infer', 'library', true]);
  assert.equal((await home({ thread: 't-rsi-pd', pick: 'list#@t-rsi-pd' })).picked, false);
  // ... while choices made in another conversation do not: the page follows this one.
  const other = await home({ thread: 't-rsi-pd', project: 'cartpole#@elsewhere', pick: 'caps#@elsewhere' });
  assert.deepEqual([other.projectId, other.pick.id, other.picked], ['pd-infer', 'pd-ttft', true]);
  // Untagged choices apply in any conversation.
  assert.equal((await home({ project: 'pd-infer', pick: 'library', thread: 'unrelated' })).pick.k, 'library');
});

test('a project conversation opens its project; with nothing to follow the page opens the first real project; demo projects say so', () => {
  const s = createFixtures(now).state;
  s.projects.unshift({ id: '/work/real', name: 'real', projectPath: '/work/real', exp: true });
  s.objectives['/work/real'] = []; s.groups['/work/real'] = []; s.units['/work/real'] = []; s.library['/work/real'] = [];
  assert.equal(viewModel(s, 'home', { thread: 'conversation-1', threadProject: 'pd-infer' }).projectId, 'pd-infer');
  const home = viewModel(s, 'home', {});
  assert.equal(home.projectId, '/work/real');
  assert.equal(home.projects.find((p) => p.id === '/work/real').name, 'real');
  assert.deepEqual(home.projects.find((p) => p.id === 'cartpole').name, { t: 'rsi.demoProject', args: ['cartpole-rl'] });
});

test('a real project with only its executor capability is listed; groups say who uses them; the executor of a deleted objective is not shown; triggers read as a time range', () => {
  const s = createFixtures(now).state;
  s.projects.unshift({ id: '/work/real', name: 'real', projectPath: '/work/real', exp: true });
  s.objectives['/work/real'] = [{ id: 'pd-ttft', name: '目标 X', parent: null, state: 'preparing', mode: 'exp', trigger: '每晚 20:00–08:00' }];
  s.units['/work/real'] = []; s.library['/work/real'] = [];
  s.groups['/work/real'] = [{ id: 'exec-pd-ttft', side: 'collect', kind: 'mcp', name: '执行 MCP rsi.executor', where: 'preflight · 试跑通过', users: '目标 X', forObjective: 'pd-ttft' },
    { id: 'exec-gone', side: 'collect', kind: 'mcp', name: '执行 MCP rsi.executor', where: 'preflight · 试跑通过', users: '已删', forObjective: 'gone' }];
  const caps = viewModel(s, 'caps', { project: '/work/real' });
  assert.equal(caps.listed, true);
  assert.deepEqual(caps.collect.map((g) => [g.id, g.users]), [['exec-pd-ttft', '目标 X']]);
  assert.equal(viewModel(s, 'home', { project: '/work/real' }).nodes[''][0].trigger, '20:00–08:00');
  s.groups['/work/real'] = [];
  assert.equal(viewModel(s, 'caps', { project: '/work/real' }).listed, false);
});

test('capability groups are renamed with the plugin write; a write acts on the project the page shows', async () => {
  const f = fixture(); await f.seed();
  const g = (await f.read()).groups['pd-infer'][0];
  // No project in the query: the followed conversation (an objective of pd-infer) decides it.
  const renamed = await f.act({ op: 'groupRename', id: g.id, name: '  新名字  ' }, { thread: 't-rsi-pd' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.payload));
  assert.equal((await f.read()).groups['pd-infer'].find((x) => x.id === g.id).name, '新名字');
  assert.equal((await f.act({ op: 'groupRename', id: g.id, name: ' ' }, { project: 'pd-infer' })).status, 400);
  assert.equal((await f.act({ op: 'groupRename', id: 'missing', name: 'x' }, { project: 'pd-infer' })).status, 404);
});

test('home says whether the user picked something (a collapsed split shows its detail); pick list goes back to the list', async () => {
  const f = fixture(); await f.seed();
  const home = async (q) => (await f.view({ project: 'pd-infer', ...q })).payload;
  const first = await home({});
  assert.equal(first.picked, false);
  assert.equal(first.pick.k, 'obj');
  // The head's 新建评估项 opens the experimental dialog only for experimental projects.
  assert.equal(first.exp, true);
  assert.equal((await f.view({ project: 'notes-agent' })).payload.exp, false);
  assert.deepEqual(await home({ pick: 'list' }).then((x) => [x.picked, x.pick]), [false, first.pick]);
  assert.deepEqual(await home({ pick: 'caps' }).then((x) => [x.picked, x.pick.k]), [true, 'caps']);
  assert.deepEqual(await home({ pick: `obj:${first.pick.id}` }).then((x) => [x.picked, x.pick.id]), [true, first.pick.id]);
  assert.equal((await f.view({ project: 'cartpole', pick: 'obj:gone' })).payload.picked, false);
  // A picked objective that was deleted: back at the list, the detail falls back to the first objective.
  assert.deepEqual(await home({ pick: 'obj:gone' }).then((x) => [x.picked, x.pick.id]), [false, first.pick.id]);
});

test('record, document, cards, and version selections consume their page-state queries', async () => {
  const f = fixture(); await f.seed();
  const doc = await f.view({ project: 'pd-infer', view: 'doc', id: 'doc-pd-overview' });
  assert.equal(doc.payload.id, 'doc-pd-overview');
  assert.deepEqual(doc.payload.objectiveNames, ['PD 分离下 TTFT p90 降低 20%']);
  const state = await f.read(), detail = state.details['tool-access-correct-use'];
  const cycle = detail.cycles.find((c) => c.decision === 'evolve');
  const record = await f.view({ project: 'self', view: 'record', type: 'run', objective: detail.id, cycle: cycle.id, id: `run-${cycle.id}-1` });
  assert.equal(record.payload.type, 'run'); assert.equal(record.payload.state, 'done');
  const only = await f.view({ project: 'self', view: 'cards', objective: 'identity-truth' });
  assert.equal(only.payload.cards.length, 1); assert.equal(only.payload.cards[0].objective, 'identity-truth');
  const objective = await f.view({ project: 'self', pick: 'obj:tool-access-correct-use', view: 'objective', tab: 'metrics', selE: 'E1>node', selC: 'C1>node' });
  assert.equal(objective.payload.eStep, 'node'); assert.equal(objective.payload.eSel.id, 'E1');
  assert.equal(objective.payload.cSel.id, 'C1');
  assert.equal((await f.read()).now, now);
  const collection = await f.view({ project: 'self', pick: 'obj:tool-access-correct-use', view: 'objective', tab: 'collect', selC: 'C1>node' });
  assert.equal(collection.status, 200);
  assert.ok(collection.payload.traces.items.length > 0);
  const trace = collection.payload.traces.items[0];
  const traceRecord = await f.view({ view: 'record', type: 'trace', objective: detail.id, cycle: trace.cycleId, id: trace.id });
  assert.equal(traceRecord.payload.type, 'trace');
  assert.equal((await f.view({ project: 'pd-infer', view: 'doc', id: 'missing' })).payload, null);
});

// A real objective with one cycle of three groups × two seeds, waiting for its conclusion; values per group and seed are its metrics in order.
const P = '/work/arith';
const METRICS = [{ id: 'accuracy', name: 'holdout accuracy', dir: 'up', guard: false, minDelta: 0.05 }, { id: 'format_rate', name: '格式正确率', dir: 'up', guard: false },
  { id: 'signal', name: '训练信号步占比', dir: 'up', guard: true, threshold: 0.3 }, { id: 'tail', name: '末窗 train accuracy', dir: 'up', guard: true, threshold: 0.05 }, { id: 'wall', name: 'wall_time_s', dir: 'down', guard: false }];
const GROUPS = [{ id: 'control', label: '当前版本对照', version: 'v1', vars: {}, control: true, confirm: false },
  { id: 'lr-low', label: '只降学习率', version: 'v1', vars: { lr: 0.00003 }, control: false, confirm: false },
  { id: 'format-zero', label: '去掉格式奖励', version: 'v1', vars: { reward_weights: { correctness: 1, format: 0 } }, control: false, confirm: false }];
// The control crosses the signal guardrail on seed 23; lr-low is best but crosses the tail one on seed 11; format-zero wins.
const VALUES = { control: [[0.08, 0.9, 0.35, 0.06, 100], [0.075, 0.8, 0.25, 0.07, 110]], 'lr-low': [[0.52, 0.95, 0.4, 0.04, 100], [0.51, 0.85, 0.42, 0.06, 110]],
  'format-zero': [[0.21, 0.5, 0.33, 0.08, 90], [0.19, 0.4, 0.31, 0.09, 100]] };
// No winner: format-zero also crosses the signal guardrail.
const SPLIT = { ...VALUES, control: [[0.08, 0.9, 0.35, 0.06, 100], [0.075, 0.8, 0.33, 0.07, 110]], 'format-zero': [[0.21, 0.5, 0.2, 0.08, 90], [0.19, 0.4, 0.31, 0.09, 100]] };
function arith({ analysts = [], seeds = [11, 23], groups = GROUPS, values = VALUES } = {}) {
  const s = createFixtures(now).state;
  s.projects.unshift({ id: P, name: 'arith', projectPath: P, exp: true });
  s.objectives[P] = []; s.groups[P] = []; s.units[P] = []; s.library[P] = [];
  s.draft = { analysts: analysts.map(([catId, name]) => ({ catId, name, model: `m-${catId}` })) };
  const o = rsiExpNew(s, P, { statement: '算术题准确率', prepare: 'it', evaluate: 'ev', iterate: 'it', projectPath: P, auto: 'none',
    cats: [{ id: 'ev', name: '小狸', model: 'k3.1' }, { id: 'it', name: '砚砚', model: 'gpt-5.6' }] }, now);
  const d = s.experiments[o.id];
  d.metrics = { version: 'E1', items: METRICS };
  const runs = groups.flatMap((g) => seeds.map((seed, i) => ({ id: `${o.id}-1-${g.id}-s${seed}`, group: g.id, seed, state: 'done', start: now, end: now + 60000, retries: 0, attempts: [],
    metrics: Object.fromEntries(METRICS.map((m, k) => [m.id, values[g.id][i][k]])), artifacts: [], env: {}, log: '', error: null })));
  d.rounds.push({ n: 1, version: 'v1', start: now, end: now + 60000, state: 'evaluating', plan: { groups, seeds }, metrics: structuredClone(d.metrics), report: null, decision: null, events: [], runs });
  d.objective.state = 'running';
  const x = { s, d, id: o.id };
  x.conclude = (options, findings = 'f') => assert.equal(conclude(s, d, { cycle: 1, verdict: 'tune', findings, ...(options ? { options } : {}) }, now).ok, true);
  x.propose = (catId, options) => assert.equal(propose(s, d, { cycle: 1, options }, catId, now).ok, true);
  x.view = (step) => viewModel(s, 'exp', { project: P, pick: `obj:${o.id}`, ...(step ? { selO: `${o.id}/v1>c1.${step}` } : {}) });
  x.steps = (vm) => vm.versions[0].steps;
  return x;
}
const option = (k, kind, target, expect) => ({ k, title: k, why: 'w', kind, ...(target ? { target } : {}), ...(expect ? { expect } : {}) });

test('evaluation compares every metric with the same cycle’s control: the main metric, then guardrails, then the rest; per group mean ± SD, signed difference, better or worse, guardrail crossings and per-seed values', () => {
  const x = arith();
  x.conclude([option('confirm', 'variable', 'reward_weights.format')], 'format-zero 胜出\nlr-low 末窗越线');
  const vm = x.view('eval'), c = vm.cycle.compare, metric = (id) => c.metrics.find((m) => m.id === id), cell = (m, g) => metric(m).items.find((r) => r.id === g);
  assert.deepEqual(c.metrics.map((m) => [m.id, m.role]), [['accuracy', 'main'], ['signal', 'guard'], ['tail', 'guard'], ['format_rate', 'other'], ['wall', 'other']]);
  assert.deepEqual(metric('accuracy').items.map((r) => r.id), ['control', 'lr-low', 'format-zero']);
  assert.deepEqual([metric('accuracy').rule, metric('accuracy').ruleValue, metric('signal').limit, metric('signal').threshold], ['minDelta', 0.05, 'up', 0.3]);
  assert.deepEqual([c.seeds, c.single, c.result, c.group, c.version, c.lead], [2, false, 'candidate', 'format-zero', 'v1', '+0.1225']);
  const main = (g) => { const r = cell('accuracy', g); return [r.mean, r.sd, r.delta, r.better, r.standing]; };
  assert.deepEqual(main('control'), ['0.0775', '0.003536', null, '', '']);
  // lr-low improves most but crossed a guardrail, so it does not count; format-zero beats the control.
  assert.deepEqual(main('lr-low'), ['0.515', '0.007071', '+0.4375', 'better', 'guard']);
  assert.deepEqual(main('format-zero'), ['0.2', '0.01414', '+0.1225', 'better', 'beats']);
  assert.ok(c.metrics.slice(1).every((m) => m.items.every((r) => r.standing === '')));
  // Lower is better for the wall time; a worse secondary metric says so.
  assert.deepEqual([cell('wall', 'format-zero').delta, cell('wall', 'format-zero').better, cell('wall', 'lr-low').better, cell('format_rate', 'format-zero').better], ['-10', 'better', 'same', 'worse']);
  // Guardrails pass or fail per group and name the seeds that crossed; the per-seed values mark them.
  assert.deepEqual([cell('signal', 'control').guard, cell('signal', 'control').crossed, cell('signal', 'lr-low').guard, cell('tail', 'lr-low').crossed], ['fail', [23], 'pass', [11]]);
  assert.deepEqual(cell('signal', 'control').seeds, [{ seed: 11, value: '0.35', state: '' }, { seed: 23, value: '0.25', state: 'cross' }]);
  assert.equal(cell('format_rate', 'control').guard, '');
  // The stepper shows the difference of the group that beats the control.
  assert.equal(x.steps(vm).find((s) => s.k === 'eval').delta, '+0.1225');
  // The headline is said once: the prose is the rest of the findings. The conclusion's placeholder attribution is no attribution.
  assert.deepEqual([vm.cycle.report.headline, vm.cycle.body, vm.cycle.attribution], ['format-zero 胜出', 'lr-low 末窗越线', null]);
  // 采集 shows each run's main metric, 应用 object variables as JSON.
  assert.deepEqual([vm.cycle.main.name, vm.cycle.runs[0].value], ['holdout accuracy', '0.08']);
  assert.deepEqual(vm.cycle.groups.map((g) => g.varsText), ['', 'lr=0.00003', 'reward_weights={"correctness":1,"format":0}']);
});

test('a single seed is a single result without SD; a change that crossed a guardrail does not count, and a control that did not finish compares nothing', () => {
  const groups = GROUPS.slice(0, 2), values = { control: [VALUES.control[0]], 'lr-low': [VALUES['lr-low'][0]] };
  const x = arith({ seeds: [12], groups, values });
  x.conclude([option('lr', 'variable', 'lr')]);
  const vm = x.view('eval'), c = vm.cycle.compare, row = c.metrics[0].items[1];
  // The only change improves the main metric but does not count, so the stepper shows no difference.
  assert.deepEqual([c.single, c.seeds, c.result, c.lead, x.steps(vm).find((s) => s.k === 'eval').delta], [true, 1, 'none', null, null]);
  assert.ok(c.metrics.every((m) => m.items.every((r) => r.sd === null && r.n === 1 && !r.partial)));
  assert.deepEqual([row.mean, row.delta, row.standing, c.metrics.find((m) => m.id === 'tail').items[1].crossed], ['0.52', '+0.44', 'guard', [12]]);
  const y = arith({ seeds: [12], groups, values });
  Object.assign(y.d.rounds[0].runs[0], { state: 'failed', metrics: {}, error: { kind: 'env', raw: 'killed' } });
  y.conclude([option('lr', 'variable', 'lr')]);
  const d = y.view('eval').cycle.compare;
  assert.deepEqual([d.result, d.metrics[0].items[0].mean, d.metrics[0].items[0].seeds[0].state, d.metrics[0].items[1].standing, d.metrics[0].items[1].delta], ['incomparable', null, 'env', 'control', null]);
});

test('the discussion is its own stage, reachable while discussion members still propose; it groups directions by member, shows a member’s repeats once, names who did not propose and says where the 首选 differ', () => {
  const x = arith({ analysts: [['ev', '小狸'], ['a1', '甲'], ['a2', '乙'], ['a3', '丙']], values: SPLIT });
  const own = [option('tail-mean', 'metric', 'tail'), option('lr-5e-5', 'variable', 'lr')];
  x.conclude(own);
  x.propose('a1', [option('lr', 'variable', 'lr'), option('temperature', 'variable', 'temperature')]);
  // Still proposing: the page opens on this cycle's discussion, the stepper says how many proposed, and there is no decision yet.
  let vm = x.view();
  assert.deepEqual([vm.step, vm.next.k, vm.next.go.endsWith('/v1>c1.discuss')], ['discuss', 'analyzing', true]);
  assert.deepEqual(x.steps(vm).map((s) => s.k), ['apply', 'collect', 'eval', 'discuss', 'gov']);
  assert.deepEqual((({ result, done, asked, missing }) => ({ result, done, asked, missing }))(x.steps(vm).find((s) => s.k === 'discuss')), { result: 'proposing', done: 1, asked: 4, missing: 0 });
  assert.equal(x.steps(vm).find((s) => s.k === 'gov').result, 'waiting');
  assert.deepEqual([vm.cycle.discussion.waiting.map((m) => m.name), vm.cycle.gov.ask], [['小狸', '乙', '丙'], '']);
  // Nothing beats the control, so the stepper shows no difference.
  assert.equal(x.steps(vm).find((s) => s.k === 'eval').delta, null);
  // The evaluator, also a discussion member, proposes its own directions again; 丙 does not propose in time.
  x.propose('ev', own);
  x.propose('a2', [option('reward', 'code', 'reward.py')]);
  finishAnalysis(x.s, x.d, x.d.rounds[0], now);
  vm = x.view('discuss');
  const disc = vm.cycle.discussion;
  assert.equal(x.d.rounds[0].report.agree, false);
  assert.deepEqual([disc.status, disc.differ, disc.missing.map((m) => m.name), disc.done, disc.asked, disc.count], ['split', 'kind', ['丙'], 3, 4, 5]);
  assert.deepEqual(disc.members.map((m) => [m.id, m.name, m.role, m.items.map((d) => [d.title, d.first])]), [
    ['ev', '小狸', 'both', [['tail-mean', true], ['lr-5e-5', false]]], ['a1', '甲', 'analyze', [['lr', true], ['temperature', false]]], ['a2', '乙', 'analyze', [['reward', true]]]]);
  assert.deepEqual(disc.firsts.map((f) => [f.by, f.title, f.kind, f.target]), [['ev', 'tail-mean', 'metric', 'tail'], ['a1', 'lr', 'variable', 'lr'], ['a2', 'reward', 'code', 'reward.py']]);
  assert.deepEqual(x.steps(vm).slice(-2).map((s) => [s.k, s.result, s.missing]), [['discuss', 'split', 1], ['gov', 'pending', undefined]]);
  assert.deepEqual([vm.cycle.gov.ask, vm.cycle.gov.choices, vm.cycle.gov.discuss.endsWith('/v1>c1.discuss')], ['split', [{ k: 'same' }, { k: 'note' }], true]);
});

test('where agreeing 首选 still differ, and why 首选 without a target cannot agree, are told apart', () => {
  const discuss = (a1, a2) => {
    const x = arith({ analysts: [['a1', '甲'], ['a2', '乙']], values: SPLIT });
    x.conclude(); x.propose('a1', [a1]); x.propose('a2', [a2]);
    const { status, differ, kind, target } = x.view('discuss').cycle.discussion;
    return [x.d.rounds[0].report.agree, status, differ, kind, target];
  };
  assert.deepEqual(discuss(option('lr', 'variable', 'lr'), option('lr2', 'variable', 'lr')), [true, 'agree', 'same', 'variable', 'lr']);
  assert.deepEqual(discuss(option('lr', 'variable', 'lr', { lo: 0.1, hi: 0.2 }), option('lr2', 'variable', 'lr', { lo: 0.2, hi: 0.4 })), [true, 'agree', 'effect', 'variable', 'lr']);
  assert.deepEqual(discuss(option('lr', 'variable', 'lr'), option('t', 'variable', 'temperature')), [false, 'split', 'target', 'variable', 'lr']);
  assert.deepEqual(discuss(option('lr', 'variable', 'lr'), option('lr2', 'variable')), [false, 'split', 'untargeted', 'variable', 'lr']);
});

test('governance names what you decide and records what was chosen, by whom and what came of it', () => {
  // A candidate: the next cycle is its confirmation, and 今晚照旧 is the only choice.
  const w = arith();
  w.conclude([option('confirm', 'variable', 'reward_weights.format')]);
  const g = w.view('gov').cycle.gov;
  assert.deepEqual([g.ask, g.candidate, g.choices, g.current, g.iterate], ['confirm', { group: 'format-zero', version: 'v1' }, [{ k: 'same' }], 'v1', '砚砚']);
  // An adopted direction: who proposed it, and the version the governance member is asked for.
  const x = arith({ analysts: [['a1', '甲'], ['a2', '乙']], values: SPLIT });
  x.conclude(); x.propose('a1', [option('lr', 'variable', 'lr')]); x.propose('a2', [option('lr2', 'variable', 'lr')]);
  assert.equal(x.view('gov').cycle.gov.ask, 'agree');
  assert.deepEqual(act(x.s, { op: 'expDecide', objective: x.id, n: 1, pick: 'direction', directionId: 'lr2' }, { project: P }, now), { ok: true });
  let vm = x.view('gov');
  assert.deepEqual([vm.cycle.gov.ask, vm.cycle.gov.choices, vm.cycle.gov.adopted.title, vm.cycle.gov.adopted.by, vm.cycle.gov.led], ['', [], 'lr2', 'a2', { k: 'version', title: 'lr2' }]);
  assert.deepEqual([vm.cycle.decision.by, x.steps(vm).at(-1).result, vm.cycle.discussion.members[1].items[0].picked], ['你', 'variable', true]);
  // Once the next cycle runs, that is what the decision led to.
  delete x.d.versionRequest;
  x.d.rounds.push({ n: 2, version: 'v1', start: now, end: null, state: 'running', plan: { groups: [GROUPS[0]], seeds: [24, 25] }, runs: [], report: null, decision: null, events: [] });
  vm = x.view('gov');
  assert.deepEqual(vm.cycle.gov.led, { k: 'cycle', n: 2, version: 'v1', go: `${x.id}/v1>c2.collect` });
});

test('a discussion member who did not propose is named by the objective’s members in any role; one the objective no longer knows is left to the Host to name', () => {
  const x = arith({ analysts: [['a1', '甲'], ['it', '砚砚'], ['gone', '走了']], values: SPLIT });
  x.conclude(); x.propose('a1', [option('lr', 'variable', 'lr')]);
  finishAnalysis(x.s, x.d, x.d.rounds[0], now);
  // Both leave the discussion afterwards: 砚砚 is still the governance member, gone is no member at all.
  for (const catId of ['it', 'gone']) assert.equal(act(x.s, { op: 'analystRemove', objective: x.id, catId }, { project: P }, now).ok, true);
  assert.deepEqual(x.view('discuss').cycle.discussion.missing.map((m) => [m.kind, m.catId, m.name]), [['member', 'it', '砚砚'], ['member', 'gone', undefined]]);
});

test('a member’s repeated direction is shown once as the copy that says more, with the citations of both, and stays adopted when either copy was', () => {
  const x = arith({ analysts: [['ev', '小狸'], ['a1', '甲']], values: SPLIT });
  x.s.library[P].push(...['doc-a', 'doc-b'].map((id) => ({ id, kind: 'project', title: id, objectives: [], state: 'confirmed' })));
  x.conclude([{ ...option('a', 'variable', 'lr'), cites: ['doc-a'] }]);
  x.propose('ev', [{ ...option('a', 'variable', 'lr', { lo: 0.1, hi: 0.2 }), cites: ['doc-b'] }]);
  x.propose('a1', [option('b', 'code', 'reward.py')]);
  assert.deepEqual(act(x.s, { op: 'expDecide', objective: x.id, n: 1, pick: 'direction', directionId: 'a' }, { project: P }, now), { ok: true });
  const { members, firsts } = x.view('discuss').cycle.discussion, kept = members[0].items;
  assert.deepEqual(kept.map((d) => [d.id, d.cites, d.expect, d.first, d.picked]), [['a-ev', ['doc-a', 'doc-b'], 'accuracy +0.1 ~ +0.2', true, true]]);
  assert.equal(firsts[0], kept[0]);
});

test('an attribution is shown only when the evaluator assessed a layer; the demo’s are', () => {
  const fixture = createFixtures(now), state = fixture.state;
  state.experiments['cp-converge'] = fixture.templates['cp-converge'];
  state.objectives.cartpole.push({ id: 'cp-converge', name: '训练更快、更稳地收敛', parent: null, state: 'pending', mode: 'exp', trigger: '18:00–08:00', running: { o: 'v2' }, cycle: null, prediction: null, locked: 0 });
  const demo = viewModel(state, 'exp', { project: 'cartpole', selO: 'cp-converge/v2>c2.eval' }).cycle;
  // Unresolved, but after assessing every layer: that is an attribution.
  assert.deepEqual([demo.attribution.verdict, demo.attribution.assessedLayers.length, demo.attribution.competingLayers, demo.body], ['unresolved', 4, ['harness', 'observation'], demo.report.summary]);
  const x = arith();
  x.conclude([option('confirm', 'variable', 'reward_weights.format')]);
  assert.equal(x.d.rounds[0].report.attribution.verdict, 'unresolved');
  assert.equal(x.view('eval').cycle.attribution, null);
});

test('long objective statements render clipped display titles in sidebar and header while keeping the full statement in goal and prep', () => {
  const longStatement = '优化昇腾910B3上的bge-large-zh-v1.5服务，目标是在高并发下显著压低TTFT与P99延迟并维持召回和精度基线不退化，同时验证不同batch与并行策略在真实请求分布下的稳定性表现，记录每一轮对比结果与回滚边界，确保线上服务可用性不受影响。';
  const state = createFixtures(now).state;
  const project = '/work/bge-opt';
  state.projects.unshift({ id: project, name: 'bge-opt', projectPath: project, exp: true, hostKinds: ['mcp'] });
  state.objectives[project] = []; state.groups[project] = []; state.units[project] = []; state.library[project] = [];
  assert.equal(act(state, { op: 'new', statement: longStatement, projectPath: project, prepare: 'codex', evaluate: 'ev', cats: [{ id: 'codex', name: '砚砚' }, { id: 'ev', name: '小狸' }] }, { project }, now).ok, true);
  const obj = state.objectives[project][0];
  const d = state.experiments[obj.id];
  assert.ok(obj.name.length <= 48 && obj.name.endsWith('…'));
  assert.equal(d.objective.goal.statement, longStatement);
  assert.equal(d.prep.find((p) => p.id.endsWith('-goal')).value, longStatement);
  // Also clip legacy already-persisted objectives whose stored name was never shortened.
  obj.name = longStatement; d.objective.name = longStatement;
  const home = viewModel(state, 'home', { project, pick: `obj:${obj.id}` });
  const exp = viewModel(state, 'exp', { project, pick: `obj:${obj.id}` });
  assert.ok(home.nodes[''][0].name.length <= 48 && home.nodes[''][0].name.endsWith('…'));
  assert.ok(exp.name.length <= 64 && exp.name.endsWith('…'));
  assert.equal(exp.goal.statement, longStatement);
});

test('initialization prep steps expose DAG depKeys, 5 normalized stages, auto-focus error/pending steps, and switch cleanly via initStep', () => {
  const state = createFixtures(now).state;
  const project = '/work/bge-dag';
  state.projects.unshift({ id: project, name: 'bge-dag', projectPath: project, exp: true, hostKinds: ['mcp'] });
  state.objectives[project] = []; state.groups[project] = []; state.units[project] = []; state.library[project] = [];
  assert.equal(act(state, { op: 'new', statement: 'DAG test', projectPath: project, prepare: 'codex', evaluate: 'kimi', cats: [{ id: 'codex', name: '砚砚' }, { id: 'kimi', name: '小狸' }] }, { project }, now).ok, true);
  const id = state.objectives[project][0].id;
  const d = state.experiments[id];
  // Simulate step 1 (goal) aborted with missing, step 2 (scope) done, step 3 (run) running
  d.exec.goal = { id: 'ex-1', state: 'missing', by: 'kimi', base: {}, reason: '首轮未暴露 plugin_call' };
  delete d.exec.scope;
  d.steps.scope = { rev: 1, base: {}, stale: false, redo: false };
  d.exec.run = { id: 'ex-3', state: 'started', by: 'codex', base: {} };

  const exp = viewModel(state, 'exp', { project, pick: `obj:${id}` });
  const byK = Object.fromEntries(exp.prep.steps.map((s) => [s.k, s]));
  assert.deepEqual(byK.goal.depKeys, []);
  assert.deepEqual(byK.rules.depKeys, ['goal', 'scope']);
  assert.deepEqual(byK.design.depKeys, ['scope', 'run', 'rules']);
  assert.deepEqual([byK.goal.stage, byK.scope.stage, byK.run.stage, byK.rules.stage], ['error', 'done', 'running', 'waiting']);
  assert.equal(byK.goal.owner, '小狸');
  assert.equal(byK.goal.reason, '首轮未暴露 plugin_call');
  // Auto-focus prioritizes error step ('goal')
  assert.equal(exp.prep.activeKey, 'goal');
  assert.equal(byK.goal.selected, true);
  assert.equal(byK.goal.visible, true);
  assert.equal(byK.scope.visible, false);

  // Clicking another node selects it and shows only its detail
  const expRules = viewModel(state, 'exp', { project, pick: `obj:${id}`, initStep: 'rules' });
  assert.equal(expRules.prep.activeKey, 'rules');
  assert.equal(expRules.prep.steps.find((s) => s.k === 'rules').visible, true);
  assert.equal(expRules.prep.steps.find((s) => s.k === 'goal').visible, false);

  // Single-step focus always stays clean (no showAll dump), and terminal ready node merges all leaf steps
  const readyNode = expRules.prep.dagNodes.find((n) => n.k === 'ready');
  assert.equal(readyNode.terminal, true);
  assert.deepEqual(readyNode.depKeys, ['design', 'feedback', 'baseline']);
  assert.equal(readyNode.stage, 'waiting');
  const expReady = viewModel(state, 'exp', { project, pick: `obj:${id}`, initStep: 'ready' });
  assert.equal(expReady.prep.activeKey, 'ready');
  assert.equal(expReady.prep.ready.selected, true);
  assert.equal(expReady.prep.visibleSteps.length, 0);
  // Default top-level section is manage during setup, switchable to execute
  assert.equal(expReady.section, 'manage');
  assert.equal(viewModel(state, 'exp', { project, pick: `obj:${id}`, expSec: 'execute' }).section, 'execute');
});

test('dual-tab console supports inline role switching, step history snapshots, eval visual comparisons, and click-to-open governance file diffs', () => {
  const state = createFixtures(now).state;
  const project = '/work/bge-console';
  state.projects.unshift({ id: project, name: 'bge-console', projectPath: project, exp: true, hostKinds: ['mcp'] });
  state.objectives[project] = []; state.groups[project] = []; state.units[project] = []; state.library[project] = [];
  assert.equal(act(state, { op: 'new', statement: 'BGE rerank latency & quality', projectPath: project, prepare: 'codex', evaluate: 'kimi', cats: [{ id: 'codex', name: '砚砚' }, { id: 'kimi', name: '小狸' }, { id: 'gemini', name: '墨墨' }] }, { project }, now).ok, true);
  const id = state.objectives[project][0].id;
  const d = state.experiments[id];

  // Inline member switch by role updates immediately
  assert.equal(act(state, { op: 'members', objective: id, role: 'evaluate', v: 'gemini', cats: [{ id: 'gemini', name: '墨墨' }] }, { project }, now).ok, true);
  assert.equal(viewModel(state, 'exp', { project, pick: `obj:${id}` }).memberIds.evaluate, 'gemini');

  // Step history snapshots let users switch back to earlier revisions
  d.steps.scope = { rev: 2, base: {}, stale: false, redo: false, unknowns: 'v2 unknown', next: '' };
  d.stepHistory = {
    scope: [
      { rev: 1, at: now - 1000, by: 'codex', items: [{ id: 's1', section: 'scope', title: 'Old scope', value: 'v1 value', state: 'confirmed', neededFrom: null }], unknowns: 'v1 unknown', next: '' },
      { rev: 2, at: now, by: 'codex', items: [{ id: 's1', section: 'scope', title: 'New scope', value: 'v2 value', state: 'confirmed', neededFrom: null }], unknowns: 'v2 unknown', next: '' },
    ],
  };
  d.prep.push({ id: 's1', section: 'scope', title: 'New scope', value: 'v2 value', state: 'confirmed', neededFrom: null });
  const oldSnap = viewModel(state, 'exp', { project, pick: `obj:${id}`, initStep: 'scope', initRev: 'scope:1' });
  const scopeStep = oldSnap.prep.steps.find((s) => s.k === 'scope');
  assert.equal(scopeStep.hasHistory, true);
  assert.equal(scopeStep.viewingOld, true);
  assert.equal(scopeStep.items[0].value, 'v1 value');

  // Step refresh marks step stale+redo
  assert.equal(act(state, { op: 'initStepRefresh', k: 'scope' }, { project, pick: `obj:${id}` }, now).ok, true);
  const d2 = state.experiments[id];
  assert.equal(d2.steps.scope.stale, true);

  // Add a completed round with visual comparisons and governance file diffs
  d2.metrics = { version: 'E1', items: [{ id: 'qps', name: '有效 QPS', how: 'metrics.qps', dir: 'up', guard: false }] };
  const plan = { baseline: false, groups: [{ id: 'control', label: '对照', version: 'v1', vars: {}, control: true }], seeds: [1] };
  d2.rounds.push({
    n: 1, version: 'v1', start: now, end: now + 1000, state: 'evaluating', plan, metrics: structuredClone(d2.metrics),
    runs: [{ id: 'r1', group: 'control', seed: 1, state: 'done', metrics: { qps: 42 }, env: {} }],
    report: null, decision: null, events: [],
  });
  assert.equal(conclude(state, d2, {
    cycle: 1, verdict: 'tune', findings: 'QPS +15%',
    options: [{ k: 'batch', title: '增大 batch', why: '提升吞吐', kind: 'code' }],
    comparisons: [{
      id: 'cmp-img', title: '延迟分布对比', kind: 'chart',
      before: { label: '前一轮 v1', kind: 'image', src: '/img/v1.png' },
      after: { label: '本轮 v2', kind: 'image', src: '/img/v2.png' },
    }],
  }, now + 2000).ok, true);
  d2.rounds[0].govChanges = {
    pr: { id: '#42', title: 'Enable dynamic batching', url: 'https://example.com/pr/42' },
    items: [{ op: 'set', name: 'batch_size', from: '8', to: '32' }, { op: 'add', name: 'fp16_cache', to: 'true' }],
    files: [
      { path: 'src/rerank.py', op: 'modify', added: 12, removed: 3, hunks: [['@@ -10,3 +10,5 @@', [[' ', 'def run():'], ['-', '  bs = 8'], ['+', '  bs = 32']]]] },
      { path: 'config.yaml', op: 'modify', added: 1, removed: 1, hunks: [['@@ -1 +1 @@', [['-', 'bs: 8'], ['+', 'bs: 32']]]] },
    ],
  };

  // With rounds, default section switches to execute; comparisons & file list render; diff stays closed until a file is clicked
  const execVm = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v1>c1.eval` });
  assert.equal(execVm.section, 'execute');
  assert.equal(execVm.cycle.comparisons.length, 1);
  assert.equal(execVm.cycle.comparisons[0].before.isMedia, true);
  assert.equal(execVm.cycle.comparisons[0].after.src, '/img/v2.png');

  const govClosed = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v1>c1.gov` });
  assert.equal(govClosed.cycle.gov.pr.id, '#42');
  assert.equal(govClosed.cycle.gov.changeItems[0].detail, '8 → 32');
  assert.equal(govClosed.cycle.gov.diffFiles.length, 2);
  assert.equal(govClosed.cycle.gov.selectedFile, null);

  const govOpen = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v1>c1.gov`, govFile: 'src/rerank.py', govDiffMode: 'split' });
  assert.equal(govOpen.cycle.gov.selectedFile.path, 'src/rerank.py');
  assert.equal(govOpen.cycle.gov.diffMode, 'split');
  assert.equal(govOpen.cycle.gov.selectedFile.hunks.length, 1);

  // Separate analysis vs execution members + archived completed stage vs live upcoming stage
  assert.equal(act(state, { op: 'stepMember', objective: id, k: 'goal', v: 'codex', cats: [{ id: 'codex', name: '砚砚' }] }, { project }, now).ok, true);
  const afterStep = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v1>c1.eval` });
  assert.equal(afterStep.prep.steps.find((s) => s.k === 'goal').ownerCatId, 'codex');
  assert.equal(afterStep.prep.steps.find((s) => s.k === 'rules').ownerCatId, 'kimi');
  assert.equal(afterStep.memberIds.evaluate, 'gemini');
  assert.deepEqual(afterStep.execStages.map((s) => s.role), ['evaluate', 'iterate']);
  // Cycle 1 eval is already done -> archived executor stays 墨墨 even after execution evaluator changes to 宪宪
  assert.equal(afterStep.cycle.stageOwners.eval.archived, true);
  assert.equal(afterStep.cycle.stageOwners.eval.name, '墨墨');
  // Add an in-flight cycle 2 still running/collecting, then change execution evaluator to opus
  const d3 = state.experiments[id];
  d3.rounds.push({ n: 2, version: 'v1', start: now + 3000, end: null, state: 'running', plan, metrics: structuredClone(d3.metrics), runs: [], report: null, decision: null, events: [] });
  assert.equal(act(state, { op: 'members', objective: id, role: 'evaluate', v: 'opus', cats: [{ id: 'opus', name: '宪宪' }] }, { project }, now).ok, true);
  const c1After = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v1>c1.eval` });
  const c2After = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v1>c2.collect` });
  assert.equal(c1After.cycle.stageOwners.eval.name, '墨墨');
  assert.equal(c1After.cycle.stageOwners.eval.archived, true);
  assert.equal(c2After.cycle.stageOwners.eval.name, '宪宪');
  assert.equal(c2After.cycle.stageOwners.eval.archived, false);
  // Changing execution member did not overwrite step 1 analysis member
  assert.equal(c2After.prep.steps.find((s) => s.k === 'goal').ownerCatId, 'codex');

  // Every execution stage (evaluating / discussing / versionRequest) supports swap + re-trigger
  d3.rounds[1].state = 'evaluating';
  const c2Eval = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v1>c2.eval` });
  assert.equal(c2Eval.cycle.evaluating, true);
  assert.equal(act(state, { op: 'evalAgain' }, { project, pick: `obj:${id}` }, now).ok, true);
  d3.rounds[0].analysis = { waiting: ['kimi'], since: now };
  assert.equal(act(state, { op: 'analystAdd', catId: 'gemini', cats: [{ id: 'gemini', name: '墨墨' }] }, { project, pick: `obj:${id}` }, now).ok, true);
  assert.equal(d3.rounds[0].analysis.waiting.includes('gemini'), true);
  assert.equal(act(state, { op: 'discussAgain' }, { project, pick: `obj:${id}` }, now).ok, true);
  d3.versionRequest = { cycle: 1, title: '增大 batch', since: now };
  assert.equal(act(state, { op: 'versionAgain' }, { project, pick: `obj:${id}` }, now).ok, true);

  // Inline goal edit, single-cycle execution pipeline schematic, and direct policy dropdown ops
  assert.equal(act(state, { op: 'goalEdit', objective: id, v: '新目标：压缩单卡 P99 至 60ms' }, { project }, now).ok, true);
  assert.equal(act(state, { op: 'maxRuns', objective: id, v: '3' }, { project }, now).ok, true);
  assert.equal(act(state, { op: 'auto', objective: id, v: 'execution' }, { project }, now).ok, true);
  assert.equal(act(state, { op: 'repair', objective: id, v: '3' }, { project }, now).ok, true);
  assert.equal(act(state, { op: 'analystToggle', objective: id, v: 'codex', cats: [{ id: 'codex', name: '砚砚' }] }, { project }, now).ok, true);
  const finalVm = viewModel(state, 'exp', { project, pick: `obj:${id}`, execStage: 'discuss' });
  assert.equal(finalVm.goalQuote, '> 新目标：压缩单卡 P99 至 60ms');
  assert.equal(finalVm.policy.schedule.maxRunsValue, '3');
  assert.equal(finalVm.policy.autoKey, 'execution');
  assert.equal(finalVm.policy.repairValue, '3');
  assert.deepEqual(finalVm.execFlow.nodes.map((n) => n.k), ['apply', 'collect', 'evaluate', 'discuss', 'iterate']);
  assert.equal(finalVm.execFlow.rows.length, 1);
  assert.equal(finalVm.execFlow.rows[0].steps.length, 5);
  assert.equal(finalVm.execFlow.selected.isDiscuss, true);
  assert.equal(finalVm.execFlow.selected.discussionIds.includes('codex'), true);
  const scopeFinal = finalVm.prep.steps.find((s) => s.k === 'scope');
  assert.deepEqual(scopeFinal.unknownList, ['v2 unknown']);
});

test('repaired and repairing cycles expose governance step and repair decision without requiring an evaluation report', () => {
  const state = createFixtures(now).state;
  const project = '/tmp/repair-proj';
  state.projects.unshift({ id: project, name: 'RepairProj', projectPath: project, exp: true, hostKinds: ['mcp'] });
  state.objectives[project] = []; state.groups[project] = []; state.units[project] = []; state.library[project] = [];
  const created = act(state, { op: 'new', statement: '昇腾 BGE 吞吐优化', projectPath: project, prepare: 'codex', evaluate: 'kimi', iterate: 'codex', cats: [{ id: 'codex', name: '砚砚' }, { id: 'kimi', name: '小狸' }] }, { project }, now);
  assert.equal(created.ok, true);
  const id = state.objectives[project][0].id;
  const d = state.experiments[id];
  d.metrics = { version: 'E1', items: [{ id: 'qps', name: '有效 QPS', how: 'metrics.qps', dir: 'up', guard: false }] };
  d.versions.push({ id: 'v2', parent: 'v1', change: '修复 NPU 绑定逻辑', commit: 'e7408c5c', config: {}, at: now + 2000, current: true, status: 'confirmed', direct: true });
  d.versions[0].current = false;
  d.objective.currentVersion = 'v2';
  d.repairs = [{ at: now + 2000, cycle: 1, version: 'v2', signature: 'submit exited #: NPU # has not been claimed' }];
  d.rounds = [
    {
      n: 1, version: 'v1', start: now, end: now + 1000, state: 'repaired', repairedBy: 'v2',
      plan: { baseline: false, groups: [{ id: 'control', label: '对照', version: 'v1', vars: {}, control: true }], seeds: [1] },
      metrics: structuredClone(d.metrics),
      runs: [{ id: 'r1', group: 'control', seed: 1, state: 'failed', metrics: {}, env: {}, error: { kind: 'env', step: 'submit', raw: 'submit exited 1: NPU 4 has not been claimed' } }],
      report: null, decision: null, events: [],
    },
    {
      n: 2, version: 'v2', start: now + 3000, end: now + 4000, state: 'repairing',
      plan: { baseline: false, groups: [{ id: 'control', label: '对照', version: 'v2', vars: {}, control: true }], seeds: [2] },
      metrics: structuredClone(d.metrics),
      runs: [{ id: 'r2', group: 'control', seed: 2, state: 'failed', metrics: {}, env: {}, error: { kind: 'env', step: 'submit', raw: 'submit exited 1: NPU 4 has not been claimed' } }],
      report: null, decision: null, events: [],
    },
  ];
  d.versionRequest = { cycle: 2, title: '修第 2 周期的运行失败', direct: true, since: now + 4000, decision: null, repair: { signature: 'submit exited #: NPU # has not been claimed' } };

  const v1Gov = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v1>c1.gov` });
  const v1Row = v1Gov.versions.find((v) => v.id === 'v1');
  const v2Row = v1Gov.versions.find((v) => v.id === 'v2');
  assert.deepEqual(v1Row.steps.map((s) => [s.k, s.result]), [['apply', 'failed'], ['collect', undefined], ['eval', 'skipped'], ['gov', 'execution']]);
  assert.deepEqual(v2Row.steps.map((s) => [s.k, s.result]), [['apply', 'failed'], ['collect', undefined], ['eval', 'skipped'], ['gov', 'repairing']]);
  assert.equal(v1Gov.cycle.decision.pick, 'repair');
  assert.match(v1Gov.cycle.decision.note, /v1 版本运行失败.*修复为 v2：修复 NPU 绑定逻辑/);
  assert.equal(v1Gov.cycle.gov.led.k, 'cycle');
  assert.equal(v1Gov.cycle.gov.led.version, 'v2');

  const v1Eval = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v1>c1.eval` });
  assert.equal(v1Eval.cycle.evalState, 'skipped');
  assert.equal(v1Eval.cycle.evalMetrics.version, 'E1');
  assert.equal(v1Eval.cycle.evalMetrics.items[0].id, 'qps');

  const v2Gov = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v2>c1.gov` });
  assert.equal(v2Gov.cycle.decision.pick, 'repairing');
  assert.equal(v2Gov.cycle.gov.led.k, 'version');
  assert.equal(v2Gov.cycle.gov.led.title, '修第 2 周期的运行失败');

  // A running cycle still renders its complete pipeline with waiting future steps, while focusing collect
  d.rounds[1].state = 'running';
  d.rounds[1].runs[0].state = 'running';
  delete d.versionRequest;
  const runningVm = viewModel(state, 'exp', { project, pick: `obj:${id}` });
  const runningRow = runningVm.versions.find((v) => v.id === 'v2');
  assert.equal(runningVm.step, 'collect');
  assert.deepEqual(runningRow.steps.map((s) => [s.k, s.result]), [['apply', 'failed'], ['collect', undefined], ['eval', 'waiting'], ['gov', 'waiting']]);
});
