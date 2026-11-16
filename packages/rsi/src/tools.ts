import { RSI_CP_INIT, createFixtures } from './fixtures.js';
import { submitInitStep, enqueue, kick, STOP_TARGET, syncObjective } from './init.js';
import { conclude, comparison, controlGroup, cycleLibrary, freshSeeds, validPlan } from './cycles.js';
import { windowMinutes } from './schedule.js';
import { record, text } from './store.js';
import type { Data, Experiment, PrepItem, RsiState, Section, ToolContext } from './types.js';

const fields = ['preflight', 'submit', 'get', 'cancel', 'collect', 'analyze'];
export function executorInput(input: Data): boolean {
  return ['preflight', 'submit', 'collect'].every((k) => text(input[k]))
    && fields.every((k) => input[k] === undefined || text(input[k]))
    && (input.failureField === undefined || text(input.failureField))
    && (input.resultMap === undefined || Array.isArray(input.resultMap) && input.resultMap.every((m: unknown) => record(m) && text(m.metric) && text(m.field)));
}

function registerExecutor(state: RsiState, d: Experiment, input: Data) {
  const commands = Object.fromEntries(fields.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
  d.executor = { mcp: 'rsi.executor', state: 'probing', commands, failureField: input.failureField, resultMap: input.resultMap || [],
    ops: Object.entries(commands).map(([op, command]) => ({ op, tool: command, params: {} })), pending: d.executor.pending?.executionId === d.exec!.run!.id ? d.executor.pending : undefined };
  enqueue(state, d, 'executor', { action: 'preflight', executionId: d.exec!.run!.id });
}

function currentStep(d: Experiment, input: Data) {
  const plan = typeof input.step === 'number' ? d.plan[input.step - 1] : d.plan.find((p) => p.k === input.step);
  return plan?.k;
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
        value: item.value, userOwned: !!item.mine, format: 'value: string; facts?: [{k:string,v:string}]; can?: string; rec?: explore|fixed|excluded; tag?: string',
        example: template.prep.find((p) => p.id === item.id)?.value || '填写项目中的观察、依据和建议。' })),
      ...(d.objective.projectPath && p.k !== 'goal' ? { itemsAreYours: '这一步的条目由你按这个项目来定：每条自己起 id（小写、短横线）和 title，按项目实际增删；重做时没再提交的条目会被去掉。下面 examples 是另一个项目（CartPole 强化学习）的写法，只看结构，不要照抄名字。',
        examples: template.prep.filter((x) => x.section === p.k).map((x) => ({ id: x.id, title: x.title, value: x.value })) } : {}),
      deps: p.deps.map((k) => ({ step: d.plan.findIndex((p) => p.k === k) + 1, section: k, version: d.steps![k]!.rev, items: d.prep.filter((item) => item.section === k) })),
      ...(p.k === 'run' ? { window: '每晚 20:00–08:00', executor: '先用 rsi.executor 登记 preflight/submit/collect 命令；preflight 通过且本步 items 已提交后才完成。' } : {}),
      ...(p.k === 'rules' ? { metrics: { version: 'E1', items: [{ id: 'score', name: '得分', how: 'metrics.json 的 score', dir: 'up', unit: '分', locked: true, guard: false }] } } : {}),
      ...(p.k === 'design' || p.k === 'baseline' ? { upcoming: { groups: [{ id: 'control', label: '对照', vars: {}, control: true }, { id: 'change', label: '一个改动', vars: { '<配置里的键>': '<新取值>' } }], seeds: [11, 23] } } : {}) };
  });
  const evaluate = d.members.find((m) => m.role === 'evaluate')?.catId === ctx.catId && d.rounds.find((r: Data) => r.state === 'evaluating');
  const version = d.members.find((m) => m.role === 'prepare')?.catId === ctx.catId && d.versionRequest;
  if (!steps.length && !evaluate && !version) return { error: 'It is not this member’s turn', status: 403 };
  if (evaluate) evaluate.invocationId = ctx.invocationId;
  if (version) version.invocationId = ctx.invocationId;
  return { objective: d.objective, projectPath: d.objective.projectPath, steps, versions: d.versions,
    stepVersions: d.steps, ...(evaluate ? { evaluate: { cycle: evaluate.n, plan: evaluate.plan, runs: evaluate.runs, metrics: evaluate.metrics || d.metrics, comparison: comparison(d, evaluate), library: cycleLibrary(state, d), next: '调用 rsi.conclude 提交 verdict/findings/options；方向 cites 引用之前周期的资料库条目。' } } : {}),
    ...(version ? { version: { ...version, next: '按方向修改项目并提交 git；调用 rsi.version({change,commit,config})。config 是 JSON 对象或项目内 JSON 文件路径。' } } : {}) };
}

// Some member runtimes hand nested arguments over as JSON text ("items": "[{…}]"); read them as the structures they describe.
// Text that is not JSON (a shell command such as "[ -f train.py ]") stays as it is.
const structured = (v: unknown) => { if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) return v; try { return JSON.parse(v); } catch { return v; } };

export function toolAction(state: RsiState, method: string, raw: Data, ctx: ToolContext, now: number): Data {
  const input: Data = Object.fromEntries(Object.entries(raw || {}).map(([k, v]) => [k, structured(v)]));
  const d = Object.values(state.experiments).find((d) => d.objective.thread === ctx.threadId);
  if (!d?.objective.projectPath) return { error: 'No real RSI objective in this thread', status: 404 };
  if (!d.members.some((m) => m.catId === ctx.catId)) return { error: 'Not an objective member', status: 403 };
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
    const round = d.rounds.find((r: Data) => r.n === input.cycle);
    if (d.members.find((m) => m.role === 'evaluate')?.catId !== ctx.catId || round?.invocationId !== ctx.invocationId) return { error: 'Call rsi.task on the evaluation turn first', status: 403 };
    return conclude(state, d, input, now);
  }
  if (method === 'rsi.version') {
    if (d.members.find((m) => m.role === 'prepare')?.catId !== ctx.catId || d.versionRequest?.invocationId !== ctx.invocationId) return { error: 'Call rsi.task on the version turn first', status: 403 };
    if (!text(input.change) || input.commit !== undefined && (!text(input.commit) || !/^[a-f0-9]{7,40}$/i.test(input.commit)) || !(record(input.config) || text(input.config))) return { error: 'Provide change, optional git commit (7–40 hex characters), and config (JSON object or JSON file path)' };
    const previous = d.objective.currentVersion, id = `v${d.versions.length + 1}`;
    d.versions.push({ id, parent: previous, change: input.change, commit: input.commit || null, config: input.config, at: now, current: false, status: 'proposed' });
    const last = d.rounds.find((r: Data) => r.n === d.versionRequest.cycle);
    d.upcoming = { ...last.plan, baseline: false, seeds: freshSeeds(d, last.plan.seeds.length), groups: [controlGroup(d),
      { id: 'change', label: input.change, version: id, vars: {}, control: false, confirm: false }] };
    delete d.versionRequest;
    syncObjective(state, d);
    return { ok: true, version: id };
  }
  if (method === 'rsi.executor') {
    if (!claimed(d, 'run', ctx)) return { error: 'Call rsi.task on step 3 first; dependencies must be current', status: 403 };
    if (!executorInput(input)) return { error: 'Provide preflight, submit and collect templates; get/cancel/analyze and resultMap are optional' };
    if (d.executor.state === 'probing') return { error: 'Preflight is already running', status: 409 };
    registerExecutor(state, d, input);
    return { ok: true, state: 'probing' };
  }
  if (method !== 'rsi.submit') return { error: 'Unknown RSI tool' };
  const section = currentStep(d, input);
  const own = !!d.objective.projectPath && section !== 'goal';
  if (!section || !claimed(d, section, ctx)) return { error: 'Call rsi.task for the current step; dependencies or execution changed', status: 409 };
  if (!Array.isArray(input.items) || !input.items.length || input.items.some((p: unknown) => !record(p) || !text(p.id) || !text(p.value)
    || p.facts !== undefined && (!Array.isArray(p.facts) || p.facts.some((f: unknown) => !record(f) || !text(f.k) || typeof f.v !== 'string'))
    || p.rec !== undefined && !['explore', 'fixed', 'excluded'].includes(p.rec)
    || p.can !== undefined && !text(p.can) || p.tag !== undefined && !text(p.tag))
    || new Set(input.items.map((p: Data) => p.id)).size !== input.items.length
    || input.items.some((p: Data) => !d.prep.some((x) => x.section === section && x.id === p.id) && (!own || !text(p.title) || d.prep.some((x) => x.id === p.id)))
    || d.prep.some((p) => p.section === section && !p.mine && !own && !input.items.some((x: Data) => x.id === p.id))
    || input.unknowns !== undefined && typeof input.unknowns !== 'string' || input.next !== undefined && typeof input.next !== 'string') return { error: 'Submit all step items with non-empty values and valid facts/rec/can/tag; in a real project a new item needs its own id and a title' };
  if (section === 'run' && input.window !== undefined && !windowMinutes(input.window)) return { error: 'Provide a window such as 20:00–08:00' };
  if (input.goal !== undefined && !record(input.goal)) return { error: 'Invalid goal' };
  if (input.docs !== undefined && (!Array.isArray(input.docs) || input.docs.some((doc: unknown) => !record(doc) || !text(doc.id) || !text(doc.title) || !text(doc.body) || !['project', 'provided', 'feedback'].includes(doc.kind)))) return { error: 'Docs require id, title, body and kind' };
  if (section === 'rules' && (!record(input.metrics) || !text(input.metrics.version) || !Array.isArray(input.metrics.items) || !input.metrics.items.length
    || input.metrics.items.some((m: unknown) => !record(m) || !text(m.id) || !text(m.name) || !text(m.how) || !['up', 'down'].includes(m.dir) || m.guard !== undefined && typeof m.guard !== 'boolean' || m.guard && (typeof m.threshold !== 'number' || !Number.isFinite(m.threshold)))
    || !input.metrics.items.some((m: Data) => !m.guard)
    || new Set(input.metrics.items.map((m: Data) => m.id)).size !== input.metrics.items.length)) return { error: 'Step 4 requires metrics {version,items:[{id,name,how,dir:up|down,guard?,threshold?}]}; guardrails require a finite threshold' };
  // A real objective's stop target names a metric; step 4 must define it, or the target could never be checked.
  const stopMetric = section === 'rules' && d.objective.projectPath && STOP_TARGET.exec(d.objective.stop?.target || '')?.[1].trim();
  if (stopMetric && !input.metrics.items.some((m: Data) => m.id === stopMetric || m.name === stopMetric))
    return { error: `停止目标「${d.objective.stop.target}」里的指标「${stopMetric}」不在量尺里：把对应量尺的 id 或名称写成「${stopMetric}」，或请用户在页面上改「何时停」。` };
  if ((section === 'design' || section === 'baseline') && input.upcoming !== undefined && !validPlan(input.upcoming)) return { error: 'Invalid upcoming plan' };
  if (section === 'design' && !validPlan(input.upcoming)) return { error: 'Step 5 requires upcoming {groups:[{id,label,vars}],seeds:[integer]}' };
  const items = input.items.map((p: Data) => ({ ...d.prep.find((x) => x.id === p.id)!, ...p, section })) as PrepItem[];
  const submission = { section, executionId: d.exec![section]!.id, items, unknowns: input.unknowns, next: input.next, ...(section === 'run' && input.window ? { window: input.window } : {}),
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
