import { editHypothesis } from './hypotheses.js';
import { tierEvidence, tiersOf } from './tiers.js';
import { randomUUID } from 'node:crypto';
import { askEvaluation, buildCloseoutReport, controlGroup, cycleVarsConflicts, finishAnalysis, freshSeeds, needsCycleVars, notifyAwaitingCycleVars, requestVersion, runCycle } from './cycles.js';
import { formatPolicy, hasValidSchedule, parseMaxRuns, parseScheduleText, policiesOf, scheduleOf, scheduleSummary, timeRange, validatePolicy } from './schedule.js';
import { summaryOf, objectiveData } from './data.js';
import { clipTitle, enqueue, kick, mention, message, refreshMembers, rsiExpNew, rsiExpReady, rsiExpStaleFrom, setMember, stopOf, stopText, syncObjective, repairCount, repairText, REPAIR_DEFAULT, prepSettled, AUTO, autoKinds, autoKey, autoText } from './init.js';
import { record } from './store.js';
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
  const stale = step && !(item.section === 'run' && d.rounds.length > 0) ? rsiExpStaleFrom(d, item.section, false) : [];
  message(state, d, now, `你${what}第 ${d.plan.findIndex((p) => p.k === item.section) + 1} 步「${item.title}」`, item.value + (stale.length ? `\n\n依赖它的第 ${stale.join('、')} 步已标过期；按新版本重做会按依赖顺序重新 @ 对应的成员。` : ''));
}

function dispatchDecision(state: RsiState, d: Experiment, round: Data, now: number) {
  d.objective.state = 'running';
  if (d.candidate || round.decision.pick === 'same') {
    if (!d.candidate) {
      const { reservedSeeds: _dropReserved, requiresExplicitPlan: _dropReq, cycleVars: _dropCycleVars, ...basePlan } = round.plan;
      const confirmSeedCount = d.policy.confirmSeeds || round.plan.seeds.length;
      d.upcoming = d.policy.tiers
        ? { ...basePlan, seeds: basePlan.tierRule?.seedPolicy === 'fixed' ? [...basePlan.seeds] : freshSeeds(d, basePlan.seeds.length) }
        : { ...basePlan, tier: 'confirm', skipControl: false, seeds: freshSeeds(d, confirmSeedCount), groups: [controlGroup(d)] };
    }
    message(state, d, now, d.candidate ? '下一周期：确认赢家' : '下一周期：当前版本对照', needsCycleVars(d) ? '下一周期计划已就绪；因已启用每轮前绑定 cycleVars 门禁，待绑定本轮参数后启动。' : '在已确认的时段运行，也可点「跑一轮」。', 'plan');
    notifyAwaitingCycleVars(state, d, now, d.candidate ? `第 ${round.n} 周期已确认进入候选复验` : `第 ${round.n} 周期决定沿用当前计划`);
    syncObjective(state, d);
    return;
  }
  requestVersion(state, d, round, now);
}

export function act(state: RsiState, body: Data, query: Data, now: number, actor = '你'): Data {
  const project = body.project || query.project || 'cartpole';
  if (!state.objectives[project]) return { error: 'Project not found', status: 404 };
  const id = selected(state, body, query), o = summaryOf(state, id), d = state.experiments[id];
  switch (body.op) {
    case 'hypothesis': return d ? editHypothesis(d, body, actor, now) : { error: 'Experiment not found', status: 404 };
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
      const curStop = d.objective.stop || {};
      const nextInput = body.field === 'target'
        ? { target: body.v ?? body.target ?? '', rounds: curStop.maxCycles ? String(curStop.maxCycles) : '' }
        : body.field === 'rounds'
          ? { target: curStop.target || '', rounds: body.v ?? body.rounds ?? '' }
          : body;
      const limits = stopOf(nextInput);
      if (limits.error) return limits;
      d.objective.stop = limits.stop;
      Object.assign(d.objective.budget ||= { used: 0 }, { rounds: limits.stop.maxCycles });
      const text = stopText(limits.stop), item = d.prep.find((p) => p.section === 'goal' && p.id.endsWith('-stop'));
      if (item) Object.assign(item, { value: text, state: 'confirmed', by: '你', mine: true, at: now });
      // A finished objective continues under the new conditions; they are checked again after the next conclusion.
      const resumed = d.objective.state === 'done';
      if (resumed) {
        delete d.objective.stopReason;
        delete d.closeoutReport;
        d.objective.state = d.rounds.some((r: Data) => r.report && !r.decision) ? 'pending' : 'running';
        for (const r of d.rounds) {
          if (r.report && !r.decision && r.asked) r.asked = now;
          if (r.analysis?.waiting?.length) {
            r.analysis.since = now;
            r.analysis.askedAt = now;
            delete r.analysis.unclaimedNotified;
          }
          if (r.state === 'evaluating') {
            r.evalAskedAt = now;
            if (!r.invocationId) delete r.evalStalledNotified;
          }
        }
        if (d.executor.off) {
          d.executor.off = false;
          for (const g of state.groups[project]) if (g.forObjective === id || (g.kind === 'mcp' && g.name.includes(d.executor.mcp))) g.off = false;
          enqueue(state, d, 'executor', { action: 'enable' });
        }
        syncObjective(state, d);
      }
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
      message(state, d, now, `${actor}把第 ${d.plan.findIndex((p) => p.k === section) + 1} 步的分析成员换成了 ${nextMember.name}`, '仅影响该分析步骤，下次触发或重试时生效，不影响执行成员。', 'members');
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
      if (d.stepMembers) refreshMembers(Object.values(d.stepMembers), body.cats);
      if (d.policy?.manager?.catId) refreshMembers([d.policy.manager], body.cats);
      for (const role of roles) {
        const existing = d.members.find((m) => m.role === role);
        const member = existing ? setMember(existing, input[role], body.cats) : (() => { const m = setMember({ role }, input[role], body.cats); d.members.push(m); return m; })();
        message(state, d, now, `你把${{ prepare: '准备', evaluate: '评估分析', iterate: '治理实施' }[role]}执行成员换成了 ${member.name}`, '未执行到的阶段与后续周期将自动使用新成员；已完成周期保留原归档记录。', 'members');
        const waiting = role === 'evaluate' ? d.rounds.find((r: Data) => r.state === 'evaluating') : null;
        if (waiting) askEvaluation(state, d, waiting, false, now);
        else if (role === 'iterate' && d.versionRequest) {
          d.versionRequest.since = now;
          delete d.versionRequest.invocationId;
          delete d.versionRequest.stalledNotified;
          enqueue(state, d, 'agent', { member: member.catId, cycle: d.versionRequest.cycle, action: 'version', message: { title: '接手', body: `${mention(member)} 治理实施成员换成了你：先调原生 MCP 工具 rsi_task 看轮到你的事。` } });
        }
      }
      syncObjective(state, d);
      return { ok: true };
    }
    case 'goalEdit': {
      if (!d || !o) return { error: 'Experiment not found', status: 404 };
      const nextText = typeof (body.v ?? body.statement) === 'string' ? String(body.v ?? body.statement).trim() : '';
      if (!nextText) return { error: '请输入评估目标' };
      d.objective.goal = { ...(d.objective.goal || {}), statement: nextText };
      const clipped = clipTitle(nextText, 48, d.objective.id);
      d.objective.name = clipped;
      o.name = clipped;
      const goalItem = d.prep.find((p) => p.section === 'goal' && p.id.endsWith('-goal'));
      if (goalItem) Object.assign(goalItem, { value: nextText, state: 'confirmed', by: '你', mine: true, at: now });
      message(state, d, now, '你更新了评估目标', nextText);
      syncObjective(state, d);
      return { ok: true, act: 'plugSet', args: { k: 'editGoal', v: '' } };
    }
    case 'maxRuns': {
      if (!d || !o) return { error: 'Experiment not found', status: 404 };
      const parsed = parseMaxRuns(body.v ?? body.maxRuns);
      if ('error' in parsed) return parsed;
      d.policy.schedule ||= { window: '' };
      if (parsed.maxRuns) d.policy.schedule.maxRuns = parsed.maxRuns;
      else delete d.policy.schedule.maxRuns;
      message(state, d, now, '你改了时间窗内最大执行次数', parsed.maxRuns ? `最多 ${parsed.maxRuns} 次` : '不限制');
      syncObjective(state, d);
      return { ok: true };
    }
    case 'repair': {
      if (!d) return { error: 'Experiment not found', status: 404 };
      const repair = repairCount(body.repair ?? body.v);
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
    case 'policyEditOpen': {
      if (!d || !o) return { error: 'Experiment not found', status: 404 };
      const existingList = policiesOf(d.policy.schedule);
      const editId = typeof body.policyId === 'string' && body.policyId.trim() ? body.policyId.trim() : '';
      const found = editId ? existingList.find((p) => p.id === editId) : null;
      const todayDate = new Date(now);
      const todayYmd = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, '0')}-${String(todayDate.getDate()).padStart(2, '0')}`;
      const anchorTs = found?.dateFrom ? new Date(`${found.dateFrom}T12:00:00`).getTime() : now;
      d.policyDraft = found
        ? {
            id: found.id,
            isEdit: true,
            kind: found.kind,
            days: found.days ? [...found.days] : [1, 2, 3, 4, 5],
            dateFrom: found.dateFrom || '',
            dateTo: found.dateTo || '',
            start: found.start || '',
            end: found.end || '',
            excludeDays: found.excludeDays ? [...found.excludeDays] : [],
            excludeFrom: found.excludeFrom || '',
            excludeTo: found.excludeTo || '',
            calAnchor: Number.isFinite(anchorTs) ? anchorTs : now,
            calStep: 'from',
          }
        : {
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
            calAnchor: now,
            calStep: 'from',
            todayYmd,
          };
      return { ok: true, acts: [{ act: 'dialog', args: { kind: 'rsiExecPolicy', objective: d.objective.id } }] };
    }
    case 'policyDraft': {
      if (!d || !o) return { error: 'Experiment not found', status: 404 };
      const draft: Data = d.policyDraft || (d.policyDraft = { id: '', isEdit: false, kind: 'weekly', days: [1, 2, 3, 4, 5], dateFrom: '', dateTo: '', start: '20:00', end: '08:00', excludeDays: [], excludeFrom: '', excludeTo: '', calAnchor: now, calStep: 'from' });
      const field = String(body.field || '');
      const val = body.v ?? body.value;
      const toYmd = (ts: number) => {
        const dt = new Date(ts);
        return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      };
      if (field === 'kind' && typeof val === 'string') {
        draft.kind = val;
        if (val === 'fixed' && !draft.dateFrom) { const y = toYmd(now); draft.dateFrom = y; draft.dateTo = y; }
        if (val === 'weekly' && (!Array.isArray(draft.days) || !draft.days.length)) draft.days = [1, 2, 3, 4, 5];
        if (val === 'continuous') { draft.start = ''; draft.end = ''; }
      } else if (field === 'dayToggle') {
        const day = Number(val);
        if (Number.isInteger(day) && day >= 0 && day <= 6) {
          const cur: number[] = Array.isArray(draft.days) ? [...draft.days] : [];
          draft.days = cur.includes(day) ? cur.filter((x) => x !== day) : [...cur, day].sort((a, b) => a - b);
        }
      } else if (field === 'excludeDayToggle') {
        const day = Number(val);
        if (Number.isInteger(day) && day >= 0 && day <= 6) {
          const cur: number[] = Array.isArray(draft.excludeDays) ? [...draft.excludeDays] : [];
          draft.excludeDays = cur.includes(day) ? cur.filter((x) => x !== day) : [...cur, day].sort((a, b) => a - b);
        }
      } else if (field === 'calNav') {
        const base = new Date(Number(draft.calAnchor) || now);
        if (val === 'prev') draft.calAnchor = new Date(base.getFullYear(), base.getMonth() - 1, 15, 12).getTime();
        else if (val === 'next') draft.calAnchor = new Date(base.getFullYear(), base.getMonth() + 1, 15, 12).getTime();
        else draft.calAnchor = now;
      } else if (field === 'calPick') {
        const ts = Number(val);
        if (Number.isFinite(ts)) {
          const ymd = toYmd(ts);
          draft.calAnchor = ts;
          if (draft.kind === 'fixed') {
            draft.dateFrom = ymd;
            draft.dateTo = ymd;
          } else if (draft.kind === 'range') {
            if (!draft.dateFrom || draft.dateTo || draft.calStep === 'from') {
              draft.dateFrom = ymd;
              draft.dateTo = '';
              draft.calStep = 'to';
            } else {
              if (ymd < draft.dateFrom) { draft.dateTo = draft.dateFrom; draft.dateFrom = ymd; }
              else draft.dateTo = ymd;
              draft.calStep = 'from';
            }
          }
        }
      } else if (field === 'timePreset') {
        if (val === 'all') { draft.start = ''; draft.end = ''; }
        else if (val === 'day') { draft.start = '09:00'; draft.end = '18:00'; }
        else if (val === 'night') { draft.start = '20:00'; draft.end = '08:00'; }
      } else if (['dateFrom', 'dateTo', 'start', 'end', 'excludeFrom', 'excludeTo'].includes(field)) {
        draft[field] = typeof val === 'string' ? val.trim() : '';
        if (field === 'dateFrom' && draft.kind === 'fixed') draft.dateTo = draft.dateFrom;
      }
      return { ok: true };
    }
    case 'policySave': {
      if (!d || !o) return { error: 'Experiment not found', status: 404 };
      const draft: Data = d.policyDraft || body;
      const existing = policiesOf(d.policy.schedule);
      const checked = validatePolicy(draft, `pol-${randomUUID().slice(0, 8)}`);
      if ('error' in checked) return checked;
      const nextList = draft.isEdit && draft.id
        ? existing.map((p) => (p.id === draft.id ? checked.policy : p))
        : [...existing, checked.policy];
      const maxRuns = d.policy.schedule?.maxRuns ?? null;
      d.policy.schedule = {
        mode: 'rules',
        policies: nextList,
        ...(maxRuns ? { maxRuns } : {}),
        window: '',
      };
      d.policy.schedule.window = scheduleSummary(d.policy.schedule);
      delete d.policyDraft;
      const summary = d.policy.schedule.window;
      o.trigger = String(timeRange(summary) || '');
      message(state, d, now, draft.isEdit ? '你更新了执行策略' : '你添加了执行策略', formatPolicy(checked.policy).title);
      syncObjective(state, d);
      return { ok: true };
    }
    case 'policyDelete': {
      if (!d || !o) return { error: 'Experiment not found', status: 404 };
      const targetId = typeof (body.policyId ?? body.id) === 'string' ? String(body.policyId ?? body.id) : '';
      const existing = policiesOf(d.policy.schedule);
      const removed = existing.find((p) => p.id === targetId);
      if (!removed) return { error: 'Policy not found', status: 404 };
      const nextList = existing.filter((p) => p.id !== targetId);
      const maxRuns = d.policy.schedule?.maxRuns ?? null;
      d.policy.schedule = {
        mode: 'rules',
        policies: nextList,
        ...(maxRuns ? { maxRuns } : {}),
        window: '',
      };
      d.policy.schedule.window = scheduleSummary(d.policy.schedule);
      delete d.policyDraft;
      o.trigger = String(timeRange(d.policy.schedule.window) || '');
      message(state, d, now, '你删除了一条执行策略', formatPolicy(removed).title);
      syncObjective(state, d);
      return { ok: true };
    }
    case 'auto': {
      if (!d) return { error: 'Experiment not found', status: 404 };
      const auto = autoKinds(body.auto ?? body.v);
      if ('error' in auto) return auto;
      d.policy.auto = auto.kinds;
      const text = autoText(auto.kinds), item = d.prep.find((p) => p.section === 'goal' && p.id.endsWith('-auto'));
      if (item) Object.assign(item, { value: text, state: 'confirmed', by: '你', mine: true, at: now });
      else d.prep.push({ id: `${d.objective.id}-auto`, section: 'goal', title: '夜里可以自己定的方向', value: text, state: 'confirmed', neededFrom: null, mine: true, by: '你', at: now });
      message(state, d, now, '你改了夜里可以自己定的方向', text);
      return { ok: true };
    }
    case 'manager': {
      if (!d) return { error: 'Experiment not found', status: 404 };
      const raw = body.v ?? body.catId;
      if (raw !== undefined && raw !== null && typeof raw !== 'string') return { error: 'Invalid manager selection' };
      const catId = typeof raw === 'string' ? raw.trim() : '';
      d.policy ||= {};
      if (!catId) {
        delete d.policy.manager;
        message(state, d, now, '你取消了委托负责人', '管理操作（确认准备项、采纳方向、重做步骤、暂停/恢复等）恢复为仅你本人通过页面操作。', 'members');
      } else {
        const known = d.members.find((m) => m.catId === catId) || Object.values<Data>(d.stepMembers || {}).find((m) => m?.catId === catId);
        const manager = Array.isArray(body.cats) && body.cats.some((c: Data) => c.id === catId)
          ? setMember({}, catId, body.cats)
          : known
            ? { catId: known.catId, name: known.name, model: known.model || '', ...(known.handle ? { handle: known.handle } : {}) }
            : setMember({}, catId, body.cats);
        d.policy.manager = manager;
        message(state, d, now, `你把委托负责人设为了 ${manager.name}`, '该成员可通过原生 MCP 工具 rsi_operate 代为确认准备项、采纳方向、重做步骤、暂停/恢复与触发执行；可随时在策略区取消。', 'members');
      }
      syncObjective(state, d);
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
      Object.assign(item, { state: 'confirmed', isDefault: false, by: actor, at: now });
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
        if (!(section === 'run' && d.rounds.length > 0)) rsiExpStaleFrom(d, section, false);
        if (d.objective.state === 'ready') d.objective.state = 'preparing';
        message(state, d, now, `${actor}触发了第 ${d.plan.findIndex((p) => p.k === section) + 1} 步重新分析`, '将按当前成员重新调研并保留历史版本快照。');
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
    case 'analystRemove':
    case 'analystToggle': {
      if (!d) return { error: 'Experiment not found', status: 404 };
      const catId = typeof body.catId === 'string' && body.catId ? body.catId : (typeof body.v === 'string' ? body.v : '');
      if (!catId) return { error: 'Choose a member' };
      const exists = d.members.some((m) => m.role === 'analyze' && m.catId === catId);
      const add = body.op === 'analystAdd' || (body.op === 'analystToggle' && !exists);
      d.members = d.members.filter((m) => !(m.role === 'analyze' && m.catId === catId));
      refreshMembers(d.members, body.cats);
      if (d.stepMembers) refreshMembers(Object.values(d.stepMembers), body.cats);
      if (d.policy?.manager?.catId) refreshMembers([d.policy.manager], body.cats);
      if (add) {
        const added = setMember({ role: 'analyze' }, catId, body.cats);
        d.members.push(added);
        // If a cycle is currently awaiting discussion proposals, enroll and wake the newly added analyst immediately.
        for (const r of d.rounds) if (r.analysis?.waiting?.length && !r.analysis.waiting.includes(added.catId)) {
          r.analysis.waiting.push(added.catId);
          enqueue(state, d, 'agent', { member: added.catId, cycle: r.n, action: 'direction', message: { title: `第 ${r.n} 周期：请给方向`,
            body: `${mention(added)} 你已加入本评估项方案讨论：调原生 MCP 工具 rsi_task 看第 ${r.n} 周期结论与同周期对照，再调 rsi_propose 交你的方向。` } });
        }
      }
      // A removed analyst no longer holds up a conclusion.
      else for (const r of d.rounds) if (r.analysis?.waiting.includes(catId)) {
        r.analysis.waiting = r.analysis.waiting.filter((id: string) => id !== catId);
        if (!r.analysis.waiting.length) finishAnalysis(state, d, r, now);
      }
      syncObjective(state, d);
      return { ok: true };
    }
    case 'evalAgain': {
      if (!d) return { error: 'Experiment not found', status: 404 };
      const evaluating = d.rounds.find((r: Data) => r.state === 'evaluating');
      const targetN = body.n != null && body.n !== '' ? Number(body.n) : null;
      if (targetN != null && Number.isFinite(targetN)) {
        const round = d.rounds.find((r: Data) => r.n === targetN);
        if (!round) return { error: 'Cycle not found', status: 404 };
        if (round.state === 'evaluating') {
          askEvaluation(state, d, round, false, now);
          return { ok: true };
        }
        if (round.state !== 'done') return { error: 'Cycle is not ready for evaluation', status: 400 };
        if (evaluating && evaluating.n !== round.n) return { error: 'Another cycle is currently evaluating', status: 409 };
        round.reevaluating = true;
        round.state = 'evaluating';
        askEvaluation(state, d, round, true, now);
        return { ok: true };
      }
      if (!evaluating) return { error: 'No cycle is waiting for its conclusion', status: 404 };
      askEvaluation(state, d, evaluating, false, now);
      return { ok: true };
    }
    case 'discussAgain': {
      const round = d?.rounds.find((r: Data) => r.analysis?.waiting?.length);
      if (!d || !round) return { error: 'No cycle is waiting for discussion proposals', status: 404 };
      round.analysis.askedAt = now;
      delete round.analysis.unclaimedNotified;
      for (const catId of round.analysis.waiting as string[]) {
        const m = d.members.find((x) => x.catId === catId) || { catId, name: catId };
        enqueue(state, d, 'agent', { member: catId, cycle: round.n, action: 'direction', message: { title: `第 ${round.n} 周期：请给方向（重发）`,
          body: `${mention(m)} 第 ${round.n} 周期仍在等你给方向：调原生 MCP 工具 rsi_task 读取结论与对照，再调 rsi_propose 提交。` } });
      }
      return { ok: true };
    }
    case 'versionAgain': {
      if (!d || !d.versionRequest) return { error: 'No version request is pending', status: 404 };
      const member = d.members.find((m) => m.role === 'iterate');
      if (!member?.catId) return { error: 'Assign a governance execution member first' };
      d.versionRequest.since = now;
      delete d.versionRequest.invocationId;
      delete d.versionRequest.stalledNotified;
      enqueue(state, d, 'agent', { member: member.catId, cycle: d.versionRequest.cycle, action: 'version', message: { title: d.versionRequest.repair ? `重发：修第 ${d.versionRequest.cycle} 周期的运行失败` : '重发：准备下一个版本',
        body: `${mention(member)} 重新触发治理任务「${d.versionRequest.title}」：先调原生 MCP 工具 rsi_task 看要求，完成后调 rsi_version 提交。` } });
      return { ok: true };
    }
    case 'runCycle':
      return d?.objective.projectPath ? runCycle(state, d, now) : { error: 'Select a real experimental project' };
    case 'life': {
      if (!o) return { error: 'Objective not found', status: 404 };
      if (!['start', 'pause', 'resume', 'finish', 'retry', 'more'].includes(body.action)) return { error: 'Invalid lifecycle action' };
      if (d?.objective.projectPath && body.action === 'retry') return runCycle(state, d, now);
      if (d?.objective.projectPath && ['done', 'retired'].includes(d.objective.state)) return { error: 'Objective has stopped' };
      const STATE_LABEL: Record<string, string> = {
        setup: '准备中',
        ready: '待开始',
        running: '运行中',
        pending: '等待决定',
        paused: '已暂停',
        done: '已结束',
        retired: '已退役',
        baseline: '基线周期',
        collecting: '采集中',
        exhausted: '次数用完',
      };
      const stateLabel = (s: string | undefined) => (s && STATE_LABEL[s]) || s || '运行中';
      const objective = d ? d.objective : o;
      if (body.action === 'start') {
        if (d?.objective.projectPath && !hasValidSchedule(d.policy.schedule)) return { error: '请先在策略区配置「运行时段」或完成第 3 步，也可先手动点「跑一轮」' };
        if (objective.state !== 'ready') return { error: 'Objective is not ready' };
        objective.state = d ? 'running' : 'baseline';
      } else if (body.action === 'pause') {
        const wasPaused = objective.state === 'paused';
        if (!wasPaused) objective.resumeTo = objective.state;
        objective.state = 'paused';
        if (d && !wasPaused) {
          message(state, d, now, `${actor}暂停了评估项`, `已暂停自动推进并关闭执行器（原状态：${stateLabel(objective.resumeTo)}）；恢复后会重新计算等待计时。`, 'plan');
        }
      } else if (body.action === 'resume') {
        if (objective.state !== 'paused') return { error: 'Objective is not paused' };
        const prevResumeTo = objective.resumeTo;
        const hasUndecided = !!d?.rounds.some((r: Data) => r.report && !r.decision);
        const lastRound = d?.rounds.at(-1);
        const strandedLegacy = !!d?.objective.projectPath
          && prevResumeTo === 'pending'
          && !!lastRound?.report
          && !!lastRound.decision
          && lastRound.decision.pick !== 'same'
          && !d.candidate
          && !d.versionRequest
          && d.versions.at(-1)?.id === lastRound.version;
        const deferredRound = d?.objective.projectPath && lastRound?.report && lastRound.decision
          && (lastRound.decision.deferred || strandedLegacy)
          ? lastRound
          : undefined;
        const rawTarget = prevResumeTo || (hasUndecided ? 'pending' : 'running');
        const targetState = rawTarget === 'pending' && !hasUndecided ? 'running' : rawTarget;
        objective.state = targetState;
        delete objective.resumeTo;
        if (d) {
          for (const r of d.rounds) {
            if (r.report && !r.decision && r.asked) r.asked = now;
            if (r.analysis?.waiting?.length) {
              r.analysis.since = now;
              r.analysis.askedAt = now;
              delete r.analysis.unclaimedNotified;
            }
            if (r.state === 'evaluating') {
              r.evalAskedAt = now;
              if (!r.invocationId) delete r.evalStalledNotified;
            }
          }
          if (d.versionRequest) {
            d.versionRequest.since = now;
            if (!d.versionRequest.invocationId) delete d.versionRequest.stalledNotified;
          }
          message(state, d, now, `${actor}恢复了评估项`, `已恢复为 ${stateLabel(targetState)} 并启用执行器；等待决策/分析/版本计时已从本次恢复重新起算。`, 'plan');
          if (deferredRound) {
            delete deferredRound.decision.deferred;
            dispatchDecision(state, d, deferredRound, now);
          }
        }
      } else if (body.action === 'finish') {
        if (d?.rounds.some((r: Data) => r.state === 'running')) {
          return { error: '当前有运行中的周期，请先暂停或等本周期结束后再结项', status: 409 };
        }
        if (d && body.note == null) {
          return { ok: true, act: 'dialog', args: { kind: 'rsiFinish', objective: d.objective.id, name: d.objective.name } };
        }
        const note = typeof body.note === 'string' ? body.note.trim() : '';
        if (d && !note) return { error: '请填写结项/毕业说明' };
        if (note.length > 240) return { error: '结项说明请控制在 240 字以内' };
        objective.state = 'done';
        delete objective.resumeTo;
        if (d) {
          const lastCycle = d.rounds.length ? d.rounds[d.rounds.length - 1].n : (d.objective.round || 0);
          objective.stopReason = { kind: 'manual', text: note, cycle: lastCycle, at: now, by: actor };
          delete d.versionRequest;
          const report = buildCloseoutReport(d, now, actor);
          d.closeoutReport = report;
          message(state, d, now, `${actor}结项了评估项`, report.markdown, 'conclusion');
        }
      } else if (body.action === 'more') {
        if (d) d.objective.budget.rounds = (d.objective.budget.rounds || 0) + 10;
        else if (state.details[id]?.trigger) state.details[id].trigger.evals.max += 10;
      }
      if (d) {
        if (body.action === 'pause' || body.action === 'resume' || body.action === 'finish') {
          d.executor.off = body.action !== 'resume';
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
      if (d.objective.projectPath && ['done', 'retired'].includes(d.objective.state)) return { error: 'Objective is not active', status: 409 };
      const canRedecide = !!round.decision
        && !!d.objective.projectPath
        && !d.rounds.some((r: Data) => r.n > round.n)
        && ((d.versionRequest?.cycle === round.n && !d.versionRequest.repair) || !!round.decision.deferred);
      if (round.decision && !canRedecide) return { error: 'Round already decided', status: 409 };
      if (canRedecide && !round.decision.deferred && d.objective.state === 'paused') return { error: 'Objective is not active', status: 409 };
      if (canRedecide) delete d.versionRequest;
      round.decision = { pick: body.pick, directionId: body.directionId ?? null, note: body.note ?? '', by: actor, at: now };
      const n = round.n + 1, current = round.plan.groups[0];
      if (d.objective.projectPath) {
        if (d.objective.state === 'paused') {
          round.decision.deferred = true;
          if (d.objective.resumeTo === 'pending') d.objective.resumeTo = 'running';
          message(state, d, now, `${actor}已暂存第 ${round.n} 周期决定`, '评估项当前处于暂停状态；恢复后会自动派发该决定对应的版本或下一周期计划。', 'plan');
          syncObjective(state, d);
          return { ok: true };
        }
        dispatchDecision(state, d, round, now);
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
    case 'lineageFix': {
      if (!d) return { error: 'Experiment not found', status: 404 };
      const rawPatches = body.patches;
      if (!Array.isArray(rawPatches) || !rawPatches.length || rawPatches.length > 200) {
        return { error: 'Provide patches: a non-empty array of up to 200 version annotations' };
      }
      const byId = new Map<string, Data>(d.versions.map((v: Data) => [v.id, v]));
      const nextParents = new Map<string, string | null>(d.versions.map((v: Data) => [v.id, v.parent ?? null]));
      const validated: Data[] = [];
      for (const raw of rawPatches) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Each patch must be an object' };
        const p = raw as Data;
        const vid = typeof p.version === 'string' ? p.version.trim() : '';
        if (!vid || !byId.has(vid)) return { error: `Unknown version in lineageFix: ${JSON.stringify(p.version)}`, status: 404 };
        const hasField = p.parent !== undefined || p.aspects !== undefined || p.disposition !== undefined || p.tag !== undefined;
        if (!hasField) return { error: `Patch for ${vid} must specify at least one of parent, aspects, disposition, or tag` };
        let parent: string | null | undefined;
        if (p.parent !== undefined) {
          if (p.parent === null || p.parent === '') parent = null;
          else if (typeof p.parent === 'string' && byId.has(p.parent.trim()) && p.parent.trim() !== vid) parent = p.parent.trim();
          else return { error: `Invalid parent ${JSON.stringify(p.parent)} for version ${vid}` };
          nextParents.set(vid, parent);
        }
        let aspects: string[] | null | undefined;
        if (p.aspects !== undefined) {
          if (p.aspects === null) aspects = null;
          else if (Array.isArray(p.aspects) && p.aspects.length && p.aspects.every((a: unknown) => typeof a === 'string' && ['object', 'observability', 'rubric'].includes(a))) {
            aspects = ['object', 'observability', 'rubric'].filter((k) => (p.aspects as string[]).includes(k));
          } else return { error: `Invalid aspects for version ${vid}` };
        }
        let disposition: 'advance' | 'dead_end' | null | undefined;
        if (p.disposition !== undefined) {
          if (p.disposition === null || p.disposition === '') disposition = null;
          else if (p.disposition === 'advance' || p.disposition === 'dead_end') disposition = p.disposition;
          else return { error: `Invalid disposition for version ${vid}: must be "advance", "dead_end", or null` };
        }
        let tag: string | null | undefined;
        if (p.tag !== undefined) {
          if (p.tag === null || p.tag === '') tag = null;
          else if (typeof p.tag === 'string' && p.tag.trim() && p.tag.trim().length <= 32) tag = p.tag.trim();
          else return { error: `Invalid tag for version ${vid}: must be 1–32 characters or null` };
        }
        validated.push({ vid, parent, aspects, disposition, tag });
      }
      for (const vid of nextParents.keys()) {
        const seen = new Set<string>();
        let cur: string | null | undefined = vid;
        while (cur) {
          if (seen.has(cur)) return { error: `Lineage patch introduces a parent cycle involving ${cur}` };
          seen.add(cur);
          cur = nextParents.get(cur);
        }
      }
      const annotatedBy = typeof body.annotatedBy === 'string' && body.annotatedBy.trim() ? body.annotatedBy.trim().slice(0, 48) : actor;
      const updated: string[] = [];
      for (const p of validated) {
        const v = byId.get(p.vid)!;
        if (p.parent !== undefined) v.parent = p.parent;
        if (p.aspects !== undefined) {
          if (p.aspects === null) delete v.aspects;
          else v.aspects = p.aspects;
        }
        if (p.disposition !== undefined) {
          if (p.disposition === null) delete v.disposition;
          else v.disposition = p.disposition;
        }
        if (p.tag !== undefined) {
          if (p.tag === null) delete v.tag;
          else v.tag = p.tag;
        }
        v.annotatedBy = annotatedBy;
        v.annotatedAt = now;
        if (!updated.includes(p.vid)) updated.push(p.vid);
      }
      message(state, d, now, `${annotatedBy}校准了 ${updated.length} 个版本的谱系标注`, updated.join('、'), 'declare');
      syncObjective(state, d);
      return { ok: true, updated, annotatedBy };
    }
    case 'abortCycle': {
      if (!d || !d.objective.projectPath) return { error: 'Real experimental objective not found', status: 404 };
      if (!['budget', 'env', 'eliminated', 'manual'].includes(body.reason)) return { error: 'reason must be budget, env, eliminated or manual', status: 400 };
      if (body.note !== undefined && typeof body.note !== 'string') return { error: 'note must be a string', status: 400 };
      const note = typeof body.note === 'string' ? body.note.trim() : '';
      if (note.length > 240) return { error: '中止说明请控制在 240 字以内', status: 400 };
      const round = d.rounds.find((r: Data) => r.state === 'running');
      if (!round) return { error: 'No running cycle to abort', status: 409 };
      round.aborted = { reason: body.reason, ...(note ? { note } : {}), by: actor, at: now };
      round.state = 'aborting';
      for (const run of round.runs) {
        if (run.state === 'running' || run.jobId) run.cancelResult = { status: 'pending' };
        if (['running', 'queued'].includes(run.state)) Object.assign(run, { state: 'cancelled', retryable: false, end: now });
      }
      // Persist intent before touching processes. Restart only completes cleanup, never resumes these runs.
      d.objective.state = 'paused';
      d.objective.resumeTo = 'ready';
      if (d.upcoming) delete d.upcoming.cycleVars;
      syncObjective(state, d);
      return { ok: true, cycle: round.n, state: 'aborting' };
    }
    case 'cycleVars': {
      if (!d) return { error: 'Experiment not found', status: 404 };
      if (['done', 'retired'].includes(d.objective.state)) {
        return { error: `Cannot set cycleVars while objective is ${d.objective.state}`, status: 409 };
      }
      if (!d.upcoming) return { error: 'No upcoming cycle plan to bind cycleVars to', status: 400 };
      const raw = body.vars;
      if (raw === null) {
        delete d.upcoming.cycleVars;
        syncObjective(state, d);
        return { ok: true, cycleVars: null };
      }
      if (!record(raw)) return { error: 'Provide vars as a JSON object or null to clear', status: 400 };
      const RESERVED_KEYS = ['seed', 'tier', 'reservedSeeds', 'pairedPlan'];
      const forbidden = RESERVED_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(raw, k));
      if (forbidden.length) return { error: `cycleVars cannot override Host-managed keys: ${forbidden.join(', ')}`, status: 400 };
      const encoded = JSON.stringify(raw);
      if (encoded.length > 65_536) return { error: 'cycleVars exceeds 64 KiB limit', status: 400 };
      const conflicts = cycleVarsConflicts(d, d.upcoming.groups || [], raw);
      if (conflicts.length) return { error: `cycleVars cannot override keys that differ across groups: ${conflicts.join(', ')}`, status: 400 };
      if (!Object.keys(raw).length) delete d.upcoming.cycleVars;
      else d.upcoming.cycleVars = JSON.parse(encoded);
      syncObjective(state, d);
      return { ok: true, cycleVars: d.upcoming.cycleVars ?? null };
    }
    case 'requireCycleVars': {
      if (!d) return { error: 'Experiment not found', status: 404 };
      const raw = body.enabled ?? body.v;
      let enabled: boolean;
      if (typeof raw === 'boolean') enabled = raw;
      else if (raw === 'on' || raw === 'true') enabled = true;
      else if (raw === 'off' || raw === 'false' || raw === '') enabled = false;
      else return { error: 'Provide enabled as true/false or "on"/"off"', status: 400 };
      d.policy ||= {};
      // Pre-gate plans may contain preparer-supplied bindings; require fresh authorization.
      if (enabled && !d.policy.requireCycleVars && d.upcoming) delete d.upcoming.cycleVars;
      if (enabled) d.policy.requireCycleVars = true;
      else delete d.policy.requireCycleVars;
      message(state, d, now, `${actor}${enabled ? '开启' : '关闭'}了每轮前绑定 cycleVars 门禁`, enabled ? '后续每次启动新周期前均须先绑定非空 cycleVars（外部资源/租约），未绑定时系统自动等待而不盲跑。' : '恢复为按计划自动推进周期，不再强制每轮前绑定 cycleVars。', 'declare');
      syncObjective(state, d);
      return { ok: true, requireCycleVars: !!d.policy.requireCycleVars };
    }
    case 'promote': {
      if (!d || !d.objective.projectPath) return { error: 'Real experimental objective not found', status: 404 };
      if (['done', 'retired'].includes(d.objective.state)) {
        return { error: `Cannot promote version while objective is ${d.objective.state}`, status: 409 };
      }
      if (d.rounds.some((r: Data) => ['running', 'evaluating'].includes(r.state)) || d.versionRequest) {
        return { error: '当前有运行中、评估中或出版本中的周期任务，请等当前阶段完成后再晋升默认版本', status: 409 };
      }
      const candidate = d.candidate;
      const requestedId = typeof body.version === 'string' && body.version.trim()
        ? body.version.trim()
        : (candidate?.version || '');
      if (!requestedId) return { error: 'Provide version to promote (or have an active candidate)', status: 400 };
      let version = d.versions.find((v: Data) => v.id === requestedId);
      if (!version) return { error: `Unknown version ${JSON.stringify(requestedId)}`, status: 404 };
      const note = typeof body.note === 'string' ? body.note.trim() : '';
      if (note.length > 240) return { error: '晋升说明请控制在 240 字以内', status: 400 };
      const previous = d.objective.currentVersion;
      const isCandidatePromote = !!candidate && candidate.version === version.id;
      if (!isCandidatePromote && version.status !== 'confirmed') {
        return { error: 'Only the active candidate or a previously confirmed version can be promoted', status: 409 };
      }
      if (isCandidatePromote && d.policy.tiers) {
        const top = tiersOf(d).at(-1)!;
        const selected = d.rounds.find((r: Data) => r.n === candidate.cycle);
        const plan = { ...selected?.plan, tier: top.id, groups: [candidate], hypothesisIds: selected?.hypothesisIds, scenario: selected?.scenario };
        if (!tierEvidence(d, plan, top.id).length) return { error: 'Adoption requires completed highest-tier evidence for this candidate', status: 409 };
      }
      if (version.id === previous) {
        if (!isCandidatePromote) return { error: `Version ${version.id} is already the current version`, status: 409 };
        version = { ...version, id: `v${d.versions.length + 1}`, parent: version.id, current: false, change: candidate.label || version.change, at: now };
        delete version.worktree;
        d.versions.push(version);
      }
      if (isCandidatePromote) {
        version.vars = structuredClone(candidate.vars);
        if (candidate.hypothesisId) version.hypothesisId = candidate.hypothesisId;
      }
      Object.assign(version, { status: 'confirmed', promotedAt: now, promotedBy: actor, ...(note ? { promotedNote: note } : {}) });
      for (const v of d.versions) v.current = v.id === version.id;
      d.objective.currentVersion = version.id;
      if (candidate) delete d.candidate;
      if (d.upcoming) {
        delete d.upcoming.cycleVars;
        const rest = (d.upcoming.groups || []).filter((g: Data) => !g.control && g.id !== 'control' && !(g.confirm && (g.version === requestedId || g.version === candidate?.version)));
        d.upcoming.groups = [controlGroup(d), ...rest];
      }
      const lastRound = d.rounds.at(-1);
      if (isCandidatePromote && lastRound?.decision?.deferred && lastRound.decision.pick === 'same') {
        delete lastRound.decision;
        if (d.objective.state === 'paused') d.objective.resumeTo = 'pending';
      }
      message(state, d, now, `${actor}将 ${version.id} 晋升为当前默认版本（原 ${previous}）`, note || '经批准直接采用为当前默认版本，后续周期将以该版本作为对照基线。', 'declare');
      syncObjective(state, d);
      return { ok: true, previous, currentVersion: version.id, status: 'confirmed' };
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
