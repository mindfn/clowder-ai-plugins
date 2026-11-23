import { AUTO, autoKey, clipTitle, prepSettled, REPAIR_DEFAULT, repairText, stepMemberOf, stopText } from './init.js';
import type { Data, RsiState } from './types.js';
import { projectOf, todoOf, cardsOf, libraryOf, tracesOf, runsOf, objectiveData, memberIds } from './data.js';
import { formatPolicy, maxRunsText, nextScheduledRuns, policiesOf, scheduleForm, scheduleSummary, timeRange, validatePolicy } from './schedule.js';
import { analystsOf, short, signed, testedVersion } from './cycles.js';

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
    rsiOverviewMode: query.overviewMode === 'trend' ? 'trend' : 'map',
    rsiOverviewLens: query.overviewLens === 'aspect' ? 'aspect' : 'metric',
    rsiCmpMode: query.cmpMode === 'cross' ? 'cross' : 'cycle',
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
  const mainOf = (r: Data) => (r.metrics || d.metrics).items.find((m: Data) => !m.guard);
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
  const compareOf = function (r: Data) {
    const report = r.report, items = (r.metrics || d.metrics).items, lead = mainOf(r);
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
    const concludedRounds = rounds.filter((x: Data) => x.report && (x.n === r.n || (x.report.matrix || []).some((c: Data) => typeof c.mean === 'number' && Number.isFinite(c.mean))));
    const crossCols = concludedRounds.map((x: Data) => ({ cycle: x.n, label: `${x.version}-${x.k}`, version: x.version, current: x.n === r.n }));
    const seriesIds = new Set(trendSeries.map((s: Data) => s.id));
    const nonControlGroups = groups.filter((g: Data) => !g.control);
    const buildTableRow = (m: Data) => {
      const def = items.find((x: Data) => x.id === m.id) || {};
      const ctrlItem = m.items.find((x: Data) => x.control) || null;
      const candItems = m.items.filter((x: Data) => !x.control);
      const anyValue = m.items.some((x: Data) => x.mean != null);
      const anyFail = m.role === 'guard' && m.items.some((x: Data) => x.guard === 'fail');
      const allPass = m.role === 'guard' && anyValue && !anyFail && m.items.some((x: Data) => x.guard === 'pass');
      const leadCand = candItems[0] || null;
      let status = 'info', statusText = '';
      if (!anyValue) { status = 'missing'; statusText = '本轮未测'; }
      else if (m.role === 'main') {
        if (candItems.some((x: Data) => x.standing === 'beats')) { status = 'win'; statusText = '胜过对照'; }
        else if (candItems.some((x: Data) => x.standing === 'guard')) { status = 'fail'; statusText = '护栏越线'; }
        else if (candItems.some((x: Data) => x.standing === 'control' || x.standing === 'runs')) { status = 'warn'; statusText = '不可比'; }
        else if (leadCand?.better === 'better') { status = 'win'; statusText = '更好'; }
        else if (leadCand?.better === 'worse') { status = 'fail'; statusText = '更差'; }
        else if (leadCand?.better === 'same') { status = 'info'; statusText = '持平'; }
        else { status = 'info'; statusText = '基线'; }
      } else if (m.role === 'guard') {
        if (anyFail) { status = 'fail'; statusText = '越线'; }
        else if (allPass) { status = 'pass'; statusText = '通过'; }
        else { status = 'missing'; statusText = '未测'; }
      } else if (leadCand) {
        if (leadCand.better === 'better') { status = 'pass'; statusText = '更好'; }
        else if (leadCand.better === 'worse') { status = 'warn'; statusText = '更差'; }
        else if (leadCand.better === 'same') { status = 'info'; statusText = '持平'; }
      }
      const ruleText = m.role === 'guard' && typeof m.threshold === 'number'
        ? `${m.dir === 'up' ? '≥' : '≤'} ${m.threshold}${def.unit ? ' ' + def.unit : ''}`
        : `${m.dir === 'up' ? '↑ 越大越好' : '↓ 越小越好'}${def.unit ? ' · ' + def.unit : ''}`;
      const crossValues = concludedRounds.map((x: Data) => {
        const c = metricValueInRound(x, m.id, m.dir);
        const val = num(c?.mean);
        const pass = m.role === 'guard' && typeof m.threshold === 'number' && typeof c?.mean === 'number'
          ? (m.dir === 'up' ? c.mean >= m.threshold : c.mean <= m.threshold)
          : null;
        return { label: `${x.version}-${x.k}`, value: val, current: x.n === r.n, guard: pass === null ? '' : pass ? 'pass' : 'fail' };
      });
      return {
        id: m.id,
        name: m.name,
        role: m.role,
        dir: m.dir,
        unit: def.unit || '',
        ruleText,
        hasTrend: seriesIds.has(m.id),
        active: m.id === activeTrendId,
        status,
        statusText,
        anyValue,
        control: ctrlItem ? {
          id: ctrlItem.id, version: ctrlItem.version, mean: ctrlItem.mean, sd: ctrlItem.sd, n: ctrlItem.n, partial: ctrlItem.partial, guard: ctrlItem.guard,
          seeds: (ctrlItem.seeds || []).map((s: Data, idx: number) => ({ round: idx + 1, seed: s.seed, value: s.value, state: s.state })),
        } : null,
        candidates: candItems.map((c: Data) => ({
          id: c.id, label: c.label, version: c.version, confirm: c.confirm, mean: c.mean, sd: c.sd, n: c.n, partial: c.partial,
          delta: c.delta, better: c.better, guard: c.guard, crossed: c.crossed, standing: c.standing,
          seeds: (c.seeds || []).map((s: Data, idx: number) => ({ round: idx + 1, seed: s.seed, value: s.value, state: s.state })),
        })),
        crossValues,
      };
    };
    const tableRows = metrics.map(buildTableRow);
    const secMain = tableRows.filter((x: Data) => x.role === 'main');
    const secGuardFail = tableRows.filter((x: Data) => x.role === 'guard' && x.anyValue && x.status === 'fail');
    const secGuardPass = tableRows.filter((x: Data) => x.role === 'guard' && x.anyValue && x.status === 'pass');
    const secOther = tableRows.filter((x: Data) => x.role === 'other' && x.anyValue);
    const secMissing = tableRows.filter((x: Data) => !x.anyValue && x.role !== 'main');
    const sections = [
      { k: 'main', title: '主指标', defaultOpen: true, tone: 'info', rows: secMain },
      { k: 'guard_fail', title: '未通过护栏', defaultOpen: true, tone: 'danger', rows: secGuardFail },
      { k: 'guard_pass', title: '已通过护栏', defaultOpen: secGuardPass.length <= 4 && secGuardFail.length === 0, tone: 'ok', rows: secGuardPass },
      { k: 'other', title: '诊断与辅助指标', defaultOpen: secOther.length <= 5, tone: '', rows: secOther },
      { k: 'missing', title: '本轮未测 / 暂无数据', defaultOpen: false, tone: 'muted', rows: secMissing },
    ].filter((sec) => sec.rows.length > 0);
    const table = {
      mode: S.rsiCmpMode,
      tier: r.plan.tier || '',
      skipControl: !!r.plan.skipControl,
      selectedMetric: activeTrendId,
      cycleLabel: `${r.version}-${r.k}`,
      seeds: r.plan.seeds,
      controlGroup: control ? { id: control.id, version: control.version, label: control.label } : null,
      candidateGroups: nonControlGroups.map((g: Data) => ({ id: g.id, version: g.version, label: g.label, confirm: !!g.confirm })),
      crossCols,
      sections,
      totalMetrics: tableRows.length,
    };
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
    const m = r.metrics || d.metrics || { version: '', items: [] };
    return {
      version: m.version,
      items: (m.items || []).map((it: Data) => Object.assign({}, it, {
        line: it.line || (it.guard && typeof it.threshold === 'number' ? `${it.dir === 'up' ? '≥' : '≤'} ${it.threshold}${it.unit ? ' ' + it.unit : ''}` : ''),
      })),
    };
  };
  const ASPECT_LABELS: Record<string, string> = { object: '进化对象', observability: '可观测性', rubric: '规约尺子' };
  const findTriggerRound = (v: Data, verRounds: Data[]) => {
    const repairedFrom = rounds.find((x: Data) => x.repairedBy === v.id);
    if (repairedFrom) return { round: repairedFrom, repair: true };
    const firstN = verRounds.length ? verRounds[0].n : Infinity;
    const candidates = rounds.filter((x: Data) => x.n < firstN && (x.decision || x.state === 'repaired'));
    for (let i = candidates.length - 1; i >= 0; i--) {
      const cand = candidates[i];
      if (cand.version === v.parent) return { round: cand, repair: false };
    }
    return candidates.length ? { round: candidates[candidates.length - 1], repair: false } : null;
  };
  const aspectsOfVersion = (v: Data, verRounds: Data[]) => {
    if (!v.parent) return ['object', 'observability', 'rubric'];
    const set = new Set<string>();
    const trig = findTriggerRound(v, verRounds);
    if (trig?.repair) set.add('observability');
    else if (trig?.round?.decision) {
      const dec = trig.round.decision;
      const dir = dirOf(trig.round);
      const kind = dir?.kind || '';
      if (kind === 'code' || kind === 'variable' || dec.pick === 'addVar') set.add('object');
      else if (kind === 'execution' || kind === 'discriminate') set.add('observability');
      else if (kind === 'metric' || kind === 'goal' || dec.pick === 'metric' || dec.pick === 'goal') set.add('rubric');
    }
    const parentRounds = rounds.filter((x: Data) => x.version === v.parent);
    const parentMetricVer = parentRounds[parentRounds.length - 1]?.metrics?.version || d.metrics.version;
    const ownMetricVer = verRounds[0]?.metrics?.version || d.metrics.version;
    if (ownMetricVer && parentMetricVer && ownMetricVer !== parentMetricVer) set.add('rubric');
    const parentV = d.versions.find((x: Data) => x.id === v.parent);
    if (parentV) {
      const sameVars = JSON.stringify(v.vars || {}) === JSON.stringify(parentV.vars || {});
      const sameCfg = JSON.stringify(v.config || {}) === JSON.stringify(parentV.config || {});
      if ((!sameVars || !sameCfg) && !set.has('observability') && !set.has('rubric')) set.add('object');
    }
    if (!set.size) set.add('object');
    return ['object', 'observability', 'rubric'].filter((k) => set.has(k));
  };
  const pruneInfoOfVersion = (v: Data, verRounds: Data[], isRunningVer: boolean) => {
    if (v.current || isRunningVer || v.status === 'candidate' || !verRounds.length) return { pruned: false, reason: '' };
    const lastR = verRounds[verRounds.length - 1];
    if (lastR.state === 'repaired') return { pruned: true, reason: '执行失败已由后续版本修复' };
    const verdict = lastR.report?.verdict || '';
    if (verdict === 'rollback') return { pruned: true, reason: lastR.report?.headline || '回退剪枝' };
    if (verdict === 'sunset') return { pruned: true, reason: lastR.report?.headline || '已终止剪枝' };
    if (verdict === 'insufficient') return { pruned: true, reason: lastR.report?.headline || '证据不足 / 门禁拦截' };
    return { pruned: false, reason: '' };
  };
  const versionMetaById: Record<string, Data> = {};
  d.versions.forEach((v: Data) => {
    const verRounds = rounds.filter((x: Data) => x.version === v.id);
    const isRunningVer = !!o.projectPath && verRounds.some((x: Data) => ['running', 'evaluating', 'repairing'].includes(x.state));
    const aspects = aspectsOfVersion(v, verRounds);
    const prune = pruneInfoOfVersion(v, verRounds, isRunningVer);
    const lastR = verRounds[verRounds.length - 1] || null;
    const nodeState = v.current ? 'current' : isRunningVer ? 'running' : v.status === 'candidate' ? 'candidate' : (o.projectPath && prune.pruned) ? 'pruned' : '';
    const stateText = nodeState === 'current' ? '当前运行中' : nodeState === 'running' ? '评估运行中' : prune.pruned ? '已证伪 / 拦截' : nodeState === 'candidate' ? '待验证候选' : '已探索';
    versionMetaById[v.id] = {
      aspects,
      aspectText: aspects.map((a) => ASPECT_LABELS[a] || a).join(' · '),
      pruned: prune.pruned,
      pruneReason: prune.reason,
      nodeState,
      stateText,
      commitShort: v.commit ? String(v.commit).slice(0, 7) : '',
      metricVersion: lastR?.metrics?.version || d.metrics.version,
      verRounds,
      lastRound: lastR,
      isRunningVer,
    };
  });
  const tree = rsiTree('rsiSelO', d.versions.map(function (v: any): any {
    const meta = versionMetaById[v.id];
    const verRounds = meta.verRounds;
    return { key: key(v.id), parent: v.parent && key(v.parent),
      cycles: verRounds.map(function (r: any): any {
        const live = r.state === 'running', disc = r.report && discussionOf(r), bypassed = r.state === 'repaired' || r.state === 'repairing';
        return { n: r.k, apply: r.runs.some(function (u: any): any { return u.error && u.error.kind === 'env'; }) ? 'failed' : 'done', collect: true, live: live,
          done: live ? r.runs.filter((u: Data) => u.state === 'done' || u.state === 'failed').length : null, total: r.runs.length,
          eval: r.report ? r.report.verdict : evalStateOf(r), delta: r.report && compareOf(r).lead,
          discuss: disc ? { result: disc.status, resolved: !!r.decision, count: disc.count, done: disc.done, asked: disc.asked, missing: disc.missing.length } : (o.projectPath ? { result: (!hasAnalysts || bypassed) ? 'skipped' : 'waiting', resolved: false, count: 0 } : null),
          gov: govOf(r) || 'waiting' };
      }),
      data: Object.assign({}, v, {
        nodeState: meta.nodeState,
        stateText: meta.stateText,
        aspects: meta.aspects,
        aspectText: meta.aspectText,
        pruned: meta.pruned,
        pruneReason: meta.pruneReason,
        commitShort: meta.commitShort,
        metricVersion: meta.metricVersion,
      }) };
  }), { row: key(focus ? focus.version : o.currentVersion) });
  const verRaw = d.versions.find(function (v: any): any { return key(v.id) === tree.rowKey; }), m = /^c(\d+)\.(\w+)$/.exec(tree.stepKey);
  const ver = verRaw ? Object.assign({}, verRaw, {
    nodeState: versionMetaById[verRaw.id]?.nodeState || '',
    stateText: versionMetaById[verRaw.id]?.stateText || '',
    aspects: versionMetaById[verRaw.id]?.aspects || [],
    aspectText: versionMetaById[verRaw.id]?.aspectText || '',
    pruned: !!versionMetaById[verRaw.id]?.pruned,
    pruneReason: versionMetaById[verRaw.id]?.pruneReason || '',
    commitShort: versionMetaById[verRaw.id]?.commitShort || '',
    metricVersion: versionMetaById[verRaw.id]?.metricVersion || d.metrics.version,
  }) : null;
  const r = m && rounds.find(function (x: any): any { return x.version === ver.id && x.k === +m[1]; });
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
  const dagNodes = [...steps, readyNode];
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
  const next = o.state === 'done' ? { k: 'done', stop: (d.prep.find(function (p: any): any { return p.section === 'goal' && p.id.endsWith('-stop'); }) || {}).id } : o.state === 'paused' ? { k: 'paused' } : wait ? { k: 'decide', v: wait.version, n: wait.k, go: at(wait, 'gov') } : run ? { k: 'running', v: run.version, n: run.k, go: at(run, 'collect') }
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
    return Object.assign({}, u, {
      roundNo: idx + 1,
      roundTitle: `第 ${idx + 1} 轮`,
      seedText: `seed ${u.seed}`,
      value: num(u.metrics?.[mainOf(x).id]),
      durationSeconds: durSec,
      durationText: u.state === 'running' && durMs != null ? `已跑 ${fmtDuration(durMs)}` : fmtDuration(durMs),
      command: renderRunCommand(x, g, u),
      commitShort,
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
      evaluateCatId: (d.members.find((m: Data) => m.role === 'evaluate') || {}).catId || '',
      iterateCatId: (d.members.find((m: Data) => m.role === 'iterate') || {}).catId || '',
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
  const currentStep = m ? m[2] : 'node';
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
    const trig = findTriggerRound(v, versionMetaById[v.id]?.verRounds || []);
    let triggerText = !v.parent ? '初始基线版本' : `源自 ${v.parent}`;
    if (trig?.repair) triggerText = `第 ${trig.round.n} 周期（${trig.round.version}）执行失败后自动修复`;
    else if (trig?.round?.decision) {
      const dir = dirOf(trig.round);
      triggerText = dir?.title
        ? `第 ${trig.round.n} 周期采纳方向：${clipTitle(dir.title, 72, dir.id)}`
        : trig.round.decision.note
          ? `第 ${trig.round.n} 周期决策：${clipTitle(trig.round.decision.note, 72, trig.round.decision.pick)}`
          : `第 ${trig.round.n} 周期（${trig.round.version}）推进`;
    }
    const basisText = targetRound?.report?.headline
      || (targetRound?.state === 'running' ? '正在执行实验运行' : targetRound?.state === 'evaluating' ? '运行已完成，等待评估结论' : targetRound?.state === 'repaired' ? '运行失败并已由后续版本修复' : '尚未形成评估结论');
    return { trigger: triggerText, action: v.change || '—', basis: basisText };
  };
  const overviewNodes = d.versions.map((v: Data) => {
    const meta = versionMetaById[v.id];
    const lastR = meta.lastRound;
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
    const pickTarget = lastR ? `${key(v.id)}>c${lastR.k}.${lastR.report ? 'eval' : 'collect'}` : `${key(v.id)}>node`;
    const guardFail = !!(lastR?.report?.compare?.groups || []).some((g: Data) => {
      const gp = lastR.plan?.groups?.find((x: Data) => x.id === g.group);
      return gp && gp.version === v.id && !gp.control && Array.isArray(g.guardrails) && g.guardrails.some((gr: Data) => !gr.pass);
    });
    const receipts = lastR ? lastR.runs.slice(0, 6).map((u: Data) => ({
      runId: u.id,
      seed: u.seed,
      state: u.state,
      jobId: u.jobId || '',
      commit: (u.env?.commit || v.commit || '').slice(0, 7),
      error: u.error?.raw ? clipTitle(String(u.error.raw), 80, '') : '',
    })) : [];
    return {
      id: v.id,
      parent: v.parent || null,
      pick: pickTarget,
      selected: ver?.id === v.id,
      state: meta.nodeState,
      stateText: meta.stateText,
      pruned: meta.pruned,
      pruneReason: meta.pruneReason,
      aspects: meta.aspects,
      aspectText: meta.aspectText,
      verdict: lastR?.report?.verdict || (lastR?.state === 'running' ? 'running' : lastR?.state === 'repaired' ? 'repaired' : ''),
      tier,
      metricVersion: ownScale,
      cycleN: lastR?.n || null,
      cycleK: lastR?.k || null,
      roundsCount: meta.verRounds.length,
      value: val,
      valueText: fmtMetricNum(val, activeMetricDef.unit || ''),
      refId,
      refValue: refVal,
      deltaText,
      better,
      comparable,
      guardFail,
      commitShort: meta.commitShort,
      change: v.change || '',
      changeShort: clipTitle(v.change || '', 24, v.id),
      headline: lastR?.report?.headline || '',
      causality: buildCausality(v, lastR),
      receipts,
    };
  });
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
      total: overviewNodes.length,
      pruned: overviewNodes.filter((n: Data) => n.pruned).length,
      running: overviewNodes.filter((n: Data) => n.state === 'running').length,
      current: o.currentVersion,
    },
    nodes: overviewNodes,
  };
  const buildCycleDetailCard = (targetR: Data | null, targetV: Data | null, cmp: Data | null, bodyText: string) => {
    if (!targetR || !targetR.report || !targetV) return null;
    const meta = versionMetaById[targetV.id] || { aspects: [], aspectText: '', pruned: false, commitShort: '' };
    const mainMetric = cmp?.metrics?.[0] || null;
    const ctrlItem = mainMetric?.items?.find((it: Data) => it.control) || null;
    const candItem = mainMetric?.items?.find((it: Data) => !it.control) || ctrlItem;
    const comparable = !!targetR.report.compare?.comparable && !!ctrlItem && candItem !== ctrlItem;
    const tier = targetR.plan.tier || (targetR.plan.baseline ? 'baseline' : 'confirm');
    const tierLabel = tier === 'explore' ? '探索快筛（不可直接晋级）' : tier === 'baseline' ? '基线标定' : '正式确认';
    const scaleVer = (targetR.metrics || d.metrics).version;
    const seedsText = [
      ...(targetR.plan.seeds || []).map(String),
      ...((targetR.plan.reservedSeeds || []).length ? [`预留 ${targetR.plan.reservedSeeds.join(', ')}`] : []),
    ].join(' · ');
    const guardrailsText = ((targetR.metrics || d.metrics).items || [])
      .filter((it: Data) => it.guard)
      .slice(0, 6)
      .map((it: Data) => `${it.name}${it.threshold != null ? ` (${it.dir === 'up' ? '≥' : '≤'}${it.threshold}${it.unit ? ' ' + it.unit : ''})` : ''}`)
      .join('；');
    const conditions = [
      { k: '量尺版本', v: scaleVer },
      { k: '实验层级', v: tierLabel },
      { k: '到达/种子', v: seedsText || '—' },
      { k: '外层对照', v: targetR.plan.skipControl ? '探索跳过外层对照' : (ctrlItem ? `同周期对照 ${ctrlItem.version}` : '基线单组') },
      ...(cycleGroups.filter((g: Data) => g.configSummary).map((g: Data) => ({ k: `配置 (${g.version})`, v: g.configSummary }))),
      ...(guardrailsText ? [{ k: '护栏约束', v: guardrailsText }] : []),
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
      tierLabel,
      metricVersion: scaleVer,
      aspects: meta.aspects,
      aspectText: meta.aspectText,
      pruned: meta.pruned,
      main: mainMetric ? {
        name: mainMetric.name,
        value: candItem?.mean ?? '—',
        sd: candItem?.sd ?? null,
        refLabel: comparable ? `对照 ${ctrlItem.version}` : (targetR.plan.skipControl ? '探索单组（无同轮对照）' : '基线单组'),
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
  return { id: o.id, name: clipTitle(o.name, 64, o.id), state: o.state, projectPath: o.projectPath, goal: o.goal, goalQuote, editingGoal: S.rsiEditGoal, execStatus, execFlow, thread: o.thread, next: next, now: now, tab: S.rsiTab, section: expSection, snapshot, hasRounds: rounds.length > 0, setup: rounds.length === 0,
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
    versions: tree.rows, ver: ver, step: currentStep, candidate: d.candidate ? d.candidate.version : null,
    cycle: r && Object.assign({}, r, { versionRound: `${r.version}-${r.k}`, canReeval: !!o.projectPath && ['done', 'evaluating'].includes(r.state), waiting: waiting(r), evaluating: r.state === 'evaluating', evalState: evalStateOf(r), discussState: discussStateOf(r), evalMetrics: evalMetricsOf(r), groups: cycleGroups, main: mainOf(r),
      stage: stageOfCycle(r, currentStep),
      stageOwners: stageOwnersOf(r),
      runs: cycleRuns,
      notAssessed: r.report && RSI_LAYERS.filter(function (l: any): any { return r.report.attribution.assessedLayers.indexOf(l) < 0; }),
      // A conclusion stores a placeholder attribution (no layer assessed): only one that assessed a layer is an attribution.
      attribution: r.report && r.report.attribution.assessedLayers.length ? r.report.attribution : null,
      // The findings after their first line, which is the headline.
      body: cycleBody,
      detailCard: cycleDetailCard,
      comparisons: r.report ? comparisonsOf(r) : [],
      compare: cycleCompare, discussion: r.report && discussionOf(r), decision: repairDecisionOf(r), gov: (r.report || r.state === 'repaired' || r.state === 'repairing') && govFor(r) }),
    prep: { needYou: needYou, steps: steps, dagNodes: dagNodes, visibleSteps: steps.filter((s: Data) => s.visible), ready: readyInfo, activeKey: activeKey, showAll: showAll }, executor: d.executor && Object.assign({}, d.executor, { ops: (d.executor.ops || []).map(function (op: any) { const p = op.params; const params = typeof p === 'string' ? p : p && typeof p === 'object' && Object.keys(p).length ? JSON.stringify(p) : ''; return Object.assign({}, op, { params: params || op.tool || '' }); }) }), members: o.projectPath ? d.members.filter(function (m: any): any { return m.catId; }) : d.members, roleMembers: o.projectPath ? d.members.filter(function (m: any): any { return m.catId && m.role !== 'analyze'; }) : d.members, execStages, discussion: d.members.filter(function (m: any): any { return m.role === 'analyze' && m.catId; }).map(function (m: any): any { return { id: m.catId, name: m.name }; }), memberIds: { prepare: (d.members.find(function (m: any): any { return m.role === 'prepare'; }) || {}).catId, evaluate: (d.members.find(function (m: any): any { return m.role === 'evaluate'; }) || {}).catId, iterate: (d.members.find(function (m: any): any { return m.role === 'iterate'; }) || {}).catId }, policy: policyOf(d, o, schedNow), policyEditor: policyEditorOf(d, schedNow), metrics: d.metrics,
    eTree: [{ id: d.metrics.version }], cTree: [{ id: 'C1' }] };
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
