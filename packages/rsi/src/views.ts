import { AUTO, autoKey, clipTitle, prepSettled, REPAIR_DEFAULT, repairText, stepMemberOf, stopText } from './init.js';
import type { Data, RsiState } from './types.js';
import { projectOf, todoOf, cardsOf, libraryOf, tracesOf, runsOf, objectiveData, memberIds } from './data.js';
import { formatPolicy, maxRunsText, nextScheduledRuns, policiesOf, scheduleForm, scheduleSummary, timeRange, validatePolicy } from './schedule.js';
import { analystsOf, buildCloseoutReport, resolveRsiParent, short, signed, testedVersion } from './cycles.js';
import { buildComparisonTable, roundMetrics, roundMetricVersion } from './compare.js';

const tc = (key: string, ...args: unknown[]) => ({ t: key, args });

// The page follows the current conversation (query.thread = host:currentThread.id): its objective, else its project (threadProject,
// looked up by the backend). A choice made in the page is tagged with the conversation it was made in ("…#@thread"); in another
// conversation it no longer applies, so the page follows that one. pick "list" = back at the list. Reads and writes both use this.
export function follow(state: RsiState, query: Data) {
  const thread = typeof query.thread === 'string' ? query.thread : '', tag = thread ? '#@' + thread : '';
  const here = (v: unknown) => { if (typeof v !== 'string') return ''; const i = v.lastIndexOf('#@'); return i < 0 ? v : v.slice(i + 2) === thread ? v.slice(0, i) : ''; };
  const pickQ = here(query.pick), projectQ = here(query.project);
  const owner = (id: string) => Object.keys(state.objectives).find((k) => state.objectives[k].some((o) => o.id === id));
  const inThread = thread ? Object.values(state.experiments).find((x) => x.objective.thread === thread) : undefined;
  const pick = pickQ && pickQ !== 'list' ? pickQ : inThread && !pickQ && !projectQ ? 'obj:' + inThread.objective.id : '';
  const project = [pick.startsWith('obj:') ? owner(pick.slice(4)) : '', projectQ, inThread && owner(inThread.objective.id), query.threadProject, state.projects.find((p) => p.projectPath)?.id]
    .find((k) => k && state.objectives[k]) || 'cartpole';
  return { project, pick, tag, missing: !!projectQ && !state.projects.some((p) => p.id === projectQ) };
}

// A real objective's policy is what its cycles actually use: seeds per group from the next plan, the variables its groups have tried,
// and every direction chosen by you (the demo's approval rules are not enforced here).
const WEEKDAYS_UI: readonly { d: number; label: string }[] = [
  { d: 1, label: '周一' },
  { d: 2, label: '周二' },
  { d: 3, label: '周三' },
  { d: 4, label: '周四' },
  { d: 5, label: '周五' },
  { d: 6, label: '周六' },
  { d: 0, label: '周日' },
];

function policyEditorOf(d: Data, nowTs: number) {
  const draft: Data = d.policyDraft || {
    id: '',
    isEdit: false,
    kind: 'weekly',
    days: [1, 2, 3, 4, 5],
    dateFrom: '',
    dateTo: '',
    start: '20:00',
    end: '08:00',
    excludeDays: [],
    excludeFrom: '',
    excludeTo: '',
    calAnchor: nowTs,
    calStep: 'from',
  };
  const kind = String(draft.kind || 'weekly');
  const activeDays: number[] = Array.isArray(draft.days) ? draft.days : [];
  const exDays: number[] = Array.isArray(draft.excludeDays) ? draft.excludeDays : [];
  const anchor = Number(draft.calAnchor) || nowTs;
  const anchorDate = new Date(anchor);
  const monthLabel = `${anchorDate.getFullYear()}年${anchorDate.getMonth() + 1}月`;
  const parseYmdNoon = (ymd: unknown) => (typeof ymd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? new Date(`${ymd}T12:00:00`).getTime() : NaN);
  const fromTs = parseYmdNoon(draft.dateFrom);
  const toTs = parseYmdNoon(draft.dateTo);
  const valueTs = Number.isFinite(fromTs) ? fromTs : nowTs;
  const marks: { at: number }[] = [];
  if (kind === 'range' && Number.isFinite(fromTs) && Number.isFinite(toTs) && toTs >= fromTs) {
    const maxSpan = 62;
    for (let i = 0, cur = fromTs; cur <= toTs && i < maxSpan; i++, cur += 86_400_000) {
      marks.push({ at: cur });
    }
  } else if (kind === 'fixed' && Number.isFinite(fromTs)) {
    marks.push({ at: fromTs });
  }
  const checked = validatePolicy(draft, 'preview');
  const preview = 'policy' in checked ? nextScheduledRuns([checked.policy], nowTs, 3) : [];
  const previewError = 'error' in checked ? checked.error : '';
  return {
    id: draft.id || '',
    isEdit: !!draft.isEdit,
    kind,
    isFixed: kind === 'fixed',
    isDaily: kind === 'daily',
    isWeekly: kind === 'weekly',
    isRange: kind === 'range',
    isContinuous: kind === 'continuous',
    showCalendar: kind === 'fixed' || kind === 'range',
    showWeekdays: kind === 'weekly',
    showDateBounds: kind === 'daily' || kind === 'weekly' || kind === 'continuous',
    showTime: kind !== 'continuous',
    days: WEEKDAYS_UI.map((w) => ({ d: w.d, label: w.label, on: activeDays.includes(w.d) })),
    excludeDays: WEEKDAYS_UI.map((w) => ({ d: w.d, label: w.label, on: exDays.includes(w.d) })),
    dateFrom: draft.dateFrom || '',
    dateTo: draft.dateTo || '',
    start: draft.start || '',
    end: draft.end || '',
    timePresetValue: !draft.start && !draft.end ? 'all' : draft.start === '09:00' && draft.end === '18:00' ? 'day' : draft.start === '20:00' && draft.end === '08:00' ? 'night' : '',
    excludeFrom: draft.excludeFrom || '',
    excludeTo: draft.excludeTo || '',
    hasExclude: exDays.length > 0 || !!(draft.excludeFrom || draft.excludeTo),
    calendar: { anchor, value: valueTs, today: nowTs, mode: 'month', marks, monthLabel },
    rangeHint: kind === 'range'
      ? (draft.dateFrom && draft.dateTo ? `已选区间：${draft.dateFrom} ~ ${draft.dateTo}` : draft.dateFrom ? `已选开始：${draft.dateFrom}，请再点一天作为结束日期` : '在日历上依次点选开始日期和结束日期')
      : (draft.dateFrom ? `已选日期：${draft.dateFrom}` : '在日历上点选执行日期'),
    preview,
    previewError,
  };
}

function policyOf(d: Data, o: Data, nowTs = Date.now()) {
  const windowText = scheduleSummary(d.policy.schedule);
  const maxRuns = d.policy.schedule?.maxRuns ?? null;
  const rawPolicies = policiesOf(d.policy.schedule);
  const policies = rawPolicies.map((p) => {
    const f = formatPolicy(p);
    return { id: p.id, kind: p.kind, title: f.title, sub: f.sub };
  });
  const nextRuns = nextScheduledRuns(rawPolicies, nowTs, 5);
  const schedule = { ...d.policy.schedule, window: windowText, maxRuns, maxRunsValue: maxRuns ? String(maxRuns) : '', maxRunsText: maxRunsText(d.policy.schedule), form: scheduleForm(d.policy.schedule), policies, hasPolicies: policies.length > 0, nextRuns };
  const repair = d.policy.repair ?? REPAIR_DEFAULT;
  const stop = o.stop || {};
  const shared = {
    schedule, repair, repairValue: String(repair), repairText: repairText(repair),
    stopTarget: stop.target || '', stopTargetText: stop.target || '不限制',
    stopRounds: stop.maxCycles || '', stopRoundsValue: stop.maxCycles ? String(stop.maxCycles) : '', stopRoundsText: stop.maxCycles ? `${stop.maxCycles} 个周期` : '不限制',
    stopText: stopText(stop), autoKey: autoKey(d.policy.auto || AUTO.default) || 'default',
    managerId: d.policy.manager?.catId || '', managerName: d.policy.manager?.name || '',
  };
  if (!o.projectPath) return Object.assign({}, d.policy, shared, { autoText: tc('rsi.exp.pol.autoText') });
  const plan = d.upcoming || (d.rounds.length ? d.rounds[d.rounds.length - 1].plan : null), tried: Data = {};
  for (const r of d.rounds) for (const g of r.plan.groups) if (!g.control) for (const [k, v] of Object.entries(g.vars || {})) {
    const value = typeof v === 'string' ? v : JSON.stringify(v);
    if (!(tried[k] ||= []).includes(value)) tried[k].push(value);
  }
  return Object.assign({}, d.policy, shared, { seeds: plan ? plan.seeds.length : d.policy.seeds, vars: Object.entries(tried).map(([name, values]) => ({ name, values })), autoText: tc('rsi.exp.pol.' + (({ default: 'nightBoth', execution: 'nightExecution' } as Data)[autoKey(d.policy.auto || AUTO.default) || 'none'] || 'manual')) });
}

export function viewModel(state: RsiState, view: string, query: Data = {}): any {
  const at = follow(state, query);
  const S: Data = {
    rsiProject: at.project, rsiPick: at.pick || 'obj:cp-converge', rsiPicked: !!at.pick, tag: at.tag,
    rsiTab: query.tab || 'version',
    rsiExpSec: typeof query.expSec === 'string' ? query.expSec : '',
    rsiEditGoal: query.editGoal === '1',
    rsiExecStage: typeof query.execStage === 'string' ? query.execStage : '',
    rsiSelO: query.selO || '', rsiSelE: query.selE || '', rsiSelC: query.selC || '',
    rsiInitStep: typeof query.initStep === 'string' ? query.initStep : '',
    rsiInitRev: typeof query.initRev === 'string' ? query.initRev : '',
    rsiGovFile: typeof query.govFile === 'string' ? query.govFile : '',
    rsiGovDiffMode: query.govDiffMode === 'split' ? 'split' : 'unified',
    rsiTrendMetric: typeof query.trendMetric === 'string' ? query.trendMetric : '',
    rsiOverviewMode: query.overviewMode === 'map' ? 'map' : 'trend',
    rsiOverviewLens: query.overviewLens === 'aspect' ? 'aspect' : 'metric',
    rsiCmpCols: typeof query.cmpCols === 'string' ? query.cmpCols : '',
    rsiCmpMetrics: typeof query.cmpMetrics === 'string' ? query.cmpMetrics : '',
    rsiCmpStats: typeof query.cmpStats === 'string' ? query.cmpStats : '',
    rsiCmpView: typeof query.cmpView === 'string' ? query.cmpView : '',
    dialog: query.dialog,
  };
  if (view === 'doc' && (query.id || query.doc)) S.dialog = { kind: 'rsiDoc', args: { id: query.id || query.doc } };
  if (view === 'cards' && query.objective) S.dialog = { kind: 'rsiCards', args: { objective: query.objective } };
  if (view === 'record' && query.id) S.dialog = { kind: 'rsiRecord', args: { id: query.id, type: query.type, objective: query.objective, cycle: query.cycle } };
  function experimentData(id: string) {
    const d = state.experiments[id];
    if (!d || !objectiveData(state, id)) return null;
    const run = d.rounds.find((r: Data) => r.state === 'running');
    return { ...d, upcoming: run ? run.plan : d.objective.projectPath || d.objective.state === 'ready' ? d.upcoming || null : null };
  }
function rsiProject(): any { return projectOf(state, { projectId: S.rsiProject }); }

function rsiPick(objectives: any): any {
  const leaves = objectives.filter(function (o: any): any { return !objectives.some(function (x: any): any { return x.parent === o.id; }); });
  const i = S.rsiPick.indexOf(':'), k = i < 0 ? S.rsiPick : S.rsiPick.slice(0, i), id = i < 0 ? '' : S.rsiPick.slice(i + 1);
  if (k !== 'obj') return { k: k, id: id };
  const o = leaves.find(function (x: any): any { return x.id === id; }) || leaves[0];
  return o ? { k: 'obj', id: o.id, exp: o.mode === 'exp' } : { k: 'none' };
}

function home(): any {

  const pr = rsiProject(), todo = todoOf(state, { projectId: S.rsiProject }).items, pick = rsiPick(pr.objectives);
  const node = function (o: any): any { const kids = pr.objectives.filter(function (x: any): any { return x.parent === o.id; }); return Object.assign({}, o, { name: clipTitle(o.name, 48, o.id), trigger: timeRange(o.trigger), path: o.id, pickKey: 'obj:' + o.id + S.tag, dir: kids.length > 0, selected: pick.k === 'obj' && pick.id === o.id }); };

  const rank = function (o: any): any { return ({ pending: 0, retired: 2 } as Data)[o.state] != null ? ({ pending: 0, retired: 2 } as Data)[o.state] : 1; };
  const sorted = pr.objectives.map(function (o: any, i: any): any { return { o: o, i: i }; }).sort(function (a: any, b: any): any { return rank(a.o) - rank(b.o) || a.i - b.i; }).map(function (x: any): any { return x.o; });
  const nodes: Data = { '': sorted.filter(function (o: any): any { return !o.parent; }).map(node) };
  sorted.forEach(function (o: any): any { if (o.parent) (nodes[o.parent] = nodes[o.parent] || []).push(node(o)); });
  // A demo project (no project directory) says so; choices carry the conversation tag.
  const projects = state.projects.map(function (p: any): any { return Object.assign({}, p, { choice: p.id + S.tag, name: p.projectPath ? p.name : tc('rsi.demoProject', p.name) }); });
  return { draftAnalysts: state.draft ? state.draft.analysts.map(function (a: any): any { return { id: a.catId, name: a.name }; }) : [], projects: projects, projectId: S.rsiProject, projectChoice: S.rsiProject + S.tag, listKey: 'list' + S.tag, nodes: nodes, pick: pick, hasObjectives: pr.objectives.length > 0,
    exp: !!state.projects.find(function (p: any): any { return p.id === S.rsiProject; })?.exp,
    picked: !!S.rsiPicked && pick.k !== 'none' && (pick.k !== 'obj' || S.rsiPick === 'obj:' + pick.id),
    navs: [{ k: 'caps', selected: pick.k === 'caps' }, { k: 'library', count: rsiDocs().filter(function (doc: any): any { return doc.state === 'pending'; }).length, selected: pick.k === 'library' }, { k: 'cards', count: todo.length, selected: pick.k === 'cards' }]
      .map(function (n: any): any { return Object.assign(n, { pickKey: n.k + S.tag }); }) };
};

function rsiTree(tree: any, rows: any, def: any): any {
  const parts = String(S[tree] || '').split('>'), has = rows.some(function (r: any): any { return r.key === parts[0]; });
  const rowKey = has ? parts[0] : def.row, m = /^c(\d+)\./.exec(parts[1] || '');
  const stepOf = function (c: any): any { return 'c' + c.n + '.' + (c.eval && c.eval !== 'waiting' && c.eval !== 'skipped' ? 'eval' : 'collect'); };
  const out = rows.map(function (r: any, i: any): any {
    const sel = r.key === rowKey, vis = (sel && m && r.cycles.find(function (c: any): any { return c.n === +m[1]; })) || r.cycles[r.cycles.length - 1], steps: Data[] = [];
    if (r.prep) steps.push(Object.assign({ k: 'prep', step: 'prep' }, r.prep));
    if (vis && vis.apply) steps.push({ k: 'apply', n: vis.n, result: vis.apply, step: 'c' + vis.n + '.apply' });
    if (vis && vis.collect) steps.push({ k: 'collect', n: vis.n, live: vis.live, done: vis.done, total: vis.total, step: 'c' + vis.n + '.collect' });
    if (vis && vis.eval) steps.push({ k: 'eval', n: vis.n, result: vis.eval, delta: vis.delta, step: 'c' + vis.n + '.eval' });
    if (vis && vis.discuss) steps.push(Object.assign({ k: 'discuss', n: vis.n, step: 'c' + vis.n + '.discuss' }, vis.discuss));
    if (vis && vis.gov) steps.push({ k: 'gov', result: vis.gov, step: 'c' + vis.n + '.gov' });
    else if (r.gov) steps.push({ k: 'gov', result: r.gov, step: 'gov' });
    return { r: r, sel: sel, steps: steps, pick: r.cycles.length > 1 ? { id: 'rsi-cyc-' + tree + '-' + i, tree: tree, value: r.key + '>' + stepOf(vis), options: r.cycles.map(function (c: any): any { return { v: r.key + '>' + stepOf(c), n: c.n, total: r.cycles.length }; }) } : null };
  });
  const row = out.find(function (x: any): any { return x.sel; });
  const activeStep = row && ([...row.steps].reverse().find(function (x: any): any { return x.result !== 'waiting' && x.result !== 'skipped'; }) || row.steps[row.steps.length - 1]);
  const stepKey = has && row && (parts[1] === 'node' || row.steps.some(function (x: any): any { return x.step === parts[1]; })) ? parts[1] : activeStep ? activeStep.step : 'node';
  return { rowKey: rowKey, stepKey: stepKey, rows: out.map(function (x: any): any {
    return Object.assign({}, x.r.data, { key: x.r.key, parentKey: x.r.parent, selected: x.sel, nodeSelected: x.sel && stepKey === 'node', pick: x.r.key + '>node', cyclePick: x.pick,
      steps: x.steps.map(function (y: any): any { return Object.assign({}, y, { pick: x.r.key + '>' + y.step, selected: x.sel && y.step === stepKey }); }) });
  }) };
}

function objective(): any {
  const pr = rsiProject(), pick = rsiPick(pr.objectives), r = objectiveData(state, pick.id);
  if (!r) return null;
  const o = r.objective, d = r.detail;
  if (o.mode === 'exp' && o.running) return exp();

  if (!o.running) {
    const at = ['analyzing', 'preparing', 'ready'].indexOf(o.state);
    return { id: o.id, name: o.name, state: o.state, setup: ['analyzing', 'preparing', 'ready'].map(function (k: any, i: any): any { return { k: k, done: i < at, on: i === at }; }) };
  }
  const unit = function (id: any): any { return pr.units.find(function (u: any): any { return u.id === id; }) || { id: id, name: id }; };
  const objName = function (id: any): any { return (pr.objectives.find(function (x: any): any { return x.id === id; }) || {}).name; };
  const pointName = function (id: any): any { return (pr.groups.find(function (x: any): any { return x.id === id; }) || {}).name; };
  const key = function (id: any): any { return o.id + '/' + id; };
  const last = d.cycles[d.cycles.length - 1], current = last && (last.decision === 'collecting' || last.decision === 'pending' || last.decision === 'stalled' || last.collecting) ? last : null, t = d.trigger;
  const cardId = Object.keys(d.cards)[0], card = cardId ? d.cards[cardId] : null;

  const ownCycles = function (v: any): any { return d.cycles.filter(function (c: any): any { return c.version === v.id; }); };
  const govOf = function (cs: any): any { const z = cs[cs.length - 1]; return z && (['evolve', 'rollback', 'pending'].indexOf(z.decision) >= 0 || (z.decision === 'stalled' && z.stalledAt === 'gov')) ? z.decision : null; };
  const oTree = rsiTree('rsiSelO', d.versions.map(function (v: any): any {
    const cs = ownCycles(v);
    return { key: key(v.id), parent: v.parent && key(v.parent), gov: govOf(cs),
      cycles: cs.map(function (c: any): any { const live = c === current && c.decision !== 'pending' && c.decision !== 'stalled'; return { n: c.n, collect: true, live: live, eval: live ? null : ['evolve', 'rollback', 'pending'].indexOf(c.decision) >= 0 || (c.decision === 'stalled' && c.stalledAt === 'gov') ? 'proposal' : c.decision }; }),
      data: Object.assign({}, v, { ecChanged: v.kind !== 'candidate' && (function (p: any): any { return !p || p.e !== v.e || p.c !== v.c; })(d.versions.find(function (x: any): any { return x.id === v.parent; })),
        nodeState: v.id === o.running.o ? 'current' : v.kind === 'evolve' ? '' : v.kind, change: (v.change || []).map(function (c: any): any { return Object.assign({ op: 'modify' }, c, { unitName: c.unitName || unit(c.unit).name }); }) }) };
  }), { row: key(o.running.o) });
  const ver = d.versions.find(function (v: any): any { return key(v.id) === oTree.rowKey; }), m = /^c(\d+)\.(\w+)$/.exec(oTree.stepKey);
  const cyc = m ? ownCycles(ver).find(function (c: any): any { return c.n === +m[1]; }) : oTree.stepKey === 'gov' ? ownCycles(ver)[ownCycles(ver).length - 1] : null;
  const isCurrent = cyc && cyc === current;

  const eTree = rsiTree('rsiSelE', d.metrics.versions.map(function (e: any): any {
    const cs = e.evals.map(function (x: any, i: any): any { return { n: i + 1, collect: true, eval: x.kind }; });
    if (e.progress) cs.push({ n: cs.length + 1, collect: true, live: true, eval: null });
    return { key: e.id, parent: e.parent, gov: e.evals.some(function (x: any): any { return x.kind === 'switch'; }) ? 'switch' : null, cycles: cs, data: Object.assign({}, e, { nodeState: e.id === o.running.e ? 'current' : '' }) };
  }), { row: o.running.e });
  const eSel = d.metrics.versions.find(function (e: any): any { return e.id === eTree.rowKey; }), em = /^c(\d+)\.(\w+)$/.exec(eTree.stepKey);
  const eEval = eSel && (em ? eSel.evals[+em[1] - 1] : eTree.stepKey === 'gov' ? eSel.evals.find(function (x: any): any { return x.kind === 'switch'; }) : null);

  const cTree = rsiTree('rsiSelC', d.collection.versions.map(function (c: any): any {
    return { key: c.id, parent: c.parent, gov: c.evals.length ? 'switch' : null, cycles: c.evals.map(function (x: any, i: any): any { return { n: i + 1, eval: x.kind }; }),
      data: Object.assign({}, c, { nodeState: c.id === o.running.c ? 'current' : '', pointNames: c.points.map(pointName) }) };
  }), { row: o.running.c });
  const cSel = d.collection.versions.find(function (c: any): any { return c.id === cTree.rowKey; });

  return {
    id: o.id, name: o.name, state: o.state, statement: d.statement, running: o.running, tab: S.rsiTab, threads: d.threads,
    card: card && Object.assign({}, card, { actions: card.actions.map(function (a: any): any { return Object.assign({}, a, { unitName: unit(a.unit).name, sharedNames: (a.shared || []).map(objName) }); }) }),
    overrides: rsiPolicyOf(r).overrides,

    nowLine: { o: o.running.o, e: o.running.e, c: o.running.c, got: current && current.samples, need: t && t.cur, collecting: !!current && current.decision !== 'pending' && current.decision !== 'stalled',
      pick: current ? 'version|' + key(o.running.o) + '>' + (current.decision === 'pending' || current.stalledAt === 'gov' ? 'gov' : current.decision === 'stalled' ? 'c' + current.n + '.eval' : 'c' + current.n + '.collect') : null },
    versions: oTree.rows, ver: ver, step: m ? m[2] : oTree.stepKey,
    cycle: cyc && Object.assign({}, cyc, { start: cyc.windows[0][0], end: cyc.windows[cyc.windows.length - 1][1], merged: cyc.windows.length > 1 ? cyc.windows.length : 0, current: isCurrent,
      candidate: cyc.candidate && d.versions.find(function (v: any): any { return v.id === cyc.candidate; }) }),
    now: isCurrent && t && {
      groups: [{ k: 'must', items: t.must }, { k: 'any', items: t.any }].map(function (g: any): any { return { k: g.k, items: g.items.map(function (x: any): any { return Object.assign({ pct: Math.round(100 * Math.min(1, x.got / x.need)), met: x.got >= x.need }, x); }) }; }),
      ladder: t.ladder, cur: t.cur, evals: t.evals, live: d.live, awaiting: ver.prediction === 'pending' ? ver.predictions : null,
      metricTriggers: d.metricTriggers.map(function (x: any): any { return Object.assign({ met: x.got >= x.need, pct: Math.round(100 * Math.min(1, x.got / x.need)) }, x); }) },
    metricVersions: eTree.rows, eSel: eSel && Object.assign({}, eSel, { items: eSel.items.map(function (x: any): any { const tr = String(x.trigger || '').split(':'); return Object.assign({}, x, { tk: tr[0], tn: tr[1] }); }) }),
    eStep: em ? em[2] : eTree.stepKey, eEval: eEval, eRefs: eEval && rsiDocs().filter(function (doc: any): any { return (eEval.refs || []).indexOf(doc.id) >= 0; }).map(rsiDoc), eLive: em && !eEval && eSel.progress,

    eLooked: eSel && (eEval ? eEval.looked : d.versions.filter(function (v: any): any { return v.e === eSel.id && v.kind !== 'candidate'; }).map(function (v: any): any { return v.id; })).map(function (id: any): any {
      const v = d.versions.find(function (x: any): any { return x.id === id; }), cs = ownCycles(v), count = function (k: any): any { return cs.filter(function (c: any): any { return c.decision === k; }).length; };
      return { id: id, pick: 'version|' + key(id) + '>node', cycles: cs.length, keep: count('keep') + count('baseline'), insufficient: count('insufficient'), evolve: count('evolve'), rollback: count('rollback'), prediction: v.prediction };
    }),
    eCurrent: eSel && eSel.id === o.running.e,

    traces: S.rsiTab === 'version' && cyc && (m ? m[2] : oTree.stepKey) === 'collect' ? tracesOf(state, { objectiveId: o.id, cycle: cyc.id })
      : S.rsiTab === 'collect' && cSel && cTree.stepKey === 'node' ? tracesOf(state, { objectiveId: o.id, c: cSel.id }) : null,
    runs: (m ? m[2] : oTree.stepKey) === 'gov' && cyc ? runsOf(state, { objectiveId: o.id, cycle: cyc.id }) : null,
    collectVersions: cTree.rows, cSel: cSel && Object.assign({}, cSel, { pointNames: cSel.points.map(pointName) }), cStep: cTree.stepKey === 'node' ? 'node' : cTree.stepKey === 'gov' ? 'gov' : 'eval', cEval: cSel && cSel.evals[0]
  };
};

function rsiExpData(): any { return experimentData(rsiPick(rsiProject().objectives).id); }
const RSI_LAYERS = ['execution', 'harness', 'rubric', 'observation'];
function exp(): any {
  const d = rsiExpData(); if (!d) return null;
  const o = d.objective, main = d.metrics.items.find((m: Data) => !m.guard).id, key = function (v: any): any { return o.id + '/' + v; };
  const nameOf = function (id: any): any {
    const m = d.members.find(function (m: any): any { return m.catId === id; })
      || Object.values<Data>(d.stepMembers || {}).find((x) => x?.catId === id);
    return m ? m.name : id;
  };
  const memberName = function (role: any): any { return nameOf((d.members.find(function (m: any): any { return m.role === role; }) || {}).catId); };
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) ? short(x) : null;
  // A cycle's metrics are the scale it ran with; the first that is not a guardrail is its main metric.
  const mainOf = (r: Data) => roundMetrics(d, r).items.find((m: Data) => !m.guard);
  // A cycle whose analysts are still proposing is not yet waiting for the decision.
  const waiting = function (r: any): any { return !!r.report && !r.decision && r.state === 'done' && !(r.analysis && r.analysis.waiting.length); };
  const tested = d.rounds.map(function (r: any): any { return Object.assign({}, r, { version: testedVersion(r.plan) }); });
  const rounds = tested.filter(function (r: any): any { return r.state !== 'planned'; }).map(function (r: any): any { return Object.assign({}, r, { k: tested.filter(function (x: any): any { return x.version === r.version && x.n <= r.n; }).length }); });
  const dirOf = function (r: any): any { return r.decision && r.decision.directionId && r.report && r.report.directions.find(function (x: any): any { return x.id === r.decision.directionId; }); };
  const govOf = function (r: any): any {
    if (r.state === 'repairing') return 'repairing';
    if (r.state === 'repaired') return 'execution';
    const x = dirOf(r);
    return waiting(r) ? 'pending' : !r.decision ? null : x ? (x.kind === 'code' ? (r.report.verdict === 'rollback' ? 'rollback' : 'evolve') : x.kind) : r.decision.pick;
  };
  const repairDecisionOf = function (r: Data) {
    if (r.decision || (r.state !== 'repaired' && r.state !== 'repairing')) return r.decision || null;
    const ask = d.versionRequest && d.versionRequest.cycle === r.n ? d.versionRequest : null;
    const rec = (d.repairs || []).find((x: Data) => x.cycle === r.n);
    const nextVer = r.repairedBy ? d.versions.find((v: Data) => v.id === r.repairedBy) : null;
    const firstErr = r.runs.find((u: Data) => u.error)?.error?.raw;
    const sig = rec?.signature || ask?.repair?.signature || (firstErr ? String(firstErr).trim().split('\n')[0] : '');
    const note = [
      sig ? `${r.version} 版本运行失败：${sig}` : `${r.version} 版本运行失败`,
      nextVer?.change ? `修复为 ${nextVer.id}：${nextVer.change}` : '',
    ].filter(Boolean).join('；');
    return { pick: r.state === 'repaired' ? 'repair' : 'repairing', by: 'RSI', at: rec?.at || nextVer?.at || ask?.since || r.end || null, note };
  };
  const sel = (x: Data, step: string) => key(x.version) + '>c' + x.k + '.' + step;
  const fmtDuration = (ms: number | null) => {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
    const hr = Math.floor(m / 60), rm = m % 60;
    return rm ? `${hr}h ${rm}m` : `${hr}h`;
  };
  const renderRunCommand = (r: Data, g: Data, u: Data) => {
    const tpl = d.executor?.commands?.submit;
    if (typeof tpl !== 'string' || !tpl.trim()) return '';
    const dir = u.directory || (o.projectPath ? `${o.projectPath}/runs/${o.id}/${r.n}/${g.id}-s${u.seed}` : `runs/${o.id}/${r.n}/${g.id}-s${u.seed}`);
    const cfg = `${dir}/config.json`;
    const vals: Record<string, string> = { config: cfg, run: dir, seed: String(u.seed ?? ''), job: String(u.jobId || ''), start: String(u.start || ''), end: String(u.end || '') };
    return tpl.replace(/\{(config|run|seed|job|start|end)\}/g, (_, k: string) => {
      const v = vals[k] ?? '';
      return /\s/.test(v) ? `'${v}'` : v;
    });
  };
  const metricValueInRound = (x: Data, metricId: string, dir: string) => {
    if (!x.report?.matrix) return null;
    const testedGroups = x.plan.groups.filter((g: Data) => g.version === x.version);
    const preferred = testedGroups.filter((g: Data) => !g.control);
    const pool = preferred.length ? preferred : testedGroups;
    const eligibleIds = new Set((x.report.compare?.groups || []).filter((g: Data) => g.eligible).map((g: Data) => g.group));
    const cells = x.report.matrix.filter((c: Data) => c.metric === metricId && typeof c.mean === 'number' && Number.isFinite(c.mean) && pool.some((g: Data) => g.id === c.group));
    if (!cells.length) return null;
    const eligibleCells = cells.filter((c: Data) => eligibleIds.has(c.group));
    const pickFrom = eligibleCells.length ? eligibleCells : cells;
    pickFrom.sort((a: Data, b: Data) => dir === 'down' ? a.mean - b.mean : b.mean - a.mean);
    return pickFrom[0];
  };
  const allMetricDefs: Data[] = Array.isArray(d.metrics?.items) ? d.metrics.items : [];
  const orderedMetricDefs = [
    ...allMetricDefs.filter((m: Data) => m.id === main),
    ...allMetricDefs.filter((m: Data) => m.guard && m.id !== main),
    ...allMetricDefs.filter((m: Data) => !m.guard && m.id !== main),
  ];
  const trendSeries = orderedMetricDefs.map((m: Data) => {
    const points = rounds.map((x: Data) => {
      const cell = metricValueInRound(x, m.id, m.dir);
      if (!cell) return null;
      return { n: x.k, cycle: x.n, version: x.version, label: `${x.version}-${x.k}`, value: Number(cell.mean.toPrecision(4)) };
    }).filter(Boolean);
    return {
      id: m.id,
      name: m.name,
      role: m.id === main ? 'main' : m.guard ? 'guard' : 'other',
      dir: m.dir || 'up',
      unit: m.unit || '',
      threshold: m.guard && typeof m.threshold === 'number' ? m.threshold : null,
      points,
    };
  }).filter((s: Data) => s.points.length > 0);
  const activeTrendSeries = trendSeries.find((s: Data) => s.id === S.rsiTrendMetric) || trendSeries.find((s: Data) => s.id === main) || trendSeries[0] || null;
  const activeTrendId = activeTrendSeries?.id || main;
  const trendOptions = trendSeries.map((s: Data) => ({ v: s.id, label: `${s.name}${s.role === 'main' ? '（主指标）' : s.role === 'guard' ? '（护栏）' : ''}` }));
  // A concluded cycle's numbers, from the comparison stored with its report (cycles.ts comparison): a block per metric — the main one, then
  // the guardrails, then the rest — and in it a row per group, the control first: mean and sample SD over the seeds, the difference from the
  // same cycle's control, better or worse by the metric's direction, and on a guardrail whether every seed kept to it.
  const leadDeltaOf = function (r: Data): string | null {
    const report = r.report, lead = mainOf(r);
    if (!report?.matrix || !lead) return null;
    const groups = r.plan.groups || [], control = groups.find((g: Data) => g.control);
    if (!control) return null;
    const cell = (g: string) => report.matrix.find((c: Data) => c.group === g && c.metric === lead.id);
    const judged = (g: string) => report.compare?.groups?.find((x: Data) => x.group === g);
    const winners = groups.filter((g: Data) => judged(g.id)?.beatsControl).sort((a: Data, b: Data) => lead.dir === 'down' ? (cell(a.id)?.mean ?? 0) - (cell(b.id)?.mean ?? 0) : (cell(b.id)?.mean ?? 0) - (cell(a.id)?.mean ?? 0));
    if (!winners.length) return null;
    const c = cell(winners[0].id), base = cell(control.id);
    if (typeof c?.mean !== 'number' || typeof base?.mean !== 'number') return null;
    const delta = c.mean - base.mean;
    return delta ? signed(delta) : '0';
  };
  const compareOf = function (r: Data) {
    const report = r.report, items = roundMetrics(d, r).items, lead = mainOf(r);
    const groups = [...r.plan.groups.filter((g: Data) => g.control), ...r.plan.groups.filter((g: Data) => !g.control)], control = groups.find((g: Data) => g.control);
    const cell = (g: string, m: string) => report.matrix.find((c: Data) => c.group === g && c.metric === m), judged = (g: string) => report.compare.groups?.find((x: Data) => x.group === g);
    const row = (g: Data, m: Data) => {
      const c = cell(g.id, m.id), base = control && !g.control ? cell(control.id, m.id) : null, j = judged(g.id);
      const delta = typeof c?.mean === 'number' && typeof base?.mean === 'number' ? c.mean - base.mean : null;
      const checks = m.guard && j ? j.guardrails.filter((x: Data) => x.metric === m.id) : [], crossed = checks.filter((x: Data) => !x.pass).map((x: Data) => x.seed);
      return { key: m.id + '/' + g.id, id: g.id, label: g.label, version: g.version, control: !!g.control, confirm: !!g.confirm, mean: num(c?.mean), sd: num(c?.sd), n: c ? c.n : 0, partial: !!c && c.n > 0 && c.n < r.plan.seeds.length,
        delta: delta === null ? null : delta ? signed(delta) : '0', better: delta === null ? '' : delta === 0 ? 'same' : (delta > 0) === (m.dir === 'up') ? 'better' : 'worse',
        guard: checks.length ? (crossed.length ? 'fail' : 'pass') : '', crossed,
        // The main metric decides: a group beats the control, does not, or does not count (its runs or the control's did not all finish, or it crossed a guardrail).
        standing: m === lead && j && !g.control ? (j.beatsControl ? 'beats' : j.eligible ? 'below' : !report.compare.comparable ? 'control' : j.guardrails.some((x: Data) => !x.pass) ? 'guard' : 'runs') : '',
        seeds: c?.seeds?.map((s: Data) => {
          const hasVal = typeof s.value === 'number' && Number.isFinite(s.value);
          const seedState = crossed.includes(s.seed) ? 'cross'
            : hasVal && s.state === 'done' ? ''
            : s.error ? (s.error.kind === 'env' ? 'env' : 'failed')
            : s.state === 'done' ? '' : 'failed';
          return { seed: s.seed, value: num(s.value), state: seedState };
        }) };
    };
    const conf = report.confirmation, mean = (g: Data) => cell(g.id, lead.id)?.mean;
    const winners = groups.filter((g: Data) => judged(g.id)?.beatsControl).sort((a: Data, b: Data) => lead.dir === 'down' ? mean(a) - mean(b) : mean(b) - mean(a));
    const metrics = [lead, ...items.filter((m: Data) => m.guard), ...items.filter((m: Data) => m !== lead && !m.guard)].map((m: Data) => ({ id: m.id, name: m.name, role: m === lead ? 'main' : m.guard ? 'guard' : 'other', dir: m.dir,
      rule: m !== lead ? '' : m.margin !== undefined ? 'margin' : m.minDelta ? 'minDelta' : '', ruleValue: m.margin ?? m.minDelta, limit: m.guard && typeof m.threshold === 'number' ? m.dir : '', threshold: m.threshold,
      items: groups.map((g: Data) => row(g, m)) }));
    const seriesIds = new Set(trendSeries.map((s: Data) => s.id));
    const table = buildComparisonTable(d, r, rounds, {
      activeTrendId,
      seriesIds,
      cmpCols: S.rsiCmpCols,
      cmpMetrics: S.rsiCmpMetrics,
      cmpStats: S.rsiCmpStats,
      cmpView: S.rsiCmpView,
    });
    return { seeds: r.plan.seeds.length, single: r.plan.seeds.length === 1, metrics, table, group: conf?.group, version: conf?.version,
      result: conf ? conf.status : !report.compare.groups ? '' : groups.length < 2 ? 'baseline' : !report.compare.comparable ? 'incomparable' : 'none',
      // The difference the stepper shows: that of the best group that beats the control; none when no group does.
      lead: winners.length ? metrics[0].items.find((x: Data) => x.id === winners[0].id)!.delta : null };
  };
  // A member as the Host draws one (who): its name among this objective's members, any role; else the Host's name for it, else its id.
  const memberOf = (id: string) => ({ kind: 'member', catId: id, name: d.members.find((m: Data) => m.catId === id)?.name });
  // A cycle's discussion (cycles.ts conclude, propose, finishAnalysis): the directions by member, in the order they first proposed, a member's
  // exact repeats shown once (the same title and kind, as when the evaluator is also a discussion member: the copy that says more, with the
  // citations of both); a member's first direction is their 首选. When two or more discussion members proposed, the conclusion's rule
  // (report.agree) said whether their 首选 agree; here only where they differ.
  const discussionOf = function (r: Data) {
    const dirs = r.report.directions, asked = r.analysis, still: string[] = asked ? asked.waiting : [], late: string[] = asked && asked.missing || [];
    if (!dirs.length && !asked) return null;
    const analysts = analystsOf(d), evaluator = d.members.find((m: Data) => m.role === 'evaluate')?.catId, picked = (x: Data) => !!r.decision && r.decision.directionId === x.id, members: Data[] = [];
    const says = (x: Data) => [x.cites.length, x.target, x.expect, x.predict].filter(Boolean).length;
    for (const x of dirs) {
      let m = members.find((y) => y.id === x.by);
      if (!m) members.push(m = { id: x.by, name: nameOf(x.by), model: x.model, evaluator: x.by === evaluator, analyst: analysts.some((a) => a.catId === x.by), items: [] });
      const at = m.items.findIndex((y: Data) => y.title === x.title && y.kind === x.kind), y = m.items[at];
      if (at < 0) m.items.push(Object.assign({}, x, { picked: picked(x), first: !m.items.length }));
      else m.items[at] = Object.assign({}, says(x) > says(y) ? x : y, { cites: [...new Set([...y.cites, ...x.cites])], picked: y.picked || picked(x), first: y.first });
    }
    // The 首选 the rule compares: the first direction of each discussion member who proposed.
    const firsts = asked ? analysts.filter((a) => !still.includes(a.catId) && !late.includes(a.catId)).map((a) => dirs.find((x: Data) => x.by === a.catId)).filter(Boolean) : [];
    const kinds = new Set(firsts.map((x: Data) => x.kind || '')), targets = new Set(firsts.map((x: Data) => x.target || ''));
    return { status: still.length ? 'proposing' : firsts.length > 1 ? (r.report.agree ? 'agree' : 'split') : 'count',
      resolved: !!r.decision,
      differ: firsts.length < 2 ? '' : kinds.size > 1 && !kinds.has('') ? 'kind' : kinds.has('') || targets.has('') ? 'untargeted' : targets.size > 1 ? 'target'
        : new Set(firsts.map((x: Data) => JSON.stringify(x.predict || null))).size > 1 ? 'effect' : 'same',
      kind: firsts[0]?.kind, target: firsts[0]?.target, done: firsts.length, asked: firsts.length + still.length + late.length, waiting: still.map(memberOf), missing: late.map(memberOf),
      count: members.reduce((n, m) => n + m.items.length, 0), firsts: members.map((m) => m.items[0]),
      members: members.map((m) => Object.assign(m, { role: m.evaluator && m.analyst ? 'both' : m.evaluator ? 'evaluate' : m.analyst ? 'analyze' : 'other' })) };
  };
  // What deciding a cycle does (actions.ts expDecide, cycles.ts requestVersion): while it waits, what the choice is; once decided, what was
  // chosen, by whom, and what came of it — the version being made for it, the next cycle, or the objective's end.
  const govFor = function (r: Data) {
    const disc = r.report ? discussionOf(r) : null, later = rounds.find((x: Data) => x.n > r.n), ask = d.versionRequest && d.versionRequest.cycle === r.n ? d.versionRequest : null;
    const decision = repairDecisionOf(r);
    const nextVer = r.repairedBy ? d.versions.find((v: Data) => v.id === r.repairedBy) : (later ? d.versions.find((v: Data) => v.id === later.version) : null);
    const rawChanges = r.govChanges || nextVer?.changes || (r.decision?.pick === 'direction' && d.versions.find((v: Data) => v.parent === r.version && v.at >= (r.decision.at || 0))?.changes) || null;
    const pr = rawChanges?.pr || (nextVer?.pr ? { id: nextVer.pr } : null);
    const changeItems = (rawChanges?.items || []).map((it: Data, idx: number) => ({
      key: `${it.op || 'set'}:${it.name}:${idx}`,
      op: it.op || 'set',
      name: it.name,
      from: it.from ?? '',
      to: it.to ?? '',
      detail: it.op === 'add' ? `+ ${it.to ?? ''}` : it.op === 'del' ? `- ${it.from ?? ''}` : `${it.from ?? ''} → ${it.to ?? ''}`,
    }));
    const diffFiles = (rawChanges?.files || []).map((f: Data) => {
      const added = typeof f.added === 'number' ? f.added : null;
      const removed = typeof f.removed === 'number' ? f.removed : null;
      const stats = [added != null ? `+${added}` : '', removed != null ? `-${removed}` : ''].filter(Boolean).join(' ');
      return {
        path: f.path,
        op: f.op || 'modify',
        added,
        removed,
        stats,
        selected: S.rsiGovFile === f.path,
        hunks: Array.isArray(f.hunks) ? f.hunks : [],
      };
    });
    const selectedFile = diffFiles.find((f: Data) => f.path === S.rsiGovFile) || null;
    const hasDetails = !!(pr || changeItems.length || diffFiles.length);
    return { ask: !waiting(r) ? '' : d.candidate ? 'confirm' : !r.report.directions.length ? 'empty' : ['split', 'agree'].includes(disc!.status) ? disc!.status : 'choose',
      choices: !waiting(r) ? [] : d.candidate ? [{ k: 'same' }] : [{ k: 'same' }, { k: 'note' }], candidate: d.candidate && { group: d.candidate.id, version: d.candidate.version }, current: o.currentVersion, iterate: memberName('iterate'),
      discuss: disc && sel(r, 'discuss'), adopted: dirOf(r) || null,
      pr, changeItems, diffFiles, selectedFile, diffMode: S.rsiGovDiffMode, hasDetails,
      led: !decision ? null : ask ? { k: 'version', title: ask.title } : later ? { k: 'cycle', n: later.k, version: later.version, go: sel(later, later.report ? 'eval' : 'collect') }
        : o.stopReason && o.stopReason.cycle === r.n ? { k: 'stop', text: o.stopReason.text } : { k: 'later' } };
  };
  const focus = o.projectPath && rounds.find((r: Data) => waiting(r) || r.analysis?.waiting.length || ['running', 'evaluating', 'repairing'].includes(r.state));
  const hasAnalysts = d.members.some((m: Data) => m.role === 'analyze' && m.catId);
  const evalStateOf = (r: Data) => r.report ? 'done' : r.state === 'evaluating' ? 'pending' : (r.state === 'repaired' || r.state === 'repairing') ? 'skipped' : 'waiting';
  const discussStateOf = (r: Data) => {
    const disc = r.report ? discussionOf(r) : null;
    if (disc) return disc.status;
    return (!hasAnalysts || r.state === 'repaired' || r.state === 'repairing') ? 'skipped' : 'waiting';
  };
  const evalMetricsOf = (r: Data) => {
    const m = roundMetrics(d, r);
    return {
      version: m.version,
      items: (m.items || []).map((it: Data) => Object.assign({}, it, {
        line: it.line || (it.guard && typeof it.threshold === 'number' ? `${it.dir === 'up' ? '≥' : '≤'} ${it.threshold}${it.unit ? ' ' + it.unit : ''}` : ''),
      })),
    };
  };
  const findTriggerRound = (v: Data, verRounds: Data[]) => {
    const repairedFrom = rounds.find((x: Data) => x.repairedBy === v.id);
    if (repairedFrom) return { round: repairedFrom, repair: true };
    if (verRounds.length) {
      const firstN = verRounds[0].n;
      const prior = rounds.filter((x: Data) => x.n < firstN && (x.decision || x.state === 'repaired'));
      if (prior.length) return { round: prior[prior.length - 1], repair: false };
    }
    const decided = rounds.filter((x: Data) => x.decision && (!v.at || !x.decision.at || x.decision.at <= v.at + 60_000));
    return decided.length ? { round: decided[decided.length - 1], repair: false } : null;
  };
  const aspectsOfVersion = (v: Data, verRounds: Data[]) => {
    if (v.preparing) return { kind: v.direct ? 'derived' : 'unlabeled', aspects: v.direct ? ['observability'] : [] };
    if (!v.parent) return { kind: 'baseline', aspects: [] as string[] };
    if (Array.isArray(v.aspects) && v.aspects.length) {
      const declared = ['object', 'observability', 'rubric'].filter((k) => v.aspects.includes(k));
      if (declared.length) return { kind: 'declared', aspects: declared };
    }
    const set = new Set<string>();
    const trig = findTriggerRound(v, verRounds);
    const parentRounds = rounds.filter((x: Data) => x.version === v.parent);
    const parentLast = parentRounds[parentRounds.length - 1];
    const parentMetricVer = parentLast ? roundMetricVersion(d, parentLast) : d.metrics.version;
    const ownMetricVer = verRounds[0] ? roundMetricVersion(d, verRounds[0]) : d.metrics.version;
    if (ownMetricVer && parentMetricVer && ownMetricVer !== parentMetricVer) set.add('rubric');
    if (trig?.repair || v.direct) set.add('observability');
    else if (trig?.round?.decision) {
      const dec = trig.round.decision;
      const dir = dirOf(trig.round);
      const kind = dir?.kind || '';
      if (kind === 'execution') set.add('observability');
      else if (kind === 'metric' || kind === 'goal' || dec.pick === 'metric' || dec.pick === 'goal') set.add('rubric');
    }
    const derived = ['object', 'observability', 'rubric'].filter((k) => set.has(k));
    return { kind: derived.length ? 'derived' : 'unlabeled', aspects: derived };
  };
  const outcomeOfVersion = (v: Data, verRounds: Data[], isRunningVer: boolean) => {
    if (v.current) return { outcome: 'current', pruned: false, reason: '' };
    if (isRunningVer) return { outcome: 'running', pruned: false, reason: '' };
    if (v.preparing || v.status === 'preparing') return { outcome: 'preparing', pruned: false, reason: '' };
    if (!v.parent) return { outcome: 'baseline', pruned: false, reason: '' };
    if (v.status === 'confirmed') return { outcome: 'confirmed', pruned: false, reason: '' };
    if (v.status === 'candidate') return { outcome: 'candidate', pruned: false, reason: '' };
    const lastR = verRounds[verRounds.length - 1] || null;
    const disposition = v.disposition || lastR?.report?.disposition || '';
    const tagReason = v.tag || lastR?.report?.tag || lastR?.report?.headline || '';
    if (disposition === 'dead_end') return { outcome: 'deadEnd', pruned: true, reason: tagReason };
    if (v.status === 'rejected') return { outcome: 'pruned', pruned: true, reason: tagReason };
    if (!lastR) {
      const queued = Array.isArray(d.upcoming?.groups) && d.upcoming.groups.some((g: Data) => g.version === v.id);
      return { outcome: queued ? 'preparing' : 'proposed', pruned: false, reason: '' };
    }
    if (lastR.state === 'repaired') return { outcome: 'repaired', pruned: false, reason: '' };
    const verdict = lastR.report?.verdict || '';
    if (verdict === 'rollback' || verdict === 'sunset') return { outcome: 'pruned', pruned: true, reason: tagReason };
    if (verdict === 'insufficient') return { outcome: 'insufficient', pruned: false, reason: tagReason };
    if (lastR.report?.compare?.comparable) {
      const candGroups = (lastR.plan?.groups || []).filter((g: Data) => g.version === v.id && !g.control);
      const judged = lastR.report.compare.groups || [];
      const ownJudged = candGroups.map((g: Data) => judged.find((j: Data) => j.group === g.id)).filter(Boolean);
      if (ownJudged.length && ownJudged.every((j: Data) => !j.eligible && Array.isArray(j.guardrails) && j.guardrails.some((g: Data) => g.pass === false || g.crossed === true))) {
        return { outcome: 'guardrail', pruned: true, reason: tagReason };
      }
      if (ownJudged.length && ownJudged.every((j: Data) => j.eligible && !j.beatsControl)) {
        const mItems = roundMetrics(d, lastR).items || [];
        const mDef = mItems.find((m: Data) => m.id === lastR.report.compare.metric) || mItems.find((m: Data) => !m.guard);
        const cmpDir = lastR.report.compare.dir || mDef?.dir || 'up';
        const minDelta = typeof mDef?.minDelta === 'number' && Number.isFinite(mDef.minDelta) && mDef.minDelta > 0 ? mDef.minDelta : 0;
        const ctrlGroup = (lastR.plan?.groups || []).find((g: Data) => g.control);
        const cells = Array.isArray(lastR.report.matrix) ? lastR.report.matrix : [];
        const ctrlCell = ctrlGroup && mDef ? cells.find((c: Data) => c.group === ctrlGroup.id && c.metric === mDef.id) : null;
        const isWorse = ownJudged.every((j: Data) => {
          if (typeof j.delta !== 'number' || !Number.isFinite(j.delta)) return false;
          if (minDelta > 0) return cmpDir === 'up' ? j.delta <= -minDelta : j.delta >= minDelta;
          const candCell = mDef ? cells.find((c: Data) => c.group === j.group && c.metric === mDef.id) : null;
          if (candCell && ctrlCell && typeof candCell.lo === 'number' && typeof candCell.hi === 'number' && typeof ctrlCell.lo === 'number' && typeof ctrlCell.hi === 'number') {
            const overlaps = candCell.lo <= ctrlCell.hi && ctrlCell.lo <= candCell.hi;
            if (overlaps) return false;
          }
          return cmpDir === 'up' ? j.delta < -1e-9 : j.delta > 1e-9;
        });
        return { outcome: isWorse ? 'worse' : 'tied', pruned: false, reason: tagReason };
      }
    }
    return { outcome: 'explored', pruned: false, reason: '' };
  };
  // Single source of truth for versions across the version tree and overview map:
  // when a versionRequest is in flight, project the pending version once and share it everywhere.
  const prepVer: Data | null = d.versionRequest ? (() => {
    const req = d.versionRequest;
    const prepId = `v${d.versions.length + 1}`;
    const trigRound = d.rounds.find((x: Data) => x.n === req.cycle);
    const prepParent = resolveRsiParent(d, trigRound, req.baseVersion, !!req.direct);
    const iterMember = d.members.find((m: Data) => m.role === 'iterate');
    const title = req.title || (req.repair ? `第 ${req.cycle} 周期修复` : '');
    return {
      id: prepId,
      parent: prepParent,
      change: title,
      commit: null,
      at: req.since || null,
      current: false,
      status: 'preparing',
      preparing: true,
      direct: !!req.direct,
      repair: !!req.repair,
      triggerCycle: req.cycle || null,
      triggerVersion: trigRound?.version || prepParent || '',
      ownerName: iterMember?.name || '',
      claimed: !!req.invocationId,
    };
  })() : null;
  const allVersions: Data[] = prepVer ? [...d.versions, prepVer] : d.versions;
  const versionMetaById: Record<string, Data> = {};
  allVersions.forEach((v: Data) => {
    const verRounds = v.preparing ? [] : rounds.filter((x: Data) => x.version === v.id);
    const isRunningVer = !!o.projectPath && verRounds.some((x: Data) => ['running', 'evaluating', 'repairing'].includes(x.state));
    const asp = aspectsOfVersion(v, verRounds);
    const out = outcomeOfVersion(v, verRounds, isRunningVer);
    const lastR = verRounds[verRounds.length - 1] || null;
    const nodeState = v.current ? 'current'
      : isRunningVer ? 'running'
      : out.outcome === 'preparing' ? 'preparing'
      : v.status === 'candidate' ? 'candidate'
      : o.projectPath && ['pruned', 'deadEnd', 'guardrail', 'worse', 'tied', 'confirmed', 'insufficient', 'repaired'].includes(out.outcome) ? out.outcome
      : '';
    versionMetaById[v.id] = {
      aspectKind: asp.kind,
      aspects: asp.aspects,
      outcome: out.outcome,
      pruned: out.pruned,
      pruneReason: out.reason,
      disposition: v.disposition || lastR?.report?.disposition || '',
      tag: v.tag || lastR?.report?.tag || '',
      annotatedBy: v.annotatedBy || '',
      nodeState,
      commitShort: v.commit ? String(v.commit).slice(0, 7) : '',
      metricVersion: lastR ? roundMetricVersion(d, lastR) : d.metrics.version,
      verRounds,
      lastRound: lastR,
      isRunningVer,
    };
  });
  const tree = rsiTree('rsiSelO', allVersions.map(function (v: any): any {
    const meta = versionMetaById[v.id];
    const verRounds = meta.verRounds;
    const prepStep = v.preparing
      ? { result: v.claimed ? 'claimed' : 'unclaimed', owner: v.ownerName || '' }
      : meta.outcome === 'preparing'
        ? { result: 'queued', owner: '' }
        : null;
    return { key: key(v.id), parent: v.parent && key(v.parent), prep: prepStep,
      cycles: verRounds.map(function (r: any): any {
        const live = r.state === 'running', disc = r.report && discussionOf(r), bypassed = r.state === 'repaired' || r.state === 'repairing';
        const hasEnvFail = r.runs.some((u: Data) => u.error && u.error.kind === 'env');
        const applyState = hasEnvFail ? (o.projectPath && r.report && r.report.verdict !== 'insufficient' ? 'concluded' : 'failed') : 'done';
        return { n: r.k, apply: applyState, collect: true, live: live,
          done: live ? r.runs.filter((u: Data) => u.state === 'done' || u.state === 'failed').length : null, total: r.runs.length,
          eval: r.report ? r.report.verdict : evalStateOf(r), delta: r.report && leadDeltaOf(r),
          discuss: disc ? { result: disc.status, resolved: !!r.decision, count: disc.count, done: disc.done, asked: disc.asked, missing: disc.missing.length } : (o.projectPath ? { result: (!hasAnalysts || bypassed) ? 'skipped' : 'waiting', resolved: false, count: 0 } : null),
          gov: govOf(r) || 'waiting' };
      }),
      data: Object.assign({}, v, {
        nodeState: meta.nodeState,
        outcome: meta.outcome,
        aspectKind: meta.aspectKind,
        aspects: meta.aspects,
        pruned: meta.pruned,
        pruneReason: meta.pruneReason,
        commitShort: meta.commitShort,
        metricVersion: meta.metricVersion,
      }) };
  }), { row: key(focus ? focus.version : o.currentVersion) });
  const verRaw = allVersions.find(function (v: any): any { return key(v.id) === tree.rowKey; }), m = /^c(\d+)\.(\w+)$/.exec(tree.stepKey);
  const ver = verRaw ? Object.assign({}, verRaw, {
    nodeState: versionMetaById[verRaw.id]?.nodeState || '',
    outcome: versionMetaById[verRaw.id]?.outcome || '',
    aspectKind: versionMetaById[verRaw.id]?.aspectKind || 'unlabeled',
    aspects: versionMetaById[verRaw.id]?.aspects || [],
    pruned: !!versionMetaById[verRaw.id]?.pruned,
    pruneReason: versionMetaById[verRaw.id]?.pruneReason || '',
    commitShort: versionMetaById[verRaw.id]?.commitShort || '',
    metricVersion: versionMetaById[verRaw.id]?.metricVersion || d.metrics.version,
  }) : null;
  const r = m && ver && rounds.find(function (x: any): any { return x.version === ver.id && x.k === +m[1]; });
  const best = function (x: any): any { return x.report && x.report.matrix.filter(function (y: any): any { return y.metric === main && y.mean != null && (!o.projectPath || x.report.compare.groups?.some((g: Data) => g.group === y.group && g.eligible)) && x.plan.groups.find(function (g: any): any { return g.id === y.group; }).version === x.version; }).sort(function (a: any, b: any): any { return d.metrics.items.find((m: Data) => m.id === main).dir === 'down' ? a.mean - b.mean : b.mean - a.mean; })[0]; };
  const preds = ([] as Data[]).concat.apply([], rounds.map(function (x: any): any { return x.report ? x.report.predictions : []; }));
  const needYou = d.prep.filter(function (i: any): any { return i.neededFrom === 'human' && i.state !== 'confirmed'; }).length;

  const no = function (k: any): any { return d.plan.findIndex(function (p: any): any { return p.k === k; }) + 1; };
  const below = function (k: any): any { const out: any[] = []; (function walk(x: any): any { d.plan.forEach(function (p: any): any { if (p.deps.indexOf(x) >= 0 && out.indexOf(p.k) < 0) { out.push(p.k); walk(p.k); } }); })(k); return out; };
  const stageOf = (state: string) => state === 'confirmed' ? 'done'
    : state === 'preparing' ? 'running'
    : state === 'submitted' || state === 'stale' ? 'pending'
    : ['cancelled', 'failed', 'blocked', 'missing'].includes(state) ? 'error'
    : 'waiting';
  const splitPoints = (raw: unknown): string[] => {
    if (Array.isArray(raw)) return raw.map((x) => String(x || '').trim()).filter(Boolean);
    if (typeof raw !== 'string' || !raw.trim()) return [];
    const lines = raw.split(/\n+/).map((s) => s.replace(/^[\s\-•*\d.)、]+/, '').trim()).filter(Boolean);
    if (lines.length > 1) return lines;
    const bySemi = lines[0].split(/[；;。]+/).map((s) => s.trim()).filter(Boolean);
    return bySemi.length > 1 ? bySemi : lines;
  };
  const rawSteps = d.plan.map(function (p: any, i: any): any {
    const k = p.k, items = d.prep.filter(function (x: any): any { return x.section === k; }).map(function (x: any): any { return Object.assign({}, x, { needYou: x.neededFrom === 'human' && x.state !== 'confirmed', by: x.by && nameOf(x.by) }); });
    const has = function (st: any): any { return items.some(function (x: any): any { return x.state === st; }); }, ex = d.exec && d.exec[k], st = d.steps && d.steps[k];
    const missing = d.steps ? p.deps.filter(function (x: any): any { return !d.steps[x] || d.steps[x].stale; }).map(no) : [];
    const state = ex ? ({ started: 'preparing', cancelled: 'cancelled', failed: 'failed', blocked: 'blocked', missing: 'missing' } as Data)[ex.state] : d.steps && st && st.stale ? 'stale' : d.steps && !st ? (missing.length ? 'waiting' : 'queued')
      : items.every(function (x: any): any { return x.state === 'confirmed'; }) ? 'confirmed' : has('preparing') ? 'preparing' : has('submitted') ? 'submitted' : 'uninvestigated';
    const stage = stageOf(state);
    const ownerMember = stepMemberOf(d, k);
    const hist: Data[] = Array.isArray(d.stepHistory?.[k]) ? d.stepHistory[k] : [];
    const latestRev = st?.rev || (hist.length ? hist[hist.length - 1].rev : 1);
    const revOptions = hist.length > 1
      ? [...hist].reverse().map((h: Data) => ({ v: `${k}:${h.rev}`, rev: h.rev, label: `v${h.rev}${h.rev === latestRev ? '（当前）' : ''}` }))
      : [];
    const pickedMatch = S.rsiInitRev && S.rsiInitRev.startsWith(`${k}:`) ? Number(S.rsiInitRev.slice(k.length + 1)) : null;
    const pickedHist = pickedMatch && pickedMatch !== latestRev ? hist.find((h: Data) => h.rev === pickedMatch) : null;
    const viewItems = pickedHist
      ? (pickedHist.items || []).map((x: Data) => Object.assign({}, x, { needYou: false, by: x.by && nameOf(x.by) }))
      : items;
    const unknownsVal = pickedHist ? pickedHist.unknowns : st && st.unknowns;
    const nextVal = pickedHist ? pickedHist.next : st && st.next;
    return { k: k, i: i + 1, role: p.role, owner: ownerMember?.name || memberName(p.role), ownerCatId: ownerMember?.catId || '', depKeys: [...p.deps], items: viewItems, needCount: items.filter((x: any) => x.needYou).length, by: ex && ex.state === 'started' && nameOf(ex.by), who: ex && nameOf(ex.by), reason: ex && ex.reason || '', unknowns: unknownsVal, next: nextVal,
      unknownList: splitPoints(unknownsVal), nextList: splitPoints(nextVal),
      canRefresh: !!o.projectPath && stage !== 'running' && stage !== 'waiting',
      revOptions, hasHistory: revOptions.length > 1, selectedRev: pickedHist ? `${k}:${pickedHist.rev}` : `${k}:${latestRev}`, viewingOld: !!pickedHist,
      deps: p.deps.map(no).join('、'), waitOn: d.steps && !ex && !st && missing.join('、'), state, stage };
  });
  const showAll = false;
  const leafKeys = d.plan.filter((p: Data) => !d.plan.some((other: Data) => other.deps.includes(p.k))).map((p: Data) => p.k);
  const doneCount = rawSteps.filter((s: Data) => s.stage === 'done').length;
  const readyStage = ['running', 'done', 'paused'].includes(o.state) ? 'done' : o.state === 'ready' ? 'pending' : 'waiting';
  const defaultStep = o.state === 'ready'
    ? { k: 'ready' }
    : rawSteps.find((s: Data) => s.stage === 'error') || rawSteps.find((s: Data) => s.stage === 'pending') || rawSteps.find((s: Data) => s.stage === 'running') || rawSteps.find((s: Data) => s.stage !== 'done') || rawSteps[0];
  const validKeys = new Set([...rawSteps.map((s: Data) => s.k), 'ready']);
  const activeKey = validKeys.has(S.rsiInitStep) ? S.rsiInitStep : defaultStep?.k || '';
  const steps = rawSteps.map((s: Data) => Object.assign({}, s, { selected: s.k === activeKey, visible: s.k === activeKey }));
  const readyNode = {
    k: 'ready',
    i: rawSteps.length + 1,
    terminal: true,
    depKeys: leafKeys,
    stage: readyStage,
    state: readyStage === 'done' ? 'confirmed' : o.state === 'ready' ? 'ready' : 'waiting',
    owner: `${doneCount}/${rawSteps.length}`,
    needCount: o.state === 'ready' ? 1 : 0,
    selected: activeKey === 'ready',
    visible: activeKey === 'ready',
  };
  const dagNodes = [
    ...steps.map((s: Data) => ({ k: s.k, i: s.i, role: s.role, owner: s.owner, depKeys: s.depKeys, stage: s.stage, state: s.state, needCount: s.needCount, selected: s.selected })),
    readyNode,
  ];
  const prepBySec = (sec: string) => d.prep.filter((p: Data) => p.section === sec && p.value);
  const clipLine = (text: unknown, max = 120) => {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  };
  const scopeDecision = (p: Data) => p.decision || p.rec || 'explore';
  const scopeItems = d.prep.filter((p: Data) => p.section === 'scope');
  const mainDef = d.metrics.items.find((m: Data) => !m.guard);
  const guardDefs = d.metrics.items.filter((m: Data) => m.guard);
  const readyOverview = [
    {
      k: 'baseline',
      title: '现状与基线',
      items: [
        ...prepBySec('baseline').slice(0, 4).map((p: Data) => ({ k: p.title, v: clipLine(p.value, 140) })),
      ],
    },
    {
      k: 'goal',
      title: '目标与约束',
      items: [
        ...(o.goal?.statement ? [{ k: '改进目标', v: clipLine(o.goal.statement, 160) }] : []),
        ...(mainDef ? [{ k: '主指标', v: `${mainDef.name}（${mainDef.dir === 'down' ? '越小越好' : '越大越好'}${mainDef.unit ? '，' + mainDef.unit : ''}）` }] : []),
        ...(guardDefs.length ? [{ k: `护栏（${guardDefs.length} 项）`, v: guardDefs.slice(0, 4).map((m: Data) => `${m.name} ${m.dir === 'up' ? '≥' : '≤'} ${m.threshold}${m.unit ? ' ' + m.unit : ''}`).join('；') + (guardDefs.length > 4 ? ` 等 ${guardDefs.length} 项` : '') }] : []),
        { k: '停止条件', v: stopText(o.stop || {}) || '不限制' },
      ],
    },
    {
      k: 'scope',
      title: '改动范围',
      items: [
        { k: '可探索', v: scopeItems.filter((p: Data) => scopeDecision(p) === 'explore').map((p: Data) => p.title).join('、') || '—' },
        { k: '固定不动', v: scopeItems.filter((p: Data) => scopeDecision(p) === 'fixed').map((p: Data) => p.title).join('、') || '—' },
        ...(scopeItems.some((p: Data) => scopeDecision(p) === 'excluded') ? [{ k: '明确排除', v: scopeItems.filter((p: Data) => scopeDecision(p) === 'excluded').map((p: Data) => p.title).join('、') }] : []),
      ],
    },
    {
      k: 'design',
      title: '实验与执行设计',
      items: [
        ...prepBySec('design').slice(0, 3).map((p: Data) => ({ k: p.title, v: clipLine(p.value, 140) })),
        ...(d.executor?.mcp ? [{ k: '执行器', v: `${d.executor.mcp}（${d.executor.state === 'passed' ? '试跑通过' : d.executor.state}）` }] : []),
        ...prepBySec('feedback').slice(0, 2).map((p: Data) => ({ k: p.title, v: clipLine(p.value, 140) })),
      ],
    },
  ].filter((card) => card.items.length > 0);
  const readyInfo = {
    selected: readyNode.visible,
    stage: readyStage,
    state: o.state,
    doneCount,
    totalCount: rawSteps.length,
    remaining: rawSteps.filter((s: Data) => s.stage !== 'done').map((s: Data) => s.i).join('、'),
    schedule: scheduleSummary(d.policy.schedule),
    maxRunsText: maxRunsText(d.policy.schedule),
    executorState: d.executor.state,
    canStart: o.state === 'ready',
    waitingFirstRun: o.state === 'ready' && rounds.length === 0,
    canTriggerNow: !!o.projectPath && d.executor.state === 'passed' && ['ready', 'running', 'pending'].includes(o.state) && prepSettled(d) && !d.versionRequest && !d.rounds.some((x: Data) => ['running', 'evaluating'].includes(x.state)),
    overview: readyOverview,
  };
  const at = function (x: any, step: any): any { return 'version|' + sel(x, step); };
  const wait = rounds.find(waiting), run = rounds.find(function (x: any): any { return x.state === 'running'; }), ev = rounds.find(function (x: any): any { return x.state === 'evaluating'; }), halted = rounds.find(function (x: any): any { return x.state === 'interrupted'; }), an = rounds.find(function (x: any): any { return x.analysis && x.analysis.waiting.length; });
  const doing = steps.filter(function (x: any): any { return x.state === 'preparing'; }), cut = steps.find(function (x: any): any { return x.state === 'cancelled'; }), stale = steps.filter(function (x: any): any { return x.state === 'stale'; }).length;

  const first = steps.filter(function (x: any): any { return x.items.some(function (y: any): any { return y.needYou; }); }).map(function (x: any): any { return { i: x.i, n: below(x.k).length }; }).sort(function (a: any, b: any): any { return b.n - a.n; })[0];
  const hint = first && first.n ? tc('rsi.exp.firstOf', first.i, first.n) : '';
  const next = o.state === 'done' ? { k: 'done', v: o.stopReason?.text ? `（${o.stopReason.text}）` : '', stop: (d.prep.find(function (p: any): any { return p.section === 'goal' && p.id.endsWith('-stop'); }) || {}).id } : o.state === 'paused' ? { k: 'paused' } : wait ? { k: 'decide', v: wait.version, n: wait.k, go: at(wait, 'gov') } : run ? { k: 'running', v: run.version, n: run.k, go: at(run, 'collect') }
    : ev ? { k: 'evaluating', v: ev.version, n: ev.k, by: memberName('evaluate'), go: at(ev, 'collect') }
    : an ? { k: 'analyzing', v: an.version, n: an.k, by: an.analysis.waiting.map(nameOf).join('、'), go: at(an, 'discuss') }
    : halted ? { k: halted.autoResumed ? 'interrupted' : 'resuming', v: halted.version, n: halted.k, go: at(halted, 'collect') }
    : cut ? { k: 'cancelled', n: cut.i, by: cut.who } : doing.length ? { k: 'init', by: doing.map(function (x: any): any { return { who: x.who, i: x.i, k: x.k }; }), hint: hint }
    : o.state === 'ready' ? { k: 'ready' } : stale ? { k: 'stale', count: stale } : needYou ? { k: 'prep', count: needYou, hint: hint }
    : d.versionRequest ? (d.versionRequest.repair ? { k: 'repair', v: d.versionRequest.cycle, by: memberName('iterate') } : { k: 'version', v: d.versionRequest.title, by: memberName('iterate') })
    : d.executor.state !== 'passed' ? { k: 'executor' } : { k: 'planned', window: scheduleSummary(d.policy.schedule) };

  const cur = d.versions.find(function (v: any): any { return v.current; }), rules = steps.find(function (x: any): any { return x.k === 'rules'; }), ruled = ['submitted', 'confirmed', 'stale'].indexOf(rules.state) >= 0;
  const now = { version: cur.id, change: cur.change, when: run ? 'running' : o.state === 'running' ? 'soon' : o.state, window: scheduleSummary(d.policy.schedule), v: run && run.version, n: run && run.k,
    plan: d.upcoming && { groups: d.upcoming.groups.map(function (g: any): any { return g.label; }).join('、'), seeds: d.upcoming.seeds.length },
    exec: d.executor.state === 'passed' ? d.executor.mcp : null, metrics: ruled ? d.metrics.items.map(function (x: any): any { return x.name + (x.line ? ' ' + x.line : ''); }).join('；') : null, e: d.metrics.version };
  const configObjOf = (g: Data) => {
    const v = d.versions.find((x: Data) => x.id === g.version);
    const vCfg = v && v.config && typeof v.config === 'object' && !Array.isArray(v.config) ? v.config : {};
    const vVars = v && v.vars && typeof v.vars === 'object' && !Array.isArray(v.vars) ? v.vars : {};
    const gVars = g && g.vars && typeof g.vars === 'object' && !Array.isArray(g.vars) ? g.vars : {};
    return Object.assign({}, vCfg, vVars, gVars);
  };
  const formatVal = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  const enrichRun = (x: Data, g: Data, u: Data, idx: number) => {
    const v = d.versions.find((y: Data) => y.id === g.version);
    const durMs = u.start ? (u.end || Date.now()) - u.start : null;
    const durSec = durMs != null ? Math.round(durMs / 1000) : null;
    const commitRaw = u.env?.commit || v?.commit || '';
    const commitShort = commitRaw ? String(commitRaw).slice(0, 7) : '';
    const attemptsList: Data[] = Array.isArray(u.attempts) ? u.attempts : [];
    const attemptsText = attemptsList.length > 1
      ? attemptsList.map((a: Data, i: number) => {
          const aDur = a.start && a.end ? fmtDuration(a.end - a.start) : '';
          const aErr = a.error?.raw ? `: ${clipLine(a.error.raw, 48)}` : '';
          return `#${i + 1} ${a.state || 'unknown'}${a.jobId ? ` (${a.jobId})` : ''}${aDur ? ` ${aDur}` : ''}${aErr}`;
        }).join('；')
      : '';
    const { attempts: _dropAttempts, slices: _dropSlices, ...runRest } = u;
    return Object.assign({}, runRest, {
      roundNo: idx + 1,
      roundTitle: `第 ${idx + 1} 轮`,
      seedText: `seed ${u.seed}`,
      value: num(u.metrics?.[mainOf(x).id]),
      durationSeconds: durSec,
      durationText: u.state === 'running' && durMs != null ? `已跑 ${fmtDuration(durMs)}` : fmtDuration(durMs),
      command: renderRunCommand(x, g, u),
      commitShort,
      jobId: u.jobId || '',
      directory: u.directory || '',
      errorBrief: u.error?.raw ? clipLine(u.error.raw, 120) : '',
      attemptsCount: attemptsList.length,
      attemptsText,
      metricRows: Object.entries(u.metrics || {}).map(([id, value]) => ({ k: d.metrics.items.find((m: Data) => m.id === id)?.name || id, v: value })),
      groupLabel: g.label,
    });
  };
  const groupsOf = function (x: any): any {
    const ctrlGroup = x.plan.groups.find((g: Data) => g.control);
    const ctrlCfg = ctrlGroup ? configObjOf(ctrlGroup) : {};
    const ordered = [...x.plan.groups.filter((g: Data) => g.control), ...x.plan.groups.filter((g: Data) => !g.control)];
    return ordered.map(function (g: any): any {
      const v = d.versions.find((y: Data) => y.id === g.version);
      const runs = x.runs.filter(function (u: any): any { return u.group === g.id; });
      const enrichedRuns = runs.map((u: Data, idx: number) => enrichRun(x, g, u, idx));
      const cfg = configObjOf(g);
      const configEntries = Object.entries(cfg).map(([k, val]) => {
        const textVal = formatVal(val);
        const baseVal = k in ctrlCfg ? formatVal(ctrlCfg[k]) : undefined;
        const changed = !g.control && ctrlGroup ? baseVal !== textVal : false;
        return { k, v: changed && baseVal !== undefined ? `${baseVal} → ${textVal}` : textVal, raw: textVal, changed };
      });
      const diffEntries = configEntries.filter((e) => e.changed);
      const showEntries = diffEntries.length ? diffEntries : configEntries.slice(0, 4);
      const configSummary = showEntries.map((e) => `${e.k}=${e.v}`).join(' · ');
      const rawLabel = String(g.label || g.id);
      const shortTitle = rawLabel.length > 42 ? rawLabel.slice(0, 41) + '…' : rawLabel;
      const sampleCommand = enrichedRuns[0]?.command || renderRunCommand(x, g, { seed: x.plan.seeds?.[0] ?? 0 });
      // A variable may hold an object (reward weights): it reads as JSON.
      return Object.assign({}, g, {
        runListId: `rsi-exp-runs:${x.n}:${g.id}`,
        shortTitle,
        fullDesc: rawLabel,
        versionChange: v?.change || '',
        versionCommit: v?.commit ? String(v.commit).slice(0, 7) : '',
        varsText: Object.entries(g.vars || {}).map(([k, val]) => k + '=' + formatVal(val)).join(' '),
        configEntries,
        configSummary,
        sampleCommand,
        runs: enrichedRuns,
        failed: runs.filter(function (u: any): any { return u.state === 'failed'; }).length,
        runningN: runs.filter(function (u: any): any { return u.state === 'running'; }).length,
        doneN: runs.filter(function (u: any): any { return u.state === 'done' || u.state === 'failed'; }).length,
        total: runs.length,
      });
    });
  };
  const expSection = ['manage', 'execute'].includes(S.rsiExpSec) ? S.rsiExpSec : (rounds.length === 0 ? 'manage' : 'execute');
  const snapshot = {
    version: cur.id,
    change: cur.change,
    metricVersion: d.metrics.version,
    stop: stopText(o.stop || {}),
    rounds: rounds.length,
    window: scheduleSummary(d.policy.schedule),
  };
  const comparisonsOf = (r: Data) => (r.report?.comparisons || []).map((c: Data, idx: number) => ({
    id: c.id || `cmp-${r.n}-${idx + 1}`,
    title: c.title,
    kind: c.kind || 'visual',
    note: c.note || '',
    before: Object.assign({}, c.before, { id: `${c.id || idx}-before`, isMedia: ['image', 'video', 'audio'].includes(c.before?.kind) && !!c.before?.src }),
    after: Object.assign({}, c.after, { id: `${c.id || idx}-after`, isMedia: ['image', 'video', 'audio'].includes(c.after?.kind) && !!c.after?.src }),
  }));
  const stageMember = (role: string) => {
    const m = d.members.find((x: Data) => x.role === role);
    return { role, catId: m?.catId || '', name: m?.name || '', model: m?.model || '' };
  };
  // Execution/governance stage members apply to upcoming & not-yet-reached cycle stages (separate from per-step analysis members).
  const execStages = [stageMember('evaluate'), stageMember('iterate')];
  const discussionList = d.members.filter((m: Data) => m.role === 'analyze' && m.catId).map((m: Data) => ({ id: m.catId, name: m.name }));
  const activeExecStage = ['node', 'apply', 'collect', 'evaluate', 'discuss', 'iterate'].includes(S.rsiExecStage) ? S.rsiExecStage : 'evaluate';
  const execFlowNodes = [
    { k: 'apply', depKeys: [], owner: d.executor.state === 'passed' ? '自动' : '待接通', selected: activeExecStage === 'apply' },
    { k: 'collect', depKeys: ['apply'], owner: d.executor.state === 'passed' ? '执行器' : '待接通', selected: activeExecStage === 'collect' },
    { k: 'evaluate', depKeys: ['collect'], owner: memberName('evaluate') || '未指定', selected: activeExecStage === 'evaluate' },
    { k: 'discuss', depKeys: ['evaluate'], owner: discussionList.length ? `${discussionList.length} 人` : '未指定', selected: activeExecStage === 'discuss' },
    { k: 'iterate', depKeys: ['discuss'], owner: memberName('iterate') || '未指定', selected: activeExecStage === 'iterate' },
  ];
  // Reuse the exact rsiLineage row shape used in Governance & Execution so users see one consistent cycle visual language.
  const execFlowRows = [{
    key: `exec-preview/${cur.id}`,
    parentKey: null,
    id: cur.id,
    nodeState: 'current',
    nodeSelected: activeExecStage === 'node',
    pick: 'node',
    steps: execFlowNodes.map((n) => ({ k: n.k, faint: n.owner, selected: n.selected, pick: n.k })),
  }];
  const evalCatId = (d.members.find((m: Data) => m.role === 'evaluate') || {}).catId || '';
  const iterCatId = (d.members.find((m: Data) => m.role === 'iterate') || {}).catId || '';
  const execFlow = {
    nodes: execFlowNodes,
    rows: execFlowRows,
    selected: {
      k: activeExecStage,
      isNode: activeExecStage === 'node',
      isApply: activeExecStage === 'apply',
      isCollect: activeExecStage === 'collect',
      isAutoStage: activeExecStage === 'apply' || activeExecStage === 'collect',
      isEvaluate: activeExecStage === 'evaluate',
      isDiscuss: activeExecStage === 'discuss',
      isIterate: activeExecStage === 'iterate',
      executorMcp: d.executor.mcp || 'rsi.executor',
      executorState: d.executor.state || 'none',
      evaluateCatId: evalCatId,
      iterateCatId: iterCatId,
      memberStage: (activeExecStage === 'evaluate' || activeExecStage === 'iterate')
        ? { role: activeExecStage, value: activeExecStage === 'evaluate' ? evalCatId : iterCatId }
        : null,
      discussionIds: discussionList.map((m: Data) => m.id),
      discussionText: discussionList.map((m: Data) => m.name).join('、'),
    },
  };
  const goalStatement = o.goal?.statement || o.name || '';
  const goalQuote = goalStatement ? goalStatement.split('\n').map((l: string) => '> ' + l).join('\n') : '';
  const execStatus = {
    started: rounds.length > 0,
    ready: o.state === 'ready',
    doneCount,
    totalCount: rawSteps.length,
    version: cur.id,
    change: cur.change,
    metricVersion: d.metrics.version,
    roundsCount: rounds.length,
    schedule: scheduleSummary(d.policy.schedule),
  };
  const stageOwnersOf = (r: Data) => {
    const evalDone = !!r.report;
    const discussDone = !!r.report && !(r.analysis?.waiting?.length);
    const govDone = !!(r.stageMembers?.gov || ((r.decision || r.state === 'repaired') && !d.versionRequest));
    const evalArchived = r.stageMembers?.eval?.name || (evalDone ? memberName('evaluate') : '');
    const discussArchived = Array.isArray(r.stageMembers?.discuss)
      ? r.stageMembers.discuss.map((m: Data) => m.name).join('、')
      : '';
    const discussLive = d.members.filter((m: Data) => m.role === 'analyze' && m.catId).map((m: Data) => m.name).join('、');
    const govArchived = r.stageMembers?.gov?.name || '';
    return {
      eval: { name: evalDone ? evalArchived : memberName('evaluate'), archived: evalDone },
      discuss: { name: discussDone && discussArchived ? discussArchived : discussLive, archived: discussDone },
      gov: { name: govDone && govArchived ? govArchived : memberName('iterate'), archived: govDone },
    };
  };
  const latestRoundN = rounds.length ? rounds[rounds.length - 1].n : null;
  const stageOfCycle = (r: Data, step: string) => {
    if (!['apply', 'eval', 'discuss', 'gov'].includes(step)) return null;
    const isLatest = r.n === latestRoundN;
    const ownersByRole = (role: string): { id: string; name: string }[] => d.members.filter((m: Data) => m.role === role && m.catId).map((m: Data) => ({ id: m.catId, name: m.name }));
    const archivedDiscuss = Array.isArray(r.stageMembers?.discuss) ? r.stageMembers.discuss.map((m: Data) => ({ id: m.catId, name: m.name })) : [];
    const evalDone = !!r.report;
    const discussDone = !!r.report && !(r.analysis?.waiting?.length);
    const govDone = !!(r.stageMembers?.gov || ((r.decision || r.state === 'repaired') && !d.versionRequest));
    const defs: Record<string, { role: string; multi: boolean; state: string; archived: boolean; owners: { id: string; name: string }[] }> = {
      apply: {
        role: 'prepare', multi: false,
        state: r.runs.some((u: Data) => u.error?.kind === 'env') ? 'failed' : 'done',
        archived: !isLatest,
        owners: r.stageMembers?.apply ? [{ id: r.stageMembers.apply.catId, name: r.stageMembers.apply.name }] : ownersByRole('prepare'),
      },
      eval: {
        role: 'evaluate', multi: false,
        state: evalStateOf(r),
        archived: evalDone,
        owners: evalDone && r.stageMembers?.eval ? [{ id: r.stageMembers.eval.catId, name: r.stageMembers.eval.name }] : ownersByRole('evaluate'),
      },
      discuss: {
        role: 'analyze', multi: true,
        state: discussStateOf(r),
        archived: discussDone,
        owners: (discussDone && archivedDiscuss.length) ? archivedDiscuss : ownersByRole('analyze'),
      },
      gov: {
        role: 'iterate', multi: false,
        state: govOf(r) || 'waiting',
        archived: govDone,
        owners: r.stageMembers?.gov ? [{ id: r.stageMembers.gov.catId, name: r.stageMembers.gov.name }] : ownersByRole('iterate'),
      },
    };
    const s = defs[step];
    const liveOwners = ownersByRole(s.role);
    return {
      cycle: r.n,
      stage: step,
      state: s.state,
      role: s.role,
      multi: s.multi,
      archived: s.archived,
      canEdit: !!o.projectPath && isLatest,
      owners: s.owners,
      ownerNames: s.owners.map((x) => x.name).join('、'),
      value: liveOwners[0]?.id || '',
      values: liveOwners.map((x) => x.id),
    };
  };
  const currentStep = m ? m[2] : tree.stepKey === 'prep' ? 'prep' : 'node';
  const liveNow = Date.now();
  const schedNow = state.now && Math.abs(liveNow - state.now) < 36 * 3_600_000 ? state.now : liveNow;
  const legacyTrend = rounds.filter(best).map(function (x: any): any { return { n: x.k, version: x.version, label: `${x.version}-${x.k}`, value: Number(best(x).mean.toPrecision(4)) }; });
  const activeTrend = activeTrendSeries
    ? Object.assign({}, activeTrendSeries, { points: activeTrendSeries.points.map((pt: Data) => Object.assign({}, pt, { current: !!r && pt.cycle === r.n })) })
    : (legacyTrend.length ? { id: main, name: d.metrics.items.find((m: Data) => m.id === main)?.name || main, role: 'main', dir: d.metrics.items.find((m: Data) => m.id === main)?.dir || 'up', unit: '', threshold: null, points: legacyTrend } : null);
  const cycleGroups = r ? groupsOf(r) : [];
  const cycleRuns = r ? cycleGroups.flatMap((g: Data) => g.runs) : [];
  const activeMetricDef = allMetricDefs.find((x: Data) => x.id === activeTrendId) || allMetricDefs.find((x: Data) => x.id === main) || allMetricDefs[0] || { id: main, name: main, dir: 'up', unit: '', guard: false };
  const valueOfVersionOnMetric = (vId: string, metricId: string, dir: string) => {
    const vrs = versionMetaById[vId]?.verRounds || [];
    for (let i = vrs.length - 1; i >= 0; i--) {
      const cell = metricValueInRound(vrs[i], metricId, dir);
      if (cell && typeof cell.mean === 'number' && Number.isFinite(cell.mean)) {
        return { value: Number(cell.mean.toPrecision(4)), cycle: vrs[i] };
      }
    }
    return null;
  };
  const fmtMetricNum = (val: number | null, unit: string) => val == null ? '—' : `${Number(val.toPrecision(4))}${unit ? ' ' + unit : ''}`;
  const buildCausality = (v: Data, targetRound: Data | null) => {
    if (v.preparing) {
      return {
        triggerKind: v.repair ? 'repair' : 'direction',
        triggerCycle: v.triggerCycle || null,
        triggerVersion: v.triggerVersion || v.parent || '',
        triggerDetail: clipTitle(v.change || '', 72, ''),
        action: v.change || '',
        basisKind: 'preparing',
        basisText: '',
        ownerName: v.ownerName || '',
        claimed: !!v.claimed,
      };
    }
    const trig = findTriggerRound(v, versionMetaById[v.id]?.verRounds || []);
    let triggerKind = !v.parent ? 'baseline' : 'parent';
    let triggerCycle: number | null = null;
    let triggerVersion = v.parent || '';
    let triggerDetail = '';
    if (trig?.repair) {
      triggerKind = 'repair';
      triggerCycle = trig.round.n;
      triggerVersion = trig.round.version;
    } else if (trig?.round?.decision) {
      const dir = dirOf(trig.round);
      triggerCycle = trig.round.n;
      triggerVersion = trig.round.version;
      if (dir?.title) { triggerKind = 'direction'; triggerDetail = clipTitle(dir.title, 72, dir.id); }
      else if (trig.round.decision.note) { triggerKind = 'decision'; triggerDetail = clipTitle(trig.round.decision.note, 72, trig.round.decision.pick); }
      else { triggerKind = 'cycle'; }
    }
    const basisKind = targetRound?.report?.headline ? 'headline' : (targetRound?.state || 'none');
    return {
      triggerKind,
      triggerCycle,
      triggerVersion,
      triggerDetail,
      action: v.change || '',
      basisKind,
      basisText: targetRound?.report?.headline || '',
    };
  };
  const overviewNodes = allVersions.map((v: Data) => {
    const meta = versionMetaById[v.id];
    const lastR = meta.lastRound;
    if (v.preparing) {
      return {
        id: v.id,
        parent: v.parent || null,
        pick: `${key(v.id)}>prep`,
        selected: ver?.id === v.id,
        state: 'preparing',
        preparing: true,
        pruned: false,
        aspectKind: meta.aspectKind,
        aspects: meta.aspects,
        verdict: 'preparing',
        tier: '',
        metricVersion: meta.metricVersion,
        cycleN: v.triggerCycle || null,
        value: null,
        valueText: '—',
        refId: v.parent || null,
        deltaText: '',
        better: '',
        comparable: false,
        commitShort: '',
        ownerName: v.ownerName || '',
        claimed: !!v.claimed,
        repair: !!v.repair,
        changeShort: clipTitle(v.change || '', 30, v.id),
        changeBrief: clipTitle(v.change || '', 120, ''),
        headlineBrief: '',
      };
    }
    const ownVal = valueOfVersionOnMetric(v.id, activeMetricDef.id, activeMetricDef.dir || 'up');
    const val = ownVal ? ownVal.value : null;
    const ownScale = ownVal?.cycle?.metrics?.version || meta.metricVersion;
    const sameCycleCtrl = ownVal?.cycle?.plan?.groups?.find((g: Data) => g.control);
    const sameCycleCtrlCell = sameCycleCtrl && ownVal?.cycle?.report?.matrix
      ? ownVal.cycle.report.matrix.find((c: Data) => c.group === sameCycleCtrl.id && c.metric === activeMetricDef.id && typeof c.mean === 'number' && Number.isFinite(c.mean))
      : null;
    let refId: string | null = null;
    let refVal: number | null = null;
    let comparable = false;
    if (sameCycleCtrlCell && ownVal?.cycle?.report?.compare?.comparable) {
      refId = sameCycleCtrl.version;
      refVal = Number(sameCycleCtrlCell.mean.toPrecision(4));
      comparable = true;
    } else if (v.parent) {
      const parentVal = valueOfVersionOnMetric(v.parent, activeMetricDef.id, activeMetricDef.dir || 'up');
      const parentScale = parentVal?.cycle?.metrics?.version || versionMetaById[v.parent]?.metricVersion;
      if (parentVal && parentScale === ownScale) {
        refId = v.parent;
        refVal = parentVal.value;
        comparable = !!ownVal?.cycle?.report?.compare?.comparable;
      }
    }
    const dir = activeMetricDef.dir || 'up';
    let deltaText = '';
    let better = '';
    if (val != null && refVal != null) {
      const diff = val - refVal;
      deltaText = diff === 0 ? '0' : signed(diff);
      better = diff === 0 ? 'same' : ((diff > 0) === (dir === 'up') ? 'better' : 'worse');
    }
    const tier = lastR?.plan?.tier || (lastR?.plan?.baseline ? 'baseline' : lastR ? 'confirm' : '');
    const pickTarget = lastR ? `${key(v.id)}>c${lastR.k}.${lastR.report ? 'eval' : 'collect'}` : meta.outcome === 'preparing' ? `${key(v.id)}>prep` : `${key(v.id)}>node`;
    return {
      id: v.id,
      parent: v.parent || null,
      pick: pickTarget,
      selected: ver?.id === v.id,
      state: meta.outcome,
      pruned: meta.pruned,
      aspectKind: meta.aspectKind,
      aspects: meta.aspects,
      verdict: lastR?.report?.verdict || (lastR?.state === 'running' ? 'running' : lastR?.state === 'repaired' ? 'repaired' : ''),
      tier,
      metricVersion: ownScale,
      cycleN: lastR?.n || null,
      value: val,
      valueText: fmtMetricNum(val, activeMetricDef.unit || ''),
      refId,
      deltaText,
      better,
      comparable,
      commitShort: meta.commitShort,
      ...(meta.disposition ? { disposition: meta.disposition } : {}),
      ...(meta.tag ? { tag: meta.tag } : {}),
      ...(meta.annotatedBy ? { annotatedBy: meta.annotatedBy } : {}),
      changeShort: clipTitle(v.change || '', 30, v.id),
      changeBrief: clipTitle(v.change || '', 120, ''),
      headlineBrief: lastR?.report?.headline ? clipTitle(lastR.report.headline, 140, '') : '',
    };
  });
  const selectedOverviewDetail = ver ? (() => {
    const meta = versionMetaById[ver.id];
    const lastR = meta?.lastRound || null;
    return {
      id: ver.id,
      causality: buildCausality(ver, lastR),
      receipts: lastR ? lastR.runs.slice(0, 6).map((u: Data) => ({
        seed: u.seed,
        state: u.state,
        jobId: u.jobId || '',
        commit: (u.env?.commit || ver.commit || '').slice(0, 7),
        error: u.error?.raw ? clipTitle(String(u.error.raw), 80, '') : '',
      })) : [],
    };
  })() : null;
  const overviewMap = {
    objectiveId: o.id,
    objectiveName: clipTitle(o.name, 64, o.id),
    currentVersion: o.currentVersion,
    metricVersion: d.metrics.version,
    mode: S.rsiOverviewMode,
    lens: S.rsiOverviewLens,
    metric: {
      id: activeMetricDef.id,
      name: activeMetricDef.name,
      dir: activeMetricDef.dir || 'up',
      unit: activeMetricDef.unit || '',
      threshold: activeMetricDef.guard && typeof activeMetricDef.threshold === 'number' ? activeMetricDef.threshold : null,
      role: activeMetricDef.id === main ? 'main' : activeMetricDef.guard ? 'guard' : 'other',
    },
    selectedVersion: ver?.id || o.currentVersion,
    stats: {
      total: d.versions.length,
      pruned: overviewNodes.filter((n: Data) => n.pruned).length,
      insufficient: overviewNodes.filter((n: Data) => n.state === 'insufficient').length,
      running: overviewNodes.filter((n: Data) => n.state === 'running').length,
      preparing: prepVer ? prepVer.id : (overviewNodes.find((n: Data) => n.state === 'preparing')?.id || null),
      current: o.currentVersion,
    },
    nodes: overviewNodes,
    selectedDetail: selectedOverviewDetail,
  };
  const buildCycleDetailCard = (targetR: Data | null, targetV: Data | null, cmp: Data | null, bodyText: string) => {
    if (!targetR || !targetR.report || !targetV) return null;
    const meta = versionMetaById[targetV.id] || { aspectKind: 'unlabeled', aspects: [], pruned: false, commitShort: '' };
    const mainMetric = cmp?.metrics?.[0] || null;
    const ctrlItem = mainMetric?.items?.find((it: Data) => it.control) || null;
    const candItem = mainMetric?.items?.find((it: Data) => !it.control) || ctrlItem;
    const comparable = !!targetR.report.compare?.comparable && !!ctrlItem && candItem !== ctrlItem;
    const tier = targetR.plan.tier || (targetR.plan.baseline ? 'baseline' : 'confirm');
    const scaleVer = (targetR.metrics || d.metrics).version;
    const guardrailsText = ((targetR.metrics || d.metrics).items || [])
      .filter((it: Data) => it.guard)
      .slice(0, 6)
      .map((it: Data) => `${it.name}${it.threshold != null ? ` (${it.dir === 'up' ? '≥' : '≤'}${it.threshold}${it.unit ? ' ' + it.unit : ''})` : ''}`)
      .join('; ');
    const conditions = [
      { kKey: 'metricVersion', v: scaleVer },
      { kKey: 'tier', vKey: tier },
      { kKey: 'seeds', v: (targetR.plan.seeds || []).join(', '), reserved: (targetR.plan.reservedSeeds || []).join(', ') },
      { kKey: 'control', vKey: targetR.plan.skipControl ? 'skipControl' : (ctrlItem ? 'paired' : 'single'), version: ctrlItem?.version || '' },
      ...(cycleGroups.filter((g: Data) => g.configSummary).map((g: Data) => ({ kKey: 'config', version: g.version, v: g.configSummary }))),
      ...(guardrailsText ? [{ kKey: 'guardrails', v: guardrailsText }] : []),
    ];
    const receipts = cycleRuns.map((u: Data) => ({
      id: u.id,
      seed: u.seed,
      state: u.state,
      commit: u.commitShort || meta.commitShort || '',
      jobId: u.jobId || '',
      duration: u.durationText || '',
      error: u.error?.raw ? clipTitle(String(u.error.raw), 110, '') : '',
    }));
    const trimmedBody = String(bodyText || '').trim();
    return {
      foldId: `${o.id}:${targetR.n}`,
      version: targetV.id,
      cycleN: targetR.n,
      verdict: targetR.report.verdict,
      headline: targetR.report.headline,
      tier,
      metricVersion: scaleVer,
      aspectKind: meta.aspectKind,
      aspects: meta.aspects,
      pruned: meta.pruned,
      main: mainMetric ? {
        name: mainMetric.name,
        value: candItem?.mean ?? '—',
        sd: candItem?.sd ?? null,
        refKind: comparable ? 'paired' : (targetR.plan.skipControl ? 'explore' : 'single'),
        refVersion: comparable ? ctrlItem.version : '',
        refValue: comparable ? ctrlItem.mean : null,
        delta: comparable ? candItem?.delta : null,
        better: comparable ? (candItem?.better || '') : '',
        comparable,
      } : null,
      causality: buildCausality(targetV, targetR),
      conditions,
      body: trimmedBody,
      bodyLength: trimmedBody.length,
      autoFoldBody: trimmedBody.length > 280,
      receipts,
    };
  };
  const cycleCompare = r && r.report ? compareOf(r) : null;
  const cycleBody = r && r.report ? (r.report.summary.startsWith(r.report.headline) ? r.report.summary.slice(r.report.headline.length).trim() : r.report.summary) : '';
  const cycleDetailCard = buildCycleDetailCard(r || null, ver, cycleCompare, cycleBody);
  const collectSummary = r ? (() => {
    const doneOk = cycleRuns.filter((u: Data) => u.state === 'done').length;
    const failedN = cycleRuns.filter((u: Data) => u.state === 'failed').length;
    const runningN = cycleRuns.filter((u: Data) => u.state === 'running').length;
    const totalN = cycleRuns.length;
    const seeds = Array.isArray(r.plan?.seeds) ? r.plan.seeds : [];
    const reserved = Array.isArray(r.plan?.reservedSeeds) ? r.plan.reservedSeeds : [];
    const seedsText = [seeds.join(', '), reserved.length ? `预留 ${reserved.join(', ')}` : ''].filter(Boolean).join(' · ');
    const progParts = [`${doneOk}/${totalN}`];
    if (failedN) progParts.push(`${failedN} 失败`);
    if (runningN) progParts.push(`${runningN} 运行中`);
    return {
      tier: r.plan?.tier || (r.plan?.baseline ? 'baseline' : 'confirm'),
      metricVersion: roundMetricVersion(d, r),
      seedsText,
      progressText: progParts.join(' · '),
      failed: failedN,
      concludedHeadline: failedN > 0 && r.report && r.report.verdict !== 'insufficient' && r.report.headline ? clipLine(r.report.headline, 180) : '',
    };
  })() : null;
  const prepStage = ver && currentStep === 'prep' ? {
    version: ver.id,
    status: ver.preparing ? (ver.claimed ? 'claimed' : 'unclaimed') : 'queued',
    ownerName: ver.ownerName || memberName('iterate') || '',
    parent: ver.parent || '',
    triggerCycle: ver.triggerCycle || null,
    triggerVersion: ver.triggerVersion || ver.parent || '',
    repair: !!ver.repair,
    change: ver.change || '',
    commitShort: ver.commitShort || '',
    at: ver.at || null,
    canWake: !!o.projectPath && !!ver.preparing,
  } : null;
  const slimPrepSteps = expSection === 'execute'
    ? steps.map((s: Data) => s.visible ? s : Object.assign({}, s, { items: [], revOptions: [] }))
    : steps;
  const cycleReportSlim = r?.report ? (() => {
    const { matrix: _dropMatrix, slices: _dropSlices, ...rest } = r.report;
    return rest;
  })() : null;
  const cycleView = r ? (() => {
    const { runs: _dropRawRuns, report: _dropRawReport, metrics: _dropRawMetrics, ...rRest } = r;
    return Object.assign({}, rRest, {
      report: cycleReportSlim,
      versionRound: `${r.version}-${r.k}`,
      canReeval: !!o.projectPath && ['done', 'evaluating'].includes(r.state),
      waiting: waiting(r),
      evaluating: r.state === 'evaluating',
      evalState: evalStateOf(r),
      discussState: discussStateOf(r),
      evalMetrics: evalMetricsOf(r),
      groups: cycleGroups,
      main: mainOf(r),
      stage: stageOfCycle(r, currentStep),
      stageOwners: stageOwnersOf(r),
      runs: cycleRuns,
      collectSummary,
      notAssessed: r.report && RSI_LAYERS.filter(function (l: any): any { return r.report.attribution.assessedLayers.indexOf(l) < 0; }),
      // A conclusion stores a placeholder attribution (no layer assessed): only one that assessed a layer is an attribution.
      attribution: r.report && r.report.attribution.assessedLayers.length ? r.report.attribution : null,
      // The findings after their first line, which is the headline.
      body: cycleBody,
      detailCard: cycleDetailCard,
      comparisons: r.report ? comparisonsOf(r) : [],
      compare: cycleCompare,
      discussion: r.report && discussionOf(r),
      decision: repairDecisionOf(r),
      gov: (r.report || r.state === 'repaired' || r.state === 'repairing') && govFor(r),
    });
  })() : null;
  const closeoutReport = o.state === 'done'
    ? (d.closeoutReport || buildCloseoutReport(d, o.stopReason?.at || Date.now(), o.stopReason?.by || 'RSI'))
    : null;

  // Build real Metrics (E1 -> E2 -> ...) lineage from metricHistory + per-round metric snapshots + legacy stepHistory.rules + current d.metrics.
  const currentMetricVer = String(d.metrics?.version || 'E1');
  const rulesHist = Array.isArray(d.stepHistory?.rules) ? d.stepHistory.rules : [];
  const metricOrder: string[] = [];
  const metricMap = new Map<string, Data>();
  const upsertMetricSnap = (snap: Data | null | undefined, meta?: { rev?: number; at?: number; by?: string; note?: string; legacyPrep?: boolean }) => {
    if (!snap || !Array.isArray(snap.items)) return;
    const id = String(snap.version || 'E1');
    if (!metricMap.has(id)) {
      metricOrder.push(id);
      metricMap.set(id, { id, items: snap.items, slices: Array.isArray(snap.slices) ? snap.slices : [], rev: meta?.rev ?? snap.rev ?? null, at: meta?.at ?? snap.at ?? null, by: meta?.by ?? snap.by ?? null, note: meta?.note ?? snap.note ?? '', legacyPrep: !!meta?.legacyPrep });
    } else {
      const existing = metricMap.get(id)!;
      if (existing.legacyPrep && !meta?.legacyPrep && snap.items.length) {
        existing.items = snap.items;
        existing.slices = Array.isArray(snap.slices) ? snap.slices : [];
        existing.legacyPrep = false;
      }
      if (meta?.rev != null && existing.rev == null) existing.rev = meta.rev;
      if (meta?.at != null && existing.at == null) existing.at = meta.at;
      if (meta?.by && !existing.by) existing.by = meta.by;
      if (meta?.note && !existing.note) existing.note = meta.note;
    }
  };
  for (const h of Array.isArray(d.metricHistory) ? d.metricHistory : []) upsertMetricSnap(h);
  for (const r of rounds) if (r.metrics) upsertMetricSnap(r.metrics, { at: r.start });
  // Retroactive fallback for objectives whose earlier E1 round.metrics were compacted before metricHistory existed:
  // reconstruct prior E<rev> nodes from stepHistory.rules before inserting current d.metrics so E1 -> E2 stays intact.
  const curRulesRev = d.steps?.rules?.rev || rulesHist.length || 1;
  for (const rh of rulesHist) {
    if (typeof rh?.rev !== 'number' || rh.rev >= curRulesRev) continue;
    const inferredId = `E${rh.rev}`;
    if (inferredId === currentMetricVer || metricMap.has(inferredId)) continue;
    const prepAsItems = Array.isArray(rh.items)
      ? rh.items.map((p: Data) => ({ id: p.id, name: p.title || p.id, how: p.value || '', dir: '', line: '', guard: false, locked: false }))
      : [];
    upsertMetricSnap({ version: inferredId, items: prepAsItems, slices: [] }, { rev: rh.rev, at: rh.at, by: rh.by, note: rh.next || rh.unknowns || '', legacyPrep: true });
  }
  if (d.metrics) {
    const curHist = rulesHist.find((h: Data) => h.rev === curRulesRev) || rulesHist[rulesHist.length - 1];
    upsertMetricSnap(d.metrics, { rev: curRulesRev, at: curHist?.at, by: curHist?.by, note: curHist?.next || d.steps?.rules?.next || '' });
    const curEntry = metricMap.get(currentMetricVer);
    if (curEntry) { curEntry.items = d.metrics.items; curEntry.slices = Array.isArray(d.metrics.slices) ? d.metrics.slices : []; curEntry.legacyPrep = false; }
  }
  const eNum = (id: string) => { const m = /^E(\d+)$/i.exec(id); return m ? +m[1] : Number.MAX_SAFE_INTEGER; };
  metricOrder.sort((a, b) => {
    const na = eNum(a), nb = eNum(b);
    if (na !== nb) return na - nb;
    const ea = metricMap.get(a)!, eb = metricMap.get(b)!;
    if (ea.rev != null && eb.rev != null && ea.rev !== eb.rev) return ea.rev - eb.rev;
    return (ea.at || 0) - (eb.at || 0);
  });
  const metricNodes = metricOrder.map(function (id: string, idx: number): Data {
    const entry = metricMap.get(id)!;
    const parentId = idx > 0 ? metricOrder[idx - 1] : null;
    const parentEntry = parentId ? metricMap.get(parentId)! : null;
    const histMatch = (entry.rev != null && rulesHist.find((h: Data) => h.rev === entry.rev)) || rulesHist[idx] || null;
    const by = entry.by || histMatch?.by || null;
    const at = entry.at || histMatch?.at || null;
    const note = entry.note || histMatch?.next || (id === currentMetricVer ? d.steps?.rules?.next || '' : '');
    const usedRounds = rounds.filter((r: Data) => roundMetricVersion(d, r) === id);
    const versionsUsed = [...new Set(usedRounds.map((r: Data) => r.version).filter(Boolean))];
    const lockedCount = entry.items.filter((m: Data) => m.locked || m.guard).length;
    const workingCount = entry.items.length - lockedCount;
    const diffChanges: Data[] = [];
    let add = 0, del = 0, mod = 0;
    if (parentEntry && !parentEntry.legacyPrep && !entry.legacyPrep) {
      const pItems = new Map<string, Data>(parentEntry.items.map((m: Data) => [m.id, m]));
      const cItems = new Map<string, Data>(entry.items.map((m: Data) => [m.id, m]));
      for (const m of entry.items) {
        const pm = pItems.get(m.id);
        if (!pm) {
          add++;
          diffChanges.push({ key: `add:${m.id}`, kind: 'add', title: m.name || m.id, detail: [m.dir, m.line, m.how].filter(Boolean).join(' · ') });
        } else {
          const diffs: string[] = [];
          if ((pm.line || '') !== (m.line || '')) diffs.push(`${pm.line || '—'} → ${m.line || '—'}`);
          if ((pm.dir || '') !== (m.dir || '')) diffs.push(`${pm.dir || '—'} → ${m.dir || '—'}`);
          if (Boolean(pm.guard) !== Boolean(m.guard)) diffs.push(m.guard ? '转为护栏' : '取消护栏');
          if ((pm.how || '') !== (m.how || '')) diffs.push(`${pm.how || '—'} → ${m.how || '—'}`);
          if (diffs.length) {
            mod++;
            diffChanges.push({ key: `mod:${m.id}`, kind: 'mod', title: m.name || m.id, detail: diffs.join('；') });
          }
        }
      }
      for (const pm of parentEntry.items) {
        if (!cItems.has(pm.id)) {
          del++;
          diffChanges.push({ key: `del:${pm.id}`, kind: 'del', title: pm.name || pm.id, detail: [pm.dir, pm.line].filter(Boolean).join(' · ') });
        }
      }
      const pSlices = new Map<string, Data>((parentEntry.slices || []).map((s: Data) => [s.id, s]));
      for (const s of entry.slices || []) {
        const ps = pSlices.get(s.id);
        const pStats = new Map<string, Data>((ps?.stats || []).map((st: Data) => [st.id, st]));
        for (const st of s.stats || []) {
          const pst = pStats.get(st.id);
          if (!pst) {
            add++;
            diffChanges.push({ key: `sadd:${s.id}:${st.id}`, kind: 'add', title: `${s.name || s.id} / ${st.name || st.id}`, detail: [st.dir, st.line].filter(Boolean).join(' · ') });
          } else if ((pst.line || '') !== (st.line || '') || (pst.dir || '') !== (st.dir || '')) {
            mod++;
            diffChanges.push({ key: `smod:${s.id}:${st.id}`, kind: 'mod', title: `${s.name || s.id} / ${st.name || st.id}`, detail: `${pst.line || '—'} → ${st.line || '—'}` });
          }
        }
      }
    }
    const eCycles = usedRounds.map((r: Data) => {
      const done = (r.runs || []).filter((u: Data) => u.state === 'done' || u.state === 'failed').length;
      const total = (r.runs || []).length;
      const evalRes = r.state === 'running' ? null : r.report ? r.report.verdict : (r.state === 'evaluating' ? 'waiting' : r.state);
      const dec = r.decision;
      const decText = dec ? (dec.pick === 'direction'
        ? ((r.report?.directions || []).find((x: Data) => x.id === dec.directionId)?.title || dec.directionId || '采纳方向')
        : dec.note || dec.pick) : '';
      return {
        n: r.n,
        version: r.version,
        state: r.state,
        verdict: r.report?.verdict || r.state,
        tag: r.report?.tag || '',
        headline: r.report?.headline || (r.state === 'running' ? '运行中' : r.state === 'evaluating' ? '等待评估' : ''),
        summary: r.report?.summary || '',
        decisionText: decText,
        collect: true,
        live: r.state === 'running',
        done,
        total,
        eval: evalRes,
      };
    });
    return {
      key: key(id),
      parent: parentId ? key(parentId) : null,
      gov: idx < metricOrder.length - 1 ? 'switch' : null,
      cycles: eCycles,
      data: {
        id,
        parent: parentId,
        isCurrent: id === currentMetricVer,
        nodeState: id === currentMetricVer ? 'current' : '',
        count: entry.items.length,
        locked: lockedCount,
        working: workingCount,
        versionsUsed,
        hasVersionsUsed: versionsUsed.length > 0,
        by: by ? nameOf(by) : '',
        at,
        note,
        items: entry.items,
        hasDiff: diffChanges.length > 0,
        diff: parentId ? { parent: parentId, add, del, mod } : null,
        diffChanges,
        hasCycles: eCycles.length > 0,
        cycleSummaries: eCycles,
      },
    };
  });
  const eTreeObj = rsiTree('rsiSelE', metricNodes, { row: key(currentMetricVer) });
  const eSelRow = eTreeObj.rows.find((x: Data) => x.key === eTreeObj.rowKey) || eTreeObj.rows[eTreeObj.rows.length - 1] || null;
  const eCycleMatch = /^c(\d+)\./.exec(eTreeObj.stepKey || '');
  const eSelCycle = eSelRow && eCycleMatch ? (eSelRow.cycleSummaries || []).find((c: Data) => c.n === +eCycleMatch[1]) || null : null;
  const eSel = eSelRow ? Object.assign({}, eSelRow, { selectedCycle: eSelCycle, hasSelectedCycle: !!eSelCycle }) : null;

  // Build real Collection / Executor (C1 -> C2 -> ...) lineage from executorHistory + stepHistory.run + current d.executor.
  const executorOpsOf = (ex: Data | null | undefined) => {
    if (!ex) return [];
    if (Array.isArray(ex.ops) && ex.ops.length) {
      return ex.ops.map(function (op: any) {
        const p = op.params;
        const params = typeof p === 'string' ? p : p && typeof p === 'object' && Object.keys(p).length ? JSON.stringify(p) : '';
        return Object.assign({}, op, { params: params || op.tool || '' });
      });
    }
    if (ex.commands && typeof ex.commands === 'object') {
      return Object.entries(ex.commands).filter(([, v]) => typeof v === 'string' && v).map(([k, v]) => ({ op: k, params: String(v) }));
    }
    return [];
  };
  const runHist = Array.isArray(d.stepHistory?.run) ? d.stepHistory.run : [];
  const execHist = Array.isArray(d.executorHistory) ? d.executorHistory : [];
  const cRevs = [...new Set([...execHist.map((h: Data) => h.rev), ...runHist.map((h: Data) => h.rev), d.steps?.run?.rev || 1].filter((n) => typeof n === 'number' && n > 0))].sort((a, b) => a - b);
  const latestCRev = cRevs[cRevs.length - 1] || 1;
  const cNodes = cRevs.map((rev: number, idx: number) => {
    const cid = `C${rev}`;
    const parentCid = idx > 0 ? `C${cRevs[idx - 1]}` : null;
    const eh = execHist.find((h: Data) => h.rev === rev);
    const rh = runHist.find((h: Data) => h.rev === rev);
    const isCur = rev === latestCRev;
    const ops = isCur ? executorOpsOf(d.executor) : executorOpsOf(eh);
    return {
      key: key(cid),
      parent: parentCid ? key(parentCid) : null,
      gov: idx < cRevs.length - 1 ? 'switch' : null,
      cycles: [],
      data: {
        id: cid,
        rev,
        isCurrent: isCur,
        nodeState: isCur ? 'current' : '',
        by: (eh?.by || rh?.by) ? nameOf(eh?.by || rh?.by) : '',
        at: eh?.at || rh?.at || null,
        note: eh?.note || rh?.next || rh?.unknowns || (isCur ? d.steps?.run?.next || '' : ''),
        state: isCur ? (d.executor?.state || '') : (eh?.state || ''),
        mcp: isCur ? (d.executor?.mcp || '') : (eh?.mcp || ''),
        ops,
        hasOps: ops.length > 0,
      },
    };
  });
  const cTreeObj = rsiTree('rsiSelC', cNodes, { row: key(`C${latestCRev}`) });
  const cSel = cTreeObj.rows.find((x: Data) => x.key === cTreeObj.rowKey) || cTreeObj.rows[cTreeObj.rows.length - 1] || null;

  return { id: o.id, name: clipTitle(o.name, 64, o.id), state: o.state, stopReason: o.stopReason || null, closeoutReport, projectPath: o.projectPath, goal: o.goal, goalQuote, editingGoal: S.rsiEditGoal, execStatus, execFlow, thread: o.thread, next: next, now: now, tab: S.rsiTab, section: expSection, snapshot, hasRounds: rounds.length > 0, setup: rounds.length === 0,
    // Four significant digits: the chart prints the value (0.5075000000000001 → 0.5075).
    trend: legacyTrend,
    trendMetric: d.metrics.items.find((m: Data) => m.id === main).name,
    trendSeries,
    trendOptions,
    activeTrendId,
    activeTrend,
    overviewMode: S.rsiOverviewMode,
    overviewLens: S.rsiOverviewLens,
    overviewMap,
    hitRate: { hit: preds.filter(function (p: any): any { return p.result === 'hit'; }).length, all: preds.filter(function (p: any): any { return p.result !== 'unresolved'; }).length },
    versions: tree.rows, ver: ver, step: currentStep, prepStage, candidate: d.candidate ? d.candidate.version : null,
    cycle: cycleView,
    prep: { needYou: needYou, steps: slimPrepSteps, dagNodes: dagNodes, visibleSteps: slimPrepSteps.filter((s: Data) => s.visible), ready: readyInfo, activeKey: activeKey, showAll: showAll }, executor: d.executor && Object.assign({}, d.executor, { ops: executorOpsOf(d.executor) }), members: o.projectPath ? d.members.filter(function (m: any): any { return m.catId; }) : d.members, roleMembers: o.projectPath ? d.members.filter(function (m: any): any { return m.catId && m.role !== 'analyze'; }) : d.members, execStages, discussion: d.members.filter(function (m: any): any { return m.role === 'analyze' && m.catId; }).map(function (m: any): any { return { id: m.catId, name: m.name }; }), memberIds: { prepare: (d.members.find(function (m: any): any { return m.role === 'prepare'; }) || {}).catId, evaluate: (d.members.find(function (m: any): any { return m.role === 'evaluate'; }) || {}).catId, iterate: (d.members.find(function (m: any): any { return m.role === 'iterate'; }) || {}).catId }, policy: policyOf(d, o, schedNow), policyEditor: policyEditorOf(d, schedNow), metrics: d.metrics,
    eTree: eTreeObj.rows, eSel, cTree: cTreeObj.rows, cSel };
};
function record(): any {
  const a = S.dialog && S.dialog.kind === 'rsiRecord' && S.dialog.args; if (!a) return null;
  return (a.type === 'run' ? runsOf : tracesOf)(state, { objectiveId: a.objective, cycle: a.cycle }).items.find(function (x: any): any { return x.id === a.id; }) || null;
};

function rsiPolicyOf(r: any): any {
  if (!r) return null;
  const d = r.detail, cats = memberIds(state).map((id) => ({ id, name: id, displayName: id })).map(function (c: any): any { return { v: c.id, label: c.displayName || c.name }; });
  const catName = function (id: any): any { return (cats.find(function (c: any): any { return c.v === id; }) || {}).label || id; };
  const pol = function (k: any, options: any): any { return { value: d.policy[k] != null ? String(d.policy[k]) : '', inherit: r.projectPolicy[k], options: options.map(function (v: any): any { return { v: String(v) }; }) }; };
  const member = function (k: any): any { return Object.assign(pol(k, []), { inheritName: catName(r.projectPolicy[k]), options: cats }); };
  return { overrides: Object.keys(d.policy).map(function (k: any): any { return { k: k, v: String(d.policy[k]), name: catName(d.policy[k]) }; }),
    policy: { count: pol('count', [200, 400, 800]), days: pol('days', [3, 7, 14]), interval: pol('interval', ['1h', '2h', '6h']), counter: pol('counter', [3, 5, 10]),
      approval: pol('approval', ['manual', 'auto']), everyN: pol('everyN', [3, 5]), noChangeK: pol('noChangeK', [4, 5]), eval: member('eval'), iterate: member('iterate'), metrics: member('metrics') } };
}

function policy(): any { const pr = rsiProject(); return rsiPolicyOf(objectiveData(state, rsiPick(pr.objectives).id)); };

function todo(): any {
  const pr = rsiProject();
  const name = function (id: any): any { return (pr.objectives.find(function (o: any): any { return o.id === id; }) || {}).name; }, unit = function (id: any): any { return pr.units.find(function (u: any): any { return u.id === id; }) || { name: id }; };
  return { items: todoOf(state, { projectId: S.rsiProject }).items.map(function (x: any): any {
    return Object.assign({}, x, { objectiveName: name(x.objective), actions: (x.actions || []).map(function (a: any): any { return Object.assign({}, a, { unitName: unit(a.unit).name, sharedNames: (a.shared || []).map(name) }); }) });
  }) };
};

function newExp(): any { return { cats: [] }; }
function caps(): any {
  // An executor capability of an objective that no longer exists is not shown.
  const pr = rsiProject(), groups = pr.groups.filter(function (g: any): any { return !g.forObjective || state.experiments[g.forObjective]; }), group = function (g: any): any { return Object.assign({}, g, { units: pr.units.filter(function (u: any): any { return u.group === g.id; }).length, supported: pr.hostKinds.indexOf(g.kind) >= 0 }); };
  return { analysis: pr.analysis, listed: !!pr.analysis || groups.length > 0, modify: groups.filter(function (g: any): any { return g.side === 'modify'; }).map(group), collect: groups.filter(function (g: any): any { return g.side === 'collect'; }).map(group), env: groups.filter(function (g: any): any { return g.side === 'env'; }) };
};

function cards(): any {
  const pr = rsiProject(), only = S.dialog && S.dialog.kind === 'rsiCards' && S.dialog.args && S.dialog.args.objective, name = function (id: any): any { return (pr.objectives.find(function (x: any): any { return x.id === id; }) || {}).name; };
  const unit = function (id: any): any { return pr.units.find(function (u: any): any { return u.id === id; }) || { name: id }; };
  return { cards: cardsOf(state, { projectId: S.rsiProject }).cards.filter(function (c: any): any { return !only || c.objective === only; }).map(function (c: any): any {
    return Object.assign({}, c, { objectiveName: name(c.objective), actions: (c.actions || []).map(function (a: any): any { return Object.assign({}, a, { unitName: unit(a.unit).name, sharedNames: (a.shared || []).map(name) }); }) });
  }) };
};

function rsiDocs(): any { return libraryOf(state, { projectId: S.rsiProject }).docs; }
function rsiDoc(x: any): any {
  const pr = rsiProject(), name = function (id: any): any { return (pr.objectives.find(function (o: any): any { return o.id === id; }) || {}).name; };
  return Object.assign({}, x, { objectiveNames: x.objectives.map(name), usedByEs: x.usedBy.map(function (u: any): any { return u.e; }).filter(function (e: any, i: any, a: any): any { return a.indexOf(e) === i; }) });
}
function library(): any {
  const docs = rsiDocs();
  return { analysis: rsiProject().analysis, docs: docs.length > 0, groups: ['project', 'feedback', 'provided'].map(function (k: any): any { return { k: k, items: docs.filter(function (x: any): any { return x.kind === k; }).map(rsiDoc) }; }).filter(function (g: any): any { return g.items.length; }) };
};
function doc(): any {
  const a = S.dialog && S.dialog.kind === 'rsiDoc' && S.dialog.args; if (!a) return null;
  const pr = rsiProject(), x = rsiDocs().find(function (doc: any): any { return doc.id === a.id; }), name = function (id: any): any { return (pr.objectives.find(function (o: any): any { return o.id === id; }) || {}).name; };
  return x ? Object.assign({}, x, { objectiveNames: x.objectives.map(name), usedBy: x.usedBy.map(function (u: any): any { return Object.assign({ name: name(u.objective) }, u); }) }) : null;
};

  switch (view) {
    case 'home': return home();
    case 'objective': return objective();
    case 'exp': return exp();
    case 'record': return record();
    case 'policy': return policy();
    case 'todo': return todo();
    case 'newExp': return newExp();
    case 'caps': return caps();
    case 'cards': return cards();
    case 'library': return library();
    case 'doc': return doc();
    default: return undefined;
  }
}
