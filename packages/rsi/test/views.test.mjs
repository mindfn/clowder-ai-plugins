import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createFixtures } from '../dist/fixtures.js';
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
