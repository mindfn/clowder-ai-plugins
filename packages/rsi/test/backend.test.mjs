import assert from 'node:assert/strict';
import test from 'node:test';
import { ownerKey } from '../dist/backend.js';
import { confirmAll, draftAll, fixture } from './helpers.mjs';

test('entry point exposes owner-scoped actions and persists seeded state across handler recreation', async () => {
  const f = fixture();
  assert.deepEqual(Object.keys(f.start().actions), ['rsi.view', 'rsi.act', 'rsi.task', 'rsi.submit', 'rsi.executor', 'rsi.version', 'rsi.conclude', 'rsi.propose', 'rsi.tick', 'rsi.delivery']);
  assert.equal((await f.view()).status, 200);
  const seeded = await f.storage.get(ownerKey('owner-a'));
  assert.ok(seeded.revision); assert.equal(seeded.value.projects.length, 6);
  await f.newObjective();
  assert.equal((await f.view()).payload.hasObjectives, true);
  assert.equal((await f.view({}, { userId: 'owner-b' })).payload.hasObjectives, false);
  assert.notDeepEqual(await f.read('owner-a'), await f.read('owner-b'));
  assert.equal((await f.view({}, { active: false })).status, 403);
  assert.equal((await f.view({}, { instanceId: 'other-plugin' })).status, 403);
  assert.equal((await f.view({}, { operation: 'write' })).status, 403);
  assert.equal((await f.act({ op: 'new' }, {}, { operation: 'read' })).status, 403);
  assert.equal((await f.invoke('view', { method: 'POST' })).status, 405);
  assert.equal((await f.invoke('act', { method: 'GET' })).status, 405);
  assert.equal((await f.invoke('view', { method: 'GET', query: [] })).status, 400);
  assert.equal((await f.invoke('act', { method: 'POST', body: null })).status, 400);
  assert.equal((await f.view({ view: 'unknown' })).status, 400);
  assert.equal((await f.view({ project: 'missing' })).status, 404);
});

test('CAS conflicts report 409 and preserve the previous state and outbox', async () => {
  const f = fixture(); await f.seed();
  const before = await f.read();
  f.storage.compareAndSet = async () => ({ applied: false });
  const response = await f.act({ op: 'new', statement: 'New goal', prepare: 'a', evaluate: 'b' });
  assert.equal(response.status, 409); assert.deepEqual(await f.read(), before);
});

test('concurrent first reads share one seed and invalid retained data is rejected', async () => {
  const f = fixture();
  const results = await Promise.all([f.view(), f.view()]);
  assert.ok(results.every((r) => r.status === 200));
  assert.equal((await f.storage.get(ownerKey('owner-a'))).revision, 1);
  const current = await f.storage.get(ownerKey('owner-a'));
  await f.storage.compareAndSet(ownerKey('owner-a'), current.revision, { wrong: true });
  assert.equal((await f.view()).status, 500);
});

test('owner freshness is checked again before committing a write', async () => {
  const f = fixture(); await f.seed(); let calls = 0;
  const before = await f.read();
  await assert.rejects(f.act({ op: 'new', statement: 'New goal', prepare: 'a', evaluate: 'b' }, {}, {
    async assertCurrent() { if (++calls === 2) throw new Error('owner context revoked'); },
  }), /revoked/);
  assert.deepEqual(await f.read(), before);
});

test('document writes, policy overrides, group rename, and metrics survive storage reads', async () => {
  const f = fixture(); await f.seed();
  const context = { project: 'self', pick: 'obj:tool-access-correct-use' };
  assert.equal((await f.act({ op: 'docAdd', title: 'An evidence note', url: 'https://example.com/evidence', body: 'Observed results' }, context)).status, 200);
  let library = (await f.view({ view: 'library', project: 'self' })).payload;
  const doc = library.groups.find((g) => g.k === 'provided').items.find((d) => d.title === 'An evidence note');
  assert.equal((await f.view({ view: 'doc', project: 'self', doc: doc.id })).payload.body, 'Observed results');
  assert.equal((await f.act({ op: 'docConfirm', id: 'fb-identity-skip' }, context)).status, 200);
  assert.equal((await f.act({ op: 'docRemove', id: doc.id }, context)).status, 200);
  assert.equal((await f.act({ op: 'docRemove', id: 'missing' }, context)).status, 404);
  assert.equal((await f.act({ op: 'policy', key: 'count', value: '800' }, context)).status, 200);
  assert.equal((await f.view({ view: 'policy', ...context })).payload.policy.count.value, '800');
  await f.act({ op: 'policy', key: 'count', value: '' }, context);
  assert.equal((await f.view({ view: 'policy', ...context })).payload.policy.count.value, '');
  await f.act({ op: 'renameGroup', id: 'g-code', name: 'Source changes' }, context);
  assert.equal((await f.view({ view: 'caps', project: 'self' })).payload.modify.find((g) => g.id === 'g-code').name, 'Source changes');
  const id = 'tool-access-correct-use', before = await f.read(), versionCount = before.details[id].metrics.versions.length;
  assert.equal((await f.act({ op: 'addMetric', name: 'Evidence quality', how: 'Read cited observations' }, context)).status, 200);
  let state = await f.read(), last = state.details[id].metrics.versions.at(-1);
  assert.equal(state.details[id].metrics.versions.length, versionCount + 1);
  assert.equal(last.items.at(-1).logic, 'Read cited observations');
  await f.act({ op: 'lock', metric: last.items.at(-1).id, locked: 'true' }, context);
  state = await f.read(); assert.equal(state.details[id].metrics.items.at(-1).locked, true);
});

test('card decisions update state and retain external execution and reevaluation work in outbox', async () => {
  const f = fixture(); await f.seed();
  const card = (await f.read()).details['identity-truth'].cards['card-identity-truth'];
  assert.equal((await f.act({ op: 'reeval', card: card.id, note: 'Look at independent evidence' })).status, 200);
  let state = await f.read();
  assert.equal(state.details['identity-truth'].cards[card.id].round, 2);
  assert.deepEqual(state.details['identity-truth'].cards[card.id].reasons, ['Look at independent evidence']);
  assert.equal(state.outbox.at(-1).kind, 'reevaluate');
  assert.equal((await f.act({ op: 'decide', card: card.id, decision: 'apply' })).status, 200);
  state = await f.read();
  assert.equal(state.details['identity-truth'].cards[card.id], undefined);
  assert.equal(state.objectives.self.find((o) => o.id === 'identity-truth').running.o, card.to);
  assert.equal(state.outbox.at(-1).kind, 'executor');
  assert.equal((await f.act({ op: 'decide', card: 'card-tool-access-correct-use', decision: 'skip' })).status, 200);
  assert.equal((await f.read()).details['tool-access-correct-use'].cycles.at(-1).decision, 'collecting');
});

test('lifecycle writes schedule work without generated runs; pause/resume toggles the introduced capability', async () => {
  const f = fixture(); await f.seed(); const id = await f.newObjective();
  assert.equal((await f.act({ op: 'life', objective: id, action: 'start' })).status, 400);
  await draftAll(f, id); await confirmAll(f, id);
  assert.equal((await f.act({ op: 'life', objective: id, action: 'start' })).status, 200);
  let state = await f.read();
  assert.equal(state.experiments[id].objective.state, 'running');
  assert.deepEqual(state.experiments[id].rounds, []); assert.equal(state.outbox.at(-1).kind, 'schedule');
  await f.act({ op: 'life', objective: id, action: 'pause' });
  state = await f.read();
  assert.equal(state.experiments[id].objective.state, 'paused');
  assert.equal(state.groups.cartpole.find((g) => g.forObjective === id).off, true);
  await f.act({ op: 'life', objective: id, action: 'resume' });
  state = await f.read();
  assert.equal(state.experiments[id].objective.state, 'running');
  assert.equal(state.groups.cartpole.find((g) => g.forObjective === id).off, false);
});

test('round decisions store the choice and the planned next cycle without prototype timers or fabricated PR merges', async () => {
  const f = fixture(); await f.seed();
  await f.update((state) => {
    const template = state.experiments['pd-ttft'];
    template.rounds.push({ n: 1, version: 'v1', state: 'done', plan: { groups: [{ id: 'control', label: 'control', vars: {}, version: 'v1' }], seeds: [1, 2, 3] }, report: { directions: [{ id: 'code-change', kind: 'code' }] }, decision: null });
  });
  const response = await f.act({ op: 'expDecide', n: 1, pick: 'direction', directionId: 'code-change', note: 'Try it' }, { project: 'pd-infer' });
  assert.equal(response.status, 200);
  const d = (await f.read()).experiments['pd-ttft'];
  assert.equal(d.rounds[0].decision.directionId, 'code-change');
  assert.equal(d.rounds[1].state, 'planned'); assert.equal(d.versions.length, 1);
  assert.equal((await f.act({ op: 'expDecide', n: 1, pick: 'same' }, { project: 'pd-infer' })).status, 409);
});

test('prototype actions return public dialogs before writes and preserve their dialog arguments', async () => {
  const f = fixture(); await f.seed();
  for (const [op, kind, query] of [['new', 'rsiNewExp', {}], ['new', 'rsiNew', { project: 'self' }], ['docAdd', 'rsiDocAdd', {}], ['addMetric', 'rsiAddMetric', { project: 'self', pick: 'obj:identity-truth' }]]) {
    assert.deepEqual((await f.act({ op }, query)).payload, { ok: true, act: 'dialog', args: { kind } });
  }
  const id = await f.newObjective();
  const edit = (await f.act({ op: 'prep', id: 'cp-good', action: 'edit' })).payload;
  assert.equal(edit.act, 'dialog'); assert.equal(edit.args.kind, 'rsiPrepEdit'); assert.equal(edit.args.id, 'cp-good');
  const reeval = (await f.act({ op: 'reeval', card: 'card-identity-truth' })).payload;
  assert.deepEqual(reeval, { ok: true, act: 'dialog', args: { kind: 'rsiReeval', card: 'card-identity-truth' } });
  assert.deepEqual((await f.act({ op: 'go', objective: id })).payload, { ok: true, act: 'plugSet', args: { k: 'pick', v: `obj:${id}` } });
  assert.deepEqual((await f.act({ op: 'goVersion', pick: 'version|cp-converge/v1>node' })).payload, { ok: true, act: 'plugSet', args: { k: 'selO', v: 'cp-converge/v1>node' } });
  assert.equal((await f.act({ op: 'policy', key: 'count', v: '400' }, { project: 'self', pick: 'obj:identity-truth' })).status, 200);
});
