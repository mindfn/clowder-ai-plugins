import { enqueue, message, prepSettled, STOP_TARGET, syncObjective } from './init.js';
import { record, text } from './store.js';
import type { Data, Experiment, RsiState } from './types.js';

export function validPlan(plan: unknown): plan is Data {
  return record(plan) && Array.isArray(plan.groups) && plan.groups.length > 0 && Array.isArray(plan.seeds) && plan.seeds.length > 0
    && plan.seeds.every((s: unknown) => Number.isSafeInteger(s) && Number(s) >= 0) && new Set(plan.seeds).size === plan.seeds.length
    && plan.groups.every((g: unknown) => record(g) && text(g.id) && /^[a-zA-Z0-9_-]+$/.test(g.id) && text(g.label) && record(g.vars ?? g.overrides))
    && new Set(plan.groups.map((g: Data) => g.id)).size === plan.groups.length;
}

export function freshSeeds(d: Experiment, count: number): number[] {
  const used = d.rounds.flatMap((r: Data) => r.plan.seeds), start = Math.max(0, ...used) + 1;
  return Array.from({ length: count }, (_, i) => start + i);
}

export function controlGroup(d: Experiment): Data {
  const version = d.versions.find((v: Data) => v.id === d.objective.currentVersion);
  return { id: 'control', label: '当前版本对照', version: version.id, vars: version.vars || {}, control: true, confirm: false };
}

// A cycle belongs to the version it tests: the first group other than the control that runs another version,
// otherwise the control's version (a cycle that only tries variables on it).
export function testedVersion(plan: Data): string {
  const control = plan.groups.find((g: Data) => g.control);
  return (plan.groups.find((g: Data) => !g.control && g.version && g.version !== control?.version) || control || plan.groups[0]).version;
}

export function runCycle(state: RsiState, d: Experiment, now: number): Data {
  if (d.executor.state !== 'passed' || !d.executor.commands) return { error: 'Register and pass rsi.executor first' };
  if (!['ready', 'running', 'pending'].includes(d.objective.state)) return { error: 'Objective is not ready' };
  if (d.versionRequest) return { error: 'The prepare member must submit rsi.version first' };
  // A step rewritten after the start holds the next cycle until it is submitted again and confirmed.
  if (!prepSettled(d)) return { error: 'Preparation is being redone: wait for the members, then confirm the changed items' };
  if (d.rounds.some((r: Data) => ['running', 'evaluating'].includes(r.state) || r.report && !r.decision)) return { error: 'Finish the current cycle first' };
  let round = d.rounds.find((r: Data) => r.state === 'interrupted');
  if (round) {
    for (const run of round.runs) if (run.retryable) Object.assign(run, { state: 'queued', retryable: false, error: null });
    round.state = 'running'; round.end = null;
  } else {
    const planned = d.rounds.find((r: Data) => r.state === 'planned');
    const plan = structuredClone(planned?.plan || d.upcoming);
    if (!validPlan(plan)) return { error: 'Submit a cycle plan with groups and seeds' };
    const current = d.versions.find((v: Data) => v.id === d.objective.currentVersion);
    const declared = plan.groups.find((g: Data) => g.control || g.id === 'control');
    if (!current.vars) current.vars = !declared?.version || declared.version === current.id ? declared?.vars ?? declared?.overrides ?? {} : {};
    plan.groups = [controlGroup(d), ...plan.groups.filter((g: Data) => !g.control && g.id !== 'control')
      .map((g: Data) => ({ ...g, control: false, vars: g.vars ?? g.overrides, version: g.version || current.id }))];
    if (plan.groups.some((g: Data) => !d.versions.some((v: Data) => v.id === g.version))) return { error: 'Unknown group version' };
    if (d.rounds.length) plan.seeds = freshSeeds(d, plan.seeds.length);
    const n = planned?.n || Math.max(0, ...d.rounds.map((r: Data) => r.n)) + 1;
    round = planned || { n };
    Object.assign(round, { version: testedVersion(plan), start: now, end: null, state: 'running', plan, metrics: structuredClone(d.metrics), report: null, decision: null, events: [],
      runs: plan.groups.flatMap((g: Data) => plan.seeds.map((seed: number) => ({ id: `${d.objective.id}-${n}-${g.id}-s${seed}`, group: g.id, seed,
        state: 'queued', start: null, end: null, retries: 0, attempts: [], metrics: {}, artifacts: [], env: {}, log: '', error: null }))) });
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
  askEvaluation(state, d, round);
  syncObjective(state, d);
}

// Wakes the evaluate member for a cycle that waits for its conclusion (after the runs, and again from the page when that turn ended without one).
export function askEvaluation(state: RsiState, d: Experiment, round: Data) {
  enqueue(state, d, 'agent', { member: d.members.find((m) => m.role === 'evaluate')!.catId, cycle: round.n,
    message: { title: `第 ${round.n} 周期跑完`, body: `第 ${round.n} 周期跑完，调 rsi.task 看同周期对照、各组均值和逐种子结果，再调 rsi.conclude。` } });
}

export function matrix(d: Experiment, round: Data) {
  return round.plan.groups.flatMap((group: Data) => (round.metrics || d.metrics).items.map((metric: Data) => {
    const seeds = round.runs.filter((r: Data) => r.group === group.id).map((r: Data) => ({ seed: r.seed, value: r.metrics[metric.id] ?? null, state: r.state, error: r.error }));
    const values = seeds.filter((s: Data) => s.state === 'done' && s.error?.kind !== 'env' && typeof s.value === 'number' && Number.isFinite(s.value)).map((s: Data) => s.value);
    const n = values.length, mean = n ? values.reduce((a: number, b: number) => a + b, 0) / n : null;
    const sd = n > 1 ? Math.sqrt(values.reduce((sum: number, v: number) => sum + (v - mean!) ** 2, 0) / (n - 1)) : null;
    return { group: group.id, metric: metric.id, mean, sd, spread: sd, lo: sd === null ? null : mean! - sd, hi: sd === null ? null : mean! + sd, n, seeds };
  }));
}

export function comparison(d: Experiment, round: Data) {
  const cells = matrix(d, round), metrics = (round.metrics || d.metrics).items, main = metrics.find((m: Data) => !m.guard);
  const control = round.plan.groups.find((g: Data) => g.control), cell = (group: string) => cells.find((m: Data) => m.group === group && m.metric === main?.id);
  const valid = (group: string) => round.runs.filter((r: Data) => r.group === group).every((r: Data) => r.state === 'done' && !r.error);
  const reference = control && cell(control.id), comparable = !!reference && reference.n === round.plan.seeds.length && valid(control.id);
  const groups = round.plan.groups.map((g: Data) => {
    const result = cell(g.id), guardrails = round.runs.filter((r: Data) => r.group === g.id && r.state === 'done').flatMap((r: Data) => metrics.filter((m: Data) => m.guard).map((m: Data) => {
      const value = r.metrics[m.id], pass = typeof value === 'number' && Number.isFinite(value) && (m.dir === 'up' ? value >= m.threshold : value <= m.threshold);
      return { metric: m.id, seed: r.seed, value: value ?? null, threshold: m.threshold, dir: m.dir, pass };
    }));
    const eligible = comparable && valid(g.id) && result?.n === round.plan.seeds.length && guardrails.every((g: Data) => g.pass);
    const delta = typeof result?.mean === 'number' && typeof reference?.mean === 'number' ? result.mean - reference.mean : null;
    return { group: g.id, version: g.version, control: !!g.control, mean: result?.mean ?? null, delta, eligible, guardrails,
      beatsControl: !g.control && eligible && (main.dir === 'up' ? delta! > 0 : delta! < 0) };
  });
  return { cycle: round.n, against: control?.id || null, metric: main?.id, dir: main?.dir, comparable, groups, matrix: cells };
}

export function cycleLibrary(state: RsiState, d: Experiment) {
  return state.library[d.objective.projectId].filter((doc: Data) => doc.objectives.includes(d.objective.id) && doc.cycle);
}

function stopAfterConclusion(state: RsiState, d: Experiment, round: Data, compared: Data, improved: boolean, now: number) {
  const progress = d.objective.progress ||= { stall: 0 }, stop = d.objective.stop;
  if (compared.comparable && round.runs.every((r: Data) => r.error?.kind !== 'env')) progress.stall = improved || round.n === 1 ? 0 : progress.stall + 1;
  const target = stop?.target;
  const match = typeof target === 'string' && STOP_TARGET.exec(target);
  const metric = match && (round.metrics || d.metrics).items.find((m: Data) => m.id === match[1].trim() || m.name === match[1].trim());
  const adopted = round.confirmation?.status === 'confirmed' ? round.confirmation.group : 'control';
  const cell = metric && compared.matrix.find((m: Data) => m.group === adopted && m.metric === metric.id);
  const eligible = compared.groups.find((g: Data) => g.group === adopted)?.eligible;
  const reached = eligible && cell && typeof cell.mean === 'number' && match && (['>=', '≥'].includes(match[2]) ? cell.mean >= +match[3] : ['<=', '≤'].includes(match[2]) ? cell.mean <= +match[3] : match[2] === '>' ? cell.mean > +match[3] : cell.mean < +match[3]);
  const reason = reached ? { kind: 'target', text: `达到目标：${target}` }
    : stop?.maxCycles && d.objective.budget.used >= stop.maxCycles ? { kind: 'maxCycles', text: `已完成最多 ${stop.maxCycles} 个周期` }
    : stop?.stall && progress.stall >= stop.stall ? { kind: 'stall', text: `连续 ${stop.stall} 个周期没进步，已暂停` }
    : round.report.verdict === 'sunset' ? { kind: 'sunset', text: '本周期结论：停止评估' } : null;
  if (!reason) return null;
  d.objective.stopReason = { ...reason, cycle: round.n, at: now };
  d.objective.state = reason.kind === 'stall' ? 'paused' : 'done';
  if (reason.kind === 'stall') d.objective.resumeTo = 'running';
  round.decision = { pick: 'same', note: reason.text, by: 'RSI', at: now };
  return reason;
}

// Four significant digits, never in exponent form (0.5075000000000001 → 0.5075, 1234.567 → 1235).
const short = (x: number) => String(Number(x.toPrecision(4)));

export function conclude(state: RsiState, d: Experiment, input: Data, now: number) {
  const round = d.rounds.find((r: Data) => r.n === input.cycle && r.state === 'evaluating');
  if (!round) return { error: 'Cycle is not awaiting evaluation' };
  const previous = cycleLibrary(state, d);
  if (!['baseline', 'keep', 'tune', 'rollback', 'sunset', 'insufficient'].includes(input.verdict)
    || !(text(input.findings) || Array.isArray(input.findings) && input.findings.length && input.findings.every(text))
    || !Array.isArray(input.options) || !input.options.length || input.options.some((o: unknown) => !record(o) || !text(o.k) || !text(o.title) || !text(o.why)
      || o.cites !== undefined && (!Array.isArray(o.cites) || o.cites.some((id: unknown) => !text(id) || !state.library[d.objective.projectId].some((doc: Data) => doc.id === id)))
      || previous.length && !o.cites?.some((id: string) => previous.some((doc: Data) => doc.id === id)))
    || new Set(input.options.map((o: Data) => o.k)).size !== input.options.length) return { error: 'Provide verdict, findings and distinct options {k,title,why,cites?}; cite previous cycle library entries when available' };
  const findings = Array.isArray(input.findings) ? input.findings.join('\n') : input.findings, compared = comparison(d, round);
  const wins = compared.groups.filter((g: Data) => g.beatsControl).sort((a: Data, b: Data) => compared.dir === 'up' ? b.mean - a.mean : a.mean - b.mean);
  const winner = wins[0], candidate = d.candidate;
  let confirmation: Data | null = null;
  if (candidate) {
    const group = round.plan.groups.find((g: Data) => g.confirm && g.version === candidate.version && JSON.stringify(g.vars) === JSON.stringify(candidate.vars));
    const missing = !compared.comparable || round.runs.some((r: Data) => (r.group === 'control' || r.group === group?.id) && r.error?.kind === 'env');
    const holds = !missing && group && winner?.group === group.id && round.plan.seeds.every((s: number) => !candidate.seeds.includes(s));
    confirmation = { status: holds ? 'confirmed' : missing ? 'insufficient' : 'rejected', group: group?.id, version: candidate.version, selectedCycle: candidate.cycle, cycle: round.n };
    if (holds) {
      let version = d.versions.find((v: Data) => v.id === candidate.version);
      if (version.id === d.objective.currentVersion) {
        version = { ...version, id: `v${d.versions.length + 1}`, parent: version.id, current: false, change: candidate.label, at: now };
        delete version.worktree;
        d.versions.push(version);
      }
      const interval = compared.matrix.find((m: Data) => m.group === group.id && m.metric === compared.metric);
      Object.assign(version, { vars: candidate.vars, status: 'confirmed', interval, confirmedCycle: round.n });
      for (const v of d.versions) v.current = v.id === version.id;
      d.objective.currentVersion = version.id;
      confirmation.version = version.id; confirmation.interval = interval;
    }
    if (missing) candidate.seeds.push(...round.plan.seeds);
    else {
      if (!holds && candidate.version !== d.objective.currentVersion) d.versions.find((v: Data) => v.id === candidate.version).status = 'rejected';
      delete d.candidate;
    }
    d.upcoming = { ...round.plan, groups: [controlGroup(d), ...(missing ? [{ ...group, control: false, confirm: true }] : [])], seeds: freshSeeds(d, round.plan.seeds.length) };
  } else if (winner) {
    const group = round.plan.groups.find((g: Data) => g.id === winner.group);
    d.candidate = { ...group, cycle: round.n, seeds: [...round.plan.seeds], against: d.objective.currentVersion };
    const version = d.versions.find((v: Data) => v.id === group.version);
    if (!version.current) version.status = 'candidate';
    confirmation = { status: 'candidate', group: group.id, version: group.version, cycle: round.n };
    d.upcoming = { ...round.plan, groups: [controlGroup(d), { ...group, control: false, confirm: true }], seeds: freshSeeds(d, round.plan.seeds.length) };
  } else d.upcoming = { ...round.plan, seeds: freshSeeds(d, round.plan.seeds.length) };
  const member = d.members.find((m) => m.role === 'evaluate')!;
  round.confirmation = confirmation;
  round.report = { verdict: input.verdict, headline: findings.split('\n')[0], summary: findings, matrix: compared.matrix,
    predictions: [], asks: [], directions: input.options.map((o: Data) => ({ id: o.k, title: o.title, why: o.why, ...(text(o.kind) ? { kind: o.kind } : {}), by: member.catId, model: member.model, expect: '', cites: o.cites || [] })),
    compare: { ...compared, note: '仅比较本周期 control；区间为种子均值 ± 样本标准差。' }, confirmation,
    attribution: { verdict: 'unresolved', primaryLayer: null, assessedLayers: [], competingLayers: [], uncertainty: 'interval', comparability: 'unchanged', reasons: [], evidence: [] } };
  round.state = 'done';
  d.objective.state = 'pending';
  const interval = confirmation?.interval;
  const outcome = confirmation ? `\n\n${confirmation.status === 'candidate' ? '候选：下一周期换新种子确认赢家，默认版本保持当前对照。' : confirmation.status === 'confirmed' ? `确认赢家，采用 ${confirmation.version}：${short(interval.mean)} ± ${interval.spread == null ? '无法估计' : short(interval.spread)}。` : confirmation.status === 'insufficient' ? '复验环境失败，证据不足；保留候选，下周期换新种子继续确认。' : '复验未保持改善，保留当前默认版本。'}` : '';
  // A conclusion that stops the objective asks for no direction; its stop card follows it.
  const stopped = stopAfterConclusion(state, d, round, compared, !!winner, now);
  message(state, d, now, `第 ${round.n} 周期结论 · ${input.verdict}`, `${findings}${outcome}\n\n${input.options.map((o: Data) => `${o.k} · ${o.title}：${o.why}`).join('\n')}${stopped ? '' : '\n\n在 RSI 页面选择方向。'}`, 'conclusion');
  if (stopped) message(state, d, now, stopped.text, `第 ${round.n} 周期结论后停止启动新周期。`, 'conclusion');
  state.library[d.objective.projectId].push({ id: `${d.objective.id}-cycle-${round.n}`, kind: 'feedback', title: `第 ${round.n} 周期：${round.report.headline}`, body: `${round.plan.groups.filter((g: Data) => !g.control).map((g: Data) => `${g.label} (${g.version}) ${JSON.stringify(g.vars)}`).join('\n') || '当前版本基线'}\n\n${findings}${outcome}`,
    objectives: [d.objective.id], cycle: round.n, tried: round.plan.groups.filter((g: Data) => !g.control), result: { verdict: input.verdict, comparison: compared, confirmation }, sources: [{ objective: d.objective.id, cycle: round.n }], state: 'confirmed', by: member.catId, at: now });
  syncObjective(state, d);
  return { ok: true, comparison: compared, confirmation, stop: d.objective.stopReason || null };
}
