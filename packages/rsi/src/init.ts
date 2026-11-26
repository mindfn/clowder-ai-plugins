import { randomUUID } from 'node:crypto';
import { createFixtures, RSI_CP_INIT } from './fixtures.js';
import { hasValidSchedule, parseScheduleText, scheduleOf, scheduleSummary, timeRange } from './schedule.js';
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

// A member as the member dialogs pass its cat (the Host's member rows): name, model and handle, the first mention pattern
// (e.g. @gemini) people type to mention it; a cat without one leaves no handle.
export function setMember(m: Data, catId: string, cats: unknown) {
  const cat = Array.isArray(cats) ? cats.find((c: Data) => c.id === catId) : null;
  delete m.handle;
  return Object.assign(m, { catId, name: cat?.name || catId, model: cat?.model || '' }, cat?.handle ? { handle: cat.handle } : {});
}
// A write that passes the rows refreshes every member found in them, not only the one it changes.
export function refreshMembers(members: Data[], cats: unknown) {
  for (const m of members) if (Array.isArray(cats) && cats.some((c: Data) => c.id === m.catId)) setMember(m, m.catId, cats);
}
// A message names a member to act like any routing message: its handle at a line start; without one its plain name, no @.
export const mention = (m: Data) => m.handle || m.name;

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

export function stepMemberOf(d: Data, section: Section): Data | undefined {
  const override = d.stepMembers?.[section];
  if (override?.catId) return override;
  const plan = d.plan?.find((p: Data) => p.k === section);
  return plan ? d.members?.find((m: Data) => m.role === plan.role) : undefined;
}

export function rsiExpKick(experiment: Experiment, now: number): { experiment: Experiment; outbox: OutboxEntry[] } {
  const d = structuredClone(experiment), outbox: OutboxEntry[] = [];
  d.steps ||= {}; d.exec ||= {};
  for (const plan of d.plan) {
    const old = d.steps[plan.k], member = stepMemberOf(d, plan.k);
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
      body: (plan.deps.length ? '依据：' + plan.deps.map((k) => `第 ${d.plan.findIndex((p) => p.k === k) + 1} 步 v${base[k]}`).join('、') + '\n\n' : '') + `${mention(member)} ${rewrite?.note || s.ask}`, ask: '', ifIgnored: '' };
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
  const prevSectionItems = d.prep.filter((p) => p.section === section);
  const sectionItems = items.concat(prevSectionItems.filter((p) => p.mine && !items.some((x) => x.id === p.id)));
  d.prep = d.prep.filter((p) => p.section !== section).concat(sectionItems);
  const nextRev = old ? old.rev + 1 : 1;
  d.steps![section] = { rev: nextRev, base: execution.base, stale: moved, redo: false, unknowns: submission.unknowns, next: submission.next };
  d.stepHistory ||= {};
  const hist = (d.stepHistory[section] ||= []);
  const prevHist = old ? hist.find((h: Data) => h.rev === old.rev) : null;
  if (prevHist && !prevHist.items) prevHist.items = structuredClone(prevSectionItems);
  hist.push({ rev: nextRev, at: now, by: execution.by, unknowns: submission.unknowns || '', next: submission.next || '' });
  if (hist.length > 5) hist.splice(0, hist.length - 5);
  delete d.exec![section];
  if (old && !(section === 'run' && d.rounds.length > 0)) rsiExpStaleFrom(d, section, true);
  if (submission.goal) Object.assign(d.objective.goal, submission.goal, { statement: d.objective.goal?.statement || d.objective.name });
  if (submission.executor) d.executor = structuredClone(submission.executor);
  if (section === 'run' && d.executor) {
    d.executorHistory ||= [];
    const cId = `C${nextRev}`;
    const cSnap = { id: cId, rev: nextRev, at: now, by: execution.by, note: submission.next || submission.unknowns || '', state: d.executor.state || null, mcp: d.executor.mcp || '', commands: d.executor.commands ? structuredClone(d.executor.commands) : null, timeout: d.executor.timeout ?? null, poll: d.executor.poll ?? null };
    const cIdx = d.executorHistory.findIndex((x: Data) => x.rev === nextRev);
    if (cIdx >= 0) d.executorHistory[cIdx] = cSnap;
    else d.executorHistory.push(cSnap);
  }
  if (submission.metrics) {
    if (d.metrics?.version) {
      d.metricHistory ||= [];
      const prevVer = String(d.metrics.version);
      if (!d.metricHistory.some((m: Data) => m.version === prevVer)) {
        const prevStep = (d.stepHistory?.rules || []).find((h: Data) => h.rev === (old?.rev || 1));
        d.metricHistory.push({ ...structuredClone(d.metrics), rev: old?.rev || 1, at: prevStep?.at || now, by: prevStep?.by || execution.by, note: prevStep?.next || '' });
      }
    }
    d.metrics = structuredClone(submission.metrics);
    for (const metric of d.metrics.items) if (metric.guard) metric.locked = true;
    d.metricHistory ||= [];
    const curVer = String(d.metrics.version || 'E1');
    const mSnap = { ...structuredClone(d.metrics), rev: nextRev, at: now, by: execution.by, note: submission.next || '' };
    const mIdx = d.metricHistory.findIndex((m: Data) => m.version === curVer);
    if (mIdx >= 0) d.metricHistory[mIdx] = mSnap;
    else d.metricHistory.push(mSnap);
  }
  if (section === 'run') {
    const rawWindow = submission.window || (!hasValidSchedule(d.policy.schedule) ? submission.items.find((p) => p.id === 'cp-trigger')?.value : undefined);
    const parsed = parseScheduleText(rawWindow);
    if (parsed) d.policy.schedule = parsed;
  }
  if (submission.upcoming) d.upcoming = structuredClone(submission.upcoming);
  const project = Object.keys(state.objectives).find((k) => state.objectives[k].some((o) => o.id === id))!;
  for (const doc of submission.docs || []) {
    const at = state.library[project].findIndex((x) => x.id === doc.id);
    const value = { ...doc, at: now, state: 'pending' };
    if (at < 0) state.library[project].push(value); else state.library[project][at] = value;
  }
  if (submission.executor?.state === 'passed') {
    summaryOf(state, id)!.trigger = timeRange(scheduleSummary(d.policy.schedule));
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
  if (input.rounds != null && input.rounds !== '' && (!Number.isSafeInteger(+input.rounds) || +input.rounds < 1)) return { error: 'The cycle limit must be a positive integer' };
  return { stop: { target: target || null, maxCycles: +input.rounds || null } };
}
// How many failed cycles a night fixes by itself (PHASE3 §1): the governance member fixes them and the cycle reruns; 0 turns it off.
export const REPAIR_DEFAULT = 5;
export function repairCount(value: unknown): { count: number } | { error: string } {
  if (value == null || value === '') return { count: REPAIR_DEFAULT };
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 && n <= 20 ? { count: n } : { error: '「夜里出错自动修几次」要写 0–20 的整数，0 = 不自动修' };
}
export const repairText = (n: number) => n ? `运行失败时交给治理执行成员修，修完重跑这一周期；每晚最多 ${n} 次，同一个错误连续 3 次就停下等你` : '不自动修：运行失败时交给评估成员下结论，等你决定';
// Which kinds of direction a night adopts without a person (PHASE3 §2); by default FLOW §3's: execution fixes and variables within the declared scope.
export const AUTO: Record<string, string[]> = { default: ['execution', 'variable'], execution: ['execution'], none: [] };
export function autoKinds(value: unknown): { kinds: string[] } | { error: string } {
  const key = value == null || value === '' ? 'default' : value;
  return typeof key === 'string' && Object.hasOwn(AUTO, key) ? { kinds: [...AUTO[key]] } : { error: '「夜里可以自己定的方向」只能选执行修复和调变量、只有执行修复或都等我定' };
}
export const autoKey = (kinds: string[]) => Object.keys(AUTO).find((k) => AUTO[k].join() === kinds.join());
export const autoText = (kinds: string[]) => kinds.length ? `${kinds.includes('variable') ? '执行修复和调变量：时段内结论的第一方向是这两类' : '只有执行修复：时段内结论的第一方向是执行修复'}就直接采纳（几位分析成员要意见一致），有候选时直接复验；其余等你定` : '都等你定：夜里不自己采纳方向，也不直接复验候选';
export const stopText = (stop: Data) => [stop.target && `达到「${stop.target}」并复验稳定`, stop.maxCycles && `用满 ${stop.maxCycles} 个周期`].filter(Boolean).join('，或') || '由你决定';
export function clipTitle(text: unknown, max: number, fallback = 'RSI'): string {
  const clean = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (!clean) return fallback;
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}
export function threadTitle(text: unknown, max = 64): string {
  const clean = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  const body = clean.replace(/^RSI\s*·\s*/, '');
  return clipTitle(body ? `RSI · ${body}` : 'RSI', max, 'RSI');
}

export function rsiExpNew(state: RsiState, project: string, body: Data, now: number) {
  const fixture = createFixtures(now), templateId = project === 'pd-infer' ? 'pd-ttft' : 'cp-converge';
  const d = structuredClone(fixture.templates[templateId]);
  const id = body.projectPath || summaryOf(state, templateId) ? `obj-${randomUUID()}` : templateId;
  const limits = stopOf(body).stop, stop = stopText(limits), name = clipTitle(body.statement, 48);
  const reuseThread = body.projectPath && typeof body.reuseThread === 'string' && body.reuseThread ? body.reuseThread : null;
  d.objective = { ...d.objective, id, name, projectId: project, ...(body.projectPath ? { projectPath: body.projectPath } : {}), state: 'preparing', thread: reuseThread, currentVersion: 'v1', round: 0, budget: { rounds: limits.maxCycles, used: 0 }, stop: limits, goal: { ...d.objective.goal, statement: body.statement, good: '', adoptWhen: '', stopWhen: stop } };
  d.rounds = []; d.messages = []; d.steps = {}; d.exec = {}; d.seq = 0;
  delete d.night;
  d.versions = [{ ...d.versions[0], current: true }];
  if (body.projectPath) {
    d.versions = [{ id: 'v1', parent: null, change: '初始版本', config: {}, commit: null, snapshot: true, at: now, current: true }];
    d.executor = { state: 'none', mcp: 'rsi.executor', ops: [], resultMap: [] };
    const initialSchedule = typeof body.scheduleMode === 'string' && body.scheduleMode ? scheduleOf({ mode: body.scheduleMode }) : null;
    d.policy.schedule = initialSchedule && 'schedule' in initialSchedule ? initialSchedule.schedule : { window: '' };
    delete d.upcoming;
  }
  d.plan = RSI_CP_INIT.map((s) => ({ k: s.section, role: s.role, deps: [...s.deps] }));
  d.executor.state = 'none';
  d.prep = d.prep.map((p) => ({ ...p, value: '', state: 'uninvestigated', by: '', neededFrom: null, at: null, facts: null, can: null, rec: null, tag: null }));
  // A real project's items are the members' own (they name, add and drop them); only the goal section's questions are fixed.
  if (body.projectPath) d.prep = d.prep.filter((p) => p.section === 'goal');
  // A real project's members are the cats chosen here; the template's other roles are demo placeholders that never act.
  if (body.projectPath) d.members = d.members.filter((m) => ['prepare', 'iterate', 'evaluate'].includes(m.role));
  for (const role of ['prepare', 'iterate', 'evaluate']) {
    // Governance execution (the version a decision asks for) is its own member; without a choice the preparer does it.
    const catId = role === 'iterate' ? body.iterate || body.prepare : body[role];
    setMember(d.members.find((m) => m.role === role)!, catId, body.cats);
  }
  // The discussion members picked in the dialog were kept as a draft until the objective existed.
  if (body.projectPath) for (const a of state.draft?.analysts || []) d.members.push({ role: 'analyze', ...a });
  refreshMembers(d.members, body.cats);
  // Seed independent per-step analysis members from the initial role assignment; later edits stay isolated from execution members.
  d.stepMembers = {};
  for (const p of d.plan) {
    const base = d.members.find((m) => m.role === p.role);
    if (base?.catId) d.stepMembers[p.k] = { catId: base.catId, name: base.name, model: base.model, ...(base.handle ? { handle: base.handle } : {}) };
  }
  delete state.draft;
  const goal = d.prep.find((p) => p.id.endsWith('-goal'))!;
  Object.assign(goal, { value: body.statement, state: 'confirmed', by: '你', mine: true, at: now });
  const stopItem = d.prep.find((p) => p.id.endsWith('-stop'));
  if (stopItem) Object.assign(stopItem, { value: stop, state: 'confirmed', by: '你', mine: true, at: now });
  else d.prep.push({ id: `${id}-stop`, section: 'goal', title: '何时停', value: stop, state: 'confirmed', neededFrom: null, mine: true, by: '你', at: now });
  d.policy.repair = (repairCount(body.repair) as { count: number }).count;
  d.prep.push({ id: `${id}-repair`, section: 'goal', title: '夜里出错自动修', value: repairText(d.policy.repair), state: 'confirmed', neededFrom: null, mine: true, by: '你', at: now });
  d.policy.auto = (autoKinds(body.auto) as { kinds: string[] }).kinds;
  d.prep.push({ id: `${id}-auto`, section: 'goal', title: '夜里可以自己定的方向', value: autoText(d.policy.auto), state: 'confirmed', neededFrom: null, mine: true, by: '你', at: now });
  state.experiments[id] = d;
  const initTrigger = d.policy.schedule ? String(timeRange(scheduleSummary(d.policy.schedule)) || '') : '';
  state.objectives[project].push({ id, name, parent: null, state: 'preparing', mode: 'exp', trigger: body.projectPath ? initTrigger : '', running: null, cycle: null, prediction: null, locked: 0, ...(reuseThread ? { thread: reuseThread } : {}) });
  enqueue(state, d, 'createThread', { project, title: threadTitle(body.statement) });
  const who = (role: string) => mention(d.members.find((m) => m.role === role)!);
  message(state, d, now, `新评估项：${body.statement}`, `何时停：${stop}。\n\n${who('prepare')} 负责准备\n${who('evaluate')} 负责评估\n${who('iterate')} 负责治理执行（按你选的方向出新版本）\n\n初始化七步，按依赖往下做。`, 'goal');
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
