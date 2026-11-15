import type { Data, RsiState } from './types.js';

export function summaryOf(state: RsiState, id: string): Data | undefined {
  return Object.values(state.objectives).flat().find((o) => o.id === id);
}

export function detailOf(state: RsiState, id: string): Data {
  return state.details[id] || { id, units: [], versions: [], cycles: [], cards: {}, metrics: { versions: [], items: [] }, collection: { versions: [] }, trigger: null, live: [] };
}

export function objectiveData(state: RsiState, id: string): Data | undefined {
  const objective = summaryOf(state, id);
  if (!objective) return undefined;
  const project = Object.keys(state.objectives).find((k) => state.objectives[k].includes(objective))!;
  return { objective, detail: objective.mode === 'exp' ? state.experiments[id] : detailOf(state, id), projectPolicy: state.policy[project] };
}

export function memberIds(state: RsiState): string[] {
  return [...new Set(Object.values(state.experiments).flatMap((d) => d.members.map((m) => m.catId)).filter((id): id is string => !!id))];
}

function rsiRand(seed: number) { let r = seed; return () => { r = (r * 9301 + 49297) % 233280; return r / 233280; }; }

const RSI_TRACE_EVENT: Data = {
  'c-f257': function (r: any): any { return '注入 ' + ['D1', 'L2', 'S1', 'R3', 'N1', 'C1'][Math.floor(r() * 6)] + ' 段 r' + (1 + Math.floor(r() * 4)) + '，命中条件「' + ['任务开始', '跨 thread 回复', '工具调用前', '唤醒后'][Math.floor(r() * 4)] + '」'; },
  'c-guard': function (r: any): any { return 'Guard 拒绝 ' + ['cat_cafe_post_message', 'cat_cafe_create_task', 'git push'][Math.floor(r() * 3)] + '（' + ['目标不在成员里', '没有授权', '不可逆操作'][Math.floor(r() * 3)] + '），ledger g-' + (4100 + Math.floor(r() * 900)); },
  'c-thread': function (r: any, cat?: any): any { return '@' + cat + ' 回复，invocation 终态「' + ['完成', '完成', '完成', '中断'][Math.floor(r() * 4)] + '」'; },
  'c-mcp': function (r: any): any { return '调用 ' + ['cat_cafe_search_evidence', 'cat_cafe_post_message', 'cat_cafe_graph_resolve', 'cat_cafe_list_recent'][Math.floor(r() * 4)] + ' → 成功'; }
};
export function projectOf(state: RsiState, p: Data): Data {
  const FX_RSI = state, FX_RSI_DETAIL = state.details, FX_RSI_EXP = state.experiments, MOCK_NOW = state.now;
  const rsiAgo = (d: number, h = 0) => MOCK_NOW - d * 86400e3 - h * 3600e3;

  return { project: FX_RSI.projects.find(function (x: any): any { return x.id === p.projectId; }), analysis: FX_RSI.analysis[p.projectId] || null, hostKinds: FX_RSI.hostKinds, groups: FX_RSI.groups[p.projectId], units: FX_RSI.units[p.projectId], objectives: FX_RSI.objectives[p.projectId] };

}

export function todoOf(state: RsiState, p: Data): Data {
  const FX_RSI = state, FX_RSI_DETAIL = state.details, FX_RSI_EXP = state.experiments, MOCK_NOW = state.now;
  const rsiAgo = (d: number, h = 0) => MOCK_NOW - d * 86400e3 - h * 3600e3;

  const items: Data[] = [];
  FX_RSI.objectives[p.projectId].forEach(function (o: any): any {
    if (o.mode === 'exp') {
      var exp = FX_RSI_EXP[o.id];
      if (o.state === 'ready') items.push({ id: 'ready-' + o.id, kind: 'ready', objective: o.id, at: MOCK_NOW });
      if (o.state === 'pending') {
        var round = exp.rounds[exp.rounds.length - 1], message = exp.messages[exp.messages.length - 1];
        items.push({ id: message.id, kind: message.kind, objective: o.id, round: round.n, at: message.at, title: message.title, body: message.body,
          ask: message.ask, ifIgnored: message.ifIgnored, report: round.report, actions: [] });
      }
      exp.prep.forEach(function (item: any): any {
        if (item.neededFrom === 'human' && item.state !== 'confirmed') items.push({ id: item.id, kind: 'prep', objective: o.id, round: 0, at: item.at,
          title: item.title, value: item.value, state: item.state, isDefault: item.isDefault, ask: '确认、手动改或让准备成员补。', ifIgnored: item.note, actions: [] });
      });
      return;
    }
    const d = FX_RSI_DETAIL[o.id];
    if (d) Object.keys(d.cards).forEach(function (k: any): any { items.push(Object.assign({}, d.cards[k], { kind: 'card', cardKind: d.cards[k].kind, objective: o.id, at: rsiAgo(0, 2) })); });
    if (o.state === 'stalled') { const last = d.cycles[d.cycles.length - 1]; items.push({ id: 'stalled-' + o.id, kind: 'stalled', objective: o.id, stalledAt: last.stalledAt, thread: last.stalledAt === 'gov' ? d.threads.iterate : d.threads.eval, at: rsiAgo(0, 3) }); }
    if (o.state === 'exhausted') items.push({ id: 'exhausted-' + o.id, kind: 'exhausted', objective: o.id, at: rsiAgo(1) });
    if (o.state === 'ready') items.push({ id: 'ready-' + o.id, kind: 'ready', objective: o.id, at: MOCK_NOW });
  });
  return { items: items };

}

export function cardsOf(state: RsiState, p: Data): Data {
  const FX_RSI = state, FX_RSI_DETAIL = state.details, FX_RSI_EXP = state.experiments, MOCK_NOW = state.now;
  const rsiAgo = (d: number, h = 0) => MOCK_NOW - d * 86400e3 - h * 3600e3;

  const cards: Data[] = [];
  FX_RSI.objectives[p.projectId].forEach(function (o: any): any {
    if (o.mode === 'exp') {
      todoOf(state, p).items.forEach(function (item: any): any { if (item.objective === o.id) cards.push(item); });
      return;
    }
    const d = detailOf(state, o.id); Object.keys(d.cards).forEach(function (k: any): any { cards.push(Object.assign({ objective: o.id, at: rsiAgo(0, 2) }, d.cards[k])); });
  });
  return { cards: cards };

}

export function libraryOf(state: RsiState, p: Data): Data {
  const FX_RSI = state, FX_RSI_DETAIL = state.details, FX_RSI_EXP = state.experiments, MOCK_NOW = state.now;
  const rsiAgo = (d: number, h = 0) => MOCK_NOW - d * 86400e3 - h * 3600e3;

  return { docs: (state.library[p.projectId] || []).map(function (doc: any): any {
    const usedBy: Data[] = [];
    FX_RSI.objectives[p.projectId].forEach(function (o: any): any {
      if (o.mode === 'exp') {
        var exp = FX_RSI_EXP[o.id];
        if (exp.rounds.some(function (round: any): any { return round.state === 'done' && round.report.directions.some(function (direction: any): any { return direction.cites.indexOf(doc.id) >= 0; }); })) usedBy.push({ objective: o.id, e: exp.metrics.version });
        return;
      }
      const d = FX_RSI_DETAIL[o.id]; if (d) d.metrics.versions.forEach(function (v: any): any { if (v.evals.some(function (x: any): any { return (x.refs || []).indexOf(doc.id) >= 0; })) usedBy.push({ objective: o.id, e: v.id }); });
    });
    return Object.assign({ usedBy: usedBy }, doc);
  }) };

}

export function tracesOf(state: RsiState, p: Data): Data {
  const FX_RSI = state, FX_RSI_DETAIL = state.details, FX_RSI_EXP = state.experiments, MOCK_NOW = state.now;
  const rsiAgo = (d: number, h = 0) => MOCK_NOW - d * 86400e3 - h * 3600e3;
  const RSI_H = 3600e3;

  const d = detailOf(state, p.objectiveId), groups = FX_RSI.groups[d.project] || [];
  const cats = [...new Set([...memberIds(state), ...Object.values(state.policy).flatMap((p) => [p.eval, p.iterate, p.metrics])])].map((id) => ({ id, displayName: id }));
  const threads = Object.values(d.threads || {}).map((id) => ({ id, title: id }));
  const ofC = function (v: any): any { return (d.versions.find(function (x: any): any { return x.id === v; }) || {}).c; };
  const cs = d.cycles.filter(function (x: any): any { return p.cycle ? x.id === p.cycle : ofC(x.version) === p.c; }).reverse();
  const cv = d.collection.versions.find(function (x: any): any { return x.id === (p.c || ofC(cs[0] && cs[0].version)); });
  const points = (cv ? cv.points : []).map(function (id: any): any { return groups.find(function (g: any): any { return g.id === id; }); });
  const structural = d.metrics.items.filter(function (m: any): any { return m.kind === 'structural'; });
  const items: Data[] = [];
  cs.forEach(function (x: any): any {
    const end = x.windows[x.windows.length - 1][1], start = x.windows[0][0], n = Math.min(x.samples, 20 - items.length);
    for (let k = 0; k < n; k++) {
      const r = rsiRand(x.n * 1000 + k + p.objectiveId.length * 7), at = end - (k + r()) * Math.min(RSI_H, (end - start) / Math.max(1, x.samples)), cat = cats[Math.floor(r() * cats.length)];
      const counter = structural.length && r() < 0.18, bad = counter && structural[Math.floor(r() * structural.length)];
      const events = points.map(function (g: any, i: any): any { return { at: at + i * 9e3, source: g.name, text: (RSI_TRACE_EVENT[g.id] || function (): any { return g.where; })(r, cat.displayName), raw: JSON.stringify({ point: g.id, at: new Date(at + i * 9e3).toISOString(), cat: cat.id, version: x.version }, null, 2) }; });
      if (bad) events.push({ at: at + events.length * 9e3, source: bad.name, text: '命中「' + bad.name + '」：' + d.statement, state: 'hit', raw: '// rules/' + (bad.ruleRef || bad.id) + '.ts\nincidentKey: ' + x.id + ':' + (k + 1) + '\nmatched: true' });
      const t = threads[Math.floor(r() * threads.length)];
      items.push({ id: 'tr-' + x.id + '-' + (k + 1), at: at, cycleId: x.id, cycle: x.n, version: x.version, c: cv && cv.id, cat: cat.displayName, counter: !!counter,
        thread: d.project === 'self' ? t.id : null, source: d.project === 'self' ? t.title : 'session ' + Math.floor(r() * 0xffffff).toString(16),
        type: 'trace', points: points.map(function (g: any): any { return g.name; }), events: events, results: structural.map(function (m: any): any { return { name: m.name, pass: m !== bad }; }) });
    }
  });
  return { total: cs.reduce(function (a: any, x: any): any { return a + x.samples; }, 0), items: items };

}

export function runsOf(state: RsiState, p: Data): Data {
  const FX_RSI = state, FX_RSI_DETAIL = state.details, FX_RSI_EXP = state.experiments, MOCK_NOW = state.now;
  const rsiAgo = (d: number, h = 0) => MOCK_NOW - d * 86400e3 - h * 3600e3;

  const d = detailOf(state, p.objectiveId), x = d.cycles.find(function (c: any): any { return c.id === p.cycle; });
  if (!x || ['evolve', 'rollback'].indexOf(x.decision) < 0) return { items: [] };
  const ver = function (id: any): any { return d.versions.find(function (v: any): any { return v.id === id; }) || {}; };
  const changes = x.decision === 'evolve' ? ver(x.to).change || [] : (ver(x.version).change || []).map(function (c: any): any { return Object.assign({}, c, { from: c.to, to: c.from }); });
  const at0 = x.windows[x.windows.length - 1][1] + 6e5, by = x.card ? x.card.by : 'human';
  return { items: changes.map(function (c: any, i: any): any {
    const u = FX_RSI.units[d.project].find(function (y: any): any { return y.id === c.unit; }) || {}, g = FX_RSI.groups[d.project].find(function (y: any): any { return y.id === u.group; }) || {};
    const apply = u.apply || g.apply || 'direct', to = c.to || '', from = c.from || '', at = at0 + i * 3e5, n = 1600 + (x.n * 37 + i * 11) % 300, step = function (k: any, name: any, text: any, raw?: any): any { return { at: at + k * 6e4, source: name, text: text, raw: raw }; };
    const run = (g.run || '').replace(/\{unit\}/g, c.unitName).replace(/\{version\}/g, to);
    const steps = apply === 'pr' ? [
      step(0, '建 worktree', 'git worktree add ../rsi-' + to + ' -b rsi/' + d.id + '/' + to, 'Preparing worktree (new branch \'rsi/' + d.id + '/' + to + '\')\nHEAD is now at 3f2a9c1'),
      step(1, '改动', '迭代 thread 在 worktree 里改 ' + c.unitName, ' src/select.ts       | 24 +++++++++++-----\n src/select.test.ts  | 31 ++++++++++++++++++\n 2 files changed, 47 insertions(+), 8 deletions(-)'),
      step(2, '开 PR', 'PR #' + n + '：' + c.unitName + ' ' + from + ' → ' + to),
      step(9, 'CI', '检查全部通过', '✓ lint (32s)\n✓ unit (1m48s)\n✓ e2e (4m02s)'),
      step(30, '合入', 'PR #' + n + ' 已合入，worktree 已清理（合入即止）')]
    : apply === 'script' ? [
      step(0, '拉起', '在 ' + d.project + ' 里启动执行环境', 'cwd: ~/workspace/' + d.project + '\nshell: zsh\nenv: RSI_OBJECTIVE=' + d.id + ' RSI_VERSION=' + to),
      step(1, '执行脚本', run, '> ' + run + '\ncopying ' + c.unitName + '@' + to + ' → .claude/skills/' + c.unitName + '\nvalidating SKILL.md … ok\ndone in 2.4s'),
      step(2, '退出', '退出码 0'),
      step(3, '检查', c.unitName + ' 已加载 ' + to)]
    : [
      step(0, '写入', c.unitName + ' ' + (from ? from + ' → ' : '') + to + ' 写入 F257 override 层', '--- ' + c.unitName + '@' + from + '\n+++ ' + c.unitName + '@' + to + '\n@@ 触发条件 @@\n- when: task.start\n+ when: task.start || tool.before'),
      step(1, '生效', '下一次注入起用 ' + to)];
    return { id: 'run-' + x.id + '-' + (i + 1), type: 'run', cycleId: x.id, at: at, op: c.op || 'modify', unit: c.unit, unitName: c.unitName, from: from, to: to, apply: apply, run: run, by: by, state: 'done',
      pr: apply === 'pr' ? '#' + n : null, events: steps,
      results: (apply === 'pr' ? ['CI', 'Review'] : apply === 'script' ? ['退出码 0', '加载检查'] : ['段加载', '注入条件和预期一致']).map(function (k: any): any { return { name: k, pass: true }; }) };
  }) };

}
