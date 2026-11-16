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
    for (const [path, expected] of Object.entries(entry.fields)) {
      const value = path.split('.').reduce((at, key) => at?.[key], actual);
      // The plugin returns the hint's numbers; the console composes the sentence (the prototype composed it in the VM).
      const want = expected?.t === 'rsi.exp.firstOf' ? { i: expected.args[0], n: expected.args[1] } : expected;
      assert.deepEqual(value, want, `${entry.view} ${JSON.stringify(entry.query)} ${path}`);
    }
  }
});

test('home follows an objective thread; unrelated threads preserve the page selection', async () => {
  const f = fixture(); await f.seed();
  const response = await f.view({ project: 'cartpole', thread: 't-rsi-pd', list: 'true', wide: 'true' });
  assert.equal(response.payload.projectId, 'pd-infer');
  assert.deepEqual(response.payload.pick, { k: 'obj', id: 'pd-ttft', exp: true });
  assert.equal(response.payload.panelList, false);
  assert.equal(response.payload.wide, true);
  assert.equal((await f.view({ project: 'pd-infer', pick: 'library', thread: 'unrelated' })).payload.pick.k, 'library');
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
