import { follow, viewModel } from './views.js';
import { act } from './actions.js';
import { createRuntime } from './runtime.js';
import { mergeProjects, projects } from './projects.js';
import { isState, load, ownerKey, record, update } from './store.js';
import { toolAction } from './tools.js';
import type { Data, Experiment, OwnerContext, RsiHost, ToolContext } from './types.js';
export { ownerKey } from './store.js';

export function json(status: number, payload: unknown) {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(payload ?? null) };
}

export function createRsi(host: RsiHost) {
  const runtime = createRuntime(host), ready = runtime.start();
  async function handle(input: unknown, context: OwnerContext | undefined, method: 'GET' | 'POST') {
    if (context?.kind !== 'owner-http-request') return json(403, { error: 'Owner request required' });
    if (!record(input) || !record(input.request)) return json(400, { error: 'Invalid request' });
    if (input.request.method !== method) return json(405, { error: 'Invalid method' });
    if (context.operation !== (method === 'GET' ? 'read' : 'write')) return json(403, { error: 'Invalid owner operation' });
    if (input.request.query !== undefined && !record(input.request.query)) return json(400, { error: 'Invalid query' });
    if (method === 'POST' && (!record(input.request.body) || typeof input.request.body.op !== 'string')) return json(400, { error: 'Invalid operation' });
    await context.assertCurrent();
    await ready;
    const key = ownerKey(context.userId), query = input.request.query || {};
    const current = await load(host.storage, key, () => context.assertCurrent());
    if (!current) return json(409, { error: 'RSI state changed, please retry' });
    if (!isState(current.value)) return json(500, { error: 'Invalid RSI data' });
    const live = await projects(host);
    // The current conversation's project: the page follows it when nothing was chosen in this conversation.
    if (typeof query.thread === 'string' && query.thread) query.threadProject = (await host.threads.get(query.thread).catch(() => null))?.projectRef;
    if (method === 'GET') {
      if (typeof query.view !== 'string') return json(400, { error: 'Provide a view' });
      mergeProjects(current.value, live);
      if (follow(current.value, query).missing) return json(404, { error: 'Project not found' });
      const result = viewModel(current.value, query.view, query);
      return result === undefined ? json(400, { error: 'Unknown view' }) : json(200, result);
    }
    const body: Data = { ...input.request.body };
    if (['new', 'newExp'].includes(body.op)) {
      const threadMode = body.threadMode === 'new' ? 'new' : 'current';
      const currentThread = typeof body.thread === 'string' && body.thread && body.thread !== 'default'
        ? await host.threads.get(body.thread).catch(() => null)
        : null;
      if (body.project === '') {
        if (typeof body.thread !== 'string') return json(400, { error: 'Choose a project or open this dialog from a project conversation' });
        if (!currentThread?.projectRef) return json(400, { error: 'The current conversation has no project' });
        body.project = currentThread.projectRef;
      }
      body.reuseThread = threadMode === 'current' && currentThread ? currentThread.id : null;
    }
    let created: string | undefined, removed: Experiment[] = [];
    const result = await update(host.storage, key, (next) => {
      mergeProjects(next, live);
      // A write acts on what the page shows: the followed or chosen project and pick, without the conversation tag.
      const at = follow(next, query), shown = { ...query, project: at.project, pick: at.pick };
      const project = next.projects.find((p) => p.id === (body.project || shown.project));
      body.projectPath = project?.projectPath;
      const before = next.outbox.length, had = { ...next.experiments };
      const result = act(next, body, shown, Date.now());
      created = next.outbox.slice(before).find((e) => e.kind === 'createThread')?.objective;
      removed = Object.values(had).filter((d) => !next.experiments[d.objective.id]);
      return result;
    }, () => context.assertCurrent());
    if (result.error) { const { status = 400, ...payload } = result; return json(status, payload); }
    if (removed.length) await runtime.drop(removed);
    await runtime.flush(key);
    if (created) {
      const saved = await host.storage.get(key);
      const id = isState(saved?.value) && saved.value.experiments[created].objective.thread;
      // Open the new objective's conversation, then the RSI panel; the panel follows that conversation to the objective.
      if (id) return json(200, { ok: true, acts: [{ act: 'thread', args: { id } }, { act: 'open', args: { ref: 'plugin:official.rsi/rsi.panel' } }] });
    }
    return json(200, result);
  }
  return {
    view: (input: unknown, context?: OwnerContext) => handle(input, context, 'GET'),
    act: (input: unknown, context?: OwnerContext) => handle(input, context, 'POST'),
    async tool(method: string, input: unknown, ctx?: ToolContext) {
      if (!ctx || !ctx.catId || !ctx.threadId || !ctx.userId || !ctx.invocationId) return { error: 'Host tool context required', status: 403 };
      if (!record(input)) return { error: 'Tool input must be an object', status: 400 };
      await ctx.assertCurrent();
      await ready;
      const key = ownerKey(ctx.userId);
      if (!(await host.storage.get(key))) return { error: 'No RSI objective for this owner', status: 404 };
      const result = await update(host.storage, key, (state) => {
        const before = state.outbox.length, result = toolAction(state, method, input, ctx, Date.now());
        if (result.error) return result;
        // Steps that became this member's while it is still in this turn: tell it here instead of waking it again.
        const mine = state.outbox.slice(before).filter((e) => e.kind === 'agent' && e.member === ctx.catId && !e.sent);
        for (const e of mine) e.inTurn = ctx.invocationId;
        const steps = mine.filter((e) => e.section).map((e) => state.experiments[e.objective].plan.findIndex((p) => p.k === e.section) + 1);
        const turns = [...(steps.length ? [`第 ${steps.join('、')} 步`] : []), ...mine.filter((e) => !e.section).map((e) => `「${e.message?.title}」`)].join('、');
        return mine.length ? { ...result, next: `${turns}也轮到你了：接着调用 rsi.task 做，不用等新的消息。` } : result;
      }, () => ctx.assertCurrent());
      if (!result.error) await runtime.flush(key);
      return result;
    },
    async tick() { await ready; await runtime.tick(); },
    deliver: runtime.deliver,
    stop: () => runtime.stop(),
  };
}
