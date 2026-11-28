import { collectHypotheses } from './hypotheses.js';
import { tierOf, screeningRound, tierEvidence } from './tiers.js';
import { progress } from './progress.js';
import { AUTO, clipTitle, enqueue, mention, message, REPAIR_DEFAULT, STOP_TARGET, syncObjective } from './init.js';
import { formatComparisonMarkdown, roundMetrics, roundMetricVersion, sliceMatrix } from './compare.js';
import { insideWindow, windowEnd, windowStart } from './schedule.js';
import { cycleResult, record, text } from './store.js';
import type { Data, Experiment, RsiState } from './types.js';

export const RUN_ORDERS = ['grouped', 'interleaved', 'balanced'] as const;
export type RunOrder = (typeof RUN_ORDERS)[number];

export function validOrder(order: unknown): order is RunOrder {
  return typeof order === 'string' && (RUN_ORDERS as readonly string[]).includes(order);
}

export function orderedPairs(groups: Data[], seeds: number[], order?: RunOrder): { group: Data; seed: number }[] {
  if (order === 'interleaved') {
    return seeds.flatMap((seed) => groups.map((group) => ({ group, seed })));
  }
  if (order === 'balanced') {
    return seeds.flatMap((seed, idx) => (idx % 2 === 1 ? [...groups].reverse() : groups).map((group) => ({ group, seed })));
  }
  return groups.flatMap((group) => seeds.map((seed) => ({ group, seed })));
}

export function validPlan(plan: unknown): plan is Data {
  return record(plan) && Array.isArray(plan.groups) && plan.groups.length > 0 && Array.isArray(plan.seeds) && plan.seeds.length > 0
    && plan.seeds.every((s: unknown) => Number.isSafeInteger(s) && Number(s) >= 0) && new Set(plan.seeds).size === plan.seeds.length
    && (plan.order === undefined || validOrder(plan.order))
    && plan.groups.every((g: unknown) => record(g) && text(g.id) && /^[a-zA-Z0-9_-]+$/.test(g.id) && text(g.label) && record(g.vars ?? g.overrides))
    && new Set(plan.groups.map((g: Data) => g.id)).size === plan.groups.length;
}

export function usedSeeds(d: Experiment): Set<number> {
  return new Set(d.rounds.flatMap((r: Data) => [
    ...(Array.isArray(r.plan?.seeds) ? r.plan.seeds : []),
    ...(Array.isArray(r.plan?.reservedSeeds) ? r.plan.reservedSeeds : []),
  ]));
}

export function reservedSeedIssue(d: Experiment, reserved: unknown, scheduledSeeds: number[]): { code: string; detail: string; message: string } | null {
  if (reserved === undefined) return null;
  if (!Array.isArray(reserved) || reserved.length > 20 || reserved.some((s: unknown) => !Number.isSafeInteger(s) || (s as number) < 0))
    return { code: 'shape', detail: '', message: 'reservedSeeds must be an array of up to 20 non-negative integers' };
  const nums = reserved as number[];
  if (new Set(nums).size !== nums.length) return { code: 'duplicate', detail: '', message: 'reservedSeeds must not contain duplicate seeds' };
  const history = usedSeeds(d);
  const histDup = nums.filter((s) => history.has(s));
  if (histDup.length) return { code: 'history', detail: histDup.join(', '), message: `reservedSeeds overlaps previously used seeds: ${histDup.join(', ')}` };
  const schedSet = new Set(scheduledSeeds);
  const schedDup = nums.filter((s) => schedSet.has(s));
  if (schedDup.length) return { code: 'scheduled', detail: schedDup.join(', '), message: `reservedSeeds must list only extra internal seeds and must not overlap scheduled seeds: ${schedDup.join(', ')}` };
  return null;
}

export function validateReservedSeeds(d: Experiment, reserved: unknown, scheduledSeeds: number[]): string | null {
  return reservedSeedIssue(d, reserved, scheduledSeeds)?.message || null;
}

export function freshSeeds(d: Experiment, count: number): number[] {
  const start = Math.max(0, ...usedSeeds(d)) + 1;
  return Array.from({ length: count }, (_, i) => start + i);
}

export function controlGroup(d: Experiment): Data {
  const version = d.versions.find((v: Data) => v.id === d.objective.currentVersion);
  return { id: 'control', label: '当前版本对照', version: version.id, vars: version.vars || {}, control: true, confirm: false };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

// Reject cycleVars keys that would erase treatment differences in a multi-arm plan:
// if any non-control arm defines key k and the arms do not all agree on k, overriding k is forbidden.
// Shared bench keys that only exist as legacy placeholders on control (absent on treatment arms) remain overridable.
export function cycleVarsConflicts(d: Experiment, groups: Data[], cycleVars: unknown): string[] {
  if (!record(cycleVars) || !Array.isArray(groups) || groups.length < 2) return [];
  const keys = Object.keys(cycleVars);
  if (!keys.length) return [];
  const perGroup = groups.map((g: Data) => {
    const isControl = !!(g.control || g.id === 'control');
    const resolved = isControl ? controlGroup(d) : g;
    const ver = d.versions.find((v: Data) => v.id === (resolved.version || d.objective.currentVersion));
    const merged: Data = {
      ...(record(ver?.config) ? ver.config : {}),
      ...(record(ver?.vars) ? ver.vars : {}),
      ...(record(resolved.vars) ? resolved.vars : record(resolved.overrides) ? resolved.overrides : {}),
    };
    return { isControl, merged };
  });
  const conflicts: string[] = [];
  for (const k of keys) {
    const definedByTreatment = perGroup.some((g) => !g.isControl && Object.prototype.hasOwnProperty.call(g.merged, k));
    if (!definedByTreatment) continue;
    const vals = new Set(perGroup.map((g) => Object.prototype.hasOwnProperty.call(g.merged, k) ? canonicalJson(g.merged[k]) : 'undefined'));
    if (vals.size > 1) conflicts.push(k);
  }
  return conflicts;
}

export function hasCycleVars(plan: Data | undefined): boolean {
  return !!plan && record(plan.cycleVars) && Object.keys(plan.cycleVars).length > 0;
}

export function needsCycleVars(d: Experiment): boolean {
  return !!(d.policy?.requireCycleVars || d.upcoming && tierOf(d, d.upcoming)?.requireCycleVars) && !hasCycleVars(d.upcoming);
}

export function notifyAwaitingCycleVars(state: RsiState, d: Experiment, now: number, reason: string) {
  const manager = d.policy?.manager;
  if (!d.objective.projectPath || !needsCycleVars(d) || !manager?.catId) return;
  const pausedHint = d.objective.state === 'paused' ? '（评估项当前处于暂停态）' : '';
  enqueue(state, d, 'agent', {
    member: manager.catId,
    action: 'cycleVars',
    message: {
      title: '下一周期待绑定本轮参数（cycleVars）',
      body: `${mention(manager)} ${reason}${pausedHint}。因已启用「每轮前须绑定 cycleVars」门禁，系统暂不自动启动下一周期；请先确认外部资源/租约，再调原生 MCP 工具 rsi_operate(op="cycleVars") 绑定本轮参数并启动。`,
    },
  });
}

// A cycle belongs to the version it tests: the first group other than the control that runs another version,
// otherwise the control's version (a cycle that only tries variables on it).
export function testedVersion(plan: Data): string {
  const control = plan.groups.find((g: Data) => g.control);
  return (plan.groups.find((g: Data) => !g.control && g.version && g.version !== control?.version) || control || plan.groups[0]).version;
}

export function runCycle(state: RsiState, d: Experiment, now: number): Data {
  const readiness = progress(d, now);
  if (!readiness.canRunCycle) return { error: readiness.blockers.find((b) => b.scope === 'all')!.message, blockers: readiness.blockers };
  let round = d.rounds.find((r: Data) => r.state === 'interrupted');
  if (round) {
    for (const run of round.runs) if (run.retryable) Object.assign(run, { state: 'queued', retryable: false, error: null });
    // Resumed with 跑一轮 it no longer keeps to the window; the schedule marks what it resumes again.
    round.state = 'running'; round.end = null; delete round.scheduled;
  } else {
    const planned = d.rounds.find((r: Data) => r.state === 'planned');
    const plan = readiness.plan!;
    const current = d.versions.find((v: Data) => v.id === d.objective.currentVersion);
    if (!current.vars) current.vars = readiness.initialVars!;
    if (!d.policy.confirmSeeds && plan.tierRule?.adoption !== false && plan.seeds.length > 0) d.policy.confirmSeeds = plan.seeds.length;
    const n = planned?.n || Math.max(0, ...d.rounds.map((r: Data) => r.n)) + 1;
    round = planned || { n };
    Object.assign(round, { tier: plan.tier || 'confirm', ...(plan.scenario ? { scenario: plan.scenario } : {}), ...(plan.hypothesisIds ? { hypothesisIds: [...plan.hypothesisIds] } : {}), version: testedVersion(plan), start: now, end: null, state: 'running', plan, metrics: structuredClone(d.metrics), report: null, decision: null, events: [],
      runs: orderedPairs(plan.groups, plan.seeds, plan.order).map(({ group: g, seed }) => ({ id: `${d.objective.id}-${n}-${g.id}-s${seed}`, group: g.id, seed,
        state: 'queued', start: null, end: null, retries: 0, attempts: [], metrics: {}, artifacts: [], env: {}, log: '', error: null })) });
    if (!planned) {
      d.rounds.push(round);
      // One-shot per-cycle runtime overrides are snapshotted onto round.plan and never carried into future cycles.
      if (d.upcoming?.cycleVars) delete d.upcoming.cycleVars;
    }
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
    askEvaluation(state, d, round, false, now);
  }
  syncObjective(state, d);
}

export function settleAbort(state: RsiState, d: Experiment, round: Data, now: number) {
  if (round.state !== 'aborting' || round.runs.some((r: Data) => r.cancelResult?.status === 'pending')) return;
  round.end = now;
  const evidence = round.runs.filter((r: Data) => r.evidence === true);
  const evaluate = round.aborted.reason !== 'env' && evidence.length > 0;
  round.state = evaluate ? 'evaluating' : 'aborted';
  d.objective.budget.used++;
  const reasons: Data = { budget: '预算用完', env: '环境问题', eliminated: '实测淘汰', manual: '人工停止' };
  const cleanup = round.runs.filter((r: Data) => r.cancelResult).map((r: Data) => `${r.id}: ${r.cancelResult.status}${r.jobId ? `（作业 ${r.jobId} 尚未确认清理）` : ''}`).join('；');
  message(state, d, now, `第 ${round.n} 周期已中止：${reasons[round.aborted.reason]}`,
    `${round.aborted.note || ''}\n保留 ${evidence.length} 次已完成运行；其余队列不会重试。${cleanup ? `\n清理：${cleanup}` : ''}\n评估项已暂停，恢复需明确操作。${evaluate ? '已交评估成员审阅部分证据，不自动晋升。' : '未派发科学评估。'}`, 'conclusion');
  if (evaluate) askEvaluation(state, d, round, false, now);
  syncObjective(state, d);
}

// A repair stops at the night's allowance, after the same failure three times in a row, or when the member takes longer than REPAIR_WAIT.
export const REPAIR_SAME = 3, REPAIR_WAIT = 60 * 60_000;
// The project directory is the user's working tree and may hold work not yet committed: versions are made beside it.
const WORKTREE = '在单独的 git worktree 里、自己的分支上改并在那里提交；不要在项目目录本身改文件、提交、切分支、stash 或 reset（用户的工作区里可能有还没提交的改动）。';
const usableAnalysis = (value: unknown) => {
  const s = typeof value === 'string' ? value.trim() : '';
  return s && !/^[\[{]/.test(s) ? s : '';
};
const signatureOf = (run: Data) => String(usableAnalysis(run.error?.analysis) || run.error?.raw || '').split('\n').map((l) => l.trim()).filter(Boolean).pop()?.replace(/\d+/g, '#').slice(0, 200) || '未知错误';

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
  enqueue(state, d, 'agent', { member: member.catId, cycle: round.n, action: 'version', message: { title: `第 ${round.n} 周期运行失败，请修`,
    body: `${mention(member)} ${failed.length} 次运行失败：${signature}。这是执行修复：只修让它跑不起来的问题，不改训练和评测。先调原生 MCP 工具 rsi_task 看失败详情；修好提交 git 后调 rsi_version，插件用修好的版本重跑这一周期的计划。${WORKTREE}修不了就调 rsi_version({cannot:"原因"})，交给评估成员下结论。本晚还能自动修 ${left} 次。` } });
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
  askEvaluation(state, d, round, false, now);
  syncObjective(state, d);
}

// Wakes the evaluate member for a cycle that waits for its conclusion (after the runs, and again from the page when that turn ended without one).
export function askEvaluation(state: RsiState, d: Experiment, round: Data, reeval = false, now = Date.now()) {
  const member = d.members.find((m) => m.role === 'evaluate')!;
  round.evalAskedAt = now;
  delete round.evalStalledNotified;
  delete round.invocationId;
  enqueue(state, d, 'agent', { member: member.catId, cycle: round.n, action: 'evaluate',
    message: { title: reeval ? `第 ${round.n} 周期：重新分析指标` : `第 ${round.n} 周期跑完`, body: `${mention(member)} ${round.aborted ? '本周期已中止，只评估保留的部分证据，不可当作完整验证或据此晋升。' : ''}${reeval ? `用户请求重新分析第 ${round.n} 周期指标与结论` : `第 ${round.n} 周期跑完`}，调原生 MCP 工具 rsi_task 看同周期对照、各组均值和逐种子结果，再调 rsi_conclude。${EXPECT_HINT}` } });
}

export function matrix(d: Experiment, round: Data) {
  return round.plan.groups.flatMap((group: Data) => roundMetrics(d, round).items.map((metric: Data) => {
    const seeds = round.runs.filter((r: Data) => r.group === group.id).map((r: Data) => ({ seed: r.seed, value: r.metrics[metric.id] ?? null, state: r.state, error: r.error }));
    const values = seeds.filter((s: Data) => s.state === 'done' && s.error?.kind !== 'env' && typeof s.value === 'number' && Number.isFinite(s.value)).map((s: Data) => s.value);
    const n = values.length, mean = n ? values.reduce((a: number, b: number) => a + b, 0) / n : null;
    const sd = n > 1 ? Math.sqrt(values.reduce((sum: number, v: number) => sum + (v - mean!) ** 2, 0) / (n - 1)) : null;
    return { group: group.id, metric: metric.id, mean, sd, spread: sd, lo: sd === null ? null : mean! - sd, hi: sd === null ? null : mean! + sd, n, seeds };
  }));
}

export function comparison(d: Experiment, round: Data) {
  const scale = roundMetrics(d, round);
  if (scale.fallback) {
    const prev = round.report?.compare;
    if (prev && Array.isArray(prev.groups)) {
      const prevMatrix = Array.isArray(round.report?.matrix) && round.report.matrix.length
        ? structuredClone(round.report.matrix)
        : matrix(d, round);
      const cloned = structuredClone(prev);
      if (cloned.unrecomputable) {
        delete cloned.preservedFromReport;
        return {
          ...cloned,
          cycle: cloned.cycle ?? round.n,
          matrix: prevMatrix,
        };
      }
      return {
        ...cloned,
        cycle: cloned.cycle ?? round.n,
        preservedFromReport: true,
        matrix: prevMatrix,
      };
    }
    const cells = matrix(d, round), metrics = scale.items, main = metrics.find((m: Data) => !m.guard);
    const control = round.plan.groups.find((g: Data) => g.control), cell = (group: string) => cells.find((m: Data) => m.group === group && m.metric === main?.id);
    const reference = control && cell(control.id);
    const groups = round.plan.groups.map((g: Data) => {
      const result = cell(g.id);
      const delta = typeof result?.mean === 'number' && typeof reference?.mean === 'number' ? result.mean - reference.mean : null;
      return { group: g.id, version: g.version, control: !!g.control, mean: result?.mean ?? null, delta, eligible: false, guardrails: [], beatsControl: false };
    });
    return {
      cycle: round.n,
      against: control?.id || null,
      metric: main?.id,
      dir: main?.dir,
      comparable: false,
      unrecomputable: true,
      unrecomputableReason: `历史量尺 ${scale.version} 快照缺失且无原报告实录，无法按现行 ${d.metrics?.version || ''} 规则复算同周期判定`,
      groups,
      matrix: cells,
    };
  }
  const cells = matrix(d, round), metrics = scale.items, main = metrics.find((m: Data) => !m.guard);
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
    const passes = main.margin !== undefined
      ? main.dir === 'up' ? delta! >= -main.margin : delta! <= main.margin
      : main.dir === 'up' ? delta! > 0 && delta! >= (main.minDelta || 0) : delta! < 0 && -delta! >= (main.minDelta || 0);
    return { group: g.id, version: g.version, control: !!g.control, mean: result?.mean ?? null, delta, eligible, guardrails,
      // A margin asks whether the change is not meaningfully worse; otherwise a win must improve by minDelta.
      beatsControl: !g.control && eligible && passes };
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
  const metric = match && roundMetrics(d, round).items.find((m: Data) => m.id === match[1].trim() || m.name === match[1].trim());
  const adopted = round.confirmation?.status === 'confirmed' ? round.confirmation.group : 'control';
  const cell = metric && compared.matrix.find((m: Data) => m.group === adopted && m.metric === metric.id);
  const eligible = compared.groups.find((g: Data) => g.group === adopted)?.eligible;
  const reached = !screeningRound(round) && eligible && cell && typeof cell.mean === 'number' && match && (['>=', '≥'].includes(match[2]) ? cell.mean >= +match[3] : ['<=', '≤'].includes(match[2]) ? cell.mean <= +match[3] : match[2] === '>' ? cell.mean > +match[3] : cell.mean < +match[3]);
  const reason = reached ? { kind: 'target', text: `达到目标：${target}` }
    : stop?.maxCycles && d.objective.budget.used >= stop.maxCycles ? { kind: 'maxCycles', text: `已完成最多 ${stop.maxCycles} 个周期` }
    : round.report.verdict === 'sunset' ? { kind: 'sunset', text: '本周期结论：停止评估' } : null;
  if (!reason) return null;
  d.objective.stopReason = { ...reason, cycle: round.n, at: now };
  d.objective.state = 'done';
  delete d.objective.resumeTo;
  round.decision = { pick: 'same', note: reason.text, by: 'RSI', at: now };
  d.closeoutReport = buildCloseoutReport(d, now, 'RSI');
  return reason;
}

const STOP_KIND_LABEL: Record<string, string> = {
  manual: '人工结项 / 毕业',
  target: '达到目标自动结项',
  maxCycles: '达到周期上限自动结项',
  sunset: '评估建议停止',
};

const mdCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

// Deterministic, record-grounded closeout report built purely from persisted objective/version/round records.
export function buildCloseoutReport(d: Experiment, now: number, by?: string): Data {
  const stop = d.objective.stopReason || {};
  const reasonText = typeof stop.text === 'string' && stop.text.trim() ? stop.text.trim() : '评估已结束';
  const kindLabel = (stop.kind && STOP_KIND_LABEL[stop.kind]) || '结项';
  const actor = by || stop.by || 'RSI';
  const at = typeof stop.at === 'number' ? stop.at : now;
  const rounds: Data[] = Array.isArray(d.rounds) ? d.rounds : [];
  const versions: Data[] = Array.isArray(d.versions) ? d.versions : [];
  const reportedRounds = rounds.filter((r) => r.report);
  const verdictCounts: Record<string, number> = {};
  for (const r of reportedRounds) {
    const v = r.report?.verdict;
    if (v) verdictCounts[v] = (verdictCounts[v] || 0) + 1;
  }
  const verdictSummary = Object.entries(verdictCounts).map(([k, n]) => `${k} ${n}`).join(' / ') || '暂无';

  const preds = reportedRounds.flatMap((r) => (Array.isArray(r.report?.predictions) ? r.report.predictions : []));
  const resolvedPreds = preds.filter((p: Data) => p.result && p.result !== 'unresolved');
  const hitPreds = resolvedPreds.filter((p: Data) => p.result === 'hit');
  const predText = resolvedPreds.length ? `${hitPreds.length}/${resolvedPreds.length}（${Math.round((hitPreds.length / resolvedPreds.length) * 100)}%）` : '暂无可核对预测';

  const latestReportOf = (vid: string) => [...reportedRounds].reverse().find((r) => r.version === vid)?.report;
  const dispOf = (v: Data) => v.disposition || latestReportOf(v.id)?.disposition || null;
  const tagOf = (v: Data) => v.tag || latestReportOf(v.id)?.tag || '';

  const curVer = versions.find((v) => v.id === d.objective.currentVersion) || versions.find((v) => v.current) || versions[0];
  const latestAdvance = [...versions].reverse().find((v) => dispOf(v) === 'advance');
  const verBrief = (v: Data | undefined) => {
    if (!v) return '—';
    const commit = v.commit ? `@${String(v.commit).slice(0, 7)}` : '';
    const t = tagOf(v);
    const tag = t ? ` · ${t}` : '';
    return `${v.id}${commit}${tag}`;
  };

  const metricCellOf = (round: Data, groupId: string, metricId: string): { mean: number; spread: number | null } | null => {
    const cell = Array.isArray(round.report?.matrix)
      ? round.report.matrix.find((c: Data) => c.group === groupId && c.metric === metricId && typeof c.mean === 'number' && Number.isFinite(c.mean))
      : null;
    if (cell) return { mean: cell.mean, spread: typeof cell.spread === 'number' && Number.isFinite(cell.spread) ? cell.spread : null };
    const vals = (round.runs || [])
      .filter((u: Data) => u.group === groupId && u.state === 'done' && u.error?.kind !== 'env' && typeof u.metrics?.[metricId] === 'number' && Number.isFinite(u.metrics[metricId]))
      .map((u: Data) => u.metrics[metricId] as number);
    if (!vals.length) return null;
    const mean = vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
    if (vals.length === 1) return { mean, spread: null };
    const sd = Math.sqrt(vals.reduce((s: number, x: number) => s + (x - mean) ** 2, 0) / (vals.length - 1));
    return { mean, spread: sd };
  };
  const curMetricVersion = typeof d.metrics?.version === 'string' && d.metrics.version.trim() ? d.metrics.version.trim() : null;
  const fmtCell = (hit: { mean: number; spread: number | null; cycle: number; version: string; metricVersion: string | null } | null, unit: string) => {
    if (!hit) return '—';
    const u = unit ? ` ${unit}` : '';
    const val = hit.spread != null ? `${short(hit.mean)} ± ${short(hit.spread)}${u}` : `${short(hit.mean)}${u}`;
    const mv = hit.metricVersion && curMetricVersion && hit.metricVersion !== curMetricVersion ? `·${hit.metricVersion}` : '';
    return `${val}（${hit.version}·C${hit.cycle}${mv}）`;
  };
  const findBaselineMetric = (metricId: string) => {
    for (const r of rounds) {
      const groups: Data[] = r.plan?.groups || [];
      const ctrl = groups.find((g: Data) => g.control) || (r.plan?.baseline ? groups[0] : null);
      if (!ctrl) continue;
      const cell = metricCellOf(r, ctrl.id, metricId);
      if (cell) return { ...cell, cycle: r.n, version: ctrl.version || r.version, metricVersion: roundMetricVersion(d, r) };
    }
    return null;
  };
  const findLatestVersionMetric = (versionId: string | undefined, metricId: string) => {
    if (!versionId) return null;
    for (let i = rounds.length - 1; i >= 0; i--) {
      const r = rounds[i];
      const groups: Data[] = r.plan?.groups || [];
      const targetGroup = groups.find((g) => !g.control && g.version === versionId) || groups.find((g) => g.version === versionId);
      if (!targetGroup) continue;
      const cell = metricCellOf(r, targetGroup.id, metricId);
      if (cell) return { ...cell, cycle: r.n, version: versionId, metricVersion: roundMetricVersion(d, r) };
    }
    return null;
  };

  const hasDistinctAdvance = !!latestAdvance && latestAdvance.id !== curVer?.id;
  const metricsItems: Data[] = Array.isArray(d.metrics?.items) ? d.metrics.items : [];
  const mainMetricId = metricsItems.find((m) => !m.guard)?.id || null;
  const metricRows = metricsItems.map((m, idx) => {
    const baseHit = findBaselineMetric(m.id);
    const curHit = findLatestVersionMetric(curVer?.id, m.id);
    const advHit = hasDistinctAdvance ? findLatestVersionMetric(latestAdvance!.id, m.id) : null;
    const isMain = m.id === mainMetricId;
    const prio = isMain ? 0
      : advHit ? 1
      : curHit ? (m.guard ? 2 : 3)
      : m.guard ? 4 : 5;
    return { m, idx, prio, isMain, baseHit, curHit, advHit };
  });
  const orderedMetrics = [...metricRows]
    .sort((a, b) => a.prio - b.prio || a.idx - b.idx)
    .slice(0, 16);

  const lines: string[] = [];
  lines.push('### 1. 结项概览');
  lines.push(`- **结项方式**：${kindLabel}（操作者：${actor}）`);
  lines.push(`- **结项说明**：${reasonText}`);
  lines.push(`- **评估目标**：${clipTitle(d.objective.goal?.statement || d.objective.name, 200, d.objective.id)}`);
  lines.push(`- **规模统计**：共 **${rounds.length}** 个周期（已出结论 ${reportedRounds.length}：${verdictSummary}），共 **${versions.length}** 个版本，预测命中率 ${predText}`);
  lines.push(`- **当前正式版本**：\`${verBrief(curVer)}\``);
  if (hasDistinctAdvance) {
    lines.push(`- **最新推进里程碑**：\`${verBrief(latestAdvance)}\`（未自动替换当前正式版）`);
  }

  if (orderedMetrics.length) {
    lines.push('');
    lines.push('### 2. 核心指标对照');
    lines.push('_各列取自不同周期的实测（括号内为版本·周期；量尺版本不同时另标量尺号），条件可能不同，不是同周期对照，不能直接相减；同周期对照请看各周期结论。_');
    if (hasDistinctAdvance) {
      lines.push(`| 指标 | 角色 | 基线实测 | 当前正式版（${curVer?.id || '—'}） | 最新推进版（${latestAdvance!.id}） |`);
      lines.push('|---|---|---|---|---|');
    } else {
      lines.push(`| 指标 | 角色 | 基线实测 | 当前正式版（${curVer?.id || '—'}） |`);
      lines.push('|---|---|---|---|');
    }
    for (const row of orderedMetrics) {
      const { m, isMain, baseHit, curHit, advHit } = row;
      const role = isMain ? '主指标' : m.guard ? `护栏${m.line ? `（${m.line}）` : ''}` : '辅助';
      const unit = m.unit || '';
      const base = fmtCell(baseHit, unit);
      const cur = fmtCell(curHit, unit);
      if (hasDistinctAdvance) {
        const adv = fmtCell(advHit, unit);
        lines.push(`| ${mdCell(m.name || m.id)} | ${mdCell(role)} | ${mdCell(base)} | ${mdCell(cur)} | ${mdCell(adv)} |`);
      } else {
        lines.push(`| ${mdCell(m.name || m.id)} | ${mdCell(role)} | ${mdCell(base)} | ${mdCell(cur)} |`);
      }
    }
    if (metricsItems.length > orderedMetrics.length) {
      lines.push(`_（其余 ${metricsItems.length - orderedMetrics.length} 项指标略，可在周期记录中查看完整矩阵。）_`);
    }
  }

  const milestones = versions.filter((v) => v.current || v.status === 'confirmed' || dispOf(v) === 'advance');
  if (milestones.length) {
    lines.push('');
    lines.push(`### 3. 演进里程碑（共 ${milestones.length} 个关键节点）`);
    const shown = milestones.length <= 12 ? milestones : [...milestones.slice(0, 4), ...milestones.slice(-8)];
    for (const v of shown) {
      const parent = v.parent ? ` ← ${v.parent}` : '';
      const commit = v.commit ? ` \`${String(v.commit).slice(0, 7)}\`` : '';
      const t = tagOf(v);
      const tag = t ? ` **${t}**` : '';
      const change = v.change ? `：${clipTitle(v.change, 90, '')}` : '';
      lines.push(`- **${v.id}**${parent}${commit}${v.current ? '（当前正式版）' : ''}${tag}${change}`);
    }
    if (milestones.length > shown.length) {
      lines.push(`- _（中间 ${milestones.length - shown.length} 个过渡推进节点已折叠，完整谱系见总览图。）_`);
    }
  }

  const rollbackVerIds = new Set(reportedRounds.filter((r) => r.report?.verdict === 'rollback').map((r) => r.version));
  const pruned = versions.filter((v) => !v.current && (dispOf(v) === 'dead_end' || v.status === 'rejected' || rollbackVerIds.has(v.id)));
  if (pruned.length) {
    lines.push('');
    lines.push(`### 4. 已验证淘汰路线与避坑清单（共 ${pruned.length} 项）`);
    for (const v of pruned.slice(-15)) {
      const parent = v.parent ? `（自 ${v.parent} 分出）` : '';
      const t = tagOf(v);
      const tag = t ? ` **${t}**` : '';
      const rMatch = latestReportOf(v.id);
      const detail = t ? '' : (rMatch?.headline ? `：${clipTitle(rMatch.headline, 90, '')}` : v.change ? `：${clipTitle(v.change, 90, '')}` : '');
      lines.push(`- **${v.id}**${parent}${tag}${detail}`);
    }
  }

  if (reportedRounds.length) {
    lines.push('');
    lines.push('### 5. 近期周期结论摘录');
    for (const r of reportedRounds.slice(-5)) {
      lines.push(`- **C${r.n}**（${r.version} · \`${r.report.verdict}\`）：${clipTitle(r.report.headline || r.report.summary || '', 120, '')}`);
    }
  }
  const repairs: Data[] = Array.isArray(d.repairs) ? d.repairs : [];
  if (repairs.length) {
    lines.push('');
    lines.push(`- **自动修复记录**：共 ${repairs.length} 次（最近：${repairs.slice(-3).map((x) => `${x.version}「${clipTitle(x.signature || '', 40, '')}」`).join('；')}）`);
  }

  return {
    at,
    by: actor,
    kind: stop.kind || 'manual',
    cycle: stop.cycle ?? (rounds.length ? rounds[rounds.length - 1].n : d.objective.round || 0),
    reason: reasonText,
    stats: {
      rounds: rounds.length,
      concludedRounds: reportedRounds.length,
      versions: versions.length,
      milestones: milestones.length,
      pruned: pruned.length,
      currentVersion: curVer?.id || null,
      latestAdvanceVersion: latestAdvance?.id || null,
      predictionsHit: hitPreds.length,
      predictionsResolved: resolvedPreds.length,
    },
    markdown: lines.join('\n'),
  };
}

// Directions a member proposes for a cycle: distinct k, title and why; kind, target and baseVersion optional; cites must name an earlier cycle when there is one.
function badOptions(state: RsiState, d: Experiment, options: unknown, cycle: number): boolean {
  const previous = cycleLibrary(state, d).filter((doc: Data) => doc.cycle < cycle);
  return !Array.isArray(options) || !options.length || options.some((o: unknown) => !record(o) || !text(o.k) || !text(o.title) || !text(o.why)
      || o.target !== undefined && !text(o.target)
      || o.baseVersion !== undefined && (!text(o.baseVersion) || !d.versions.some((v: Data) => v.id === o.baseVersion.trim()))
      || o.expect !== undefined && !(record(o.expect) && Number.isFinite(+o.expect.lo) && Number.isFinite(+o.expect.hi) && +o.expect.lo <= +o.expect.hi
        && (o.expect.metric === undefined || d.metrics.items.some((m: Data) => m.id === o.expect.metric)))
      || o.cites !== undefined && (!Array.isArray(o.cites) || o.cites.some((id: unknown) => !text(id) || !state.library[d.objective.projectId].some((doc: Data) => doc.id === id)))
      || previous.length && !o.cites?.some((id: string) => previous.some((doc: Data) => doc.id === id)))
    || new Set(options.map((o: Data) => o.k)).size !== options.length;
}
export const signed = (x: number) => (x >= 0 ? '+' : '') + short(x);
// A direction may predict how its version changes a metric (the main one by default) against the same cycle's control: expect {lo, hi}.
const directionsFrom = (d: Experiment, options: Data[], member: Data, taken: string[]) => options.map((o: Data) => {
  const metric = record(o.expect) ? o.expect.metric || d.metrics.items.find((m: Data) => !m.guard)?.id : null;
  const predict = metric ? { metric, lo: +o.expect.lo, hi: +o.expect.hi } : null;
  const baseVersion = text(o.baseVersion) ? o.baseVersion.trim() : undefined;
  return { id: taken.includes(o.k) ? `${o.k}-${member.catId}` : o.k, title: o.title, why: o.why, ...(text(o.kind) ? { kind: o.kind } : {}), ...(text(o.target) ? { target: o.target.trim() } : {}),
    ...(baseVersion ? { baseVersion } : {}),
    by: member.catId, model: member.model, expect: predict ? `${metric} ${signed(predict.lo)} ~ ${signed(predict.hi)}` : '', ...(predict ? { predict } : {}), cites: o.cites || [] };
});

// Pure RSI experimental lineage parent resolution (independent of git commit topology).
// Priority: explicit baseVersion > direction/request baseVersion > currentVersion (direct fix) >
// lastRound.version (when continuing a non-dead-end branch) > nearest viable ancestor along RSI's own lineage (when backtracking from a dead-end) > currentVersion.
export function resolveRsiParent(d: Experiment, lastRound: Data | undefined, explicitBaseVersion?: string, direct?: boolean): string {
  if (explicitBaseVersion && d.versions.some((v: Data) => v.id === explicitBaseVersion)) return explicitBaseVersion;
  if (d.versionRequest?.baseVersion && d.versions.some((v: Data) => v.id === d.versionRequest.baseVersion)) return d.versionRequest.baseVersion;
  if (direct) return d.objective.currentVersion;
  const startId = lastRound?.version;
  if (!startId || !d.versions.some((v: Data) => v.id === startId)) return d.objective.currentVersion;

  const byId = new Map<string, Data>(d.versions.map((v: Data) => [v.id, v]));
  const lastRoundOf = (vid: string): Data | null => {
    for (let i = d.rounds.length - 1; i >= 0; i--) {
      if (d.rounds[i].version === vid) return d.rounds[i];
    }
    return null;
  };
  const isDeadEnd = (v: Data): boolean => {
    const r = lastRoundOf(v.id);
    const disp = v.disposition || r?.report?.disposition || '';
    const verdict = r?.report?.verdict || '';
    return disp === 'dead_end' || v.status === 'rejected' || verdict === 'rollback' || verdict === 'sunset';
  };
  const startVer = byId.get(startId)!;
  if (!isDeadEnd(startVer)) return startVer.id;

  const isViableAnchor = (v: Data): boolean => {
    if (isDeadEnd(v)) return false;
    if (v.current || v.status === 'confirmed' || !v.parent) return true;
    const r = lastRoundOf(v.id);
    const disp = v.disposition || r?.report?.disposition || '';
    if (disp === 'advance') return true;
    const verdict = r?.report?.verdict || '';
    return !!verdict && verdict !== 'insufficient';
  };
  const seen = new Set<string>([startVer.id]);
  let cur: string | null | undefined = startVer.parent;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const node = byId.get(cur);
    if (!node) break;
    if (isViableAnchor(node)) return node.id;
    cur = node.parent;
  }
  return d.objective.currentVersion;
}

// Analysts are members chosen for the role; demo placeholders (no member id, kept by objectives created before alpha.24) never act.
export const analystsOf = (d: Experiment) => d.members.filter((m) => m.role === 'analyze' && m.catId);

// Every request for directions says that a direction may predict its effect (checked by the plugin once its version runs).
const EXPECT_HINT = '方向可以带 expect {lo,hi}：你预期选了它之后，主指标相对同周期对照变化多少；版本跑完后插件自动核对，算进命中率。';

// Analysts that have not proposed within this long are left out and the conclusion goes out without them.
export const ANALYSIS_LIMIT = 20 * 60_000;
// A wake that has not even been claimed via rsi_task after this long surfaces a visible reminder card (independent of Host turn events).
export const UNCLAIMED_WAIT = 10 * 60_000;
// A conclusion nobody decides within this inside the run window goes on with its plan (FLOW §1.5: 没回应，到点用默认 / 照旧).
export const DECISION_WAIT = 30 * 60_000;

// Four significant digits, never in exponent form (0.5075000000000001 → 0.5075, 1234.567 → 1235).
export const short = (x: number) => String(Number(x.toPrecision(4)));

// A version made for a predicting direction is checked the first time it runs against a comparable control: the change of the
// predicted metric (its group mean minus the control mean) inside [lo, hi] is a hit.
function checkPredictions(d: Experiment, round: Data, compared: Data): Data[] {
  const mean = (group: string, metric: string) => compared.matrix.find((m: Data) => m.group === group && m.metric === metric)?.mean;
  return round.plan.groups.filter((g: Data) => !g.control).flatMap((g: Data) => {
    const p = d.versions.find((v: Data) => v.id === g.version)?.prediction;
    if (!p || p.checked || !compared.comparable) return [];
    const who = `${d.members.find((m) => m.catId === p.by)?.name || p.by}：${p.text}`;
    // The scale changed and no longer has the predicted metric: say so instead of leaving the prediction unchecked forever.
    if (!roundMetrics(d, round).items.some((m: Data) => m.id === p.metric)) {
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
  if (input.disposition !== undefined && !['advance', 'dead_end'].includes(input.disposition)) {
    return { error: 'disposition must be "advance" or "dead_end"' };
  }
  const disposition = input.disposition as ('advance' | 'dead_end' | undefined);
  let tag: string | undefined;
  if (input.tag !== undefined) {
    if (typeof input.tag !== 'string' || !input.tag.trim() || input.tag.trim().length > 32) {
      return { error: 'tag must be a non-empty string of at most 32 characters' };
    }
    tag = input.tag.trim();
  }
  const findings = Array.isArray(input.findings) ? input.findings.join('\n') : input.findings, compared = comparison(d, round), slices = sliceMatrix(d, round);
  const member = d.members.find((m) => m.role === 'evaluate')!, { matrix: cells, ...compare } = compared;
  const comparisons = Array.isArray(input.comparisons)
    ? input.comparisons.filter((c: unknown) => record(c) && text(c.title) && record(c.before) && record(c.after)).map((c: Data, i: number) => ({
      id: text(c.id) ? c.id : `cmp-${round.n}-${i + 1}`,
      title: c.title,
      kind: ['chart', 'visual', 'artifact'].includes(c.kind) ? c.kind : 'visual',
      note: typeof c.note === 'string' ? c.note : '',
      before: { label: text(c.before.label) ? c.before.label : '前一轮', kind: ['image', 'video', 'audio', 'text'].includes(c.before.kind) ? c.before.kind : (text(c.before.src) ? 'image' : 'text'), ...(text(c.before.src) ? { src: c.before.src } : {}), ...(typeof c.before.text === 'string' ? { text: c.before.text } : {}), ...(typeof c.before.width === 'number' ? { width: c.before.width } : {}), ...(typeof c.before.height === 'number' ? { height: c.before.height } : {}) },
      after: { label: text(c.after.label) ? c.after.label : '本轮', kind: ['image', 'video', 'audio', 'text'].includes(c.after.kind) ? c.after.kind : (text(c.after.src) ? 'image' : 'text'), ...(text(c.after.src) ? { src: c.after.src } : {}), ...(typeof c.after.text === 'string' ? { text: c.after.text } : {}), ...(typeof c.after.width === 'number' ? { width: c.after.width } : {}), ...(typeof c.after.height === 'number' ? { height: c.after.height } : {}) },
    }))
    : [];
  const isHistoricalReeval = !!round.reevaluating && (!!round.decision || d.rounds.some((x: Data) => x.n > round.n));
  if (isHistoricalReeval) {
    const prev = round.report || {};
    round.report = {
      ...prev,
      verdict: input.verdict,
      headline: findings.split('\n')[0],
      summary: findings,
      matrix: cells,
      ...(slices.length ? { slices } : {}),
      ...(disposition ? { disposition } : {}),
      ...(tag ? { tag } : {}),
      ...(comparisons.length ? { comparisons } : {}),
      compare: { ...compare, note: compare.unrecomputableReason || prev.compare?.note || '仅比较本周期 control；区间为种子均值 ± 样本标准差。' },
    };
    round.stageMembers ||= {};
    round.stageMembers.eval = { catId: member.catId, name: member.name };
    round.state = 'done';
    delete round.reevaluating;
    const lib = state.library[d.objective.projectId], docId = `${d.objective.id}-cycle-${round.n}`;
    const doc = { id: docId, kind: 'feedback', title: `第 ${round.n} 周期：${round.report.headline}`, body: `${round.plan.groups.filter((g: Data) => !g.control).map((g: Data) => `${g.label} (${g.version}) ${JSON.stringify(g.vars)}`).join('\n') || '当前版本基线'}\n\n${findings}${prev.outcome || ''}`,
      objectives: [d.objective.id], cycle: round.n, tried: round.plan.groups.filter((g: Data) => !g.control), result: cycleResult(input.verdict, compared, round.confirmation || null), sources: [{ objective: d.objective.id, cycle: round.n }], state: 'confirmed', by: member.catId, at: now };
    const at = lib.findIndex((x: Data) => x.id === docId);
    if (at >= 0) lib[at] = doc; else lib.push(doc);
    const reCompareMd = formatComparisonMarkdown(d, round);
    message(state, d, now, `第 ${round.n} 周期重新分析完成 · ${input.verdict}`, `${round.report.summary}${reCompareMd ? `\n\n${reCompareMd}` : ''}`, 'conclusion');
    syncObjective(state, d);
    return { ok: true, comparison: compared, confirmation: round.confirmation || null, reevaluated: true };
  }
  delete round.reevaluating;
  const wins = compared.groups.filter((g: Data) => g.beatsControl).sort((a: Data, b: Data) => compared.dir === 'up' ? b.mean - a.mean : a.mean - b.mean);
  const isExplore = screeningRound(round);
  // Evaluate the current conclusion and actual runs before any adoption mutation.
  const concludedRound = { ...round, state: 'done', report: { verdict: input.verdict, disposition, compare } };
  const winnerGroup = round.plan.groups.find((g: Data) => g.id === wins[0]?.group);
  const currentEvidence = !d.policy.tiers || winnerGroup && tierEvidence({ ...d, rounds: [concludedRound] },
    { ...round.plan, groups: [winnerGroup] }, round.tier, undefined, round.runs).includes(round.n);
  const winner = isExplore || round.aborted || !currentEvidence ? undefined : wins[0], candidate = d.candidate;
  let confirmation: Data | null = null;
  const hadReservedSeeds = Array.isArray(round.plan.reservedSeeds) && round.plan.reservedSeeds.length > 0;
  const { reservedSeeds: _dropReserved, requiresExplicitPlan: _dropReq, cycleVars: _dropCycleVars, ...basePlan } = round.plan;
  if (!isExplore && !round.aborted && candidate) {
    const group = round.plan.groups.find((g: Data) => g.confirm && g.version === candidate.version && JSON.stringify(g.vars) === JSON.stringify(candidate.vars));
    const missing = !compared.comparable || round.runs.some((r: Data) => (r.group === 'control' || r.group === group?.id) && r.error?.kind === 'env');
    const holds = !missing && group && winner?.group === group.id && round.plan.seeds.every((s: number) => !candidate.seeds.includes(s))
      && (!d.policy.tiers || tierEvidence(d, round.plan, round.tier, undefined, round.runs).includes(candidate.cycle));
    confirmation = { status: holds ? 'confirmed' : missing ? 'insufficient' : 'rejected', group: group?.id, version: candidate.version, selectedCycle: candidate.cycle, cycle: round.n };
    if (holds) {
      let version = d.versions.find((v: Data) => v.id === candidate.version);
      if (version.id === d.objective.currentVersion) {
        version = { ...version, id: `v${d.versions.length + 1}`, parent: version.id, current: false, change: candidate.label, at: now };
        delete version.worktree;
        d.versions.push(version);
      }
      const interval = compared.matrix.find((m: Data) => m.group === group.id && m.metric === compared.metric);
      Object.assign(version, { vars: candidate.vars, ...(candidate.hypothesisId ? { hypothesisId: candidate.hypothesisId } : {}), status: 'confirmed', interval, confirmedCycle: round.n });
      for (const v of d.versions) v.current = v.id === version.id;
      d.objective.currentVersion = version.id;
      confirmation.version = version.id; confirmation.interval = interval;
    }
    if (missing) candidate.seeds.push(...round.plan.seeds);
    else {
      if (!holds && candidate.version !== d.objective.currentVersion) d.versions.find((v: Data) => v.id === candidate.version).status = 'rejected';
      delete d.candidate;
    }
    const confirmSeedCount = d.policy.confirmSeeds || round.plan.seeds.length;
    d.upcoming = { ...basePlan, tier: round.plan.tierRule?.adoption ? round.plan.tierRule.id : 'confirm', skipControl: false, groups: [controlGroup(d), ...(missing ? [{ ...group, control: false, confirm: true }] : [])], seeds: freshSeeds(d, confirmSeedCount) };
  } else if (winner) {
    const group = round.plan.groups.find((g: Data) => g.id === winner.group);
    const confirmSeedCount = d.policy.confirmSeeds || round.plan.seeds.length;
    d.candidate = { ...group, ...(round.hypothesisIds?.length === 1 ? { hypothesisId: round.hypothesisIds[0] } : {}), cycle: round.n, seeds: [...round.plan.seeds], against: d.objective.currentVersion };
    const version = d.versions.find((v: Data) => v.id === group.version);
    if (!version.current) version.status = 'candidate';
    confirmation = { status: 'candidate', group: group.id, version: group.version, cycle: round.n };
    d.upcoming = { ...basePlan, tier: round.plan.tierRule?.adoption ? round.plan.tierRule.id : 'confirm', skipControl: false, groups: [controlGroup(d), { ...group, control: false, confirm: true }], seeds: freshSeeds(d, confirmSeedCount) };
  } else d.upcoming = { ...basePlan, seeds: round.plan.tierRule?.seedPolicy === 'fixed' ? [...round.plan.seeds] : freshSeeds(d, round.plan.seeds.length), ...(hadReservedSeeds ? { requiresExplicitPlan: true } : {}) };
  round.confirmation = confirmation;
  round.stageMembers ||= {};
  round.stageMembers.eval = { catId: member.catId, name: member.name };
  // The comparison's cells are stored once, as the report's matrix.
  round.report = { verdict: input.verdict, headline: findings.split('\n')[0], summary: findings, matrix: cells,
    ...(slices.length ? { slices } : {}),
    ...(disposition ? { disposition } : {}),
    ...(tag ? { tag } : {}),
    ...(comparisons.length ? { comparisons } : {}),
    predictions: checkPredictions(d, round, compared), asks: [], directions: directionsFrom(d, options, member, []), agree: true,
    compare: { ...compare, note: '仅比较本周期 control；区间为种子均值 ± 样本标准差。' }, confirmation,
    attribution: { verdict: 'unresolved', primaryLayer: null, assessedLayers: [], competingLayers: [], uncertainty: 'interval', comparability: 'unchanged', reasons: [], evidence: [] } };
  collectHypotheses(d, round, now);
  const alreadyClosed = ['done', 'retired'].includes(d.objective.state);
  round.state = 'done';
  if (!alreadyClosed) {
    if (d.objective.state === 'paused') d.objective.resumeTo = 'pending';
    else d.objective.state = 'pending';
  }
  const interval = confirmation?.interval;
  const outcome = confirmation ? `\n\n${confirmation.status === 'candidate' ? '候选：下一周期换新种子确认赢家，默认版本保持当前对照。' : confirmation.status === 'confirmed' ? `确认赢家，采用 ${confirmation.version}：${short(interval.mean)} ± ${interval.spread == null ? '无法估计' : short(interval.spread)}。` : confirmation.status === 'insufficient' ? '复验环境失败，证据不足；保留候选，下周期换新种子继续确认。' : '复验未保持改善，保留当前默认版本。'}` : '';
  // A conclusion that stops the objective asks for no direction; its stop card follows it.
  // Nor does one that leaves a winner to confirm: the next cycle is the confirmation whatever is picked.
  round.report.outcome = outcome;
  const stopped = alreadyClosed ? null : stopAfterConclusion(state, d, round, compared, now);
  if (analysts.length && !stopped && !alreadyClosed && !d.candidate) {
    // The analysts receive the same report and propose side by side; the conclusion card waits for them.
    round.analysis = { waiting: analysts.map((m) => m.catId), since: now };
    for (const m of analysts) enqueue(state, d, 'agent', { member: m.catId, cycle: round.n, action: 'direction', message: { title: `第 ${round.n} 周期：请给方向`,
      body: `${mention(m)} 评估成员的结论是 ${input.verdict}：${round.report.headline}。调原生 MCP 工具 rsi_task 看同周期对照、各组结果和之前的周期，再调 rsi_propose 交你的方向；几个分析成员的方向会署名并列，交给用户选。${EXPECT_HINT}` } });
  } else conclusionCard(state, d, round, now, stopped);
  state.library[d.objective.projectId].push({ id: `${d.objective.id}-cycle-${round.n}`, kind: 'feedback', title: `第 ${round.n} 周期：${round.report.headline}`, body: `${round.plan.groups.filter((g: Data) => !g.control).map((g: Data) => `${g.label} (${g.version}) ${JSON.stringify(g.vars)}`).join('\n') || '当前版本基线'}\n\n${findings}${outcome}`,
    objectives: [d.objective.id], cycle: round.n, tried: round.plan.groups.filter((g: Data) => !g.control), result: cycleResult(input.verdict, compared, confirmation), sources: [{ objective: d.objective.id, cycle: round.n }], state: 'confirmed', by: member.catId, at: now });
  if (alreadyClosed && d.objective.state === 'done' && d.closeoutReport) {
    d.closeoutReport = buildCloseoutReport(d, now, d.closeoutReport.by);
  }
  syncObjective(state, d);
  return { ok: true, comparison: compared, confirmation, stop: d.objective.stopReason || null, ...(round.analysis ? { analysts: round.analysis.waiting } : {}) };
}

function conclusionCard(state: RsiState, d: Experiment, round: Data, now: number, stopped?: Data | null) {
  const closed = !!stopped || ['done', 'retired'].includes(d.objective.state);
  // From here the conclusion waits for your decision (a stopping or already-closed objective does not).
  if (!round.decision && !closed) round.asked = now;
  const report = round.report, nameOf = (id: string) => d.members.find((m) => m.catId === id)?.name || id, several = new Set(report.directions.map((x: Data) => x.by)).size > 1;
  const lines = report.directions.map((x: Data) => `${x.id} · ${x.title}${several ? `（${nameOf(x.by)}）` : ''}：${x.why}`);
  const missing = round.analysis?.missing || [];
  // Agreement is stated only when at least two analysts proposed: one analyst's directions cannot agree or disagree.
  const verdict = (round.analysis?.compared || 0) > 1 && !closed ? `\n\n${report.agree ? '分析成员意见一致，可以直接采纳。' : '几个分析成员意见不一致，需要你判断。'}` : '';
  const absent = missing.length ? `\n\n${missing.map(nameOf).join('、')} 没在时限内给方向。` : '';
  const checked = report.predictions.length ? `\n\n${report.predictions.map((p: Data) => `预测核对 · ${p.text}：预期 ${p.expect}，实际 ${p.actual}，${p.result === 'hit' ? '命中' : p.result === 'unresolved' ? '无法核对' : '未命中'}`).join('\n')}` : '';
  const compareMd = formatComparisonMarkdown(d, round);
  const compareBlock = compareMd ? `\n\n${compareMd}` : '';
  const customSeedNote = !closed && !d.candidate && Array.isArray(round.plan.reservedSeeds) && round.plan.reservedSeeds.length ? '（本周期含自定义 reservedSeeds 绑定，超时不会自动照旧续跑。）' : '';
  message(state, d, now, `第 ${round.n} 周期结论 · ${report.verdict}`, `${report.summary}${compareBlock}${report.outcome}${checked}\n\n${lines.join('\n')}${verdict}${absent}${closed ? '' : d.candidate ? '\n\n在 RSI 页面点「今晚照旧」，下一周期跑确认。' : `\n\n在 RSI 页面选择方向。${customSeedNote}`}`, 'conclusion');
  if (stopped) message(state, d, now, stopped.text, d.closeoutReport?.markdown || `第 ${round.n} 周期结论后停止启动新周期。`, 'conclusion');
  if (!round.decision && !closed) decideAtNight(state, d, round, now);
  if (!round.decision && !closed && d.objective.projectPath && d.policy?.manager?.catId) {
    const manager = d.policy.manager;
    const pausedHint = d.objective.state === 'paused' ? '评估项当前处于暂停状态；' : '';
    const actionHint = d.candidate
      ? `已产生候选版本 ${d.candidate.version}，可按授权决定复验（expDecide pick="same"）、直接晋升默认版本（promote）或请主人拍板。`
      : '请调原生 MCP 工具 rsi_status 查看完整结论与各成员方向，再按授权通过 rsi_operate(op="expDecide") 拍板或转交主人。';
    enqueue(state, d, 'agent', {
      member: manager.catId,
      cycle: round.n,
      action: 'decide',
      message: {
        title: `第 ${round.n} 周期结论已就绪，请处理决策`,
        body: `${mention(manager)} 第 ${round.n} 周期结论（${report.verdict}）及方向提案已汇总完毕。${pausedHint}${actionHint}`,
      },
    });
  }
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
    message(state, d, now, `第 ${round.n} 周期：有候选，直接换新种子复验`, needsCycleVars(d) ? '复验计划已就绪；因已启用每轮前绑定 cycleVars 门禁，待绑定本轮参数后启动。' : '复验只换种子、不改任何东西，不用等人：下一周期跑确认。', 'plan');
    notifyAwaitingCycleVars(state, d, now, `第 ${round.n} 周期已排入候选确认计划`);
    return;
  }
  // The first analyst who proposed speaks for them (two or more must agree); without one, the evaluator's first direction.
  const firsts = analystsOf(d).map((m) => round.report.directions.find((x: Data) => x.by === m.catId)).filter(Boolean), first = firsts[0] || round.report.directions[0];
  if (!first || firsts.length > 1 && !round.report.agree || !auto.includes(first.kind)) return;
  round.decision = { pick: 'direction', directionId: first.id, note: '夜里按规则采纳', by: 'RSI', at: now };
  message(state, d, now, `第 ${round.n} 周期：夜里按规则采纳「${first.title}」`, `${first.why}\n\n这类方向声明时定了夜里可以自己定：交给 ${d.members.find((m) => m.role === 'iterate')!.name} 出版本，出好后接着跑。`, 'plan');
  requestVersion(state, d, round, now);
}

// A pick that changes something asks the governance member for its version, whether made on the page or by the night's rules.
export function requestVersion(state: RsiState, d: Experiment, round: Data, now = Date.now()) {
  collectHypotheses(d, round, now);
  const direction = round.report.directions.find((x: Data) => x.id === round.decision.directionId);
  // An execution fix must not change what is measured: its version replaces the default directly instead of competing with it.
  const direct = direction?.kind === 'execution';
  const hypothesis = (d.hypotheses || []).find((h: Data) => h.source.kind === 'direction' && h.source.cycle === round.n && h.source.directionId === direction?.id && h.source.member === direction?.by);
  const baseVersion = resolveRsiParent(d, round, direction?.baseVersion, direct);
  d.versionRequest = { cycle: round.n, since: now, decision: round.decision, ...(hypothesis ? { hypothesisId: hypothesis.id } : {}), title: direction?.title || round.decision.note || round.decision.pick, baseVersion, ...(direct ? { direct } : {}),
    ...(direction?.predict ? { prediction: { ...direction.predict, by: direction.by, text: direction.title, expect: direction.expect, direction: direction.id, cycle: round.n } } : {}) };
  d.objective.state = 'running';
  const member = d.members.find((m) => m.role === 'iterate')!;
  enqueue(state, d, 'agent', { member: member.catId, cycle: round.n, action: 'version',
    message: { title: '准备下一个版本', body: `${mention(member)} 按「${d.versionRequest.title}」出下一个版本（谱系父版本默认 ${baseVersion}，如改换分支起点请在 rsi_version 显式传 baseVersion）。${direct ? '这是执行修复：不和当前版本对比，登记后直接作为默认版本，所以只修执行，不改训练和评测。' : ''}先调原生 MCP 工具 rsi_task，改项目并提交 git 后调 rsi_version。${WORKTREE}` } });
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
  if ((Array.isArray(round.plan?.reservedSeeds) && round.plan.reservedSeeds.length && !d.candidate) || d.upcoming?.requiresExplicitPlan || d.policy?.requireCycleVars || d.upcoming && tierOf(d, d.upcoming)?.requireCycleVars) return;
  round.decision = { pick: 'same', note: `${DECISION_WAIT / 60_000} 分钟没人回应，按当前计划继续`, by: 'RSI', at: now };
  d.objective.state = 'running';
  message(state, d, now, `第 ${round.n} 周期：没人回应，按当前计划继续`, d.candidate ? '下一周期换新种子复验候选。' : '下一周期按同样的组换新种子再跑一轮，不改任何东西。下一个结论出来时可以再选方向。', 'plan');
  syncObjective(state, d);
}

export function finishAnalysis(state: RsiState, d: Experiment, round: Data, now: number) {
  collectHypotheses(d, round, now);
  const missing = round.analysis.waiting;
  round.analysis = { ...round.analysis, waiting: [], missing };
  const firsts = analystsOf(d).filter((m) => !missing.includes(m.catId!)).map((m) => round.report.directions.find((x: Data) => x.by === m.catId)).filter(Boolean);
  round.analysis.compared = firsts.length;
  round.stageMembers ||= {};
  round.stageMembers.discuss = analystsOf(d).filter((m) => !missing.includes(m.catId!)).map((m) => ({ catId: m.catId, name: m.name }));
  round.report.agree = firsts.length < 2 || firsts.every((x: Data) => x.kind && x.target && x.kind === firsts[0].kind && x.target === firsts[0].target);
  conclusionCard(state, d, round, now);
  syncObjective(state, d);
}

// The run window that closed last with what happened in it (cycles started, the schedule's decisions, repairs), until it is summarized; null when nothing did.
export function nightDue(d: Experiment, now: number) {
  const end = windowEnd(d.policy.schedule, now);
  if (!d.objective.projectPath || !end || d.digestAt === end) return null;
  const start = windowStart(d.policy.schedule, end), inside = (at: number) => at >= start && at < end;
  const night = { start, end, cycles: d.rounds.filter((r: Data) => inside(r.start)), decided: d.rounds.filter((r: Data) => r.decision?.by === 'RSI' && inside(r.decision.at)), repairs: (d.repairs || []).filter((x: Data) => inside(x.at)) };
  return night.cycles.length || night.decided.length || night.repairs.length ? night : null;
}

// The morning summary (PHASE3 §4), once per window: built from the records alone, never from what members wrote.
export function nightDigest(state: RsiState, d: Experiment, now: number) {
  const night = nightDue(d, now);
  if (!night) return;
  d.digestAt = night.end;
  const outcome = (r: Data) => r.report ? `${r.report.verdict} · ${r.report.headline}` : r.state === 'repaired' ? `已修复，由 ${r.repairedBy} 重跑`
    : ({ evaluating: r.runs.some((u: Data) => u.state === 'failed') ? '运行失败，交给评估' : '跑完，等结论', repairing: '运行失败，正在修', interrupted: '被插件重启打断' } as Data)[r.state] || '还在跑';
  // The decision that stopped the objective is told under 现在, not counted as 照旧.
  const same = night.decided.filter((r: Data) => r.decision.pick === 'same' && r.n !== d.objective.stopReason?.cycle).length;
  const own = [same && `照旧 ${same} 次`, ...night.decided.filter((r: Data) => r.decision.pick === 'direction')
    .map((r: Data) => `按规则采纳「${r.report.directions.find((x: Data) => x.id === r.decision.directionId).title}」`)].filter(Boolean).join('；');
  const waiting = d.rounds.find((r: Data) => r.report && !r.decision && !r.analysis?.waiting.length), ask = d.versionRequest;
  const status = d.objective.state === 'done' ? `已结束（${d.objective.stopReason.text}）` : waiting ? `第 ${waiting.n} 周期的结论等你定`
    : ask ? `等 ${d.members.find((m) => m.role === 'iterate')!.name} ${ask.repair ? `修第 ${ask.cycle} 周期的运行失败` : `按「${ask.title}」出版本`}` : '';
  const opened = new Date(night.start);
  message(state, d, now, `夜间总结 · ${opened.getMonth() + 1}月${opened.getDate()}日`, [night.cycles.map((r: Data) => `第 ${r.n} 周期（${r.version}）：${outcome(r)}`).join('\n'),
    own && `夜里自己定的：${own}`, night.repairs.map((x: Data) => `${x.version} 修了「${x.signature}」`).join('\n'), status && `现在：${status}`].filter(Boolean).join('\n\n'), 'digest');
}

const evalUnclaimed = (r: Data, now: number) => r.state === 'evaluating' && !r.invocationId && !r.evalStalledNotified && !!(r.evalAskedAt || r.end) && now - (r.evalAskedAt || r.end) > UNCLAIMED_WAIT;
const versionUnclaimed = (d: Experiment, now: number) => !!d.versionRequest && !d.versionRequest.invocationId && !d.versionRequest.stalledNotified && !!d.versionRequest.since && now - d.versionRequest.since > UNCLAIMED_WAIT;
const unclaimedAnalysts = (r: Data, now: number) => r.analysis?.waiting?.length && !r.analysis.unclaimedNotified && !!(r.analysis.askedAt || r.analysis.since) && now - (r.analysis.askedAt || r.analysis.since) > UNCLAIMED_WAIT
  ? (r.analysis.waiting as string[]).filter((id) => !r.analysis.turns?.[id])
  : [];

export function hasUnclaimed(d: Experiment, now: number): boolean {
  if (!d.objective.projectPath || ['done', 'retired', 'paused'].includes(d.objective.state)) return false;
  return versionUnclaimed(d, now) || d.rounds.some((r: Data) => evalUnclaimed(r, now) || unclaimedAnalysts(r, now).length > 0);
}

// Self-contained stalled-wake detection: surfaces a visible reminder card once per dispatch when a member has not called rsi_task after UNCLAIMED_WAIT.
export function warnUnclaimed(state: RsiState, d: Experiment, now: number) {
  if (!d.objective.projectPath || ['done', 'retired', 'paused'].includes(d.objective.state)) return;
  const nameOf = (id: string) => d.members.find((m) => m.catId === id)?.name || id;
  const hint = '可能遭遇唤醒失败或连接中断；可在 RSI 页面点「重新触发」，或让该成员直接调用原生 MCP 工具 rsi_task 继续。';
  for (const r of d.rounds) {
    if (evalUnclaimed(r, now)) {
      r.evalStalledNotified = true;
      const who = d.members.find((m) => m.role === 'evaluate')?.name || '评估成员';
      message(state, d, now, `第 ${r.n} 周期评估：${who} 派发 ${UNCLAIMED_WAIT / 60_000} 分钟仍未认领`, hint, 'failed');
    }
    const missed = unclaimedAnalysts(r, now);
    if (missed.length) {
      r.analysis.unclaimedNotified = true;
      message(state, d, now, `第 ${r.n} 周期方向讨论：${missed.map(nameOf).join('、')} 派发 ${UNCLAIMED_WAIT / 60_000} 分钟仍未认领`, hint, 'failed');
    }
  }
  if (versionUnclaimed(d, now)) {
    d.versionRequest.stalledNotified = true;
    const who = d.members.find((m) => m.role === 'iterate')?.name || '治理执行成员';
    message(state, d, now, `第 ${d.versionRequest.cycle} 周期出版本：${who} 派发 ${UNCLAIMED_WAIT / 60_000} 分钟仍未认领`, hint, 'failed');
  }
}
