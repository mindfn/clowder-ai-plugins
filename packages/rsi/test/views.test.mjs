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
  groups = structuredClone(groups);
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
  assert.deepEqual(v1Row.steps.map((s) => [s.k, s.result]), [['apply', 'failed'], ['collect', undefined], ['eval', 'skipped'], ['discuss', 'skipped'], ['gov', 'execution']]);
  assert.deepEqual(v2Row.steps.map((s) => [s.k, s.result]), [['apply', 'failed'], ['collect', undefined], ['eval', 'skipped'], ['discuss', 'skipped'], ['gov', 'repairing']]);
  assert.equal(v1Gov.cycle.decision.pick, 'repair');
  assert.match(v1Gov.cycle.decision.note, /v1 版本运行失败.*修复为 v2：修复 NPU 绑定逻辑/);
  assert.equal(v1Gov.cycle.gov.led.k, 'cycle');
  assert.equal(v1Gov.cycle.gov.led.version, 'v2');
  assert.equal(v1Gov.cycle.stage.canEdit, false);
  assert.equal(v1Gov.cycle.stage.ownerNames, '砚砚');

  const v1Eval = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v1>c1.eval` });
  assert.equal(v1Eval.cycle.evalState, 'skipped');
  assert.equal(v1Eval.cycle.evalMetrics.version, 'E1');
  assert.equal(v1Eval.cycle.evalMetrics.items[0].id, 'qps');
  assert.equal(v1Eval.cycle.stage.ownerNames, '小狸');
  assert.equal(v1Eval.cycle.stage.canEdit, false);

  const v2Gov = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v2>c1.gov` });
  assert.equal(v2Gov.cycle.decision.pick, 'repairing');
  assert.equal(v2Gov.cycle.gov.led.k, 'version');
  assert.equal(v2Gov.cycle.gov.led.title, '修第 2 周期的运行失败');
  assert.equal(v2Gov.cycle.stage.canEdit, true);
  assert.equal(v2Gov.cycle.stage.role, 'iterate');
  assert.equal(v2Gov.cycle.stage.value, 'codex');

  // Latest cycle discuss stage is always visible (skipped when empty) and editable inline to add members
  const v2Disc = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v2>c1.discuss` });
  assert.equal(v2Disc.cycle.stage.canEdit, true);
  assert.equal(v2Disc.cycle.stage.multi, true);
  assert.equal(v2Disc.cycle.stage.state, 'skipped');
  assert.deepEqual(v2Disc.cycle.stage.values, []);

  // Latest cycle apply stage echoes prepare owner and allows inline edit; collect has no owner stage
  const v2Apply = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v2>c1.apply` });
  assert.equal(v2Apply.cycle.stage.canEdit, true);
  assert.equal(v2Apply.cycle.stage.role, 'prepare');
  assert.equal(v2Apply.cycle.stage.value, 'codex');

  // A running cycle still renders its complete pipeline with waiting future steps, while focusing collect
  d.rounds[1].state = 'running';
  d.rounds[1].runs[0].state = 'running';
  delete d.versionRequest;
  const runningVm = viewModel(state, 'exp', { project, pick: `obj:${id}` });
  const runningRow = runningVm.versions.find((v) => v.id === 'v2');
  assert.equal(runningVm.step, 'collect');
  assert.equal(runningVm.cycle.stage, null);
  assert.deepEqual(runningRow.steps.map((s) => [s.k, s.result]), [['apply', 'failed'], ['collect', undefined], ['eval', 'waiting'], ['discuss', 'skipped'], ['gov', 'waiting']]);
});

test('rsiLineage auto-folds older linear chains into expandable [v1~vN] bundles while keeping latest 5 and branches open', async () => {
  const vm = await import('node:vm');
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../console/components/lineage.js', import.meta.url), 'utf8');
  const sandbox = {
    PDL_COMPONENTS: {},
    S: { folds: {} },
    h: (s) => String(s ?? ''),
    pv: (expr, sc) => typeof expr === 'string' && expr.startsWith('@') ? sc?.[expr.slice(1)] : expr,
    pvList: (v) => Array.isArray(v) ? v : [],
    pvParts: (v, sc) => Array.isArray(v) ? v.map((x) => typeof x.text === 'string' && x.text.startsWith('@') ? sc?.[x.text.slice(1)] : x.text).join('') : String(v ?? ''),
    pvArgs: () => '',
    pvControl: () => '',
    pvText: (v) => String(v ?? ''),
    chipHtml: (o) => `<button class="${o.cls}">${o.label}</button>`,
  };
  vm.runInNewContext(src, sandbox);
  const render = sandbox.PDL_COMPONENTS['plugin:official.rsi/rsiLineage'];

  // 17 nodes: v1->v2->v3->v4->v5->v6->(v7, v8->v9->v10->v11->v12->v13->v14->v15->v16->v17)
  const rows = [];
  for (let i = 1; i <= 6; i++) rows.push({ key: `v${i}`, parentKey: i === 1 ? null : `v${i - 1}`, id: `v${i}` });
  rows.push({ key: 'v7', parentKey: 'v6', id: 'v7' });
  rows.push({ key: 'v8', parentKey: 'v6', id: 'v8' });
  for (let i = 9; i <= 17; i++) rows.push({ key: `v${i}`, parentKey: `v${i - 1}`, id: `v${i}`, nodeState: i === 17 ? 'current' : undefined });

  const props = { from: rows, key: '@key', parent: '@parentKey', node: { label: [{ text: '@id' }], state: '@nodeState' } };
  const collapsed = render(props, {}, {});
  // Linear head v1..v5 folds into container-wrapped [v1~v5] at depth 0, so v6 sits directly below at depth 0 with zero extra horizontal indent
  assert.match(collapsed, /rsi-lin-grp-box/);
  assert.match(collapsed, /\[v1~v5\]/);
  assert.doesNotMatch(collapsed, />v2</);
  assert.match(collapsed, /style="--d:0"[^>]*>.*>v6</);
  // Branches v7 and v8 indent once to depth 1, while linear chain under v8 stays at depth 1 (no staircase drift)
  assert.match(collapsed, /\[v9~v12\]/);
  assert.match(collapsed, /style="--d:1"[^>]*>.*>v7</);
  assert.match(collapsed, /style="--d:1"[^>]*>.*>v13</);
  assert.match(collapsed, /style="--d:1"[^>]*>.*>v17</);

  // Expanding [v1~v5] reveals v1..v5 inside the container with a collapse handle, keeping v6 unshifted at depth 0
  sandbox.S.folds['rsi-lin-grp:v1..v5'] = true;
  const expanded = render(props, {}, {});
  assert.match(expanded, /− v1~v5/);
  assert.match(expanded, />v1</);
  assert.match(expanded, />v5</);
  assert.match(expanded, /style="--d:0"[^>]*>.*>v6</);
});

test('console UX upgrades: no false red dot on finite metric, version.config merged in groups, running nodeState, resolved discuss, multi-metric trend, compareMatrix & historical re-eval', async () => {
  const x = arith({ analysts: [['a1', '甲'], ['a2', '乙']], values: SPLIT });
  x.d.versions[0].config = { route: 'replicas', document_token_cache: false };
  x.d.versions.push({ id: 'v2', parent: 'v1', change: 'preserved groups route', commit: 'fdf684b1234', config: { route: 'preserved_groups', document_token_cache: false }, at: now, current: false, status: 'proposed' });
  x.d.versions.push({ id: 'v3', parent: 'v2', change: 'online planning fix', commit: 'e8a73271234', config: { route: 'preserved_groups', online_plan: true }, at: now + 500, current: false, status: 'proposed' });
  x.d.executor = { mcp: 'rsi.executor', state: 'passed', commands: { submit: 'python3 run.py --config {config} --run {run} --seed {seed}' } };
  // Give control run[0] a non-fatal run-level warning (missing unrelated metric) while accuracy/signal have finite values
  x.d.rounds[0].runs[0].error = { kind: 'real', step: 'collect', raw: 'missing unrelated metric' };
  x.d.rounds[0].plan.groups[1].version = 'v2';
  x.d.rounds[0].plan.groups[1].vars = {};
  x.conclude();
  x.propose('a1', [option('dir1', 'variable', 'lr')]);
  x.propose('a2', [option('dir2', 'code', 'router.py')]);
  assert.equal(act(x.s, { op: 'expDecide', objective: x.id, n: 1, pick: 'direction', directionId: 'dir2' }, { project: P }, now).ok, true);

  // Add a live running round on v3 to verify running nodeState
  x.d.rounds.push({ n: 2, version: 'v3', start: now + 1000, end: null, state: 'running', plan: { groups: [GROUPS[0], { ...GROUPS[1], version: 'v3', vars: {} }], seeds: [31] },
    runs: [{ id: 'r-live-1', group: 'control', seed: 31, state: 'running', start: now + 1000, end: null, metrics: {}, env: {} }], report: null, decision: null, events: [] });

  const vm = viewModel(x.s, 'exp', { project: P, pick: `obj:${x.id}`, selO: `${x.id}/v2>c1.eval` });
  // 1. Finite metric on done seed must NOT be flagged red 'failed' despite run-level collect warning
  const ctrlAcc = vm.cycle.compare.metrics.find((m) => m.id === 'accuracy').items.find((g) => g.control);
  assert.equal(ctrlAcc.seeds[0].value, '0.08');
  assert.equal(ctrlAcc.seeds[0].state, '');
  // 2. Lineage v3 shows nodeState='running' while v1 stays 'current'; decided split discussion carries resolved=true
  assert.equal(vm.versions.find((v) => v.id === 'v1').nodeState, 'current');
  assert.equal(vm.versions.find((v) => v.id === 'v3').nodeState, 'running');
  const v2DiscStep = vm.versions.find((v) => v.id === 'v2').steps.find((s) => s.k === 'discuss');
  assert.equal(v2DiscStep.result, 'split');
  assert.equal(v2DiscStep.resolved, true);
  assert.equal(vm.cycle.discussion.resolved, true);
  // 3. groupsOf merges version.config and computes diff vs control + command preview
  const candGroup = vm.cycle.groups.find((g) => g.version === 'v2');
  assert.match(candGroup.configSummary, /route=replicas → preserved_groups/);
  assert.match(candGroup.sampleCommand, /python3 run\.py --config .* --seed 11/);
  assert.equal(candGroup.runs[0].roundNo, 1);
  // 4. Multi-metric trendSeries & query.trendMetric switching
  assert.ok(vm.trendSeries.length >= 4);
  const vmWall = viewModel(x.s, 'exp', { project: P, pick: `obj:${x.id}`, selO: `${x.id}/v2>c1.eval`, trendMetric: 'wall' });
  assert.equal(vmWall.activeTrendId, 'wall');
  assert.equal(vmWall.activeTrend.name, 'wall_time_s');
  // 5. Ready overview cards aggregated from d.prep
  assert.ok(Array.isArray(vm.prep.ready.overview) && vm.prep.ready.overview.length >= 2);
  // 6. rsiCompareMatrix & rsiTrend render cleanly
  const vmMod = await import('node:vm');
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../console/components/lineage.js', import.meta.url), 'utf8');
  const sandbox = {
    PDL_COMPONENTS: {},
    S: { folds: {} },
    h: (s) => String(s ?? ''),
    pv: (expr, sc) => expr === '$.table' ? vm.cycle.compare.table : expr === '$.trend' ? vm.activeTrend : expr,
    pvList: (v) => Array.isArray(v) ? v : [],
    pvText: (v) => String(v ?? ''),
  };
  vmMod.runInNewContext(src, sandbox);
  const mxHtml = sandbox.PDL_COMPONENTS['plugin:official.rsi/rsiCompareMatrix']({ from: '$.table' }, {}, {});
  assert.match(mxHtml, /主指标/);
  assert.match(mxHtml, /未通过护栏/);
  assert.match(mxHtml, /holdout accuracy/);
  // Expanding a metric row in cycle mode renders inline aligned rsi-mx-seed-row rows sharing main columns
  const mainMetric = vm.cycle.compare.table.sections[0].rows[0];
  sandbox.S.folds['rsi-cmp-row:' + vm.cycle.compare.table.cycleLabel + ':' + mainMetric.id] = true;
  const mxExpandedHtml = sandbox.PDL_COMPONENTS['plugin:official.rsi/rsiCompareMatrix']({ from: '$.table' }, {}, {});
  assert.match(mxExpandedHtml, /class="rsi-mx-seed-row"/);
  assert.doesNotMatch(mxExpandedHtml, /class="rsi-mx-sub"/);
  const trHtml = sandbox.PDL_COMPONENTS['plugin:official.rsi/rsiTrend']({ series: '$.trend', label: '趋势' }, {}, {});
  assert.match(trHtml, /rsi-trend-wrap/);
  assert.match(trHtml, /v2-1/);
  // 7. Historical re-eval updates report without clobbering decision or live round
  assert.equal(act(x.s, { op: 'evalAgain', objective: x.id, n: 1 }, { project: P }, now).ok, true);
  assert.equal(x.d.rounds[0].state, 'evaluating');
  assert.equal(x.d.rounds[0].reevaluating, true);
  const reRes = conclude(x.s, x.d, { cycle: 1, verdict: 'keep', findings: '重评结论\n细节' }, now + 5000);
  assert.equal(reRes.ok, true);
  assert.equal(reRes.reevaluated, true);
  assert.equal(x.d.rounds[0].report.headline, '重评结论');
  assert.equal(x.d.rounds[0].decision.directionId, 'dir2');
  assert.equal(x.d.rounds[1].state, 'running');
});

test('universal explore/confirm tier supports single-group explore without outer control while preserving confirmSeeds and full control on confirm', async () => {
  const { runCycle } = await import('../dist/cycles.js');
  const { toolAction } = await import('../dist/tools.js');
  const x = arith();
  // Set up 3-seed baseline and mark objective ready to run next version
  x.d.objective.thread = 't-tier';
  x.d.executor = { mcp: 'rsi.executor', state: 'passed', commands: { preflight: 'true', submit: 'true', collect: 'true' } };
  x.d.prep.forEach((p) => { p.state = 'confirmed'; });
  x.d.steps = Object.fromEntries(x.d.plan.map((p) => [p.k, { rev: 1 }]));
  x.d.exec = {};
  x.d.rounds[0].plan.seeds = [11, 23, 37];
  x.d.policy.confirmSeeds = 3;
  x.d.rounds[0].state = 'done';
  x.d.rounds[0].report = { verdict: 'tune', headline: 'h', summary: 'h', matrix: [], directions: [], compare: { comparable: true, groups: [] }, predictions: [], attribution: { assessedLayers: [] } };
  x.d.rounds[0].decision = { pick: 'direction', directionId: 'd1', by: '你', at: now };
  x.d.versionRequest = { cycle: 1, title: 'try explore', since: now, invocationId: 'inv-1' };
  const ctx = { catId: 'it', threadId: 't-tier', userId: 'u', invocationId: 'inv-1' };

  // skipControl rejected when tier !== 'explore'
  const bad = toolAction(x.s, 'rsi.version', { change: 'bad', config: { a: 1 }, skipControl: true }, ctx, now);
  assert.match(bad.error, /skipControl is only allowed when tier is "explore"/);

  // reservedSeeds fail-closed negative cases with zero dirty mutation to d.versions
  const vCountBefore = x.d.versions.length;
  const badConfirmReserved = toolAction(x.s, 'rsi.version', { change: 'confirm reserved', config: { a: 2 }, tier: 'confirm', reservedSeeds: [45] }, ctx, now);
  assert.match(badConfirmReserved.error, /reservedSeeds is only allowed when tier is "explore"/);
  assert.equal(x.d.versions.length, vCountBefore);
  const badDefaultReserved = toolAction(x.s, 'rsi.version', { change: 'default reserved', config: { a: 2 }, reservedSeeds: [45] }, ctx, now);
  assert.match(badDefaultReserved.error, /reservedSeeds is only allowed when tier is "explore"/);
  assert.equal(x.d.versions.length, vCountBefore);
  const dupHist = toolAction(x.s, 'rsi.version', { change: 'dup hist', config: { a: 2 }, tier: 'explore', seeds: 1, reservedSeeds: [11], skipControl: true }, ctx, now);
  assert.match(dupHist.error, /overlaps previously used seeds: 11/);
  assert.equal(x.d.versions.length, vCountBefore);
  const dupSched = toolAction(x.s, 'rsi.version', { change: 'dup sched', config: { a: 2 }, tier: 'explore', seeds: 1, reservedSeeds: [38], skipControl: true }, ctx, now);
  assert.match(dupSched.error, /must not overlap scheduled seeds: 38/);
  assert.equal(x.d.versions.length, vCountBefore);
  const dupSelf = toolAction(x.s, 'rsi.version', { change: 'dup self', config: { a: 2 }, tier: 'explore', seeds: 1, reservedSeeds: [39, 39], skipControl: true }, ctx, now);
  assert.match(dupSelf.error, /must not contain duplicate seeds/);
  assert.equal(x.d.versions.length, vCountBefore);

  // Valid explore tier (Option A semantics): scheduled seeds=[38] + extra reservedSeeds=[39], skip outer control
  const okExplore = toolAction(x.s, 'rsi.version', { change: 'fast explore', config: { a: 2 }, tier: 'explore', seeds: 1, reservedSeeds: [39], skipControl: true }, ctx, now);
  assert.equal(okExplore.ok, true);
  assert.equal(x.d.upcoming.tier, 'explore');
  assert.equal(x.d.upcoming.skipControl, true);
  assert.deepEqual(x.d.upcoming.seeds, [38]);
  assert.deepEqual(x.d.upcoming.reservedSeeds, [39]);
  assert.deepEqual(x.d.upcoming.groups.map((g) => g.id), ['change']);

  // runCycle respects skipControl on explore tier (does not prepend control)
  const started = runCycle(x.s, x.d, now + 100);
  assert.equal(started.ok, true);
  const r2 = x.d.rounds[1];
  assert.equal(r2.plan.tier, 'explore');
  assert.deepEqual(r2.plan.groups.map((g) => g.id), ['change']);
  assert.equal(r2.runs.length, 1);

  // Conclude single-group explore round: comparable=false -> cannot auto-promote candidate, strips reservedSeeds from upcoming, and rsiCompareMatrix renders '探索' cleanly
  Object.assign(r2.runs[0], { state: 'done', metrics: Object.fromEntries(METRICS.map((m, k) => [m.id, VALUES['format-zero'][0][k]])) });
  r2.state = 'evaluating';
  const c2 = conclude(x.s, x.d, { cycle: 2, verdict: 'tune', findings: 'explore ok', options: [option('c', 'variable', 'a')] }, now + 200);
  assert.equal(c2.ok, true);
  assert.equal(c2.confirmation, null);
  assert.equal(x.d.candidate, undefined);
  assert.equal(x.d.upcoming.reservedSeeds, undefined);
  const vm2 = viewModel(x.s, 'exp', { project: P, pick: `obj:${x.id}`, selO: `${x.id}/v2>c1.eval` });
  assert.equal(vm2.cycle.compare.table.tier, 'explore');
  assert.equal(vm2.cycle.compare.table.controlGroup, null);
  const vmMod = await import('node:vm');
  const src = readFileSync(new URL('../console/components/lineage.js', import.meta.url), 'utf8');
  const sb = { PDL_COMPONENTS: {}, S: { folds: {} }, h: (s) => String(s ?? ''), pv: (e) => e === '$.t' ? vm2.cycle.compare.table : e, pvList: () => [], pvText: (v) => String(v ?? '') };
  vmMod.runInNewContext(src, sb);
  const html = sb.PDL_COMPONENTS['plugin:official.rsi/rsiCompareMatrix']({ from: '$.t' }, {}, {});
  assert.match(html, /探索快筛/);
  assert.match(html, /探索 <span class="rsi-mx-ver">v2<\/span>/);
  assert.doesNotMatch(html, /Δ 变化/);

  // Reusing a historical reservedSeed (39) in a later round is rejected fail-closed
  x.d.versionRequest = { cycle: 2, title: 'reuse reserved', since: now + 240, invocationId: 'inv-1a' };
  const dupHistReserved = toolAction(x.s, 'rsi.version', { change: 'reuse 39', config: { a: 2 }, tier: 'explore', seeds: 1, reservedSeeds: [39], skipControl: true }, { ...ctx, invocationId: 'inv-1a' }, now + 240);
  assert.match(dupHistReserved.error, /overlaps previously used seeds: 39/);

  // Default rsi_version (omitting tier/seeds/reservedSeeds) after an explore cycle resets tier, drops reservedSeeds & restores confirmSeeds (3) skipping both 38 and 39
  x.d.versionRequest = { cycle: 2, title: 'default after explore', since: now + 250, invocationId: 'inv-1b' };
  const okDefault = toolAction(x.s, 'rsi.version', { change: 'standard version', config: { a: 2 } }, { ...ctx, invocationId: 'inv-1b' }, now + 250);
  assert.equal(okDefault.ok, true);
  assert.equal(x.d.upcoming.tier, undefined);
  assert.equal(x.d.upcoming.reservedSeeds, undefined);
  assert.equal(x.d.upcoming.skipControl, false);
  assert.equal(x.d.upcoming.seeds.length, 3);
  assert.deepEqual(x.d.upcoming.seeds, [40, 41, 42]);
  assert.deepEqual(x.d.upcoming.groups.map((g) => g.id), ['control', 'change']);

  // runCycle defense-in-depth rejects non-explore reservedSeeds and stale/overlapping reservedSeeds in upcoming
  x.d.rounds[1].decision = { pick: 'direction', directionId: 'c', by: '你', at: now + 260 };
  x.d.upcoming.reservedSeeds = [45];
  const badRunTier = runCycle(x.s, x.d, now + 261);
  assert.match(badRunTier.error, /reservedSeeds is only allowed when tier is "explore"/);
  x.d.upcoming.tier = 'explore';
  x.d.upcoming.reservedSeeds = [40];
  const badRun = runCycle(x.s, x.d, now + 262);
  assert.match(badRun.error, /must not overlap scheduled seeds: 40/);
  delete x.d.upcoming.tier;
  delete x.d.upcoming.reservedSeeds;

  // Even an explore cycle WITH outer control (skipControl: false) cannot set candidate or trigger target stop
  x.d.objective.stop = { target: 'accuracy >= 0.8' };
  x.d.versionRequest = { cycle: 2, title: 'explore with control', since: now + 265, invocationId: 'inv-1c' };
  assert.equal(toolAction(x.s, 'rsi.version', { change: 'explore with control', config: { a: 3 }, tier: 'explore', seeds: 1, skipControl: false }, { ...ctx, invocationId: 'inv-1c' }, now + 265).ok, true);
  assert.equal(runCycle(x.s, x.d, now + 270).ok, true);
  const r3 = x.d.rounds[2];
  assert.deepEqual(r3.plan.groups.map((g) => g.id), ['control', 'change']);
  Object.assign(r3.runs[0], { state: 'done', metrics: { accuracy: 0.70, format: 1, latency: 0.2 } });
  Object.assign(r3.runs[1], { state: 'done', metrics: { accuracy: 0.95, format: 1, latency: 0.2 } });
  r3.state = 'evaluating';
  const c3 = conclude(x.s, x.d, { cycle: 3, verdict: 'keep', findings: 'explore beat control', options: [{ ...option('d', 'variable', 'a'), cites: [`${x.id}-cycle-2`] }] }, now + 280);
  assert.equal(c3.ok, true);
  assert.equal(c3.confirmation, null);
  assert.equal(x.d.candidate, undefined);
  assert.equal(c3.stop, null);
  assert.notEqual(x.d.objective.state, 'done');

  // Confirm tier restores outer control + full confirmSeeds (3) and never inherits reservedSeeds
  x.d.versionRequest = { cycle: 3, title: 'confirm v4', since: now + 300, invocationId: 'inv-2' };
  const okConfirm = toolAction(x.s, 'rsi.version', { change: 'confirm candidate', config: { a: 3 }, tier: 'confirm' }, { ...ctx, invocationId: 'inv-2' }, now + 300);
  assert.equal(okConfirm.ok, true);
  assert.equal(x.d.upcoming.tier, 'confirm');
  assert.equal(x.d.upcoming.reservedSeeds, undefined);
  assert.equal(x.d.upcoming.skipControl, false);
  assert.equal(x.d.upcoming.seeds.length, 3);
  assert.deepEqual(x.d.upcoming.seeds, [41, 42, 43]);
  assert.deepEqual(x.d.upcoming.groups.map((g) => g.id), ['control', 'change']);
});

test('overview lineage map, honest pruned/neutral states, explicit aspects, hot-reload listener safety, i18n labels and slim payload', async () => {
  const { toolAction } = await import('../dist/tools.js');
  const x = arith({ analysts: [['a1', '甲'], ['a2', '乙']], values: SPLIT });
  x.d.objective.thread = 't-ov';
  // v1: root baseline (current=false once v2 is confirmed current, never pruned); v2: confirmed historical default (never pruned);
  // v3: rollback after immediately preceding execution direction -> pruned + observability;
  // v4: insufficient explore -> neutral 'insufficient', NOT pruned;
  // v5: repaired cycle -> neutral 'repaired', NOT pruned;
  // v6: status='rejected' -> pruned;
  // v7: comparable control eligible && !beatsControl -> pruned;
  // v8: unlabeled code version -> aspectKind='unlabeled', aspects=[] (NO false 'object' default);
  // v9: declared aspects via rsi_version -> aspectKind='declared', aspects=['object','rubric']
  x.d.versions[0].commit = '1111111aaaa';
  x.d.versions[0].current = false;
  x.d.versions.push(
    { id: 'v2', parent: 'v1', change: 'confirmed historical default', commit: '2222222bbbb', at: now + 100, current: false, status: 'confirmed' },
    { id: 'v3', parent: 'v1', change: 'probe schema rollback', commit: '3333333cccc', at: now + 200, current: false, status: 'proposed' },
    { id: 'v4', parent: 'v1', change: 'missing field registration', commit: '4444444dddd', at: now + 300, current: false, status: 'proposed' },
    { id: 'v5', parent: 'v1', change: 'broken runner superseded', commit: '5555555eeee', at: now + 400, current: false, status: 'proposed' },
    { id: 'v6', parent: 'v1', change: 'rejected on fresh seeds', commit: '6666666ffff', at: now + 500, current: false, status: 'rejected' },
    { id: 'v7', parent: 'v1', change: 'lost to control', commit: '77777770000', at: now + 600, current: false, status: 'proposed' },
    { id: 'v8', parent: 'v1', change: 'unlabeled explore tune', commit: '88888881111', at: now + 700, current: false, status: 'proposed' },
  );
  x.d.versions[0].current = true;
  x.d.rounds[0].plan.groups[1].version = 'v2';
  const longBody = 'Headline\n' + 'Detailed evaluation audit paragraph. '.repeat(25);
  x.d.rounds[0].state = 'evaluating';
  conclude(x.s, x.d, { cycle: 1, verdict: 'tune', findings: longBody, options: [option('d-exec', 'execution', 'probe.py')] }, now + 120);
  x.d.rounds[0].decision = { pick: 'direction', directionId: 'd-exec', by: '墨墨', at: now + 130 };
  // Cycle 2 on v3: rollback (immediately follows execution decision -> observability + pruned)
  x.d.rounds.push({
    n: 2, version: 'v3', start: now + 200, end: now + 250, state: 'done',
    plan: { tier: 'explore', skipControl: true, seeds: [31], reservedSeeds: [32], groups: [{ id: 'change', label: 'v3 explore', version: 'v3', vars: {}, control: false }] },
    runs: [{ id: 'r-v3-1', group: 'change', seed: 31, state: 'done', jobId: 'job-v3', start: now + 200, end: now + 240, metrics: { accuracy: 0.41, format: 1, latency: 0.3 }, env: { commit: '3333333cccc' } }],
    report: {
      verdict: 'rollback', headline: 'v3 regressed', summary: 'v3 regressed\nShort note',
      matrix: [{ group: 'change', metric: 'accuracy', mean: 0.41, sd: null, n: 1, seeds: [{ seed: 31, value: 0.41, state: 'done' }] }],
      directions: [option('d-code', 'code', 'serve.py')], compare: { comparable: false, groups: [{ group: 'change', eligible: false, beatsControl: false, guardrails: [] }] },
      predictions: [], attribution: { assessedLayers: [] },
    },
    decision: { pick: 'direction', directionId: 'd-code', by: '墨墨', at: now + 260 }, events: [],
  });
  // Cycle 3 on v4: insufficient (must NOT be pruned even if comparable && !beatsControl)
  x.d.rounds.push({
    n: 3, version: 'v4', start: now + 300, end: now + 340, state: 'done',
    plan: { tier: 'confirm', skipControl: false, seeds: [33], groups: [{ id: 'control', label: 'v1', version: 'v1', vars: {}, control: true }, { id: 'change', label: 'v4', version: 'v4', vars: {}, control: false }] },
    runs: [], report: { verdict: 'insufficient', headline: 'v4 incomplete', summary: 'v4 incomplete', matrix: [], directions: [], compare: { comparable: true, groups: [{ group: 'control', eligible: true, beatsControl: false, guardrails: [] }, { group: 'change', eligible: true, beatsControl: false, guardrails: [] }] }, predictions: [], attribution: { assessedLayers: [] } },
    decision: null, events: [],
  });
  // Cycle 4 on v5: repaired (must NOT be pruned)
  x.d.rounds.push({
    n: 4, version: 'v5', start: now + 400, end: now + 420, state: 'repaired', repairedBy: 'v6',
    plan: { tier: 'explore', skipControl: true, seeds: [34], groups: [{ id: 'change', label: 'v5', version: 'v5', vars: {}, control: false }] },
    runs: [], report: null, decision: null, events: [],
  });
  // Cycle 5 on v7: comparable control where candidate eligible && !beatsControl with worse delta -> worse (red, no ✕)
  x.d.rounds.push({
    n: 5, version: 'v7', start: now + 600, end: now + 640, state: 'done',
    plan: { tier: 'confirm', skipControl: false, seeds: [35], groups: [{ id: 'control', label: 'v1', version: 'v1', vars: {}, control: true }, { id: 'change', label: 'v7', version: 'v7', vars: {}, control: false }] },
    runs: [],
    report: {
      verdict: 'tune', headline: 'v7 worse than control', summary: 'v7 worse than control',
      matrix: [{ group: 'control', metric: 'accuracy', mean: 0.7, sd: null, n: 1, seeds: [] }, { group: 'change', metric: 'accuracy', mean: 0.65, sd: null, n: 1, seeds: [] }],
      directions: [option('d-code-2', 'code', 'model.py')],
      compare: { comparable: true, metric: 'accuracy', dir: 'up', groups: [{ group: 'control', eligible: true, delta: 0, beatsControl: false, guardrails: [] }, { group: 'change', eligible: true, delta: -0.05, beatsControl: false, guardrails: [] }] },
      predictions: [], attribution: { assessedLayers: [] },
    },
    decision: { pick: 'direction', directionId: 'd-code-2', by: '墨墨', at: now + 650 }, events: [],
  });
  // Cycle 6 on v8: explore tune (non-comparable, immediately follows kind=code -> unlabeled, NOT pruned)
  x.d.rounds.push({
    n: 6, version: 'v8', start: now + 700, end: now + 740, state: 'done',
    plan: { tier: 'explore', skipControl: true, seeds: [36], groups: [{ id: 'change', label: 'v8', version: 'v8', vars: {}, control: false }] },
    runs: [],
    report: { verdict: 'tune', headline: 'v8 promising explore', summary: 'v8 promising explore', matrix: [{ group: 'change', metric: 'accuracy', mean: 0.75, sd: null, n: 1, seeds: [] }], directions: [], compare: { comparable: false, groups: [{ group: 'change', eligible: false, beatsControl: false, guardrails: [] }] }, predictions: [], attribution: { assessedLayers: [] } },
    decision: null, events: [],
  });

  // Add v9 (guardrail violation on comparable round using real cycles.ts pass:false -> guardrail & pruned)
  x.d.versions.push({ id: 'v9', parent: 'v1', change: 'v9 crossed guardrail', commit: 'aaaaaaa', config: {}, at: now + 745, current: false, status: 'proposed' });
  x.d.rounds.push({
    n: 7, version: 'v9', start: now + 746, end: now + 748, state: 'done',
    plan: { tier: 'confirm', skipControl: false, seeds: [37], groups: [{ id: 'control', label: 'v1', version: 'v1', vars: {}, control: true }, { id: 'change', label: 'v9', version: 'v9', vars: {}, control: false }] },
    runs: [],
    report: {
      verdict: 'tune', headline: 'v9 crossed format guardrail', summary: 'v9 crossed format guardrail',
      matrix: [{ group: 'control', metric: 'accuracy', mean: 0.7, sd: null, n: 1, seeds: [] }, { group: 'change', metric: 'accuracy', mean: 0.8, sd: null, n: 1, seeds: [] }],
      directions: [],
      compare: { comparable: true, metric: 'accuracy', dir: 'up', groups: [{ group: 'control', eligible: true, delta: 0, beatsControl: false, guardrails: [] }, { group: 'change', eligible: false, delta: 0.1, beatsControl: false, guardrails: [{ metric: 'format', pass: false }] }] },
      predictions: [], attribution: { assessedLayers: [] },
    },
    decision: null, events: [],
  });
  // Add v10 (comparable tie delta=0 -> tied, neutral)
  x.d.versions.push({ id: 'v10', parent: 'v1', change: 'v10 tied control', commit: 'bbbbbbb', config: {}, at: now + 749, current: false, status: 'proposed' });
  x.d.rounds.push({
    n: 8, version: 'v10', start: now + 749, end: now + 750, state: 'done',
    plan: { tier: 'confirm', skipControl: false, seeds: [38], groups: [{ id: 'control', label: 'v1', version: 'v1', vars: {}, control: true }, { id: 'change', label: 'v10', version: 'v10', vars: {}, control: false }] },
    runs: [],
    report: {
      verdict: 'tune', headline: 'v10 tied control', summary: 'v10 tied control',
      matrix: [{ group: 'control', metric: 'accuracy', mean: 0.7, sd: null, n: 1, seeds: [] }, { group: 'change', metric: 'accuracy', mean: 0.7, sd: null, n: 1, seeds: [] }],
      directions: [],
      compare: { comparable: true, metric: 'accuracy', dir: 'up', groups: [{ group: 'control', eligible: true, delta: 0, beatsControl: false, guardrails: [] }, { group: 'change', eligible: true, delta: 0, beatsControl: false, guardrails: [] }] },
      predictions: [], attribution: { assessedLayers: [] },
    },
    decision: null, events: [],
  });

  // Exercise rsi_version optional aspects validation + persistence -> v11
  x.d.versionRequest = { cycle: 6, title: 'v11 declared', since: now + 750, invocationId: 'inv-asp' };
  const badAsp = toolAction(x.s, 'rsi.version', { change: 'bad aspect', config: { a: 1 }, aspects: ['bogus'] }, { catId: x.d.members.find((m) => m.role === 'iterate').catId, threadId: 't-ov', invocationId: 'inv-asp' }, now + 755);
  assert.match(badAsp.error, /aspects must be a non-empty array/);
  const okAsp = toolAction(x.s, 'rsi.version', { change: 'declared object+rubric', config: { a: 2 }, aspects: ['rubric', 'object'] }, { catId: x.d.members.find((m) => m.role === 'iterate').catId, threadId: 't-ov', invocationId: 'inv-asp' }, now + 760);
  assert.equal(okAsp.ok, true);
  assert.equal(okAsp.version, 'v11');

  const vmMap = viewModel(x.s, 'exp', { project: P, pick: `obj:${x.id}`, selO: `${x.id}/v2>c1.eval` });
  const row = (id) => vmMap.versions.find((v) => v.id === id);
  // P1-1 + alpha.113 polish: honest states (worse vs tied vs guardrail vs pruned)
  assert.equal(row('v1').outcome, 'current');
  assert.equal(row('v1').pruned, false);
  assert.equal(row('v2').outcome, 'confirmed');
  assert.equal(row('v2').pruned, false);
  assert.equal(row('v3').outcome, 'pruned');
  assert.equal(row('v3').pruned, true);
  assert.equal(row('v4').outcome, 'insufficient');
  assert.equal(row('v4').pruned, false);
  assert.equal(row('v5').outcome, 'repaired');
  assert.equal(row('v5').pruned, false);
  assert.equal(row('v6').outcome, 'pruned');
  assert.equal(row('v6').pruned, true);
  assert.equal(row('v7').outcome, 'worse');
  assert.equal(row('v7').pruned, false);
  assert.equal(row('v8').outcome, 'explored');
  assert.equal(row('v8').pruned, false);
  assert.equal(row('v9').outcome, 'guardrail');
  assert.equal(row('v9').pruned, true);
  assert.equal(row('v10').outcome, 'tied');
  assert.equal(row('v10').pruned, false);
  assert.equal(vmMap.overviewMap.stats.pruned, 3); // strictly v3 (rollback), v6 (rejected), v9 (guardrail)
  assert.equal(vmMap.overviewMap.stats.insufficient, 1); // v4

  // P1-2: reliable aspects only (no fake 'object' default on unlabeled code versions)
  assert.equal(row('v1').aspectKind, 'baseline');
  assert.deepEqual(row('v1').aspects, []);
  assert.deepEqual(row('v3').aspects, ['observability']);
  assert.equal(row('v8').aspectKind, 'unlabeled');
  assert.deepEqual(row('v8').aspects, []);
  assert.equal(row('v11').aspectKind, 'declared');
  assert.deepEqual(row('v11').aspects, ['object', 'rubric']);

  // P2-3: slim overviewMap nodes (no causality/receipts/full change bloat on all nodes; selectedDetail only for selected)
  for (const n of vmMap.overviewMap.nodes) {
    assert.equal('causality' in n, false);
    assert.equal('receipts' in n, false);
    assert.equal('change' in n, false);
  }
  assert.equal(vmMap.overviewMap.selectedDetail.id, 'v2');

  // Layered detail card checks
  assert.equal(vmMap.cycle.detailCard.autoFoldBody, true);
  assert.equal(vmMap.cycle.detailCard.main.comparable, true);
  const vmV3 = viewModel(x.s, 'exp', { project: P, pick: `obj:${x.id}`, selO: `${x.id}/v3>c1.eval`, overviewMode: 'trend', overviewLens: 'aspect' });
  assert.equal(vmV3.cycle.detailCard.main.comparable, false);
  assert.equal(vmV3.cycle.detailCard.autoFoldBody, false);

  // P2-1 + P2-2 + alpha.113: hot-reload single click listener (zero keydown), cluster container, inline inspector & native viewport modal mode
  const vmMod = await import('node:vm');
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../console/components/lineage.js', import.meta.url), 'utf8');
  const clickListeners = [];
  const keyListeners = [];
  const wheelListeners = [];
  const pointerOverListeners = [];
  const fakeWindow = {};
  const sandbox = {
    window: fakeWindow,
    globalThis: fakeWindow,
    document: {
      addEventListener: (ev, fn, opts) => {
        if (ev === 'click') clickListeners.push(fn);
        if (ev === 'keydown') keyListeners.push(fn);
        if (ev === 'wheel') wheelListeners.push(fn);
        if (ev === 'pointerover') pointerOverListeners.push({ fn, opts });
      },
      removeEventListener: (ev, fn) => {
        if (ev === 'pointerover') {
          const idx = pointerOverListeners.findIndex((x) => x.fn === fn);
          if (idx >= 0) pointerOverListeners.splice(idx, 1);
          return;
        }
        const arr = ev === 'click' ? clickListeners : ev === 'keydown' ? keyListeners : ev === 'wheel' ? wheelListeners : null;
        if (arr) { const idx = arr.indexOf(fn); if (idx >= 0) arr.splice(idx, 1); }
      },
    },
    PDL_COMPONENTS: {},
    S: { folds: {} },
    h: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    pv: (expr, sc) => expr === '$.map' ? vmMap.overviewMap : expr === '$.mapAspect' ? vmV3.overviewMap : expr === '$.cardLong' ? vmMap.cycle.detailCard : expr === '$.cardShort' ? vmV3.cycle.detailCard : expr === '$.trend' ? vmMap.activeTrend : (typeof expr === 'string' && expr.startsWith('@') ? sc?.[expr.slice(1)] : expr),
    pvList: (v) => Array.isArray(v) ? v : [],
    pvParts: (v, sc) => Array.isArray(v) ? v.map((it) => typeof it.text === 'string' && it.text.startsWith('@') ? sc?.[it.text.slice(1)] : it.text).join('') : String(v ?? ''),
    pvArgs: () => '',
    pvControl: () => '',
    pvText: (v) => String(v ?? ''),
    chipHtml: (o) => `<button class="${o.cls}"${o.attrs || ''}>${o.label}</button>`,
  };
  // Load twice (simulating hot-install reload without page refresh) -> strictly 1 click listener, 0 keydown listeners
  vmMod.runInNewContext(src, sandbox);
  vmMod.runInNewContext(src, sandbox);
  assert.equal(clickListeners.length, 1);
  assert.equal(wheelListeners.length, 0, 'must never attach document-level wheel listener');
  assert.equal(pointerOverListeners.length, 1);
  assert.equal(pointerOverListeners[0].opts?.passive, true);
  assert.equal(keyListeners.length, 0);
  // Lazy element-scoped wheel binding via passive pointerover: binds once per .rsi-map-scroll element
  const elemWheel = [];
  const fakeScroll = { addEventListener: (ev, fn, opts) => { if (ev === 'wheel') elemWheel.push({ fn, opts }); } };
  const fakeTarget = { closest: (sel) => sel === '.rsi-map-scroll' ? fakeScroll : null };
  pointerOverListeners[0].fn({ target: fakeTarget });
  pointerOverListeners[0].fn({ target: fakeTarget });
  assert.equal(elemWheel.length, 1, 'element-scoped wheel listener binds strictly once');
  assert.equal(elemWheel[0].opts?.passive, false);

  const mapHtml = sandbox.PDL_COMPONENTS['plugin:official.rsi/rsiOverviewMap']({ from: '$.map' }, {}, {});
  assert.match(mapHtml, /Refuted ✕/);
  assert.match(mapHtml, /Guardrail ✕/);
  assert.match(mapHtml, /Below control/);
  assert.match(mapHtml, /Tied/);
  assert.match(mapHtml, /Insufficient/);
  assert.match(mapHtml, /Superseded/);
  assert.match(mapHtml, /class="rsi-map-inspect"/);
  assert.match(mapHtml, /class="rsi-map-cluster"/);
  assert.doesNotMatch(mapHtml, /rsi-map-edge chain/);
  assert.doesNotMatch(mapHtml, /已证伪|证据不足|剪枝/);

  const modalHtml = sandbox.PDL_COMPONENTS['plugin:official.rsi/rsiOverviewMap']({ from: '$.map', mode: 'modal' }, {}, {});
  assert.match(modalHtml, /rsi-map-wrap is-modal/);
  assert.match(modalHtml, /class="rsi-map-split"/);
  assert.match(modalHtml, /class="rsi-map-aside"/);

  const aspectMapHtml = sandbox.PDL_COMPONENTS['plugin:official.rsi/rsiOverviewMap']({ from: '$.mapAspect' }, {}, {});
  assert.match(aspectMapHtml, /asp-unlabeled/);
  assert.match(aspectMapHtml, /asp-baseline/);

  const longCardHtml = sandbox.PDL_COMPONENTS['plugin:official.rsi/rsiCycleCard']({ from: '$.cardLong' }, {}, {});
  assert.match(longCardHtml, /Show full evaluation details/);
  assert.doesNotMatch(longCardHtml, /class="rsi-cc-body"/);
  sandbox.S.folds['rsi-cc-body:' + vmMap.cycle.detailCard.foldId] = true;
  assert.match(sandbox.PDL_COMPONENTS['plugin:official.rsi/rsiCycleCard']({ from: '$.cardLong' }, {}, {}), /class="rsi-cc-body"/);

  const shortCardHtml = sandbox.PDL_COMPONENTS['plugin:official.rsi/rsiCycleCard']({ from: '$.cardShort' }, {}, {});
  assert.match(shortCardHtml, /Explore reference/);
  assert.match(shortCardHtml, /class="rsi-cc-body"/);
  assert.doesNotMatch(shortCardHtml, /探索参考|上游触发|判断依据/);

  const linHtml = sandbox.PDL_COMPONENTS['plugin:official.rsi/rsiLineage']({ from: vmMap.versions, key: '@key', parent: '@parentKey', node: { label: [{ text: '@id' }], state: '@nodeState' } }, {}, {});
  assert.match(linHtml, /data-state="pruned"/);
  assert.match(linHtml, /data-state="guardrail"/);
  assert.match(linHtml, /data-state="worse"/);
  assert.match(linHtml, /data-state="tied"/);
  assert.match(linHtml, /data-state="confirmed"/);
  assert.match(linHtml, /data-state="insufficient"/);
  assert.match(linHtml, /data-state="repaired"/);

  const trHtml = sandbox.PDL_COMPONENTS['plugin:official.rsi/rsiTrend']({ series: '$.trend', label: 'Trend' }, {}, {});
  assert.match(trHtml, /stick-end rsi-trend-scroll/);

  // alpha.114: noise-band worse vs tied (minDelta + mean ± SD overlap), disposition: dead_end + tag + annotatedBy provenance
  const noMinMetrics = { version: 'E2', items: [{ id: 'accuracy', name: 'holdout accuracy', dir: 'up', guard: false }] };
  x.d.versions.push(
    { id: 'v12', parent: 'v2', change: 'Within minDelta band', at: now + 1200, current: false, status: 'proposed', aspects: ['object'] },
    { id: 'v13', parent: 'v2', change: 'Overlap SD noise band', at: now + 1300, current: false, status: 'proposed', aspects: ['object'] },
    { id: 'v14', parent: 'v2', change: 'Dead-end experiment', at: now + 1400, current: false, status: 'proposed', aspects: ['object'], disposition: 'dead_end', tag: '融合精度差 0.038 拦截', annotatedBy: '墨墨（回填）' },
  );
  x.d.rounds.push(
    {
      n: 12, version: 'v12', state: 'done',
      plan: { tier: 'confirm', seeds: [41], groups: [{ id: 'control', label: 'Control', version: 'v2', vars: {}, control: true }, { id: 'change', label: 'SmallDrop', version: 'v12', vars: {}, control: false }] },
      runs: [],
      metrics: x.d.metrics,
      report: {
        verdict: 'tune', headline: 'Within minDelta band', summary: 'Within minDelta band',
        matrix: [
          { group: 'control', metric: 'accuracy', mean: 0.70, sd: null, n: 1, seeds: [] },
          { group: 'change', metric: 'accuracy', mean: 0.68, sd: null, n: 1, seeds: [] },
        ],
        compare: { comparable: true, metric: 'accuracy', dir: 'up', groups: [{ group: 'control', version: 'v2', control: true, eligible: true, mean: 0.70, delta: 0, beatsControl: false, guardrails: [] }, { group: 'change', version: 'v12', control: false, eligible: true, mean: 0.68, delta: -0.02, beatsControl: false, guardrails: [] }] },
        predictions: [], directions: [], attribution: { assessedLayers: [] },
      },
      decision: { pick: 'same' }, events: [],
    },
    {
      n: 13, version: 'v13', state: 'done',
      plan: { tier: 'confirm', seeds: [42, 43], groups: [{ id: 'control', label: 'Control', version: 'v2', vars: {}, control: true }, { id: 'change', label: 'Overlap', version: 'v13', vars: {}, control: false }] },
      runs: [],
      metrics: noMinMetrics,
      report: {
        verdict: 'tune', headline: 'Within SD overlap band', summary: 'Within SD overlap band',
        matrix: [
          { group: 'control', metric: 'accuracy', mean: 0.86, sd: 0.02, lo: 0.84, hi: 0.88, n: 2, seeds: [] },
          { group: 'change', metric: 'accuracy', mean: 0.845, sd: 0.02, lo: 0.825, hi: 0.865, n: 2, seeds: [] },
        ],
        compare: { comparable: true, metric: 'accuracy', dir: 'up', groups: [{ group: 'control', version: 'v2', control: true, eligible: true, mean: 0.86, delta: 0, beatsControl: false, guardrails: [] }, { group: 'change', version: 'v13', control: false, eligible: true, mean: 0.845, delta: -0.015, beatsControl: false, guardrails: [] }] },
        predictions: [], directions: [], attribution: { assessedLayers: [] },
      },
      decision: { pick: 'same' }, events: [],
    },
    {
      n: 14, version: 'v14', state: 'done',
      plan: { tier: 'explore', skipControl: true, seeds: [44], groups: [{ id: 'change', label: 'DeadEnd', version: 'v14', vars: {}, control: false }] },
      runs: [],
      metrics: x.d.metrics,
      report: { verdict: 'insufficient', disposition: 'dead_end', tag: '融合精度差 0.038 拦截', headline: 'Precision gate failed', summary: 'Precision gate failed', matrix: [{ group: 'change', metric: 'accuracy', mean: 0, sd: null, n: 1, seeds: [] }], compare: { comparable: false, metric: 'accuracy', dir: 'up', groups: [] }, predictions: [], directions: [], attribution: { assessedLayers: [] } },
      decision: { pick: 'same' }, events: [],
    },
  );
  const vm114 = viewModel(x.s, 'exp', { project: P, pick: `obj:${x.id}`, selO: `${x.id}/v14>c1.eval` });
  assert.equal(vm114.overviewMode, 'trend');
  assert.equal(vm114.overviewMap.nodes.find((n) => n.id === 'v12').state, 'tied', 'delta inside minDelta band must classify as tied');
  assert.equal(vm114.overviewMap.nodes.find((n) => n.id === 'v13').state, 'tied', 'overlapping mean±SD intervals must classify as tied');
  const n14 = vm114.overviewMap.nodes.find((n) => n.id === 'v14');
  assert.equal(n14.state, 'deadEnd');
  assert.equal(n14.pruned, true);
  assert.equal(n14.tag, '融合精度差 0.038 拦截');
  assert.equal(n14.annotatedBy, '墨墨（回填）');
  sandbox.pv = (expr, sc) => expr === '$.map114' ? vm114.overviewMap : (typeof expr === 'string' && expr.startsWith('@') ? sc?.[expr.slice(1)] : expr);
  const html114 = sandbox.PDL_COMPONENTS['plugin:official.rsi/rsiOverviewMap']({ from: '$.map114', mode: 'modal' }, {}, {});
  assert.match(html114, /Dead-end ✕/);
  assert.match(html114, /融合精度差 0\.038 拦截/);
  assert.match(html114, /Source：墨墨（回填）/);

  // alpha.115: linear chain folding (>=4 folds into Vm~Vn card, <=3 stays unfolded), preparing stage node, and persisted zoom across re-renders
  const chainMap = {
    objectiveId: 'obj-fold-test',
    objectiveName: 'Fold & Preparing test',
    currentVersion: 'v4',
    metricVersion: 'E1',
    lens: 'metric',
    metric: { id: 'qps', name: 'QPS', dir: 'up', unit: '' },
    selectedVersion: 'v9',
    stats: { total: 8, pruned: 1, insufficient: 0, running: 0, preparing: 'v9', current: 'v4' },
    nodes: [
      { id: 'v1', parent: null, state: 'baseline', value: 1, valueText: '1', aspects: [], changeShort: 'root' },
      { id: 'v2', parent: 'v1', state: 'explored', value: 2, valueText: '2', aspects: ['observability'], changeShort: 'step 2' },
      { id: 'v3', parent: 'v2', state: 'explored', value: 3, valueText: '3', aspects: ['rubric'], changeShort: 'step 3' },
      { id: 'v4', parent: 'v3', state: 'current', value: 4, valueText: '4', aspects: ['object'], changeShort: 'cur v4' },
      // 3-node branch (v5 -> v6 -> v7): MUST NOT fold
      { id: 'v5', parent: 'v4', state: 'explored', value: 4.1, valueText: '4.1', aspects: ['object'], changeShort: 'b1' },
      { id: 'v6', parent: 'v5', state: 'explored', value: 4.2, valueText: '4.2', aspects: ['object'], changeShort: 'b2' },
      { id: 'v7', parent: 'v6', state: 'deadEnd', pruned: true, value: 0, valueText: '0', aspects: ['object'], changeShort: 'b3 dead' },
      // Preparing virtual node hanging off v4
      { id: 'v8', parent: 'v4', state: 'explored', value: 5, valueText: '5', aspects: ['object'], changeShort: 'b4' },
      { id: 'v9', parent: 'v4', state: 'preparing', preparing: true, value: null, valueText: '—', ownerName: '砚砚', claimed: true, aspects: [], changeShort: 'next direction' },
    ],
    selectedDetail: { id: 'v9', causality: { triggerKind: 'direction', triggerCycle: 8, triggerDetail: 'next direction', action: 'next direction', basisKind: 'preparing', ownerName: '砚砚', claimed: true }, receipts: [] },
  };
  sandbox.globalThis.__rsiMapZoom = { 'obj-fold-test': 0.65 };
  sandbox.globalThis.__rsiMapExpanded = {};
  sandbox.pv = (expr, sc) => expr === '$.map115' ? chainMap : (typeof expr === 'string' && expr.startsWith('@') ? sc?.[expr.slice(1)] : expr);
  const html115 = sandbox.PDL_COMPONENTS['plugin:official.rsi/rsiOverviewMap']({ from: '$.map115', mode: 'modal' }, {}, {});
  assert.match(html115, /data-fold-key="v2~v3"/, '4-node linear chain v1->v2->v3->v4 must fold middle v2~v3');
  assert.match(html115, /v2 ~ v3/);
  assert.doesNotMatch(html115, /data-fold-key="v6~v6"/, '3-node branch v5->v6->v7 must NOT fold');
  assert.match(html115, /data-ver="v6"/, 'v6 in 3-node branch remains directly visible');
  assert.match(html115, /data-state="preparing" data-ver="v9"/, 'preparing virtual node must render');
  assert.match(html115, /rsi-map-edge[^"]*preparing/, 'preparing edge must render with dashed class');
  assert.match(html115, /data-zoom="0\.65"/, 'saved zoom must persist across re-renders');
  assert.match(html115, />65%</, 'zoom pill must display persisted percentage');
  assert.match(html115, /data-rsi-map-act="expand-all"/, 'toolbar must offer expand-all when chains are folded');
  assert.match(html115, /砚砚 is implementing/);
  assert.doesNotMatch(html115, /class="rsi-cc-asp obs"/, 'must not collide with host .obs flex-column CSS class');
  assert.match(html115, /rsi-asp-obs/, 'must use namespaced rsi-asp-obs class');

  // alpha.124: consecutive linear `advance` nodes fold like other linear exploration chains (only true structural/active/pruned boundaries stay pinned)
  const advanceChainMap = {
    objectiveId: 'obj-adv-fold',
    objectiveName: 'Advance linear fold test',
    currentVersion: 'v4',
    metricVersion: 'E1',
    lens: 'metric',
    metric: { id: 'qps', name: 'QPS', dir: 'up', unit: '' },
    selectedVersion: 'v47',
    stats: { total: 8, pruned: 1, insufficient: 0, running: 0, preparing: null, current: 'v4' },
    nodes: [
      { id: 'v38', parent: null, state: 'explored', disposition: 'advance', value: 8.5, valueText: '8.5', aspects: ['observability'], changeShort: 'root branch' },
      { id: 'v39', parent: 'v38', state: 'deadEnd', disposition: 'dead_end', pruned: true, value: 0, valueText: '0', aspects: ['object'], changeShort: 'dead branch' },
      { id: 'v40', parent: 'v38', state: 'explored', disposition: 'advance', value: 8.5, valueText: '8.5', aspects: ['observability'], changeShort: 'head' },
      { id: 'v41', parent: 'v40', state: 'explored', disposition: 'advance', value: 8.5, valueText: '8.5', aspects: ['observability'], changeShort: 'mid1' },
      { id: 'v42', parent: 'v41', state: 'explored', disposition: 'advance', value: 8.57, valueText: '8.57', aspects: ['observability'], changeShort: 'mid2' },
      { id: 'v43', parent: 'v42', state: 'explored', disposition: 'advance', value: 8.63, valueText: '8.63', aspects: ['observability'], changeShort: 'mid3' },
      { id: 'v44', parent: 'v43', state: 'explored', disposition: 'advance', value: 8.63, valueText: '8.63', aspects: ['observability'], changeShort: 'mid4' },
      { id: 'v45', parent: 'v44', state: 'explored', disposition: 'advance', value: 8.63, valueText: '8.63', aspects: ['observability'], changeShort: 'branch tail' },
      { id: 'v46', parent: 'v45', state: 'deadEnd', disposition: 'dead_end', pruned: true, value: 0, valueText: '0', aspects: ['object'], changeShort: 'dead2' },
      { id: 'v47', parent: 'v45', state: 'explored', value: 8.45, valueText: '8.45', aspects: ['observability'], changeShort: 'leaf' },
    ],
    selectedDetail: { id: 'v47', causality: { triggerKind: 'direction', triggerCycle: 50, triggerDetail: 'soak', action: 'soak', basisKind: 'done' }, receipts: [] },
  };
  sandbox.globalThis.__rsiMapExpanded = {};
  sandbox.pv = (expr, sc) => expr === '$.map124' ? advanceChainMap : (typeof expr === 'string' && expr.startsWith('@') ? sc?.[expr.slice(1)] : expr);
  const html124 = sandbox.PDL_COMPONENTS['plugin:official.rsi/rsiOverviewMap']({ from: '$.map124', mode: 'modal' }, {}, {});
  assert.match(html124, /data-fold-key="v41~v44"/, 'linear advance chain v40->v41..v44->v45 must fold middle v41~v44');
  assert.match(html124, /data-ver="v39"/, 'dead_end branch stays visible');
  assert.match(html124, /data-ver="v46"/, 'dead_end branch stays visible');
  assert.match(html124, /data-ver="v40"/, 'branch child head stays visible');
  assert.match(html124, /data-ver="v45"/, 'branch parent tail stays visible');

  // alpha.116: card without numeric metric or manual tag surfaces headlineBrief (instead of hiding verdict behind changeShort),
  // and version tree marks env-failed runs with non-insufficient report verdict as 'concluded' instead of misleading 'failed'.
  x.d.versions.push({ id: 'v15', parent: 'v2', change: 'Code change description hidden behind headline', at: now + 1500, current: false, status: 'proposed', aspects: ['object'] });
  x.d.rounds.push({
    n: 15, version: 'v15', state: 'done',
    plan: { tier: 'explore', skipControl: true, seeds: [45], groups: [{ id: 'change', label: 'GateStop', version: 'v15', vars: {}, control: false }] },
    runs: [{ id: 'r15-1', group: 'change', seed: 45, state: 'failed', retries: 1, error: { kind: 'env', step: 'get', raw: 'exit 1' }, metrics: {} }],
    metrics: x.d.metrics,
    report: { verdict: 'tune', headline: 'Preformal gate intercepted 176 score diffs', summary: 'Gate intercepted', matrix: [], compare: { comparable: false, metric: 'accuracy', dir: 'up', groups: [] }, predictions: [], directions: [], attribution: { assessedLayers: [] } },
    decision: { pick: 'same' }, events: [],
  });
  const vm116 = viewModel(x.s, 'exp', { project: P, pick: `obj:${x.id}`, selO: `${x.id}/v15>c1.eval` });
  const v15Row = vm116.versions.find((row) => row.id === 'v15');
  const v15ApplyStep = v15Row?.steps?.find((st) => st.k === 'apply');
  assert.equal(v15ApplyStep?.result, 'concluded', 'env-failed run with non-insufficient report must surface concluded instead of failed');
  sandbox.pv = (expr, sc) => expr === '$.map116' ? vm116.overviewMap : (typeof expr === 'string' && expr.startsWith('@') ? sc?.[expr.slice(1)] : expr);
  const html116 = sandbox.PDL_COMPONENTS['plugin:official.rsi/rsiOverviewMap']({ from: '$.map116', mode: 'modal' }, {}, {});
  assert.match(html116, /Preformal gate intercepted 176 score diffs/, 'untagged metricless node must display headlineBrief on card');

  // alpha.117:
  // 1) Shared preparing node single source of truth across version tree (vm.versions) and overviewMap.nodes,
  //    with explicit `prep` stage chip in version tree (`[v16] -> [准备 · 实现中]`), unified `>prep` / `>node` selection,
  //    and safe ver/prepStage details without rounds/commit.
  x.d.versionRequest = { cycle: 15, title: 'Implement v16 zero-drift kernel', baseVersion: 'v2', since: now + 2000, invocationId: 'inv-117' };
  const prepStepPick117 = `${x.id}/v16>prep`;
  const prepNodePick117 = `${x.id}/v16>node`;
  const vm117Prep = viewModel(x.s, 'exp', { project: P, pick: `obj:${x.id}`, selO: prepStepPick117 });
  const treePrepRow = vm117Prep.versions.find((row) => row.id === 'v16');
  const mapPrepNode = vm117Prep.overviewMap.nodes.find((n) => n.id === 'v16');
  assert.ok(treePrepRow, 'preparing version must appear in version tree (vm.versions)');
  assert.ok(mapPrepNode, 'preparing version must appear in overviewMap.nodes');
  assert.equal(treePrepRow.parentKey, `${x.id}/v2`);
  assert.equal(mapPrepNode.parent, 'v2');
  assert.equal(treePrepRow.pick, prepNodePick117);
  assert.equal(treePrepRow.steps.length, 1);
  assert.equal(treePrepRow.steps[0].k, 'prep');
  assert.equal(treePrepRow.steps[0].result, 'claimed');
  assert.equal(treePrepRow.steps[0].pick, prepStepPick117);
  assert.equal(treePrepRow.steps[0].selected, true);
  assert.equal(mapPrepNode.pick, prepStepPick117);
  assert.equal(treePrepRow.nodeState, 'preparing');
  assert.equal(mapPrepNode.state, 'preparing');
  assert.equal(vm117Prep.ver?.id, 'v16');
  assert.equal(vm117Prep.ver?.outcome, 'preparing');
  assert.equal(vm117Prep.ver?.preparing, true);
  assert.equal(vm117Prep.step, 'prep');
  assert.equal(vm117Prep.prepStage?.status, 'claimed');
  assert.equal(vm117Prep.prepStage?.triggerCycle, 15);
  assert.equal(vm117Prep.prepStage?.canWake, true);
  assert.equal(vm117Prep.cycle, null);
  assert.equal(vm117Prep.overviewMap.selectedVersion, 'v16');
  assert.equal(vm117Prep.overviewMap.selectedDetail?.id, 'v16');
  assert.equal(vm117Prep.overviewMap.selectedDetail?.causality?.basisKind, 'preparing');
  assert.equal(vm117Prep.overviewMap.stats.total, x.d.versions.length, 'stats.total counts registered versions, not virtual preparing node');
  assert.equal(vm117Prep.overviewMap.stats.preparing, 'v16');
  const vm117PrepNode = viewModel(x.s, 'exp', { project: P, pick: `obj:${x.id}`, selO: prepNodePick117 });
  assert.equal(vm117PrepNode.step, 'node');
  assert.equal(vm117PrepNode.prepStage, null);
  delete x.d.versionRequest;

  // 2) Enriched collect step fields: collectSummary, jobId, directory, errorBrief, attemptsText
  x.d.rounds[x.d.rounds.length - 1].runs[0].jobId = 'job-15-a';
  x.d.rounds[x.d.rounds.length - 1].runs[0].directory = '/tmp/rsi/run-15';
  x.d.rounds[x.d.rounds.length - 1].runs[0].attempts = [
    { state: 'failed', jobId: 'job-15-0', start: now, end: now + 3000, error: { raw: 'first attempt timeout' } },
    { state: 'failed', jobId: 'job-15-a', start: now + 4000, end: now + 9000, error: { raw: 'exit 1' } },
  ];
  const vm117Collect = viewModel(x.s, 'exp', { project: P, pick: `obj:${x.id}`, selO: `${x.id}/v15>c1.collect` });
  assert.equal(vm117Collect.cycle.groups[0].runListId, 'rsi-exp-runs:15:change');
  assert.equal(vm117Collect.cycle.collectSummary.tier, 'explore');
  assert.match(vm117Collect.cycle.collectSummary.concludedHeadline, /Preformal gate intercepted/);
  assert.equal(vm117Collect.cycle.runs[0].jobId, 'job-15-a');
  assert.equal(vm117Collect.cycle.runs[0].directory, '/tmp/rsi/run-15');
  assert.equal(vm117Collect.cycle.runs[0].errorBrief, 'exit 1');
  assert.match(vm117Collect.cycle.runs[0].attemptsText, /#1 failed \(job-15-0\)/);
  assert.match(vm117Collect.cycle.runs[0].attemptsText, /#2 failed \(job-15-a\)/);

  // 3) Overview fold groups: max 6 per chunk, expanded dashed box with per-group Collapse button,
  //    selecting a node inside an expanded group keeps the group intact, and no Host .scroll-x on .rsi-map-scroll.
  const longChainNodes = [{ id: 'v1', parent: null, state: 'baseline', value: 1, valueText: '1', aspects: [], changeShort: 'root' }];
  for (let i = 2; i <= 14; i++) {
    longChainNodes.push({ id: `v${i}`, parent: `v${i - 1}`, state: 'explored', value: i, valueText: String(i), aspects: ['object'], changeShort: `step ${i}` });
  }
  longChainNodes.push({ id: 'v15', parent: 'v14', state: 'current', value: 15, valueText: '15', aspects: ['object'], changeShort: 'cur v15' });
  const longChainMap = {
    objectiveId: 'obj-chunk-test',
    objectiveName: 'Chunked fold test',
    currentVersion: 'v15',
    metricVersion: 'E1',
    lens: 'metric',
    metric: { id: 'qps', name: 'QPS', dir: 'up', unit: '' },
    selectedVersion: 'v15',
    stats: { total: 15, pruned: 0, insufficient: 0, running: 0, preparing: null, current: 'v15' },
    nodes: longChainNodes,
  };
  sandbox.globalThis.__rsiMapZoom = {};
  sandbox.globalThis.__rsiMapExpanded = {};
  sandbox.pv = (expr, sc) => expr === '$.map117' ? longChainMap : (typeof expr === 'string' && expr.startsWith('@') ? sc?.[expr.slice(1)] : expr);
  const html117Collapsed = sandbox.PDL_COMPONENTS['plugin:official.rsi/rsiOverviewMap']({ from: '$.map117', mode: 'modal' }, {}, {});
  // 13 middle nodes (v2..v14) split into chunks of <=6 with no 1-node chunk: [6, 5, 2] -> v2~v7, v8~v12, v13~v14
  assert.match(html117Collapsed, /data-fold-key="v2~v7"/);
  assert.match(html117Collapsed, /data-fold-key="v8~v12"/);
  assert.match(html117Collapsed, /data-fold-key="v13~v14"/);
  assert.doesNotMatch(html117Collapsed, /class="scroll-x rsi-map-scroll"/, 'must not attach Host scroll-x class');
  assert.match(html117Collapsed, /class="rsi-map-scroll"/);
  // Expanding v8~v12 while selecting v10 inside it keeps v8~v12 intact as one dashed container with a Collapse button
  sandbox.globalThis.__rsiMapExpanded = { 'obj-chunk-test': { 'v8~v12': true } };
  const longChainSelInside = Object.assign({}, longChainMap, { selectedVersion: 'v10' });
  sandbox.pv = (expr, sc) => expr === '$.map117b' ? longChainSelInside : (typeof expr === 'string' && expr.startsWith('@') ? sc?.[expr.slice(1)] : expr);
  const html117Expanded = sandbox.PDL_COMPONENTS['plugin:official.rsi/rsiOverviewMap']({ from: '$.map117b', mode: 'modal' }, {}, {});
  assert.match(html117Expanded, /class="rsi-map-fold-box" data-fold-key="v8~v12"/, 'expanded chunk renders persistent dashed fold container');
  assert.match(html117Expanded, /data-rsi-map-act="toggle-fold" data-fold-key="v8~v12" data-fold-open="1"/, 'expanded container renders individual Collapse button');
  assert.match(html117Expanded, /data-ver="v10" aria-pressed="true"/, 'selected node inside expanded group remains selected without splitting the group');
  assert.match(html117Expanded, /data-fold-key="v2~v7" data-fold-open="0"/, 'other chunks remain collapsed');
  assert.match(html117Expanded, /data-fold-key="v13~v14" data-fold-open="0"/);
  // Explicit collapse overrides wildcard '*' so collapsing one group from expand-all mode works
  sandbox.globalThis.__rsiMapExpanded = { 'obj-chunk-test': { '*': true, 'v8~v12': false } };
  const html117OneCollapsed = sandbox.PDL_COMPONENTS['plugin:official.rsi/rsiOverviewMap']({ from: '$.map117b', mode: 'modal' }, {}, {});
  assert.match(html117OneCollapsed, /data-fold-key="v8~v12" data-fold-open="0"/, 'explicit false must collapse even under expand-all wildcard');
  assert.match(html117OneCollapsed, /class="rsi-map-fold-box" data-fold-key="v2~v7"/);
  assert.match(html117OneCollapsed, /data-rsi-map-act="expand-all"/, 'top button switches back to expand-all when one group is collapsed');
});

test('alpha.118: data-driven sliced & scalar comparison, guardrail rollup, user chip customization, cross-cycle/cross-scale honesty, chat markdown & slim exp payload', async () => {
  const { validateSliceSpecs, normalizeSlicesInput, sliceMatrix, formatComparisonMarkdown } = await import('../dist/compare.js');
  // 1) Slice spec validation & input normalization
  assert.equal(validateSliceSpecs([{ id: 'load', name: '负载分档', axis: '并发', axisUnit: 'c', stats: [{ id: 'qps', name: 'QPS', dir: 'up', primary: true }, { id: 'p99', name: 'P99', unit: 'ms', dir: 'down', threshold: 80 }] }]), null);
  assert.match(validateSliceSpecs([{ id: 'load', name: 'A', axis: 'x', stats: [{ id: 'q', name: 'Q', dir: 'sideways' }] }]), /dir/);
  assert.match(validateSliceSpecs([{ id: 'a', name: 'A', axis: 'x', stats: [{ id: 'q', name: 'Q', dir: 'up' }] }, { id: 'a', name: 'B', axis: 'y', stats: [{ id: 'q', name: 'Q', dir: 'up' }] }]), /Duplicate slice table/);
  const normSlices = normalizeSlicesInput({
    load: [
      { at: 1, values: { qps: 50, p99: 20, bad: NaN, undeclared_extra: 999 }, pass: true },
      { at: 'x'.repeat(100), values: { qps: 120, p99: 75 } },
      { at: '', values: { qps: 1 } },
    ],
  }, [{ id: 'load', name: '负载分档', axis: '并发', stats: [{ id: 'qps', name: 'QPS', dir: 'up' }, { id: 'p99', name: 'P99', dir: 'down' }] }]);
  assert.equal(normSlices.load.length, 2);
  assert.deepEqual(normSlices.load[0].values, { qps: 50, p99: 20 }, 'undeclared stats must be stripped when Step 4 declared slices');
  assert.equal(normSlices.load[1].at.length, 64, 'slice at string must be capped at 64 chars');
  // Even without declared specs, values keys are capped at 24
  const manyStats = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`s${i}`, i]));
  const capped = normalizeSlicesInput({ raw: [{ at: 'k', values: manyStats }] });
  assert.equal(Object.keys(capped.raw[0].values).length, 24);

  // 2) Build a realistic multi-cycle objective with 1 main + 8 guardrails + 2 aux + 1 slice table
  const state = createFixtures(now).state;
  const project = '/work/sliced-bench';
  state.projects.unshift({ id: project, name: 'sliced-bench', projectPath: project, exp: true, hostKinds: ['mcp'] });
  state.objectives[project] = []; state.groups[project] = []; state.units[project] = []; state.library[project] = [];
  assert.equal(act(state, { op: 'new', statement: 'Throughput under SLA', projectPath: project, prepare: 'codex', evaluate: 'kimi', iterate: 'codex', cats: [{ id: 'codex', name: '砚砚' }, { id: 'kimi', name: '小狸' }] }, { project }, now).ok, true);
  const id = state.objectives[project][0].id;
  const d = state.experiments[id];
  const guards = Array.from({ length: 8 }, (_, i) => ({ id: `g${i + 1}`, name: `质量护栏${i + 1}`, how: `m.g${i + 1}`, dir: 'down', threshold: 0, guard: true }));
  const sliceSpec = [{
    id: 'load', name: '负载分档', axis: '并发', axisUnit: 'c',
    stats: [
      { id: 'qps', name: 'QPS', dir: 'up', primary: true },
      { id: 'p50', name: 'P50', unit: 'ms', dir: 'down' },
      { id: 'p99', name: 'P99', unit: 'ms', dir: 'down', threshold: 80 },
    ],
  }];
  d.metrics = {
    version: 'E2',
    items: [
      { id: 'max-qps', name: '可持续 QPS', how: 'm.max_qps', dir: 'up', unit: 'QPS', guard: false },
      ...guards,
      { id: 'aux-mem', name: '显存占用', how: 'm.mem', dir: 'down', unit: 'GB', guard: false },
    ],
    slices: sliceSpec,
  };
  const zeroGuards = Object.fromEntries(guards.map((g) => [g.id, 0]));
  d.versions.push(
    { id: 'v2', parent: 'v1', change: 'E2 baseline', config: {}, at: now + 1000, current: true, status: 'confirmed' },
    { id: 'v3', parent: 'v2', change: 'W8A8 dynamic batch', config: {}, at: now + 2000, current: false, status: 'proposed' },
    { id: 'v4', parent: 'v3', change: 'Explore no-ctrl', config: {}, at: now + 3000, current: false, status: 'proposed' },
  );
  d.versions[0].current = false;
  d.objective.currentVersion = 'v2';

  // Round 1 on older scale E1 (tests cross-scale delta suppression!)
  const r1Metrics = { version: 'E1', items: structuredClone(d.metrics.items), slices: sliceSpec };
  d.rounds.push({
    n: 1, version: 'v1', start: now, end: now + 500, state: 'evaluating',
    plan: { baseline: true, groups: [{ id: 'control', label: '对照', version: 'v1', vars: {}, control: true }], seeds: [1] },
    metrics: r1Metrics,
    runs: [{
      id: 'r1-c-1', group: 'control', seed: 1, state: 'done',
      metrics: { 'max-qps': 40, ...zeroGuards, 'aux-mem': 12 },
      slices: { load: [{ at: 1, values: { qps: 40, p50: 15, p99: 30 } }, { at: 8, values: { qps: 50, p50: 40, p99: 95 } }] },
      env: {},
    }],
    report: null, decision: { pick: 'direction', directionId: 'd1', by: '你', at: now + 600 }, events: [],
  });
  assert.equal(conclude(state, d, { cycle: 1, verdict: 'baseline', findings: 'E1 baseline', options: [{ k: 'd1', title: 'v2', why: 'scale E2' }] }, now + 550).ok, true);

  // Round 2 paired on E2 (v2 control vs v3 candidate, 2 seeds, all 8 guards pass)
  d.rounds.push({
    n: 2, version: 'v3', start: now + 1000, end: now + 1500, state: 'evaluating',
    plan: {
      baseline: false, tier: 'confirm',
      groups: [
        { id: 'control', label: '当前版本对照', version: 'v2', vars: {}, control: true },
        { id: 'change', label: 'W8A8', version: 'v3', vars: {}, control: false },
      ],
      seeds: [11, 23],
    },
    metrics: structuredClone(d.metrics),
    runs: [
      { id: 'r2-c-11', group: 'control', seed: 11, state: 'done', metrics: { 'max-qps': 60, ...zeroGuards, 'aux-mem': 14 }, slices: { load: [{ at: 1, values: { qps: 45, p50: 14, p99: 28 } }, { at: 8, values: { qps: 60, p50: 38, p99: 72 } }, { at: 16, values: { qps: 65, p50: 60, p99: 110 } }] }, env: {} },
      { id: 'r2-c-23', group: 'control', seed: 23, state: 'done', metrics: { 'max-qps': 60, ...zeroGuards, 'aux-mem': 14 }, slices: { load: [{ at: 1, values: { qps: 45, p50: 14, p99: 30 } }, { at: 8, values: { qps: 60, p50: 40, p99: 74 } }, { at: 16, values: { qps: 65, p50: 62, p99: 112 } }] }, env: {} },
      { id: 'r2-g-11', group: 'change', seed: 11, state: 'done', metrics: { 'max-qps': 120, ...zeroGuards, 'aux-mem': 11 }, slices: { load: [{ at: 1, values: { qps: 90, p50: 8, p99: 15 } }, { at: 8, values: { qps: 120, p50: 22, p99: 52 } }, { at: 16, values: { qps: 130, p50: 35, p99: 76 } }] }, env: {} },
      { id: 'r2-g-23', group: 'change', seed: 23, state: 'done', metrics: { 'max-qps': 120, ...zeroGuards, 'aux-mem': 11 }, slices: { load: [{ at: 1, values: { qps: 90, p50: 8, p99: 17 } }, { at: 8, values: { qps: 120, p50: 24, p99: 54 } }, { at: 16, values: { qps: 130, p50: 37, p99: 78 } }] }, env: {} },
    ],
    report: null, decision: null, events: [],
  });
  assert.equal(conclude(state, d, { cycle: 2, verdict: 'keep', findings: 'W8A8 doubles QPS\nClean SLA pass at c=16', options: [{ k: 'd2', title: 'next', why: 'keep tuning', cites: [`${id}-cycle-1`] }] }, now + 1600).ok, true);

  // sliceMatrix aggregated deterministic pass/fail per slice against p99 <= 80 threshold
  const r2Slices = sliceMatrix(d, d.rounds[1]);
  assert.equal(r2Slices.length, 1);
  const c16Ctrl = r2Slices[0].cells.find((c) => c.group === 'control' && c.at === 16);
  const c16Cand = r2Slices[0].cells.find((c) => c.group === 'change' && c.at === 16);
  assert.equal(c16Ctrl.pass, false);
  assert.equal(c16Cand.pass, true);
  assert.equal(c16Cand.stats.qps.mean, 130);

  // Default console view on round 2: slice view active, 8/8 guards summarized in 1 badge, 2 paired columns
  const vmSlice = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v3>c1.eval` });
  const tbl = vmSlice.cycle.compare.table;
  assert.equal(tbl.hasSlices, true);
  assert.equal(tbl.isSliceView, true);
  assert.equal(tbl.activeView, 'slice:load');
  assert.equal(tbl.guardSummary.text, '质量护栏 8/8 全部通过');
  assert.equal(tbl.columns.length, 2);
  assert.equal(tbl.sliceTable.rows.length, 3);
  assert.equal(tbl.sliceTable.rows[2].diff.ratio, '2×');
  assert.equal(tbl.sliceTable.rows[2].diff.delta, '+65');
  assert.equal(tbl.sliceTable.rows[2].diff.better, 'better');

  // Switch to scalar view: >3 passing guardrails auto-collapse into 1 summary section (defaultOpen=false)
  const vmScalar = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v3>c1.eval`, cmpView: 'scalar' });
  const scTbl = vmScalar.cycle.compare.table;
  assert.equal(scTbl.isSliceView, false);
  const passSec = scTbl.sections.find((s) => s.k === 'guard_pass');
  assert.equal(passSec.defaultOpen, false);
  assert.equal(passSec.title, '已通过护栏 8 项（点击展开）');
  assert.equal(passSec.rows.length, 8);

  // User customization via chips: remove stat p50 -> statCustomized=true; add historical E1 column -> crossCycle & sameScale=false
  const p50Chip = tbl.statChips.find((c) => c.id === 'p50');
  const vmNoP50 = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v3>c1.eval`, cmpStats: p50Chip.removeVal });
  assert.equal(vmNoP50.cycle.compare.table.statCustomized, true);
  assert.deepEqual(vmNoP50.cycle.compare.table.statChips.map((c) => c.id), ['qps', 'p99']);

  const e1Add = tbl.addColumns.find((c) => c.id === 'c1:control');
  assert.ok(e1Add, 'historical cycle 1 must be in addColumns');
  assert.match(e1Add.menuLabel, /不同量尺 E1/);
  // Compare E1 (c1:control) directly against E2 (c2:change) -> delta MUST be suppressed!
  const vmCrossScale = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v3>c1.eval`, cmpCols: `${id}:2|c1:control,c2:change` });
  assert.equal(vmCrossScale.cycle.compare.table.colCustomized, true);
  assert.equal(vmCrossScale.cycle.compare.table.pairSameScale, false);
  assert.equal(vmCrossScale.cycle.compare.table.pairReferenceOnly, true);
  assert.equal(vmCrossScale.cycle.compare.table.sliceTable.rows[0].diff.suppressed, true);
  const vmCrossScaleScalar = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v3>c1.eval`, cmpView: 'scalar', cmpCols: `${id}:2|c1:control,c2:change` });
  assert.equal(vmCrossScaleScalar.cycle.compare.table.sections[0].rows[0].deltaSuppressed, true);
  assert.equal(vmCrossScaleScalar.cycle.compare.table.sections[0].rows[0].statusText, '量尺不同');

  // Add a specific passing guardrail into metric chips via cmpMetrics
  const addG1 = scTbl.addMetrics.find((m) => m.id === 'g1');
  const vmWithG1 = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v3>c1.eval`, cmpView: 'scalar', cmpMetrics: addG1.addVal });
  assert.equal(vmWithG1.cycle.compare.table.metricCustomized, true);
  assert.ok(vmWithG1.cycle.compare.table.metricChips.some((c) => c.id === 'g1'));

  // Round 3 single-group explore (skipControl=true) on E2: v4's parent is v3 (120 QPS on c2), while currentVersion is still v2 (60 QPS on c2).
  // P1-1: default reference MUST pick parent v3 (v3 · C2), NOT ancient currentVersion v2, so v4's 100 QPS shows honest -20 regression!
  // P1-2: even if reference v3 had a failed guardrail (g3=9) while candidate v4 passes g3=0 and only fails g2, guardSummary MUST count only v4's 1 failure (7/8, NOT 6/8)!
  d.rounds[1].runs.filter((u) => u.group === 'change').forEach((u) => { u.metrics.g3 = 9; });
  d.rounds[1].report.matrix.find((m) => m.group === 'change' && m.metric === 'g3').mean = 9;
  const r2ChangeJudged = d.rounds[1].report.compare.groups.find((g) => g.group === 'change');
  r2ChangeJudged.guardrails.filter((g) => g.metric === 'g3').forEach((g) => { g.value = 9; g.pass = false; });
  d.rounds.push({
    n: 3, version: 'v4', start: now + 3000, end: now + 3500, state: 'evaluating',
    plan: { baseline: false, tier: 'explore', skipControl: true, groups: [{ id: 'change', label: 'Explore', version: 'v4', vars: {}, control: false }], seeds: [31] },
    metrics: structuredClone(d.metrics),
    runs: [{
      id: 'r3-g-31', group: 'change', seed: 31, state: 'done',
      metrics: { 'max-qps': 100, ...zeroGuards, g2: 0.05, 'aux-mem': 10 },
      slices: { load: [{ at: 1, values: { qps: 80, p50: 9, p99: 16 } }, { at: 8, values: { qps: 100, p50: 25, p99: 55 } }] },
      env: {},
    }],
    report: null, decision: null, events: [],
  });
  assert.equal(conclude(state, d, { cycle: 3, verdict: 'tune', findings: 'Explore regressed vs parent v3 and g2 crossed', options: [{ k: 'd3', title: 'fix g2', why: 'guardrail', cites: [`${id}-cycle-2`] }] }, now + 3600).ok, true);
  const vmExplore = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v4>c1.eval` });
  assert.equal(vmExplore.cycle.compare.table.columns.length, 2);
  assert.equal(vmExplore.cycle.compare.table.columns[0].id, 'c2:change', 'P1-1: must default reference to lineage parent v3, not currentVersion v2');
  assert.equal(vmExplore.cycle.compare.table.columns[0].label, 'v3 · C2', 'P1-1: cross-cycle header must show version · C<n>');
  assert.equal(vmExplore.cycle.compare.table.columns[0].crossCycle, true);
  assert.match(vmExplore.cycle.compare.table.columns[0].chipLabel, /v3 · C2 · 跨周期参考/);
  assert.equal(vmExplore.cycle.compare.table.pairReferenceOnly, true);
  assert.equal(vmExplore.cycle.compare.table.sliceTable.rows[1].diff.delta, '-20', 'P1-1: delta must reflect -20 regression vs parent v3');
  assert.equal(vmExplore.cycle.compare.table.guardSummary.text, '质量护栏 通过 7/8 · 1 项越线', 'P1-2: reference v3 g3 failure must not taint v4 guardrail summary');
  const vmExploreScalar = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v4>c1.eval`, cmpView: 'scalar' });
  const failSec3 = vmExploreScalar.cycle.compare.table.sections.find((s) => s.k === 'guard_fail');
  assert.deepEqual(failSec3.rows.map((r) => r.id), ['g2'], 'P1-2: only candidate v4 failed guardrail g2 appears in guard_fail, not ref-only g3');
  const passSec3 = vmExploreScalar.cycle.compare.table.sections.find((s) => s.k === 'guard_pass');
  const g3Row = passSec3.rows.find((r) => r.id === 'g3');
  assert.equal(g3Row.status, 'pass', 'P1-2: g3 passes on evaluated v4');
  assert.equal(g3Row.cells[0].guard, 'fail', 'P1-2: reference cell still marks its own failure');

  // Unmeasured candidate guardrails (null values) must be reported as 未测 (missing), NEVER as 越线 (fail);
  // and a probe-only cycle with all-null formal metrics must report 本轮未产出正式指标 instead of N crossed rows.
  d.versions.push(
    { id: 'v4b', parent: 'v3', change: 'Partial unmeasured guards', config: {}, at: now + 3700, current: false, status: 'proposed' },
  );
  d.rounds.push({
    n: 4, version: 'v4b', start: now + 3700, end: now + 3750, state: 'evaluating',
    plan: { baseline: false, tier: 'explore', skipControl: true, groups: [{ id: 'change', label: 'Partial', version: 'v4b', vars: {}, control: false }], seeds: [32] },
    metrics: structuredClone(d.metrics),
    runs: [{
      id: 'r4-g-32', group: 'change', seed: 32, state: 'done',
      metrics: { 'max-qps': 95, ...zeroGuards, g2: 0.08, g6: null, g7: null, 'aux-mem': 10 },
      env: {},
    }],
    report: null, decision: null, events: [],
  });
  assert.equal(conclude(state, d, { cycle: 4, verdict: 'tune', findings: 'Partial guards unmeasured', options: [{ k: 'd4', title: 'next', why: 'ok', cites: [`${id}-cycle-3`] }] }, now + 3760).ok, true);
  const vmPartial = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v4b>c1.eval`, cmpView: 'scalar' });
  assert.equal(vmPartial.cycle.compare.table.guardSummary.text, '质量护栏 通过 5/6 · 1 项越线 · 2 项未测');
  assert.deepEqual(vmPartial.cycle.compare.table.sections.find((s) => s.k === 'guard_fail').rows.map((r) => r.id), ['g2']);
  const missRows4 = vmPartial.cycle.compare.table.sections.find((s) => s.k === 'missing').rows;
  assert.deepEqual(missRows4.map((r) => r.id), ['g6', 'g7']);
  assert.equal(missRows4.every((r) => r.status === 'missing' && r.statusText === '未测'), true);
  const partialMd = formatComparisonMarkdown(d, d.rounds[3]);
  assert.match(partialMd, /质量护栏 通过 5\/6 · 1 项越线 · 2 项未测/);

  // alpha.119: (a) mixed measured+null seeds -> 部分未测; (b) multi-candidate with one passing & one unmeasured -> 部分未测 (NOT 全部通过);
  // (c) paired cycle where same-cycle control measured metrics but candidate is all-null -> 候选未产出正式指标.
  const allNullMetrics = Object.fromEntries(d.metrics.items.map((m) => [m.id, null]));
  d.versions.push(
    { id: 'v4c', parent: 'v4b', change: 'Device probe only', config: {}, at: now + 3800, current: false, status: 'proposed' },
    { id: 'v4d', parent: 'v3', change: 'Partial seed & multi-cand', config: {}, at: now + 3850, current: false, status: 'proposed' },
    { id: 'v4e', parent: 'v3', change: 'Control ok cand null', config: {}, at: now + 3900, current: false, status: 'proposed' },
  );
  d.rounds.push({
    n: 5, version: 'v4c', start: now + 3800, end: now + 3820, state: 'evaluating',
    plan: { baseline: false, tier: 'explore', skipControl: true, groups: [{ id: 'change', label: 'ProbeOnly', version: 'v4c', vars: {}, control: false }], seeds: [33] },
    metrics: structuredClone(d.metrics),
    runs: [{
      id: 'r5-g-33', group: 'change', seed: 33, state: 'done',
      error: { kind: 'real', step: 'collect', raw: 'Non-finite or missing metrics' },
      metrics: allNullMetrics,
      env: {},
    }],
    report: null, decision: null, events: [],
  });
  assert.equal(conclude(state, d, { cycle: 5, verdict: 'tune', findings: 'Device probe negative result', options: [{ k: 'd5', title: 'next', why: 'ok', cites: [`${id}-cycle-4`] }] }, now + 3830).ok, true);
  const vmNoOutput = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v4c>c1.eval`, cmpView: 'scalar' });
  assert.equal(vmNoOutput.cycle.compare.table.guardSummary.kind, 'noOutput');
  assert.equal(vmNoOutput.cycle.compare.table.guardSummary.failed, 0);
  assert.equal(vmNoOutput.cycle.compare.table.guardSummary.text, '本轮未产出正式指标');
  assert.equal(vmNoOutput.cycle.compare.table.sections.find((s) => s.k === 'guard_fail'), undefined);
  assert.equal(formatComparisonMarkdown(d, d.rounds[4]), '> 本轮未产出正式指标');

  // Round 6: single candidate with 2 seeds where g8 has 1 finite pass + 1 null -> 部分未测
  d.rounds.push({
    n: 6, version: 'v4d', start: now + 3850, end: now + 3870, state: 'evaluating',
    plan: { baseline: false, tier: 'explore', skipControl: true, groups: [{ id: 'change', label: 'MixedSeeds', version: 'v4d', vars: {}, control: false }], seeds: [34, 35] },
    metrics: structuredClone(d.metrics),
    runs: [
      { id: 'r6-34', group: 'change', seed: 34, state: 'done', metrics: { 'max-qps': 110, ...zeroGuards, 'aux-mem': 10 }, env: {} },
      { id: 'r6-35', group: 'change', seed: 35, state: 'done', metrics: { 'max-qps': 112, ...zeroGuards, g8: null, 'aux-mem': 10 }, env: {} },
    ],
    report: null, decision: null, events: [],
  });
  assert.equal(conclude(state, d, { cycle: 6, verdict: 'tune', findings: 'One seed missing g8', options: [{ k: 'd6', title: 'next', why: 'ok', cites: [`${id}-cycle-5`] }] }, now + 3880).ok, true);
  const vmMixedSeeds = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v4d>c1.eval`, cmpView: 'scalar' });
  const g8Row = vmMixedSeeds.cycle.compare.table.sections.find((s) => s.k === 'missing').rows.find((r) => r.id === 'g8');
  assert.equal(g8Row.status, 'warn');
  assert.equal(g8Row.statusText, '部分未测');
  assert.equal(vmMixedSeeds.cycle.compare.table.guardSummary.text, '质量护栏 通过 7/7 · 1 项未测');

  // Round 7: paired cycle where control measured metrics, candidate produced all nulls -> 候选未产出正式指标
  d.rounds.push({
    n: 7, version: 'v4e', start: now + 3900, end: now + 3920, state: 'evaluating',
    plan: {
      baseline: false, tier: 'confirm',
      groups: [
        { id: 'control', label: '对照', version: 'v2', vars: {}, control: true },
        { id: 'change', label: 'CandNull', version: 'v4e', vars: {}, control: false },
      ],
      seeds: [36],
    },
    metrics: structuredClone(d.metrics),
    runs: [
      { id: 'r7-c-36', group: 'control', seed: 36, state: 'done', metrics: { 'max-qps': 60, ...zeroGuards, 'aux-mem': 14 }, env: {} },
      { id: 'r7-g-36', group: 'change', seed: 36, state: 'done', error: { kind: 'real', step: 'collect', raw: 'missing metrics' }, metrics: allNullMetrics, env: {} },
    ],
    report: null, decision: null, events: [],
  });
  assert.equal(conclude(state, d, { cycle: 7, verdict: 'insufficient', findings: 'Candidate produced no metrics', options: [{ k: 'd7', title: 'next', why: 'ok', cites: [`${id}-cycle-6`] }] }, now + 3930).ok, true);
  const vmNoCand = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v4e>c1.eval`, cmpView: 'scalar' });
  assert.equal(vmNoCand.cycle.compare.table.guardSummary.kind, 'noCandOutput');
  assert.equal(vmNoCand.cycle.compare.table.guardSummary.text, '候选未产出正式指标');
  assert.equal(formatComparisonMarkdown(d, d.rounds[6]), '> 候选未产出正式指标');

  // Multi-candidate: Cand A all pass, Cand B all-null guardrails -> row must be 部分未测 (warn), NOT 全部通过!
  const multiObj = arith();
  multiObj.d.rounds[0].runs.filter((u) => u.group === 'lr-low').forEach((u) => { u.metrics.signal = 0.5; u.metrics.tail = 0.2; });
  multiObj.d.rounds[0].runs.filter((u) => u.group === 'format-zero').forEach((u) => { u.metrics.signal = null; u.metrics.tail = null; });
  assert.equal(conclude(multiObj.s, multiObj.d, { cycle: 1, verdict: 'tune', findings: 'cand B missing guards', options: [option('m1', 'variable', 'lr')] }, now + 3950).ok, true);
  const multiTbl = multiObj.view('eval').cycle.compare.table;
  const multiMiss = multiTbl.sections.find((s) => s.k === 'missing').rows;
  assert.deepEqual(multiMiss.map((r) => [r.id, r.status, r.statusText]), [['signal', 'warn', '部分未测'], ['tail', 'warn', '部分未测']]);
  assert.equal(multiTbl.guardSummary.kind, 'unmeasured');
  assert.equal(multiTbl.guardSummary.passed, 0);

  // P2-1: multi-group same-version cycle disambiguates candidate column headers with group name
  const arithObj = arith();
  assert.equal(conclude(arithObj.s, arithObj.d, { cycle: 1, verdict: 'tune', findings: 'multi-arm v1', options: [option('o1', 'variable', 'lr')] }, now + 4000).ok, true);
  const arithTbl = arithObj.view('eval').cycle.compare.table;
  assert.deepEqual(arithTbl.columns.map((c) => c.label), ['对照 v1', '候选 只降学习率 (v1)', '候选 去掉格式奖励 (v1)']);

  // 3) Render rsiCompareMatrix in node:vm for sliced view (grouped headers, PASS/FAIL, ratio, seed expansion) + P2-2 English i18n labels
  const vmMod = await import('node:vm');
  const { parse: parseYaml } = await import('yaml');
  const enPack = parseYaml(readFileSync(new URL('../console/i18n/en.yaml', import.meta.url), 'utf8'));
  const src = readFileSync(new URL('../console/components/lineage.js', import.meta.url), 'utf8');
  const sb = {
    PDL_COMPONENTS: {},
    S: { folds: { ['rsi-cmp-slice:v3-1:load:16']: true } },
    h: (s) => String(s ?? ''),
    pv: (e) => e === '$.slice' ? tbl : e === '$.cross' ? vmExplore.cycle.compare.table : e === '$.scalar' ? vmScalar.cycle.compare.table : e,
    pvList: () => [],
    pvText: (v) => String(v ?? ''),
  };
  vmMod.runInNewContext(src, sb);
  const sliceHtml = sb.PDL_COMPONENTS['plugin:official.rsi/rsiCompareMatrix']({ from: '$.slice' }, {}, {});
  assert.match(sliceHtml, /class="rsi-mx rsi-mx-slice"/);
  assert.doesNotMatch(sliceHtml, /class="scroll-x rsi-mx-scroll"/, 'slice scroll container must not attach Host scroll-x fade mask over sticky col');
  assert.match(sliceHtml, /rowspan="2"/);
  assert.match(sliceHtml, /colspan="4"/);
  assert.match(sliceHtml, /PASS/);
  assert.match(sliceHtml, /FAIL/);
  assert.match(sliceHtml, /2× \/ \+65/);
  assert.match(sliceHtml, /质量护栏 8\/8 全部通过/);
  assert.match(sliceHtml, /class="rsi-mx-seed-row"/);
  const crossHtml = sb.PDL_COMPONENTS['plugin:official.rsi/rsiCompareMatrix']({ from: '$.cross' }, {}, {});
  assert.doesNotMatch(crossHtml, /class="scroll-x rsi-mx-scroll"/, 'cross-cycle scroll container must not attach Host scroll-x fade mask over sticky col');
  assert.match(crossHtml, /跨周期参考/);
  assert.match(crossHtml, /v3 · C2/);
  const zhScalarHtml = sb.PDL_COMPONENTS['plugin:official.rsi/rsiCompareMatrix']({ from: '$.scalar' }, {}, {});
  assert.doesNotMatch(zhScalarHtml, /class="scroll-x rsi-mx-scroll"/, 'scalar scroll container must not attach Host scroll-x fade mask over sticky col');
  assert.match(zhScalarHtml, /class="rsi-mx-sec-in"/, 'section header must wrap sticky inner span');
  assert.match(zhScalarHtml, /已通过护栏 8 项（点击展开）<\/span><\/span><\/button>/, 'collapsed guardrail summary must not append duplicate count span');
  // alpha.120: horizontal toolbar chips (no .vstack/stack wrapper) + sticky column CSS specificity > Host page.css (0,3,0)
  assert.equal(tbl.colsRemovable, true);
  assert.equal(tbl.statsRemovable, true);
  assert.equal(vmScalar.cycle.compare.table.metricsRemovable, true);
  const vmOneCol = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v3>c1.eval`, cmpView: 'scalar', cmpCols: tbl.columns[0].removeVal, cmpMetrics: `${id}|max-qps` });
  assert.equal(vmOneCol.cycle.compare.table.colsRemovable, false);
  assert.equal(vmOneCol.cycle.compare.table.metricsRemovable, false);
  const pdlSrc = readFileSync(new URL('../console/pdl.yaml', import.meta.url), 'utf8');
  const cmpToolbarSlice = pdlSrc.slice(pdlSrc.indexOf('rsi.cmp.colsLabel'), pdlSrc.indexOf('plugin:official.rsi/rsiCompareMatrix'));
  assert.doesNotMatch(cmpToolbarSlice, /\btype:\s*stack\b/, 'comparison chip toolbars must not wrap chips in vertical stack (.vstack)');
  const cssSrc = readFileSync(new URL('../console/components/lineage.css', import.meta.url), 'utf8');
  assert.match(cssSrc, /\.rsi-mx-scroll \.rsi-mx tbody tr > td\.rsi-mx-col-m/, 'sticky body column selector must beat Host tbody tr + tr > td specificity');
  assert.match(cssSrc, /border-collapse:separate/, 'sticky table must use border-collapse:separate');
  assert.match(cssSrc, /\.pop-center:has\(\.rsi-map-wrap\.is-modal\)\{padding:var\(--sp-l\)\}/, 'modal overview map must remove .pop-center top gap');
  assert.match(cssSrc, /\[data-shell="v2"\] \.v2-confirm-dialog\):has\(\.rsi-map-wrap\.is-modal\)/, 'v2 modal fill selector must anchor on [data-shell="v2"] (top-layer pop-host is outside .v2-shell)');
  assert.doesNotMatch(cssSrc, /\.v2-shell \.v2-confirm-dialog:has\(\.rsi-map-wrap\.is-modal\)/, 'must not scope modal dialog under .v2-shell which misses top-layer popover dialogs');
  // P2-2: English labels render without leaked Chinese chrome
  const enScalarHtml = sb.PDL_COMPONENTS['plugin:official.rsi/rsiCompareMatrix']({ from: '$.scalar', labels: enPack.cmp }, {}, {});
  assert.match(enScalarHtml, /Guardrails 8\/8 passed/);
  assert.match(enScalarHtml, /Primary metric/);
  assert.match(enScalarHtml, /Beats control/);
  assert.doesNotMatch(enScalarHtml, /质量护栏|主指标|胜过对照/);

  // 4) Chat conclusion card Markdown table (both sliced & flat scalar)
  const sliceMd = formatComparisonMarkdown(d, d.rounds[1]);
  assert.match(sliceMd, /> 质量护栏 通过 7\/8 · 1 项越线/);
  assert.match(sliceMd, /\| 并发 \|/);
  assert.match(sliceMd, /2× \/ \+65/);
  assert.match(sliceMd, /PASS/);
  assert.match(sliceMd, /\*\*FAIL\*\*/);
  assert.doesNotMatch(sliceMd, /质量护栏4/, 'passing guardrails must stay rolled up, not spammed into chat');
  const exploreMd = formatComparisonMarkdown(d, d.rounds[2]);
  assert.match(exploreMd, /v3 · C2 \(跨周期参考\)/);
  assert.match(exploreMd, /-20/);
  assert.match(exploreMd, /越线护栏：质量护栏2/);
  assert.doesNotMatch(exploreMd, /质量护栏3/, 'P1-2: reference g3 failure must not appear in candidate v4 chat failed guardrails');
  // Verify conclusionCard message in state.outbox includes the Markdown table
  const conclMsg = state.outbox.find((e) => e.kind === 'message' && e.objective === id && e.message?.title?.includes('第 2 周期结论'));
  assert.ok(conclMsg && conclMsg.message.body.includes('| 并发 |'));

  // 5) Slim exp payload check on a 25-round objective
  const bigD = state.experiments[id];
  for (let n = 8; n <= 25; n++) {
    bigD.versions.push({ id: `v${n + 1}`, parent: `v${n}`, change: `iter ${n}`, config: {}, at: now + n * 1000, current: false, status: 'proposed' });
    bigD.rounds.push({
      n, version: `v${n + 1}`, start: now + n * 1000, end: now + n * 1000 + 500, state: 'done',
      plan: { baseline: false, groups: [{ id: 'control', label: '对照', version: 'v2', vars: {}, control: true }, { id: 'change', label: `iter ${n}`, version: `v${n + 1}`, vars: {}, control: false }], seeds: [100 + n] },
      runs: [{ id: `r-${n}`, group: 'change', seed: 100 + n, state: 'done', metrics: { 'max-qps': 100 + n, ...zeroGuards, 'aux-mem': 12 }, attempts: [{ start: now, end: now + 100, log: 'x'.repeat(200) }], env: {} }],
      report: { verdict: 'tune', headline: `r${n}`, summary: `r${n}`, matrix: [{ group: 'change', metric: 'max-qps', mean: 100 + n, sd: null, n: 1, seeds: [{ seed: 100 + n, value: 100 + n, state: 'done' }] }], directions: [], predictions: [], compare: { comparable: true, groups: [] }, attribution: { assessedLayers: [] } },
      decision: { pick: 'same', by: 'RSI', at: now + n * 1000 + 600 }, events: [],
    });
  }
  const bigVm = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v3>c1.eval` });
  assert.equal(bigVm.prep.dagNodes.every((n) => !('items' in n)), true, 'dagNodes must not duplicate prep items');
  assert.equal(bigVm.cycle.report.matrix, undefined, 'cycle.report.matrix must be omitted to avoid duplicating compare');
  assert.equal(bigVm.cycle.runs[0].attempts, undefined, 'enriched runs must strip raw attempts array');
  const bytes = Buffer.byteLength(JSON.stringify(bigVm));
  assert.ok(bytes < 150_000, `expected slim exp payload < 150 KB for 25-round objective, got ${bytes} bytes`);
});

test('alpha.133: real exp view builds interactive E1->E2 metrics lineage with diff & cycle conclusions and C1->C2 collect lineage retroactively', () => {
  const { state } = createFixtures(now);
  const project = 'cartpole';
  const o = rsiExpNew(state, project, { statement: 'Ascend BGE multi-card', prepare: 'codex', evaluate: 'codex', iterate: 'codex', auto: 'none' }, now);
  const id = o.id;
  const d = state.experiments[id];
  const e1 = {
    version: 'E1',
    items: [
      { id: 'qps-short', name: '短文吞吐', dir: 'up', line: '≥ 8 req/s', how: '短文有效吞吐', guard: false, locked: true },
      { id: 'card-imbalance', name: '卡间不均', dir: 'down', line: '≤ 15%', how: '按请求数计算', guard: true, locked: true },
    ],
    slices: [{ id: 'mixed-ladder', name: '混合梯度', stats: [{ id: 'p99-t2-ms', name: 'T2 P99', dir: 'down', line: '待定' }] }],
  };
  const e2 = {
    version: 'E2',
    items: [
      { id: 'qps-short', name: '短文吞吐', dir: 'up', line: '≥ 8 req/s', how: '短文有效吞吐', guard: false, locked: true },
      { id: 'card-imbalance', name: '卡间不均', dir: 'down', line: '≤ 15%', how: '按设备忙碌时间计算', guard: true, locked: true },
    ],
    slices: [{ id: 'mixed-ladder', name: '混合梯度', stats: [{ id: 'p99-t2-ms', name: 'T2 P99', dir: 'down', line: '≤ 210 ms' }] }],
  };
  d.metrics = structuredClone(e2);
  d.stepHistory = {
    rules: [
      { rev: 1, at: now, by: 'opus', next: '初始化 E1 量尺' },
      { rev: 2, at: now + 2000, by: 'opus', next: '冻结 E2 长文门限并改用忙碌时间口径' },
    ],
    run: [
      { rev: 1, at: now, by: 'cat-drby1x4c', next: 'CPU 占位执行器' },
      { rev: 2, at: now + 1500, by: 'cat-drby1x4c', next: '切换四卡实机执行器' },
    ],
  };
  d.steps.run = { rev: 2, stale: false, redo: false, next: '切换四卡实机执行器' };
  d.executor = { state: 'passed', commands: { preflight: 'py preflight', submit: 'py submit', collect: 'py collect' }, timeout: 2100, poll: 15 };
  d.versions = [
    { id: 'v1', parent: null, change: 'init', config: {}, at: now, current: false, status: null },
    { id: 'v2', parent: 'v1', change: 'device exec', config: {}, at: now + 1000, current: false, status: 'confirmed' },
    { id: 'v3', parent: 'v2', change: 'host config', config: {}, at: now + 2000, current: true, status: 'confirmed' },
  ];
  d.objective.currentVersion = 'v3';
  d.objective.state = 'running';
  d.rounds = [
    {
      n: 1, version: 'v1', start: now + 100, end: now + 200, state: 'done', metrics: structuredClone(e1),
      plan: { groups: [{ id: 'control', label: '对照', version: 'v1', vars: {}, control: true }], seeds: [1] },
      runs: [{ id: 'r1', group: 'control', seed: 1, state: 'done', metrics: { 'qps-short': null, 'card-imbalance': null }, attempts: [], env: {} }],
      report: { verdict: 'insufficient', tag: 'CPU 占位', headline: 'C1 CPU 占位无实机样本', summary: 'C1', matrix: [], directions: [{ id: 'd1', title: '接通设备执行器' }], predictions: [], compare: { comparable: false, groups: [] }, attribution: { assessedLayers: [] } },
      decision: { pick: 'direction', directionId: 'd1', by: '墨墨', at: now + 250 }, events: [],
    },
    {
      n: 2, version: 'v2', start: now + 1100, end: now + 1200, state: 'done', metrics: structuredClone(e1),
      plan: { groups: [{ id: 'control', label: '对照', version: 'v2', vars: {}, control: true }], seeds: [2] },
      runs: [{ id: 'r2', group: 'control', seed: 2, state: 'failed', metrics: {}, attempts: [], env: {} }],
      report: { verdict: 'insufficient', tag: '校准完成', headline: 'C2 设备校准完成，建议升 E2', summary: 'C2', matrix: [], directions: [{ id: 'd2', title: '固定 Host Python 与 config.json' }], predictions: [], compare: { comparable: false, groups: [] }, attribution: { assessedLayers: [] } },
      decision: { pick: 'direction', directionId: 'd2', by: '墨墨', at: now + 1250 }, events: [],
    },
    {
      n: 3, version: 'v3', start: now + 2100, end: null, state: 'running', metrics: structuredClone(e2),
      plan: { groups: [{ id: 'control', label: '对照', version: 'v3', vars: {}, control: true }], seeds: [3] },
      runs: [{ id: 'r3', group: 'control', seed: 3, state: 'running', metrics: {}, attempts: [], env: {} }],
      report: null, decision: null, events: [],
    },
  ];

  // Default view selects current E2 and reconstructs E1 -> E2 even without d.metricHistory.
  const vmE2 = viewModel(state, 'exp', { project, pick: `obj:${id}` });
  assert.deepEqual(vmE2.eTree.map((n) => [n.id, n.parentKey, n.nodeState]), [['E1', null, ''], ['E2', `${id}/E1`, 'current']]);
  assert.deepEqual(vmE2.eTree[0].versionsUsed, ['v1', 'v2']);
  assert.deepEqual(vmE2.eTree[1].versionsUsed, ['v3']);
  assert.equal(vmE2.eSel.id, 'E2');
  assert.equal(vmE2.eSel.hasDiff, true);
  assert.equal(vmE2.eSel.diff.parent, 'E1');
  assert.equal(vmE2.eSel.diff.mod, 2); // card-imbalance formula + mixed-ladder p99-t2-ms line
  assert.equal(vmE2.eSel.diffChanges.some((c) => c.title.includes('卡间不均') && c.detail.includes('按设备忙碌时间计算')), true);
  assert.equal(vmE2.eSel.diffChanges.some((c) => c.title.includes('T2 P99') && c.detail.includes('≤ 210 ms')), true);
  assert.equal(vmE2.eSel.cycleSummaries.length, 1);
  assert.equal(vmE2.eSel.cycleSummaries[0].n, 3);
  assert.equal(vmE2.eSel.cycleSummaries[0].verdict, 'running');

  // Selecting E1 switches detail pane to E1's metrics and Cycle 1-2 conclusions.
  const vmE1 = viewModel(state, 'exp', { project, pick: `obj:${id}`, selE: `${id}/E1>node` });
  assert.equal(vmE1.eSel.id, 'E1');
  assert.equal(vmE1.eSel.hasDiff, false);
  assert.equal(vmE1.eSel.items.find((m) => m.id === 'card-imbalance').how, '按请求数计算');
  assert.deepEqual(vmE1.eSel.cycleSummaries.map((c) => [c.n, c.verdict, c.decisionText]), [
    [1, 'insufficient', '接通设备执行器'],
    [2, 'insufficient', '固定 Host Python 与 config.json'],
  ]);

  // Collection lineage reconstructs C1 -> C2 from stepHistory.run and switches cleanly via selC.
  assert.deepEqual(vmE2.cTree.map((n) => [n.id, n.parentKey, n.nodeState]), [['C1', null, ''], ['C2', `${id}/C1`, 'current']]);
  assert.equal(vmE2.cSel.id, 'C2');
  assert.equal(vmE2.cSel.hasOps, true);
  const vmC1 = viewModel(state, 'exp', { project, pick: `obj:${id}`, selC: `${id}/C1>node` });
  assert.equal(vmC1.cSel.id, 'C1');
  assert.equal(vmC1.cSel.note, 'CPU 占位执行器');

  // Legacy compacted state (pre-alpha.133 live objective where C1/C2 round.metrics were deleted before E2 upgrade):
  // E1 is reconstructed from stepHistory.rules[0], C1/C2 are attributed to E1 by timestamp, and C3 to E2.
  delete d.rounds[0].metrics;
  delete d.rounds[1].metrics;
  delete d.metricHistory;
  d.steps.rules = { rev: 2, stale: false, redo: false, next: '冻结 E2 长文门限' };
  d.stepHistory.rules[0].items = [{ id: 'rule-e1-short', title: 'E1 短文门限', value: 'T1 P99 ≤ 80 ms' }];
  const vmLegacy = viewModel(state, 'exp', { project, pick: `obj:${id}` });
  assert.deepEqual(vmLegacy.eTree.map((n) => [n.id, n.parentKey, n.nodeState]), [['E1', null, ''], ['E2', `${id}/E1`, 'current']]);
  assert.deepEqual(vmLegacy.eTree[0].versionsUsed, ['v1', 'v2']);
  assert.deepEqual(vmLegacy.eTree[1].versionsUsed, ['v3']);
  assert.equal(vmLegacy.eSel.hasDiff, false); // no bogus item diff against legacy prep-card fallback
  const vmLegacyE1 = viewModel(state, 'exp', { project, pick: `obj:${id}`, selE: `${id}/E1>node` });
  assert.equal(vmLegacyE1.eSel.items[0].name, 'E1 短文门限');
  assert.deepEqual(vmLegacyE1.eSel.cycleSummaries.map((c) => c.n), [1, 2]);
});

test('unified roundMetrics / roundMetricVersion keeps compare table cross-scale warnings, thresholds, closeout report, and rubric aspects consistent after compaction', async () => {
  const { buildCloseoutReport } = await import('../dist/cycles.js');
  const { buildComparisonTable } = await import('../dist/compare.js');
  const { compact } = await import('../dist/store.js');
  const x = arith();
  const { s: state, d, id } = x;
  const project = P;
  const e1 = {
    version: 'E1',
    items: [
      { id: 'qps', name: '吞吐', dir: 'up', unit: 'req/s', guard: false },
      { id: 'p99', name: 'P99 延迟', dir: 'down', unit: 'ms', guard: true, threshold: 100, line: '≤ 100 ms' },
    ],
    slices: [],
  };
  const e2 = {
    version: 'E2',
    items: [
      { id: 'qps', name: '吞吐', dir: 'up', unit: 'req/s', guard: false },
      { id: 'p99', name: 'P99 延迟', dir: 'down', unit: 'ms', guard: true, threshold: 210, line: '≤ 210 ms' },
    ],
    slices: [],
  };
  d.versions = [
    { id: 'v1', parent: null, change: 'baseline', config: {}, at: now, current: false, status: 'confirmed' },
    { id: 'v2', parent: 'v1', change: 'e1 device', config: {}, at: now + 1000, current: false, status: 'confirmed' },
    { id: 'v3', parent: 'v2', change: 'e2 host cfg', config: {}, at: now + 2000, current: true, status: 'confirmed' },
  ];
  d.objective.currentVersion = 'v3';
  d.metrics = structuredClone(e1);
  d.steps.rules = { rev: 1, stale: false, redo: false, next: 'E1' };
  d.stepHistory = {
    rules: [
      { rev: 1, at: now, by: 'opus', next: 'E1' },
      { rev: 2, at: now + 1900, by: 'opus', next: 'E2' },
    ],
  };
  d.rounds = [
    {
      n: 1, version: 'v2', start: now + 1100, end: now + 1200, state: 'done', metrics: structuredClone(e1),
      plan: { groups: [{ id: 'control', label: 'v2', version: 'v2', vars: {}, control: true }], seeds: [1] },
      runs: [{ id: 'r1', group: 'control', seed: 1, state: 'done', metrics: { qps: 7.5, p99: 95 }, attempts: [], env: {} }],
      report: {
        verdict: 'keep', headline: 'C1 on E1', summary: 'C1',
        matrix: [
          { group: 'control', metric: 'qps', mean: 7.5, sd: null, n: 1, seeds: [{ seed: 1, value: 7.5, state: 'done' }] },
          { group: 'control', metric: 'p99', mean: 95, sd: null, n: 1, seeds: [{ seed: 1, value: 95, state: 'done' }] },
        ],
        directions: [], predictions: [], compare: { comparable: false, groups: [{ group: 'control', eligible: true, beatsControl: false, guardrails: [{ metric: 'p99', seed: 1, value: 95, threshold: 100, dir: 'down', pass: true }] }] },
        attribution: { assessedLayers: [] },
      },
      decision: null, events: [],
    },
  ];
  // Compact while d.metrics is E1 (stores r1.metricVersion='E1' and d.metricHistory=[E1], deletes r1.metrics).
  compact(state);
  assert.equal(d.rounds[0].metrics, undefined);
  assert.equal(d.rounds[0].metricVersion, 'E1');
  assert.equal(d.metricHistory.some((m) => m.version === 'E1'), true);

  // Upgrade d.metrics to E2 and add Cycle 2 (v3) on E2.
  d.metrics = structuredClone(e2);
  d.steps.rules = { rev: 2, stale: false, redo: false, next: 'E2' };
  d.rounds.push({
    n: 2, version: 'v3', start: now + 2100, end: now + 2200, state: 'done', metrics: structuredClone(e2),
    plan: { tier: 'explore', skipControl: true, groups: [{ id: 'change', label: 'v3', version: 'v3', vars: {}, control: false }], seeds: [2] },
    runs: [{ id: 'r2', group: 'change', seed: 2, state: 'done', metrics: { qps: 8.1, p99: 140 }, attempts: [], env: {} }],
    report: {
      verdict: 'keep', headline: 'C2 on E2', summary: 'C2',
      matrix: [
        { group: 'change', metric: 'qps', mean: 8.1, sd: null, n: 1, seeds: [{ seed: 2, value: 8.1, state: 'done' }] },
        { group: 'change', metric: 'p99', mean: 140, sd: null, n: 1, seeds: [{ seed: 2, value: 140, state: 'done' }] },
      ],
      directions: [], predictions: [], compare: { comparable: false, groups: [{ group: 'change', eligible: true, beatsControl: false, guardrails: [{ metric: 'p99', seed: 2, value: 140, threshold: 210, dir: 'down', pass: true }] }] },
      attribution: { assessedLayers: [] },
    },
    decision: null, events: [],
  });

  // 1. Comparison table on C2 (E2) refuses to silently auto-pull compacted cross-scale parent v2 (E1),
  //    labels it "不同量尺 E1" in addColumns, and suppresses delta when the user explicitly adds it!
  const defaultC2 = buildComparisonTable(d, d.rounds[1], d.rounds);
  assert.deepEqual(defaultC2.columns.map((c) => [c.version, c.metricVersion]), [['v3', 'E2']]);
  const addV2 = defaultC2.addColumns.find((c) => c.id === 'c1:control');
  assert.ok(addV2, 'v2 should be available in addColumns');
  assert.match(addV2.menuLabel, /不同量尺 E1/);
  const crossTable = buildComparisonTable(d, d.rounds[1], d.rounds, { cmpCols: addV2.addVal });
  const scales = Object.fromEntries(crossTable.columns.map((c) => [c.version, c.metricVersion]));
  assert.deepEqual(scales, { v2: 'E1', v3: 'E2' });
  assert.equal(crossTable.pairSameScale, false);
  const crossQps = crossTable.sections.flatMap((s) => s.rows).find((r) => r.id === 'qps');
  assert.equal(crossQps.deltaSuppressed, true);
  assert.equal(crossQps.delta, null);
  assert.equal(crossQps.statusText, '量尺不同');

  // 2. Cycle 1 comparison table preserves E1's guardrail threshold text (≤ 100 ms), NOT E2's (≤ 210 ms).
  const c1Table = buildComparisonTable(d, d.rounds[0], d.rounds);
  const c1P99 = c1Table.sections.flatMap((s) => s.rows).find((r) => r.id === 'p99');
  assert.equal(c1P99.ruleText, '≤ 100 ms');

  // 3. Closeout report annotates compacted E1 baseline cell with E1 (v2·C1·E1) since E1 !== current E2.
  const closeout = buildCloseoutReport(d);
  assert.match(closeout.markdown, /v2·C1·E1/);

  // 4. View model derives 'rubric' aspect on v3, and labels v2 & C1 as E1.
  const vm = viewModel(state, 'exp', { project, pick: `obj:${id}`, selO: `${id}/v2>c1.eval` });
  assert.equal(vm.versions.find((v) => v.id === 'v2').metricVersion, 'E1');
  assert.equal(vm.versions.find((v) => v.id === 'v3').aspects.includes('rubric'), true);
  assert.equal(vm.cycle.collectSummary.metricVersion, 'E1');
  assert.equal(vm.cycle.evalMetrics.version, 'E1');

  // 5. Legacy pre-alpha.133 compacted state (no metricHistory, no r1.metricVersion) STILL flags E1 vs E2 via stepHistory.rules timestamps.
  delete d.rounds[0].metricVersion;
  delete d.metricHistory;
  const legacyDefault = buildComparisonTable(d, d.rounds[1], d.rounds);
  const legacyAddV2 = legacyDefault.addColumns.find((c) => c.id === 'c1:control');
  assert.ok(legacyAddV2);
  assert.match(legacyAddV2.menuLabel, /不同量尺 E1/);
  const legacyCross = buildComparisonTable(d, d.rounds[1], d.rounds, { cmpCols: legacyAddV2.addVal });
  assert.deepEqual(Object.fromEntries(legacyCross.columns.map((c) => [c.version, c.metricVersion])), { v2: 'E1', v3: 'E2' });
  assert.equal(legacyCross.pairSameScale, false);
  assert.equal(legacyCross.sections.flatMap((s) => s.rows).find((r) => r.id === 'qps').deltaSuppressed, true);
  assert.match(buildCloseoutReport(d).markdown, /v2·C1·E1/);
});
