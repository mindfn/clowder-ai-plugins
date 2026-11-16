import { enqueue, message, syncObjective } from './init.js';
import { record, text } from './store.js';
import type { Data, Experiment, RsiState } from './types.js';

export function validPlan(plan: unknown): plan is Data {
  return record(plan) && Array.isArray(plan.groups) && plan.groups.length > 0 && Array.isArray(plan.seeds) && plan.seeds.length > 0
    && plan.seeds.every((s: unknown) => Number.isSafeInteger(s) && Number(s) >= 0) && new Set(plan.seeds).size === plan.seeds.length
    && plan.groups.every((g: unknown) => record(g) && text(g.id) && /^[a-zA-Z0-9_-]+$/.test(g.id) && text(g.label) && record(g.vars ?? g.overrides))
    && new Set(plan.groups.map((g: Data) => g.id)).size === plan.groups.length;
}

export function runCycle(state: RsiState, d: Experiment, now: number): Data {
  if (d.executor.state !== 'passed' || !d.executor.commands) return { error: 'Register and pass rsi.executor first' };
  if (d.objective.state === 'paused' || d.objective.state === 'preparing') return { error: 'Objective is not ready' };
  if (d.versionRequest) return { error: 'The prepare member must submit rsi.version first' };
  if (d.rounds.some((r: Data) => ['running', 'evaluating'].includes(r.state) || r.report && !r.decision)) return { error: 'Finish the current cycle first' };
  let round = d.rounds.find((r: Data) => r.state === 'interrupted');
  if (round) {
    for (const run of round.runs) if (run.retryable) Object.assign(run, { state: 'queued', retryable: false, error: null });
    round.state = 'running'; round.end = null;
  } else {
    const planned = d.rounds.find((r: Data) => r.state === 'planned');
    const plan = structuredClone(planned?.plan || d.upcoming);
    if (!validPlan(plan)) return { error: 'Submit a cycle plan with groups and seeds' };
    plan.groups = plan.groups.map((g: Data) => ({ ...g, vars: g.vars ?? g.overrides, version: g.version || d.objective.currentVersion }));
    if (plan.groups.some((g: Data) => !d.versions.some((v: Data) => v.id === g.version))) return { error: 'Unknown group version' };
    const n = planned?.n || Math.max(0, ...d.rounds.map((r: Data) => r.n)) + 1;
    round = planned || { n };
    Object.assign(round, { version: d.objective.currentVersion, start: now, end: null, state: 'running', plan, report: null, decision: null, events: [],
      runs: plan.groups.flatMap((g: Data) => plan.seeds.map((seed: number) => ({ id: `${d.objective.id}-${n}-${g.id}-s${seed}`, group: g.id, seed,
        state: 'queued', start: null, end: null, retries: 0, metrics: {}, artifacts: [], env: {}, log: '', error: null }))) });
    if (!planned) d.rounds.push(round);
  }
  d.objective.round = round.n;
  d.objective.state = 'running';
  enqueue(state, d, 'run', { cycle: round.n });
  syncObjective(state, d);
  return { ok: true, cycle: round.n };
}

export function finishCycle(state: RsiState, d: Experiment, round: Data, now: number) {
  if (round.state !== 'running' || round.runs.some((r: Data) => r.state === 'queued' || r.state === 'running')) return;
  round.state = 'evaluating'; round.end = now;
  d.objective.budget.used++;
  enqueue(state, d, 'agent', { member: d.members.find((m) => m.role === 'evaluate')!.catId, cycle: round.n,
    message: { title: `第 ${round.n} 周期跑完`, body: `第 ${round.n} 周期跑完，调 rsi.task 看指标，再调 rsi.conclude。` } });
  syncObjective(state, d);
}

export function matrix(d: Experiment, round: Data) {
  return round.plan.groups.flatMap((group: Data) => d.metrics.items.map((metric: Data) => {
    const values = round.runs.filter((r: Data) => r.group === group.id && r.state === 'done').map((r: Data) => r.metrics[metric.id]).filter((v: unknown) => typeof v === 'number' && Number.isFinite(v));
    const n = values.length, mean = n ? values.reduce((a: number, b: number) => a + b, 0) / n : null;
    const sd = n > 1 ? Math.sqrt(values.reduce((sum: number, v: number) => sum + (v - mean!) ** 2, 0) / (n - 1)) : null;
    return { group: group.id, metric: metric.id, mean, sd, lo: null, hi: null, n };
  }));
}

export function conclude(state: RsiState, d: Experiment, input: Data, now: number) {
  const round = d.rounds.find((r: Data) => r.n === input.cycle && r.state === 'evaluating');
  if (!round) return { error: 'Cycle is not awaiting evaluation' };
  if (!['baseline', 'keep', 'tune', 'rollback', 'sunset', 'insufficient'].includes(input.verdict)
    || !(text(input.findings) || Array.isArray(input.findings) && input.findings.length && input.findings.every(text))
    || !Array.isArray(input.options) || !input.options.length || input.options.some((o: unknown) => !record(o) || !text(o.k) || !text(o.title) || !text(o.why))
    || new Set(input.options.map((o: Data) => o.k)).size !== input.options.length) return { error: 'Provide verdict, findings and distinct options {k,title,why}' };
  const findings = Array.isArray(input.findings) ? input.findings.join('\n') : input.findings;
  round.report = { verdict: input.verdict, headline: findings.split('\n')[0], summary: findings, matrix: matrix(d, round),
    predictions: [], asks: [], directions: input.options.map((o: Data) => ({ id: o.k, title: o.title, why: o.why, kind: 'code', expect: '', cites: [] })),
    compare: { against: round.plan.groups.find((g: Data) => g.control)?.id || null, comparable: round.plan.groups.some((g: Data) => g.control), note: '同周期运行记录与指标见 rsi.task。' },
    attribution: { verdict: 'unresolved', primaryLayer: null, assessedLayers: [], competingLayers: [], uncertainty: 'not_estimable', comparability: 'unchanged', reasons: [], evidence: [] } };
  round.state = 'done';
  d.objective.state = 'pending';
  message(state, d, now, `第 ${round.n} 周期结论 · ${input.verdict}`, `${findings}\n\n${input.options.map((o: Data) => `${o.k} · ${o.title}：${o.why}`).join('\n')}\n\n在 RSI 页面选择方向。`, 'conclusion');
  syncObjective(state, d);
  return { ok: true };
}
