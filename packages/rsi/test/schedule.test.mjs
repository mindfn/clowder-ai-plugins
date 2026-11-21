import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixtures } from '../dist/fixtures.js';
import { act } from '../dist/actions.js';
import { viewModel } from '../dist/views.js';
import { hasValidSchedule, insideWindow, maxRunsText, nextScheduledRuns, parseScheduleText, scheduleForm, scheduleOf, scheduleSummary, validatePolicy, withinWindowLimit } from '../dist/schedule.js';

const local = (y, m, d, hh, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime();

test('schedule supports unrestricted anytime, weekday daytime + all-day weekends, calendar date ranges, and overnight weekday rollover', () => {
  // 1. Anytime (24/7)
  const anytime = scheduleOf({ mode: 'anytime' });
  assert.ok('schedule' in anytime);
  assert.equal(scheduleSummary(anytime.schedule), '不限制（全天）');
  assert.equal(hasValidSchedule(anytime.schedule), true);
  assert.equal(insideWindow(anytime.schedule, local(2026, 11, 25, 3, 15)), true);
  assert.equal(insideWindow(anytime.schedule, local(2026, 11, 22, 14, 0)), true);

  // 2. Weekday daytime (09:00-18:00) + weekend all day (e.g. cross-timezone Ascend NPU sharing)
  const crossTz = scheduleOf({ mode: 'daytime_weekend', start: '09:00', end: '18:00' });
  assert.ok('schedule' in crossTz);
  assert.equal(scheduleSummary(crossTz.schedule), '周一至周五 09:00–18:00；周六至周日 全天');
  // 2026-11-25 is Wednesday
  assert.equal(insideWindow(crossTz.schedule, local(2026, 11, 25, 10, 30)), true);
  assert.equal(insideWindow(crossTz.schedule, local(2026, 11, 25, 20, 0)), false);
  // 2026-11-21 is Saturday, 2026-11-22 is Sunday
  assert.equal(insideWindow(crossTz.schedule, local(2026, 11, 21, 2, 30)), true);
  assert.equal(insideWindow(crossTz.schedule, local(2026, 11, 22, 23, 45)), true);

  // 3. Calendar date range + hours
  const ranged = scheduleOf({ mode: 'daily', dateFrom: '2026-11-21', dateTo: '2026-11-28', start: '08:30', end: '19:30' });
  assert.ok('schedule' in ranged);
  assert.equal(insideWindow(ranged.schedule, local(2026, 11, 20, 12, 0)), false);
  assert.equal(insideWindow(ranged.schedule, local(2026, 11, 21, 12, 0)), true);
  assert.equal(insideWindow(ranged.schedule, local(2026, 11, 28, 19, 29)), true);
  assert.equal(insideWindow(ranged.schedule, local(2026, 11, 29, 12, 0)), false);
  assert.ok('error' in scheduleOf({ mode: 'daily', dateFrom: '2026-11-28', dateTo: '2026-11-21' }));

  // 4. Overnight weekday rollover: Mon-Fri 22:00-08:00 includes Saturday 03:00 (Friday night), excludes Sunday 03:00 (Saturday night)
  const overnight = parseScheduleText('周一至周五 22:00–08:00');
  assert.ok(overnight);
  // 2026-11-20 is Friday, 21 is Saturday, 22 is Sunday
  assert.equal(insideWindow(overnight, local(2026, 11, 20, 23, 0)), true);
  assert.equal(insideWindow(overnight, local(2026, 11, 21, 3, 0)), true);
  assert.equal(insideWindow(overnight, local(2026, 11, 21, 23, 0)), false);
  assert.equal(insideWindow(overnight, local(2026, 11, 22, 3, 0)), false);

  // 5. Multi-rule text parser & form round-trip
  const multi = parseScheduleText('工作日 09:00-18:00；周末 全天');
  assert.ok(multi);
  assert.equal(insideWindow(multi, local(2026, 11, 25, 11, 0)), true);
  assert.equal(insideWindow(multi, local(2026, 11, 25, 22, 0)), false);
  assert.equal(insideWindow(multi, local(2026, 11, 21, 22, 0)), true);
  assert.equal(scheduleForm(crossTz.schedule).mode, 'daytime_weekend');
  assert.equal(scheduleForm(crossTz.schedule).start, '09:00');
});

test('op: schedule updates an objective schedule anytime, refreshes views and sidebar trigger, and unlocks life:start', () => {
  const now = 1800000000000;
  const state = createFixtures(now).state;
  const project = '/work/ascend-bge';
  state.projects.unshift({ id: project, name: 'ascend-bge', projectPath: project, exp: true, hostKinds: ['mcp'] });
  state.objectives[project] = []; state.groups[project] = []; state.units[project] = []; state.library[project] = [];
  assert.equal(act(state, { op: 'new', statement: '优化 BGE 推理', projectPath: project, prepare: 'codex', evaluate: 'kimi', scheduleMode: 'anytime', cats: [] }, { project }, now).ok, true);
  const id = state.objectives[project][0].id;
  assert.equal(viewModel(state, 'exp', { project, pick: `obj:${id}` }).policy.schedule.window, '不限制（全天）');

  // Switch to weekday daytime + weekend all-day with calendar date range via op: schedule
  const res = act(state, { op: 'schedule', objective: id, mode: 'daytime_weekend', dateFrom: '2026-11-21', dateTo: '2026-12-05', start: '09:00', end: '18:00' }, { project }, now);
  assert.deepEqual(res, { ok: true });
  const exp = viewModel(state, 'exp', { project, pick: `obj:${id}` });
  assert.equal(exp.policy.schedule.window, '2026-11-21~2026-12-05 周一至周五 09:00–18:00；2026-11-21~2026-12-05 周六至周日 全天');
  assert.equal(exp.policy.schedule.form.dateFrom, '2026-11-21');
  assert.equal(exp.policy.schedule.form.dateTo, '2026-12-05');
  assert.equal(state.objectives[project][0].trigger, exp.policy.schedule.window);

  // Ready objective can start with the structured schedule (no longer blocked by legacy single HH:MM–HH:MM check)
  state.experiments[id].objective.state = 'ready';
  assert.deepEqual(act(state, { op: 'life', objective: id, action: 'start' }, { project }, now), { ok: true });
  assert.equal(state.experiments[id].objective.state, 'running');

  // maxRunsPerWindow: unlimited by default, enforces cap when set
  assert.equal(exp.policy.schedule.maxRunsText, '不限制');
  const capped = scheduleOf({ mode: 'anytime', maxRuns: '2' });
  assert.ok('schedule' in capped);
  assert.equal(capped.schedule.maxRuns, 2);
  assert.equal(maxRunsText(capped.schedule), '最多 2 次');
  assert.equal(scheduleForm(capped.schedule).maxRuns, '2');
  assert.equal(withinWindowLimit(capped.schedule, [{ scheduled: true, start: now - 1000 }], now), true);
  assert.equal(withinWindowLimit(capped.schedule, [{ scheduled: true, start: now - 2000 }, { scheduled: true, start: now - 1000 }], now), false);
  assert.equal(withinWindowLimit(scheduleOf({ mode: 'anytime', maxRuns: '' }).schedule, [{ scheduled: true, start: now - 2000 }, { scheduled: true, start: now - 1000 }], now), true);
  assert.ok('error' in scheduleOf({ mode: 'anytime', maxRuns: '-1' }));
});

test('multi-policy execution strategy supports fixed/daily/weekly/range/continuous, excludes, calendar range picking, echo-edit, and next-N preview', () => {
  const now = local(2026, 11, 20, 10, 0); // Friday 2026-11-20 10:00
  const state = createFixtures(now).state;
  const project = '/work/ascend-bge-pol';
  state.projects.unshift({ id: project, name: 'ascend-bge-pol', projectPath: project, exp: true, hostKinds: ['mcp'] });
  state.objectives[project] = []; state.groups[project] = []; state.units[project] = []; state.library[project] = [];
  assert.equal(act(state, { op: 'new', statement: '多策略测试', projectPath: project, prepare: 'codex', evaluate: 'kimi', cats: [] }, { project }, now).ok, true);
  const id = state.objectives[project][0].id;

  // 1. Open new policy dialog -> weekly Mon-Fri 09:00-18:00, exclude Wednesday (3) and 2026-11-24..2026-11-25
  const opened = act(state, { op: 'policyEditOpen', objective: id }, { project }, now);
  assert.equal(opened.ok, true);
  assert.equal(opened.acts[0].args.kind, 'rsiExecPolicy');
  act(state, { op: 'policyDraft', objective: id, field: 'kind', v: 'weekly' }, { project }, now);
  act(state, { op: 'policyDraft', objective: id, field: 'timePreset', v: 'day' }, { project }, now);
  act(state, { op: 'policyDraft', objective: id, field: 'excludeDayToggle', v: '3' }, { project }, now);
  act(state, { op: 'policyDraft', objective: id, field: 'excludeFrom', v: '2026-11-24' }, { project }, now);
  act(state, { op: 'policyDraft', objective: id, field: 'excludeTo', v: '2026-11-25' }, { project }, now);
  const saved1 = act(state, { op: 'policySave', objective: id }, { project }, now);
  assert.equal(saved1.ok, true);

  // 2. Add a second policy: calendar date range 2026-11-21 ~ 2026-11-22 all day (weekend sprint)
  act(state, { op: 'policyEditOpen', objective: id }, { project }, now);
  act(state, { op: 'policyDraft', objective: id, field: 'kind', v: 'range' }, { project }, now);
  act(state, { op: 'policyDraft', objective: id, field: 'calPick', v: local(2026, 11, 21, 12, 0) }, { project }, now);
  act(state, { op: 'policyDraft', objective: id, field: 'calPick', v: local(2026, 11, 22, 12, 0) }, { project }, now);
  act(state, { op: 'policyDraft', objective: id, field: 'timePreset', v: 'all' }, { project }, now);
  const editorBeforeSave = viewModel(state, 'exp', { project, pick: `obj:${id}` }).policyEditor;
  assert.equal(editorBeforeSave.calendar.marks.length, 2);
  assert.equal(editorBeforeSave.dateFrom, '2026-11-21');
  assert.equal(editorBeforeSave.dateTo, '2026-11-22');
  assert.equal(act(state, { op: 'policySave', objective: id }, { project }, now).ok, true);

  const exp = viewModel(state, 'exp', { project, pick: `obj:${id}` });
  assert.equal(exp.policy.schedule.policies.length, 2);
  assert.equal(exp.policy.schedule.nextRuns.length, 5);
  // 2026-11-20 Fri 10:00 -> inside weekly policy
  assert.equal(insideWindow(state.experiments[id].policy.schedule, local(2026, 11, 20, 10, 0)), true);
  // 2026-11-21 Sat 03:00 -> inside range policy
  assert.equal(insideWindow(state.experiments[id].policy.schedule, local(2026, 11, 21, 3, 0)), true);
  // 2026-11-24 Tue 11:00 -> excluded by excludeFrom..excludeTo
  assert.equal(insideWindow(state.experiments[id].policy.schedule, local(2026, 11, 24, 11, 0)), false);
  // 2026-12-02 Wed 11:00 -> excluded by excludeDays=[3]
  assert.equal(insideWindow(state.experiments[id].policy.schedule, local(2026, 12, 2, 11, 0)), false);
  // 2026-11-26 Thu 11:00 -> matches weekly policy
  assert.equal(insideWindow(state.experiments[id].policy.schedule, local(2026, 11, 26, 11, 0)), true);

  // 3. Click existing policy -> echoes data -> edit & save -> still 2 policies
  const firstId = exp.policy.schedule.policies[0].id;
  act(state, { op: 'policyEditOpen', objective: id, policyId: firstId }, { project }, now);
  const echo = viewModel(state, 'exp', { project, pick: `obj:${id}` }).policyEditor;
  assert.equal(echo.isEdit, true);
  assert.equal(echo.kind, 'weekly');
  assert.equal(echo.excludeFrom, '2026-11-24');
  act(state, { op: 'policyDraft', objective: id, field: 'timePreset', v: 'night' }, { project }, now);
  assert.equal(act(state, { op: 'policySave', objective: id }, { project }, now).ok, true);
  const afterEdit = viewModel(state, 'exp', { project, pick: `obj:${id}` });
  assert.equal(afterEdit.policy.schedule.policies.length, 2);
  assert.match(afterEdit.policy.schedule.policies[0].title, /20:00–08:00/);

  // 4. Delete one policy -> 1 left
  assert.equal(act(state, { op: 'policyDelete', objective: id, policyId: firstId }, { project }, now).ok, true);
  assert.equal(viewModel(state, 'exp', { project, pick: `obj:${id}` }).policy.schedule.policies.length, 1);

  // 5. Fixed single-date policy validation & nextScheduledRuns
  const fixed = validatePolicy({ kind: 'fixed', dateFrom: '2026-11-25', start: '14:00', end: '16:00' });
  assert.ok('policy' in fixed);
  assert.deepEqual(nextScheduledRuns([fixed.policy], now, 5), ['11/25 周三 14:00–16:00']);
});
