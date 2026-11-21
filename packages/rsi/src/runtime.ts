import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { abandonRepair, ANALYSIS_LIMIT, DECISION_WAIT, decideByDefault, finishAnalysis, nightDigest, nightDue, REPAIR_WAIT, runCycle } from './cycles.js';
import { insideWindow, withinWindowLimit } from './schedule.js';
import { bindObjectiveThread, clipTitle, recordInitExecution, threadTitle } from './init.js';
import { createRuns } from './runs.js';
import { isState, listOwners, readState, record, retain } from './store.js';
import { removeVersionWorktrees } from './versions.js';
import type { Data, Experiment, RsiHost, Section } from './types.js';

function executionEvents(state: import('./types.js').RsiState, d: Experiment) {
  for (const [id, event] of Object.entries(d.lifecycle || {}) as [string, Data][]) {
    if (!event.outcome || event.applied) continue;
    const dispatch = state.outbox.find((entry) => entry.kind === 'agent' && entry.objective === d.objective.id && entry.messageId === event.replyTo);
    if (!dispatch?.section) continue;
    const step = d.exec?.[dispatch.section as Section];
    if (step?.state === 'started' && step.id === dispatch.executionId && step.by === dispatch.member)
      recordInitExecution(state, d.objective.id, dispatch.section, step.id, event.outcome, Date.now());
    // The member's turn ended normally while a step handed to it in that turn is still open: wake it once for that step.
    if (event.outcome === 'completed') for (const handed of state.outbox.filter((e) => e.kind === 'agent' && e.objective === d.objective.id && e.member === dispatch.member && e.inTurn && !e.rewoken)) {
      const open = d.exec?.[handed.section as Section];
      if (open?.state !== 'started' || open.id !== handed.executionId) continue;
      handed.rewoken = true;
      state.outbox.push({ ...handed, id: `${handed.id}-wake`, inTurn: undefined, sent: undefined, messageId: undefined });
    }
    state.experiments[d.objective.id].lifecycle[id].applied = true;
  }
}

// Tool usage lives in the plugin's registered `rsi` skill (skills/rsi/SKILL.md);
// wake-up messages only keep a brief pointer to claim the current turn.
export const AGENT_HOW = '按 rsi skill 流程处理：直接调用本会话原生 MCP 工具（工具名以 rsi_task 结尾，不同 CLI 带各自前缀如 *__rsi_task({})）认领并读取本步上下文；原生工具已挂载时不要走 plugin_call。';

export function createRuntime(host: RsiHost) {
  let stopped = false, tail = Promise.resolve();
  const runs = createRuns(host, flush);
  const subscribe = (threadId: string) => host.messaging.subscribe({ threadId, method: 'rsi.delivery' });
  // Marks a delivered entry; an entry deleted with its objective meanwhile is skipped. The write's compaction takes it out of the
  // outbox (a message stays in the objective's messages); an agent request stays while its reply may still be matched to it.
  const mark = (next: import('./types.js').RsiState, id: string, extra: Data = {}) => {
    const e = next.outbox.find((x) => x.id === id);
    if (e) Object.assign(e, { sent: Date.now(), ...extra });
    return e;
  };

  async function deliverOutbox(key: string) {
    while (!stopped) {
      const stored = await readState(host.storage, key);
      if (!stored || !isState(stored.value)) return;
      const state = stored.value;
      const entry = state.outbox.find((e) => !e.sent && state.experiments[e.objective]?.objective.projectPath);
      if (!entry) return;
      const d = state.experiments[entry.objective];
      if (entry.kind === 'createThread') {
        const thread = d.objective.thread || (await host.threads.create({ title: threadTitle(entry.title), projectRef: d.objective.projectPath,
          participants: [...new Set(d.members.filter((m) => ['prepare', 'iterate', 'evaluate'].includes(m.role)).map((m) => m.catId))] })).id;
        if (stopped) return;
        await retain(host.storage, key, (next) => { if (mark(next, entry.id)) bindObjectiveThread(next, entry.objective, thread); });
        await subscribe(thread);
      } else if (entry.kind === 'message' || entry.kind === 'agent') {
        if (!d.objective.thread) return;
        if (entry.kind === 'agent' && entry.section && d.exec?.[entry.section as Section]?.id !== entry.executionId) {
          await retain(host.storage, key, (next) => { mark(next, entry.id); });
          continue;
        }
        const content = [entry.message?.title, entry.kind === 'agent' ? AGENT_HOW : '', entry.message?.body, entry.message?.ask].filter(Boolean).join('\n\n');
        const sent = await host.messaging.send({ threadId: d.objective.thread, idempotencyKey: entry.id,
          ...(entry.kind === 'agent' && !entry.inTurn ? { wake: { catId: entry.member, exact: true as const } } : {}),
          payload: { provenance: { epistemicStatus: entry.kind === 'agent' ? 'user_intent' : 'observation' },
            elements: [{ elementId: entry.id, kind: 'text', payload: { text: content } },
              ...(entry.kind === 'message' && ['goal', 'conclusion', 'failed', 'plan', 'digest'].includes(entry.message.kind) ? [{ elementId: `${entry.id}-card`, kind: 'rich_block' as const,
                payload: { id: entry.id, kind: 'card' as const, v: 1 as const, title: clipTitle(entry.message.title, 120, 'RSI'), bodyMarkdown: [entry.message.body, entry.message.ask].filter(Boolean).join('\n\n') } }] : [])] } });
        if (stopped) return;
        await retain(host.storage, key, (next) => { if (mark(next, entry.id, { messageId: sent.messageId })) executionEvents(next, next.experiments[entry.objective]); });
      } else {
        await retain(host.storage, key, (next) => { mark(next, entry.id); });
      }
    }
  }

  function flush(key: string) {
    const delivery = tail.then(() => deliverOutbox(key));
    tail = delivery.catch((error: unknown) => host.log('error', 'RSI outbox delivery failed; retained for retry', { error: String(error) }));
    return delivery.then(() => { runs.wake(); });
  }

  async function start() {
    for (const [key, stored] of await listOwners(host.storage)) {
      const real = Object.values(stored.value.experiments).filter((d) => d.objective.projectPath);
      if (!real.length) continue;
      await retain(host.storage, key, (state) => {
        // A dialog draft from alpha.45–46 holds bare ids, not members; the dialog starts empty again.
        if (state.draft?.analysts.some((a) => typeof a === 'string')) delete state.draft;
        for (const d of Object.values(state.experiments).filter((d) => d.objective.projectPath)) {
          // Objectives created before alpha.24 still hold the template's placeholder members (no cat; they never act), an iterator among them.
          d.members = d.members.filter((m) => m.catId);
          // Objectives created before governance execution had its own member: the preparer keeps doing it.
          if (!d.members.some((m) => m.role === 'iterate')) d.members.push({ ...d.members.find((m) => m.role === 'prepare')!, role: 'iterate' });
          for (const round of d.rounds.filter((r: Data) => r.state === 'running')) {
            if (d.executor.commands?.get && round.runs.some((r: Data) => r.jobId)) {
              for (const run of round.runs.filter((r: Data) => r.state === 'running')) run.state = 'queued';
              continue;
            }
            round.state = 'interrupted'; round.end = Date.now();
            for (const run of round.runs.filter((r: Data) => ['running', 'queued'].includes(r.state))) Object.assign(run, {
              state: 'failed', retryable: true, end: Date.now(), error: { kind: 'env', step: 'restart', raw: '插件重启，运行已中断。' } });
          }
          if (d.executor.state === 'probing' && d.exec?.run) {
            d.executor.state = 'failed';
            recordInitExecution(state, d.objective.id, 'run', d.exec.run.id, 'cancelled', Date.now(), { reason: '插件重启，预检已中断。' });
          }
        }
      });
      if (!real.length) continue;
      for (const d of real) if (d.objective.thread) await subscribe(d.objective.thread);
      await flush(key);
    }
  }

  async function deliver(input: unknown) {
    if (!record(input) || typeof input.deliveryId !== 'string') throw new Error('Invalid RSI delivery');
    const receipt = { deliveryId: input.deliveryId };
    if (stopped || input.kind !== 'execution_status' || !['started', 'settled'].includes(input.state)) return receipt;
    for (const [key, stored] of await listOwners(host.storage)) {
      const d = Object.values(stored.value.experiments).find((d) => d.objective.projectPath && d.objective.thread === input.threadId);
      if (!d) continue;
      await retain(host.storage, key, (state) => {
        const current = state.experiments[d.objective.id];
        if (!current) return;
        current.lifecycle ||= {};
        if (input.state === 'started' && typeof input.replyTo === 'string') current.lifecycle[input.executionId] ||= { replyTo: input.replyTo };
        if (input.state === 'settled' && current.lifecycle[input.executionId]) current.lifecycle[input.executionId].outcome = input.outcome;
        executionEvents(state, current);
      });
      void flush(key).catch(() => {});
      break;
    }
    return receipt;
  }
  async function tick() {
    if (stopped) return;
    let owners = await listOwners(host.storage);
    // Analysts that have not proposed in time are left out and the conclusion goes out with the directions there are;
    // a conclusion nobody decided in time inside the run window goes on with its plan. Whatever else is running:
    // the busy check below only guards starting a new cycle.
    const now = Date.now();
    const analysisLate = (r: Data) => r.analysis?.waiting.length && now - r.analysis.since > ANALYSIS_LIMIT;
    const decisionLate = (x: Experiment, r: Data) => x.objective.state === 'pending' && r.asked && !r.decision && now - r.asked > DECISION_WAIT && insideWindow(x.policy.schedule, now);
    const repairLate = (x: Experiment) => x.versionRequest?.repair && now - x.versionRequest.since > REPAIR_WAIT;
    const late = (state: import('./types.js').RsiState) => Object.values(state.experiments).some((x) => repairLate(x) || nightDue(x, now) || x.rounds.some((r: Data) => analysisLate(r) || decisionLate(x, r)));
    for (const [key, entry] of owners) if (late(entry.value)) {
      await retain(host.storage, key, (state) => {
        for (const x of Object.values(state.experiments)) if (repairLate(x)) abandonRepair(state, x, `${REPAIR_WAIT / 60_000} 分钟内没修好`, now);
        for (const x of Object.values(state.experiments)) for (const r of x.rounds) {
          if (analysisLate(r)) finishAnalysis(state, x, r, now);
          else if (decisionLate(x, r)) decideByDefault(state, x, r, now);
        }
        // A closed window's summary goes last, so it tells where things stand after the checks above.
        for (const x of Object.values(state.experiments)) nightDigest(state, x, now);
      });
      await flush(key);
    }
    if (stopped) return;
    owners = await listOwners(host.storage);
    // A cycle the schedule started stops its running run once its window has closed; waking the runs on every tick continues it when the window opens.
    runs.hold(owners.flatMap(([, entry]) => Object.values((entry.value as import('./types.js').RsiState).experiments)
      .flatMap((d) => d.rounds.filter((r: Data) => r.scheduled && r.state === 'running' && !insideWindow(d.policy.schedule, now)).flatMap((r: Data) => r.runs.map((x: Data) => x.id)))));
    runs.wake();
    if (owners.some(([, entry]) => Object.values((entry.value as import('./types.js').RsiState).experiments).some((d) => d.objective.projectPath && (d.executor.state === 'probing' || d.rounds.some((r: Data) => r.state === 'running'))))) return;
    // Objectives take turns: of those that may start a cycle, the one whose last cycle started longest ago goes first,
    // and one that cannot start leaves the turn to the next.
    const due = (d: Experiment) => d.objective.projectPath && d.objective.state === 'running' && !d.versionRequest
      && insideWindow(d.policy.schedule, Date.now()) && withinWindowLimit(d.policy.schedule, d.rounds, Date.now()) && !d.rounds.some((r: Data) => ['running', 'evaluating'].includes(r.state) || r.state === 'interrupted' && r.autoResumed || r.report && !r.decision);
    const lastStart = (d: Experiment) => Math.max(0, ...d.rounds.map((r: Data) => r.start || 0));
    const turns = owners.flatMap(([key, entry]) => Object.values((entry.value as import('./types.js').RsiState).experiments).filter(due)
      .map((d) => ({ key, id: d.objective.id, last: lastStart(d) }))).sort((x, y) => x.last - y.last);
    for (const { key, id } of turns) {
      let started = false;
      await retain(host.storage, key, (state) => {
        started = false;
        const d = state.experiments[id];
        if (!d || !due(d)) return;
        // An interrupted cycle is resumed once by the schedule; interrupted again, it waits for 跑一轮.
        const halted = d.rounds.find((r: Data) => r.state === 'interrupted'), result = runCycle(state, d, Date.now());
        started = !!result.ok;
        // A cycle the schedule starts keeps to its window; one started with 跑一轮 does not.
        if (started) d.rounds.find((r: Data) => r.n === result.cycle).scheduled = true;
        if (started && halted) { halted.autoResumed = true; halted.events.push({ at: Date.now(), kind: 'retry', text: '周期被插件重启打断，调度自动续跑一次' }); }
      });
      await flush(key);
      if (started) return;
    }
  }
  // Deleted objectives: stop their run, then remove their runs folder in the project and their version worktrees.
  async function drop(removed: Experiment[]) {
    await runs.drop(removed.map((d) => d.objective.id));
    for (const d of removed.filter((d) => d.objective.projectPath)) {
      const log = (what: string) => (error: unknown) => host.log('error', `RSI could not remove a deleted objective's ${what}`, { objective: d.objective.id, error: String(error) });
      if (/^[\w-]+$/.test(d.objective.id)) await rm(join(d.objective.projectPath, 'runs', d.objective.id), { recursive: true, force: true }).catch(log('runs'));
      await removeVersionWorktrees(d).catch(log('worktrees'));
    }
  }
  return { start, flush, deliver, tick, drop, async stop() { stopped = true; await runs.stop(); await tail; } };
}
