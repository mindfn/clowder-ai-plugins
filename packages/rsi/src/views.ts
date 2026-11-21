import { AUTO, autoKey, clipTitle } from './init.js';
import type { Data, RsiState } from './types.js';
import { projectOf, todoOf, cardsOf, libraryOf, tracesOf, runsOf, objectiveData, memberIds } from './data.js';
import { scheduleForm, scheduleSummary, timeRange } from './schedule.js';
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
function policyOf(d: Data, o: Data) {
  const windowText = scheduleSummary(d.policy.schedule);
  const schedule = { ...d.policy.schedule, window: windowText, form: scheduleForm(d.policy.schedule) };
  if (!o.projectPath) return Object.assign({}, d.policy, { schedule, autoText: tc('rsi.exp.pol.autoText') });
  const plan = d.upcoming || (d.rounds.length ? d.rounds[d.rounds.length - 1].plan : null), tried: Data = {};
  for (const r of d.rounds) for (const g of r.plan.groups) if (!g.control) for (const [k, v] of Object.entries(g.vars || {})) {
    const value = typeof v === 'string' ? v : JSON.stringify(v);
    if (!(tried[k] ||= []).includes(value)) tried[k].push(value);
  }
  return Object.assign({}, d.policy, { schedule, seeds: plan ? plan.seeds.length : d.policy.seeds, vars: Object.entries(tried).map(([name, values]) => ({ name, values })), autoText: tc('rsi.exp.pol.' + (({ default: 'nightBoth', execution: 'nightExecution' } as Data)[autoKey(d.policy.auto || AUTO.default) || 'none'] || 'manual')) });
}

export function viewModel(state: RsiState, view: string, query: Data = {}): any {
  const at = follow(state, query);
  const S: Data = {
    rsiProject: at.project, rsiPick: at.pick || 'obj:cp-converge', rsiPicked: !!at.pick, tag: at.tag,
    rsiTab: query.tab || 'version',
    rsiSelO: query.selO || '', rsiSelE: query.selE || '', rsiSelC: query.selC || '',
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
  const stepOf = function (c: any): any { return 'c' + c.n + '.' + (c.eval ? 'eval' : 'collect'); };
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
  const row = out.find(function (x: any): any { return x.sel; }), stepKey = has && row && (parts[1] === 'node' || row.steps.some(function (x: any): any { return x.step === parts[1]; })) ? parts[1] : row && row.steps.length ? row.steps[row.steps.length - 1].step : 'node';
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
  const nameOf = function (id: any): any { const m = d.members.find(function (m: any): any { return m.catId === id; }); return m ? m.name : id; };
  const memberName = function (role: any): any { return nameOf((d.members.find(function (m: any): any { return m.role === role; }) || {}).catId); };
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) ? short(x) : null;
  // A cycle's metrics are the scale it ran with; the first that is not a guardrail is its main metric.
  const mainOf = (r: Data) => (r.metrics || d.metrics).items.find((m: Data) => !m.guard);
  // A cycle whose analysts are still proposing is not yet waiting for the decision.
  const waiting = function (r: any): any { return !!r.report && !r.decision && r.state === 'done' && !(r.analysis && r.analysis.waiting.length); };
  const tested = d.rounds.map(function (r: any): any { return Object.assign({}, r, { version: testedVersion(r.plan) }); });
  const rounds = tested.filter(function (r: any): any { return r.state !== 'planned'; }).map(function (r: any): any { return Object.assign({}, r, { k: tested.filter(function (x: any): any { return x.version === r.version && x.n <= r.n; }).length }); });
  const dirOf = function (r: any): any { return r.decision && r.decision.directionId && r.report.directions.find(function (x: any): any { return x.id === r.decision.directionId; }); };
  const govOf = function (r: any): any { const x = dirOf(r); return waiting(r) ? 'pending' : !r.decision ? null : x ? (x.kind === 'code' ? (r.report.verdict === 'rollback' ? 'rollback' : 'evolve') : x.kind) : r.decision.pick; };
  const sel = (x: Data, step: string) => key(x.version) + '>c' + x.k + '.' + step;
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
        seeds: c?.seeds?.map((s: Data) => ({ seed: s.seed, value: num(s.value), state: crossed.includes(s.seed) ? 'cross' : s.error ? (s.error.kind === 'env' ? 'env' : 'failed') : s.state === 'done' ? '' : 'failed' })) };
    };
    const conf = report.confirmation, mean = (g: Data) => cell(g.id, lead.id)?.mean;
    const winners = groups.filter((g: Data) => judged(g.id)?.beatsControl).sort((a: Data, b: Data) => lead.dir === 'down' ? mean(a) - mean(b) : mean(b) - mean(a));
    const metrics = [lead, ...items.filter((m: Data) => m.guard), ...items.filter((m: Data) => m !== lead && !m.guard)].map((m: Data) => ({ id: m.id, name: m.name, role: m === lead ? 'main' : m.guard ? 'guard' : 'other', dir: m.dir,
      rule: m !== lead ? '' : m.margin !== undefined ? 'margin' : m.minDelta ? 'minDelta' : '', ruleValue: m.margin ?? m.minDelta, limit: m.guard && typeof m.threshold === 'number' ? m.dir : '', threshold: m.threshold,
      items: groups.map((g: Data) => row(g, m)) }));
    return { seeds: r.plan.seeds.length, single: r.plan.seeds.length === 1, metrics, group: conf?.group, version: conf?.version,
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
      differ: firsts.length < 2 ? '' : kinds.size > 1 && !kinds.has('') ? 'kind' : kinds.has('') || targets.has('') ? 'untargeted' : targets.size > 1 ? 'target'
        : new Set(firsts.map((x: Data) => JSON.stringify(x.predict || null))).size > 1 ? 'effect' : 'same',
      kind: firsts[0]?.kind, target: firsts[0]?.target, done: firsts.length, asked: firsts.length + still.length + late.length, waiting: still.map(memberOf), missing: late.map(memberOf),
      count: members.reduce((n, m) => n + m.items.length, 0), firsts: members.map((m) => m.items[0]),
      members: members.map((m) => Object.assign(m, { role: m.evaluator && m.analyst ? 'both' : m.evaluator ? 'evaluate' : m.analyst ? 'analyze' : 'other' })) };
  };
  // What deciding a cycle does (actions.ts expDecide, cycles.ts requestVersion): while it waits, what the choice is; once decided, what was
  // chosen, by whom, and what came of it — the version being made for it, the next cycle, or the objective's end.
  const govFor = function (r: Data) {
    const disc = discussionOf(r), later = rounds.find((x: Data) => x.n > r.n), ask = d.versionRequest && d.versionRequest.cycle === r.n ? d.versionRequest : null;
    return { ask: !waiting(r) ? '' : d.candidate ? 'confirm' : !r.report.directions.length ? 'empty' : ['split', 'agree'].includes(disc!.status) ? disc!.status : 'choose',
      choices: !waiting(r) ? [] : d.candidate ? [{ k: 'same' }] : [{ k: 'same' }, { k: 'note' }], candidate: d.candidate && { group: d.candidate.id, version: d.candidate.version }, current: o.currentVersion, iterate: memberName('iterate'),
      discuss: disc && sel(r, 'discuss'), adopted: dirOf(r) || null,
      led: !r.decision ? null : ask ? { k: 'version', title: ask.title } : later ? { k: 'cycle', n: later.k, version: later.version, go: sel(later, later.report ? 'eval' : 'collect') }
        : o.stopReason && o.stopReason.cycle === r.n ? { k: 'stop', text: o.stopReason.text } : { k: 'later' } };
  };
  const focus = o.projectPath && rounds.find((r: Data) => waiting(r) || r.analysis?.waiting.length || ['running', 'evaluating'].includes(r.state));
  const tree = rsiTree('rsiSelO', d.versions.map(function (v: any): any {
    return { key: key(v.id), parent: v.parent && key(v.parent),
      cycles: rounds.filter(function (r: any): any { return r.version === v.id; }).map(function (r: any): any {
        const live = r.state === 'running', disc = r.report && discussionOf(r);
        return { n: r.k, apply: r.runs.some(function (u: any): any { return u.error && u.error.kind === 'env'; }) ? 'failed' : 'done', collect: true, live: live,
          done: live ? r.runs.filter((u: Data) => u.state === 'done' || u.state === 'failed').length : null, total: r.runs.length, eval: r.report && r.report.verdict, delta: r.report && compareOf(r).lead,
          discuss: disc && { result: disc.status, count: disc.count, done: disc.done, asked: disc.asked, missing: disc.missing.length }, gov: govOf(r) };
      }),
      data: Object.assign({}, v, { nodeState: v.current ? 'current' : v.status === 'candidate' ? 'candidate' : '' }) };
  }), { row: key(focus ? focus.version : o.currentVersion) });
  const ver = d.versions.find(function (v: any): any { return key(v.id) === tree.rowKey; }), m = /^c(\d+)\.(\w+)$/.exec(tree.stepKey);
  const r = m && rounds.find(function (x: any): any { return x.version === ver.id && x.k === +m[1]; });
  const best = function (x: any): any { return x.report && x.report.matrix.filter(function (y: any): any { return y.metric === main && y.mean != null && (!o.projectPath || x.report.compare.groups?.some((g: Data) => g.group === y.group && g.eligible)) && x.plan.groups.find(function (g: any): any { return g.id === y.group; }).version === x.version; }).sort(function (a: any, b: any): any { return d.metrics.items.find((m: Data) => m.id === main).dir === 'down' ? a.mean - b.mean : b.mean - a.mean; })[0]; };
  const preds = ([] as Data[]).concat.apply([], rounds.map(function (x: any): any { return x.report ? x.report.predictions : []; }));
  const needYou = d.prep.filter(function (i: any): any { return i.neededFrom === 'human' && i.state !== 'confirmed'; }).length;

  const no = function (k: any): any { return d.plan.findIndex(function (p: any): any { return p.k === k; }) + 1; };
  const below = function (k: any): any { const out: any[] = []; (function walk(x: any): any { d.plan.forEach(function (p: any): any { if (p.deps.indexOf(x) >= 0 && out.indexOf(p.k) < 0) { out.push(p.k); walk(p.k); } }); })(k); return out; };
  const steps = d.plan.map(function (p: any, i: any): any {
    const k = p.k, items = d.prep.filter(function (x: any): any { return x.section === k; }).map(function (x: any): any { return Object.assign({}, x, { needYou: x.neededFrom === 'human' && x.state !== 'confirmed', by: x.by && nameOf(x.by) }); });
    const has = function (st: any): any { return items.some(function (x: any): any { return x.state === st; }); }, ex = d.exec && d.exec[k], st = d.steps && d.steps[k];
    const missing = d.steps ? p.deps.filter(function (x: any): any { return !d.steps[x] || d.steps[x].stale; }).map(no) : [];
    return { k: k, i: i + 1, items: items, by: ex && ex.state === 'started' && nameOf(ex.by), who: ex && nameOf(ex.by), unknowns: st && st.unknowns, next: st && st.next,
      deps: p.deps.map(no).join('、'), waitOn: d.steps && !ex && !st && missing.join('、'),
      state: ex ? ({ started: 'preparing', cancelled: 'cancelled', failed: 'failed', blocked: 'blocked', missing: 'missing' } as Data)[ex.state] : d.steps && st && st.stale ? 'stale' : d.steps && !st ? (missing.length ? 'waiting' : 'queued')
      : items.every(function (x: any): any { return x.state === 'confirmed'; }) ? 'confirmed' : has('preparing') ? 'preparing' : has('submitted') ? 'submitted' : 'uninvestigated' };
  });
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
  const groupsOf = function (x: any): any {
    return x.plan.groups.map(function (g: any): any {
      const runs = x.runs.filter(function (u: any): any { return u.group === g.id; });
      // A variable may hold an object (reward weights): it reads as JSON.
      return Object.assign({}, g, { varsText: Object.entries(g.vars).map(([k, v]) => k + '=' + (typeof v === 'string' ? v : JSON.stringify(v))).join(' '), failed: runs.filter(function (u: any): any { return u.state === 'failed'; }).length,
        doneN: runs.filter(function (u: any): any { return u.state === 'done' || u.state === 'failed'; }).length, total: runs.length });
    });
  };
  return { id: o.id, name: clipTitle(o.name, 64, o.id), state: o.state, projectPath: o.projectPath, goal: o.goal, thread: o.thread, next: next, now: now, tab: S.rsiTab, setup: rounds.length === 0,
    // Four significant digits: the chart prints the value (0.5075000000000001 → 0.5075).
    trend: rounds.filter(best).map(function (x: any): any { return { n: x.k, version: x.version, value: Number(best(x).mean.toPrecision(4)) }; }),
    trendMetric: d.metrics.items.find((m: Data) => m.id === main).name, hitRate: { hit: preds.filter(function (p: any): any { return p.result === 'hit'; }).length, all: preds.filter(function (p: any): any { return p.result !== 'unresolved'; }).length },
    versions: tree.rows, ver: ver, step: m ? m[2] : 'node', candidate: d.candidate ? d.candidate.version : null,
    cycle: r && Object.assign({}, r, { waiting: waiting(r), groups: groupsOf(r), main: mainOf(r),
      runs: r.runs.map(function (u: any): any { return Object.assign({}, u, { value: num(u.metrics[mainOf(r).id]), durationSeconds: u.start ? Math.round(((u.end || Date.now()) - u.start) / 1000) : null, metricRows: Object.entries(u.metrics || {}).map(([id, value]) => ({ k: d.metrics.items.find((m: Data) => m.id === id)?.name || id, v: value })), groupLabel: r.plan.groups.find(function (g: any): any { return g.id === u.group; }).label }); }),
      notAssessed: r.report && RSI_LAYERS.filter(function (l: any): any { return r.report.attribution.assessedLayers.indexOf(l) < 0; }),
      // A conclusion stores a placeholder attribution (no layer assessed): only one that assessed a layer is an attribution.
      attribution: r.report && r.report.attribution.assessedLayers.length ? r.report.attribution : null,
      // The findings after their first line, which is the headline.
      body: r.report && (r.report.summary.startsWith(r.report.headline) ? r.report.summary.slice(r.report.headline.length).trim() : r.report.summary),
      compare: r.report && compareOf(r), discussion: r.report && discussionOf(r), gov: r.report && govFor(r) }),
    prep: { needYou: needYou, steps: steps }, executor: d.executor, members: o.projectPath ? d.members.filter(function (m: any): any { return m.catId; }) : d.members, roleMembers: o.projectPath ? d.members.filter(function (m: any): any { return m.catId && m.role !== 'analyze'; }) : d.members, discussion: d.members.filter(function (m: any): any { return m.role === 'analyze' && m.catId; }).map(function (m: any): any { return { id: m.catId, name: m.name }; }), memberIds: { prepare: (d.members.find(function (m: any): any { return m.role === 'prepare'; }) || {}).catId, evaluate: (d.members.find(function (m: any): any { return m.role === 'evaluate'; }) || {}).catId, iterate: (d.members.find(function (m: any): any { return m.role === 'iterate'; }) || {}).catId }, policy: policyOf(d, o), metrics: d.metrics,
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
