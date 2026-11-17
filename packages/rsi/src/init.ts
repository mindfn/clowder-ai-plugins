import { randomUUID } from 'node:crypto';
import { createFixtures, RSI_CP_INIT } from './fixtures.js';
import { timeRange, windowMinutes } from './schedule.js';
import { summaryOf } from './data.js';
import type { Data, Experiment, InitExecution, OutboxEntry, PrepItem, RsiState, Section } from './types.js';

export function enqueue(state: RsiState, d: Experiment, kind: OutboxEntry['kind'], data: Data = {}) {
  const entry: OutboxEntry = { id: `${d.objective.id}-${kind}-${d.seq = (d.seq || 0) + 1}`, kind, objective: d.objective.id, thread: d.objective.thread || null, ...data };
  state.outbox.push(entry);
  return entry;
}

export function message(state: RsiState, d: Experiment, now: number, title: string, body: string, kind = 'ask', ask = '') {
  const entry = enqueue(state, d, 'message', { message: { at: now, kind, round: 0, title, body, ask, ifIgnored: '' } });
  entry.message.id = entry.id;
  d.messages.push(entry.message);
}

export function syncObjective(state: RsiState, d: Experiment) {
  const o = summaryOf(state, d.objective.id)!;
  o.state = d.objective.state;
  o.running = d.objective.state === 'preparing' ? null : { o: d.objective.currentVersion };
  if (d.objective.thread) o.thread = d.objective.thread;
}

export function rsiExpStaleFrom(d: Experiment, section: Section, redo = false): number[] {
  const visited = new Set<Section>();
  function walk(k: Section) {
    for (const s of d.plan) {
      if (!s.deps.includes(k) || visited.has(s.k)) continue;
      visited.add(s.k);
      const step = d.steps?.[s.k];
      if (step) { step.stale = true; if (redo) step.redo = true; }
      walk(s.k);
    }
  }
  walk(section);
  const stale = [...visited].filter((k) => d.steps?.[k]).map((k) => d.plan.findIndex((s) => s.k === k) + 1).sort();
  if (stale.length) {
    if (d.objective.state === 'ready') d.objective.state = 'preparing';
    d.drafted = false;
  }
  return stale;
}

// Every step submitted and current, nobody still working on one, and every item the user owns confirmed.
export const prepSettled = (d: Experiment) => !Object.keys(d.exec || {}).length && d.plan.every((s) => d.steps?.[s.k] && !d.steps[s.k]!.stale)
  && !d.prep.some((x) => x.neededFrom === 'human' && x.state !== 'confirmed');

export function rsiExpReady(d: Experiment): boolean {
  if (d.objective.state !== 'preparing' || !prepSettled(d)) return false;
  d.objective.state = 'ready';
  return true;
}

export function rsiExpKick(experiment: Experiment, now: number): { experiment: Experiment; outbox: OutboxEntry[] } {
  const d = structuredClone(experiment), outbox: OutboxEntry[] = [];
  d.steps ||= {}; d.exec ||= {};
  for (const plan of d.plan) {
    const old = d.steps[plan.k], member = d.members.find((m) => m.role === plan.role);
    if (!member?.catId || d.exec[plan.k] || (old && !(old.stale && old.redo))) continue;
    if (plan.deps.some((k) => !d.steps![k] || d.steps![k]!.stale || d.exec![k])) continue;
    if (Object.values(d.exec).some((e) => e?.by === member.catId)) continue;
    const s = RSI_CP_INIT.find((s) => s.section === plan.k)!;
    const base = Object.fromEntries(plan.deps.map((k) => [k, d.steps![k]!.rev]));
    const id = `${d.objective.id}-init-${plan.k}-${d.seq = (d.seq || 0) + 1}`;
    const rewrite = d.rewrites?.[plan.k];
    d.exec[plan.k] = { id, state: 'started', by: member.catId, base, ...rewrite };
    if (s.exec) d.executor.state = 'generating';
    const m = { id, at: now, kind: 'ask', round: 0, title: `初始化第 ${d.plan.indexOf(plan) + 1} 步${old ? '（按新版本重做）' : ''}`,
      body: `@${member.name} ${rewrite?.note || s.ask}` + (plan.deps.length ? '\n\n依据：' + plan.deps.map((k) => `第 ${d.plan.findIndex((p) => p.k === k) + 1} 步 v${base[k]}`).join('、') : ''), ask: '', ifIgnored: '' };
    d.messages.push(m);
    outbox.push({ id, kind: 'agent', objective: d.objective.id, thread: d.objective.thread || null, member: member.catId, section: plan.k, executionId: id, base, message: m });
    if (rewrite) delete d.rewrites[plan.k];
  }
  return { experiment: d, outbox };
}

export function kick(state: RsiState, id: string, now: number) {
  const result = rsiExpKick(state.experiments[id], now);
  const d = state.experiments[id] = result.experiment;
  state.outbox.push(...result.outbox);
  const done = !Object.keys(d.exec!).length && d.plan.every((p) => d.steps![p.k] && !d.steps![p.k]!.stale);
  const waiting = d.prep.filter((p) => p.neededFrom === 'human' && p.state !== 'confirmed');
  if (done && waiting.length && !d.drafted) {
    d.drafted = true;
    message(state, d, now, `七步都起草完了：还有 ${waiting.length} 项等你确认`, waiting.map((p) => p.title).join('、') + '。', 'ask', '在评估项页逐条确认或修改；都确认了才能开始评估。');
  }
  if (!done) d.drafted = false;
  if (rsiExpReady(d)) message(state, d, now, d.objective.projectPath ? '初始化完成：可以跑一轮' : `初始化完成：每晚 ${d.policy.schedule.window} 跑，第一晚只跑基线 v1`, `执行能力 ${d.executor.mcp}；看 ${d.metrics.version} 的 ${d.metrics.items.length} 条量尺。`, 'declare', '在评估项页点「开始评估」。');
  syncObjective(state, d);
}

export interface InitSubmission {
  section: Section;
  executionId: string;
  items: PrepItem[];
  unknowns?: string;
  next?: string;
  goal?: Data;
  executor?: Data;
  metrics?: Data;
  docs?: Data[];
  upcoming?: Data;
  window?: string;
}

export function submitInitStep(state: RsiState, id: string, submission: InitSubmission, now: number) {
  const d = state.experiments[id], section = submission.section, plan = d?.plan.find((p) => p.k === section);
  const execution = d?.exec?.[section];
  if (!plan || !execution || execution.state !== 'started' || execution.id !== submission.executionId) return { error: 'Initialization execution not found' };
  const real = !!d?.objective.projectPath;
  if (!Array.isArray(submission.items) || !submission.items.length || submission.items.some((p) => p.section !== section || typeof p.id !== 'string' || typeof p.value !== 'string'
    || (real && !d.prep.some((x) => x.id === p.id) && (typeof p.title !== 'string' || !p.title.trim())))
    || d.prep.some((p) => p.section === section && !p.mine && (!real || p.section === 'goal') && !submission.items.some((x) => x.id === p.id))) return { error: 'Submit all items for this step; a new item needs a title' };
  const old = d.steps?.[section];
  const moved = plan.deps.some((k) => !d.steps?.[k] || d.steps[k]!.stale || d.steps[k]!.rev !== execution.base[k]);
  const config = RSI_CP_INIT.find((p) => p.section === section)!;
  const items = submission.items.map((p) => {
    const prior = d.prep.find((x) => x.id === p.id);
    if (prior?.mine) return prior;
    const human = config.human?.includes(p.id) || p.neededFrom === 'human' || (real && section !== 'goal' && !!config.human?.length);
    return { ...p, state: human ? 'submitted' as const : 'confirmed' as const, neededFrom: human ? 'human' as const : null, by: execution.by, at: now, decision: undefined };
  });
  d.prep = d.prep.filter((p) => p.section !== section).concat(items, d.prep.filter((p) => p.section === section && p.mine && !items.some((x) => x.id === p.id)));
  d.steps![section] = { rev: old ? old.rev + 1 : 1, base: execution.base, stale: moved, redo: false, unknowns: submission.unknowns, next: submission.next };
  delete d.exec![section];
  if (old) rsiExpStaleFrom(d, section, true);
  if (submission.goal) Object.assign(d.objective.goal, submission.goal, { statement: d.objective.name });
  if (submission.executor) d.executor = structuredClone(submission.executor);
  if (submission.metrics) {
    d.metrics = structuredClone(submission.metrics);
    for (const metric of d.metrics.items) if (metric.guard) metric.locked = true;
  }
  if (section === 'run') {
    const window = submission.window || submission.items.find((p) => p.id === 'cp-trigger')?.value;
    if (windowMinutes(window)) d.policy.schedule.window = window;
  }
  if (submission.upcoming) d.upcoming = structuredClone(submission.upcoming);
  const project = Object.keys(state.objectives).find((k) => state.objectives[k].some((o) => o.id === id))!;
  for (const doc of submission.docs || []) {
    const at = state.library[project].findIndex((x) => x.id === doc.id);
    const value = { ...doc, at: now, state: 'pending' };
    if (at < 0) state.library[project].push(value); else state.library[project][at] = value;
  }
  if (submission.executor?.state === 'passed') {
    summaryOf(state, id)!.trigger = timeRange(d.policy.schedule.window);
    const capability = state.groups[project].find((g) => g.forObjective === id);
    const value = { id: `exec-${id}`, side: 'collect', kind: 'mcp', name: `执行 MCP ${d.executor.mcp}`, where: d.executor.ops.map((o: Data) => o.op).join(' / ') + ' · 试跑通过', for: d.objective.name, users: d.objective.name, forObjective: id };
    if (capability) Object.assign(capability, value); else state.groups[project].push(value);
  }
  kick(state, id, now);
  return { ok: true };
}

export function recordInitExecution(state: RsiState, id: string, section: Section, executionId: string, status: InitExecution['state'] | 'completed', now: number, detail: Data = {}) {
  const d = state.experiments[id], execution = d?.exec?.[section];
  if (!execution || execution.id !== executionId) return { error: 'Initialization execution not found' };
  execution.state = status === 'completed' ? 'missing' : status;
  if (detail.reason) execution.reason = detail.reason;
  if (detail.recoveryUrl) execution.recoveryUrl = detail.recoveryUrl;
  if (status !== 'started' && status !== 'cancelled') message(state, d, now, status === 'completed' ? 'agent 结束了，这一步还没提交' : '初始化需要处理', detail.reason || '', 'failed');
  kick(state, id, now);
  return { ok: true };
}

// 何时停 is one setting: the enforced stop condition; the 何时停 item text is derived from it.
// A target reads "<metric id or name> <comparison> <number>" (accuracy ≥ 0.45); step 4's metrics must contain that metric.
export const STOP_TARGET = /^(.*?)\s*(>=|<=|≥|≤|>|<)\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*$/i;
export function stopOf(input: Data): Data {
  const target = typeof input.target === 'string' ? input.target.trim() : '';
  if (target && !STOP_TARGET.exec(target)?.[1].trim()) return { error: '「达到什么就停」要写成「指标 比较符 数字」，比如 accuracy ≥ 0.45；不需要就留空' };
  if (['stall', 'rounds'].some((k) => input[k] != null && input[k] !== '' && (!Number.isSafeInteger(+input[k]) || +input[k] < 1))) return { error: 'Stop cycle counts must be positive integers' };
  return { stop: { target: target || null, stall: +input.stall || null, maxCycles: +input.rounds || null } };
}
export const stopText = (stop: Data) => [stop.target && `达到「${stop.target}」并复验稳定`, stop.stall && `连续 ${stop.stall} 个周期没进步`, stop.maxCycles && `用满 ${stop.maxCycles} 个周期`].filter(Boolean).join('，或') || '由你决定';

export function rsiExpNew(state: RsiState, project: string, body: Data, now: number) {
  const fixture = createFixtures(now), templateId = project === 'pd-infer' ? 'pd-ttft' : 'cp-converge';
  const d = structuredClone(fixture.templates[templateId]);
  const id = body.projectPath || summaryOf(state, templateId) ? `obj-${randomUUID()}` : templateId;
  const limits = stopOf(body).stop, stop = stopText(limits);
  d.objective = { ...d.objective, id, name: body.statement, projectId: project, ...(body.projectPath ? { projectPath: body.projectPath } : {}), state: 'preparing', thread: null, currentVersion: 'v1', round: 0, budget: { rounds: limits.maxCycles, used: 0 }, stop: limits, goal: { ...d.objective.goal, statement: body.statement, good: '', adoptWhen: '', stopWhen: stop } };
  d.rounds = []; d.messages = []; d.steps = {}; d.exec = {}; d.seq = 0;
  delete d.night;
  d.versions = [{ ...d.versions[0], current: true }];
  if (body.projectPath) {
    d.versions = [{ id: 'v1', parent: null, change: '初始版本', config: {}, commit: null, snapshot: true, at: now, current: true }];
    d.executor = { state: 'none', mcp: 'rsi.executor', ops: [], resultMap: [] };
    d.policy.schedule = { window: '' };
    delete d.upcoming;
  }
  d.plan = RSI_CP_INIT.map((s) => ({ k: s.section, role: s.role, deps: [...s.deps] }));
  d.executor.state = 'none';
  d.prep = d.prep.map((p) => ({ ...p, value: '', state: 'uninvestigated', by: '', neededFrom: null, at: null, facts: null, can: null, rec: null, tag: null }));
  // A real project's items are the members' own (they name, add and drop them); only the goal section's questions are fixed.
  if (body.projectPath) d.prep = d.prep.filter((p) => p.section === 'goal');
  // A real project's members are the cats chosen here; the template's other roles are demo placeholders that never act.
  if (body.projectPath) d.members = d.members.filter((m) => m.role === 'prepare' || m.role === 'evaluate');
  for (const role of ['prepare', 'evaluate']) {
    const cat = Array.isArray(body.cats) ? body.cats.find((c: Data) => c.id === body[role]) : null;
    Object.assign(d.members.find((m) => m.role === role)!, { catId: body[role], name: cat?.name || body[role], model: cat?.model || '' });
  }
  const goal = d.prep.find((p) => p.id.endsWith('-goal'))!;
  Object.assign(goal, { value: body.statement, state: 'confirmed', by: '你', mine: true, at: now });
  const stopItem = d.prep.find((p) => p.id.endsWith('-stop'));
  if (stopItem) Object.assign(stopItem, { value: stop, state: 'confirmed', by: '你', mine: true, at: now });
  else d.prep.push({ id: `${id}-stop`, section: 'goal', title: '何时停', value: stop, state: 'confirmed', neededFrom: null, mine: true, by: '你', at: now });
  state.experiments[id] = d;
  state.objectives[project].push({ id, name: body.statement, parent: null, state: 'preparing', mode: 'exp', trigger: '', running: null, cycle: null, prediction: null, locked: 0 });
  enqueue(state, d, 'createThread', { project, title: `RSI · ${body.statement}` });
  message(state, d, now, `新评估项：${body.statement}`, `何时停：${stop}。\n\n@${d.members.find((m) => m.role === 'prepare')!.name} 负责准备；@${d.members.find((m) => m.role === 'evaluate')!.name} 负责评估。初始化七步，按依赖往下做。`, 'goal');
  kick(state, id, now);
  return state.experiments[id].objective;
}

export function bindObjectiveThread(state: RsiState, id: string, threadId: string) {
  const d = state.experiments[id];
  if (!d || !threadId) return { error: 'Objective or thread not found' };
  d.objective.thread = threadId;
  for (const entry of state.outbox) if (entry.objective === id && entry.kind !== 'createThread' && !entry.thread) entry.thread = threadId;
  syncObjective(state, d);
  return { ok: true };
}
