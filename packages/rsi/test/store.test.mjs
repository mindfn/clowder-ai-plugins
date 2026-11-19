import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixtures } from '../dist/fixtures.js';
import { update } from '../dist/store.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
// Stores the state as one value, as the Host does, through one write that changes nothing.
async function write(state) {
  let entry = { revision: 1, value: clone(state) };
  const storage = { async get() { return clone(entry); }, async list() { return { owner: clone(entry) }; },
    async compareAndSet(_key, revision, value) { if (revision !== entry.revision) return { applied: false }; entry = { revision: revision + 1, value: clone(value) }; return { applied: true }; } };
  assert.deepEqual(await update(storage, 'owner', () => ({ ok: true })), { ok: true });
  return entry.value;
}

test('every write takes delivered entries out of the outbox; an agent request stays until the turn it started is accounted for, a day at most', async () => {
  const state = createFixtures(1800000000000).state, now = Date.now(), entry = (id, kind, extra = {}) => ({ id, kind, objective: 'cp-converge', ...extra });
  state.experiments['cp-converge'].lifecycle = { ended: { replyTo: 'm-ended', outcome: 'completed', applied: true }, running: { replyTo: 'm-running' } };
  state.outbox = [entry('thread', 'createThread', { sent: now }), entry('run', 'run', { sent: now }), entry('executor', 'executor', { sent: now }),
    entry('schedule', 'schedule', { sent: now }), entry('message', 'message', { sent: now }), entry('queued', 'run'),
    entry('ended', 'agent', { section: 'goal', sent: now, messageId: 'm-ended' }),
    entry('running', 'agent', { section: 'scope', sent: now, messageId: 'm-running' }),
    // Handed over in a turn that has not ended: it wakes its member once if the step is still open then.
    entry('handed', 'agent', { section: 'rules', sent: now, messageId: 'm-handed', inTurn: 'turn' }),
    entry('old', 'agent', { section: 'design', sent: now - 25 * 3600_000, messageId: 'm-old' })];
  assert.deepEqual((await write(state)).outbox.map((e) => e.id), ['queued', 'running', 'handed']);
});

test('every write slims what earlier versions stored: a report keeps its comparison once, a cycle note its outcome, a closed cycle short logs and attempts without the run’s data', async () => {
  const state = createFixtures(1800000000000).state, d = state.experiments['cp-converge'], env = { seed: 1, commit: 'abc1234', hw: 'cpu' };
  const run = (log) => ({ id: 'run', group: 'control', seed: 1, state: 'done', env, metrics: { score: 1 }, log, error: null, attempts: [{ start: 1, end: 2, env, metrics: { score: 1 }, error: null, jobId: null }] });
  const cells = [{ group: 'control', metric: 'score', mean: 1, n: 1, seeds: [{ seed: 1, value: 1, state: 'done', error: null }] }, { group: 'change', metric: 'score', mean: 2, n: 1, seeds: [{ seed: 1, value: 2, state: 'done', error: null }] }];
  const compared = { cycle: 1, against: 'control', metric: 'score', dir: 'up', comparable: true, matrix: cells,
    groups: [{ group: 'control', version: 'v1', control: true, mean: 1, delta: 0, eligible: true, guardrails: [], beatsControl: false }, { group: 'change', version: 'v2', control: false, mean: 2, delta: 1, eligible: true, guardrails: [], beatsControl: true }] };
  d.rounds = [{ n: 1, state: 'done', runs: [run('x'.repeat(3000))], report: { verdict: 'keep', matrix: cells, compare: { ...compared, note: 'same cycle' } } },
    { n: 2, state: 'evaluating', runs: [run('y'.repeat(3000))], report: null }];
  state.library.cartpole.push({ id: 'cp-converge-cycle-1', kind: 'feedback', cycle: 1, objectives: ['cp-converge'],
    result: { verdict: 'keep', comparison: compared, confirmation: { status: 'candidate', group: 'change', version: 'v2', cycle: 1 } } });
  const after = await write(state), [closed, open] = after.experiments['cp-converge'].rounds;
  assert.deepEqual(closed.report.matrix, cells);
  assert.deepEqual(closed.report.compare, { cycle: 1, against: 'control', metric: 'score', dir: 'up', comparable: true, groups: compared.groups, note: 'same cycle' });
  assert.equal(closed.runs[0].log, 'x'.repeat(400));
  assert.deepEqual(closed.runs[0].attempts, [{ start: 1, end: 2, error: null, jobId: null }]);
  // An open cycle keeps everything: its evaluator reads it, and a retry would replace the run's environment.
  assert.equal(open.runs[0].log.length, 2000); assert.deepEqual(open.runs[0].attempts[0].env, env);
  assert.deepEqual(after.library.cartpole.at(-1).result, { verdict: 'keep', metric: 'score', means: { control: 1, change: 2 }, confirmation: { status: 'candidate', version: 'v2' } });
});
