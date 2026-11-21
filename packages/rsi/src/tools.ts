import { RSI_CP_INIT, createFixtures } from './fixtures.js';
import { submitInitStep, enqueue, kick, message, STOP_TARGET, syncObjective } from './init.js';
import { abandonRepair, conclude, comparison, controlGroup, cycleLibrary, freshSeeds, propose, validPlan } from './cycles.js';
import { parseScheduleText } from './schedule.js';
import { record, text } from './store.js';
import type { Data, Experiment, PrepItem, RsiState, Section, ToolContext } from './types.js';
import { platform } from 'node:os';

const fields = ['preflight', 'submit', 'get', 'cancel', 'collect', 'analyze'];
export function executorInput(input: Data): boolean {
  return ['preflight', 'submit', 'collect'].every((k) => text(input[k]))
    && fields.every((k) => input[k] === undefined || text(input[k]))
    && (input.failureField === undefined || text(input.failureField))
    && (input.timeout === undefined || Number.isSafeInteger(+input.timeout) && +input.timeout > 0)
    && (input.poll === undefined || Number.isSafeInteger(+input.poll) && +input.poll > 0)
    && (input.resultMap === undefined || Array.isArray(input.resultMap) && input.resultMap.every((m: unknown) => record(m) && text(m.metric) && text(m.field)));
}

function registerExecutor(state: RsiState, d: Experiment, input: Data) {
  const commands = Object.fromEntries(fields.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
  d.executor = { mcp: 'rsi.executor', state: 'probing', commands, failureField: input.failureField, resultMap: input.resultMap || [], ...(input.timeout !== undefined ? { timeout: +input.timeout } : {}), ...(input.poll !== undefined ? { poll: +input.poll } : {}),
    ops: Object.entries(commands).map(([op, command]) => ({ op, tool: command, params: {} })), pending: d.executor.pending?.executionId === d.exec!.run!.id ? d.executor.pending : undefined };
  enqueue(state, d, 'executor', { action: 'preflight', executionId: d.exec!.run!.id });
}

function currentStep(d: Experiment, input: Data) {
  const raw = input.step;
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[1-7]$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  const plan = Number.isInteger(num) ? d.plan[num - 1] : d.plan.find((p) => p.k === raw);
  return plan?.k;
}

function normalizeFacts(raw: unknown): { k: string; v: string }[] | undefined | null {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    const out: { k: string; v: string }[] = [];
    for (const f of raw) {
      if (typeof f === 'string') {
        const s = f.trim();
        if (!s) return null;
        const m = /^([^:：]{1,40})[:：]\s*(.+)$/.exec(s);
        out.push(m ? { k: m[1].trim(), v: m[2].trim() } : { k: '依据', v: s });
      } else if (record(f) && text(f.k) && typeof f.v === 'string') {
        out.push({ k: f.k, v: f.v });
      } else {
        return null;
      }
    }
    return out;
  }
  if (record(raw)) {
    const entries = Object.entries(raw);
    if (entries.some(([k, v]) => !k.trim() || typeof v !== 'string')) return null;
    return entries.map(([k, v]) => ({ k: k.trim(), v: v as string }));
  }
  return null;
}

function claimed(d: Experiment, section: Section, ctx: ToolContext) {
  const ex = d.exec?.[section], plan = d.plan.find((p) => p.k === section)!;
  return ex?.state === 'started' && ex.by === ctx.catId && ex.invocationId === ctx.invocationId
    && plan.deps.every((k) => d.steps?.[k] && !d.steps[k]!.stale && d.steps[k]!.rev === ex.base[k]);
}

function task(state: RsiState, d: Experiment, ctx: ToolContext) {
  const template = createFixtures().templates['cp-converge'];
  const steps = d.plan.filter((p) => d.exec?.[p.k]?.state === 'started' && d.exec[p.k]!.by === ctx.catId).map((p) => {
    const ex = d.exec![p.k]!;
    ex.invocationId = ctx.invocationId;
    const prototype = RSI_CP_INIT.find((s) => s.section === p.k)!;
    return { step: d.plan.indexOf(p) + 1, section: p.k, executionId: ex.id, ask: prototype.ask,
      items: d.prep.filter((item) => item.section === p.k).map((item) => ({ id: item.id, title: item.title, meaning: item.title,
        value: item.value, userOwned: !!item.mine, format: 'value: string; facts?: string[]（如 ["依据：README"]，兼容 [{k,v}]）; can?: string; rec?: explore|fixed|excluded; tag?: string；已有条目也可用顶层 2 层 values: { "<id>": "<值>" } 简写',
        example: template.prep.find((p) => p.id === item.id)?.value || '填写项目中的观察、依据和建议。' })),
      ...(d.objective.projectPath && p.k !== 'goal' ? { itemsAreYours: '这一步的条目由你按这个项目来定：每条自己起 id（小写、短横线）和 title，按项目实际增删；重做时没再提交的条目会被去掉。下面 examples 是另一个项目（CartPole 强化学习）的写法，只看结构，不要照抄名字。',
        examples: template.prep.filter((x) => x.section === p.k).map((x) => ({ id: x.id, title: x.title, value: x.value })) } : {}),
      deps: p.deps.map((k) => ({ step: d.plan.findIndex((p) => p.k === k) + 1, section: k, version: d.steps![k]!.rev, items: d.prep.filter((item) => item.section === k) })),
      ...(p.k === 'run' ? { window: '支持「不限制」「周一至周五 09:00–18:00；周六至周日 全天」「2026-11-21~2026-11-30 09:00–18:00」或「20:00–08:00」', executor: '先用 rsi.executor 登记 preflight/submit/collect 命令；preflight 通过且本步 items 已提交后才完成。' } : {}),
      ...(p.k === 'rules' ? { metrics: { version: 'E1', items: [{ id: 'score', name: '得分', how: 'metrics.json 的 score', dir: 'up', unit: '分', locked: true, guard: false }] } } : {}),
      ...(p.k === 'design' || p.k === 'baseline' ? { upcoming: { groups: [{ id: 'control', label: '对照', vars: {}, control: true }, { id: 'change', label: '一个改动', vars: { '<配置里的键>': '<新取值>' } }], seeds: [11, 23] } } : {}) };
  });
  const evaluate = d.members.find((m) => m.role === 'evaluate')?.catId === ctx.catId && d.rounds.find((r: Data) => r.state === 'evaluating');
  const version = d.members.find((m) => m.role === 'iterate')?.catId === ctx.catId && d.versionRequest;
  const analyze = d.rounds.find((r: Data) => r.analysis?.waiting.includes(ctx.catId));
  if (!steps.length && !evaluate && !version && !analyze) return { error: 'It is not this member’s turn', status: 403 };
  if (evaluate) evaluate.invocationId = ctx.invocationId;
  if (analyze) (analyze.analysis.turns ||= {})[ctx.catId] = ctx.invocationId;
  if (version) version.invocationId = ctx.invocationId;
  return { objective: d.objective, projectPath: d.objective.projectPath, steps, versions: d.versions,
    // The shell that runs the registered commands, so members write commands that run on this host.
    shell: platform() === 'win32' ? 'cmd' : 'sh', stepVersions: d.steps, ...(evaluate ? { evaluate: { cycle: evaluate.n, plan: evaluate.plan, runs: evaluate.runs, metrics: evaluate.metrics || d.metrics, comparison: comparison(d, evaluate), library: cycleLibrary(state, d), next: '调用 rsi.conclude 提交 verdict/findings/options；方向 cites 引用之前周期的资料库条目。' } } : {}),
    ...(analyze ? { analyze: { cycle: analyze.n, report: { verdict: analyze.report.verdict, findings: analyze.report.summary, confirmation: analyze.confirmation }, plan: analyze.plan, runs: analyze.runs,
      metrics: analyze.metrics || d.metrics, comparison: comparison(d, analyze), library: cycleLibrary(state, d),
      next: '调用 rsi.propose({cycle,options:[{k,title,why,kind?,target?,cites?}]}) 交你的方向。target 写这个方向要改的对象（例如 lr、group_size、train.py 的奖励），几个分析成员的第一方向种类和对象都相同就算意见一致。' } } : {}),
    ...(version ? { version: { ...version, next: version.repair ? '修好让它跑不起来的问题并提交 git，调用 rsi.version({change,commit,config})，插件用修好的版本重跑这一周期的计划；修不了就调 rsi.version({cannot:"原因"})。' : '按方向修改项目并提交 git；调用 rsi.version({change,commit,config})。config 是 JSON 对象或项目内 JSON 文件路径。' } } : {}) };
}

// Some member runtimes hand nested arguments over as JSON text ("items": "[{…}]"); read them as the structures they describe.
// Text that is not JSON (a shell command such as "[ -f train.py ]") stays as it is.
const structured = (v: unknown) => { if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) return v; try { return JSON.parse(v); } catch { return v; } };

export function toolAction(state: RsiState, method: string, raw: Data, ctx: ToolContext, now: number): Data {
  const input: Data = Object.fromEntries(Object.entries(raw || {}).map(([k, v]) => [k, structured(v)]));
  const d = Object.values(state.experiments).find((d) => d.objective.thread === ctx.threadId);
  if (!d?.objective.projectPath) return { error: 'No real RSI objective in this thread', status: 404 };
  const isObjectiveMember = d.members.some((m) => m.catId === ctx.catId)
    || Object.values<Data>(d.stepMembers || {}).some((m) => m?.catId === ctx.catId);
  if (!isObjectiveMember) return { error: 'Not an objective member', status: 403 };
  if (method === 'rsi.task') {
    for (const plan of d.plan) {
      const execution = d.exec?.[plan.k];
      if (execution?.state !== 'started' || execution.by !== ctx.catId) continue;
      if (plan.deps.some((k) => d.steps?.[k]?.rev !== execution.base[k] || d.steps?.[k]?.stale)) {
        delete d.exec![plan.k];
        if (d.steps?.[plan.k]) Object.assign(d.steps[plan.k]!, { stale: true, redo: true });
        kick(state, d.objective.id, now);
        return task(state, state.experiments[d.objective.id], ctx);
      }
    }
    return task(state, d, ctx);
  }
  if (method === 'rsi.conclude') {
    // The cycle may arrive as text ("1"); a cycle that does not exist says so instead of asking for rsi.task.
    const cycle = Number(input.cycle), round = d.rounds.find((r: Data) => r.n === cycle);
    if (!round) return { error: `Cycle ${JSON.stringify(input.cycle)} not found: pass the number in rsi.task evaluate.cycle`, status: 404 };
    if (d.members.find((m) => m.role === 'evaluate')?.catId !== ctx.catId || round.invocationId !== ctx.invocationId) return { error: 'Call rsi.task on the evaluation turn first', status: 403 };
    return conclude(state, d, { ...input, cycle }, now);
  }
  if (method === 'rsi.propose') {
    const cycle = Number(input.cycle), round = d.rounds.find((r: Data) => r.n === cycle);
    if (!round) return { error: `Cycle ${JSON.stringify(input.cycle)} not found: pass the number in rsi.task analyze.cycle`, status: 404 };
    if (round.analysis?.turns?.[ctx.catId] !== ctx.invocationId) return { error: 'Call rsi.task on the direction turn first', status: 403 };
    return propose(state, d, { ...input, cycle }, ctx.catId, now);
  }
  if (method === 'rsi.version') {
    if (d.members.find((m) => m.role === 'iterate')?.catId !== ctx.catId || d.versionRequest?.invocationId !== ctx.invocationId) return { error: 'Call rsi.task on the version turn first', status: 403 };
    // A repair the member cannot make goes to the evaluator instead.
    if (d.versionRequest.repair && text(input.cannot)) { abandonRepair(state, d, `${d.members.find((m) => m.role === 'iterate')!.name} 说修不了：${input.cannot}`, now); return { ok: true, evaluating: true }; }
    const configVal = input.config !== undefined ? input.config : text(input.configPath) ? input.configPath : undefined;
    if (!text(input.change) || input.commit !== undefined && (!text(input.commit) || !/^[a-f0-9]{7,40}$/i.test(input.commit)) || !(record(configVal) || text(configVal))) return { error: 'Provide change, optional git commit (7–40 hex characters), and config (JSON object or JSON file path / configPath)' };
    const previous = d.objective.currentVersion, id = `v${d.versions.length + 1}`;
    const changes = record(input.changes) ? {
      ...(record(input.changes.pr) && text(input.changes.pr.id) ? { pr: { id: input.changes.pr.id, ...(text(input.changes.pr.url) ? { url: input.changes.pr.url } : {}), ...(text(input.changes.pr.title) ? { title: input.changes.pr.title } : {}), ...(text(input.changes.pr.state) ? { state: input.changes.pr.state } : {}) } } : {}),
      ...(Array.isArray(input.changes.files) ? { files: input.changes.files.filter((f: unknown) => record(f) && text(f.path)).map((f: Data) => ({ path: f.path, op: ['modify', 'add', 'delete', 'rename'].includes(f.op) ? f.op : 'modify', ...(typeof f.added === 'number' ? { added: f.added } : {}), ...(typeof f.removed === 'number' ? { removed: f.removed } : {}), ...(Array.isArray(f.hunks) ? { hunks: f.hunks } : {}) })) } : {}),
      ...(Array.isArray(input.changes.items) ? { items: input.changes.items.filter((it: unknown) => record(it) && text(it.name)).map((it: Data) => ({ op: ['set', 'add', 'del'].includes(it.op) ? it.op : 'set', name: it.name, ...(it.from !== undefined ? { from: String(it.from) } : {}), ...(it.to !== undefined ? { to: String(it.to) } : {}) })) } : {}),
    } : null;
    const versionRecord: Data = { id, parent: previous, change: input.change, commit: input.commit || null, config: configVal, at: now, current: false, status: 'proposed',
      ...(changes ? { changes } : {}),
      ...(changes?.pr?.id ? { pr: changes.pr.id } : {}),
      ...(d.versionRequest.prediction ? { prediction: d.versionRequest.prediction } : {}) };
    d.versions.push(versionRecord);
    const last = d.rounds.find((r: Data) => r.n === d.versionRequest.cycle);
    if (last) {
      if (changes) last.govChanges = structuredClone(changes);
      const iterMember = d.members.find((m) => m.role === 'iterate');
      last.stageMembers ||= {};
      last.stageMembers.gov = { catId: ctx.catId, name: iterMember?.name || ctx.catId };
    }
    if (d.versionRequest.direct) {
      // An execution fix becomes the default at once and keeps the default's configuration and variables, so only its code
      // changes what runs; the next cycle runs it as the control.
      const version = d.versions.find((v: Data) => v.id === id), before = d.versions.find((v: Data) => v.id === previous);
      Object.assign(version, { status: 'confirmed', direct: true, config: before.config, vars: before.vars || {} });
      for (const v of d.versions) v.current = v.id === id;
      d.objective.currentVersion = id;
      if (d.versionRequest.repair) {
        // A repair reruns the failed cycle's plan on the fixed version; the failed cycle stays as it ran, marked repaired, and is not evaluated.
        Object.assign(last, { state: 'repaired', repairedBy: id });
        (d.repairs ||= []).push({ at: now, cycle: last.n, version: id, signature: d.versionRequest.repair.signature });
        d.upcoming = { ...last.plan, baseline: false, groups: last.plan.groups.map((g: Data) => (g.version || previous) === previous ? { ...g, version: id } : g) };
        message(state, d, now, `执行修复 ${id}：重跑第 ${last.n} 周期的计划`, `${input.change}\n\n修的是：${d.versionRequest.repair.signature}`, 'plan');
      } else {
        d.upcoming = { ...last.plan, baseline: false, seeds: freshSeeds(d, last.plan.seeds.length), groups: [controlGroup(d)] };
        message(state, d, now, `执行修复 ${id} 直接作为默认版本`, `${input.change}\n\n执行修复不和旧版本对比；下一周期用它跑当前版本对照，确认没有跑坏。`, 'plan');
      }
    } else d.upcoming = { ...last.plan, baseline: false, seeds: freshSeeds(d, last.plan.seeds.length), groups: [controlGroup(d),
      { id: 'change', label: input.change, version: id, vars: {}, control: false, confirm: false }] };
    delete d.versionRequest;
    syncObjective(state, d);
    return { ok: true, version: id };
  }
  if (method === 'rsi.executor') {
    if (!claimed(d, 'run', ctx)) return { error: 'Call rsi.task on step 3 first; dependencies must be current', status: 403 };
    if (!executorInput(input)) return { error: 'Provide preflight, submit and collect templates; get/cancel/analyze, resultMap, timeout and poll (seconds) are optional' };
    if (d.executor.state === 'probing') return { error: 'Preflight is already running', status: 409 };
    registerExecutor(state, d, input);
    return { ok: true, state: 'probing' };
  }
  if (method !== 'rsi.submit') return { error: 'Unknown RSI tool' };
  const section = currentStep(d, input);
  const own = !!d.objective.projectPath && section !== 'goal';
  if (!section || !claimed(d, section, ctx)) return { error: 'Call rsi.task for the current step; dependencies or execution changed', status: 409 };
  const rawItems = Array.isArray(input.items)
    ? input.items
    : input.items === undefined && record(input.values)
      ? Object.entries(input.values).map(([id, value]) => ({ id, value }))
      : input.items;
  if (!Array.isArray(rawItems) || !rawItems.length) {
    const preview = typeof rawItems === 'string' ? JSON.stringify(rawItems.slice(0, 60)) : typeof rawItems;
    return { error: `items must be a non-empty JSON array of objects (received ${Array.isArray(rawItems) ? 'empty array []' : preview}); pass items: [{id, value, facts?: ["依据：..."]}] or 2-level values: { "<id>": "<value>" }` };
  }
  const normalizedItems: (Data | null)[] = rawItems.map((p: unknown): Data | null => {
    if (!record(p)) return null;
    const facts = normalizeFacts(p.facts);
    if (facts === null) return null;
    const existing = d.prep.find((x) => x.section === section && x.id === p.id);
    const title = text(p.title) ? p.title : existing?.title || (own && text(p.id) ? p.id : undefined);
    return { ...p, ...(title !== undefined ? { title } : {}), ...(facts !== undefined ? { facts } : {}) };
  });
  const validNotes = (v: unknown) => v === undefined || typeof v === 'string' || (Array.isArray(v) && v.every(text));
  if (normalizedItems.some((p) => !p || !text(p.id) || !text(p.value)
    || p.rec !== undefined && !['explore', 'fixed', 'excluded'].includes(p.rec)
    || p.can !== undefined && !text(p.can) || p.tag !== undefined && !text(p.tag))
    || new Set(normalizedItems.map((p) => p!.id)).size !== normalizedItems.length
    || normalizedItems.some((p) => !d.prep.some((x) => x.section === section && x.id === p!.id) && (!own || !text(p!.title) || d.prep.some((x) => x.id === p!.id)))
    || d.prep.some((p) => p.section === section && !p.mine && !own && !normalizedItems.some((x) => x!.id === p.id))
    || !validNotes(input.unknowns) || !validNotes(input.next)) return { error: 'Submit all step items with non-empty values and valid facts/rec/can/tag; in a real project a new item needs its own id and a title' };
  const checkedItems = normalizedItems as Data[];
  if (section === 'run' && input.window !== undefined && !parseScheduleText(input.window)) return { error: 'Provide a valid window such as 不限制, 周一至周五 09:00–18:00；周六至周日 全天, 2026-11-21~2026-11-30 09:00–18:00, or 20:00–08:00' };
  if (input.goal !== undefined && !record(input.goal)) return { error: 'Invalid goal' };
  if (input.docs !== undefined && (!Array.isArray(input.docs) || input.docs.some((doc: unknown) => !record(doc) || !text(doc.id) || !text(doc.title) || !text(doc.body) || !['project', 'provided', 'feedback'].includes(doc.kind)))) return { error: 'Docs require id, title, body and kind' };
  if (section === 'rules' && (!record(input.metrics) || !text(input.metrics.version) || !Array.isArray(input.metrics.items) || !input.metrics.items.length
    || input.metrics.items.some((m: unknown) => !record(m) || !text(m.id) || !text(m.name) || !text(m.how) || !['up', 'down'].includes(m.dir) || m.guard !== undefined && typeof m.guard !== 'boolean' || m.guard && (typeof m.threshold !== 'number' || !Number.isFinite(m.threshold)))
    || input.metrics.items.some((m: Data) => m.minDelta !== undefined && !(typeof m.minDelta === 'number' && Number.isFinite(m.minDelta) && m.minDelta >= 0))
    || input.metrics.items.some((m: Data) => m.margin !== undefined && !(typeof m.margin === 'number' && Number.isFinite(m.margin) && m.margin >= 0))
    || !input.metrics.items.some((m: Data) => !m.guard)
    || new Set(input.metrics.items.map((m: Data) => m.id)).size !== input.metrics.items.length)) return { error: 'Step 4 requires metrics {version,items:[{id,name,how,dir:up|down,guard?,threshold?,minDelta?,margin?}]}; guardrails require a finite threshold; minDelta and margin are numbers ≥ 0' };
  if (section === 'rules' && input.metrics.items.some((m: Data) => m.minDelta !== undefined && m.margin !== undefined))
    return { error: '同一主指标不能同时设置 minDelta 和 margin：请选择最小有效提升或非劣效容差。' };
  // A real objective's stop target names a metric; step 4 must define it, or the target could never be checked.
  const stopMetric = section === 'rules' && d.objective.projectPath && STOP_TARGET.exec(d.objective.stop?.target || '')?.[1].trim();
  if (stopMetric && !input.metrics.items.some((m: Data) => m.id === stopMetric || m.name === stopMetric))
    return { error: `停止目标「${d.objective.stop.target}」里的指标「${stopMetric}」不在量尺里：把对应量尺的 id 或名称写成「${stopMetric}」，或请用户在页面上改「何时停」。` };
  if ((section === 'design' || section === 'baseline') && input.upcoming !== undefined && !validPlan(input.upcoming)) return { error: 'Invalid upcoming plan' };
  if (section === 'design' && !validPlan(input.upcoming)) return { error: 'Step 5 requires upcoming {groups:[{id,label,vars}],seeds:[integer]}' };
  const items = checkedItems.map((p: Data) => ({ ...d.prep.find((x) => x.id === p.id)!, ...p, section })) as PrepItem[];
  const joinNote = (v: unknown) => Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).join('\n') : v;
  const submission = { section, executionId: d.exec![section]!.id, items, unknowns: joinNote(input.unknowns) as string | undefined, next: joinNote(input.next) as string | undefined, ...(section === 'run' && input.window ? { window: input.window } : {}),
    ...(section === 'goal' && input.goal ? { goal: input.goal } : {}), ...(section === 'rules' ? { metrics: input.metrics } : {}),
    ...(['design', 'baseline'].includes(section) && input.upcoming ? { upcoming: input.upcoming } : {}),
    ...(input.docs ? { docs: input.docs.map((doc: Data) => ({ ...doc, objectives: [d.objective.id], sources: doc.sources || [], by: ctx.catId })) } : {}) };
  if (section === 'run') {
    if (input.executor !== undefined) {
      if (!record(input.executor) || !executorInput(input.executor)) return { error: 'Invalid executor templates' };
      if (d.executor.state === 'probing') return { error: 'Preflight is already running', status: 409 };
      registerExecutor(state, d, input.executor);
    }
    if (d.executor.state !== 'passed') {
      d.executor.pending = submission;
      return { ok: true, state: 'awaiting-preflight', next: 'Call rsi.executor if it has not been registered.' };
    }
  }
  return submitInitStep(state, d.objective.id, { ...submission, ...(section === 'run' ? { executor: d.executor } : {}) }, now);
}
