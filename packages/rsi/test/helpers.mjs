import assert from 'node:assert/strict';
import plugin from '../dist/index.js';
import { ownerKey } from '../dist/backend.js';
import { createFixtures, RSI_CP_INIT } from '../dist/fixtures.js';
import { submitInitStep } from '../dist/init.js';

export const now = 1800000000000;
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

export function fixture() {
  const entries = new Map();
  let revision = 0;
  const storage = {
    async get(key) { return clone(entries.get(key)); },
    async compareAndSet(key, expected, value) {
      if ((entries.get(key)?.revision ?? null) !== expected) return { applied: false };
      entries.set(key, { revision: ++revision, value: clone(value) });
      return { applied: true };
    },
  };
  const start = () => plugin.create().start({ pluginInstanceId: 'rsi-test', storage });
  const invoke = async (name, request, options = {}) => {
    const { userId = 'owner-a', operation = name === 'view' ? 'read' : 'write', instanceId = 'rsi-test', active = true, assertCurrent = async () => {} } = options;
    const result = await start().actions[`rsi.${name}`]({ request }, undefined, active ? { kind: 'owner-http-request', userId, pluginInstanceId: instanceId, operation, assertCurrent } : undefined);
    return { ...result, payload: JSON.parse(result.body) };
  };
  const view = (query = {}, options) => invoke('view', { method: 'GET', query: { view: 'home', ...query } }, options);
  const act = (body, query = {}, options) => invoke('act', { method: 'POST', body, query }, options);
  const read = async (userId = 'owner-a') => (await storage.get(ownerKey(userId)))?.value;
  const update = async (fn, userId = 'owner-a') => {
    const key = ownerKey(userId), current = await storage.get(key);
    const result = fn(current.value);
    assert.equal((await storage.compareAndSet(key, current.revision, current.value)).applied, true);
    return result;
  };
  const seed = async () => {
    assert.equal((await storage.compareAndSet(ownerKey('owner-a'), null, createFixtures(now).state)).applied, true);
  };
  const newObjective = async (body = {}) => {
    const result = await act({ op: 'new', statement: '训练更快、更稳地收敛', prepare: 'prepare-id', evaluate: 'evaluate-id', target: '平均回报 ≥ 475', stall: '3', rounds: '20', ...body });
    assert.equal(result.status, 200, JSON.stringify(result.payload));
    return (await read()).objectives[body.project || 'cartpole'].at(-1).id;
  };
  const submit = async (id, section, overrides = {}) => update((state) => {
    const template = createFixtures(now).templates[id.startsWith('pd') ? 'pd-ttft' : 'cp-converge'];
    const s = RSI_CP_INIT.find((s) => s.section === section);
    const d = state.experiments[id];
    const result = submitInitStep(state, id, {
      section, executionId: d.exec[section].id,
      items: template.prep.filter((p) => p.section === section),
      unknowns: s.unknowns, next: s.next,
      ...(section === 'goal' ? { goal: template.objective.goal } : {}),
      ...(section === 'run' ? { executor: { ...template.executor, state: 'passed' } } : {}),
      ...(section === 'rules' ? { metrics: template.metrics } : {}),
      ...(section === 'baseline' ? { upcoming: createFixtures(now).templates['cp-converge'].rounds[0].plan } : {}),
      ...overrides,
    }, now);
    assert.deepEqual(result, { ok: true });
  });
  return { storage, start, invoke, view, act, read, update, seed, newObjective, submit };
}

export async function draftAll(f, id) {
  for (const section of ['goal', 'scope', 'run', 'rules', 'design', 'feedback', 'baseline']) await f.submit(id, section);
}

export async function confirmAll(f, id) {
  const items = (await f.read()).experiments[id].prep.filter((p) => p.neededFrom === 'human' && p.state !== 'confirmed');
  for (const item of items) {
    const result = await f.act({ op: 'prep', objective: id, id: item.id, action: item.rec ? 'decide' : 'confirm', ...(item.rec ? { decision: item.rec } : {}) });
    assert.equal(result.status, 200, JSON.stringify(result.payload));
  }
}
