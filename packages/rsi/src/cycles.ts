import { AUTO, enqueue, message, prepSettled, REPAIR_DEFAULT, STOP_TARGET, syncObjective } from './init.js';
import { insideWindow, windowStart } from './schedule.js';
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
  round.end = now;
  // Runs of the default version that failed for environment or execution reasons go to the governance member to fix first (PHASE3 §1).
  if (!requestRepair(state, d, round, now)) {
    round.state = 'evaluating';
    d.objective.budget.used++;
    askEvaluation(state, d, round);
  }
  syncObjective(state, d);
}

// A repair stops at the night's allowance, after the same failure three times in a row, or when the member takes longer than REPAIR_WAIT.
export const REPAIR_SAME = 3, REPAIR_WAIT = 60 * 60_000;
const signatureOf = (run: Data) => String(run.error?.analysis || run.error?.raw || '').split('\n').map((l) => l.trim()).filter(Boolean).pop()?.replace(/\d+/g, '#').slice(0, 200) || '未知错误';

function requestRepair(state: RsiState, d: Experiment, round: Data, now: number) {
  const failed = round.runs.filter((r: Data) => r.state === 'failed' && (round.plan.groups.find((g: Data) => g.id === r.group)?.version || d.objective.currentVersion) === d.objective.currentVersion);
  const member = d.members.find((m) => m.role === 'iterate');
  if (!failed.length || !member?.catId) return false;
  const since = windowStart(d.policy.schedule, now), left = (d.policy.repair ?? REPAIR_DEFAULT) - (d.repairs || []).filter((x: Data) => x.at >= since).length;
  const signature = signatureOf(failed[0]), recent = (d.repairs || []).slice(1 - REPAIR_SAME);
  if (left <= 0 || recent.length === REPAIR_SAME - 1 && recent.every((x: Data) => x.signature === signature)) return false;
  round.state = 'repairing';
  d.versionRequest = { cycle: round.n, title: `修第 ${round.n} 周期的运行失败`, direct: true, since: now, decision: null,
    repair: { signature, failures: failed.slice(0, 5).map((r: Data) => ({ run: r.id, group: r.group, seed: r.seed, step: r.error?.step, error: r.error?.raw, analysis: r.error?.analysis || null, log: String(r.log || '').slice(-1500) })) } };
  enqueue(state, d, 'agent', { member: member.catId, action: 'version', message: { title: `第 ${round.n} 周期运行失败，请修`,
    body: `${failed.length} 次运行失败：${signature}。这是执行修复：只修让它跑不起来的问题，不改训练和评测。先调 rsi.task 看失败详情；修好提交 git 后调 rsi.version，插件用修好的版本重跑这一周期的计划。修不了就调 rsi.version({cannot:"原因"})，交给评估成员下结论。本晚还能自动修 ${left} 次。` } });
  message(state, d, now, `第 ${round.n} 周期运行失败，交给 ${member.name} 修`, `错误：${signature}\n\n修好后用修好的版本重跑这一周期的计划；本晚还能自动修 ${left} 次。`, 'plan');
  return true;
}

// A repair that does not come (the member cannot make it, or takes too long): the failed cycle goes to its conclusion as before.
export function abandonRepair(state: RsiState, d: Experiment, reason: string, now: number) {
  const round = d.rounds.find((r: Data) => r.n === d.versionRequest.cycle);
  delete d.versionRequest;
  round.state = 'evaluating';
  d.objective.budget.used++;
  message(state, d, now, `第 ${round.n} 周期的运行失败没有修好`, `${reason}\n\n交给评估成员下结论。`, 'plan');
  askEvaluation(state, d, round);
  syncObjective(state, d);
}

// Wakes the evaluate member for a cycle that waits for its conclusion (after the runs, and again from the page when that turn ended without one).
export function askEvaluation(state: RsiState, d: Experiment, round: Data) {
  enqueue(state, d, 'agent', { member: d.members.find((m) => m.role === 'evaluate')!.catId, cycle: round.n,
    message: { title: `第 ${round.n} 周期跑完`, body: `第 ${round.n} 周期跑完，调 rsi.task 看同周期对照、各组均值和逐种子结果，再调 rsi.conclude。${EXPECT_HINT}` } });
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
      // A win must reach the main metric's minimum valid improvement (minDelta, 0 when not declared).
      beatsControl: !g.control && eligible && (main.dir === 'up' ? delta! > 0 && delta! >= (main.minDelta || 0) : delta! < 0 && -delta! >= (main.minDelta || 0)) };
  });
  return { cycle: round.n, against: control?.id || null, metric: main?.id, dir: main?.dir, comparable, groups, matrix: cells };
}

export function cycleLibrary(state: RsiState, d: Experiment) {
  return state.library[d.objective.projectId].filter((doc: Data) => doc.objectives.includes(d.objective.id) && doc.cycle);
}

function stopAfterConclusion(state: RsiState, d: Experiment, round: Data, compared: Data, now: number) {
  const stop = d.objective.stop;
  const target = stop?.target;
  const match = typeof target === 'string' && STOP_TARGET.exec(target);
  const metric = match && (round.metrics || d.metrics).items.find((m: Data) => m.id === match[1].trim() || m.name === match[1].trim());
  const adopted = round.confirmation?.status === 'confirmed' ? round.confirmation.group : 'control';
  const cell = metric && compared.matrix.find((m: Data) => m.group === adopted && m.metric === metric.id);
  const eligible = compared.groups.find((g: Data) => g.group === adopted)?.eligible;
  const reached = eligible && cell && typeof cell.mean === 'number' && match && (['>=', '≥'].includes(match[2]) ? cell.mean >= +match[3] : ['<=', '≤'].includes(match[2]) ? cell.mean <= +match[3] : match[2] === '>' ? cell.mean > +match[3] : cell.mean < +match[3]);
  const reason = reached ? { kind: 'target', text: `达到目标：${target}` }
    : stop?.maxCycles && d.objective.budget.used >= stop.maxCycles ? { kind: 'maxCycles', text: `已完成最多 ${stop.maxCycles} 个周期` }
    : round.report.verdict === 'sunset' ? { kind: 'sunset', text: '本周期结论：停止评估' } : null;
  if (!reason) return null;
  d.objective.stopReason = { ...reason, cycle: round.n, at: now };
  d.objective.state = 'done';
  round.decision = { pick: 'same', note: reason.text, by: 'RSI', at: now };
  return reason;
}

// Directions a member proposes for a cycle: distinct k, title and why; kind and target optional; cites must name an earlier cycle when there is one.
function badOptions(state: RsiState, d: Experiment, options: unknown, cycle: number): boolean {
  const previous = cycleLibrary(state, d).filter((doc: Data) => doc.cycle < cycle);
  return !Array.isArray(options) || !options.length || options.some((o: unknown) => !record(o) || !text(o.k) || !text(o.title) || !text(o.why)
      || o.target !== undefined && !text(o.target)
      || o.expect !== undefined && !(record(o.expect) && Number.isFinite(+o.expect.lo) && Number.isFinite(+o.expect.hi) && +o.expect.lo <= +o.expect.hi
        && (o.expect.metric === undefined || d.metrics.items.some((m: Data) => m.id === o.expect.metric)))
      || o.cites !== undefined && (!Array.isArray(o.cites) || o.cites.some((id: unknown) => !text(id) || !state.library[d.objective.projectId].some((doc: Data) => doc.id === id)))
      || previous.length && !o.cites?.some((id: string) => previous.some((doc: Data) => doc.id === id)))
    || new Set(options.map((o: Data) => o.k)).size !== options.length;
}
const signed = (x: number) => (x >= 0 ? '+' : '') + short(x);
// A direction may predict how its version changes a metric (the main one by default) against the same cycle's control: expect {lo, hi}.
const directionsFrom = (d: Experiment, options: Data[], member: Data, taken: string[]) => options.map((o: Data) => {
  const metric = record(o.expect) ? o.expect.metric || d.metrics.items.find((m: Data) => !m.guard)?.id : null;
  const predict = metric ? { metric, lo: +o.expect.lo, hi: +o.expect.hi } : null;
  return { id: taken.includes(o.k) ? `${o.k}-${member.catId}` : o.k, title: o.title, why: o.why, ...(text(o.kind) ? { kind: o.kind } : {}), ...(text(o.target) ? { target: o.target.trim() } : {}),
    by: member.catId, model: member.model, expect: predict ? `${metric} ${signed(predict.lo)} ~ ${signed(predict.hi)}` : '', ...(predict ? { predict } : {}), cites: o.cites || [] };
});

// Analysts are members chosen for the role; demo placeholders (no member id, kept by objectives created before alpha.24) never act.
export const analystsOf = (d: Experiment) => d.members.filter((m) => m.role === 'analyze' && m.catId);

// Every request for directions says that a direction may predict its effect (checked by the plugin once its version runs).
const EXPECT_HINT = '方向可以带 expect {lo,hi}：你预期选了它之后，主指标相对同周期对照变化多少；版本跑完后插件自动核对，算进命中率。';

// Analysts that have not proposed within this long are left out and the conclusion goes out without them.
export const ANALYSIS_LIMIT = 20 * 60_000;
// A conclusion nobody decides within this inside the run window goes on with its plan (FLOW §1.5: 没回应，到点用默认 / 照旧).
export const DECISION_WAIT = 30 * 60_000;

// Four significant digits, never in exponent form (0.5075000000000001 → 0.5075, 1234.567 → 1235).
const short = (x: number) => String(Number(x.toPrecision(4)));

// A version made for a predicting direction is checked the first time it runs against a comparable control: the change of the
// predicted metric (its group mean minus the control mean) inside [lo, hi] is a hit.
function checkPredictions(d: Experiment, round: Data, compared: Data): Data[] {
  const mean = (group: string, metric: string) => compared.matrix.find((m: Data) => m.group === group && m.metric === metric)?.mean;
  return round.plan.groups.filter((g: Data) => !g.control).flatMap((g: Data) => {
    const p = d.versions.find((v: Data) => v.id === g.version)?.prediction;
    if (!p || p.checked || !compared.comparable) return [];
    const who = `${d.members.find((m) => m.catId === p.by)?.name || p.by}：${p.text}`;
    // The scale changed and no longer has the predicted metric: say so instead of leaving the prediction unchecked forever.
    if (!(round.metrics || d.metrics).items.some((m: Data) => m.id === p.metric)) {
      p.checked = { cycle: round.n, delta: null, result: 'unresolved' };
      return [{ text: who, expect: p.expect, actual: `量尺里没有 ${p.metric}`, result: 'unresolved', by: p.by }];
    }
    const value = mean(g.id, p.metric), base = mean(compared.against, p.metric);
    if (typeof value !== 'number' || typeof base !== 'number') return [];
    const delta = value - base, result = delta >= p.lo && delta <= p.hi ? 'hit' : 'miss';
    p.checked = { cycle: round.n, delta, result };
    return [{ text: who, expect: p.expect, actual: `${p.metric} ${signed(delta)}`, result, by: p.by }];
  });
}

export function conclude(state: RsiState, d: Experiment, input: Data, now: number) {
  const round = d.rounds.find((r: Data) => r.n === input.cycle && r.state === 'evaluating');
  if (!round) return { error: 'Cycle is not awaiting evaluation' };
  // With analysts the evaluator judges the cycle and may leave the directions to them.
  const analysts = analystsOf(d), options = input.options === undefined && analysts.length ? [] : input.options;
  if (!['baseline', 'keep', 'tune', 'rollback', 'sunset', 'insufficient'].includes(input.verdict)
    || !(text(input.findings) || Array.isArray(input.findings) && input.findings.length && input.findings.every(text))
    || (!analysts.length || options.length) && badOptions(state, d, options, round.n)) return { error: 'Provide verdict, findings and distinct options {k,title,why,kind?,target?,cites?}; cite previous cycle library entries when available' };
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
    predictions: checkPredictions(d, round, compared), asks: [], directions: directionsFrom(d, options, member, []), agree: true,
    compare: { ...compared, note: '仅比较本周期 control；区间为种子均值 ± 样本标准差。' }, confirmation,
    attribution: { verdict: 'unresolved', primaryLayer: null, assessedLayers: [], competingLayers: [], uncertainty: 'interval', comparability: 'unchanged', reasons: [], evidence: [] } };
  round.state = 'done';
  d.objective.state = 'pending';
  const interval = confirmation?.interval;
  const outcome = confirmation ? `\n\n${confirmation.status === 'candidate' ? '候选：下一周期换新种子确认赢家，默认版本保持当前对照。' : confirmation.status === 'confirmed' ? `确认赢家，采用 ${confirmation.version}：${short(interval.mean)} ± ${interval.spread == null ? '无法估计' : short(interval.spread)}。` : confirmation.status === 'insufficient' ? '复验环境失败，证据不足；保留候选，下周期换新种子继续确认。' : '复验未保持改善，保留当前默认版本。'}` : '';
  // A conclusion that stops the objective asks for no direction; its stop card follows it.
  // Nor does one that leaves a winner to confirm: the next cycle is the confirmation whatever is picked.
  round.report.outcome = outcome;
  const stopped = stopAfterConclusion(state, d, round, compared, now);
  if (analysts.length && !stopped && !d.candidate) {
    // The analysts receive the same report and propose side by side; the conclusion card waits for them.
    round.analysis = { waiting: analysts.map((m) => m.catId), since: now };
    for (const m of analysts) enqueue(state, d, 'agent', { member: m.catId, cycle: round.n, action: 'direction', message: { title: `第 ${round.n} 周期：请给方向`,
      body: `评估成员的结论是 ${input.verdict}：${round.report.headline}。调 rsi.task 看同周期对照、各组结果和之前的周期，再调 rsi.propose 交你的方向；几个分析成员的方向会署名并列，交给用户选。${EXPECT_HINT}` } });
  } else conclusionCard(state, d, round, now, stopped);
  state.library[d.objective.projectId].push({ id: `${d.objective.id}-cycle-${round.n}`, kind: 'feedback', title: `第 ${round.n} 周期：${round.report.headline}`, body: `${round.plan.groups.filter((g: Data) => !g.control).map((g: Data) => `${g.label} (${g.version}) ${JSON.stringify(g.vars)}`).join('\n') || '当前版本基线'}\n\n${findings}${outcome}`,
    objectives: [d.objective.id], cycle: round.n, tried: round.plan.groups.filter((g: Data) => !g.control), result: { verdict: input.verdict, comparison: compared, confirmation }, sources: [{ objective: d.objective.id, cycle: round.n }], state: 'confirmed', by: member.catId, at: now });
  syncObjective(state, d);
  return { ok: true, comparison: compared, confirmation, stop: d.objective.stopReason || null, ...(round.analysis ? { analysts: round.analysis.waiting } : {}) };
}

function conclusionCard(state: RsiState, d: Experiment, round: Data, now: number, stopped?: Data | null) {
  // From here the conclusion waits for your decision (a stopping one is already decided).
  if (!round.decision) round.asked = now;
  const report = round.report, nameOf = (id: string) => d.members.find((m) => m.catId === id)?.name || id, several = new Set(report.directions.map((x: Data) => x.by)).size > 1;
  const lines = report.directions.map((x: Data) => `${x.id} · ${x.title}${several ? `（${nameOf(x.by)}）` : ''}：${x.why}`);
  const missing = round.analysis?.missing || [];
  // Agreement is stated only when at least two analysts proposed: one analyst's directions cannot agree or disagree.
  const verdict = (round.analysis?.compared || 0) > 1 && !stopped ? `\n\n${report.agree ? '分析成员意见一致，可以直接采纳。' : '几个分析成员意见不一致，需要你判断。'}` : '';
  const absent = missing.length ? `\n\n${missing.map(nameOf).join('、')} 没在时限内给方向。` : '';
  const checked = report.predictions.length ? `\n\n${report.predictions.map((p: Data) => `预测核对 · ${p.text}：预期 ${p.expect}，实际 ${p.actual}，${p.result === 'hit' ? '命中' : p.result === 'unresolved' ? '无法核对' : '未命中'}`).join('\n')}` : '';
  message(state, d, now, `第 ${round.n} 周期结论 · ${report.verdict}`, `${report.summary}${report.outcome}${checked}\n\n${lines.join('\n')}${verdict}${absent}${stopped ? '' : d.candidate ? '\n\n在 RSI 页面点「今晚照旧」，下一周期跑确认。' : '\n\n在 RSI 页面选择方向。'}`, 'conclusion');
  if (stopped) message(state, d, now, stopped.text, `第 ${round.n} 周期结论后停止启动新周期。`, 'conclusion');
  if (!round.decision) decideAtNight(state, d, round, now);
}

// Inside the run window a conclusion that starts waiting goes on by the rules declared at creation (PHASE3 §2): a candidate is
// confirmed at once; otherwise the first direction is adopted, as if picked on the page, when its kind is allowed and the analysts agree.
function decideAtNight(state: RsiState, d: Experiment, round: Data, now: number) {
  const auto: string[] = d.policy.auto ?? AUTO.default;
  // 都等我定 leaves even a candidate's confirmation to you (or to 照旧 after DECISION_WAIT).
  if (!auto.length || d.objective.state !== 'pending' || !insideWindow(d.policy.schedule, now)) return;
  if (d.candidate) {
    round.decision = { pick: 'same', note: '有候选：直接换新种子复验', by: 'RSI', at: now };
    d.objective.state = 'running';
    message(state, d, now, `第 ${round.n} 周期：有候选，直接换新种子复验`, '复验只换种子、不改任何东西，不用等人：下一周期跑确认。', 'plan');
    return;
  }
  // The first analyst who proposed speaks for them (two or more must agree); without one, the evaluator's first direction.
  const firsts = analystsOf(d).map((m) => round.report.directions.find((x: Data) => x.by === m.catId)).filter(Boolean), first = firsts[0] || round.report.directions[0];
  if (!first || firsts.length > 1 && !round.report.agree || !auto.includes(first.kind)) return;
  round.decision = { pick: 'direction', directionId: first.id, note: '夜里按规则采纳', by: 'RSI', at: now };
  message(state, d, now, `第 ${round.n} 周期：夜里按规则采纳「${first.title}」`, `${first.why}\n\n这类方向声明时定了夜里可以自己定：交给 ${d.members.find((m) => m.role === 'iterate')!.name} 出版本，出好后接着跑。`, 'plan');
  requestVersion(state, d, round);
}

// A pick that changes something asks the governance member for its version, whether made on the page or by the night's rules.
export function requestVersion(state: RsiState, d: Experiment, round: Data) {
  const direction = round.report.directions.find((x: Data) => x.id === round.decision.directionId);
  // An execution fix must not change what is measured: its version replaces the default directly instead of competing with it.
  const direct = direction?.kind === 'execution';
  d.versionRequest = { cycle: round.n, decision: round.decision, title: direction?.title || round.decision.note || round.decision.pick, ...(direct ? { direct } : {}),
    ...(direction?.predict ? { prediction: { ...direction.predict, by: direction.by, text: direction.title, expect: direction.expect, direction: direction.id, cycle: round.n } } : {}) };
  d.objective.state = 'running';
  enqueue(state, d, 'agent', { member: d.members.find((m) => m.role === 'iterate')!.catId, action: 'version',
    message: { title: '准备下一个版本', body: `按「${d.versionRequest.title}」出下一个版本。${direct ? '这是执行修复：不和当前版本对比，登记后直接作为默认版本，所以只修执行，不改训练和评测。' : ''}先调 rsi.task，改项目并提交 git 后调 rsi.version。` } });
  syncObjective(state, d);
}

// An analyst's directions join the report; the last one (or the time limit) sends the conclusion card.
export function propose(state: RsiState, d: Experiment, input: Data, catId: string, now: number) {
  const round = d.rounds.find((r: Data) => r.n === input.cycle && r.analysis?.waiting.includes(catId));
  if (!round) return { error: 'This cycle is not waiting for your directions', status: 409 };
  if (badOptions(state, d, input.options, round.n)) return { error: 'Provide distinct options {k,title,why,kind?,target?,cites?}; cite previous cycle library entries when available' };
  round.report.directions.push(...directionsFrom(d, input.options, d.members.find((m) => m.catId === catId)!, round.report.directions.map((x: Data) => x.id)));
  round.analysis.waiting = round.analysis.waiting.filter((id: string) => id !== catId);
  if (!round.analysis.waiting.length) finishAnalysis(state, d, round, now);
  syncObjective(state, d);
  return { ok: true, waiting: round.analysis.waiting.length };
}

// The analysts agree when their first directions change the same thing in the same way (same kind and target); without a target there is nothing to compare.
// Nobody decided in time: the plan the conclusion set goes on — a candidate is confirmed, otherwise the same groups run again on fresh seeds. Nothing is changed.
export function decideByDefault(state: RsiState, d: Experiment, round: Data, now: number) {
  round.decision = { pick: 'same', note: `${DECISION_WAIT / 60_000} 分钟没人回应，按当前计划继续`, by: 'RSI', at: now };
  d.objective.state = 'running';
  message(state, d, now, `第 ${round.n} 周期：没人回应，按当前计划继续`, d.candidate ? '下一周期换新种子复验候选。' : '下一周期按同样的组换新种子再跑一轮，不改任何东西。下一个结论出来时可以再选方向。', 'plan');
  syncObjective(state, d);
}

export function finishAnalysis(state: RsiState, d: Experiment, round: Data, now: number) {
  const missing = round.analysis.waiting;
  round.analysis = { ...round.analysis, waiting: [], missing };
  const firsts = analystsOf(d).filter((m) => !missing.includes(m.catId!)).map((m) => round.report.directions.find((x: Data) => x.by === m.catId)).filter(Boolean);
  round.analysis.compared = firsts.length;
  round.report.agree = firsts.length < 2 || firsts.every((x: Data) => x.kind && x.target && x.kind === firsts[0].kind && x.target === firsts[0].target);
  conclusionCard(state, d, round, now);
  syncObjective(state, d);
}
