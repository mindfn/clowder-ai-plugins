import { prepSettled, stepMemberOf } from './init.js';
import { cycleVarsConflicts, freshSeeds, hasCycleVars, validPlan, reservedSeedIssue } from './cycles.js';
import { insideWindow, withinWindowLimit } from './schedule.js';
import type { Data, Experiment } from './types.js';

export interface Blocker {
  code: string;
  message: string;
  scope: 'all' | 'schedule';
  role: string;
  action: string;
  section?: string;
  step?: number;
  count?: number;
  by?: string;
  memberIds?: string[];
  detail?: string;
  reason?: string;
}

// The same projection serves commands, scheduling and readers. Manual runs have always
// been allowed outside the schedule; schedule-only blockers make that distinction explicit.
export function progress(d: Experiment, now: number) {
  const running = d.rounds.find((r: Data) => r.state === 'running');
  const aborting = d.rounds.find((r: Data) => r.state === 'aborting');
  const evaluating = d.rounds.find((r: Data) => r.state === 'evaluating');
  const discussing = d.rounds.find((r: Data) => r.analysis?.waiting?.length && !r.decision);
  const undecided = d.rounds.find((r: Data) => r.report && !r.decision && !r.analysis?.waiting?.length);
  const interrupted = d.rounds.find((r: Data) => r.state === 'interrupted');
  const settled = prepSettled(d);
  const blockers: Blocker[] = [];
  const add = (code: string, message: string, role: string, action: string, scope: Blocker['scope'] = 'all', details: Partial<Blocker> = {}) => blockers.push({ code, message, role, action, scope, ...details });
  if (['done', 'retired'].includes(d.objective.state)) add('terminal', 'Objective is not ready: it has ended', 'owner', 'none');
  else if (d.objective.state === 'paused') add('paused', 'Objective is not ready: it is paused', 'manager', 'resume');
  else if (settled && !['ready', 'running', 'pending'].includes(d.objective.state)) add('preparing', 'Objective is not ready', 'prepare', 'prepare');
  if (aborting) add('aborting', 'Cycle cancellation is still being settled', 'executor', 'wait');
  if (running) add('running', 'Finish the current cycle first', 'executor', 'wait');
  if (evaluating) add('evaluating', 'Finish the current cycle first: evaluation is pending', 'evaluate', 'conclude');
  if (discussing) add('discussing', 'Finish the current cycle first: direction discussion is pending', 'analyze', 'propose');
  if (undecided) add('decision', 'Finish the current cycle first: a decision is pending', 'manager', 'expDecide');
  if (d.versionRequest) add('version', 'The prepare member must submit rsi.version first', 'iterate', 'version');
  if (!settled) {
    const steps = d.plan.map((p, i) => ({ section: p.k, step: i + 1, execution: d.exec?.[p.k], stored: d.steps?.[p.k], member: stepMemberOf(d, p.k) }));
    const cut = steps.find((p) => p.execution && p.execution.state !== 'started');
    const stale = steps.filter((p) => !p.execution && p.stored?.stale && !p.stored.redo);
    const working = steps.filter((p) => p.execution?.state === 'started' || !p.execution && p.stored?.stale && p.stored.redo);
    const confirm = d.prep.filter((p) => p.neededFrom === 'human' && p.state !== 'confirmed');
    const pending = steps.find((p) => !p.execution && !p.stored);
    if (cut) add('prepInterrupted', 'Preparation reply was interrupted; retry the step', 'manager', 'initRetry', 'all',
      { section: cut.section, step: cut.step, by: cut.execution?.by });
    if (stale.length) add('prepStale', 'Preparation has stale steps; redo against the new version', 'owner', 'initRedo', 'all', { count: stale.length });
    if (working.length) add('prepWorking', 'Preparation members are still working', 'prepare', 'wait', 'all',
      { count: working.length, memberIds: [...new Set(working.map((p) => p.execution?.by || p.member?.catId).filter((id): id is string => !!id))] });
    if (confirm.length) add('prepConfirm', 'Preparation items need confirmation', 'owner', 'prepConfirm', 'all', { count: confirm.length });
    if (pending && !cut && !stale.length && !working.length) add('prepPending', 'Preparation step has not started', 'manager', pending.member?.catId ? 'initRetry' : 'stepMember', 'all', { section: pending.section, step: pending.step });
  }
  if (d.executor.state !== 'passed' || !d.executor.commands) add('executor', 'Register and pass rsi.executor first', 'prepare', 'executor');

  const planned = d.rounds.find((r: Data) => r.state === 'planned');
  let plan: Data | undefined;
  let initialVars: Data | undefined;
  if (!interrupted) {
    const source = planned?.plan || d.upcoming;
    if (!validPlan(source)) add('plan', 'Submit a cycle plan with groups and seeds', 'prepare', 'plan');
    else {
      plan = structuredClone(source);
      if (plan.requiresExplicitPlan) add('explicitPlan', '上一个探索周期包含自定义 reservedSeeds 绑定，不能直接沿用旧计划重跑；请通过方向决策提交新 rsi_version 重新登记完整兼容的种子计划。', 'iterate', 'version');
      if (d.policy.requireCycleVars && !hasCycleVars(plan)) add('cycleVars', '本评估项已启用每轮前须绑定 cycleVars 门禁，请先通过 rsi_operate(op="cycleVars") 绑定本轮一次性运行时参数后再启动周期。', 'manager', 'cycleVars');
      const current = d.versions.find((v: Data) => v.id === d.objective.currentVersion);
      if (!current) add('versionMissing', 'Unknown current version', 'iterate', 'version');
      else {
        const declared = plan.groups.find((g: Data) => g.control || g.id === 'control');
        const vars = current.vars ?? ((!declared?.version || declared.version === current.id) ? declared?.vars ?? declared?.overrides ?? {} : {});
        initialVars = structuredClone(vars);
        const others = plan.groups.filter((g: Data) => !g.control && g.id !== 'control')
          .map((g: Data) => ({ ...g, control: false, vars: g.vars ?? g.overrides, version: g.version || current.id }));
        const confirming = plan.tier === 'confirm' || others.some((g: Data) => g.confirm);
        plan.groups = !confirming && plan.tier === 'explore' && plan.skipControl === true && others.length ? others
          : [{ id: 'control', label: '当前版本对照', version: current.id, vars: structuredClone(vars), control: true, confirm: false }, ...others];
        if (plan.groups.some((g: Data) => !d.versions.some((v: Data) => v.id === g.version))) add('groupVersion', 'Unknown group version', 'iterate', 'version');
        // First start initializes the control's variables from its declared group. Check
        // against that same projected baseline without writing into the stored version.
        const baseline = { ...d, versions: d.versions.map((v: Data) => v === current ? { ...v, vars } : v) };
        const conflicts = cycleVarsConflicts(baseline, plan.groups, plan.cycleVars);
        if (conflicts.length) add('cycleVarsConflict', `cycleVars cannot override keys that differ across groups: ${conflicts.join(', ')}`, 'manager', 'cycleVars', 'all', { detail: conflicts.join(', ') });
        if (d.rounds.length) plan.seeds = freshSeeds(d, plan.seeds.length);
        if (plan.reservedSeeds !== undefined && plan.tier !== 'explore') add('reservedTier', 'reservedSeeds is only allowed when tier is "explore"', 'iterate', 'plan');
        const seedError = reservedSeedIssue(d, plan.reservedSeeds, plan.seeds);
        if (seedError) add('reservedSeeds', seedError.message, 'iterate', 'plan', 'all', { reason: seedError.code, detail: seedError.detail });
      }
    }
  }
  if (d.objective.state !== 'running') add('notStarted', 'Automatic scheduling is not active', 'manager', 'start', 'schedule');
  if (!insideWindow(d.policy.schedule, now)) add('window', 'Outside the configured run window', 'scheduler', 'wait', 'schedule');
  if (!withinWindowLimit(d.policy.schedule, d.rounds, now)) add('windowLimit', 'The scheduled cycle limit for this window has been reached', 'scheduler', 'wait', 'schedule');
  if (interrupted?.autoResumed) add('interrupted', 'This cycle was already resumed automatically; run it manually to continue', 'manager', 'runCycle', 'schedule');
  const first = blockers.find((b) => b.scope === 'all') || blockers[0];
  const phase = aborting ? 'aborting' : running ? 'running' : evaluating ? 'evaluating' : discussing ? 'analyzing'
    : undecided ? 'decide' : d.versionRequest ? (d.versionRequest.repair ? 'repair' : 'version')
    : interrupted ? (interrupted.autoResumed ? 'interrupted' : 'resuming') : !settled ? blockers.find((b) => b.code.startsWith('prep'))!.code
    : first?.code || 'ready';
  // Pausing prevents new execution, but does not remove work already owed by
  // an evaluator/analyst (including the partial evidence from an abort).
  const phaseCode = phase === 'analyzing' ? 'discussing' : phase === 'decide' ? 'decision' : phase === 'repair' ? 'version' : phase;
  const action = ['done', 'retired'].includes(d.objective.state) ? first : blockers.find((b) => b.code === phaseCode) || first;
  const role = action?.role || 'executor';
  const memberIds = action?.memberIds || (role === 'manager' ? (d.policy.manager?.catId ? [d.policy.manager.catId] : [])
    : role === 'analyze' && discussing ? [...discussing.analysis.waiting] : d.members.filter((m) => m.role === role && m.catId).map((m) => m.catId));
  return {
    phase, role, memberIds, prepSettled: settled,
    canRunCycle: !blockers.some((b) => b.scope === 'all'), canSchedule: blockers.length === 0,
    canAbortCycle: !!running && !aborting,
    blockers, nextAction: { op: action?.action || 'runCycle', role, memberIds, ...(action?.section ? { section: action.section, step: action.step, ...(action.by ? { by: action.by } : {}) } : {}), ...(action?.count !== undefined ? { count: action.count } : {}) },
    runningCycle: running?.n ?? null, abortingCycle: aborting?.n ?? null,
    evaluatingCycle: evaluating?.n ?? null, discussingCycle: discussing?.n ?? null,
    analysisWaiting: discussing?.analysis.waiting || [], pendingDecisionCycle: undecided?.n ?? null,
    interruptedCycle: interrupted?.n ?? null,
    awaitingCycleVars: blockers.some((b) => b.code === 'cycleVars') && !running && !aborting && !evaluating && !discussing && !undecided && !d.versionRequest && !['done', 'retired'].includes(d.objective.state),
    // The prepared plan is private to the start command; readers expose only the projection.
    plan, initialVars,
  };
}

export function progressView(d: Experiment, now: number) {
  const { plan: _plan, initialVars: _vars, ...view } = progress(d, now);
  return view;
}
