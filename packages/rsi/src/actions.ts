import { randomUUID } from 'node:crypto';
import { askEvaluation, controlGroup, finishAnalysis, requestVersion, runCycle } from './cycles.js';
import { hasValidSchedule, parseScheduleText, scheduleOf, scheduleSummary, timeRange } from './schedule.js';
import { summaryOf, objectiveData } from './data.js';
import { enqueue, kick, mention, message, refreshMembers, rsiExpNew, rsiExpReady, rsiExpStaleFrom, setMember, stopOf, stopText, syncObjective, repairCount, repairText, REPAIR_DEFAULT, prepSettled, AUTO, autoKinds, autoKey, autoText } from './init.js';
import type { Data, Experiment, RsiState, Section } from './types.js';

function selected(state: RsiState, body: Data, query: Data) {
  if (body.objective) return body.objective;
  const project = body.project || query.project || 'cartpole';
  const objectives = state.objectives[project] || [];
  const leaves = objectives.filter((o) => !objectives.some((x) => x.parent === o.id));
  const pick = String(query.pick || (typeof body.pick === 'string' && body.pick.startsWith('obj:') ? body.pick : 'obj:cp-converge')).split(':')[1];
  return (leaves.find((o) => o.id === pick) || leaves[0])?.id;
}

function touched(state: RsiState, d: Experiment, item: Data, now: number, what: string) {
  const step = d.steps?.[item.section as Section];
  if (step) step.rev++;
  const stale = step ? rsiExpStaleFrom(d, item.section, false) : [];
  message(state, d, now, `你${what}第 ${d.plan.findIndex((p) => p.k === item.section) + 1} 步「${item.title}」`, item.value + (stale.length ? `\n\n依赖它的第 ${stale.join('、')} 步已标过期；按新版本重做会按依赖顺序重新 @ 对应的成员。` : ''));
}

export function act(state: RsiState, body: Data, query: Data, now: number): Data {
  const project = body.project || query.project || 'cartpole';
  if (!state.objectives[project]) return { error: 'Project not found', status: 404 };
  const id = selected(state, body, query), o = summaryOf(state, id), d = state.experiments[id];
  switch (body.op) {
    case 'refresh': return { ok: true };
    case 'groupRename': {
      const g = (state.groups[project] || []).find((x) => x.id === body.id), name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!g) return { error: 'Group not found', status: 404 };
      if (!name) return { error: 'Provide a name' };
      g.name = name;
      return { ok: true };
    }
    case 'stop': {
      if (!d) return { error: 'Experiment not found', status: 404 };
      const limits = stopOf(body);
      if (limits.error) return limits;
      d.objective.stop = limits.stop;
      Object.assign(d.objective.budget ||= { used: 0 }, { rounds: limits.stop.maxCycles });
      const text = stopText(limits.stop), item = d.prep.find((p) => p.section === 'goal' && p.id.endsWith('-stop'));
      if (item) Object.assign(item, { value: text, state: 'confirmed', by: '你', mine: true, at: now });
      // A finished objective continues under the new conditions; they are checked again after the next conclusion.
      const resumed = d.objective.state === 'done';
      if (resumed) { delete d.objective.stopReason; d.objective.state = 'running'; syncObjective(state, d); }
      message(state, d, now, resumed ? '你改了何时停，接着迭代' : '你改了何时停', text);
      return { ok: true };
    }
    case 'stepMember': {
      // Per-step analysis member: completely independent from execution/governance stage members; applies on next trigger.
      if (!d) return { error: 'Experiment not found', status: 404 };
      const section = body.k as Section;
      if (!d.plan.some((p) => p.k === section)) return { error: 'Initialization step not found', status: 404 };
      if (typeof body.v !== 'string' || !body.v) return { error: 'Choose a member' };
      d.stepMembers ||= {};
      const nextMember = setMember({}, body.v, body.cats);
      d.stepMembers[section] = nextMember;
      message(state, d, now, `你把第 ${d.plan.findIndex((p) => p.k === section) + 1} 步的分析成员换成了 ${nextMember.name}`, '仅影响该分析步骤，下次触发或重试时生效，不影响执行成员。', 'members');
      if (!d.exec?.[section] && (!d.steps?.[section] || (d.steps[section]!.stale && d.steps[section]!.redo))) kick(state, id, now);
      else syncObjective(state, d);
      return { ok: true };
    }
    case 'members': {
      // Execution/governance stage members for upcoming / not-yet-reached stages; completed cycle stages keep their archived executors.
      if (!d) return { error: 'Experiment not found', status: 404 };
      const singleRole = typeof body.role === 'string' && ['prepare', 'evaluate', 'iterate'].includes(body.role) && typeof body.v === 'string' && body.v
        ? { [body.role]: body.v } : {};
      const input: Data = { ...body, ...singleRole };
      const roles = (['prepare', 'evaluate', 'iterate'] as const).filter((role) => typeof input[role] === 'string' && input[role] && input[role] !== d.members.find((m) => m.role === role)?.catId);
      refreshMembers(d.members, body.cats);
      for (const role of roles) {
        const existing = d.members.find((m) => m.role === role);
        const member = existing ? setMember(existing, input[role], body.cats) : (() => { const m = setMember({ role }, input[role], body.cats); d.members.push(m); return m; })();
        message(state, d, now, `你把${{ prepare: '准备', evaluate: '评估分析', iterate: '治理实施' }[role]}执行成员换成了 ${member.name}`, '未执行到的阶段与后续周期将自动使用新成员；已完成周期保留原归档记录。', 'members');
        const waiting = role === 'evaluate' ? d.rounds.find((r: Data) => r.state === 'evaluating') : null;
        if (waiting) askEvaluation(state, d, waiting);
        else if (role === 'iterate' && d.versionRequest)
          enqueue(state, d, 'agent', { member: member.catId, action: 'version', message: { title: '接手', body: `${mention(member)} 治理实施成员换成了你：先调 rsi.task 看轮到你的事。` } });
      }
      syncObjective(state, d);
      return { ok: true };
    }
    case 'repair': {
      if (!d) return { error: 'Experiment not found', status: 404 };
      const repair = repairCount(body.repair);
      if ('error' in repair) return repair;
      d.policy.repair = repair.count;
      const text = repairText(repair.count), item = d.prep.find((p) => p.section === 'goal' && p.id.endsWith('-repair'));
      if (item) Object.assign(item, { value: text, state: 'confirmed', by: '你', mine: true, at: now });
      else d.prep.push({ id: `${d.objective.id}-repair`, section: 'goal', title: '夜里出错自动修', value: text, state: 'confirmed', neededFrom: null, mine: true, by: '你', at: now });
      message(state, d, now, '你改了夜里出错自动修', text);
      return { ok: true };
    }
    case 'schedule': {
      if (!d || !o) return { error: 'Experiment not found', status: 404 };
      const parsed = scheduleOf(body);
      if ('error' in parsed) return parsed;
      d.policy.schedule = parsed.schedule;
      const summary = scheduleSummary(d.policy.schedule);
      o.trigger = String(timeRange(summary) || '');
      message(state, d, now, '你改了执行时段', summary);
      syncObjective(state, d);
      return { ok: true };
    }
    case 'auto': {
      if (!d) return { error: 'Experiment not found', status: 404 };
      const auto = autoKinds(body.auto);
      if ('error' in auto) return auto;
      d.policy.auto = auto.kinds;
      const text = autoText(auto.kinds), item = d.prep.find((p) => p.section === 'goal' && p.id.endsWith('-auto'));
      if (item) Object.assign(item, { value: text, state: 'confirmed', by: '你', mine: true, at: now });
      else d.prep.push({ id: `${d.objective.id}-auto`, section: 'goal', title: '夜里可以自己定的方向', value: text, state: 'confirmed', neededFrom: null, mine: true, by: '你', at: now });
      message(state, d, now, '你改了夜里可以自己定的方向', text);
      return { ok: true };
    }
    case 'delete': {
      // The objective and its sub-objectives, with their data, pending messages and cycle notes. Files are removed by the runtime; the thread stays.
      const owner = Object.keys(state.objectives).find((k) => state.objectives[k].some((x) => x.id === body.objective));
      if (!owner) return { error: 'Objective not found', status: 404 };
      const list = state.objectives[owner], gone = new Set<string>([body.objective]);
      for (let more = true; more;) { more = false; for (const x of list) if (gone.has(x.parent) && !gone.has(x.id)) { gone.add(x.id); more = true; } }
      state.objectives[owner] = list.filter((x) => !gone.has(x.id));
      for (const x of gone) { delete state.experiments[x]; delete state.details[x]; }
      state.groups[owner] = (state.groups[owner] || []).filter((g) => !gone.has(g.forObjective));
      state.outbox = state.outbox.filter((e) => !gone.has(e.objective));
      state.library[owner] = (state.library[owner] || []).flatMap((doc) => {
        const rest = (doc.objectives || []).filter((x: string) => !gone.has(x));
        return doc.cycle && doc.objectives?.length && !rest.length ? [] : [{ ...doc, objectives: rest }];
      });
      return { ok: true };
    }
    case 'new':
    case 'newExp': {
      if (state.projects.find((p) => p.id === project)!.exp) {
        if (body.statement == null) return { ok: true, act: 'dialog', args: { kind: 'rsiNewExp' } };
        if (typeof body.statement !== 'string' || !body.statement.trim() || typeof body.prepare !== 'string' || !body.prepare || typeof body.evaluate !== 'string' || !body.evaluate)
          return { error: 'Provide a statement and prepare/evaluate member ids' };
        if (typeof body.threadMode === 'string' && body.threadMode && !['current', 'new'].includes(body.threadMode))
          return { error: 'Invalid thread mode' };
        const reuseThread = body.projectPath && typeof body.reuseThread === 'string' && body.reuseThread ? body.reuseThread : null;
        if (reuseThread && Object.values(state.experiments).some((x) => x.objective.thread === reuseThread))
          return { error: '当前对话已绑定其他评估项，请改选「新建独立对话」或切换到其他对话' };
        const limits = stopOf(body);
        if (limits.error) return limits;
        const repair = repairCount(body.repair);
        if ('error' in repair) return repair;
        const auto = autoKinds(body.auto);
        if ('error' in auto) return auto;
        const objective = rsiExpNew(state, project, body, now);
        return objective.thread ? { ok: true, act: 'thread', args: { id: objective.thread } } : { ok: true };
      }
      if (body.name == null) return { ok: true, act: 'dialog', args: { kind: 'rsiNew' } };
      if (typeof body.name !== 'string' || !body.name.trim()) return { error: 'Provide an objective name' };
      const id = `obj-${randomUUID()}`;
      state.objectives[project].push({ id, name: body.name, parent: null, state: state.analysis[project] ? 'preparing' : 'analyzing', running: null, cycle: null, prediction: null, locked: 0 });
      state.outbox.push({ id: `${id}-prepare`, kind: 'agent', objective: id, project, section: state.analysis[project] ? 'prepare' : 'analysis' });
      return { ok: true };
    }
    case 'docAdd': {
      const title = body.title ?? body.name;
      if (title == null) return { ok: true, act: 'dialog', args: { kind: 'rsiDocAdd' } };
      if (typeof title !== 'string' || !title.trim()) return { error: 'Provide a document title' };
      state.library[project].push({ id: `doc-${randomUUID()}`, kind: 'provided', title, url: body.url || null, body: body.body || '', objectives: [], by: '你', at: now, state: 'confirmed', sources: [] });
      return { ok: true };
    }
    case 'docConfirm':
    case 'docRemove': {
      const list = state.library[project], at = list.findIndex((doc) => doc.id === body.id);
      if (at < 0) return { error: 'Document not found', status: 404 };
      if (body.op === 'docRemove') list.splice(at, 1); else list[at].state = 'confirmed';
      return { ok: true };
    }
    case 'renameGroup': {
      const group = state.groups[project].find((g) => g.id === body.id);
      if (!group) return { error: 'Capability not found', status: 404 };
      if (typeof body.name !== 'string' || !body.name.trim()) return { error: 'Provide a capability name' };
      group.name = body.name;
      return { ok: true };
    }
    case 'reeval':
      if (body.reason == null && body.note == null) return { ok: true, act: 'dialog', args: { kind: 'rsiReeval', card: body.card } };
      return decideCard(state, body, now);
    case 'decide': return decideCard(state, body, now);
    case 'go':
      if (!o) return { error: 'Objective not found', status: 404 };
      return { ok: true, act: 'plugSet', args: { k: 'pick', v: `obj:${o.id}` } };
    case 'goVersion': {
      if (typeof body.pick !== 'string' || !body.pick.includes('|')) return { error: 'Invalid version selection' };
      return { ok: true, act: 'plugSet', args: { k: 'selO', v: body.pick.slice(body.pick.indexOf('|') + 1) } };
    }
    case 'prep': {
      if (!d || !o) return { error: 'Experiment not found', status: 404 };
      const item = d.prep.find((p) => p.id === body.id);
      if (!item) return { error: 'Preparation item not found', status: 404 };
      if (body.action === 'edit' && body.note == null && item.id.endsWith('-stop') && d.objective.stop) {
        const s = d.objective.stop;
        return { ok: true, act: 'dialog', args: { kind: 'rsiStop', objective: d.objective.id, target: s.target || '', rounds: s.maxCycles || '' } };
      }
      if (body.action === 'edit' && body.note == null && item.id.endsWith('-repair'))
        return { ok: true, act: 'dialog', args: { kind: 'rsiRepair', objective: d.objective.id, repair: String(d.policy.repair ?? REPAIR_DEFAULT) } };
      if (body.action === 'edit' && body.note == null && item.id.endsWith('-auto'))
        return { ok: true, act: 'dialog', args: { kind: 'rsiAuto', objective: d.objective.id, auto: autoKey(d.policy.auto ?? AUTO.default) } };
      if (body.action === 'edit' && body.note == null) return { ok: true, act: 'dialog', args: { kind: 'rsiPrepEdit', id: item.id, title: item.title, value: item.value } };
      if (body.action === 'agent' || (body.action === 'edit' && body.note)) {
        if (body.note !== undefined && typeof body.note !== 'string') return { error: 'Invalid rewrite note' };
        d.steps ||= {}; d.exec ||= {};
        const old = d.steps[item.section];
        touched(state, d, item, now, '让 agent 重写了');
        if (old) { old.stale = true; old.redo = true; }
        item.state = 'preparing'; item.neededFrom = 'agent';
        d.rewrites ||= {}; d.rewrites[item.section] = { item: item.id, note: body.note || '' };
        if (d.objective.state === 'ready') d.objective.state = 'preparing';
        kick(state, id, now);
        return { ok: true };
      }
      if (!['edit', 'confirm', 'decide'].includes(body.action)) return { error: 'Invalid preparation action' };
      if (body.action === 'edit' && typeof body.value !== 'string') return { error: 'Provide an edited value' };
      if (body.action === 'decide' && !['explore', 'fixed', 'excluded'].includes(body.decision)) return { error: 'Invalid scope decision' };
      const edited = body.action === 'edit' && body.value !== item.value;
      if (body.action === 'edit') item.value = body.value;
      if (body.action === 'decide') item.decision = body.decision;
      Object.assign(item, { state: 'confirmed', isDefault: false, by: '你', at: now });
      if (edited && (item.id === 'cp-trigger' || item.section === 'run')) {
        const parsed = parseScheduleText(item.value);
        if (parsed) {
          d.policy.schedule = parsed;
          o.trigger = String(timeRange(scheduleSummary(parsed)) || '');
        }
      }
      if (edited) touched(state, d, item, now, '改了');
      else if (body.action === 'decide' && body.decision !== item.rec) touched(state, d, item, now, `把「${({ explore: '探索', fixed: '固定', excluded: '排除' } as Data)[body.decision]}」选给了`);
      if (rsiExpReady(d)) message(state, d, now, '初始化完成', d.objective.projectPath ? '在页面点跑一轮，按已提交的组和种子执行。' : `每晚 ${d.policy.schedule.window} 跑，第一晚只跑基线 v1。`, 'declare');
      syncObjective(state, d);
      return { ok: true };
    }
    case 'initRedo':
    case 'initStepRefresh':
    case 'initRetry': {
      if (!d || !o) return { error: 'Experiment not found', status: 404 };
      d.steps ||= {}; d.exec ||= {};
      if (body.op === 'initRedo') {
        for (const p of d.plan) if (d.steps[p.k]?.stale) d.steps[p.k]!.redo = true;
      } else if (body.op === 'initStepRefresh') {
        const section = body.k as Section;
        if (!d.plan.some((p) => p.k === section)) return { error: 'Initialization step not found', status: 404 };
        delete d.exec[section];
        const prev = d.steps[section];
        if (prev) { prev.stale = true; prev.redo = true; }
        rsiExpStaleFrom(d, section, false);
        if (d.objective.state === 'ready') d.objective.state = 'preparing';
        message(state, d, now, `你触发了第 ${d.plan.findIndex((p) => p.k === section) + 1} 步重新分析`, '将按当前成员重新调研并保留历史版本快照。');
      } else {
        const section = body.k as Section;
        if (!d.plan.some((p) => p.k === section)) return { error: 'Initialization step not found', status: 404 };
        // A step still counts as running when the member's turn ended without a submission and the host's turn events were lost;
        // the page's 重新叫醒 (force) dispatches it again — a submission from the old dispatch is then rejected as out of date.
        if (d.exec[section]?.state === 'started' && body.force !== true && body.force !== 'true') return { error: 'Initialization step is still running' };
        delete d.exec[section];
        if (d.steps[section]?.stale) d.steps[section]!.redo = true;
      }
      kick(state, id, now);
      return { ok: true };
    }
    case 'draftAnalyst': {
      if (typeof body.catId !== 'string' || !body.catId) return { error: 'Choose a member' };
      // The new-objective dialog adds one member per pick and removes one per ×.
      const others = (state.draft?.analysts || []).filter((a) => a.catId !== body.catId);
      refreshMembers(others, body.cats);
      state.draft = { analysts: body.on === false ? others : [...others, setMember({}, body.catId, body.cats)] };
      return { ok: true };
    }
    case 'analystAdd':
    case 'analystRemove': {
      if (!d) return { error: 'Experiment not found', status: 404 };
      if (typeof body.catId !== 'string' || !body.catId) return { error: 'Choose a member' };
      const add = body.op === 'analystAdd';
      d.members = d.members.filter((m) => !(m.role === 'analyze' && m.catId === body.catId));
      refreshMembers(d.members, body.cats);
      if (add) {
        const added = setMember({ role: 'analyze' }, body.catId, body.cats);
        d.members.push(added);
        // If a cycle is currently awaiting discussion proposals, enroll and wake the newly added analyst immediately.
        for (const r of d.rounds) if (r.analysis?.waiting?.length && !r.analysis.waiting.includes(added.catId)) {
          r.analysis.waiting.push(added.catId);
          enqueue(state, d, 'agent', { member: added.catId, cycle: r.n, action: 'direction', message: { title: `第 ${r.n} 周期：请给方向`,
            body: `${mention(added)} 你已加入本评估项方案讨论：调 rsi.task 看第 ${r.n} 周期结论与同周期对照，再调 rsi.propose 交你的方向。` } });
        }
      }
      // A removed analyst no longer holds up a conclusion.
      else for (const r of d.rounds) if (r.analysis?.waiting.includes(body.catId)) {
        r.analysis.waiting = r.analysis.waiting.filter((id: string) => id !== body.catId);
        if (!r.analysis.waiting.length) finishAnalysis(state, d, r, now);
      }
      syncObjective(state, d);
      return { ok: true };
    }
    case 'evalAgain': {
      const round = d?.rounds.find((r: Data) => r.state === 'evaluating');
      if (!d || !round) return { error: 'No cycle is waiting for its conclusion', status: 404 };
      askEvaluation(state, d, round);
      return { ok: true };
    }
    case 'discussAgain': {
      const round = d?.rounds.find((r: Data) => r.analysis?.waiting?.length);
      if (!d || !round) return { error: 'No cycle is waiting for discussion proposals', status: 404 };
      for (const catId of round.analysis.waiting as string[]) {
        const m = d.members.find((x) => x.catId === catId) || { catId, name: catId };
        enqueue(state, d, 'agent', { member: catId, cycle: round.n, action: 'direction', message: { title: `第 ${round.n} 周期：请给方向（重发）`,
          body: `${mention(m)} 第 ${round.n} 周期仍在等你给方向：调 rsi.task 读取结论与对照，再调 rsi.propose 提交。` } });
      }
      return { ok: true };
    }
    case 'versionAgain': {
      if (!d || !d.versionRequest) return { error: 'No version request is pending', status: 404 };
      const member = d.members.find((m) => m.role === 'iterate');
      if (!member?.catId) return { error: 'Assign a governance execution member first' };
      enqueue(state, d, 'agent', { member: member.catId, action: 'version', message: { title: d.versionRequest.repair ? `重发：修第 ${d.versionRequest.cycle} 周期的运行失败` : '重发：准备下一个版本',
        body: `${mention(member)} 重新触发治理任务「${d.versionRequest.title}」：先调 rsi.task 看要求，完成后调 rsi.version 提交。` } });
      return { ok: true };
    }
    case 'runCycle':
      return d?.objective.projectPath ? runCycle(state, d, now) : { error: 'Select a real experimental project' };
    case 'life': {
      if (!o) return { error: 'Objective not found', status: 404 };
      if (!['start', 'pause', 'resume', 'retry', 'more'].includes(body.action)) return { error: 'Invalid lifecycle action' };
      if (d?.objective.projectPath && body.action === 'retry') return runCycle(state, d, now);
      if (d?.objective.projectPath && ['done', 'retired'].includes(d.objective.state)) return { error: 'Objective has stopped' };
      const objective = d ? d.objective : o;
      if (body.action === 'start') {
        if (d?.objective.projectPath && !hasValidSchedule(d.policy.schedule)) return { error: '请先在策略区配置「运行时段」或完成第 3 步，也可先手动点「跑一轮」' };
        if (objective.state !== 'ready') return { error: 'Objective is not ready' };
        objective.state = d ? 'running' : 'baseline';
      } else if (body.action === 'pause') {
        if (objective.state !== 'paused') objective.resumeTo = objective.state;
        objective.state = 'paused';
      } else if (body.action === 'resume') {
        if (objective.state !== 'paused') return { error: 'Objective is not paused' };
        objective.state = objective.resumeTo; delete objective.resumeTo;
      } else if (body.action === 'more') {
        if (d) d.objective.budget.rounds = (d.objective.budget.rounds || 0) + 10;
        else if (state.details[id]?.trigger) state.details[id].trigger.evals.max += 10;
      }
      if (d) {
        if (body.action === 'pause' || body.action === 'resume') {
          d.executor.off = body.action === 'pause';
          for (const g of state.groups[project]) if (g.forObjective === id || (g.kind === 'mcp' && g.name.includes(d.executor.mcp))) g.off = d.executor.off;
          enqueue(state, d, 'executor', { action: d.executor.off ? 'disable' : 'enable' });
        } else enqueue(state, d, body.action === 'retry' ? 'run' : 'schedule', { action: body.action, plan: d.upcoming || null, schedule: d.policy.schedule });
        syncObjective(state, d);
      } else state.outbox.push({ id: `${id}-${randomUUID()}`, kind: body.action === 'retry' ? 'reevaluate' : 'schedule', objective: id, action: body.action });
      return { ok: true };
    }
    case 'lock':
    case 'addMetric': {
      if (!o) return { error: 'Objective not found', status: 404 };
      const detail = d || state.details[id];
      if (!detail) return { error: 'Metrics not found', status: 404 };
      const versions = detail.metrics.versions, last = versions?.[versions.length - 1];
      const items = last ? last.items : detail.metrics.items;
      if (body.op === 'lock') {
        const metric = items.find((m: Data) => m.id === body.metric);
        if (!metric) return { error: 'Metric not found', status: 404 };
        metric.locked = body.locked === 'true' || body.locked === true;
        o.locked = items.filter((m: Data) => m.locked).length;
        if (last) { last.locked = o.locked; last.working = items.length - o.locked; detail.metrics.items = last.items; }
      } else {
        if (body.name == null) return { ok: true, act: 'dialog', args: { kind: 'rsiAddMetric' } };
        if (typeof body.name !== 'string' || !body.name.trim()) return { error: 'Provide a metric name' };
        const metric = { id: `m-${randomUUID()}`, name: body.name, kind: 'semantic', measure: 'semantic', rule: 'evidence-only', trigger: 'weekly', how: body.how || '', logic: body.how || '', added: true, locked: false };
        const version = `E${last ? versions.length + 1 : Number(detail.metrics.version.slice(1)) + 1}`;
        if (last) {
          last.progress = null;
          versions.push({ id: version, parent: last.id, evals: [], items: items.concat(metric), locked: last.locked, working: last.working + 1, at: now, diff: { add: 1, del: 0, mod: 0 }, basis: `人工添加「${body.name}」`, by: 'human', progress: { since: 0, needN: 3, noChange: 0, needK: 4 }, objectiveVersions: [] });
          detail.metrics.items = versions[versions.length - 1].items;
          o.running.e = version;
        } else {
          detail.metrics.items = items.concat(metric);
          detail.metrics.version = version;
        }
      }
      return { ok: true };
    }
    case 'policy': {
      const detail = objectiveData(state, id)?.detail;
      if (!detail) return { error: 'Objective not found', status: 404 };
      const value = body.v ?? body.value;
      if (!['count', 'days', 'interval', 'counter', 'approval', 'everyN', 'noChangeK', 'eval', 'iterate', 'metrics'].includes(body.key) || typeof value !== 'string') return { error: 'Invalid policy setting' };
      detail.policy ||= {};
      if (value === '') delete detail.policy[body.key]; else detail.policy[body.key] = isNaN(+value) ? value : +value;
      return { ok: true };
    }
    case 'expDecide': {
      if (!d) return { error: 'Experiment not found', status: 404 };
      const round = d.rounds.find((r: Data) => r.n === +body.n);
      if (!round?.report) return { error: 'Round report not found', status: 404 };
      if (!['direction', 'same', 'info', 'addVar', 'metric', 'goal'].includes(body.pick)) return { error: 'Invalid experiment decision' };
      if (body.pick !== 'direction' && body.pick !== 'same' && body.note == null) return { ok: true, act: 'dialog', args: { kind: 'rsiExpNote', n: body.n, pick: body.pick, directionId: body.directionId } };
      if (body.pick === 'direction' && !round.report.directions.some((x: Data) => x.id === body.directionId)) return { error: 'Direction not found', status: 404 };
      if (round.decision) return { error: 'Round already decided', status: 409 };
      round.decision = { pick: body.pick, directionId: body.directionId ?? null, note: body.note ?? '', by: '你', at: now };
      const n = round.n + 1, current = round.plan.groups[0];
      if (d.objective.projectPath) {
        if (['done', 'paused', 'retired'].includes(d.objective.state)) return { ok: true };
        d.objective.state = 'running';
        if (d.candidate || body.pick === 'same') {
          if (!d.candidate) d.upcoming = { ...round.plan, groups: [controlGroup(d)] };
          message(state, d, now, d.candidate ? '下一周期：确认赢家' : '下一周期：当前版本对照', '在已确认的时段运行，也可点「跑一轮」。', 'plan');
          syncObjective(state, d);
          return { ok: true };
        }
        requestVersion(state, d, round);
        return { ok: true };
      }
      d.objective.state = 'running'; d.objective.round = n;
      const plan = { baseline: false, groups: [{ id: `r${n}-control`, label: '当前版本对照', version: d.objective.currentVersion, vars: { ...current.vars }, control: true, confirm: false }], seeds: [...round.plan.seeds], window: d.policy.schedule.window, by: 'auto' };
      d.rounds.push({ n, version: d.objective.currentVersion, start: null, end: null, state: 'planned', plan, runs: [], report: null, decision: null, events: [] });
      message(state, d, now, '今晚计划：当前版本对照', round.decision.note || '按当前计划照旧，只在声明范围内调变量。', 'plan');
      enqueue(state, d, 'agent', { action: 'decide', round: round.n, decision: round.decision, plan });
      syncObjective(state, d);
      return { ok: true };
    }
    default: return { error: 'Unknown operation' };
  }
}

function decideCard(state: RsiState, body: Data, now: number): Data {
  const detail = Object.values(state.details).find((d) => d.cards[body.card]);
  if (!detail) return { error: 'Card not found', status: 404 };
  const decision = body.op === 'reeval' ? 'reevaluate' : body.decision;
  if (!['reevaluate', 'apply', 'skip'].includes(decision)) return { error: 'Invalid card decision' };
  const card = detail.cards[body.card], cycle = detail.cycles.find((c: Data) => c.id === card.cycle), o = summaryOf(state, detail.id)!;
  if (decision === 'reevaluate') {
    card.round++; card.reasons.push(body.reason ?? body.note ?? '');
    state.outbox.push({ id: `${card.id}-reevaluate-${card.round}`, kind: 'reevaluate', objective: detail.id, card: card.id, reason: body.reason ?? body.note ?? '' });
    return { ok: true };
  }
  delete detail.cards[card.id];
  cycle.card = { result: decision, by: 'human' };
  const trigger = detail.trigger;
  if (decision === 'apply') {
    const from = detail.versions.find((v: Data) => v.id === card.from);
    detail.versions.push({ id: card.to, parent: card.from, kind: 'evolve', e: from.e, c: from.c, at: now, change: card.actions.map((a: Data) => ({ unit: a.unit, unitName: a.unitName, op: a.op, from: a.from, to: a.to })), prediction: 'pending', predictions: card.predictions });
    cycle.decision = 'evolve'; cycle.to = card.to;
    trigger.cur = trigger.ladder[Math.max(0, trigger.ladder.indexOf(trigger.cur) - 1)];
    detail.cycles.push({ id: `${card.to}-1`, version: card.to, n: 1, windows: [[now, now]], trigger: null, samples: 0, decision: 'collecting' });
    detail.live = detail.metrics.items.filter((m: Data) => m.measure === 'counter').map((m: Data) => ({ name: m.name, value: 0 }));
    Object.assign(o, { state: 'collecting', running: { o: card.to, e: from.e, c: from.c }, cycle: { got: 0, need: trigger.cur }, prediction: 'pending' });
    state.outbox.push({ id: `${card.id}-apply`, kind: 'executor', objective: detail.id, action: 'apply', changes: card.actions });
  } else {
    cycle.decision = 'keep';
    const n = detail.cycles.filter((c: Data) => c.version === card.from).length + 1;
    detail.cycles.push({ id: `${card.from}-${n}`, version: card.from, n, windows: cycle.windows.concat([[cycle.windows[cycle.windows.length - 1][1], now]]), trigger: null, samples: 0, decision: 'collecting' });
    Object.assign(o, { state: 'collecting', cycle: { got: 0, need: trigger.cur } });
  }
  trigger.any = trigger.any.map((x: Data) => ({ ...x, got: 0, need: x.k === 'count' ? trigger.cur : x.need }));
  trigger.must = [{ k: 'interval', got: 0, need: 1 }];
  return { ok: true };
}
