import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixtures } from '../dist/fixtures.js';
import { bindObjectiveThread, recordInitExecution, rsiExpKick, submitInitStep } from '../dist/init.js';
import { confirmAll, draftAll, fixture, now } from './helpers.mjs';

const executing = (d) => Object.keys(d.exec).sort();

test('new objective → member queues → dependencies → stale 4–7 → ordered redo → confirmation → ready', async () => {
  const f = fixture(); await f.seed(); const id = await f.newObjective();
  let state = await f.read(), d = state.experiments[id];
  assert.deepEqual(executing(d), ['goal', 'scope']);
  assert.equal(d.members.find((m) => m.role === 'prepare').catId, 'prepare-id');
  assert.equal(d.members.find((m) => m.role === 'prepare').name, 'prepare-id');
  assert.equal(d.prep.find((p) => p.id === 'cp-stop').mine, true);
  assert.match(d.prep.find((p) => p.id === 'cp-stop').value, /20/);
  assert.equal(state.outbox[0].kind, 'createThread');
  assert.equal(d.objective.thread, null);
  await f.submit(id, 'goal');
  assert.deepEqual(executing((await f.read()).experiments[id]), ['scope']);
  await f.submit(id, 'scope');
  d = (await f.read()).experiments[id];
  assert.deepEqual(executing(d), ['rules', 'run']);
  assert.deepEqual(d.exec.rules.base, { goal: 1, scope: 1 });
  assert.equal(d.prep.find((p) => p.id === 'cp-good').state, 'submitted');
  await f.submit(id, 'run'); await f.submit(id, 'rules');
  assert.deepEqual(executing((await f.read()).experiments[id]), ['baseline', 'design']);
  await f.submit(id, 'design');
  assert.deepEqual(executing((await f.read()).experiments[id]), ['baseline', 'feedback']);
  await f.submit(id, 'feedback'); await f.submit(id, 'baseline');
  d = (await f.read()).experiments[id];
  assert.equal(d.objective.state, 'preparing'); assert.equal(Object.keys(d.steps).length, 7);
  assert.equal((await f.act({ op: 'prep', objective: id, id: 'cp-u-train', action: 'decide', decision: 'fixed' })).status, 200);
  d = (await f.read()).experiments[id];
  assert.deepEqual(Object.keys(d.steps).filter((k) => d.steps[k].stale).sort(), ['baseline', 'design', 'feedback', 'rules']);
  assert.equal(d.steps.goal.stale, false); assert.equal(d.steps.run.stale, false); assert.equal(d.steps.scope.stale, false);
  assert.equal((await f.act({ op: 'initRedo', objective: id })).status, 200);
  assert.deepEqual(executing((await f.read()).experiments[id]), ['rules']);
  await f.submit(id, 'rules');
  assert.deepEqual(executing((await f.read()).experiments[id]), ['baseline', 'design']);
  await f.submit(id, 'baseline'); await f.submit(id, 'design');
  assert.deepEqual(executing((await f.read()).experiments[id]), ['feedback']);
  await f.submit(id, 'feedback'); await confirmAll(f, id);
  state = await f.read(); d = state.experiments[id];
  assert.equal(d.objective.state, 'ready'); assert.equal(state.objectives.cartpole[0].state, 'ready');
  assert.ok(Object.values(d.steps).every((step) => !step.stale));
  assert.deepEqual(executing(d), []);
  assert.equal(d.steps.goal.rev, 1); assert.equal(d.steps.run.rev, 1); assert.equal(d.steps.rules.rev, 2);
  const view = (await f.view({ view: 'exp', pick: `obj:${id}` })).payload;
  assert.equal(view.next.k, 'ready'); assert.equal(view.prep.needYou, 0); assert.equal(view.now.plan.seeds, 5);
  assert.equal(view.now.exec, 'cartpole-exec');
  for (const name of ['home', 'objective', 'exp', 'record', 'policy', 'todo', 'newExp', 'caps', 'cards', 'library', 'doc']) {
    assert.equal((await f.view({ view: name, pick: `obj:${id}` })).status, 200, name);
  }
});

test('an in-flight submission keeps its original dependency revisions and is immediately stale after an edit', async () => {
  const f = fixture(); await f.seed(); const id = await f.newObjective();
  await f.submit(id, 'goal'); await f.submit(id, 'scope');
  const old = (await f.read()).experiments[id].exec.rules;
  await f.act({ op: 'prep', objective: id, id: 'cp-u-train', action: 'edit', value: 'Only change gradient clipping', note: '' });
  await f.submit(id, 'rules');
  const d = (await f.read()).experiments[id];
  assert.deepEqual(d.steps.rules.base, old.base); assert.equal(d.steps.rules.stale, true);
  assert.equal(d.steps.scope.rev, 2); assert.equal(d.exec.design, undefined); assert.equal(d.exec.baseline, undefined);
});

test('cancelled and missing submissions remain stopped until retry; late replies cannot finish the new execution', async () => {
  const f = fixture(); await f.seed(); const id = await f.newObjective();
  await f.submit(id, 'goal'); await f.submit(id, 'scope');
  const old = (await f.read()).experiments[id].exec.run;
  await f.update((state) => assert.deepEqual(recordInitExecution(state, id, 'run', old.id, 'cancelled', now), { ok: true }));
  assert.equal((await f.view({ view: 'exp' })).payload.next.k, 'cancelled');
  assert.equal((await f.act({ op: 'initRetry', objective: id, k: 'run' })).status, 200);
  const current = (await f.read()).experiments[id].exec.run;
  assert.notEqual(current.id, old.id);
  const staleState = await f.read();
  assert.match(submitInitStep(staleState, id, { section: 'run', executionId: old.id, items: [] }, now).error, /not found/);
  assert.equal(staleState.experiments[id].exec.run.id, current.id);
  await f.submit(id, 'run');
  const rules = (await f.read()).experiments[id].exec.rules;
  await f.update((state) => recordInitExecution(state, id, 'rules', rules.id, 'completed', now));
  assert.equal((await f.read()).experiments[id].exec.rules.state, 'missing');
  await f.act({ op: 'initRetry', objective: id, k: 'rules' });
  await f.submit(id, 'rules');
});

test('prep rewrite records agent work without a fake reply, and the agent submits through the same hook', async () => {
  const f = fixture(); await f.seed(); const id = await f.newObjective(); await draftAll(f, id);
  const response = await f.act({ op: 'prep', objective: id, id: 'cp-good', action: 'edit', note: 'Use wall time instead of training steps' });
  assert.equal(response.status, 200);
  let state = await f.read(), d = state.experiments[id];
  assert.equal(d.exec.goal.note, 'Use wall time instead of training steps');
  assert.equal(d.prep.find((p) => p.id === 'cp-good').state, 'preparing');
  assert.equal(d.steps.rules.stale, true);
  const items = createFixtures(now).templates['cp-converge'].prep.filter((p) => p.section === 'goal').map((p) => p.id === 'cp-good' ? { ...p, value: 'Compare elapsed seconds' } : p);
  await f.submit(id, 'goal', { items });
  state = await f.read(); d = state.experiments[id];
  assert.equal(d.prep.find((p) => p.id === 'cp-good').value, 'Compare elapsed seconds');
  assert.equal(d.prep.find((p) => p.id === 'cp-good').state, 'submitted');
});

test('the scheduler is pure and serializes the same id assigned to both roles', async () => {
  const f = fixture(); await f.seed(); const id = await f.newObjective({ evaluate: 'prepare-id' });
  const d = (await f.read()).experiments[id];
  assert.deepEqual(executing(d), ['goal']);
  const before = structuredClone(d);
  const first = rsiExpKick(d, now), second = rsiExpKick(d, now);
  assert.deepEqual(d, before); assert.deepEqual(first, second); assert.deepEqual(first.outbox, []);
  await f.submit(id, 'goal');
  assert.deepEqual(executing((await f.read()).experiments[id]), ['scope']);
});

test('multiple new objectives keep independent queues, and the thread binding hook updates outbox references', async () => {
  const f = fixture(); await f.seed(); const first = await f.newObjective(); const second = await f.newObjective({ statement: 'Another goal' });
  assert.notEqual(first, second);
  await f.submit(first, 'goal');
  assert.deepEqual(executing((await f.read()).experiments[second]), ['goal', 'scope']);
  await f.update((state) => assert.deepEqual(bindObjectiveThread(state, second, 'host-created-thread'), { ok: true }));
  const state = await f.read();
  assert.ok(state.outbox.filter((e) => e.objective === second && e.kind !== 'createThread').every((e) => e.thread === 'host-created-thread'));
  assert.equal((await f.view({ thread: 'host-created-thread' })).payload.pick.id, second);
});

test('何时停 is one setting: a target must read "metric comparison number"; editing it opens its own dialog and rewrites the item from the enforced condition', async () => {
  const f = fixture(); await f.seed();
  const bad = await f.act({ op: 'new', statement: 'x', prepare: 'prepare-id', evaluate: 'evaluate-id', target: 'accuracy ≥ 0.45（备注）' });
  assert.equal(bad.status, 400); assert.match(bad.payload.error, /指标 比较符 数字/);
  const id = await f.newObjective({ target: 'accuracy ≥ 0.45', rounds: '5' });
  const stopItem = (s) => s.experiments[id].prep.find((p) => p.id.endsWith('-stop'));
  const dialog = await f.act({ op: 'prep', objective: id, id: stopItem(await f.read()).id, action: 'edit' });
  assert.deepEqual(dialog.payload.args, { kind: 'rsiStop', objective: id, target: 'accuracy ≥ 0.45', rounds: 5 });
  assert.equal((await f.act({ op: 'stop', objective: id, target: 'accuracy ≥ 0.5', rounds: '4' })).status, 200);
  const s = await f.read();
  assert.deepEqual(s.experiments[id].objective.stop, { target: 'accuracy ≥ 0.5', maxCycles: 4 });
  assert.equal(s.experiments[id].objective.budget.rounds, 4);
  assert.equal(stopItem(s).value, '达到「accuracy ≥ 0.5」并复验稳定，或用满 4 个周期');
  assert.equal((await f.act({ op: 'stop', objective: id, target: '准确率高一点' })).status, 400);
});

test('a step that still counts as running is dispatched again only on an explicit wake-again', async () => {
  const f = fixture(); await f.seed();
  const id = await f.newObjective();
  const [k, before] = Object.entries((await f.read()).experiments[id].exec).find(([, x]) => x.state === 'started');
  assert.equal((await f.act({ op: 'initRetry', objective: id, k })).status, 400);
  assert.equal((await f.act({ op: 'initRetry', objective: id, k, force: 'true' })).status, 200);
  const after = (await f.read()).experiments[id].exec[k];
  assert.equal(after.state, 'started');
  assert.notEqual(after.id, before.id);
});
