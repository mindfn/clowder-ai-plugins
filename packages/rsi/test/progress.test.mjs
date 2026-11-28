import assert from 'node:assert/strict';
import test from 'node:test';
import { progress } from '../dist/progress.js';

function experiment() {
  return {
    objective: { state: 'running', currentVersion: 'v1', projectPath: '/isolated' },
    prep: [], plan: [], exec: {}, members: [{ role: 'evaluate', catId: 'evaluator' }],
    policy: { schedule: { mode: 'anytime' } }, executor: { state: 'passed', commands: { submit: 'fixture' } },
    versions: [{ id: 'v1', config: {} }], rounds: [],
    upcoming: { groups: [{ id: 'control', label: 'Control', vars: {}, control: true }], seeds: [1] },
  };
}
const now = 1800000000000;
const round = (state) => ({ n: 1, state, start: now, plan: { groups: [{ id: 'control', vars: {}, version: 'v1' }], seeds: [2] }, runs: [], events: [] });

test('progress reports active stages, responsible members and all run blockers without modifying frozen state', () => {
  const cases = [
    ['running', (d) => d.rounds.push(round('running'))],
    ['aborting', (d) => d.rounds.push(round('aborting'))],
    ['evaluating', (d) => d.rounds.push(round('evaluating'))],
    ['discussing', (d) => d.rounds.push({ ...round('done'), report: {}, analysis: { waiting: ['analyst'] } })],
    ['decision', (d) => d.rounds.push({ ...round('done'), report: {} })],
    ['windowLimit', (d) => { d.rounds.push({ ...round('done'), scheduled: true }); d.policy.schedule.maxRuns = 1; }],
    ['cycleVarsConflict', (d) => { d.upcoming.groups.push({ id: 'change', label: 'Change', vars: { knob: 1 } }); d.upcoming.cycleVars = { knob: 0 }; }],
    ['plan', (d) => { d.upcoming = null; }],
    ['reservedTier', (d) => { d.upcoming.reservedSeeds = [4]; }],
  ];
  const freeze = (value) => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  for (const [code, mutate] of cases) {
    const d = experiment(); mutate(d); freeze(d);
    const result = progress(d, now);
    assert.ok(result.blockers.some((b) => b.code === code), code);
    assert.equal(result.canSchedule, false, code);
    assert.equal(result.canRunCycle, code === 'windowLimit', code);
    if (code === 'evaluating') assert.deepEqual(result.memberIds, ['evaluator']);
    if (code === 'discussing') assert.deepEqual(result.memberIds, ['analyst']);
  }
});

test('interrupted resume uses its existing snapshot while scheduling permits only one automatic resume', () => {
  const d = experiment();
  d.policy.requireCycleVars = true;
  d.upcoming.requiresExplicitPlan = true;
  d.rounds.push(round('interrupted'));
  const before = structuredClone(d);
  assert.equal(progress(d, now).canSchedule, true);
  assert.equal(progress(d, now).canRunCycle, true);
  assert.deepEqual(d, before);
  d.rounds[0].autoResumed = true;
  assert.equal(progress(d, now).canSchedule, false);
  assert.equal(progress(d, now).canRunCycle, true);
});

test('first-cycle control variable initialization is reflected in conflict checking without mutating the version', () => {
  const d = experiment();
  d.upcoming.groups[0].vars = { knob: 1 };
  d.upcoming.groups.push({ id: 'treatment', label: 'Treatment', vars: { knob: 1 } });
  d.upcoming.cycleVars = { knob: 2 };
  const before = structuredClone(d);
  assert.equal(progress(d, now).canRunCycle, true, 'shared variables can be bound before initial version.vars exists');
  assert.deepEqual(d, before);
  d.upcoming.groups[1].vars.knob = 3;
  assert.equal(progress(d, now).canRunCycle, false, 'a real treatment difference remains protected');
});

test('a paused objective still assigns pending partial evaluation to the evaluator', () => {
  const d = experiment(); d.objective.state = 'paused'; d.rounds.push(round('evaluating'));
  const p = progress(d, now);
  assert.equal(p.phase, 'evaluating');
  assert.equal(p.role, 'evaluate');
  assert.equal(p.nextAction.op, 'conclude');
  assert.equal(p.canRunCycle, false);
});

test('an explicit decision releases the next cycle while old analyst replies are still pending', () => {
  const d = experiment();
  d.rounds.push({ ...round('done'), report: {}, decision: { pick: 'same' }, analysis: { waiting: ['analyst'] } });
  const p = progress(d, now);
  assert.equal(p.canRunCycle, true); assert.equal(p.canSchedule, true);
  assert.equal(p.discussingCycle, null);
});

test('diagnostic parameters separate conflicting keys and reserved seed details from English error sentences', () => {
  const d = experiment(); d.upcoming.groups.push({ id: 'change', label: 'Change', vars: { knob: 3 } }); d.upcoming.cycleVars = { knob: 2 };
  assert.equal(progress(d, now).blockers.find((b) => b.code === 'cycleVarsConflict').detail, 'knob');
  d.upcoming.tier = 'explore'; d.upcoming.reservedSeeds = [1];
  let b = progress(d, now).blockers.find((b) => b.code === 'reservedSeeds');
  assert.equal(b.reason, 'scheduled'); assert.equal(b.detail, '1');
  d.rounds.push(round('done')); d.upcoming.reservedSeeds = [2];
  b = progress(d, now).blockers.find((b) => b.code === 'reservedSeeds');
  assert.equal(b.reason, 'history'); assert.equal(b.detail, '2');
});
